// SPDX-License-Identifier: Apache-2.0
// Conditional draft saves revalidate every guard while preserving multi-document authority (SPEC §6a, §6b, §17).
const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { fakeFirestore, withFakeAdmin } = require("./fakes.js");
const { writeDraft, draftRevision } = require("../lib/lib/draft.js");
const actor = { uid: "owner", email: "owner@example.com", channel: "web" };
const causal = (vector, deletes = {}, generation = "a".repeat(64)) => ({ generation, vector, deletes });
const stored = stamp => ({ generation: stamp.generation, vector: stamp.vector, deletesJson: JSON.stringify(stamp.deletes) });

async function world(body, extra = {}) {
  const initial = { ownerUid: actor.uid, ownerEmail: actor.email, currentVersion: "v1", liveEpoch: "initial", draft: { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/bundles/old" }, ...extra };
  const { db, store } = fakeFirestore({ "docs/d": initial });
  const docRef = db.doc("docs/d");
  const objects = new Map([["docs/d/bundles/old/index.html", Buffer.from("old")]]);
  const descriptor = Object.getOwnPropertyDescriptor(admin, "storage");
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({
    file: name => ({ save: async bytes => { objects.set(name, Buffer.from(bytes)); } }),
    deleteFiles: async ({ prefix }) => { for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key); },
  }) }) });
  const save = (options = {}) => writeDraft({ db, docRef, baseVersion: "v1", version: { entry: "index.html", format: "html" }, content: { html: "candidate" }, emailLower: actor.email, actor, liveEpoch: "initial", ...options });
  const race = change => {
    const update = docRef.update.bind(docRef); let attempts = 0;
    docRef.update = async (fields, condition) => {
      attempts++;
      if (attempts === 1) await db.doc("docs/d").update(change);
      return update(fields, condition);
    };
    return () => attempts;
  };
  try { await withFakeAdmin({ db }, () => body({ db, store, docRef, objects, save, race, initial })); }
  finally { if (descriptor) Object.defineProperty(admin, "storage", descriptor); else delete admin.storage; }
}

test("a document-authorized save uses its exact snapshot precondition without a read/write transaction", async () => {
  await world(async ({ db, docRef, store, save }) => {
    db.runTransaction = async () => { throw new Error("direct draft save must not acquire transactional read locks"); };
    const before = await docRef.get(); const original = docRef.update.bind(docRef);
    docRef.update = async (fields, precondition) => {
      assert.ok(precondition?.lastUpdateTime?.isEqual(before.updateTime), "the write must check the exact authorized snapshot");
      return original(fields, precondition);
    };
    await save();
    assert.notEqual(store.get("docs/d").draft.storagePrefix, "docs/d/bundles/old");
  });
});

