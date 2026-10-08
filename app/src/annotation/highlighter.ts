// SPDX-License-Identifier: Apache-2.0
// In-iframe highlight rendering, and the serializer that keeps it out of saved bytes (SPEC §6, §6a).

import {
  ANN_ATTR,
  AUTHOR_COLOR_VAR,
  EDIT_FONTS_ID,
  EMPTY_ATTR,
  HL_CLASS,
  HL_SELECTOR,
  HL_STYLE_ID,
  INS_ATTR,
  OWN_ATTR,
  SUG_ATTR,
  isOwnMarker,
  markOwn,
} from "../brand/dom";
import { TOKENS } from "../brand/tokens";
import { peerColor } from "../brand/tokens";
import type { Anchor, Annotation } from "../types";

/**
 * The document is same-origin, so the parent app mutates `contentDocument`
 * directly and the proxy injects NOTHING. Highlights are presentational and are
 * never persisted; `serializeCleanHtml` below is what guarantees that.
 */

/**
 * The highlight treatment, and why it is a border rather than a fill.
 *
 * A pale fill is invisible on a dark slide, and documents here are arbitrary
 * third-party HTML — a deck with a navy background is a normal case, not an
 * edge one. A 1px border plus a WHITE HALO survives any backdrop: against dark
 * content the halo reads, against light content the border does.
 *
 * A RESOLVED annotation is not drawn at all — see `redrawHighlights`. There is
 * therefore one treatment here, not two.
 *
 * A coarse pointer gets a tinted fill as well, because a 1px border is not
 * something a thumb can hit.
 *
 * Inside SVG text the wrapper is a `<tspan>` (see `wrapperFor`), and border,
 * background and box-shadow do not apply to SVG text at all, so it gets its
 * own treatment: a stroke in the author's colour painted BEHIND the glyph fill,
 * which leaves the author's own glyph colour intact — the same principle as
 * the border. Not an underline: SVG text decorations ignore
 * `text-decoration-color`, so an underline cannot carry the author's colour.
 * Measured, not assumed — it painted zero coloured pixels.
 */
