// SPDX-License-Identifier: Apache-2.0
// What has to remount, and what merely has to re-render (SPEC §6a, §6c).

import { describe, expect, it } from "vitest";
import {
  frameKey,
  frameSandbox,
  frameSrc,
  isEffectivelyTrusted,
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
    expect(frameSrc(READING, "d1", "index.html", 0, "tok en/+")).toContain(
      "?k=tok%20en%2F%2B",
    );
  });
});

describe("effective trust", () => {
  it("treats an absent flag as trusted", () => {
    // Documents published before the flag existed, and every CLI publish, are
    // the ones that need their scripts.
    expect(isEffectivelyTrusted(undefined, false)).toBe(true);
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
