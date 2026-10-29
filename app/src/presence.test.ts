// SPDX-License-Identifier: Apache-2.0
// Presence lifetime, per-session ownership and user aggregation across reconnects and multiple tabs (SPEC §16).

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { joinPresence, watchPeers } from "./presence";

const calls = vi.hoisted(() => ({
  rtdb: {} as object | null, value: vi.fn(), disconnect: vi.fn(), set: vi.fn(async (_path: string, _payload: unknown) => {}), remove: vi.fn(async (_path: string) => {}),
}));
vi.mock("./firebase", () => ({ get rtdb() { return calls.rtdb; } }));
vi.mock("firebase/database", () => ({
  ref: (_database: unknown, path: string) => path,
  onValue: calls.value, onDisconnect: calls.disconnect,
  set: calls.set, remove: calls.remove, serverTimestamp: () => 123,
}));

beforeEach(() => {
  calls.rtdb = {};
  vi.useFakeTimers(); vi.setSystemTime(10_000); vi.clearAllMocks();
  calls.value.mockReturnValue(vi.fn());
  calls.disconnect.mockReturnValue({ remove: vi.fn(async () => {}), cancel: vi.fn(async () => {}) });
});
afterEach(() => { vi.useRealTimers(); });
const focus = { elementId: "p", exact: "words", prefix: "", suffix: "", start: 0, end: 5 };
const connect = async (index = 0) => {
  calls.value.mock.calls[index][1]({ val: () => true });
  await Promise.resolve(); await Promise.resolve();
};

it("never resurrects a departed peer from queued focus or viewport throttles", async () => {
  const peer = joinPresence("d", "u", "A@example.test", "A", "edit");
  await connect();
  peer.setFocus(focus); peer.setFocus({ ...focus, start: 1 });
  peer.setViewport(0.1); peer.setViewport(0.9);
  peer.leave(); const writes = calls.set.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls.set).toHaveBeenCalledTimes(writes);
});

it("does not announce after a pending disconnect registration resolves following leave", async () => {
  let armed = () => {};
  calls.disconnect.mockReturnValue({ remove: () => new Promise<void>((resolve) => { armed = resolve; }), cancel: vi.fn(async () => {}) });
  const peer = joinPresence("d", "u", "a@example.test", "A", "edit");
  calls.value.mock.calls[0][1]({ val: () => true });
  peer.leave(); armed(); await Promise.resolve(); await Promise.resolve();
  expect(calls.set).not.toHaveBeenCalled();
});

it("ignores every setter on a handle after it leaves", async () => {
  const peer = joinPresence("d", "u", "a@example.test", "A", "view");
  await connect(); peer.leave(); const writes = calls.set.mock.calls.length;
  peer.setMode("edit"); peer.setComposing("thread"); peer.setFocus(focus); peer.setViewport(0.5);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls.set).toHaveBeenCalledTimes(writes);
});

it("broadcasts the trailing null focus so an old peer selection disappears", async () => {
  const peer = joinPresence("d", "u", "a@example.test", "A", "view");
  await connect(); peer.setFocus(focus); peer.setFocus(null);
  await vi.advanceTimersByTimeAsync(200);
  expect(calls.set.mock.calls.at(-1)?.[1]).not.toHaveProperty("focus");
  peer.leave();
});

it("gives two tabs of one account distinct records and removes only the leaving tab", async () => {
  const first = joinPresence("d", "u", "a@example.test", "A", "edit");
  const second = joinPresence("d", "u", "a@example.test", "A", "view");
  await connect(0); await connect(1);
  const paths = calls.set.mock.calls.map((row) => row[0]);
  expect(new Set(paths).size).toBe(2);
  expect(calls.set.mock.calls.map((row) => row[1])).toEqual([
    expect.objectContaining({ uid: "u", mode: "edit" }), expect.objectContaining({ uid: "u", mode: "view" }),
  ]);
  second.leave(); expect(calls.remove).toHaveBeenCalledWith(paths[1]);
  expect(calls.remove).not.toHaveBeenCalledWith(paths[0]);
  first.leave();
});

it("groups session records by person and retains editing while any tab edits, including legacy records", () => {
  const seen = vi.fn();
  watchPeers("d", "self", seen);
  const sample = {
    tabA: { uid: "u", email: "a@example.test", name: "A", mode: "edit", focus, lastChanged: 10 },
    tabB: { uid: "u", email: "a@example.test", name: "A", mode: "view", lastChanged: 20 },
    legacy: { email: "old@example.test", name: "Old", mode: "view", lastChanged: 5 },
    ownTab: { uid: "self", email: "me@example.test", mode: "edit", lastChanged: 30 },
  };
  calls.value.mock.calls[0][1]({ val: () => sample });
  expect(seen.mock.calls[0][0]).toEqual([
    expect.objectContaining({ uid: "u", mode: "edit", focus }),
    expect.objectContaining({ uid: "legacy", mode: "view" }),
  ]);
});

it("without a database URL every presence operation is inert and readers receive an empty list", () => {
  calls.rtdb = null;
  const peer = joinPresence("d", "u", "a@example.test", "A", "edit");
  peer.setMode("view"); peer.setFocus(focus); peer.setViewport(0.2); peer.setComposing("t"); peer.leave();
  const seen = vi.fn(); watchPeers("d", "u", seen)();
  expect(seen).toHaveBeenCalledWith([]);
  expect(calls.value).not.toHaveBeenCalled();
  expect(calls.set).not.toHaveBeenCalled();
});

it("one page observes edit to view to absent when a person's sessions depart in order", () => {
  const seen = vi.fn(); watchPeers("d", "self", seen);
  const notify = (value: unknown) => calls.value.mock.calls[0][1]({ val: () => value });
  const editor = { uid: "u", email: "a@example.test", mode: "edit", lastChanged: 1 };
  const reader = { uid: "u", email: "a@example.test", mode: "view", lastChanged: 2 };
  notify({ first: editor, second: reader });
  notify({ second: reader });
  notify(null);
  expect(seen.mock.calls.map(([peers]) => peers.map((p: { mode: string }) => p.mode))).toEqual([["edit"], ["view"], []]);
});

it("a delayed throttle timer cannot overwrite a newer immediate focus update", async () => {
  const peer = joinPresence("d", "u", "a@example.test", "A", "view");
  await connect(); peer.setFocus(focus); peer.setFocus({ ...focus, exact: "older" });
  vi.setSystemTime(11_000); // Input may run before an overdue timer after a busy frame.
  peer.setFocus({ ...focus, exact: "newest" });
  await vi.advanceTimersByTimeAsync(200);
  expect(calls.set.mock.calls.at(-1)?.[1]).toHaveProperty("focus.exact", "newest");
  peer.leave();
});
