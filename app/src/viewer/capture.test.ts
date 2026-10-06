// SPDX-License-Identifier: Apache-2.0
// What counts as a capture of nothing, and how a preview's fonts reach its image (SPEC §6d).

import { afterEach, describe, expect, it, vi } from "vitest";

import { embedFontCss, isUniform } from "./capture";

/** An RGBA buffer of `n` pixels, each from `colour(i)`. */
function pixels(n: number, colour: (i: number) => [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = colour(i);
    out.set([r, g, b, 255], i * 4);
  }
  return out;
}

describe("isUniform", () => {
  it("calls a flat field a capture of nothing, JPEG noise and all", () => {
    expect(isUniform(pixels(10_000, () => [255, 255, 255]))).toBe(true);
    expect(isUniform(pixels(10_000, (i) => [250 + (i % 5), 252, 249 + (i % 3)]))).toBe(true);
  });

  it("calls anything drawn on it content", () => {
    // One dark band across an otherwise white slide: a heading.
    expect(isUniform(pixels(10_000, (i) => (i > 4_000 && i < 4_400 ? [20, 20, 30] : [255, 255, 255])))).toBe(false);
  });
});

describe("embedFontCss", () => {
  afterEach(() => {
    document.head.innerHTML = "";
  });

  it("resolves an inline sheet's fonts against the document's base, not this page", async () => {
    // The preview's <base> is the content proxy. Resolved against the app page
    // instead, every font request misses and every heading falls back.
    document.head.innerHTML =
      `<base href="/content/doc1/v3/">` +
      `<style>@font-face{font-family:Deck;src:url("fonts/deck.woff2") format("woff2")}</style>`;
    const load = vi.fn(async (url: string) => `data:font/woff2;base64,${btoa(url)}`);

    const css = await embedFontCss(document, load);

    expect(load).toHaveBeenCalledWith(new URL("/content/doc1/v3/fonts/deck.woff2", location.href).href);
    expect(css).toContain("font-family: Deck");
    expect(css).toContain('url("data:font/woff2;base64,');
    expect(css).not.toContain("fonts/deck.woff2");
  });

  it("leaves a font that is already inline alone", async () => {
    document.head.innerHTML = `<style>@font-face{font-family:Inline;src:url(data:font/woff2;base64,AAAA)}</style>`;
    const load = vi.fn();
    const css = await embedFontCss(document, load);
    expect(load).not.toHaveBeenCalled();
    expect(css).toContain("Inline");
  });

  it("drops a face whose font will not load, so the text falls back rather than the capture failing", async () => {
    document.head.innerHTML =
      `<style>@font-face{font-family:Gone;src:url(gone.woff2)}` +
      `@font-face{font-family:Here;src:url(here.woff2)}</style>`;
    const css = await embedFontCss(document, async (url) =>
      url.endsWith("gone.woff2") ? null : "data:font/woff2;base64,AAAA",
    );
    expect(css).not.toContain("Gone");
    expect(css).toContain("Here");
  });

  it("ignores everything in a sheet that is not a font", async () => {
    document.head.innerHTML = `<style>h1{font-family:Deck} .x{background:url(bg.png)}</style>`;
    const load = vi.fn();
    expect(await embedFontCss(document, load)).toBe("");
    expect(load).not.toHaveBeenCalled();
  });
});
