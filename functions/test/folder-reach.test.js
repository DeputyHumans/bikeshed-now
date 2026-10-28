// SPDX-License-Identifier: Apache-2.0
// A folder's link or public level opens everything beneath it, to read and nothing else (SPEC §13, §17; ADR 0019).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { Timestamp } = require("firebase-admin/firestore");

const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const presence = require("../lib/lib/presence.js");
const {
  canEdit,
  canRead,
  canSuggest,
  keyHashOf,
  keyMatchesHash,
  ownReachEntry,
  readAccess,
} = require("../lib/lib/acl.js");
const { computeReach } = require("../lib/lib/folders.js");
const { setFolderVisibility } = require("../lib/lib/management.js");
const { decideShell, GENERIC } = require("../lib/lib/shell.js");
const {
  contentProxy,
  manageSuggestion,
  organize,
  saveDraft,
  setVisibility,
  unlockDoc,
} = require("../lib/index.js");

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const STRANGER = { uid: "u-stranger", emailLower: "stranger@example.com" };
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const grants = { viewers: [], suggesters: [], editors: [], approvers: [] };

let saved;
test.beforeEach(() => {
  saved = presence.syncPresenceAccess;
  presence.syncPresenceAccess = async () => {};
});
test.afterEach(() => {
  presence.syncPresenceAccess = saved;
});

// --- The decision, pure ------------------------------------------------------

const KEY = "folder-key-0123456789ab";

function folderWith(reach) {
  return { ownerEmail: OWNER.emailLower, members: [OWNER.emailLower], reach };
}
const privateDoc = (extra = {}) => ({
  ownerUid: OWNER.uid,
  ownerEmail: OWNER.emailLower,
  members: [OWNER.emailLower],
  editorMembers: [OWNER.emailLower],
  folderId: "top",
  ...extra,
});

test("a folder's reach stores a hash of its key, never the key", () => {
  const entry = ownReachEntry("top", { visibility: "unlisted", linkToken: KEY });
  assert.equal(entry.keyHash, keyHashOf(KEY));
  assert.ok(!JSON.stringify(entry).includes(KEY));
  const stored = computeReach("sub", {}, [entry]);
  assert.ok(!JSON.stringify(stored).includes(KEY), "a subfolder inherits the hash, not the key");
  assert.equal(ownReachEntry("top", { visibility: "private", linkToken: KEY }), null);
  assert.equal(ownReachEntry("top", { visibility: "public" }).keyHash, undefined);
});

test("a key matches its hash, and an absent key matches nothing", () => {
  assert.equal(keyMatchesHash(keyHashOf(KEY), KEY), true);
  assert.equal(keyMatchesHash(keyHashOf(KEY), `${KEY}x`), false);
  assert.equal(keyMatchesHash(keyHashOf(KEY), ""), false);
  assert.equal(keyMatchesHash(keyHashOf(KEY), null), false);
  assert.equal(keyMatchesHash("", ""), false);
  assert.equal(keyMatchesHash(undefined, undefined), false);
});

test("the read decision: own basis first, then the folder's reach, read-only", () => {
  const link = folderWith([{ folderId: "top", visibility: "unlisted", keyHash: keyHashOf(KEY), expiresAt: NOW + DAY }]);
  const pub = folderWith([{ folderId: "top", visibility: "public", expiresAt: null }]);
  const both = folderWith([
    { folderId: "top", visibility: "unlisted", keyHash: keyHashOf(KEY), expiresAt: NOW + DAY },
    { folderId: "sub", visibility: "public", expiresAt: NOW + 2 * DAY },
  ]);
  const ended = folderWith([{ folderId: "top", visibility: "unlisted", keyHash: keyHashOf(KEY), expiresAt: NOW - 1 }]);

  assert.deepEqual(readAccess(privateDoc(), STRANGER, { k: KEY }, link, NOW), { basis: "folder-link", until: NOW + DAY });
  assert.equal(readAccess(privateDoc(), STRANGER, { k: "wrong" }, link, NOW), null);
  assert.equal(readAccess(privateDoc(), null, {}, link, NOW), null);
  assert.deepEqual(readAccess(privateDoc(), null, {}, pub, NOW), { basis: "folder-public", until: null });
  // Public wins over a key, as it does for a document's own levels.
  assert.deepEqual(readAccess(privateDoc(), null, { k: KEY }, both, NOW), { basis: "folder-public", until: NOW + 2 * DAY });
  assert.equal(readAccess(privateDoc(), null, { k: KEY }, ended, NOW), null, "an ended reach opens nothing");
  // The document's own basis wins: a member is a member.
  assert.deepEqual(readAccess(privateDoc(), OWNER, { k: KEY }, link, NOW), { basis: "member", until: null });
  assert.deepEqual(
    readAccess(privateDoc({ visibility: "public" }), null, {}, link, NOW),
    { basis: "public", until: null },
  );
});

