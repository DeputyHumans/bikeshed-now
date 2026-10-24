// SPDX-License-Identifier: Apache-2.0
// A completed claim or release is never replayed over a later lease operation after native ACK loss (SPEC §22).
const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore } = require("./fakes.js");
const { loseFirstTransactionAcknowledgement } = require("./transaction-ack.js");
const { createSuggestion, changeSuggestion } = require("../lib/lib/suggestions.js");
const caller = { uid: "author", emailLower: "author@example.com" }, actor = { uid: caller.uid, email: caller.emailLower, channel: "web" };
async function world() {
  const w = fakeFirestore({ "docs/d": { currentVersion: "v1" } }), docRef = w.db.doc("docs/d");
  const made = await createSuggestion({ db: w.db, docRef, versionId: "v1", author: caller, actor, anchor: { exact: "old", elementId: "p", prefix: "", suffix: "", start: 0, end: 3 }, replacement: "new", note: "note", color: "#b5257b" });
  const path = `docs/d/versions/v1/annotations/${made.annId}`;
  return { ...w, path, claim: () => w.store.get(path).suggestion.claim ?? null, change: (op, nowMs = Date.now()) => changeSuggestion({ db: w.db, docRef, versionId: "v1", annId: made.annId, op, caller, actor, maySuggest: true, replacement: "new", nowMs }) };
}
for (const op of ["claim", "release"]) test(`native ${op} retry preserves a later distinct same-account lease operation`, async () => {
  const w = await world(), now = Date.now();
  if (op === "release") await w.change("claim", now - 1);
  let later;
  const count = loseFirstTransactionAcknowledgement(w.db, { afterCommit: async () => { await w.change(op === "claim" ? "release" : "claim", now + 1); later = w.claim(); } });
  assert.deepEqual(await w.change(op, now), { state: "pending" });
  assert.deepEqual(w.claim(), later, `native ${op} retry cannot replay its old lease state over later intent`);
  assert.equal(w.claim() === null, op === "claim");
  assert.ok(count().callbackCalls >= 3);
  assert.deepEqual(w.store.get(w.path).transactionReceipts ?? {}, {}, "both completed operations remove only their own receipts");
});
test("a release with no claim is read-only and creates no receipt", async () => {
  const w = await world(), before = JSON.stringify(w.store.get(w.path));
  assert.deepEqual(await w.change("release"), { state: "pending" });
  assert.equal(JSON.stringify(w.store.get(w.path)), before);
});
