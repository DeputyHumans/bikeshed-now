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
  OWN_ATTR,
  SUG_ATTR,
  isOwnMarker,
} from "../brand/dom";
import { refusesListeners, watchFocus } from "../viewer/frameWatch";
import { hasRetargetedLinks, restoreLinks } from "../viewer/outboundLinks";
import { TOKENS } from "../brand/tokens";
import { peerColor } from "../brand/tokens";
import type { Anchor, Annotation } from "../types";
import { createSuggestionLabels, type SuggestionLabel, type SuggestionLabels } from "./labels";
import {
  hasPaint,
  paint,
  paintSelected,
  paintedAt,
  paintedItems,
  setFlash,
  setPaintHover,
  setPaintShown,
  unpaint,
  type PaintItem,
} from "./paint";

/**
 * The document is same-origin, so the parent app reaches into `contentDocument`
 * directly and the proxy injects NOTHING. Highlights are presentational and are
 * never persisted; `serializeCleanHtml` below is what guarantees that.
 *
 * HTML text is PAINTED, never wrapped (`paint.ts`, ADR 0043): a `<mark>` around
 * part of a run of text in a flex or grid container made new items of it and
 * rearranged the slide, for every reader of every comment. Only SVG text keeps
 * a wrapper, a `<tspan>`, because one engine paints no highlight inside
 * `<text>` and SVG text has no flex or grid to break.
 */

/**
 * The SVG wrapper's treatment. Border, background and box-shadow do not apply
 * to SVG text at all, so it is a stroke in the author's colour painted BEHIND
 * the glyph fill, which leaves the author's own glyph colour intact. Not an
 * underline: SVG text decorations ignore `text-decoration-color`, so an
 * underline cannot carry the author's colour. Measured, not assumed — it
 * painted zero coloured pixels.
 */
const TSPAN_CSS = `
tspan.${HL_CLASS} {
  paint-order: stroke fill;
  stroke: var(${AUTHOR_COLOR_VAR}, ${TOKENS.annotation});
  stroke-width: 2px;
  stroke-linejoin: round;
  cursor: pointer;
}
tspan.${HL_CLASS}[data-selected="true"] { stroke-width: 4px; }
tspan.${HL_CLASS}[data-hidden] { stroke: none; text-decoration: none; cursor: inherit; }
tspan.${HL_CLASS}:focus { outline: none; }
tspan.${HL_CLASS}[${SUG_ATTR}] {
  text-decoration-line: line-through;
  text-decoration-thickness: 2px;
}
`;

/** Install the highlight stylesheet, adopted where the browser can, before anything is drawn. */
export function ensureHighlightStyles(doc: Document): void {
  paint(doc, paintedItems(doc), TSPAN_CSS);
}

/** Open every <details> ancestor so a highlighted range is actually visible. */
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

/** The one wrapper left: SVG text, which one engine will not paint a highlight in. */
function tspanFor(doc: Document): SVGElement {
  const wrapper = doc.createElementNS(SVG_NS, "tspan");
  // Where no click is delivered, a tap is heard as focus (attachHighlightFocus).
  if (refusesListeners(doc)) wrapper.setAttribute("tabindex", "-1");
  return wrapper;
}

/** Each document's suggestion labels, made when the first one is drawn. */
const labelLayers = new WeakMap<Document, SuggestionLabels>();
const labelsDrawn = new WeakMap<Document, SuggestionLabel[]>();
const shownIn = new WeakMap<Document, boolean>();

function labelsOf(doc: Document): SuggestionLabels {
  let labels = labelLayers.get(doc);
  if (!labels) {
    labels = createSuggestionLabels(doc);
    labels.setShown(shownIn.get(doc) ?? true);
    labelLayers.set(doc, labels);
  }
  return labels;
}

/**
 * One thread's passage, made ready to draw: the HTML text runs of it as
 * ranges to paint, the SVG text runs of it wrapped. Per text node, so a range
 * that crosses an element boundary is never surrounded whole, and existing
 * element nodes are never destroyed or re-parented. A highlight must not
 * change the document's structure — and in HTML now changes nothing at all.
 */
