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

for (const channel of ["draft", "update"]) {
  test(`${channel} publishes restored historical bytes as a new current version`, async () => {
    await world(async ({ db, store, objects }) => {
      const newer = "<p>published two</p>";
      const draft = { baseVersion: "v2", entry: "index.html", storagePrefix: "docs/d/drafts/revert" };
      await db.doc("docs/d/versions/v2").set({ entry: "index.html", format: "html", contentHash: hashBundleFiles([{ rel: "index.html", data: Buffer.from(newer) }]).contentHash });
      await db.doc("docs/d").update({ currentVersion: "v2", draft });
      objects.set("docs/d/v2/index.html", Buffer.from(newer));
      objects.set("docs/d/drafts/revert/index.html", Buffer.from(oldHtml));
      const args = { db, docRef: db.doc("docs/d"), baseVersion: "v2", actor };
      const result = channel === "draft"
        ? (await commitDraft({ ...args, draft, emailLower: actor.email })).body
        : await commitNewVersion({ ...args, authorEmail: actor.email, via: "mcp", compiled: { entry: "index.html", format: "html", files: [{ rel: "index.html", data: Buffer.from(oldHtml) }] } });
      assert.equal(result.deduped, false, `${channel}: a historical match must publish the requested restoration`);
      assert.equal(result.versionId, "v3");
      assert.equal(store.get("docs/d").currentVersion, "v3");
      const restored = store.get("docs/d/versions/v3");
      assert.equal(restored.parentVersion, "v2");
      assert.equal(restored.contentHash, oldHash);
      assert.equal(objects.get(`${restored.storagePrefix}/index.html`).toString(), oldHtml);
      assert.equal(objects.get("docs/d/v1/index.html").toString(), oldHtml);
      assert.equal(objects.get("docs/d/v2/index.html").toString(), newer);
      assert.equal(store.get("docs/d").draft, undefined);
    });
  });
}

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

const causal = (vector, deletes = {}, generation = "a".repeat(64)) => ({ generation, vector, deletes });

test("a late older autosave preserves the newer merged draft and removes only its own candidate", async () => {
  await world(async ({ save, store, objects }) => {
    const latest = await save("<p>merged edits</p>", { liveEpoch: "initial", causal: causal({ 1: 5, 2: 4 }) });
    const before = JSON.stringify(store.get("docs/d"));
    const result = await save("<p>older edit</p>", { liveEpoch: "initial", causal: causal({ 1: 5, 2: 2 }) });
    assert.equal(result.storagePrefix, latest.storagePrefix);
    assert.equal(JSON.stringify(store.get("docs/d")), before);
    assert.equal(objects.get(`${latest.storagePrefix}/index.html`).toString(), "<p>merged edits</p>");
    assert.equal([...objects.keys()].filter((key) => key.startsWith("docs/d/bundles/")).length, 1);
  });
});

test("deletion-only autosaves supersede equal vectors and identical histories do not replace bytes", async () => {
  await world(async ({ save, store, objects }) => {
    await save("<p>abc</p>", { liveEpoch: "initial", causal: causal({ 1: 5 }) });
    const deleted = await save("<p>ac</p>", { liveEpoch: "initial", causal: causal({ 1: 5 }, { 1: [[2, 1]] }) });
    await save("<p>abc</p>", { liveEpoch: "initial", causal: causal({ 1: 5 }) });
    await save("<p>different serialization</p>", { liveEpoch: "initial", causal: causal({ 1: 5 }, { 1: [[2, 1]] }) });
    assert.equal(store.get("docs/d").draft.storagePrefix, deleted.storagePrefix);
    assert.equal(objects.get(`${deleted.storagePrefix}/index.html`).toString(), "<p>ac</p>");
  });
});

for (const [label, stamp, detail] of [
  ["concurrent", causal({ 1: 6, 2: 1 }), "draftChanged"],
  ["different seed", causal({ 1: 6, 2: 5 }, {}, "b".repeat(64)), "liveReset"],
]) test(`a ${label} autosave cannot replace the durable draft`, async () => {
  await world(async ({ save, store, objects }) => {
    const latest = await save("<p>durable</p>", { liveEpoch: "initial", causal: causal({ 1: 5, 2: 4 }) });
    await assert.rejects(save("<p>unsafe replacement</p>", { liveEpoch: "initial", causal: stamp }), (error) => error.detail?.[detail] === true);
    assert.equal(store.get("docs/d").draft.storagePrefix, latest.storagePrefix);
    assert.equal(objects.get(`${latest.storagePrefix}/index.html`).toString(), "<p>durable</p>");
  });
});

