// SPDX-License-Identifier: Apache-2.0
// The tab follows the document even where the server shell cannot (SPEC §17).

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useDocumentTitle } from "./useDocumentTitle";

describe("useDocumentTitle", () => {
  afterEach(() => {
    document.title = "Bikeshed";
  });

  it("sets the tab to the document's title while mounted", () => {
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: "Q3 acquisition memo" },
    });
    expect(document.title).toBe("Q3 acquisition memo");

    // Reactive to the title resolving later (Firestore, then the fallback).
    rerender({ title: "Updated title" });
    expect(document.title).toBe("Updated title");
  });

  it("restores the app's title on unmount", () => {
    const { unmount } = renderHook(() => useDocumentTitle("Q3 acquisition memo"));
    expect(document.title).toBe("Q3 acquisition memo");

    unmount();

    expect(document.title).toBe("Bikeshed");
  });

  it("falls back to the app title while the document is still loading", () => {
    // useDocument()'s EMPTY sentinel is title: "" for the whole loading
    // window, and permanently for a not-found/denied document — an empty
    // string must never reach document.title verbatim.
    renderHook(() => useDocumentTitle(""));

    expect(document.title).toBe("Bikeshed");
  });

  it("falls back to the app title rather than leaking a previous document's title", () => {
    // The same DocViewer instance navigates from one document straight into
    // loading the next (or into one that turns out not-found) without
    // unmounting in between — the only sequence a real visitor performs.
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: "Q3 acquisition memo" },
    });
    expect(document.title).toBe("Q3 acquisition memo");

    rerender({ title: "" });

    expect(document.title).toBe("Bikeshed");
  });
});