test("a folder's key never authorizes a write, whatever the document allows its own readers", () => {
  // Open editing on an unlisted document reaches its own link holders. A folder
  // key is not that link, and no write decision so much as looks at a folder.
  const doc = privateDoc({ visibility: "unlisted", linkToken: "the-documents-own-key22", publicEdit: true });
  const folder = folderWith([{ folderId: "top", visibility: "unlisted", keyHash: keyHashOf(KEY), expiresAt: null }]);
  assert.equal(readAccess(doc, STRANGER, { k: KEY }, folder, NOW).basis, "folder-link", "it does read");
  assert.equal(canRead(doc, STRANGER, { k: KEY }), false);
  assert.equal(canEdit(doc, STRANGER, { k: KEY }), false);
  assert.equal(canSuggest(doc, STRANGER, { k: KEY }), false);
  // Control: the document's own key does edit, so the refusal above is the folder's.
  assert.equal(canEdit(doc, STRANGER, { k: "the-documents-own-key22" }), true);
});

test("the document shell opens to a folder's reach, cut at its end, and noindex for a key", () => {
  const doc = { ...privateDoc(), currentVersion: "v1" };
  const link = folderWith([{ folderId: "top", visibility: "unlisted", keyHash: keyHashOf(KEY), expiresAt: NOW + 60_000 }]);
  const linked = decideShell({ doc, folder: link, k: KEY, versionId: null, now: NOW });
  assert.equal(linked.kind, "document");
  assert.equal(linked.noindex, true);
  assert.ok(linked.maxAge <= 60, `max-age ${linked.maxAge} outlives the folder's reach`);
  const pub = folderWith([{ folderId: "top", visibility: "public", expiresAt: null }]);
  const shown = decideShell({ doc, folder: pub, k: "", versionId: null, now: NOW });
  assert.deepEqual([shown.kind, shown.noindex, shown.maxAge], ["document", false, 300]);
  assert.equal(decideShell({ doc, folder: link, k: "wrong", versionId: null, now: NOW }), GENERIC);
  assert.equal(decideShell({ doc, folder: null, k: KEY, versionId: null, now: NOW }), GENERIC);
  // A document's own expiry still wins over a folder that would open it.
  const expired = { ...doc, expiresAt: Timestamp.fromMillis(NOW - 1) };
  assert.equal(decideShell({ doc: expired, folder: pub, k: "", versionId: null, now: NOW }), GENERIC);
});

// --- End to end, through the endpoints --------------------------------------

/** Top holds Sub, which holds a private memo. Nothing is shared at the start. */
function world(extra = {}) {
  const { db, store } = fakeFirestore({
    "folders/top": {
      folderId: "top", name: "Top", ownerUid: OWNER.uid, ownerEmail: OWNER.emailLower,
      parentId: null, ancestors: [], depth: 0, ...grants,
      members: [OWNER.emailLower], suggesterMembers: [OWNER.emailLower],
      editorMembers: [OWNER.emailLower], approverMembers: [OWNER.emailLower],
    },
    "folders/sub": {
      folderId: "sub", name: "Sub", ownerUid: OWNER.uid, ownerEmail: OWNER.emailLower,
      parentId: "top", ancestors: ["top"], depth: 1, ...grants,
      members: [OWNER.emailLower], suggesterMembers: [OWNER.emailLower],
      editorMembers: [OWNER.emailLower], approverMembers: [OWNER.emailLower],
    },
    "docs/memo": {
      docId: "memo", title: "Memo", slug: "memo", ownerUid: OWNER.uid, ownerEmail: OWNER.emailLower,
      folderId: "sub", currentVersion: "v1", visibility: "private", publicEdit: false, trusted: false,
      ...grants, members: [OWNER.emailLower], suggesterMembers: [OWNER.emailLower],
      editorMembers: [OWNER.emailLower], approverMembers: [OWNER.emailLower],
      createdAt: Timestamp.fromMillis(NOW - DAY), updatedAt: Timestamp.fromMillis(NOW - DAY),
    },
    "docs/memo/versions/v1": { versionId: "v1", entry: "index.html", format: "html" },
    ...extra,
  });
  return { db, store };
}

