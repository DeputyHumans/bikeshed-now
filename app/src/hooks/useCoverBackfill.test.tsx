// SPDX-License-Identifier: Apache-2.0
// The workspace fills in covers nobody has captured, one at a time, and only what it may (SPEC §2, §6d).

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCoverBackfill, resetBackfillAttempts, type BackfillOptions } from "./useCoverBackfill";
import type { Captured, Capturer } from "../viewer/capture";
import { THUMB_REVISION, resetUploadClaims } from "../thumbs";
import type { DocMeta } from "../types";

const ME = "me@example.com";
const KEY = "0123456789abcdef";

function doc(id: string, over: Partial<DocMeta> = {}): DocMeta {
  return {
    docId: id,
    title: id,
    slug: id,
    ownerUid: "u1",
    ownerEmail: ME,
    currentVersion: "v2",
    viewers: [],
    editors: [],
    members: [ME],
    trusted: false,
    createdAt: null,
    updatedAt: null,
    ...over,
  } as unknown as DocMeta;
}

const page = (title: string, extra = "") =>
  `<!doctype html><html><head><style>h1{color:navy}</style></head><body><h1>${title}</h1>${extra}</body></html>`;

function harness(html: Record<string, string>, opts: { uniform?: boolean; failing?: string } = {}) {
  const captured: string[] = [];
  const capturer: Capturer = {
    async capture(preview, o) {
      expect(o?.page).toBe(true);
      const title = /<h1>([^<]*)<\/h1>/.exec(preview)?.[1] ?? "?";
      if (title === opts.failing) throw new Error("render failed");
      captured.push(title);
      const shot: Captured = { blob: new Blob([title]), uniform: Boolean(opts.uniform) };
      return shot;
    },
    dispose: vi.fn(),
  };
  const options: Partial<BackfillOptions> = {
    getEntry: vi.fn(async () => "index.html"),
    fetchHtml: vi.fn(async (url: string) => html[url.split("/")[2]] ?? null),
    makeCapturer: () => capturer,
    upload: vi.fn(async () => true),
    startAfterMs: 0,
    idleMs: 5,
  };
  return { captured, capturer, options };
}

beforeEach(() => {
  resetUploadClaims();
  resetBackfillAttempts();
});
afterEach(() => vi.restoreAllMocks());

describe("useCoverBackfill", () => {
  it("captures and stores a cover for each card that has none, from its published first screen", async () => {
    const { captured, options } = harness({ a: page("Alpha"), b: page("Beta") });
    renderHook(() => useCoverBackfill([doc("a"), doc("b")], ME, options));

    await waitFor(() => expect(options.upload).toHaveBeenCalledTimes(2));
    expect(captured).toEqual(["Alpha", "Beta"]);
    // The published version's own entry, through the content proxy.
    expect(options.fetchHtml).toHaveBeenCalledWith("/content/a/v2/index.html");
    expect(vi.mocked(options.upload!).mock.calls[0].slice(0, 3)).toEqual(["a", "v2", "cover"]);
  });

  it("leaves alone what it may not, or need not, capture", async () => {
    const { captured, options } = harness({
      theirs: page("Theirs"),
      expired: page("Expired"),
      done: page("Done"),
      owed: page("Owed"),
      mine: page("Mine, expired"),
    });
    renderHook(() =>
      useCoverBackfill(
        [
          doc("theirs", { ownerEmail: "ana@example.com", viewers: [ME] }),
          // An editor's, expired: frozen and unreadable to them.
          doc("expired", { ownerEmail: "ana@example.com", editors: [ME], expiresAt: Date.now() - 1000 }),
          doc("done", { thumb: { versionId: "v2", rev: THUMB_REVISION, cover: KEY } }),
          doc("owed"),
          // The owner's, expired: they alone still read it, so it gets a cover.
          doc("mine", { expiresAt: Date.now() - 1000 }),
        ],
        ME,
        options,
      ),
    );

    await waitFor(() => expect(options.upload).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toEqual(["Owed", "Mine, expired"]);
  });

  it("replaces a cover an older capture made", async () => {
    const { captured, options } = harness({ old: page("Old") });
    renderHook(() =>
      useCoverBackfill([doc("old", { thumb: { versionId: "v2", rev: 1, cover: KEY } })], ME, options),
    );
    await waitFor(() => expect(options.upload).toHaveBeenCalledTimes(1));
    expect(captured).toEqual(["Old"]);
  });

  it("waits for an open when every reader runs the document's scripts", async () => {
    // Trusted: readers run its scripts, and a capture that runs none could
    // show them a page they never see. An untrusted document is sandboxed for
    // everyone, so its first screen without scripts is exactly theirs.
    const script = "<script>document.body.append('drawn')</script>";
    const { captured, options } = harness({
      trusted: page("Trusted", script),
      untrusted: page("Untrusted", script),
      plain: page("Plain"),
    });
    renderHook(() =>
      useCoverBackfill(
        [doc("trusted", { trusted: true }), doc("untrusted"), doc("plain", { trusted: true })],
        ME,
        options,
      ),
    );

    await waitFor(() => expect(options.upload).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toEqual(["Untrusted", "Plain"]);
  });

  it("stores no cover of a blank first screen", async () => {
    const { captured, options } = harness({ blank: page("Blank") }, { uniform: true });
    renderHook(() => useCoverBackfill([doc("blank")], ME, options));
    await waitFor(() => expect(captured).toEqual(["Blank"]));
    await new Promise((r) => setTimeout(r, 30));
    expect(options.upload).not.toHaveBeenCalled();
  });

  it("moves on past a document that fails, and does not retry it", async () => {
    const { captured, options } = harness({ bad: page("Bad"), good: page("Good") }, { failing: "Bad" });
    renderHook(() => useCoverBackfill([doc("bad"), doc("good")], ME, options));

    await waitFor(() => expect(options.upload).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toEqual(["Good"]);
    expect(options.fetchHtml).toHaveBeenCalledTimes(2);
  });

  it("stops when the workspace goes away", async () => {
    const { options } = harness({ a: page("Alpha"), b: page("Beta") });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    options.getEntry = vi.fn(async () => {
      await gate;
      return "index.html";
    });
    const { unmount } = renderHook(() => useCoverBackfill([doc("a"), doc("b")], ME, options));

    await waitFor(() => expect(options.getEntry).toHaveBeenCalledTimes(1));
    unmount();
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(options.upload).not.toHaveBeenCalled();
  });

  it("keeps going when the cards are re-rendered mid-capture", async () => {
    // Every card's record is rewritten whenever somebody reads it. A worker
    // restarted by that would drop the capture in flight — and, having tried
    // that document already, never come back to it this visit.
    const { captured, capturer, options } = harness({ a: page("Alpha"), b: page("Beta") });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = capturer.capture.bind(capturer);
    capturer.capture = async (html, o) => {
      if (!captured.length) await gate;
      return real(html, o);
    };
    const { rerender } = renderHook((docs: DocMeta[]) => useCoverBackfill(docs, ME, options), {
      initialProps: [doc("a"), doc("b")],
    });

    await waitFor(() => expect(options.fetchHtml).toHaveBeenCalledTimes(1));
    rerender([doc("a"), doc("b")]);
    rerender([doc("a"), doc("b")]);
    release();

    await waitFor(() => expect(options.upload).toHaveBeenCalledTimes(2));
    expect(captured).toEqual(["Alpha", "Beta"]);
  });
});
