// SPDX-License-Identifier: Apache-2.0
// Draft oracles follow the selected snapshot and reject pointers outside their document (SPEC §6a).

import test from "node:test";
import assert from "node:assert/strict";
import { draftStoragePrefix } from "../lib/admin.mjs";

test("draft storage oracles distinguish immutable snapshots from legacy drafts", () => {
  assert.equal(draftStoragePrefix("d", { storagePrefix: "docs/d/bundles/new" }), "docs/d/bundles/new");
  assert.equal(draftStoragePrefix("d", { entry: "index.html" }), "docs/d/draft");
});

test("draft storage oracles reject foreign or ambiguous pointers", () => {
  for (const storagePrefix of ["docs/other/bundles/new", "docs/d/../other", "docs/d//new", "docs/d/bundles/new/", 3]) {
    assert.throws(() => draftStoragePrefix("d", { storagePrefix }), /must belong/);
  }
});
