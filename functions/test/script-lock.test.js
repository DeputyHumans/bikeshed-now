// SPDX-License-Identifier: Apache-2.0
// A document's own script runs only with its reader's consent or a superadmin's, however it is opened (SPEC §2, §6c; ADR 0021).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { Timestamp } = require("firebase-admin/firestore");

const { fakeFirestore, fakeToken, withFakeAdmin, invoke } = require("./fakes.js");
const {
  RUN_ANCESTORS,
  SCRIPT_LOCK,
  canTrustForEveryone,
  contentSecurityPolicy,
  globallyTrusted,
  isScriptable,
  isServiceWorkerFetch,
} = require("../lib/lib/scriptlock.js");
const { superadmins } = require("../lib/config.js");
const { contentProxy, getDraft, trustDoc } = require("../lib/index.js");

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const READER = { uid: "u-reader", emailLower: "reader@example.com" };
const STRANGER = { uid: "u-stranger", emailLower: "stranger@example.com" };
const NOW = Date.now();

// --- The decision, pure ------------------------------------------------------

test("every scriptable type is locked unless the run variant was asked for and granted", () => {
  for (const type of ["text/html", "text/html; charset=utf-8", "application/xhtml+xml", "image/svg+xml", "application/xml", "TEXT/XML"]) {
    assert.equal(isScriptable(type), true, type);
    assert.equal(contentSecurityPolicy({ contentType: type, run: false, unlocked: false }), SCRIPT_LOCK, type);
    // Granted without being asked is not a way in: the plain URL is always locked.
    assert.equal(contentSecurityPolicy({ contentType: type, run: false, unlocked: true }), SCRIPT_LOCK, type);
    assert.equal(contentSecurityPolicy({ contentType: type, run: true, unlocked: false }), `${SCRIPT_LOCK}; ${RUN_ANCESTORS}`, type);
    assert.equal(contentSecurityPolicy({ contentType: type, run: true, unlocked: true }), RUN_ANCESTORS, type);
  }
  for (const type of ["image/png", "text/css", "application/javascript", "application/pdf", "application/octet-stream"]) {
    assert.equal(isScriptable(type), false, type);
    assert.equal(contentSecurityPolicy({ contentType: type, run: false, unlocked: false }), null, type);
    assert.equal(contentSecurityPolicy({ contentType: type, run: true, unlocked: false }), RUN_ANCESTORS, type);
  }
  // The lock is the frame's own sandbox, so inside the app it changes nothing.
  assert.equal(SCRIPT_LOCK, "sandbox allow-same-origin");
});

test("every type a file can be served as that a browser renders as HTML or XML is locked", () => {
  // The server types a file by its extension through mime-types, so its table
  // is exactly what can reach a browser. Which of these a browser renders as
  // an XML document, where an element in the XHTML namespace runs, is its own
  // choice: a list of five scriptable types once left .atom and .rss running
  // on this origin in WebKit (Safari, every browser on iOS), and a hundred
  // more +xml types one browser change from it.
  const { types } = require("mime-types");
  const documentLike = Object.entries(types).filter(([, type]) => /html|xml/.test(type));
  assert.ok(documentLike.length > 100, "the table is the whole table");
  for (const [ext, type] of documentLike) {
    assert.equal(isScriptable(type), true, `.${ext} is served as ${type}`);
  }
  // A type nobody listed is locked, not trusted.
  for (const type of ["application/x-unheard-of", "text/x-something", "", "multipart/x-mixed-replace"]) {
    assert.equal(isScriptable(type), true, JSON.stringify(type));
  }
  // What is shown as text, played or drawn stays as it was.
  for (const type of ["image/jpeg", "image/webp", "audio/mpeg", "video/mp4", "font/woff2", "application/manifest+json", "text/javascript"]) {
    assert.equal(isScriptable(type), false, type);
  }
});

test("only trusted: true is trust for everyone", () => {
  assert.equal(globallyTrusted({ trusted: true }), true);
  for (const doc of [{}, { trusted: false }, { trusted: "true" }, { trusted: 1 }, null, undefined]) {
    assert.equal(globallyTrusted(doc), false, JSON.stringify(doc));
  }
});

test("trusting for everyone takes a superadmin who owns the document", () => {
  const doc = { ownerEmail: "Owner@Example.com" };
  const admins = new Set([OWNER.emailLower]);
  assert.equal(canTrustForEveryone(doc, OWNER.emailLower, admins), true);
  assert.equal(canTrustForEveryone(doc, OWNER.emailLower, new Set()), false, "an owner alone may not");
  assert.equal(canTrustForEveryone(doc, READER.emailLower, new Set([READER.emailLower])), false, "a superadmin who does not own it may not");
  assert.equal(canTrustForEveryone(null, OWNER.emailLower, admins), false);
});

