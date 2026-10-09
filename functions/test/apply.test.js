// SPDX-License-Identifier: Apache-2.0
// An accepted suggestion's change is made exactly where the browser would make it, or not at all (SPEC §22).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const { applyToHtml, applyToMarkdown, bodyText, spliceHtml } = require("../lib/lib/apply.js");
const { scanBody } = require("../lib/lib/quote.js");
const { decodeEntities } = require("../lib/lib/htmltext.js");
const { renderMarkdown } = require("../lib/lib/markdown/render.js");

const { cases } = JSON.parse(readFileSync(join(__dirname, "fixtures", "apply-vectors.json"), "utf8"));
const quoteCases = JSON.parse(readFileSync(join(__dirname, "fixtures", "quote-vectors.json"), "utf8")).cases;

test("every golden case gives exactly its expected answer", () => {
  assert.ok(cases.length >= 12, "there are cases to agree on");
  for (const c of cases) {
    const got = applyToHtml(c.html, c.anchor, c.replacement);
    if (c.expect.html) assert.deepEqual(got, { state: "applied", html: c.expect.html }, c.name);
    else if (c.expect.already) assert.deepEqual(got, { state: "already-applied" }, c.name);
    else assert.deepEqual(got, { state: "refused", reason: c.expect.refused }, c.name);
  }
});

test("the read-back refuses a change made anywhere but where it was asked for", () => {
  // The mapping never splices in the wrong place on purpose; this is the net
  // under it. Three bytes to the left of the quote is "in " → refused.
  const html = "<body><p>We can cut over in a single weekend.</p></body>";
  const at = html.indexOf("a single weekend");
  const expected = "We can cut over in two weekends.";
  assert.deepEqual(spliceHtml(html, at - 3, at - 3 + 16, "two weekends", expected), { state: "refused", reason: "unverified" });
  assert.equal(spliceHtml(html, at, at + 16, "two weekends", expected).state, "applied");
});

test("each character the scanner reads maps back to the bytes it came from", () => {
  // What lets a span of text become a span of source: a plain character is
  // its own byte, and an entity's characters all point at the whole entity.
  for (const html of [...quoteCases.map((c) => c.html), ...cases.map((c) => c.html)]) {
    const { chars, from, to } = scanBody(html);
    for (let k = 0; k < chars.length; k++) {
      const raw = html.slice(from[k], to[k]);
      if (raw.startsWith("&") && raw.length > 1) assert.ok(decodeEntities(raw).includes(chars[k]), raw);
      else assert.equal(raw, chars[k], `${JSON.stringify(raw)} in ${html.slice(0, 60)}`);
    }
  }
});

test("the text a deletion is measured in stops at its block, as the browser's does", () => {
  // "Frankly" ends one paragraph; the space after it belongs to the next one.
  const html = "<body><p>It is plain, frankly</p>\n<p>The rest.</p></body>";
  const got = applyToHtml(html, { exact: "frankly", prefix: "It is plain, ", suffix: "The rest" }, "");
  assert.deepEqual(got, { state: "applied", html: "<body><p>It is plain,</p>\n<p>The rest.</p></body>" });
});

const render = (md) => renderMarkdown(md, { title: "Plan" }).html;
const mdApply = (source, anchor, replacement) => applyToMarkdown(source, anchor, replacement, render);

test("a Markdown change is made in the source only where exactly one place renders as asked", () => {
  const source = "# Plan\n\nWe can cut over in a single\nweekend, and yes, that is enough.\n\nKeep `a single weekend` in the code.\n";
  const got = mdApply(source, { exact: "a single weekend", prefix: "cut over in ", suffix: ", and yes" }, "two weekends");
  assert.equal(got.state, "applied");
  assert.equal(
    got.markdown,
    "# Plan\n\nWe can cut over in two weekends, and yes, that is enough.\n\nKeep `a single weekend` in the code.\n",
    "the copy in a code span reads differently around it, and is left alone",
  );
  assert.equal(got.html, render(got.markdown));
});

test("a replacement that would render as Markdown is escaped, and only then", () => {
  const source = "Ship it soon.\n";
  const plain = mdApply(source, { exact: "soon", prefix: "Ship it ", suffix: "." }, "this week");
  assert.equal(plain.markdown, "Ship it this week.\n", "nothing to escape, nothing escaped");
  const starred = mdApply(source, { exact: "soon", prefix: "Ship it ", suffix: "." }, "*now* & [then]");
  assert.equal(starred.markdown, "Ship it \\*now\\* \\& \\[then\\].\n");
});

test("a Markdown quote not written out plainly in its source is refused", () => {
  const emphasised = mdApply("We can cut over in a *single* weekend.\n", { exact: "a single weekend", prefix: "cut over in ", suffix: "." }, "two weekends");
  assert.deepEqual(emphasised, { state: "refused", reason: "not-verbatim" });
  const stale = mdApply("We can cut over in a long weekend.\n", { exact: "a single weekend", prefix: "cut over in ", suffix: "." }, "two weekends");
  assert.deepEqual(stale, { state: "refused", reason: "stale" });
});

test("a Markdown deletion takes the space it would leave doubled", () => {
  const got = mdApply("Compare vs. OpenAI Codex today.\n", { exact: "OpenAI", prefix: "Compare vs. ", suffix: " Codex" }, "");
  assert.equal(got.markdown, "Compare vs. Codex today.\n");
});
