// SPDX-License-Identifier: Apache-2.0
// Making an accepted suggestion's change in a document's source, without a DOM (SPEC §22).

import { scanBody, type ScannedText } from "./quote";

/**
 * The browser makes an accepted suggestion's change by finding its quote in
 * the page and typing the replacement over it (`app/src/annotation/exact.ts`).
 * An agent has no page, so this makes the same change in the source instead,
 * under three rules that keep it from ever being a guess (ADR 0015):
 *
 *   1. The quote is found by the browser's own rule — the same normalised
 *      text, the same context scoring — and only where BOTH sides of its
 *      context agree. The browser will settle for one side; this does not,
 *      so any way in which this text and the page's could differ ends in a
 *      refusal rather than in another place.
 *   2. Exactly the source bytes of that text are replaced, and only when they
 *      hold no markup. Every other byte of the document stays as it was.
 *   3. The result is read back. Its text must be the old text with that one
 *      span replaced, which is the check the browser makes after typing. A
 *      Markdown change is tried at each place the quote is written out in the
 *      source, and kept only if exactly one of them renders as asked.
 *
 * Whatever falls outside those rules is refused, and the refusal says to
 * accept it in the app, where it is made against the page itself.
 */

export type ApplyRefusal =
  /** The quote is not there as quoted. Only rejectable, as in the app. */
  | "stale"
  /** The quote is there, but its context does not pin it to one place. */
  | "unplaced"
  /** Its source holds markup, so only an editor can replace it. */
  | "markup"
  /** A Markdown quote not written out plainly in the source. */
  | "not-verbatim"
  /** The read-back did not show exactly the change asked for. */
  | "unverified";

export type ApplyResult =
  | { state: "applied"; html: string; markdown?: string }
  | { state: "already-applied" }
  | { state: "refused"; reason: ApplyRefusal };

export interface SuggestionAnchor {
  exact: string;
  prefix: string;
  suffix: string;
}

const squash = (s: string) => s.replace(/\s+/g, " ");
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** The body's text as the browser normalises `textContent`: each run of whitespace one space, never trimmed. */
interface BodyText {
  text: string;
  /** For each character of `text`, the source span it stands for, and its run of text. */
  from: number[];
  to: number[];
  run: number[];
}

export function bodyText(html: string): BodyText {
  const scanned: ScannedText = scanBody(html);
  const out: BodyText = { text: "", from: [], to: [], run: [] };
  const parts: string[] = [];
  for (let k = 0; k < scanned.chars.length; k++) {
    const ch = scanned.chars[k];
    if (isSpace(ch)) {
      if (parts.length > 0 && parts[parts.length - 1] === " " && isSpace(scanned.chars[k - 1])) {
        // Same run of whitespace: the one space now stands for this byte too.
        out.to[out.to.length - 1] = scanned.to[k];
        continue;
      }
      parts.push(" ");
    } else {
      parts.push(ch);
    }
    out.from.push(scanned.from[k]);
    out.to.push(scanned.to[k]);
    out.run.push(scanned.run[k]);
  }
  out.text = parts.join("");
  return out;
}

function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

interface Match {
  start: number;
  end: number;
  sides: 1 | 2;
}

/** `locate` in exact.ts: the unique occurrence both sides agree on, else the unique one either does. */
function locate(text: string, q: SuggestionAnchor): Match | null {
  const exact = squash(q.exact).trim();
  if (!exact) return null;
  const prefix = squash(q.prefix).trimEnd();
  const suffix = squash(q.suffix).trimStart();
  const scored = occurrences(text, exact).map((at) => {
    const before = text.slice(0, at).trimEnd();
    const after = text.slice(at + exact.length).trimStart();
    return {
      at,
      pre: prefix === "" || before.endsWith(prefix),
      suf: suffix === "" || after.startsWith(suffix),
    };
  });
  const both = scored.filter((c) => c.pre && c.suf);
  const either = scored.filter((c) => c.pre || c.suf);
  if (both.length === 1) return { start: both[0].at, end: both[0].at + exact.length, sides: 2 };
  if (both.length === 0 && either.length === 1) return { start: either[0].at, end: either[0].at + exact.length, sides: 1 };
  return null;
}

