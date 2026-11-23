// SPDX-License-Identifier: Apache-2.0
// Draws highlights, hides them on request, and stops the moment editing begins (SPEC §6, §6a).

import { useEffect, useRef, useState } from "react";
import { rangeFromAnchor } from "../annotation/anchor";
import { exactRangeFromAnchor } from "../annotation/exact";
import { attachSelectionGuard } from "../annotation/clickGuard";
import {
  attachHighlightClick,
  clearHighlights,
  ensureHighlightStyles,
  redrawHighlights,
  lightHighlight,
  removeHighlightStyles,
  setHighlightsShown,
  setSelectedHighlight,
} from "../annotation/highlighter";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import type { Annotation } from "../types";
import type { FrameMode } from "./frameMode";
import { attachOutboundLinks, openBeside } from "./outboundLinks";

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
/** How long each light and each dark of the blink lasts. */
export const BLINK_MS = 250;
/** How long the passage stays lit, once, under reduced motion. */
export const BLINK_STILL_MS = 1000;

export function useAnnotationLayer(options: {
  mode: FrameMode;
  doc: Document | null;
  epoch: number;
  annotations: Annotation[];
  selectedId: string | null;
  onSelect: (annId: string) => void;
  /** False while the reader hides comments, or presents: drawn, but not shown (SPEC §6). */
  shown?: boolean;
  /**
   * While hidden by the reader's own switch, a thread they open has its
   * passage blinked twice and then nothing marked, so they can see what it is
   * about. Never while presenting, which passes false.
   */
  blinkSelected?: boolean;
}): { orphaned: string[]; stale: string[] } {
  const { mode, doc, epoch, annotations, selectedId, onSelect, shown = true, blinkSelected = false } = options;
  const enabled = mode.kind === "reading";
  const [orphaned, setOrphaned] = useState<string[]>([]);
  const [stale, setStale] = useState<string[]>([]);

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
    // A link out of the document opens beside it rather than replacing it in
    // the frame. Reading only, for the same reason: in the editor a click on a
    // link places the caret.
    const unlink = attachOutboundLinks(doc, openBeside);
    return () => {
      detach();
      unguard();
      unlink();
      // Both, and in this order: unwrap the marks, then remove the stylesheet.
      // Removing the stylesheet first leaves unstyled <mark> elements visible
      // for a frame.
      clearHighlights(doc);
      removeHighlightStyles(doc);
    };
  }, [enabled, doc, epoch]);

  useEffect(() => {
    if (!enabled || !doc) return;
    const result = redrawHighlights(
      doc,
      annotations,
      (anchor) => rangeFromAnchor(doc, anchor),
      // A suggestion is drawn only where its exact text still stands: what is
      // struck through is what an approver would replace (SPEC §22).
      (anchor) => exactRangeFromAnchor(doc, anchor),
    );
    // An anchor that no longer resolves is REPORTED, not swallowed: the comment
    // still has to be readable, or the feedback is simply lost.
    setOrphaned(result.orphaned);
    setStale(result.stale);
  }, [enabled, doc, epoch, annotations]);

  useEffect(() => {
    if (!enabled || !doc) return;
    setSelectedHighlight(doc, selectedId);
  }, [enabled, doc, epoch, selectedId, annotations]);

  // After the draw, so a document that loads while hidden comes up hidden.
  useEffect(() => {
    if (!enabled || !doc) return;
    setHighlightsShown(doc, shown);
  }, [enabled, doc, epoch, shown, annotations]);

  /**
   * A thread opened while everything is hidden: its passage lights, goes out,
   * lights and goes out, about a second in all, and nothing is left marked.
   * Under reduced motion it lights once, for a second, without blinking. Only
   * when the selection CHANGES: turning the switch off with a thread open
   * blinks nothing.
   */
  const reduceMotion = usePrefersReducedMotion();
  const lastSelected = useRef<string | null>(null);
  useEffect(() => {
    const changed = selectedId !== lastSelected.current;
    lastSelected.current = selectedId;
    if (!changed || !enabled || !doc || !blinkSelected || !selectedId) return;
    const steps = reduceMotion ? [true] : [true, false, true];
    const every = reduceMotion ? BLINK_STILL_MS : BLINK_MS;
    let step = 0;
    lightHighlight(doc, selectedId, steps[0]);
    const timer = setInterval(() => {
      step += 1;
      if (step >= steps.length) {
        clearInterval(timer);
        lightHighlight(doc, null, false);
        return;
      }
      lightHighlight(doc, selectedId, steps[step]);
    }, every);
    return () => {
      clearInterval(timer);
      lightHighlight(doc, null, false);
    };
  }, [enabled, doc, epoch, blinkSelected, selectedId, reduceMotion]);

  return { orphaned, stale };
}

