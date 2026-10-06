// SPDX-License-Identifier: Apache-2.0
// Turn a preview document into the JPEG a stored thumbnail is, in an editor's browser (SPEC §2, §6d).

import { toCanvas } from "html-to-image";

import { revealHidden } from "./preview";
import { THUMB_MAX_IMAGE_BYTES, THUMB_PIXEL_RATIO, THUMB_QUALITY, THUMB_STAGE } from "../thumbs";

/**
 * A capture renders a preview — the same separate document the rail shows,
 * built by `viewer/preview.ts` — in a frame of this app's own, and rasterises
 * it. It never touches the reader's frame, so it puts nothing in the document
 * and has no place in the decoration ordering `DocViewer` documents.
 *
 * The frame is sandboxed `allow-same-origin` with no scripts, like every
 * preview. It sits at the top left at full stage size with `opacity:0`, not
 * off-screen: a frame off-screen gets its lazy images deferred, and its
 * rendering throttled, which is exactly what a capture cannot wait out.
 */

/** A 1×1 transparent GIF, for an image that will not load: one 404 must not lose the slide. */
const PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** No preview waits longer than this to load, nor its fonts or first images. */
const LOAD_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 4_000;

export interface Captured {
  blob: Blob;
  /** Every sampled pixel the same colour: a blank slide, or a capture of nothing. */
  uniform: boolean;
}

export interface Capturer {
  /**
   * Render one preview and return it as a JPEG, or null if it could not be
   * rendered at all. `page` is a whole document's first screen rather than a
   * slide: only what lies in that screen is rasterised.
   */
  capture(html: string, opts?: { page?: boolean }): Promise<Captured | null>;
  dispose(): void;
}

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * True when the sampled pixels span less than a few levels in every channel.
 *
 * Sampled on a stride rather than read whole: a 640×360 capture is 230,400
 * pixels, and the question is only whether ANYTHING is drawn. Six levels of
 * spread is JPEG noise on a flat field, not content.
 */
