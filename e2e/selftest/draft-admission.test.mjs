// SPDX-License-Identifier: Apache-2.0
// Pin explicit admission recovery to non-editable, same-origin-version stale reads (SPEC §6b).

import { test } from "node:test";
import assert from "node:assert/strict";
import { staleDraftAdmission, withDraftAdmissionReload } from "../lib/draft-admission.mjs";

const url = (revision = "a", base = "v1", epoch = "initial") => `http://localhost/draft/d/index.html?baseVersion=${base}&liveEpoch=${epoch}&draftRevision=${revision.repeat(64)}`;
const refused = () => ({ share: "off", editable: false, contentType: "application/json", body: JSON.stringify({ error: "The draft changed. Reload before editing.", draftChanged: true }), url: url() });
const admitted = () => ({ share: "shared", editable: true, contentType: "text/html", body: "authored bytes", url: url("b") });

test("a stale admission uses the explicit reload action and retains the resulting state", async () => {
  const states = [refused(), admitted()], reloads = [], notes = [];
  const result = await withDraftAdmissionReload(async () => states.shift(), async previous => reloads.push(previous), note => notes.push(note));
  assert.deepEqual(result, admitted());
  assert.deepEqual(reloads, [url()]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /explicit Reload draft/);
});

test("admitted editable DOM is never replaced by admission recovery", async () => {
  let reloads = 0;
  const state = { ...refused(), editable: true };
  assert.equal(await withDraftAdmissionReload(async () => state, async () => { reloads += 1; }, () => {}), state);
  assert.equal(reloads, 0);
});

test("only the exact documented JSON refusal in an unopened pinned draft is retryable", async () => {
  for (const change of [
    { share: "shared" }, { contentType: "text/html" }, { body: "not JSON" },
    { body: JSON.stringify({ error: "permission denied", draftChanged: true }) },
    { body: JSON.stringify({ error: "The draft changed. Reload before editing." }) },
    { url: "http://localhost/content/d/v1/index.html" },
    { url: url().replace("/draft/d/", "/content/d/") },
    { url: url().replace("a".repeat(64), "bad") },
    { url: "http://localhost/draft/d/index.html?baseVersion=v1&liveEpoch=initial" },
    { url: `http://localhost/draft/d/index.html?liveEpoch=initial&draftRevision=${"a".repeat(64)}` },
    { url: `http://localhost/draft/d/index.html?baseVersion=v1&draftRevision=${"a".repeat(64)}` },
  ]) {
    const state = { ...refused(), ...change };
    assert.equal(staleDraftAdmission(state), false, JSON.stringify(change));
    let reloads = 0;
    assert.equal(await withDraftAdmissionReload(async () => state, async () => { reloads += 1; }, () => {}), state);
    assert.equal(reloads, 0);
  }
});

test("repeated stale admission is bounded and remains visibly refused", async () => {
  let reads = 0, reloads = 0;
  const result = await withDraftAdmissionReload(async () => { reads += 1; return refused(); }, async () => { reloads += 1; }, () => {});
  assert.equal(reads, 4);
  assert.equal(reloads, 3);
  assert.equal(result.editable, false);
  assert.equal(result.share, "off");
});

for (const [field, changed] of [
  ["baseVersion", url("b", "v2")], ["liveEpoch", url("b", "v1", "retired")],
  ["origin", url("b").replace("localhost", "other.invalid")], ["pathname", url("b").replace("/draft/d/", "/draft/other/")],
]) {
  test(`recovery cannot cross a changed ${field}`, async () => {
    const states = [refused(), { ...admitted(), url: changed }];
    await assert.rejects(withDraftAdmissionReload(async () => states.shift(), async () => {}, () => {}), new RegExp(`changed ${field}`));
  });
}

test("an unrelated error after reload is returned without another attempt", async () => {
  const denied = { ...refused(), body: JSON.stringify({ error: "permission denied" }), url: url("b") };
  const states = [refused(), denied]; let reloads = 0;
  assert.equal(await withDraftAdmissionReload(async () => states.shift(), async () => { reloads += 1; }, () => {}), denied);
  assert.equal(reloads, 1);
});
