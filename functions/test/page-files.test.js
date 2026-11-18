// SPDX-License-Identifier: Apache-2.0
// A page's files beside it: names with spaces, video by a short link, caching by type, an agent's files and loose files (SPEC §2, §17, §19, §24).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const AdmZip = require("adm-zip");
const { Timestamp } = require("firebase-admin/firestore");

const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { contentProxy, getDraft, createDoc } = require("../lib/index.js");
const { TOOLS } = require("../lib/mcp/tools.js");
const { contentPath } = require("../lib/lib/http.js");
const { extractBundle, extractLoose } = require("../lib/lib/bundle.js");
const { decodeAgentFiles, resolveLoose, isStreamedMedia } = require("../lib/lib/files.js");
const { compileOverlay } = require("../lib/lib/publish.js");
const { loadVersionMeta } = require("../lib/lib/draft.js");
const { setMediaSigner } = require("../lib/lib/medialink.js");
const { sha256Hex } = require("../lib/lib/hash.js");
const { versionBytes } = require("./stored.js");

const tool = (name) => TOOLS.find((t) => t.name === name);
const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const EDITOR = { uid: "u-ed", emailLower: "ed@example.com" };
const STRANGER = { uid: "u-x", emailLower: "x@example.com" };
const PEOPLE = [OWNER, EDITOR, STRANGER];
const SESSIONS = Object.fromEntries(PEOPLE.map((p) => [`s-${p.uid}`, { uid: p.uid, email: p.emailLower, email_verified: true }]));
const NOW = Date.now();

const PAGE = "<!doctype html><title>Deck</title><link rel=stylesheet href=style.css><img src=\"img/chart.png\">";
const FILES = {
  "index.html": PAGE,
  "style.css": "body{}",
  "img/chart.png": "png-one",
  "Screen Shot.png": "spaced",
  "clip.mp4": "video",
  "app.js": "1",
  "logo.svg": "<svg/>",
  "font.woff2": "font",
};

