// SPDX-License-Identifier: Apache-2.0
// How often a person is emailed about one document: comments and suggestions apart (SPEC §14, §22).

const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore } = require("./fakes");
const { claimCommentCooldown } = require("../lib/email/notify.js");

const MIN = 60 * 1000;
const T0 = 1_800_000_000_000;

const people = () =>
  fakeFirestore({
    "users/u1": { uid: "u1", email: "owner@example.com" },
    "users/quiet": { uid: "quiet", email: "quiet@example.com", emailNotifications: false },
  });

test("a comment email does not hold back the notice of a suggestion on the same document", async () => {
  // A waiting suggestion blocks the next version until somebody decides it, so
  // the owner hearing about a comment a minute earlier must not delay hearing
  // about it.
  const { db } = people();
  assert.equal(await claimCommentCooldown(db, "u1", "doc", "comment", T0), true);
  assert.equal(await claimCommentCooldown(db, "u1", "doc", "suggestion", T0 + MIN), true);
});

test("nor does a suggestion email hold back a comment", async () => {
  const { db } = people();
  assert.equal(await claimCommentCooldown(db, "u1", "doc", "suggestion", T0), true);
  assert.equal(await claimCommentCooldown(db, "u1", "doc", "comment", T0 + MIN), true);
});

test("suggestions are still limited among themselves, so a burst is one email", async () => {
  // An agent may leave twenty at once; twenty emails would be a flood.
  const { db } = people();
  assert.equal(await claimCommentCooldown(db, "u1", "doc", "suggestion", T0), true);
  assert.equal(await claimCommentCooldown(db, "u1", "doc", "suggestion", T0 + 5 * MIN), false);
  assert.equal(await claimCommentCooldown(db, "u1", "doc", "suggestion", T0 + 31 * MIN), true);
});

test("comments keep their thirty minutes", async () => {
  const { db } = people();
  assert.equal(await claimCommentCooldown(db, "u1", "doc", "comment", T0), true);
  assert.equal(await claimCommentCooldown(db, "u1", "doc", "comment", T0 + 29 * MIN), false);
  assert.equal(await claimCommentCooldown(db, "u1", "doc", "comment", T0 + 31 * MIN), true);
});

test("each document has its own limits", async () => {
  const { db } = people();
  assert.equal(await claimCommentCooldown(db, "u1", "a", "suggestion", T0), true);
  assert.equal(await claimCommentCooldown(db, "u1", "b", "suggestion", T0 + MIN), true);
});

test("somebody who turned email off, or has no account, is told nothing of either kind", async () => {
  const { db } = people();
  for (const kind of ["comment", "suggestion"]) {
    assert.equal(await claimCommentCooldown(db, "quiet", "doc", kind, T0), false);
    assert.equal(await claimCommentCooldown(db, "nobody", "doc", kind, T0), false);
  }
});

test("expired limits are pruned, of both kinds", async () => {
  const { db, store } = people();
  await claimCommentCooldown(db, "u1", "old", "comment", T0);
  await claimCommentCooldown(db, "u1", "old", "suggestion", T0);
  await claimCommentCooldown(db, "u1", "new", "comment", T0 + 31 * MIN);
  assert.deepEqual(Object.keys(store.get("users/u1").emailCooldowns), ["new"]);
});

// --- The trigger, end to end ------------------------------------------------

const { withFakeAdmin } = require("./fakes");
const { onCommentCreated } = require("../lib/index.js");

/** Run the comment trigger on one new comment; resolve to the addresses it emailed. */
async function notifyFor(db, comment, { docId = "doc", versionId = "v1", annId = "s1" } = {}) {
  const sent = [];
  const info = console.info;
  console.info = (line) => {
    const m = /^\[email\] skipped "(.*)" to (\S+):/.exec(String(line));
    if (m) sent.push({ subject: m[1], to: m[2] });
  };
  try {
    await withFakeAdmin({ db }, () =>
      onCommentCreated.run({
        data: { data: () => comment },
        params: { docId, versionId, annId, commentId: "c1" },
      }),
    );
  } finally {
    console.info = info;
  }
  return sent;
}

