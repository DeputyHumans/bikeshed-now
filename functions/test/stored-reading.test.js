// SPDX-License-Identifier: Apache-2.0
// A version's reading is made once for its bytes and kept, and a kept one is never served for other bytes (SPEC §19, ADR 0033).

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const admin = require("firebase-admin");

process.env.BIKESHED_PUBLIC_ORIGIN = "https://bikeshed.example";
const { RULES, parseKept, readingObject, readingsPrefix, storedReading } = require("../lib/lib/markdown/stored.js");
const { readingMarkdown } = require("../lib/lib/markdown/reading.js");
const { TOOLS } = require("../lib/mcp/tools.js");
const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { docMarkdown } = require("../lib/index.js");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PLACE = { origin: "https://bikeshed.example", docId: "plan", versionId: "v1", entry: "index.html", k: null };
const PAGE_A = "<!doctype html><html><body><h1>Plan</h1><p>Ship in two weekends.</p></body></html>";
const PAGE_B = "<!doctype html><html><body><h1>Plan</h1><p>Ship in one weekend instead.</p></body></html>";

/** A bucket that keeps what is written, refuses to overwrite, and counts every call. */
function fakeStore(objects = {}) {
  const calls = { downloads: [], saves: [] };
  const store = {
    objects,
    calls,
    file: (name) => ({
      download: async () => {
        calls.downloads.push(name);
        if (!(name in objects)) throw Object.assign(new Error("No such object"), { code: 404 });
        return [Buffer.from(objects[name])];
      },
      save: async (data, options) => {
        calls.saves.push({ name, options });
        if (options?.preconditionOpts?.ifGenerationMatch === 0 && name in objects) {
          throw Object.assign(new Error("Precondition failed"), { code: 412 });
        }
        objects[name] = String(data);
      },
    }),
  };
  return store;
}

const reads = (store) => store.calls.downloads.filter((n) => !n.includes("/readings/"));

async function read(store, { version = { contentHash: HASH_A }, html = PAGE_A, place = PLACE, prefix = "docs/plan/v1" } = {}) {
  let sourceReads = 0;
  const reading = await storedReading({
    store,
    place,
    version,
    storagePrefix: prefix,
    source: async () => {
      sourceReads++;
      return html;
    },
  });
  return { reading, sourceReads };
}

// --- The store ------------------------------------------------------------------

test("the rules a reading is made by can be named, so a reading can be kept", () => {
  assert.match(String(RULES), /^[0-9a-f]{64}$/);
});

