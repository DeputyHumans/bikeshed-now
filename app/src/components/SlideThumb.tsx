// SPDX-License-Identifier: Apache-2.0
// One slide, rendered small and inert, for the rail and the overview (SPEC §6d).

import { useEffect, useMemo, useRef, useState } from "react";

import type { Slide, StageSize } from "../viewer/deck";
import { buildPreviewDoc, revealHidden } from "../viewer/preview";

/**
 * This component owns scaling and nothing else. What a preview CONTAINS is
 * `viewer/preview.ts`; what size it is laid out at is `stage`, decided once for
 * the whole deck by `useDeck` so every thumbnail in the rail and every card in
 * the overview is the same shape. Sizing previews slide by slide is what made
 * the rail a ragged column and left dead space under every short card.
 */

/**
 * Only until the box reports a width. jsdom never lays out, so this is the
 * value every test runs on; a browser replaces it in the same commit, because
 * the measuring effect reads the box synchronously after layout.
 *
 * It is NOT a second owner of the thumbnail width. CSS owns that — the box is
 * `width:100%` with an `aspect-ratio` — and nothing here is allowed to know it.
 */
const UNMEASURED_WIDTH = 240;

/**
 * The skeleton is hidden by CSS once the preview in front of it has loaded,
 * keyed on this attribute rather than on state. It is latched for free — an
 * edit re-renders the same iframe, which keeps the mark, so typing does not
 * flash "loading" over a slide that is already there — and a load that lands
 * after a test's last assertion is not a React update at all.
 *
 * The reveal pass runs first, in the PREVIEW's document, because it needs the
 * preview's computed styles and must never see the reader's. A new `srcDoc`
 * loads a new document, so it runs again whenever the preview is rebuilt.
 */
function markPainted(event: React.SyntheticEvent<HTMLIFrameElement>) {
  const frame = event.currentTarget;
  if (frame.contentDocument) revealHidden(frame.contentDocument);
  frame.setAttribute("data-painted", "");
}

export function SlideThumb({
  slide,
  baseHref,
  stage,
  state = "",
}: {
  slide: Slide;
  /** `/content/{docId}/{versionId}/`, the same base the print export uses. */
  baseHref: string;
  stage: StageSize;
  /** The deck's shown-slide classes, from `slideStateTokens`. */
  state?: string;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [boxWidth, setBoxWidth] = useState(0);

  /**
   * Mount only what is on screen. A deck can run to dozens of slides, and a
   * preview's relative assets are fetched through a function — the README is
   * explicit that bytes cost invocations, so rendering every slide at once
   * would be a real bill for a rail nobody scrolled.
   *
   * `visible` is deliberately one-way. A private document is served `no-store`,
   * so unmounting a scrolled-past preview would mean a genuine refetch on the
   * way back; latching caps each slide at one load per session instead.
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

  /**
   * The scale comes from measuring our own box, so CSS stays the only owner of
   * how wide a thumbnail is. The rail's width lives in one stylesheet rule and
   * the overview's is `minmax(236px, 1fr)` — a function of the container, not a
   * constant at all, which is why no exported number could have served both.
   */
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const apply = () => {
      const width = el.getBoundingClientRect().width;
      // Guarded so a resize that changes nothing does not re-render the rail.
      setBoxWidth((prev) => (Math.abs(prev - width) < 0.5 ? prev : width));
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const srcDoc = useMemo(
    () => (visible ? buildPreviewDoc(slide, baseHref, state) : null),
    [visible, slide, baseHref, state],
  );

  const width = boxWidth > 0 ? boxWidth : UNMEASURED_WIDTH;
  const scale = width / stage.width;

  return (
    <span ref={box} className="slide-thumb-box">
      {srcDoc ? (
        <iframe
          className="slide-thumb-frame"
          title={`Slide ${slide.index + 1}`}
          aria-hidden="true"
          tabIndex={-1}
          sandbox="allow-same-origin"
          srcDoc={srcDoc}
          onLoad={markPainted}
          style={{
            width: stage.width,
            height: stage.height,
            transform: `scale(${scale})`,
          }}
        />
      ) : null}
      {/* Until the preview has painted, the box would be a blank slide. */}
      <span className="skeleton slide-thumb-skeleton" aria-hidden="true" />
    </span>
  );
}
