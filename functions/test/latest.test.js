// SPDX-License-Identifier: Apache-2.0
// A document's summary of its current version follows every way a version is made or withdrawn, and only ever names the head (SPEC §4, §17).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { Timestamp } = require("firebase-admin/firestore");
const { fakeFirestore, withFakeAdmin } = require("./fakes.js");
const { refreshLatest, summaryOf } = require("../lib/lib/latest.js");
const { WORDS_SCAN_CHARS } = require("../lib/lib/head.js");

const AT1 = Timestamp.fromMillis(Date.UTC(2026, 9, 28));
const AT2 = Timestamp.fromMillis(Date.UTC(2026, 9, 29));
const page = (words) => `<!doctype html><html><head><title>T</title></head><body><p>${words}</p></body></html>`;

function world({ current = "v2", v1 = {}, v2 = {} } = {}) {
  return fakeFirestore({
    "docs/d": { title: "Plan", ownerEmail: "own@example.com", visibility: "private", currentVersion: current },
    "docs/d/versions/v1": { entry: "index.html", storagePrefix: "docs/d/bundles/b1", publishedAt: AT1, publishedByEmail: "own@example.com", publishedBy: { channel: "web" }, publishedVia: "upload", ...v1 },
    "docs/d/versions/v2": { entry: "index.html", storagePrefix: "docs/d/bundles/b2", publishedAt: AT2, publishedByEmail: "own@example.com", publishedBy: { channel: "cli", via: "CLI on mbp" }, origin: "upload", ...v2 },
  });
}

/** Storage that holds each version's entry, and counts the downloads it serves. */
async function withStorage(objects, fn) {
  const saved = Object.getOwnPropertyDescriptor(admin, "storage");
  const before = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  const reads = [];
  Object.defineProperty(admin, "storage", {
    configurable: true,
    value: () => ({
      bucket: () => ({
        file: (path) => ({
          download: async (options) => {
            reads.push(path);
            reads.options = [...(reads.options ?? []), options];
            if (!(path in objects)) throw Object.assign(new Error("not found"), { code: 404 });
            return [Buffer.from(objects[path])];
          },
        }),
      }),
    }),
  });
  try {
    return await fn(reads);
  } finally {
    if (saved) Object.defineProperty(admin, "storage", saved);
    else delete admin.storage;
    if (before === undefined) delete process.env.BIKESHED_BUCKET;
    else process.env.BIKESHED_BUCKET = before;
  }
}

const OBJECTS = { "docs/d/bundles/b1/index.html": page("one two three"), "docs/d/bundles/b2/index.html": page("one two three four five") };

test("a new version is counted once and summarized on its document: when, by whom, through what, how it arrived", async () => {
  const { db, store } = world();
  await withFakeAdmin({ db }, () => withStorage(OBJECTS, async (reads) => {
    const moved = await refreshLatest(db, "d", "v2", store.get("docs/d/versions/v2"));
    assert.equal(store.get("docs/d/versions/v2").words, 5);
    assert.equal(moved?.title, "Plan", "the document as read, so the trigger can bring its mirror in line");
    // An entry may be as large as a bundle; only what a count reads is fetched.
    assert.deepEqual(reads.options, [{ start: 0, end: WORDS_SCAN_CHARS - 1, validation: false }]);
    const latest = store.get("docs/d").latest;
    assert.deepEqual({ ...latest, at: latest.at.toMillis() }, { version: "v2", at: AT2.toMillis(), byEmail: "own@example.com", channel: "cli", via: "CLI on mbp", origin: "upload", words: 5 });

    // The trigger fires again for its own write of the words: nothing is read or written twice.
    const run = db.runTransaction.bind(db);
    let updates = 0;
    db.runTransaction = (fn) => run((tx) => {
      const update = tx.update.bind(tx);
      tx.update = (...args) => (updates++, update(...args));
      return fn(tx);
    });
    const again = await refreshLatest(db, "d", "v2", store.get("docs/d/versions/v2"));
    assert.equal(reads.length, 1, "counted once");
    assert.equal(updates, 0, "and summarized once: an unchanged summary is not written again");
    assert.equal(again, null, "and nothing moved, so no mirror to bring in line");
  }));
});

test("a version that is not current is counted, but the summary keeps naming the head", async () => {
  const { db, store } = world({ v1: {} });
  await withFakeAdmin({ db }, () => withStorage(OBJECTS, async () => {
    await refreshLatest(db, "d", "v1", store.get("docs/d/versions/v1"));
    assert.equal(store.get("docs/d/versions/v1").words, 3);
    assert.equal(store.get("docs/d").latest.version, "v2", "v1 is not the head");
    assert.equal(store.get("docs/d").latest.words, undefined, "v2 not counted yet");
  }));
});

test("a withdrawal moves the summary back to what is current, with an older version's origin read from publishedVia", async () => {
  const { db, store } = world({ current: "v1", v1: { words: 3 } });
  await withFakeAdmin({ db }, () => withStorage(OBJECTS, async (reads) => {
    await refreshLatest(db, "d", "v2", undefined);
    const latest = store.get("docs/d").latest;
    assert.deepEqual([latest.version, latest.channel, latest.origin, latest.words], ["v1", "web", "upload", 3]);
    assert.equal(reads.length, 0, "a deleted version has nothing to count");
  }));
});

test("an entry that cannot be read is left uncounted, and the summary still moves", async () => {
  const { db, store } = world();
  await withFakeAdmin({ db }, () => withStorage({}, async () => {
    await refreshLatest(db, "d", "v2", store.get("docs/d/versions/v2"));
    assert.equal(store.get("docs/d/versions/v2").words, undefined);
    assert.equal(store.get("docs/d").latest.version, "v2");
    assert.ok(!("words" in store.get("docs/d").latest));
  }));
});

test("a version stored without an entry name is counted from index.html, as every reader of it opens", async () => {
  const { db, store } = world({ v2: { entry: undefined } });
  await withFakeAdmin({ db }, () => withStorage(OBJECTS, async (reads) => {
    await refreshLatest(db, "d", "v2", store.get("docs/d/versions/v2"));
    assert.deepEqual([...reads], ["docs/d/bundles/b2/index.html"]);
    assert.equal(store.get("docs/d/versions/v2").words, 5);
  }));
});

test("what a reader is told is the summary only while it names the head", () => {
  const at = AT2;
  const renamed = Timestamp.fromMillis(Date.UTC(2026, 9, 30));
  const latest = { version: "v2", at, words: 5 };
  assert.deepEqual(summaryOf({ currentVersion: "v2", latest, updatedAt: renamed }), { at, words: 5 });
  assert.deepEqual(summaryOf({ currentVersion: "v3", latest, updatedAt: renamed }), { at: renamed, words: null }, "v3 just published, not yet summarized");
  assert.deepEqual(summaryOf({ currentVersion: "v2", updatedAt: renamed }), { at: renamed, words: null }, "a document from before the summary");
  assert.deepEqual(summaryOf({ currentVersion: "v2", createdAt: AT1 }), { at: AT1, words: null });
});
