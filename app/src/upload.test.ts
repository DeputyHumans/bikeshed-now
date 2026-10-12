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
