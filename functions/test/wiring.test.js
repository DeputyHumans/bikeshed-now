// SPDX-License-Identifier: Apache-2.0
// The endpoint table, firebase.json and the built exports must agree (SPEC §2).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "..");

/**
 * This test exists because of two real, silent defects in the design being
 * rebuilt: teardown deleted 2 of 14 functions because it was written when there
 * were two, and the dev proxy covered 2 of 14 for the same reason. Both reported
 * success. Deriving all three from one table only helps if something checks that
 * they still agree.
 */
test("firebase.json rewrites match the endpoint table exactly", async () => {
  const { rewrites } = await import("../../scripts/lib/endpoints.mjs");
  const firebase = JSON.parse(readFileSync(join(ROOT, "firebase.json"), "utf8"));
  const actual = firebase.hosting.rewrites
    .filter((r) => r.function)
    .map((r) => `${r.source} -> ${r.function}`);
  const expected = rewrites().map((r) => `${r.source} -> ${r.function}`);
  assert.deepEqual(actual, expected);
});

test("the SPA catch-all is last, after every wildcard", () => {
  const firebase = JSON.parse(readFileSync(join(ROOT, "firebase.json"), "utf8"));
  const sources = firebase.hosting.rewrites.map((r) => r.source);
  assert.equal(sources[sources.length - 1], "**");
  // An exact rewrite must precede a wildcard that would shadow it.
  assert.ok(sources.indexOf("/draft") < sources.indexOf("/draft/**"));
});

test("every table entry is exported by the built functions bundle", async () => {
  const { functionNames } = await import("../../scripts/lib/endpoints.mjs");
  const built = require("../lib/index.js");
  for (const name of functionNames()) {
    assert.ok(built[name], `functions/lib/index.js does not export ${name}`);
  }
});

test("the built bundle exports nothing the table does not know about", async () => {
  const { functionNames } = await import("../../scripts/lib/endpoints.mjs");
  const known = new Set(functionNames());
  const built = require("../lib/index.js");
  for (const key of Object.keys(built)) {
    assert.ok(known.has(key), `${key} is deployed but absent from the endpoint table`);
  }
});

test("exact endpoints get anchored dev-proxy keys", async () => {
  const { viteProxyKeys } = await import("../../scripts/lib/endpoints.mjs");
  const keys = viteProxyKeys();
  // /folder is both a POST endpoint and the prefix of the /folder/{id} client
  // route. A plain string key is a PREFIX match in Vite, which would proxy
  // folder deep-links to the emulator and break them silently.
  assert.ok(keys.includes("^/folder(\\?.*)?$"));
  assert.ok(!keys.includes("/folder"));
  assert.ok(keys.includes("/content"));
  const folderRe = new RegExp("^/folder(\\?.*)?$");
  assert.ok(folderRe.test("/folder"));
  assert.ok(folderRe.test("/folder?x=1"));
  assert.ok(!folderRe.test("/folder/abc123"));
});