test("a second read of one version's bytes converts nothing and reads the same", async () => {
  const store = fakeStore();
  const first = await read(store);
  assert.equal(first.sourceReads, 1);
  assert.equal(store.calls.saves.length, 1, "the first read keeps what it made");
  const kept = store.calls.saves[0];
  assert.ok(kept.name.startsWith(readingsPrefix("plan", "v1")), "kept beside the version, outside its own prefix");
  assert.deepEqual(kept.options, { contentType: "application/json", resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
  const second = await read(store);
  assert.equal(second.sourceReads, 0, "the source is not read again");
  assert.deepEqual(second.reading, first.reading);
  assert.deepEqual(first.reading, readingMarkdown(PAGE_A, PLACE), "what is kept is what would be made");
});

test("a version name minted again for other bytes never gets the old one's reading", async () => {
  // delete-version withdraws the head v1, and the next publish mints v1 again
  // (`v${maxN + 1}`) with different bytes.
  const store = fakeStore();
  await read(store, { version: { contentHash: HASH_A }, html: PAGE_A });
  const after = await read(store, { version: { contentHash: HASH_B }, html: PAGE_B });
  assert.equal(after.sourceReads, 1, "the new bytes are read");
  assert.match(after.reading.body, /one weekend instead/);
  assert.doesNotMatch(after.reading.body, /two weekends/);
});

test("every input that decides the body names a different object", () => {
  const name = readingObject(PLACE, { contentHash: HASH_A }, "docs/plan/v1");
  const variants = [
    readingObject(PLACE, { contentHash: HASH_B }, "docs/plan/v1"),
    readingObject(PLACE, { contentHash: HASH_A }, "docs/plan/v1-attempt-2"),
    readingObject({ ...PLACE, entry: "guide/index.html" }, { contentHash: HASH_A }, "docs/plan/v1"),
    readingObject({ ...PLACE, origin: "https://other.example" }, { contentHash: HASH_A }, "docs/plan/v1"),
    readingObject({ ...PLACE, k: "LinkKey0123456789abcdef" }, { contentHash: HASH_A }, "docs/plan/v1"),
  ];
  for (const v of variants) assert.notEqual(v, name);
  assert.equal(new Set(variants).size, variants.length);
});

test("a kept reading is named by the rules that made it and by the version's bytes", () => {
  // Pinned exactly, so the test after this one means something: a name that
  // left the rules out would still miss an object kept under other rules.
  const want = createHash("sha256")
    .update(JSON.stringify([RULES, HASH_A, "docs/plan/v1", PLACE.entry, PLACE.origin, ""]))
    .digest("hex");
  assert.equal(readingObject(PLACE, { contentHash: HASH_A }, "docs/plan/v1"), `docs/plan/readings/v1/${want}.json`);
});

test("a reading kept by other rules is never served", async () => {
  // What an older build of the reading would have kept under its own rules.
  const stale = createHash("sha256")
    .update(JSON.stringify(["other-rules", HASH_A, "docs/plan/v1", PLACE.entry, PLACE.origin, ""]))
    .digest("hex");
  const poison = JSON.stringify({ body: "STALE\n", leftOut: readingMarkdown("", PLACE).leftOut, warnings: [], cut: false });
  const store = fakeStore({ [`${readingsPrefix("plan", "v1")}${stale}.json`]: poison });
  const { reading, sourceReads } = await read(store);
  assert.equal(sourceReads, 1);
  assert.doesNotMatch(reading.body, /STALE/);
});

test("a version recorded without its content hash is converted every time, and nothing is kept", async () => {
  for (const version of [{}, { contentHash: "" }, { contentHash: "not-a-hash" }]) {
    const store = fakeStore();
    await read(store, { version });
    const again = await read(store, { version });
    assert.equal(again.sourceReads, 1);
    assert.deepEqual(store.calls.saves, []);
    assert.deepEqual(store.calls.downloads, [], "nothing is looked up either");
  }
});

test("a keyed reading and a member's are kept apart, and only the keyed one carries the key", async () => {
  const store = fakeStore();
  const KEY = "LinkKey0123456789abcdef";
  const html = '<!doctype html><html><body><p>See <img src="a.png" alt="A"></p></body></html>';
  const keyed = await read(store, { html, place: { ...PLACE, k: KEY } });
  const member = await read(store, { html });
  assert.equal(member.sourceReads, 1, "a member's read does not take the keyed one");
  assert.match(keyed.reading.body, new RegExp(`/content/~${KEY}/plan/v1/a\\.png`));
  assert.ok(!member.reading.body.includes(KEY));
  assert.equal(store.calls.saves.length, 2);
});

test("a malformed kept reading is made again", async () => {
  const name = readingObject(PLACE, { contentHash: HASH_A }, "docs/plan/v1");
  for (const bad of ["not json", "null", '{"body":1}', '{"body":"x","cut":false,"warnings":[],"leftOut":{"scripts":-1}}']) {
    const store = fakeStore({ [name]: bad });
    const { reading, sourceReads } = await read(store);
    assert.equal(sourceReads, 1, bad);
    assert.match(reading.body, /Ship in two weekends/, bad);
  }
  assert.equal(parseKept(JSON.stringify(readingMarkdown(PAGE_A, PLACE))) !== null, true);
});

test("a write that fails or loses the race still answers with the reading", async () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const failing = fakeStore();
    failing.file = ((file) => (name) => ({ ...file(name), save: async () => { throw Object.assign(new Error("boom"), { code: 503 }); } }))(failing.file);
    assert.match((await read(failing)).reading.body, /Ship in two weekends/);
    const raced = fakeStore();
    const name = readingObject(PLACE, { contentHash: HASH_A }, "docs/plan/v1");
    raced.file = ((file) => (n) => ({
      ...file(n),
      // Another reader's identical write lands between this one's miss and its write.
      download: async () => { throw Object.assign(new Error("No such object"), { code: 404 }); },
      save: async (data, options) => { raced.objects[name] = data; return file(n).save(data, options); },
    }))(raced.file);
    assert.match((await read(raced)).reading.body, /Ship in two weekends/);
  } finally {
    console.warn = quiet;
  }
});

// --- get_document, through the real tool -------------------------------------------

async function withBucket(store, fn) {
  const saved = Object.getOwnPropertyDescriptor(admin, "storage");
  const before = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => store }) });
  try {
    return await fn();
  } finally {
    if (saved) Object.defineProperty(admin, "storage", saved);
    else delete admin.storage;
    if (before === undefined) delete process.env.BIKESHED_BUCKET;
    else process.env.BIKESHED_BUCKET = before;
  }
}

