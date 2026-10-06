// SPDX-License-Identifier: Apache-2.0
// The endpoint table, firebase.json and the built exports must agree (SPEC §2).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "..");

/**
 * This test exists because of two real, silent defects in the design being
 * rebuilt: teardown deleted 2 of 14 functions because it was written when there
 * were two, and the dev proxy covered 2 of 14 for the same reason. Both reported
 * success. Deriving all three from one table only helps if something checks that
 * they still agree.
 */
test("firebase.json rewrites match the endpoint table exactly", async () => {
  const { rewrites } = await import("../../scripts/lib/endpoints.mjs");
  const firebase = JSON.parse(readFileSync(join(ROOT, "firebase.json"), "utf8"));
  const actual = firebase.hosting.rewrites
    .filter((r) => r.function)
    .map((r) => `${r.source} -> ${r.function}`);
  const expected = rewrites().map((r) => `${r.source} -> ${r.function}`);
  assert.deepEqual(actual, expected);
});

test("the SPA catch-all is last, after every wildcard", () => {
  const firebase = JSON.parse(readFileSync(join(ROOT, "firebase.json"), "utf8"));
  const sources = firebase.hosting.rewrites.map((r) => r.source);
  assert.equal(sources[sources.length - 1], "**");
  // An exact rewrite must precede a wildcard that would shadow it.
  assert.ok(sources.indexOf("/draft") < sources.indexOf("/draft/**"));
  assert.ok(sources.indexOf("/thumb") < sources.indexOf("/thumb/**"));
  // The document page is a function too, and it must come before the SPA
  // catch-all or the shell is served with a generic head; after the content
  // path so byte requests are never answered with a page.
  assert.ok(sources.indexOf("/d/**") < sources.indexOf("**"));
  assert.ok(sources.indexOf("/content/**") < sources.indexOf("/d/**"));
});

test("every table entry is exported by the built functions bundle", async () => {
  const { functionNames } = await import("../../scripts/lib/endpoints.mjs");
  const built = require("../lib/index.js");
  for (const name of functionNames()) {
    assert.ok(built[name], `functions/lib/index.js does not export ${name}`);
  }
});

test("the built bundle exports nothing the table does not know about", async () => {
  const { functionNames } = await import("../../scripts/lib/endpoints.mjs");
  const known = new Set(functionNames());
  const built = require("../lib/index.js");
  for (const key of Object.keys(built)) {
    assert.ok(known.has(key), `${key} is deployed but absent from the endpoint table`);
  }
});

test("exact endpoints get anchored dev-proxy keys", async () => {
  const { viteProxyKeys } = await import("../../scripts/lib/endpoints.mjs");
  const keys = viteProxyKeys();
  // /folder is both a POST endpoint and the prefix of the /folder/{id} client
  // route. A plain string key is a PREFIX match in Vite, which would proxy
  // folder deep-links to the emulator and break them silently.
  assert.ok(keys.includes("^/folder(\\?.*)?$"));
  assert.ok(!keys.includes("/folder"));
  assert.ok(keys.includes("/content"));
  const folderRe = new RegExp("^/folder(\\?.*)?$");
  assert.ok(folderRe.test("/folder"));
  assert.ok(folderRe.test("/folder?x=1"));
  assert.ok(!folderRe.test("/folder/abc123"));
  // /d/** is rewritten to docShell in Hosting, but it is a CLIENT ROUTE: the
  // function serves the app shell, which in dev is Vite's own. A `/d` proxy
  // key would send every document page to the emulator, which has no shell
  // to serve, so the row must stay out of the proxy entirely. Decided the way
  // Vite does: a key starting with `^` is a regex, anything else a prefix —
  // so `/draft` and `/download` are fine and `/d` is not.
  const proxied = (url) => keys.some((k) => (k[0] === "^" ? new RegExp(k).test(url) : url.startsWith(k)));
  assert.ok(!keys.includes("/d"));
  assert.ok(!proxied("/d"));
  assert.ok(!proxied("/d/abc123"));
  assert.ok(!proxied("/d/abc123/v2?k=tok"));
  assert.ok(proxied("/draft/abc123"), "the simulation must still see a real prefix row");
});

// --- Cache headers on the byte paths ---------------------------------------

