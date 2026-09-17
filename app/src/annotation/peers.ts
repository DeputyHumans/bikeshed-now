// SPDX-License-Identifier: Apache-2.0
// Peer cursors and selections, as an overlay that never touches the document (SPEC §16).

import { PEER_LAYER_ID, PEER_STYLE_ID, markOwn } from "../brand/dom";
import { rangeFromAnchor } from "./anchor";
import type { Peer } from "../presence";

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
      label.textContent = peer.name || peer.email;
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
