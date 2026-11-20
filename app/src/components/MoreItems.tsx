// SPDX-License-Identifier: Apache-2.0
// What follows a list drawn a batch at a time: how much is shown, and a button for the rest (SPEC §13 "Grid and list").

import { useCallback, useEffect, useRef } from "react";
import type { Incremental } from "../hooks/useIncremental";

/** Every item's title link, in the order the lists draw them: folders, then documents. The explorer's are documents alone. */
const ITEM_TITLES = "a.doc-card-title, a.doc-row-title, a.explorer-doc";

/**
 * The sentinel `useIncremental` watches, and the way to the next batch for
 * anyone not scrolling: the button. Pressed, it moves focus to the first item
 * it drew, so a keyboard carries on from there; a batch drawn by scrolling
 * leaves focus where it is. Drawn only while something is still hidden.
 *
 * It sits beside the lists, in the same container, never inside a grid or a
 * table, so nothing that counts cards or rows counts it.
 */
export function MoreItems({ list }: { list: Incremental }) {
  const focusFrom = useRef<number | null>(null);
  const scope = useRef<Element | null>(null);
  const { sentinel } = list;
  // Stable, so React does not detach and reattach the sentinel on every render.
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) scope.current = node.parentElement;
      sentinel(node);
    },
    [sentinel],
  );

  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || list.shown <= from) return;
    focusFrom.current = null;
    const next = scope.current?.querySelectorAll<HTMLElement>(ITEM_TITLES)[from];
    next?.focus();
  }, [list.shown]);

  if (list.shown >= list.total) return null;
  const next = Math.min(list.batch, list.total - list.shown);
  return (
    <div className="workspace-more" ref={attach}>
      <span className="caption" role="status">
        {list.shown} of {list.total}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          focusFrom.current = list.shown;
          list.more();
        }}
      >
        Show {next} more
      </button>
    </div>
  );
}
