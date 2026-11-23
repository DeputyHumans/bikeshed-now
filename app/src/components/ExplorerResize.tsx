// SPDX-License-Identifier: Apache-2.0
// The explorer column's edge: drag it, or move it with the arrow keys, to set the column's width (SPEC §13 "The explorer").

import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { WidthBounds } from "../viewer/explorerWidth";

/** How far one press of an arrow moves the edge, and with Shift held. */
export const RESIZE_STEP = 16;
export const RESIZE_STEP_LARGE = 64;
/** A run of key presses is written to the account once it pauses this long. */
export const RESIZE_SETTLE_MS = 500;

/**
 * A window splitter (WAI-ARIA's separator pattern), on the column's right edge.
 *
 * The width moves with the pointer and is kept once, when the pointer comes
 * up: the account is written for a choice, never for every pixel of a drag.
 * The keys write once a run of presses pauses. A double click, or Enter, puts
 * it back where it starts.
 */
export function ExplorerResize({
  controls,
  width,
  bounds,
  onLive,
  onCommit,
  onDragging,
}: {
  /** The panel it sizes, for `aria-controls`. */
  controls: string;
  /** The width the column is drawn at now. */
  width: number;
  bounds: WidthBounds;
  /** A width to draw while it moves, not yet kept. */
  onLive: (width: number) => void;
  /** A width to keep. */
  onCommit: (width: number) => void;
  /** While a pointer drags it: the page stops selecting text and the document's frame stops taking the pointer. */
  onDragging: (dragging: boolean) => void;
}) {
  const drag = useRef<{ pointer: number; x: number; from: number; last: number } | null>(null);
  const timer = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  // The latest callbacks, so a pending write is never flushed by a re-render.
  const commitRef = useRef(onCommit);
  const draggingRef = useRef(onDragging);
  useLayoutEffect(() => {
    commitRef.current = onCommit;
    draggingRef.current = onDragging;
  });

  const clamp = (w: number) => Math.round(Math.min(bounds.max, Math.max(bounds.min, w)));

  const flush = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (pending.current === null) return;
    const w = pending.current;
    pending.current = null;
    commitRef.current(w);
  }, []);
  // Going away mid-run keeps what the keys had reached; going away mid-drag
  // (the column closing as the reader starts to edit) must not leave the
  // page unselectable and the document's frame deaf to the pointer.
  useEffect(
    () => () => {
      flush();
      if (drag.current) {
        drag.current = null;
        draggingRef.current(false);
      }
    },
    [flush],
  );

  const byKey = (w: number) => {
    onLive(w);
    pending.current = w;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, RESIZE_SETTLE_MS);
  };

  const end = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    drag.current = null;
    onDragging(false);
    onCommit(d.last);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the document list"
      aria-controls={controls}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width}
      tabIndex={0}
      className="explorer-resize"
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        flush();
        // Capture keeps the drag here over the document's frame, which would
        // otherwise take every move once the pointer crosses into it.
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { pointer: event.pointerId, x: event.clientX, from: width, last: width };
        onDragging(true);
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d || d.pointer !== event.pointerId) return;
        d.last = clamp(d.from + event.clientX - d.x);
        onLive(d.last);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => {
        flush();
        onCommit(bounds.initial);
      }}
      onBlur={flush}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
        const from = pending.current ?? width;
        let next: number | null = null;
        if (event.key === "ArrowLeft") next = clamp(from - step);
        else if (event.key === "ArrowRight") next = clamp(from + step);
        else if (event.key === "Home") next = bounds.min;
        else if (event.key === "End") next = bounds.max;
        else if (event.key === "Enter") {
          event.preventDefault();
          pending.current = null;
          flush();
          onCommit(bounds.initial);
          return;
        }
        if (next === null) return;
        event.preventDefault();
        byKey(next);
      }}
    />
  );
}
