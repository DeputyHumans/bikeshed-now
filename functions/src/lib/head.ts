// SPDX-License-Identifier: Apache-2.0
// What a document's own <head> and first words say about it (SPEC §17).

import { asciiLower, collapseWhitespace, decodeEntities } from "./htmltext";

/**
 * Shared links unfurl with the uploaded document's own title, description,
 * keywords and image, and its <title> becomes the default workspace title.
 * This module reads those out of the raw HTML of an untrusted upload, at
 * request time, without an HTML parser: there is none in `functions/` and the
 * dependency budget does not admit one.
 *
 * The scanner is `indexOf`-driven and linear on adversarial input. Every
 * opener is found with `indexOf`, its terminator with `indexOf` from there,
 * and no character is scanned twice for the same purpose: each character that
 * can end something (`>`, `"`, `'`) is indexed lazily in one forward pass,
 * whether a quote opens an attribute value is decided once per quote, and the
 * walk that finds a tag's end is memoised at every position it passes, so
 * that openers nested inside a tag that never closes cost nothing after the
 * first. A tag with no `>` within TAG_CHARS is not a tag; the `<` is skipped.
 * An element that hides its contents (`<script>` and friends, or a comment)
 * with no closer consumes the rest of the input. The only regex is a bounded
 * one over a single already-isolated tag (at most TAG_CHARS long), for its
 * attributes.
 *
 * Two passes, over an input first cut to HEAD_SCAN_BYTES characters:
 *
 *  1. A pre-strip drops, case-insensitively, `<!-- … -->`, `<script>`,
 *     `<style>`, `<svg>`, `<template>` and `<nav>` with their contents, each
 *     replaced by one space. It walks tags in document order, so an element
 *     name inside an attribute value does not open an element. This is what
 *     keeps an inline SVG's accessible `<title>` (the tour sample has six) or a
 *     commented-out `<title>` from becoming the document's title, and a table
 *     of contents from becoming its description.
 *  2. The head region (before the first `<body`, at most HEAD_REGION_CHARS)
 *     gives the declared values; the body region gives the excerpt and the
 *     `<img>` fallback.
 *
 * Not supported, by design: CDATA sections (their contents are scanned as
 * markup) and `<template>` inside `<head>` (it is dropped whole like any other
 * template, so nothing it declares is read).
 */

export interface DocHead {
  title: string | null;
  description: string | null;
  keywords: string | null;
  image: string | null;
}

/** Characters of input that are scanned; what lies past this is not described. */
export const HEAD_SCAN_BYTES = 256 * 1024;

/** The head region ends at the first `<body` or here, whichever comes first. */
const HEAD_REGION_CHARS = 64 * 1024;

/** A `<` with no `>` this close is a stray character, not a tag. */
const TAG_CHARS = 4096;

/** The excerpt is this many characters, cut back to a word, plus an ellipsis. */
const EXCERPT_CHARS = 200;

const CAP = { title: 200, description: 300, keywords: 500, image: 2048 } as const;

/** Elements whose contents are never part of what a document says about itself. */
const HIDDEN = ["script", "style", "svg", "template", "nav"];

const RASTER_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

/**
 * Elements that sit inside a word or a phrase. Every other tag, opening or
 * closing, separates the text on either side of it in the excerpt, so a
 * minified `<p>First.</p><p>Second.</p>` reads "First. Second." and a `<br>`
 * is a space — while `un<em>believable</em>` stays one word.
 */
const INLINE = new Set([
  "a", "b", "i", "em", "strong", "span", "code", "sub", "sup", "small", "mark",
  "abbr", "q", "s", "u", "time", "cite", "kbd", "var", "dfn",
]);

