// SPDX-License-Identifier: Apache-2.0
// The Markdown reading an agent gets of an HTML document, and how get_document pages it (SPEC §19, ADR 0030).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const admin = require("firebase-admin");
const domino = require("@mixmark-io/domino");

const {
  BUILT_BY_SCRIPT,
  READ_PARSE_CHARS,
  STOPS_EARLY,
  composeReading,
  readingMarkdown,
  readingPreamble,
  resolveAddress,
  stripForReading,
} = require("../lib/lib/markdown/reading.js");
const { textBlocks } = require("../lib/lib/quote.js");
const { TOOLS, pageEnd } = require("../lib/mcp/tools.js");

const ROOT = join(__dirname, "..", "..");
const PLACE = { origin: "https://bikeshed.example", docId: "plan", versionId: "v2", entry: "index.html", k: null };
const read = (html, place = PLACE) => readingMarkdown(html, place);
const none = () => ({ scripts: 0, stylesheets: 0, figures: 0, embeds: 0, inlineImages: 0, hidden: 0, formControls: 0 });

/** Every published sample and guide: the documents a reading has to be right about. */
const BUNDLES = readdirSync(join(ROOT, "content"))
  .map((name) => join(ROOT, "content", name, "bundle", "index.html"))
  .filter((path) => existsSync(path))
  .map((path) => ({ path, html: readFileSync(path, "utf8") }));

// --- The strip ---------------------------------------------------------------

test("an inline image's bytes never reach the parser, let alone the reading", () => {
  // A page can be 25 MiB of base64; the strip empties a data: value to its
  // scheme before anything builds a tree out of it.
  const payload = "iVBORw0KGgo".repeat(5000);
  const html = `<p>Before</p><img alt="Chart" src="data:image/png;base64,${payload}"><a href=' data:text/html,${payload}'>x</a><p>After</p>`;
  const stripped = stripForReading(html, none());
  assert.ok(!stripped.includes(payload), "the payload is gone before parsing");
  const r = read(html);
  assert.ok(!r.body.includes("data:"), "no data: address in the reading");
  assert.match(r.body, /\[image: Chart\]/);
  assert.equal(r.leftOut.inlineImages, 1);
});

test("scripts, stylesheets and comments are removed and counted, not read as prose", () => {
  const leftOut = none();
  const stripped = stripForReading(
    '<head><link rel="stylesheet" href="a.css"><style>p{color:red}</style></head>' +
      "<body><!-- note --><script>var x = '<p>not text</p>';</script><SCRIPT type=module>go()</SCRIPT><p>Words</p></body>",
    leftOut,
  );
  assert.deepEqual([leftOut.scripts, leftOut.stylesheets], [2, 2]);
  for (const gone of ["color:red", "not text", "go()", "note"]) assert.ok(!stripped.includes(gone), `${gone} is stripped`);
  assert.match(stripped, /<p>Words<\/p>/);
});

test("hostile markup costs linear time", () => {
  // Every one of these would be quadratic, or worse, in a regular expression
  // with backtracking: unterminated openers, quotes and comments by the
  // hundred thousand. Generous, because a loaded machine is slower; a
  // quadratic scan of these inputs takes minutes, not seconds.
  for (const hostile of ["<script".repeat(100_000), '<a href="'.repeat(100_000), "<!--".repeat(100_000), "<".repeat(500_000)]) {
    const started = Date.now();
    read(hostile);
    assert.ok(Date.now() - started < 5000, `${hostile.slice(0, 8)}… took ${Date.now() - started} ms`);
  }
});

test("a page too long to read whole says so, in the reading and the result", () => {
  const html = `<p>${"word ".repeat(Math.ceil(READ_PARSE_CHARS / 5) + 10)}</p><p>THE END</p>`;
  const r = read(html);
  assert.equal(r.cut, true);
  assert.ok(r.warnings.includes(STOPS_EARLY));
  assert.ok(!r.body.includes("THE END"), "the reading stops before the end");
  assert.equal(read("<p>short</p>").cut, false);
});

// --- What the reading says ---------------------------------------------------

test("no HTML reaches a reading, whatever the page is made of", () => {
  const html = `
    <my-widget data-x="1"><span>Custom <b>element</b></span></my-widget>
    <div class="grid"><section><details><summary>More</summary><p>Folded</p></details></section></div>
    <table><tr><td>no</td><td>header</td></tr><tr><td>a</td><td>b</td></tr></table>
    <video src="clip.mp4" title="Demo"></video><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>
    <iframe src="https://example.com/embed" title="Map"></iframe><object data="x.pdf"></object>
    <form><label>Name <input name="n"></label><button>Send</button><select><option>A</option></select></form>`;
  const r = read(html);
  assert.ok(!/<[a-z!/]/i.test(r.body), `raw HTML leaked into:\n${r.body}`);
  assert.match(r.body, /Custom \*\*element\*\*/);
  assert.match(r.body, /Folded/);
});

