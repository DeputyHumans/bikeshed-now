// SPDX-License-Identifier: Apache-2.0
// Dropping a file onto the workspace uploads it (SPEC §2, §11).

import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";

/**
 * Why a counter rather than a boolean.
 *
 * `dragleave` fires every time the pointer crosses into a CHILD element, so a
 * grid of cards turns one drag into a stream of enter/leave pairs and a boolean
 * flickers off the moment the pointer touches anything inside the zone. Only the
 * leave that balances the outermost enter means the drag has actually gone.
 *
 * The zone also has to claim `dragover` with `preventDefault`, or the browser
 * takes the drop itself and NAVIGATES to the file — losing whatever was on the
 * page. That is the failure mode of forgetting one line here.
 */
export interface FileDrop {
  /** True while a file is over this zone. Drives the visible target. */
  over: boolean;
  /** Spread onto the element that should accept files. */
  handlers: {
    onDragEnter: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
}

/** True when the drag carries FILES, rather than text or an in-page item. */
function carriesFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

export function useFileDrop(
  onFiles: (files: File[]) => void,
  enabled = true,
): FileDrop {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  const onDragEnter = useCallback(
    (e: DragEvent) => {
      if (!enabled || !carriesFiles(e)) return;
      e.preventDefault();
      // Nested zones: a folder card inside the workspace claims the drag, and
      // the workspace behind it must not light up as well.
      e.stopPropagation();
      depth.current += 1;
      setOver(true);
    },
    [enabled],
  );

  const onDragOver = useCallback(
    (e: DragEvent) => {
      if (!enabled || !carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    },
    [enabled],
  );

  const onDragLeave = useCallback(
    (e: DragEvent) => {
      if (!enabled || !carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    [enabled],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!enabled || !carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) onFiles(files);
    },
    [enabled, onFiles],
  );

  return useMemo(
    () => ({ over, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } }),
    [over, onDragEnter, onDragOver, onDragLeave, onDrop],
  );
}
