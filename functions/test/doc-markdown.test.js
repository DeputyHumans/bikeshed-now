// SPDX-License-Identifier: Apache-2.0
// /d/<id>.md: a document as an agent with only its address reads it, behind the gate /content has (SPEC §2, §17, ADR 0030).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.BIKESHED_PUBLIC_ORIGIN = "https://bikeshed.example";
const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { docMarkdown } = require("../lib/index.js");

const OWNER = "owner@example.com";
const KEY = "LinkKey0123456789abcdef";
const base = { ownerUid: "o", ownerEmail: OWNER, currentVersion: "v1", folderId: null, members: [OWNER], editorMembers: [OWNER] };
const PAGE = '<!doctype html><html><head><style>p{}</style></head><body><h1>Plan</h1><p>Ship it.</p><img src="a.png" alt="A"></body></html>';
/** What an author wrote: a mark the HTML cannot carry back, a loose list, a picture beside the page. */
const SOURCE = '# Notes\n\n- **Say.** "We\'re here."\n\n  One was a nonprofit that <mark>[what it did]</mark>.\n\n- Stop.\n\n![chart](chart.png)\n';
const { SOURCE_NOTICE } = require("../lib/lib/markdown/source.js");
const SESSIONS = { o: { uid: "o", email: OWNER, email_verified: true } };

function world() {
  const docs = {
    "docs/priv": { ...base, title: "Private", visibility: "private" },
    "docs/pub": { ...base, title: "Public", visibility: "public" },
    "docs/unl": { ...base, title: "Unlisted", visibility: "unlisted", linkToken: KEY },
    "docs/md": { ...base, title: "Markdown", visibility: "public" },
    "docs/mdu": { ...base, title: "Unlisted notes", visibility: "unlisted", linkToken: KEY },
    "docs/mdold": { ...base, title: "Old Markdown", visibility: "public" },
    "docs/mdgone": { ...base, title: "Gone", visibility: "public" },
  };
  const markdown = { versionId: "v1", entry: "index.html", sourceEntry: "index.md", format: "markdown", files: ["index.md", "index.html"] };
  const versions = Object.fromEntries(
    Object.keys(docs).map((d) => [
      `${d}/versions/v1`,
      d === "docs/md" || d === "docs/mdu" || d === "docs/mdgone"
        ? markdown
        : d === "docs/mdold"
          ? { versionId: "v1", entry: "index.html", format: "markdown", files: ["index.html"] }
          : { versionId: "v1", entry: "index.html", format: "html", files: ["index.html", "a.png"] },
    ]),
  );
  const { db } = fakeFirestore({ ...docs, ...versions });
  return db;
}

async function get(path, { session = null, query = {} } = {}) {
  const db = world();
  const saved = Object.getOwnPropertyDescriptor(admin, "storage");
  const before = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  Object.defineProperty(admin, "storage", {
    configurable: true,
    value: () => ({
      bucket: () => ({
        file: (key) => ({
          download: async () => {
            if (/^docs\/[a-z]+\/v1\/index\.html$/.test(key)) return [Buffer.from(PAGE)];
            if (/^docs\/(md|mdu)\/v1\/index\.md$/.test(key)) return [Buffer.from(SOURCE)];
            throw Object.assign(new Error(`no ${key}`), { code: 404 });
          },
        }),
      }),
    }),
  });
  try {
    return await withFakeAdmin({ db, sessions: SESSIONS }, () =>
      invoke(docMarkdown, { method: "GET", path, query, headers: session ? { cookie: `__session=${session}` } : {} }),
    );
  } finally {
    if (saved) Object.defineProperty(admin, "storage", saved);
    else delete admin.storage;
    if (before === undefined) delete process.env.BIKESHED_BUCKET;
    else process.env.BIKESHED_BUCKET = before;
  }
}

test("a private document's reading is the same 404 as a document that does not exist", async () => {
  const stranger = await get("/d/priv.md");
  const absent = await get("/d/absent.md");
  assert.equal(stranger.status, 404);
  assert.deepEqual(stranger, absent, "refused and absent answer byte for byte alike");
  assert.equal(stranger.headers["cache-control"], "private, no-store", "a refusal must not inherit Hosting's max-age");
});

