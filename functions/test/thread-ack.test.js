// SPDX-License-Identifier: Apache-2.0
// Thread decisions retain their completed note across native transaction retries and never undo a later opposite decision (SPEC §6, §19).
const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore } = require("./fakes.js");
const { loseFirstTransactionAcknowledgement } = require("./transaction-ack.js");
const { setThreadResolved } = require("../lib/lib/threads.js");
const path = "docs/d/versions/v1/annotations/a";
for (const resolved of [false, true]) for (const later of [false, true]) test(`thread resolution acknowledges one committed note, resolved=${resolved}, later opposite=${later}`, async () => {
  const { db, store } = fakeFirestore({ "docs/d": { currentVersion: "v1" }, [path]: { resolved: !resolved } });
  const count = loseFirstTransactionAcknowledgement(db, { afterCommit: async () => {
    if (later) {
      await db.doc(path).update({ resolved: !resolved, resolvedBy: { uid: "later" } });
      await db.doc("docs/d").update({ currentVersion: "v2" });
    }
  } });
  const result = await setThreadResolved({ db, docRef: db.doc("docs/d"), versionId: "v1", annId: "a", resolved, caller: { uid: "owner", emailLower: "owner@example.com" }, actor: { uid: "owner", channel: "mcp" } });
  assert.deepEqual(result, { resolved, changed: true }, "the native retry acknowledges its original successful decision");
  assert.equal(store.get(path).resolved, later ? !resolved : resolved, "acknowledgement does not undo a later opposite decision");
  const comments = [...store].filter(([key]) => key.startsWith(`${path}/comments/`));
  assert.equal(comments.length, 1, "the native retry creates no duplicate generated note");
  assert.equal(comments[0][1].body, resolved ? "Resolved." : "Reopened.");
  if (later) assert.equal(store.get(path).resolvedBy.uid, "later");
  assert.deepEqual(count(), { callbackCalls: 2, failures: 1 });
});
