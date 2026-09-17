// SPDX-License-Identifier: Apache-2.0
// Draws highlights, and stops the moment editing begins (SPEC §6, §6a).

import { useEffect, useRef, useState } from "react";
import { rangeFromAnchor } from "../annotation/anchor";
import {
  attachHighlightClick,
  clearHighlights,
  ensureHighlightStyles,
  redrawHighlights,
  removeHighlightStyles,
  setSelectedHighlight,
} from "../annotation/highlighter";
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
    return () => {
      detach();
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

  return { orphaned };
}
