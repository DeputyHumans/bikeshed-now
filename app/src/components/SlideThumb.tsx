// SPDX-License-Identifier: Apache-2.0
// One slide, rendered small and inert, for the rail and the overview (SPEC §6d).

import { useEffect, useMemo, useRef, useState } from "react";

import { OWN_SELECTOR } from "../brand/dom";
import type { Slide } from "../viewer/deck";

/**
 * A preview is a SEPARATE document we build, never the frame the reader reads.
 *
 * That distinction is the whole reason this is allowed to restyle anything.
 * The copy below forces the slide visible and static, which a deck whose
 * `.slide` is `position:absolute; visibility:hidden` needs or it previews
 * blank — but it is applied to a parent-constructed document that nothing
 * serializes, so it cannot reach published bytes and does not touch the
 * reader's view.
 *
 * Previews are inert even for a trusted document: `sandbox="allow-same-origin"`
 * with no `allow-scripts`. A thumbnail is not worth running anybody's code.
 */

/** Used only until the live frame can be measured; a deck is near enough 16:9. */
const FALLBACK = { width: 1280, height: 720 };

function previewDoc(slide: Slide, baseHref: string): string {
  const doc = slide.outer.ownerDocument;

  // The guest's own stylesheets, minus ours. Without the filter a reader's
  // highlights bleed into every thumbnail.
  const styles = Array.from(doc.head.querySelectorAll('style, link[rel="stylesheet"]'))
    .filter((el) => !el.matches(OWN_SELECTOR))
    .map((el) => el.outerHTML)
    .join("");

  const htmlClass = doc.documentElement.getAttribute("class") ?? "";
  const bodyClass = doc.body?.getAttribute("class") ?? "";

  return [
    "<!doctype html><html",
    htmlClass ? ` class="${htmlClass.replace(/"/g, "&quot;")}"` : "",
    '><head><meta charset="utf-8">',
    // Relative images and fonts resolve against the content proxy, not the app
    // origin. Without this every asset in a preview 404s.
    `<base href="${baseHref.replace(/"/g, "&quot;")}">`,
    styles,
    "<style>html,body{margin:0;padding:0;overflow:hidden;background:#fff}",
    // Undo the layout a deck applies to hide every slide but the current one.
    "body>*{position:static!important;visibility:visible!important;",
    "inset:auto!important;margin:0!important;transform:none!important;opacity:1!important}",
    "</style></head><body",
    bodyClass ? ` class="${bodyClass.replace(/"/g, "&quot;")}"` : "",
    ">",
    slide.outer.outerHTML,
    "</body></html>",
  ].join("");
}

export function SlideThumb({
  slide,
  baseHref,
  thumbWidth,
}: {
  slide: Slide;
  /** `/content/{docId}/{versionId}/`, the same base the print export uses. */
  baseHref: string;
  thumbWidth: number;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);

  /**
   * Mount only what is on screen. One deck in the sample set has 48 slides, and
   * every preview is an iframe whose assets are fetched through a function —
   * the README is explicit that bytes cost invocations, so rendering all of
   * them at once would be a real bill for a rail nobody scrolled.
   */
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (typeof IntersectionObserver !== "function") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setVisible(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Measured from the live frame rather than assumed: decks ship 16:9 stages,
  // 1280x720 pages and full-viewport sections, and guessing gets two of the
  // three wrong.
  const size = useMemo(() => {
    const rect = slide.outer.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      ? { width: rect.width, height: rect.height }
      : FALLBACK;
  }, [slide]);

  const scale = thumbWidth / size.width;
  // A preview of a very tall section would be a long ribbon down the rail, so
  // the box clips at roughly 4:3 and shows the top of it. A 16:9 slide is
  // shorter than that and is never touched.
  const boxHeight = Math.min(Math.round(size.height * scale), Math.round(thumbWidth * 0.8));
  const srcDoc = useMemo(
    () => (visible ? previewDoc(slide, baseHref) : null),
    [visible, slide, baseHref],
  );

  return (
    <span
      ref={box}
      className="slide-thumb-box"
      style={{ width: thumbWidth, height: boxHeight }}
    >
      {srcDoc ? (
        <iframe
          className="slide-thumb-frame"
          title={`Slide ${slide.index + 1}`}
          aria-hidden="true"
          tabIndex={-1}
          sandbox="allow-same-origin"
          srcDoc={srcDoc}
          style={{
            width: size.width,
            height: size.height,
            transform: `scale(${scale})`,
          }}
        />
      ) : null}
    </span>
  );
}
