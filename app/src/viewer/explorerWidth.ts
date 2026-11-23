// SPDX-License-Identifier: Apache-2.0
// The explorer column's width: its bounds, defined once for the handle and checked against the stylesheet's clamp() (SPEC §13 "The explorer").

/**
 * The reader drags or keys the column's width and the account keeps it (ADR
 * 0041). viewer.css draws it as `clamp(min, --explorer-width, min(max, share
 * of the window))`, so the document always keeps the rest of the window;
 * styles/viewer.test.ts holds the two to the same numbers.
 */
export const EXPLORER_WIDTH = { min: 200, max: 480, initial: 260 } as const;
export const EXPLORER_MAX_SHARE = 0.35;

export interface WidthBounds {
  min: number;
  max: number;
  initial: number;
}

export const isWidthChoice = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= EXPLORER_WIDTH.min && v <= EXPLORER_WIDTH.max;

/** The bounds at a window this wide, as the stylesheet's clamp() draws them. */
export function widthBounds(viewport: number): WidthBounds {
  const max = Math.min(EXPLORER_WIDTH.max, Math.floor(viewport * EXPLORER_MAX_SHARE));
  return { min: EXPLORER_WIDTH.min, max: Math.max(EXPLORER_WIDTH.min, max), initial: EXPLORER_WIDTH.initial };
}