test("the published samples and guides read without HTML", () => {
  // A `<name` in a reading is either text the page shows — written `&lt;name`
  // in its source, as in "https://<deployment>" — or an element that leaked.
  for (const { path, html } of BUNDLES) {
    const r = read(html);
    for (const [, name] of r.body.matchAll(/<\/?([a-z][a-z0-9-]*)/gi)) {
      assert.ok(html.toLowerCase().includes(`&lt;${name.toLowerCase()}`), `${path}: <${name} is not text in the page`);
    }
  }
});

/** The text a comment is anchored against, with what a reading drops taken out first. */
function anchorBlocks(html) {
  const doc = domino.createDocument(html);
  for (const el of [...doc.querySelectorAll('[hidden], [aria-hidden="true"], input, select, textarea, button, canvas, video, audio, iframe, object')]) el.remove();
  for (const el of [...doc.querySelectorAll("[style]")]) {
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute("style"))) el.remove();
  }
  return textBlocks(doc.documentElement.outerHTML);
}

/** A reading with its Markdown marks taken out: the words an agent would quote. */
function words(markdown) {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
  // Inside a fence, a line starting "# " is a shell comment, not a heading.
  const parts = body.split(/^```[^\n]*$/m).map((part, i) =>
    i % 2 === 1
      ? part
      : part
          .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
          .replace(/\[(?:figure|image|embedded|video|audio)(?::[^\]]*)?\](?:\([^)]*\))?/g, " ")
          .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/^ {0,3}(?:#{1,6} |[-+] {1,3}|\d+\. {1,2}|> ?)/gm, ""),
  );
  return parts
    .join(" ")
    .replace(/\\\|/g, "|")
    .replace(/[*`~]/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ");
}