test("get_document reads a long reading's later pages without converting the page again", async () => {
  const long = `<!doctype html><html><body>${"<p>A sentence that is long enough to fill pages. </p>".repeat(9000)}</body></html>`;
  const store = fakeStore({ "docs/plan/v1/index.html": long });
  const tool = TOOLS.find((t) => t.name === "get_document");
  const caller = { uid: "u1", emailLower: "owner@example.com" };
  const data = { ownerUid: "u1", members: [caller.emailLower], currentVersion: "v1", title: "Plan" };
  const version = { exists: true, data: () => ({ entry: "index.html", format: "html", files: ["index.html"], contentHash: HASH_A }) };
  const none = { orderBy: () => none, limit: () => none, where: () => none, get: async () => ({ docs: [], empty: true }) };
  const ref = {
    id: "plan",
    get: async () => ({ exists: true, data: () => data }),
    collection: (name) => ({ ...none, doc: () => (name === "versions" ? { get: async () => version } : { get: async () => ({ exists: false }), set: async () => {} }) }),
  };
  const db = { collection: () => ({ doc: () => ref }) };
  await withBucket(store, async () => {
    let page = await tool.run({ db, caller, actor: { tokenId: "t1" } }, { id: "plan" });
    const pages = [page.markdown];
    while (page.truncated) {
      page = await tool.run({ db, caller, actor: { tokenId: "t1" } }, { id: "plan", version: "v1", offset: page.nextOffset });
      pages.push(page.markdown);
    }
    assert.ok(pages.length >= 3, `a reading long enough to page (${pages.length} pages)`);
    assert.equal(reads(store).length, 1, "the source was read once, for the first page");
    assert.equal(store.calls.saves.length, 1);
    assert.match(pages.join(""), /^---\nreading: /);
  });
});

// --- /d/<id>.md, through the real endpoint -------------------------------------------

const OWNER = "owner@example.com";
const SESSIONS = { o: { uid: "o", email: OWNER, email_verified: true } };

function world(currentVersion) {
  const base = { ownerUid: "o", ownerEmail: OWNER, currentVersion, folderId: null, members: [OWNER], editorMembers: [OWNER] };
  return fakeFirestore({
    "docs/plan": { ...base, title: "Plan", visibility: "private" },
    "docs/plan/versions/v1": { versionId: "v1", entry: "index.html", format: "html", files: ["index.html"], contentHash: HASH_A },
    "docs/plan/versions/v2": { versionId: "v2", entry: "index.html", format: "html", files: ["index.html"], contentHash: HASH_B },
  }).db;
}

async function getMd(store, path, { currentVersion = "v1", session = "o" } = {}) {
  return withBucket(store, () =>
    withFakeAdmin({ db: world(currentVersion), sessions: SESSIONS }, () =>
      invoke(docMarkdown, { method: "GET", path, query: {}, headers: session ? { cookie: `__session=${session}` } : {} }),
    ),
  );
}

test("a new publish is read at once, and a pinned version keeps its own reading", async () => {
  const store = fakeStore({ "docs/plan/v1/index.html": PAGE_A, "docs/plan/v2/index.html": PAGE_B });
  const v1 = await getMd(store, "/d/plan.md");
  assert.match(v1.body, /two weekends/);
  const v2 = await getMd(store, "/d/plan.md", { currentVersion: "v2" });
  assert.equal(v2.status, 200);
  assert.match(v2.body, /one weekend instead/, "the current version is the one the record names now");
  assert.match(v2.body, /version: "v2"/);
  const pinned = await getMd(store, "/d/plan/v1.md", { currentVersion: "v2" });
  assert.match(pinned.body, /two weekends/);
  assert.doesNotMatch(pinned.body, /one weekend instead/);
  const before = reads(store).length;
  await getMd(store, "/d/plan.md", { currentVersion: "v2" });
  assert.equal(reads(store).length, before, "a repeat read converts nothing");
});

test("a refused read never reaches a kept reading", async () => {
  const store = fakeStore({ "docs/plan/v1/index.html": PAGE_A });
  await getMd(store, "/d/plan.md");
  store.calls.downloads.length = 0;
  const refused = await getMd(store, "/d/plan.md", { session: null });
  assert.equal(refused.status, 404);
  assert.equal(refused.headers["cache-control"], "private, no-store");
  assert.deepEqual(store.calls.downloads, [], "no object was read for a caller who may not read");
});