/** Attributes of one isolated tag: name, then a double-, single- or unquoted value. */
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function readHead(html: string): DocHead {
  const raw = html.length > HEAD_SCAN_BYTES ? html.slice(0, HEAD_SCAN_BYTES) : html;
  const { text, lower } = stripHidden(raw, asciiLower(raw));

  const bodyAt = firstTag(lower, "body", 0);
  const headEnd = Math.min(bodyAt === -1 ? text.length : bodyAt, HEAD_REGION_CHARS);
  const declared = scanHead(text.slice(0, headEnd), lower.slice(0, headEnd));

  const title = declared.title ?? declared.ogTitle;
  const keywords = declared.keywords;
  let description = declared.description ?? declared.ogDescription;
  let image = declared.ogImage ?? declared.twitterImage;

  if (description === null || image === null) {
    const bodyFrom = bodyAt === -1 ? afterHead(lower) : bodyAt;
    const body = scanBody(text.slice(bodyFrom), lower.slice(bodyFrom), {
      excerpt: description === null,
      image: image === null,
    });
    description ??= body.excerpt;
    image ??= body.image;
  }

  return { title, description, keywords, image };
}

export function titleFromHtml(html: string): string | null {
  return readHead(html).title;
}

/**
 * Where the body begins in a document with no `<body` tag: after `</head>`,
 * else after `</title>`, else at the start. Without this the title's own text
 * would lead the excerpt, and so the description.
 */
function afterHead(lower: string): number {
  return closerAt(lower, "head", 0)?.end ?? closerAt(lower, "title", 0)?.end ?? 0;
}

/* ------------------------------------------------------------------------ */
/* The two scans                                                             */

interface Declared {
  title: string | null;
  ogTitle: string | null;
  description: string | null;
  ogDescription: string | null;
  keywords: string | null;
  ogImage: string | null;
  twitterImage: string | null;
}

/** Which `<meta>` goes where, keyed by the attribute that names it. */
const META_BY_NAME = new Map<string, keyof Declared>([
  ["description", "description"],
  ["keywords", "keywords"],
  ["twitter:image", "twitterImage"],
]);
const META_BY_PROPERTY = new Map<string, keyof Declared>([
  ["og:title", "ogTitle"],
  ["og:description", "ogDescription"],
  ["og:image", "ogImage"],
  ["twitter:image", "twitterImage"],
]);
const CAP_OF: Record<keyof Declared, number> = {
  title: CAP.title,
  ogTitle: CAP.title,
  description: CAP.description,
  ogDescription: CAP.description,
  keywords: CAP.keywords,
  ogImage: CAP.image,
  twitterImage: CAP.image,
};

function scanHead(text: string, lower: string): Declared {
  const found: Declared = {
    title: null,
    ogTitle: null,
    description: null,
    ogDescription: null,
    keywords: null,
    ogImage: null,
    twitterImage: null,
  };
  const tags = new TagEnds(text);
  let i = 0;
  for (;;) {
    const lt = nextTagStart(lower, i);
    if (lt === -1) break;
    const gt = tags.end(lt);
    if (gt === -1) {
      i = lt + 1;
      continue;
    }
    if (tagIs(lower, lt, "title")) {
      // RCDATA: nothing until </title> is a tag. Without a closer the rest of
      // the head is title text in a browser, which is not a title to trust.
      const closer = closerAt(lower, "title", gt + 1);
      if (closer === null) break;
      found.title ??= tidy(decodeEntities(text.slice(gt + 1, closer.at)), CAP.title);
      i = closer.end;
      continue;
    }
    if (tagIs(lower, lt, "meta")) {
      const attrs = attributes(text.slice(lt + "<meta".length, gt));
      const name = attrs.get("name");
      const property = attrs.get("property");
      const key =
        (name !== undefined ? META_BY_NAME.get(name.toLowerCase()) : undefined) ??
        (property !== undefined ? META_BY_PROPERTY.get(property.toLowerCase()) : undefined);
      const content = attrs.get("content");
      if (key !== undefined && found[key] === null && content !== undefined) {
        found[key] = tidy(content, CAP_OF[key]);
      }
    }
    i = gt + 1;
  }
  return found;
}

interface BodyWants {
  excerpt: boolean;
  image: boolean;
}

/**
 * The excerpt starts after the first `</h1>` when there is one, else after the
 * `<body>` tag; the image is the first raster `<img>` anywhere in the body.
 * One walk serves both, and stops as soon as it has what was asked for.
 */
