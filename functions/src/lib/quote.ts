// SPDX-License-Identifier: Apache-2.0
// Finding an agent's quoted passage in a version, without a DOM (SPEC §19, §22).

import { ENTITY_CHARS, asciiLower, decodeEntity } from "./htmltext";

/**
 * An agent proposes an edit by quoting the passage as a reader sees it. The
 * browser will later find that quote with its strict resolver
 * (`app/src/annotation/exact.ts`) — exact text, whitespace normalised, context
 * choosing between repeats — so what this has to produce is an anchor that
 * resolver will resolve, and a definite refusal when it would not.
 *
 * `functions/` has no HTML parser, by budget, so this reads the body the way
 * a browser's `textContent` does as far as it matters here: tags gone,
 * entities decoded in text and nowhere else, whitespace collapsed. It splits
 * that text at every block and every non-text element, because a suggestion
 * lives inside one block (SPEC §22), and it takes its context from inside the
 * quote's own block only — the part of the text where this model and the
 * browser's agree most closely. Where they would disagree, the result is a
 * stale suggestion, never a misplaced one: the browser re-finds the quote
 * exactly or not at all. A shared fixture of golden cases, asserted on both
 * sides, keeps the two from drifting (`test/fixtures/quote-vectors.json`).
 */

/** Elements whose start or end separates text into different blocks. */
const BREAKS = new Set([
  "p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th", "tr", "dt", "dd",
  "blockquote", "pre", "figcaption", "caption", "summary", "legend", "label",
  "div", "section", "article", "aside", "main", "header", "footer", "nav", "body",
  "details", "figure", "form", "fieldset", "table", "thead", "tbody", "tfoot",
  "ul", "ol", "dl", "br", "hr", "img", "picture", "video", "audio", "iframe",
  "object", "embed", "canvas", "input", "select", "textarea", "button",
]);

/** Elements whose contents are not prose a suggestion could change. */
const SKIPPED = new Set(["script", "style", "svg", "math", "template", "noscript"]);

/** How much context either side of the quote is kept, at most. */
const CONTEXT = 32;

export type QuoteRefusal = "not-found" | "ambiguous" | "crosses-block";

export interface Located {
  anchor: { elementId: string; exact: string; prefix: string; suffix: string; start: number; end: number };
}

const squash = (s: string) => s.replace(/\s+/g, " ");

/** Where the body's content starts: after `<body>`, or after the head, or at 0. */
function bodyStart(html: string): number {
  const lower = asciiLower(html);
  const body = lower.search(/<body[\s>]/);
  if (body >= 0) return html.indexOf(">", body) + 1;
  const head = lower.indexOf("</head>");
  return head >= 0 ? head + 7 : 0;
}

/** Where a tag that starts at `lt` ends, quote-aware, or -1. */
function tagEnd(html: string, lt: number): number {
  let quote = "";
  for (let i = lt + 1; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

/**
 * The body's decoded text, one entry per UTF-16 unit, each with the source
 * bytes it came from and the run of text it belongs to.
 *
 * A run ends at every block boundary and every skipped element, so two
 * characters are in the same block exactly when their `run` is equal. An
 * entity's characters all point at the whole entity, so a span of decoded
 * text always maps back to whole source characters (SPEC §22).
 */
export interface ScannedText {
  chars: string[];
  /** Source offset of each character's first byte, in the whole document. */
  from: number[];
  /** Source offset just past each character's last byte. */
  to: number[];
  run: number[];
}

export function scanBody(html: string): ScannedText {
  const out: ScannedText = { chars: [], from: [], to: [], run: [] };
  let run = 0;
  const push = (ch: string, from: number, to: number) => {
    out.chars.push(ch);
    out.from.push(from);
    out.to.push(to);
    out.run.push(run);
  };
  // Decoded exactly as `decodeEntities` decodes, keeping where each part came from.
  const text = (from: number, to: number) => {
    const raw = html.slice(from, to);
    let pos = 0;
    let amp = raw.indexOf("&");
    let semi = -1;
    while (amp !== -1) {
      if (semi < amp) semi = raw.indexOf(";", amp + 1);
      if (semi === -1) break;
      const decoded = semi - amp - 1 <= ENTITY_CHARS ? decodeEntity(raw.slice(amp + 1, semi)) : null;
      if (decoded === null) {
        amp = raw.indexOf("&", amp + 1);
        continue;
      }
      for (let k = pos; k < amp; k++) push(raw[k], from + k, from + k + 1);
      for (let k = 0; k < decoded.length; k++) push(decoded[k], from + amp, from + semi + 1);
      pos = semi + 1;
      amp = raw.indexOf("&", pos);
    }
    for (let k = pos; k < raw.length; k++) push(raw[k], from + k, from + k + 1);
  };
  const lower = asciiLower(html);
  let i = bodyStart(html);
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      text(i, html.length);
      break;
    }
    text(i, lt);
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = tagEnd(html, lt);
    if (gt === -1) {
      // An unterminated `<` is text, as the tokenizer reads it.
      push("<", lt, lt + 1);
      i = lt + 1;
      continue;
    }
    const m = /^<\/?([a-z][a-z0-9-]*)/.exec(lower.slice(lt, Math.min(gt + 1, lt + 64)));
    const name = m?.[1] ?? "";
    const closing = lower[lt + 1] === "/";
    i = gt + 1;
    if (!closing && SKIPPED.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      i = close === -1 ? html.length : tagEnd(html, close) + 1 || html.length;
      run++;
      continue;
    }
    if (BREAKS.has(name)) run++;
  }
  return out;
}