/** A stored-layout record listing `files`, and the objects holding them. */
function stored(files, extra = {}) {
  const entries = Object.entries(files).map(([rel, text]) => ({ rel, size: Buffer.byteLength(text), sha256: sha256Hex(Buffer.from(text)) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    record: {
      versionId: "v1", entry: "index.html", format: "html", layout: "blobs", hashVersion: 2, contentHash: "c".repeat(64), attempt: "seed",
      files: entries.map((e) => e.rel), hashes: entries.map((e) => e.sha256), sizes: entries.map((e) => e.size),
      fileCount: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0), ...extra,
    },
    objects: Object.fromEntries(Object.values(files).map((text) => [`docs/d/blobs/${sha256Hex(Buffer.from(text))}`, Buffer.from(text)])),
  };
}

function docRecord(more = {}) {
  return {
    docId: "d", title: "Deck", slug: "d", ownerUid: OWNER.uid, ownerEmail: OWNER.emailLower, currentVersion: "v1",
    visibility: "private", publicEdit: false, viewers: [], suggesters: [], editors: [EDITOR.emailLower], approvers: [],
    members: [OWNER.emailLower, EDITOR.emailLower], suggesterMembers: [OWNER.emailLower, EDITOR.emailLower],
    editorMembers: [OWNER.emailLower, EDITOR.emailLower], approverMembers: [OWNER.emailLower],
    createdAt: Timestamp.fromMillis(NOW), updatedAt: Timestamp.fromMillis(NOW), ...more,
  };
}

/** The document, in Firestore and Storage, and requests to it as a person or an agent. */
function world({ doc = {}, files = FILES, version = null } = {}) {
  const v = version ?? stored(files);
  const { db, store } = fakeFirestore({ "docs/d": docRecord(doc), "docs/d/versions/v1": v.record });
  const objects = new Map(Object.entries(v.objects));
  const storageCalls = [];
  const file = (name) => ({
    name,
    exists: async () => { storageCalls.push(["exists", name]); return [objects.has(name)]; },
    getMetadata: async () => {
      storageCalls.push(["getMetadata", name]);
      if (!objects.has(name)) throw Object.assign(new Error("not found"), { code: 404 });
      return [{ size: String(objects.get(name).length) }];
    },
    download: async () => {
      if (!objects.has(name)) throw Object.assign(new Error("not found"), { code: 404 });
      return [objects.get(name)];
    },
    save: async (data, opts) => {
      if (opts?.preconditionOpts?.ifGenerationMatch === 0 && objects.has(name)) throw Object.assign(new Error("412"), { code: 412 });
      objects.set(name, Buffer.from(data));
    },
    createReadStream: () => { throw new Error("a test of headers streams nothing"); },
  });
  const storage = { bucket: () => ({ file, getFiles: async ({ prefix }) => [[...objects.keys()].filter((k) => k.startsWith(prefix)).map(file)], deleteFiles: async () => {} }) };
  const around = async (fn) => {
    const saved = ["storage", "database"].map((k) => [k, Object.getOwnPropertyDescriptor(admin, k)]);
    const bucketEnv = process.env.BIKESHED_BUCKET;
    process.env.BIKESHED_BUCKET = "test-bucket";
    Object.defineProperty(admin, "storage", { configurable: true, value: () => storage });
    Object.defineProperty(admin, "database", { configurable: true, value: () => { throw new Error("no Realtime Database configured"); } });
    try { return await withFakeAdmin({ db, sessions: SESSIONS }, fn); }
    finally {
      for (const [k, d] of saved) { if (d) Object.defineProperty(admin, k, d); else delete admin[k]; }
      if (bucketEnv === undefined) delete process.env.BIKESHED_BUCKET; else process.env.BIKESHED_BUCKET = bucketEnv;
    }
  };
  const as = (who) => (who ? { cookie: `__session=s-${who.uid}` } : {});
  const head = (who, path, method = "HEAD") => around(() => invoke(contentProxy, { method, path, headers: as(who) }));
  const draft = (who, path) => around(() => invoke(getDraft, { method: "HEAD", path, headers: as(who) }));
  const upload = (who, query, body) => around(() => invoke(createDoc, { method: "POST", path: "/publish", query, rawBody: body, body, headers: as(who) }));
  const ctx = (who) => ({ db, caller: { ...who, channel: "mcp", tokenId: "t1" }, actor: { uid: who.uid, email: who.emailLower, channel: "mcp", tokenId: "t1" } });
  const call = (name, who, args) => around(() => tool(name).run(ctx(who), args));
  const bytesOf = (versionId, rel) => versionBytes(objects, "d", versionId, store.get(`docs/d/versions/${versionId}`), rel)?.toString();
  return { db, store, objects, storageCalls, head, draft, upload, call, bytesOf };
}

function zipOf(files) {
  const zip = new AdmZip();
  for (const [rel, text] of Object.entries(files)) zip.addFile(rel, Buffer.from(text));
  return zip.toBuffer();
}

// --- Names with spaces, and HEAD ----------------------------------------------

test("a file named with a space is served, from the size its version lists", async () => {
  // Folders from a desktop are full of them ("Screen Shot 2026-11-18.png"); a
  // NUL is what a path segment may not hold.
  assert.equal(contentPath(["d", "v1", "Screen Shot.png"]).relPath, "Screen Shot.png");

  const w = world();
  const r = await w.head(OWNER, "/content/d/v1/Screen%20Shot.png");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "image/png");
  assert.equal(r.headers["content-length"], String(Buffer.byteLength("spaced")), "its size comes from the version's list");
  assert.deepEqual(w.storageCalls, [], "and a HEAD of a listed file costs no Storage call");
});

test("a page named with a space opens: its version is usable", async () => {
  const w = world({ version: stored({ "My Report.html": PAGE }, { entry: "My Report.html" }) });
  const meta = await loadVersionMeta(w.db.doc("docs/d"), "v1");
  assert.equal(meta?.entry, "My Report.html");
});

test("a missing file is a no-store 404, even on a public document whose files are cached", async () => {
  // Older layout: the object is asked for, and is not there.
  const legacy = { record: { versionId: "v1", entry: "index.html", format: "html", storagePrefix: "docs/d/bundles/old" }, objects: { "docs/d/bundles/old/index.html": Buffer.from(PAGE) } };
  const w = world({ doc: { visibility: "public" }, version: legacy });
  const missing = await w.head(null, "/content/d/v1/gone.png");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["cache-control"], "private, no-store");
  const there = await w.head(null, "/content/d/v1/index.html");
  assert.equal(there.status, 200);
  assert.match(there.headers["cache-control"], /^public, max-age=/);

  // Stored layout: a path the version does not list is refused before any cache header.
  const s = world({ doc: { visibility: "public" } });
  const unlisted = await s.head(null, "/content/d/v1/gone.png");
  assert.equal(unlisted.status, 404);
  assert.equal(unlisted.headers["cache-control"], "private, no-store");
});

// --- Video and audio -----------------------------------------------------------

