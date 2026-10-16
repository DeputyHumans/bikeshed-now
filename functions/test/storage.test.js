// SPDX-License-Identifier: Apache-2.0
// Committed version metadata selects its bundle without escaping the owning document (SPEC §2).

const test = require("node:test");
const assert = require("node:assert/strict");
const { newBundlePrefix, versionStoragePrefix } = require("../lib/lib/storage.js");

test("legacy records resolve to their version path and new records keep their isolated upload", () => {
  assert.equal(versionStoragePrefix("d", "v2", {}), "docs/d/v2");
  const first = newBundlePrefix("d");
  const next = newBundlePrefix("d");
  assert.notEqual(first, next);
  assert.match(first, /^docs\/d\/bundles\/[0-9a-f-]{36}$/);
  assert.equal(versionStoragePrefix("d", "v2", { storagePrefix: first }), first);
});

test("a recorded prefix cannot name another document or an unsafe path", () => {
  for (const prefix of ["docs/other/v2", "docs/d/../other/v2", "/docs/d/v2", "docs/d/v2/", 42]) {
    assert.throws(() => versionStoragePrefix("d", "v2", { storagePrefix: prefix }), /invalid version storage prefix/);
  }
  assert.throws(() => newBundlePrefix("../other"), /invalid document storage id/);
  assert.throws(() => versionStoragePrefix("d", "../v2", {}), /invalid version storage id/);
});