const SESSIONS = Object.fromEntries(
  [OWNER, STRANGER].map((p) => [`s-${p.uid}`, { uid: p.uid, email: p.emailLower, email_verified: true }]),
);

/** Storage that holds nothing, and no Realtime Database: a HEAD never reads bytes. */
async function withStorage(fn) {
  const before = ["storage", "database"].map((k) => [k, Object.getOwnPropertyDescriptor(admin, k)]);
  const env = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  Object.defineProperty(admin, "storage", {
    configurable: true,
    value: () => ({ bucket: () => ({ file: () => ({ createReadStream: () => { throw new Error("no bytes in this test"); } }) }) }),
  });
  Object.defineProperty(admin, "database", { configurable: true, value: () => { throw new Error("no RTDB"); } });
  try {
    return await fn();
  } finally {
    for (const [k, d] of before) if (d) Object.defineProperty(admin, k, d);
    if (env === undefined) delete process.env.BIKESHED_BUCKET;
    else process.env.BIKESHED_BUCKET = env;
  }
}

function caller(w) {
  const as = (who) => (who ? { cookie: `__session=s-${who.uid}` } : {});
  const run = (handler, who, opts) =>
    withStorage(() => withFakeAdmin({ db: w.db, sessions: SESSIONS }, () => invoke(handler, { ...opts, headers: as(who) })));
  return {
    post: (handler, who, body) => run(handler, who, { method: "POST", body }),
    head: (who, path) => run(contentProxy, who, { method: "HEAD", path }),
  };
}

const unlisted = { visibility: "unlisted", expiresAt: null };

test("a folder link opens what is beneath it, read-only, and rotating it closes every copy", async () => {
  const w = world();
  const c = caller(w);

  const set = await c.post(setVisibility, OWNER, { folderId: "top", ...unlisted });
  assert.equal(set.status, 200);
  const key = set.body.linkToken;
  assert.ok(typeof key === "string" && key.length >= 22);
  // The cascade carried it down, as a hash.
  const subReach = w.store.get("folders/sub").reach;
  assert.deepEqual(subReach.map((e) => [e.folderId, e.visibility]), [["top", "unlisted"]]);
  assert.ok(!JSON.stringify(subReach).includes(key));

  // A stranger signed in, holding the folder's key: read, marked, no grant.
  const opened = await c.post(unlockDoc, STRANGER, { docId: "memo", k: key });
  assert.equal(opened.status, 200);
  assert.deepEqual(
    [opened.body.viaFolder, opened.body.visibility, opened.body.publicEdit],
    [true, "unlisted", false],
  );
  assert.ok(![...w.store.keys()].some((p) => p.includes("linkGrants")), "a folder key must never grant");

  // The folder itself, from its subfolder: the path starts at the shared folder.
  const level = await c.post(unlockDoc, null, { folderId: "sub", k: key });
  assert.equal(level.status, 200);
  assert.deepEqual(level.body.path.map((p) => p.name), ["Top", "Sub"]);
  assert.deepEqual(level.body.documents.map((d) => d.docId), ["memo"]);
  assert.ok(!JSON.stringify(level.body).includes("owner@example.com"), "the listing names nobody");

  // The bytes: cacheable at the keyed URL, never indexed.
  const bytes = await c.head(null, `/content/~${key}/memo/v1/index.html`);
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers["cache-control"], "public, max-age=300");
  assert.equal(bytes.headers["x-robots-tag"], "noindex");

  // Writes stay closed to the same key.
  const suggestion = await c.post(manageSuggestion, STRANGER, {
    op: "create", docId: "memo", versionId: "v1", k: key,
    anchor: { exact: "x", prefix: "", suffix: "" }, replacement: "y",
  });
  assert.equal(suggestion.status, 404);
  const draft = await c.post(saveDraft, STRANGER, { docId: "memo", baseVersion: "v1", html: "<p>mine</p>", k: key });
  assert.equal(draft.status, 404);

  // Rotate: private, then unlisted again. The old key is the absent id's 404.
  await c.post(setVisibility, OWNER, { folderId: "top", visibility: "private", expiresAt: null });
  const again = await c.post(setVisibility, OWNER, { folderId: "top", ...unlisted });
  assert.notEqual(again.body.linkToken, key);
  const absent = await c.post(unlockDoc, null, { docId: "no-such-doc", k: key });
  for (const stale of [
    await c.post(unlockDoc, null, { docId: "memo", k: key }),
    await c.post(unlockDoc, null, { folderId: "sub", k: key }),
    await c.head(null, `/content/~${key}/memo/v1/index.html`),
  ]) {
    assert.equal(stale.status, 404);
    assert.equal(stale.body, absent.body);
  }
  assert.equal((await c.post(unlockDoc, null, { docId: "memo", k: again.body.linkToken })).status, 200);
});

