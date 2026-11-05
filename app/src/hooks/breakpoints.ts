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
 *   PHONE            the header folds behind one menu button; Print leaves the
 *                    toolbar for the More menu; rail drawer.
 *   XS               a document's details stack, a line each.
 *
 * CONDENSED is PHONE, or a phone on its side: wide enough to look like a tablet,
 * and under 300 CSS px tall in Safari, so the bars above a document have to fold
 * just the same. A height is not a tier, so `tokens.test.ts` does not count it,
 * and `styles/viewer.test.ts` holds its stylesheet copies to this one.
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
export const CONDENSED_QUERY = `(max-width: ${PHONE_MAX}px), (max-height: 500px) and (pointer: coarse)`;
export const COARSE_POINTER_QUERY = "(hover: none), (pointer: coarse)";
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
