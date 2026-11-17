// SPDX-License-Identifier: Apache-2.0
// The embed page another site frames, and the reads it counts (SPEC §2 "GET /embed/…", §4, §17; ADR 0031).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { Timestamp } = require("firebase-admin/firestore");

const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const {
  EMBED_MARKER,
  EMBED_SANDBOX,
  embedSegments,
  isEmbedPath,
  renderEmbed,
  renderEmbedRefusal,
} = require("../lib/lib/embed.js");
const { resetShellCacheForTests } = require("../lib/lib/shell.js");
const { docShell, recordView } = require("../lib/index.js");

const ROOT = join(__dirname, "..", "..");
const read = (...path) => readFileSync(join(ROOT, ...path), "utf8");

// The built templates, as Hosting serves them: `loadShell` adopts a page only
// with its marker and a hashed module asset.
const EMBED_TEMPLATE = read("app", "embed.html").replace(
  '<script type="module" src="/src/embed/main.ts"></script>',
  '<script type="module" crossorigin src="/assets/embed-test.js"></script>',
);
const APP_SHELL = read("app", "index.html").replace(
  "</head>",
  '<script type="module" src="/assets/index-test.js"></script></head>',
);

const OWNER = { uid: "u-owner", email: "owner@example.com", email_verified: true };
const KEY = "tok_0123456789abcdefghijk";
const NOW = Date.now();

const base = {
  ownerUid: OWNER.uid,
  ownerEmail: OWNER.email,
  members: [OWNER.email],
  editorMembers: [OWNER.email],
  currentVersion: "v2",
  trusted: false,
  stats: {},
};
const versions = (id) => ({
  [`docs/${id}/versions/v1`]: { versionId: "v1", entry: "index.html", format: "html" },
  [`docs/${id}/versions/v2`]: { versionId: "v2", entry: "deck/index.html", format: "markdown" },
});

function world(extra = {}) {
  return fakeFirestore({
    "docs/pub": { ...base, title: `Q3 "plan" <draft> & $' notes`, visibility: "public" },
    ...versions("pub"),
    "docs/link": { ...base, title: "Linked", visibility: "unlisted", linkToken: KEY },
    ...versions("link"),
    "docs/memo": { ...base, title: "Private memo", visibility: "private" },
    ...versions("memo"),
    "docs/gone": { ...base, title: "Expired", visibility: "public", expiresAt: NOW - 60_000 },
    ...versions("gone"),
    "docs/binned": { ...base, title: "Binned", visibility: "public", trashed: { at: Timestamp.fromMillis(NOW) } },
    ...versions("binned"),
    ...extra,
  });
}

/** Hosting, serving the two built pages, for the length of `fn`. */
async function withTemplates(fn, { embed = EMBED_TEMPLATE } = {}) {
  const saved = globalThis.fetch;
  const origin = process.env.BIKESHED_PUBLIC_ORIGIN;
  process.env.BIKESHED_PUBLIC_ORIGIN = "https://bikeshed.example";
  resetShellCacheForTests();
  globalThis.fetch = async (url) => {
    const body = String(url).endsWith("/embed.html") ? embed : APP_SHELL;
    return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
    if (origin === undefined) delete process.env.BIKESHED_PUBLIC_ORIGIN;
    else process.env.BIKESHED_PUBLIC_ORIGIN = origin;
    resetShellCacheForTests();
  }
}

function page(w, path, query = {}, method = "GET") {
  return withTemplates(() => withFakeAdmin({ db: w.db, sessions: {} }, () => invoke(docShell, { method, path, query })));
}

/** No answer of the embed page may carry a header that stops a frame. */
function assertFrameable(r, label) {
  assert.equal(r.headers["x-frame-options"], undefined, `${label}: X-Frame-Options`);
  assert.doesNotMatch(String(r.headers["content-security-policy"] ?? ""), /frame-ancestors/, `${label}: frame-ancestors`);
}

const frameOf = (body) => /<iframe [^>]*>/.exec(body)?.[0] ?? null;
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

// --- The template and the client agree -------------------------------------------

test("the template the server fills is the one the embed entry builds, with its slot and marker", () => {
  const template = read("app", "embed.html");
  assert.ok(template.includes(EMBED_MARKER), "the marker that says the body is this page");
  assert.ok(template.includes("<!--embed-->"), "the slot the frame goes in");
  assert.ok(template.includes('src="/src/embed/main.ts"'), "the embed's own entry, never the app's");
  const main = read("app", "src", "embed", "main.ts");
  for (const id of ['"embed"', '"embed-frame"']) assert.ok(main.includes(id), `main.ts looks for ${id}`);
});

test("the embed frame's sandbox is the viewer's reading sandbox", () => {
  const frameMode = read("app", "src", "viewer", "frameMode.ts");
  const reading = /export const READING_SANDBOX = "([^"]+)"/.exec(frameMode)?.[1];
  assert.equal(EMBED_SANDBOX, reading);
  assert.doesNotMatch(EMBED_SANDBOX, /allow-scripts/);
});

