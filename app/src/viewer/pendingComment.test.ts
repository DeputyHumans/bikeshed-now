// SPDX-License-Identifier: Apache-2.0
// A passage kept across the sign-in page (SPEC §3).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Anchor } from "../types";

const anchor = { exact: "the passage", prefix: "", suffix: "", start: 0, end: 11 } as unknown as Anchor;
const pending = { docId: "doc-1", version: "v2", anchor };
const NOW = 1_800_000_000_000;

/** A fresh module each time: a real return from a provider reloads the page, and memory with it. */
const fresh = async () => {
  vi.resetModules();
  return import("./pendingComment");
};

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("a comment waiting on a sign-in", () => {
  it("survives a page load, for the document it was made on", async () => {
    (await fresh()).savePendingComment(pending, NOW);
    const { readPendingComment } = await fresh();
    expect(readPendingComment("doc-1", NOW + 1000)).toEqual(pending);
    expect(readPendingComment("doc-2", NOW + 1000)).toBeNull();
  });

  it("can be read more than once, so a render is free to read it, until it is cleared", async () => {
    const { savePendingComment, readPendingComment, clearPendingComment } = await fresh();
    savePendingComment(pending, NOW);
    expect(readPendingComment("doc-1", NOW)).toEqual(pending);
    expect(readPendingComment("doc-1", NOW)).toEqual(pending);
    clearPendingComment();
    expect(readPendingComment("doc-1", NOW)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("goes stale, so a highlight from an hour ago does not become a thread", async () => {
    const { savePendingComment, readPendingComment } = await fresh();
    savePendingComment(pending, NOW);
    expect(readPendingComment("doc-1", NOW + 29 * 60_000)).toEqual(pending);
    expect(readPendingComment("doc-1", NOW + 31 * 60_000)).toBeNull();
  });

  it("still covers a sign-in with no reload when storage refuses", async () => {
    const { savePendingComment, readPendingComment } = await fresh();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("refused");
    });
    savePendingComment(pending, NOW);
    expect(readPendingComment("doc-1", NOW)).toEqual(pending);
  });

  it("reads garbage in storage as nothing", async () => {
    sessionStorage.setItem("bikeshed.pendingComment", "{not json");
    expect((await fresh()).readPendingComment("doc-1", NOW)).toBeNull();
  });

  it("never puts the passage in the address", async () => {
    const before = window.location.href;
    (await fresh()).savePendingComment(pending, NOW);
    expect(window.location.href).toBe(before);
  });
});