test("a member reads a private document's reading, and no cache keeps it", async () => {
  const r = await get("/d/priv.md", { session: "o" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/markdown; charset=utf-8");
  assert.equal(r.headers["cache-control"], "private, no-store");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.match(r.body, /^---\nreading: "A Markdown reading of this document/);
  assert.match(r.body, /document: "https:\/\/bikeshed\.example\/d\/priv"/);
  assert.match(r.body, /original: "https:\/\/bikeshed\.example\/content\/priv\/v1\/index\.html"/);
  assert.match(r.body, /\n# Plan\n\nShip it\.\n\n!\[A\]\(https:\/\/bikeshed\.example\/content\/priv\/v1\/a\.png\)\n$/);
  assert.equal(
    r.headers.link,
    '<https://bikeshed.example/d/priv>; rel="canonical", <https://bikeshed.example/content/priv/v1/index.html>; rel="alternate"; type="text/html"',
  );
});

test("a public document's reading is cached as its content is", async () => {
  const r = await get("/d/pub.md");
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "public, max-age=300");
  assert.equal(r.headers["x-robots-tag"], undefined);
});

test("an unlisted document's reading needs its key, and carries it on its own addresses", async () => {
  assert.equal((await get("/d/unl.md")).status, 404);
  assert.equal((await get("/d/unl.md", { query: { k: "wrong" } })).status, 404);
  const r = await get("/d/unl.md", { query: { k: KEY } });
  assert.equal(r.status, 200);
  assert.equal(r.headers["x-robots-tag"], "noindex");
  assert.match(r.body, new RegExp(`document: "https://bikeshed\\.example/d/unl\\?k=${KEY}"`));
  assert.match(r.body, new RegExp(`original: "https://bikeshed\\.example/content/~${KEY}/unl/v1/index\\.html"`));
  assert.match(r.body, new RegExp(`\\(https://bikeshed\\.example/content/~${KEY}/unl/v1/a\\.png\\)`));
});

test("a pinned version reads at its own address; a version that is not there is a 404", async () => {
  const r = await get("/d/pub/v1.md");
  assert.equal(r.status, 200);
  assert.match(r.body, /document: "https:\/\/bikeshed\.example\/d\/pub\/v1"/);
  assert.equal((await get("/d/pub/v9.md")).status, 404);
});

test("only a .md address of one or two segments is a reading", async () => {
  for (const path of ["/d/pub", "/d/.md", "/d/pub/v1/extra.md", "/d/pub.html", "/content/pub/v1/index.md"]) {
    const r = await get(path);
    assert.equal(r.status, 404, path);
    assert.equal(r.headers["cache-control"], "private, no-store", path);
  }
});

/** The text after the front matter and the blank line that ends it. */
function afterFrontMatter(body) {
  const end = body.indexOf("\n---\n");
  assert.notEqual(end, -1, "the text opens with front matter");
  assert.equal(body.slice(end + 5, end + 6), "\n", "a blank line ends the front matter");
  return body.slice(end + 6);
}

test("a Markdown document answers its own Markdown, byte for byte, under front matter that says so", async () => {
  /**
   * The Markdown IS the source, so the address answers it rather than a
   * reading made back from its HTML, which lost the <mark> and said "it is
   * not the source" of the source (ADR 0042).
   */
  const r = await get("/d/md.md");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/markdown; charset=utf-8");
  assert.equal(r.headers["cache-control"], "public, max-age=300", "cached as its content is");
  assert.equal(r.headers["bikeshed-cut"], undefined, "a source is never cut");
  assert.equal(
    r.body.slice(0, r.body.indexOf("\n---\n") + 5),
    [
      "---",
      `source: ${JSON.stringify(SOURCE_NOTICE)}`,
      'title: "Markdown"',
      'document: "https://bikeshed.example/d/md"',
      'version: "v1"',
      'original: "https://bikeshed.example/content/md/v1/index.md"',
      "---",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(r.body, /^reading:/m, "it is not a reading");
  assert.equal(afterFrontMatter(r.body), SOURCE, "the author's Markdown exactly, <mark> and relative picture included");
  assert.equal(
    r.headers.link,
    '<https://bikeshed.example/d/md>; rel="canonical", <https://bikeshed.example/content/md/v1/index.md>; rel="alternate"; type="text/markdown"',
  );
});

test("an unlisted Markdown document's own addresses carry the key that opened it, and a pinned version its version", async () => {
  assert.equal((await get("/d/mdu.md")).status, 404);
  const r = await get("/d/mdu.md", { query: { k: KEY } });
  assert.equal(r.status, 200);
  assert.equal(r.headers["x-robots-tag"], "noindex");
  assert.match(r.body, new RegExp(`\ndocument: "https://bikeshed\\.example/d/mdu\\?k=${KEY}"\n`));
  assert.match(r.body, new RegExp(`\noriginal: "https://bikeshed\\.example/content/~${KEY}/mdu/v1/index\\.md"\n`));
  assert.equal(afterFrontMatter(r.body), SOURCE);

  const pinned = await get("/d/md/v1.md");
  assert.equal(pinned.status, 200);
  assert.match(pinned.body, /\ndocument: "https:\/\/bikeshed\.example\/d\/md\/v1"\n/);
  assert.equal(afterFrontMatter(pinned.body), SOURCE);
});

test("a Markdown version that names no source still answers a reading of its HTML", async () => {
  const r = await get("/d/mdold.md");
  assert.equal(r.status, 200);
  assert.match(r.body, /^---\nreading: "A Markdown reading of this document/);
  assert.match(r.body, /original: "https:\/\/bikeshed\.example\/content\/mdold\/v1\/index\.html"/);
});

test("a Markdown document whose source cannot be read is a 500 with none of the headers a source carries", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = await get("/d/mdgone.md");
    assert.equal(r.status, 500);
    assert.equal(r.headers["cache-control"], "private, no-store");
    assert.equal(r.headers.link, undefined);
    assert.equal(r.headers["content-type"], undefined);
  } finally {
    console.warn = warn;
  }
});

test("a failure after the gate drops every header the reading would have carried", async () => {
  // A version whose bytes are gone: the gate passed, the read did not.
  const db = fakeFirestore({
    "docs/pub": { ...base, title: "Public", visibility: "public", currentVersion: "v2" },
    "docs/pub/versions/v2": { versionId: "v2", entry: "index.html", format: "html", files: ["index.html"] },
  }).db;
  const saved = Object.getOwnPropertyDescriptor(admin, "storage");
  Object.defineProperty(admin, "storage", {
    configurable: true,
    value: () => ({ bucket: () => ({ file: () => ({ download: async () => { throw Object.assign(new Error("gone"), { code: 404 }); } }) }) }),
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = await withFakeAdmin({ db, sessions: SESSIONS }, () => invoke(docMarkdown, { method: "GET", path: "/d/pub.md" }));
    assert.equal(r.status, 500);
    assert.equal(r.headers["cache-control"], "private, no-store");
    assert.equal(r.headers.link, undefined);
  } finally {
    console.warn = warn;
    if (saved) Object.defineProperty(admin, "storage", saved);
    else delete admin.storage;
  }
});
