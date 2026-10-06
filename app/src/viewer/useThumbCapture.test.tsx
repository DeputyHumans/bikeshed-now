// SPDX-License-Identifier: Apache-2.0
// A published version is captured once, cover first, and the reader's document is left alone (SPEC §2, §6d).

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { scanSlides, type Slide } from "./deck";
import type { Captured, Capturer } from "./capture";
import { resetCaptureAttempts, useThumbCapture, type ThumbCaptureOptions } from "./useThumbCapture";

const BASE = "/content/q3-plan/v3/";

function deckDoc(): Document {
  return new DOMParser().parseFromString(
    `<html><head><style>.slide{color:navy}</style></head><body><main class="deck">
       <section class="slide active"><h2>One</h2></section>
       <section class="slide"><h2>Two</h2></section>
       <section class="slide"><h2>Three</h2></section>
     </main></body></html>`,
    "text/html",
  );
}

function slidesOf(doc: Document): Slide[] {
  const scan = scanSlides(doc);
  if (scan.kind !== "slides") throw new Error("fixture is not a deck");
  return scan.slides;
}

/** A capturer whose image is the heading it rendered, so a test can tell slides apart. */
function fakeCapturer(opts: { uniform?: (html: string) => boolean; gate?: Promise<void> } = {}) {
  const calls: { html: string; page: boolean }[] = [];
  const capturer: Capturer = {
    async capture(html, o) {
      calls.push({ html, page: Boolean(o?.page) });
      if (opts.gate && calls.length === 2) await opts.gate;
      const heading = /<h2>([^<]*)<\/h2>/.exec(html)?.[1] ?? "page";
      const shot: Captured = { blob: new Blob([heading]), uniform: opts.uniform?.(html) ?? false };
      return shot;
    },
    dispose: vi.fn(),
  };
  return { capturer, calls };
}

async function textOf(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}

function options(over: Partial<ThumbCaptureOptions> = {}): ThumbCaptureOptions {
  const doc = over.frameDoc ?? deckDoc();
  return {
    docId: "q3-plan",
    version: "v3",
    frameDoc: doc,
    epoch: 1,
    slides: over.slides ?? slidesOf(doc),
    isDeck: true,
    baseHref: BASE,
    needs: { cover: true, slides: true },
    settleMs: 0,
    upload: vi.fn(async () => true),
    ...over,
  };
}

beforeEach(() => {
  resetCaptureAttempts();
});

