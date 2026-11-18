// SPDX-License-Identifier: Apache-2.0
// A version lists its files, and each file's bytes are stored once per document (SPEC §4, §9.1, ADR 0036).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { fakeFirestore, withFakeAdmin } = require("./fakes.js");
const { reviseDocument, commitNewVersion } = require("../lib/lib/publish.js");
const { commitDraft } = require("../lib/lib/draft.js");
const { hashBundleFiles, sha256Hex } = require("../lib/lib/hash.js");
const { versionObjectKey, storedFiles } = require("../lib/lib/storage.js");
const { assertNotWithdrawing } = require("../lib/lib/blobs.js");
const { listedHash } = require("./stored.js");

const actor = { uid: "owner", email: "owner@example.com", channel: "web" };
const page = "<!doctype html><title>Deck</title><img src=chart.png>";
const chart = Buffer.from("\x89PNG chart, one megabyte in real life");
const sha = (text) => sha256Hex(Buffer.from(text));

/** A stored-layout record for these files, as the server writes one. */
function storedRecord(files) {
  const listing = files.map(([rel, data]) => ({ rel, size: Buffer.from(data).length, sha256: sha(data) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    entry: "index.html",
    format: "html",
    layout: "blobs",
    files: listing.map((f) => f.rel),
    hashes: listing.map((f) => f.sha256),
    sizes: listing.map((f) => f.size),
    fileCount: listing.length,
    bytes: listing.reduce((n, f) => n + f.size, 0),
    contentHash: listedHash(files.map(([rel, data]) => ({ rel, data: Buffer.from(data) }))),
    hashVersion: 2,
    attempt: "seed",
  };
}

/**
 * A document whose v1 is `head`, over a bucket that records every write and
 * REFUSES every read of a stored file: a mint that reads what it carries over
 * fails here, which is the point.
 */
async function world(head, objects, body, { doc = {} } = {}) {
  const { db, store } = fakeFirestore({
    "docs/d": { ownerUid: "owner", ownerEmail: actor.email, currentVersion: "v1", liveEpoch: "initial", ...doc },
    "docs/d/versions/v1": head,
  });
  const writes = [];
  const reads = [];
  const file = (name) => ({
    name,
    save: async (bytes, opts) => {
      if (opts?.preconditionOpts?.ifGenerationMatch === 0 && objects.has(name)) throw Object.assign(new Error("412"), { code: 412 });
      writes.push(name);
      objects.set(name, Buffer.from(bytes));
    },
    download: async () => {
      reads.push(name);
      if (name.includes("/blobs/")) throw new Error(`a mint read a stored file it carries: ${name}`);
      if (!objects.has(name)) throw Object.assign(new Error("not found"), { code: 404 });
      return [objects.get(name)];
    },
  });
  const descriptor = Object.getOwnPropertyDescriptor(admin, "storage");
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({
    file,
    getFiles: async ({ prefix }) => [[...objects.keys()].filter((k) => k.startsWith(prefix)).map(file)],
    deleteFiles: async ({ prefix }) => { for (const k of objects.keys()) if (k.startsWith(prefix)) objects.delete(k); },
  }) }) });
  const docRef = db.doc("docs/d");
  try { await withFakeAdmin({ db }, () => body({ db, store, docRef, writes, reads, objects })); }
  finally { if (descriptor) Object.defineProperty(admin, "storage", descriptor); else delete admin.storage; }
}

function storedObjects(files) {
  return new Map(files.map(([, data]) => [`docs/d/blobs/${sha(data)}`, Buffer.from(data)]));
}

const pageOnly = (html) => ({ files: [{ rel: "index.html", data: Buffer.from(html) }], entry: "index.html", format: "html", archive: false });

// --- Finding a version's files ----------------------------------------------

test("a stored version resolves each listed path to its document's stored file, and nothing else", () => {
  const record = storedRecord([["index.html", page], ["img/chart.png", chart]]);
  assert.equal(versionObjectKey("d", "v1", record, "img/chart.png"), `docs/d/blobs/${sha(chart)}`);
  assert.equal(versionObjectKey("d", "v1", record, "index.html"), `docs/d/blobs/${sha(page)}`);
  assert.equal(versionObjectKey("d", "v1", record, "missing.png"), null, "a path it does not list costs no Storage call");
  // A version from before files were stored once keeps its prefix.
  assert.equal(versionObjectKey("d", "v1", { storagePrefix: "docs/d/bundles/u1" }, "a b.png"), "docs/d/bundles/u1/a b.png");
});

