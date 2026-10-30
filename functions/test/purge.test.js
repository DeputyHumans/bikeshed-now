// SPDX-License-Identifier: Apache-2.0
// Deleting forever: what goes, what stays, the tombstone that keeps the id, the emailed code and the daily job (SPEC §4, ADR 0025).

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { fakeFirestore, fakeToken, withFakeAdmin, invoke } = require("./fakes.js");
const { emptyGrants } = require("../lib/lib/access.js");
const { computeMembership, persistDocMembership, uniqueDocId } = require("../lib/lib/folders.js");
const { purgeDocument, purgeFolder, purgeExpired, describePurge } = require("../lib/lib/purge.js");
const { restoreDocument } = require("../lib/lib/trash.js");
const { lineageFor } = require("../lib/lib/fork.js");
const { recordTriggered } = require("../lib/lib/events.js");
const { TOOLS, toolByName } = require("../lib/mcp/tools.js");
const presence = require("../lib/lib/presence.js");
const notify = require("../lib/email/notify.js");
const http = require("../lib/index.js");

const DAY = 86_400_000;
const owner = "owner@example.com", other = "other@example.com";
const uidOf = (email) => `u-${email.split("@")[0]}`;
const ago = (ms) => admin.firestore.Timestamp.fromMillis(Date.now() - ms);
const mark = (batch, msAgo = DAY, along) => ({ at: ago(msAgo), by: uidOf(owner), batch, ...(along ? { with: along } : {}) });

function owned(email, extra = {}) {
  const grants = { ...emptyGrants(), ...extra };
  return { ownerUid: uidOf(email), ownerEmail: email, ...grants, ...computeMembership(email, grants, null, new Map()), ...extra };
}

const saved = { presence: presence.clearPresence, sync: presence.syncPresenceAccess, code: notify.sendPurgeCode, storage: Object.getOwnPropertyDescriptor(admin, "storage") };
let cleared, objects, mailed;
beforeEach(() => {
  cleared = [];
  mailed = [];
  objects = new Set();
  presence.clearPresence = async (id) => cleared.push(id);
  presence.syncPresenceAccess = async () => {};
  notify.sendPurgeCode = async (...args) => (mailed.push(args), true);
  Object.defineProperty(admin, "storage", {
    configurable: true,
    value: () => ({
      bucket: () => ({
        deleteFiles: async ({ prefix }) => {
          for (const name of [...objects]) if (name.startsWith(prefix)) objects.delete(name);
        },
      }),
    }),
  });
});
afterEach(() => {
  presence.clearPresence = saved.presence;
  presence.syncPresenceAccess = saved.sync;
  notify.sendPurgeCode = saved.code;
  if (saved.storage) Object.defineProperty(admin, "storage", saved.storage);
});

/**
 * The owner's `plan` is in the Trash with everything a document gathers; it
 * is a fork of `source`, and `plan-2`, whose id `plan` is a prefix of, is
 * someone else's and stays. The owner's folder `top` went to the Trash with
 * their `memo`, another account's `theirs`, and `sub` with the owner's
 * `deep`; `stray` is still live inside it, which only a race leaves.
 */