test("the superadmins come from deployment configuration, and none when unset", () => {
  const before = process.env.BIKESHED_SUPERADMINS;
  try {
    delete process.env.BIKESHED_SUPERADMINS;
    assert.equal(superadmins().size, 0);
    process.env.BIKESHED_SUPERADMINS = " A@Example.com, b@example.com  c@example.com,,";
    assert.deepEqual([...superadmins()].sort(), ["a@example.com", "b@example.com", "c@example.com"]);
  } finally {
    if (before === undefined) delete process.env.BIKESHED_SUPERADMINS;
    else process.env.BIKESHED_SUPERADMINS = before;
  }
});

test("a service worker's script fetch is recognised by its header", () => {
  assert.equal(isServiceWorkerFetch("script"), true);
  assert.equal(isServiceWorkerFetch(" Script "), true);
  assert.equal(isServiceWorkerFetch(undefined), false);
  assert.equal(isServiceWorkerFetch(""), false);
});

// --- Through the endpoints ---------------------------------------------------

const grants = { viewers: [], suggesters: [], editors: [], approvers: [] };

/** A public scripted page, and the same page trusted for everyone. */
function world(extra = {}) {
  const doc = (docId, more) => ({
    docId, title: docId, slug: docId, ownerUid: OWNER.uid, ownerEmail: OWNER.emailLower,
    currentVersion: "v1", visibility: "public", publicEdit: false, ...grants,
    members: [OWNER.emailLower], suggesterMembers: [OWNER.emailLower],
    editorMembers: [OWNER.emailLower], approverMembers: [OWNER.emailLower],
    createdAt: Timestamp.fromMillis(NOW), updatedAt: Timestamp.fromMillis(NOW),
    ...more,
  });
  const { db, store } = fakeFirestore({
    "docs/page": doc("page", { trusted: false }),
    "docs/page/versions/v1": { versionId: "v1", entry: "index.html", format: "html" },
    "docs/legacy": doc("legacy", {}),
    "docs/legacy/versions/v1": { versionId: "v1", entry: "index.html", format: "html" },
    "docs/global": doc("global", { trusted: true }),
    "docs/global/versions/v1": { versionId: "v1", entry: "index.html", format: "html" },
    ...extra,
  });
  return { db, store };
}

const SESSIONS = Object.fromEntries(
  [OWNER, READER, STRANGER].map((p) => [`s-${p.uid}`, { uid: p.uid, email: p.emailLower, email_verified: true }]),
);

/** Storage whose every object exists and is never read: a HEAD streams nothing. */
async function withStorage(fn) {
  const before = Object.getOwnPropertyDescriptor(admin, "storage");
  const env = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  Object.defineProperty(admin, "storage", {
    configurable: true,
    value: () => ({
      bucket: () => ({
        file: () => ({
          exists: async () => [true],
          createReadStream: () => { throw new Error("no bytes in this test"); },
        }),
      }),
    }),
  });
  try {
    return await fn();
  } finally {
    if (before) Object.defineProperty(admin, "storage", before);
    if (env === undefined) delete process.env.BIKESHED_BUCKET;
    else process.env.BIKESHED_BUCKET = env;
  }
}

async function withAdmins(list, fn) {
  const before = process.env.BIKESHED_SUPERADMINS;
  if (list === null) delete process.env.BIKESHED_SUPERADMINS;
  else process.env.BIKESHED_SUPERADMINS = list;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.BIKESHED_SUPERADMINS;
    else process.env.BIKESHED_SUPERADMINS = before;
  }
}

function caller(w) {
  const as = (who, extra = {}) => ({ ...(who ? { cookie: `__session=s-${who.uid}` } : {}), ...extra });
  const run = (handler, who, opts, extra) =>
    withStorage(() => withFakeAdmin({ db: w.db, sessions: SESSIONS }, () => invoke(handler, { ...opts, headers: as(who, extra) })));
  return {
    head: (who, path, extra) => run(contentProxy, who, { method: "HEAD", path }, extra),
    draft: (who, path) => run(getDraft, who, { method: "HEAD", path }),
    trust: (who, method, docId, body) =>
      run(trustDoc, who, method === "GET" ? { method, query: { docId } } : { method, body: { docId, ...body } }),
  };
}

