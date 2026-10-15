// SPDX-License-Identifier: Apache-2.0
// Lost transaction acknowledgements cannot erase saved or published bytes, or turn an observed own commit into a refusal (SPEC §6a, §6b).
const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { fakeFirestore, withFakeAdmin } = require("./fakes.js");
const { loseFirstTransactionAcknowledgement } = require("./transaction-ack.js");
const { writeDraft, commitDraft, draftRevision, removeUnreferencedCandidate } = require("../lib/lib/draft.js");
const { commitNewVersion } = require("../lib/lib/publish.js");
const { hashBundleFiles } = require("../lib/lib/hash.js");

const actor = { uid: "link-editor", email: "editor@example.com", channel: "web" };
const oldHtml = "<p>old published bytes</p>", newHtml = "<p>candidate bytes</p>";
const linkDoc = { ownerUid: "owner", ownerEmail: "owner@example.com", visibility: "unlisted", publicEdit: true, linkToken: "token" };
async function world(body, { dedup = false } = {}) {
  const draft = { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/bundles/draft" };
  const initial = { ...linkDoc, currentVersion: "v1", liveEpoch: "initial", draft };
  const { db, store } = fakeFirestore({
    "docs/d": initial,
    "docs/d/linkGrants/link-editor": { token: "token" },
    "docs/d/versions/v1": { entry: "index.html", format: "html", contentHash: hashBundleFiles([{ rel: "index.html", data: Buffer.from(oldHtml) }]).contentHash },
  });
  const objects = new Map([["docs/d/v1/index.html", Buffer.from(oldHtml)], ["docs/d/bundles/draft/index.html", Buffer.from(dedup ? oldHtml : newHtml)]]);
  const file = name => ({ name, save: async bytes => { objects.set(name, Buffer.from(bytes)); }, download: async () => {
    if (!objects.has(name)) throw Object.assign(new Error("not found"), { code: 404 });
    return [objects.get(name)];
  } });
  const descriptor = Object.getOwnPropertyDescriptor(admin, "storage");
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({
    file, getFiles: async ({ prefix }) => [[...objects.keys()].filter(key => key.startsWith(prefix)).map(file)],
    deleteFiles: async ({ prefix }) => { for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key); },
  }) }) });
  const docRef = db.doc("docs/d");
  const save = (extra = {}) => writeDraft({ db, docRef, baseVersion: "v1", version: { entry: "index.html", format: "html" }, content: { html: newHtml }, expectedRevision: draftRevision(initial), liveEpoch: "initial", retireLive: true, emailLower: actor.email, actor, ...extra });
  const commit = () => commitDraft({ db, docRef, baseVersion: "v1", draft, emailLower: actor.email, actor });
  const update = () => commitNewVersion({ db, docRef, baseVersion: "v1", compiled: { entry: "index.html", format: "html", files: [{ rel: "index.html", data: Buffer.from(newHtml) }] }, authorEmail: actor.email, actor, via: "mcp" });
  try { await withFakeAdmin({ db }, () => body({ db, store, objects, save, commit, update, initial })); }
  finally { if (descriptor) Object.defineProperty(admin, "storage", descriptor); else delete admin.storage; }
}

for (const revoke of [false, true]) test(`a remembered-link save acknowledges its own committed candidate after SDK retry, revoked=${revoke}`, async () => {
  await world(async ({ db, store, objects, save }) => {
    const count = loseFirstTransactionAcknowledgement(db, { afterCommit: async () => { if (revoke) await db.doc("docs/d/linkGrants/link-editor").delete(); } });
    let result;
    await assert.doesNotReject(async () => { result = await save(); }, "an observed own committed draft is acknowledged before retry-only authority/revision/epoch refusals");
    assert.ok(count().callbackCalls >= 2, "the installed SDK retried its callback after code 14");
    assert.equal(result.storagePrefix, store.get("docs/d").draft.storagePrefix);
    assert.equal(objects.get(`${result.storagePrefix}/index.html`)?.toString(), newHtml, "the committed candidate remains readable");
    assert.notEqual(result.liveEpoch, "initial");
    assert.equal(objects.has("docs/d/bundles/draft/index.html"), false, "normal successful cleanup still removes only the replaced draft");
  });
});

