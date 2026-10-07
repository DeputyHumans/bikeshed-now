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
      assert.equal(got.anchor.exact, c.exact, c.name);
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

test("an empty quote is not a place", () => {
  assert.deepEqual(locateQuote("<body><p>text</p></body>", { exact: "   " }), { error: "not-found" });
});
