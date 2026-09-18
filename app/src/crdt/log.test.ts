// SPDX-License-Identifier: Apache-2.0
// Two peers on one log converge, and the log does not grow forever (SPEC §6b).

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COMPACT_AFTER, connect, fromBase64, toBase64, type UpdateLog } from "./log";

/**
 * An in-memory log shared by every peer in a test, standing in for the RTDB
 * node. It reproduces the two properties that matter: an entry is delivered to
 * everybody including its author, and entries already present are delivered on
 * subscribe.
 */
function makeLog() {
  const entries = new Map<string, string>();
  const listeners = new Set<(key: string, payload: string) => void>();
  let next = 0;
  let online = true;
  const api: UpdateLog & {
    entries: typeof entries;
    setOnline(v: boolean): void;
  } = {
    entries,
    setOnline(v) {
      online = v;
      if (!online) return;
      for (const l of listeners) for (const [k, p] of entries) l(k, p);
    },
    async ready() {},
    subscribe(onEntry) {
      listeners.add(onEntry);
      for (const [k, p] of entries) onEntry(k, p);
      return () => listeners.delete(onEntry);
    },
    async append(payload) {
      const key = `e${next++}`;
      entries.set(key, payload);
      if (online) for (const l of listeners) l(key, payload);
      return key;
    },
    async remove(keys) {
      for (const k of keys) entries.delete(k);
    },
  };
  return api;
}

const text = (doc: Y.Doc) => doc.getText("t").toString();
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("base64", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });

  it("survives an update too large for String.fromCharCode(...bytes)", () => {
    // The naive spread throws RangeError past the argument limit, and a
    // document only has to be a few hundred kilobytes to get there.
    const big = new Uint8Array(200_000).map((_, i) => i % 256);
    expect(() => toBase64(big)).not.toThrow();
    expect(fromBase64(toBase64(big)).length).toBe(big.length);
  });
});

describe("two peers on one log", () => {
  it("converge on the same text", async () => {
    const log = makeLog();
    const a = new Y.Doc();
    const b = new Y.Doc();
    connect(a, log);
    connect(b, log);

    a.getText("t").insert(0, "hello");
    await settle();
    b.getText("t").insert(5, " world");
    await settle();

    expect(text(a)).toBe(text(b));
    expect(text(a)).toBe("hello world");
  });

  it("does not echo: one local edit appends exactly one entry", async () => {
    // Without the origin tag every peer re-appends every update it receives,
    // and the log grows without bound while the document does nothing.
    const log = makeLog();
    const a = new Y.Doc();
    const b = new Y.Doc();
    connect(a, log);
    connect(b, log);
    a.getText("t").insert(0, "x");
    await settle();
    expect(log.entries.size).toBe(1);
  });

  it("merges edits made while a peer was offline", async () => {
    const log = makeLog();
    const a = new Y.Doc();
    connect(a, log);
    a.getText("t").insert(0, "shared ");
    await settle();

    // B joins late and must catch up from the entries already there.
    const b = new Y.Doc();
    connect(b, log);
    await settle();
    expect(text(b)).toBe("shared ");

    log.setOnline(false);
    a.getText("t").insert(7, "A");
    b.getText("t").insert(7, "B");
    await settle();
    log.setOnline(true);
    await settle();

    expect(text(a)).toBe(text(b));
    expect(text(a)).toContain("A");
    expect(text(a)).toContain("B");
  });

  it("a late joiner sees a compacted log as the same document", async () => {
    const log = makeLog();
    const a = new Y.Doc();
    connect(a, log);
    for (let i = 0; i < COMPACT_AFTER + 5; i += 1) {
      a.getText("t").insert(a.getText("t").length, "x");
      await settle();
    }
    // Compaction happened: the log is far shorter than the edit count.
    expect(log.entries.size).toBeLessThan(COMPACT_AFTER);

    const late = new Y.Doc();
    connect(late, log);
    await settle();
    expect(text(late)).toBe(text(a));
    expect(text(late).length).toBe(COMPACT_AFTER + 5);
  });

  it("stops appending once destroyed", async () => {
    const log = makeLog();
    const a = new Y.Doc();
    const conn = connect(a, log);
    a.getText("t").insert(0, "x");
    await settle();
    const before = log.entries.size;
    conn.destroy();
    a.getText("t").insert(0, "y");
    await settle();
    expect(log.entries.size).toBe(before);
  });

  it("ignores a malformed entry rather than failing every peer", async () => {
    const log = makeLog();
    const a = new Y.Doc();
    connect(a, log);
    a.getText("t").insert(0, "good");
    await settle();
    await log.append("!!!not base64 at all!!!");
    await settle();
    // Still readable, still converged with what came before it.
    expect(text(a)).toBe("good");
  });
});