function scanBody(text: string, lower: string, wants: BodyWants): { excerpt: string | null; image: string | null } {
  const h1 = closerAt(lower, "h1", 0);
  let textFrom = h1 !== null ? h1.end : tagIs(lower, 0, "body") ? -1 : 0;
  let wantExcerpt = wants.excerpt;
  let wantImage = wants.image;
  const excerpt = new Excerpt();
  let image: string | null = null;

  const tags = new TagEnds(text);
  let i = 0;
  let runFrom = 0;
  while (wantExcerpt || wantImage) {
    const lt = nextTagStart(lower, i);
    if (lt === -1) {
      if (wantExcerpt && textFrom !== -1) excerpt.add(text.slice(Math.max(runFrom, textFrom)));
      break;
    }
    const gt = tags.end(lt);
    if (gt === -1) {
      i = lt + 1;
      continue;
    }
    if (wantExcerpt && textFrom !== -1 && lt > textFrom) {
      if (excerpt.add(text.slice(Math.max(runFrom, textFrom), lt))) wantExcerpt = false;
    }
    if (textFrom === -1 && tagIs(lower, lt, "body")) textFrom = gt + 1;
    else if (wantExcerpt && textFrom !== -1 && lt >= textFrom && !INLINE.has(tagName(lower, lt))) {
      // A block boundary is whitespace, whether or not the author wrote any.
      if (excerpt.add(" ")) wantExcerpt = false;
    }
    if (wantImage && tagIs(lower, lt, "img")) {
      // Returned as written, less the ends: a URL's insides are the author's.
      const src = attributes(text.slice(lt + "<img".length, gt)).get("src")?.trim();
      if (src !== undefined && isRaster(src)) {
        image = capped(src, CAP.image);
        wantImage = false;
      }
    }
    i = runFrom = gt + 1;
  }
  return { excerpt: wants.excerpt ? excerpt.text() : null, image };
}

/** The first words of a body: raw text runs in, one cut sentence out. */
class Excerpt {
  private readonly runs: string[] = [];
  private rawLength = 0;
  private checkAt = 512;
  private cached: string | null = null;

  /** Adds a run of text between tags; true once there is enough for the excerpt. */
  add(run: string): boolean {
    this.runs.push(run);
    this.rawLength += run.length;
    this.cached = null;
    if (this.rawLength < this.checkAt) return false;
    // Tidying shrinks (entities, whitespace), so how much raw text yields
    // EXCERPT_CHARS is unknown; checking at doubling thresholds keeps the total
    // work linear in the text consumed.
    this.checkAt *= 2;
    return this.collapsed().length > EXCERPT_CHARS;
  }

  text(): string | null {
    const full = this.collapsed();
    if (full.length === 0) return null;
    if (full.length <= EXCERPT_CHARS) return full;
    let cut = cutAt(full, EXCERPT_CHARS);
    if (full.charCodeAt(EXCERPT_CHARS) !== 0x20) {
      const boundary = cut.lastIndexOf(" ");
      if (boundary > 0) cut = cut.slice(0, boundary);
    }
    return `${cut.trimEnd()}\u2026`;
  }

  private collapsed(): string {
    if (this.cached === null) {
      const joined = this.runs.join("");
      this.runs.length = 0;
      this.runs.push(joined);
      this.cached = collapseWhitespace(decodeEntities(joined));
    }
    return this.cached;
  }
}

