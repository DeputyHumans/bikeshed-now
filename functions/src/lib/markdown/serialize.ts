// SPDX-License-Identifier: Apache-2.0
// Edited HTML back to Markdown, server-side (SPEC §11).

import TurndownService from "turndown";
import { MARKDOWN_THEME_ID } from "./theme";

// turndown-plugin-gfm ships CommonJS with no ESM interop shim.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const turndownGfm = require("turndown-plugin-gfm") as {
  gfm: TurndownService.Plugin;
};

/**
 * Why this runs on the server
 * --------------------------
 * The editor edits the rendered DOM, exactly as it does for an HTML document, so
 * a save arrives as HTML. Converting it here rather than in the browser means
 * one implementation instead of two, and keeps the app's runtime dependency
 * budget at seven (docs/architecture/overview.md).
 *
 * The contract this must satisfy
 * ------------------------------
 * `md -> html -> md'` may normalize: `*` bullets become `-`, setext headings
 * become ATX, an indented code block becomes a fenced one, a reference link
 * becomes inline. That first pass is visible at a version boundary, which is the
 * honest place for it.
 *
 * `md' -> html' -> md''` must change NOTHING. Idempotence after the first pass
 * is the whole contract, and it is what keeps editing a Markdown document from
 * degrading it one save at a time.
 *
 * Normalization must also never be LOSSY. Two bugs of that shape are fixed
 * explicitly below — strikethrough emitted with a single tilde, and raw HTML
 * silently dropped — because both are idempotent while still destroying the
 * author's content on the first save, which is the worst possible combination.
 */

/**
 * Every element markdown-it (plus this codebase's two plugins) can generate.
 *
 * Anything NOT in this set came from raw HTML the author wrote, and is kept
 * verbatim. That is the principled version of a hand-maintained keep-list: the
 * question "did we produce this element, or did the author?" has an exact
 * answer, and the answer is this set.
 */
const GENERATED_ELEMENTS = new Set([
  "html", "head", "body", "title", "meta", "link", "style",
  "main", "section",
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "pre", "code",
  "em", "strong", "s", "del", "a", "img", "hr", "br",
  "table", "thead", "tbody", "tr", "th", "td",
]);

/** The placeholder a comment is parked in while turndown walks the tree. */
const COMMENT_ATTR = "data-md-comment";

/**
 * A one-character prefix on the parked payload, so the placeholder always has
 * text. `<!---->` base64-encodes to the empty string, and an empty placeholder
 * is blank again — which is precisely the case this whole arrangement exists to
 * avoid. It is not a character base64 can produce, so stripping it is exact.
 */
const COMMENT_SENTINEL = "#";

/** Document scaffolding that carries no authored content. */
const DOCUMENT_CHROME = ["head", "title", "meta", "link", "base"];

/**
 * The minimum of a DOM node these rules touch.
 *
 * @types/turndown types its filter callbacks as `HTMLElement`, which only
 * resolves with the DOM lib enabled. Enabling that for the whole functions build
 * would make `document.querySelector` typecheck inside a Node process, which is
 * a worse trade than one local structural type. At runtime turndown parses with
 * its own bundled DOM implementation, so these are the real shapes.
 */
interface MinimalNode {
  nodeName: string;
  id?: string;
  type?: string;
  checked?: boolean;
  isBlock?: boolean;
  outerHTML?: string;
  parentNode?: MinimalNode | null;
  nextSibling?: MinimalNode | null;
  children?: ArrayLike<MinimalNode>;
  getAttribute?: (name: string) => string | null;
}

function asNode(node: unknown): MinimalNode {
  return node as MinimalNode;
}

/** Adapt a structural predicate to the filter type @types/turndown declares. */
function nodeFilter(
  predicate: (node: MinimalNode) => boolean,
): TurndownService.Filter {
  return predicate as unknown as TurndownService.Filter;
}

function tagOf(node: MinimalNode): string {
  return (node.nodeName || "").toLowerCase();
}

