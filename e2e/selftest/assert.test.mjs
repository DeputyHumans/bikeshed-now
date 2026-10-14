// SPDX-License-Identifier: Apache-2.0
// Self-test: eventually() waits for stability and times out loudly; header and status helpers catch every mismatch; lineHunks is a faithful line diff (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertHeaderMatrix,
  assertSameHeadersExceptDate,
  cacheControl,
  checkHeaders,
  eventually,
  expectStatus,
  headerMap,
  LINE_HUNKS_MAX_CELLS,
  lineHunks,
  sameBytes,
  sameHeadersExceptDate,
} from "../lib/assert.mjs";

test("eventually resolves once fn stops throwing, with its value", async () => {
  let n = 0;
  const v = await eventually(() => {
    n += 1;
    if (n < 4) throw new Error("not yet");
    return { n };
  }, { timeout: 2000, interval: 5 });
  assert.deepEqual(v, { n: 4 });
});

test("NEGATIVE: eventually times out with the last error and the sample count", async () => {
  await assert.rejects(
    eventually(() => { throw new Error("still red"); }, { timeout: 150, interval: 20, message: "peers converge" }),
    (err) => err.code === "E2E_EVENTUALLY_TIMEOUT" && /peers converge/.test(err.message) && /still red/.test(err.message) && err.samples >= 3,
  );
  await assert.rejects(eventually(() => false, { timeout: 60, interval: 10 }), /last value: false/);
});

test("NEGATIVE: stableSamples demands consecutive EQUAL successes, not a passing glance", async () => {
  let i = 0;
  // Alternating values never stabilise.
  await assert.rejects(eventually(() => ({ h: i++ % 2 }), { timeout: 200, interval: 5, stableSamples: 3 }), /stable streak/);
  // A value that settles does.
  let j = 0;
  const v = await eventually(() => ({ h: Math.min(j++, 5) }), { timeout: 2000, interval: 5, stableSamples: 3 });
  assert.deepEqual(v, { h: 5 });
  assert.ok(j >= 8, `took ${j} samples: 5 to settle, then 3 equal`);
});

test("expectStatus passes the expected code and NEGATIVE: names the wrong one with the body", () => {
  assert.equal(expectStatus({ status: 404 }, [404, 410]), 404);
  assert.throws(() => expectStatus({ status: 200, url: "http://x/y" }, 404, { body: { leaked: true } }), (e) => e.code === "E2E_STATUS" && /got 200 from http:\/\/x\/y/.test(e.message) && /leaked/.test(e.message));
  assert.equal(expectStatus({ status: () => 201 }, 201), 201, "a Playwright response's status()");
});

test("headerMap reads fetch Headers, Playwright headers() and plain objects alike", () => {
  const fromFetch = headerMap(new Response("", { headers: { "Cache-Control": "private, no-store" } }));
  assert.equal(fromFetch["cache-control"], "private, no-store");
  assert.equal(headerMap({ headers: () => ({ "X-A": "1" }) })["x-a"], "1");
  assert.equal(headerMap({ ETag: "x" }).etag, "x");
});

test("cacheControl parses the directives the matrix checks", () => {
  const c = cacheControl("public, max-age=300, s-maxage=600, immutable");
  assert.equal(c.public, true);
  assert.equal(c.maxAge, 300);
  assert.equal(c.sMaxAge, 600);
  assert.equal(c.immutable, true);
  assert.equal(cacheControl("private, no-store").noStore, true);
  assert.equal(cacheControl("").maxAge, null);
});

test("NEGATIVE: a header matrix reports every bad cell, including a forbidden header that is present", () => {
  const rows = [
    { label: "member /content", res: { status: 200, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } }, status: 200, expect: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } },
    { label: "refusal 404", res: { status: 404, headers: { "cache-control": "public, max-age=600" } }, status: 404, expect: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } },
    { label: "unlisted", res: { status: 200, headers: { "cache-control": "public, max-age=300" } }, status: 200, expect: { "x-robots-tag": "noindex", "set-cookie": null } },
    { label: "wrong status", res: { status: 500, headers: {} }, status: [200, 304] },
  ];
  assert.throws(() => assertHeaderMatrix(rows), (e) => {
    assert.equal(e.code, "E2E_HEADER_MATRIX");
    const cells = e.cells.map((c) => `${c.label}|${c.header}`).sort();
    assert.deepEqual(cells, ["refusal 404|cache-control", "refusal 404|x-content-type-options", "unlisted|x-robots-tag", "wrong status|:status"]);
    return true;
  });
  assert.deepEqual(assertHeaderMatrix(rows.slice(0, 1)), ["member /content"]);
  assert.deepEqual(checkHeaders({ headers: { "set-cookie": "a=b" } }, { "set-cookie": null }).map((m) => m.got), ["a=b"]);
  assert.deepEqual(checkHeaders({ headers: { "cache-control": "public, max-age=120" } }, { "cache-control": (v) => cacheControl(v).maxAge <= 300 }), []);
});

test("sameHeadersExceptDate ignores Date only, and NEGATIVE: any other difference is reported", () => {
  const a = { headers: { Date: "Mon, 01 Jan 2026 00:00:00 GMT", "Cache-Control": "private, no-store", "Content-Type": "text/html" } };
  const b = { headers: { date: "Tue, 02 Jan 2026 00:00:00 GMT", "cache-control": "private, no-store", "content-type": "text/html" } };
  assert.equal(sameHeadersExceptDate(a, b).equal, true);
  const c = { headers: { ...b.headers, "x-robots-tag": "noindex" } };
  const r = sameHeadersExceptDate(a, c);
  assert.equal(r.equal, false);
  assert.deepEqual(r.diff, [{ header: "x-robots-tag", a: undefined, b: "noindex" }]);
  assert.throws(() => assertSameHeadersExceptDate(a, { headers: { ...b.headers, "cache-control": "public, max-age=300" } }), (e) => e.code === "E2E_HEADERS_DIFFER");
  assert.equal(sameHeadersExceptDate(a, c, { ignore: ["X-Robots-Tag"] }).equal, true);
});

