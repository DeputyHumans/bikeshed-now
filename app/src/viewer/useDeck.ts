// SPDX-License-Identifier: Apache-2.0
// Moving through a deck: position, paging, and the keys that drive it (SPEC §6d).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { watchResize, watchScroll } from "./frameWatch";

import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import {
  activeIndex,
  isPaged,
  isShown,
  isStacked,
  readComputed,
  scanSlides,
  shownIndex,
  deckShape,
  FLUID_SHAPE,
  type Slide,
  type SlideScan,
  type DeckShape,
} from "./deck";

/**
 * This hook SCROLLS the document, presses its keys, and reads it. It never
 * writes to it, injects nothing, and marks nothing — so unlike the annotation,
 * presence and editor hooks it carries no ordering obligation against
 * `useInlineEditor`, and it is deliberately absent from
 * `viewer/invariant.test.tsx`'s harness. If it ever gains a marker, a class or
 * an attribute, both of those stop being true.
 *
 * A deck that runs its own JavaScript usually STACKS its slides — every one at
 * `position:absolute; inset:0`, one shown at a time — and on that shape
 * scrolling to a slide changes nothing, which left the rail, the overview and
 * the parent's arrow keys all dead on a trusted deck. So on a stacked deck
 * this hook reaches a slide by pressing the arrow keys the deck already
 * answers to, and reads position from which slide is SHOWN rather than from an
 * offset. That is the deck's own contract, the same one `onKey` below defers to
 * by yielding on `defaultPrevented`; the hash was rejected because its shape is
 * per-framework, and toggling the deck's class ourselves because that styles a
 * document this app does not own. A stacked deck that ignores the arrows is no
 * worse off than before: `goTo` falls back to the scroll that never worked.
 */

const NO_SLIDES: Slide[] = [];

/**
 * Walk a stacked deck from `from` to `to` with its own arrow keys, dispatched
 * on the frame's `body` so a deck listening on `body`, `document` or `window`
 * all hear it. `dispatchEvent` is false when a listener called
 * `preventDefault`, which is how a deck says it took the key; the first key it
 * does not take ends the walk and reports it, so the caller can fall back.
 */
function pressArrows(
  doc: Document,
  view: Window & typeof globalThis,
  from: number,
  to: number,
): boolean {
  const key = to > from ? "ArrowRight" : "ArrowLeft";
  for (let n = Math.abs(to - from); n > 0; n -= 1) {
    const event = new view.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    if (doc.body.dispatchEvent(event)) return false;
  }
  return true;
}

/** Which slide a stacked deck is showing, read live from the frame. */
function shownSlide(view: Window, slides: Slide[]): number {
  return shownIndex(slides.map((slide) => isShown(readComputed(view, slide.el))));
}

/**
 * Whether a stacked deck is still moving between slides: more than one of
 * them shown, or a slide in the middle of a transition or animation of its
 * own. A deck that fades starts the incoming slide at opacity 0 and keeps the
 * one it is leaving until the fade ends, so for that moment the only slide
 * shown is the old one, and a second move counted from it presses the wrong
 * number of keys. Reading the styles first makes the browser start the
 * transitions it is about to report.
 */
function moving(view: Window, slides: Slide[]): boolean {
  let shown = 0;
  for (const slide of slides) if (isShown(readComputed(view, slide.el)) && ++shown > 1) return true;
  return slides.some((slide) =>
    typeof slide.el.getAnimations === "function" && slide.el.getAnimations().some((a) => a.playState === "running"),
  );
}

/** How long a move this hook made is trusted over a deck that is still moving. */
const AIM_MS = 1500;

/**
 * Somewhere the reader is composing, so the keys are theirs, not ours.
 *
 * Duck-typed rather than `instanceof Element`, because the target usually comes
 * from the FRAME's realm and `instanceof` compares against the parent's
 * constructor — it is false for every element inside the document, which is
 * precisely the set this needs to recognise.
 */
