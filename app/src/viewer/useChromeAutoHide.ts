// SPDX-License-Identifier: Apache-2.0
// On a phone, the bars above a document get out of the way while it is being read (SPEC §6, §7).

import { useEffect, useRef, useState } from "react";
import { watchResize, watchScroll } from "./frameWatch";

/**
 * Two rows of controls are an eighth of a phone's screen, and a reader scrolling
 * down is not reaching for them. So they go on the way down and come back on the
 * way up, as a phone's own browser bars do.
 *
 * The frame really grows, by the rows leaving the viewer's grid. The alternative,
 * sliding them over a frame that is always full height, was rejected because it
 * would hide the bottom of a document that scrolls an inner element for good: such
 * a document never reports a scroll, so nothing would ever bring that part into view.
 *
 * Nothing here writes to the document. It reads scroll, size and selection, and
 * sets an attribute on the parent's own `.viewer`, so it has no place in
 * `viewer/invariant.test.tsx`'s harness and no reason to precede `useInlineEditor`.
 *
 * Measured in iOS Safari: a flick keeps its momentum across the resize (835 px with
 * it, 800 to 823 without), and `scrollY` keeps moving while the page decelerates,
 * so the 150 ms sample WebKit makes us use is late, never wrong.
 */

export interface ChromeScroll {
  hidden: boolean;
  /** Where the current run of scrolling started, in one direction. */
  anchor: number;
  /** The frame's height when last seen, to notice our own resize. */
  viewH: number;
}

export interface ChromeReading {
  y: number;
  maxY: number;
  viewH: number;
  /** How tall the bars are, which is how much scrolling a document has to spare. */
  chromeH: number;
  /** Stay exactly as you are: a selection is being made, or a peer is being followed. */
  frozen: boolean;
}

/** Scrolled this far from the top, the bars are always there to be found. */
const AT_TOP = 8;
const HIDE_AFTER = 48;
/** Less than hiding takes, because a reader looking for the bars wants them now. */
const SHOW_AFTER = 24;

export const CHROME_AT_REST: ChromeScroll = { hidden: false, anchor: 0, viewH: 0 };

/**
 * One step, as a pure function, because the order of these rules is the whole thing:
 *
 * 1. Clamp, which takes iOS's rubber-banding out at both ends.
 * 2. If the frame changed height, start again from here. Hiding near the bottom
 *    clamps `scrollY` by up to the height of the bars, which would otherwise read
 *    as a scroll up, show the bars, and do it again for as long as the reader stays.
 * 3. Near the top the bars are shown, whatever came before.
 * 4. A document that could not scroll past the bars never hides them: there would
 *    be no scrolling left to bring them back with.
 */
export function nextChrome(state: ChromeScroll, reading: ChromeReading): ChromeScroll {
  const y = Math.min(Math.max(reading.y, 0), Math.max(reading.maxY, 0));
  if (reading.frozen || reading.viewH !== state.viewH) {
    return { hidden: state.hidden, anchor: y, viewH: reading.viewH };
  }
  if (y <= AT_TOP) return { hidden: false, anchor: y, viewH: reading.viewH };
  if (state.hidden) {
    const anchor = Math.max(state.anchor, y);
    return anchor - y >= SHOW_AFTER
      ? { hidden: false, anchor: y, viewH: reading.viewH }
      : { hidden: true, anchor, viewH: reading.viewH };
  }
  const anchor = Math.min(state.anchor, y);
  return y - anchor >= HIDE_AFTER && reading.maxY - reading.chromeH >= HIDE_AFTER
    ? { hidden: true, anchor: y, viewH: reading.viewH }
    : { hidden: false, anchor, viewH: reading.viewH };
}

/**
 * Whether content moves when the frame changes height: sections sized in `vh`, which
 * WebKit does not anchor, so a paragraph 424 px down the page jumped by 424 px when
 * the bars left. One hero screen moves by exactly the bars and looks like nothing, so
 * only more than that counts.
 *
 * Measured by trying it, inside one task, so nothing is ever painted that way.
 */
export function movesWithHeight(doc: Document, viewer: HTMLElement, chromeH: number): boolean {
  const before = doc.documentElement.scrollHeight;
  viewer.setAttribute("data-chrome", "hidden");
  const after = doc.documentElement.scrollHeight;
  viewer.removeAttribute("data-chrome");
  return Math.abs(after - before) > chromeH * 1.5;
}

/** After the page or the state around it changes, its own scrolling is not the reader's. */
const QUIET_MS = 1000;

export function useChromeAutoHide({
  enabled,
  doc,
  epoch,
  revealKey,
  frozen,
}: {
  /** The one switch: off, and the two rows simply stay where they are. */
  enabled: boolean;
  doc: Document | null;
  epoch: number;
  /** Anything new to say above the document. A change brings the bars back, once. */
  revealKey: string;
  /** Read on every step, for what must not move under the reader. */
  frozen: () => boolean;
}): boolean {
  const [hidden, setHidden] = useState(false);
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;

  useEffect(() => {
    setHidden(false);
    if (!enabled || !doc) return;
    const view = doc.defaultView;
    const viewer = document.querySelector<HTMLElement>(".viewer");
    const bars = document.querySelector<HTMLElement>(".viewer-toolbar");
    if (!view || !viewer || !bars) return;
    if (movesWithHeight(doc, viewer, bars.offsetHeight)) return;

    let state = CHROME_AT_REST;
    const quietUntil = Date.now() + QUIET_MS;
    const step = () => {
      let reading: ChromeReading;
      try {
        const viewH = view.innerHeight;
        reading = {
          y: view.scrollY,
          maxY: doc.documentElement.scrollHeight - viewH,
          viewH,
          chromeH: bars.offsetHeight,
          frozen: Date.now() < quietUntil || frozenRef.current(),
        };
      } catch {
        return; // a frame on its way out
      }
      state = nextChrome(state, reading);
      setHidden(state.hidden);
    };
    step();
    const stopScroll = watchScroll(doc, step);
    // Its own size too. Where the scroll is sampled, a frame that has just grown goes
    // unseen until the next scroll, which would then be spent noticing, not counted:
    // a small nudge up would not bring the bars back.
    const stopResize = watchResize(doc, step);
    return () => {
      stopScroll();
      stopResize();
      setHidden(false);
    };
  }, [enabled, doc, epoch, revealKey]);

  return hidden;
}