for (const channel of ["commit", "update"]) for (const advanced of [false, true]) test(`${channel} acknowledges its own immutable version after SDK retry, newer head=${advanced}`, async () => {
  await world(async ({ db, store, objects, commit, update }) => {
    const count = loseFirstTransactionAcknowledgement(db, { afterCommit: async () => {
      if (advanced) {
        await db.doc("docs/d/versions/v3").set({ entry: "index.html", storagePrefix: "docs/d/bundles/later" });
        await db.doc("docs/d").update({ currentVersion: "v3", liveEpoch: "later" });
        objects.set("docs/d/bundles/later/index.html", Buffer.from("later version"));
      }
    } });
    const result = await (channel === "commit" ? commit() : update());
    const body = channel === "commit" ? result.body : result;
    assert.equal(channel === "commit" ? result.status : result.status ?? 200, 200, "the already committed immutable version is acknowledged");
    assert.equal(body.versionId, "v2");
    assert.equal(body.deduped, false);
    assert.ok(count().callbackCalls >= 2);
    assert.equal(store.get("docs/d").currentVersion, advanced ? "v3" : "v2", "retry acknowledgement never repoints a later head");
    const published = store.get("docs/d/versions/v2");
    assert.equal(objects.get(`${published.storagePrefix}/index.html`)?.toString(), newHtml, "the published version still has the bytes its record references");
    if (advanced) assert.equal(objects.get("docs/d/bundles/later/index.html")?.toString(), "later version");
  });
});

test("a deduplicated draft commit recognizes its own retirement epoch after SDK retry", async () => {
  await world(async ({ db, store, objects, commit }) => {
    const count = loseFirstTransactionAcknowledgement(db);
    const result = await commit();
    assert.equal(result.status, 200, "a committed no-change publication must not report a stale draft");
    assert.equal(result.body.deduped, true);
    assert.equal(result.body.versionId, "v1");
    assert.ok(count().callbackCalls >= 2);
    assert.equal(store.get("docs/d").draft, undefined);
    assert.notEqual(store.get("docs/d").liveEpoch, "initial");
    assert.equal(objects.has("docs/d/bundles/draft/index.html"), false);
    assert.equal(objects.get("docs/d/v1/index.html")?.toString(), oldHtml);
  }, { dedup: true });
});

for (const reason of ["revision", "revoked"]) test(`a retry-only ${reason} refusal retains a candidate still referenced by a historical version`, async () => {
  await world(async ({ db, store, objects, save }) => {
    let candidate;
    loseFirstTransactionAcknowledgement(db, { afterCommit: async () => {
      candidate = store.get("docs/d").draft.storagePrefix;
      await db.doc("docs/d/versions/v0").set({ entry: "index.html", storagePrefix: candidate });
      await db.doc("docs/d").update({ liveEpoch: "later", draft: { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/bundles/later" } });
      objects.set("docs/d/bundles/later/index.html", Buffer.from("later draft"));
      if (reason === "revoked") await db.doc("docs/d/linkGrants/link-editor").delete();
    } });
    await assert.rejects(save(), e => reason === "revoked" ? e.status === 403 : e.detail?.reloadRequired === true);
    assert.equal(objects.get(`${candidate}/index.html`)?.toString(), newHtml, "a later refusal cannot delete bytes still selected by a historical version");
    assert.equal(objects.get("docs/d/bundles/later/index.html")?.toString(), "later draft");
    assert.equal(store.get("docs/d").draft.storagePrefix, "docs/d/bundles/later");
  });
});

for (const channel of ["save", "commit", "update"]) test(`${channel} removes a candidate after a definite competing transaction wins`, async () => {
  await world(async ({ db, objects, save, commit, update }) => {
    const transact = db.runTransaction.bind(db);
    let raced = false;
    db.runTransaction = work => transact(async tx => {
      const result = await work(tx);
      if (!raced) {
        raced = true;
        await db.doc("docs/d/versions/v2").set({ entry: "index.html", storagePrefix: "docs/d/bundles/winner" });
        await db.doc("docs/d").update({ currentVersion: "v2" });
        objects.set("docs/d/bundles/winner/index.html", Buffer.from("winner"));
      }
      return result;
    });
    if (channel === "save") await assert.rejects(save(), e => e.detail?.currentVersion === "v2");
    else {
      const result = await (channel === "commit" ? commit() : update());
      assert.equal(result.status, 409);
    }
    assert.deepEqual([...objects.keys()].sort(), ["docs/d/bundles/draft/index.html", "docs/d/bundles/winner/index.html", "docs/d/v1/index.html"], "a normal losing transaction removes its unreferenced candidate");
  });
});

for (const reference of ["draft", "historical", "read failure"]) test(`candidate cleanup retains bytes on ${reference} evidence`, async () => {
  await world(async ({ db, objects }) => {
    const prefix = "docs/d/bundles/candidate";
    objects.set(`${prefix}/index.html`, Buffer.from(newHtml));
    if (reference === "draft") await db.doc("docs/d").update({ draft: { storagePrefix: prefix } });
    if (reference === "historical") await db.doc("docs/d/versions/v0").set({ storagePrefix: prefix });
    if (reference === "read failure") db.runTransaction = async () => { throw new Error("reference lookup unavailable"); };
    await removeUnreferencedCandidate(db, db.doc("docs/d"), prefix);
    assert.equal(objects.get(`${prefix}/index.html`)?.toString(), newHtml, "unreadable or existing durable references cannot authorize deletion");
  });
});