const TYPING_SELECTOR =
  "input, textarea, select, [contenteditable=''], [contenteditable='true']";

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest(TYPING_SELECTOR) != null;
}

export interface DeckControls {
  scan: SlideScan;
  slides: Slide[];
  /** Index into `slides` of whatever is nearest the top of the frame. */
  current: number;
  /**
   * Where the deck is NOW, read from the frame rather than from `current`,
   * which follows the deck's own moves a moment late (an observer, a scroll).
   */
  locate: () => number;
  /** True when slides are about one viewport tall, so paging makes sense. */
  paged: boolean;
  /** What every thumbnail of the deck is shaped by: its slides' content (`deckShape`). */
  shape: DeckShape;
  overviewOpen: boolean;
  setOverviewOpen: (open: boolean) => void;
  /**
   * Show a slide. Every move counts as the reader's own, and lets go of a
   * follow (`onReaderMove`), except one made `{ follow: true }`, which is the
   * follow itself.
   */
  goTo: (index: number, how?: { follow?: boolean }) => void;
  next: () => void;
  prev: () => void;
  /** Re-read the document after a structural edit. */
  rescan: () => void;
  /**
   * The frame epoch the slide list and the latch above were measured for.
   * Until it equals the frame's epoch, `slides` and `paged` may still describe
   * the document before it, so anything that acts on a new document waits.
   */
  measuredEpoch: number;
}

