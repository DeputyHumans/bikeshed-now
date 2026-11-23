// SPDX-License-Identifier: Apache-2.0
// Peer cursors and selections, as an overlay that never touches the document (SPEC §16).

import { OWN_SELECTOR, PEER_LAYER_ID, PEER_STYLE_ID, markOwn } from "../brand/dom";
import { rangeFromAnchor } from "./anchor";
import { isVisible } from "./visible";
import { PLACE_ID_MAX, type Peer, type ReadingPlace } from "../presence";
import { personName } from "../people";

/**
 * The most important constraint in this feature: ephemeral peer presence NEVER
 * touches the document DOM.
 *
 * Persisted annotations wrap text nodes inline, because they have to flow with
 * the text and be clickable. Peer presence does not, and wrapping text nodes for
 * it would be wrong three ways:
 *
 *   1. SERIALIZATION. Inline wrappers inside content that is being edited and
 *      serialized are a third contamination class, alongside highlights and
 *      placeholder marking. One marked container is one querySelector to strip,
 *      already covered by the existing rule and the dev-only assertion.
 *
 *   2. IT WOULD FIGHT THE EDITOR. Wrapping a text node inside a contentEditable
 *      lands in the browser's undo stack and can move the local caret — so
 *      somebody else's cursor would make YOUR typing jump, and ctrl-Z would
 *      undo their presence instead of your edit.
 *
 *   3. COST. Repositioning absolutely-placed rectangles is cheap. Re-wrapping
 *      text nodes five times a second is not.
 *
 * So: one absolutely-positioned, pointer-events:none container appended to the
 * document body, holding per-peer caret bars and selection rectangles computed
 * from Range.getClientRects() and repositioned by a single rAF loop.
 */

export interface PeerOverlay {
  /** Redraw from the current peer list. Cheap enough to call on every update. */
  render: (peers: Peer[]) => void;
  /** Reposition without recomputing peers. Bound to scroll and resize. */
  reflow: () => void;
  destroy: () => void;
}

const OVERLAY_CSS = `
#${PEER_LAYER_ID} {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
  contain: layout style;
}
#${PEER_LAYER_ID} .bshd-peer-sel {
  position: absolute;
  border-radius: 2px;
  opacity: 0.18;
  background: var(--bshd-peer);
}
#${PEER_LAYER_ID} .bshd-peer-caret {
  position: absolute;
  width: 2px;
  border-radius: 1px;
  background: var(--bshd-peer);
}
#${PEER_LAYER_ID} .bshd-peer-label {
  position: absolute;
  transform: translateY(-100%);
  padding: 1px 5px;
  border-radius: 3px 3px 3px 0;
  background: var(--bshd-peer);
  color: #fff;
  font: 600 10px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif;
  white-space: nowrap;
  max-width: 14ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
@media (prefers-reduced-motion: no-preference) {
  #${PEER_LAYER_ID} .bshd-peer-caret { transition: top 120ms linear, left 120ms linear; }
}
/* Somebody else's caret and name are not part of a printout. The export path
   strips this layer outright; the browser's File → Print sees the live frame. */
@media print {
  #${PEER_LAYER_ID} { display: none; }
}
`;

