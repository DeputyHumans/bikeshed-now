// SPDX-License-Identifier: Apache-2.0
// In-iframe highlight rendering, and the serializer that keeps it out of saved bytes (SPEC §6, §6a).

import {
  ANN_ATTR,
  AUTHOR_COLOR_VAR,
  EDIT_FONTS_ID,
  EMPTY_ATTR,
  HL_CLASS,
  HL_RESOLVED_CLASS,
  HL_STYLE_ID,
  OWN_ATTR,
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
 * Resolved differs by border STYLE and alpha, never by colour alone, so the
 * distinction survives a monochrome display and colour blindness.
 *
 * A coarse pointer gets a tinted fill as well, because a 1px border is not
 * something a thumb can hit.
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
    .${HL_CLASS}.${HL_RESOLVED_CLASS} {
      border-style: dashed;
      opacity: 0.55;
      box-shadow: none;
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

/**
 * Wrap a Range in <mark> nodes, one per text node.
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
  options: { resolved: boolean; authorEmail?: string },
): void {
  if (range.collapsed) return;

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

    const mark = doc.createElement("mark");
    mark.className = options.resolved ? `${HL_CLASS} ${HL_RESOLVED_CLASS}` : HL_CLASS;
    mark.setAttribute(ANN_ATTR, annId);
    // The author's colour, so a highlight can be traced to a person without
    // opening the panel — the same value the chip, caret and rail marker use.
    mark.style.setProperty(AUTHOR_COLOR_VAR, color);
    try {
      sub.surroundContents(mark);
    } catch {
      // A boundary this sub-range cannot cleanly wrap. Skipping the fragment
      // loses part of one highlight; throwing would lose the whole document.
    }
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
  for (const mark of Array.from(doc.querySelectorAll(`mark.${HL_CLASS}`))) {
    unwrapMark(mark);
  }
}

/** Remove the injected stylesheet. clearHighlights deliberately does NOT. */
export function removeHighlightStyles(doc: Document): void {
  doc.getElementById(HL_STYLE_ID)?.remove();
}

/** Mark one thread as selected, and clear the rest. */
export function setSelectedHighlight(doc: Document, annId: string | null): void {
  for (const mark of Array.from(doc.querySelectorAll(`mark.${HL_CLASS}`))) {
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

  for (const el of Array.from(root.querySelectorAll(`[${OWN_ATTR}]`))) {
    if (isOwnMarker(el)) el.remove();
  }
  // The edit-font link predates the marker convention in documents published by
  // earlier versions of this design. Removing it by id costs one selector and
  // keeps those documents from carrying it forever.
  root.querySelector(`#${EDIT_FONTS_ID}`)?.remove();

  for (const mark of Array.from(root.querySelectorAll(`mark.${HL_CLASS}`))) {
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
  if (doc.querySelector(`mark.${HL_CLASS}`)) found.push("highlight mark");
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

/** Clear, then redraw every annotation using the supplied resolver. */
export function redrawHighlights(
  doc: Document,
  annotations: Annotation[],
  resolve: (anchor: Anchor) => Range | null,
): { drawn: string[]; orphaned: string[] } {
  clearHighlights(doc);
  const drawn: string[] = [];
  const orphaned: string[] = [];
  for (const ann of annotations) {
    const range = resolve(ann.anchor);
    if (range) {
      highlightRange(doc, range, ann.annId, {
        resolved: ann.resolved,
        authorEmail: ann.authorEmail,
      });
      drawn.push(ann.annId);
    } else {
      // Reported rather than swallowed: a comment whose passage no longer
      // exists still has to be readable, or the feedback is simply lost.
      orphaned.push(ann.annId);
    }
  }
  return { drawn, orphaned };
}

/** Listen for clicks on a highlight. Returns a cleanup function. */
export function attachHighlightClick(
  doc: Document,
  onClick: (annId: string) => void,
): () => void {
  const handler = (e: Event) => {
    const target = e.target as Element | null;
    const mark = target?.closest?.(`mark.${HL_CLASS}[${ANN_ATTR}]`) as HTMLElement | null;
    const id = mark?.getAttribute(ANN_ATTR);
    if (id) onClick(id);
  };
  // Capture phase, so a document that stops propagation on its own click
  // handlers cannot make its highlights unclickable.
  doc.addEventListener("click", handler, true);
  return () => doc.removeEventListener("click", handler, true);
}
