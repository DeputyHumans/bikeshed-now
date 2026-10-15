// SPDX-License-Identifier: Apache-2.0
// Simultaneous first join elects one seed instead of replicating the authored document twice (SPEC §6b, §16).

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { LiveLogSizeError, type UpdateLog } from "../crdt/log";
import { useSharedDocument } from "./useSharedDocument";

beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());

const transport = vi.hoisted(() => ({ current: null as unknown as UpdateLog }));
vi.mock("../crdt/rtdb", () => ({ rtdbLog: () => transport.current }));

it("elects one seed when two empty-log joins bind before either peer receives a wire update", async () => {
  const entries = new Map<string, string>();
  const listeners = new Set<(key: string, payload: string) => void>();
  const pending: [string, string][] = [];
  let sequence = 0;
  transport.current = {
    ready: async () => {},
    subscribe(receive) { listeners.add(receive); return () => listeners.delete(receive); },
    async append(payload) { const key = `entry-${sequence++}`; entries.set(key, payload); pending.push([key, payload]); return key; },
    async remove(keys) { for (const key of keys) entries.delete(key); },
    async initialize(payload: string) {
      if (!entries.has("_seed")) { entries.set("_seed", payload); pending.push(["_seed", payload]); }
      return entries.get("_seed")!;
    },
  } as UpdateLog;
  const docs = [0, 1].map(() => new DOMParser().parseFromString('<body><p id="sentinel">One authored document</p></body>', "text/html"));
  const views = docs.map((doc) => renderHook(() => useSharedDocument({ mode: { kind: "editing", baseVersion: "v1" }, doc, epoch: 1, docId: "d1", enabled: true })));
  try {
    await act(async () => { await Promise.resolve(); });
    // Both joins ran against empty snapshots; only now does the wire deliver.
    await act(async () => { while (pending.length) { const [key, payload] = pending.shift()!; for (const receive of listeners) receive(key, payload); } });
    await waitFor(() => expect(views.every((v) => v.result.current.state === "shared")).toBe(true));
    for (let i = 0; i < docs.length; i += 1) {
      expect(views[i].result.current.state).toBe("shared");
      expect(docs[i].querySelectorAll("#sentinel")).toHaveLength(1);
      expect(docs[i].body.textContent).toBe("One authored document");
    }
  } finally { for (const view of views) view.unmount(); }
});

it("keeps editing unbound when the configured shared transport refuses the initial read", async () => {
  const append = vi.fn();
  const stop = vi.fn();
  transport.current = { ready: async () => { throw new Error("PERMISSION_DENIED"); }, subscribe: () => stop, append, remove: vi.fn(), initialize: vi.fn() };
  const doc = new DOMParser().parseFromString('<body><p id="sentinel">Local draft</p></body>', "text/html");
  const view = renderHook(() => useSharedDocument({ mode: { kind: "editing", baseVersion: "v1" }, doc, epoch: 1, docId: "d1", enabled: true }));
  try {
    await act(async () => { await Promise.resolve(); });
    expect(view.result.current).toMatchObject({ state: "off", bound: false });
    expect(doc.body.textContent).toBe("Local draft");
    expect(stop).toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  } finally { view.unmount(); }
});

function memoryLog(): UpdateLog {
  return { ready: async () => {}, subscribe: () => () => {}, append: async () => "entry", remove: async () => {}, initialize: async (payload) => payload };
}
function sharedOptions(doc: Document, liveEpoch = "initial") {
  return { mode: { kind: "editing" as const, baseVersion: "v1" }, doc, epoch: 1, docId: "d1", enabled: true, liveEpoch };
}
it("does not bind a fresh seed over saved causal history after the shared log is lost", async () => {
  transport.current = memoryLog();
  const doc = new DOMParser().parseFromString("<p>Saved text</p>", "text/html");
  const view = renderHook(() => useSharedDocument({ ...sharedOptions(doc), expectedGeneration: "0".repeat(64) }));
  try {
    await waitFor(() => expect(view.result.current.error).toMatch(/could not start/));
    expect(view.result.current.bound).toBe(false);
    expect(view.result.current.causalStamp()).toBeNull();
    expect(doc.body.textContent).toBe("Saved text");
  } finally { view.unmount(); }
});
it("flushes pending DOM mutations into a synchronous causal stamp", async () => {
  const updates: string[] = [];
  transport.current = { ...memoryLog(), append: async (payload) => { updates.push(payload); return `entry-${updates.length}`; } };
  const doc = new DOMParser().parseFromString("<p>Before</p>", "text/html");
  const view = renderHook(() => useSharedDocument(sharedOptions(doc)));
  try {
    await waitFor(() => expect(view.result.current.bound).toBe(true));
    const before = view.result.current.causalStamp()!;
    doc.querySelector("p")!.firstChild!.textContent = "Before after";
    const after = view.result.current.causalStamp()!;
    expect(after).not.toEqual(before);
    expect(updates.length).toBeGreaterThan(0);
    expect(after.generation).toBe(before.generation);
  } finally { view.unmount(); }
});
it("keeps the replacement epoch bound when a cancelled old join rejects later", async () => {
  let rejectOld!: (reason: Error) => void;
  transport.current = { ...memoryLog(), ready: () => new Promise<void>((_resolve, reject) => { rejectOld = reject; }) };
  const doc = new DOMParser().parseFromString("<p>Current</p>", "text/html");
  const view = renderHook(({ liveEpoch }) => useSharedDocument(sharedOptions(doc, liveEpoch)), { initialProps: { liveEpoch: "old" } });
  try {
    transport.current = memoryLog();
    view.rerender({ liveEpoch: "new" });
    await waitFor(() => expect(view.result.current.state).toBe("shared"));
    const stamp = view.result.current.causalStamp();
    await act(async () => rejectOld(new Error("old read refused")));
    expect(view.result.current).toMatchObject({ state: "shared", bound: true, error: null });
    expect(view.result.current.causalStamp()).toEqual(stamp);
  } finally { view.unmount(); }
});
it("explains legacy recovery and permits solo binding only without a configured transport", async () => {
  const doc = new DOMParser().parseFromString("<p>Local</p>", "text/html");
  transport.current = { ...memoryLog(), ready: async () => { throw new Error("legacy log needs recovery"); } };
  const view = renderHook(({ liveEpoch }) => useSharedDocument(sharedOptions(doc, liveEpoch)), { initialProps: { liveEpoch: "initial" } });
  try {
    await waitFor(() => expect(view.result.current.error).toMatch(/original tab/));
    expect(view.result.current.bound).toBe(false);
    transport.current = null as unknown as UpdateLog;
    view.rerender({ liveEpoch: "next" });
    await waitFor(() => expect(view.result.current.bound).toBe(true));
    expect(view.result.current).toMatchObject({ state: "off", error: null });
    expect(view.result.current.causalStamp()).toBeNull();
  } finally { view.unmount(); }
});

it("shows an actionable size refusal and keeps an oversized document unbound", async () => {
  transport.current = { ...memoryLog(), initialize: async () => { throw new LiveLogSizeError(); } };
  const doc = new DOMParser().parseFromString("<p>Large authored content</p>", "text/html");
  const view = renderHook(() => useSharedDocument(sharedOptions(doc)));
  try {
    await waitFor(() => expect(view.result.current.error).toMatch(/too large.*2 MiB/));
    expect(view.result.current).toMatchObject({ bound: false, state: "off" });
    expect(view.result.current.error).toMatch(/upload/);
    expect(doc.body.textContent).toBe("Large authored content");
  } finally { view.unmount(); }
});
