// SPDX-License-Identifier: Apache-2.0
// Markdown round-trip idempotence is the contract (SPEC §11).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const { renderMarkdown, titleFromMarkdown, RENDERER_VERSION } = require("../lib/lib/markdown/render.js");
const { htmlToMarkdown } = require("../lib/lib/markdown/serialize.js");
const { Slugger, baseSlug } = require("../lib/lib/markdown/slug.js");

const FIXTURES = join(__dirname, "fixtures", "markdown");
const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");

/**
 * The shipped sample is ALSO a fixture.
 *
 * content/markdown-reference documents this feature and is published by the
 * emulator walkthrough, so running the round-trip contract against it is what
 * stops the documentation drifting from the renderer: a change that breaks the
 * sample breaks the suite in the same commit.
 */
const SAMPLE = join(__dirname, "..", "..", "content", "markdown-reference", "bundle", "index.md");

const sources = () => [
  ...readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".md"))
    .map((name) => [name, fixture(name)]),
  ["content/markdown-reference", readFileSync(SAMPLE, "utf8")],
];

const sections = (html) =>
  [...html.matchAll(/<section id="([^"]*)">/g)].map((m) => m[1]);

// --- The contract ----------------------------------------------------------

test("the round trip is idempotent after the first normalizing pass", () => {
  // `md -> md'` may normalize. `md' -> md''` must change NOTHING. That property
  // is what keeps editing a Markdown document from degrading it one save at a
  // time, and it is the reason this whole feature is safe to offer.
  for (const [name, source] of sources()) {
    const first = htmlToMarkdown(renderMarkdown(source).html);
    const second = htmlToMarkdown(renderMarkdown(first).html);
    assert.equal(second, first, `${name} is not idempotent after the first pass`);
    const third = htmlToMarkdown(renderMarkdown(second).html);
    assert.equal(third, second, `${name} drifts on the third pass`);
  }
});

test("normalization is not lossy: formatting survives the first pass", () => {
  const source = [
    "# T",
    "",
    "*em* **strong** ~~struck~~ `code`",
    "",
    "* star bullet",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "- [x] done",
  ].join("\n");
  const out = htmlToMarkdown(renderMarkdown(source).html);
  assert.match(out, /\*em\*/, "emphasis survives");
  assert.match(out, /\*\*strong\*\*/, "strong survives");
  // A single tilde would round-trip as literal text, losing the formatting
  // idempotently — which is worse than losing it noisily.
  assert.match(out, /~~struck~~/, "strikethrough keeps both tildes");
  assert.match(out, /`code`/, "inline code survives");
  assert.match(out, /^- star bullet$/m, "* bullets normalize to -");
  assert.match(out, /\| a \| b \|/, "the table survives");
  assert.match(out, /- \[x\] done/, "the task marker survives");
});

test("raw HTML the author wrote is never silently dropped", () => {
  // Turndown treats an element with no text as blank and drops it before any
  // rule is consulted. An empty <div id="chart"> is exactly the fill target a
  // scripted document uses, so losing it is silent data loss.
  const source = '# T\n\n<div id="chart"></div>\n\n<script>go()</script>\n';
  const out = htmlToMarkdown(renderMarkdown(source).html);
  assert.match(out, /<div id="chart"><\/div>/);
  assert.match(out, /<script>go\(\)<\/script>/);
});

// --- Raw text: script, style, textarea --------------------------------------
//
// Turndown collapses whitespace in every text node before any rule runs, and
// exempts only <pre>. Inside these three elements the text is not prose: a
// script's line breaks end its `//` comments, a textarea's are its value. Each
// case below was broken on the first save, and stably so afterwards.

const RAW = [
  "# T",
  "",
  "<script>",
  "// The next line is the only one that does anything.",
  'document.getElementById("out").textContent = "ran";',
  "</script>",
  "",
  "<style>",
  ".box {",
  "  color: red;",
  "}",
  "</style>",
  "",
  "<textarea>line one",
  "  line two</textarea>",
  "",
].join("\n");

test("a script keeps its line breaks, so a // comment still ends at its line", () => {
  const out = htmlToMarkdown(renderMarkdown(RAW).html);
  assert.ok(
    out.includes('<script>\n// The next line is the only one that does anything.\ndocument.getElementById("out").textContent = "ran";\n</script>'),
    `the script changed:\n${out}`,
  );
});

