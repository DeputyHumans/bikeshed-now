// SPDX-License-Identifier: Apache-2.0
// Going to a place in the document — a thread's passage, a link's target, the person followed — on whichever slide holds it, and keeping the address on the slide (SPEC §6, §6d, §6e, §16).

import { useCallback, useEffect, useRef, useState } from "react";
import { rangeFromAnchor } from "../annotation/anchor";
import { exactRangeFromAnchor } from "../annotation/exact";
import { paintedRange } from "../annotation/paint";
import { scrollToFraction, scrollToPlace } from "../annotation/peers";
import { ANN_ATTR, HL_SELECTOR } from "../brand/dom";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import type { Peer } from "../presence";
import type { Annotation } from "../types";
import { slideOf, slideOfPeer } from "./deck";
import { formatTarget, parseTarget, slideOfTarget, slideTarget } from "./target";
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
 *
 * A link lands where its address says, after `#` (`viewer/target.ts`): a
 * section or slide by id, a slide by number, a comment thread. Once per
 * arrival — a page load, or the router moving to an address this hook did not
 * write — and never again for a redraw, a peer or a reload of the frame. On a
 * paged deck the address then follows the reader from slide to slide, by
 * replacing it, so copying the address bar shares the slide and Back still
 * leaves the document; and a frame that reloads returns to the slide in it.
 */

/** Why a comment a link names is not shown, for the viewer to say. */
export type TargetNotice =
  | "comment-missing"
  | "comment-sign-in"
  | "comment-unreadable"
  | "comment-folder-link"
  /** The person followed shares no slide this paged deck can find, so following cannot move it. */
  | "follow-unshared";

