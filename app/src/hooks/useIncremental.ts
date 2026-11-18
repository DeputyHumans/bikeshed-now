// SPDX-License-Identifier: Apache-2.0
// A long list drawn a batch at a time, with the next batch when its end comes within reach (SPEC §13 "Grid and list").

import { useCallback, useEffect, useState } from "react";

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

export function useIncremental(total: number, resetKey: string, batch: number = BATCH): Incremental {
  const [state, setState] = useState({ key: resetKey, count: batch });
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

  return { shown, total, batch, more, sentinel };
}
