// SPDX-License-Identifier: Apache-2.0
// View choices are the account's, copied into this browser so a page draws right at once, taken by a tab once, and never break a page when storage is blocked (SPEC §13, ADR 0041).

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserRecord } from "../types";

const state = vi.hoisted(() => ({
  auth: { user: { uid: "u-me" } as { uid: string } | null, emailLower: "me@example.com", gate: "ready" as string },
  /** The account's listener, as the store opened it: its first answer is the one a tab takes. */
  onData: null as ((record: Partial<UserRecord> | null) => void) | null,
  watched: [] as string[],
  stopped: 0,
  save: vi.fn(async (_uid: string, _email: string, _fields: Partial<UserRecord>) => {}),
}));

vi.mock("../firebase", () => ({ auth: {}, db: {}, rtdb: null }));
vi.mock("../auth", () => ({ useAuth: () => state.auth }));
vi.mock("../firestore", () => ({
  watchUser: (uid: string, onData: (record: Partial<UserRecord> | null) => void) => {
    state.watched.push(uid);
    state.onData = onData;
    return () => {
      state.stopped += 1;
    };
  },
  saveUserProfile: (uid: string, email: string, fields: Partial<UserRecord>) => state.save(uid, email, fields),
}));

import { LEGACY_KEYS, accountFields, cacheKey, choicesOf, forgetViewChoices, isLayout, useViewChoice } from "./prefs";

const copy = (uid = "u-me") => JSON.parse(window.localStorage.getItem(cacheKey(uid)) ?? "null");
const answer = (record: Partial<UserRecord> | null) => act(() => state.onData!(record));
const layout = () => renderHook(() => useViewChoice("layout.folders", "grid", isLayout));

