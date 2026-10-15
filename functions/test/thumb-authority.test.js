// SPDX-License-Identifier: Apache-2.0
// Thumbnail uploads recheck editor authority after their bytes land and retire only their own refused candidate (SPEC §2).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { saveThumbs } = require("../lib/index.js");
const { THUMB_REVISION } = require("../lib/lib/thumbs.js");

const owner = "owner@example.com", editor = "editor@example.com";
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
const existingKey = "0123456789abcdef";

async function upload({ mode, actor = "editor", kind = "cover", initial = false }) {
  const thumb = kind === "cover"
    ? { versionId: "v1", rev: THUMB_REVISION, slides: { key: existingKey, count: 1 } }
    : { versionId: "v1", rev: THUMB_REVISION, cover: existingKey };
  const existingObject = `docs/d/thumbs/v1/${existingKey}/${kind === "cover" ? "s0" : "cover"}.jpg`;
  const before = { ownerUid: "owner", ownerEmail: owner, members: [owner, editor], editorMembers: [owner, editor], visibility: "private", currentVersion: "v1", thumb, updatedAt: 123 };
  const { db, store } = fakeFirestore({ "docs/d": before });
  const objects = new Map([[existingObject, Buffer.from("existing sibling thumbnail")], ["docs/other/thumbs/v1/keep/cover.jpg", Buffer.from("other document")]]);
  const originalObjects = new Map(objects);
  const saved = [], deleted = [];
  const changeAccess = async () => {
    if (mode === "owner") return;
    await db.doc("docs/d").update({ editorMembers: [owner], members: mode === "removed" ? [owner] : [owner, editor] });
  };
  if (initial) await changeAccess();
  const oldStorage = Object.getOwnPropertyDescriptor(admin, "storage");
  const oldBucket = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({
    file: (name) => ({ save: async (bytes) => {
      objects.set(name, Buffer.from(bytes));
      saved.push(name);
      // The authorization change happens after a real candidate object exists,
      // before saveThumbs can enter its metadata transaction.
      await changeAccess();
    } }),
    deleteFiles: async ({ prefix }) => {
      deleted.push(prefix);
      for (const name of objects.keys()) if (name.startsWith(prefix)) objects.delete(name);
    },
  }) }) });
  try {
    const response = await withFakeAdmin({ db, sessions: { s: { uid: actor, email: actor === "owner" ? owner : editor, email_verified: true } } }, () => invoke(saveThumbs, {
      headers: { cookie: "__session=s" }, query: { doc: "d", v: "v1", kind, sizes: String(jpeg.length), r: String(THUMB_REVISION) }, rawBody: jpeg,
    }));
    return { response, record: store.get("docs/d"), before, objects, originalObjects, saved, deleted, existingObject };
  } finally {
    if (oldStorage) Object.defineProperty(admin, "storage", oldStorage); else delete admin.storage;
    if (oldBucket === undefined) delete process.env.BIKESHED_BUCKET; else process.env.BIKESHED_BUCKET = oldBucket;
  }
}

for (const kind of ["cover", "slides"]) for (const [mode, status] of [["viewer", 403], ["removed", 404]]) {
  test(`${kind}: ${mode} after upload receives ${status} without metadata disclosure`, async () => {
    const r = await upload({ mode, kind });
    assert.equal(r.saved.length, 1, "the request passed initial authority and uploaded its candidate");
    assert.equal(r.response.status, status, "fresh thumbnail authority chooses the refusal status");
    assert.equal(r.response.body, undefined, "refusal reveals no thumbnail metadata");
  });
  test(`${kind}: ${mode} after upload cannot change the thumbnail or edit timestamp`, async () => {
    const r = await upload({ mode, kind });
    assert.deepEqual(r.record.thumb, r.before.thumb, "a refused capture cannot become shared thumbnail metadata");
    assert.equal(r.record.updatedAt, r.before.updatedAt, "a thumbnail refusal is not a document edit");
  });
  test(`${kind}: ${mode} after upload deletes only its own candidate objects`, async () => {
    const r = await upload({ mode, kind });
    assert.deepEqual(r.objects, r.originalObjects, "candidate cleanup retains the previous thumbnail and another document's bytes");
    assert.deepEqual(r.deleted, [r.saved[0].replace(/[^/]+$/, "")], "cleanup is confined to this upload's random key");
  });
}

for (const mode of ["viewer", "removed"]) test(`${mode} before upload is still refused without storing bytes`, async () => {
  const r = await upload({ mode, initial: true });
  assert.equal(r.response.status, mode === "viewer" ? 403 : 404);
  assert.deepEqual(r.saved, [], "the initial ACL guard still avoids unauthorized uploads");
});

test("owner can still store a thumbnail after another editor is removed during upload", async () => {
  const r = await upload({ actor: "owner", mode: "removed" });
  assert.deepEqual(r.response, { status: 200, body: { stored: true }, headers: { "cache-control": "private, no-store" } });
  assert.equal(r.record.thumb.cover, r.saved[0].split("/").at(-2), "the accepted owner candidate is the recorded key");
  assert.deepEqual(r.record.thumb.slides, r.before.thumb.slides, "the previously stored other kind remains recorded");
  assert.equal(r.record.updatedAt, r.before.updatedAt);
  assert.deepEqual(r.objects.get(r.saved[0]), jpeg, "the recorded owner JPEG remains stored");
  for (const [name, bytes] of r.originalObjects) assert.deepEqual(r.objects.get(name), bytes);
  assert.deepEqual(r.deleted, []);
});
