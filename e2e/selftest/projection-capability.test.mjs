// SPDX-License-Identifier: Apache-2.0
// Projection failure is confined to the explicit test document and leaves ordinary transactions intact (SPEC §6a).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const ts = require("typescript");
const patch = readFileSync(new URL("../patches/a12-projection-unavailable/10-projection-fault-helper.patch", import.meta.url), "utf8");
const source = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
async function adapter(text = source) {
  const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return (await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`)).e2eProjectionUnavailable;
}
function db(title) {
  return { collection(name) { assert.equal(name, "docs"); return { doc(id) { assert.equal(id, "selected"); return { get: async () => ({ data: () => ({ title }) }) }; } }; }, runTransaction: (work) => work("actual-transaction"), identity() { return this; } };
}
test("the explicit fixture fails only its projection transaction and names its document", async () => {
  const proxy = (await adapter())(db("E2E_PROJECTION_FAULT: selected"), "selected");
  const prior = console.error, markers = []; console.error = (line) => markers.push(line);
  try { await assert.rejects(proxy.runTransaction(() => assert.fail("selected fault must not run work")), /injected projection transaction unavailable/); }
  finally { console.error = prior; }
  assert.deepEqual(markers, ["E2E_PROJECTION_UNAVAILABLE selected"]);
});
test("unmarked docs retain the actual transaction and bound nontransaction methods", async () => {
  const actual = db("ordinary A12 document"), proxy = (await adapter())(actual, "selected");
  assert.equal(await proxy.runTransaction(async (tx) => tx), "actual-transaction");
  assert.equal(proxy.identity(), actual);
});
test("inverse global fault cannot satisfy ordinary-document isolation", async () => {
  const broken = source.replace('if (!String(doc.data()?.title ?? "").startsWith("E2E_PROJECTION_FAULT:")) return target.runTransaction(work);', 'void doc;');
  const prior = console.error; console.error = () => {};
  try { await assert.rejects((await adapter(broken))(db("ordinary"), "selected").runTransaction(async (tx) => tx), /injected projection transaction unavailable/); }
  finally { console.error = prior; }
});
