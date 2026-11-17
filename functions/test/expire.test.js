// SPDX-License-Identifier: Apache-2.0
// When a date passes: private, the date cleared, recorded once, and the hourly job that does it (SPEC §17, ADR 0029).

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { fakeFirestore } = require("./fakes.js");
const { emptyGrants } = require("../lib/lib/access.js");
const { computeMembership, recomputeSubtree } = require("../lib/lib/folders.js");
const { expireDocument, expireFolder, expireDue } = require("../lib/lib/expire.js");
const presence = require("../lib/lib/presence.js");
const publicdoc = require("../lib/lib/publicdoc.js");

const DAY = 86_400_000;
const NOW = Date.now();
const owner = "owner@example.com", viewer = "viewer@example.com";
const ts = (ms) => admin.firestore.Timestamp.fromMillis(ms);

function owned(extra = {}) {
  const grants = { ...emptyGrants(), viewers: [viewer] };
  return { ownerUid: "u-owner", ownerEmail: owner, ...grants, ...computeMembership(owner, grants, null), folderId: null, ...extra };
}

const saved = { sync: presence.syncPresenceAccess, project: publicdoc.syncPublicProjection };
let synced;
beforeEach(() => {
  synced = [];
  presence.syncPresenceAccess = async (id) => void synced.push(id);
});
afterEach(() => {
  presence.syncPresenceAccess = saved.sync;
  publicdoc.syncPublicProjection = saved.project;
});

const events = (store, id, type = "doc.expired") =>
  [...store.entries()].filter(([p, d]) => p.startsWith(`docs/${id}/events/`) && d.type === type).map(([, d]) => d);

test("a passed date makes a shared document private, ends its link and open editing, and keeps the people", async () => {
  const due = NOW - 1000;
  const { db, store } = fakeFirestore({
    "docs/d": owned({ title: "Plan", visibility: "unlisted", publicEdit: true, linkToken: "k".repeat(22), expiresAt: ts(due) }),
    "public/d": { title: "stale" },
  });
  const before = store.get("docs/d");
  assert.equal(await expireDocument(db, "d", NOW), "expired");
  const after = store.get("docs/d");
  assert.deepEqual(
    [after.visibility, after.publicEdit, "linkToken" in after, "expiresAt" in after],
    ["private", false, false, false],
  );
  assert.deepEqual([after.viewers, after.members], [before.viewers, before.members], "the people it was shared with keep it");
  assert.equal(store.has("public/d"), false, "a private document has no public mirror");
  assert.deepEqual(synced, ["d"], "the realtime maps learn the date is gone");
  const [event, ...more] = events(store, "d");
  assert.equal(more.length, 0, "recorded once");
  assert.deepEqual(
    [event.audience, event.actor, event.data],
    ["editors", { uid: null, channel: "system", via: "its end date" }, { expiresAt: due, from: "unlisted", endedOpenEditing: true }],
  );
});

test("on a document already private, a passed date is only cleared, and that is still recorded", async () => {
  const { db, store } = fakeFirestore({ "docs/d": owned({ visibility: "private", publicEdit: false, expiresAt: ts(NOW - 1) }) });
  const before = store.get("docs/d");
  assert.equal(await expireDocument(db, "d", NOW), "expired");
  const { updatedAt: _a, expiresAt: _gone, ...was } = before;
  const { updatedAt: _b, ...is } = store.get("docs/d");
  assert.deepEqual(is, was);
  assert.deepEqual(events(store, "d").map((e) => e.data.from), ["private"]);
});

test("a date still to come, or cleared since the query read it, is left alone", async () => {
  const { db, store } = fakeFirestore({
    "docs/later": owned({ visibility: "public", expiresAt: ts(NOW + DAY) }),
    "docs/cleared": owned({ visibility: "public" }),
  });
  const before = new Map(store);
  assert.equal(await expireDocument(db, "later", NOW), "skipped");
  assert.equal(await expireDocument(db, "cleared", NOW), "skipped");
  assert.deepEqual((await expireDue(db, NOW)).documents, 0);
  assert.deepEqual(store, before);
});

test("a new date set while the run worked is the owner's, and is kept", async () => {
  const { db, store } = fakeFirestore({ "docs/d": owned({ visibility: "unlisted", linkToken: "k".repeat(22), expiresAt: ts(NOW - 1) }) });
  // Between making it private and clearing the date, the owner sets another:
  // once, at the first mirror sync, which runs before the date is cleared.
  let calls = 0;
  publicdoc.syncPublicProjection = async () => {
    if (calls++ === 0) store.set("docs/d", { ...store.get("docs/d"), expiresAt: ts(NOW + 7 * DAY) });
  };
  assert.equal(await expireDocument(db, "d", NOW), "expired");
  assert.equal(store.get("docs/d").expiresAt.toMillis(), NOW + 7 * DAY);
  assert.equal(store.get("docs/d").visibility, "private");
});

