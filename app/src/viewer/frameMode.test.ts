// SPDX-License-Identifier: Apache-2.0
// What has to remount, and what merely has to re-render (SPEC §6a, §6c).

import { describe, expect, it } from "vitest";
import {
  contentBase,
  frameKey,
  frameSandbox,
  frameSrc,
  isEffectivelyTrusted,
  readingSandboxed,
  readsDraft,
  type FrameMode,
} from "./frameMode";

const READING: FrameMode = {
  kind: "reading",
  versionId: "v2",
  draft: false,
  sandboxed: true,
};
const EDITING: FrameMode = { kind: "editing", baseVersion: "v2" };

describe("frameKey", () => {
  it("changes when the sandbox changes", () => {
    /**
     * The subtlest of these. The sandbox attribute is read at PARSE time, so
     * changing it on a live frame does literally nothing — the frame has to
     * remount, which means the key has to change.
     */
    const a = frameKey(READING, "sandboxed", 0);
    const b = frameKey({ ...READING, sandboxed: false }, "trusted", 0);
    expect(a).not.toBe(b);
  });

  it("changes when trust is granted, so the blocked scripts finally run", () => {
    expect(frameKey(READING, "sandboxed", 0)).not.toBe(frameKey(READING, "trusted", 0));
  });

  it("changes between reading and editing", () => {
    expect(frameKey(READING, "t", 0)).not.toBe(frameKey(EDITING, "t", 0));
  });

  it("changes between a published version and the draft", () => {
    expect(frameKey(READING, "t", 0)).not.toBe(
      frameKey({ ...READING, draft: true }, "t", 0),
    );
  });

  it("changes on an explicit reload, even when nothing else did", () => {
    // A draft refresh can produce a byte-identical URL, so there has to be an
    // input that says "reload anyway".
    expect(frameKey(READING, "t", 0)).not.toBe(frameKey(READING, "t", 1));
  });

  it("is stable when nothing that matters changed", () => {
    expect(frameKey(READING, "t", 3)).toBe(frameKey({ ...READING }, "t", 3));
  });
});

describe("frameSandbox", () => {
  it("always keeps allow-same-origin", () => {
    // Non-negotiable: the parent drives annotation and editing on
    // contentDocument, so a cross-origin frame breaks the entire product.
    expect(frameSandbox(READING)).toContain("allow-same-origin");
    expect(frameSandbox(EDITING)).toContain("allow-same-origin");
    // No popups while editing: a click there places the caret.
    expect(frameSandbox(EDITING)).toBe("allow-same-origin");
    // Popups while reading, for a link that must open its own tab where the
    // viewer hears no clicks; never scripts (ADR 0021, outboundLinks.ts).
    expect(frameSandbox(READING)).toBe("allow-same-origin allow-popups allow-popups-to-escape-sandbox");
  });

  it("NEVER allows scripts while editing, whatever the document's trust says", () => {
    // Encoded in the type as well: the editing variant has no `sandboxed`
    // field, so "edit an un-sandboxed document" is not representable.
    expect(frameSandbox(EDITING)).not.toContain("allow-scripts");
  });

  it("drops the sandbox entirely for a trusted document being read", () => {
    expect(frameSandbox({ ...READING, sandboxed: false })).toBeUndefined();
  });
});

describe("frameSrc", () => {
  it("reads a published version from the content path", () => {
    expect(frameSrc(READING, "d1", "index.html", 0)).toBe("/content/d1/v2/index.html");
  });

  it("reads a draft from the draft path, cache-busted", () => {
    expect(frameSrc({ ...READING, draft: true }, "d1", "index.html", 7)).toBe(
      "/draft/d1/index.html?r=7",
    );
    expect(frameSrc(EDITING, "d1", "index.html", 7)).toBe("/draft/d1/index.html?r=7");
  });

  it("carries the unlisted link token, encoded", () => {
    // Without it, an unlisted document is readable by anyone who guesses the
    // slug, which would make "unlisted" mean nothing.
    expect(frameSrc(READING, "d1", "index.html", 0, "tok en/+")).toBe(
      "/content/~tok%20en%2F%2B/d1/v2/index.html",
    );
  });

  it("carries the token to every file the document refers to by relative path", () => {
    // In `?k=` the token stopped at the entry, so a signed-out reader of an
    // unlisted bundle got its text and none of its images or stylesheets.
    const src = new URL(frameSrc(READING, "d1", "index.html", 0, "tok_123"), "https://x.example");
    expect(new URL("img/a.png", src).pathname).toBe("/content/~tok_123/d1/v2/img/a.png");
    expect(new URL("../v2/style.css", src).pathname).toBe("/content/~tok_123/d1/v2/style.css");
  });

  it("asks for the run variant only when the frame is unsandboxed, and every relative file inherits it", () => {
    // Every other content URL is served locked (ADR 0021): a trusted frame
    // that loaded the plain URL would show its document with the script off.
    expect(frameSrc(READING, "d1", "index.html", 0)).not.toContain("!run");
    const src = new URL(frameSrc({ ...READING, sandboxed: false }, "d1", "index.html", 0, "tok_123"), "https://x.example");
    expect(src.pathname).toBe("/content/~tok_123/!run/d1/v2/index.html");
    expect(new URL("app.js", src).pathname).toBe("/content/~tok_123/!run/d1/v2/app.js");
    // A draft never runs, so it never asks.
    expect(frameSrc({ ...READING, sandboxed: false, draft: true }, "d1", "index.html", 3)).toBe("/draft/d1/index.html?r=3");
  });
});

