// SPDX-License-Identifier: Apache-2.0
// PDF export: a sandboxed print of a scrubbed, stamped snapshot (SPEC §20).

import { serializeCleanHtml } from "../annotation/highlighter";
import { PRINT_FOOTER_CLASS, PRINT_MARK_CLASS } from "../brand/dom";
import { markingIsVisible } from "./labels";
import { resolveFooter } from "../marking";
import type { Marking } from "../types";

/**
 * Three hardening properties protect different parts of the print snapshot.
 *
 * THE SANDBOX is the real guarantee. The print frame gets `allow-same-origin`
 * (so the parent can write into it) and `allow-modals` (so print() works) and
 * deliberately NOT `allow-scripts`, so no snapshot JavaScript can run
 * same-origin during export. The attribute scrub below is defence in depth.
 *
 * THE TOP LAYER keeps authored html/body transforms, filters and containment
 * from moving the stamps with their ancestors. Their own fixed boxes repeat
 * on each printed page. The mounted snapshot activates their manual popovers.
 *
 * THE INLINE `!important` prevents the document from styling the stamp itself. An important
 * declaration in an element's style attribute outranks any selector-based
 * author !important rule, because the style attribute has the highest
 * specificity there is — and a sandboxed document has no JavaScript with which
 * to add inline styles to our nodes. So for every property locked below, no
 * bundle CSS can win.
 *
 * Residual risk, accepted: a document can blank its OWN entire body, yielding an
 * empty PDF. Self-defeating, and no content leaks. A cryptographic guarantee
 * would need server-side rendering; client-side print is the chosen trade.
 */

/**
 * Every property a document could otherwise use to hide the stamp.
 *
 * Both classes of vector are covered, and the second is the one people forget:
 * making a box invisible (display, visibility, opacity, transform, filter,
 * clip, content-visibility, max-height, overflow, zoom) AND making its text
 * invisible while the box stays (text-fill-color, text-stroke, text-indent,
 * text-shadow, letter-spacing, word-spacing, white-space, text-transform).
 */
const LOCK: Record<string, string> = {
  display: "block",
  visibility: "visible",
  opacity: "1",
  transform: "none",
  scale: "1",
  rotate: "none",
  translate: "none",
  "offset-path": "none",
  "mask-image": "none",
  "mix-blend-mode": "normal",
  filter: "none",
  "clip-path": "none",
  clip: "auto",
  "content-visibility": "visible",
  position: "fixed",
  "z-index": "2147483647",
  margin: "0",
  border: "0",
  background: "transparent",
  "max-height": "none",
  "max-width": "none",
  height: "auto",
  width: "auto",
  overflow: "visible",
  "pointer-events": "none",
  zoom: "1",
  "-webkit-text-fill-color": "currentColor",
  "-webkit-text-stroke": "0",
  "text-indent": "0",
  "text-shadow": "none",
  "letter-spacing": "normal",
  "word-spacing": "normal",
  "white-space": "normal",
  "text-transform": "none",
};

/** Exported so the test can walk every key and assert the priority. */
export const LOCKED_PROPERTIES = Object.keys(LOCK);

function stampElement(
  doc: Document,
  className: string,
  text: string,
  extra: Record<string, string>,
): HTMLElement {
  const el = doc.createElement("div");
  el.className = className;
  // Top-layer placement is activated after the snapshot is mounted. It keeps
  // authored html/body containing blocks from moving or clipping the marking.
  el.setAttribute("popover", "manual");
  // textContent, never innerHTML: the label and footer are user-supplied, and
  // this is the one place they reach a document.
  el.textContent = text;
  for (const [k, v] of Object.entries({ ...LOCK, ...extra })) {
    el.style.setProperty(k, v, "important");
  }
  return el;
}

