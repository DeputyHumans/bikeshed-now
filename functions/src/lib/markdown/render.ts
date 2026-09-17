// SPDX-License-Identifier: Apache-2.0
// Markdown source to a self-contained HTML bundle entry (SPEC §11).

import MarkdownIt from "markdown-it";
import { Slugger } from "./slug";
import { MARKDOWN_THEME_CSS, MARKDOWN_THEME_ID } from "./theme";

/**
 * The design rule that makes Markdown cheap
 * -----------------------------------------
 * Markdown compiles to an HTML bundle at WRITE time, server-side, exactly once
 * per version. The client never renders Markdown. Every existing invariant then
 * survives untouched — content is still immutable bytes in a private bucket,
 * still served through contentProxy into a same-origin iframe, still annotated
 * by DOM anchors, still exported from the rendered DOM — and there is no
 * dual-implementation drift risk, because there is only ever one implementation
 * running in one place.
 *
 * Two consequences worth stating rather than discovering:
 *
 *  1. The rendered bytes are part of the hashed bundle, so a RENDERER UPGRADE
 *     mints a new version. That is correct: the rendering is part of the
 *     artifact. `rendererVersion` on each version record makes it auditable, and
 *     markdown-it is pinned to an exact version for the same reason.
 *
 *  2. Raw HTML flows through the EXISTING trust model rather than a new
 *     sanitizer policy. A `<script>` in the source survives into the output and
 *     the document obeys SPEC §6c: CLI-published means trusted, browser-uploaded
 *     means sandboxed with a trust prompt only if the DOM really contains
 *     script. One concept, not two.
 */

/**
 * Bumped whenever the rendered bytes can change. Recorded on every version so a
 * later "why did the hash move" has an answer.
 */
export const RENDERER_VERSION = "markdown-it@14.1.0+bikeshed-1";

/** Ids the renderer emits itself, reserved so a heading cannot collide with one. */
const RESERVED_IDS = ["preamble"];

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Wrap each heading and its subordinate content in `<section id="...">`.
 *
 * This is the load-bearing part of the whole feature. Annotation anchors scope
 * to the nearest `id`-bearing ancestor, so a flat `<h1><p><p>` stream would
 * scope EVERY highlight to `<body>`: an edit anywhere in the document would then
 * shift every anchor's position offsets at once, and the quote selector would be
 * searching the entire document for its match. Sections make the scope local, so
 * an edit in one section cannot disturb anchors in another.
 *
 * It also happens to be exactly the shape the hand-authored HTML samples use, so
 * the annotation layer, the `<details>` rehydrator and per-section image export
 * all work on Markdown documents with no special-casing.
 */
function sectionPlugin(md: MarkdownIt): void {
  md.core.ruler.push("bikeshed_sections", (state) => {
    const Token = state.Token;
    const tokens = state.tokens;
    const slugger = new Slugger(RESERVED_IDS);

    const open = (id: string) => {
      const t = new Token("html_block", "", 0);
      t.content = `<section id="${escapeAttr(id)}">\n`;
      t.block = true;
      return t;
    };
    const close = () => {
      const t = new Token("html_block", "", 0);
      t.content = "</section>\n";
      t.block = true;
      return t;
    };

    const out: typeof tokens = [];
    /** Heading levels of the sections currently open, outermost first. */
    const openLevels: number[] = [];
    let sawHeading = false;
    let preambleOpen = false;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      if (token.type === "heading_open") {
        if (preambleOpen) {
          out.push(close());
          preambleOpen = false;
        }
        const level = Number(token.tag.slice(1)) || 1;
        while (
          openLevels.length > 0 &&
          openLevels[openLevels.length - 1] >= level
        ) {
          out.push(close());
          openLevels.pop();
        }
        const inline = tokens[i + 1];
        const text = inline && inline.type === "inline" ? inline.content : "";
        out.push(open(slugger.slug(text)));
        openLevels.push(level);
        sawHeading = true;
        out.push(token);
        continue;
      }

      // Content before the first heading still needs a stable scope, or every
      // anchor in it would resolve against <body>.
      if (!sawHeading && !preambleOpen && token.block && token.nesting >= 0) {
        out.push(open("preamble"));
        preambleOpen = true;
      }
      out.push(token);
    }

    while (openLevels.length > 0) {
      out.push(close());
      openLevels.pop();
    }
    if (preambleOpen) out.push(close());

    state.tokens = out;
  });
}

/** Task-list checkboxes, rendered inert: a document is not a form. */
function taskListPlugin(md: MarkdownIt): void {
  md.core.ruler.after("inline", "bikeshed_tasklists", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== "inline") continue;
      const prev = tokens[i - 1];
      if (!prev || prev.type !== "paragraph_open") continue;
      const li = tokens[i - 2];
      if (!li || li.type !== "list_item_open") continue;
      const m = /^\[([ xX])\]\s+/.exec(inline.content);
      if (!m) continue;

      const checked = m[1] !== " ";
      inline.content = inline.content.slice(m[0].length);
      if (inline.children && inline.children.length > 0) {
        const first = inline.children[0];
        if (first.type === "text") first.content = first.content.replace(/^\[([ xX])\]\s+/, "");
      }
      const box = new state.Token("html_inline", "", 0);
      // No trailing space: the stylesheet provides the gap, and a space here
      // round-trips into the Markdown as a second space after the marker.
      box.content = `<input type="checkbox" disabled${checked ? " checked" : ""}>`;
      inline.children = [box, ...(inline.children ?? [])];
      li.attrJoin("class", "task-list-item");
    }
  });
}

/**
 * The renderer. Pinned configuration, no nondeterministic plugins: rendering the
 * same source twice must be byte-identical, including across process restarts.
 */
function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({
    html: true, // raw HTML passes through; SPEC §6c governs it
    linkify: false, // linkify is a normalization the author did not ask for
    typographer: false, // and so is smart-quoting
    breaks: false,
    xhtmlOut: false,
  });
  md.use(taskListPlugin);
  md.use(sectionPlugin);
  return md;
}

let renderer: MarkdownIt | null = null;
function md(): MarkdownIt {
  if (!renderer) renderer = createRenderer();
  return renderer;
}

/** The document title: the first level-1 heading, else a fallback. */
export function titleFromMarkdown(source: string, fallback: string): string {
  const m = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m.exec(source);
  if (m) return m[1].trim().slice(0, 200);
  const setext = /^\s{0,3}(\S.*)\n\s{0,3}=+\s*$/m.exec(source);
  if (setext) return setext[1].trim().slice(0, 200);
  return fallback;
}

export interface RenderedMarkdown {
  html: string;
  title: string;
  rendererVersion: string;
}

/**
 * Compile Markdown into a self-contained HTML document.
 *
 * Self-contained means what it says: an embedded stylesheet and ZERO external
 * URLs, so the output satisfies the same bundle rules the hand-authored samples
 * follow and a reader's browser never contacts a third party to render it.
 */
export function renderMarkdown(
  source: string,
  opts: { title?: string } = {},
): RenderedMarkdown {
  const body = md().render(source);
  const title = opts.title?.trim() || titleFromMarkdown(source, "Document");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(title)}</title>
<style id="${MARKDOWN_THEME_ID}">
${MARKDOWN_THEME_CSS}
</style>
</head>
<body>
<main>
${body.trimEnd()}
</main>
</body>
</html>
`;
  return { html, title, rendererVersion: RENDERER_VERSION };
}
