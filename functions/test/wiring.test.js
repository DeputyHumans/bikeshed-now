// SPDX-License-Identifier: Apache-2.0
// The endpoint table, firebase.json and the built exports must agree (SPEC §2).

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
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

test("SPEC §2's table lists every rewrite and trigger, in order", async () => {
  // The table said it was asserted to match, and nothing read it: it went
  // without /suggestion and the OAuth rewrites for two releases.
  const { rewrites, TRIGGERS } = await import("../../scripts/lib/endpoints.mjs");
  const spec = readFileSync(join(ROOT, "docs", "architecture", "spec.md"), "utf8");
  const section = spec.slice(spec.indexOf("\n## 2. "), spec.indexOf("\n## 3. "));
  const rows = [...section.matchAll(/^\| (`[^`]+`|— \(Firestore trigger\)) \| `([A-Za-z]+)` \|$/gm)].map(
    (m) => `${m[1].replace(/`/g, "")} -> ${m[2]}`,
  );
  const expected = [
    ...rewrites().map((r) => `${r.source} -> ${r.function}`),
    ...TRIGGERS.map((fn) => `— (Firestore trigger) -> ${fn}`),
  ];
  assert.deepEqual(rows, expected);
});

test("SPEC §8 accounts for every source file in functions/src", () => {
  // A list of files is true on the day it is written. This one lost email's
  // real names, all of oauth/ and ten lib/ files without anything noticing.
  const { readdirSync } = require("node:fs");
  const spec = readFileSync(join(ROOT, "docs", "architecture", "spec.md"), "utf8");
  const section = spec.slice(spec.indexOf("\n## 8. "), spec.indexOf("\n## 9. "));
  const block = section.match(/```\nfunctions\/src\/\n([\s\S]*?)```/);
  assert.ok(block, "SPEC §8 has no functions/src/ tree");
  const listed = [];
  for (const line of block[1].split("\n")) {
    const path = line.trim().split(/\s+/)[0];
    if (!path) continue;
    const brace = path.match(/^(.*)\{([^}]+)\}(.*)$/);
    if (brace) for (const part of brace[2].split(",")) listed.push(`${brace[1]}${part}${brace[3]}`);
    else listed.push(path);
  }
  const globs = listed.filter((p) => p.includes("*")).map((p) => new RegExp(`^${p.replace(".", "\\.").replace("*", "[^/]+")}$`));
  const named = new Set(listed.filter((p) => !p.includes("*")));
  const walk = (dir) =>
    readdirSync(join(ROOT, "functions", "src", dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  for (const file of walk("")) {
    assert.ok(named.has(file) || globs.some((g) => g.test(file)), `SPEC §8 never lists functions/src/${file}`);
  }
  for (const file of named) {
    assert.ok(existsSync(join(ROOT, "functions", "src", file)), `SPEC §8 lists functions/src/${file}, which does not exist`);
  }
});

test("a function that retries can be deployed by the workflow", () => {
  // firebase deploy refuses a function with a failure policy when it cannot
  // ask, unless given --force. 0.13.0's first deploy failed exactly so: CI
  // was green, and the deploy stopped at its first step.
  const built = require("../lib/index.js");
  const retrying = Object.keys(built).filter((n) => built[n]?.__endpoint?.eventTrigger?.retry === true);
  assert.ok(retrying.length > 0, "no function retries, so this test checks nothing");
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "deploy.yml"), "utf8");
  const step = workflow.slice(workflow.indexOf("- name: Deploy functions"), workflow.indexOf("- name: Deploy rules"));
  assert.match(step, /firebase deploy --only "\$only"[^\n]*--force/, `the by-name functions deploy needs --force for ${retrying.join(", ")}`);
});

test("exactly the three services a document open waits on are kept warm", () => {
  // A full page load runs docShell, session and contentProxy one after
  // another; cold, docShell alone took 3.6 s and contentProxy 3.0 s (ADR
  // 0011). Each warm instance is a standing monthly charge, so a fourth is a
  // decision to argue for, not a line to copy.
  const built = require("../lib/index.js");
  const warm = Object.keys(built)
    .filter((n) => built[n]?.__endpoint?.minInstances !== undefined)
    .map((n) => `${n}=${built[n].__endpoint.minInstances}`)
    .sort();
  assert.deepEqual(warm, ["contentProxy=1", "docShell=1", "session=1"]);
});

test("a cold start never loads the email renderer", () => {
  // Every function shares this module graph, so whatever index.js loads at
  // the top, every cold start pays for. @react-email/components alone was
  // 221 ms of a 290 ms load, imported statically through email/notify on
  // every request path ADR 0008 said would never see it. Its own process,
  // because this file has already loaded index.js by the time it runs.
  const { execFileSync } = require("node:child_process");
  const probe = `
    require(${JSON.stringify(join(__dirname, "..", "lib", "index.js"))});
    console.log(JSON.stringify(Object.keys(require.cache)));
  `;
  const loaded = JSON.parse(execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" }));
  const pkg = (p) => loaded.some((k) => k.includes(`/node_modules/${p}/`));
  assert.ok(pkg("firebase-admin"), "index.js loaded without firebase-admin, so this test checks nothing");
  assert.deepEqual(
    ["react", "react-dom", "@react-email", "resend"].filter(pkg),
    [],
    "index.js loads the email renderer at the top",
  );
  assert.ok(!loaded.some((k) => k.endsWith("/lib/email/notify.js")), "index.js imports email/notify at the top");
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

/**
 * `/docs` and `/docs/developers` are redirects, not pages: each guide is an
 * ordinary published document in `content/`, and the shortcut points at its id.
 * A 302 rather than a 301 because browsers keep a 301 for good, so a guide that
 * ever moved would stay unreachable for everybody who had followed the old one.
 */
test("/docs and /docs/developers redirect, temporarily, to the published guides", () => {
  const firebase = JSON.parse(readFileSync(join(ROOT, "firebase.json"), "utf8"));
  assert.deepEqual(firebase.hosting.redirects, [
    { source: "/docs", destination: "/d/docs", type: 302 },
    { source: "/docs/", destination: "/d/docs", type: 302 },
    { source: "/docs/developers", destination: "/d/docs-developers", type: 302 },
  ]);
  // The id in each destination is the directory publish.mjs reads, so a
  // shortcut and its source cannot drift apart unnoticed.
  for (const { source, destination } of firebase.hosting.redirects) {
    const id = destination.split("/").pop();
    assert.ok(
      existsSync(join(ROOT, "content", id, "bundle", "index.html")),
      `${source} points at /d/${id}, but content/${id}/bundle/index.html does not exist`,
    );
  }
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
  // `setAccess` and `setFolderAccess` answer GET with the grants a record
  // inherits, which is one owner's view of who can read it (SPEC §13).
  // `mcp`, `oauth` and `oauthConsent` answer refusals — a 401, a 405 — before
  // any handler code runs its own header, and a refusal cached for ten minutes
  // is a sign-in that cannot be retried (SPEC §23).
  for (const name of ["contentProxy", "downloadBundle", "getDraft", "docShell", "recordView", "unlockDoc", "forkDoc", "saveThumbs", "setAccess", "setFolderAccess", "setVisibility", "organize", "mcp", "oauth", "oauthConsent"]) {
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
  const management = readFileSync(join(__dirname, "..", "src", "lib", "management.ts"), "utf8");
  const sync = management.slice(management.indexOf("await syncPresenceAccess("));
  assert.match(sync.slice(0, 300), /opensEditingToAnyAccount\(/);
});

test("MCP declares its invitation secret and delegates all management writes", () => {
  const index = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
  const management = readFileSync(join(__dirname, "..", "src", "mcp", "management.ts"), "utf8");
  assert.match(index, /export const mcp = onRequest\(\{ \.\.\.MAILING,/);
  assert.match(management, /from "\.\.\/lib\/management"/);
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
  // The in-app commit and commit_draft both publish the draft through commitDraft.
  const draft = readFileSync(join(__dirname, "..", "src", "lib", "draft.ts"), "utf8");

  const upload = slice(publish, "export async function commitNewVersion(", "\nexport ");
  const inUpload = slice(upload, "runTransaction(", "\n  });\n");
  assert.match(inUpload, /readTrustGrants\(tx, /, "a token update must read the trust grants in its transaction");
  assert.match(inUpload, /withdrawTrust\(tx, /, "a token update must withdraw trust in its transaction");

  const commit = slice(draft, "export async function commitDraft(", "\nexport ");
  const inCommit = slice(slice(commit, "const editSessions =", "\nexport "), "runTransaction(", "\n    });\n");
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

// --- Connecting an app (SPEC §23) -------------------------------------------

test("the consent page and the sign-in page cannot be framed", () => {
  /**
   * The consent page is where a person clicks Approve, which is exactly the
   * click a framing page wants to borrow. `/signup` is pinned too: a framed
   * `/signup?next=/connect…` reaches the consent page by client-side
   * navigation, which never loads `/connect` from Hosting and so never gets
   * its headers.
   */
  const config = JSON.parse(readFileSync(join(__dirname, "..", "..", "firebase.json"), "utf8"));
  const headersFor = (source) => {
    const rule = config.hosting.headers.find((h) => h.source === source);
    return Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]));
  };
  for (const source of ["/connect", "/signup"]) {
    const h = headersFor(source);
    assert.equal(h["X-Frame-Options"], "DENY", source);
    assert.equal(h["Content-Security-Policy"], "frame-ancestors 'none'", source);
  }
  assert.equal(headersFor("/connect")["Referrer-Policy"], "no-referrer");
});

test("the consent endpoint takes no cross-origin calls and no personal token", () => {
  const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
  const start = src.indexOf("export const oauthConsent = onRequest(");
  assert.ok(start > 0, "oauthConsent not found");
  assert.match(src.slice(start, start + 60), /onRequest\(PLAIN,/, "oauthConsent must not enable CORS");
  const consent = readFileSync(join(__dirname, "..", "src", "oauth", "consent.ts"), "utf8");
  // Calls and imports only: the file explains in prose why it does not use them.
  assert.doesNotMatch(consent, /\b(?:resolveCaller|verifySessionCookie|verifyToken)\s*\(/);
  assert.doesNotMatch(consent, /import[^;]*\b(?:resolveCaller|verifySessionCookie|verifyToken)\b/);
});

test("the dev proxy sends discovery to the function and leaves mcp.json to Hosting", async () => {
  // The static discovery file sits beside the OAuth metadata under
  // /.well-known/. A prefix row there would hand it to a function that has no
  // such route, in development and in Hosting alike.
  const { viteProxyKeys } = await import("../../scripts/lib/endpoints.mjs");
  const keys = viteProxyKeys();
  const proxied = (url) => keys.some((k) => (k[0] === "^" ? new RegExp(k).test(url) : url.startsWith(k)));
  assert.ok(proxied("/.well-known/oauth-authorization-server"));
  assert.ok(proxied("/.well-known/oauth-protected-resource/mcp"));
  assert.ok(proxied("/oauth/token"));
  assert.ok(!proxied("/.well-known/mcp.json"));
  assert.ok(!proxied("/connect"), "the consent page is the app's own route");
});