/** `locateJoin` in exact.ts: where a deletion was made, only with both sides. */
function locateJoin(text: string, q: SuggestionAnchor): Match | null {
  const prefix = squash(q.prefix).trim();
  const suffix = squash(q.suffix).trim();
  if (!prefix || !suffix) return null;
  const joins = occurrences(text, prefix)
    .map((at) => at + prefix.length)
    .filter((p) => text.slice(p).trimStart().startsWith(suffix));
  return joins.length === 1 ? { start: joins[0], end: joins[0], sides: 2 } : null;
}

export type Resolution = { state: "pending"; quote: Match } | { state: "applied" } | { state: "stale" };

/** `resolveSuggestion` in exact.ts, over text rather than a page: one rule for the quote and its replacement. */
export function resolveInText(text: string, anchor: SuggestionAnchor, replacement: string): Resolution {
  const quote = locate(text, anchor);
  const hasContext = Boolean(anchor.prefix.trim() || anchor.suffix.trim());
  const made = !hasContext
    ? null
    : squash(replacement).trim() === ""
      ? locateJoin(text, anchor)
      : locate(text, { exact: replacement, prefix: anchor.prefix, suffix: anchor.suffix });
  if (quote && made) {
    const within = (a: Match, b: Match) => a.start >= b.start && a.end <= b.end;
    if (within(quote, made)) return { state: "applied" };
    if (within(made, quote)) return { state: "pending", quote };
    if (made.sides !== quote.sides) return made.sides > quote.sides ? { state: "applied" } : { state: "pending", quote };
    return { state: "stale" };
  }
  if (made) return { state: "applied" };
  if (quote) return { state: "pending", quote };
  return { state: "stale" };
}

/** What may follow a deleted word directly, so the space before it goes instead (exact.ts). */
const CLOSING = /^[.,;:!?)\]}…'"’”]/;

/**
 * A deletion widened by the one space it would leave doubled, by the rule
 * `widenDeletion` applies in the browser, measured within the run of text.
 */
function widen(body: BodyText, start: number, end: number): { start: number; end: number } {
  const run = body.run[start];
  const before = start > 0 && body.run[start - 1] === run ? body.text[start - 1] : undefined;
  const after = end < body.text.length && body.run[end] === run ? body.text[end] : undefined;
  if (isSpace(before) && isSpace(after)) return { start, end: end + 1 };
  if (isSpace(before) && (after === undefined || CLOSING.test(after))) return { start: start - 1, end };
  if (before === undefined && isSpace(after)) return { start, end: end + 1 };
  return { start, end };
}

const sameText = (a: string, b: string) => squash(a).trim() === squash(b).trim();

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Where the change goes in the page's text, and what the text must read afterwards. */
function plan(
  body: BodyText,
  anchor: SuggestionAnchor,
  replacement: string,
): { state: "already-applied" } | { state: "refused"; reason: ApplyRefusal } | { start: number; end: number; expected: string } {
  const found = resolveInText(body.text, anchor, replacement);
  if (found.state === "applied") return { state: "already-applied" };
  if (found.state === "stale") return { state: "refused", reason: "stale" };
  if (found.quote.sides !== 2) return { state: "refused", reason: "unplaced" };
  const span = replacement === "" ? widen(body, found.quote.start, found.quote.end) : found.quote;
  const expected = body.text.slice(0, span.start) + replacement + body.text.slice(span.end);
  return { start: span.start, end: span.end, expected };
}

/** Make the change in an HTML document's source. */
export function applyToHtml(html: string, anchor: SuggestionAnchor, replacement: string): ApplyResult {
  const body = bodyText(html);
  const where = plan(body, anchor, replacement);
  if ("state" in where) return where;
  return spliceHtml(html, body.from[where.start], body.to[where.end - 1], replacement, where.expected);
}