function collect(
  doc: Document,
  range: Range,
  annId: string,
  options: { authorEmail?: string; suggestion?: { replacement: string } },
): { item: PaintItem; label: SuggestionLabel | null } | null {
  if (range.collapsed) return null;
  openDetailsAround(range.startContainer);
  openDetailsAround(range.endContainer);

  const { startContainer, startOffset, endContainer, endOffset } = range;
  const color = options.authorEmail ? peerColor(options.authorEmail) : TOKENS.annotation;
  const ranges: Range[] = [];
  let last: Range | null = null;

  for (const node of intersectingTextNodes(doc, range)) {
    const from = node === startContainer ? startOffset : 0;
    const to = node === endContainer ? endOffset : node.length;
    if (from >= to) continue;

    const sub = doc.createRange();
    sub.setStart(node, from);
    sub.setEnd(node, to);

    if (node.parentElement?.namespaceURI !== SVG_NS) {
      ranges.push(sub);
      last = sub;
      continue;
    }
    const wrapper = tspanFor(doc);
    // setAttribute, not `.className =`: on an SVG element `className` is an
    // SVGAnimatedString and the assignment is silently ignored.
    wrapper.setAttribute("class", HL_CLASS);
    wrapper.setAttribute(ANN_ATTR, annId);
    // The author's colour, so a highlight can be traced to a person without
    // opening the panel — the same value the chip, caret and rail marker use.
    wrapper.style.setProperty(AUTHOR_COLOR_VAR, color);
    if (options.suggestion) wrapper.setAttribute(SUG_ATTR, annId);
    try {
      sub.surroundContents(wrapper);
      const inside = doc.createRange();
      inside.selectNodeContents(wrapper);
      last = inside;
    } catch {
      // A boundary this sub-range cannot cleanly wrap. Skipping the fragment
      // loses part of one highlight; throwing would lose the whole document.
    }
  }
  const replacement = options.suggestion?.replacement;
  return {
    item: { annId, ranges, color, suggestion: Boolean(options.suggestion) },
    // …and what it would become is shown beside its last segment. Nothing for a deletion.
    label: replacement && last ? { annId, range: last, color, text: replacement } : null,
  };
}

/** Draw one thread's passage, beside whatever this document already shows. */
export function highlightRange(
  doc: Document,
  range: Range,
  annId: string,
  options: { authorEmail?: string; suggestion?: { replacement: string } } = {},
): void {
  const made = collect(doc, range, annId, options);
  if (!made) return;
  paint(doc, [...paintedItems(doc).filter((item) => item.annId !== annId), made.item], TSPAN_CSS);
  if (made.label) {
    const labels = [...(labelsDrawn.get(doc) ?? []).filter((l) => l.annId !== annId), made.label];
    labelsDrawn.set(doc, labels);
    labelsOf(doc).render(labels);
  }
}

function unwrapMark(mark: Element): void {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  (parent as Element | Document).normalize?.();
}

/** Undraw every thread. The stylesheet stays, for the next draw; `removeHighlightStyles` takes it. */
export function clearHighlights(doc: Document): void {
  for (const mark of Array.from(doc.querySelectorAll(HL_SELECTOR))) {
    unwrapMark(mark);
  }
  if (paintedItems(doc).length > 0) paint(doc, [], TSPAN_CSS);
  labelsDrawn.delete(doc);
  labelLayers.get(doc)?.render([]);
}

/** Remove the stylesheet, every painted highlight and the suggestion labels. clearHighlights deliberately does NOT. */
export function removeHighlightStyles(doc: Document): void {
  unpaint(doc);
  labelLayers.get(doc)?.destroy();
  labelLayers.delete(doc);
  labelsDrawn.delete(doc);
  shownIn.delete(doc);
}

/** Mark one thread as selected, and clear the rest. */
export function setSelectedHighlight(doc: Document, annId: string | null): void {
  for (const mark of Array.from(doc.querySelectorAll(HL_SELECTOR))) {
    const isSelected = annId != null && mark.getAttribute(ANN_ATTR) === annId;
    if (isSelected) mark.setAttribute("data-selected", "true");
    else mark.removeAttribute("data-selected");
  }
  paintSelected(doc, annId);
}

/**
 * Show or hide every thread's passage and every suggestion's label, keeping
 * what they are, while the reader hides comments or presents (SPEC §6). The
 * SVG wrappers stay in the text, unstyled while hidden.
 */
export function setHighlightsShown(doc: Document, shown: boolean): void {
  shownIn.set(doc, shown);
  setPaintShown(doc, shown);
  labelLayers.get(doc)?.setShown(shown);
  for (const mark of Array.from(doc.querySelectorAll(HL_SELECTOR))) {
    if (shown) mark.removeAttribute("data-hidden");
    else mark.setAttribute("data-hidden", "true");
  }
}