test("a malformed list names no file at all, so nothing outside the document can be reached", () => {
  const good = storedRecord([["index.html", page]]);
  for (const bad of [
    { ...good, hashes: [] },
    { ...good, hashes: [good.hashes[0], good.hashes[0]], sizes: [1, 1] },
    { ...good, hashes: ["../../other/blobs/x"] },
    { ...good, files: ["../escape.html"] },
    { ...good, files: ["index.html", "index.html"], hashes: [good.hashes[0], good.hashes[0]], sizes: [1, 1] },
    { ...good, sizes: [-1] },
  ]) {
    assert.deepEqual(storedFiles("d", bad), []);
    assert.equal(versionObjectKey("d", "v1", bad, "index.html"), null);
  }
});

// --- Minting writes only what changed ----------------------------------------

test("changing one file mints a version that writes that file alone and reads nothing it carries", async () => {
  const files = [["index.html", page], ["img/chart.png", chart]];
  await world(storedRecord(files), storedObjects(files), async ({ db, store, docRef, writes, reads }) => {
    const next = "<!doctype html><title>Deck</title><p>new words</p><img src=img/chart.png>";
    const result = await reviseDocument({ db, docRef, baseVersion: "v1", title: "Deck", extracted: pageOnly(next), actor, authorEmail: actor.email });
    assert.equal(result.versionId, "v2", JSON.stringify(result));
    assert.deepEqual(writes, [`docs/d/blobs/${sha(next)}`], "only the new page is written");
    assert.deepEqual(reads, [], "no carried file is read");
    assert.deepEqual(result.changes, { changed: 1, unchanged: 1, removed: 0 });

    const v2 = store.get("docs/d/versions/v2");
    assert.equal(v2.layout, "blobs");
    assert.deepEqual(v2.files, ["img/chart.png", "index.html"]);
    assert.equal(v2.hashes[0], sha(chart), "the chart is the same stored file as v1's");
    assert.equal(v2.contentHash, listedHash([{ rel: "index.html", data: Buffer.from(next) }, { rel: "img/chart.png", data: chart }]));
    assert.equal(v2.hashVersion, 2);
    assert.equal(v2.storagePrefix, undefined, "a stored version owns no prefix");
  });
});

test("the same files again mint nothing, and write nothing", async () => {
  const files = [["index.html", page], ["img/chart.png", chart]];
  await world(storedRecord(files), storedObjects(files), async ({ db, store, docRef, writes }) => {
    const result = await reviseDocument({ db, docRef, baseVersion: "v1", title: "Deck", extracted: pageOnly(page), actor, authorEmail: actor.email });
    assert.equal(result.deduped, true);
    assert.equal(result.versionId, "v1");
    assert.deepEqual(result.changes, { changed: 0, unchanged: 2, removed: 0 });
    assert.deepEqual(writes, []);
    assert.equal(store.has("docs/d/versions/v2"), false);
  });
});