function createService(): TurndownService {
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
     * Turndown treats an element with no text content as "blank" and drops it,
     * BEFORE any rule or keep filter is consulted. For an authored
     * `<div id="chart"></div>` — the fill target of a script, and the exact
     * shape this product's sample documents use — that is silent data loss on
     * the first save. Blank elements we did not generate are therefore emitted
     * verbatim.
     */
    blankReplacement: (_content, node) => {
      const n = asNode(node);
      if (!GENERATED_ELEMENTS.has(tagOf(n)) && typeof n.outerHTML === "string") {
        return n.isBlock ? `\n\n${n.outerHTML}\n\n` : n.outerHTML;
      }
      return n.isBlock ? "\n\n" : "";
    },
  });

  service.use(turndownGfm.gfm);

  // Rules are consulted in REVERSE order of registration, so everything added
  // below overrides both turndown's defaults and the GFM plugin.

  // Document scaffolding carries nothing the author wrote. Without this the
  // <title> text lands as a stray first line of the Markdown on every save.
  service.addRule("dropDocumentChrome", {
    filter: DOCUMENT_CHROME,
    replacement: () => "",
  });

  // The renderer's own stylesheet. Author <style> blocks are kept verbatim by
  // the predicate below; only ours is dropped, and only by id.
  service.addRule("dropOwnTheme", {
    filter: nodeFilter(
      (node) => tagOf(node) === "style" && node.id === MARKDOWN_THEME_ID,
    ),
    replacement: () => "",
  });

  // `<section>` and `<main>` are structure this renderer adds. Unwrap them, or a
  // round trip accumulates one nesting level per save. `<article>` is
  // deliberately NOT in this list: we never generate it, so it is the author's.
  service.addRule("unwrapGeneratedStructure", {
    filter: ["section", "main"],
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });

  // turndown-plugin-gfm emits a SINGLE tilde. markdown-it's strikethrough rule
  // requires two, so `~struck~` round-trips as literal text and the formatting
  // is gone — idempotently, which is what makes it dangerous rather than merely
  // wrong.
  service.addRule("strikethrough", {
    filter: ["del", "s"],
    replacement: (content) => (content.trim() ? `~~${content}~~` : ""),
  });

  // GFM task list items. The renderer emits a disabled checkbox; turn it back
  // into the `[ ]` / `[x]` marker rather than keeping the input verbatim.
  service.addRule("taskListCheckbox", {
    filter: nodeFilter(
      (node) =>
        tagOf(node) === "input" &&
        node.type === "checkbox" &&
        (tagOf(node.parentNode ?? { nodeName: "" }) === "li" ||
          tagOf(node.parentNode?.parentNode ?? { nodeName: "" }) === "li"),
    ),
    replacement: (_content, node) => (asNode(node).checked ? "[x] " : "[ ] "),
  });

  /**
   * List items, with the continuation indent matched to the marker width.
   *
   * Turndown's default indents continuation by a fixed four spaces and pads the
   * bullet to match. That is valid but unidiomatic, and it is actively wrong for
   * ordered lists, where a nested list must be indented to the CONTENT column —
   * `1. ` is three characters, so two spaces of indent would un-nest it.
   */
  service.addRule("listItem", {
    filter: "li",
    replacement: (content, node, options) => {
      const n = asNode(node);
      const parent = n.parentNode;
      let prefix = `${options.bulletListMarker} `;
      if (parent && tagOf(parent) === "ol") {
        const start = parent.getAttribute?.("start");
        const index = parent.children
          ? Array.prototype.indexOf.call(parent.children, n)
          : 0;
        const first = start ? Number(start) : 1;
        prefix = `${first + index}. `;
      }
      const indent = " ".repeat(prefix.length);
      const body = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n/gm, `\n${indent}`);
      const needsBreak = n.nextSibling && !/\n$/.test(body);
      return prefix + body + (needsBreak ? "\n" : "");
    },
  });

  /**
   * Author comments, carried through a placeholder.
   *
   * Turndown never visits comment nodes — its walker handles element and text
   * nodes and returns "" for anything else — so no rule can reach one and a
   * comment is simply gone after a single save. That is silent deletion of
   * something the author wrote, and it is the third instance of the
   * lossy-but-idempotent bug this module's header calls the worst shape. Not
   * hypothetical either: every sample in `content/` opens with an SPDX comment,
   * so editing one stripped its licence header.
   *
   * The payload rides as the placeholder's TEXT, not as an attribute, and that
   * is load-bearing. Turndown treats an element with no text as blank and
   * consults `blankReplacement` before any rule — and blankness propagates, so
   * an empty placeholder would make its whole enclosing `<section>` blank and
   * the section's own replacement would drop the subtree before this rule was
   * ever asked. Text content makes the node meaningful, and everything above it
   * too.
   *
   * Base64 so a comment containing quotes, angle brackets or newlines survives
   * the trip through markup intact.
   */
  service.addRule("authorComment", {
    filter: nodeFilter((node) => node.getAttribute?.(COMMENT_ATTR) != null),
    replacement: (content) => {
      const payload = content.trim().slice(COMMENT_SENTINEL.length);
      return `\n\n<!--${Buffer.from(payload, "base64").toString("utf8")}-->\n\n`;
    },
  });

  // Everything the renderer does not generate is the author's raw HTML, and is
  // emitted verbatim. Turndown's default would print an unknown element's text
  // content, quietly turning an inline <svg> or a <script> into stray prose.
  service.keep(nodeFilter((node) => !GENERATED_ELEMENTS.has(tagOf(node))));

  return service;
}

/**
 * Park every HTML comment in a placeholder element.
 *
 * Operating on the string is safe here because this input is always rendered
 * output: markdown-it escapes `<` to `&lt;` inside code spans and fenced
 * blocks, so a comment written INSIDE code is not a comment node and does not
 * match. The only `<!--` left in the rendered HTML is a real one.
 */
function parkComments(html: string): string {
  return html.replace(/<!--([\s\S]*?)-->/g, (_all, body: string) => {
    const encoded = Buffer.from(body, "utf8").toString("base64");
    return `<div ${COMMENT_ATTR}="1">${COMMENT_SENTINEL}${encoded}</div>`;
  });
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

/**
 * Convert an edited HTML document back to Markdown.
 *
 * Accepts a whole document or a fragment: turndown parses with a DOM
 * implementation of its own, so `<head>` is handled by the rules above rather
 * than by string surgery on the input.
 */
export function htmlToMarkdown(html: string): string {
  if (!service) service = createService();
  return tidy(service.turndown(parkComments(html ?? "")));
}