function world() {
  const { db, store } = fakeFirestore({
    "docs/plan": owned(owner, { title: "Plan", currentVersion: "v2", trashed: mark("b-plan"), visibility: "public" }),
    "docs/plan/versions/v1": { entry: "index.html" },
    "docs/plan/versions/v2": { entry: "index.html" },
    "docs/plan/versions/v2/annotations/a1": { body: "hm" },
    "docs/plan/versions/v2/annotations/a1/comments/c1": { body: "agreed" },
    "docs/plan/events/e1": { type: "version.published" },
    "docs/plan/viewers/u-x": { ms: 1 },
    "docs/plan/views/s1": { ms: 1 },
    "docs/plan/acl/x1": { op: "grant" },
    "docs/plan/linkGrants/u-x": { token: "t" },
    "docs/plan/trust/u-x": { trusted: true },
    "public/plan": { title: "Plan", visibility: "public" },
    "forks/plan": { parentId: "source", parentVersion: "v1" },
    "docs/source": owned(other, { title: "Source", currentVersion: "v1", visibility: "public", stats: { forks: 2 } }),
    "docs/source/versions/v1": { entry: "index.html" },
    "docs/plan-2": owned(other, { title: "Plan", currentVersion: "v1" }),
    "docs/live": owned(owner, { title: "Live", currentVersion: "v1" }),
    "folders/top": owned(owner, { name: "Top", parentId: null, trashed: mark("b-top") }),
    "folders/top/acl/x1": { op: "grant" },
    "folders/sub": owned(owner, { name: "Sub", parentId: "top", ancestors: ["top"], trashed: mark("b-top", DAY, { folderId: "top", name: "Top" }) }),
    "docs/memo": owned(owner, { title: "Memo", currentVersion: "v1", folderId: "top", trashed: mark("b-top", DAY, { folderId: "top", name: "Top" }) }),
    "docs/memo/versions/v1": { entry: "index.html" },
    "docs/theirs": owned(other, { title: "Theirs", currentVersion: "v1", folderId: "top", trashed: mark("b-top", DAY, { folderId: "top", name: "Top" }) }),
    "docs/theirs/versions/v1": { entry: "index.html" },
    "docs/deep": owned(owner, { title: "Deep", currentVersion: "v1", folderId: "sub", trashed: mark("b-top", DAY, { folderId: "top", name: "Top" }) }),
    "docs/stray": owned(other, { title: "Stray", currentVersion: "v1", folderId: "top" }),
  });
  for (const name of ["docs/plan/bundles/x/index.html", "docs/plan/thumbs/v2/k/cover.jpg", "docs/plan/draft/index.html", "docs/plan-2/v1/index.html", "docs/memo/v1/index.html"]) objects.add(name);
  const under = (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix));
  return { db, store, under };
}

test("a document deleted forever leaves a tombstone and nothing else, and its original counts one fork fewer", async () => {
  const w = world();
  assert.equal(await purgeDocument(w.db, "plan", { ownerUid: uidOf(owner) }), "purged");
  assert.deepEqual(Object.keys(w.store.get("docs/plan")), ["purgedAt"], "only when it went, nothing a gate or query keys on");
  assert.deepEqual(w.under("docs/plan/"), [], "every version, thread, comment, event, view, grant and trust record");
  assert.equal(w.store.has("public/plan"), false, "its public mirror");
  assert.equal(w.store.has("forks/plan"), false, "its fork record");
  assert.equal(w.store.get("docs/source").stats.forks, 1, "the original's count");
  assert.deepEqual([...objects].sort(), ["docs/memo/v1/index.html", "docs/plan-2/v1/index.html"], "every object under docs/plan/, and nothing under docs/plan-2/");
  assert.deepEqual(cleared, ["plan"], "its live-editing state");
  assert.ok(w.store.has("docs/plan-2"), "a document whose id it prefixes is untouched");
});

test("only what is in the Trash, in scope, is ever deleted", async () => {
  const w = world();
  const before = JSON.stringify([...w.store]);
  assert.equal(await purgeDocument(w.db, "live", {}), "skipped", "not in the Trash");
  assert.equal(await purgeDocument(w.db, "theirs", { ownerUid: uidOf(owner) }), "skipped", "someone else's, early");
  assert.equal(await purgeDocument(w.db, "plan", { trashedBefore: Date.now() - 30 * DAY }), "skipped", "not there for 30 days yet");
  assert.equal(await purgeDocument(w.db, "nope", {}), "skipped", "no such document");
  assert.equal(JSON.stringify([...w.store]), before, "and nothing was written");
});

test("a purge that stopped after its tombstone is finished by the next daily run", async () => {
  const w = world();
  w.store.set("docs/half", { purgedAt: ago(0), purgePending: true });
  w.store.set("docs/half/versions/v1", { entry: "index.html" });
  objects.add("docs/half/v1/index.html");
  const report = await purgeExpired(w.db);
  assert.equal(report.finished, 1);
  assert.deepEqual(Object.keys(w.store.get("docs/half")), ["purgedAt"]);
  assert.deepEqual(w.under("docs/half/"), []);
  assert.equal(objects.has("docs/half/v1/index.html"), false);
  assert.equal(await purgeDocument(w.db, "half", {}), "skipped", "and a finished one is left alone");
});

