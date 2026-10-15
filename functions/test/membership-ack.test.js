// SPDX-License-Identifier: Apache-2.0
// Native commit retries preserve membership invitation deltas and never replay a completed user mutation over newer intent (SPEC §4, §13).
const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore, withFakeAdmin } = require("./fakes.js");
const { loseFirstTransactionAcknowledgement } = require("./transaction-ack.js");
const { persistFolderMembership, persistDocMembership } = require("../lib/lib/folders.js");
const owner = "owner@example.com", invitee = "new@example.com";
const initial = { ownerEmail: owner, name: "a folder", viewers: [], editors: [], suggesters: [], approvers: [], members: [owner], editorMembers: [owner], suggesterMembers: [owner], approverMembers: [owner], visibility: "private" };
function world() { return fakeFirestore({ "folders/f": initial, "docs/d": initial }); }

test("folder ACK retry preserves the committed before/after invitation delta", async () => {
  const { db, store } = world(), counts = loseFirstTransactionAcknowledgement(db); let changes = 0;
  const result = await persistFolderMembership(db, db.doc("folders/f"), current => { changes++; return { viewers: [...current.viewers, invitee] }; });
  assert.deepEqual(result.before.members, [owner], "a committed invitation still has its original before set");
  assert.deepEqual(result.membership.members, [invitee, owner]);
  assert.equal(result.data.name, "a folder");
  assert.equal(changes, 1, "the committed change callback runs only once");
  assert.deepEqual(counts(), { failures: 1, callbackCalls: 2 });
  assert.deepEqual(store.get("folders/f").transactionReceipts ?? {}, {}, "successful result removes only its bookkeeping receipt");
});
test("folder ACK retry does not regrant access revoked after its commit", async () => {
  const { db, store } = world();
  loseFirstTransactionAcknowledgement(db, { afterCommit: async () => { await db.doc("folders/f").update({ viewers: [], members: [owner] }); } });
  const result = await persistFolderMembership(db, db.doc("folders/f"), () => ({ viewers: [invitee] }));
  assert.deepEqual(result.membership.members, [invitee, owner], "the response acknowledges this request's own committed result");
  assert.deepEqual(store.get("folders/f").viewers, [], "the native retry cannot overwrite a later revocation");
  assert.deepEqual(store.get("folders/f").members, [owner]);
});
test("document ACK retry preserves callback deltas and emits its event once", async () => {
  const { db, store } = world(); loseFirstTransactionAcknowledgement(db);
  let beforeMembers = [], changes = 0, events = 0;
  const result = await withFakeAdmin({ db }, () => persistDocMembership(db, db.doc("docs/d"), current => {
    changes++; beforeMembers = current.members; return { viewers: [invitee] };
  }, (next, _before, previous) => {
    events++; beforeMembers = previous.members;
    return [{ type: "access.changed", audience: "editors", data: { added: next.members.filter(x => !previous.members.includes(x)), removed: [] } }];
  }));
  assert.deepEqual(beforeMembers, [owner], "request-local invitation delta is not replaced by postcommit membership");
  assert.deepEqual(result.members, [invitee, owner]);
  assert.equal(changes, 1); assert.equal(events, 1);
  assert.equal([...store.keys()].filter(k => k.startsWith("docs/d/events/")).length, 1, "one user mutation emits one event despite callback retry");
});
test("document ACK retry cannot overwrite a later move or emit a second move event", async () => {
  const { db, store } = world();
  loseFirstTransactionAcknowledgement(db, { afterCommit: async () => { await db.doc("docs/d").update({ folderId: "newer" }); } });
  await withFakeAdmin({ db }, () => persistDocMembership(db, db.doc("docs/d"), () => ({ folderId: "first" }), () => [{ type: "doc.moved", audience: "readers", data: { to: "first" } }]));
  assert.equal(store.get("docs/d").folderId, "newer", "a completed move is not replayed over a newer distinct move");
  assert.equal([...store.keys()].filter(k => k.startsWith("docs/d/events/")).length, 1);
});
test("pure membership recomputation creates no user-operation receipt", async () => {
  const { db, store } = world();
  await persistFolderMembership(db, db.doc("folders/f"));
  await withFakeAdmin({ db }, () => persistDocMembership(db, db.doc("docs/d")));
  assert.equal(store.get("folders/f").transactionReceipts, undefined);
  assert.equal(store.get("docs/d").transactionReceipts, undefined);
});
