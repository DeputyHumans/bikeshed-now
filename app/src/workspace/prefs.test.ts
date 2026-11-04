// SPDX-License-Identifier: Apache-2.0
// The workspace's remembered choices survive a return, and never break the page when storage is blocked (SPEC §13).

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PREF_KEYS, isLayout, readPref, useRemembered, writePref } from "./prefs";

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const block = () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
};

describe("reading and writing a choice", () => {
  it("reads back what was written, under the key defined for it", () => {
    writePref(PREF_KEYS.layoutFolders, "list");
    expect(window.localStorage.getItem("bshd-workspace-layout")).toBe('"list"');
    expect(readPref(PREF_KEYS.layoutFolders, isLayout)).toBe("list");
  });

  it("ignores a value this version does not understand, or that is not JSON at all", () => {
    window.localStorage.setItem(PREF_KEYS.layoutFolders, '"table"');
    expect(readPref(PREF_KEYS.layoutFolders, isLayout)).toBeNull();
    window.localStorage.setItem(PREF_KEYS.layoutFolders, "{not json");
    expect(readPref(PREF_KEYS.layoutFolders, isLayout)).toBeNull();
  });

  it("answers nothing, and throws nothing, when storage is blocked", () => {
    block();
    expect(readPref(PREF_KEYS.layoutFolders, isLayout)).toBeNull();
    expect(() => writePref(PREF_KEYS.layoutFolders, "list")).not.toThrow();
  });
});

describe("useRemembered", () => {
  it("starts from the stored choice and stores the next one", () => {
    writePref(PREF_KEYS.layoutFolders, "list");
    const { result } = renderHook(() => useRemembered(PREF_KEYS.layoutFolders, "grid", isLayout));
    expect(result.current[0]).toBe("list");
    act(() => result.current[1]("grid"));
    expect(result.current[0]).toBe("grid");
    expect(readPref(PREF_KEYS.layoutFolders, isLayout)).toBe("grid");
  });

  it("keeps each kind of page's choice apart, re-reading when the key changes under a mounted page", () => {
    // One workspace component serves several kinds of page; moving between
    // them must not carry one kind's layout into the other.
    type Key = (typeof PREF_KEYS)[keyof typeof PREF_KEYS];
    writePref(PREF_KEYS.layoutFolders, "list");
    const { result, rerender } = renderHook(({ key }: { key: Key }) => useRemembered(key, "grid", isLayout), {
      initialProps: { key: PREF_KEYS.layoutFolders as Key },
    });
    expect(result.current[0]).toBe("list");
    rerender({ key: PREF_KEYS.layoutShared });
    expect(result.current[0]).toBe("grid");
    act(() => result.current[1]("list"));
    rerender({ key: PREF_KEYS.layoutFolders });
    act(() => result.current[1]("grid"));
    expect(result.current[0]).toBe("grid");
    rerender({ key: PREF_KEYS.layoutShared });
    expect(result.current[0]).toBe("list");
    expect(readPref(PREF_KEYS.layoutFolders, isLayout)).toBe("grid");
  });

  it("still switches for this visit when storage is blocked", () => {
    block();
    const { result } = renderHook(() => useRemembered(PREF_KEYS.layoutFolders, "grid", isLayout));
    expect(result.current[0]).toBe("grid");
    act(() => result.current[1]("list"));
    expect(result.current[0]).toBe("list");
  });
});
