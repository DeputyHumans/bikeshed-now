// SPDX-License-Identifier: Apache-2.0
// The Markdown an agent reads in place of an HTML document's source, and the preamble that says so (SPEC §19, ADR 0030).

import TurndownService from "turndown";

/**
 * Why this exists
 * ---------------
 * An agent that reads an HTML document wants its words. The source is the
 * page as authored: stylesheets, scripts, inline SVG and base64 images, which
 * fill an agent's context and say nothing to it. So `get_document`, `bikeshed
 * get` and `/d/<id>.md` hand an agent this reading instead, made from the
 * stored entry. It is a VIEW, like the crawler text a document's shell
 * carries (ADR 0028): never hashed, so changing these rules mints no version
 * of anything. `stored.ts` keeps each version's reading once made, named by
 * a fingerprint of this file among the rest, so a change here is never
 * served an old one (ADR 0033).
 *
 * Two rules the rest of this file serves
 * --------------------------------------
 * 1. **An agent always knows it is reading an adjustment.** Every reading opens
 *    with a preamble saying so, what was left out, and where the original is
 *    (`readingPreamble`). A reading must never be mistaken for the source and
 *    sent back as an update.
 * 2. **No HTML reaches the output, and no escaping either.** Anything Markdown
 *    cannot say becomes its text or a bracketed placeholder. Text is left
 *    unescaped, so the words match the text a comment is anchored against
 *    (`lib/quote.ts`): a quote of words copied from a reading is found.
 *
 * This is not the round-trip converter. `serialize.ts` turns an edited Markdown
 * document back into its source and must lose nothing, so it keeps every
 * element it did not generate verbatim. This one is for reading and keeps
 * nothing verbatim. The two share the library, never a configuration.
 *
 * It is not a defence against prompt injection either: text a stylesheet class
 * hides still appears, because no CSS is evaluated here.
 */

/** Characters parsed after the strip. Past it, the prefix is read and the reading says it stops early. */
export const READ_PARSE_CHARS = 2_000_000;

/** What a reading leaves out, counted so the preamble can say how much. */
export interface LeftOut {
  scripts: number;
  stylesheets: number;
  /** Pictures drawn in code: SVG, canvas, MathML. Each leaves a `[figure: …]` behind. */
  figures: number;
  /** Frames and objects: `iframe`, `object`, `embed`. Each leaves an `[embedded: …]` link. */
  embeds: number;
  /** Images held inside the page as `data:` or `blob:` addresses. Each leaves an `[image: …]`. */
  inlineImages: number;
  hidden: number;
  formControls: number;
}

/** Where the reading's addresses point: the version the entry belongs to. */
export interface ReadingContext {
  /** The deployment's origin, or "" when none is configured: addresses are then paths. */
  origin: string;
  docId: string;
  versionId: string;
  /** The HTML entry's path inside the version. */
  entry: string;
  /** The key that opened the document, carried on the version's own addresses; null for a member's or a public read. */
  k: string | null;
}

export interface Reading {
  /** The converted body, without the preamble. */
  body: string;
  leftOut: LeftOut;
  warnings: string[];
  /** The input was longer than `READ_PARSE_CHARS` after the strip, so the body stops early. */
  cut: boolean;
}

/** Said when a page writes its own content with a script, which a reading cannot run. */
export const BUILT_BY_SCRIPT =
  "This page builds its content with a script, so this reading may be missing most of it. Read the original.";
/** Said when the page was too long to read whole. */
export const STOPS_EARLY =
  "The page is too long to read whole, so this reading stops before its end. The original continues.";

/** Fewer letters and digits than this, from a page that has a script, reads as a page the script fills. */
const SCRIPT_BUILT_BELOW = 200;

function noneLeftOut(): LeftOut {
  return { scripts: 0, stylesheets: 0, figures: 0, embeds: 0, inlineImages: 0, hidden: 0, formControls: 0 };
}

