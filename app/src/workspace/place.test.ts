// SPDX-License-Identifier: Apache-2.0
// A list's place is kept per history entry, by an id the entry carries, and storage that fails costs only the place (SPEC §13 "Grid and list").

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLACES_KEPT, PLACES_KEY, entryId, readPlace, savePlace } from "./place";

const place = (over: Partial<{ list: string; shown: number; y: number; at: number }> = {}) => ({
  list: "everything",
  shown: 50,
  y: 900,
  at: 1,
  ...over,
});

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a history entry's id", () => {
  it("is written into the entry's own state once, beside what the router keeps there, and read back after", () => {
    window.history.replaceState({ idx: 3, key: "k" }, "");
    const id = entryId();
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
    expect(window.history.state).toEqual({ idx: 3, key: "k", bshdPlace: id });
    expect(entryId()).toBe(id);
  });

  it("is new for an entry that has none, so a fresh visit never inherits another's place", () => {
    const first = entryId();
    window.history.replaceState(null, "");
    expect(entryId()).not.toBe(first);
  });

  it("is null where history cannot be written", () => {
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(entryId()).toBeNull();
  });
});

describe("a kept place", () => {
  it("is read back for its own entry only", () => {
    savePlace("a", place());
    expect(readPlace("a")).toEqual(place());
    expect(readPlace("b")).toBeNull();
  });

  it("keeps only the newest entries", () => {
    for (let i = 0; i < PLACES_KEPT + 5; i++) savePlace(`e${i}`, place({ at: i }));
    const kept = JSON.parse(window.sessionStorage.getItem(PLACES_KEY) ?? "{}");
    expect(Object.keys(kept)).toHaveLength(PLACES_KEPT);
    expect(readPlace("e0")).toBeNull();
    expect(readPlace(`e${PLACES_KEPT + 4}`)?.at).toBe(PLACES_KEPT + 4);
  });

  it("ignores what it cannot read as a place", () => {
    window.sessionStorage.setItem(PLACES_KEY, JSON.stringify({ a: { list: "x", shown: -1, y: 0, at: 0 }, b: "nope", c: place() }));
    expect(readPlace("a")).toBeNull();
    expect(readPlace("b")).toBeNull();
    expect(readPlace("c")).toEqual(place());
    window.sessionStorage.setItem(PLACES_KEY, "{not json");
    expect(readPlace("c")).toBeNull();
  });

  it("costs only the place where storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => savePlace("a", place())).not.toThrow();
    expect(readPlace("a")).toBeNull();
  });
});