describe("contentBase", () => {
  it("is the version's directory, with the token ahead of the document when there is one", () => {
    // The base thumbnails, print and downloads resolve against: without the
    // token they 404 for the same reader the frame now serves.
    expect(contentBase("d1", "v2")).toBe("/content/d1/v2/");
    expect(contentBase("d1", "v2", "tok_123")).toBe("/content/~tok_123/d1/v2/");
  });
});

describe("effective trust", () => {
  it("treats an absent flag as untrusted, as the server does (ADR 0021)", () => {
    // It once meant trusted, for documents older than the flag. A flag a
    // superadmin never set is not trust.
    expect(isEffectivelyTrusted(undefined, false)).toBe(false);
    expect(isEffectivelyTrusted(true, false)).toBe(true);
  });

  it("treats an explicit false as untrusted", () => {
    expect(isEffectivelyTrusted(false, false)).toBe(false);
  });

  it("lets personal trust override for one reader only", () => {
    // The only session exposed to that document's code is their own, which is
    // exactly why any reader may grant it to themselves.
    expect(isEffectivelyTrusted(false, true)).toBe(true);
  });
});

describe("readsDraft", () => {
  const HEAD = { hasDraft: true, canEdit: true, shownVersion: "v2", headVersion: "v2" };

  it("shows an editor reading the head the draft", () => {
    expect(readsDraft(HEAD)).toBe(true);
  });

  it("shows an editor who opened an older version that version, not the draft", () => {
    expect(readsDraft({ ...HEAD, shownVersion: "v1" })).toBe(false);
  });

  it("never shows the draft to somebody who cannot edit", () => {
    expect(readsDraft({ ...HEAD, canEdit: false })).toBe(false);
  });

  it("has nothing to show when there is no draft", () => {
    expect(readsDraft({ ...HEAD, hasDraft: false })).toBe(false);
  });

  it("waits for the version to be known rather than guessing", () => {
    expect(readsDraft({ ...HEAD, shownVersion: "", headVersion: "" })).toBe(false);
  });
});

it("binds the editor frame URL and key to the exact prepared revision and live epoch", () => {
  const mode: FrameMode = { kind: "editing", baseVersion: "v2", liveEpoch: "fresh", draftRevision: "a".repeat(64) };
  const url = new URL(frameSrc(mode, "d", "index.html", 3), "https://example.test");
  expect(Object.fromEntries(url.searchParams)).toEqual({ r: "3", baseVersion: "v2", liveEpoch: "fresh", draftRevision: "a".repeat(64) });
  expect(frameKey(mode, "t", 0)).not.toBe(frameKey({ ...mode, draftRevision: "b".repeat(64) }, "t", 0));
  expect(frameKey(mode, "t", 0)).not.toBe(frameKey({ ...mode, liveEpoch: "newer" }, "t", 0));
});

describe("readingSandboxed", () => {
  const HEAD = { draft: false, trusted: true, shownVersion: "v2", headVersion: "v2" };

  it("runs the head for a reader who trusts it", () => {
    expect(readingSandboxed(HEAD)).toBe(false);
  });

  it("never runs an older version, whatever the document's trust says", () => {
    // Trust is for the head: an older version may be an editor's, whose
    // commit withdrew trust at the time, and trusting the head again must not
    // run it (SPEC §6c).
    expect(readingSandboxed({ ...HEAD, shownVersion: "v1" })).toBe(true);
  });

  it("never runs a draft, or an untrusted head", () => {
    expect(readingSandboxed({ ...HEAD, draft: true })).toBe(true);
    expect(readingSandboxed({ ...HEAD, trusted: false })).toBe(true);
  });

  it("sandboxes while the head is not yet known", () => {
    expect(readingSandboxed({ ...HEAD, headVersion: "" })).toBe(true);
    expect(readingSandboxed({ ...HEAD, shownVersion: "", headVersion: "" })).toBe(true);
  });
});