test("Vite builds the embed template as its own page", () => {
  const config = read("app", "vite.config.ts");
  assert.match(config, /embed: fileURLToPath\(new URL\("\.\/embed\.html"/);
});

// --- The path -----------------------------------------------------------------------

test("any spelling of the prefix is the embed page's, so none can be the app shell", () => {
  for (const path of ["/embed/pub", "/EMBED/pub", "/Embed/pub", "/%65mbed/pub", "/%45MBED/pub/v1"]) {
    assert.equal(isEmbedPath(path), true, path);
  }
  assert.deepEqual(embedSegments("/embed/pub/v1"), ["pub", "v1"]);
  assert.deepEqual(embedSegments("/embed"), []);
  for (const path of ["/d/pub", "/embedded/pub", "/folder/embed", "/", "/%E0%A4%A/pub"]) {
    assert.equal(isEmbedPath(path), false, path);
  }
});

// --- What the page says -----------------------------------------------------------------

test("a document's page is a sandboxed frame of its files and a link to it, with the title escaped", () => {
  const html = renderEmbed(EMBED_TEMPLATE, {
    docId: "pub",
    versionId: "v2",
    requestedVersion: null,
    entry: "deck/index.html",
    title: `Q3 "plan" <draft> & $' notes`,
    format: "markdown",
    token: null,
  });
  const frame = frameOf(html);
  assert.ok(frame, "the frame is in the markup, not left to the script");
  assert.equal(attr(frame, "src"), "/content/pub/v2/deck/index.html");
  assert.equal(attr(frame, "sandbox"), EMBED_SANDBOX);
  assert.equal(attr(frame, "data-doc"), "pub");
  assert.equal(attr(frame, "data-version"), "v2");
  assert.equal(attr(frame, "data-format"), "markdown");
  assert.equal(attr(frame, "data-k"), null, "a public document's page carries no key");
  // Text needs no quotes escaped; the frame's title attribute does. `$'` is
  // here because String.replace would have expanded it.
  assert.ok(html.includes(`<title>Q3 "plan" &lt;draft&gt; &amp; $' notes</title>`));
  assert.equal(attr(frame, "title"), "Q3 &quot;plan&quot; &lt;draft&gt; &amp; $&#39; notes");
  assert.ok(!html.includes("<draft>"), "a title cannot become markup");
  assert.match(html, /<a id="embed-open" href="\/d\/pub" target="_blank" rel="noopener noreferrer">/);
  assert.ok(!html.includes("<!--embed-->"), "the slot is filled");
});

test("a key that opened the page is in the frame's path and the link, as the viewer puts it", () => {
  const html = renderEmbed(EMBED_TEMPLATE, {
    docId: "link", versionId: "v1", requestedVersion: "v1", entry: "index.html", title: "Linked", format: "html", token: "a/b c",
  });
  const frame = frameOf(html);
  assert.equal(attr(frame, "src"), "/content/~a%2Fb%20c/link/v1/index.html");
  assert.equal(attr(frame, "data-k"), "a/b c");
  assert.match(html, /href="\/d\/link\/v1\?k=a%2Fb%20c"/);
});

test("a template without its slot is not half a page", () => {
  assert.throws(() => renderEmbedRefusal("<html><title>x</title></html>", "pub"), /no <!--embed-->/);
});

// --- The handler ----------------------------------------------------------------------------

test("a public document embeds at its current version, cacheable, unindexed, and frameable", async () => {
  const w = world();
  const r = await page(w, "/embed/pub");
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "public, max-age=300");
  assert.equal(r.headers["x-robots-tag"], "noindex");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assertFrameable(r, "a document");
  assert.equal(attr(frameOf(r.body), "src"), "/content/pub/v2/deck/index.html", "the current version's entry");
  assert.ok(!r.body.includes('id="root"'), "never the app shell");

  const pinned = await page(w, "/embed/pub/v1");
  assert.equal(attr(frameOf(pinned.body), "src"), "/content/pub/v1/index.html");
  assert.match(pinned.body, /href="\/d\/pub\/v1"/);

  // A key on a public document's address is not carried: a cached page at a
  // URL anybody may share holds no key it happened to be asked with.
  const keyed = await page(w, "/embed/pub", { k: KEY });
  assert.equal(attr(frameOf(keyed.body), "data-k"), null);
  assert.equal(attr(frameOf(keyed.body), "src"), "/content/pub/v2/deck/index.html");

  const head = await page(w, "/embed/pub", {}, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers["cache-control"], "public, max-age=300");
});

test("an unlisted document embeds with its key, and is refused without it", async () => {
  const w = world();
  const r = await page(w, "/embed/link", { k: KEY });
  assert.equal(r.status, 200);
  assert.equal(attr(frameOf(r.body), "src"), `/content/~${KEY}/link/v2/deck/index.html`);
  assert.equal(attr(frameOf(r.body), "data-k"), KEY);
  assert.equal((await page(w, "/embed/link")).status, 404);
  assert.equal((await page(w, "/embed/link", { k: "tok_wrong0123456789abcd" })).status, 404);
});

test("every refusal is one neutral page, uncacheable and frameable, the same for private and absent", async () => {
  const w = world();
  const refusals = [
    ["/embed/memo", {}],
    ["/embed/gone", {}],
    ["/embed/binned", {}],
    ["/embed/link", {}],
    ["/embed/pub/v9", {}],
    ["/embed/nothing-here", {}],
    ["/embed/pub/v1/extra", {}],
    ["/embed", {}],
  ];
  for (const [path, query] of refusals) {
    const r = await page(w, path, query);
    assert.equal(r.status, 404, path);
    assert.equal(r.headers["cache-control"], "private, no-store", `${path}: Hosting would add max-age=600 to a response with none`);
    assert.equal(r.headers["x-robots-tag"], "noindex", path);
    assertFrameable(r, path);
    assert.equal(frameOf(r.body), null, `${path} frames nothing`);
    assert.ok(!r.body.includes('id="root"'), `${path} is never the app shell`);
    assert.match(r.body, /isn’t available here/, path);
  }

  // A private document and an absent one, under the same id: byte-identical.
  const without = world();
  without.store.delete("docs/memo");
  const absent = await page(without, "/embed/memo");
  const hidden = await page(w, "/embed/memo");
  assert.equal(absent.status, 404);
  assert.equal(hidden.body, absent.body);
  assert.ok(!hidden.body.includes("Private memo"), "a refusal names nothing the address did not");
});

test("a casing of the prefix Hosting sends here gets the embed page, never the app shell", async () => {
  const w = world();
  for (const path of ["/EMBED/pub", "/Embed/pub", "/%65mbed/pub"]) {
    const r = await page(w, path);
    assert.equal(r.status, 200, path);
    assert.ok(frameOf(r.body), `${path} is the embed page`);
    assert.ok(!r.body.includes('id="root"'), `${path} is not the app shell`);
  }
});

test("with no embed template adopted, the page is a 503 and not the app shell", async () => {
  const w = world();
  const r = await withTemplates(
    () => withFakeAdmin({ db: w.db, sessions: {} }, () => invoke(docShell, { method: "GET", path: "/embed/pub" })),
    { embed: APP_SHELL },
  );
  assert.equal(r.status, 503);
  assert.ok(!String(r.body ?? "").includes('id="root"'));
});

// --- Counting ------------------------------------------------------------------------------------

const SESSION = "0123456789abcdef0123456789abcdef";

function beat(w, body) {
  return withFakeAdmin({ db: w.db, sessions: {} }, () =>
    invoke(recordView, { body: { docId: "pub", versionId: "v2", sessionId: SESSION, ...body } }),
  );
}

test("an embedded read counts as a visit, and as one of the embedded ones, once per session", async () => {
  const w = world();
  assert.equal((await beat(w, { ms: 0, surface: "embed" })).status, 200);
  assert.equal((await beat(w, { ms: 60_000, surface: "embed" })).status, 200);
  const stats = w.store.get("docs/pub").stats;
  assert.equal(stats.views, 1);
  assert.equal(stats.embeds, 1, "a second beat of the same session is not a second embedded visit");
  assert.equal(stats.totalMs, 60_000);
  const session = w.store.get(`docs/pub/views/${SESSION}`);
  assert.equal(session.embedded, true);
  assert.equal(session.uid, null, "another site's frame presents no caller");
});

test("a read in the viewer is not an embedded one", async () => {
  const w = world();
  await beat(w, { ms: 0 });
  assert.equal(w.store.get("docs/pub").stats.views, 1);
  assert.equal(w.store.get("docs/pub").stats.embeds, undefined);
  assert.equal(w.store.get(`docs/pub/views/${SESSION}`).embedded, undefined);
});

test("a surface this server does not know is refused, and counts nothing", async () => {
  const w = world();
  for (const surface of ["app", "EMBED", 1, null]) {
    const r = await beat(w, { ms: 0, surface });
    assert.equal(r.status, 400, JSON.stringify(surface));
  }
  assert.deepEqual(w.store.get("docs/pub").stats, {});
  assert.equal(w.store.get(`docs/pub/views/${SESSION}`), undefined);
});

test("the activity feed says a read came through an embed", async () => {
  const w = world({
    "docs/pub/views/s-embed": { startedAt: Timestamp.fromMillis(NOW - 2000), email: null, uid: null, versionId: "v2", ms: 4000, automated: false, embedded: true },
    "docs/pub/views/s-app": { startedAt: Timestamp.fromMillis(NOW - 1000), email: null, uid: null, versionId: "v2", ms: 4000, automated: false },
  });
  const r = await withFakeAdmin({ db: w.db, sessions: { own: OWNER } }, () =>
    invoke(recordView, { method: "GET", path: "/activity", headers: { cookie: "__session=own" }, query: { docId: "pub" } }),
  );
  assert.equal(r.status, 200);
  const reads = r.body.items.filter((i) => i.type === "read").map((i) => [i.id, i.embedded ?? false]);
  assert.deepEqual(reads, [["read:s-app", false], ["read:s-embed", true]]);
});
