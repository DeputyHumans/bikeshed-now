// SPDX-License-Identifier: Apache-2.0
// Draws highlights, and stops the moment editing begins (SPEC §6, §6a).

import { useEffect, useRef, useState } from "react";
import { rangeFromAnchor } from "../annotation/anchor";
import { attachSelectionGuard } from "../annotation/clickGuard";
import {
  attachHighlightClick,
  clearHighlights,
  ensureHighlightStyles,
  redrawHighlights,
  removeHighlightStyles,
  setSelectedHighlight,
} from "../annotation/highlighter";
import { ANN_ATTR, HL_SELECTOR } from "../brand/dom";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import type { Annotation } from "../types";
import type { FrameMode } from "./frameMode";

/**
 * LEG 1 of the four that keep decoration out of saved bytes.
 *
 * `enabled` is derived from the SAME tagged union the editor derives its own
 * from, so the two cannot both be active. That is strictly stronger than three
 * independent `if (editing) return` guards, which can drift apart one commit at
 * a time.
 *
 * LEG 2 is ordering: within one component, effect cleanups run in declaration
 * order before any setup. This hook must therefore be declared BEFORE
 * useInlineEditor, so its cleanup — which strips every highlight — has already
 * run by the time the editor attaches. Changing the declaration order in
 * DocViewer silently breaks that, which is why it is stated at both ends.
 */
export function useAnnotationLayer(options: {
  mode: FrameMode;
  doc: Document | null;
  epoch: number;
  annotations: Annotation[];
  selectedId: string | null;
  onSelect: (annId: string) => void;
}): { orphaned: string[] } {
  const { mode, doc, epoch, annotations, selectedId, onSelect } = options;
  const enabled = mode.kind === "reading";
  const [orphaned, setOrphaned] = useState<string[]>([]);
  const reduceMotion = usePrefersReducedMotion();

  /**
   * The callback is held in a REF rather than depended on, and that is a
   * correctness fix rather than an optimization.
   *
   * The attach effect's cleanup strips every highlight. If the callback were a
   * dependency, a caller passing an inline arrow — which is the normal thing to
   * write — would change its identity on every render, re-running that cleanup
   * without re-running the redraw below, and the document would silently lose
   * its highlights. That happened, and this is the fix.
   */
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!enabled || !doc) return;
    ensureHighlightStyles(doc);
    const detach = attachHighlightClick(doc, (annId) => onSelectRef.current(annId));
    // A click that ends a text selection is the start of a comment, not a
    // click for the document's own scripts — on a deck that advances on
    // click, letting it through hides the passage before the reader can
    // comment on it. Reading mode only, with the rest of this effect: the edit
    // frame runs no script and the caret must never lose a click.
    const unguard = attachSelectionGuard(doc);
    return () => {
      detach();
      unguard();
      // Both, and in this order: unwrap the marks, then remove the stylesheet.
      // Removing the stylesheet first leaves unstyled <mark> elements visible
      // for a frame.
      clearHighlights(doc);
      removeHighlightStyles(doc);
    };
  }, [enabled, doc, epoch]);

  useEffect(() => {
    if (!enabled || !doc) return;
    const result = redrawHighlights(doc, annotations, (anchor) =>
      rangeFromAnchor(doc, anchor),
    );
    // An anchor that no longer resolves is REPORTED, not swallowed: the comment
    // still has to be readable, or the feedback is simply lost.
    setOrphaned(result.orphaned);
  }, [enabled, doc, epoch, annotations]);

  useEffect(() => {
    if (!enabled || !doc) return;
    setSelectedHighlight(doc, selectedId);
  }, [enabled, doc, epoch, selectedId, annotations]);

  /**
   * A newly selected thread brings its passage into view.
   *
   * Only when it is not already there: the usual way it is there is that the
   * selection came from clicking the highlight itself, and moving a passage
   * that is under the pointer is the document jumping under a click. Deciding
   * by geometry rather than by where the selection came from also spares a
   * reader who picked, from the panel, a passage they were already looking at.
   *
   * Only ONCE per selection, which is what the ref is for: this effect also
   * runs when the highlights are redrawn for a peer's comment landing, and a
   * reader who has scrolled on since selecting must not be pulled back. It
   * does run again for a selection that outran its highlight — posting a
   * comment selects the thread before the listener delivers it — because the
   * redraw that finally draws the passage is the moment to land on it.
   */
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId === null) {
      scrolledTo.current = null;
      return;
    }
    if (!enabled || !doc || scrolledTo.current === selectedId) return;
    const wrapper = Array.from(doc.querySelectorAll(HL_SELECTOR)).find(
      (el) => el.getAttribute(ANN_ATTR) === selectedId,
    );
    if (!wrapper) return;
    scrolledTo.current = selectedId;
    if (inView(wrapper)) return;
    wrapper.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  }, [enabled, doc, epoch, selectedId, annotations, reduceMotion]);

  return { orphaned };
}

/** Whether the whole of an element sits inside its frame's viewport. */
function inView(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  const rect = el.getBoundingClientRect();
  return rect.top >= 0 && rect.bottom <= view.innerHeight;
}