/** Whether the threads of the version on screen can be looked in yet, and if not, why. */
export interface ThreadsState {
  ready: boolean;
  /** Set once ready: why a reader cannot see them at all. */
  refused?: Exclude<TargetNotice, "comment-missing" | "follow-unshared">;
}
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
  /** The router's part of the address after `#`. Changes only when the router moves. */
  hash?: string;
  threads?: ThreadsState;
  /** Open a thread a link named: select it and show the comments. */
  onThread?: (threadId: string) => void;
  onNotice?: (notice: TargetNotice) => void;
}): void {
  const {
    mode, doc, epoch, deck, annotations, selectedId, frameShown = true, follow = null, shareSlide,
    hash = "", threads = { ready: false }, onThread, onNotice,
  } = options;
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
    const node = passageOf(doc, annotations, selectedId);
    if (!node) return;
    revealed.current = selectedId;
    const slide = paged ? slideOf(slides, node) : -1;
    if (slide >= 0 && slide !== locate()) {
      goTo(slide);
      return;
    }
    if (inView(node, paintedRange(doc, selectedId))) return;
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
   *
   * Their slide first, whenever this document has it, paged here or not: a
   * deck that stacks its slides scrolls nothing, so it is the only way there,
   * and on a deck laid out taller here it is still the top of where they are.
   * Then, on a paged deck, the slide holding the place they share, which a
   * leader whose own viewer did not page the deck sends instead. A paged deck
   * that can find neither cannot be moved by a scroll, so the reader is told
   * once, rather than left looking at a pressed chip and a deck that stays
   * put; the place and the fraction are still tried, for a deck that scrolls.
   */
  const placeKey = follow?.place ? `${follow.place.a ?? ""}\n${follow.place.b ?? ""}\n${follow.place.at}` : "";
  const followUid = follow?.uid ?? null;
  const followSlide = follow?.slide;
  const followViewport = follow?.viewport;
  const followPlace = follow?.place;
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  /** Whom the reader was last told cannot be followed by slide, so it is said once per follow. */
  const toldUnshared = useRef<string | null>(null);
  useEffect(() => {
    if (!followUid) {
      toldUnshared.current = null;
      return;
    }
    // Not before the deck has measured this document: until then whether it is
    // paged is not known, and a move made on a guess is made twice.
    if (!doc || !measured) return;
    const bySlide = followSlide !== undefined && followSlide < slides.length;
    const at = slideOfPeer({ slide: followSlide, place: followPlace }, slides, doc);
    if (at >= 0 && (bySlide || paged)) {
      if (at !== locate()) goTo(at, { follow: true });
      return;
    }
    if (paged && toldUnshared.current !== followUid) {
      toldUnshared.current = followUid;
      onNoticeRef.current?.("follow-unshared");
    }
    if (followPlace && scrollToPlace(doc, followPlace)) return;
    if (followViewport !== undefined) scrollToFraction(doc, followViewport);
    // `followPlace` is read through `placeKey`, so a new object with the same
    // place does not move the reader again.
  }, [doc, epoch, measured, paged, slides, followUid, followSlide, placeKey, followViewport, locate, goTo]);

  // --- An address that names a place ----------------------------------------

  /** The part after `#` this hook last wrote, which the router never sees. */
  const written = useRef<string | null>(null);
  /**
   * The arrival being landed. A new one whenever the router's hash changes to
   * something this hook did not write: the router hears Back, Forward and an
   * address edited by hand, and never a `replaceState` of ours.
   */
  const [arrival, setArrival] = useState(() => ({ hash, target: parseTarget(hash), landed: false }));
  if (arrival.hash !== hash && hash !== written.current) {
    setArrival({ hash, target: parseTarget(hash), landed: false });
  }
  /** The frame epoch the address was last applied on, so a reload can go back to it. */
  const appliedEpoch = useRef<number | null>(null);
  /**
   * A slide this hook is on its way to for the address. A deck that scrolls
   * smoothly passes other slides first, and the address must not be rewritten
   * to them, losing the link's own target; given up on after a moment, for a
   * deck that never gets there.
   */
  const heading = useRef<{ slide: number; until: number } | null>(null);
  const head = useCallback((slide: number) => {
    heading.current = { slide, until: Date.now() + 2000 };
    goTo(slide);
  }, [goTo]);
  const passage = useCallback((threadId: string) => (doc ? passageOf(doc, annotations, threadId) : null), [doc, annotations]);

  const landed = useCallback(() => {
    appliedEpoch.current = epoch;
    setArrival((a) => (a.landed ? a : { ...a, landed: true }));
  }, [epoch]);

  useEffect(() => {
    const target = arrival.target;
    if (arrival.landed) return;
    if (!doc || !measured) return;
    if (!target) {
      landed();
      return;
    }
    if (target.kind === "comment") {
      if (!threads.ready) return;
      if (threads.refused) onNotice?.(threads.refused);
      else if (annotations.some((a) => a.annId === target.id)) onThread?.(target.id);
      else onNotice?.("comment-missing");
      landed();
      return;
    }
    if (target.kind === "slide") {
      if (paged && target.n <= slides.length) head(target.n - 1);
      landed();
      return;
    }
    const el = doc.getElementById(target.id);
    if (el) {
      const slide = paged ? slideOf(slides, el) : -1;
      if (slide >= 0) head(slide);
      // Instantly, as a browser goes to `#id`; the slide itself needs no scroll.
      if (slide < 0 || (el !== slides[slide].el && el !== slides[slide].outer)) {
        el.scrollIntoView({ block: "start", behavior: "auto" });
      }
    }
    landed();
  }, [arrival, doc, measured, threads.ready, threads.refused, annotations, paged, slides, head, onThread, onNotice, landed]);

  /**
   * A frame that loads again — a peer's draft, a trust change — shows a deck's
   * first slide. On a paged deck the address says which slide the reader was
   * on, so they are put back there. Not while following: the follow decides.
   */
  const following = follow !== null;
  useEffect(() => {
    if (!doc || !measured || !paged || following || !arrival.landed) return;
    if (appliedEpoch.current === null || appliedEpoch.current === epoch) return;
    appliedEpoch.current = epoch;
    const slide = slideOfTarget(doc, parseTarget(window.location.hash), slides, passage);
    if (slide >= 0 && slide !== locate()) head(slide);
  }, [doc, epoch, measured, paged, following, arrival.landed, slides, passage, locate, head]);

  /**
   * On a paged deck the address follows the slide. Replaced, never pushed, and
   * the router's own state kept with it, so Back still leaves the document and
   * the router still knows where it is.
   *
   * Only when the slide CHANGES: an address that does not name the slide on
   * screen is left alone until the reader moves, so a link's target stays in
   * it while the thread it names is still being opened, and a document opened
   * with no place in its address keeps none. Nor while a link's target has yet
   * to land, nor for a slide passed on the way to one, nor when the address
   * already names the new slide — a thread there, an element on it.
   */
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!doc || !measured || !paged || !arrival.landed) return;
    const at = locate();
    const slide = slides[at];
    if (!slide) return;
    if (seen.current === null || seen.current === at) {
      seen.current = at;
      return;
    }
    seen.current = at;
    const bound = heading.current;
    if (bound) {
      if (at !== bound.slide && Date.now() < bound.until) return;
      heading.current = null;
    }
    const here = window.location;
    const named = parseTarget(here.hash);
    if (slideOfTarget(doc, named, slides, passage) === at) return;
    const next = formatTarget(slideTarget(slide));
    if (next === here.hash) return;
    written.current = next;
    window.history.replaceState(window.history.state, "", `${here.pathname}${here.search}${next}`);
    // `current` is how the deck says it moved; `locate` is where it is now.
  }, [doc, measured, paged, arrival.landed, current, slides, passage, locate]);
}


/**
 * Where a thread's passage is: where its painted highlight starts, or its SVG
 * wrapper, or for a resolved thread, which has neither, the element its anchor
 * resolves in — strictly when it would be drawn strictly, exactly as
 * `redrawHighlights` decides.
 */
function passageOf(doc: Document, annotations: readonly Annotation[], annId: string): Element | null {
  const painted = paintedRange(doc, annId);
  if (painted) {
    const start = painted.startContainer;
    const el = start.nodeType === 1 ? (start as Element) : start.parentElement;
    if (el) return el;
  }
  const mark = Array.from(doc.querySelectorAll(HL_SELECTOR)).find((el) => el.getAttribute(ANN_ATTR) === annId);
  if (mark) return mark;
  const annotation = annotations.find((a) => a.annId === annId) ?? null;
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

/**
 * Whether the whole of a passage sits inside its frame's viewport: its painted
 * range where it has one, which a long paragraph's own box would misreport,
 * else the element.
 */
function inView(el: Element, painted: Range | null = null): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  const rect = painted && typeof painted.getBoundingClientRect === "function" ? painted.getBoundingClientRect() : el.getBoundingClientRect();
  return rect.top >= 0 && rect.bottom <= view.innerHeight;
}