describe("useThumbCapture", () => {
  it("stores slide one as the cover first, then the whole rail", async () => {
    const { capturer, calls } = fakeCapturer();
    const opts = options({ makeCapturer: () => capturer });
    renderHook(() => useThumbCapture(opts));

    await waitFor(() => expect(opts.upload).toHaveBeenCalledTimes(2));
    const [cover, rail] = vi.mocked(opts.upload!).mock.calls;
    expect(cover.slice(0, 3)).toEqual(["q3-plan", "v3", "cover"]);
    expect(await Promise.all(cover[3].map(textOf))).toEqual(["One"]);
    expect(rail.slice(0, 3)).toEqual(["q3-plan", "v3", "slides"]);
    expect(await Promise.all(rail[3].map(textOf))).toEqual(["One", "Two", "Three"]);
    // Slide one is rendered once and stored twice.
    expect(calls).toHaveLength(3);
    // Each slide in the state the deck shows its current one in.
    expect(calls[1].html).toContain('class="slide active"');
    expect(capturer.dispose).toHaveBeenCalled();
  });

  it("does not start over when the record behind it is rewritten mid-deck", async () => {
    // `recordView` rewrites the record every minute somebody reads, so the
    // `needs` object is rebuilt with the same values. A capture keyed on that
    // object would cancel itself and begin the deck again.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { capturer, calls } = fakeCapturer({ gate });
    const opts = options({ makeCapturer: () => capturer });
    const { rerender } = renderHook((props: ThumbCaptureOptions) => useThumbCapture(props), {
      initialProps: opts,
    });

    await waitFor(() => expect(calls).toHaveLength(2));
    rerender({ ...opts, needs: { cover: true, slides: true } });
    rerender({ ...opts, needs: { cover: true, slides: true } });
    release();

    await waitFor(() => expect(opts.upload).toHaveBeenCalledTimes(2));
    expect(calls).toHaveLength(3);
  });

  it("covers a document that is not a deck with its first screen", async () => {
    const doc = new DOMParser().parseFromString(
      `<html><body><h1>Design review</h1><p>Body.</p></body></html>`,
      "text/html",
    );
    const { capturer, calls } = fakeCapturer();
    const opts = options({
      frameDoc: doc,
      slides: [],
      isDeck: false,
      needs: { cover: true, slides: false },
      makeCapturer: () => capturer,
    });
    renderHook(() => useThumbCapture(opts));

    await waitFor(() => expect(opts.upload).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([expect.objectContaining({ page: true })]);
    expect(calls[0].html).toContain("Design review");
    expect(vi.mocked(opts.upload!).mock.calls[0][2]).toBe("cover");
  });

  it("stores no cover of a blank first screen, and no rail of nothing but blanks", async () => {
    const { capturer, calls } = fakeCapturer({ uniform: () => true });
    const opts = options({ makeCapturer: () => capturer });
    renderHook(() => useThumbCapture(opts));

    await waitFor(() => expect(calls).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(opts.upload).not.toHaveBeenCalled();
  });

  it("keeps a blank slide in a rail that has content", async () => {
    const { capturer } = fakeCapturer({ uniform: (html) => html.includes("<h2>Two</h2>") });
    const opts = options({ makeCapturer: () => capturer });
    renderHook(() => useThumbCapture(opts));

    await waitFor(() => expect(opts.upload).toHaveBeenCalledTimes(2));
    expect(vi.mocked(opts.upload!).mock.calls[1][3]).toHaveLength(3);
  });

  it("stores nothing more once the viewer has gone", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { capturer, calls } = fakeCapturer({ gate });
    const opts = options({ makeCapturer: () => capturer });
    const { unmount } = renderHook(() => useThumbCapture(opts));

    await waitFor(() => expect(calls).toHaveLength(2));
    unmount();
    release();
    await new Promise((r) => setTimeout(r, 20));

    expect(vi.mocked(opts.upload!).mock.calls.map((c) => c[2])).toEqual(["cover"]);
    expect(calls).toHaveLength(2);
  });

  it("does nothing when nothing is owed, or before the frame has loaded", async () => {
    const { capturer, calls } = fakeCapturer();
    renderHook(() => useThumbCapture(options({ needs: null, makeCapturer: () => capturer })));
    renderHook(() => useThumbCapture(options({ epoch: 0, makeCapturer: () => capturer })));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
  });

  it("uploads each kind for a version once per page, however often the viewer opens it", async () => {
    // The record says it is still owed until the upload's write comes back; a
    // second open in that window must not store it twice.
    const first = options({ makeCapturer: () => fakeCapturer().capturer });
    const a = renderHook(() => useThumbCapture(first));
    await waitFor(() => expect(first.upload).toHaveBeenCalledTimes(2));
    a.unmount();

    const second = options({ makeCapturer: () => fakeCapturer().capturer });
    renderHook(() => useThumbCapture(second));
    await new Promise((r) => setTimeout(r, 20));
    expect(second.upload).not.toHaveBeenCalled();
  });

  it("leaves the reader's document exactly as it was", async () => {
    const doc = deckDoc();
    const before = doc.documentElement.outerHTML;
    const { capturer } = fakeCapturer();
    const opts = options({ frameDoc: doc, slides: slidesOf(doc), makeCapturer: () => capturer });
    renderHook(() => useThumbCapture(opts));

    await waitFor(() => expect(opts.upload).toHaveBeenCalledTimes(2));
    expect(doc.documentElement.outerHTML).toBe(before);
  });
});
