// SPDX-License-Identifier: Apache-2.0
// Self-test: a spec reads a version's bytes as its record names them, a stored file for a version that lists its files and its own prefix for an older one (SPEC §4).

/**
 * Hermetic. The two layouts a version record can have, and what the helpers
 * in lib/admin.mjs make of each: a version that lists its files names
 * `docs/{doc}/blobs/{sha256}` per file, so two versions that share a file
 * name one object, and a file it does not list is no object at all; an older
 * version names `{storagePrefix}/{rel}`, or `docs/{doc}/{version}/{rel}` for
 * the oldest records, which carry no prefix.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { versionObjectKey, versionObjects } from "../lib/admin.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const listed = { layout: "blobs", files: ["index.html", "img/chart.png"], hashes: [A, B], sizes: [10, 20] };

test("a version that lists its files names one stored file per path, and nothing for a path it does not list", () => {
  assert.equal(versionObjectKey("deck", "v2", listed, "img/chart.png"), `docs/deck/blobs/${B}`);
  assert.equal(versionObjectKey("deck", "v2", listed, "index.html"), `docs/deck/blobs/${A}`);
  assert.equal(versionObjectKey("deck", "v2", listed, "missing.css"), null);
});

test("an older version names its own prefix, or the version's folder when it has none", () => {
  assert.equal(versionObjectKey("deck", "v1", { storagePrefix: "docs/deck/bundles/u1" }, "index.html"), "docs/deck/bundles/u1/index.html");
  assert.equal(versionObjectKey("deck", "v1", {}, "index.html"), "docs/deck/v1/index.html");
});

test("a listed version's objects come from its record, sorted by path, with no listing of Storage", async () => {
  const objects = await versionObjects({ kind: "never-touched" }, "deck", "v2", listed);
  assert.deepEqual(objects, [{ rel: "img/chart.png", key: `docs/deck/blobs/${B}` }, { rel: "index.html", key: `docs/deck/blobs/${A}` }]);
});