test("the trigger tells the owner about a new suggestion a minute after telling them about a comment", async () => {
  const now = Date.now();
  const { db } = fakeFirestore({
    "users/u-own": { uid: "u-own", email: "owner@example.com", emailCooldowns: { doc: now - MIN } },
    "users/u-sug": { uid: "u-sug", email: "sug@example.com" },
    "docs/doc": {
      title: "A document",
      ownerEmail: "owner@example.com",
      members: ["owner@example.com", "sug@example.com"],
      suggesterMembers: ["owner@example.com", "sug@example.com"],
      editorMembers: ["owner@example.com"],
      approverMembers: ["owner@example.com"],
      currentVersion: "v1",
    },
    "docs/doc/versions/v1/annotations/s1": {
      anchor: { elementId: "", exact: "old words", prefix: "", suffix: "", start: 0, end: 9 },
      resolved: false,
      suggestion: { replacement: "new words", state: "pending" },
    },
  });
  const opener = {
    authorEmail: "sug@example.com",
    actor: { uid: "u-sug", email: "sug@example.com", channel: "web" },
    body: "Replace “old words” with “new words”.",
    opensSuggestion: true,
    generated: true,
  };
  const sent = await notifyFor(db, opener);
  assert.deepEqual(sent.map((s) => s.to), ["owner@example.com"], JSON.stringify(sent));
  assert.match(sent[0].subject, /suggested an edit to/);

  // A plain comment on the same document a moment later is still held back:
  // the comment limit was set a minute ago and is untouched by the suggestion.
  const reply = { authorEmail: "sug@example.com", actor: opener.actor, body: "Also this." };
  assert.deepEqual(await notifyFor(db, reply), []);
});

test("a participant who moved address hears about the thread at the new one", async () => {
  // Ana wrote in the thread as ana@old before Google renamed her
  // (SPEC §14). Her account record now says ana@new; the comment she
  // wrote still says the old address, which finds nobody.
  const { db } = fakeFirestore({
    "users/u-own": { uid: "u-own", email: "owner@example.com" },
    "users/u-ana": { uid: "u-ana", email: "ana@new.example.com" },
    "docs/moved": { title: "Plan", ownerEmail: "owner@example.com", members: ["owner@example.com", "ana@new.example.com"] },
    "docs/moved/versions/v1/annotations/a1": { anchor: { exact: "words" }, resolved: false },
    "docs/moved/versions/v1/annotations/a1/comments/c0": {
      authorUid: "u-ana",
      authorEmail: "ana@old.example.com",
      body: "Earlier.",
    },
  });
  const reply = { authorUid: "u-own", authorEmail: "owner@example.com", actor: { uid: "u-own", channel: "web" }, body: "Reply." };
  const sent = await notifyFor(db, reply, { docId: "moved", annId: "a1" });
  assert.deepEqual(sent.map((s) => s.to), ["ana@new.example.com"], JSON.stringify(sent));
});

test("an author is not told about their own comment written under an address they left", async () => {
  // A tab still on the old token writes her old address into the comment;
  // she owns the document under the new one.
  const { db } = fakeFirestore({
    "users/u-ana": { uid: "u-ana", email: "ana@new.example.com" },
    "docs/hers": { title: "Hers", ownerEmail: "ana@new.example.com", members: ["ana@new.example.com"] },
    "docs/hers/versions/v1/annotations/a1": { anchor: { exact: "words" }, resolved: false },
  });
  const own = { authorUid: "u-ana", authorEmail: "ana@old.example.com", actor: { uid: "u-ana", channel: "web" }, body: "Note to self." };
  assert.deepEqual(await notifyFor(db, own, { docId: "hers", annId: "a1" }), []);
});