/** Light one thread's passage on its own while the rest are hidden, or put it out. */
export function lightHighlight(doc: Document, annId: string | null, lit: boolean): void {
  setFlash(doc, annId, lit);
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

/** The two body attributes the editor temporarily overrides, including absence. */
export type EditingBodyAttributes = Record<"contenteditable" | "spellcheck", string | null>;

/** Restore the authored values on a clone, or when the editing host is released. */
export function restoreEditingBodyAttributes(body: Element, authored: EditingBodyAttributes): void {
  for (const [name, value] of Object.entries(authored)) {
    if (value === null) body.removeAttribute(name);
    else body.setAttribute(name, value);
  }
}

export interface SerializeOptions {
  /** Captured immediately before the editor overrides the body's own values. */
  authoredBodyAttributes?: EditingBodyAttributes;
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
 *   - The editor's body `contenteditable` and `spellcheck` overrides, restored
 *     to their authored values. Attributes on other elements are authored.
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
  const body = root.querySelector("body");
  if (body && opts.authoredBodyAttributes) {
    restoreEditingBodyAttributes(body, opts.authoredBodyAttributes);
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

  // A link the viewer pointed at a new tab, where clicks are not delivered,
  // gets the author's own target and rel back.
  restoreLinks(root);

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
  if (doc.querySelector(`[${SUG_ATTR}]`)) found.push("suggestion mark");
  if (doc.getElementById(HL_STYLE_ID)) found.push("highlight stylesheet");
  if (hasPaint(doc)) found.push("painted highlight");
  if (hasRetargetedLinks(doc)) found.push("retargeted link");
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
  const items: PaintItem[] = [];
  const labels: SuggestionLabel[] = [];
  for (const ann of annotations) {
    if (ann.resolved) continue;
    const suggestion = ann.suggestion?.state === "pending" ? ann.suggestion : null;
    // An agent's comment is resolved strictly too: its anchor was found by its
    // quote without a DOM, so a position fallback would point at the wrong words.
    const strict = suggestion !== null || ann.anchor.strict === true;
    const range = strict ? resolveExact(ann.anchor) : resolve(ann.anchor);
    if (range) {
      const made = collect(doc, range, ann.annId, {
        authorEmail: ann.authorEmail,
        ...(suggestion ? { suggestion: { replacement: suggestion.replacement } } : {}),
      });
      if (made) {
        items.push(made.item);
        if (made.label) labels.push(made.label);
      }
      drawn.push(ann.annId);
    } else if (suggestion) {
      stale.push(ann.annId);
    } else {
      // Reported rather than swallowed: a comment whose passage no longer
      // exists still has to be readable, or the feedback is simply lost.
      orphaned.push(ann.annId);
    }
  }
  paint(doc, items, TSPAN_CSS);
  labelsDrawn.set(doc, labels);
  if (labels.length > 0 || labelLayers.has(doc)) labelsOf(doc).render(labels);
  return { drawn, orphaned, stale };
}

/**
 * Listen for clicks on a highlight. Returns a cleanup function.
 *
 * A painted passage is no element (`paint.ts`), so a click is matched to one
 * by where it lands, `paintedAt`; an SVG wrapper is still found by the click's
 * target. While the pointer is over a painted passage the hand shows, set by
 * the stylesheet alone, so hovering writes nothing to the document.
 */
export function attachHighlightClick(
  doc: Document,
  onClick: (annId: string) => void,
): () => void {
  if (refusesListeners(doc)) return attachHighlightFocus(doc, onClick);
  const handler = (e: Event) => {
    const target = e.target as Element | null;
    const mark = target?.closest?.(HL_SELECTOR) as Element | null;
    const pointer = e as MouseEvent;
    const id = mark?.getAttribute(ANN_ATTR) ?? paintedAt(doc, pointer.clientX, pointer.clientY);
    if (!id) return;
    onClick(id);
    // And it stops here: the click is the thread's. A deck that advances on
    // click would otherwise move off the passage the reader just opened.
    e.stopPropagation();
  };
  let frame = 0;
  let at: { x: number; y: number } | null = null;
  const view = doc.defaultView;
  const hover = (e: Event) => {
    const pointer = e as PointerEvent;
    at = { x: pointer.clientX, y: pointer.clientY };
    if (frame || !view) return;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      if (at) setPaintHover(doc, paintedAt(doc, at.x, at.y) !== null);
    });
  };
  // Capture phase, so a document that stops propagation on its own click
  // handlers cannot make its highlights unclickable.
  doc.addEventListener("click", handler, true);
  doc.addEventListener("pointermove", hover, { capture: true, passive: true });
  return () => {
    doc.removeEventListener("click", handler, true);
    doc.removeEventListener("pointermove", hover, { capture: true });
    if (frame && view) view.cancelAnimationFrame(frame);
    setPaintHover(doc, false);
  };
}

/**
 * Where the frame delivers no clicks (viewer/frameWatch.ts), a tap is heard by
 * what it does to focus: every highlight is focusable, though never in the tab
 * order (`tabindex="-1"`), and its thread opens when one takes focus, which is
 * then given back so the same highlight can be tapped again. The attribute is
 * on our own wrapper, which the strip unwraps, so it never reaches a version;
 * the text is untouched, so no anchor moves.
 */
function attachHighlightFocus(doc: Document, onClick: (annId: string) => void): () => void {
  // Highlights drawn from now on are made focusable as they are made
  // (tspanFor); any already drawn, here.
  for (const mark of Array.from(doc.querySelectorAll(HL_SELECTOR))) {
    if (!mark.hasAttribute("tabindex")) mark.setAttribute("tabindex", "-1");
  }
  const stop = watchFocus(doc, (el) => {
    const mark = el.closest(HL_SELECTOR);
    const id = mark?.getAttribute(ANN_ATTR);
    if (!mark || !id) return;
    onClick(id);
    (mark as HTMLElement).blur?.();
  });
  return () => {
    stop();
    for (const mark of Array.from(doc.querySelectorAll(HL_SELECTOR))) mark.removeAttribute("tabindex");
  };
}
