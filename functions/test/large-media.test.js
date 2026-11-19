// SPDX-License-Identifier: Apache-2.0
// Large media go straight to Storage through a session, are checked before a version names them, and download by a link (SPEC §2, §24, ADR 0038).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const AdmZip = require("adm-zip");
const { Readable, PassThrough } = require("node:stream");
const { Timestamp } = require("firebase-admin/firestore");

const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { createDoc, downloadBundle } = require("../lib/index.js");
const { checkSessionRequest, readStaged, storeStaged } = require("../lib/lib/staging.js");
const { writeStoredZip } = require("../lib/lib/zipstream.js");
const { setMediaSigner } = require("../lib/lib/medialink.js");
const { sha256Hex } = require("../lib/lib/hash.js");
const { versionBytes } = require("./stored.js");

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const READER = { uid: "u-reader", emailLower: "reader@example.com" };
const SESSIONS = Object.fromEntries([OWNER, READER].map((p) => [`s-${p.uid}`, { uid: p.uid, email: p.emailLower, email_verified: true }]));
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const NOW = Date.now();
const MB = 1024 * 1024;

/** A bucket in memory that records sessions, reads and copies, with object metadata as Storage gives it. */
function memoryBucket(objects = new Map(), meta = new Map()) {
  const log = { sessions: [], reads: [], copies: [] };
  const file = (name, opts = {}) => ({
    name,
    createResumableUpload: async (options) => { log.sessions.push({ name, options }); return [`https://upload.example.com/${name}?upload_id=secret`]; },
    getMetadata: async () => {
      if (!objects.has(name)) throw Object.assign(new Error("not found"), { code: 404 });
      return [{ size: String(objects.get(name).length), generation: "7", timeCreated: new Date(NOW).toISOString(), ...(meta.get(name) ?? {}) }];
    },
    exists: async () => [objects.has(name)],
    createReadStream: () => { log.reads.push({ name, generation: opts.generation }); return Readable.from([objects.get(name) ?? Buffer.alloc(0)]); },
    download: async () => [objects.get(name)],
    copy: async (dest, o) => {
      if (o?.preconditionOpts?.ifGenerationMatch === 0 && objects.has(dest)) throw Object.assign(new Error("412"), { code: 412 });
      log.copies.push({ from: name, generation: opts.generation, to: dest });
      objects.set(dest, objects.get(name));
    },
    save: async (data, o) => {
      if (o?.preconditionOpts?.ifGenerationMatch === 0 && objects.has(name)) throw Object.assign(new Error("412"), { code: 412 });
      objects.set(name, Buffer.from(data));
    },
    createWriteStream: (o) => {
      const out = new PassThrough();
      const chunks = [];
      out.on("data", (c) => chunks.push(c));
      out.on("end", () => objects.set(name, Buffer.concat(chunks)));
      if (o?.preconditionOpts?.ifGenerationMatch === 0 && objects.has(name)) process.nextTick(() => out.destroy(Object.assign(new Error("412"), { code: 412 })));
      return out;
    },
  });
  return { objects, meta, log, file, getFiles: async ({ prefix }) => [[...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => file(k))], deleteFiles: async () => {} };
}

function staged(bucket, uid, id, { doc = "d", path = "film/intro.mp4", bytes = Buffer.from("a film"), declared, made } = {}) {
  const key = `staging/${uid}/${id}`;
  bucket.objects.set(key, bytes);
  bucket.meta.set(key, {
    metadata: { doc, path, size: String(declared ?? bytes.length), issued: String(NOW) },
    ...(made ? { timeCreated: new Date(made).toISOString() } : {}),
  });
  return key;
}

// --- Asking for a session ------------------------------------------------------

