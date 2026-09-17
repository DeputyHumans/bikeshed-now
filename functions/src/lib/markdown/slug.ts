// SPDX-License-Identifier: Apache-2.0
// GitHub-style heading slugs, deterministic and deduped (SPEC §11).

/**
 * These slugs are not decoration. Annotation anchors scope to the nearest
 * `id`-bearing ancestor (SPEC §6), so they are what a highlight in a Markdown
 * document is measured against. Two properties therefore matter more than
 * prettiness:
 *
 *   DETERMINISM   the same source must produce the same slugs on every render,
 *                 across process restarts, or the content hash changes and a
 *                 no-op republish mints a version.
 *
 *   LOCALITY      editing one heading must not renumber unrelated slugs, or
 *                 every anchor below the edit silently re-scopes to a different
 *                 section.
 *
 * Numbering is assigned in document order, so an edit can only affect duplicates
 * of the SAME heading text that appear after it.
 */

/** Strip inline Markdown emphasis and code marks from heading text. */
function plainText(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/__([^_]*)__/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/_([^_]*)_/g, "$1")
    .replace(/~~([^~]*)~~/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/** The base slug for one heading, before deduplication. */
export function baseSlug(text: string): string {
  const slug = plainText(String(text ?? ""))
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "section";
}

/**
 * Allocates unique slugs across one document.
 *
 * Reserve identifiers the renderer itself emits (`preamble`) before walking the
 * headings, so a heading that happens to be called "Preamble" gets `preamble-1`
 * rather than colliding with the wrapper.
 */
export class Slugger {
  private readonly counts = new Map<string, number>();

  constructor(reserved: readonly string[] = []) {
    for (const r of reserved) this.counts.set(r, 1);
  }

  slug(text: string): string {
    const base = baseSlug(text);
    const seen = this.counts.get(base) ?? 0;
    this.counts.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  }
}
