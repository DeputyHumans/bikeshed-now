// SPDX-License-Identifier: Apache-2.0
// What counts as a capture of nothing, and how a preview's fonts reach its image (SPEC §6d).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { embedFontCss, inlineSvgStyles, isUniform } from "./capture";

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

describe("inlineSvgStyles", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  // html-to-image copies every computed style onto every HTML element, but it
  // deep-copies an <svg> and never visits what is inside. A shape coloured by a
  // class rule then has no colour at all in the image, and SVG's default fill
  // is black: a logo sheet came out as a grid of black squares.
  it("writes a shape's class-driven paint onto the shape itself", () => {
    document.head.innerHTML = `<style>.f-paper{fill:rgb(248, 247, 243)} .s-ink{stroke:rgb(35, 37, 32);stroke-width:2.4px}</style>`;
    document.body.innerHTML =
      `<svg viewBox="-4 -4 32 32"><path id="tile" class="f-paper" d="M-4-4h32v32H-4z"/>` +
      `<path id="arm" class="s-ink" fill="none" d="M7 6L8 5"/></svg>`;

    inlineSvgStyles(document);

    const tile = document.getElementById("tile") as unknown as SVGElement;
    const arm = document.getElementById("arm") as unknown as SVGElement;
    expect(tile.style.getPropertyValue("fill")).toBe("rgb(248, 247, 243)");
    expect(arm.style.getPropertyValue("stroke")).toBe("rgb(35, 37, 32)");
    expect(arm.style.getPropertyValue("stroke-width")).toBe("2.4px");
  });

  it("leaves a symbol's content to take its colour from wherever it is used", () => {
    // A sprite's <use fill="…"> colours the symbol through inheritance. Its
    // in-place value written on the shape would override every use of it.
    document.head.innerHTML = `<style>.glyph{fill:rgb(9, 9, 9)}</style>`;
    document.body.innerHTML =
      `<svg><defs><path id="def" class="glyph" d="M0 0h1v1z"/></defs>` +
      `<symbol id="sym"><path id="inner" class="glyph" d="M0 0h1v1z"/></symbol>` +
      `<use href="#sym"/></svg>`;

    inlineSvgStyles(document);

    expect(document.getElementById("inner")!.getAttribute("style")).toBeNull();
    expect(document.getElementById("def")!.getAttribute("style")).toBeNull();
  });

  it("runs on every capture, after the reveal and before the image is drawn", () => {
    // jsdom cannot rasterise, so the order is pinned on the source: run after
    // the reveal pass, the inlined values are the revealed ones; run after the
    // image, they would be in nobody's picture.
    const src = readFileSync(join(__dirname, "capture.ts"), "utf8");
    const body = src.slice(src.indexOf("async function capture("));
    const reveal = body.indexOf("revealHidden(doc)");
    const inline = body.indexOf("inlineSvgStyles(doc");
    const draw = body.indexOf("toCanvas(");
    expect(reveal).toBeGreaterThan(0);
    expect(inline).toBeGreaterThan(reveal);
    expect(draw).toBeGreaterThan(inline);
  });

  it("does nothing outside an svg", () => {
    document.head.innerHTML = `<style>.p{color:rgb(1, 2, 3)} .f{fill:rgb(4, 5, 6)}</style>`;
    document.body.innerHTML = `<svg><path class="f" d="M0 0h1v1z"/></svg><p id="p" class="p">text</p>`;
    inlineSvgStyles(document);
    expect(document.getElementById("p")!.getAttribute("style")).toBeNull();
  });
});
