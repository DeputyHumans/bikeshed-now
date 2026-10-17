// SPDX-License-Identifier: Apache-2.0
// Browser feedback retains the version and passage the reader selected (SPEC §6, §19).
import assert from "node:assert/strict";

/** Browser callers name a version explicitly, including a historical one. */
export function assertBrowserFeedback(state, answers, { allowRefused = false } = {}) {
  const web = answers.filter((answer) => answer.what === "web thread");
  assert.ok(web.length > 0, "historical feedback has browser writes to judge");
  const refused = web.filter((answer) => answer.isError);
  if (allowRefused) for (const answer of refused) assert.match(answer.text, /PERMISSION_DENIED/, "a retired-version write is refused by the rules");
  else assert.deepEqual(refused.map((answer) => answer.text), [], "current browser feedback remains permitted on the selected version");
  for (const answer of web.filter(answer => !answer.isError)) {
    const stored = state.threads.find((thread) => thread.annId === answer.json.threadId);
    assert.ok(stored, "historical browser feedback is stored");
    assert.equal(stored.version, answer.json.version, "historical browser feedback stays on its selected version");
    assert.deepEqual(stored.anchor, answer.json.expectedAnchor, "historical browser feedback keeps its selected passage");
    if (answer.json.expectedBody !== undefined) assert.deepEqual(stored.bodies, [answer.json.expectedBody], "historical browser feedback keeps its body on the selected version");
  }
}
