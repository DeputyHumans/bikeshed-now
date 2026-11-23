// SPDX-License-Identifier: Apache-2.0
// A suggestion's replacement, shown in a label beside its passage and never in the text (SPEC §22, ADR 0043).

import { OWN_SELECTOR, SUG_LABEL_STYLE_ID, SUG_LAYER_ID, markOwn } from "../brand/dom";
import { watchResize } from "../viewer/frameWatch";
import { isVisible, watchShown } from "./visible";

/**
 * What a suggested edit would put in place of its passage. It used to hang off
 * the last highlight wrapper as generated content, `content: attr(…)`, and with
 * the wrappers gone (ADR 0043) there is nothing to hang it from. It is never a
 * text node in the document: that would add to the `textContent` every anchor
 * is measured against, and survive the strip that publishes the document.
 *
 * So it is drawn much as a peer's name is (`peers.ts`): in one layer of ours,
 * absolutely placed, `pointer-events: none`, in page coordinates, just above
 * the end of the struck-through passage, in its author's colour, its words as
 * generated content from an attribute, so they are in no text node. Only where the
 * passage can be seen, and drawn again whenever that may have changed: a deck
 * changing slide, a resize. The comments panel still says the whole change.
 */

export interface SuggestionLabel {
  annId: string;
  /** The suggestion's passage, whose last line the label sits above the end of. */
  range: Range;
  color: string;
  text: string;
}

export interface SuggestionLabels {
  render: (labels: SuggestionLabel[]) => void;
  /** Hidden while the reader hides comments, or presents. */
  setShown: (shown: boolean) => void;
  destroy: () => void;
}

const CSS = `
#${SUG_LAYER_ID} {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2147482999;
  contain: layout style;
}
#${SUG_LAYER_ID}[hidden] { display: none; }
#${SUG_LAYER_ID} .bshd-sug-label {
  position: absolute;
  transform: translateY(-100%);
  max-width: 40ch;
  padding: 0 4px;
  border: 1px solid var(--bshd-author);
  border-radius: 3px 3px 3px 0;
  background: color-mix(in srgb, var(--bshd-author) 14%, #fff);
  color: #14161a;
  font: 500 12px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
  text-decoration: underline 2px var(--bshd-author);
  text-underline-offset: 0.18em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* Generated content, so the words are in no text node: the document's
   textContent, which every anchor is measured against, stays the document's. */
#${SUG_LAYER_ID} .bshd-sug-label::before { content: attr(data-text); }
@media print {
  #${SUG_LAYER_ID} { display: none; }
}
`;

export function createSuggestionLabels(doc: Document): SuggestionLabels {
  if (!doc.getElementById(SUG_LABEL_STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = SUG_LABEL_STYLE_ID;
    markOwn(style, "sug-label-style");
    style.textContent = CSS;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  const existing = doc.getElementById(SUG_LAYER_ID);
  const layer = existing ?? doc.createElement("div");
  if (!existing) {
    layer.id = SUG_LAYER_ID;
    markOwn(layer, "sug-labels");
    layer.setAttribute("aria-hidden", "true");
    (doc.body ?? doc.documentElement).appendChild(layer);
  }

  let current: SuggestionLabel[] = [];
  let frame = 0;
  const view = doc.defaultView;

  const draw = () => {
    frame = 0;
    layer.textContent = "";
    if (layer.hidden) return;
    const dx = view?.scrollX ?? 0;
    const dy = view?.scrollY ?? 0;
    for (const label of current) {
      const start = label.range.startContainer;
      const el = start.nodeType === 1 ? (start as Element) : start.parentElement;
      if (!el || !isVisible(el)) continue;
      // jsdom lays nothing out and gives a Range no rects at all.
      const rects = typeof label.range.getClientRects === "function" ? Array.from(label.range.getClientRects()).filter((r) => r.width >= 1) : [];
      const last = rects[rects.length - 1];
      if (!last) continue;
      const node = doc.createElement("div");
      node.className = "bshd-sug-label";
      node.style.setProperty("--bshd-author", label.color);
      node.style.left = `${last.right + dx}px`;
      node.style.top = `${last.top + dy}px`;
      node.setAttribute("data-text", label.text);
      layer.appendChild(node);
      // Kept inside the page on its right, where a passage ends near the edge.
      const width = view?.innerWidth ?? 0;
      const over = node.getBoundingClientRect().right - width;
      if (width > 0 && over > 0) node.style.left = `${Math.max(0, last.right + dx - over)}px`;
    }
  };

  const schedule = () => {
    if (!view || frame) return;
    frame = view.requestAnimationFrame(draw);
  };

  const stopShown = watchShown(doc, OWN_SELECTOR, () => {
    if (current.length > 0) schedule();
  });
  const stopResize = watchResize(doc, () => {
    if (current.length > 0) schedule();
  });

  return {
    render(labels) {
      current = labels;
      schedule();
    },
    setShown(shown) {
      if (layer.hidden === !shown) return;
      layer.hidden = !shown;
      schedule();
    },
    destroy() {
      stopShown();
      stopResize();
      if (frame && view) view.cancelAnimationFrame(frame);
      layer.remove();
      doc.getElementById(SUG_LABEL_STYLE_ID)?.remove();
    },
  };
}
