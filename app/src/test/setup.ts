// SPDX-License-Identifier: Apache-2.0
// Vitest setup: the few globals jsdom does not provide.

import { afterEach, vi } from "vitest";

/**
 * jsdom implements neither matchMedia nor requestAnimationFrame in the shape
 * this app uses, and both are load-bearing rather than incidental: the
 * responsive branches read matchMedia, and the peer overlay coalesces its
 * repaints into one frame.
 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id as unknown as NodeJS.Timeout)) as typeof window.cancelAnimationFrame;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
