// SPDX-License-Identifier: Apache-2.0
// An approver's agent declines a suggested edit, as the approver can in the app (SPEC §19, §22).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

const { fakeFirestore } = require("./fakes.js");
const { TOOLS } = require("../lib/mcp/tools.js");
const { pendingSuggestions } = require("../lib/lib/review.js");

const tool = (name) => TOOLS.find((t) => t.name === name);

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const APPROVER = { uid: "u-appr", emailLower: "appr@example.com" };
const EDITOR = { uid: "u-ed", emailLower: "ed@example.com" };
const SUGGESTER = { uid: "u-sug", emailLower: "sug@example.com" };

const S1 = "docs/d1/versions/v1/annotations/s1";

function suggestion(over = {}) {
  return {
    annId: "s1",
    anchor: { exact: "a single weekend", prefix: "cut over in ", suffix: ", and" },
    authorUid: SUGGESTER.uid,
    authorEmail: SUGGESTER.emailLower,
    resolved: false,
    suggestion: { replacement: "two weekends", state: "pending" },
    ...over,
  };
}

function world({ doc = {}, s1 = suggestion() } = {}) {
  const { db, store } = fakeFirestore({
    "docs/d1": {
      docId: "d1",
      title: "Migration",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      currentVersion: "v1",
      suggesters: [SUGGESTER.emailLower],
      editors: [EDITOR.emailLower],
      approvers: [APPROVER.emailLower],
      members: [OWNER.emailLower, SUGGESTER.emailLower, EDITOR.emailLower, APPROVER.emailLower],
      suggesterMembers: [OWNER.emailLower, SUGGESTER.emailLower, EDITOR.emailLower, APPROVER.emailLower],
      editorMembers: [OWNER.emailLower, EDITOR.emailLower, APPROVER.emailLower],
      approverMembers: [OWNER.emailLower, APPROVER.emailLower],
      visibility: "private",
      ...doc,
    },
    "docs/d1/versions/v1": { versionId: "v1", entry: "index.html", format: "html" },
    [S1]: s1,
    "docs/d1/versions/v1/annotations/c1": { annId: "c1", anchor: { exact: "Payments" }, resolved: false },
  });
  const ctx = (who) => ({
    db,
    caller: { ...who, channel: "mcp", tokenId: "t1" },
    actor: { uid: who.uid, email: who.emailLower, channel: "mcp", tokenId: "t1" },
  });
  const reject = (who, args = {}) => tool("reject_suggestion").run(ctx(who), { id: "d1", threadId: "s1", ...args });
  const notes = () =>
    [...store.entries()].filter(([p]) => p.startsWith(`${S1}/comments/`)).map(([, d]) => d);
  return { db, store, reject, notes, ann: () => store.get(S1) };
}

test("an approver's agent rejects a suggestion with its reason, and it stops holding back a version", async () => {
  const w = world();
  const docRef = w.db.collection("docs").doc("d1");
  assert.equal(await pendingSuggestions(docRef, "v1"), 1);

  const result = await w.reject(APPROVER, { reason: "  The fortnight is already in section 3.  " });
  assert.equal(result.state, "rejected");
  assert.equal(result.version, "v1");

  const a = w.ann();
  assert.equal(a.suggestion.state, "rejected");
  assert.equal(a.resolved, true);
  assert.equal(a.suggestion.decidedBy.channel, "mcp", "recorded as decided through an agent");
  assert.equal(a.suggestion.decidedBy.email, APPROVER.emailLower);
  const [note] = w.notes();
  assert.equal(note.body, "Rejected: The fortnight is already in section 3.");
  assert.equal(note.generated, true);
  assert.equal(note.actor.channel, "mcp");
  assert.equal(await pendingSuggestions(docRef, "v1"), 0);

  // A retry after a dropped response reports the outcome and writes nothing.
  assert.equal((await w.reject(APPROVER)).state, "rejected");
  assert.equal(w.notes().length, 1);
});

test("only the owner or an approver decides, as in the app", async () => {
  for (const who of [EDITOR, SUGGESTER]) {
    const w = world();
    await assert.rejects(w.reject(who), { message: "only the owner or an approver can accept or reject a suggestion" });
    assert.equal(w.ann().suggestion.state, "pending");
  }
  // Open editing widens who may edit, never who may decide.
  const open = world({ doc: { visibility: "public", publicEdit: true } });
  await assert.rejects(open.reject({ uid: "u-x", emailLower: "x@example.com" }), /only the owner or an approver/);
  assert.equal((await world().reject(OWNER)).state, "rejected");
});

test("a withdrawn, accepted or claimed suggestion is not rejected", async () => {
  const withdrawn = world({ s1: suggestion({ resolved: true, suggestion: { replacement: "two weekends", state: "withdrawn" } }) });
  await assert.rejects(withdrawn.reject(APPROVER), { message: "it has already been withdrawn" });
  assert.equal(withdrawn.ann().suggestion.state, "withdrawn");

  const accepted = world({ s1: suggestion({ resolved: true, suggestion: { replacement: "two weekends", state: "accepted" } }) });
  await assert.rejects(accepted.reject(APPROVER), { message: "it has already been accepted" });

  const until = admin.firestore.Timestamp.fromMillis(Date.now() + 60_000);
  const claimed = world({
    s1: suggestion({ suggestion: { replacement: "two weekends", state: "pending", claim: { uid: OWNER.uid, email: OWNER.emailLower, until } } }),
  });
  await assert.rejects(claimed.reject(APPROVER), { message: "owner@example.com is applying it right now" });
  assert.equal(claimed.ann().suggestion.state, "pending");
  assert.deepEqual(claimed.notes(), []);
});

test("a thread that is not a suggestion, an expired document and a bad id are refused", async () => {
  const w = world();
  await assert.rejects(w.reject(APPROVER, { threadId: "c1" }), { message: "no such suggestion" });
  await assert.rejects(w.reject(APPROVER, { threadId: "../s1" }), /threadId is required/);
  const expired = world({ doc: { expiresAt: Date.now() - 1000 } });
  await assert.rejects(expired.reject(OWNER), /expired/);
  assert.equal(expired.ann().suggestion.state, "pending");
});
