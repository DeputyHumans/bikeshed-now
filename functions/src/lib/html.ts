// SPDX-License-Identifier: Apache-2.0
// Escaping for markup the functions emit outside the Markdown renderer (SPEC §17).

/**
 * Why this is not shared with `markdown/render.ts`.
 *
 * That renderer's `escapeAttr`/`escapeText` produce bytes that are part of the
 * content hash (ADR 0003): changing them, even to fix an omission, mints a new
 * hash for every existing document. They also do not escape `'`, which is fine
 * inside their own double-quoted attributes but is not safe in general.
 *
 * Everything this module escapes lands in the app shell on the app origin,
 * where the session cookie lives, so it gets its own escaper with no frozen
 * output to preserve and no reason to leave `'` unescaped.
 */

/** Escapes text for placement between HTML tags. */
export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escapes text for placement inside a quoted HTML attribute value. */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
