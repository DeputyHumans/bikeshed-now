// SPDX-License-Identifier: Apache-2.0
// Self-test: generated ids, the stored-zip builder, and the committed fixtures matching their generator (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";
import { DOC_ID_MAX, FIXTURES, FIXTURES_DIR, docIdFor, fixtureDrift, generateFixtures, readFixture, zipBundle } from "../lib/seed.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const T = { runId: "2610101200-seed" };
const VALID_DOC_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/; // functions/src/lib/folders.ts isValidDocId

test("docIdFor: e2e-<run6>-<name>-<r4>, valid for the product, at most 53 characters, unique", () => {
  const id = docIdFor(T, "crdt paragraphs");
  assert.match(id, /^e2e-00seed-crdt-paragraphs-[a-z0-9]{4}$/);
  const long = docIdFor(T, "x".repeat(200));
  assert.ok(long.length <= DOC_ID_MAX && long.length + 7 <= 60, `${long} leaves room for the product's suffix`);
  for (const name of ["UPPER Case", "--dashes--", "ünïcode", "", "a/b\\c"]) assert.match(docIdFor(T, name), VALID_DOC_ID, name);
  const many = new Set(Array.from({ length: 200 }, () => docIdFor(T, "same")));
  assert.ok(many.size > 190, "random tails do not collide in practice");
});

test("zipBundle: the repo's stored zip, readable back byte for byte", async () => {
  const { readStoredZip } = await import(join(REPO_ROOT, "tools", "zip.mjs"));
  const zip = await zipBundle({ "index.html": "<p>hi</p>", "img/a.bin": Buffer.from([0, 1, 2, 255]) });
  assert.deepEqual([...zip.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const back = readStoredZip(zip);
  const byName = Object.fromEntries(back.map((e) => [e.name, Buffer.from(e.data)]));
  assert.equal(byName["index.html"].toString(), "<p>hi</p>");
  assert.deepEqual([...byName["img/a.bin"]], [0, 1, 2, 255]);
});

test("the committed fixtures are exactly what the generator makes", () => {
  assert.deepEqual(fixtureDrift(), []);
});

test("negative control: an edited or missing fixture is reported as drift", () => {
  const copy = tempDir("e2e-fixtures-");
  cpSync(FIXTURES_DIR, copy, { recursive: true });
  assert.deepEqual(fixtureDrift(copy), []);
  const p = join(copy, "crdt-paragraphs.html");
  writeFileSync(p, readFileSync(p, "utf8").replace("Paragraph 7.", "Paragraph 7!"));
  assert.deepEqual(fixtureDrift(copy), ["crdt-paragraphs.html"]);
  const empty = tempDir("e2e-fixtures-");
  assert.deepEqual(fixtureDrift(empty).sort(), Object.keys(FIXTURES).sort());
});

test("fixture contents: what the specs rely on", () => {
  const all = generateFixtures();
  for (const [name, text] of Object.entries(all)) assert.ok(text.includes("SPDX-License-Identifier: Apache-2.0"), `${name} carries the identifier`);
  const crdt = readFixture("crdt-paragraphs.html");
  for (let i = 1; i <= 40; i++) assert.equal(crdt.split(`<p id="e2e-${i}">`).length, 2, `p#e2e-${i} exactly once`);
  assert.equal(crdt.split('id="e2e-sentinel"').length, 2, "one sentinel heading");
  assert.equal((crdt.match(/<p id="e2e-\d+">/g) ?? []).length, 40);
  const large = readFixture("large-doc.html");
  const text = large.split("<body>")[1].replace(/<[^>]+>/g, "");
  assert.ok(large.length > 280_000 && large.length < 340_000, `large-doc is ~300 KB (${large.length})`);
  assert.ok(text.length > 200_000, `more than 200k characters of text (${text.length}), past the S10 threshold`);
  const foreign = readFixture("foreign-marker.html");
  assert.equal((foreign.match(/data-bshd="whatever"/g) ?? []).length, 2, "the author's own marker (and its mention)");
  assert.ok(!/data-bshd="(hl-style|edit-placeholders|edit-fonts|peers|peer-style)"/.test(foreign), "no value Bikeshed owns");
  const digits = readFixture("digit-sections.html");
  assert.deepEqual([...digits.matchAll(/<section id="(\d+)">/g)].map((m) => m[1]), ["1", "2", "3", "4", "5"]);
});
