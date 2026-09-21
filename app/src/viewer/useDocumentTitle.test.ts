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
});