test("a tombstone keeps its id from every other document, and takes no write that would make it one again", async () => {
  const w = world();
  await purgeDocument(w.db, "plan", { ownerUid: uidOf(owner) });
  const id = await uniqueDocId(w.db, "Plan");
  assert.notEqual(id, "plan", "a new document named Plan never gets the deleted one's id");
  await assert.rejects(persistDocMembership(w.db, w.db.collection("docs").doc("plan"), () => ({ ownerEmail: owner })), /no longer exists/);
  // Its versions going fires the version trigger: nothing is recorded into a log that is gone.
  await recordTriggered(w.db, "plan", "evt-1", [{ type: "version.withdrawn", audience: "readers", version: "v1", actor: { channel: "operator" } }]);
  assert.deepEqual(Object.keys(w.store.get("docs/plan")), ["purgedAt"]);
  assert.deepEqual(w.under("docs/plan/"), []);
});

test("after a purge, a view beacon, an agent's read and a restore find nothing and create nothing", async () => {
  const w = world();
  await purgeDocument(w.db, "plan", { ownerUid: uidOf(owner) });
  const before = JSON.stringify([...w.store]);
  await withFakeAdmin({ db: w.db, sessions: { s: { uid: uidOf(owner), email: owner, email_verified: true } } }, async () => {
    const beat = await invoke(http.recordView, { headers: { cookie: "__session=s" }, body: { docId: "plan", versionId: "v2", sessionId: "after-purge-session", ms: 1000 } });
    assert.notEqual(beat.status, 200, "the beacon is refused");
    const ctx = { db: w.db, caller: { uid: uidOf(owner), emailLower: owner, channel: "mcp" }, actor: { uid: uidOf(owner), channel: "mcp" } };
    await assert.rejects(Promise.resolve().then(() => toolByName("get_document").run(ctx, { id: "plan" })));
    await assert.rejects(restoreDocument({ ...ctx, caller: { ...ctx.caller, channel: "web" } }, "plan"), (e) => e.status === 404);
  });
  assert.equal(JSON.stringify([...w.store]), before, "the store is exactly as the purge left it");
});

test("a fork of a document deleted forever says so, rather than that its original is hidden", async () => {
  const w = world();
  w.store.set("docs/copy", owned(owner, { title: "Copy", currentVersion: "v1", forked: true }));
  w.store.set("forks/copy", { parentId: "plan", parentVersion: "v2" });
  const caller = { uid: uidOf(owner), emailLower: owner };
  const trashed = await lineageFor({ db: w.db, caller, docId: "copy" });
  assert.deepEqual([trashed.lineage.hiddenAncestor, trashed.lineage.deletedAncestor], [false, false], "in the Trash it is its owner's, and readable");
  await purgeDocument(w.db, "plan", { ownerUid: uidOf(owner) });
  const gone = await lineageFor({ db: w.db, caller, docId: "copy" });
  assert.deepEqual([gone.lineage.ancestors.length, gone.lineage.hiddenAncestor, gone.lineage.deletedAncestor], [0, false, true]);
});

test("a folder's early purge takes what of its owner's went with it, leaves another owner's in their Trash, and moves anything live to its owner's root", async () => {
  const w = world();
  const out = await purgeFolder(w.db, "top", { ownerUid: uidOf(owner) });
  assert.deepEqual(out, { folders: 2, documents: 2 });
  assert.equal(w.store.has("folders/top"), false);
  assert.equal(w.store.has("folders/sub"), false);
  assert.deepEqual(w.under("folders/top/"), [], "its access history");
  assert.deepEqual(Object.keys(w.store.get("docs/memo")), ["purgedAt"]);
  assert.deepEqual(Object.keys(w.store.get("docs/deep")), ["purgedAt"]);
  assert.ok(w.store.get("docs/theirs").trashed, "someone else's stays in their Trash");
  assert.equal(w.store.get("docs/stray").folderId, null, "a live one is not left under a folder that is gone");
  assert.equal(w.store.get("docs/stray").trashed, undefined);
  const theirs = { db: w.db, caller: { uid: uidOf(other), emailLower: other, channel: "web" }, actor: { uid: uidOf(other), channel: "web" } };
  assert.deepEqual(await restoreDocument(theirs, "theirs"), { id: "theirs", folderId: null }, "and its owner brings it back at their root");
});

