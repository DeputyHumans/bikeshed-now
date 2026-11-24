// SPDX-License-Identifier: Apache-2.0
// One slide, rendered small and inert, for the rail and the overview (SPEC §6d).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Box, Slide, StageSize } from "../viewer/deck";
import { buildPreviewDoc, fitPreview, revealHidden } from "../viewer/preview";
import { THUMB_STAGE } from "../thumbs";

/**
 * This component owns scaling and nothing else. What a preview CONTAINS is
 * `viewer/preview.ts`. It is laid out as on a 1280×720 screen, the stage the
 * stored images are captured at, grown to hold its slide when the slide is
 * larger (`fitPreview`), and shows the slide's CONTENT, contained and centred
 * in a box of the deck's one shape (`ratio`, from `deckShape`), so every
 * thumbnail in the rail and every card in the overview is the same shape.
 *
 * It used to be laid out at the reader's own window, and shown whole, in the
 * window's shape: a phone, or a desktop with the panels open, made every
 * thumbnail of a landscape deck portrait, a letterboxed stage between bands.
 */

/** Where the preview sits and how large, so its `crop` fills a box of `box`'s size, contained and centred. */
export function thumbTransform(crop: Box, box: StageSize): { x: number; y: number; scale: number } {
  if (crop.width <= 0 || crop.height <= 0 || box.width <= 0 || box.height <= 0) return { x: 0, y: 0, scale: 1 };
  const scale = Math.min(box.width / crop.width, box.height / crop.height);
  return {
    x: (box.width - crop.width * scale) / 2 - crop.left * scale,
    y: (box.height - crop.height * scale) / 2 - crop.top * scale,
    scale,
  };
}

/**
 * Only until the box reports a width. jsdom never lays out, so this is the
 * value every test runs on; a browser replaces it in the same commit, because
 * the measuring effect reads the box synchronously after layout.
 *
 * It is NOT a second owner of the thumbnail width. CSS owns that — the box is
 * `width:100%` with an `aspect-ratio` — and nothing here is allowed to know it.
 */
const UNMEASURED_WIDTH = 240;

/** The stored image's twin of the frame's mark (`settle`): same mark, same CSS, nothing to fit. */
function markImagePainted(event: React.SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.setAttribute("data-painted", "");
}

export function SlideThumb({
  slide,
  baseHref,
  ratio,
  state = "",
  image,
}: {
  slide: Slide;
  /** `/content/{docId}/{versionId}/`, the same base the print export uses. */
  baseHref: string;
  /** Width over height of every thumbnail of the deck: its content's shape (`deckShape`). */
  ratio: number;
  /** The deck's shown-slide classes, from `slideStateTokens`. */
  state?: string;
  /**
   * This slide's stored image, when the version on screen has one
   * (`storedSlideImages`). Shown instead of a live preview: one request, kept
   * by the browser, and no preview built at all. If it will not load, the live
   * preview takes over, so a missing image costs a thumbnail nothing.
   */
  image?: string;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [boxWidth, setBoxWidth] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const stored = image && !imageFailed ? image : null;
  const frame = useRef<HTMLIFrameElement>(null);
  /** What the preview is laid out at: a 1280×720 screen, grown to hold its slide. */
  const [layout, setLayout] = useState<StageSize>(THUMB_STAGE);
  /** The box of the preview the thumbnail shows, once measured; the whole layout until then. */
  const [crop, setCrop] = useState<Box | null>(null);

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
    () => (visible && !stored ? buildPreviewDoc(slide, baseHref, state) : null),
    [visible, stored, slide, baseHref, state],
  );

  /**
   * The skeleton is hidden by CSS once the preview in front of it is shown,
   * keyed on an attribute rather than on state. It is latched for free — an
   * edit re-renders the same iframe, which keeps the mark, so typing does not
   * flash "loading" over a slide that is already there.
   *
   * On load the reveal pass runs first, in the PREVIEW's document, because it
   * needs the preview's computed styles and must never see the reader's. Then
   * the preview is fitted: laid out again if its slide reaches past it, and
   * cropped to the slide's content. The mark goes on once the crop is in, so
   * the skeleton covers the frame until it shows what it should. A new
   * `srcDoc` loads a new document, so all of it runs again on a rebuild.
   */
  /** Whether this load has grown the layout once already: one grow holds what reached past. */
  const grewThisLoad = useRef(false);
  const settle = (at: StageSize) => {
    const el = frame.current;
    const doc = el?.contentDocument;
    if (!el || !doc) return;
    const fit = fitPreview(doc, at);
    if (fit && !grewThisLoad.current && (fit.layout.width !== at.width || fit.layout.height !== at.height)) {
      grewThisLoad.current = true;
      setLayout(fit.layout);
      return;
    }
    setCrop(fit ? fit.crop : null);
    el.setAttribute("data-painted", "");
  };
  const onLoad = () => {
    const doc = frame.current?.contentDocument;
    if (doc) revealHidden(doc);
    grewThisLoad.current = false;
    settle(layout);
  };
  // A grown layout is measured again once the frame is laid out at it.
  const grown = useRef(false);
  useLayoutEffect(() => {
    if (!grown.current) {
      grown.current = true;
      return;
    }
    settle(layout);
    // Only when the layout changes: settle reads the frame, not React state.
  }, [layout.width, layout.height]);

  const width = boxWidth > 0 ? boxWidth : UNMEASURED_WIDTH;
  const place = thumbTransform(crop ?? { left: 0, top: 0, width: layout.width, height: layout.height }, { width, height: width / ratio });

  return (
    <span ref={box} className="slide-thumb-box">
      {stored ? (
        <img
          className="slide-thumb-image"
          src={stored}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          onLoad={markImagePainted}
          onError={() => setImageFailed(true)}
        />
      ) : srcDoc ? (
        <iframe
          ref={frame}
          className="slide-thumb-frame"
          title={`Slide ${slide.index + 1}`}
          aria-hidden="true"
          tabIndex={-1}
          sandbox="allow-same-origin"
          srcDoc={srcDoc}
          onLoad={onLoad}
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${place.x}px, ${place.y}px) scale(${place.scale})`,
          }}
        />
      ) : null}
      {/* Until the preview has painted, the box would be a blank slide. */}
      <span className="skeleton slide-thumb-skeleton" aria-hidden="true" />
    </span>
  );
}