test("video answers a 302 to a short-lived link, uncached, after the gate and only then", async () => {
  const asked = [];
  setMediaSigner(async (req) => { asked.push(req); return `https://storage.example.com/${req.objectKey}?sig=1`; });
  try {
    const w = world();
    const r = await w.head(OWNER, "/content/d/v1/clip.mp4", "GET");
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, `https://storage.example.com/docs/d/blobs/${sha256Hex(Buffer.from("video"))}?sig=1`);
    assert.equal(r.headers["cache-control"], "private, no-store", "a cached redirect would outlive its link");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].contentType, "video/mp4", "the link names the type the file is served as");
    assert.equal(asked[0].disposition, "inline");
    assert.ok(asked[0].expires > NOW && asked[0].expires <= Date.now() + 10 * 60 * 1000, "it lives ten minutes");

    // On a public document too: the redirect is never the public cache's.
    const pub = world({ doc: { visibility: "public" } });
    assert.equal((await pub.head(null, "/content/d/v1/clip.mp4", "GET")).headers["cache-control"], "private, no-store");

    // A stranger to a private document is refused before anything is signed.
    asked.length = 0;
    assert.equal((await w.head(STRANGER, "/content/d/v1/clip.mp4", "GET")).status, 404);
    assert.equal(asked.length, 0);

    // The editor's frame plays it the same way.
    assert.equal((await w.draft(OWNER, "/draft/d/clip.mp4")).status, 302);

    // A picture is still streamed by the proxy.
    assert.equal((await w.head(OWNER, "/content/d/v1/img/chart.png")).status, 200);
  } finally {
    setMediaSigner(null);
  }
});

test("where there is no signer, as in the emulator, video streams as before", async () => {
  setMediaSigner(async () => null);
  try {
    const r = await world().head(OWNER, "/content/d/v1/clip.mp4");
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "video/mp4");
  } finally {
    setMediaSigner(null);
  }
  assert.equal(isStreamedMedia("a/b.webm"), true);
  assert.equal(isStreamedMedia("song.mp3"), true);
  assert.equal(isStreamedMedia("chart.png"), false);
});

// --- Caching by type -----------------------------------------------------------

test("a member's browser keeps pictures, stylesheets and fonts an hour, capped at expiry, and nothing else", async () => {
  const w = world();
  for (const rel of ["img/chart.png", "style.css", "font.woff2"]) {
    assert.equal((await w.head(OWNER, `/content/d/v1/${rel}`)).headers["cache-control"], "private, max-age=3600", rel);
  }
  for (const rel of ["index.html", "app.js", "logo.svg"]) {
    assert.equal((await w.head(OWNER, `/content/d/v1/${rel}`)).headers["cache-control"], "private, no-store", rel);
  }
  // The run variant's answer depends on who asked, and is never kept.
  assert.equal((await w.head(OWNER, "/content/!run/d/v1/style.css")).headers["cache-control"], "private, no-store");

  const soon = world({ doc: { expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000) } });
  const age = Number(/max-age=(\d+)/.exec((await soon.head(OWNER, "/content/d/v1/style.css")).headers["cache-control"])[1]);
  assert.ok(age <= 600 && age > 500, `capped at the expiry: ${age}`);
});

// --- An agent's files --------------------------------------------------------------

const HTML_PAGE = { entry: "index.html", format: "html" };
const MD_PAGE = { entry: "index.html", sourceEntry: "index.md", format: "markdown" };

test("an agent's files are refused in words it can act on", () => {
  const refused = (files, page = HTML_PAGE) => decodeAgentFiles(files, page).error;
  assert.match(refused([{ path: "a.exe", content: "x" }]), /\.exe is not a type files takes/);
  assert.match(refused([{ path: "a.png", content: "x" }]), /binary; send it with encoding: "base64"/);
  assert.match(refused([{ path: "a.png", content: "data:image/png;base64,AAAA", encoding: "base64" }]), /without a data: prefix/);
  assert.match(refused([{ path: "a.png", content: "AA AA", encoding: "base64" }]), /not valid base64/);
  assert.match(refused([{ path: "a.css", content: "" }, { path: "a.css", content: "" }]), /twice/);
  assert.match(refused([{ path: "index.html", content: "<p>" }]), /the page itself; send it as content/);
  assert.match(refused([{ path: "index.html", content: "<p>" }], MD_PAGE), /made from the Markdown/);
  assert.match(refused([{ path: "index.md", content: "#" }], MD_PAGE), /the page itself/);
  assert.match(refused([{ path: ".env", content: "KEY=1" }]), /left out of a folder/);
  assert.match(refused([{ path: "../x.css", content: "" }]), /not a usable path/);
  assert.match(refused([{ path: `${"a".repeat(260)}.css`, content: "" }]), /longer than 256 bytes/);
  assert.match(refused([{ path: "big.css", content: "x".repeat(11 * 1024 * 1024) }]), /more than 10 MB/);

  const ok = decodeAgentFiles([
    { path: "style.css", content: "body{color:red}" },
    { path: "img/dot.png", content: Buffer.from("png").toString("base64"), encoding: "base64" },
  ], HTML_PAGE);
  assert.deepEqual(ok.files.map((f) => [f.rel, f.data.toString()]), [["style.css", "body{color:red}"], ["img/dot.png", "png"]]);
});

