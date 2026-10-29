// SPDX-License-Identifier: Apache-2.0
// Starts and stops the reading clock (SPEC §4).

import { useEffect, useRef } from "react";
import { refusesListeners, watchScroll, watchSelection } from "./frameWatch";
import { trackView, type ViewTracker } from "../stats";

/**
 * The tracker owns the clock; this hook owns its lifetime and wires the
 * interaction signal.
 *
 * Interaction is observed INSIDE the document, not in the parent: a reader
 * scrolling a deck never touches the parent frame, and counting them idle would
 * make the whole statistic a measure of how often somebody clicks the toolbar.
 */
export function useReadingSession(options: {
  docId: string;
  versionId: string | null;
  /** An unlisted document's key, from the URL. The server needs it to count the view. */
  k?: string;
  doc: Document | null;
  epoch: number;
  /** Reading a draft is editing, not reading. It is not a view. */
  enabled: boolean;
}): void {
  const { docId, versionId, k, doc, epoch, enabled } = options;
  const tracker = useRef<ViewTracker | null>(null);

  useEffect(() => {
    if (!enabled || !versionId) return;
    tracker.current = trackView(docId, versionId, k || undefined);
    return () => {
      tracker.current?.stop();
      tracker.current = null;
    };
  }, [enabled, docId, versionId, k]);

  useEffect(() => {
    if (!doc || !tracker.current) return;
    const mark = () => tracker.current?.markActive();
    // Where no gesture is delivered (viewer/frameWatch.ts), what a reader does
    // to the page is what can be seen of it: a scroll, or a selection.
    if (refusesListeners(doc)) {
      const stops = [watchScroll(doc, mark), watchSelection(doc, mark)];
      return () => {
        for (const stop of stops) stop();
      };
    }
    const events = ["pointerdown", "keydown", "scroll", "wheel"] as const;
    for (const type of events) {
      doc.addEventListener(type, mark, { passive: true });
    }
    return () => {
      for (const type of events) doc.removeEventListener(type, mark);
    };
  }, [doc, epoch]);
}