test("the daily job deletes what has been in the Trash for 30 days, anyone's, and nothing newer", async () => {
  const w = world();
  w.store.set("docs/old", owned(other, { title: "Old", currentVersion: "v1", trashed: mark("b-old", 31 * DAY) }));
  w.store.set("docs/old/versions/v1", { entry: "index.html" });
  w.store.set("folders/top", { ...w.store.get("folders/top"), trashed: mark("b-top", 31 * DAY) });
  const report = await purgeExpired(w.db);
  assert.deepEqual({ documents: report.documents, folders: report.folders, more: report.more }, { documents: 4, folders: 2, more: false });
  for (const id of ["old", "memo", "theirs", "deep"]) assert.deepEqual(Object.keys(w.store.get(`docs/${id}`)), ["purgedAt"], id);
  assert.ok(w.store.get("docs/plan").trashed, "a day in the Trash is not 30");
  assert.equal(w.store.get("docs/stray").folderId, null);
});

test("the daily job stops at its deadline and says there is more", async () => {
  const w = world();
  w.store.set("docs/old", owned(other, { title: "Old", currentVersion: "v1", trashed: mark("b-old", 31 * DAY) }));
  const report = await purgeExpired(w.db, Date.now(), Date.now() - 1);
  assert.equal(report.more, true);
  assert.ok(w.store.get("docs/old").trashed, "and leaves the rest for tomorrow");
});

test("what a code is asked for says what will go, counted as the purge counts", async () => {
  const w = world();
  assert.deepEqual(await describePurge(w.db, uidOf(owner), { kind: "document", id: "plan" }), { kind: "document", title: "Plan", versions: 2 });
  assert.deepEqual(await describePurge(w.db, uidOf(owner), { kind: "folder", id: "top" }), { kind: "folder", title: "Top", documents: 2, folders: 1, theirs: 1 });
  assert.deepEqual(await describePurge(w.db, uidOf(owner), { all: true }), { kind: "all", documents: 3, folders: 2 });
  assert.equal(await describePurge(w.db, uidOf(owner), { kind: "document", id: "theirs" }), null, "someone else's is not in this Trash");
  assert.equal(await describePurge(w.db, uidOf(owner), { kind: "document", id: "live" }), null, "nor is what is not in a Trash");
});

// --- POST /purge -------------------------------------------------------------

async function withEmail(on, fn) {
  const previous = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = on ? "re_test" : " ";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previous;
  }
}

function endpoint(w, extra = {}) {
  const sessions = { s: { uid: uidOf(owner), email: owner, email_verified: true } };
  return (fn) => withFakeAdmin({ db: w.db, sessions, ...extra }, () => fn((body, headers = { cookie: "__session=s" }) => invoke(http.purgeTrash, { headers, body })));
}

test("GET /purge says whether deleting early is possible here, uncached", async () => {
  const w = world();
  for (const on of [true, false]) {
    await withEmail(on, () => endpoint(w)(async () => {
      const r = await invoke(http.purgeTrash, { method: "GET" });
      assert.deepEqual({ status: r.status, body: r.body, cache: r.headers["cache-control"] }, { status: 200, body: { available: on, retentionDays: 30 }, cache: "private, no-store" });
    }));
  }
});

