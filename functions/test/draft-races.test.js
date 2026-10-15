// SPDX-License-Identifier: Apache-2.0
// Draft saves and commits cannot revive an old base or erase a later working copy (SPEC §6a).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { fakeFirestore, withFakeAdmin } = require("./fakes.js");
const { writeDraft, commitDraft } = require("../lib/lib/draft.js");
const { commitNewVersion } = require("../lib/lib/publish.js");
const { hashBundleFiles } = require("../lib/lib/hash.js");
const actor = { uid: "owner", email: "owner@example.com", channel: "web" };
const oldHtml = "<p>published one</p>";
const oldHash = hashBundleFiles([{ rel: "index.html", data: Buffer.from(oldHtml) }]).contentHash;

async function world(fn, onSave = async () => {}) {
  const draft = { baseVersion: "v1", entry: "index.html" };
  const { db, store } = fakeFirestore({
    "docs/d": { currentVersion: "v1", ownerEmail: actor.email, draft },
    "docs/d/versions/v1": { entry: "index.html", format: "html", contentHash: oldHash },
  });
  const objects = new Map([["docs/d/v1/index.html", Buffer.from(oldHtml)], ["docs/d/draft/index.html", Buffer.from(oldHtml)]]);
  const old = Object.getOwnPropertyDescriptor(admin, "storage");
  const env = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  const file = (name) => ({ name, download: async () => {
    if (!objects.has(name)) throw Object.assign(new Error("not found"), { code: 404 });
    return [objects.get(name)];
  }, save: async (data) => { objects.set(name, Buffer.from(data)); await onSave(db, name); } });
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({
    file, getFiles: async ({ prefix }) => [[...objects.keys()].filter((key) => key.startsWith(prefix)).map(file)],
    deleteFiles: async ({ prefix }) => { for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key); },
  }) }) });
  const save = (content, extra = {}) => writeDraft({ db, docRef: db.doc("docs/d"), baseVersion: "v1", version: { entry: "index.html", format: "html" }, content: { html: content }, emailLower: actor.email, actor, ...extra });
  const commit = (snapshot = draft) => commitDraft({ db, docRef: db.doc("docs/d"), baseVersion: "v1", draft: snapshot, emailLower: actor.email, actor });
  try { await withFakeAdmin({ db }, () => fn({ db, store, objects, save, commit, draft })); }
  finally {
    if (old) Object.defineProperty(admin, "storage", old); else delete admin.storage;
    if (env === undefined) delete process.env.BIKESHED_BUCKET; else process.env.BIKESHED_BUCKET = env;
  }
}

test("a save overtaken by a publish refuses instead of restoring an old-base draft", async () => {
  await world(async ({ save, store }) => {
    await assert.rejects(save("<p>stale save</p>"), (e) => e.detail?.currentVersion === "v2");
    assert.equal(store.get("docs/d").currentVersion, "v2");
    assert.equal(store.get("docs/d").draft, undefined);
  }, async (db) => db.doc("docs/d").set({ currentVersion: "v2", ownerEmail: actor.email }));
});

test("deduplicating a stale commit preserves the new version's draft and its bytes", async () => {
  await world(async ({ db, store, objects, commit }) => {
    const fresh = { baseVersion: "v2", entry: "index.html", storagePrefix: "docs/d/drafts/fresh" };
    objects.set("docs/d/drafts/fresh/index.html", Buffer.from("<p>fresh work</p>"));
    await db.doc("docs/d").set({ currentVersion: "v2", ownerEmail: actor.email, draft: fresh });
    const outcome = await commit();
    assert.equal(outcome.status, 409);
    assert.equal(outcome.body.currentVersion, "v2");
    assert.deepEqual(store.get("docs/d").draft, fresh);
    assert.equal(objects.get("docs/d/drafts/fresh/index.html").toString(), "<p>fresh work</p>");
  });
});

