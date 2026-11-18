// SPDX-License-Identifier: Apache-2.0
// What the upload client sends, and how it reads a refusal (SPEC §2).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaleUploadError, uploadDoc, uploadVersion } from "./upload";

/**
 * jsdom's XMLHttpRequest would try a real request, so a fake stands in: it
 * records what was opened and sent, and answers with whatever the test set.
 */
const sent: { url: string; body: unknown }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

class FakeXHR {
  status = 0;
  responseText = "";
  withCredentials = false;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private url = "";
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send(body: unknown) {
    sent.push({ url: this.url, body });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    this.status = reply.status;
    this.responseText = JSON.stringify(reply.body);
    queueMicrotask(() => this.onload?.());
  }
}

const file = new File(["<p>Hi</p>"], "deck.html", { type: "text/html" });
const query = () => new URL(sent[sent.length - 1].url, "http://x").searchParams;

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});
afterEach(() => vi.unstubAllGlobals());

describe("uploadVersion", () => {
  it("sends the file as an update to the document, from the version it was looking at", async () => {
    reply = { status: 200, body: { docId: "d1", versionId: "v5", contentHash: "h", fileCount: 1, bytes: 9, deduped: false } };
    const progress: number[] = [];
    const result = await uploadVersion(file, { docId: "d1", baseVersion: "v4", onProgress: (f) => progress.push(f) });

    expect(Object.fromEntries(query())).toEqual({ filename: "deck.html", update: "d1", baseVersion: "v4" });
    expect(sent[0].body).toBe(file);
    expect(result.versionId).toBe("v5");
    expect(progress).toEqual([0.5]);
  });

  it("reads a refusal that names the current version as somebody having published since", async () => {
    reply = { status: 409, body: { error: "the document is at v5 now, not v4: somebody published since you read it", currentVersion: "v5" } };
    const err = await uploadVersion(file, { docId: "d1", baseVersion: "v4" }).catch((e) => e);
    expect(err).toBeInstanceOf(StaleUploadError);
    expect(err.currentVersion).toBe("v5");
    expect(err.message).toBe("Somebody published v5 while this was open, so the file was not published over it. Look at v5 first.");
  });

  it("passes on any other refusal in the server's own words", async () => {
    const editing = "Somebody has this document open in the editor, where this would be lost, so it was not published. Try again once they have left it, or ask them to do it there.";
    reply = { status: 409, body: { error: editing, editors: 1 } };
    const err = await uploadVersion(file, { docId: "d1", baseVersion: "v4" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(StaleUploadError);
    expect(err.message).toBe(editing);
  });

  it("shows a refusal written as a clause as a sentence", async () => {
    reply = { status: 400, body: { error: "this document is HTML, so an update to it cannot be Markdown" } };
    await expect(uploadVersion(file, { docId: "d1", baseVersion: "v4" })).rejects.toThrow(
      /^This document is HTML, so an update to it cannot be Markdown\.$/,
    );
  });

  it("says a 403 is about this document, not a folder", async () => {
    reply = { status: 403, body: {} };
    await expect(uploadVersion(file, { docId: "d1", baseVersion: "v4" })).rejects.toThrow(
      "You can no longer publish to this document.",
    );
    await expect(uploadDoc(file, { folderId: "f1" })).rejects.toThrow("You cannot upload to that folder.");
  });
});


describe("uploadDoc marking", () => {
  it("preserves an explicit off choice instead of falling back to the account default", async () => {
    reply = { status: 200, body: { docId: "d1" } };
    const off = { enabled: false, label: "", footer: "" };
    await uploadDoc(file, { marking: off });
    expect(JSON.parse(query().get("marking")!)).toEqual(off);
    await uploadDoc(file);
    expect(query().has("marking")).toBe(false);
  });
});

describe("large media through upload sessions (SPEC §24)", () => {
  const MB = 1024 * 1024;
  /** A file that claims a size without holding it: only its session ever reads it here. */
  const sized = (name: string, size: number) => {
    const f = new File(["x"], name);
    Object.defineProperty(f, "size", { value: size });
    return f;
  };
  const picked = (path: string, size: number) => ({ path, file: sized(path, size) });

  it("sends the largest media on their own until the rest fits one request, and nothing when it already does", async () => {
    const { splitForSessions } = await import("./upload");
    const small = [picked("index.html", 1000), picked("a.png", 2 * MB)];
    expect(splitForSessions(small).staged).toEqual([]);
    const page = picked("index.html", 1000);
    const film = picked("film.mp4", 30 * MB);
    const still = picked("still.png", 20 * MB);
    const css = picked("style.css", 3 * MB);
    const { staged, rest } = splitForSessions([page, still, film, css]);
    expect(staged.map((f) => f.path)).toEqual(["film.mp4"]);
    expect(rest.map((f) => f.path)).toEqual(["index.html", "still.png", "style.css"]);
    expect(splitForSessions([page, picked("a.mp4", 20 * MB), picked("b.mp4", 20 * MB)]).staged.map((f) => f.path)).toEqual(["a.mp4"]);
  });

  it("stages a film, then lays it over the version by name with no body", async () => {
    const { publishVersion } = await import("./upload");
    const fetched: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      fetched.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ stagingId: "st-1", uploadUrl: "https://upload.example.com/s?upload_id=1", expiresAt: 1, chunkBytes: 8 * MB }), { status: 200 });
    }));
    reply = { status: 200, body: { docId: "d1", versionId: "v6", contentHash: "h", fileCount: 3, bytes: 1, deduped: false } };
    const progress: number[] = [];
    const film = picked("intro.mp4", 40 * MB);
    const plan = { action: "merge" as const, bytes: film.file.size, problems: [], files: [{ sent: film, at: "film/intro.mp4", does: "replaces" as const }] };
    const result = await publishVersion(plan, { docId: "d1", baseVersion: "v5", onProgress: (f) => progress.push(f) });

    expect(fetched).toEqual([{ url: "/media", body: { docId: "d1", path: "intro.mp4", size: 40 * MB } }]);
    expect(sent[0].url).toBe("https://upload.example.com/s?upload_id=1");
    expect(sent[0].body).toBe(film.file);
    const publish = new URL(sent[1].url, "http://x");
    expect(publish.pathname).toBe("/publish");
    expect(publish.searchParams.getAll("media")).toEqual(["st-1"]);
    expect(publish.searchParams.get("merge")).toBe("1");
    expect((sent[1].body as Blob).size).toBe(0);
    expect(result.versionId).toBe("v6");
    expect(progress.every((p, i) => p >= (progress[i - 1] ?? 0) && p <= 1)).toBe(true);
  });

  it("stops while a film is on its way, and publishes nothing", async () => {
    const { publishVersion, UploadStopped } = await import("./upload");
    const stop = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      stop.abort();
      return new Response(JSON.stringify({ stagingId: "st-1", uploadUrl: "https://upload.example.com/s" }), { status: 200 });
    }));
    const film = picked("intro.mp4", 40 * MB);
    const plan = { action: "merge" as const, bytes: film.file.size, problems: [], files: [{ sent: film, at: "intro.mp4", does: "adds" as const }] };
    const err = await publishVersion(plan, { docId: "d1", baseVersion: "v5", signal: stop.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadStopped);
    expect(sent.some((s) => s.url.startsWith("/publish"))).toBe(false);
  });

  it("says a slow publish may still land, rather than that it failed", async () => {
    reply = { status: 504, body: {} };
    const err = await uploadVersion(file, { docId: "d1", baseVersion: "v4" }).catch((e) => e);
    expect(err.message).toBe("This is taking longer than usual. It may still publish: look at the document in a minute.");
  });
});