/* ------------------------------------------------------------------------ */
/* The strip                                                                 */

const NAME_CHAR = /[A-Za-z0-9-]/;

/** The lowercased tag name starting at `at`, or "" when no element starts there. */
function tagNameAt(html: string, at: number): string {
  let end = at;
  if (!/[A-Za-z]/.test(html[at] ?? "")) return "";
  while (end < html.length && NAME_CHAR.test(html[end])) end++;
  return html.slice(at, end).toLowerCase();
}

/** The next `</name` from `from`, compared without case and without lowercasing the whole input. */
function closeTagAt(html: string, name: string, from: number): number {
  let at = from;
  for (;;) {
    const found = html.indexOf("</", at);
    if (found === -1) return -1;
    const candidate = html.slice(found + 2, found + 2 + name.length).toLowerCase();
    if (candidate === name && !NAME_CHAR.test(html[found + 2 + name.length] ?? "")) return found;
    at = found + 2;
  }
}

/** True when an attribute value is a `data:` or `blob:` address, ignoring leading whitespace. */
function inlineAddress(value: string): "data:" | "blob:" | null {
  const head = value.slice(0, 40).trimStart().slice(0, 5).toLowerCase();
  return head === "data:" || head === "blob:" ? head : null;
}

/**
 * Copy one opening tag from `lt`, emptying every `data:`/`blob:` attribute
 * value down to its scheme. Returns the copied text and where the tag ended,
 * or null when it never closes. Linear: every character is looked at once.
 */
function copyTag(html: string, lt: number, nameEnd: number): { text: string; end: number } | null {
  const parts: string[] = [html.slice(lt, nameEnd)];
  let i = nameEnd;
  const n = html.length;
  while (i < n) {
    const c = html[i];
    if (c === ">") {
      parts.push(">");
      return { text: parts.join(""), end: i + 1 };
    }
    if (c === "=") {
      parts.push("=");
      i++;
      while (i < n && /\s/.test(html[i])) parts.push(html[i++]);
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        if (close === -1) return null;
        const value = html.slice(i + 1, close);
        const scheme = inlineAddress(value);
        parts.push(q, scheme ?? value, q);
        i = close + 1;
      } else {
        let end = i;
        while (end < n && !/[\s>]/.test(html[end])) end++;
        const value = html.slice(i, end);
        parts.push(inlineAddress(value) ?? value);
        i = end;
      }
      continue;
    }
    parts.push(c);
    i++;
  }
  return null;
}

/**
 * Remove scripts, stylesheets and comments, and empty every `data:` address,
 * BEFORE anything is parsed: a page can be 25 MiB of base64 and a parser would
 * build every byte of it into the tree. An indexOf scanner rather than regular
 * expressions, so hostile input costs linear time.
 */
export function stripForReading(html: string, leftOut: LeftOut): string {
  const parts: string[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      parts.push(html.slice(i));
      break;
    }
    parts.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const name = tagNameAt(html, lt + 1);
    if (name === "") {
      parts.push("<");
      i = lt + 1;
      continue;
    }
    if (name === "script" || name === "style") {
      if (name === "script") leftOut.scripts++;
      else leftOut.stylesheets++;
      const close = closeTagAt(html, name, lt + 1 + name.length);
      if (close === -1) {
        i = n;
        continue;
      }
      const gt = html.indexOf(">", close);
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    const tag = copyTag(html, lt, lt + 1 + name.length);
    if (tag === null) {
      parts.push(html.slice(lt));
      break;
    }
    if (name === "link" && /\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag.text)) leftOut.stylesheets++;
    parts.push(tag.text);
    i = tag.end;
  }
  return parts.join("");
}

/* ------------------------------------------------------------------------ */
/* Addresses                                                                 */

/** Stands in for an unconfigured origin while parsing, and is never emitted. */
const PARSE_ORIGIN = "https://origin.invalid";