test("a scripted document opened by its plain address renders locked, trusted or not", async () => {
  const c = caller(world());
  for (const docId of ["page", "legacy", "global"]) {
    for (const who of [null, OWNER, STRANGER]) {
      const r = await c.head(who, `/content/${docId}/v1/index.html`);
      assert.equal(r.status, 200, `${docId} as ${who?.uid ?? "nobody"}`);
      assert.equal(r.headers["content-security-policy"], SCRIPT_LOCK, `${docId} as ${who?.uid ?? "nobody"}`);
    }
    // An SVG is a document too; a picture of the same type is not, so nothing else is.
    assert.equal((await c.head(null, `/content/${docId}/v1/logo.svg`)).headers["content-security-policy"], SCRIPT_LOCK);
    assert.equal((await c.head(null, `/content/${docId}/v1/photo.png`)).headers["content-security-policy"], undefined);
    // So is a feed, or any XML a bundle carries: rendered as XML, it runs.
    for (const name of ["feed.atom", "feed.rss", "data.rdf", "page.xslt", "f.mathml"]) {
      assert.equal((await c.head(null, `/content/${docId}/v1/${name}`)).headers["content-security-policy"], SCRIPT_LOCK, name);
    }
  }
  // Locking changes nothing about caching: the plain URL's answer is the same
  // for everyone, so it stays as cacheable as it was.
  assert.equal((await c.head(null, "/content/page/v1/index.html")).headers["cache-control"], "public, max-age=300");
});

test("the run variant runs a document only for a superadmin's trust or the reader's own consent", async () => {
  const w = world({ "docs/page/trust/u-reader": { uid: READER.uid, email: READER.emailLower } });
  const c = caller(w);
  const unlocked = (r) => r.headers["content-security-policy"] === RUN_ANCESTORS;

  // Trusted for everyone: anyone's frame runs it.
  for (const who of [null, STRANGER]) {
    assert.ok(unlocked(await c.head(who, "/content/!run/global/v1/index.html")), `global as ${who?.uid ?? "nobody"}`);
  }
  // Untrusted: only the reader who consented.
  assert.ok(unlocked(await c.head(READER, "/content/!run/page/v1/index.html")), "the reader who consented");
  for (const who of [null, STRANGER, OWNER]) {
    const r = await c.head(who, "/content/!run/page/v1/index.html");
    assert.equal(r.headers["content-security-policy"], `${SCRIPT_LOCK}; ${RUN_ANCESTORS}`, `page as ${who?.uid ?? "nobody"}`);
  }
  // An absent flag is not trust.
  assert.ok(!unlocked(await c.head(null, "/content/!run/legacy/v1/index.html")));

  // Every scriptable answer here depends on who asked, so none is cacheable.
  for (const [who, path] of [[READER, "/content/!run/page/v1/index.html"], [null, "/content/!run/global/v1/index.html"], [STRANGER, "/content/!run/page/v1/index.html"]]) {
    assert.equal((await c.head(who, path)).headers["cache-control"], "private, no-store", path);
  }
  // Its scripts and pictures are the same for everyone, so they keep the
  // content policy, framed by this origin only.
  const js = await c.head(STRANGER, "/content/!run/page/v1/app.js");
  assert.deepEqual([js.headers["cache-control"], js.headers["content-security-policy"]], ["public, max-age=300", RUN_ANCESTORS]);
});

test("trust runs the current version only, never an older one", async () => {
  // v1 is the older version: say an editor's, whose commit withdrew trust at
  // the time. The head is v2, and trust has since been granted on it again.
  const older = (docId) => ({ [`docs/${docId}/versions/v2`]: { versionId: "v2", entry: "index.html", format: "html" } });
  const w = world({
    ...older("global"),
    ...older("page"),
    "docs/page/trust/u-reader": { uid: READER.uid, email: READER.emailLower },
  });
  w.store.set("docs/global", { ...w.store.get("docs/global"), currentVersion: "v2" });
  w.store.set("docs/page", { ...w.store.get("docs/page"), currentVersion: "v2" });
  const c = caller(w);
  const unlocked = (r) => r.headers["content-security-policy"] === RUN_ANCESTORS;

  assert.ok(unlocked(await c.head(null, "/content/!run/global/v2/index.html")), "the trusted head runs");
  assert.ok(unlocked(await c.head(READER, "/content/!run/page/v2/index.html")), "the consented head runs");
  for (const [who, path] of [[null, "/content/!run/global/v1/index.html"], [READER, "/content/!run/page/v1/index.html"]]) {
    const r = await c.head(who, path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers["content-security-policy"], `${SCRIPT_LOCK}; ${RUN_ANCESTORS}`, path);
  }
});

test("a draft never runs its script, for anyone", async () => {
  const w = world({ "docs/global": { ...world().store.get("docs/global"), draft: null } });
  const c = caller(w);
  const r = await c.draft(OWNER, "/draft/global/index.html");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-security-policy"], SCRIPT_LOCK);
  assert.equal(r.headers["cache-control"], "private, no-store");
});