test("publish_document takes the page and its files as one bundle", async () => {
  const w = world();
  const out = await w.call("publish_document", OWNER, {
    title: "With files", format: "html", content: "<!doctype html><link rel=stylesheet href=style.css><p>hi",
    files: [{ path: "style.css", content: "p{color:red}" }, { path: "img/a.png", content: Buffer.from("A").toString("base64"), encoding: "base64" }],
  });
  const v1 = w.store.get(`docs/${out.docId}/versions/v1`);
  assert.deepEqual(v1.files, ["img/a.png", "index.html", "style.css"]);
  assert.equal(versionBytes(w.objects, out.docId, "v1", v1, "style.css").toString(), "p{color:red}");
});

test("update_document with files alone replaces or adds them and keeps the rest, page included", async () => {
  const w = world();
  const out = await w.call("update_document", OWNER, { id: "d", files: [{ path: "style.css", content: "body{margin:0}" }, { path: "new.json", content: "{}" }] });
  assert.equal(out.versionId, "v2");
  assert.deepEqual(out.changes, { changed: 2, unchanged: Object.keys(FILES).length - 1, removed: 0 });
  assert.equal(w.bytesOf("v2", "style.css"), "body{margin:0}");
  assert.equal(w.bytesOf("v2", "new.json"), "{}");
  assert.equal(w.bytesOf("v2", "index.html"), PAGE, "the page is carried");
  assert.equal(w.bytesOf("v2", "img/chart.png"), "png-one");

  await assert.rejects(w.call("update_document", OWNER, { id: "d" }), /send content, files, or both/);
});

test("changing a document's files is its editors' own; open editing changes its text", async () => {
  const w = world({ doc: { visibility: "public", publicEdit: true } });
  await assert.rejects(
    w.call("update_document", STRANGER, { id: "d", files: [{ path: "style.css", content: "x" }] }),
    /only the document's editors can change its files/,
  );
  const text = await w.call("update_document", STRANGER, { id: "d", content: "<!doctype html><p>fixed a typo" });
  assert.equal(text.versionId, "v2");
});

// --- Loose files --------------------------------------------------------------------

test("a loose file replaces the one file of its name, wherever it is; a shared name is refused", () => {
  const paths = ["index.html", "img/chart.png", "a/logo.png", "b/logo.png"];
  const f = (rel) => ({ rel, data: Buffer.from(rel) });
  assert.deepEqual(resolveLoose(paths, [f("chart.png")], HTML_PAGE).files.map((x) => x.rel), ["img/chart.png"]);
  assert.deepEqual(resolveLoose(paths, [f("img/new.png")], HTML_PAGE).files.map((x) => x.rel), ["img/new.png"], "a path is exact");
  assert.deepEqual(resolveLoose(paths, [f("extra.css")], HTML_PAGE).files.map((x) => x.rel), ["extra.css"], "a new name is added at the top");
  assert.deepEqual(resolveLoose(paths, [f("draft-2.html")], HTML_PAGE).files.map((x) => x.rel), ["index.html"], "a page alone replaces the page");
  assert.deepEqual(resolveLoose(paths, [f("draft-2.html"), f("extra.css")], HTML_PAGE).files.map((x) => x.rel), ["draft-2.html", "extra.css"], "with others it is a page beside it");
  const shared = resolveLoose(paths, [f("logo.png")], HTML_PAGE);
  assert.deepEqual(shared.matches, ["a/logo.png", "b/logo.png"]);
  assert.match(shared.error, /2 files are called logo.png/);
  assert.match(resolveLoose(paths, [f("notes.md")], HTML_PAGE).error, /this document is HTML/);
});

