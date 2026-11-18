// SPDX-License-Identifier: Apache-2.0
// An agent's quote is found where the browser will find it, or refused plainly (SPEC §22).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const { locateQuote } = require("../lib/lib/quote.js");

const { cases } = JSON.parse(readFileSync(join(__dirname, "fixtures", "quote-vectors.json"), "utf8"));

test("every golden case gives exactly its expected answer", () => {
  for (const c of cases) {
    const got = locateQuote(c.html, { exact: c.exact, prefix: c.prefix, suffix: c.suffix });
    if (c.expect.ok) {
      assert.ok("anchor" in got, `${c.name}: ${JSON.stringify(got)}`);
      assert.equal(got.anchor.exact, c.expect.exact ?? c.exact, c.name);
      assert.equal(got.anchor.prefix, c.expect.prefix, `${c.name}: prefix`);
      assert.equal(got.anchor.suffix, c.expect.suffix, `${c.name}: suffix`);
      assert.equal(got.anchor.elementId, "", `${c.name}: measured against the body`);
    } else {
      assert.deepEqual(got, c.expect.count ? { error: c.expect.error, count: c.expect.count } : { error: c.expect.error }, c.name);
    }
  }
});

test("context is taken from the quote's own block, at most 32 characters a side", () => {
  const long = "x".repeat(80);
  const got = locateQuote(`<body><h1>Title</h1><p>${long} needle ${long}</p></body>`, { exact: "needle" });
  assert.equal(got.anchor.prefix, `${"x".repeat(31)} `);
  assert.equal(got.anchor.suffix, ` ${"x".repeat(31)}`);
  assert.ok(!got.anchor.prefix.includes("Title"));
});

test("context copied from a reading may carry the spaces a quote may", () => {
  // The same words twice in one block, told apart only by what comes before,
  // and that before is two spans touching: "Total96" in the page, "Total 96"
  // in the reading an agent copied it from.
  const html =
    "<body><div><span>Total</span><span>96</span><span>Waiting on you</span> and <span>Total</span><span>5</span><span>Waiting on you</span></div></body>";
  const got = locateQuote(html, { exact: "Waiting on you", prefix: "Total 96" });
  assert.ok("anchor" in got, JSON.stringify(got));
  assert.equal(got.anchor.prefix, "Total96");
  assert.equal(got.anchor.start, "Total96".length);
  const later = locateQuote(html, { exact: "Waiting on you", prefix: "Total 5" });
  assert.equal(later.anchor.start, "Total96Waiting on you and Total5".length);
});

test("a place found both as written and as the reading prints it is one place", () => {
  const got = locateQuote("<body><div><span>256</span><span>Applications out</span></div></body>", { exact: "Applications out" });
  assert.ok("anchor" in got, `one place, not a repeat: ${JSON.stringify(got)}`);
  assert.equal(got.anchor.exact, "Applications out");
});

test("an empty quote is not a place", () => {
  assert.deepEqual(locateQuote("<body><p>text</p></body>", { exact: "   " }), { error: "not-found" });
});