beforeEach(() => {
  state.auth = { user: { uid: "u-me" }, emailLower: "me@example.com", gate: "ready" };
  state.onData = null;
  state.watched = [];
  state.stopped = 0;
  state.save.mockReset();
  state.save.mockImplementation(async () => {});
  forgetViewChoices();
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

const block = () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
};

describe("where each choice lives on the account", () => {
  it("reads every choice from `view`, and the explorer's open or closed from beside it", () => {
    expect(
      choicesOf({
        explorerOpen: true,
        view: { sort: "name", layout: { folders: "list", recent: "grid" }, recentFilters: { opened: true, shared: false, unread: false }, explorerWidth: 320 },
      }),
    ).toEqual({
      sort: "name",
      "layout.folders": "list",
      "layout.recent": "grid",
      recentFilters: { opened: true, shared: false, unread: false },
      explorerOpen: true,
      explorerWidth: 320,
    });
    expect(choicesOf(null)).toEqual({});
  });

  it("writes one choice as the fields that hold it, nested so a merge touches nothing else", () => {
    expect(accountFields({ "layout.recent": "grid" })).toEqual({ view: { layout: { recent: "grid" } } });
    expect(accountFields({ explorerOpen: false })).toEqual({ explorerOpen: false });
    expect(accountFields({ sort: "name", explorerWidth: 300, "layout.shared": "list" })).toEqual({
      view: { sort: "name", explorerWidth: 300, layout: { shared: "list" } },
    });
  });
});

describe("a tab and the account", () => {
  it("draws from this browser's copy at once, then takes the account's and keeps a copy of it", async () => {
    window.localStorage.setItem(cacheKey("u-me"), JSON.stringify({ "layout.folders": "list" }));
    const { result } = layout();
    expect(result.current[0]).toBe("list");
    expect(state.watched).toEqual(["u-me"]);
    answer({ view: { layout: { folders: "grid" }, sort: "name" } });
    expect(result.current[0]).toBe("grid");
    expect(copy()).toEqual({ "layout.folders": "grid", sort: "name" });
    // Taken once: the listener is closed again, so nothing more is read for it.
    expect(state.stopped).toBe(1);
  });

  it("leaves a page already open alone when the account changes later, from another tab or device", () => {
    const { result } = layout();
    answer({ view: { layout: { folders: "list" } } });
    answer({ view: { layout: { folders: "grid" } } });
    expect(result.current[0]).toBe("list");
  });

  it("writes a change to the account and to this browser's copy at once", async () => {
    const { result } = layout();
    answer({});
    await act(async () => {
      expect(await result.current[1]("list")).toBe(true);
    });
    expect(result.current[0]).toBe("list");
    expect(state.save).toHaveBeenLastCalledWith("u-me", "me@example.com", { view: { layout: { folders: "list" } } });
    expect(copy()).toEqual({ "layout.folders": "list" });
  });

  it("keeps a change made before the account answered", async () => {
    const { result } = layout();
    await act(async () => {
      await result.current[1]("list");
    });
    answer({ view: { layout: { folders: "grid" } } });
    expect(result.current[0]).toBe("list");
  });

  it("puts a refused change back, here and in the copy, and says so", async () => {
    state.save.mockImplementation(async () => {
      throw new Error("refused");
    });
    const { result } = layout();
    answer({ view: { layout: { folders: "grid" } } });
    let stored: boolean | undefined;
    await act(async () => {
      stored = await result.current[1]("list");
    });
    expect(stored).toBe(false);
    expect(result.current[0]).toBe("grid");
    expect(copy()).toEqual({ "layout.folders": "grid" });
  });

  it("keeps each account's choices apart on one browser", () => {
    window.localStorage.setItem(cacheKey("u-me"), JSON.stringify({ "layout.folders": "list" }));
    state.auth = { user: { uid: "u-two" }, emailLower: "two@example.com", gate: "ready" };
    const { result } = layout();
    expect(result.current[0]).toBe("grid");
    expect(state.watched).toEqual(["u-two"]);
  });

  it("re-reads at once when the choice changes under a mounted page", () => {
    window.localStorage.setItem(cacheKey("u-me"), JSON.stringify({ "layout.folders": "list" }));
    type Choice = "layout.folders" | "layout.shared";
    const { result, rerender } = renderHook(({ choice }: { choice: Choice }) => useViewChoice(choice, "grid", isLayout), {
      initialProps: { choice: "layout.folders" as Choice },
    });
    expect(result.current[0]).toBe("list");
    rerender({ choice: "layout.shared" });
    expect(result.current[0]).toBe("grid");
  });

  it("reads a value this version does not understand as the default", () => {
    const { result } = layout();
    answer({ view: { layout: { folders: "table" } } });
    expect(result.current[0]).toBe("grid");
  });
});

describe("the choices this browser kept before they moved to the account", () => {
  it("moves them up where the account has none, keeps the account's where it has one, and removes them", () => {
    window.localStorage.setItem(LEGACY_KEYS["layout.folders"]!, JSON.stringify("list"));
    window.localStorage.setItem(LEGACY_KEYS.sort!, JSON.stringify("name"));
    const { result } = layout();
    expect(result.current[0]).toBe("list");
    answer({ view: { sort: "recent" } });
    expect(state.save).toHaveBeenCalledTimes(1);
    expect(state.save).toHaveBeenCalledWith("u-me", "me@example.com", { view: { layout: { folders: "list" } } });
    expect(copy()).toEqual({ "layout.folders": "list", sort: "recent" });
    expect(window.localStorage.getItem(LEGACY_KEYS["layout.folders"]!)).toBeNull();
    expect(window.localStorage.getItem(LEGACY_KEYS.sort!)).toBeNull();
  });

  it("writes nothing up when the account already has every one", () => {
    window.localStorage.setItem(LEGACY_KEYS["layout.folders"]!, JSON.stringify("list"));
    layout();
    answer({ view: { layout: { folders: "grid" } } });
    expect(state.save).not.toHaveBeenCalled();
  });
});

describe("where nothing can be kept", () => {
  it("still switches, and still reaches the account, when storage is blocked", async () => {
    block();
    const { result } = layout();
    expect(result.current[0]).toBe("grid");
    answer({ view: { layout: { folders: "list" } } });
    expect(result.current[0]).toBe("list");
    await act(async () => {
      await result.current[1]("grid");
    });
    expect(result.current[0]).toBe("grid");
    expect(state.save).toHaveBeenLastCalledWith("u-me", "me@example.com", { view: { layout: { folders: "grid" } } });
  });

  it("signed out: a choice lasts as long as the page, and nothing is read or written", async () => {
    state.auth = { user: null, emailLower: "", gate: "signed_out" };
    const { result } = layout();
    await act(async () => {
      await result.current[1]("list");
    });
    expect(result.current[0]).toBe("list");
    expect(state.watched).toEqual([]);
    expect(state.save).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });
});
