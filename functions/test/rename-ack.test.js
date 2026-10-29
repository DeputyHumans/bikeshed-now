// SPDX-License-Identifier: Apache-2.0
// A native rename retry preserves newer names and emits its own change event only once (SPEC §4, §19).
const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore } = require("./fakes.js");
const { loseFirstTransactionAcknowledgement } = require("./transaction-ack.js");
const { renameDocument } = require("../lib/lib/rename.js");
const actor = { uid: "owner", email: "owner@example.com", channel: "web" };
function world() { return fakeFirestore({ "docs/d": { title: "Original", ownerEmail: actor.email, visibility: "private" } }); }
test("a native rename retry acknowledges its own result without undoing a later real rename", async () => {
  const { db, store } = world(), ref = db.doc("docs/d");
  const count = loseFirstTransactionAcknowledgement(db, { afterCommit: () => renameDocument(db, ref, "Newer", actor) });
  const result = await renameDocument(db, ref, "First", actor);
  assert.deepEqual(result, { title: "First" }, "original request acknowledges its committed result");
  assert.equal(store.get("docs/d").title, "Newer", "native retry cannot overwrite a later real rename");
  assert.equal(store.get("docs/d").slug, "newer");
  assert.deepEqual([...store].filter(([p]) => p.startsWith("docs/d/events/")).map(([,data]) => data.data), [{ from: "Original", to: "First" }, { from: "First", to: "Newer" }], "exactly the two real rename events remain");
  assert.ok(count().callbackCalls >= 3);
  assert.deepEqual(store.get("docs/d").transactionReceipts ?? {}, {}, "each successful request removes its own receipt");
});
test("a rename refuses a missing record instead of recreating a partial document", async () => {
  const { db, store } = world(); await db.doc("docs/d").delete();
  await assert.rejects(renameDocument(db, db.doc("docs/d"), "Missing", actor), /document no longer exists/);
  assert.equal(store.has("docs/d"), false);
});
