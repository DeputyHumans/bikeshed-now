// SPDX-License-Identifier: Apache-2.0
// How long a document takes to read, from the word count its version carries (SPEC §4).

/**
 * Silent reading of non-fiction, in words a minute: 238, the average across
 * 190 studies (Brysbaert, 2019). A rounded-up estimate of a sitting, never
 * a measurement; "time spent reading" in Activity is the measured one.
 */
export const WORDS_PER_MINUTE = 238;

export function readingMinutes(words: number): number {
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/** "6 min read", or null when the words have not been counted. */
export function readingTime(words: number | null | undefined): string | null {
  return typeof words === "number" ? `${readingMinutes(words)} min read` : null;
}