test("a draft commit writes only the page it edited", async () => {
  const files = [["index.html", page], ["img/chart.png", chart]];
  const objects = storedObjects(files);
  const edited = "<!doctype html><title>Deck</title><p>edited in the app</p>";
  objects.set("docs/d/drafts/one/index.html", Buffer.from(edited));
  const draft = { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/drafts/one" };
  await world(storedRecord(files), objects, async ({ db, store, docRef, writes }) => {
    const { status, body } = await commitDraft({ db, docRef, baseVersion: "v1", draft, emailLower: actor.email, actor });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(writes, [`docs/d/blobs/${sha(edited)}`]);
    assert.deepEqual(body.changes, { changed: 1, unchanged: 1, removed: 0 });
    assert.equal(store.get("docs/d/versions/v2").hashes[store.get("docs/d/versions/v2").files.indexOf("img/chart.png")], sha(chart));
  }, { doc: { draft } });
});

// --- A head from before files were stored once ---------------------------------

test("an older prefix head is read once and stored once; identical bytes still mint nothing", async () => {
  const legacy = { entry: "index.html", format: "html", storagePrefix: "docs/d/bundles/old", contentHash: hashBundleFiles([
    { rel: "index.html", data: Buffer.from(page) }, { rel: "img/chart.png", data: chart },
  ]).contentHash };
  const objects = new Map([["docs/d/bundles/old/index.html", Buffer.from(page)], ["docs/d/bundles/old/img/chart.png", chart]]);
  await world(legacy, objects, async ({ db, store, docRef, writes }) => {
    const same = await reviseDocument({ db, docRef, baseVersion: "v1", title: "Deck", extracted: pageOnly(page), actor, authorEmail: actor.email });
    assert.equal(same.deduped, true, "compared with the head in the framing it was minted with");
    assert.deepEqual(writes, []);

    const next = "<p>first version stored once</p>";
    const result = await reviseDocument({ db, docRef, baseVersion: "v1", title: "Deck", extracted: pageOnly(next), actor, authorEmail: actor.email });
    assert.equal(result.versionId, "v2");
    assert.deepEqual(writes.sort(), [`docs/d/blobs/${sha(chart)}`, `docs/d/blobs/${sha(next)}`].sort(), "the carried chart is stored once, and the old prefix is left alone");
    assert.equal(objects.get("docs/d/bundles/old/index.html").toString(), page, "v1 still reads from its own prefix");
    assert.equal(store.get("docs/d/versions/v2").layout, "blobs");
  });
});

// --- A withdrawal in progress ------------------------------------------------

test("a version that would reuse a file an operator is deleting is refused until the mark lapses", async () => {
  const files = [["index.html", page]];
  const doomedHtml = "<p>the withdrawn version's page</p>";
  const mark = (until) => ({ withdrawing: { hashes: [sha(doomedHtml)], until } });
  await world(storedRecord(files), storedObjects(files), async ({ db, store, docRef }) => {
    const result = await commitNewVersion({ db, docRef, baseVersion: "v1", actor, authorEmail: actor.email,
      compiled: { entry: "index.html", format: "html", files: [{ rel: "index.html", data: Buffer.from(doomedHtml) }] } });
    assert.equal(result.status, 409);
    assert.match(result.error, /being withdrawn/);
    assert.equal(store.has("docs/d/versions/v2"), false);
  }, { doc: mark(Date.now() + 60_000) });

  // Unrelated files publish through a mark, and a lapsed mark holds nothing back.
  assert.doesNotThrow(() => assertNotWithdrawing(mark(Date.now() + 60_000), [{ rel: "a", size: 1, sha256: sha("other") }]));
  assert.doesNotThrow(() => assertNotWithdrawing(mark(Date.now() - 1), [{ rel: "a", size: 1, sha256: sha(doomedHtml) }]));
  assert.throws(() => assertNotWithdrawing(mark(Date.now() + 60_000), [{ rel: "a", size: 1, sha256: sha(doomedHtml) }]), /WITHDRAWING/);
});

test("withdrawing deletes only the stored files no other version names", async () => {
  const { onlyNamedBy } = await import("../../scripts/lib/stored.mjs");
  const shared = storedRecord([["index.html", page], ["img/chart.png", chart]]);
  const doomed = storedRecord([["index.html", "<p>leaked</p>"], ["img/chart.png", chart], ["secrets.png", "secret"]]);
  const { deletes, keeps } = onlyNamedBy("d", doomed, [{ id: "v1", record: shared }, { id: "v0", record: { storagePrefix: "docs/d/bundles/x" } }]);
  assert.deepEqual(deletes.map((f) => f.paths).sort(), [["index.html"], ["secrets.png"]]);
  assert.deepEqual(keeps.map((f) => [f.paths, f.usedBy]), [[["img/chart.png"], ["v1"]]]);
  // A version from before files were stored once owns a prefix, and no stored file.
  assert.deepEqual(onlyNamedBy("d", { storagePrefix: "docs/d/bundles/x" }, []), { deletes: [], keeps: [] });
});

test("the operator scripts find a version's files where the functions do", async () => {
  // The ESM side throws on a malformed list where the CommonJS side names
  // nothing: a script acts on what it is given, a reader serves nothing.
  const esm = await import("../../scripts/lib/stored.mjs");
  const record = storedRecord([["index.html", page], ["img/chart.png", chart], ["a b.png", "spaced"]]);
  assert.deepEqual(
    esm.storedEntries("d", record).map((f) => [f.rel, f.key, f.size]),
    storedFiles("d", record).map((f) => [f.rel, f.key, f.size]),
  );
  assert.throws(() => esm.storedEntries("d", { ...record, hashes: [] }), /malformed/);
  assert.equal(esm.isStoredLayout(record), true);
  assert.equal(esm.isStoredLayout({ storagePrefix: "docs/d/v1" }), false);
});