test("a Markdown document's HTML is made, never laid over; its renderer is kept when only a picture changes", () => {
  const base = { entry: "index.html", sourceEntry: "index.md", format: "markdown", rendererVersion: "r-old",
    files: [{ rel: "index.md", data: Buffer.from("# A") }, { rel: "index.html", data: Buffer.from("<h1>A</h1>") }, { rel: "pic.png", data: Buffer.from("1") }] };
  assert.match(compileOverlay(base, [{ rel: "index.html", data: Buffer.from("<p>") }], "A", 1e6).error, /made from the Markdown/);
  const picture = compileOverlay(base, [{ rel: "pic.png", data: Buffer.from("2") }], "A", 1e6);
  assert.equal(picture.rendererVersion, "r-old");
  assert.equal(picture.files.find((f) => f.rel === "index.html").data.toString(), "<h1>A</h1>");
  const page = compileOverlay(base, [{ rel: "index.md", data: Buffer.from("# B") }], "A", 1e6);
  assert.match(page.files.find((f) => f.rel === "index.html").data.toString(), /<h1[^>]*>B<\/h1>/, "the page is rendered again");
});

test("POST /publish?merge=1 lays dropped files over the current version", async () => {
  const w = world();
  const r = await w.upload(OWNER, { update: "d", merge: "1", baseVersion: "v1" }, zipOf({ "chart.png": "png-two" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.changes, { changed: 1, unchanged: Object.keys(FILES).length - 1, removed: 0 });
  assert.equal(w.bytesOf("v2", "img/chart.png"), "png-two");
  assert.equal(w.bytesOf("v2", "index.html"), PAGE);
  assert.deepEqual(r.body.placed, [{ sent: "chart.png", at: "img/chart.png" }], "the answer says where each file went");

  const shared = world({ files: { ...FILES, "a/chart.png": "other" } });
  const refused = await shared.upload(OWNER, { update: "d", merge: "1" }, zipOf({ "chart.png": "png-two" }));
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body.matches, ["a/chart.png", "img/chart.png"]);

  assert.equal((await w.upload(OWNER, { merge: "1" }, zipOf({ "a.png": "x" }))).status, 400, "merge needs a document");
  assert.equal((await w.upload(OWNER, { update: "d", merge: "1" }, Buffer.from("not a zip"))).status, 400);
});

// --- What a folder or a zip leaves out ------------------------------------------------

test("dotfiles, node_modules and other junk are left out of a zip; an unsafe path is refused, not skipped", async () => {
  const out = extractBundle(zipOf({
    "site/index.html": PAGE, "site/.env": "KEY=secret", "site/.git/config": "x", "site/node_modules/x/i.js": "1",
    "site/__MACOSX/._index.html": "x", "site/Thumbs.db": "x", "site/style.css": "body{}",
  }), "site.zip", 1e7);
  assert.deepEqual(out.files.map((f) => f.rel).sort(), ["index.html", "style.css"]);
  // adm-zip rewrites `../` when it writes, so the archive is made by hand.
  const { storedZip } = await import("../../tools/zip.mjs");
  const raw = (name) => storedZip([{ name, data: Buffer.from(PAGE) }]);
  assert.match(extractBundle(raw("../escape.html"), "x.zip", 1e7).error, /unsafe path/);
  assert.match(extractBundle(raw(".git/../../escape.html"), "x.zip", 1e7).error, /unsafe path/, "unsafe is refused before anything is left out");
  assert.match(extractBundle(raw(`${"a".repeat(300)}.html`), "x.zip", 1e7).error, /longer than 256 bytes/);
  assert.deepEqual(extractLoose(zipOf({ "img/a.png": "1", ".DS_Store": "x" }), 1e7).files.map((f) => f.rel), ["img/a.png"]);
});

test("the server leaves out and opens what the shared table says", () => {
  const { isLeftOut, resolveEntry, stripCommonPrefix } = require("../lib/lib/bundle.js");
  const rules = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "fixtures", "bundle-rules.json"), "utf8"));
  for (const rel of rules.leftOut.kept) assert.equal(isLeftOut(rel), false, rel);
  for (const rel of rules.leftOut.out) assert.equal(isLeftOut(rel), true, rel);
  const { isStageable } = require("../lib/lib/staging.js");
  for (const rel of rules.stageable.yes) assert.equal(isStageable(rel), true, rel);
  for (const rel of rules.stageable.no) assert.equal(isStageable(rel), false, rel);
  for (const c of rules.entries) {
    const stripped = stripCommonPrefix(c.files.map((rel) => ({ rel })));
    if (c.stripped) assert.deepEqual(stripped.map((f) => f.rel), c.stripped, c.files.join(","));
    assert.equal(resolveEntry(stripped)?.entry ?? null, c.entry, c.files.join(","));
  }
});