export function isUniform(pixels: Uint8ClampedArray, stride = 7): boolean {
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (let i = 0; i + 2 < pixels.length; i += 4 * stride) {
    for (let c = 0; c < 3; c++) {
      const v = pixels[i + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return max.every((hi, c) => hi - min[c] < 6);
}

async function dataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Every `@font-face` reachable from a sheet, with the URL its own urls resolve against. */
function fontFaces(sheet: CSSStyleSheet, base: string, out: { css: string; base: string }[]): boolean {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return false; // another origin's sheet: its rules are not ours to read
  }
  for (const rule of Array.from(rules)) {
    if (rule.cssText.startsWith("@font-face")) {
      out.push({ css: rule.cssText, base });
    } else if (rule.cssText.startsWith("@import")) {
      const imported = (rule as CSSImportRule).styleSheet;
      if (imported) fontFaces(imported, imported.href ?? base, out);
    }
  }
  return true;
}

/**
 * The document's web fonts as CSS with every font inlined, for html-to-image.
 *
 * html-to-image finds fonts itself, but not inside a frame: it tests each node
 * with `instanceof HTMLElement` from THIS window, which nothing in a frame
 * passes, so only the root's font was ever embedded and every heading fell
 * back. It also resolves a `<style>`'s relative urls against this page rather
 * than the document's `<base>`. So the fonts are read here, from the preview's
 * own sheets, each url resolved against its sheet — or, for an inline sheet,
 * against the document's base, which is the content proxy.
 *
 * A sheet from another origin cannot be read as rules; it is fetched as text
 * and parsed, as the browser already did to render it. A font that will not
 * load is dropped, and the text falls back to the face the browser would use.
 */
export async function embedFontCss(
  doc: Document,
  load: (url: string) => Promise<string | null> = dataUrl,
): Promise<string> {
  const faces: { css: string; base: string }[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    const base = sheet.href ?? doc.baseURI;
    if (fontFaces(sheet, base, faces) || !sheet.href) continue;
    try {
      const res = await fetch(sheet.href);
      const parsed = new CSSStyleSheet();
      parsed.replaceSync(await res.text());
      fontFaces(parsed, sheet.href, faces);
    } catch {
      /* unreadable either way: its fonts fall back */
    }
  }

  const inlined = await Promise.all(
    faces.map(async ({ css, base }) => {
      let out = css;
      for (const [whole, quoted, bare] of css.matchAll(/url\(\s*(?:["']([^"']+)["']|([^)\s]+))\s*\)/g)) {
        const raw = quoted ?? bare;
        if (raw.startsWith("data:")) continue;
        const data = await load(new URL(raw, base).href);
        if (!data) return "";
        out = out.replace(whole, `url("${data}")`);
      }
      return out;
    }),
  );
  return inlined.filter(Boolean).join("\n");
}

/** The colour behind the content, since html-to-image draws the body and not the canvas. */
function backgroundOf(doc: Document): string {
  const view = doc.defaultView;
  for (const el of [doc.body, doc.documentElement]) {
    const bg = view?.getComputedStyle(el).backgroundColor;
    if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
  }
  return "#ffffff";
}

/** Images within the first screen that have not finished, waited for up to a limit. */
async function firstScreenImages(doc: Document): Promise<void> {
  const pending = Array.from(doc.images).filter(
    (img) => !img.complete && img.getBoundingClientRect().top < THUMB_STAGE.height,
  );
  if (pending.length === 0) return;
  const settled = Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await Promise.race([settled, timeout(SETTLE_TIMEOUT_MS, undefined)]);
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

export function createCapturer(host: Document = document): Capturer {
  let frame: HTMLIFrameElement | null = null;
  let fonts: Promise<string> | null = null;

  function ensureFrame(): HTMLIFrameElement {
    if (frame) return frame;
    frame = host.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText =
      `position:fixed;top:0;left:0;width:${THUMB_STAGE.width}px;height:${THUMB_STAGE.height}px;` +
      "opacity:0;pointer-events:none;z-index:-1;border:0";
    host.body.appendChild(frame);
    return frame;
  }

  async function capture(html: string, opts: { page?: boolean } = {}): Promise<Captured | null> {
    const el = ensureFrame();
    const loaded = new Promise<boolean>((resolve) => {
      el.onload = () => resolve(true);
    });
    el.srcdoc = html;
    if (!(await Promise.race([loaded, timeout(LOAD_TIMEOUT_MS, false)]))) return null;

    const doc = el.contentDocument;
    if (!doc?.body) return null;
    revealHidden(doc);
    await Promise.race([doc.fonts.ready, timeout(SETTLE_TIMEOUT_MS, undefined)]);
    if (opts.page) await firstScreenImages(doc);

    // Every preview of one document carries the same stylesheets, so the
    // fonts are read and fetched once per capture run, not once per slide.
    fonts ??= embedFontCss(doc);

    const canvas = await toCanvas(doc.body, {
      width: THUMB_STAGE.width,
      height: THUMB_STAGE.height,
      pixelRatio: THUMB_PIXEL_RATIO,
      backgroundColor: backgroundOf(doc),
      imagePlaceholder: PLACEHOLDER,
      fontEmbedCSS: await fonts,
      cacheBust: false,
      // A page's cover is its first screen: what lies below it is not drawn,
      // so its images are not worth fetching. `nodeType`, because the nodes
      // belong to the frame's window and fail an `instanceof` from this one.
      filter: opts.page
        ? (node) =>
            node.nodeType !== 1 ||
            (node as Element).getBoundingClientRect().top < THUMB_STAGE.height
        : undefined,
    });

    const context = canvas.getContext("2d");
    const uniform = context
      ? isUniform(context.getImageData(0, 0, canvas.width, canvas.height).data)
      : false;
    let blob = await toJpeg(canvas, THUMB_QUALITY);
    if (blob && blob.size > THUMB_MAX_IMAGE_BYTES) blob = await toJpeg(canvas, 0.5);
    if (!blob || blob.size > THUMB_MAX_IMAGE_BYTES) return null;
    return { blob, uniform };
  }

  return {
    capture,
    dispose() {
      frame?.remove();
      frame = null;
    },
  };
}
