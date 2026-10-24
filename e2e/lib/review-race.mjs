// SPDX-License-Identifier: Apache-2.0
// Retain bounded natural-race attempts and distinguish local review edits from legitimate merged autosaves (SPEC §16, §22).

import assert from "node:assert/strict";

/** Only a fully judged, explicitly missed window may retry; errors are never swallowed. */
export async function naturalRaceAttempts({ run, record, max = 3 }) {
  if (!Number.isInteger(max) || max < 1 || max > 3) throw new TypeError("natural race attempts are bounded to one through three");
  const attempts = [];
  for (let attempt = 1; attempt <= max; attempt += 1) {
    let result;
    try { result = await run(attempt); }
    catch (error) { attempts.push({ attempt, outcome: "stopped", error: error.message }); await record(attempts); throw error; }
    assert.equal(typeof result.achieved, "boolean", "a natural attempt must explicitly report whether its window was achieved");
    attempts.push({ attempt, outcome: result.achieved ? "achieved" : "window-missed", diagnostic: result.diagnostic });
    await record(attempts);
    if (result.achieved || attempt === max) return { ...result, attempts };
  }
}

/** Run in the document frame: remote CRDT patches do not invoke the editing command API. */
export function installReviewCommandObserver() {
  if (document.__e2eReviewCommands) throw new Error("review command observer already installed");
  const original = document.execCommand;
  const commands = [];
  document.__e2eReviewCommands = { original, commands };
  document.execCommand = function (command, showUi, value) {
    commands.push({ command: String(command).toLowerCase(), value: value == null ? null : String(value) });
    return original.call(this, command, showUi, value);
  };
}

/** Read and restore the unchanged command API after the observation window. */
export function finishReviewCommandObserver() {
  const observed = document.__e2eReviewCommands;
  if (!observed) throw new Error("review command observer was not installed");
  document.execCommand = observed.original;
  delete document.__e2eReviewCommands;
  return observed.commands;
}

export function assertRefusedReview({ name, commands, requests, expectedText }) {
  assert.deepEqual(commands, [], `${name}: a refused claim performs no local editing command`);
  const accepts = requests.filter((r) => r.path === "/suggestion" && r.op === "accept");
  assert.deepEqual(accepts, [], `${name}: a refused claim never records an acceptance`);
  for (const row of requests.filter((r) => r.path === "/draft")) {
    assert.equal(row.text, expectedText, `${name}: a refused page may autosave only the unchanged remote merge`);
    assert.ok(row.status === 200 || row.status === 409 && row.draftChanged === true, `${name}: a remote-merge autosave is stored or explicitly refused as a causal conflict`);
  }
}