/** Remove inline event handlers and javascript: URLs from a tree. */
export function scrubActiveContent(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (
        (name === "href" || name === "src" || name === "xlink:href") &&
        // Leading whitespace and mixed case are both valid in a URL scheme, so
        // a naive startsWith("javascript:") misses `  JaVaScRiPt:alert(1)`.
        /^[\s\u0000- ]*j[\s\u0000- ]*a[\s\u0000- ]*v[\s\u0000- ]*a[\s\u0000- ]*s[\s\u0000- ]*c[\s\u0000- ]*r[\s\u0000- ]*i[\s\u0000- ]*p[\s\u0000- ]*t[\s\u0000- ]*:/i.test(
          attr.value,
        )
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

export interface PrintOptions {
  baseHref?: string;
  marking?: Marking;
  title?: string;
  version?: string;
  user?: string;
}

/**
 * Build the inert, stamped snapshot.
 *
 * Exported for the test: asserting the stamp's computed priority on a real
 * document is what makes the "hostile CSS cannot hide it" claim true rather
 * than merely stated, and it is the assertion most likely to rot silently.
 */
export function buildPrintHtml(sourceDoc: Document, opts: PrintOptions = {}): string {
  // No authoredAssets here, deliberately: the export path snapshots a
  // POST-script DOM, where a stylesheet the document's own script injected is
  // load-bearing rather than contamination.
  const raw = serializeCleanHtml(sourceDoc);
  const parsed = new DOMParser().parseFromString(raw, "text/html");

  parsed.querySelectorAll("script").forEach((s) => s.remove());
  scrubActiveContent(parsed);

  const head = parsed.head ?? parsed.documentElement;
  if (opts.baseHref) {
    const base = parsed.createElement("base");
    base.href = opts.baseHref;
    head.insertBefore(base, head.firstChild);
  }
  // No `@page` of ours. One used to be appended here, and because `@page`
  // cascades by order it beat every page the document declared: a deck sized
  // `200mm 120mm; margin: 0` printed each slide across two pages. It also
  // took the margin choice away from the person printing — Chrome ignores the
  // dialog's setting once CSS sets one. The stamp never needed it: a fixed box
  // sits at the edge of the page area whatever the margin is.

  const marking = opts.marking;
  if (marking && markingIsVisible(marking)) {
    const body = parsed.body ?? parsed.documentElement;
    const context = {
      title: opts.title ?? "",
      version: opts.version ?? "",
      user: opts.user ?? "",
    };
    // The stamps go BEFORE the content. A deck ends its last slide with
    // `page-break-after: always`, and anything after that in the DOM — a fixed
    // box included — makes the browser open a page for it: eight slides printed
    // nine pages, the last carrying nothing but the stamp. Fixed positioning
    // does not care where in the body the box sits. Footer first, then the
    // label, so the two read in source order once both are prepended.
    const prepend = (el: HTMLElement) => body.insertBefore(el, body.firstChild);

    if (marking.footer) {
      prepend(
        stampElement(
          parsed,
          PRINT_FOOTER_CLASS,
          // {year} and {date} resolve HERE, at export time. The design this
          // replaces hardcoded the year, which silently went stale.
          resolveFooter(marking.footer, context),
          {
            left: "0",
            right: "0",
            bottom: "0",
            top: "auto",
            color: "#4a4a55",
            font: '9px/1.35 -apple-system, "Helvetica Neue", Arial, sans-serif',
            "text-align": "center",
            padding: "6px 14px",
            background: "transparent",
          },
        ),
      );
    }
    if (marking.label) {
      prepend(
        stampElement(parsed, PRINT_MARK_CLASS, marking.label, {
          top: "0",
          right: "0",
          left: "auto",
          bottom: "auto",
          color: "#b02318",
          font: '700 9px/1 -apple-system, "Helvetica Neue", Arial, sans-serif',
          "letter-spacing": "0.14em",
          padding: "6px 12px",
        }),
      );
    }
  }

  return `<!DOCTYPE html>\n${parsed.documentElement.outerHTML}`;
}

/** Place only the generated marks above authored ancestor layout, without modifying that layout. */
export function activatePrintMarks(doc: Document): void {
  for (const mark of Array.from(doc.querySelectorAll<HTMLElement>(`.${PRINT_MARK_CLASS}, .${PRINT_FOOTER_CLASS}`))) {
    if (typeof mark.showPopover !== "function") {
      throw new Error("This browser cannot safely print export markings. Update your browser and try again.");
    }
    mark.showPopover();
  }
}

/**
 * Open the browser's print dialog for a stamped snapshot.
 *
 * When marking is disabled the stamp nodes are simply absent — and every other
 * property here stays unconditional. The sandbox, the script removal, the
 * handler scrub and the javascript: scrub do not depend on whether anybody
 * turned marking on.
 */
export async function printDoc(
  sourceDoc: Document,
  opts: PrintOptions = {},
): Promise<void> {
  const html = buildPrintHtml(sourceDoc, opts);

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(frame);

  const fdoc = frame.contentDocument;
  if (!fdoc) {
    frame.remove();
    throw new Error("Could not open a print view.");
  }
  fdoc.open();
  fdoc.write(html);
  fdoc.close();

  // Give layout, images and fonts a moment to settle. Printing too early
  // produces a page of unstyled text, which looks like a bug in the document.
  await new Promise((r) => setTimeout(r, 250));
  try {
    activatePrintMarks(fdoc);
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
  } finally {
    setTimeout(() => frame.remove(), 1500);
  }
}
