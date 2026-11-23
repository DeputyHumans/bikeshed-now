// SPDX-License-Identifier: Apache-2.0
// The switch that hides comments and other people's activity lasts for the tab, across documents (SPEC §6, §16).

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { othersMenuEntry, setOthersShown, useOthersShown } from "./othersShown";

afterEach(() => setOthersShown(true));

describe("useOthersShown", () => {
  it("starts shown, and keeps what the reader chose across a viewer remounting for the next document", () => {
    const first = renderHook(() => useOthersShown());
    expect(first.result.current[0]).toBe(true);
    act(() => first.result.current[1](false));
    expect(first.result.current[0]).toBe(false);
    first.unmount();
    // The next document mounts a new viewer in the same tab.
    const next = renderHook(() => useOthersShown());
    expect(next.result.current[0]).toBe(false);
    act(() => next.result.current[1](true));
    expect(next.result.current[0]).toBe(true);
  });

  it("tells every viewer mounted at once", () => {
    const a = renderHook(() => useOthersShown());
    const b = renderHook(() => useOthersShown());
    act(() => a.result.current[1](false));
    expect(b.result.current[0]).toBe(false);
  });
});

describe("the menu's entry", () => {
  it("says what pressing it will do, and does it", () => {
    const set = vi.fn();
    const shown = othersMenuEntry(true, set);
    expect(shown.label).toBe("Hide comments and others' activity");
    shown.onSelect();
    expect(set).toHaveBeenLastCalledWith(false);
    const hidden = othersMenuEntry(false, set);
    expect(hidden.label).toBe("Show comments and others' activity");
    hidden.onSelect();
    expect(set).toHaveBeenLastCalledWith(true);
  });
});
