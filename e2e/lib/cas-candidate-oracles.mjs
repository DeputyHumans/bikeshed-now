// SPDX-License-Identifier: Apache-2.0
// Judge the real CAS winner and disposal without discarding any selected draft or historical bytes (SPEC §2, §4, §6a).
import assert from "node:assert/strict";
const labelFor = reused => reused ? "C12e CAS reused candidate" : "C12e CAS refused candidate";
export function assertCasWinner({ reused, response, published, winner, original, expectedPrefix, expectedVector }) {
  const label=labelFor(reused);
  if(reused) {
    assert.equal(response.status, 200, `${label}: the newer causal save succeeds`);
    assert.equal(winner.draft?.storagePrefix, expectedPrefix, `${label}: the actual newer candidate is the selected draft`);
    assert.deepEqual(winner.draft?.causal?.vector, expectedVector, `${label}: the selected draft has the newer causal frontier`);
    assert.deepEqual(winner.versions, original.versions, `${label}: the newer save preserves every historical version's metadata and bytes`);
  } else {
    assert.equal(published, "v2", `${label}: the real agent publication wins while the old snapshot is held`);
    assert.equal(winner.currentVersion, "v2", `${label}: the selected head advances before the CAS resumes`);
    assert.equal(winner.draft, null, `${label}: publication retires the previously selected draft`);
    assert.deepEqual(winner.versions.find(v => v.id === "v1"), original.versions[0], `${label}: publication preserves the historical version's metadata and bytes`);
    assert.ok(winner.versions.find(v => v.id === "v2")?.objects.length > 0, `${label}: the winning version has actual stored bytes`);
  }
}
export function assertCasCandidateOutcome({ reused, response, winner, final, discarded, unreachable }) {
  const label=labelFor(reused);
  if(reused) {
    assert.equal(response.status, 200, `${label}: the older causal history acknowledges the newer draft`);
    assert.equal(response.json?.draft?.storagePrefix, winner.draft.storagePrefix, `${label}: acknowledgement returns the existing newer draft pointer`);
  } else {
    assert.equal(response.status, 409, `${label}: the old base is refused`);
    assert.equal(response.json?.error, "This document has a newer version. Reload before editing.", `${label}: refusal names the documented changed-version reason`);
    assert.equal(response.json?.currentVersion, "v2", `${label}: refusal identifies the current head`);
  }
  assert.deepEqual(final, winner, `${label}: the losing request preserves exact current/draft/version metadata and byte digests`);
  assert.deepEqual(discarded, [], `${label}: the discarded upload remains unreferenced but present`);
  assert.deepEqual(unreachable, [], `${label}: no unreachable attempt objects remain after the completed race`);
}
