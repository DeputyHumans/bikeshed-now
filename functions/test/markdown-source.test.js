// SPDX-License-Identifier: Apache-2.0
// A Markdown document's own Markdown under the `.md` address's front matter, and telling that front matter from an author's (SPEC §19, ADR 0042).

const test = require("node:test");
const assert = require("node:assert/strict");

const { SOURCE_NOTICE, sourcePreamble, composeSource, opensWithOwnFrontMatter } = require("../lib/lib/markdown/source.js");
const { readingPreamble, noneLeftOut } = require("../lib/lib/markdown/reading.js");

const PLACE = {
  title: 'Plan: "phase 2"',
  document: "https://bikeshed.example/d/plan",
  version: "v3",
  original: "https://bikeshed.example/content/plan/v3/index.md",
};

test("the front matter says it is the source, in values a colon or a quote cannot break", () => {
  const preamble = sourcePreamble(PLACE);
  assert.equal(
    preamble,
    [
      "---",
      `source: ${JSON.stringify(SOURCE_NOTICE)}`,
      'title: "Plan: \\"phase 2\\""',
      'document: "https://bikeshed.example/d/plan"',
      'version: "v3"',
      'original: "https://bikeshed.example/content/plan/v3/index.md"',
      "---",
      "",
    ].join("\n"),
  );
  assert.match(SOURCE_NOTICE, /not part of it: to revise, send only what follows it/);
  assert.match(SOURCE_NOTICE, /quote its words, not its Markdown/);
});

test("the source follows the front matter and a blank line, exactly as stored", () => {
  const source = "﻿# Plan\r\n\r\nShip <mark>it</mark>.\r\n";
  const text = composeSource(sourcePreamble(PLACE), source);
  assert.ok(text.endsWith(`---\n\n${source}`));
  assert.equal(text.slice(sourcePreamble(PLACE).length + 1), source);
  assert.equal(composeSource("---\n---\n", ""), "---\n---\n", "an empty source is the front matter alone");
});

test("Bikeshed's own front matter is recognised, whichever kind and however it was carried", () => {
  const own = composeSource(sourcePreamble(PLACE), "# Plan\n");
  const reading = readingPreamble({ ...PLACE, leftOut: noneLeftOut(), warnings: [] }) + "\n# Plan\n";
  for (const [name, text] of [
    ["the .md address's", own],
    ["a reading's", reading],
    ["with CRLF line ends", own.replace(/\n/g, "\r\n")],
    ["after a byte order mark", `﻿${own}`],
  ]) {
    assert.equal(opensWithOwnFrontMatter(text), true, name);
  }
});

test("an author's own front matter, and ours anywhere but the start, are not Bikeshed's", () => {
  const own = sourcePreamble(PLACE);
  for (const [name, text] of [
    ["an author's front matter", "---\ntitle: Plan\ntags: [a, b]\n---\n\n# Plan\n"],
    ["a source key with other words", '---\nsource: "My own notes."\n---\n# Plan\n'],
    ["the notice after the block closes", `---\ntitle: Plan\n---\n${own.split("\n")[1]}\n`],
    ["ours below a first line", `# Plan\n\n${own}`],
    ["no front matter at all", "# Plan\n\nShip it.\n"],
    ["nothing", ""],
  ]) {
    assert.equal(opensWithOwnFrontMatter(text), false, name);
  }
});