test("every passage a comment can anchor to reads word for word", () => {
  /**
   * The reading is unescaped so that an agent quoting its words quotes the
   * document's: `add_comment` locates a quote in the page's text
   * (`lib/quote.ts`). Escaping `*`, `_` or `[` would make every quote with
   * one in it a refusal. So every block of the page's text, from every
   * sample, has to appear in the reading once its Markdown marks are gone.
   */
  for (const { path, html } of BUNDLES) {
    const reading = words(read(html).body);
    for (const block of anchorBlocks(html)) {
      // A block's own text may start with what reads as a marker ("1. "), which
      // `words` takes off a line, so it comes off the block the same way.
      const want = block
        .replace(/^ {0,3}(?:#{1,6} |[-+] {1,3}|\d+\. {1,2}|> ?)/, "")
        .replace(/[*`~]/g, "")
        .replace(/\|/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!want) continue;
      assert.ok(reading.includes(want), `${path}: the reading lost "${want.slice(0, 80)}"`);
    }
  }
});

test("characters Markdown would escape are left as the author wrote them", () => {
  const r = read("<p>snake_case * stars [brackets] #hash 1. one</p>");
  assert.equal(r.body.trim(), "snake_case * stars [brackets] #hash 1. one");
});

test("what was left out is counted, category by category", () => {
  const html = `<head><style>x{}</style><link rel="stylesheet" href="s.css"></head>
    <body><script>a()</script><script>b()</script>
    <svg viewBox="0 0 1 1"><title>Growth</title><path d="M0 0"/></svg><canvas aria-label="Live chart"></canvas><math alttext="x^2"><mi>x</mi></math>
    <iframe src="https://example.com/x" title="Map"></iframe><embed src="a.swf"><object data="b.pdf"></object>
    <img src="data:image/png;base64,AAAA" alt="Inline">
    <div hidden><p>secret</p></div><p aria-hidden="true">icon</p><p style="display: none">gone</p>
    <button>Copy</button><input type="text"><input type="checkbox" checked> Done
    <p>${"Real words here. ".repeat(20)}</p></body>`;
  const r = read(html);
  assert.deepEqual(r.leftOut, { scripts: 2, stylesheets: 2, figures: 3, embeds: 3, inlineImages: 1, hidden: 3, formControls: 2 });
  assert.match(r.body, /\[figure: Growth\]/);
  assert.match(r.body, /\[figure: Live chart\]/);
  assert.match(r.body, /\[figure: x\^2\]/);
  assert.match(r.body, /\[embedded: Map\]\(https:\/\/example\.com\/x\)/);
  assert.match(r.body, /\[x\] +Done/);
  for (const gone of ["secret", "icon", "gone", "Copy"]) assert.ok(!r.body.includes(gone), `${gone} is left out`);
  assert.deepEqual(r.warnings, []);
});

test("a page its script builds is flagged, a page with words is not", () => {
  const built = read('<div id="app"></div><script src="app.js"></script>');
  assert.deepEqual(built.warnings, [BUILT_BY_SCRIPT]);
  // A script that only decorates leaves the words in place.
  const decorated = read(`<p>${"An actual paragraph of prose. ".repeat(12)}</p><script>highlight()</script>`);
  assert.deepEqual(decorated.warnings, []);
  // Without a script, a short page is just short.
  assert.deepEqual(read("<p>Hi.</p>").warnings, []);
  for (const { path, html } of BUNDLES) {
    assert.ok(!read(html).warnings.includes(BUILT_BY_SCRIPT), `${path} is not built by its script`);
  }
});

test("a table without a header row is still a table, with its pipes escaped", () => {
  const r = read('<table><tr><td>a|b</td><td colspan="2">wide</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>');
  assert.equal(r.body.trim(), "| a\\|b | wide | |\n| --- | --- | --- |\n| 1 | 2 | 3 |");
  const nested = read("<table><tr><th>Outer</th></tr><tr><td><table><tr><td>inner</td></tr></table></td></tr></table>");
  assert.match(nested.body, /^\| Outer \|\n\| --- \|\n/);
});

test("video, audio and figures leave a placeholder an agent can follow", () => {
  const r = read('<video title="Demo"><source src="media/clip.mp4"></video><audio src="talk.mp3"></audio><svg viewBox="0 0 1 1"></svg>');
  assert.match(r.body, /\[video: Demo\]\(https:\/\/bikeshed\.example\/content\/plan\/v2\/media\/clip\.mp4\)/);
  assert.match(r.body, /\[audio: talk\.mp3\]\(https:\/\/bikeshed\.example\/content\/plan\/v2\/talk\.mp3\)/);
  // An SVG with no text is "blank" to the converter, which skips its rules:
  // the placeholder has to come from the blank path too.
  assert.match(r.body, /\[figure\]/);
});

// --- Addresses ---------------------------------------------------------------

test("an address is absolute, inside the version, and keyed only when a key opened it", () => {
  assert.equal(resolveAddress("img/a.png", PLACE), "https://bikeshed.example/content/plan/v2/img/a.png");
  assert.equal(
    resolveAddress("img/a.png", { ...PLACE, k: "Key_123" }),
    "https://bikeshed.example/content/~Key_123/plan/v2/img/a.png",
  );
  assert.equal(resolveAddress("../a.png", { ...PLACE, entry: "guide/index.html" }), "https://bikeshed.example/content/plan/v2/a.png");
  assert.equal(resolveAddress("/d/other", { ...PLACE, k: "Key_123" }), "https://bikeshed.example/d/other", "no key outside the version");
  assert.equal(resolveAddress("https://elsewhere.example/x?y=1", PLACE), "https://elsewhere.example/x?y=1");
  assert.equal(resolveAddress("mailto:a@example.com", PLACE), "mailto:a@example.com");
  for (const dropped of ["javascript:alert(1)", "#section", "", "file:///etc/passwd", "data:text/plain,hi"]) {
    assert.equal(resolveAddress(dropped, PLACE), null, dropped);
  }
  // A deployment with no origin configured: paths, never a made-up host.
  assert.equal(resolveAddress("a.png", { ...PLACE, origin: "" }), "/content/plan/v2/a.png");
  const r = read('<p><a href="javascript:go()">Run</a> and <a href="#top">top</a></p>');
  assert.equal(r.body.trim(), "Run and top");
});

// --- The preamble ------------------------------------------------------------

test("the preamble says it is a reading, what it left out, and where the original is", () => {
  const leftOut = { ...none(), scripts: 1, figures: 2 };
  const text = readingPreamble({
    title: 'Plan: "v2"',
    document: "https://bikeshed.example/d/plan",
    version: "v2",
    original: "https://bikeshed.example/content/plan/v2/index.html",
    leftOut,
    warnings: [BUILT_BY_SCRIPT],
  });
  assert.match(text, /^---\nreading: "A Markdown reading of this document, made by Bikeshed for agents\. It is not the source: never send it back as an update\./);
  const fields = Object.fromEntries(
    text.split("\n").filter((l) => /^[a-z-]+: "/.test(l)).map((l) => [l.slice(0, l.indexOf(":")), JSON.parse(l.slice(l.indexOf(":") + 2))]),
  );
  assert.equal(fields.title, 'Plan: "v2"', "a quote or colon in a title cannot break the front matter");
  assert.equal(fields.original, "https://bikeshed.example/content/plan/v2/index.html");
  assert.match(fields["original-through"], /as: "source"/);
  assert.equal(fields["left-out"], "styling and layout, 1 script, 2 figures drawn in code");
  assert.match(text, /\nwarnings:\n {2}- "This page builds its content with a script/);
  assert.match(text, /\n---\n$/);
  assert.equal(composeReading(text, { body: "Body\n" }), `${text}\nBody\n`);
});

// --- get_document ------------------------------------------------------------

/** One HTML or Markdown document, its bytes in memory, read through the real tool. */
async function getDocument(args, { html, md = null, files = ["index.html"], basis = "member" } = {}) {
  const tool = TOOLS.find((t) => t.name === "get_document");
  const saved = Object.getOwnPropertyDescriptor(admin, "storage");
  const before = [process.env.BIKESHED_BUCKET, process.env.BIKESHED_PUBLIC_ORIGIN];
  const objects = { "docs/plan/v1/index.html": html, ...(md !== null ? { "docs/plan/v1/index.md": md } : {}) };
  Object.defineProperty(admin, "storage", {
    configurable: true,
    value: () => ({
      bucket: () => ({
        file: (key) => ({
          download: async () => {
            if (!(key in objects)) throw new Error(`no ${key}`);
            return [Buffer.from(objects[key])];
          },
        }),
      }),
    }),
  });
  process.env.BIKESHED_BUCKET = "test-bucket";
  process.env.BIKESHED_PUBLIC_ORIGIN = "https://bikeshed.example";
  try {
    const caller = { uid: "u1", emailLower: "owner@example.com" };
    const data =
      basis === "member"
        ? { ownerUid: "u1", members: [caller.emailLower], currentVersion: "v1", title: "Plan" }
        : { ownerUid: "u9", members: [], currentVersion: "v1", title: "Plan", visibility: "unlisted", linkToken: "LinkKey0123456789abcdef" };
    const version = {
      exists: true,
      data: () => ({ entry: "index.html", format: md !== null ? "markdown" : "html", files, ...(md !== null ? { sourceEntry: "index.md" } : {}) }),
    };
    const none = { orderBy: () => none, limit: () => none, where: () => none, get: async () => ({ docs: [], empty: true }) };
    const ref = {
      id: "plan",
      get: async () => ({ exists: true, data: () => data }),
      collection: (name) => ({ ...none, doc: () => (name === "versions" ? { get: async () => version } : { get: async () => ({ exists: false }), set: async () => {} }) }),
    };
    const db = { collection: () => ({ doc: () => ref }) };
    return await tool.run({ db, caller, actor: { tokenId: "t1" } }, { id: "plan", ...args });
  } finally {
    if (saved) Object.defineProperty(admin, "storage", saved);
    else delete admin.storage;
    [process.env.BIKESHED_BUCKET, process.env.BIKESHED_PUBLIC_ORIGIN] = before;
    if (before[0] === undefined) delete process.env.BIKESHED_BUCKET;
    if (before[1] === undefined) delete process.env.BIKESHED_PUBLIC_ORIGIN;
  }
}

const PAGE = '<!doctype html><html><head><style>body{}</style></head><body><h1>Plan</h1><p>Ship in <b>two</b> weekends.</p><img src="chart.png" alt="Chart"></body></html>';

test("an HTML document reads as Markdown by default, flagged before the body", async () => {
  const r = await getDocument({}, { html: PAGE, files: ["index.html", "chart.png"] });
  assert.equal(r.as, "markdown");
  assert.equal(r.source, undefined);
  assert.match(r.markdown, /^---\nreading: "A Markdown reading/);
  assert.match(r.markdown, /\n---\n\n# Plan\n\nShip in \*\*two\*\* weekends\.\n\n!\[Chart\]\(https:\/\/bikeshed\.example\/content\/plan\/v1\/chart\.png\)\n$/);
  assert.deepEqual(r.original, {
    as: "source",
    url: "https://bikeshed.example/content/plan/v1/index.html",
    files: 2,
    download: "https://bikeshed.example/download/plan/v1",
  });
  const text = JSON.stringify(r);
  for (const flag of ['"as":', '"original":', '"truncated":', '"total":']) {
    assert.ok(text.indexOf(flag) < text.indexOf('"markdown":'), `${flag} must precede the body`);
  }
});

test('as: "source" is the stored HTML, byte for byte, with no preamble', async () => {
  const r = await getDocument({ as: "source" }, { html: PAGE });
  assert.equal(r.as, "source");
  assert.equal(r.source, PAGE);
  assert.equal(r.markdown, undefined);
  assert.equal(r.original, undefined);
  assert.equal(r.truncated, false);
  assert.equal(r.nextOffset, undefined);
});

test("a Markdown document returns its source, whatever as says", async () => {
  for (const as of [undefined, "markdown", "source"]) {
    const r = await getDocument(as ? { as } : {}, { html: PAGE, md: "# Plan\n\nShip it.\n" });
    assert.equal(r.as, "source");
    assert.equal(r.source, "# Plan\n\nShip it.\n", "never a preamble on a source");
  }
  await assert.rejects(getDocument({ as: "html" }, { html: PAGE }), /as must be "markdown" or "source"/);
});

test("an unlisted document's reading carries its key on the version's own addresses", async () => {
  const k = "LinkKey0123456789abcdef";
  const r = await getDocument({ k }, { html: PAGE, basis: "link", files: ["index.html", "chart.png"] });
  assert.equal(r.original.url, `https://bikeshed.example/content/~${k}/plan/v1/index.html`);
  assert.equal(r.original.download, `https://bikeshed.example/download/plan/v1?k=${k}`);
  assert.match(r.markdown, new RegExp(`document: "https://bikeshed\\.example/d/plan\\?k=${k}"`));
  assert.match(r.markdown, new RegExp(`\\(https://bikeshed\\.example/content/~${k}/plan/v1/chart\\.png\\)`));
  // A member's reading hands out no key, even when one was sent along.
  const member = await getDocument({ k }, { html: PAGE });
  assert.ok(!member.markdown.includes(k) || member.markdown.indexOf(k) === member.markdown.indexOf(`?k=${k}`), "only the reader address names it");
  assert.ok(!member.original.url.includes("~"));
});

test("a long document comes in pages from one version, and the pages are the whole", async () => {
  const paragraphs = Array.from({ length: 9000 }, (_, i) => `<p>Paragraph ${i} of the plan, with enough words to fill a page.</p>`).join("");
  const html = `<!doctype html><body>${paragraphs}</body>`;

  // The source, paged, is the stored bytes exactly.
  let offset = 0;
  let source = "";
  for (;;) {
    const page = await getDocument({ as: "source", version: "v1", ...(offset ? { offset } : {}) }, { html });
    assert.equal(page.total, html.length);
    source += page.source;
    if (!page.truncated) break;
    assert.equal(page.nextOffset, offset + page.source.length);
    offset = page.nextOffset;
  }
  assert.equal(source, html);

  // The reading, paged, starts with its preamble and ends with the last paragraph.
  offset = 0;
  let reading = "";
  let pages = 0;
  for (;;) {
    const page = await getDocument({ version: "v1", ...(offset ? { offset } : {}) }, { html });
    reading += page.markdown;
    pages++;
    if (!page.truncated) break;
    offset = page.nextOffset;
  }
  assert.ok(pages > 1, "it took more than one page");
  assert.match(reading, /^---\nreading:/);
  assert.match(reading, /Paragraph 8999 of the plan, with enough words to fill a page\.\n$/);

  await assert.rejects(getDocument({ offset: 10 }, { html }), /pass the version you read first/);
  await assert.rejects(getDocument({ version: "v1", offset: 10 ** 9 }, { html }), /past the end/);
  await assert.rejects(getDocument({ version: "v1", offset: -1 }, { html }), /offset must be a whole number/);
  await assert.rejects(getDocument({ version: "v1", offset: 1.5 }, { html }), /offset must be a whole number/);
});

test("a page never ends between the two halves of a character", () => {
  const text = `${"a".repeat(9)}😀${"b".repeat(5)}`;
  assert.equal(pageEnd(text, 0, 10), 9, "the emoji starts at 9 and would be split at 10");
  assert.equal(pageEnd(text, 0, 11), 11);
  assert.equal(pageEnd(text, 0, 100), text.length);
  assert.equal(text.slice(0, pageEnd(text, 0, 10)) + text.slice(pageEnd(text, 0, 10)), text);
});
