// SPDX-License-Identifier: Apache-2.0
// A long list drawn a batch at a time, with the next batch when its end comes within reach, and Back returning to where it was (SPEC §13 "Grid and list").

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { entryId, readPlace, savePlace, type Place } from "../workspace/place";

/**
 * Every workspace list used to draw everything it had, which for a busy
 * reader was hundreds of cards on a page they wanted the top of. Only the
 * drawing is limited: the list itself is still fetched whole, so a search,
 * the sort, the filters and the empty states all see every item.
 *
 * The count goes back to one batch whenever `resetKey` changes, during the
 * render that changed it, so a new page, folder, search, sort, filter or
 * layout never paints with the last one's count. Live updates replace the
 * list without a new key, so a document arriving or leaving keeps your place.
 *
 * With `remember`, the count and the window's scroll are kept for this
 * history entry (`workspace/place.ts`), and a list mounted again for the same
 * entry and the same `resetKey`, by Back after opening a document, draws as
 * much as it had and scrolls back once `remember.ready` says its items have
 * landed. Until then nothing is kept, so the scroll a half-drawn page clamps
 * to never overwrites the place it is about to return to.
 */

/** How many items each batch draws. */
export const BATCH = 25;

/** How close the end of the list comes, below the screen, before the next batch is drawn. */
export const AHEAD = "0px 0px 400px 0px";

export interface Incremental {
  /** How many items to draw, never more than `total`. */
  shown: number;
  total: number;
  batch: number;
  /** Draws the next batch. */
  more: () => void;
  /** A ref for the element after the list: when it comes within reach, the next batch is drawn. */
  sentinel: (el: Element | null) => void;
}

export interface IncrementalOptions {
  batch?: number;
  /** Keep this list's place for its history entry; `ready` once its items have landed. */
  remember?: { ready: boolean };
}

export function useIncremental(total: number, resetKey: string, options: IncrementalOptions = {}): Incremental {
  const batch = options.batch ?? BATCH;
  const remember = options.remember ?? null;

  // Read once, when the list mounts: this entry's id, and its place when the
  // reader is coming back to the same list.
  const [entry] = useState(() => (remember ? entryId() : null));
  const [returning] = useState<Place | null>(() => {
    if (!entry) return null;
    const kept = readPlace(entry);
    return kept && kept.list === resetKey ? kept : null;
  });

  const [state, setState] = useState(() => ({ key: resetKey, count: returning ? Math.max(batch, returning.shown) : batch }));
  let count = state.count;
  if (state.key !== resetKey) {
    count = batch;
    setState({ key: resetKey, count: batch });
  }
  const shown = Math.min(count, total);

  const more = useCallback(() => setState((s) => ({ ...s, count: s.count + batch })), [batch]);

  const [el, setEl] = useState<Element | null>(null);
  const sentinel = useCallback((node: Element | null) => setEl(node), []);

  // Observed afresh after every batch: a new observer reports where the
  // sentinel is now, so a batch too short to push it out of reach draws the
  // next one too. Without an observer, the button after the list still works.
  useEffect(() => {
    if (!el || shown >= total || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) more();
      },
      { rootMargin: AHEAD },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, shown, total, more]);

  // --- Back returns to the same place ---------------------------------------

  const settled = useRef(returning === null);
  const ready = remember?.ready ?? false;
  const latest = useRef({ list: resetKey, shown });
  latest.current = { list: resetKey, shown };

  const keep = useCallback(() => {
    if (!entry || !settled.current) return;
    savePlace(entry, { ...latest.current, y: window.scrollY, at: Date.now() });
  }, [entry]);

  // Before paint, once the items are there: the reader never sees the top first.
  useLayoutEffect(() => {
    if (settled.current || !ready || !returning) return;
    settled.current = true;
    window.scrollTo(0, returning.y);
  }, [ready, returning]);

  useLayoutEffect(() => {
    keep();
  }, [keep, shown, resetKey]);

  useEffect(() => {
    if (!entry) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        keep();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [entry, keep]);

  // Leaving: a layout cleanup runs before the list's nodes go, while the
  // window is still scrolled where the reader left it.
  useLayoutEffect(() => () => keep(), [keep]);

  return { shown, total, batch, more, sentinel };
}