test("a run that stopped part way is finished by the next, and the change is recorded once", async () => {
  const { db, store } = fakeFirestore({ "docs/d": owned({ visibility: "public", expiresAt: ts(NOW - 1) }) });
  publicdoc.syncPublicProjection = async () => { throw new Error("killed"); };
  await assert.rejects(expireDocument(db, "d", NOW), /killed/);
  assert.equal(store.get("docs/d").visibility, "private", "private first");
  assert.ok(store.get("docs/d").expiresAt, "the date goes last, so the query still finds it");
  publicdoc.syncPublicProjection = saved.project;
  const report = await expireDue(db, NOW);
  assert.equal(report.documents, 1);
  assert.equal("expiresAt" in store.get("docs/d"), false);
  assert.equal(events(store, "d").length, 1, "the second run found the first run's record");
  assert.equal(events(store, "d")[0].data.from, "public", "and it still says what it was");
});

test("a deleted document's tombstone is never written to", async () => {
  const { db, store } = fakeFirestore({ "docs/gone": { purgedAt: ts(NOW - DAY), expiresAt: ts(NOW - 1) } });
  const before = new Map(store);
  assert.equal(await expireDocument(db, "gone", NOW), "skipped");
  assert.deepEqual(store, before);
});

test("something in the Trash is left as it was, and made private once it is restored", async () => {
  const { db, store } = fakeFirestore({
    "docs/d": owned({ visibility: "public", expiresAt: ts(NOW - 1), trashed: { at: ts(NOW - DAY), by: "u-owner", batch: "b" } }),
  });
  const before = new Map(store);
  const first = await expireDue(db, NOW);
  assert.deepEqual([first.documents, first.trashed], [0, 1]);
  assert.deepEqual(store, before, "Restore gives back exactly what it took");
  const { trashed: _t, ...restored } = store.get("docs/d");
  store.set("docs/d", restored);
  const second = await expireDue(db, NOW);
  assert.deepEqual([second.documents, second.trashed], [1, 0]);
  assert.equal(store.get("docs/d").visibility, "private");
});

test("a page of trashed items does not hide the ones after it", async () => {
  const seed = {};
  // More than a page, all due before the one live document.
  for (let i = 0; i < 101; i++) {
    seed[`docs/t${String(i).padStart(3, "0")}`] = owned({ visibility: "public", expiresAt: ts(NOW - 10 * DAY + i), trashed: { at: ts(NOW - DAY), by: "u-owner", batch: "b" } });
  }
  seed["docs/live"] = owned({ visibility: "public", expiresAt: ts(NOW - 1) });
  const { db, store } = fakeFirestore(seed);
  const report = await expireDue(db, NOW);
  assert.deepEqual([report.trashed, report.documents], [101, 1]);
  assert.equal(store.get("docs/live").visibility, "private");
});

test("a run past its deadline stops, says there is more, and changes nothing", async () => {
  const { db, store } = fakeFirestore({ "docs/d": owned({ visibility: "public", expiresAt: ts(NOW - 1) }) });
  const before = new Map(store);
  const report = await expireDue(db, NOW, Date.now() - 1);
  assert.equal(report.more, true);
  assert.deepEqual(store, before);
});

test("a folder's passed date makes it private: its link and its reach end, its members keep it, and its history says so", async () => {
  const due = NOW - 1000;
  const grants = { ...emptyGrants(), viewers: [viewer] };
  const folder = (id, parentId, extra = {}) => ({
    folderId: id, name: id, ownerUid: "u-owner", ownerEmail: owner, parentId, ancestors: parentId ? [parentId] : [], depth: parentId ? 1 : 0,
    ...grants, ...computeMembership(owner, grants, null), ...extra,
  });
  const { db, store } = fakeFirestore({
    "folders/top": folder("top", null, { visibility: "public", expiresAt: ts(NOW + DAY) }),
    "folders/sub": folder("sub", "top"),
    "docs/memo": owned({ folderId: "sub", visibility: "private", currentVersion: "v1" }),
    "docs/memo/versions/v1": { entry: "index.html" },
  });
  await recomputeSubtree(db, "top");
  await saved.project(db, "memo");
  assert.ok(store.get("folders/sub").reach.length > 0, "the setup reaches the subfolder");
  assert.ok(store.has("public/memo"), "and mirrors the document beneath it");
  // Then the date comes round, before the job has run.
  store.set("folders/top", { ...store.get("folders/top"), expiresAt: ts(due) });

  assert.equal(await expireFolder(db, "top", NOW), "expired");
  const top = store.get("folders/top");
  assert.deepEqual([top.visibility, "linkToken" in top, "expiresAt" in top], ["private", false, false]);
  assert.deepEqual(top.viewers, [viewer], "its members keep it");
  assert.deepEqual(store.get("folders/sub").reach, [], "nothing above reaches the subfolder any more");
  assert.equal(store.has("public/memo"), false, "nor the document beneath it");
  const entries = [...store.entries()].filter(([p]) => p.startsWith("folders/top/acl/")).map(([, d]) => d);
  assert.equal(entries.length, 1);
  assert.deepEqual(
    [entries[0].reason, entries[0].actor.channel, entries[0].visibility, entries[0].expiresAt],
    ["expired", "system", { from: "public", to: "private" }, { from: due, to: null }],
  );
});

test("the job runs hourly from a schedule, with no instance kept warm", () => {
  const { applyExpiries } = require("../lib/index.js");
  const endpoint = applyExpiries.__endpoint;
  assert.equal(endpoint.scheduleTrigger.schedule, "every 60 minutes");
  assert.equal(endpoint.minInstances ?? 0, 0, "an idle hour costs nothing");
});