/** The version's own address for one of its files, with the key in the path when one opened it. */
export function contentAddress(ctx: ReadingContext, rel: string): string {
  const key = ctx.k ? `~${encodeURIComponent(ctx.k)}/` : "";
  return `${ctx.origin}/content/${key}${ctx.docId}/${ctx.versionId}/${rel}`;
}

/** Where a person opens the document: the reader page, pinned when asked, with `?k=` when keyed. */
export function readerAddress(origin: string, docId: string, version: string | null, k: string | null): string {
  return `${origin}/d/${docId}${version ? `/${encodeURIComponent(version)}` : ""}${k ? `?k=${encodeURIComponent(k)}` : ""}`;
}

/**
 * An attribute's address, absolute, or null when the reading keeps only the
 * text. Resolved against the entry's own address, as a browser would; a
 * fragment alone says nothing outside the page. Only http(s) and mailto
 * survive: any other scheme is a script or a local file to an agent.
 */
export function resolveAddress(raw: string | null | undefined, ctx: ReadingContext): string | null {
  const ref = (raw ?? "").trim();
  if (!ref || ref.startsWith("#")) return null;
  const origin = ctx.origin || PARSE_ORIGIN;
  let u: URL;
  try {
    u = new URL(ref, `${origin}/content/${ctx.docId}/${ctx.versionId}/${ctx.entry}`);
  } catch {
    return null;
  }
  if (u.protocol === "mailto:") return u.href;
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let own: string;
  try {
    own = new URL(origin).origin;
  } catch {
    return null;
  }
  // Somewhere else entirely: the author's link, as written.
  if (u.origin !== own) return u.href;
  const prefix = `/content/${ctx.docId}/${ctx.versionId}/`;
  const path = u.pathname.startsWith(prefix)
    ? contentAddress({ ...ctx, origin: "" }, u.pathname.slice(prefix.length))
    : u.pathname;
  return `${ctx.origin}${path}${u.search}${u.hash}`;
}

/* ------------------------------------------------------------------------ */
/* The conversion                                                            */

/** The minimum of a DOM node these rules touch; turndown parses with its own DOM. */
interface MinimalNode {
  nodeName: string;
  nodeType?: number;
  textContent?: string | null;
  isBlock?: boolean;
  checked?: boolean;
  parentNode?: MinimalNode | null;
  previousSibling?: MinimalNode | null;
  nextSibling?: MinimalNode | null;
  childNodes?: ArrayLike<MinimalNode>;
  getAttribute?: (name: string) => string | null;
}

function asNode(node: unknown): MinimalNode {
  return node as MinimalNode;
}

function tagOf(node: MinimalNode | null | undefined): string {
  return (node?.nodeName || "").toLowerCase();
}

function attr(node: MinimalNode, name: string): string | null {
  return node.getAttribute?.(name) ?? null;
}

function filter(predicate: (node: MinimalNode) => boolean): TurndownService.Filter {
  return predicate as unknown as TurndownService.Filter;
}

/** One line of label, at most a sentence long. */
function label(text: string | null | undefined): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length > 120 ? `${one.slice(0, 119)}…` : one;
}

function bracket(kind: string, text: string): string {
  return text ? `[${kind}: ${text}]` : `[${kind}]`;
}

/** The first child element with this tag, skipping text. */
function childByTag(node: MinimalNode, tag: string): MinimalNode | null {
  const kids = node.childNodes ?? [];
  for (let i = 0; i < kids.length; i++) if (tagOf(kids[i]) === tag) return kids[i];
  return null;
}

function isHidden(node: MinimalNode): boolean {
  if (attr(node, "hidden") !== null) return true;
  if ((attr(node, "aria-hidden") ?? "").trim().toLowerCase() === "true") return true;
  return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(attr(node, "style") ?? "");
}

const FIGURES = new Set(["svg", "canvas", "math"]);
const EMBEDS = new Set(["iframe", "object", "embed"]);
const FORM_CONTROLS = new Set(["input", "select", "textarea", "button"]);
const CHROME = ["head", "title", "meta", "link", "base", "template", "noscript", "script", "style"];

