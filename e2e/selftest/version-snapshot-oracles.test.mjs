// SPDX-License-Identifier: Apache-2.0
// Version checks inspect immutable storage and retain retired evidence after metadata deletion (SPEC §2, §9).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { draftStoragePrefix, versionObjectKey } from "../lib/admin.mjs";

const source = readFileSync(new URL("../specs/functional/a12-versions.spec.mjs", import.meta.url), "utf8");
const helper = source.slice(source.indexOf("const observedPrefixes ="), source.indexOf("/** docs/{docId}/trust"));
function world() {
  const objects = new Set(["docs/d/bundles/version/index.html", "docs/d/bundles/draft/index.html"]);
  const versions = new Map([["v2", { storagePrefix: "docs/d/bundles/version" }]]);
  const document = { draft: { storagePrefix: "docs/d/bundles/draft" } };
  const listObjects = async (_target, prefix) => [...objects].filter((name) => name.startsWith(prefix)).sort();
  const readObject = async (_target, name) => objects.has(name) ? Buffer.from(name) : null;
  // lib/admin.mjs's two layout-aware helpers, over this world's objects.
  const readVersionObject = async (t, docId, versionId, record, rel) => {
    const key = versionObjectKey(docId, versionId, record, rel);
    return key ? readObject(t, key) : null;
  };
  const versionObjects = async (t, docId, versionId, record) => {
    if (record?.layout === "blobs") return record.files.map((rel, i) => ({ rel, key: `docs/${docId}/blobs/${record.hashes[i]}` }));
    const prefix = `${record?.storagePrefix ?? `docs/${docId}/${versionId}`}/`;
    return (await listObjects(t, prefix)).map((key) => ({ rel: key.slice(prefix.length), key }));
  };
  const api = new Function("versionRecord", "docRecord", "readCollection", "listObjects", "readObject", "readVersionObject", "versionObjects", "draftStoragePrefix", "precondition", "target", `${helper}\nreturn { objectsUnder, versionObject };`)(
    async (_id, v) => versions.get(v), async () => document,
    async () => [...versions].map(([id, data]) => ({ id, data })),
    listObjects, readObject, readVersionObject, versionObjects,
    draftStoragePrefix, (ok, why) => assert.ok(ok, why), {},
  );
  return { objects, versions, document, ...api };
}

test("version reads and listings follow the selected snapshot; a re-mint reads its new pointer", async () => {
  const f = world();
  assert.equal(String(await f.versionObject("d", "v2", "index.html")), "docs/d/bundles/version/index.html");
  assert.deepEqual(await f.objectsUnder("d", "v2/"), ["docs/d/bundles/version/index.html"]);
  f.versions.set("v2", { storagePrefix: "docs/d/bundles/remint" });
  f.objects.add("docs/d/bundles/remint/index.html");
  assert.equal(String(await f.versionObject("d", "v2", "index.html")), "docs/d/bundles/remint/index.html");
});

test("a version that lists its files reads and lists its stored files, and keeps what is left of them after its record goes", async () => {
  const f = world();
  const [A, B] = ["a".repeat(64), "b".repeat(64)];
  f.versions.set("v3", { layout: "blobs", files: ["img/chart.png", "index.html"], hashes: [B, A], sizes: [1, 1] });
  f.objects.add(`docs/d/blobs/${A}`); f.objects.add(`docs/d/blobs/${B}`);
  assert.equal(String(await f.versionObject("d", "v3", "index.html")), `docs/d/blobs/${A}`);
  assert.deepEqual(await f.objectsUnder("d", "v3/"), [`docs/d/blobs/${A}`, `docs/d/blobs/${B}`]);
  f.versions.delete("v3"); f.objects.delete(`docs/d/blobs/${A}`);
  assert.deepEqual(await f.objectsUnder("d", "v3/"), [`docs/d/blobs/${B}`], "a stored file another version shares is still there");
});

test("withdrawal keeps captured version and draft evidence after their records disappear", async () => {
  const f = world();
  await f.objectsUnder("d", "v2/"); await f.objectsUnder("d", "draft/");
  f.versions.delete("v2"); delete f.document.draft;
  assert.ok((await f.objectsUnder("d", "v2/")).includes("docs/d/bundles/version/index.html"));
  assert.ok((await f.objectsUnder("d", "draft/")).includes("docs/d/bundles/draft/index.html"));
  f.objects.clear();
  assert.deepEqual(await f.objectsUnder("d", "v2/"), []);
  assert.deepEqual(await f.objectsUnder("d", "draft/"), []);
});

test("a refused future version exposes uploaded candidates without counting selected snapshots", async () => {
  const f = world();
  assert.deepEqual(await f.objectsUnder("d", "v3/"), []);
  f.objects.add("docs/d/bundles/refused/index.html");
  assert.deepEqual(await f.objectsUnder("d", "v3/"), ["docs/d/bundles/refused/index.html"]);
  f.objects.add("docs/d/v3/index.html");
  assert.deepEqual(await f.objectsUnder("d", "v3/"), ["docs/d/bundles/refused/index.html", "docs/d/v3/index.html"]);
});

test("legacy records still read and list their traditional paths", async () => {
  const f = world(); f.versions.set("v1", {}); f.objects.add("docs/d/v1/index.html");
  assert.equal(String(await f.versionObject("d", "v1", "index.html")), "docs/d/v1/index.html");
  assert.deepEqual(await f.objectsUnder("d", "v1/"), ["docs/d/v1/index.html"]);
});
