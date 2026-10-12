// SPDX-License-Identifier: Apache-2.0
// Dropping a file onto the open document offers it as the next version (SPEC §2).

import { useCallback, useEffect, useRef, useState } from "react";
import { useFileDrop, type FileDrop } from "../hooks/useFileDrop";

/**
 * The document is in a same-origin frame, and a drag over a frame belongs to
 * the frame's document: the page around it never hears of it. Worse, a file
 * dropped there is the browser's to handle, and it opens the file in the frame
 * in place of the document.
 *
 * So the frame's document is only listened to. A file dragged into it raises a
 * target in the PAGE, over the frame, and from then on the drag is over that
 * target, where `useFileDrop` takes it like any other. Nothing is added to the
 * frame's document, so nothing can reach its bytes; the listeners go when it
 * is replaced or the drop is switched off.
 *
 * A drag can end in the frame without telling it, with Escape or by leaving
 * the window, so the raise lapses on its own once the drag stops moving over
 * the frame. Dropping never publishes anything: it opens the dialog with the
 * file, which says what publishing it would do.
 */
const LAPSE_MS = 500;

/** True when the drag carries FILES, rather than text or an in-page item. */
function carriesFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

export function useVersionDrop(options: {
  enabled: boolean;
  doc: Document | null;
  epoch: number;
  onFile: (file: File) => void;
}): FileDrop {
  const { enabled, doc, epoch, onFile } = options;
  const [raised, setRaised] = useState(false);
  const lapse = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(onFile);
  latest.current = onFile;

  const lower = useCallback(() => {
    if (lapse.current) clearTimeout(lapse.current);
    lapse.current = null;
    setRaised(false);
  }, []);
  const take = useCallback(
    (files: File[]) => {
      lower();
      if (files[0]) latest.current(files[0]);
    },
    [lower],
  );
  const chrome = useFileDrop(take, enabled);

  useEffect(() => {
    if (!enabled || !doc) {
      lower();
      return;
    }
    const raise = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setRaised(true);
      if (lapse.current) clearTimeout(lapse.current);
      lapse.current = setTimeout(lower, LAPSE_MS);
    };
    // Reached only if the drop lands before the target is up under the pointer.
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      lower();
      const file = e.dataTransfer?.files?.[0];
      if (file) latest.current(file);
    };
    doc.addEventListener("dragenter", raise);
    doc.addEventListener("dragover", raise);
    doc.addEventListener("drop", drop);
    return () => {
      doc.removeEventListener("dragenter", raise);
      doc.removeEventListener("dragover", raise);
      doc.removeEventListener("drop", drop);
      lower();
    };
  }, [doc, epoch, enabled, lower]);

  return { over: enabled && (chrome.over || raised), handlers: chrome.handlers };
}
