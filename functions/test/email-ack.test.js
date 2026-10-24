// SPDX-License-Identifier: Apache-2.0
// A native retry cannot consume a notification cooldown without delivering its unique winning claim (SPEC §14, §22).
const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore } = require("./fakes.js");
const { loseFirstTransactionAcknowledgement } = require("./transaction-ack.js");
const { claimCommentCooldown } = require("../lib/email/notify.js");
for (const kind of ["comment", "suggestion"]) test(`${kind} cooldown acknowledges its own claim after native commit ACK loss`, async () => {
  const { db, store } = fakeFirestore({ "users/owner": { email: "owner@example.com" }, "docs/d": { ownerEmail: "owner@example.com", ownerUid: "owner", members: ["owner@example.com"] } });
  const count = loseFirstTransactionAcknowledgement(db);
  assert.equal(await claimCommentCooldown(db, "owner", "d", kind), true, "the committed winning claim still permits its notification");
  assert.deepEqual(count(), { failures: 1, callbackCalls: 2 });
  assert.equal(await claimCommentCooldown(db, "owner", "d", kind), false, "a distinct call remains suppressed by the cooldown");
  assert.ok(store.get("users/owner").emailCooldowns);
});
function cooldownWorld(extra = {}) {
  return fakeFirestore({ "users/owner": { email: "owner@example.com", ...extra }, "docs/d": { ownerEmail: "owner@example.com", ownerUid: "owner", members: ["owner@example.com"] }, "docs/other": { ownerEmail: "owner@example.com", ownerUid: "owner", members: ["owner@example.com"] } });
}
test("different same-millisecond notification calls cannot reuse a claim receipt", async () => {
  const { db, store } = cooldownWorld(), now = Date.now();
  assert.equal(await claimCommentCooldown(db, "owner", "d", "comment", now), true);
  const receipt = store.get("users/owner").emailCooldownClaims.d;
  assert.equal(typeof receipt, "string");
  assert.equal(await claimCommentCooldown(db, "owner", "d", "comment", now), false);
  assert.equal(store.get("users/owner").emailCooldowns.d, now, "legacy timestamp shape stays numeric");
  assert.equal(store.get("users/owner").emailCooldownClaims.d, receipt);
});
test("native claim acknowledgement still checks fresh opt-out and read authority", async () => {
  for (const optOut of [true, false]) {
    const { db } = cooldownWorld();
    loseFirstTransactionAcknowledgement(db, { afterCommit: async () => {
      if (optOut) await db.doc("users/owner").update({ emailNotifications: false });
      else await db.doc("docs/d").update({ ownerEmail: "other@example.com", ownerUid: "other", members: [] });
    } });
    assert.equal(await claimCommentCooldown(db, "owner", "d"), false, "a claimed notice cannot bypass a later opt-out or revocation");
  }
});
test("a concurrent claim for another document preserves the original retry receipt", async () => {
  const { db, store } = cooldownWorld(), now = Date.now();
  loseFirstTransactionAcknowledgement(db, { afterCommit: async () => {
    assert.equal(await claimCommentCooldown(db, "owner", "other", "comment", now), true);
  } });
  assert.equal(await claimCommentCooldown(db, "owner", "d", "comment", now), true);
  assert.deepEqual(Object.keys(store.get("users/owner").emailCooldownClaims).sort(), ["d", "other"]);
});
test("cooldown receipts prune expired entries alongside compatible numeric timestamps", async () => {
  const now = Date.now(), { db, store } = cooldownWorld({ emailCooldowns: { old: 1, recent: now - 1 }, emailCooldownClaims: { old: "expired", recent: "retained" } });
  assert.equal(await claimCommentCooldown(db, "owner", "d", "comment", now), true);
  const user = store.get("users/owner");
  assert.deepEqual(Object.keys(user.emailCooldowns).sort(), ["d", "recent"]);
  assert.deepEqual(Object.keys(user.emailCooldownClaims).sort(), ["d", "recent"]);
  assert.equal(user.emailCooldownClaims.recent, "retained");
});
test("native claim retry checks expiry at its fresh clock while retaining the original cooldown timestamp", async () => {
  const clock = Date.now, now = clock();
  try {
    for (const owner of [false, true]) {
      Date.now = () => now;
      const { db } = cooldownWorld();
      await db.doc("docs/d").update({ ownerEmail: owner ? "owner@example.com" : "other@example.com", ownerUid: owner ? "owner" : "other", expiresAt: require("firebase-admin/firestore").Timestamp.fromMillis(now + 1000) });
      loseFirstTransactionAcknowledgement(db, { afterCommit: async () => { Date.now = () => now + 2000; } });
      assert.equal(await claimCommentCooldown(db, "owner", "d", "comment", now), owner, "expiry at the retry denies a reader while preserving the owner exception");
    }
  } finally { Date.now = clock; }
});