test("every byte-serving endpoint sets a cache header before it can return", () => {
  /**
   * The bug this pins, found only on a real deployment:
   *
   * Firebase Hosting applies a default `max-age=600` to a function response
   * that sets no cache header. The success paths set `private, no-store`; the
   * 403 and 404 paths set nothing. So one anonymous probe of a private
   * document produced a PUBLICLY CACHEABLE 404, and the CDN then served that
   * 404 to authorised readers for ten minutes — a stranger could make a
   * document unreadable to the people who own it.
   *
   * The emulator cannot reproduce it: it applies no default caching. So the
   * invariant is asserted structurally instead — `noStore(res)` must appear
   * before the first `return` in each byte-serving handler, which is what makes
   * a future early return safe by construction rather than by remembering.
   */
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");

  // `forkDoc` serves no bytes, but its lineage answer is per caller — who may
  // see which ancestor, and the owner's inventory — so it is held to the same
  // rule: a cached lineage would show one reader's view of a document to the next.
  for (const name of ["contentProxy", "downloadBundle", "getDraft", "docShell", "recordView", "unlockDoc", "forkDoc", "saveThumbs"]) {
    const start = src.indexOf(`export const ${name} = onRequest(`);
    assert.ok(start > 0, `${name} not found`);
    const body = src.slice(start, start + 1200);

    const noStoreAt = body.indexOf("noStore(res)");
    assert.ok(noStoreAt > 0, `${name} must call noStore(res)`);

    // It has to come before the first thing that can send a response.
    const firstReturn = body.indexOf("res.status(");
    assert.ok(
      firstReturn === -1 || noStoreAt < firstReturn,
      `${name} calls res.status() before noStore(res), so that path inherits Hosting's max-age=600`,
    );
  }
});

// --- The unlisted key has one home ------------------------------------------