test("a session is for a picture, film or recording, of a stated size, at a usable path", () => {
  const refused = (b) => checkSessionRequest(b).error;
  assert.match(refused({ path: "logo.svg", size: 10 }), /only pictures, films and recordings/);
  assert.match(refused({ path: "notes.pdf", size: 10 }), /only pictures, films and recordings/);
  assert.match(refused({ path: "../x.mp4", size: 10 }), /relative path/);
  assert.match(refused({ path: ".hidden.mp4", size: 10 }), /left out/);
  assert.match(refused({ path: "a.mp4", size: 0 }), /at most 200 MB/);
  assert.match(refused({ path: "a.mp4", size: 200 * MB + 1 }), /at most 200 MB/);
  assert.match(refused({ path: "a.mp4", size: 5, sha256: "ABC" }), /64 lowercase hex/);
  assert.deepEqual(checkSessionRequest({ path: "film/intro.mp4", size: 5 }), { path: "film/intro.mp4", size: 5, sha256: null });
});

function world({ doc = {}, version = null } = {}) {
  const bucket = memoryBucket();
  const v = version ?? { versionId: "v1", entry: "index.html", format: "html", layout: "blobs", hashVersion: 2, contentHash: "c".repeat(64), attempt: "seed",
    files: ["index.html"], hashes: [sha256Hex(Buffer.from("<p>page"))], sizes: [7], fileCount: 1, bytes: 7 };
  bucket.objects.set(`docs/d/blobs/${sha256Hex(Buffer.from("<p>page"))}`, Buffer.from("<p>page"));
  const { db, store } = fakeFirestore({
    "docs/d": { docId: "d", title: "Deck", slug: "deck", ownerUid: OWNER.uid, ownerEmail: OWNER.emailLower, currentVersion: "v1", visibility: "private",
      viewers: [READER.emailLower], editors: [], suggesters: [], approvers: [], members: [OWNER.emailLower, READER.emailLower],
      suggesterMembers: [OWNER.emailLower], editorMembers: [OWNER.emailLower], approverMembers: [OWNER.emailLower],
      createdAt: Timestamp.fromMillis(NOW), updatedAt: Timestamp.fromMillis(NOW), ...doc },
    "docs/d/versions/v1": { ...v, publishedAt: Timestamp.fromMillis(NOW) },
  });
  const around = async (fn) => {
    const saved = ["storage", "database"].map((k) => [k, Object.getOwnPropertyDescriptor(admin, k)]);
    const env = { bucket: process.env.BIKESHED_BUCKET, origin: process.env.BIKESHED_PUBLIC_ORIGIN, project: process.env.GCLOUD_PROJECT };
    process.env.BIKESHED_BUCKET = "test-bucket";
    process.env.GCLOUD_PROJECT = "demo-bikeshed";
    process.env.BIKESHED_PUBLIC_ORIGIN = "https://bikeshed.example";
    Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => bucket }) });
    Object.defineProperty(admin, "database", { configurable: true, value: () => { throw new Error("no Realtime Database configured"); } });
    try { return await withFakeAdmin({ db, sessions: SESSIONS }, fn); }
    finally {
      for (const [k, d] of saved) { if (d) Object.defineProperty(admin, k, d); else delete admin[k]; }
      if (env.bucket === undefined) delete process.env.BIKESHED_BUCKET; else process.env.BIKESHED_BUCKET = env.bucket;
      if (env.origin === undefined) delete process.env.BIKESHED_PUBLIC_ORIGIN; else process.env.BIKESHED_PUBLIC_ORIGIN = env.origin;
      if (env.project === undefined) delete process.env.GCLOUD_PROJECT; else process.env.GCLOUD_PROJECT = env.project;
    }
  };
  const as = (who) => (who ? { cookie: `__session=s-${who.uid}` } : {});
  const media = (who, body, headers = {}) => around(() => invoke(createDoc, { method: "POST", path: "/media", body, headers: { ...as(who), ...headers } }));
  const publish = (who, query, body) => around(() => invoke(createDoc, { method: "POST", path: "/publish", query, rawBody: body, body, headers: as(who) }));
  const download = (who) => around(() => invoke(downloadBundle, { method: "GET", path: "/download/d/v1", headers: as(who) }));
  return { db, store, bucket, media, publish, download };
}