export function useDeck({
  doc,
  epoch,
  keysEnabled,
  onReaderMove,
}: {
  doc: Document | null;
  epoch: number;
  /** False while a dialog owns the keyboard, or while editing. */
  keysEnabled: boolean;
  /** Told of every move but a follow's: the rail, the overview, the keys, a thread. */
  onReaderMove?: () => void;
}): DeckControls {
  // Read through a ref, so a caller's inline callback does not rebuild goTo.
  const onReaderMoveRef = useRef(onReaderMove);
  onReaderMoveRef.current = onReaderMove;
  const [scan, setScan] = useState<SlideScan>({ kind: "none" });
  // Which epoch `scan` was read from, and which one the latch has measured.
  const [scannedEpoch, setScannedEpoch] = useState(-1);
  const [measuredEpoch, setMeasuredEpoch] = useState(-1);
  // Bumped after a structural edit. Adding or reordering a slide is DOM
  // surgery that fires no load and no scroll, so nothing else would tell us
  // the list changed.
  const [nonce, setNonce] = useState(0);
  const [current, setCurrent] = useState(0);
  const [paged, setPaged] = useState(false);
  const [stacked, setStacked] = useState(false);
  const [shape, setShape] = useState<DeckShape>(FLUID_SHAPE);
  const [overviewOpen, setOverviewOpen] = useState(false);
  // Read by the key handler, so opening the overview does not re-bind it.
  const overviewOpenRef = useRef(overviewOpen);
  overviewOpenRef.current = overviewOpen;
  const reduceMotion = usePrefersReducedMotion();
  /**
   * True while `goTo` is pressing keys into the frame. The keys it presses
   * reach `onKey`'s own listener on the frame document, and on a stacked deck
   * that takes no arrow keys that is goTo → key → goTo → key until the stack
   * overflows. Not an `isTrusted` gate — see `onKey` for why that matters.
   */
  const driving = useRef(false);

  // Keyed on epoch, never on the iframe ref: `useDocFrame` bumps the epoch in
  // onLoad, and that is the only moment the document is known to be the new one.
  useEffect(() => {
    setScan(scanSlides(doc));
    setScannedEpoch(epoch);
  }, [doc, epoch, nonce]);

  // Position and the overview belong to the DOCUMENT, not to its slide list:
  // resetting them on a rescan would throw the reader back to slide one every
  // time somebody reordered a section.
  useEffect(() => {
    setCurrent(0);
    setOverviewOpen(false);
  }, [doc, epoch]);

  const rescan = useCallback(() => setNonce((n) => n + 1), []);

  const slides = scan.kind === "slides" ? scan.slides : NO_SLIDES;

  /**
   * Every measurement comes from the FRAME's view. A rect taken inside the
   * frame is relative to the frame's viewport, and an iframe's scroll never
   * reaches the parent window, so reading either from `window` gives a number
   * that looks plausible and tracks nothing.
   *
   * Position tracks scroll and resize; whether this is a DECK does not. See
   * the latch below for why that separation is load-bearing rather than tidy.
   *
   * A stacked deck moves by toggling a class or a style on a slide and fires
   * no scroll for it, so there position is which slide is shown, and the
   * attributes are what to watch. That is how the rail follows the reader's
   * own keys, clicks and wheel inside the frame. Observation only: nothing
   * here changes the document.
   */
  /**
   * The slide this hook last drove a stacked deck to, while the deck is still
   * on its way there: for that moment the frame cannot say where it is going.
   * Let go once the deck has stopped moving, or after `AIM_MS`.
   */
  const aim = useRef<{ index: number; until: number } | null>(null);

  const locate = useCallback((): number => {
    const view = doc?.defaultView;
    if (!view || slides.length === 0) return 0;
    const heading = aim.current;
    if (stacked && heading && Date.now() < heading.until && moving(view, slides)) return heading.index;
    return stacked
      ? shownSlide(view, slides)
      : activeIndex(slides.map((slide) => slide.outer.getBoundingClientRect().top));
  }, [doc, slides, stacked]);

  useEffect(() => {
    const view = doc?.defaultView;
    if (!view || slides.length === 0) return;
    const measure = () => {
      // Arrived, or never coming: the frame says where the deck is again.
      const heading = aim.current;
      if (heading && (Date.now() >= heading.until || !(stacked && moving(view, slides)))) aim.current = null;
      setCurrent(locate());
    };
    measure();
    // Watched: an engine that delivers a sandboxed deck no events would
    // otherwise never move the rail off its first slide (viewer/frameWatch.ts).
    const stopScroll = watchScroll(view.document, measure);
    const stopResize = watchResize(view.document, measure);
    // Attributes change when motion starts, while the outgoing slide can
    // still paint. Completion changes computed styles without DOM mutation.
    const motionEvents = ["transitionend", "transitioncancel", "animationend", "animationcancel"];
    if (stacked) for (const event of motionEvents) doc.addEventListener(event, measure, true);
    const observer = stacked && doc.body ? new view.MutationObserver(measure) : null;
    observer?.observe(doc.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden"],
    });
    return () => {
      stopScroll();
      stopResize();
      if (stacked) for (const event of motionEvents) doc.removeEventListener(event, measure, true);
      observer?.disconnect();
    };
  }, [doc, epoch, slides, stacked, locate]);

  /**
   * `paged`, `stacked` and `shape` are LATCHED: decided once per document,
   * never recomputed for a resize.
   *
   * That is not an optimisation. The rail renders only when `paged` is true,
   * and rendering it narrows the frame — which fires `resize` inside the guest,
   * reflows it, and can push its slides past the height `isPaged` accepts. Let
   * a resize revise the answer and the rail unmounts, the frame widens, the
   * answer flips back, and the viewer oscillates forever. It would fire only
   * for decks near the threshold, which is the worst kind of bug to own.
   *
   * It is also simply the truer statement: whether a document is a deck is a
   * property of the document, not of whether somebody opened a panel.
   */
  useEffect(() => {
    // The first pass after a load still holds the last document's slides, whose
    // nodes are detached and measure nothing. Wait for this document's list.
    if (scannedEpoch !== epoch) return;
    const view = doc?.defaultView;
    if (!view || slides.length === 0) {
      setPaged(false);
      setStacked(false);
      setShape(FLUID_SHAPE);
      setMeasuredEpoch(epoch);
      return;
    }
    const rects = slides.map((slide) => slide.outer.getBoundingClientRect());
    setPaged(isPaged(rects.map((r) => r.height), view.innerHeight));
    setStacked(isStacked(rects));
    setShape(deckShape({ width: view.innerWidth, height: view.innerHeight }, slides));
    setMeasuredEpoch(epoch);
  }, [doc, epoch, slides, scannedEpoch]);

  const goTo = useCallback(
    (index: number, how?: { follow?: boolean }) => {
      const slide = slides[Math.max(0, Math.min(slides.length - 1, index))];
      if (!slide) return;
      if (!how?.follow) onReaderMoveRef.current?.();
      const view = doc?.defaultView;
      if (stacked && view && doc.body) {
        // From where the deck IS, read live — the reader may have moved it
        // with its own controls since the last thing this hook did.
        driving.current = true;
        try {
          if (pressArrows(doc, view, locate(), slide.index)) {
            aim.current = { index: slide.index, until: Date.now() + AIM_MS };
            setCurrent(slide.index);
            return;
          }
        } finally {
          driving.current = false;
        }
        // The deck took no key. Fall through to the scroll: it does nothing on
        // a stacked deck, but it is exactly what happened before, so a deck
        // driven by clicks alone is no worse off.
      }
      slide.outer.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
      setCurrent(slide.index);
    },
    [doc, slides, stacked, reduceMotion, locate],
  );

  const next = useCallback(() => goTo(current + 1), [goTo, current]);
  const prev = useCallback(() => goTo(current - 1), [goTo, current]);

  useEffect(() => {
    if (!keysEnabled || slides.length === 0) return;

    const onKey = (e: KeyboardEvent) => {
      // Deliberately NOT gated on `e.isTrusted`, unlike the follow-mode release
      // in `usePeerPresence`. There the guard stops a scroll we caused from
      // cancelling the thing that caused it; here the only synthetic keydowns
      // come from assistive technology and from the document's own script, and
      // refusing the first would break a hard accessibility requirement to
      // defend against the second, which `defaultPrevented` already covers.
      //
      // The document's OWN script gets first refusal. When the frame is
      // trusted, a deck that ships arrow-key navigation has already run and
      // called preventDefault, and paging on top of it would advance twice.
      // When the frame is sandboxed that script never ran, which is exactly
      // the case this hook exists to cover.
      if (driving.current) return;
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      // Escape closes the overview, and does nothing at all when it is shut.
      // The overview binds no Escape of its own — other surfaces arm a
      // document-level one without a focus gate — so this is the only place
      // the key reaches it; leaving it untouched otherwise keeps presentation
      // mode's fullscreen exit, and every other Escape, exactly as they were.
      if (e.key === "Escape") {
        if (!overviewOpenRef.current) return;
        e.preventDefault();
        setOverviewOpen(false);
        return;
      }

      // Overview and paging belong only to measured pages. Prose keeps its keys.
      if (!paged) return;
      if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        setOverviewOpen((open) => !open);
        return;
      }

      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
          e.preventDefault();
          next();
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          prev();
          break;
        case "Home":
          e.preventDefault();
          goTo(0);
          break;
        case "End":
          e.preventDefault();
          goTo(slides.length - 1);
          break;
        default:
          break;
      }
    };

    // BOTH targets, because focus decides which one sees the event and the
    // reader's focus is usually inside the frame. A parent-only listener is
    // silently dead the moment somebody clicks the document.
    window.addEventListener("keydown", onKey);
    doc?.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      doc?.removeEventListener("keydown", onKey);
    };
  }, [doc, epoch, keysEnabled, slides, paged, next, prev, goTo]);

  return useMemo(
    () => ({
      scan,
      slides,
      current,
      locate,
      paged,
      shape,
      overviewOpen,
      setOverviewOpen,
      goTo,
      next,
      prev,
      rescan,
      measuredEpoch,
    }),
    [scan, slides, current, locate, paged, shape, overviewOpen, goTo, next, prev, rescan, measuredEpoch],
  );
}
