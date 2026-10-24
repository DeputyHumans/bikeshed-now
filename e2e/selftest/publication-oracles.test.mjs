// SPDX-License-Identifier: Apache-2.0
// Refute missing, redirected and changed publication data in refused-commit evidence (SPEC §6a, §12).
import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicationBaseline, assertPublicationPreserved, isPublicationReviewRefusal } from "../lib/publication-oracles.mjs";

const refusal = text => ({ status: 200, isError: true, text });
const singular = "1 suggested edit is waiting for a decision. Only the owner or an approver can accept or reject it, and no new version can be published until then. If it is yours, you may withdraw it.";
test("only full documented review messages qualify as refusals", () => {
  assert.equal(isPublicationReviewRefusal(refusal("Resolve all comments before publishing a new version.")), true);
  assert.equal(isPublicationReviewRefusal(refusal(singular)), true);
  assert.equal(isPublicationReviewRefusal(refusal("2 suggested edits are waiting for a decision. Only the owner or an approver can accept or reject them, and no new version can be published until then. Any that are yours you may withdraw.")), true);
});
for (const [name, value] of [
  ["generic error", refusal("Unknown publication failure.")],
  ["truncated known prefix", refusal("1 suggested edit is waiting for a decision.")],
  ["extra suffix", refusal(singular + " Try again later.")],
  ["zero count", refusal(singular.replace("1 suggested", "0 suggested"))],
  ["wrong grammar", refusal(singular.replace("edit is", "edits are"))],
  ["transport error", { ...refusal(singular), status: 500 }],
  ["successful response", { ...refusal(singular), isError: false }],
]) test(`safe-refusal predicate rejects ${name}`, () => assert.equal(isPublicationReviewRefusal(value), false));

const object = key => ({ key, size: 12, sha256: "a".repeat(64) });
const sample = () => ({ currentVersion: "v1", liveEpoch: { present: false }, draft: { entry: "index.html", storagePrefix: "docs/d/bundles/draft", baseVersion: "v1", causal: { generation: "g", vector: "a", deletes: [] } }, versions: [{ id: "v1", metadata: { entry: "index.html", storagePrefix: "docs/d/bundles/old" }, objects: [object("docs/d/bundles/old/index.html")] }], draftObjects: [object("docs/d/bundles/draft/index.html")] });
test("a real unchanged saved draft and version are accepted", () => { const before = sample(); assertPublicationBaseline(before); assertPublicationPreserved(before, structuredClone(before)); });
for (const [name, change] of [
  ["head", s => { s.currentVersion = "v2"; }],
  ["epoch presence", s => { s.liveEpoch = { present: true, value: "initial" }; }],
  ["draft removed", s => { s.draft = null; }],
  ["draft frontier", s => { s.draft.causal.vector = "b"; }],
  ["draft prefix", s => { s.draft.storagePrefix = "docs/d/elsewhere"; }],
  ["draft missing bytes", s => { s.draftObjects = []; }],
  ["draft changed bytes", s => { s.draftObjects[0].sha256 = "b".repeat(64); }],
  ["draft object path", s => { s.draftObjects[0].key += "x"; }],
  ["new version", s => { s.versions.push({ ...structuredClone(s.versions[0]), id: "v2" }); }],
  ["version metadata", s => { s.versions[0].metadata.label = "changed"; }],
  ["version missing bytes", s => { s.versions[0].objects = []; }],
  ["version changed bytes", s => { s.versions[0].objects[0].sha256 = "b".repeat(64); }],
]) test(`refused commit rejects ${name}`, () => { const before = sample(), after = structuredClone(before); change(after); assert.throws(() => assertPublicationPreserved(before, after), assert.AssertionError); });
for (const [name, change] of [
  ["missing draft", s => { s.draft = null; }],
  ["empty draft inventory", s => { s.draftObjects = []; }],
  ["empty version inventory", s => { s.versions[0].objects = []; }],
  ["missing digest", s => { delete s.draftObjects[0].sha256; }],
  ["wrong entry path", s => { s.draftObjects[0].key = "docs/d/other.bin"; }],
]) test(`baseline rejects ${name}`, () => { const snapshot = sample(); change(snapshot); assert.throws(() => assertPublicationBaseline(snapshot), assert.AssertionError); });
