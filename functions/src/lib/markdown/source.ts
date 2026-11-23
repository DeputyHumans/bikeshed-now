// SPDX-License-Identifier: Apache-2.0
// A Markdown document's own Markdown as its `.md` address answers it, the front matter on top, and the refusal of that front matter sent back (SPEC §19, ADR 0042).

import { READING_NOTICE } from "./reading";

/**
 * Why this is not in `reading.ts`
 * -------------------------------
 * A Markdown document already is Markdown, so `/d/<id>.md` answers it as
 * written instead of a reading made back from its HTML, which lost what the
 * HTML could not carry back and said "it is not the source" of the source
 * (ADR 0042). The front matter says what the text is, as a reading's does
 * (ADR 0030 §3), because an agent that has only an address must still know
 * what it holds. `reading.ts` is one of the files that name a kept reading
 * (`stored.ts`), so anything added to it would make every kept reading again
 * (ADR 0033). Nothing here is part of a reading, so it lives apart.
 */

/** The sentence a Markdown document's `.md` address opens with. */
export const SOURCE_NOTICE =
  "The Markdown this document is written in, as published. This front matter is not part of it: to revise, send only what follows it. When you comment, quote its words, not its Markdown.";

/**
 * The front matter on a Markdown document's `.md` address: the reading's
 * shape and quoting (`readingPreamble`), with nothing to say about what was
 * left out, because nothing was. `original` is the bare Markdown at its
 * versioned address, which the source's relative links resolve against.
 */
export function sourcePreamble(input: { title: string; document: string; version: string; original: string }): string {
  const q = (s: string) => JSON.stringify(s);
  return [
    "---",
    `source: ${q(SOURCE_NOTICE)}`,
    `title: ${q(input.title)}`,
    `document: ${q(input.document)}`,
    `version: ${q(input.version)}`,
    `original: ${q(input.original)}`,
    "---",
    "",
  ].join("\n");
}

/** The front matter, a blank line, then the source exactly as stored. */
export function composeSource(preamble: string, source: string): string {
  return source ? `${preamble}\n${source}` : preamble;
}

const OWN_LINES = new Set([`source: ${JSON.stringify(SOURCE_NOTICE)}`, `reading: ${JSON.stringify(READING_NOTICE)}`]);

/** The opening block is read this far at most; ours is under a kilobyte. */
const OPENING_SCAN_CHARS = 16_384;

/**
 * True when `content` opens with front matter Bikeshed wrote: this file's or
 * a reading's, named by its exact notice line. Sent to a Markdown document
 * as its page, it would publish that front matter as the document's first
 * lines, so `update_document` refuses it. An author's own front matter has
 * neither line and passes.
 */
export function opensWithOwnFrontMatter(content: string): boolean {
  const text = content.slice(0, OPENING_SCAN_CHARS).replace(/^﻿/, "");
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines[0] !== "---") return false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") return false;
    if (OWN_LINES.has(lines[i])) return true;
  }
  return false;
}
