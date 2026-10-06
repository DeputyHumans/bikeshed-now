// SPDX-License-Identifier: Apache-2.0
// Every slide at once, as a way of getting to one of them (SPEC §6d).

import { useEffect, useRef } from "react";

import { Icon } from "./Icon";
import { SlideThumb } from "./SlideThumb";
import { slideStateTokens } from "../viewer/preview";
import type { Slide, StageSize } from "../viewer/deck";

/**
 * Escape is deliberately NOT bound here.
 *
 * Four things in this app already arm a document-level Escape handler with no
 * focus gate, so a fifth would dismiss two of them at once. `useDeck` owns the
 * key and closes the overview before presentation mode sees it.
 */

export function SlideOverview({
  slides,
  current,
  baseHref,
  stage,
  onGoTo,
  onClose,
}: {
  slides: Slide[];
  current: number;
  baseHref: string;
  stage: StageSize;
  onGoTo: (index: number) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // Every render, as in the rail: see `SlidePanel`.
  const state = slideStateTokens(slides);

  /**
   * Focus moves in so the overview is keyboard-reachable the moment it opens,
   * and so Escape has somewhere sensible to return from — landing on the slide
   * the reader is actually on.
   *
   * Two queries, not one selector list. `querySelector('[aria-current], button')`
   * returns the first element matching EITHER in tree order, which is always
   * card one: the reader on slide thirty opened the overview and was put back
   * at the beginning.
   */
  useEffect(() => {
    const grid = panel.current;
    const target =
      grid?.querySelector<HTMLElement>('[aria-current="true"]') ??
      grid?.querySelector<HTMLElement>("button");
    target?.focus();
  }, []);

  return (
    <div
      className="slide-overview"
      role="dialog"
      aria-modal="true"
      aria-label="All slides"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="slide-overview-bar">
        <span>
          {slides.length} slides
        </span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          <Icon name="close" size={14} /> Close
        </button>
      </div>
      <div className="slide-overview-grid" ref={panel}>
        {slides.map((slide, i) => (
          <button
            key={slide.el.id || `${slide.index}-${slide.title}`}
            type="button"
            className="slide-overview-item"
            aria-current={current === i}
            aria-label={`Slide ${i + 1}: ${slide.title}`}
            onClick={() => {
              onGoTo(i);
              onClose();
            }}
          >
            <SlideThumb slide={slide} baseHref={baseHref} stage={stage} state={state} />
            <span className="slide-overview-caption">
              <span className="slide-overview-index">{i + 1}</span>
              <span className="slide-overview-title">{slide.title}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
