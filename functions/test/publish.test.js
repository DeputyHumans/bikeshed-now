// SPDX-License-Identifier: Apache-2.0
// compileBundle's title default, what an update holds, and where a new document's bytes are placed (SPEC §4, §11, §17, §19).

const test = require("node:test");
const assert = require("node:assert/strict");

const { compileBundle, compileRevision, placeNewDocument } = require("../lib/lib/publish.js");
const { HEAD_SCAN_BYTES } = require("../lib/lib/head.js");
const { hashBundleFiles } = require("../lib/lib/hash.js");

/** An extracted HTML bundle whose single file is the entry. */
function htmlBundle(entryHtml, entryRel = "index.html") {
  return {
    files: [{ rel: entryRel, data: Buffer.from(entryHtml, "utf8") }],
    entry: entryRel,
    format: "html",
  };
}

/** An extracted Markdown bundle whose single file is the entry. */
function markdownBundle(source, entryRel = "index.md") {
  return {
    files: [{ rel: entryRel, data: Buffer.from(source, "utf8") }],
    entry: entryRel,
    format: "markdown",
  };
}

test("an HTML upload's own <title> becomes the document title", () => {
  const html =
    "<!DOCTYPE html><html><head><title>From The File</title></head><body><p>hi</p></body></html>";
  const compiled = compileBundle(htmlBundle(html), "from-filename");
  assert.equal(compiled.title, "From The File");
});

test("an HTML upload with no <title> falls back to the caller's title", () => {
  const html = "<!DOCTYPE html><html><head></head><body><p>hi</p></body></html>";
  const compiled = compileBundle(htmlBundle(html), "from-filename");
  assert.equal(compiled.title, "from-filename");
});

test("a Markdown upload's H1 still wins over the fallback", () => {
  const compiled = compileBundle(markdownBundle("# Heading\n\nBody."), "from-filename");
  assert.equal(compiled.title, "Heading");
});

test("a Markdown upload with no H1 still falls back", () => {
  const compiled = compileBundle(markdownBundle("just body text, no heading"), "from-filename");
  assert.equal(compiled.title, "from-filename");
});

test("compileBundle reads the same first 256 KiB of the entry that the document page does", () => {
  // The handler streams HEAD_SCAN_BYTES bytes; here the whole entry is in
  // memory, and only that prefix is decoded. The distinction shows in
  // multi-byte text: 140,000 two-byte characters are under the scanner's
  // character cap but over its byte cap, so a <title> after them is the
  // page's title only if bytes past the cap were decoded.
  const padding = `<!-- ${"é".repeat(140_000)} -->`;
  assert.ok(Buffer.byteLength(padding, "utf8") > HEAD_SCAN_BYTES, "padding must exceed the byte cap");
  assert.ok(padding.length < HEAD_SCAN_BYTES, "padding must stay under the character cap");
  const html = `<!DOCTYPE html><html><head>${padding}<title>Too Late</title></head><body></body></html>`;
  const compiled = compileBundle(htmlBundle(html), "from-filename");
  assert.equal(compiled.title, "from-filename");
});

// --- What an update holds ----------------------------------------------------

const MAX = 25 * 1024 * 1024;
const file = (rel, text) => ({ rel, data: Buffer.from(text, "utf8") });
const text = (files, rel) => files.find((f) => f.rel === rel)?.data.toString("utf8");
const rels = (files) => files.map((f) => f.rel).sort();

/** A published HTML bundle: an entry and the files it refers to. */
const htmlBase = {
  entry: "index.html",
  format: "html",
  files: [file("index.html", "<h1>v1</h1>"), file("style.css", "h1{}"), file("img/dot.svg", "<svg/>")],
};

test("an update that sends one file keeps every file beside the entry", () => {
  // The in-app commit has always laid the edited entry over the base version's
  // files. An update sent through a token dropped them, so a deck's images
  // vanished on its first revision.
  const revised = compileRevision(htmlBase, htmlBundle("<h1>v2</h1>"), "T", MAX);
  assert.deepEqual(rels(revised.files), ["img/dot.svg", "index.html", "style.css"]);
  assert.equal(text(revised.files, "index.html"), "<h1>v2</h1>");
  assert.equal(text(revised.files, "style.css"), "h1{}");
  assert.equal(revised.entry, "index.html");
});

test("a single-file update lands on the version's own entry, wherever the bundle put it", () => {
  const base = {
    entry: "site/page.html",
    format: "html",
    files: [file("site/page.html", "<p>old</p>"), file("site/a.png", "png")],
  };
  const revised = compileRevision(base, htmlBundle("<p>new</p>"), "T", MAX);
  assert.deepEqual(rels(revised.files), ["site/a.png", "site/page.html"]);
  assert.equal(text(revised.files, "site/page.html"), "<p>new</p>");
  assert.equal(revised.entry, "site/page.html");
});