test("POST /media opens a create-only session of the declared length on the caller's own object, and says nothing of who else", async () => {
  const w = world();
  assert.equal((await w.media(null, { path: "a.mp4", size: 5 })).status, 401);
  assert.equal((await w.media(OWNER, { docId: "nope", path: "a.mp4", size: 5 })).status, 404);
  assert.equal((await w.media(READER, { docId: "d", path: "a.mp4", size: 5 })).status, 403, "a reader who is not an editor");
  assert.equal((await w.media(OWNER, { docId: "d", path: "logo.svg", size: 5 })).status, 400);

  const r = await w.media(OWNER, { docId: "d", path: "film/intro.mp4", size: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers["cache-control"], "private, no-store", "a session URL is a secret");
  assert.match(r.body.stagingId, /^[0-9a-f-]{36}$/);
  assert.equal(r.body.chunkBytes, 8 * MB);
  const [session] = w.bucket.log.sessions;
  assert.equal(session.name, `staging/${OWNER.uid}/${r.body.stagingId}`);
  assert.deepEqual(session.options.preconditionOpts, { ifGenerationMatch: 0 }, "create-only");
  assert.equal(session.options.metadata.contentLength, 5, "Storage refuses a byte more than declared");
  assert.equal(session.options.metadata.contentType, "video/mp4");
  assert.deepEqual({ ...session.options.metadata.metadata, issued: undefined }, { doc: "d", path: "film/intro.mp4", size: "5", issued: undefined });
  assert.equal(session.options.origin, "https://bikeshed.example", "a browser's session names the deployment's own origin for CORS");

  // Someone on another of the deployment's own addresses gets a session that
  // answers there; a forwarded host that is not the deployment's is ignored.
  const other = "demo-bikeshed.web.app";
  await w.media(OWNER, { docId: "d", path: "b.mp4", size: 5 }, { "x-forwarded-host": other });
  await w.media(OWNER, { docId: "d", path: "c.mp4", size: 5 }, { "x-forwarded-host": "evil.example" });
  assert.deepEqual(w.bucket.log.sessions.slice(1).map((s) => s.options.origin), [`https://${other}`, "https://bikeshed.example"]);
  // The emulator finishes a session at its first PUT, so there a file goes whole.
  process.env.FUNCTIONS_EMULATOR = "true";
  try { assert.equal((await w.media(OWNER, { docId: "d", path: "e.mp4", size: 5 })).body.chunkBytes, 200 * MB); }
  finally { delete process.env.FUNCTIONS_EMULATOR; }

  const frozen = world({ doc: { expiresAt: Timestamp.fromMillis(NOW - 1000) } });
  assert.equal((await frozen.media(OWNER, { docId: "d", path: "a.mp4", size: 5 })).status, 409);
});

test("POST /media answers that the document already stores a file, and opens nothing", async () => {
  const w = world();
  const film = Buffer.from("the same film");
  w.bucket.objects.set(`docs/d/blobs/${sha256Hex(film)}`, film);
  const r = await w.media(OWNER, { docId: "d", path: "intro.mp4", size: film.length, sha256: sha256Hex(film) });
  assert.deepEqual(r.body, { have: true });
  assert.equal(w.bucket.log.sessions.length, 0);
});

// --- Naming a staged upload --------------------------------------------------------

test("a staged upload is read only as its own caller's, for its document, whole, fresh, at a pinned generation", async () => {
  const bucket = memoryBucket();
  const film = Buffer.from("a film, really");
  staged(bucket, OWNER.uid, ID, { bytes: film });
  const ok = await readStaged({ bucket, uid: OWNER.uid, docId: "d", stagingIds: [ID] });
  assert.deepEqual(ok.files.map((f) => [f.rel, f.size, f.sha256, f.generation]), [["film/intro.mp4", film.length, sha256Hex(film), "7"]]);
  assert.deepEqual(bucket.log.reads, [{ name: `staging/${OWNER.uid}/${ID}`, generation: "7" }], "hashed at the generation it checked");

  assert.match((await readStaged({ bucket, uid: READER.uid, docId: "d", stagingIds: [ID] })).error, /not there/, "another account's upload is not theirs to name");
  assert.match((await readStaged({ bucket, uid: OWNER.uid, docId: "other", stagingIds: [ID] })).error, /another document/);
  assert.match((await readStaged({ bucket, uid: OWNER.uid, docId: "d", stagingIds: ["../x"] })).error, /not a staging id/);
  staged(bucket, OWNER.uid, OTHER_ID, { bytes: Buffer.from("half"), declared: 100 });
  assert.match((await readStaged({ bucket, uid: OWNER.uid, docId: "d", stagingIds: [OTHER_ID] })).error, /did not finish: 4 of 100 bytes/);
  staged(bucket, OWNER.uid, OTHER_ID, { made: NOW - 25 * 60 * 60 * 1000 });
  assert.match((await readStaged({ bucket, uid: OWNER.uid, docId: "d", stagingIds: [OTHER_ID] })).error, /more than a day old/);
  staged(bucket, OWNER.uid, OTHER_ID, { path: "logo.svg" });
  assert.match((await readStaged({ bucket, uid: OWNER.uid, docId: "d", stagingIds: [OTHER_ID] })).error, /no usable path/);

  await storeStaged(bucket, "d", ok.files);
  assert.deepEqual(bucket.log.copies, [{ from: `staging/${OWNER.uid}/${ID}`, generation: "7", to: `docs/d/blobs/${sha256Hex(film)}` }]);
  await storeStaged(bucket, "d", ok.files);
  assert.equal(bucket.log.copies.length, 1, "already stored is success, and nothing is copied over it");
});

test("a film laid over a version by name needs no body, and the version is past 25 MB", async () => {
  const w = world({ version: {
    versionId: "v1", entry: "index.html", format: "html", layout: "blobs", hashVersion: 2, contentHash: "c".repeat(64), attempt: "seed",
    // The b-roll is carried, so the next version is past 25 MB whatever replaces the intro.
    files: ["film/b-roll.mp4", "film/intro.mp4", "index.html"], hashes: ["b".repeat(64), "a".repeat(64), sha256Hex(Buffer.from("<p>page"))],
    sizes: [30 * MB, MB, 7], fileCount: 3, bytes: 31 * MB + 7,
  } });
  const film = Buffer.from("the final cut");
  staged(w.bucket, OWNER.uid, ID, { path: "intro.mp4", bytes: film });
  const r = await w.publish(OWNER, { update: "d", merge: "1", media: ID });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.placed, [{ sent: "intro.mp4", at: "film/intro.mp4" }]);
  const v2 = w.store.get("docs/d/versions/v2");
  assert.equal(versionBytes(w.bucket.objects, "d", "v2", v2, "film/intro.mp4").toString(), "the final cut");
  assert.ok(v2.bytes > 25 * MB, "a version past what a request body may be");
  assert.equal(w.bucket.objects.has(`staging/${OWNER.uid}/${ID}`), true, "never deleted: a lost acknowledgement retries into deduped");

  const again = await w.publish(OWNER, { update: "d", merge: "1", media: ID, baseVersion: "v2" });
  assert.equal(again.body.deduped, true);
});