/** The conversion in progress: its context and its counts. Turndown is synchronous, so one at a time. */
let current: { ctx: ReadingContext; leftOut: LeftOut } | null = null;

function counts(): LeftOut {
  return current?.leftOut ?? noneLeftOut();
}

function figure(node: MinimalNode): string {
  counts().figures++;
  const titled = tagOf(node) === "svg" ? childByTag(node, "title")?.textContent : null;
  return bracket("figure", label(attr(node, "aria-label") ?? attr(node, "alttext") ?? titled ?? attr(node, "title")));
}

function embed(node: MinimalNode): string {
  counts().embeds++;
  const name = label(attr(node, "title") ?? attr(node, "aria-label") ?? attr(node, "name"));
  const href = current ? resolveAddress(attr(node, "src") ?? attr(node, "data"), current.ctx) : null;
  return href ? `[${name ? `embedded: ${name}` : "embedded"}](${href})` : bracket("embedded", name);
}

/* Where the page's CSS is what keeps words apart ---------------------------- */

/**
 * The elements whose text runs into a neighbour's when only a stylesheet lays
 * them out apart: a metric's number and its label, a card's cells, a link and
 * the company after it. `lib/quote.ts` marks the same boundaries, more widely,
 * so a quote copied with the space this puts in is still found (ADR 0032).
 */
const TOUCHING = new Set(["span", "a"]);

function isElement(node: MinimalNode | null | undefined): node is MinimalNode {
  return node?.nodeType === 1;
}

function inPreformatted(node: MinimalNode): boolean {
  for (let p = node.parentNode ?? null; p; p = p.parentNode ?? null) {
    const t = tagOf(p);
    if (t === "pre" || t === "code") return true;
  }
  return false;
}

/**
 * A space in front of a span or link whose text runs straight on from the span
 * or link before it, `<span>256</span><span>Applications</span>`, skipping
 * empty ones between, like a bar drawn with CSS. Never after a text node,
 * which may be inside the same word, never in code, and never between two
 * single characters, which is a word split letter by letter for an animation.
 */
function touchGap(node: MinimalNode): string {
  const own = node.textContent ?? "";
  if (own === "" || /^\s/.test(own)) return "";
  let p = node.previousSibling ?? null;
  while (isElement(p) && TOUCHING.has(tagOf(p)) && /^\s*$/.test(p.textContent ?? "")) p = p.previousSibling ?? null;
  if (!isElement(p) || !TOUCHING.has(tagOf(p)) || isHidden(p)) return "";
  const before = p.textContent ?? "";
  if (/\s$/.test(before)) return "";
  if (before.length === 1 && own.length === 1) return "";
  return inPreformatted(node) ? "" : " ";
}

/* Pictures that say what they show --------------------------------------- */

/** How long a `role="img"` element's own words may run: they are the figure's content, not a caption. */
const IMAGE_LABEL_CHARS = 1000;

/** The words a `role="img"` element gives for itself, or null when it gives none. */
function imageLabel(node: MinimalNode): string | null {
  const role = (attr(node, "role") ?? "").trim().toLowerCase().split(/\s+/)[0];
  if (role !== "img" && role !== "image") return null;
  const said = (attr(node, "aria-label") ?? "").replace(/\s+/g, " ").trim();
  return said || null;
}

/**
 * A chart drawn from boxes, read as a screen reader reads it: its label, and
 * none of the cells inside, whose numbers mean nothing without the layout.
 */
function describedImage(node: MinimalNode, said: string): string {
  counts().figures++;
  const text = bracket("figure", said.length > IMAGE_LABEL_CHARS ? `${said.slice(0, IMAGE_LABEL_CHARS - 1)}…` : said);
  return node.isBlock ? `\n\n${text}\n\n` : text;
}

/* Lists ------------------------------------------------------------------- */