function ensureStyles(doc: Document): void {
  if (doc.getElementById(PEER_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = PEER_STYLE_ID;
  markOwn(style, "peer-style");
  style.textContent = OVERLAY_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function ensureLayer(doc: Document): HTMLElement {
  const existing = doc.getElementById(PEER_LAYER_ID);
  if (existing) return existing as HTMLElement;
  const layer = doc.createElement("div");
  layer.id = PEER_LAYER_ID;
  markOwn(layer, "peers");
  layer.setAttribute("aria-hidden", "true");
  (doc.body ?? doc.documentElement).appendChild(layer);
  return layer;
}

/** Page coordinates, so the overlay stays put while the document scrolls. */
function pageRects(doc: Document, range: Range): DOMRect[] {
  const view = doc.defaultView;
  const dx = view ? view.scrollX : 0;
  const dy = view ? view.scrollY : 0;
  return Array.from(range.getClientRects()).map(
    (r) => new DOMRect(r.left + dx, r.top + dy, r.width, r.height),
  );
}

export function createPeerOverlay(doc: Document): PeerOverlay {
  ensureStyles(doc);
  const layer = ensureLayer(doc);
  let current: Peer[] = [];
  let frame = 0;

  const draw = () => {
    frame = 0;
    // Rebuilt wholesale rather than diffed. A handful of peers is a handful of
    // nodes, and a diff here would be more code than it saves — and a stale
    // caret is worse than a repaint.
    layer.textContent = "";

    for (const peer of current) {
      if (!peer.focus) continue;
      const range = rangeFromAnchor(doc, peer.focus);
      if (!range) continue;

      const rects = pageRects(doc, range);
      if (rects.length === 0) continue;

      for (const rect of rects) {
        if (rect.width < 1) continue;
        const sel = doc.createElement("div");
        sel.className = "bshd-peer-sel";
        sel.style.setProperty("--bshd-peer", peer.color);
        sel.style.left = `${rect.left}px`;
        sel.style.top = `${rect.top}px`;
        sel.style.width = `${rect.width}px`;
        sel.style.height = `${rect.height}px`;
        layer.appendChild(sel);
      }

      // The caret sits at the END of the selection, which is where a person's
      // attention actually is while they extend one.
      const last = rects[rects.length - 1];
      const caret = doc.createElement("div");
      caret.className = "bshd-peer-caret";
      caret.style.setProperty("--bshd-peer", peer.color);
      caret.style.left = `${last.left + last.width}px`;
      caret.style.top = `${last.top}px`;
      caret.style.height = `${Math.max(12, last.height)}px`;
      layer.appendChild(caret);

      // Colour carries identity, but colour alone is never a signal here: the
      // name is what makes the caret mean something to somebody who cannot
      // distinguish two hues.
      const label = doc.createElement("div");
      label.className = "bshd-peer-label";
      label.style.setProperty("--bshd-peer", peer.color);
      label.style.left = `${last.left + last.width}px`;
      label.style.top = `${last.top}px`;
      // The short name, as the presence bar draws it; the caret repaints with
      // every move, so a name that arrives later is here by the next one.
      label.textContent = personName({ uid: peer.uid, email: peer.email, known: peer.name });
      layer.appendChild(label);
    }
  };

  const schedule = () => {
    const view = doc.defaultView;
    if (!view) return;
    // Coalesced into one frame: peers, scroll and resize all land here, and
    // three updates in the same tick should be one repaint.
    if (frame) return;
    frame = view.requestAnimationFrame(draw);
  };

  return {
    render(peers) {
      current = peers;
      schedule();
    },
    reflow: schedule,
    destroy() {
      const view = doc.defaultView;
      if (frame && view) view.cancelAnimationFrame(frame);
      layer.remove();
      doc.getElementById(PEER_STYLE_ID)?.remove();
    },
  };
}

/** The reader's fractional scroll position, for broadcasting and for follow mode. */
export function scrollFraction(doc: Document): number {
  const view = doc.defaultView;
  if (!view) return 0;
  const el = doc.documentElement;
  const max = Math.max(1, el.scrollHeight - view.innerHeight);
  return Math.min(1, Math.max(0, view.scrollY / max));
}

/** Scroll to a peer's position. Used by follow mode. */
export function scrollToFraction(doc: Document, fraction: number): void {
  const view = doc.defaultView;
  if (!view) return;
  const el = doc.documentElement;
  const max = Math.max(0, el.scrollHeight - view.innerHeight);
  view.scrollTo({ top: max * fraction, behavior: "auto" });
}

/**
 * The elements a reading place may name, top to bottom: every element with an
 * id that a follower can find again by it and that moves with the text.
 *
 * Left out: our own nodes; an id another element took first, which
 * `getElementById` would never return; anything with no box; anything the
 * reader cannot see (`annotation/visible.ts`), which on a deck that stacks its
 * slides is every slide but the one shown, all of them in the same box; and
 * anything `fixed` or `sticky`, or inside something that is, because its top
 * moves with the scroll and would place the reader wherever they already were.
 * An id too long for the rules to carry is left out too, rather than refused
 * with the whole record. Sorted by top, DOM order breaking ties.
 */
function placeMarks(doc: Document): { id: string; top: number }[] {
  const view = doc.defaultView;
  if (!view) return [];
  const pinned = new Map<Element, boolean>();
  const isPinned = (el: Element | null): boolean => {
    if (!el || el === doc.body || el === doc.documentElement) return false;
    const known = pinned.get(el);
    if (known !== undefined) return known;
    const position = view.getComputedStyle(el).position;
    const answer = position === "fixed" || position === "sticky" || isPinned(el.parentElement);
    pinned.set(el, answer);
    return answer;
  };
  const marks: { id: string; top: number }[] = [];
  for (const el of Array.from(doc.body?.querySelectorAll("[id]") ?? [])) {
    const id = el.id;
    if (!id || id.length > PLACE_ID_MAX || doc.getElementById(id) !== el) continue;
    if (el.closest(OWN_SELECTOR)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (!isVisible(el)) continue;
    if (isPinned(el)) continue;
    marks.push({ id, top: rect.top + view.scrollY });
  }
  return marks.sort((x, y) => x.top - y.top);
}

/** How far the window can scroll. */
function maxScroll(doc: Document, view: Window): number {
  return Math.max(0, doc.documentElement.scrollHeight - view.innerHeight);
}

/**
 * Where the top of the reader's screen is in the text, for a follower on a
 * screen of another size (`ReadingPlace`). Null when the document has no ids to
 * name a place by, which leaves the follower the fraction.
 */
export function readingPlace(doc: Document): ReadingPlace | null {
  const view = doc.defaultView;
  if (!view) return null;
  const marks = placeMarks(doc);
  if (marks.length === 0) return null;
  const y = view.scrollY;
  let above = -1;
  // A pixel of slack, for a heading scrolled to exactly the top and rounded.
  for (let i = 0; i < marks.length && marks[i].top <= y + 1; i += 1) above = i;
  const a = above >= 0 ? marks[above] : null;
  const b = marks[above + 1] ?? null;
  const lo = a ? a.top : 0;
  const hi = b ? b.top : maxScroll(doc, view);
  const at = hi > lo ? Math.min(1, Math.max(0, (y - lo) / (hi - lo))) : 0;
  return { ...(a ? { a: a.id } : {}), ...(b ? { b: b.id } : {}), at };
}

/**
 * Scroll to a peer's reading place. False, having scrolled nothing, when an id
 * it names is not in this document, so the caller can fall back to the
 * fraction.
 */
export function scrollToPlace(doc: Document, place: ReadingPlace): boolean {
  const view = doc.defaultView;
  if (!view) return false;
  const topOf = (id: string): number | null => {
    const el = doc.getElementById(id);
    return el ? el.getBoundingClientRect().top + view.scrollY : null;
  };
  const max = maxScroll(doc, view);
  const lo = place.a !== undefined ? topOf(place.a) : 0;
  const hi = place.b !== undefined ? topOf(place.b) : max;
  if (lo === null || hi === null) return false;
  const y = hi > lo ? lo + place.at * (hi - lo) : lo;
  view.scrollTo({ top: Math.min(max, Math.max(0, y)), behavior: "auto" });
  return true;
}
