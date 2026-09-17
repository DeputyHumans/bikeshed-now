// SPDX-License-Identifier: Apache-2.0
// Edit-mode marking for containers a script fills at read time (SPEC §6a).

import { EDIT_PLACEHOLDERS_ID, EMPTY_ATTR, markOwn } from "../brand/dom";

/**
 * The edit frame is script-free, so what an editor sees IS the authored markup.
 * For a script-driven deck that means the containers its script fills render as
 * empty space, with nothing to say why — which reads as "the tool lost my
 * content".
 *
 * Two constraints, both about never polluting the saved bytes:
 *
 *   1. The marking is an ATTRIBUTE, never an inserted node, so no placeholder
 *      text can end up inside an authored element. This is the difference
 *      between a hint and a data-loss bug.
 *   2. The label is drawn by a ::after rule from ONE injected stylesheet, which
 *      the serializer strips wholesale by marker value.
 */

/** An element the author left empty for its own script to fill. */
function isEmptyContainer(el: Element): boolean {
  if (!el.id) return false;
  if (el.children.length > 0) return false;
  return (el.textContent ?? "").trim().length === 0;
}

/**
 * Mark every empty, id-bearing element whose id is referenced from one of the
 * document's own scripts.
 *
 * "Referenced by id from a script in this document" is the signal that the
 * emptiness is INTENTIONAL — a fill target — rather than incidental. Marking
 * every empty element would outline half a normal document.
 */
export function markGeneratedContainers(doc: Document): number {
  const scriptText = Array.from(doc.querySelectorAll("script"))
    .map((s) => s.textContent ?? "")
    .join("\n");
  if (!scriptText.trim()) return 0;

  let marked = 0;
  for (const el of Array.from(doc.querySelectorAll("[id]"))) {
    if (!isEmptyContainer(el)) continue;
    if (!scriptText.includes(el.id)) continue;
    el.setAttribute(EMPTY_ATTR, `#${el.id}`);
    marked += 1;
  }
  if (marked > 0) ensurePlaceholderStyles(doc);
  return marked;
}

export function clearGeneratedContainers(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll(`[${EMPTY_ATTR}]`))) {
    el.removeAttribute(EMPTY_ATTR);
  }
  doc.getElementById(EDIT_PLACEHOLDERS_ID)?.remove();
}

function ensurePlaceholderStyles(doc: Document): void {
  if (doc.getElementById(EDIT_PLACEHOLDERS_ID)) return;
  const style = doc.createElement("style");
  style.id = EDIT_PLACEHOLDERS_ID;
  markOwn(style, "edit-placeholders");
  // min-height so a zero-height container is still visible; the box is inert
  // because its content is generated somewhere the editor cannot reach.
  style.textContent = `
    [${EMPTY_ATTR}] {
      display: block;
      min-height: 72px;
      border: 1px dashed rgba(75, 61, 209, 0.5);
      border-radius: 8px;
      background: repeating-linear-gradient(
        45deg,
        rgba(75, 61, 209, 0.05),
        rgba(75, 61, 209, 0.05) 8px,
        transparent 8px,
        transparent 16px
      );
    }
    [${EMPTY_ATTR}]::after {
      content: "filled in by this document's own script when it is read: " attr(${EMPTY_ATTR});
      display: block;
      padding: 10px 12px;
      font: 500 12px/1.4 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.01em;
      color: rgba(60, 48, 176, 0.8);
    }
  `;
  (doc.head ?? doc.documentElement).appendChild(style);
}