test("a new document takes its film beside its page, and an update carries what the document already stores", async () => {
  const w = world();
  const film = Buffer.from("a whole film");
  staged(w.bucket, OWNER.uid, ID, { doc: "", path: "film.mp4", bytes: film });
  const zip = new AdmZip(); zip.addFile("index.html", Buffer.from("<video src=film.mp4 controls></video>"));
  const made = await w.publish(OWNER, { filename: "deck.zip", media: ID }, zip.toBuffer());
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const v1 = w.store.get(`docs/${made.body.docId}/versions/v1`);
  assert.deepEqual(v1.files, ["film.mp4", "index.html"]);
  assert.equal(versionBytes(w.bucket.objects, made.body.docId, "v1", v1, "film.mp4").toString(), "a whole film");

  // The CLI does not send an unchanged film again; it names it.
  const kept = new AdmZip(); kept.addFile("index.html", Buffer.from("<p>new words<video src=film.mp4></video>"));
  w.bucket.objects.set(`docs/d/blobs/${sha256Hex(film)}`, film);
  const r = await w.publish(OWNER, { update: "d", filename: "deck.zip", have: `film.mp4:${sha256Hex(film)}` }, kept.toBuffer());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(w.store.get("docs/d/versions/v2").files, ["film.mp4", "index.html"]);
  const missing = await w.publish(OWNER, { update: "d", filename: "deck.zip", have: `film.mp4:${"e".repeat(64)}` }, kept.toBuffer());
  assert.match(missing.body.error, /does not store film\.mp4 as sent/);
});