/**
 * Replace source bytes `from`–`to` with `replacement` as text, and keep the
 * result only if its text reads `expected`. Exported so the read-back can be
 * shown to catch a splice in the wrong place, which the mapping above never
 * produces on purpose.
 */
export function spliceHtml(html: string, from: number, to: number, replacement: string, expected: string): ApplyResult {
  if (html.slice(from, to).includes("<")) return { state: "refused", reason: "markup" };
  const out = html.slice(0, from) + escapeHtml(replacement) + html.slice(to);
  if (!sameText(bodyText(out).text, expected)) return { state: "refused", reason: "unverified" };
  return { state: "applied", html: out };
}

/** How many places in a Markdown source are tried; more than this is no longer one passage. */
const MAX_CANDIDATES = 20;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Inline Markdown a replacement could start by accident, escaped as CommonMark allows. */
const escapeMarkdown = (s: string) => s.replace(/[\\`*_[\]<>&~|]/g, "\\$&");

/**
 * Make the change in a Markdown document's source, given how it renders.
 *
 * The quote is placed in the rendered page by the rules above. In the source
 * it is looked for written out as it reads, wrapped lines allowed, and each
 * place it is found is tried: as the replacement is, then escaped, then with
 * the space a deletion leaves doubled taken too. A try is kept only when the
 * whole page renders as the old one with that one span replaced, and only
 * when exactly one place gives such a try.
 */
export function applyToMarkdown(
  source: string,
  anchor: SuggestionAnchor,
  replacement: string,
  render: (markdown: string) => string,
): ApplyResult {
  const body = bodyText(render(source));
  const where = plan(body, anchor, replacement);
  if ("state" in where) return where;

  const words = squash(anchor.exact).trim().split(" ").map(escapeRegExp);
  // Words as written, any run of spaces between them, and at most one line break.
  const pattern = new RegExp(words.join("(?:[ \\t]+\\n?[ \\t]*|\\n[ \\t]*)"), "g");
  const places = [...source.matchAll(pattern)].slice(0, MAX_CANDIDATES + 1);
  if (places.length === 0) return { state: "refused", reason: "not-verbatim" };
  if (places.length > MAX_CANDIDATES) return { state: "refused", reason: "unplaced" };

  const made: { html: string; markdown: string }[] = [];
  for (const place of places) {
    const start = place.index ?? 0;
    const end = start + place[0].length;
    // A deletion takes the space it would leave doubled, as the rendered
    // widening does: the one after, else the one before. Tried before the
    // bare span, which would also read right once whitespace is collapsed and
    // so would leave the doubled space in the source for good.
    const spans: { start: number; end: number }[] = [];
    if (replacement === "") {
      if (source[end] === " " || source[end] === "\t") spans.push({ start, end: end + 1 });
      if (source[start - 1] === " " || source[start - 1] === "\t") spans.push({ start: start - 1, end });
    }
    spans.push({ start, end });
    const texts = replacement === "" ? [""] : [replacement, escapeMarkdown(replacement)];
    const kept = tryEach(spans, texts, (span, text) => {
      const markdown = source.slice(0, span.start) + text + source.slice(span.end);
      const html = render(markdown);
      return sameText(bodyText(html).text, where.expected) ? { html, markdown } : null;
    });
    if (kept) made.push(kept);
  }
  if (made.length === 0) return { state: "refused", reason: "not-verbatim" };
  if (made.length > 1) return { state: "refused", reason: "unplaced" };
  return { state: "applied", html: made[0].html, markdown: made[0].markdown };
}

function tryEach<T>(
  spans: { start: number; end: number }[],
  texts: string[],
  attempt: (span: { start: number; end: number }, text: string) => T | null,
): T | null {
  for (const text of texts) {
    for (const span of spans) {
      const result = attempt(span, text);
      if (result) return result;
    }
  }
  return null;
}
