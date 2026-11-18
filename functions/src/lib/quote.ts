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
 * It loads no HTML parser — the one inside turndown builds a whole tree, and
 * this runs on every agent's quote — so this reads the body the way
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

/**
 * Elements whose text a stylesheet often lays out apart, though nothing in the
 * text separates them. The Markdown reading puts a space where one of these
 * touches another (`lib/markdown/reading.ts`, ADR 0032), so a quote copied
 * from it may carry that space; the page's text does not.
 */
const TOUCHING = new Set(["span", "a"]);

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
  /**
   * True where only tags stand between this character and the one before it,
   * and among them a span or link closes and another opens: the place the
   * reading may have put a space the text does not have.
   */
  touch: boolean[];
}

export function scanBody(html: string): ScannedText {
  const out: ScannedText = { chars: [], from: [], to: [], run: [], touch: [] };
  let run = 0;
  // Since the last character: did a span or link close, and did one open after it?
  let closed = false;
  let touching = false;
  const push = (ch: string, from: number, to: number) => {
    out.chars.push(ch);
    out.from.push(from);
    out.to.push(to);
    out.run.push(run);
    out.touch.push(touching);
    closed = false;
    touching = false;
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
    if (TOUCHING.has(name)) {
      if (closing) closed = true;
      else if (closed) touching = true;
    }
  }
  return out;
}

/** One block's text, whitespace squashed, with where a span or link touches another. */
interface Block {
  text: string;
  /** `touch[i]`: a touching boundary stands just before `text[i]`. */
  touch: boolean[];
}

/** Squash a block exactly as `squash` does, keeping each character's touch mark. */
function squashBlock(chars: string[], touch: boolean[]): Block {
  const parts: string[] = [];
  const marks: boolean[] = [];
  let spacing = false;
  for (let i = 0; i < chars.length; i++) {
    if (/\s/.test(chars[i])) {
      if (!spacing) {
        parts.push(" ");
        marks.push(false);
        spacing = true;
      }
      continue;
    }
    spacing = false;
    parts.push(chars[i]);
    marks.push(touch[i]);
  }
  return { text: parts.join(""), touch: marks };
}

function blocksOf(html: string): Block[] {
  const { chars, run, touch } = scanBody(html);
  const blocks: Block[] = [];
  let current: string[] = [];
  let marks: boolean[] = [];
  let at = 0;
  for (let k = 0; k < chars.length; k++) {
    // Every boundary between two characters' runs closes one block per run
    // passed, as each element boundary did when the text was read.
    while (at < run[k]) {
      blocks.push(squashBlock(current, marks));
      current = [];
      marks = [];
      at++;
    }
    current.push(chars[k]);
    marks.push(touch[k]);
  }
  blocks.push(squashBlock(current, marks));
  return blocks.filter((b) => b.text.trim() !== "");
}

/** The body's text as blocks: each a run of text no element boundary breaks. */
export function textBlocks(html: string): string[] {
  return blocksOf(html).map((b) => b.text);
}

/**
 * A block as the reading may print it: a space at every touching boundary with
 * no whitespace either side. `pos[i]` is where the block's `text[i]` landed,
 * and `from[j]` the block index each printed character stands for. Null when
 * the block has no such boundary, which is most of them.
 */
interface Spaced {
  text: string;
  pos: number[];
  from: number[];
}

function spaced(block: Block): Spaced | null {
  const { text, touch } = block;
  const parts: string[] = [];
  const pos: number[] = [];
  const from: number[] = [];
  let any = false;
  for (let i = 0; i < text.length; i++) {
    if (i > 0 && touch[i] && text[i] !== " " && text[i - 1] !== " ") {
      parts.push(" ");
      from.push(i);
      any = true;
    }
    pos.push(parts.length);
    parts.push(text[i]);
    from.push(i);
  }
  return any ? { text: parts.join(""), pos, from } : null;
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
  const blocks = blocksOf(html).map((block) => ({ block, spaced: spaced(block) }));

  // A place is a stretch of one block's own text. A quote copied from the
  // reading may carry a space where two elements touch, so each block is
  // searched as written and as the reading prints it, and a place found both
  // ways is one place (ADR 0032).
  const candidates: { block: Block; spaced: Spaced | null; start: number; end: number }[] = [];
  for (const { block, spaced: s } of blocks) {
    const seen = new Set<number>();
    const add = (start: number, end: number) => {
      if (seen.has(start * 4_294_967_296 + end)) return;
      seen.add(start * 4_294_967_296 + end);
      candidates.push({ block, spaced: s, start, end });
    };
    for (const at of occurrences(block.text, exact)) add(at, at + exact.length);
    // The quote is trimmed, so it starts and ends on characters of the text, never on an added space.
    if (s) for (const at of occurrences(s.text, exact)) add(s.from[at], s.from[at + exact.length - 1] + 1);
  }
  if (candidates.length === 0) {
    const texts = blocks.map((b) => b.block.text);
    const printed = blocks.map((b) => b.spaced?.text ?? b.block.text);
    const across = [squash(texts.join(" ")), squash(texts.join("")), squash(printed.join(" "))];
    return { error: across.some((t) => t.includes(exact)) ? "crosses-block" : "not-found" };
  }

  // Choose between repeats exactly as the browser will: both sides of context,
  // else one side, else no choice at all. Context copied from the reading may
  // carry the same spaces the quote may.
  const prefix = squash(q.prefix ?? "").trimEnd();
  const suffix = squash(q.suffix ?? "").trimStart();
  const scored = candidates.map((c) => {
    const { text } = c.block;
    const before = [text.slice(0, c.start).trimEnd()];
    const after = [text.slice(c.end).trimStart()];
    if (c.spaced) {
      before.push(c.spaced.text.slice(0, c.spaced.pos[c.start]).trimEnd());
      after.push(c.spaced.text.slice(c.end < text.length ? c.spaced.pos[c.end] : c.spaced.text.length).trimStart());
    }
    return {
      ...c,
      pre: prefix === "" || before.some((b) => b.endsWith(prefix)),
      suf: suffix === "" || after.some((a) => a.startsWith(suffix)),
    };
  });
  const both = scored.filter((c) => c.pre && c.suf);
  const either = scored.filter((c) => c.pre || c.suf);
  const pick = both.length === 1 ? both[0] : both.length === 0 && either.length === 1 ? either[0] : null;
  if (!pick) return { error: "ambiguous", count: candidates.length };

  const text = pick.block.text;
  return {
    anchor: {
      // Measured against the body, which is where the browser looks for an
      // anchor with no element id. The page's own text, never the quote as
      // sent: the browser finds exactly this.
      elementId: "",
      exact: text.slice(pick.start, pick.end),
      prefix: text.slice(Math.max(0, pick.start - CONTEXT), pick.start),
      suffix: text.slice(pick.end, pick.end + CONTEXT),
      // Offsets are what a comment's highlight falls back to; a suggestion is
      // only ever found by its quote, so these are a block-local hint at most.
      start: pick.start,
      end: pick.end,
    },
  };
}