// --- A large download ------------------------------------------------------------------

test("a version over 25 MB downloads from a zip built once, by a short link", async () => {
  const page = Buffer.from("<p>page");
  const big = Buffer.alloc(26 * MB, 7);
  const w = world({ version: {
    versionId: "v1", entry: "index.html", format: "html", layout: "blobs", hashVersion: 2, contentHash: "d".repeat(64), attempt: "seed",
    files: ["film.mp4", "index.html"], hashes: [sha256Hex(big), sha256Hex(page)], sizes: [big.length, page.length], fileCount: 2, bytes: big.length + page.length,
  } });
  w.bucket.objects.set(`docs/d/blobs/${sha256Hex(big)}`, big);
  const asked = [];
  setMediaSigner(async (req) => { asked.push(req); return `https://storage.example.com/${req.objectKey}?sig=1`; });
  try {
    const r = await w.download(OWNER);
    assert.equal(r.status, 302);
    assert.equal(r.headers["cache-control"], "private, no-store");
    assert.equal(asked[0].objectKey, `downloads/d/${"d".repeat(64)}.zip`, "named by its bytes, not its version");
    assert.equal(asked[0].disposition, 'attachment; filename="deck-v1.zip"');
    const built = new AdmZip(w.bucket.objects.get(asked[0].objectKey));
    assert.deepEqual(built.getEntries().map((e) => [e.entryName, e.header.size]), [["film.mp4", big.length], ["index.html", page.length]]);
    assert.ok(built.getEntry("film.mp4").getData().equals(big), "the CRC and bytes read back");
    assert.equal((await w.download(READER)).status, 302, "any reader may download");
  } finally {
    setMediaSigner(null);
  }
});

test("the streamed zip is a valid zip and the same bytes every time", async () => {
  const sources = [{ rel: "a b/été.txt", data: Buffer.from("été") }, { rel: "empty", data: Buffer.alloc(0) }, { rel: "big.bin", data: Buffer.alloc(3 * MB, 1) }]
    .map((f) => ({ rel: f.rel, size: f.data.length, open: () => Readable.from([f.data.subarray(0, 1), f.data.subarray(1)]) }));
  const make = async () => {
    const out = new PassThrough(); const chunks = []; out.on("data", (c) => chunks.push(c));
    const length = await writeStoredZip(out, sources, new Date(Date.UTC(2026, 10, 18, 9, 30, 10)));
    const zip = Buffer.concat(chunks);
    assert.equal(zip.length, length);
    return zip;
  };
  const one = await make();
  assert.ok(one.equals(await make()), "deterministic");
  const read = new AdmZip(one);
  assert.deepEqual(read.getEntries().map((e) => e.entryName), ["a b/été.txt", "empty", "big.bin"]);
  assert.equal(read.getEntry("a b/été.txt").getData().toString(), "été");
  assert.equal(read.getEntry("big.bin").header.time.getUTCFullYear?.() ?? 2026, 2026);
  await assert.rejects(writeStoredZip(new PassThrough(), [{ rel: "short", size: 10, open: () => Readable.from([Buffer.from("abc")]) }], new Date()), /is 3 bytes, not 10/);
});