export function ensureHighlightStyles(doc: Document): void {
  if (doc.getElementById(HL_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = HL_STYLE_ID;
  markOwn(style, "hl-style");
  style.textContent = `
    .${HL_CLASS} {
      background: transparent;
      color: inherit;
      border: 1px solid var(${AUTHOR_COLOR_VAR}, ${TOKENS.annotation});
      border-radius: 2px;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55);
      cursor: pointer;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    .${HL_CLASS}[data-selected="true"] {
      box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.8),
                  0 0 0 3px var(${AUTHOR_COLOR_VAR}, ${TOKENS.annotation});
    }
    @media (hover: none), (pointer: coarse) {
      .${HL_CLASS} {
        background: color-mix(in srgb, var(${AUTHOR_COLOR_VAR}, ${TOKENS.annotation}) 16%, transparent);
        padding: 0 1px;
        margin: 0 -1px;
        touch-action: manipulation;
      }
    }
    tspan.${HL_CLASS} {
      paint-order: stroke fill;
      stroke: var(${AUTHOR_COLOR_VAR}, ${TOKENS.annotation});
      stroke-width: 2px;
      stroke-linejoin: round;
    }
    tspan.${HL_CLASS}[data-selected="true"] {
      stroke-width: 4px;
    }
    .${HL_CLASS}[${SUG_ATTR}] {
      text-decoration-line: line-through;
      text-decoration-color: var(${AUTHOR_COLOR_VAR}, ${TOKENS.annotation});
      text-decoration-thickness: 2px;
    }
    mark.${HL_CLASS}[${INS_ATTR}]::after {
      content: attr(${INS_ATTR});
      /* inline-block, because a line-through propagates into every inline
         descendant and cannot be undone there — only an atomic inline is
         spared it. */
      display: inline-block;
      max-width: 100%;
      margin-left: 0.25em;
      padding: 0 2px;
      border-radius: 2px;
      white-space: pre-wrap;
      color: inherit;
      text-decoration: underline 2px var(${AUTHOR_COLOR_VAR}, ${TOKENS.annotation});
      background: color-mix(in srgb, var(${AUTHOR_COLOR_VAR}, ${TOKENS.annotation}) 14%, transparent);
    }
  `;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Open every <details> ancestor so a wrapped range is actually visible. */
function openDetailsAround(node: Node | null): void {
  let el: Element | null =
    node && node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : (node?.parentElement ?? null);
  while (el) {
    if (el.tagName === "DETAILS") (el as HTMLDetailsElement).open = true;
    el = el.parentElement;
  }
}

/** Text nodes a Range touches, in document order. */
function intersectingTextNodes(doc: Document, range: Range): Text[] {
  const common = range.commonAncestorContainer;
  const scope: Node =
    common.nodeType === Node.TEXT_NODE ? (common.parentNode ?? common) : common;
  const out: Text[] = [];
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    const t = n as Text;
    if (t.length > 0 && range.intersectsNode(t)) out.push(t);
    n = walker.nextNode();
  }
  return out;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The element to wrap one text node in.
 *
 * SVG renders no foreign child of a text content element: an HTML `<mark>`
 * inside `<text>` paints nothing, and the passage disappears — which is how a
 * comment on a label in a figure made the label vanish. A `<tspan>` is what
 * SVG has for a styled run, and it renders inline exactly where the mark would.
 *
 * Decided per text node, by the parent's namespace, so a range that runs from
 * prose into a figure gets the right wrapper for each part.
 */
function wrapperFor(doc: Document, text: Text): HTMLElement | SVGElement {
  return text.parentElement?.namespaceURI === SVG_NS
    ? doc.createElementNS(SVG_NS, "tspan")
    : doc.createElement("mark");
}

/**
 * Wrap a Range in highlight nodes, one per text node.
 *
 * Per-text-node rather than one surroundContents over the whole range: a range
 * that crosses an element boundary cannot be surrounded at all, and splitting
 * it into per-node sub-ranges means existing element nodes are never destroyed
 * or re-parented. A highlight must not change the document's structure.
 */
export function highlightRange(
  doc: Document,
  range: Range,
  annId: string,
  options: { authorEmail?: string; suggestion?: { replacement: string } } = {},
): void {
  if (range.collapsed) return;
  let lastHtmlMark: Element | null = null;

  openDetailsAround(range.startContainer);
  openDetailsAround(range.endContainer);

  const { startContainer, startOffset, endContainer, endOffset } = range;
  const color = options.authorEmail ? peerColor(options.authorEmail) : TOKENS.annotation;

  for (const node of intersectingTextNodes(doc, range)) {
    const from = node === startContainer ? startOffset : 0;
    const to = node === endContainer ? endOffset : node.length;
    if (from >= to) continue;

    const sub = doc.createRange();
    sub.setStart(node, from);
    sub.setEnd(node, to);

    const mark = wrapperFor(doc, node);
    // setAttribute, not `.className =`: on an SVG element `className` is an
    // SVGAnimatedString and the assignment is silently ignored.
    mark.setAttribute("class", HL_CLASS);
    mark.setAttribute(ANN_ATTR, annId);
    // The author's colour, so a highlight can be traced to a person without
    // opening the panel — the same value the chip, caret and rail marker use.
    mark.style.setProperty(AUTHOR_COLOR_VAR, color);
    // A suggestion's text is struck through, segment by segment.
    if (options.suggestion) mark.setAttribute(SUG_ATTR, annId);
    try {
      sub.surroundContents(mark);
      if (mark.namespaceURI !== SVG_NS) lastHtmlMark = mark;
    } catch {
      // A boundary this sub-range cannot cleanly wrap. Skipping the fragment
      // loses part of one highlight; throwing would lose the whole document.
    }
  }
  // …and what it would become follows its last segment, as generated content
  // read from an attribute (see INS_ATTR). Nothing for a deletion.
  if (options.suggestion?.replacement && lastHtmlMark) {
    lastHtmlMark.setAttribute(INS_ATTR, options.suggestion.replacement);
  }
}

function unwrapMark(mark: Element): void {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  (parent as Element | Document).normalize?.();
}

export function clearHighlights(doc: Document): void {
  for (const mark of Array.from(doc.querySelectorAll(HL_SELECTOR))) {
    unwrapMark(mark);
  }
}

/** Remove the injected stylesheet. clearHighlights deliberately does NOT. */
export function removeHighlightStyles(doc: Document): void {
  doc.getElementById(HL_STYLE_ID)?.remove();
}

/** Mark one thread as selected, and clear the rest. */
export function setSelectedHighlight(doc: Document, annId: string | null): void {
  for (const mark of Array.from(doc.querySelectorAll(HL_SELECTOR))) {
    const isSelected = annId != null && mark.getAttribute(ANN_ATTR) === annId;
    if (isSelected) mark.setAttribute("data-selected", "true");
    else mark.removeAttribute("data-selected");
  }
}

// --- Serialization ---------------------------------------------------------

/** Asset tags whose presence is the AUTHOR's decision, never the viewer's. */
const ASSET_TAGS = "script, style, link, meta, base";

/**
 * A multiset of asset-tag outerHTML, captured from a freshly loaded document.
 *
 * Taken in the iframe's onLoad BEFORE anything is injected, so it is the
 * author's own inventory. The serializer drops anything that appeared
 * afterwards: our own injections, and — the case that motivated it — nodes a
 * BROWSER EXTENSION added to the same-origin frame, which would otherwise be
 * published into the next version.
 *
 * Sound only because the edit frame is script-free: with the bundle's own
 * JavaScript disabled, nothing rewrites its asset tags between load and
 * serialize, so "absent from the baseline" reliably means "not authored".
 */
export function captureAssetTags(doc: Document): Map<string, number> {
  const seen = new Map<string, number>();
  for (const el of Array.from(doc.querySelectorAll(ASSET_TAGS))) {
    const key = el.outerHTML;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return seen;
}

export interface SerializeOptions {
  /**
   * The load-time inventory from captureAssetTags. Supplied on the EDIT path.
   * Omitted on the export path, which snapshots a post-script DOM where a
   * script-injected stylesheet is load-bearing rather than contamination.
   */
  authoredAssets?: Map<string, number>;
}

/**
 * Serialize the document to clean HTML, WITHOUT mutating the live DOM.
 *
 * Everything happens on a clone, because the source document is still being
 * edited: stripping decoration in place would make the editor's own view flicker
 * and could move the caret.
 *
 * What is removed, and why each one is needed:
 *
 *   - Our own injected nodes, matched by ATTRIBUTE VALUE rather than by
 *     attribute presence. A document that happens to use `data-bshd` for its
 *     own purposes survives; only values we write are ours to delete. Matching
 *     on presence alone would be silent data loss.
 *   - Highlight <mark>s, unwrapped so their text survives.
 *   - `contenteditable`, which is an editing affordance and not content.
 *   - Placeholder marking, which is an ATTRIBUTE and not a node, so the
 *     authored element survives untouched once it is gone.
 *   - Asset tags absent from the authored inventory (see above).
 *
 * The doctype is preserved by hand, because `documentElement.outerHTML` drops
 * it and a document that loses its doctype renders in quirks mode forever after.
 */
export function serializeCleanHtml(
  doc: Document,
  opts: SerializeOptions = {},
): string {
  const root = doc.documentElement.cloneNode(true) as HTMLElement;

  stripDecoration(root);

  if (opts.authoredAssets) {
    // A BUDGET rather than a set: a document that legitimately contains two
    // identical <style> tags keeps both, while a third — ours, or an
    // extension's — is dropped.
    const budget = new Map(opts.authoredAssets);
    for (const el of Array.from(root.querySelectorAll(ASSET_TAGS))) {
      const left = budget.get(el.outerHTML) ?? 0;
      if (left > 0) budget.set(el.outerHTML, left - 1);
      else el.remove();
    }
  }

  const prefix = doc.doctype ? "<!DOCTYPE html>\n" : "";
  return prefix + root.outerHTML;
}

/**
 * Remove this app's decoration from a COPY, in place. Never call it on a live
 * document: it is what the serializer and the slide preview share so that both
 * mean the same thing by "decoration", and both run it on a clone.
 *
 * Only `root`'s descendants are examined, which is every caller's case — a
 * document element or a preview's `<html>`, neither of which is ever ours.
 */
export function stripDecoration(root: Element): void {
  for (const el of Array.from(root.querySelectorAll(`[${OWN_ATTR}]`))) {
    if (isOwnMarker(el)) el.remove();
  }
  // The edit-font link predates the marker convention in documents published by
  // earlier versions of this design. Removing it by id costs one selector and
  // keeps those documents from carrying it forever.
  root.querySelector(`#${EDIT_FONTS_ID}`)?.remove();

  for (const mark of Array.from(root.querySelectorAll(HL_SELECTOR))) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
  root.normalize();

  for (const el of Array.from(root.querySelectorAll("[contenteditable]"))) {
    el.removeAttribute("contenteditable");
  }
  for (const el of Array.from(root.querySelectorAll(`[${EMPTY_ATTR}]`))) {
    el.removeAttribute(EMPTY_ATTR);
  }
}

/**
 * Throw if any of this app's decoration survived into a document about to be
 * edited or serialized.
 *
 * Dev-only, and deliberately loud. The iframe does NOT always remount on
 * entering edit mode — for an already-sandboxed document the `src` and the
 * sandbox attribute are both unchanged — so the editor can attach to the exact
 * Document the annotation layer just decorated. Every other defence against
 * that is a comment; this is the one that fails.
 */
export function assertNoDecoration(doc: Document, context: string): void {
  if (!import.meta.env.DEV) return;
  const found: string[] = [];
  if (doc.querySelector(HL_SELECTOR)) found.push("highlight mark");
  if (doc.querySelector(`[${SUG_ATTR}], [${INS_ATTR}]`)) found.push("suggestion mark");
  if (doc.getElementById(HL_STYLE_ID)) found.push("highlight stylesheet");
  for (const el of Array.from(doc.querySelectorAll(`[${OWN_ATTR}]`))) {
    if (isOwnMarker(el)) found.push(`injected ${el.getAttribute(OWN_ATTR)}`);
  }
  if (found.length > 0) {
    throw new Error(
      `decoration survived into ${context}: ${found.join(", ")}. ` +
        "Serializing now would publish it into the next version.",
    );
  }
}

/**
 * Clear, then redraw every annotation using the supplied resolver.
 *
 * A RESOLVED annotation is not drawn. Resolving is how a reader says "this is
 * dealt with", and leaving its passage marked means the document never gets
 * visibly cleaner however much feedback is worked through — which is the whole
 * point of resolving one. The thread stays in the panel and can be reopened
 * there; what goes away is the mark on the prose.
 *
 * It is not counted as orphaned either. Whether a settled comment's passage
 * still matches is not a question anybody needs answered.
 *
 * A pending SUGGESTION is resolved with `resolveExact`, which is strict:
 * it is drawn only where its exact text unambiguously still stands, because
 * what is drawn is what an approver would replace. One that does not resolve is
 * STALE rather than orphaned, which is a different thing to tell a reader: a
 * comment still makes its point, a stale suggestion can no longer be applied.
 *
 * A `strict` anchor goes through the same resolver, for a different reason:
 * the server found it by its quote, so its offsets mean nothing in the page.
 * It is still a comment, so one that does not resolve is orphaned.
 */
export function redrawHighlights(
  doc: Document,
  annotations: Annotation[],
  resolve: (anchor: Anchor) => Range | null,
  resolveExact: (anchor: Anchor) => Range | null = resolve,
): { drawn: string[]; orphaned: string[]; stale: string[] } {
  clearHighlights(doc);
  const drawn: string[] = [];
  const orphaned: string[] = [];
  const stale: string[] = [];
  for (const ann of annotations) {
    if (ann.resolved) continue;
    const suggestion = ann.suggestion?.state === "pending" ? ann.suggestion : null;
    // An agent's comment is resolved strictly too: its anchor was found by its
    // quote without a DOM, so a position fallback would point at the wrong words.
    const strict = suggestion !== null || ann.anchor.strict === true;
    const range = strict ? resolveExact(ann.anchor) : resolve(ann.anchor);
    if (range) {
      highlightRange(doc, range, ann.annId, {
        authorEmail: ann.authorEmail,
        ...(suggestion ? { suggestion: { replacement: suggestion.replacement } } : {}),
      });
      drawn.push(ann.annId);
    } else if (suggestion) {
      stale.push(ann.annId);
    } else {
      // Reported rather than swallowed: a comment whose passage no longer
      // exists still has to be readable, or the feedback is simply lost.
      orphaned.push(ann.annId);
    }
  }
  return { drawn, orphaned, stale };
}

/** Listen for clicks on a highlight. Returns a cleanup function. */
export function attachHighlightClick(
  doc: Document,
  onClick: (annId: string) => void,
): () => void {
  const handler = (e: Event) => {
    const target = e.target as Element | null;
    const mark = target?.closest?.(HL_SELECTOR) as Element | null;
    const id = mark?.getAttribute(ANN_ATTR);
    if (!id) return;
    onClick(id);
    // And it stops here: the click is the thread's. A deck that advances on
    // click would otherwise move off the passage the reader just opened.
    e.stopPropagation();
  };
  // Capture phase, so a document that stops propagation on its own click
  // handlers cannot make its highlights unclickable.
  doc.addEventListener("click", handler, true);
  return () => doc.removeEventListener("click", handler, true);
}
