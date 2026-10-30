// SPDX-License-Identifier: Apache-2.0
// How long a document takes to read, from the word count its version carries (SPEC §4).

/**
 * Silent reading of non-fiction, in words a minute: 238, the average across
 * 190 studies (Brysbaert, 2019). A rounded-up estimate of a sitting, never
 * a measurement; "time spent reading" in Activity is the measured one.
 */
const WORDS_PER_MINUTE = 238;

export function readingMinutes(words: number): number {
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/** "6 min read", or null when the words have not been counted. */
export function readingTime(words: number | null | undefined): string | null {
  return typeof words === "number" ? `${readingMinutes(words)} min read` : null;
}

/**
 * The word count of the version on screen: counted on the version itself,
 * else in the document's summary while it names that version, else in the
 * mirror a reader without the record reads, while it is of that version.
 * Undefined until counted. The chip and the Details sheet both read this.
 */
export function wordsOf(
  viewing: string,
  from: {
    version?: { words?: number } | null;
    latest?: { version?: string; words?: number } | null;
    mirror?: { currentVersion?: string; words?: number | null } | null;
  },
): number | undefined {
  if (typeof from.version?.words === "number") return from.version.words;
  if (from.latest?.version === viewing && typeof from.latest.words === "number") return from.latest.words;
  if (from.mirror?.currentVersion === viewing && typeof from.mirror.words === "number") return from.mirror.words;
  return undefined;
}