test("an author's <style> stays a stylesheet, not prose", () => {
  const out = htmlToMarkdown(renderMarkdown(RAW).html);
  assert.ok(out.includes("<style>\n.box {\n  color: red;\n}\n</style>"), `the style block changed:\n${out}`);
  const again = renderMarkdown(out).html;
  assert.ok(!/<p>[^<]*\.box \{/.test(again), "the CSS came back as a paragraph of visible text");
});

test("a textarea keeps its value exactly", () => {
  const out = htmlToMarkdown(renderMarkdown(RAW).html);
  assert.ok(out.includes("<textarea>line one\n  line two</textarea>"), `the textarea changed:\n${out}`);
});

test("raw-text blocks keep their own lines, so each renders as its own block", () => {
  const out = htmlToMarkdown(renderMarkdown(RAW).html);
  assert.match(out, /<\/script>\n\n<style>/, "the script and the style were run together");
  assert.match(out, /<\/style>\n\n<textarea>/, "the style and the textarea were run together");
});

test("raw text survives every later save unchanged", () => {
  const first = htmlToMarkdown(renderMarkdown(RAW).html);
  const second = htmlToMarkdown(renderMarkdown(first).html);
  assert.equal(second, first);
  assert.ok(first.startsWith("# T\n\n<script>\n// The next line"), first);
});

test("a script inside a paragraph stays inside it, line breaks and all", () => {
  const source = "# T\n\nBefore <script>x = 1;\n// c\ny = 2;</script> after.\n";
  const out = htmlToMarkdown(renderMarkdown(source).html);
  assert.ok(out.includes("Before <script>x = 1;\n// c\ny = 2;</script> after."), `the paragraph changed:\n${out}`);
  assert.equal(htmlToMarkdown(renderMarkdown(out).html), out);
});

test("a script nested in the author's own element keeps its line breaks too", () => {
  const source = '# T\n\n<div class="widget">\n<script>\n// one\nrun();\n</script>\n</div>\n';
  const out = htmlToMarkdown(renderMarkdown(source).html);
  assert.ok(out.includes("<script>\n// one\nrun();\n</script>"), `the nested script changed:\n${out}`);
});

test("a <script> written inside a comment is part of the comment, untouched", () => {
  const source = "# T\n\n<!-- disabled:\n<script>\n// off\nrun();\n</script>\n-->\n\nBody.\n";
  const out = htmlToMarkdown(renderMarkdown(source).html);
  assert.ok(out.includes("<!-- disabled:\n<script>\n// off\nrun();\n</script>\n-->"), `the comment changed:\n${out}`);
  assert.ok(!out.includes("bshd-raw"), "a parked token leaked");
});

test("a <!-- inside a script is script text, not a comment", () => {
  const source = '# T\n\n<script>\nvar s = "<!-- not a comment -->";\nrun(s);\n</script>\n';
  const out = htmlToMarkdown(renderMarkdown(source).html);
  assert.ok(out.includes('<script>\nvar s = "<!-- not a comment -->";\nrun(s);\n</script>'), `the script changed:\n${out}`);
});

test("raw text keeps its trailing spaces and its runs of blank lines", () => {
  // The output is tidied — trailing spaces stripped, blank lines squeezed — and
  // inside a textarea or a script those are the author's, so tidying must not
  // reach them.
  const source = "# T\n\n<textarea>one  \n\n\n\ntwo</textarea>\n";
  const out = htmlToMarkdown(renderMarkdown(source).html);
  assert.ok(out.includes("<textarea>one  \n\n\n\ntwo</textarea>"), `the textarea changed:\n${JSON.stringify(out)}`);
});

test("a comment that merely mentions <script> does not swallow the real script after it", () => {
  const source = "# T\n\n<!-- remember the <script> tag below -->\n\n<script>\n// real\nrun();\n</script>\n\nAfter.\n";
  const out = htmlToMarkdown(renderMarkdown(source).html);
  assert.ok(out.includes("<!-- remember the <script> tag below -->"), `the comment changed:\n${out}`);
  assert.ok(out.includes("<script>\n// real\nrun();\n</script>"), `the script changed:\n${out}`);
  assert.ok(out.includes("After."), `text after the script was lost:\n${out}`);
});

test("the renderer's own stylesheet never reaches the author's source", () => {
  const out = htmlToMarkdown(renderMarkdown("# T\n\nBody.\n").html);
  assert.ok(!out.includes("box-sizing"), "the embedded theme leaked into the Markdown");
  assert.ok(!out.includes("<style"), "a <style> block leaked into the Markdown");
});

test("the document title never leaks into the body as a stray first line", () => {
  const out = htmlToMarkdown(renderMarkdown("# Alpha\n\nBody.\n").html);
  assert.equal(out.split("\n")[0], "# Alpha");
});

// --- Author comments -------------------------------------------------------

test("an HTML comment survives the round trip, and stays put", () => {
  /**
   * Turndown never visits comment nodes, so before this was handled a single
   * save deleted every comment in the document — including the SPDX header
   * every sample in `content/` opens with. Lossy AND idempotent is the worst
   * shape a normalization can have: it destroys the author's content once and
   * then looks stable forever.
   */
  const cases = {
    "a licence header": "<!-- SPDX-License-Identifier: Apache-2.0 -->\n\n# Title\n\nBody.\n",
    "quotes, angle brackets and an ampersand": '<!-- a "quoted" <tag> & more -->\n\n# T\n',
    "several lines": "<!--\n  line one\n  line two\n-->\n\n# T\n",
    "two of them, one mid-document": "<!-- one -->\n\n# T\n\n<!-- two -->\n\nBody.\n",
    // Base64 of "" is "", so an unprefixed placeholder would be blank — which
    // is the exact condition the placeholder exists to avoid.
    "an empty one": "<!---->\n\n# T\n",
    "beside an authored empty div": '# T\n\n<!-- why -->\n<div id="chart"></div>\n',
  };

  for (const [name, source] of Object.entries(cases)) {
    const first = htmlToMarkdown(renderMarkdown(source).html);
    assert.ok(first.includes("<!--"), `${name}: the comment was dropped`);
    const second = htmlToMarkdown(renderMarkdown(first).html);
    assert.equal(second, first, `${name} is not idempotent`);
  }
});

test("a comment INSIDE code is code, not a comment", () => {
  // The parking step works on the rendered HTML string. That is only safe
  // because markdown-it escapes `<` inside code spans and fenced blocks, so
  // what looks like a comment in code never becomes a comment node.
  for (const source of [
    "# T\n\n```html\n<!-- not a real comment -->\n```\n",
    "# T\n\nUse `<!-- x -->` here.\n",
  ]) {
    const first = htmlToMarkdown(renderMarkdown(source).html);
    assert.ok(
      first.includes("<!-- not a real comment -->") || first.includes("`<!-- x -->`"),
      "the literal text must survive as code",
    );
    assert.equal(htmlToMarkdown(renderMarkdown(first).html), first);
  }
});

test("the placeholder never reaches the output", () => {
  // If it ever did, it would be visible markup in somebody's document.
  const source = "<!-- one -->\n\n# T\n\n<!-- two -->\n";
  const out = htmlToMarkdown(renderMarkdown(source).html);
  assert.doesNotMatch(out, /data-md-comment/);
});

// --- Determinism -----------------------------------------------------------

test("rendering the same source twice is byte-identical", () => {
  for (const [name, source] of sources()) {
    assert.equal(renderMarkdown(source).html, renderMarkdown(source).html, name);
  }
});

test("there is nothing time- or random-dependent in the output", () => {
  const html = renderMarkdown(fixture("kitchen-sink.md")).html;
  assert.ok(!/\b20\d\d-\d\d-\d\dT/.test(html), "a timestamp reached the output");
});

test("the renderer version is pinned and recorded", () => {
  assert.match(RENDERER_VERSION, /^markdown-it@\d+\.\d+\.\d+\+bikeshed-\d+$/);
  assert.equal(renderMarkdown("# x").rendererVersion, RENDERER_VERSION);
});

// Any signed-up account can upload Markdown, up to MAX_BUNDLE_BYTES, and it is
// rendered inside the request. markdown-it 14.1.0 took 13.8 s on the first of
// these and 12.2 s on the second; the time grew with the square of the input, so
// a file well under the limit held a function until it timed out. The bound
// leaves room for a loaded machine, and is still far below the broken renderer.
for (const [name, source] of [
  ["unclosed declarations", "a <!X ".repeat(80_000)],
  ["unclosed processing instructions", "a <? ".repeat(160_000)],
]) {
  test(`${name} render in linear time`, () => {
    const started = process.hrtime.bigint();
    renderMarkdown(source);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 2000, `took ${Math.round(elapsedMs)} ms`);
  });
}

