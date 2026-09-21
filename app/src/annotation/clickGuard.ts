// SPDX-License-Identifier: Apache-2.0
// Keeps the click that made a text selection from the document's own scripts (SPEC §6).

/**
 * A drag that selects text ends in a `click`, and a deck that advances on
 * click — the common hand-made shape, `document.addEventListener("click",
 * next)` — then moves off the very slide the reader was about to comment on.
 * This stops that click before the document's scripts see it.
 *
 * Only that click. The test is not "is text selected" but "did THIS gesture
 * select it": the selection is noted when the pointer goes down and compared
 * when the click arrives. Measured in Chrome, that is the line that matters.
 * A drag changes it between the two. A click that merely dismisses a
 * selection collapses it on mouse-up, before `click`, and passes as a plain
 * click. And a selection stranded on a slide the arrow keys moved off is never
 * collapsed at all — the browser cannot hit-test hidden text — yet is the same
 * selection at both moments, so it passes too; treating it as live would have
 * swallowed every click until the reader selected something else, which is
 * exactly what happened in the first cut of this. A click with no pointer-down
 * before it — keyboard activation, a script's own synthetic click — is nobody
 * selecting text and passes as well.
 *
 * Propagation is stopped, the default action is not. A link still navigates
 * and a `<summary>` still toggles; it is the document's *scripted* reaction to
 * the click that is withheld, because that is the reaction which hides the
 * passage.
 *
 * The listeners sit on the frame's WINDOW, in the capture phase. Between
 * listeners on one node, registration order decides, and the deck's script
 * has run long before this hook attaches. The window sits above the document
 * in the propagation path, so this runs before anything the deck registered
 * on its document or body, in either phase, whenever it registered it.
 */
export function attachSelectionGuard(doc: Document): () => void {
  const target: EventTarget = doc.defaultView ?? doc;
  let atPointerDown: SelectionSnapshot | null = null;

  const onPointerDown = () => {
    atPointerDown = snapshot(doc.getSelection());
  };
  const onClick = (e: Event) => {
    const before = atPointerDown;
    atPointerDown = null;
    if (!before) return;
    const sel = doc.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    if (sameSelection(before, sel)) return;
    e.stopPropagation();
  };

  target.addEventListener("pointerdown", onPointerDown, true);
  target.addEventListener("click", onClick, true);
  return () => {
    target.removeEventListener("pointerdown", onPointerDown, true);
    target.removeEventListener("click", onClick, true);
  };
}

/** The four coordinates that identify a selection, held by node identity. */
interface SelectionSnapshot {
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
}

function snapshot(sel: Selection | null): SelectionSnapshot {
  return {
    anchorNode: sel?.anchorNode ?? null,
    anchorOffset: sel?.anchorOffset ?? 0,
    focusNode: sel?.focusNode ?? null,
    focusOffset: sel?.focusOffset ?? 0,
  };
}

function sameSelection(a: SelectionSnapshot, b: Selection): boolean {
  return (
    a.anchorNode === b.anchorNode &&
    a.anchorOffset === b.anchorOffset &&
    a.focusNode === b.focusNode &&
    a.focusOffset === b.focusOffset
  );
}