test("a Markdown update replaces its source and its rendering, and keeps the rest", () => {
  const base = {
    entry: "notes/readme.html",
    sourceEntry: "notes/readme.md",
    format: "markdown",
    files: [
      file("notes/readme.md", "# Old\n"),
      file("notes/readme.html", "<h1>Old</h1>"),
      file("notes/fig.png", "png"),
    ],
  };
  const revised = compileRevision(base, markdownBundle("# New\n"), "T", MAX);
  assert.deepEqual(rels(revised.files), ["notes/fig.png", "notes/readme.html", "notes/readme.md"]);
  assert.equal(text(revised.files, "notes/readme.md"), "# New\n");
  assert.match(text(revised.files, "notes/readme.html"), /<h1>New<\/h1>/);
  assert.equal(revised.entry, "notes/readme.html");
  assert.equal(revised.sourceEntry, "notes/readme.md");
  assert.equal(revised.format, "markdown");
});

test("a .zip update is the whole new bundle, so a file it leaves out is gone", () => {
  const zip = { ...htmlBundle("<h1>v2</h1>"), archive: true };
  const revised = compileRevision(htmlBase, zip, "T", MAX);
  assert.deepEqual(rels(revised.files), ["index.html"]);
});

test("an update in the other format is refused rather than converted", () => {
  const refused = compileRevision(htmlBase, markdownBundle("# New\n"), "T", MAX);
  assert.ok("error" in refused, "a Markdown update to an HTML document went through");
  assert.match(refused.error, /HTML/);
  assert.match(refused.error, /Markdown/);
});

test("files carried from the base count toward the size cap", () => {
  const baseBytes = htmlBase.files.reduce((n, f) => n + f.data.length, 0);
  const refused = compileRevision(htmlBase, htmlBundle("<h1>v1</h1>"), "T", baseBytes - 1);
  assert.ok("error" in refused, "a bundle over the cap was accepted");
  assert.match(refused.error, /too large/);
});

test("sending a version's own entry back hashes the same, so the update is a no-op", () => {
  const revised = compileRevision(htmlBase, htmlBundle("<h1>v1</h1>"), "T", MAX);
  assert.equal(hashBundleFiles(revised.files).contentHash, hashBundleFiles(htmlBase.files).contentHash);
});

// --- Placing a new document's bytes -----------------------------------------

/** Firestore reduced to "does docs/{id} exist". Nothing here holds a record. */
const noRecords = {
  collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }),
};

/** What Storage throws when a CREATE_ONLY write finds the object already there. */
const preconditionFailed = () => Object.assign(new Error("412 Precondition Failed"), { code: 412 });

test("a new document's bytes go under the wanted id's v1", async () => {
  const puts = [];
  const placed = await placeNewDocument(noRecords, "01-platform", async (prefix) => {
    puts.push(prefix);
  });
  assert.deepEqual(puts, ["docs/01-platform/v1"]);
  assert.deepEqual(placed, { docId: "01-platform", storagePrefix: "docs/01-platform/v1" });
});

test("a refused write moves the document to a suffixed id instead of failing", async () => {
  /**
   * Storage refuses when bytes already sit at the id although no record holds
   * it: a create racing this one, or what a failed create left. Either way the
   * id is taken, and the publisher still gets a document.
   */
  const puts = [];
  const placed = await placeNewDocument(noRecords, "01-platform", async (prefix) => {
    puts.push(prefix);
    if (puts.length === 1) throw preconditionFailed();
  });
  assert.equal(puts.length, 2);
  assert.equal(puts[0], "docs/01-platform/v1");
  assert.match(placed.docId, /^01-platform-[a-z0-9]{6}$/);
  assert.equal(placed.storagePrefix, `docs/${placed.docId}/v1`);
  assert.equal(puts[1], placed.storagePrefix);
});

test("any other storage failure is not mistaken for a taken id", async () => {
  let calls = 0;
  await assert.rejects(
    placeNewDocument(noRecords, "01-platform", async () => {
      calls++;
      throw Object.assign(new Error("quota"), { code: 429 });
    }),
    /quota/,
  );
  assert.equal(calls, 1);
});

test("a second refusal fails the publish rather than retrying forever", async () => {
  let calls = 0;
  await assert.rejects(
    placeNewDocument(noRecords, "01-platform", async () => {
      calls++;
      throw preconditionFailed();
    }),
    /412/,
  );
  assert.equal(calls, 2);
});