/** A bullet an author typed into a list item that already has one. Never a hyphen or a dash: those may be words. */
const TYPED_BULLET = /^[•◦▪▫‣⁃●○■□·][^\S\n]*/;

/** Each item's place in its list, counted once per list: a long list must not cost its length squared. */
const itemIndex = new WeakMap<object, number>();

function orderedIndex(item: MinimalNode, list: MinimalNode): number {
  let at = itemIndex.get(item);
  if (at === undefined) {
    const kids = list.childNodes ?? [];
    let n = 0;
    for (let i = 0; i < kids.length; i++) if (tagOf(kids[i]) === "li") itemIndex.set(kids[i], n++);
    at = itemIndex.get(item) ?? 0;
  }
  return at;
}

/** The table a row or cell belongs to, skipping nothing: a nested table owns its own rows. */
function owningTable(node: MinimalNode): MinimalNode | null {
  let p = node.parentNode ?? null;
  while (p && tagOf(p) !== "table") p = p.parentNode ?? null;
  return p;
}

/** The first row of a table, not looking inside a nested one. */
function firstRow(table: MinimalNode): MinimalNode | null {
  const stack: MinimalNode[] = [];
  const kids = table.childNodes ?? [];
  for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  while (stack.length > 0) {
    const n = stack.pop() as MinimalNode;
    const t = tagOf(n);
    if (t === "tr") return n;
    if (t === "table") continue;
    const inner = n.childNodes ?? [];
    for (let i = inner.length - 1; i >= 0; i--) stack.push(inner[i]);
  }
  return null;
}

function span(node: MinimalNode): number {
  const n = Number(attr(node, "colspan"));
  return Number.isInteger(n) && n > 1 ? Math.min(n, 50) : 1;
}

function columns(row: MinimalNode): number {
  let total = 0;
  const kids = row.childNodes ?? [];
  for (let i = 0; i < kids.length; i++) {
    const t = tagOf(kids[i]);
    if (t === "td" || t === "th") total += span(kids[i]);
  }
  return Math.max(total, 1);
}

