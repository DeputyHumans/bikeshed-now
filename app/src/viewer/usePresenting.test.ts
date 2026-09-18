// SPDX-License-Identifier: Apache-2.0
// Presenting follows the browser out of fullscreen (SPEC §6d).

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePresenting } from "./usePresenting";

/**
 * jsdom implements none of the Fullscreen API — `src/test/setup.ts` stubs
 * `matchMedia` and `requestAnimationFrame` and stops there — so every piece of
 * it is installed here and removed again.
 */
let fullscreenElement: Element | null = null;

function stubFullscreen({ refuse = false } = {}) {
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  document.documentElement.requestFullscreen = vi.fn(async () => {
    if (refuse) throw new Error("denied");
    fullscreenElement = document.documentElement;
  });
  document.exitFullscreen = vi.fn(async () => {
    fullscreenElement = null;
  });
}

function leaveFullscreenOutsideTheApp() {
  fullscreenElement = null;
  act(() => {
    document.dispatchEvent(new Event("fullscreenchange"));
  });
}

afterEach(() => {
  fullscreenElement = null;
  document.body.className = "";
  vi.restoreAllMocks();
});

describe("usePresenting", () => {
  it("hides the chrome and asks for fullscreen", () => {
    stubFullscreen();
    const { result } = renderHook(() => usePresenting());

    act(() => result.current.start());

    expect(result.current.presenting).toBe(true);
    expect(document.body.classList.contains("is-presenting")).toBe(true);
    expect(document.documentElement.requestFullscreen).toHaveBeenCalled();
  });

  it("comes back when the reader leaves fullscreen by Escape or F11", () => {
    // The bug: neither fires a click on our Exit button, so presenting stayed
    // true with every piece of chrome hidden and no obvious way back.
    stubFullscreen();
    const { result } = renderHook(() => usePresenting());
    act(() => result.current.start());

    leaveFullscreenOutsideTheApp();

    expect(result.current.presenting).toBe(false);
    expect(document.body.classList.contains("is-presenting")).toBe(false);
  });

  it("still presents when the browser refuses fullscreen", () => {
    // The CSS state is what hides the chrome; fullscreen is the enhancement.
    stubFullscreen({ refuse: true });
    const { result } = renderHook(() => usePresenting());

    act(() => result.current.start());

    expect(result.current.presenting).toBe(true);
    expect(document.body.classList.contains("is-presenting")).toBe(true);
  });

  it("listens for nothing until it is presenting", () => {
    stubFullscreen();
    const add = vi.spyOn(document, "addEventListener");
    renderHook(() => usePresenting());

    expect(add.mock.calls.filter(([type]) => type === "fullscreenchange")).toHaveLength(0);
  });

  it("stops on request, and leaves the chrome behind it", () => {
    stubFullscreen();
    const { result } = renderHook(() => usePresenting());
    act(() => result.current.start());

    act(() => result.current.stop());

    expect(result.current.presenting).toBe(false);
    expect(document.body.classList.contains("is-presenting")).toBe(false);
    expect(document.exitFullscreen).toHaveBeenCalled();
  });
});