/** The body's text as blocks: each a run of text no element boundary breaks. */
export function textBlocks(html: string): string[] {
  const { chars, run } = scanBody(html);
  const blocks: string[] = [];
  let current = "";
  let at = 0;
  for (let k = 0; k < chars.length; k++) {
    // Every boundary between two characters' runs closes one block per run
    // passed, as each element boundary did when the text was read.
    while (at < run[k]) {
      blocks.push(squash(current));
      current = "";
      at++;
    }
    current += chars[k];
  }
  blocks.push(squash(current));
  return blocks.filter((b) => b.trim() !== "");
}

/** Every index at which `needle` starts in `hay`. */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * Find a quoted passage in a version's HTML: the one place it stands, inside
 * one block, chosen by the given context where it repeats.
 */
export function locateQuote(
  html: string,
  q: { exact: string; prefix?: string; suffix?: string },
): Located | { error: QuoteRefusal; count?: number } {
  const exact = squash(q.exact).trim();
  if (!exact) return { error: "not-found" };
  const blocks = textBlocks(html);

  const candidates = blocks.flatMap((block) => occurrences(block, exact).map((at) => ({ block, at })));
  if (candidates.length === 0) {
    const across = [squash(blocks.join(" ")), squash(blocks.join(""))];
    return { error: across.some((t) => t.includes(exact)) ? "crosses-block" : "not-found" };
  }

  // Choose between repeats exactly as the browser will: both sides of context,
  // else one side, else no choice at all.
  const prefix = squash(q.prefix ?? "").trimEnd();
  const suffix = squash(q.suffix ?? "").trimStart();
  const scored = candidates.map((c) => {
    const before = c.block.slice(0, c.at).trimEnd();
    const after = c.block.slice(c.at + exact.length).trimStart();
    return { ...c, pre: prefix === "" || before.endsWith(prefix), suf: suffix === "" || after.startsWith(suffix) };
  });
  const both = scored.filter((c) => c.pre && c.suf);
  const either = scored.filter((c) => c.pre || c.suf);
  const pick = both.length === 1 ? both[0] : both.length === 0 && either.length === 1 ? either[0] : null;
  if (!pick) return { error: "ambiguous", count: candidates.length };

  const end = pick.at + exact.length;
  return {
    anchor: {
      // Measured against the body, which is where the browser looks for an
      // anchor with no element id.
      elementId: "",
      exact,
      prefix: pick.block.slice(Math.max(0, pick.at - CONTEXT), pick.at),
      suffix: pick.block.slice(end, end + CONTEXT),
      // Offsets are what a comment's highlight falls back to; a suggestion is
      // only ever found by its quote, so these are a block-local hint at most.
      start: pick.at,
      end,
    },
  };
}
