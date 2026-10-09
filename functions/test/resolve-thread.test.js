// SPDX-License-Identifier: Apache-2.0
// An agent resolves and reopens threads as any reader may, and leaves a note saying so (SPEC §6, §19).

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeFirestore } = require("./fakes.js");
const { TOOLS } = require("../lib/mcp/tools.js");

const tool = (name) => TOOLS.find((t) => t.name === name);

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const VIEWER = { uid: "u-viewer", emailLower: "viewer@example.com" };
const STRANGER = { uid: "u-stranger", emailLower: "stranger@example.com" };

const THREAD = "docs/d1/versions/v2/annotations/t1";

function world(extra = {}) {
  const { db, store } = fakeFirestore({
    "docs/d1": {
      docId: "d1",
      title: "Migration",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      currentVersion: "v2",
      viewers: [VIEWER.emailLower],
      editors: [],
      approvers: [],
      members: [OWNER.emailLower, VIEWER.emailLower],
      editorMembers: [OWNER.emailLower],
      approverMembers: [OWNER.emailLower],
      visibility: "private",
      ...extra,
    },
    "docs/d1/versions/v1": { versionId: "v1" },
    "docs/d1/versions/v2": { versionId: "v2" },
    "docs/d1/versions/v1/annotations/old": { annId: "old", anchor: { exact: "before" }, resolved: false },
    [THREAD]: { annId: "t1", anchor: { exact: "a single weekend" }, authorEmail: OWNER.emailLower, resolved: false },
    [`${THREAD}/comments/c1`]: { commentId: "c1", body: "There is a dual-write period.", authorEmail: OWNER.emailLower },
    "docs/d1/versions/v2/annotations/s1": {
      annId: "s1",
      anchor: { exact: "Payments" },
      resolved: false,
      suggestion: { replacement: "Billing", state: "pending" },
    },
  });
  const ctx = (who) => ({
    db,
    caller: { ...who, channel: "mcp", tokenId: "t1" },
    actor: { uid: who.uid, email: who.emailLower, channel: "mcp", tokenId: "t1" },
  });
  const call = (name, who, args) => tool(name).run(ctx(who), { id: "d1", ...args });
  const notes = (path = THREAD) =>
    [...store.entries()]
      .filter(([p]) => p.startsWith(`${path}/comments/`) && p !== `${path}/comments/c1`)
      .map(([, d]) => d);
  return { store, call, notes, thread: () => store.get(THREAD) };
}

test("a reader's agent resolves, reopens and resolves again, with a note each time it changed", async () => {
  // One thread through the sequence a review actually takes, rather than each
  // state on its own: an agent closes a point, the reviewer disagrees, it is
  // dealt with properly, closed again — and a retry changes nothing.
  const w = world();

  const first = await w.call("resolve_thread", VIEWER, { threadId: "t1" });
  assert.deepEqual({ threadId: first.threadId, version: first.version, resolved: first.resolved }, {
    threadId: "t1",
    version: "v2",
    resolved: true,
  });
  assert.equal(w.thread().resolved, true);

  await w.call("reopen_thread", VIEWER, { threadId: "t1" });
  assert.equal(w.thread().resolved, false);

  await w.call("resolve_thread", VIEWER, { threadId: "t1" });
  await w.call("resolve_thread", VIEWER, { threadId: "t1" });
  assert.equal(w.thread().resolved, true);

  const notes = w.notes();
  assert.deepEqual(
    notes.map((n) => n.body),
    ["Resolved.", "Reopened.", "Resolved."],
    "one note per change, and none for the retry",
  );
  for (const n of notes) {
    assert.equal(n.generated, true, "written by the server, so no client may rewrite it");
    assert.equal(n.authorEmail, VIEWER.emailLower, "in the name of the person whose agent did it");
    assert.equal(n.actor.channel, "mcp", "and marked as done through an agent");
  }
  assert.equal(w.thread().anchor.exact, "a single weekend", "nothing but resolved changes on the thread");
});

test("a suggested edit is decided, never resolved or reopened", async () => {
  const w = world();
  for (const name of ["resolve_thread", "reopen_thread"]) {
    await assert.rejects(w.call(name, OWNER, { threadId: "s1" }), /settled by accepting, rejecting or withdrawing it/);
  }
  const s = w.store.get("docs/d1/versions/v2/annotations/s1");
  assert.equal(s.resolved, false);
  assert.equal(s.suggestion.state, "pending");
  assert.deepEqual(w.notes("docs/d1/versions/v2/annotations/s1"), []);
});

test("only the current version's threads, and only for someone who may read the document", async () => {
  const w = world();
  await assert.rejects(w.call("resolve_thread", OWNER, { threadId: "old" }), { message: "no such thread" });
  assert.equal(w.store.get("docs/d1/versions/v1/annotations/old").resolved, false, "an earlier version's review stays as it was");
  await assert.rejects(w.call("resolve_thread", OWNER, { threadId: "nope" }), { message: "no such thread" });
  await assert.rejects(w.call("resolve_thread", STRANGER, { threadId: "t1" }), { message: 'no document with id "d1"' });
  await assert.rejects(w.call("resolve_thread", OWNER, { threadId: "../t1" }), /threadId is required/);
  assert.equal(w.thread().resolved, false);
});

test("an expired document is frozen, its owner's resolve included", async () => {
  const w = world({ expiresAt: Date.now() - 1000 });
  await assert.rejects(w.call("resolve_thread", OWNER, { threadId: "t1" }), /expired/);
  assert.equal(w.thread().resolved, false);
});
