// SPDX-License-Identifier: Apache-2.0
// Natural race retries retain missed windows and never discard assertion failures; refused reviews cannot apply locally (SPEC §16, §22).

import { test } from "node:test";
import assert from "node:assert/strict";
import { naturalRaceAttempts, installReviewCommandObserver, finishReviewCommandObserver, assertRefusedReview } from "../lib/review-race.mjs";

test("natural retries retain every missed window and stop at the first achieved window", async () => {
  const records = [], calls = [];
  const result = await naturalRaceAttempts({ run: async n => { calls.push(n); return { achieved: n === 2, diagnostic: `window ${n}` }; }, record: rows => records.push(structuredClone(rows)) });
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(result.attempts.map(x => x.outcome), ["window-missed", "achieved"]);
  assert.deepEqual(records.map(x => x.length), [1, 2]);
  assert.equal(records[0][0].diagnostic, "window 1");
});
test("exhausted natural attempts stay unachieved and product errors stop immediately", async () => {
  const records = [];
  const exhausted = await naturalRaceAttempts({ run: async () => ({ achieved: false, diagnostic: "no overlap" }), record: rows => records.push(structuredClone(rows)) });
  assert.equal(exhausted.achieved, false); assert.equal(exhausted.attempts.length, 3);
  let calls = 0;
  const failure = new assert.AssertionError({ message: "genuine product failure" });
  await assert.rejects(naturalRaceAttempts({ run: async () => { calls++; throw failure; }, record: rows => records.push(structuredClone(rows)) }), error => error === failure);
  assert.equal(calls, 1); assert.equal(records.at(-1)[0].outcome, "stopped");
  assert.equal(records.at(-1)[0].error, "genuine product failure");
  await assert.rejects(naturalRaceAttempts({ max: 4 }), /bounded/);
});
test("review command observer invokes the original API and distinguishes remote changes", () => {
  const calls = [], original = function (...args) { calls.push([this, args]); return true; };
  const doc = { execCommand: original, body: { textContent: "quote" } };
  const install = new Function("document", `return (${installReviewCommandObserver.toString()})();`);
  const finish = new Function("document", `return (${finishReviewCommandObserver.toString()})();`);
  install(doc); doc.body.textContent = "remote replacement";
  assert.deepEqual(doc.__e2eReviewCommands.commands, []);
  assert.equal(doc.execCommand("insertText", false, "local"), true);
  assert.deepEqual(finish(doc), [{ command: "inserttext", value: "local" }]);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], doc); assert.equal(doc.execCommand, original);
  assert.throws(() => finish(doc), /not installed/);
});
test("a refused review allows only an unchanged remote autosave and no local edit or decision", () => {
  const clean = { name: "p2", commands: [], requests: [{ path: "/draft", text: "merged", status: 200 }], expectedText: "merged" };
  assertRefusedReview(clean);
  assertRefusedReview({ ...clean, requests: [{ path: "/draft", text: "merged", status: 409, draftChanged: true }] });
  assert.throws(() => assertRefusedReview({ ...clean, commands: [{ command: "inserttext", value: "local" }] }), /no local editing command/);
  assert.throws(() => assertRefusedReview({ ...clean, requests: [{ path: "/suggestion", op: "accept" }] }), /never records an acceptance/);
  assert.throws(() => assertRefusedReview({ ...clean, requests: [{ path: "/draft", text: "locally changed", status: 200 }] }), /only the unchanged remote merge/);
  assert.throws(() => assertRefusedReview({ ...clean, requests: [{ path: "/draft", text: "merged", status: 500 }] }), /stored or explicitly refused/);
});

test("a single natural attempt retains a missed window rather than claiming success", async () => {
  const records = [];
  let calls = 0;
  const result = await naturalRaceAttempts({ max: 1,
    run: async () => { calls++; return { achieved: false, diagnostic: "serialized delivery" }; },
    record: rows => records.push(structuredClone(rows)),
  });
  assert.equal(calls, 1);
  assert.equal(result.achieved, false);
  assert.deepEqual(records, [[{ attempt: 1, outcome: "window-missed", diagnostic: "serialized delivery" }]]);
});