test("sameBytes finds the first differing offset", () => {
  assert.deepEqual(sameBytes("abc", "abc"), { equal: true });
  assert.deepEqual(sameBytes("abcd", "abXd"), { equal: false, at: 2, lengths: [4, 4] });
  assert.deepEqual(sameBytes("ab", "abc"), { equal: false, at: 2, lengths: [2, 3] });
});

/** Apply hunks to `expected`, line by line, as their `line` numbers say: the text the hunks claim `actual` is. */
function applyHunks(expected, hunks) {
  const a = expected.split("\n");
  const out = [];
  let at = 0;
  for (const h of hunks) {
    while (at < h.line - 1) out.push(a[at++]);
    assert.deepEqual(a.slice(at, at + h.expected.length), h.expected, `hunk at line ${h.line} removes what expected has there`);
    at += h.expected.length;
    out.push(...h.got);
  }
  while (at < a.length) out.push(a[at++]);
  return out.join("\n");
}

test("lineHunks: [] for equal texts, strings or Buffers; a changed, an inserted and a removed line each read as themselves", () => {
  const doc = ["# Title", "", "one", "two", "three", "four", ""].join("\n");
  assert.deepEqual(lineHunks(doc, doc), []);
  assert.deepEqual(lineHunks(Buffer.from(doc), Buffer.from(doc)), []);
  assert.deepEqual(lineHunks(doc, doc.replace("two", "TWO")), [{ line: 4, expected: ["two"], got: ["TWO"] }]);
  assert.deepEqual(lineHunks(doc, doc.replace("one\n", "one\nnew\n")), [{ line: 4, expected: [], got: ["new"] }], "an insertion is placed before the line it precedes");
  assert.deepEqual(lineHunks(doc, doc.replace("three\n", "")), [{ line: 5, expected: ["three"], got: [] }]);
  assert.deepEqual(lineHunks("a", "b\na"), [{ line: 1, expected: [], got: ["b"] }], "at the very start");
  assert.deepEqual(lineHunks("a\n", "a\n\n"), [{ line: 3, expected: [], got: [""] }], "one more trailing newline is one more empty line, after the two expected has");
  assert.deepEqual(lineHunks("x\r\ny", "x\ny"), [{ line: 1, expected: ["x\r"], got: ["x"] }], "a CR stays on its line, so a CRLF difference shows");
  assert.deepEqual(lineHunks(doc, Buffer.from(doc.replace("four", "4"))), [{ line: 6, expected: ["four"], got: ["4"] }], "a Buffer is read as UTF-8");
  assert.throws(() => lineHunks(doc, null), { name: "TypeError", message: "lineHunks: actual is a string or a Buffer, got null" });
  assert.throws(() => lineHunks(42, doc), /lineHunks: expected is a string or a Buffer, got number/);
});

test("lineHunks: NEGATIVE: a moved line is one removal and one addition, where a positional comparison reports every line between", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const moved = [...lines.slice(0, 3), ...lines.slice(4), lines[3]];
  const want = lines.join("\n");
  const got = moved.join("\n");
  assert.deepEqual(lineHunks(want, got), [
    { line: 4, expected: ["line 4"], got: [] },
    { line: 31, expected: [], got: ["line 4"] },
  ]);
  const positional = lines.filter((l, i) => l !== moved[i]).length;
  assert.equal(positional, 27, "comparing line i with line i reports 27 differing lines for the one moved line");
});

test("lineHunks: [] exactly when equal, and the hunks rebuild actual from expected, over random texts", () => {
  // mulberry32: 32-bit integer arithmetic throughout, so the sequence never degenerates in floating point.
  let seed = 7;
  const rnd = (n) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const alphabet = ["a", "b", "c", "", "a b", "\r"];
  let unequal = 0;
  for (let k = 0; k < 400; k += 1) {
    const text = () => Array.from({ length: rnd(9) }, () => alphabet[rnd(alphabet.length)]).join("\n");
    const a = text();
    const b = rnd(4) === 0 ? a : text();
    if (a !== b) unequal += 1;
    const hunks = lineHunks(a, b);
    assert.equal(hunks.length === 0, a === b, `[] iff equal: ${JSON.stringify([a, b])}`);
    assert.equal(applyHunks(a, hunks), b, `the hunks rebuild actual: ${JSON.stringify([a, b, hunks])}`);
    for (let i = 1; i < hunks.length; i += 1) assert.ok(hunks[i].line > hunks[i - 1].line, "hunks are in order");
  }
  assert.ok(unequal >= 250, `the run compared mostly unequal texts (${unequal} of 400), so it tests something`);
});

test("lineHunks: a differing middle past LINE_HUNKS_MAX_CELLS is one hunk, and still rebuilds actual", () => {
  const n = Math.ceil(Math.sqrt(LINE_HUNKS_MAX_CELLS)) + 1;
  const a = ["head", ...Array.from({ length: n }, (_, i) => `a${i}`), "tail"].join("\n");
  const b = ["head", ...Array.from({ length: n }, (_, i) => `b${i}`), "tail"].join("\n");
  const hunks = lineHunks(a, b);
  assert.equal(hunks.length, 1);
  assert.deepEqual([hunks[0].line, hunks[0].expected.length, hunks[0].got.length], [2, n, n]);
  assert.equal(applyHunks(a, hunks), b);
});