// --- Section wrapping and slugs --------------------------------------------

test("every heading opens a section with a stable id", () => {
  const ids = sections(renderMarkdown(fixture("headings.md")).html);
  assert.deepEqual(ids, [
    "preamble",
    "alpha",
    "beta",
    "gamma",
    "beta-1",
    "alpha-1",
  ]);
});

test("content before the first heading still gets a scope", () => {
  // Without this, every anchor in the preamble would resolve against <body>,
  // and an edit anywhere in the document would shift all of them at once.
  const html = renderMarkdown("Intro.\n\n# H\n").html;
  assert.ok(html.includes('<section id="preamble">'));
});

test("a document that opens with a heading has no preamble section", () => {
  const html = renderMarkdown("# H\n\nBody.\n").html;
  assert.ok(!html.includes('id="preamble"'));
});

test("sections nest by heading level and close correctly", () => {
  const html = renderMarkdown("# A\n\n## B\n\n### C\n\n## D\n\n# E\n").html;
  const opens = (html.match(/<section /g) || []).length;
  const closes = (html.match(/<\/section>/g) || []).length;
  assert.equal(opens, closes, "unbalanced sections");
  assert.equal(opens, 5);
});

test("editing one heading does not renumber unrelated slugs", () => {
  // Anchors scope to the nearest id-bearing ancestor, so a renumber would
  // silently re-scope every anchor below the edit.
  const before = sections(renderMarkdown("# A\n\n## Notes\n\n## Other\n\n## Notes\n").html);
  const after = sections(renderMarkdown("# A\n\n## Notes\n\n## Renamed\n\n## Notes\n").html);
  assert.deepEqual(before, ["a", "notes", "other", "notes-1"]);
  assert.deepEqual(after, ["a", "notes", "renamed", "notes-1"]);
});

