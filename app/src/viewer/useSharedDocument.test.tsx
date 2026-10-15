// SPDX-License-Identifier: Apache-2.0
// Simultaneous first join elects one seed instead of replicating the authored document twice (SPEC §6b, §16).

import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { UpdateLog } from "../crdt/log";
import { useSharedDocument } from "./useSharedDocument";

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
    for (let i = 0; i < docs.length; i += 1) {
      expect(views[i].result.current.state).toBe("shared");
      expect(docs[i].querySelectorAll("#sentinel")).toHaveLength(1);
      expect(docs[i].body.textContent).toBe("One authored document");
    }
  } finally { for (const view of views) view.unmount(); }
});

it("falls back to local editing without claiming Shared when the transport refuses the initial read", async () => {
  const append = vi.fn();
  const stop = vi.fn();
  transport.current = { ready: async () => { throw new Error("PERMISSION_DENIED"); }, subscribe: () => stop, append, remove: vi.fn(), initialize: vi.fn() };
  const doc = new DOMParser().parseFromString('<body><p id="sentinel">Local draft</p></body>', "text/html");
  const view = renderHook(() => useSharedDocument({ mode: { kind: "editing", baseVersion: "v1" }, doc, epoch: 1, docId: "d1", enabled: true }));
  try {
    await act(async () => { await Promise.resolve(); });
    expect(view.result.current).toMatchObject({ state: "off", bound: true });
    expect(doc.body.textContent).toBe("Local draft");
    expect(stop).toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  } finally { view.unmount(); }
});
