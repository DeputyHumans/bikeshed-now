// SPDX-License-Identifier: Apache-2.0
// The four responsive tiers, shared between JavaScript and CSS (SPEC §7).

/**
 * CSS @media conditions cannot read a custom property, so these values are
 * duplicated as literals in the stylesheets. `brand/tokens.test.ts` parses
 * every @media rule in styles/ and asserts each max-width is one of these four,
 * which turns "keep them in sync" from a comment into a test.
 *
 *   COMPACT_TOOLBAR  viewer toolbar secondary actions drop their labels and go
 *                    icon-only. Trust and Edit keep theirs at every width,
 *                    because both change what the document DOES.
 *   ONE_COLUMN       viewer and workspace collapse to one column; the slide
 *                    rail becomes a drawer; a Doc/Comments toggle appears.
 *   PHONE            condensed header, toolbar overflow menu, rail drawer.
 *   XS               hide the address and the viewer title; tighter padding.
 */
export const COMPACT_TOOLBAR_MAX = 1100;
export const ONE_COLUMN_MAX = 860;
export const PHONE_MAX = 600;
export const XS_MAX = 400;

export const BREAKPOINTS = [
  COMPACT_TOOLBAR_MAX,
  ONE_COLUMN_MAX,
  PHONE_MAX,
  XS_MAX,
] as const;

export const COMPACT_TOOLBAR_QUERY = `(max-width: ${COMPACT_TOOLBAR_MAX}px)`;
export const ONE_COLUMN_QUERY = `(max-width: ${ONE_COLUMN_MAX}px)`;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX}px)`;
export const XS_QUERY = `(max-width: ${XS_MAX}px)`;
export const COARSE_POINTER_QUERY = "(hover: none), (pointer: coarse)";
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
