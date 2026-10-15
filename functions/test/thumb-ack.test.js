// SPDX-License-Identifier: Apache-2.0
// A retried thumbnail transaction acknowledges its own committed key without deleting the referenced JPEGs (SPEC §2).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { loseFirstTransactionAcknowledgement } = require("./transaction-ack.js");
const { saveThumbs } = require("../lib/index.js");
const { commitNewVersion } = require("../lib/lib/publish.js");
const { THUMB_REVISION } = require("../lib/lib/thumbs.js");
const owner = "owner@example.com", editor = "editor@example.com";
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
const sibling = "0123456789abcdef";

async function upload({ kind = "cover", revoke = false, oldVersion = false, replace = false } = {}) {
  const beforeThumb = oldVersion ? { versionId: "v0", rev: THUMB_REVISION, cover: sibling }
    : { versionId: "v1", rev: THUMB_REVISION, ...(kind === "cover" ? { slides: { key: sibling, count: 1 } } : { cover: sibling }) };
  const { db, store } = fakeFirestore({ "docs/d": {
    ownerUid: "owner", ownerEmail: owner, members: [owner, editor], editorMembers: [owner, editor], visibility: "private", currentVersion: "v1", thumb: beforeThumb,
  } });
  const siblingPath = `docs/d/thumbs/${oldVersion ? "v0" : "v1"}/${sibling}/${oldVersion || kind === "slides" ? "cover" : "s0"}.jpg`;
  const objects = new Map([[siblingPath, Buffer.from("previous JPEG")]]), saved = [];
  let later, laterEpoch;
  const send = (versionId, images) => invoke(saveThumbs, { headers: { cookie: "__session=s" }, query: { doc: "d", v: versionId, kind, sizes: images.map(b => b.length).join(","), r: String(THUMB_REVISION) }, rawBody: Buffer.concat(images) });
  if (replace) await db.doc("docs/d/versions/v1").set({ entry: "index.html", format: "html" });
  const faults = loseFirstTransactionAcknowledgement(db, { afterCommit: async () => {
    if (revoke) await db.doc("docs/d").update({ editorMembers: [owner], members: [owner] });
    if (replace) {
      const publication = await commitNewVersion({ db, docRef: db.doc("docs/d"), baseVersion: "v1", compiled: { entry: "index.html", format: "html", files: [{ rel: "index.html", data: Buffer.from("<p>Later publication</p>") }] }, actor: { uid: "editor", email: editor, channel: "web" }, authorEmail: editor, via: "editor" });
      assert.equal(publication.versionId, "v2", "a real later publication replaces the original thumbnail's head");
      const response = await send("v2", [jpeg]);
      assert.deepEqual({ status: response.status, body: response.body }, { status: 200, body: { stored: true } }, "the later head receives its own real thumbnail upload");
      later = store.get("docs/d").thumb;
      laterEpoch = store.get("docs/d").liveEpoch;
    }
  } });
  const descriptor = Object.getOwnPropertyDescriptor(admin, "storage"), oldBucket = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({
    file: name => ({ save: async bytes => { saved.push(name); objects.set(name, Buffer.from(bytes)); } }),
    deleteFiles: async ({ prefix }) => { for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key); },
  }) }) });
  try {
    const images = kind === "cover" ? [jpeg] : [jpeg, jpeg];
    const response = await withFakeAdmin({ db, sessions: { s: { uid: "editor", email: editor, email_verified: true } } }, () => invoke(saveThumbs, {
      headers: { cookie: "__session=s" }, query: { doc: "d", v: "v1", kind, sizes: images.map(b => b.length).join(","), r: String(THUMB_REVISION) }, rawBody: Buffer.concat(images),
    }));
    assert.equal(faults().failures, 1, "the SDK retried after one committed response was lost");
    return { response, objects, saved, siblingPath, later, laterEpoch, record: store.get("docs/d") };
  } finally {
    if (descriptor) Object.defineProperty(admin, "storage", descriptor); else delete admin.storage;
    if (oldBucket === undefined) delete process.env.BIKESHED_BUCKET; else process.env.BIKESHED_BUCKET = oldBucket;
  }
}

for (const kind of ["cover", "slides"]) {
  test(`${kind}: a lost commit acknowledgement still reports the accepted upload`, async () => {
    const r = await upload({ kind });
    assert.deepEqual({ status: r.response.status, body: r.response.body }, { status: 200, body: { stored: true } }, "an accepted candidate is not a competing loser");
  });
  test(`${kind}: retry keeps every referenced JPEG and its previous sibling`, async () => {
    const r = await upload({ kind });
    assert.deepEqual(r.objects, new Map([[r.siblingPath, Buffer.from("previous JPEG")], ...r.saved.map(key => [key, jpeg])]), "acknowledgement loss must not delete committed thumbnail bytes");
  });
}

test("a role revoked after the thumbnail committed does not misreport the completed upload", async () => {
  const r = await upload({ revoke: true });
  assert.deepEqual({ status: r.response.status, body: r.response.body }, { status: 200, body: { stored: true } }, "the unique key proves the write completed before revocation");
});
test("a postcommit revocation cannot make retry delete the stored thumbnail", async () => {
  const r = await upload({ revoke: true });
  assert.deepEqual(r.objects.get(`docs/d/thumbs/v1/${r.record.thumb.cover}/cover.jpg`), jpeg, "the recorded key still names the committed bytes");
});
test("a reconciled thumbnail commit still retires only the obsolete version's JPEGs", async () => {
  const r = await upload({ oldVersion: true });
  assert.deepEqual(r.objects, new Map(r.saved.map(key => [key, jpeg])), "reconciliation retains new JPEGs and completes the original retirement");
});

for (const observation of ["response", "cleanup", "newer state"]) test(`a later publication and thumbnail preserve the first committed upload's ${observation}`, async () => {
  const r = await upload({ oldVersion: true, replace: true });
  if (observation === "response") assert.deepEqual({ status: r.response.status, body: r.response.body }, { status: 200, body: { stored: true } }, "the first upload acknowledges its own successful commit after a later thumbnail replaced its current key");
  if (observation === "cleanup") assert.equal(r.objects.has(r.siblingPath), false, "the first upload completes its captured obsolete-version cleanup after a later thumbnail replaces it");
  if (observation === "newer state") {
    assert.equal(r.record.currentVersion, "v2", "retry never repoints the later published head");
    assert.equal(r.record.liveEpoch, r.laterEpoch, "retry leaves the later live epoch unchanged");
    assert.deepEqual(r.record.thumb, r.later, "retry never repoints the later real thumbnail");
    assert.deepEqual(r.objects.get(`docs/d/thumbs/v2/${r.later.cover}/cover.jpg`), jpeg, "the later real thumbnail's exact JPEG remains stored");
    assert.deepEqual(Object.keys(r.record.transactionReceipts ?? {}), [], "each completed thumbnail removes only its own receipt");
  }
});
