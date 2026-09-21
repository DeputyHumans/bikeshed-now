// SPDX-License-Identifier: Apache-2.0
// What a document's own <head> and first words say about it (SPEC §17).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const { HEAD_SCAN_BYTES, readHead, titleFromHtml } = require("../lib/lib/head.js");

const CONTENT = join(__dirname, "..", "..", "content");

/** A document with the given head markup and body markup. */
function doc(head, body = "<p>Body.</p>") {
  return `<!DOCTYPE html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
}

/** Wall-clock milliseconds a call takes. */
function timed(fn) {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

// The adversarial cases must each finish well inside a request budget. 200 ms
// is generous for a linear scan of 256 KiB and far below what a quadratic one
// takes, so the bound separates the two without flaking on a slow machine.
const TIME_BUDGET_MS = 200;

test("HEAD_SCAN_BYTES is 256 KiB", () => {
  assert.equal(HEAD_SCAN_BYTES, 256 * 1024);
});

test("a full head yields title, description, keywords and og:image", () => {
  const html = doc(
    '<meta charset="utf-8">' +
      "<title>Plan for Q3</title>" +
      '<meta name="description" content="What we will do next quarter.">' +
      '<meta name="keywords" content="plan, quarter, roadmap">' +
      '<meta property="og:image" content="https://example.com/cover.png">',
  );
  assert.deepEqual(readHead(html), {
    title: "Plan for Q3",
    description: "What we will do next quarter.",
    keywords: "plan, quarter, roadmap",
    image: "https://example.com/cover.png",
  });
});

test("titleFromHtml is readHead's title", () => {
  assert.equal(titleFromHtml(doc("<title>Only this</title>")), "Only this");
  assert.equal(titleFromHtml(doc("")), null);
});

test("tag and attribute names are case-insensitive", () => {
  const html = doc(
    "<TITLE>Shouted</TITLE>" + '<META NAME="description" CONTENT="Loud words.">',
  );
  const head = readHead(html);
  assert.equal(head.title, "Shouted");
  assert.equal(head.description, "Loud words.");
});

test("attribute values are quote-aware: a > inside quotes does not end the tag", () => {
  const head = readHead(doc('<meta name="description" content="a > b">'));
  assert.equal(head.description, "a > b");
});

test("single-quoted and bare attribute values are read", () => {
  const head = readHead(
    doc(
      "<meta name='description' content='Single quoted.'>" +
        "<meta name=keywords content=bare>",
    ),
  );
  assert.equal(head.description, "Single quoted.");
  assert.equal(head.keywords, "bare");
});

test("an svg <title> in the body is not the document title", () => {
  const html = doc("", "<p>Intro.</p><svg><title>Logo</title></svg>");
  assert.equal(readHead(html).title, null);
  // Without a <body> tag the whole document is the head region, and only the
  // pre-strip stands between the svg's accessible title and the result.
  const noBodyTag = "<html><head></head><p>Intro.</p><svg><title>Logo</title></svg></html>";
  assert.equal(readHead(noBodyTag).title, null);
});

test("a <title> in the body is not the document title", () => {
  const html = doc("", "<title>In body</title><p>Intro.</p>");
  assert.equal(readHead(html).title, null);
});

test("a real <title> after an svg in the head is the document title", () => {
  const html = doc("<svg><title>Logo</title></svg><title>Real</title>");
  assert.equal(readHead(html).title, "Real");
});

test("a commented-out <title> before the real one is ignored", () => {
  const html = doc("<!-- <title>Draft</title> --><title>Real</title>");
  assert.equal(readHead(html).title, "Real");
  // A `>` inside the comment would end it early for a scanner that treated
  // `<!--` as an ordinary tag rather than stripping the whole comment.
  const withArrow = doc("<!-- a -> b <title>Draft</title> --><title>Real</title>");
  assert.equal(readHead(withArrow).title, "Real");
});

test("a <title> inside a head <script> string is ignored", () => {
  const html = doc('<script>var t = "<title>Nope</title>";</script><title>Real</title>');
  assert.equal(readHead(html).title, "Real");
  assert.equal(readHead(doc('<script>var t = "<title>Nope</title>";</script>')).title, null);
});

test("entities in the title are decoded", () => {
  const html = doc("<title>A &mdash; B&nbsp;C&rsquo;s &#169; &#x2014; D &lt;E&gt; &amp; &bogus;</title>");
  assert.equal(readHead(html).title, "A — B C’s © — D <E> & &bogus;");
});

test("an entity named like an Object.prototype member is unknown, not a lookup", () => {
  const html = doc("<title>Q&constructor;A &__proto__; &hasOwnProperty;</title>");
  assert.equal(readHead(html).title, "Q&constructor;A &__proto__; &hasOwnProperty;");
});

test("title text and attribute values are each decoded exactly once", () => {
  // `&amp;amp;` is `&amp;` after one pass, as a browser reads it; a second
  // pass would take it on to `&`, and no pass at all would leave `&amp;amp;`.
  const html = doc(
    "<title>Q&amp;amp;A</title>" +
      '<meta name="description" content="Use &amp;amp; for &amp;lt;b&amp;gt;">',
    '<h1>T</h1><img src="a.png?x=1&amp;amp;y=2">',
  );
  const head = readHead(html);
  assert.equal(head.title, "Q&amp;A");
  assert.equal(head.description, "Use &amp; for &lt;b&gt;");
  assert.equal(head.image, "a.png?x=1&amp;y=2");
});

test("an <img> src is trimmed and capped but otherwise left as written", () => {
  const spaced = doc("<title>T</title>", '<h1>T</h1><img src="  my   photo.png ">');
  assert.equal(readHead(spaced).image, "my   photo.png");
  const long = doc("<title>T</title>", `<h1>T</h1><img src="${"x".repeat(3000)}.png">`);
  assert.equal(readHead(long).image.length, 2048);
});

test("a <title> directly under <html> with no <head> element is still found", () => {
  const html = "<html><title>Bare</title><body><p>Hi.</p></body></html>";
  assert.equal(readHead(html).title, "Bare");
});

test("og:title stands in when there is no <title>", () => {
  const html = doc('<meta property="og:title" content="From og">');
  assert.equal(readHead(html).title, "From og");
});

test("a <title> beats og:title", () => {
  const html = doc('<meta property="og:title" content="From og"><title>Real</title>');
  assert.equal(readHead(html).title, "Real");
});

test("og:description stands in when there is no meta description", () => {
  const html = doc('<meta property="og:description" content="From og.">', "<p>Body words.</p>");
  assert.equal(readHead(html).description, "From og.");
});

test("the description falls back to the first words after the first </h1>", () => {
  const html = doc("<title>T</title>", "<h1>Title</h1><p>First words here.</p>");
  assert.equal(readHead(html).description, "First words here.");
});

test("a <nav> of links between the <h1> and the first paragraph is skipped", () => {
  const html = doc(
    "<title>T</title>",
    '<h1>Title</h1><nav><a href="#a">One</a> <a href="#b">Two</a></nav><p>First words here.</p>',
  );
  assert.equal(readHead(html).description, "First words here.");
});

test("without an <h1> the excerpt starts after the <body> tag", () => {
  const html = doc("<title>T</title>", "<p>Straight in.</p>");
  assert.equal(readHead(html).description, "Straight in.");
});

test("a long paragraph is cut on a word boundary with an ellipsis", () => {
  const paragraph = "alpha beta gamma delta epsilon ".repeat(40).trim();
  assert.ok(paragraph.length >= 1000);
  // The 200th character must fall inside a word, or the test cannot tell a
  // cut on a word boundary from a cut at exactly 200.
  assert.notEqual(paragraph[199], " ");
  assert.notEqual(paragraph[200], " ");
  const html = doc("<title>T</title>", `<h1>Title</h1><p>${paragraph}</p>`);
  const { description } = readHead(html);
  assert.ok(description.length <= 201, `length ${description.length}`);
  assert.ok(description.endsWith("…"), description);
  const cut = description.slice(0, -1);
  assert.ok(paragraph.startsWith(cut + " "), `not on a word boundary: ${JSON.stringify(cut.slice(-20))}`);
});

test("a short excerpt is not cut and gets no ellipsis", () => {
  const html = doc("<title>T</title>", "<h1>Title</h1><p>Short.</p>");
  assert.equal(readHead(html).description, "Short.");
});

test("the excerpt decodes entities and collapses whitespace", () => {
  const html = doc("<title>T</title>", "<h1>Title</h1><p>\n  Tom&nbsp;&amp;\n\tJerry  &mdash; friends.\n</p>");
  assert.equal(readHead(html).description, "Tom & Jerry — friends.");
});

test("minified markup still separates its blocks in the excerpt", () => {
  // No whitespace between tags, so the tag itself is the only boundary.
  const html = doc("<title>T</title>", "<h1>T</h1><p>First.</p><p>Second.</p><ul><li>one</li><li>two</li></ul>");
  assert.equal(readHead(html).description, "First. Second. one two");
});

test("a line break separates the words on either side of it", () => {
  const html = doc("<title>T</title>", "<h1>T</h1><p>Line one<br>Line two</p>");
  assert.equal(readHead(html).description, "Line one Line two");
});

test("an inline element does not split the word it sits in", () => {
  const html = doc(
    "<title>T</title>",
    '<h1>T</h1><p>un<em>believable</em>, <b>bold</b>ly <a href="#">linked</a><sup>1</sup>.</p>',
  );
  assert.equal(readHead(html).description, "unbelievable, boldly linked1.");
});

test("with neither <body> nor <h1>, the excerpt starts after the head, not at the title", () => {
  // Nothing marks where the body begins, so the title would otherwise lead
  // the description: "Bare Hi there.".
  assert.equal(readHead("<html><head><title>Bare</title></head><p>Hi there.</p></html>").description, "Hi there.");
  assert.equal(readHead("<html><title>Bare</title><p>Hi there.</p></html>").description, "Hi there.");
  assert.equal(readHead("<p>Hi there.</p>").description, "Hi there.");
});

test("an empty body yields no description", () => {
  const html = doc("<title>T</title>", "<h1>Title</h1><div></div>");
  assert.equal(readHead(html).description, null);
});

test("the image fallback is the first raster <img>, returned raw", () => {
  const html = doc(
    "<title>T</title>",
    '<h1>Title</h1><img src="diagram.svg" alt=""><img src="./photo.PNG?x=1" alt=""><img src="other.jpg">',
  );
  assert.equal(readHead(html).image, "./photo.PNG?x=1");
});

test("an svg-only body yields no image", () => {
  const html = doc("<title>T</title>", '<h1>Title</h1><img src="diagram.svg" alt="">');
  assert.equal(readHead(html).image, null);
});

test("a declared og:image wins over any <img>", () => {
  const html = doc(
    '<title>T</title><meta property="og:image" content="https://example.com/og.png">',
    '<h1>Title</h1><img src="first.png" alt="">',
  );
  assert.equal(readHead(html).image, "https://example.com/og.png");
});

test("twitter:image stands in for og:image under name= or property=", () => {
  assert.equal(
    readHead(doc('<meta name="twitter:image" content="https://example.com/t.png">')).image,
    "https://example.com/t.png",
  );
  assert.equal(
    readHead(doc('<meta property="twitter:image" content="https://example.com/p.png">')).image,
    "https://example.com/p.png",
  );
});

test("every value is whitespace-collapsed, trimmed and capped", () => {
  const long = "x".repeat(250);
  const html = doc(
    `<title>\n  Spaced \t out  </title><meta name="keywords" content="  a,\n b  ">` +
      `<meta name="description" content="${long} ${long}">`,
  );
  const head = readHead(html);
  assert.equal(head.title, "Spaced out");
  assert.equal(head.keywords, "a, b");
  assert.equal(head.description.length, 300);
  assert.equal(readHead(doc(`<title>${long}</title>`)).title.length, 200);
  assert.equal(readHead(doc("<title>   </title>")).title, null);
});

test("what lies past HEAD_SCAN_BYTES is not described", () => {
  const padding = `<!-- ${"p".repeat(1000)} -->`.repeat(Math.ceil(HEAD_SCAN_BYTES / 1000));
  const html = `<html><head>${padding}<title>Too late</title></head><body></body></html>`;
  assert.ok(html.indexOf("<title>") > HEAD_SCAN_BYTES);
  assert.equal(readHead(html).title, null);
});

for (const [name, path, title, excerpt] of [
  [
    "bikeshed-tour",
    "bikeshed-tour",
    "A tour of Bikeshed",
    "Publish a document. Collect comments anchored to the exact passage they are about. Revise, and publish again.",
  ],
  [
    "design-review-shortener",
    "design-review-shortener",
    "Design review: a link shortener",
    "Design review · draft for comment We want short, stable, shareable links that resolve fast and cannot be guessed.",
  ],
  [
    "deck-quarter-review",
    "deck-quarter-review",
    "Quarter review",
    "Where the work went, what it bought us, and the two decisions that are still open.",
  ],
]) {
  test(`the ${name} sample yields its own title and first words`, () => {
    const html = readFileSync(join(CONTENT, path, "bundle", "index.html"), "utf8");
    const head = readHead(html);
    assert.equal(head.title, title);
    assert.ok(head.description.startsWith(excerpt), head.description);
    assert.ok(!head.description.startsWith("Summary The problem"), head.description);
  });
}

test("80,000 unterminated <meta openers scan in linear time", () => {
  const html = "<meta ".repeat(80_000) + "x".repeat(500 * 1024);
  const ms = timed(() => readHead(html));
  assert.ok(ms < TIME_BUDGET_MS, `took ${ms.toFixed(0)} ms`);
});

test("100,000 unclosed <script> openers scan in linear time", () => {
  const html = "<script>".repeat(100_000);
  const ms = timed(() => readHead(html));
  assert.ok(ms < TIME_BUDGET_MS, `took ${ms.toFixed(0)} ms`);
});

test("50,000 unclosed comment openers scan in linear time", () => {
  const html = "<!--".repeat(50_000);
  const ms = timed(() => readHead(html));
  assert.ok(ms < TIME_BUDGET_MS, `took ${ms.toFixed(0)} ms`);
});

test("65,536 openers before a whitespace run and a quoted > scan in linear time", () => {
  // Every opener reaches the same quote before the only `>`, and whether that
  // quote opens an attribute value is read off the whitespace behind it. That
  // walk has to be paid once for the quote, not once for every opener.
  const openers = HEAD_SCAN_BYTES / 4;
  const html = "<x".repeat(openers) + " ".repeat(HEAD_SCAN_BYTES / 2 - 2) + '">';
  assert.equal(html.length, HEAD_SCAN_BYTES);
  const ms = timed(() => readHead(html));
  assert.ok(ms < TIME_BUDGET_MS, `took ${ms.toFixed(0)} ms`);
});