/** Whether a `src`, less any query or fragment, names a raster image. */
function isRaster(src: string): boolean {
  let end = src.length;
  const query = src.indexOf("?");
  if (query !== -1) end = query;
  const fragment = src.indexOf("#");
  if (fragment !== -1 && fragment < end) end = fragment;
  const path = src.slice(0, end).toLowerCase();
  return RASTER_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/* ------------------------------------------------------------------------ */
/* The pre-strip                                                             */

/**
 * Removes comments and hidden elements, each replaced by one space, and
 * returns the stripped text with its index-aligned lowercase twin.
 */
function stripHidden(text: string, lower: string): { text: string; lower: string } {
  const kept: string[] = [];
  const keptLower: string[] = [];
  const tags = new TagEnds(text);
  let from = 0;
  let i = 0;
  for (;;) {
    const lt = nextTagStart(lower, i);
    if (lt === -1) break;
    let end: number;
    if (lower.startsWith("<!--", lt)) {
      // From lt + 2 so that `<!-->` and `<!--->` close at once, as in a browser.
      const close = lower.indexOf("-->", lt + 2);
      end = close === -1 ? lower.length : close + 3;
    } else {
      const name = HIDDEN.find((candidate) => tagIs(lower, lt, candidate));
      if (name === undefined) {
        const gt = tags.end(lt);
        i = gt === -1 ? lt + 1 : gt + 1;
        continue;
      }
      const closer = closerAt(lower, name, lt + 1 + name.length);
      end = closer === null ? lower.length : closer.end;
    }
    kept.push(text.slice(from, lt), " ");
    keptLower.push(lower.slice(from, lt), " ");
    from = i = end;
  }
  kept.push(text.slice(from));
  keptLower.push(lower.slice(from));
  return { text: kept.join(""), lower: keptLower.join("") };
}

/* ------------------------------------------------------------------------ */
/* Tags                                                                      */

/** The next `<` that a browser would start a tag at: followed by a letter, `/`, `!` or `?`. */
function nextTagStart(lower: string, from: number): number {
  let i = from;
  for (;;) {
    const lt = lower.indexOf("<", i);
    if (lt === -1 || lt + 1 >= lower.length) return -1;
    const c = lower.charCodeAt(lt + 1);
    if ((c >= 0x61 && c <= 0x7a) || c === 0x2f || c === 0x21 || c === 0x3f) return lt;
    i = lt + 1;
  }
}

/** The name of the tag at `lt`, opening or closing, lowercase; empty for `<!…>` and `<?…>`. */
function tagName(lower: string, lt: number): string {
  let from = lt + 1;
  if (lower.charCodeAt(from) === 0x2f) from++;
  let to = from;
  while (to < lower.length) {
    const c = lower.charCodeAt(to);
    if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39))) break;
    to++;
  }
  return lower.slice(from, to);
}

/** Whether the tag opening at `lt` is `<name`, with the name ending there (`<nav` is not `<navbar`). */
function tagIs(lower: string, lt: number, name: string): boolean {
  return lower.startsWith(name, lt + 1) && isNameEnd(lower, lt + 1 + name.length);
}

/** The first `<name` tag start at or after `from`, or -1. */
function firstTag(lower: string, name: string, from: number): number {
  let i = from;
  for (;;) {
    const lt = lower.indexOf(`<${name}`, i);
    if (lt === -1) return -1;
    if (isNameEnd(lower, lt + 1 + name.length)) return lt;
    i = lt + 1;
  }
}

/** The first `</name …>` at or after `from`: where it starts and where it ends. */
function closerAt(lower: string, name: string, from: number): { at: number; end: number } | null {
  const closer = `</${name}`;
  let i = from;
  for (;;) {
    const at = lower.indexOf(closer, i);
    if (at === -1) return null;
    const after = at + closer.length;
    if (isNameEnd(lower, after)) {
      const gt = lower.indexOf(">", after);
      return { at, end: gt === -1 ? lower.length : gt + 1 };
    }
    i = after;
  }
}

function isNameEnd(text: string, at: number): boolean {
  if (at >= text.length) return false;
  const c = text.charCodeAt(at);
  return c === 0x3e || c === 0x2f || isHtmlSpace(c);
}

/** HTML's own whitespace: space, tab, LF, FF, CR. */
function isHtmlSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
}

/**
 * Where tags end. `end(lt)` is the first `>` after `lt` that is not inside a
 * quoted attribute value, or -1 when there is none within TAG_CHARS.
 *
 * A quote opens a value only after `=`; a stray quote in an attribute name is
 * a character like any other, as in a browser. The walk from a position to
 * its `>` hops from one closing quote to the next, and its result is memoised
 * at every position it passes, so the openers inside one unterminated tag
 * share a single walk instead of each repeating it. Whether a quote opens a
 * value is read off the whitespace behind it, and that too is remembered per
 * quote: every opener before the same quote asks the same question.
 */
class TagEnds {
  private readonly gt: CharIndex;
  private readonly dq: CharIndex;
  private readonly sq: CharIndex;
  /** The `>` reached from each position a walk has passed, or -1. */
  private readonly memo = new Map<number, number>();
  /** Whether each quote already looked at opens an attribute value. */
  private readonly valueQuotes = new Map<number, boolean>();

