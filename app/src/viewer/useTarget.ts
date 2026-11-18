// SPDX-License-Identifier: Apache-2.0
// Going to a place in the document: a thread's passage, on whichever slide holds it (SPEC §6, §6d).

import { useEffect, useRef } from "react";
import { rangeFromAnchor } from "../annotation/anchor";
import { exactRangeFromAnchor } from "../annotation/exact";
import { scrollToFraction, scrollToPlace } from "../annotation/peers";
import { ANN_ATTR, HL_SELECTOR } from "../brand/dom";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import type { Peer } from "../presence";
import type { Annotation } from "../types";
import { slideOf } from "./deck";
import type { FrameMode } from "./frameMode";
import type { DeckControls } from "./useDeck";

/**
 * This hook MOVES the reader — it scrolls the frame and pages the deck — and
 * never writes to the document: no node, no class, no attribute. Like
 * `useDeck`, whose controls it uses, it therefore carries no ordering
 * obligation against `useInlineEditor` and is absent from
 * `viewer/invariant.test.tsx`'s harness. It is declared after `useDeck`
 * because it needs the deck, which `useAnnotationLayer`, declared before the
 * editor, cannot see.
 *
 * Selecting a thread brings its passage into view. On a deck that STACKS its
 * slides, a passage on a hidden slide still has a box inside the viewport, so a
 * test of "is it in view" said yes and nothing moved; and scrolling could not
 * have shown it anyway. So a passage on another slide is reached the way the
 * rail reaches a slide, through `goTo`, and only a passage on the slide being
 * shown, or in a document with no pages, is scrolled to.
 *
 * Following a peer goes where they are by the same means (SPEC §16): their
 * slide when both decks are paged, since a slide that stacks scrolls nothing;
 * else their place in the text, between the ids either side of the top of
 * their screen, which a screen of another width finds in the same words; else
 * the fraction of the page they had scrolled, as before. This reader's own
 * slide is shared for whoever follows them.
 */
export function useTarget(options: {
  mode: FrameMode;
  doc: Document | null;
  epoch: number;
  deck: DeckControls;
  annotations: Annotation[];
  selectedId: string | null;
  /** False while something hides the frame, as the comments pane does in one column. */
  frameShown?: boolean;
  /** The peer this reader follows, as their latest record. */
  follow?: Peer | null;
  /** Share this reader's slide, or null when their document is not paged. */
  shareSlide?: (slide: number | null) => void;
}): void {
  const { mode, doc, epoch, deck, annotations, selectedId, frameShown = true, follow = null, shareSlide } = options;
  const enabled = mode.kind === "reading";
  const reduceMotion = usePrefersReducedMotion();
  const { paged, slides, current, locate, goTo, measuredEpoch } = deck;
  const measured = measuredEpoch === epoch;

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
   *
   * A resolved thread has no highlight (SPEC §6), so its passage is found the
   * way it would be drawn and nothing is drawn: the reader is taken to it all
   * the same.
   */
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId === null) {
      revealed.current = null;
      return;
    }
    // Not while the frame is hidden. Its box measures zero, so every passage looks
    // in view and the jump would be used up; this waits for the frame to come back.
    // Nor before the deck has measured this document, or a passage on a slide
    // would be scrolled to as if the document had no pages.
    if (!enabled || !doc || !frameShown || measuredEpoch !== epoch || revealed.current === selectedId) return;
    const node = passageOf(doc, annotations.find((a) => a.annId === selectedId) ?? null, selectedId);
    if (!node) return;
    revealed.current = selectedId;
    const slide = paged ? slideOf(slides, node) : -1;
    if (slide >= 0 && slide !== locate()) {
      goTo(slide);
      return;
    }
    if (inView(node)) return;
    node.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  }, [enabled, doc, frameShown, epoch, measuredEpoch, selectedId, annotations, reduceMotion, paged, slides, locate, goTo]);

  // This reader's slide, for whoever follows them. Sent as it changes, because
  // on a deck that stacks its slides nothing scrolls to carry it.
  useEffect(() => {
    shareSlide?.(paged && measured ? current : null);
  }, [shareSlide, paged, measured, current]);

  /**
   * Go where the followed peer is, whenever where they are changes — not on
   * every presence update, so another person's cursor moving does not pull
   * back a follower who has just let go.
   */
  const placeKey = follow?.place ? `${follow.place.a ?? ""}\n${follow.place.b ?? ""}\n${follow.place.at}` : "";
  const followSlide = follow?.slide;
  const followViewport = follow?.viewport;
  const followPlace = follow?.place;
  useEffect(() => {
    // Not before the deck has measured this document: until then whether it is
    // paged is not known, and a move made on a guess is made twice.
    if (!doc || !measured || (followSlide === undefined && !placeKey && followViewport === undefined)) return;
    if (followSlide !== undefined && paged) {
      if (followSlide !== locate()) goTo(followSlide, { follow: true });
      return;
    }
    if (followPlace && scrollToPlace(doc, followPlace)) return;
    if (followViewport !== undefined) scrollToFraction(doc, followViewport);
    // `followPlace` is read through `placeKey`, so a new object with the same
    // place does not move the reader again.
  }, [doc, epoch, measured, paged, followSlide, placeKey, followViewport, locate, goTo]);
}

/**
 * Where a thread's passage is: its highlight, or for a resolved thread, which
 * has none, the element its anchor resolves in — strictly when it would be
 * drawn strictly, exactly as `redrawHighlights` decides.
 */
function passageOf(doc: Document, annotation: Annotation | null, annId: string): Element | null {
  const mark = Array.from(doc.querySelectorAll(HL_SELECTOR)).find((el) => el.getAttribute(ANN_ATTR) === annId);
  if (mark) return mark;
  if (!annotation?.resolved) return null;
  const strict = annotation.anchor.strict === true;
  let range: Range | null = null;
  try {
    range = strict ? exactRangeFromAnchor(doc, annotation.anchor) : rangeFromAnchor(doc, annotation.anchor);
  } catch {
    range = null;
  }
  if (!range) return null;
  const start = range.startContainer;
  return start.nodeType === 1 ? (start as Element) : start.parentElement;
}

/** Whether the whole of an element sits inside its frame's viewport. */
function inView(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  const rect = el.getBoundingClientRect();
  return rect.top >= 0 && rect.bottom <= view.innerHeight;
}