function createReadingService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
    br: "  ",
    preformattedCode: true,
    /**
     * Turndown calls an element with no text blank and consults this BEFORE
     * any rule, so a drawing with no text in it — an icon, a chart's canvas —
     * would vanish without its placeholder. Those are answered here.
     */
    blankReplacement: (_content, node) => {
      const n = asNode(node);
      const t = tagOf(n);
      if (isHidden(n)) return "";
      const said = imageLabel(n);
      if (said !== null) return describedImage(n, said);
      if (FIGURES.has(t)) return figure(n);
      if (t === "object") return embed(n);
      return n.isBlock ? "\n\n" : "";
    },
  });

  // The words, unescaped: `*`, `_` and `[` in a sentence are the author's
  // characters, and a reading is never rendered back into HTML.
  service.escape = (text: string) => text;

  // Rules are consulted in REVERSE order of registration: later ones win.

  service.addRule("chrome", { filter: CHROME as TurndownService.Filter, replacement: () => "" });

  service.addRule("strike", {
    filter: ["del", "s", "strike"] as TurndownService.Filter,
    replacement: (content) => (content.trim() ? `~~${content}~~` : ""),
  });

  // A link with an address has its own rule below; both put the same space in.
  service.addRule("touching", {
    filter: filter((node) => tagOf(node) === "span" || (tagOf(node) === "a" && attr(node, "href") === null)),
    replacement: (content, node) => `${touchGap(asNode(node))}${content}`,
  });

  service.addRule("listItem", {
    filter: "li",
    replacement: (content, node) => {
      const n = asNode(node);
      const list = n.parentNode ?? null;
      let marker = "- ";
      let body = content.replace(/^\n+/, "");
      if (list && tagOf(list) === "ol") {
        const start = Number.parseInt(attr(list, "start") ?? "", 10);
        marker = `${(Number.isFinite(start) ? start : 1) + orderedIndex(n, list)}. `;
      } else {
        body = body.replace(TYPED_BULLET, "");
      }
      // Continuation lines line up under the item's text, as CommonMark reads them.
      const indent = " ".repeat(marker.length);
      body = body.replace(/\n+$/, "\n").replace(/\n/gm, `\n${indent}`);
      return marker + body + (n.nextSibling && !/\n$/.test(body) ? "\n" : "");
    },
  });

  service.addRule("tableCell", {
    filter: ["th", "td"],
    replacement: (content, node) => {
      const text = content.replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
      return ` ${text} |${" |".repeat(span(asNode(node)) - 1)}`;
    },
  });
  service.addRule("tableRow", {
    filter: "tr",
    replacement: (content, node) => {
      const n = asNode(node);
      const row = `|${content}\n`;
      const table = owningTable(n);
      if (!table || firstRow(table) !== n) return row;
      return `${row}|${" --- |".repeat(columns(n))}\n`;
    },
  });
  service.addRule("tableSection", {
    filter: ["thead", "tbody", "tfoot"],
    replacement: (content) => content,
  });
  service.addRule("tableCaption", {
    filter: "caption",
    replacement: (content) => `${label(content)}\n\n`,
  });
  service.addRule("table", {
    filter: "table",
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });

  service.addRule("link", {
    filter: filter((node) => tagOf(node) === "a" && attr(node, "href") !== null),
    replacement: (content, node) => {
      const n = asNode(node);
      const href = current ? resolveAddress(attr(n, "href"), current.ctx) : null;
      const gap = touchGap(n);
      return href && content.trim() ? `${gap}[${content}](${href})` : `${gap}${content}`;
    },
  });

  service.addRule("image", {
    filter: "img",
    replacement: (_content, node) => {
      const n = asNode(node);
      const alt = label(attr(n, "alt"));
      const src = attr(n, "src") ?? "";
      if (inlineAddress(src) !== null) {
        counts().inlineImages++;
        return bracket("image", alt);
      }
      const href = current ? resolveAddress(src, current.ctx) : null;
      return href ? `![${alt}](${href})` : bracket("image", alt);
    },
  });

  service.addRule("media", {
    filter: ["video", "audio"],
    replacement: (_content, node) => {
      const n = asNode(node);
      const kind = tagOf(n);
      const raw = attr(n, "src") ?? (childByTag(n, "source") ? attr(childByTag(n, "source") as MinimalNode, "src") : null);
      const href = current ? resolveAddress(raw, current.ctx) : null;
      const file = href ? decodeURIComponent(new URL(href, PARSE_ORIGIN).pathname.split("/").pop() ?? "") : "";
      const name = label(attr(n, "title") ?? attr(n, "aria-label") ?? file);
      return href ? `[${name ? `${kind}: ${name}` : kind}](${href})` : bracket(kind, name);
    },
  });

  service.addRule("embed", {
    filter: filter((node) => EMBEDS.has(tagOf(node))),
    replacement: (_content, node) => embed(asNode(node)),
  });

  service.addRule("figure", {
    filter: filter((node) => FIGURES.has(tagOf(node))),
    replacement: (_content, node) => figure(asNode(node)),
  });

  service.addRule("describedImage", {
    filter: filter((node) => imageLabel(node) !== null),
    replacement: (_content, node) => describedImage(asNode(node), imageLabel(asNode(node)) as string),
  });

  service.addRule("formControl", {
    filter: filter((node) => FORM_CONTROLS.has(tagOf(node))),
    replacement: (_content, node) => {
      const n = asNode(node);
      if (tagOf(n) === "input" && (attr(n, "type") ?? "").toLowerCase() === "checkbox") {
        return n.checked || attr(n, "checked") !== null ? "[x] " : "[ ] ";
      }
      counts().formControls++;
      return "";
    },
  });

  service.addRule("hidden", {
    filter: filter((node) => isHidden(node)),
    replacement: () => {
      counts().hidden++;
      return "";
    },
  });

  return service;
}

