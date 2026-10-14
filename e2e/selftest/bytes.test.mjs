// SPDX-License-Identifier: Apache-2.0
// Self-test: DECOR flags every decoration class, spares a document's own data-bshd, BODYATTR and REHASH agree with the product (SPEC §10.1).

/**
 * Each injection below is a NEGATIVE CONTROL for one family of the checker:
 * the test fails if the checker stops seeing it. Needs Chrome (DOMParser).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  bodyAttrDiff,
  decorations,
  diffFingerprint,
  foreignMarkers,
  hashModule,
  openParser,
  rehashZip,
} from "../lib/bytes.mjs";
import { REPO_ROOT } from "../lib/paths.mjs";
import { storedZip } from "../../tools/zip.mjs";

const V1 = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>T</title><style>p{color:#333}</style></head>
<body class="doc">
<section id="s1"><h1 id="h">Title</h1><p id="p1">Alpha beta gamma.</p><p id="2">Digit id para.</p></section>
<div data-bshd="whatever" id="own">Author's own marker</div>
<details><summary>More</summary><p>Hidden text</p></details>
<svg width="40" height="20"><text x="0" y="10">Label</text></svg>
</body></html>
`;

const sub = (from, to) => (html) => {
  assert.ok(html.includes(from), `fixture lacks ${from}`);
  return html.replace(from, to);
};

/** [name, injection, which oracle must flag it, kind it must report] */
const INJECTIONS = [
  ["hl-style marker", sub("</head>", '<style data-bshd="hl-style">mark{}</style></head>'), "decor", "data-bshd"],
  ["edit-placeholders marker", sub("</head>", '<style data-bshd="edit-placeholders">[data-bshd-empty]{}</style></head>'), "decor", "data-bshd"],
  ["edit-fonts marker", sub("</head>", '<link data-bshd="edit-fonts" id="bshd-edit-fonts" rel="stylesheet" href="x.css"></head>'), "decor", "data-bshd"],
  ["peer overlay", sub("</body>", '<div data-bshd="peers" id="bshd-peers"></div></body>'), "decor", "data-bshd"],
  ["peer-style marker", sub("</head>", '<style data-bshd="peer-style" id="bshd-peer-style"></style></head>'), "decor", "data-bshd"],
  ["an own marker value nobody listed", sub("</body>", '<div data-bshd="new-overlay"></div></body>'), "decor", "data-bshd"],
  ["legacy bshd- id without a marker", sub("</head>", '<link id="bshd-edit-fonts" rel="stylesheet" href="y.css"></head>'), "decor", "bshd-id"],
  ["bshd- class", sub('<div data-bshd="whatever"', '<div class="bshd-print-mark">stamp</div><div data-bshd="whatever"'), "decor", "bshd-class"],
  ["contenteditable on a paragraph", sub('<p id="p1">', '<p id="p1" contenteditable="true">'), "decor", "contenteditable"],
  ["spellcheck on a paragraph", sub('<p id="p1">', '<p id="p1" spellcheck="true">'), "decor", "spellcheck"],
  ["mark.bshd-hl highlight", sub("beta", '<mark class="bshd-hl" data-bshd-ann="a1">beta</mark>'), "decor", "highlight"],
  ["tspan.bshd-hl in SVG text", sub(">Label<", '><tspan class="bshd-hl">Label</tspan><'), "decor", "highlight"],
  ["data-bshd-ann alone", sub('<p id="2">', '<p id="2" data-bshd-ann="a2">'), "decor", "data-bshd-*"],
  ["data-bshd-sug", sub('<p id="2">', '<p id="2" data-bshd-sug="s1">'), "decor", "data-bshd-*"],
  ["data-bshd-ins", sub('<p id="2">', '<p id="2" data-bshd-ins="replacement">'), "decor", "data-bshd-*"],
  ["data-bshd-empty", sub('<section id="s1">', '<section id="s1" data-bshd-empty="">'), "decor", "data-bshd-*"],
  ["data-bshd-preview", sub('<section id="s1">', '<section id="s1" data-bshd-preview="">'), "decor", "data-bshd-*"],
  ["--bshd-author custom property", sub('<p id="p1">', '<p id="p1" style="--bshd-author: #c00">'), "decor", "bshd-style-var"],
  ["a comment naming the namespace", sub("</body>", "<!-- bshd peers --></body>"), "decor", "bshd-comment"],
  ["raw-only: the prefix in RCDATA the parser keeps as text", sub("<title>T</title>", "<title>T bshd-hl</title>"), "decor", "raw-bshd"],
  ["contenteditable on <body>", sub('<body class="doc">', '<body class="doc" contenteditable="true">'), "bodyattr", "body"],
  ["spellcheck on <body> (S3)", sub('<body class="doc">', '<body class="doc" spellcheck="true">'), "bodyattr", "body"],
  ["an attribute on <html>", sub('<html lang="en">', '<html lang="en" data-bshd-x="1">'), "bodyattr", "html"],
  ["a duplicate id", sub('<p id="2">', '<p id="p1">dup</p><p id="2">'), "structure", "duplicate-ids"],
  ["an injected <script>", sub("</body>", "<script>1</script></body>"), "structure", "tag-count"],
  ["a <style> injected into <head>", sub("</head>", "<style>x{}</style></head>"), "structure", "tag-count"],
];

let parser;
let base;
before(async () => {
  parser = await openParser();
  base = await parser.fingerprint(V1);
});
after(async () => parser?.close());