  constructor(private readonly text: string) {
    this.gt = new CharIndex(text, ">");
    this.dq = new CharIndex(text, '"');
    this.sq = new CharIndex(text, "'");
  }

  end(lt: number): number {
    const at = this.unquotedGt(lt + 1);
    return at === -1 || at - lt > TAG_CHARS ? -1 : at;
  }

  private unquotedGt(start: number): number {
    const path: number[] = [];
    let p = start;
    let result: number;
    for (;;) {
      const known = this.memo.get(p);
      if (known !== undefined) {
        result = known;
        break;
      }
      path.push(p);
      const gt = this.gt.next(p);
      if (gt === -1) {
        result = -1;
        break;
      }
      const dq = this.dq.next(p);
      const sq = this.sq.next(p);
      let quote = -1;
      let index = this.dq;
      if (dq !== -1 && dq < gt) quote = dq;
      if (sq !== -1 && sq < gt && (quote === -1 || sq < quote)) {
        quote = sq;
        index = this.sq;
      }
      if (quote === -1) {
        result = gt;
        break;
      }
      if (!this.opensValue(quote)) {
        p = quote + 1;
        continue;
      }
      const close = index.next(quote + 1);
      if (close === -1) {
        result = -1;
        break;
      }
      p = close + 1;
    }
    for (const at of path) this.memo.set(at, result);
    return result;
  }

  /**
   * Whether the quote at `at` follows `=` and optional whitespace. The walk
   * back over that whitespace is done once per quote: walks from different
   * quotes never overlap, so together they cost one pass over the text.
   */
  private opensValue(at: number): boolean {
    const known = this.valueQuotes.get(at);
    if (known !== undefined) return known;
    let i = at - 1;
    while (i >= 0 && isHtmlSpace(this.text.charCodeAt(i))) i--;
    const opens = i >= 0 && this.text.charCodeAt(i) === 0x3d;
    this.valueQuotes.set(at, opens);
    return opens;
  }
}

/**
 * Every position of one character in a string, discovered lazily: `next(from)`
 * answers from what one forward pass has found so far and extends that pass
 * only when it must, so all the queries together cost one scan of the text.
 */
class CharIndex {
  private readonly found: number[] = [];
  /** Everything before here has been scanned. */
  private frontier = 0;

  constructor(
    private readonly text: string,
    private readonly ch: string,
  ) {}

  /** The first occurrence at or after `from`, or -1. */
  next(from: number): number {
    const found = this.found;
    if (from < this.frontier) {
      let lo = 0;
      let hi = found.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (found[mid] < from) lo = mid + 1;
        else hi = mid;
      }
      if (lo < found.length) return found[lo];
    }
    while (this.frontier < this.text.length) {
      const at = this.text.indexOf(this.ch, this.frontier);
      if (at === -1) {
        this.frontier = this.text.length;
        return -1;
      }
      found.push(at);
      this.frontier = at + 1;
      if (at >= from) return at;
    }
    return -1;
  }
}

/**
 * The attributes of one isolated tag interior, names lowercased, first value
 * winning. Values are entity-decoded here and nowhere else, as a browser
 * decodes them once in the tokenizer: `&amp;amp;` reads as `&amp;`.
 */
function attributes(interior: string): Map<string, string> {
  const out = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  for (let m = ATTRIBUTE.exec(interior); m !== null; m = ATTRIBUTE.exec(interior)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Text                                                                      */

/** Whitespace-collapsed, trimmed and capped; null when nothing is left. Decoding is the caller's. */
function tidy(text: string, cap: number): string | null {
  const collapsed = collapseWhitespace(text);
  return collapsed.length === 0 ? null : capped(collapsed, cap);
}

/** At most `n` code units, without a trailing space the cut would leave. */
function capped(text: string, n: number): string {
  return text.length > n ? cutAt(text, n).trimEnd() : text;
}

/** The first `n` code units, less a high surrogate that would be left without its pair. */
function cutAt(text: string, n: number): string {
  const last = text.charCodeAt(n - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}