test("deduplicating an older snapshot on the same base preserves a later save", async () => {
  await world(async ({ db, store, objects, commit }) => {
    const fresh = { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/drafts/fresh" };
    objects.set("docs/d/drafts/fresh/index.html", Buffer.from("<p>new unsaved review</p>"));
    await db.doc("docs/d").update({ draft: fresh });
    const outcome = await commit();
    assert.equal(outcome.status, 409);
    assert.equal(outcome.body.draftChanged, true);
    assert.deepEqual(store.get("docs/d").draft, fresh);
    assert.equal(objects.get("docs/d/drafts/fresh/index.html").toString(), "<p>new unsaved review</p>");
  });
});


test("a commit overtaken during its upload refuses without erasing the later draft", async () => {
  const fresh = { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/drafts/fresh" };
  await world(async ({ store, objects, commit }) => {
    objects.set("docs/d/draft/index.html", Buffer.from("<p>candidate version</p>"));
    objects.set("docs/d/drafts/fresh/index.html", Buffer.from("<p>later edit</p>"));
    const result = await commit();
    assert.equal(result.status, 409);
    assert.equal(result.body.draftChanged, true);
    assert.equal(store.has("docs/d/versions/v2"), false);
    assert.deepEqual(store.get("docs/d").draft, fresh);
    assert.equal(objects.get("docs/d/drafts/fresh/index.html").toString(), "<p>later edit</p>");
  }, async (db) => db.doc("docs/d").update({ draft: fresh }));
});

for (const [reason, change, status, detail] of [
  ["expiry", { expiresAt: 1 }, 409, "expired"],
  ["revocation", { ownerEmail: "other@example.com", editorEmails: [] }, 403, "error"],
]) {
  test(`a draft save rechecks ${reason} after uploading its bytes`, async () => {
    await world(async ({ save, store }) => {
      const before = store.get("docs/d").draft;
      await assert.rejects(save("<p>refused write</p>"), (error) => error.status === status && Boolean(error.detail?.[detail]));
      assert.deepEqual(store.get("docs/d").draft, before);
    }, async (db) => db.doc("docs/d").update(change));
  });

  test(`a mint rechecks ${reason} after uploading its bytes`, async () => {
    await world(async ({ commit, store, objects, draft }) => {
      objects.set("docs/d/draft/index.html", Buffer.from("<p>candidate version</p>"));
      const result = await commit();
      assert.equal(result.status, status);
      assert.ok(result.body[detail]);
      assert.equal(store.has("docs/d/versions/v2"), false);
      assert.equal([...objects.keys()].some((key) => key.startsWith("docs/d/bundles/")), false, "a refused upload retires its unreferenced candidate bundle");
      assert.deepEqual(store.get("docs/d").draft, draft);
    }, async (db) => db.doc("docs/d").update(change));
  });

  test(`an uploaded update rechecks ${reason} before minting`, async () => {
    await world(async ({ db, store, draft, objects }) => {
      const result = await commitNewVersion({
        db, docRef: db.doc("docs/d"), actor, authorEmail: actor.email,
        baseVersion: "v1", via: "upload",
        compiled: { entry: "index.html", format: "html", files: [{ rel: "index.html", data: Buffer.from("<p>uploaded version</p>") }] },
      });
      assert.equal(result.status, status);
      assert.ok(result[detail]);
      assert.equal(store.has("docs/d/versions/v2"), false);
      assert.equal([...objects.keys()].some((key) => key.startsWith("docs/d/bundles/")), false, "a refused upload retires its unreferenced candidate bundle");
      assert.deepEqual(store.get("docs/d").draft, draft);
    }, async (db) => db.doc("docs/d").update(change));
  });

  test(`dedup rechecks ${reason} before deleting the draft`, async () => {
    await world(async ({ db, commit, store, draft }) => {
      await db.doc("docs/d").update(change);
      const result = await commit();
      assert.equal(result.status, status);
      assert.ok(result.body[detail]);
      assert.deepEqual(store.get("docs/d").draft, draft);
    });
  });
}
