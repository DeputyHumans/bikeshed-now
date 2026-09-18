// SPDX-License-Identifier: Apache-2.0
// Presentation mode: chrome hidden, document full-window (SPEC §6d).

import { useCallback, useEffect, useState } from "react";

/**
 * Presentation is an APP-level state, so its class goes on <body>.
 *
 * It used to go on the viewer's own div, which quietly broke two of the four
 * things it claims to do: `.is-presenting .app-header` never matched, because
 * the header is a sibling of <main> and not a descendant of the viewer, and
 * `.is-presenting .viewer` never matched either, because .viewer CARRIED the
 * class rather than descending from it. Presenting therefore left the
 * application header on screen over the document.
 *
 * On <body> every one of those selectors means what it reads as — including
 * hiding the cookie banner, which would otherwise be the only chrome left on
 * somebody's full-window presentation.
 *
 * Fullscreen is an ENHANCEMENT. The browser may refuse it, and the CSS state is
 * what actually hides the chrome, so a refusal costs the window border and
 * nothing else.
 */
export function usePresenting(): {
  presenting: boolean;
  start: () => void;
  stop: () => void;
} {
  const [presenting, setPresenting] = useState(false);

  useEffect(() => {
    document.body.classList.toggle("is-presenting", presenting);
    return () => document.body.classList.remove("is-presenting");
  }, [presenting]);

  /**
   * Fullscreen is the browser's state, not ours, so ours has to follow it.
   *
   * Leaving fullscreen with Escape or F11 fires no click on the Exit button, so
   * `presenting` stayed true with every piece of chrome hidden and a
   * 35%-opacity button as the only way back out. The listener is armed only
   * while presenting, so it cannot interfere with a document that fullscreens
   * something of its own.
   */
  useEffect(() => {
    if (!presenting) return;
    const onChange = () => {
      if (!document.fullscreenElement) setPresenting(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [presenting]);

  const start = useCallback(() => {
    setPresenting(true);
    void document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);

  const stop = useCallback(() => {
    setPresenting(false);
    void document.exitFullscreen?.().catch(() => {});
  }, []);

  return { presenting, start, stop };
}