test("a document moved out of a shared folder stops answering to its key", async () => {
  const w = world();
  const c = caller(w);
  const key = (await c.post(setVisibility, OWNER, { folderId: "top", ...unlisted })).body.linkToken;
  assert.equal((await c.post(unlockDoc, null, { docId: "memo", k: key })).status, 200);
  const moved = await c.post(organize, OWNER, { kind: "doc", id: "memo", op: "move", targetFolderId: null });
  assert.equal(moved.status, 200);
  assert.equal((await c.post(unlockDoc, null, { docId: "memo", k: key })).status, 404);
});

test("an ended reach closes the link and nothing else, and the key holder is told it ended", async () => {
  const w = world();
  const c = caller(w);
  const key = (await c.post(setVisibility, OWNER, { folderId: "top", visibility: "unlisted", expiresAt: NOW + 60_000 })).body.linkToken;
  const capped = await c.head(null, `/content/~${key}/memo/v1/index.html`);
  const maxAge = Number(/max-age=(\d+)/.exec(capped.headers["cache-control"])[1]);
  assert.ok(maxAge <= 60, `max-age ${maxAge} outlives the folder's reach`);

  // There is no scheduler, so the date passing is the record saying so.
  for (const id of ["top", "sub"]) {
    const f = w.store.get(`folders/${id}`);
    w.store.set(`folders/${id}`, { ...f, reach: f.reach.map((e) => ({ ...e, expiresAt: NOW - 1 })) });
  }
  assert.equal((await c.post(unlockDoc, null, { docId: "memo", k: key })).status, 404);
  assert.equal((await c.head(null, `/content/~${key}/memo/v1/index.html`)).status, 404);
  const told = await c.post(unlockDoc, null, { folderId: "sub", k: key });
  assert.deepEqual([told.status, told.body.expired, told.body.name], [200, true, "Sub"]);
  assert.equal(told.body.documents, undefined, "an ended link lists nothing");
  // The owner still reads, and the document itself is not frozen.
  const own = await c.head(OWNER, "/content/memo/v1/index.html");
  assert.deepEqual([own.status, own.headers["cache-control"]], [200, "private, no-store"]);
  assert.equal(w.store.get("docs/memo").expiresAt, undefined);
});

test("a public folder mirrors what is beneath it, and stops the moment it is private again", async () => {
  const w = world();
  const c = caller(w);
  await c.post(setVisibility, OWNER, { folderId: "top", visibility: "public", expiresAt: null });
  const mirror = w.store.get("public/memo");
  assert.ok(mirror, "a document under a public folder is in the projection");
  assert.deepEqual([mirror.visibility, mirror.viaFolder, mirror.publicEdit], ["public", true, false]);
  const bytes = await c.head(null, "/content/memo/v1/index.html");
  assert.deepEqual([bytes.status, bytes.headers["cache-control"], bytes.headers["x-robots-tag"]], [200, "public, max-age=300", undefined]);

  await c.post(setVisibility, OWNER, { folderId: "top", visibility: "private", expiresAt: null });
  assert.equal(w.store.get("public/memo"), undefined);
  assert.equal((await c.head(null, "/content/memo/v1/index.html")).status, 404);
});

test("only the owner sets a folder's level, a past date is refused, and a folder has no open editing", async () => {
  const w = world();
  const c = caller(w);
  const ctx = { db: w.db, caller: { ...OWNER, channel: "mcp" }, actor: { uid: OWNER.uid, email: OWNER.emailLower, channel: "mcp" } };
  await assert.rejects(setFolderVisibility(ctx, "top", { visibility: "public", publicEdit: true }), { status: 400 });
  assert.equal((await c.post(setVisibility, STRANGER, { folderId: "top", ...unlisted })).status, 404);
  assert.equal((await c.post(setVisibility, null, { folderId: "top", ...unlisted })).status, 401);
  const past = await c.post(setVisibility, OWNER, { folderId: "top", visibility: "unlisted", expiresAt: NOW - DAY });
  assert.equal(past.status, 400);
  assert.equal(w.store.get("folders/top").visibility, undefined, "a refused date changes nothing");
});
