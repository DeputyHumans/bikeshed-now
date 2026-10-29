// SPDX-License-Identifier: Apache-2.0
// The print shortcut is the export; File → Print gets the whole frame (SPEC §20).

import { useEffect } from "react";

/**
 * Two ways a reader prints, one outcome each.
 *
 * Cmd+P / Ctrl+P is routed to the export — the same scrubbed, stamped snapshot
 * the toolbar's Print produces — instead of the browser's print
 * of this page, which is the app's header and toolbar with the document
 * clipped to its on-screen box. Both windows get the listener, as the deck keys
 * do: focus is usually inside the frame, and a parent-only listener is silently
 * dead the moment somebody clicks the document. A `defaultPrevented` event is
 * the document's own script having spoken first, the deck keys' convention.
 * Shift is not excluded: Cmd+Shift+P is Chrome's "system dialog" print and
 * prints the page just as wrongly.
 *
 * File → Print fires no key event and cannot be redirected, so the page has to
 * print acceptably on its own: `@media print` in viewer.css hides the chrome,
 * and this hook opens the frame to its content's full height on `beforeprint`
 * so the document paginates instead of printing as one clipped box. CSS cannot
 * do that part — nothing in the parent's stylesheet can see the content's
 * height. `afterprint` closes the frame again and puts the reader's scroll
 * position back, because a frame with no overflow forgets it, and printing
 * then cancelling must not cost anybody their place.
 *
 * Reads nothing from the frame and puts nothing in the document it owns, so the
 * declaration-order rule at the top of DocViewer does not apply.
 */
export function usePrinting(options: {
  doc: Document | null;
  epoch: number;
  /** Reading, with no dialog open — the same gate the deck keys use. */
  enabled: boolean;
  onPrint: () => void;
}): void {
  const { doc, epoch, enabled, onPrint } = options;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key !== "p" && e.key !== "P") return;
      e.preventDefault();
      onPrint();
    };
    window.addEventListener("keydown", onKey);
    doc?.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      doc?.removeEventListener("keydown", onKey);
    };
  }, [doc, epoch, enabled, onPrint]);

  useEffect(() => {
    if (!doc) return;
    // Same-origin, so the frame element resolves from inside; no ref to thread.
    const frame = doc.defaultView?.frameElement as HTMLElement | null;
    if (!frame) return;
    // `scrollingElement` is the root in standards mode and <body> in quirks
    // mode, which a hand-authored document may well be in.
    const scroller = () => doc.scrollingElement ?? doc.documentElement;
    let scrollTop = 0;
    const open = () => {
      // Idempotent: once open there is no overflow and the position reads 0,
      // so a second beforeprint must not overwrite what the first remembered.
      if (frame.style.height) return;
      scrollTop = scroller().scrollTop;
      frame.style.height = `${doc.documentElement.scrollHeight}px`;
    };
    const close = () => {
      frame.style.height = "";
      scroller().scrollTop = scrollTop;
    };
    window.addEventListener("beforeprint", open);
    window.addEventListener("afterprint", close);
    return () => {
      window.removeEventListener("beforeprint", open);
      window.removeEventListener("afterprint", close);
    };
  }, [doc, epoch]);
}
