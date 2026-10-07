// SPDX-License-Identifier: Apache-2.0
// Fitting a deck that scales itself by script into the script-free edit frame (SPEC §6a, §6d).

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { Slide } from "./deck";

/**
 * A deck commonly sizes its slides with its own JavaScript: a 1920px slide
 * scaled by a custom property the script sets to fit the window. The edit
 * frame never runs a document's scripts (SPEC §6a), so there the property is
 * never set, every rule that reads it is dropped, and the slides render at
 * full size. Centred in a frame half that wide, the left edge of every slide
 * lands at a negative offset — and nothing scrolls to a negative offset. Text
 * there can be neither edited nor reviewed: the review pass marks a target
 * nobody can see.
 *
 * So, while editing, the FRAME is laid out at the width the slides need and
 * scaled down to the space on screen. The iframe element belongs to this app's
 * page, never to the document: nothing here writes to the document, which is
 * why this hook, like `useDeck`, has no place in the declaration-order rule
 * or in `invariant.test.tsx`'s harness.
 *
 * The width is LATCHED per frame load, as `paged` is in `useDeck` and for the
 * same reason: measured again after the frame widens, the slides fit, the fit
 * is withdrawn, the frame narrows, and the viewer oscillates. Only the scale
 * follows the space on screen.
 */

/** Room kept on either side of the widest slide content, in layout pixels. */
const GUTTER = 16;

export interface Extent {
  left: number;
  right: number;
}

/**
 * The width the frame must be laid out at for every slide's content to sit
 * inside it, or null when it already does.
 *
 * Widening a frame by `w` moves centred content right by `w / 2`, left-aligned
 * content not at all, and right-aligned content by `w`. Adding what is cut off
 * on BOTH sides, plus a gutter on each, is enough in all three cases.
 */
export function fitLayoutWidth(viewportWidth: number, extents: readonly Extent[]): number | null {
  if (viewportWidth <= 0 || extents.length === 0) return null;
  const left = Math.min(...extents.map((e) => e.left));
  const right = Math.max(...extents.map((e) => e.right));
  const before = Math.max(0, -left);
  const after = Math.max(0, right - viewportWidth);
  if (before === 0 && after === 0) return null;
  return Math.ceil(viewportWidth + before + after + 2 * GUTTER);
}

/** How the iframe is laid out and scaled, given the latched width and the space on screen. */
export function fitStyle(layoutWidth: number, stage: { width: number; height: number }): CSSProperties | undefined {
  if (layoutWidth <= 0 || stage.width <= 0 || stage.height <= 0) return undefined;
  const scale = Math.min(1, stage.width / layoutWidth);
  return {
    position: "absolute",
    top: 0,
    left: 0,
    width: layoutWidth,
    height: stage.height / scale,
    transform: `scale(${scale})`,
    transformOrigin: "0 0",
  };
}

/**
 * Where each slide's content reaches horizontally, in the frame's layout
 * coordinates. Descendants are measured, not just the slide: a slide box can
 * fit while the fixed-width content inside it overflows. Boxes under 2px are
 * skipped, so visually hidden text parked off-canvas does not stretch the fit.
 */
function slideExtents(view: Window, slides: readonly Slide[]): Extent[] {
  const out: Extent[] = [];
  for (const slide of slides) {
    for (const el of [slide.outer, ...Array.from(slide.outer.querySelectorAll("*"))]) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      out.push({ left: r.left + view.scrollX, right: r.right + view.scrollX });
    }
  }
  return out;
}

export function useFrameFit({
  doc,
  epoch,
  active,
  slides,
  stageRef,
}: {
  doc: Document | null;
  epoch: number;
  /** Editing: the only frame in which a deck's own scripts never run. */
  active: boolean;
  slides: readonly Slide[];
  stageRef: RefObject<HTMLElement>;
}): CSSProperties | undefined {
  // Keyed by the load it was measured on, so a reloaded frame is measured
  // afresh at its natural width rather than inheriting the last fit.
  const [fit, setFit] = useState<{ epoch: number; width: number } | null>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const measured = useRef<number | null>(null);

  useEffect(() => {
    const view = doc?.defaultView;
    if (!active || !view || measured.current === epoch) return;
    // The slide list arrives a render after the document; measure only one
    // that belongs to this document.
    if (slides.length === 0 || slides[0].el.ownerDocument !== doc) return;
    measured.current = epoch;
    const width = fitLayoutWidth(view.innerWidth, slideExtents(view, slides));
    setFit(width === null ? null : { epoch, width });
  }, [doc, epoch, active, slides]);

  useEffect(() => {
    if (!active) {
      measured.current = null;
      setFit(null);
    }
  }, [active]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || !active) return;
    const read = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [stageRef, active]);

  if (!active || !fit || fit.epoch !== epoch) return undefined;
  return fitStyle(fit.width, stage);
}