test("no endpoint compares a link token by hand", () => {
  /**
   * The bug this pins: the key was checked in three handlers, each written out
   * by hand, while the shared `canRead` let an unlisted document through with
   * no key at all — so every path that trusted `canRead` (the view counter,
   * duplication, the agent tools, open editing) served an unlisted document to
   * anyone who guessed its id. The comparison lives in `tokenMatches`, reached
   * through `readBasis`, and nowhere else (SPEC §17).
   */
  const files = [
    join(__dirname, "..", "src", "index.ts"),
    join(__dirname, "..", "src", "lib", "shell.ts"),
    join(__dirname, "..", "src", "mcp", "tools.ts"),
    join(__dirname, "..", "src", "lib", "fork.ts"),
  ];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // Either side of an equality, but not a `typeof x.linkToken === "string"`.
    assert.doesNotMatch(src, /(?:===?|!==?)\s*[\w.?()]*\.linkToken\b/, `${file} compares a token by hand`);
    assert.doesNotMatch(src, /\.linkToken\s*(?:===?|!==?)\s*[^"'\s=]/, `${file} compares a token by hand`);
  }
});

test("only a public document writes the realtime key that lets any account edit", () => {
  // The realtime rules cannot see a link's key. Handing `*` to an unlisted
  // open-editing document let any signed-in account push edits into it blind.
  const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
  const start = src.indexOf("export const setVisibility = onRequest(");
  const body = src.slice(start, src.indexOf("export const", start + 10));
  const sync = body.slice(body.indexOf("await syncPresenceAccess("));
  assert.match(sync.slice(0, 300), /opensEditingToAnyAccount\(/);
});

test("noStore is exactly private, no-store — not merely no-cache", () => {
  // `no-cache` still permits a SHARED cache to store the response and
  // revalidate. For a response whose whole point is that it must not be held
  // by a CDN keyed on a URL rather than on a cookie, that is not enough.
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const http = readFileSync(join(__dirname, "..", "src", "lib", "http.ts"), "utf8");
  const fn = http.slice(http.indexOf("export function noStore"));
  assert.match(fn.slice(0, 200), /"private, no-store"/);
});

test("every write of a new document's bytes refuses to overwrite", () => {
  /**
   * A new document's bytes are written before its record, so two creates can
   * hold one id at once. Without the precondition the second overwrites the
   * first one's v1 and only then fails. The unit suite has no Storage and the
   * race cannot be staged on demand, so the shape is pinned here: both create
   * paths place their bytes through `placeNewDocument`, and write with
   * `CREATE_ONLY`, which is exactly "only if no object exists".
   */
  const publish = readFileSync(join(__dirname, "..", "src", "lib", "publish.ts"), "utf8");
  const index = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");

  const { CREATE_ONLY } = require("../lib/lib/publish.js");
  assert.deepEqual(CREATE_ONLY, { preconditionOpts: { ifGenerationMatch: 0 } });

  const bodyOf = (src, marker) => {
    const start = src.indexOf(marker);
    assert.ok(start > 0, `${marker} not found`);
    const next = src.indexOf("\nexport ", start + marker.length);
    return src.slice(start, next === -1 ? undefined : next);
  };

  const create = bodyOf(publish, "export async function publishNewDocument(");
  assert.match(create, /placeNewDocument\([\s\S]*uploadBundle\(prefix, compiled\.files, CREATE_ONLY\)/);
  assert.doesNotMatch(create, /uniqueDocId\(/);

  const fork = bodyOf(
    readFileSync(join(__dirname, "..", "src", "lib", "fork.ts"), "utf8"),
    "export async function forkDocument(",
  );
  assert.match(fork, /placeNewDocument\([\s\S]*\.copy\([^;]*CREATE_ONLY\)/);
  assert.doesNotMatch(fork, /uniqueDocId\(/);
  // The endpoint forks only through the shared path, which is what the pin covers.
  const endpoint = bodyOf(index, "export const forkDoc = onRequest(");
  assert.match(endpoint, /forkDocument\(/);
  assert.doesNotMatch(endpoint, /placeNewDocument\(|\.copy\(/);
});

/**
 * The Functions emulator wraps `firebase-admin` in a proxy that drops the
 * static namespace properties off `admin.firestore`, so `admin.firestore.
 * FieldValue` and `admin.firestore.Timestamp` are `undefined` there and fine
 * in production (see the import comment at the top of `src/index.ts`, and
 * CLAUDE.md). A unit suite cannot see it; the emulator finds it on the first
 * request that reaches the line. So the shape is pinned: those classes come
 * from the modular `firebase-admin/firestore` entry point. Type positions
 * (`as admin.firestore.Timestamp`) are erased and are fine; what must not
 * appear is a CALL through the namespace.
 */
test("no static Firestore class is reached through the admin namespace", () => {
  // Every source file, not only the endpoints: the fork counter is incremented
  // from lib/, and a library call is just as invisible to the unit suite.
  const { readdirSync } = require("node:fs");
  const root = join(__dirname, "..", "src");
  const files = readdirSync(root, { recursive: true }).filter((f) => f.endsWith(".ts"));
  assert.ok(files.includes(join("lib", "fork.ts")), "the scan must reach lib/");
  for (const file of files) {
    const src = readFileSync(join(root, file), "utf8");
    const calls = src.match(/admin\.firestore\.(FieldValue|Timestamp|FieldPath|GeoPoint)\s*[.(]/g);
    assert.deepEqual(calls ?? [], [], file);
  }
});

// --- A version nobody vouched for is never trusted -----------------------------

test("every path that mints a version decides trust inside its transaction", () => {
  /**
   * Trust used to carry from version to version unconditionally, on the claim
   * that in-app editing cannot introduce a new bundle. The server never held
   * that line: /draft stores whatever HTML a caller with canEdit sends, and
   * update_document takes any content. On a trusted document with open
   * editing, any signed-in account could commit a <script> that then ran in
   * every reader's session, with the app's own origin.
   *
   * The transactions cannot run without Firestore, so the shape is pinned: a
   * token update always withdraws trust, and the in-app commit withdraws it
   * unless keepsTrust says the owner wrote it. Both withdraw it in the same
   * transaction that moves currentVersion, so no reader can load the new
   * version under the old trust.
   */
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const slice = (src, from, to) => {
    const start = src.indexOf(from);
    assert.ok(start >= 0, `${from} not found`);
    const end = src.indexOf(to, start + from.length);
    return src.slice(start, end < 0 ? undefined : end);
  };
  const publish = readFileSync(join(__dirname, "..", "src", "lib", "publish.ts"), "utf8");
  const index = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");

  const upload = slice(publish, "export async function commitNewVersion(", "\nexport ");
  const inUpload = slice(upload, "runTransaction(", "\n  });\n");
  assert.match(inUpload, /readTrustGrants\(tx, /, "a token update must read the trust grants in its transaction");
  assert.match(inUpload, /withdrawTrust\(tx, /, "a token update must withdraw trust in its transaction");

  const commit = slice(index, "export const commitVersion = onRequest(", "\nexport const ");
  const inCommit = slice(commit, "runTransaction(", "\n    });\n");
  assert.match(inCommit, /keepsTrust\(/, "the in-app commit must ask who wrote the version");
  assert.match(inCommit, /readTrustGrants\(tx, /, "the in-app commit must read the trust grants in its transaction");
  assert.match(inCommit, /withdrawTrust\(tx, /, "the in-app commit must be able to withdraw trust");
});

// --- Stored thumbnails ---------------------------------------------------------

/** The source of one exported endpoint, up to the next export. */
function endpointBody(name) {
  const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
  const start = src.indexOf(`export const ${name} = onRequest(`);
  assert.ok(start > 0, `${name} not found`);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

test("a thumbnail is read through the same gate as content, and only if the record names it", () => {
  /**
   * A thumbnail is the document's content, so it takes the same gate — the one
   * that refuses an expired document, which the rules cannot. The unit suite
   * has no request to send, so the branch is pinned by shape: the path is
   * matched before anything is read, the gate decides, the record must name the
   * image, and the object key is the thumbnail's own, never the version's.
   */
  const body = endpointBody("contentProxy");
  const branch = body.slice(body.indexOf("if (isThumb) {"), body.indexOf("const prefix = `docs/"));
  assert.ok(branch.length > 0, "contentProxy has no thumbnail branch");
  const order = ["THUMB_REL.test(relPath)", "readGate(", "servableThumb(", "setThumbCache(", "streamObject("];
  const at = order.map((needle) => branch.indexOf(needle));
  assert.ok(at.every((i) => i >= 0), `missing one of ${order.join(", ")}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, `out of order: ${order.join(" < ")}`);
  assert.match(branch, /streamObject\(res, thumbObjectKey\(docId, versionId, relPath\)/);
  // The answer, not merely the call: both must hold, or the reader gets the 404.
  assert.ok(branch.includes("if (!gate || !servableThumb(thumb, versionId, relPath)) {"));
});

test("a member's thumbnail is kept by their browser and never by a shared cache", () => {
  const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
  const fn = src.slice(src.indexOf("function setThumbCache("), src.indexOf("GET /content/[~<key>/]"));
  assert.match(fn, /`private, max-age=\$\{maxAge\}, immutable`/);
  // Capped at expiry, like every other window.
  assert.match(fn, /expiryMs\(gate\.docData\)/);
  // Anything not decided by who is asking keeps the content policy.
  assert.match(fn, /setContentCache\(res, gate\)/);
});

test("storing thumbnails is for editors, refused once expired, and is not an edit", () => {
  const body = endpointBody("saveThumbs");
  // Editors — not open editing's every signed-in account. A shared image is
  // seen by every member; who may set it is who may change the document.
  assert.match(body, /isDocEditor\(data, caller\.uid, caller\.emailLower\)/);
  assert.doesNotMatch(body, /\bcanEdit\(/);
  // Expiry as a READER meets it, before writing anything and again inside the
  // transaction that decides: refused to every editor, but not to the owner,
  // who alone still reads an expired document and so may store its cover.
  const transaction = body.slice(body.indexOf("runTransaction("));
  const before = body.indexOf("expiredForReader(data, caller)");
  assert.ok(before > 0 && before < body.indexOf("runTransaction("));
  assert.match(transaction, /expiredForReader\(d, caller\)/);
  assert.doesNotMatch(body, /\bisExpired\(/);
  assert.match(transaction, /d\.currentVersion !== versionId/);
  // A captured image is not an edit: the workspace sorts and labels by this.
  assert.doesNotMatch(body, /updatedAt/);
  assert.match(body, /\.\.\.CREATE_ONLY/);
  // Only this deployment's capture, decided before anything is written: an
  // older page left open would store the images a newer capture replaces.
  const revision = body.indexOf('Number(strParam(req, "r")) !== THUMB_REVISION');
  assert.ok(revision > 0 && revision < body.indexOf("randomBytes("));
  // A newer capture of the same version deletes the keys it replaced, never
  // the version's whole prefix — its own images are already under it.
  assert.match(body, /thumbPrefix\(docId, gone\.versionId\)\}\$\{gone\.key \? `\$\{gone\.key\}\/` : ""\}/);
});
