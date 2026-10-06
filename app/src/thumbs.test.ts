// SPDX-License-Identifier: Apache-2.0
// When an editor's browser owes a capture, and where a reader finds one (SPEC §2, §4).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  THUMB_MAX_IMAGE_BYTES,
  THUMB_MAX_SLIDES,
  THUMB_PIXEL_RATIO,
  THUMB_STAGE,
  captureNeeds,
  coverUrl,
  storedSlideImages,
  thumbUrl,
  uploadThumbs,
  type CaptureInput,
} from "./thumbs";

const KEY = "0123456789abcdef";

/** Every gate open, nothing stored yet, a six-slide deck. */
const OWED: CaptureInput = {
  reading: true,
  draft: false,
  shownVersion: "v3",
  headVersion: "v3",
  isDocEditor: true,
  expired: false,
  sandboxed: true,
  globallyTrusted: false,
  thumbVersion: null,
  hasCover: false,
  hasSlides: false,
  isDeck: true,
  slideCount: 6,
};

describe("captureNeeds", () => {
  it("owes a cover and a rail for a deck nobody has captured", () => {
    expect(captureNeeds(OWED)).toEqual({ cover: true, slides: true });
  });

  it("owes only a cover for a document that is not a deck", () => {
    expect(captureNeeds({ ...OWED, isDeck: false })).toEqual({ cover: true, slides: false });
  });

  for (const [why, change] of [
    ["while editing, whose bytes are not the published ones", { reading: false }],
    ["on the shared draft", { draft: true }],
    ["on an older version than the head", { shownVersion: "v2" }],
    ["before the head is known", { headVersion: "", shownVersion: "" }],
    ["for a reader who cannot change the document", { isDocEditor: false }],
    ["once the document has expired", { expired: true }],
    // Personally trusted: this frame runs scripts that every other reader's
    // does not, with this reader's access.
    ["when this frame runs scripts nobody else's does", { sandboxed: false, globallyTrusted: false }],
    ["when this frame is sandboxed but everybody else's is not", { sandboxed: true, globallyTrusted: true }],
    ["when both are already stored for the head", { thumbVersion: "v3", hasCover: true, hasSlides: true }],
  ] as const) {
    it(`owes nothing ${why}`, () => {
      expect(captureNeeds({ ...OWED, ...change })).toBeNull();
    });
  }

  it("captures a trusted document in a frame that runs its scripts like everyone's", () => {
    expect(captureNeeds({ ...OWED, sandboxed: false, globallyTrusted: true })).toEqual({
      cover: true,
      slides: true,
    });
  });

  it("owes only what the head is missing", () => {
    expect(captureNeeds({ ...OWED, thumbVersion: "v3", hasCover: true })).toEqual({
      cover: false,
      slides: true,
    });
  });

  it("owes everything again once the stored images are an older version's", () => {
    expect(
      captureNeeds({ ...OWED, thumbVersion: "v2", hasCover: true, hasSlides: true }),
    ).toEqual({ cover: true, slides: true });
  });

  it("keeps a deck too long to store on live previews, with a cover all the same", () => {
    expect(captureNeeds({ ...OWED, slideCount: THUMB_MAX_SLIDES + 1 })).toEqual({
      cover: true,
      slides: false,
    });
    expect(captureNeeds({ ...OWED, slideCount: THUMB_MAX_SLIDES })?.slides).toBe(true);
  });
});

describe("where a stored image is read from", () => {
  it("names the version the record holds, not the one on screen", () => {
    // A cover stays up while the head moves on, until an editor captures anew.
    expect(coverUrl("q3-plan", { versionId: "v2", cover: KEY })).toBe(
      `/thumb/q3-plan/v2/${KEY}/cover.jpg`,
    );
    expect(coverUrl("q3-plan", { versionId: "v2" })).toBeNull();
    expect(coverUrl("q3-plan", undefined)).toBeNull();
    expect(thumbUrl("q3-plan", "v4", KEY, 7)).toBe(`/thumb/q3-plan/v4/${KEY}/s7.jpg`);
  });

  const STORED = { versionId: "v3", slides: { key: KEY, count: 3 } };
  const READING = { reading: true, draft: false, shownVersion: "v3", slideCount: 3 };

  it("reads a published deck's rail from what was stored for it", () => {
    expect(storedSlideImages("q3-plan", STORED, READING)).toEqual([
      `/thumb/q3-plan/v3/${KEY}/s0.jpg`,
      `/thumb/q3-plan/v3/${KEY}/s1.jpg`,
      `/thumb/q3-plan/v3/${KEY}/s2.jpg`,
    ]);
  });

  for (const [why, view, thumb] of [
    ["while editing", { ...READING, reading: false }, STORED],
    ["on the shared draft", { ...READING, draft: true }, STORED],
    ["on another version", { ...READING, shownVersion: "v2" }, STORED],
    ["when the deck has a different number of slides", { ...READING, slideCount: 4 }, STORED],
    ["when nothing was stored", READING, { versionId: "v3" }],
  ] as const) {
    it(`keeps the live previews ${why}`, () => {
      expect(storedSlideImages("q3-plan", thumb, view)).toBeNull();
    });
  }
});

describe("the limits the server holds an upload to", () => {
  // Pinned to the server's own source: an image it would refuse is not worth
  // rendering, and two copies of a limit drift the first time one is changed.
  const server = readFileSync(
    join(__dirname, "..", "..", "functions", "src", "lib", "thumbs.ts"),
    "utf8",
  );
  const constant = (name: string) => {
    const m = new RegExp(`export const ${name} = ([^;]+);`).exec(server);
    if (!m) throw new Error(`${name} not found in functions/src/lib/thumbs.ts`);
    return Function(`return (${m[1].replace(/_/g, "")})`)() as number;
  };

  it("agrees with the server on slide count and image size", () => {
    expect(THUMB_MAX_SLIDES).toBe(constant("THUMB_MAX_SLIDES"));
    expect(THUMB_MAX_IMAGE_BYTES).toBe(constant("THUMB_MAX_IMAGE_BYTES"));
  });

  it("captures within the server's pixel cap", () => {
    const side = constant("THUMB_MAX_SIDE");
    expect(THUMB_STAGE.width * THUMB_PIXEL_RATIO).toBeLessThanOrEqual(side);
    expect(THUMB_STAGE.height * THUMB_PIXEL_RATIO).toBeLessThanOrEqual(side);
  });
});

describe("uploadThumbs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("frames the images by their sizes and sends the session", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const images = [new Blob(["abc"]), new Blob(["de"])];

    expect(await uploadThumbs("q3-plan", "v3", "slides", images)).toBe(true);

    const [url, init] = fetch.mock.calls[0];
    const query = new URL(url, "http://x").searchParams;
    expect(url.startsWith("/thumb?")).toBe(true);
    expect(Object.fromEntries(query)).toEqual({
      doc: "q3-plan",
      v: "v3",
      kind: "slides",
      sizes: "3,2",
    });
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect((init.body as Blob).size).toBe(5);
  });

  it("reports a refusal or a network failure as false, and never throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await uploadThumbs("q3-plan", "v3", "cover", [new Blob(["x"])])).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await uploadThumbs("q3-plan", "v3", "cover", [new Blob(["x"])])).toBe(false);
  });
});