test("a heading called Preamble cannot collide with the wrapper", () => {
  const ids = sections(renderMarkdown("Intro.\n\n# Preamble\n").html);
  assert.deepEqual(ids, ["preamble", "preamble-1"]);
});

test("slugs strip inline markup and non-alphanumerics", () => {
  assert.equal(baseSlug("**Bold** heading!"), "bold-heading");
  assert.equal(baseSlug("`code` in a heading"), "code-in-a-heading");
  assert.equal(baseSlug("[linked](https://x.test)"), "linked");
  assert.equal(baseSlug("   "), "section");
  assert.equal(baseSlug("!!!"), "section");
});

test("the slugger dedupes in document order", () => {
  const s = new Slugger();
  assert.equal(s.slug("Notes"), "notes");
  assert.equal(s.slug("Notes"), "notes-1");
  assert.equal(s.slug("Notes"), "notes-2");
});

// --- Output shape ----------------------------------------------------------

test("output is self-contained: no external URLs in head", () => {
  const html = renderMarkdown(fixture("kitchen-sink.md")).html;
  const head = html.slice(0, html.indexOf("</head>"));
  assert.ok(!/<link\b/i.test(head), "an external stylesheet reference appeared");
  assert.ok(!/src=["']https?:/i.test(head), "an external script appeared");
  assert.ok(head.includes("<style"), "the theme should be embedded");
});

test("raw HTML including script passes through so the trust model governs it", () => {
  // One concept, not two: a script-bearing Markdown document is sandboxed and
  // prompts for trust exactly like a hand-authored bundle (SPEC §6c).
  const html = renderMarkdown(fixture("script.md")).html;
  assert.ok(html.includes("<script>"));
  assert.ok(html.includes('<div id="chart">'));
});

test("the title comes from the first level-1 heading", () => {
  assert.equal(titleFromMarkdown("# Alpha\n\n# Beta\n", "fallback"), "Alpha");
  assert.equal(titleFromMarkdown("Alpha\n=====\n", "fallback"), "Alpha");
  assert.equal(titleFromMarkdown("## Only h2\n", "fallback"), "fallback");
  assert.equal(renderMarkdown("# Alpha\n").title, "Alpha");
});

test("the title is HTML-escaped in the output", () => {
  const html = renderMarkdown("# <script>alert(1)</script>\n").html;
  assert.ok(html.includes("<title>&lt;script&gt;"), "the title element must be escaped");
});

test("task list items render as inert checkboxes", () => {
  const html = renderMarkdown("- [x] done\n- [ ] open\n").html;
  assert.ok(html.includes('<input type="checkbox" disabled checked>'));
  assert.ok(html.includes('<input type="checkbox" disabled>'));
  assert.ok(html.includes('class="task-list-item"'));
});

test("linkify and typographer stay off", () => {
  // Both are normalizations the author did not ask for, and both would make the
  // round trip lossy.
  const html = renderMarkdown("Visit https://example.com -- really...\n").html;
  assert.ok(!html.includes("<a href"), "a bare URL was auto-linked");
  assert.ok(html.includes("--"), "typographer rewrote punctuation");
});