test("no document may register a service worker", async () => {
  const c = caller(world());
  for (const path of ["/content/global/v1/sw.js", "/content/!run/global/v1/sw.js"]) {
    const r = await c.head(OWNER, path, { "service-worker": "script" });
    assert.equal(r.status, 404, path);
    assert.equal(r.headers["cache-control"], "private, no-store", path);
  }
  const d = await withStorage(() =>
    withFakeAdmin({ db: world().db, sessions: SESSIONS }, () =>
      invoke(getDraft, { method: "GET", path: "/draft/global/sw.js", headers: { cookie: `__session=s-${OWNER.uid}`, "service-worker": "script" } }),
    ),
  );
  assert.equal(d.status, 404);
});

test("only a superadmin who owns a document may trust it for everyone; any owner may take it back", async () => {
  await withAdmins(null, async () => {
    const c = caller(world());
    const asked = await c.trust(OWNER, "GET", "page");
    assert.deepEqual([asked.status, asked.body], [200, { trusted: false, canTrustForEveryone: false }]);
    const refused = await c.trust(OWNER, "POST", "page", { trusted: true });
    assert.equal(refused.status, 403);
    // Restoring the sandbox only takes a power away, so the owner keeps it.
    const w = world();
    const back = await caller(w).trust(OWNER, "POST", "global", { trusted: false });
    assert.equal(back.status, 200);
    assert.equal(w.store.get("docs/global").trusted, false);
  });

  await withAdmins(`someone@example.com, ${OWNER.emailLower}`, async () => {
    const w = world();
    const c = caller(w);
    assert.deepEqual((await c.trust(OWNER, "GET", "page")).body, { trusted: false, canTrustForEveryone: true });
    assert.equal((await c.trust(OWNER, "POST", "page", { trusted: true })).status, 200);
    assert.equal(w.store.get("docs/page").trusted, true);
  });

  await withAdmins(STRANGER.emailLower, async () => {
    // A superadmin, but not the owner: as refused as any other stranger.
    const w = world();
    const r = await caller(w).trust(STRANGER, "POST", "page", { trusted: true });
    assert.notEqual(r.status, 200);
    assert.equal(w.store.get("docs/page").trusted, false);
    assert.notEqual((await caller(w).trust(STRANGER, "GET", "page")).status, 200);
  });
});

test("a token never lifts the sandbox for everyone, even a superadmin owner's; it may restore it", async () => {
  await withAdmins(OWNER.emailLower, async () => {
    for (const channel of ["cli", "mcp", "api"]) {
      const token = fakeToken({ uid: OWNER.uid, email: OWNER.emailLower, channel });
      const w = world({ [token.path]: token.record });
      const users = { [OWNER.uid]: { uid: OWNER.uid, email: OWNER.emailLower, emailVerified: true, disabled: false } };
      const call = (method, body) => withStorage(() => withFakeAdmin({ db: w.db, sessions: SESSIONS, users }, () =>
        invoke(trustDoc, method === "GET"
          ? { method, query: { docId: "page" }, headers: { authorization: `Bearer ${token.bearer}` } }
          : { method, body: { docId: "page", ...body }, headers: { authorization: `Bearer ${token.bearer}` } })));
      const asked = await call("GET");
      assert.deepEqual([asked.status, asked.body], [200, { trusted: false, canTrustForEveryone: false }], channel);
      const lift = await call("POST", { trusted: true });
      assert.equal(lift.status, 403, channel);
      assert.match(lift.body.error, /in the browser/, channel);
      assert.equal(w.store.get("docs/page").trusted, false, `${channel}: nothing lifted`);
      // Taking a power away stays open to a token.
      w.store.set("docs/page", { ...w.store.get("docs/page"), trusted: true });
      assert.equal((await call("POST", { trusted: false })).status, 200, channel);
      assert.equal(w.store.get("docs/page").trusted, false, channel);
    }
    // The same superadmin owner in the browser still may.
    const w = world();
    assert.equal((await caller(w).trust(OWNER, "POST", "page", { trusted: true })).status, 200);
  });
});

test("every 200 a document path serves passes through the script lock first", () => {
  // Structural, like the noStore test: a new branch that streams a document
  // without the lock would serve it scripted at its plain address.
  const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
  for (const name of ["contentProxy", "getDraft"]) {
    const start = src.indexOf(`export const ${name} = onRequest(`);
    const end = src.indexOf("\n});\n", start);
    const body = src.slice(start, end);
    assert.ok(body.includes("isServiceWorkerFetch("), `${name} refuses service workers`);
    let at = body.indexOf("streamObject(res, objectKey");
    assert.ok(at > 0, `${name} streams a document`);
    for (; at >= 0; at = body.indexOf("streamObject(res, objectKey", at + 1)) {
      const before = body.slice(0, at);
      assert.ok(before.lastIndexOf("setScriptLock(") > before.lastIndexOf("return;"), `${name}: a stream without the lock right before it`);
    }
  }
});