test("a token is refused, whoever's, and so is no credential; email off refuses with a reason", async () => {
  const w = world();
  const token = fakeToken({ uid: uidOf(owner), email: owner, channel: "cli" });
  w.store.set(token.path, token.record);
  const before = JSON.stringify([...w.store]);
  await withEmail(true, () => endpoint(w)(async (post) => {
    const agent = await post({ op: "code", target: { kind: "document", id: "plan" } }, { authorization: `Bearer ${token.bearer}` });
    assert.equal(agent.status, 403);
    assert.match(agent.body.error, /in the browser/);
    assert.equal((await post({ op: "code", target: { all: true } }, {})).status, 401);
  }));
  await withEmail(false, () => endpoint(w)(async (post) => {
    const off = await post({ op: "code", target: { kind: "document", id: "plan" } });
    assert.deepEqual([off.status, off.body.emailOff], [409, true]);
  }));
  assert.deepEqual(mailed, []);
  assert.equal(JSON.stringify([...w.store]), before);
});

test("a code is sent for exactly one thing, kept where no client can read it, and once a minute", async () => {
  const w = world();
  await withEmail(true, () => endpoint(w)(async (post) => {
    assert.equal((await post({ op: "code", target: { kind: "document", id: "theirs" } })).status, 404, "not in this account's Trash");
    const sent = await post({ op: "code", target: { kind: "document", id: "plan" } });
    assert.deepEqual(sent.body, { sentTo: "o•••@example.com", expiresInMinutes: 10, summary: { kind: "document", title: "Plan", versions: 2 } });
    const [to, code, minutes, what] = mailed[0];
    assert.deepEqual([to, minutes, what], [owner, 10, "“Plan” and its 2 versions"]);
    assert.match(code, /^\d{6}$/);
    const kept = w.store.get(`purgeCodes/${uidOf(owner)}`);
    assert.equal(kept.key, "document:plan");
    assert.ok(!JSON.stringify(kept).includes(code), "a hash, never the code");
    assert.equal(w.store.has(`users/${uidOf(owner)}`), false, "and nothing on the record the account can read");
    assert.equal((await post({ op: "code", target: { kind: "document", id: "plan" } })).status, 429);
    assert.equal(mailed.length, 1);
  }));
});

test("the right code deletes exactly what it was sent for, once", async () => {
  const w = world();
  await withEmail(true, () => endpoint(w)(async (post) => {
    await post({ op: "code", target: { kind: "document", id: "plan" } });
    const code = mailed[0][1];
    const elsewhere = await post({ op: "confirm", target: { all: true }, code });
    assert.equal(elsewhere.status, 409, "a code for one document does not empty the Trash");
    assert.ok(w.store.get("docs/memo").trashed);
    const done = await post({ op: "confirm", target: { kind: "document", id: "plan" }, code });
    assert.deepEqual([done.status, done.body], [200, { folders: 0, documents: 1 }]);
    assert.deepEqual(Object.keys(w.store.get("docs/plan")), ["purgedAt"]);
    assert.equal(w.store.has(`purgeCodes/${uidOf(owner)}`), false, "spent and gone");
    w.store.set("docs/plan2", owned(owner, { title: "Again", currentVersion: "v1", trashed: mark("b-2") }));
    assert.equal((await post({ op: "confirm", target: { kind: "document", id: "plan2" }, code })).status, 409, "and spent once");
    assert.ok(w.store.get("docs/plan2").trashed);
  }));
});

test("five wrong codes burn it: the sixth attempt is refused even when right, and nothing is deleted", async () => {
  const w = world();
  await withEmail(true, () => endpoint(w)(async (post) => {
    await post({ op: "code", target: { all: true } });
    const code = mailed[0][1];
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) assert.equal((await post({ op: "confirm", target: { all: true }, code: wrong })).status, 400);
    const sixth = await post({ op: "confirm", target: { all: true }, code });
    assert.equal(sixth.status, 429);
    assert.equal(w.store.has(`purgeCodes/${uidOf(owner)}`), false);
    assert.equal((await post({ op: "confirm", target: { all: true }, code })).status, 409, "a burned code is no code");
    assert.ok(w.store.get("docs/plan").trashed && w.store.get("folders/top").trashed);
  }));
});

test("no agent tool deletes anything forever", () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(!names.some((n) => /purge|forever|empty|destroy/.test(n)), names.join(", "));
  assert.ok(!names.some((n) => /^delete_/.test(n) && n !== "delete_folder"), "delete_folder trashes; nothing else deletes");
});