let service: TurndownService | null = null;

/** Collapse runs of blank lines and normalize the trailing newline. */
function tidy(markdown: string): string {
  return `${markdown
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/** Letters and digits only: what a person would call the page's text. */
function textWeight(markdown: string): number {
  const bare = markdown.replace(/\[(?:figure|image|embedded|video|audio)(?::[^\]]*)?\]/g, "");
  return (bare.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/** An HTML document as an agent should read it. */
export function readingMarkdown(html: string, ctx: ReadingContext): Reading {
  const leftOut = noneLeftOut();
  const stripped = stripForReading(html ?? "", leftOut);
  const cut = stripped.length > READ_PARSE_CHARS;
  const input = cut ? stripped.slice(0, READ_PARSE_CHARS) : stripped;
  if (!service) service = createReadingService();
  current = { ctx, leftOut };
  let body: string;
  try {
    body = tidy(service.turndown(input));
  } finally {
    current = null;
  }
  if (body === "\n") body = "";
  const warnings: string[] = [];
  if (leftOut.scripts > 0 && textWeight(body) < SCRIPT_BUILT_BELOW) warnings.push(BUILT_BY_SCRIPT);
  if (cut) warnings.push(STOPS_EARLY);
  return { body, leftOut, warnings, cut };
}

/* ------------------------------------------------------------------------ */
/* The preamble                                                              */

/** The sentence every reading opens with. */
export const READING_NOTICE =
  "A Markdown reading of this document, made by Bikeshed for agents. It is not the source: never send it back as an update. When you comment, quote its words, not its Markdown.";

/** How to get the original through the tools rather than the address. */
export const ORIGINAL_THROUGH = 'get_document with as: "source", or bikeshed get --source';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What was left out, in words: always the styling, then whatever was counted. */
export function describeLeftOut(leftOut: LeftOut): string {
  const parts = ["styling and layout"];
  if (leftOut.scripts) parts.push(plural(leftOut.scripts, "script", "scripts"));
  if (leftOut.stylesheets) parts.push(plural(leftOut.stylesheets, "stylesheet", "stylesheets"));
  if (leftOut.figures) parts.push(plural(leftOut.figures, "figure drawn in code", "figures drawn in code"));
  if (leftOut.embeds) parts.push(plural(leftOut.embeds, "embedded frame", "embedded frames"));
  if (leftOut.inlineImages) parts.push(plural(leftOut.inlineImages, "image held inside the page", "images held inside the page"));
  if (leftOut.hidden) parts.push(plural(leftOut.hidden, "hidden element", "hidden elements"));
  if (leftOut.formControls) parts.push(plural(leftOut.formControls, "form control", "form controls"));
  return parts.join(", ");
}

/**
 * The front matter every reading starts with, on every surface, and never a
 * source. YAML whose values are JSON strings, which YAML reads as
 * double-quoted scalars: a title with a colon or a quote cannot break it.
 */
export function readingPreamble(input: {
  title: string;
  document: string;
  version: string;
  original: string;
  leftOut: LeftOut;
  warnings: readonly string[];
}): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = [
    "---",
    `reading: ${q(READING_NOTICE)}`,
    `title: ${q(input.title)}`,
    `document: ${q(input.document)}`,
    `version: ${q(input.version)}`,
    `original: ${q(input.original)}`,
    `original-through: ${q(ORIGINAL_THROUGH)}`,
    `left-out: ${q(describeLeftOut(input.leftOut))}`,
  ];
  if (input.warnings.length > 0) {
    lines.push("warnings:");
    for (const w of input.warnings) lines.push(`  - ${q(w)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/** A reading whole: its preamble, then its body. */
export function composeReading(preamble: string, reading: Reading): string {
  return reading.body ? `${preamble}\n${reading.body}` : preamble;
}
