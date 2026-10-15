// SPDX-License-Identifier: Apache-2.0
// Browser feedback retains the version and passage the reader selected (SPEC §6, §19).
import assert from "node:assert/strict";

/** Browser callers name a version explicitly, including a historical one. */
export function assertBrowserFeedback(state, answers) {
  const web = answers.filter((answer) => answer.what === "web thread");
  assert.ok(web.length > 0, "historical feedback has browser writes to judge");
  assert.deepEqual(web.filter((answer) => answer.isError).map((answer) => answer.text), [], "historical browser feedback remains permitted on the selected version");
  for (const answer of web) {
    const stored = state.threads.find((thread) => thread.annId === answer.json.threadId);
    assert.ok(stored, "historical browser feedback is stored");
    assert.equal(stored.version, answer.json.version, "historical browser feedback stays on its selected version");
    assert.deepEqual(stored.anchor, answer.json.expectedAnchor, "historical browser feedback keeps its selected passage");
    if (answer.json.expectedBody !== undefined) assert.deepEqual(stored.bodies, [answer.json.expectedBody], "historical browser feedback keeps its body on the selected version");
  }
}
