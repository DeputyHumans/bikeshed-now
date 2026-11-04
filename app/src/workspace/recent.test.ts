// SPDX-License-Identifier: Apache-2.0
// Recent merges your reads with new versions, marks what changed since you read it, and filters without losing either (SPEC §13 "Recent").

import { describe, expect, it } from "vitest";

import { NO_FILTERS, RECENT_WINDOW_MS, filterRecent, isRecentFilters, recentRows } from "./recent";
import type { DocLatest, DocMeta } from "../types";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const ME = "me@example.com";

const ts = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) }) as never;

/** A document whose current version `v{n}` was published at `at` by `by`. */
function doc(id: string, at: number | null, by: string | null = "ana@example.com", overrides: Partial<DocMeta> = {}): DocMeta {
  const latest: DocLatest | null =
    at === null ? null : { version: "v2", at: ts(at), byEmail: by, channel: "web", origin: "upload" };
  return {
    docId: id,
    title: id,
    slug: id,
    ownerUid: "u-ana",
    ownerEmail: "ana@example.com",
    currentVersion: "v2",
    viewers: [ME],
    editors: [],
    members: ["ana@example.com", ME],
    createdAt: null as never,
    updatedAt: null as never,
    ...(latest ? { latest } : {}),
    ...overrides,
  } as DocMeta;
}

const ids = (rows: { doc: DocMeta }[]) => rows.map((r) => r.doc.docId);

describe("recentRows", () => {
  it("merges what you read with what got a new version, newest event first, and says which put each there", () => {
    const docs = [
      doc("read-lately", NOW - 20 * 24 * HOUR),
      doc("updated-lately", NOW - 2 * HOUR),
      doc("both-read-last", NOW - 5 * HOUR),
      doc("untouched", NOW - 40 * 24 * HOUR),
    ];
    const reads = new Map([
      ["read-lately", NOW - 1 * HOUR],
      ["both-read-last", NOW - 3 * HOUR],
    ]);
    const rows = recentRows(docs, reads, ME, NOW);
    expect(ids(rows)).toEqual(["read-lately", "updated-lately", "both-read-last"]);
    expect(rows.map((r) => r.why)).toEqual(["read", "updated", "read"]);
  });

  it("looks back thirty days, for a read and for a new version alike", () => {
    const docs = [doc("old-read", NOW - 60 * 24 * HOUR), doc("edge", NOW - RECENT_WINDOW_MS), doc("old", NOW - RECENT_WINDOW_MS - 1)];
    const reads = new Map([["old-read", NOW - RECENT_WINDOW_MS - 1]]);
    expect(ids(recentRows(docs, reads, ME, NOW))).toEqual(["edge"]);
  });

  it("is the new versions alone when your reads could not be fetched", () => {
    const rows = recentRows([doc("a", NOW - HOUR), doc("b", NOW - 40 * 24 * HOUR)], null, ME, NOW);
    expect(ids(rows)).toEqual(["a"]);
    expect(rows[0]).toMatchObject({ readAt: null, isNew: false, why: "updated" });
  });

  it("shows nothing for a read of a document no longer in the workspace", () => {
    // A read row outlives access (ADR 0027); the workspace list decides.
    expect(recentRows([], new Map([["gone", NOW - HOUR]]), ME, NOW)).toEqual([]);
  });

  it("marks a document new once someone else publishes after your read, and not again once you read it", () => {
    // The sequence a reader lives through, one step after another.
    const reads = new Map([["plan", NOW - 3 * HOUR]]);
    const before = recentRows([doc("plan", NOW - 4 * HOUR)], reads, ME, NOW);
    expect(before[0].isNew).toBe(false);

    const published = recentRows([doc("plan", NOW - 2 * HOUR, "ana@example.com")], reads, ME, NOW);
    expect(published[0]).toMatchObject({ isNew: true, why: "updated" });

    reads.set("plan", NOW - 1 * HOUR);
    const reread = recentRows([doc("plan", NOW - 2 * HOUR, "ana@example.com")], reads, ME, NOW);
    expect(reread[0]).toMatchObject({ isNew: false, why: "read" });
  });

  it("does not mark your own new version as new, from the CLI or anywhere else you did not read it", () => {
    const reads = new Map([["mine", NOW - 3 * HOUR]]);
    const rows = recentRows([doc("mine", NOW - HOUR, ME)], reads, ME, NOW);
    expect(rows[0]).toMatchObject({ isNew: false, why: "updated" });
  });

  it("counts a version not summarized yet as somebody else's", () => {
    // Between a publish and its summary nobody is known (currentSummary falls
    // back to the record's own time); new is the safer reading.
    const pending = doc("pending", null, null, { updatedAt: ts(NOW - HOUR) });
    const rows = recentRows([pending], new Map([["pending", NOW - 2 * HOUR]]), ME, NOW);
    expect(rows[0]).toMatchObject({ isNew: true, updatedAt: NOW - HOUR });
  });
});

describe("filterRecent", () => {
  const docs = [
    doc("theirs-new", NOW - HOUR),
    doc("theirs-unread", NOW - 2 * HOUR),
    doc("mine-read", NOW - 30 * HOUR, ME, { ownerEmail: ME }),
  ];
  const reads = new Map([
    ["theirs-new", NOW - 5 * HOUR],
    ["mine-read", NOW - 3 * HOUR],
  ]);
  const rows = recentRows(docs, reads, ME, NOW);

  it("keeps everything with no filter on", () => {
    expect(ids(filterRecent(rows, NO_FILTERS, ME, true))).toEqual(["theirs-new", "theirs-unread", "mine-read"]);
  });

  it("narrows to what you opened, what someone else owns, and what is new since you read it, and combines them", () => {
    expect(ids(filterRecent(rows, { ...NO_FILTERS, opened: true }, ME, true))).toEqual(["theirs-new", "mine-read"]);
    expect(ids(filterRecent(rows, { ...NO_FILTERS, shared: true }, ME, true))).toEqual(["theirs-new", "theirs-unread"]);
    expect(ids(filterRecent(rows, { ...NO_FILTERS, unread: true }, ME, true))).toEqual(["theirs-new"]);
    expect(ids(filterRecent(rows, { opened: true, shared: true, unread: false }, ME, true))).toEqual(["theirs-new"]);
  });

  it("ignores the two filters that need your reads when there are none, rather than emptying the page", () => {
    const updatesOnly = recentRows(docs, null, ME, NOW);
    expect(ids(filterRecent(updatesOnly, { opened: true, shared: false, unread: true }, ME, false))).toEqual(["theirs-new", "theirs-unread", "mine-read"]);
    expect(ids(filterRecent(updatesOnly, { opened: true, shared: true, unread: true }, ME, false))).toEqual(["theirs-new", "theirs-unread"]);
  });
});

describe("isRecentFilters", () => {
  it("accepts the three switches and nothing a stored value might hold instead", () => {
    expect(isRecentFilters({ opened: true, shared: false, unread: false })).toBe(true);
    for (const v of [null, {}, { opened: true }, { opened: "yes", shared: false, unread: false }, "opened"]) {
      expect(isRecentFilters(v)).toBe(false);
    }
  });
});
