// SPDX-License-Identifier: Apache-2.0
// The comments panel opens only when there is a thread to read (SPEC §6).

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Annotation } from "../types";

import { useCommentsOpen } from "./useCommentsOpen";

// Only `resolved` is read; the rest is whatever Firestore would carry.
function thread(resolved: boolean): Annotation {
  return { annId: resolved ? "done" : "open", resolved } as Annotation;
}

describe("useCommentsOpen", () => {
  it("is closed before the first snapshot lands", () => {
    const { result } = renderHook(() => useCommentsOpen("doc-a"));

    expect(result.current.open).toBe(false);
  });

  it("opens on a first snapshot with an unresolved thread", () => {
    const { result } = renderHook(() => useCommentsOpen("doc-a"));

    act(() => result.current.settle([thread(true), thread(false)]));

    expect(result.current.open).toBe(true);
  });

  it("stays closed on a first snapshot with no threads", () => {
    const { result } = renderHook(() => useCommentsOpen("doc-a"));

    act(() => result.current.settle([]));

    expect(result.current.open).toBe(false);
  });

  it("stays closed when every thread is resolved", () => {
    // The panel hides resolved threads by default, so opening it would show
    // the same empty state as a version with nothing.
    const { result } = renderHook(() => useCommentsOpen("doc-a"));

    act(() => result.current.settle([thread(true)]));

    expect(result.current.open).toBe(false);
  });

  it("decides once: a later snapshot does not reopen a panel the reader closed", () => {
    const { result } = renderHook(() => useCommentsOpen("doc-a"));
    act(() => result.current.settle([thread(false)]));
    expect(result.current.open).toBe(true);

    act(() => result.current.setOpen(false));
    // A peer's comment landing.
    act(() => result.current.settle([thread(false), thread(false)]));

    expect(result.current.open).toBe(false);
  });

  it("lets a toggle made before the snapshot win", () => {
    const { result } = renderHook(() => useCommentsOpen("doc-a"));

    act(() => result.current.setOpen((v) => !v));
    expect(result.current.open).toBe(true);
    act(() => result.current.settle([]));

    expect(result.current.open).toBe(true);
  });

  it("decides again for another document in the same viewer instance", () => {
    // The same DocViewer navigates from one document straight into the next
    // without unmounting — the sequence useDocumentTitle already guards.
    const { result, rerender } = renderHook(({ docId }) => useCommentsOpen(docId), {
      initialProps: { docId: "doc-a" },
    });
    act(() => result.current.settle([thread(false)]));
    expect(result.current.open).toBe(true);

    rerender({ docId: "doc-b" });
    expect(result.current.open).toBe(false);

    act(() => result.current.settle([]));
    expect(result.current.open).toBe(false);

    // And the other way round: a reader who closed it on one document is not
    // holding it closed on the next.
    rerender({ docId: "doc-c" });
    act(() => result.current.settle([thread(false)]));
    expect(result.current.open).toBe(true);
  });
});
