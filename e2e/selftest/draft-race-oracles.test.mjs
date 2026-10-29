// SPDX-License-Identifier: Apache-2.0
// Reject unrelated refusals and any lost winning-save state before retrying a publication race (SPEC §2, §6a).
import test from "node:test";
import assert from "node:assert/strict";
import { assertDraftRaceRefusal, DRAFT_SNAPSHOT_REFUSAL } from "../lib/draft-race-oracles.mjs";

const sample = () => {
  const saved = { baseVersion: "v1", storagePrefix: "docs/d/bundles/late", entry: "index.html", bytes: 4, liveEpoch: "late-epoch" };
  const beforeVersion = { entry: "index.html", storagePrefix: "docs/d/bundles/head", contentHash: "head-hash" };
  return {
    commit: { status: 409, json: { error: DRAFT_SNAPSHOT_REFUSAL, draftChanged: true } }, late: { status: 200, json: { draft: saved } },
    beforeVersion, beforeBytes: Buffer.from("head"), record: { currentVersion: "v1", draft: { ...saved }, liveEpoch: saved.liveEpoch },
    versions: [{ id: "v1", data: { ...beforeVersion } }], versionBytes: Buffer.from("head"), draftBytes: Buffer.from("late"), served: { status: 200, text: "late" }, lateHtml: "late",
  };
};
test("the exact conflict with an intact winning save is a safe non-witness", () => assertDraftRaceRefusal(sample()));
for (const [name, change, message] of [
  ["missing published baseline", v => { v.beforeBytes = v.versionBytes = null; }, "actual published snapshot"],
  ["generic conflict", v => { v.commit.json.error = "Conflict"; }, "only the documented"],
  ["transport failure", v => { v.commit.status = 500; }, "only the documented"],
  ["failed late save", v => { v.late.status = 409; }, "late save succeeded"],
  ["absent saved identity", v => { delete v.late.json.draft.storagePrefix; delete v.record.draft.storagePrefix; }, "identifies its actual snapshot"],
  ["moved head", v => { v.record.currentVersion = "v2"; }, "preserves the head"],
  ["changed history", v => { v.versions[0].data.contentHash = "changed"; }, "exact version metadata"],
  ["minted version", v => { v.versions.push({ id: "v2", data: {} }); }, "exact version metadata"],
  ["changed published bytes", v => { v.versionBytes = Buffer.from("lost"); }, "exact published bytes"],
  ["removed draft", v => { delete v.record.draft; }, "late draft remains selected"],
  ["redirected draft", v => { v.record.draft.storagePrefix = "docs/d/wrong"; }, "late draft remains selected"],
  ["changed epoch", v => { v.record.liveEpoch = "old"; }, "session epoch"],
  ["lost stored draft bytes", v => { v.draftBytes = null; }, "stored bytes survive exactly"],
  ["changed served draft", v => { v.served.text = "head"; }, "editor still receives"],
]) test(`a refused race rejects ${name}`, () => {
  const value = sample(); change(value);
  assert.throws(() => assertDraftRaceRefusal(value), error => error.code === "ERR_ASSERTION" && error.message.includes(message));
});
