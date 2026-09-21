// SPDX-License-Identifier: Apache-2.0
// Whether the comments panel is showing, and what it starts as (SPEC §6).

import { useCallback, useState, type SetStateAction } from "react";

import type { Annotation } from "../types";

/**
 * The panel's default is decided ONCE per document, by the first annotation
 * snapshot: open when a thread is unresolved, collapsed when none is. It used
 * to be `useState(true)`, which put a 340px column reading "0 open" beside
 * every document that had nothing to say.
 *
 * Unresolved rather than any, because the panel hides resolved threads until
 * asked, so a version whose every thread is resolved would open to the same
 * empty state as a version with none.
 *
 * Until that snapshot lands the answer is "closed". The list is `[]` both
 * before the first snapshot and for a version with no threads, which is why
 * the decision is a callback the subscription makes and not a value derived
 * from the list: nothing else can tell those two apart.
 *
 * Whichever comes first, the snapshot or the reader, wins — and nothing after
 * it changes the answer. A peer's comment landing must not reopen a panel the
 * reader closed, and a toggle before the snapshot is a choice, not a default.
 *
 * Keyed on the document, not the version: the same DocViewer instance navigates
 * from one document straight into the next without unmounting, and the next
 * decides for itself; but publishing a version of THIS document must not
 * collapse a panel the reader had open.
 *
 * Reads nothing from the frame and puts nothing in the document it owns, so the
 * declaration-order rule at the top of DocViewer does not apply.
 */
export function useCommentsOpen(docId: string): {
  open: boolean;
  setOpen: (next: SetStateAction<boolean>) => void;
  /** Called with every snapshot. Only the first one per document decides. */
  settle: (annotations: Annotation[]) => void;
} {
  // The decision carries the document it was made for. Deriving "undecided"
  // from a mismatch, rather than resetting in an effect, means there is never
  // a render that shows the previous document's answer.
  const [state, setState] = useState<{ docId: string; open: boolean | null }>({
    docId,
    open: null,
  });
  const open = state.docId === docId ? state.open : null;

  const settle = useCallback(
    (annotations: Annotation[]) =>
      setState((s) =>
        s.docId === docId && s.open !== null
          ? s
          : { docId, open: annotations.some((a) => !a.resolved) },
      ),
    [docId],
  );

  const setOpen = useCallback(
    (next: SetStateAction<boolean>) =>
      setState((s) => {
        const current = s.docId === docId ? (s.open ?? false) : false;
        return { docId, open: typeof next === "function" ? next(current) : next };
      }),
    [docId],
  );

  return { open: open ?? false, setOpen, settle };
}
