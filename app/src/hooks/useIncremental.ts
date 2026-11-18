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
 * With `remember`, the count and the window's scroll are kept for the history
 * entry the list is showing (`workspace/place.ts`). The workspace stays
 * mounted while the reader moves between its pages, so the entry is looked up
 * again whenever `remember.at`, the router's location key, changes: an entry
 * the reader comes back to, by Back after a document or between pages, draws
 * as much as it had and scrolls back once `remember.ready` says its items have
 * landed, and a new entry starts at the top. Until a returning list has
 * scrolled back nothing is kept, so the scroll a half-drawn page clamps to
 * never overwrites the place it is about to return to.
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
  /**
   * Keep this list's place for its history entry. `at` changes on every
   * navigation (the router's location key); `ready` once the items have landed.
   */
  remember?: { at: string; ready: boolean };
}

/** Which history entry the list is showing, and the place kept for it when it is the same list. */
interface Entry {
  at: string | null;
  id: string | null;
  returning: Place | null;
}

function lookup(at: string | null, list: string): Entry {
  const id = entryId();
  const kept = id ? readPlace(id) : null;
  return { at, id, returning: kept && kept.list === list ? kept : null };
}

export function useIncremental(total: number, resetKey: string, options: IncrementalOptions = {}): Incremental {
  const batch = options.batch ?? BATCH;
  const remember = options.remember ?? null;
  const at = remember?.at ?? null;

  // The entry, looked up when the list mounts and again after every navigation.
  const [tracked, setTracked] = useState<Entry>(() => (remember ? lookup(at, resetKey) : { at, id: null, returning: null }));
  let entry = tracked;
  if (remember && tracked.at !== at) {
    entry = lookup(at, resetKey);
    setTracked(entry);
  }

  // One count per entry and list. A new entry starts from its kept place, if
  // any; a new list in the same entry starts from one batch.
  const listKey = `${entry.id ?? ""}\n${resetKey}`;
  const startAt = (e: Entry) => (e.returning ? Math.max(batch, e.returning.shown) : batch);
  const [state, setState] = useState(() => ({ key: listKey, entry: entry.id, count: startAt(entry) }));
  let count = state.count;
  if (state.key !== listKey) {
    count = state.entry !== entry.id ? startAt(entry) : batch;
    setState({ key: listKey, entry: entry.id, count });
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
        if (entries.some((e) => e.isIntersecting)) more();
      },
      { rootMargin: AHEAD },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, shown, total, more]);

  // --- Back returns to the same place ---------------------------------------

  const ready = remember?.ready ?? false;
  /** The entry being kept, and whether its returning place has been scrolled back to yet. */
  const place = useRef({ id: entry.id, returning: entry.returning, settled: entry.returning === null });
  const latest = useRef({ list: resetKey, shown });
  latest.current = { list: resetKey, shown };
  /** Where the reader last scrolled to, read on every scroll: by the time a page has changed, the window may not say. */
  const lastY = useRef(typeof window === "undefined" ? 0 : window.scrollY);
  /** The place noted for the entry being kept, written to storage on the next frame or before the entry changes. */
  const pending = useRef<{ id: string; place: Place } | null>(null);

  const flush = useCallback(() => {
    const p = pending.current;
    pending.current = null;
    if (p) savePlace(p.id, p.place);
  }, []);
  const note = useCallback(() => {
    const p = place.current;
    if (!p.id || !p.settled) return;
    pending.current = { id: p.id, place: { ...latest.current, y: lastY.current, at: Date.now() } };
  }, []);

  // A navigation while mounted: what was noted for the entry being left is
  // written first, then a new entry starts at the top and a returning one
  // waits below for its items. On mount the page is already where it should be.
  useLayoutEffect(() => {
    if (place.current.id === entry.id) return;
    flush();
    place.current = { id: entry.id, returning: entry.returning, settled: entry.returning === null };
    if (!entry.returning) {
      window.scrollTo(0, 0);
      lastY.current = 0;
    }
  }, [entry.id, entry.returning, flush]);

  // Before paint, once the items are there: the reader never sees the top first.
  useLayoutEffect(() => {
    const p = place.current;
    if (p.settled || !ready || !p.returning) return;
    p.settled = true;
    window.scrollTo(0, p.returning.y);
    lastY.current = p.returning.y;
  }, [ready, entry.id]);

  useLayoutEffect(() => {
    note();
    flush();
  }, [note, flush, shown, resetKey, entry.id]);

  const remembering = remember !== null;
  useEffect(() => {
    if (!remembering) return;
    let frame = 0;
    const onScroll = () => {
      lastY.current = window.scrollY;
      note();
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        flush();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [note, flush, remembering]);

  // Leaving: a layout cleanup runs before the list's nodes go, while the
  // window is still scrolled where the reader left it.
  useLayoutEffect(
    () => () => {
      if (place.current.settled) lastY.current = window.scrollY;
      note();
      flush();
    },
    [note, flush],
  );

  return { shown, total, batch, more, sentinel };
}
