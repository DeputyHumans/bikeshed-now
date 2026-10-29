// SPDX-License-Identifier: Apache-2.0
// Observe reserved access-mirror metadata without mistaking it for a grant or hiding unknown fields (SPEC §13, §16).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../specs/concurrency/c16-access.spec.mjs", import.meta.url), "utf8");
const block = source.slice(source.indexOf("const keysOf ="), source.indexOf("const asSet ="));
const keysOf = runInNewContext(`${block}\nkeysOf`, { assert });

test("access snapshots retain true grants while validating and excluding the live epoch", () => {
  assert.deepEqual(Array.from(keysOf({ "editor@example,invalid": true, __liveEpoch: "initial" })), ["editor@example,invalid"]);
  assert.deepEqual(Array.from(keysOf({ __liveEpoch: "epoch_2-retry" })), []);
  for (const value of [true, "", "bad/path", "x".repeat(81)]) assert.throws(() => keysOf({ __liveEpoch: value }), /live epoch/);
});

test("access snapshots never hide unknown reserved-looking keys or accept false grants", () => {
  assert.throws(() => keysOf({ __futureMetadata: "value" }), /__futureMetadata is an access grant/);
  assert.deepEqual(Array.from(keysOf({ __futureMetadata: true })), ["__futureMetadata"]);
  assert.throws(() => keysOf({ "reader@example,invalid": false }), /is an access grant/);
});
