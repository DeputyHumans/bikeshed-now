// SPDX-License-Identifier: Apache-2.0
// A reading is made in a worker within a time and memory budget, and a page over it reads shorter, never fails (SPEC §19, ADR 0034).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const { READ_PARSE_CHARS, STOPS_EARLY, TOO_COMPLEX, UNREADABLE, readingMarkdown, stripForReading } = require("../lib/lib/markdown/reading.js");
const { LADDER, budgetedReading } = require("../lib/lib/markdown/budget.js");

const ROOT = join(__dirname, "..", "..");
const PLACE = { origin: "https://bikeshed.example", docId: "plan", versionId: "v1", entry: "index.html", k: null };
const none = () => ({ scripts: 0, stylesheets: 0, figures: 0, embeds: 0, inlineImages: 0, hidden: 0, formControls: 0 });

const BUNDLES = readdirSync(join(ROOT, "content"))
  .map((name) => join(ROOT, "content", name, "bundle", "index.html"))
  .filter((path) => existsSync(path))
  .map((path) => ({ path, html: readFileSync(path, "utf8") }));

/** A tracker-shaped block: metric cards, a table, a list. Made up. */
const BLOCK = (i) =>
  `<section><h2>Week ${i}</h2>` +
  `<div class="metric"><span class="readout">${i}</span><span class="metric-label">Applications out</span></div>` +
  `<table><tr><th>Role</th><th>Stage</th></tr>${Array.from({ length: 8 }, (_, r) => `<tr><td>Role ${i}.${r}</td><td><a href="/r/${i}/${r}">Applied</a></td></tr>`).join("")}</table>` +
  `<ul>${Array.from({ length: 6 }, (_, r) => `<li>Note ${i}.${r} on the pipeline</li>`).join("")}</ul></section>`;

/** A dense page whose stripped length is past `chars`, ending in a marker. */
function trackerPage(chars) {
  const parts = [];
  let length = 0;
  for (let i = 0; length <= chars; i++) {
    const block = BLOCK(i);
    parts.push(block);
    length += block.length;
  }
  return `<!doctype html><html><body>${parts.join("")}<p>THE LAST LINE</p></body></html>`;
}

/** Collects what `console.warn` was given while `fn` runs. */
async function warnings(fn) {
  const seen = [];
  const original = console.warn;
  console.warn = (...args) => seen.push(args.join(" "));
  try {
    return { result: await fn(), seen };
  } finally {
    console.warn = original;
  }
}

test("a reading made within the budget is exactly the reading made in place", async () => {
  assert.ok(BUNDLES.length >= 5, "the samples are found");
  for (const { path, html } of BUNDLES) {
    assert.deepEqual(await budgetedReading(html, PLACE), readingMarkdown(html, PLACE), path);
  }
});

test("a dense page past 2M characters reads whole, and the request's own thread keeps running while it is made", async () => {
  const html = trackerPage(3_000_000);
  assert.ok(stripForReading(html, none()).length > 3_000_000);
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 20);
  const started = Date.now();
  let reading;
  try {
    reading = await budgetedReading(html, PLACE);
  } finally {
    clearInterval(ticker);
  }
  const elapsed = Date.now() - started;
  assert.equal(reading.cut, false);
  assert.ok(!reading.warnings.includes(STOPS_EARLY));
  assert.match(reading.body, /THE LAST LINE\n$/);
  // In place, a conversion this long holds the thread and the interval fires once at most.
  assert.ok(elapsed > 200, `the conversion took ${elapsed} ms, too short to show anything`);
  assert.ok(ticks >= Math.floor(elapsed / 20 / 3), `${ticks} ticks in ${elapsed} ms`);
});

test("the first attempt parses as much as any reading does, and the ladder fits inside the 60 s a function has", () => {
  assert.equal(LADDER[0].chars, READ_PARSE_CHARS);
  for (let i = 1; i < LADDER.length; i++) assert.ok(LADDER[i].chars < LADDER[i - 1].chars, "each rung reads less");
  const worst = LADDER.reduce((sum, r) => sum + r.ms, 0);
  assert.ok(worst <= 45_000, `the ladder can take ${worst} ms`);
});

test("an attempt over its time is stopped, and a shorter one says the page was too complex to read whole", async () => {
  const html = `<p>${"word ".repeat(1000)}</p><p>THE END</p>`;
  const ladder = [
    { chars: 1_000_000, ms: 1, heapMb: 512 },
    { chars: 100, ms: 30_000, heapMb: 512 },
  ];
  const { result: reading, seen } = await warnings(() => budgetedReading(html, PLACE, ladder));
  assert.deepEqual(seen, ["reading: over budget time"]);
  assert.equal(reading.cut, true);
  assert.deepEqual(reading.warnings, [TOO_COMPLEX]);
  assert.ok(reading.body.startsWith("word word"));
  assert.ok(!reading.body.includes("THE END"));
});

test("an attempt over its memory is stopped, and a shorter one is read", async () => {
  const html = `${"<span>a</span>".repeat(400_000)}<p>THE END</p>`;
  const ladder = [
    { chars: 8_000_000, ms: 60_000, heapMb: 32 },
    { chars: 1_000, ms: 30_000, heapMb: 512 },
  ];
  const { result: reading, seen } = await warnings(() => budgetedReading(html, PLACE, ladder));
  assert.deepEqual(seen, ["reading: over budget memory"]);
  assert.equal(reading.cut, true);
  assert.deepEqual(reading.warnings, [TOO_COMPLEX]);
  assert.ok(reading.body.length > 0 && !reading.body.includes("THE END"));
});

test("a page no part of which can be read reads as unreadable, with what the strip counted, and never throws", async () => {
  // Deep enough to overflow the converter's stack, and shorter than every rung, so only the first is tried.
  const html = `<script>x()</script>${"<div>".repeat(10_000)}deep`;
  const { result: reading, seen } = await warnings(() => budgetedReading(html, PLACE));
  assert.deepEqual(seen, ["reading: over budget error"]);
  assert.deepEqual(reading, { body: "", leftOut: { ...none(), scripts: 1 }, warnings: [UNREADABLE], cut: true });
});

test("a worker that cannot start reads as unreadable rather than failing the request", async () => {
  const { result: reading } = await warnings(() => budgetedReading("<p>words</p>", PLACE, LADDER, join(__dirname, "no-such-worker.js")));
  assert.deepEqual(reading.warnings, [UNREADABLE]);
  assert.equal(reading.body, "");
});