for (const [name, patch, extra, detail] of [
  ["base", { currentVersion: "v2" }, {}, "currentVersion"],
  ["epoch", { liveEpoch: "new-epoch" }, {}, "liveReset"],
  ["expiry", { expiresAt: 1 }, {}, "expired"],
  ["current role", { ownerUid: "other", ownerEmail: "other@example.com" }, {}, "error"],
  ["expected draft", { draft: { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/bundles/new" } }, { exactDraft: true }, "draftChanged"],
  ["expected revision", { draft: { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/bundles/new" } }, { exactRevision: true }, "reloadRequired"],
  ["generation", { draft: { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/bundles/new", causal: stored(causal({ 1: 1 }, {}, "b".repeat(64))) } }, { causal: causal({ 1: 2 }) }, "liveReset"],
  ["concurrent history", { draft: { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/bundles/new", causal: stored(causal({ 1: 1, 2: 1 })) } }, { causal: causal({ 1: 2 }) }, "draftChanged"],
]) test(`a CAS refusal rechecks ${name} before any retry can write`, async () => {
  await world(async ({ save, race, store, objects, initial }) => {
    const attempts = race(patch);
    const { exactDraft, exactRevision, ...options } = extra;
    if (exactDraft) options.expectedDraft = initial.draft;
    if (exactRevision) options.expectedRevision = draftRevision(initial);
    await assert.rejects(save(options), error => Boolean(error.detail?.[detail]));
    assert.equal(attempts(), 1, "a newly invalid snapshot cannot reach a second write");
    for (const [key, value] of Object.entries(patch)) assert.deepEqual(store.get("docs/d")[key], value);
    assert.equal([...objects.keys()].filter(key => !key.includes("/old/")).length, 1, "an SDK precondition refusal may follow an acknowledged-lost commit, so retain its candidate");
  });
});

for (const [name, candidate, newer] of [
  ["vector", causal({ 1: 2 }), causal({ 1: 3 })],
  ["deletion frontier", causal({ 1: 5 }), causal({ 1: 5 }, { 1: [[2, 1]] })],
]) test(`a CAS retry acknowledges a newer ${name} without replacing its bytes`, async () => {
  await world(async ({ save, race, objects, store }) => {
    const fresh = { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/bundles/new", causal: stored(newer) };
    objects.set("docs/d/bundles/new/index.html", Buffer.from("newer"));
    const attempts = race({ draft: fresh });
    const result = await save({ causal: candidate });
    assert.equal(attempts(), 1);
    assert.equal(result.storagePrefix, fresh.storagePrefix);
    assert.deepEqual(store.get("docs/d").draft, fresh);
    assert.equal(objects.get("docs/d/bundles/new/index.html").toString(), "newer");
    assert.equal([...objects.keys()].filter(key => !key.includes("/old/")).length, 2, "the newer draft and the uncertain candidate both remain intact");
  });
});

test("a harmless competing update retries and preserves the winner's unrelated fields", async () => {
  await world(async ({ save, race, store }) => {
    const attempts = race({ title: "new title" });
    await save();
    assert.equal(attempts(), 2);
    assert.equal(store.get("docs/d").title, "new title");
    assert.notEqual(store.get("docs/d").draft.storagePrefix, "docs/d/bundles/old");
  });
});

test("an uncertain conditional-write result is not retried and retains its potentially committed bytes", async () => {
  await world(async ({ save, docRef, store, objects }) => {
    const update = docRef.update.bind(docRef); let writes = 0;
    docRef.update = async (...args) => { writes++; await update(...args); throw Object.assign(new Error("commit acknowledgement lost"), { code: 14 }); };
    await assert.rejects(save(), /commit acknowledgement lost/);
    assert.equal(writes, 1);
    assert.equal(objects.get(`${store.get("docs/d").draft.storagePrefix}/index.html`)?.toString(), "candidate");
  });
});

for (const retireLive of [false, true]) test(`a committed conditional write followed by SDK precondition refusal is acknowledged, retirement=${retireLive}`, async () => {
  await world(async ({ save, docRef, store, objects, initial, db }) => {
    const update = docRef.update.bind(docRef); let writes = 0; let aftermath = 0;
    const transact = db.runTransaction.bind(db);
    db.runTransaction = work => { aftermath++; return transact(work); };
    docRef.update = async (...args) => { writes++; await update(...args); throw Object.assign(new Error("SDK retry after lost acknowledgement"), { code: 9 }); };
    let result;
    await assert.doesNotReject(async () => { result = await save(retireLive ? { retireLive: true, expectedDraft: initial.draft } : { causal: causal({ 1: 2 }) }); }, "the current unique prefix confirms this request's earlier commit");
    assert.equal(writes, 1, "reconciliation must not publish the same candidate again");
    assert.equal(result.storagePrefix, store.get("docs/d").draft.storagePrefix);
    assert.equal(objects.get(`${result.storagePrefix}/index.html`)?.toString(), "candidate", "acknowledging our own candidate must not delete it as a reused upload");
    assert.equal(result.liveEpoch, store.get("docs/d").liveEpoch);
    if (retireLive) { assert.notEqual(result.liveEpoch, "initial"); assert.ok(aftermath > 0, "confirmed retirement must still refresh its projection"); }
  });
});

for (const advancedEpoch of [false, true]) test(`a lost acknowledgement followed by another writer preserves the uncertain candidate, advanced epoch=${advancedEpoch}`, async () => {
  await world(async ({ save, docRef, db, store, objects }) => {
    const update = docRef.update.bind(docRef); let candidate;
    docRef.update = async (...args) => {
      candidate = args[0].draft.storagePrefix;
      await update(...args);
      await db.doc("docs/d").update({ liveEpoch: advancedEpoch ? "later" : "initial", draft: { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/bundles/later", causal: stored(causal({ 1: 3 })) } });
      objects.set("docs/d/bundles/later/index.html", Buffer.from("later"));
      throw Object.assign(new Error("SDK retry after lost acknowledgement"), { code: 9 });
    };
    if (advancedEpoch) await assert.rejects(save({ causal: causal({ 1: 2 }) }), error => error.detail?.liveReset === true);
    else assert.equal((await save({ causal: causal({ 1: 2 }) })).storagePrefix, "docs/d/bundles/later");
    assert.equal(store.get("docs/d").draft.storagePrefix, "docs/d/bundles/later");
    assert.equal(objects.get(`${candidate}/index.html`)?.toString(), "candidate", "absence from the latest snapshot does not prove the candidate never committed");
    assert.equal(objects.get("docs/d/bundles/later/index.html")?.toString(), "later");
  });
});

test("the elapsed retry budget stops writes and retains the unresolved candidate", async t => {
  await world(async ({ save, docRef, objects }) => {
    let clock = 1000; t.mock.method(Date, "now", () => clock);
    let writes = 0;
    docRef.update = async () => { writes++; if (writes > 1) throw new Error("a second write started after the deadline"); clock += 10_001; throw Object.assign(new Error("precondition changed"), { code: 9 }); };
    await assert.rejects(save(), error => error.detail?.draftChanged === true);
    assert.equal(writes, 1);
    assert.equal(objects.get("docs/d/bundles/old/index.html")?.toString(), "old");
    assert.equal([...objects.keys()].filter(key => !key.includes("/old/")).length, 1);
  });
});

test("a delayed retry read cannot start its conditional write after the elapsed deadline", async t => {
  await world(async ({ save, docRef }) => {
    let clock = 1000; t.mock.method(Date, "now", () => clock);
    const get = docRef.get.bind(docRef); let reads = 0; let writes = 0;
    docRef.get = async () => { const snap = await get(); if (++reads === 2) clock = 11_001; return snap; };
    docRef.update = async () => { if (++writes > 1) throw new Error("a late retry reached the write"); throw Object.assign(new Error("precondition changed"), { code: 9 }); };
    await assert.rejects(save(), error => error.detail?.draftChanged === true);
    assert.equal(writes, 1);
  });
});

test("remembered link authority stays transactional and a concurrent grant deletion refuses", async () => {
  await world(async ({ db, docRef, store, save }) => {
    await db.doc("docs/d/linkGrants/owner").set({ token: "link-token" });
    const original = db.runTransaction.bind(db); let calls = 0; let removed = false;
    db.runTransaction = work => original(async tx => {
      calls++; const get = tx.get.bind(tx);
      tx.get = async ref => { const snap = await get(ref); if (!removed && ref.path.includes("/linkGrants/")) { removed = true; await ref.delete(); } return snap; };
      return work(tx);
    });
    docRef.update = async () => { throw new Error("link grant must not use document-only CAS"); };
    await assert.rejects(save(), error => error.status === 403);
    assert.ok(calls >= 2, "the grant conflict must rerun the actual transaction");
    assert.equal(store.get("docs/d").draft.storagePrefix, "docs/d/bundles/old");
  }, { ownerUid: "other", ownerEmail: "other@example.com", visibility: "unlisted", publicEdit: true, linkToken: "link-token" });
});
