// SPDX-License-Identifier: Apache-2.0
// PNG and SVG export of a section or a diagram (SPEC §20).

import { toPng } from "html-to-image";
import { stripDecoration } from "../annotation/highlighter";
import { withCleanImageNode } from "./cleanImage";
import { embedFontCss, inlineSvgStyles } from "../viewer/capture";
import { TOKENS } from "../brand/tokens";
import { markingIsVisible } from "./labels";
import { resolveFooter } from "../marking";
import type { Marking } from "../types";

/**
 * The document iframe is same-origin, so the parent reads its nodes directly —
 * the same property that makes annotation possible makes exporting a section
 * possible without a round trip.
 *
 * The marking is stamped onto the rendered PIXELS here, rather than into the
 * DOM before rasterizing. Stamping the DOM would mean mutating a document
 * somebody is reading, and the whole point of the export path is that it
 * observes without touching.
 */

export type ExportBackground = "transparent" | "white" | "surface";

const BG: Record<ExportBackground, string | undefined> = {
  transparent: undefined,
  white: "#ffffff",
  surface: TOKENS.surface,
};

function saveDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function safeName(name: string): string {
  return (name || "export").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Every inline SVG in a document, in document order. */
export function listSvgs(doc: Document): SVGSVGElement[] {
  return Array.from(doc.querySelectorAll("svg"));
}

/** A readable title for a diagram, for the export picker. */
export function describeSvg(svg: SVGSVGElement, index: number): string {
  const title = svg.querySelector("title")?.textContent?.trim();
  if (title) return title;
  const label = svg.getAttribute("aria-label");
  if (label) return label;
  const section = svg.closest("[id]")?.id;
  return section ? `${section} diagram` : `Diagram ${index + 1}`;
}

/** Draw the marking into a rendered PNG. */
function stamp(dataUrl: string, marking: Marking, context: {
  title: string;
  version: string;
  user: string;
}): Promise<string> {
  if (!markingIsVisible(marking)) return Promise.resolve(dataUrl);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        // A canvas we cannot draw on means we cannot stamp. Returning the
        // unstamped image is the honest failure: silently returning nothing
        // would lose the export entirely.
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0);

      const pad = Math.max(8, Math.round(canvas.width * 0.012));
      if (marking.label) {
        const size = Math.max(10, Math.round(canvas.width * 0.014));
        ctx.font = `700 ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(176, 35, 24, 0.92)";
        ctx.fillText(marking.label, canvas.width - pad, pad);
      }
      if (marking.footer) {
        const size = Math.max(9, Math.round(canvas.width * 0.011));
        ctx.font = `${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "rgba(74, 74, 85, 0.9)";
        ctx.fillText(
          resolveFooter(marking.footer, context),
          canvas.width / 2,
          canvas.height - pad,
        );
      }
      resolve(canvas.toDataURL("image/png"));
    };
    // A failed load means no stamp, not no export.
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export interface ImageExportOptions {
  background: ExportBackground;
  scale?: number;
  name: string;
  marking?: Marking;
  title?: string;
  version?: string;
  user?: string;
}

/** Rasterize a node to PNG and download it. */
export async function exportNodePng(
  node: HTMLElement | SVGElement,
  opts: ImageExportOptions,
): Promise<void> {
  const dataUrl = await withCleanImageNode(node, async (clean) => {
    inlineSvgStyles(clean.ownerDocument);
    return toPng(clean as HTMLElement, {
      fontEmbedCSS: await embedFontCss(clean.ownerDocument),
      backgroundColor: BG[opts.background],
      pixelRatio: opts.scale ?? 2,
      // Fonts and images inside the node are fetched through the gated proxy, and
      // a cached response can be a stale version's asset.
      cacheBust: true,
    });
  });
  const stamped = opts.marking
    ? await stamp(dataUrl, opts.marking, {
        title: opts.title ?? "",
        version: opts.version ?? "",
        user: opts.user ?? "",
      })
    : dataUrl;
  saveDataUrl(stamped, `${safeName(opts.name)}.png`);
}

/**
 * Serialize an inline SVG to a standalone file.
 *
 * A vector export stays a vector: rasterizing a diagram somebody will paste
 * into a slide defeats the reason they wanted the diagram.
 */
export function exportSvg(
  svg: SVGSVGElement,
  name: string,
  marking?: Marking,
): void {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  stripDecoration(clone);
  if (!clone.getAttribute("xmlns")) {
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }

  if (marking && markingIsVisible(marking) && marking.label) {
    const NS = "http://www.w3.org/2000/svg";
    const text = document.createElementNS(NS, "text");
    text.setAttribute("x", "4");
    text.setAttribute("y", "12");
    text.setAttribute("font-family", "Arial, sans-serif");
    text.setAttribute("font-size", "9");
    text.setAttribute("font-weight", "700");
    text.setAttribute("fill", "#b02318");
    text.setAttribute("opacity", "0.85");
    text.textContent = marking.label;
    clone.appendChild(text);
  }

  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n', xml], {
    type: "image/svg+xml",
  });
  const url = URL.createObjectURL(blob);
  saveDataUrl(url, `${safeName(name)}.svg`);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