test("v1 against itself: ok, nothing flagged, and the author's data-bshd=\"whatever\" is NOT decoration", async () => {
  const again = await parser.fingerprint(V1);
  const d = diffFingerprint(base, again);
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(decorations(base), [], "absolute mode: a document-owned marker value is not decoration");
  assert.deepEqual(foreignMarkers(base), { whatever: 1 });
  assert.equal(base.dataBshd.whatever, 1);
  assert.deepEqual(base.ids.duplicates, []);
  assert.equal(base.tags.section, 1);
  assert.equal(base.tags.details, 1);
  assert.equal(base.tags.svg, 1);
});

for (const [name, inject, oracle, kind] of INJECTIONS) {
  test(`NEGATIVE: ${name} is flagged by ${oracle} (${kind})`, async () => {
    const fp = await parser.fingerprint(inject(V1));
    const d = diffFingerprint(base, fp);
    assert.equal(d.ok, false, `diffFingerprint passed a document with ${name}`);
    if (oracle === "decor") {
      assert.ok(d.decoration.some((x) => x.kind === kind), `DECOR missed ${name}: ${JSON.stringify(d.decoration)}`);
    } else if (oracle === "bodyattr") {
      assert.equal(d.bodyAttr.equal, false, `BODYATTR missed ${name}`);
      assert.equal(d.bodyAttr[kind].equal, false, `BODYATTR(${kind}) missed ${name}: ${JSON.stringify(d.bodyAttr)}`);
      assert.deepEqual(d.decoration, [], "root attributes are BODYATTR's, never double-reported as DECOR");
    } else {
      assert.ok(d.structure.some((x) => x.kind === kind), `structure missed ${name}: ${JSON.stringify(d.structure)}`);
    }
  });
}

test("NEGATIVE: losing the author's own data-bshd=\"whatever\" is reported as lost", async () => {
  const fp = await parser.fingerprint(V1.replace('data-bshd="whatever" ', ""));
  const d = diffFingerprint(base, fp);
  assert.equal(d.ok, false);
  assert.deepEqual(d.lost.map((l) => [l.kind, l.key]), [["foreign-data-bshd", "whatever"]]);
});

test("absolute mode (no baseline) still flags every known own marker", async () => {
  for (const value of ["hl-style", "edit-placeholders", "edit-fonts", "peers", "peer-style"]) {
    const fp = await parser.fingerprint(V1.replace("</body>", `<div data-bshd="${value}"></div></body>`));
    assert.ok(decorations(fp).some((x) => x.kind === "data-bshd" && x.key === value), value);
  }
});

test("allowedTextChange: a typed token passes only when declared, and only that token", async () => {
  const token = "⟦r1-u1-0001⟧";
  const typed = await parser.fingerprint(V1.replace("Alpha beta gamma.", `Alpha beta gamma.${token}`));
  assert.equal(diffFingerprint(base, typed).ok, false, "undeclared text change must fail");
  assert.equal(diffFingerprint(base, typed, { contains: [token] }).ok, true);
  const extra = await parser.fingerprint(V1.replace("Alpha beta gamma.", `Alpha beta gamma.${token}x`));
  assert.equal(diffFingerprint(base, extra, { contains: [token] }).ok, false, "a stray character beyond the token must fail");
  assert.equal(diffFingerprint(base, typed, { contains: ["⟦missing⟧"] }).ok, false);
});

test("BODYATTR reports exactly what changed on <body>", async () => {
  const fp = await parser.fingerprint(V1.replace('<body class="doc">', '<body class="doc" spellcheck="true">'));
  const d = bodyAttrDiff(base, fp);
  assert.deepEqual(d.body.added, { spellcheck: "true" });
  assert.deepEqual(d.body.removed, {});
  assert.equal(d.html.equal, true);
  assert.equal(diffFingerprint(base, fp, false, { ignoreBodyAttr: true }).ok, true, "ignoreBodyAttr isolates DECOR from BODYATTR");
});

test("REHASH: the tree's hash.mjs over a zip equals hashing the same files directly; one changed byte changes it", async () => {
  const { hashBundleFiles } = await hashModule(null);
  const files = [
    { rel: "index.html", data: Buffer.from(V1) },
    { rel: "assets/a.css", data: Buffer.from("p{}") },
  ];
  const direct = hashBundleFiles(files);
  const viaZip = await rehashZip(storedZip([{ name: "assets/" }, { name: "assets/a.css", data: files[1].data }, { name: "index.html", data: files[0].data }]));
  assert.equal(viaZip.contentHash, direct.contentHash, "entry order in the archive must not matter");
  assert.equal(viaZip.fileCount, 2, "directory entries are not files");
  const changed = await rehashZip(storedZip([{ name: "index.html", data: Buffer.from(V1 + " ") }, { name: "assets/a.css", data: files[1].data }]));
  assert.notEqual(changed.contentHash, direct.contentHash);
});

test("REHASH matches the shared golden vector the two product hash halves are pinned to", async (t) => {
  const fixture = join(REPO_ROOT, "functions", "test", "fixtures", "hash-vectors.json");
  if (!existsSync(fixture)) return t.skip(`no golden vectors at ${fixture}`);
  const vectors = createRequire(import.meta.url)(fixture);
  assert.ok(Array.isArray(vectors) && vectors.length > 0, "the golden vector file holds vectors");
  let checked = 0;
  for (const v of vectors) {
    const files = v.files.map((f) => ({ rel: f.rel, data: Buffer.from(f.utf8, "utf8") }));
    const zip = storedZip(files.map((f) => ({ name: f.rel, data: f.data })));
    const got = await rehashZip(zip);
    assert.equal(got.contentHash, v.contentHash, v.name);
    assert.equal(got.fileCount, v.fileCount, `${v.name}: fileCount`);
    assert.equal(got.bytes, v.bytes, `${v.name}: bytes`);
    checked += 1;
  }
  assert.equal(checked, vectors.length);
});
