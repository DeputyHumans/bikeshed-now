// SPDX-License-Identifier: Apache-2.0
// Distinguish a preserved snapshot-CAS refusal from a successful publisher in the late-save race (SPEC §2, §6a).
import assert from "node:assert/strict";

export const DRAFT_SNAPSHOT_REFUSAL = "The draft changed while this request was running. Retry with the current draft.";

/** Only a fully preserved winning save makes this exact refusal a safe non-witness. */
export function assertDraftRaceRefusal({ commit, late, beforeVersion, beforeBytes, record, versions, versionBytes, draftBytes, served, lateHtml }) {
  assert.ok(beforeVersion?.storagePrefix && Buffer.isBuffer(beforeBytes) && beforeBytes.length > 0, "A12 race refusal: preservation starts from an actual published snapshot");
  assert.deepEqual({ status: commit.status, body: commit.json }, { status: 409, body: { error: DRAFT_SNAPSHOT_REFUSAL, draftChanged: true } }, "A12 race refusal: only the documented snapshot conflict permits another attempt");
  assert.equal(late.status, 200, "A12 race refusal: the competing late save succeeded");
  const saved = late.json?.draft;
  assert.ok(saved?.storagePrefix && saved.entry && saved.baseVersion === "v1" && Number.isSafeInteger(saved.bytes) && saved.liveEpoch, "A12 race refusal: the successful late response identifies its actual snapshot");
  assert.equal(record.currentVersion, "v1", "A12 race refusal: the refused publisher preserves the head");
  assert.deepEqual(versions, [{ id: "v1", data: beforeVersion }], "A12 race refusal: the refused publisher preserves exact version metadata and mints nothing");
  assert.deepEqual(versionBytes, beforeBytes, "A12 race refusal: the refused publisher preserves exact published bytes");
  assert.deepEqual(Object.fromEntries(["baseVersion", "storagePrefix", "entry", "bytes"].map(key => [key, record.draft?.[key]])), Object.fromEntries(["baseVersion", "storagePrefix", "entry", "bytes"].map(key => [key, saved[key]])), "A12 race refusal: the late draft remains selected exactly");
  assert.equal(record.liveEpoch, saved.liveEpoch, "A12 race refusal: the late save keeps its session epoch");
  assert.deepEqual(draftBytes, Buffer.from(lateHtml), "A12 race refusal: the late draft's stored bytes survive exactly");
  assert.deepEqual({ status: served.status, text: served.text }, { status: 200, text: lateHtml }, "A12 race refusal: the editor still receives the exact late draft");
}
