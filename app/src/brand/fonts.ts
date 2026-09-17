// SPDX-License-Identifier: Apache-2.0
// The one @font-face definition, shared by the app and the edit iframe (SPEC §10).

/**
 * Why this is a module rather than a line of CSS
 * ---------------------------------------------
 * The typeface has to be declared in two places: the app's own stylesheet, and
 * the stylesheet injected into the edit iframe so the toolbar's font controls
 * offer something the document can actually render.
 *
 * In the design this replaces, that meant the same font URL pasted into
 * `index.html` and into the iframe injector — and the two drifted. One module
 * that both read is the whole fix, and it is why `brand/dom.ts` exists in the
 * same shape for injected identifiers.
 *
 * Self-hosted, never a CDN: a CDN link tells a third party the viewer's IP, user
 * agent and referer on every page load, which is an unacceptable default for a
 * tool holding documents people mark confidential, and it breaks entirely in an
 * air-gapped deployment. See tools/build-font.py for how the file is produced.
 */

export const FONT_FAMILY = "Bikeshed Sans";

export const FONT_URL = "/fonts/bikeshed-sans-var.woff2";

/**
 * The full stack, including the fallbacks that render before the file arrives
 * and if it never does. `font-display: swap` means text is readable
 * immediately; the metric-compatible fallbacks keep the reflow small.
 */
export const FONT_STACK = `"${FONT_FAMILY}", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/** Zero-byte: every platform already has one of these. */
export const MONO_STACK = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`;

export const FONT_FACE_CSS = `
@font-face {
  font-family: "${FONT_FAMILY}";
  src: url("${FONT_URL}") format("woff2-variations"),
       url("${FONT_URL}") format("woff2");
  font-weight: 300 800;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0000-00FF, U+0100-02AF, U+1E00-1E9F, U+2000-206F, U+2C60-2C7F, U+A720-A7FF;
}
`.trim();

/**
 * Font families the edit toolbar offers.
 *
 * Every entry resolves without a network request on a normal machine, because a
 * document is an artifact: a reader who downloads it, or opens it in five
 * years, must see what the editor saw.
 */
export const EDITOR_FONT_CHOICES: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Sans", value: FONT_STACK },
  { label: "Serif", value: 'ui-serif, Georgia, "Times New Roman", serif' },
  { label: "Mono", value: MONO_STACK },
];