test("retiring an identical draft changes the live epoch and refuses a delayed save on the same version", async () => {
  await world(async ({ save, commit, store }) => {
    const result = await commit();
    assert.equal(result.status, 200);
    assert.equal(result.body.deduped, true);
    assert.match(store.get("docs/d").liveEpoch, /^[a-zA-Z0-9_-]+$/);
    assert.notEqual(store.get("docs/d").liveEpoch, "initial");
    await assert.rejects(save("<p>old session</p>", { liveEpoch: "initial" }), (error) => error.detail?.liveReset === true);
    assert.equal(store.get("docs/d").draft, undefined);
  });
});

test("an external draft replacement retires its live epoch only after winning its draft CAS", async () => {
  await world(async ({ save, store, draft }) => {
    await save("<p>accepted suggestion</p>", { expectedDraft: draft, retireLive: true });
    const epoch = store.get("docs/d").liveEpoch;
    assert.match(epoch, /^[a-zA-Z0-9_-]+$/);
    assert.notEqual(epoch, "initial");
    await assert.rejects(save("<p>losing acceptance</p>", { expectedDraft: draft, retireLive: true }), (error) => error.detail?.draftChanged === true);
    assert.equal(store.get("docs/d").liveEpoch, epoch);
    await assert.rejects(save("<p>old editor</p>", { liveEpoch: "initial" }), (error) => error.detail?.liveReset === true);
  });
});

test("an uncertain transaction outcome retains the candidate bytes that may already be referenced", async () => {
  await world(async ({ save, db, store, objects }) => {
    const transact = db.runTransaction.bind(db);
    db.runTransaction = async (work) => { await transact(work); throw new Error("commit response lost"); };
    await assert.rejects(save("<p>committed before timeout</p>"), /commit response lost/);
    const draft = store.get("docs/d").draft;
    assert.equal(objects.get(`${draft.storagePrefix}/index.html`)?.toString(), "<p>committed before timeout</p>");
  });
});

test("projection refresh failure cannot turn a committed external draft change into a refused write", async () => {
  await world(async ({ save, db, store, objects, draft }) => {
    const transact = db.runTransaction.bind(db);
    let calls = 0;
    db.runTransaction = (work) => ++calls === 1 ? transact(work) : Promise.reject(new Error("projection unavailable"));
    const result = await save("<p>accepted and durable</p>", { expectedDraft: draft, retireLive: true });
    assert.equal(store.get("docs/d").draft.storagePrefix, result.storagePrefix);
    assert.equal(objects.get(`${result.storagePrefix}/index.html`).toString(), "<p>accepted and durable</p>");
    assert.notEqual(store.get("docs/d").liveEpoch, "initial");
  });
});

test("an unclocked revision refuses a newer causal snapshot without deleting its bytes", async () => {
  const { draftRevision } = require("../lib/lib/draft.js");
  await world(async ({ save, store, objects }) => {
    const opened = draftRevision(store.get("docs/d"));
    const member = await save("<p>member work</p>", { liveEpoch: "initial", causal: causal({ 1: 1 }) });
    await assert.rejects(save("<p>stale link work</p>", { expectedRevision: opened, liveEpoch: "initial", retireLive: true }), (error) => error.detail?.draftChanged === true);
    assert.equal(store.get("docs/d").draft.storagePrefix, member.storagePrefix);
    assert.equal(objects.get(`${member.storagePrefix}/index.html`).toString(), "<p>member work</p>");
    assert.equal([...objects.keys()].filter((key) => key.startsWith("docs/d/bundles/")).length, 1);
  });
});

test("a winning unclocked snapshot fences old causal saves and advances the solo writer's next revision", async () => {
  const { draftRevision } = require("../lib/lib/draft.js");
  await world(async ({ save, store, objects }) => {
    const opened = draftRevision(store.get("docs/d"));
    const solo = await save("<p>link holder work</p>", { expectedRevision: opened, liveEpoch: "initial", retireLive: true });
    assert.notEqual(solo.liveEpoch, "initial");
    assert.equal(solo.liveEpoch, store.get("docs/d").liveEpoch);
    assert.equal(solo.draftRevision, draftRevision(store.get("docs/d")));
    assert.notEqual(solo.draftRevision, opened);
    await assert.rejects(save("<p>old member work</p>", { liveEpoch: "initial", causal: causal({ 1: 1 }) }), (error) => error.detail?.liveReset === true);
    const next = await save("<p>more link holder work</p>", { expectedRevision: solo.draftRevision, liveEpoch: solo.liveEpoch, retireLive: true });
    assert.equal(objects.get(`${next.storagePrefix}/index.html`).toString(), "<p>more link holder work</p>");
    assert.notEqual(next.liveEpoch, solo.liveEpoch);
    const reloaded = await save("<p>merged after explicit reload</p>", { liveEpoch: next.liveEpoch, causal: causal({ 2: 1 }, {}, "c".repeat(64)) });
    assert.equal(objects.get(`${reloaded.storagePrefix}/index.html`).toString(), "<p>merged after explicit reload</p>");
  });
});
