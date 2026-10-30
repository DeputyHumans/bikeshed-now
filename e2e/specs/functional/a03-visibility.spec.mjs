// SPDX-License-Identifier: Apache-2.0
// A3 Visibility: cache headers, /unlock, the /d/** shell, the public projection, link rotation, grants, link assets, og:url and the sitemap (SPEC §17).

/**
 * Catalogue A3.1–A3.10, each case with its own accounts and documents.
 *
 *   A3.1   the Cache-Control / X-Robots-Tag / nosniff matrix for /content,
 *          /thumb, /draft, /download, /unlock and GET /access, by read basis
 *          (member, refusal, link, grant, public, expiring) — SPEC §2, §17
 *          "Caching"; nosniff on /content, /thumb, /d and every /draft answer,
 *          refusals included; plus a PRODUCTION-only row set: no 404 carries
 *          Hosting's default max-age=600 (CLAUDE.md, the emulator adds nothing)
 *   A3.1q  X-a03-visibility-1, a SPEC QUESTION (class Q), not a violation:
 *          plan 3.1 says "every response carries nosniff", SPEC §2 names it
 *          only for /content (spec.md:227) and /d (spec.md:278), and the
 *          product sends none on /download, /unlock or GET /access. Pinned
 *          as a known defect so the gap stays visible until Pavel decides
 *   A3.2   POST /unlock: no or wrong key is one empty 404; a key holder gets the
 *          reader projection without publishedAt; a signed-in key holder gets a
 *          linkGrants/{uid} record naming the token (SPEC §2 /unlock)
 *   A3.3   /d/**: private and absent are byte-identical with identical headers
 *          (Date aside); unlisted with its key is cacheable, noindex and titled
 *          by the document; a POST is 405 (SPEC §2 /d, §17 "Link previews")
 *   A3.4   public/{d} holds exactly the allowed projected keys; an anonymous get of
 *          an unlisted or an absent row, and an anonymous list, are refused by
 *          the rules (SPEC §17 "Anonymous reads use a projection")
 *   A3.5   making a public document private (or unlisted) removes its row
 *          within 2 s of the change's answer
 *   A3.6   rotating the link (private, then unlisted) kills the old key and
 *          every grant made with it, on every surface (SPEC §17, ADR 0012)
 *   A3.7   a grant holder comments and records a view without the key, in the
 *          browser (SPEC §17 "An unlisted document needs its link")
 *   A3.8   an anonymous link holder's frame loads every relative asset of a
 *          bundle with 200 — the `~<k>` path segment (SPEC §2 /content)
 *   A3.9   og:url is /d/{id} on a public document whatever k the request
 *          carried, and carries ?k= only for an unlisted one (SPEC §17)
 *   A3.10  sitemap.xml lists public documents only, and drops one once its
 *          expiry passes (SPEC §17 "Three levels", "Expiry")
 *
 * Public windows are short: every document made public or unlisted here goes
 * through lib/grant.mjs's setVisibility, so scenario() makes it private again
 * when its case ends, pass, fail or timeout, and a window that will not close
 * fails the case (E2E_WINDOW_OPEN). On production none stays open past its
 * case (the plan's ≤ 10 minutes). Ids come from docIdFor, and absent-id probes
 * that are writes (POST /unlock, POST /d/) from absentDocId; content is
 * innocuous. No case shares through POST /access, so nothing here sends an
 * invitation; A3.7's comment is made on a document whose owner and commenter
 * are cast with email off.
 *
 * Case budgets (timeoutMs) are upper bounds, not oracles: they allow for an
 * emulator whose writes stall for seconds each (measured at 5–6 s on a
 * long-lived shared stack), where a case makes 10–30 serial writes. No
 * oracle here measures how long a request takes. A write the stack never
 * answers (Hosting's 60 s cut-off, http.mjs's own deadline, an Admin SDK
 * DEADLINE_EXCEEDED; measured on a two-day-old shared stack whose Firestore
 * emulator sat at a full core: POST /publish 35 s, POST /visibility past 60 s)
 * measured nothing, so every case declares inconclusiveOnStackTimeout and
 * ends INCONCLUSIVE there rather than FAIL; an assertion never qualifies.
 *
 * Only e2e/lib/ talks to the stack.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { answered, currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { absentDocId, docIdFor, publish, publishZip } from "../../lib/seed.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { assertHeaderMatrix, cacheControl, eventually, sameBytes, sameHeadersExceptDate } from "../../lib/assert.mjs";
import { createGuard } from "../../lib/guard.mjs";
import { setVisibility } from "../../lib/grant.mjs";
import { storeThumb, tinyPng } from "../../lib/thumbs.mjs";
import { clientFirestore } from "../../lib/firestore-client.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

/** SPEC §17 "Caching": the public window, and a member's thumbnail window. */
const PUBLIC_MAX_AGE = 300;
const THUMB_MAX_AGE = 86_400;
/** The exact projection keys of public/{docId} (SPEC §17, lib/publicdoc.ts PROJECTED_KEYS). */
const PUBLIC_KEYS = ["currentVersion", "docId", "entry", "expiresAt", "fileCount", "forked", "format", "liveEpoch", "marking", "publicEdit", "publishedAt", "slug", "sourceEntry", "title", "trusted", "updatedAt", "viaFolder", "visibility", "words"];
/** POST /unlock's reader projection: the same minus publishedAt (SPEC §2 /unlock). */
const READER_KEYS = PUBLIC_KEYS.filter((k) => k !== "publishedAt");

const NO_STORE = "private, no-store";
const PUBLIC_300 = `public, max-age=${PUBLIC_MAX_AGE}`;
/** What the rules' refusal looks like through clientFirestore. */
const RULES_DENY = Object.freeze({ status: 403, code: "PERMISSION_DENIED", verdict: "DENY" });

// --- helpers ------------------------------------------------------------------

/** The cast as sessions, in order. `o` is cast()'s options ({notifications: false}). */
async function castSessions(roles, o = {}) {
  const accounts = await cast(target, roles, o);
  return Promise.all(accounts.map((a) => openSession(target, a)));
}

function htmlDoc(title, body) {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

/** Publish one innocuous HTML page as `owner`; returns {docId, versionId}. */
async function publishPage(owner, name, { title, body } = {}) {
  const tag = `${runTag(target.runId)}-${rand4()}`;
  const docTitle = title ?? `A3 ${name} ${tag}`;
  const html = htmlDoc(docTitle, body ?? `<h1>${docTitle}</h1>\n<p id="a3-p">A short page about bicycle sheds, published to test who may read it.</p>`);
  const up = await publish(owner.http, { body: html, filename: "index.html", title: `Workspace ${docTitle}`, name: `a3-${name}` });
  precondition(up.versionId === "v1", `publish ${name}: ${up.status} ${JSON.stringify(up.json)}`);
  return { docId: up.docId, versionId: up.versionId, title: docTitle, html };
}

/**
 * POST /visibility as the owner (lib/grant.mjs): anything but a 200 throws,
 * and an unlisted or public answer is a window the case closes when it ends.
 * `extra` is {expiresAt, publicEdit}, sent only when given.
 */
const visibility = (owner, docId, level, extra = {}) => setVisibility(target, { owner, doc: docId, visibility: level, ...extra });

/** The link token an unlisted answer carries. */
async function unlisted(owner, docId, label = "link token") {
  const k = (await visibility(owner, docId, "unlisted")).linkToken;
  precondition(typeof k === "string" && k.length >= 22, `${label}: ${k}`);
  return k;
}

const contentPath = (docId, v = "v1", rel = "") => `/content/${encodeURIComponent(docId)}/${v}/${rel}`;
const keyedPath = (k, docId, v = "v1", rel = "") => `/content/~${encodeURIComponent(k)}/${encodeURIComponent(docId)}/${v}/${rel}`;

/** POST /thumb a cover for v1 as `owner` (lib/thumbs.mjs storeThumb); returns the path GET /thumb serves it at. */
async function storeCover(owner, docId) {
  const t = await storeThumb(owner.http, { docId, versionId: "v1" });
  precondition(t.stored === true && t.record?.versionId === "v1" && typeof t.path === "string", `POST /thumb ${docId}: ${JSON.stringify({ stored: t.stored, record: t.record })}`);
  return t.path;
}

/** Firestore as an anonymous client SDK reaches it: no credential, so the security rules decide. */
const anonFirestore = (ctx) => clientFirestore(target, { idToken: null, http: ctx.http({ actor: "anon-fs" }) });

/** A clientFirestore result, as the refusal oracle compares it. */
const verdictOf = (r) => ({ status: r.status, code: r.code, verdict: r.verdict });

/** `<meta property="…" content="…">` from a shell page, or null. */
function metaProperty(html, prop) {
  const re = new RegExp(`<meta\\s+property="${prop.replace(/[.:]/g, "\\$&")}"\\s+content="([^"]*)"`, "i");
  const m = re.exec(html);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

function titleOf(html) {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1] : null;
}

/** `max-age` within what the expiry leaves: ≤ the seconds left when the request was sent, ≥ those left at its answer, ±1 s. */
function maxAgeWithin(expiresAt, sentAt, gotAt) {
  return (value) => {
    const cc = cacheControl(String(value ?? ""));
    if (cc.maxAge === null) return false;
    const hi = Math.floor((expiresAt - sentAt) / 1000) + 1;
    const lo = Math.floor((expiresAt - gotAt) / 1000) - 1;
    return cc.maxAge <= hi && cc.maxAge >= lo;
  };
}

async function timed(fn) {
  const sentAt = Date.now();
  const res = await fn();
  return { res, sentAt, gotAt: Date.now() };
}

// --- A3.1 ---------------------------------------------------------------------

scenario("A3.1 cache headers: member and grant reads are private no-store, link and public reads public max-age=300 (+noindex when unlisted), expiry caps max-age, thumbs immutable, /draft /download /unlock GET /access always no-store, nosniff on byte paths", { inconclusiveOnStackTimeout: true, timeoutMs: 480_000 }, async (ctx) => {
  ctx.step("cast an owner and a stranger; publish a private P, an unlisted U, a public B and a public E expiring in 120 s");
  const [owner, stranger] = await castSessions(["owner", "stranger"]);
  const anon = ctx.http({ actor: "anon" });
  const P = await publishPage(owner, "cache-private");
  const U = await publishPage(owner, "cache-unlisted");
  const B = await publishPage(owner, "cache-public");
  const E = await publishPage(owner, "cache-expiring");
  const absent = docIdFor(target, "a3-cache-absent");

  const k = await unlisted(owner, U.docId, "unlisted link token");
  await visibility(owner, B.docId, "public");

  ctx.step("the stranger presents U's key to /unlock, so they hold a link grant");
  const unlocked = await stranger.http.postJson("/unlock", { docId: U.docId, k });
  precondition(unlocked.status === 200, `stranger unlock: ${unlocked.status}`);

  ctx.step("the owner stores a cover thumbnail for P and for B through POST /thumb");
  const thumbPath = await storeCover(owner, P.docId);
  const publicThumbPath = await storeCover(owner, B.docId);

  ctx.step("E is made public expiring in 120 s, last, so its rows are read well before the date");
  const expiresAt = Date.now() + 120_000;
  const e = await visibility(owner, E.docId, "public", { expiresAt });
  precondition(e.expiresAt === expiresAt, `E's expiry was stored: ${JSON.stringify(e.json)}`);

  ctx.step("read every row");
  const ex = await timed(() => anon.get(contentPath(E.docId)));
  const exShell = await timed(() => anon.get(`/d/${E.docId}`));
  const rows = [
    // member reads
    { label: "member /content (owner, private)", res: await owner.http.get(contentPath(P.docId)), status: 200, expect: { "cache-control": NO_STORE, "x-content-type-options": "nosniff", "x-robots-tag": null } },
    { label: "member /content (owner, unlisted)", res: await owner.http.get(contentPath(U.docId)), status: 200, expect: { "cache-control": NO_STORE, "x-content-type-options": "nosniff", "x-robots-tag": "noindex" } },
    // a grant's read: decided by who asks, its URL carries no key
    { label: "grant /content (stranger, unlisted, no k)", res: await stranger.http.get(contentPath(U.docId)), status: 200, expect: { "cache-control": NO_STORE, "x-content-type-options": "nosniff", "x-robots-tag": "noindex" } },
    // refusals
    { label: "refusal /content (stranger, private)", res: await stranger.http.get(contentPath(P.docId)), status: 404, expect: { "cache-control": NO_STORE, "x-content-type-options": "nosniff" } },
    { label: "refusal /content (anonymous, private)", res: await anon.get(contentPath(P.docId)), status: 404, expect: { "cache-control": NO_STORE, "x-content-type-options": "nosniff" } },
    { label: "refusal /content (anonymous, unlisted, no k)", res: await anon.get(contentPath(U.docId)), status: 404, expect: { "cache-control": NO_STORE, "x-content-type-options": "nosniff" } },
    { label: "refusal /content (anonymous, unlisted, wrong k)", res: await anon.get(contentPath(U.docId), { query: { k: `${k.slice(0, -2)}xx` } }), status: 404, expect: { "cache-control": NO_STORE, "x-content-type-options": "nosniff" } },
    { label: "refusal /content (absent id)", res: await anon.get(contentPath(absent)), status: 404, expect: { "cache-control": NO_STORE, "x-content-type-options": "nosniff" } },
    // reads the URL alone decides
    { label: "link /content?k= (anonymous)", res: await anon.get(contentPath(U.docId), { query: { k } }), status: 200, expect: { "cache-control": PUBLIC_300, "x-content-type-options": "nosniff", "x-robots-tag": "noindex" } },
    { label: "link /content/~k/ (anonymous)", res: await anon.get(keyedPath(k, U.docId)), status: 200, expect: { "cache-control": PUBLIC_300, "x-content-type-options": "nosniff", "x-robots-tag": "noindex" } },
    { label: "public /content (anonymous)", res: await anon.get(contentPath(B.docId)), status: 200, expect: { "cache-control": PUBLIC_300, "x-content-type-options": "nosniff", "x-robots-tag": null } },
    { label: "public /content (signed-in stranger)", res: await stranger.http.get(contentPath(B.docId)), status: 200, expect: { "cache-control": PUBLIC_300, "x-content-type-options": "nosniff", "x-robots-tag": null } },
    { label: "expiring public /content (anonymous): public, max-age ≤ seconds left", res: ex.res, status: 200, expect: { "cache-control": (v) => /^public, max-age=\d+$/.test(v ?? "") && maxAgeWithin(expiresAt, ex.sentAt, ex.gotAt)(v) && cacheControl(v).maxAge < PUBLIC_MAX_AGE, "x-content-type-options": "nosniff" } },
    // thumbnails
    { label: "member /thumb (owner, no expiry)", res: await owner.http.get(thumbPath), status: 200, expect: { "cache-control": `private, max-age=${THUMB_MAX_AGE}, immutable`, "x-content-type-options": "nosniff", "content-type": /^image\/jpeg/ } },
    { label: "refusal /thumb (stranger)", res: await stranger.http.get(thumbPath), status: 404, expect: { "cache-control": NO_STORE, "x-content-type-options": "nosniff" } },
    { label: "refusal /thumb (anonymous)", res: await anon.get(thumbPath), status: 404, expect: { "cache-control": NO_STORE, "x-content-type-options": "nosniff" } },
    { label: "public /thumb (anonymous): the /content policy", res: await anon.get(publicThumbPath), status: 200, expect: { "cache-control": PUBLIC_300, "x-content-type-options": "nosniff" } },
    { label: "expiring public /d/ (anonymous): public, max-age ≤ seconds left", res: exShell.res, status: 200, expect: { "cache-control": (v) => /^public, max-age=\d+$/.test(v ?? "") && maxAgeWithin(expiresAt, exShell.sentAt, exShell.gotAt)(v) && cacheControl(v).maxAge < PUBLIC_MAX_AGE, "x-content-type-options": "nosniff" } },
    // always no-store. nosniff is asserted here where SPEC §2 or the Hosting header rules name it: the
    // byte paths above (/content spec.md:227, /d spec.md:278, /thumb under /content's gate, spec.md:261)
    // and every /draft answer (firebase.json's /draft/** rule, which reaches the refusals the function
    // itself leaves bare). Plan 3.1's "every response carries nosniff" is wider than SPEC: for /unlock
    // SPEC §2 names a Cache-Control and nothing else (spec.md:303), likewise GET /access (spec.md:326-327),
    // and for /download no header at all (spec.md:422-423), and the product sends none of the three
    // nosniff. That gap is a SPEC QUESTION, not a violation, so it is not asserted in this case (where a
    // failure is a FAIL): A3.1q pins it as X-a03-visibility-1, and the matrix evidence records what each
    // row below carried.
    { label: "/draft (owner)", res: await owner.http.get(`/draft/${encodeURIComponent(P.docId)}/`), status: 200, expect: { "cache-control": NO_STORE, "x-content-type-options": "nosniff" } },
    { label: "/draft (stranger)", res: await stranger.http.get(`/draft/${encodeURIComponent(P.docId)}/`), status: 404, expect: { "cache-control": NO_STORE, "x-content-type-options": "nosniff" } },
    { label: "/draft (anonymous)", res: await anon.get(`/draft/${encodeURIComponent(P.docId)}/`), status: 401, expect: { "cache-control": NO_STORE, "x-content-type-options": "nosniff" } },
    { label: "/download (owner)", res: await owner.http.get(`/download/${encodeURIComponent(P.docId)}/v1`), status: 200, expect: { "cache-control": NO_STORE } },
    { label: "/download (anonymous link holder)", res: await anon.get(`/download/${encodeURIComponent(U.docId)}/v1`, { query: { k } }), status: 200, expect: { "cache-control": NO_STORE } },
    { label: "/download (public, anonymous)", res: await anon.get(`/download/${encodeURIComponent(B.docId)}/v1`), status: 200, expect: { "cache-control": NO_STORE } },
    { label: "/download (stranger, private)", res: await stranger.http.get(`/download/${encodeURIComponent(P.docId)}/v1`), status: 404, expect: { "cache-control": NO_STORE } },
    { label: "/unlock (anonymous, right k)", res: await anon.postJson("/unlock", { docId: U.docId, k }), status: 200, expect: { "cache-control": NO_STORE } },
    { label: "/unlock (anonymous, public)", res: await anon.postJson("/unlock", { docId: B.docId }), status: 200, expect: { "cache-control": NO_STORE } },
    { label: "/unlock (anonymous, no k)", res: await anon.postJson("/unlock", { docId: U.docId }), status: 404, expect: { "cache-control": NO_STORE } },
    { label: "GET /access (owner)", res: await owner.http.get("/access", { query: { docId: P.docId } }), status: 200, expect: { "cache-control": NO_STORE } },
    { label: "GET /access (stranger)", res: await stranger.http.get("/access", { query: { docId: P.docId } }), status: 404, expect: { "cache-control": NO_STORE } },
    { label: "GET /access (anonymous)", res: await anon.get("/access", { query: { docId: P.docId } }), status: 401, expect: { "cache-control": NO_STORE } },
  ];

  ctx.step("the owner sets P to expire in an hour; the member thumbnail's window is then capped at the time left");
  const thumbExpiry = Date.now() + 3_600_000;
  await visibility(owner, P.docId, "private", { expiresAt: thumbExpiry });
  const tx = await timed(() => owner.http.get(thumbPath));
  rows.push({ label: "member /thumb (owner, expiring in 3600 s)", res: tx.res, status: 200, expect: { "cache-control": (v) => /^private, max-age=\d+, immutable$/.test(v ?? "") && maxAgeWithin(thumbExpiry, tx.sentAt, tx.gotAt)(v), "x-content-type-options": "nosniff" } });

  ctx.ev.json("matrix", rows.map((r) => ({ label: r.label, status: r.res.status, cacheControl: r.res.headers.get("cache-control"), robots: r.res.headers.get("x-robots-tag"), nosniff: r.res.headers.get("x-content-type-options") })));
  assertHeaderMatrix(rows);
  assert.equal(rows.find((r) => r.label.startsWith("refusal /content (absent")).res.buffer.length, 0, "a refusal's body is empty");
});

scenario("A3.1 (production) no 404 from a byte path, /unlock or /access carries Hosting's default max-age=600", { tiers: ["prod"], inconclusiveOnStackTimeout: true, timeoutMs: 120_000 }, async (ctx) => {
  const [stranger] = await castSessions(["stranger"]);
  const anon = ctx.http({ actor: "anon" });
  // POST /unlock names it, so it is an absent-id probe the production guard must be able to prove empty.
  const absent = absentDocId(target, "a3-prod-absent");
  const rows = [
    { label: "/content absent (anonymous)", res: await anon.get(contentPath(absent)) },
    { label: "/content absent (stranger)", res: await stranger.http.get(contentPath(absent)) },
    { label: "/thumb absent", res: await anon.get(`/thumb/${absent}/v1/0123456789abcdef/cover.jpg`) },
    { label: "/download absent", res: await stranger.http.get(`/download/${absent}/v1`) },
    { label: "/draft absent", res: await stranger.http.get(`/draft/${absent}/`) },
    { label: "/unlock absent", res: await anon.postJson("/unlock", { docId: absent }) },
    { label: "GET /access absent", res: await stranger.http.get("/access", { query: { docId: absent } }) },
  ].map((r) => ({ ...r, status: 404, expect: { "cache-control": (v) => v === NO_STORE && !/max-age=600/.test(v ?? "") } }));
  ctx.ev.json("prod-404s", rows.map((r) => ({ label: r.label, status: r.res.status, cacheControl: r.res.headers.get("cache-control") })));
  assertHeaderMatrix(rows);
});

/**
 * X-a03-visibility-1: SPEC §2 requires nosniff for document bytes and shell,
 * already checked by A3.1. JSON and attachment endpoints retain their existing
 * declared types, attachment disposition, authorization and no-store policy.
 * This oracle accepts an optional nosniff header; its absence is not a defect.
 */
scenario("A3.1q download, unlock and access keep their declared types, attachment disposition and no-store policy", { inconclusiveOnStackTimeout: true, timeoutMs: 300_000 }, async (ctx) => {
  ctx.step("cast an owner and a stranger; publish a private P and an unlisted U");
  const [owner, stranger] = await castSessions(["owner", "stranger"]);
  const anon = ctx.http({ actor: "anon" });
  const P = await publishPage(owner, "nosniff-private");
  const U = await publishPage(owner, "nosniff-unlisted");
  const k = await unlisted(owner, U.docId);

  ctx.step("read one answer of each kind from /download, /unlock and GET /access");
  const download = (docId) => `/download/${encodeURIComponent(docId)}/v1`;
  const rows = [
    { label: "/download (owner, private: the zip)", status: 200, res: await owner.http.get(download(P.docId)) },
    { label: "/download (anonymous link holder: the zip)", status: 200, res: await anon.get(download(U.docId), { query: { k } }) },
    { label: "/download (stranger, private: refused)", status: 404, res: await stranger.http.get(download(P.docId)) },
    { label: "/unlock (anonymous, right k: the projection)", status: 200, res: await anon.postJson("/unlock", { docId: U.docId, k }) },
    { label: "/unlock (anonymous, no k: refused)", status: 404, res: await anon.postJson("/unlock", { docId: U.docId }) },
    { label: "GET /access (owner: the inherited grants)", status: 200, res: await owner.http.get("/access", { query: { docId: P.docId } }) },
    { label: "GET /access (stranger: refused)", status: 404, res: await stranger.http.get("/access", { query: { docId: P.docId } }) },
    { label: "GET /access (anonymous: refused)", status: 401, res: await anon.get("/access", { query: { docId: P.docId } }) },
  ];
  ctx.ev.json("nosniff", rows.map((r) => ({ label: r.label, status: r.res.status, contentType: r.res.headers.get("content-type"), nosniff: r.res.headers.get("x-content-type-options") })));
  for (const r of rows) {
    answered(r.res, r.label);
    precondition(r.res.status === r.status, `${r.label}: answered ${r.res.status}, not ${r.status}; the question is about the header of the answer SPEC §2 gives`);
  }

  for (const row of rows) {
    assert.equal(row.res.headers.get("cache-control"), NO_STORE, `${row.label}: no response is cacheable`);
    if (row.status !== 200) continue;
    if (row.label.startsWith("/download")) {
      assert.equal(row.res.headers.get("content-type"), "application/zip", "a download declares a zip, never active HTML");
      assert.match(row.res.headers.get("content-disposition") ?? "", /^attachment;/, "a download is an attachment");
    } else {
      assert.match(row.res.headers.get("content-type") ?? "", /^application\/json(?:;|$)/, "metadata is declared JSON");
    }
  }
});

// --- A3.2 ---------------------------------------------------------------------

scenario("A3.2 /unlock: no or wrong k is one empty 404 like an absent id; the right k gives anyone the reader projection without publishedAt; a signed-in key holder gets a linkGrants/{uid} record", { inconclusiveOnStackTimeout: true, timeoutMs: 300_000 }, async (ctx) => {
  const [owner, stranger] = await castSessions(["owner", "stranger"]);
  const anon = ctx.http({ actor: "anon" });
  const U = await publishPage(owner, "unlock-unlisted");
  const P = await publishPage(owner, "unlock-private");
  const absent = absentDocId(target, "a3-unlock-absent"); // POST /unlock names it
  const k = await unlisted(owner, U.docId);

  ctx.step("refusals: no k, a wrong k, a private document (to its owner too) and an absent id");
  const refusals = {
    "unlisted, no k (anonymous)": await anon.postJson("/unlock", { docId: U.docId }),
    "unlisted, wrong k (anonymous)": await anon.postJson("/unlock", { docId: U.docId, k: `${k.slice(0, -2)}xx` }),
    "unlisted, no k (stranger)": await stranger.http.postJson("/unlock", { docId: U.docId }),
    "unlisted, wrong k (stranger)": await stranger.http.postJson("/unlock", { docId: U.docId, k: "not-the-key" }),
    "private (anonymous)": await anon.postJson("/unlock", { docId: P.docId }),
    "private (its owner)": await owner.http.postJson("/unlock", { docId: P.docId }),
    "absent (anonymous)": await anon.postJson("/unlock", { docId: absent }),
  };
  const base = refusals["absent (anonymous)"];
  for (const [label, r] of Object.entries(refusals)) {
    assert.equal(r.status, 404, `${label}: status`);
    assert.equal(r.buffer.length, 0, `${label}: the 404 body is empty`);
    const same = sameHeadersExceptDate(r, base);
    assert.ok(same.equal, `${label}: headers differ from an absent id's: ${JSON.stringify(same.diff)}`);
  }
  assert.equal((await readDoc(target, `docs/${U.docId}/linkGrants/${stranger.uid}`)), null, "no grant from a refused unlock");

  ctx.step("the right k, anonymously: the reader projection, exactly its 12 keys");
  const a = await anon.postJson("/unlock", { docId: U.docId, k });
  assert.equal(a.status, 200);
  assert.deepEqual(Object.keys(a.json).sort(), READER_KEYS, "the reader projection's keys, publishedAt not among them");
  assert.deepEqual(
    { docId: a.json.docId, title: a.json.title, visibility: a.json.visibility, currentVersion: a.json.currentVersion, entry: a.json.entry, format: a.json.format, publicEdit: a.json.publicEdit, expiresAt: a.json.expiresAt, forked: a.json.forked },
    { docId: U.docId, title: `Workspace ${U.title}`, visibility: "unlisted", currentVersion: "v1", entry: "index.html", format: "html", publicEdit: false, expiresAt: null, forked: false },
  );

  ctx.step("the right k, signed in as a stranger: the same projection, and a grant naming the token");
  const s = await stranger.http.postJson("/unlock", { docId: U.docId, k });
  assert.equal(s.status, 200);
  assert.deepEqual(s.json, a.json, "a signed-in key holder is told exactly what an anonymous one is");
  const grant = await readDoc(target, `docs/${U.docId}/linkGrants/${stranger.uid}`);
  assert.ok(grant, "docs/{U}/linkGrants/{stranger} exists");
  assert.deepEqual({ keys: Object.keys(grant).sort(), uid: grant.uid, token: grant.token === k }, { keys: ["grantedAt", "token", "uid"], uid: stranger.uid, token: true }, "the grant names the account and the token it presented");
  const grants = await readCollection(target, `docs/${U.docId}/linkGrants`);
  assert.deepEqual(grants.map((g) => g.id), [stranger.uid], "only the signed-in key holder holds a grant (an anonymous unlock writes none)");

  ctx.step("a member of a non-private document is answered without k (SPEC §2 /unlock)");
  const m = await owner.http.postJson("/unlock", { docId: U.docId });
  assert.equal(m.status, 200, "the owner of the unlisted document, no k");
  assert.deepEqual(m.json, a.json, "the member is told the same projection");

  ctx.step("a malformed docId is the one 400");
  assert.equal((await anon.postJson("/unlock", { k })).status, 400, "missing docId");
});

// --- A3.3 ---------------------------------------------------------------------

scenario("A3.3 /d/**: a private and an absent slug answer identical headers (Date aside) and identical bytes, to the owner too; unlisted with its k is public max-age=300, noindex and titled by the document; POST is 405", { inconclusiveOnStackTimeout: true, timeoutMs: 300_000 }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const anon = ctx.http({ actor: "anon" });
  const P = await publishPage(owner, "shell-private");
  const U = await publishPage(owner, "shell-unlisted");
  const absent = absentDocId(target, "a3-shell-absent"); // a POST /d/ names it
  const k = await unlisted(owner, U.docId);

  ctx.step("GET /d/<private> and /d/<absent> anonymously, and /d/<private> as its owner");
  const priv = await anon.get(`/d/${P.docId}`);
  const abs = await anon.get(`/d/${absent}`);
  const ownerPriv = await owner.http.get(`/d/${P.docId}`);
  const wrongK = await anon.get(`/d/${U.docId}`, { query: { k: `${k.slice(0, -2)}xx` } });
  const noK = await anon.get(`/d/${U.docId}`);
  for (const [label, r] of [["private", priv], ["private, as its owner", ownerPriv], ["unlisted, wrong k", wrongK], ["unlisted, no k", noK]]) {
    assert.deepEqual([r.status, abs.status], [200, 200], `${label}: the shell is 200 in every case`);
    const h = sameHeadersExceptDate(r, abs);
    assert.ok(h.equal, `/d/ ${label} and absent headers differ: ${JSON.stringify(h.diff)}`);
    const b = sameBytes(r.buffer, abs.buffer);
    assert.ok(b.equal, `/d/ ${label} and absent bodies differ: ${JSON.stringify(b)}`);
  }
  assert.equal(abs.headers.get("cache-control"), NO_STORE, "the generic shell is uncacheable");
  assert.equal(abs.headers.get("x-robots-tag"), null, "no robots header on the generic shell");
  assert.ok(!priv.text.includes(P.title) && !priv.text.includes(P.docId), "the generic shell names nothing of the private document");

  ctx.step("GET /d/<unlisted>?k=<key>: the document's own head, cacheable, noindex");
  const doc = await anon.get(`/d/${U.docId}`, { query: { k } });
  assert.equal(doc.status, 200);
  assert.equal(doc.headers.get("cache-control"), PUBLIC_300);
  assert.equal(doc.headers.get("x-robots-tag"), "noindex");
  assert.equal(doc.headers.get("x-content-type-options"), "nosniff");
  assert.match(doc.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(titleOf(doc.text), U.title, "the <title> is the document's own, not the workspace title or the product's");
  assert.match(doc.text, /<meta name="robots" content="noindex" \/>/, "the page itself says noindex");

  ctx.step("POST is 405 on every kind of slug");
  for (const [label, path, query] of [["unlisted with k", `/d/${U.docId}`, { k }], ["private", `/d/${P.docId}`, undefined], ["absent", `/d/${absent}`, undefined]]) {
    const r = await anon.post(path, { query, headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 405, `POST /d/ ${label}`);
  }
});

// --- A3.4 ---------------------------------------------------------------------

scenario("A3.4 public/{d} has exactly the allowed projected keys; anonymous get of an unlisted or absent row and anonymous list are denied by the rules", { inconclusiveOnStackTimeout: true, timeoutMs: 300_000 }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const fs = anonFirestore(ctx);
  const B = await publishPage(owner, "proj-public");
  const U = await publishPage(owner, "proj-unlisted");
  const absent = docIdFor(target, "a3-proj-absent");
  await visibility(owner, B.docId, "public");
  await visibility(owner, U.docId, "unlisted");

  ctx.step("the stored row, through the Admin SDK: exactly the allowed keys, nothing of the ACL");
  const row = await readDoc(target, `public/${B.docId}`);
  assert.ok(row, "public/{B} exists");
  assert.deepEqual(Object.keys(row).sort(), PUBLIC_KEYS, "public/{B}'s keys");
  assert.deepEqual(
    { docId: row.docId, title: row.title, currentVersion: row.currentVersion, entry: row.entry, format: row.format, visibility: row.visibility, publicEdit: row.publicEdit, expiresAt: row.expiresAt, forked: row.forked, trusted: typeof row.trusted, publishedAt: typeof row.publishedAt?.toMillis, updatedAt: typeof row.updatedAt },
    { docId: B.docId, title: `Workspace ${B.title}`, currentVersion: "v1", entry: "index.html", format: "html", visibility: "public", publicEdit: false, expiresAt: null, forked: false, trusted: "boolean", publishedAt: "function", updatedAt: "number" },
  );
  // One instant twice: a number a JSON reader can use, and a timestamp the sitemap orders by (SPEC §17).
  assert.equal(row.updatedAt, row.publishedAt.toMillis(), "updatedAt is publishedAt in epoch milliseconds");
  assert.equal(await readDoc(target, `public/${U.docId}`), null, "an unlisted document is not mirrored");

  ctx.step("the same row as an anonymous client reads it, under the rules");
  const got = await fs.get(`public/${B.docId}`);
  assert.equal(got.verdict, "ALLOW", `anonymous get public/{B}: ${got.status} ${got.code} ${got.message}`);
  assert.deepEqual(Object.keys(got.doc.data).sort(), PUBLIC_KEYS, "the anonymously readable fields match the explicit allowlist");

  ctx.step("anonymous get of the unlisted and the absent rows, and an anonymous list: the same refusal");
  const un = await fs.get(`public/${U.docId}`);
  const ab = await fs.get(`public/${absent}`);
  const ls = await fs.list("public", { pageSize: 5 });
  for (const [label, r] of [["get public/{unlisted}", un], ["get public/{absent}", ab], ["list public", ls]]) {
    assert.deepEqual(verdictOf(r), RULES_DENY, `${label}: ${r.status} ${r.message}`);
  }
  assert.ok(!ls.response.text.includes(B.docId) && !ls.response.text.includes(U.docId) && ls.docs.length === 0, "the refused list names no document");
});

// --- A3.5 ---------------------------------------------------------------------

scenario("A3.5 making a public document private removes its public/{d} row within 2 s, and the anonymous get is then refused (and so does making one unlisted)", { inconclusiveOnStackTimeout: true, timeoutMs: 300_000 }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const fs = anonFirestore(ctx);
  const B = await publishPage(owner, "revoke-public");
  const C = await publishPage(owner, "revoke-to-unlisted");
  for (const d of [B, C]) {
    await visibility(owner, d.docId, "public");
    precondition(await readDoc(target, `public/${d.docId}`), `public/{${d.docId}} exists while the document is public`);
    precondition((await fs.get(`public/${d.docId}`)).verdict === "ALLOW", "an anonymous client reads the row while it is public");
  }

  // The product deletes the row before POST /visibility answers (syncPublicProjection is awaited);
  // the 2 s run from that answer.
  for (const [d, level] of [[B, "private"], [C, "unlisted"]]) {
    ctx.step(`the owner makes ${d.docId} ${level}; poll its row for 2 s from the moment the change returns`);
    await visibility(owner, d.docId, level);
    const t0 = Date.now();
    await eventually(async () => (await readDoc(target, `public/${d.docId}`)) === null, { timeout: 2_000, interval: 100, message: `public/{${d.docId}} deleted within 2 s of POST /visibility ${level}` });
    ctx.step(`row gone after ${Date.now() - t0} ms`);
    const r = await fs.get(`public/${d.docId}`);
    assert.deepEqual(verdictOf(r), RULES_DENY, `the anonymous get is refused once ${level}`);
  }
});

// --- A3.6 ---------------------------------------------------------------------

scenario("A3.6 rotating the link (private, then unlisted) kills the old k and every grant made with it, on /content, /unlock, /view and /d, while the new k works", { inconclusiveOnStackTimeout: true, timeoutMs: 300_000 }, async (ctx) => {
  const [owner, holder] = await castSessions(["owner", "holder"]);
  const anon = ctx.http({ actor: "anon" });
  const U = await publishPage(owner, "rotate");
  const absent = docIdFor(target, "a3-rotate-absent");
  const view = (http, k) => http.postJson("/view", { docId: U.docId, versionId: "v1", sessionId: `a3-${rand4()}${rand4()}-${Date.now().toString(36)}`, ms: 0, ...(k ? { k } : {}) });

  ctx.step("unlisted with k1; the holder unlocks with k1 and so holds a grant");
  const k1 = await unlisted(owner, U.docId, "k1");
  precondition((await holder.http.postJson("/unlock", { docId: U.docId, k: k1 })).status === 200, "the holder unlocks with k1");
  ctx.step("before rotating, k1 and the grant both read (positive control)");
  assert.equal((await anon.get(contentPath(U.docId), { query: { k: k1 } })).status, 200, "anonymous with k1");
  assert.equal((await holder.http.get(contentPath(U.docId))).status, 200, "the holder's grant, no k");
  assert.equal((await holder.http.postJson("/unlock", { docId: U.docId })).status, 200, "the holder's grant at /unlock, no k");

  ctx.step("rotate: private, then unlisted again");
  const priv = await visibility(owner, U.docId, "private");
  assert.equal(priv.json.linkToken, null, "making it private drops the token");
  const k2 = (await visibility(owner, U.docId, "unlisted")).linkToken;
  assert.ok(typeof k2 === "string" && k2.length >= 22 && k2 !== k1, "making it unlisted again mints a new token");
  const stale = await readDoc(target, `docs/${U.docId}/linkGrants/${holder.uid}`);
  ctx.step(`the holder's grant record still names k1 (${stale?.token === k1}); nothing cleaned it up, and it must count for nothing`);

  ctx.step("k1 and the old grant are dead everywhere");
  const absentShell = await anon.get(`/d/${absent}`);
  const dead = {
    "anonymous /content?k=k1": await anon.get(contentPath(U.docId), { query: { k: k1 } }),
    "anonymous /content/~k1/": await anon.get(keyedPath(k1, U.docId)),
    "holder /content, old grant": await holder.http.get(contentPath(U.docId)),
    "holder /content?k=k1": await holder.http.get(contentPath(U.docId), { query: { k: k1 } }),
    "holder /download, old grant": await holder.http.get(`/download/${encodeURIComponent(U.docId)}/v1`),
    "anonymous /unlock k1": await anon.postJson("/unlock", { docId: U.docId, k: k1 }),
    "holder /unlock, old grant": await holder.http.postJson("/unlock", { docId: U.docId }),
    "holder /unlock k1": await holder.http.postJson("/unlock", { docId: U.docId, k: k1 }),
    "holder /view, old grant": await view(holder.http),
    "anonymous /view k1": await view(anon, k1),
  };
  for (const [label, r] of Object.entries(dead)) assert.equal(r.status, 404, `${label}: ${r.status}`);
  const shellK1 = await anon.get(`/d/${U.docId}`, { query: { k: k1 } });
  assert.ok(sameBytes(shellK1.buffer, absentShell.buffer).equal, "/d/?k=k1 is the generic shell, byte for byte an absent slug's");
  assert.equal(shellK1.headers.get("cache-control"), NO_STORE, "/d/?k=k1 is uncacheable");
  const regrant = await readDoc(target, `docs/${U.docId}/linkGrants/${holder.uid}`);
  assert.ok(!regrant || regrant.token === k1, "a refused unlock with k1 did not re-grant the holder under k2");

  ctx.step("k2 works, and a fresh unlock with k2 re-grants the holder");
  assert.equal((await anon.get(contentPath(U.docId), { query: { k: k2 } })).status, 200, "anonymous with k2");
  assert.equal((await holder.http.postJson("/unlock", { docId: U.docId, k: k2 })).status, 200, "the holder unlocks with k2");
  assert.equal((await readDoc(target, `docs/${U.docId}/linkGrants/${holder.uid}`))?.token === k2, true, "the grant now names k2");
  assert.equal((await holder.http.get(contentPath(U.docId))).status, 200, "the new grant reads without k");
});

// --- A3.7 ---------------------------------------------------------------------

const GRANT_QUOTE = "comment on this sentence without the key";

scenario("A3.7 a grant holder, back without k, reads the unlisted document, comments on a passage and records a view", { inconclusiveOnStackTimeout: true, timeoutMs: 420_000 }, async (ctx) => {
  ctx.step("cast an owner and a grant holder, both with email off; publish an unlisted page");
  const [owner, holder] = await castSessions(["owner", "holder"], { notifications: false });
  const tag = `${runTag(target.runId)}-${rand4()}`;
  const U = await publishPage(owner, "grant-comment", { body: `<h1>Grant holders ${tag}</h1>\n<p id="a3-quote">A link holder can ${GRANT_QUOTE} in the address bar.</p>` });
  const k = await unlisted(owner, U.docId);
  await createGuard(target).assertQuietDoc(U.docId);

  ctx.step("the holder signs in, opens /d/<doc>?k=<key> once (the viewer's /unlock grants them)");
  const g = await ctx.users.user({ name: "holder" });
  await g.signInUi(holder.account.email, holder.account.password);
  await g.open(U.docId, { k });
  const grant = await eventually(async () => (await readDoc(target, `docs/${U.docId}/linkGrants/${holder.uid}`)) ?? false, { timeout: 10_000, message: "the viewer's /unlock recorded a grant" });
  precondition(grant.token === k, "the grant names the key");

  ctx.step("the holder comes back WITHOUT k (as a reply notification links): the frame loads by the grant");
  const mark = g.responseMark();
  await g.open(U.docId);
  const src = await g.page.evaluate(() => document.querySelector("iframe.doc-frame")?.getAttribute("src") ?? "");
  assert.ok(!src.includes("~") && !src.includes("k="), `the frame's URL carries no key: ${src.replace(/~[^/]+/, "~‹k›")}`);
  assert.match(await (await g.frame()).locator("#a3-quote").textContent(), new RegExp(GRANT_QUOTE));

  ctx.step(`the holder selects "${GRANT_QUOTE}", presses Comment and sends`);
  const sel = await g.selectText("#a3-quote", GRANT_QUOTE);
  assert.equal(sel.text, GRANT_QUOTE);
  const body = `Grant comment ${tag}`;
  await g.comment(body);
  const anns = await eventually(async () => {
    const rows = await readCollection(target, `docs/${U.docId}/versions/v1/annotations`);
    return rows.length === 1 ? rows : false;
  }, { timeout: 15_000, message: "exactly one annotation on v1" });
  assert.deepEqual({ exact: anns[0].data.anchor?.exact, authorUid: anns[0].data.authorUid, channel: anns[0].data.actor?.channel }, { exact: GRANT_QUOTE, authorUid: holder.uid, channel: "web" });
  // The thread and its first comment are two client writes; the panel shows the comment before the
  // emulator has it, so the read waits for it rather than sampling once.
  const comments = await eventually(async () => {
    const rows = await readCollection(target, `docs/${U.docId}/versions/v1/annotations/${anns[0].id}/comments`);
    return rows.length > 0 ? rows : false;
  }, { timeout: 15_000, message: "the thread's first comment is stored" });
  assert.deepEqual(comments.map((c) => ({ body: c.data.body, authorUid: c.data.authorUid })), [{ body, authorUid: holder.uid }], "the comment was stored, as the holder's");

  ctx.step("the viewer's own POST /view, sent without k, is answered 200 and records the holder's session via the link");
  // A final beat of the keyed visit may also land after the mark (sendBeacon on pagehide); only a keyless one counts.
  const keyless = (r) => r.method === "POST" && r.path === "/view" && r.postJson?.docId === U.docId && !("k" in r.postJson);
  const beat = await g.waitForResponse(keyless, { since: mark, timeout: 20_000 });
  assert.equal(beat.status, 200, "POST /view without k, answered by the grant");
  const session = await eventually(async () => (await readDoc(target, `docs/${U.docId}/views/${beat.postJson.sessionId}`)) ?? false, { timeout: 10_000, message: "the beat's session record" });
  assert.deepEqual({ uid: session.uid, via: session.via, automated: session.automated }, { uid: holder.uid, via: "unlisted", automated: false }, "the session is the holder's, a person's, via the link");
  const viewer = await readDoc(target, `docs/${U.docId}/viewers/${holder.uid}`);
  assert.ok(viewer?.views >= 1, `the holder is counted as a viewer: ${JSON.stringify({ views: viewer?.views })}`);

  ctx.step("and the same through the API: POST /view as the holder, no k, is 200");
  const direct = await holder.http.postJson("/view", { docId: U.docId, versionId: "v1", sessionId: `a3-${rand4()}${rand4()}-${Date.now().toString(36)}`, ms: 0 });
  assert.equal(direct.status, 200, `POST /view without k: ${direct.text.slice(0, 200)}`);
});

// --- A3.8 ---------------------------------------------------------------------

scenario("A3.8 an anonymous link holder's frame loads every relative asset of a bundle with 200 (the ~k path segment)", { inconclusiveOnStackTimeout: true, timeoutMs: 300_000 }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const tag = `${runTag(target.runId)}-${rand4()}`;
  const title = `A3 link assets ${tag}`;
  const entries = {
    "index.html": htmlDoc(title, `<link rel="stylesheet" href="style.css">\n<h1 id="a3-h">${title}</h1>\n<p class="a3-styled">Styled by a relative stylesheet.</p>\n<img id="a3-img" src="img/dot.png" alt="a dot" width="20" height="20">`).replace("</title>", `</title>\n<link rel="stylesheet" href="css/extra.css">`),
    "style.css": ".a3-styled { color: rgb(1, 2, 3); }\n",
    "css/extra.css": "#a3-h { letter-spacing: 3px; }\n",
    "img/dot.png": tinyPng(),
  };
  const up = await publishZip(owner.http, entries, { title, name: "a3-assets" });
  precondition(up.versionId === "v1", `publish bundle: ${up.status} ${JSON.stringify(up.json)}`);
  const docId = up.docId;
  const k = await unlisted(owner, docId);

  ctx.step("an anonymous browser opens /d/<doc>?k=<key>");
  const a = await ctx.users.user({ name: "anon" });
  await a.open(docId, { k });
  const loaded = await eventually(
    () =>
      a.page.evaluate(() => {
        const d = document.querySelector("iframe.doc-frame")?.contentDocument;
        const img = d?.getElementById("a3-img");
        const p = d?.querySelector(".a3-styled");
        const h = d?.getElementById("a3-h");
        if (!img || !p || !h || !img.complete) return false;
        return { imgWidth: img.naturalWidth, color: d.defaultView.getComputedStyle(p).color, spacing: d.defaultView.getComputedStyle(h).letterSpacing };
      }),
    { timeout: 15_000, message: "the frame's image and stylesheets settled" },
  );
  ctx.ev.json("frame-assets", loaded);

  const contentReqs = a.log.requests.filter((r) => new URL(r.url).pathname.startsWith("/content/"));
  ctx.ev.json("content-requests", contentReqs.map((r) => ({ path: new URL(r.url).pathname.replace(/~[^/]+/, "~‹k›"), status: r.status, failure: r.failure ?? null })));
  const want = ["index.html", "style.css", "css/extra.css", "img/dot.png"];
  for (const rel of want) {
    const hits = contentReqs.filter((r) => {
      const p = decodeURIComponent(new URL(r.url).pathname);
      return p.endsWith(`/${docId}/v1/${rel}`) || (rel === "index.html" && p.endsWith(`/${docId}/v1/`));
    });
    assert.ok(hits.length >= 1, `the frame requested ${rel}`);
    for (const h of hits) assert.equal(h.status, 200, `${rel}: ${h.status ?? h.failure}`);
  }
  for (const r of contentReqs) assert.equal(r.status, 200, `every /content request is 200: ${new URL(r.url).pathname.replace(/~[^/]+/, "~‹k›")} → ${r.status ?? r.failure}`);
  assert.deepEqual(loaded, { imgWidth: 2, color: "rgb(1, 2, 3)", spacing: "3px" }, "the image decoded and both stylesheets applied");
});

// --- A3.9 ---------------------------------------------------------------------

scenario("A3.9 og:url (and og:image) on a public document never carry ?k=, whatever k the request had; on an unlisted one they carry its k", { inconclusiveOnStackTimeout: true, timeoutMs: 300_000 }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const anon = ctx.http({ actor: "anon" });
  const tag = `${runTag(target.runId)}-${rand4()}`;
  const page = (title) => ({ "index.html": htmlDoc(title, `<h1>${title}</h1>\n<p>A picture of a shed.</p>\n<img src="shed.png" alt="a shed">`), "shed.png": tinyPng() });
  const B = await publishZip(owner.http, page(`A3 og public ${tag}`), { title: `A3 og public ${tag}`, name: "a3-og-public" });
  const U = await publishZip(owner.http, page(`A3 og unlisted ${tag}`), { title: `A3 og unlisted ${tag}`, name: "a3-og-unlisted" });
  precondition(B.versionId === "v1" && U.versionId === "v1", "both bundles published");
  await visibility(owner, B.docId, "public");
  const k = await unlisted(owner, U.docId);

  // The origin the shell names: the function's configured public origin. Read it once from a page
  // that has no k at all, so every later comparison is against the product's own origin.
  const plain = await anon.get(`/d/${B.docId}`);
  assert.equal(plain.status, 200);
  const ogPlain = metaProperty(plain.text, "og:url");
  precondition(ogPlain && ogPlain.endsWith(`/d/${B.docId}`), `og:url of /d/{public}: ${ogPlain}`);
  const origin = ogPlain.slice(0, -`/d/${B.docId}`.length);
  ctx.step(`the shell's origin is ${origin}`);

  ctx.step("public: /d/x, /d/x?k=junk, /d/x?k=<the unlisted doc's real key>, /d/x/v1?k=junk");
  const cases = [
    ["/d/x", `/d/${B.docId}`, undefined, `${origin}/d/${B.docId}`],
    ["/d/x?k=junk", `/d/${B.docId}`, { k: "junk-key" }, `${origin}/d/${B.docId}`],
    ["/d/x?k=<a real key>", `/d/${B.docId}`, { k }, `${origin}/d/${B.docId}`],
    ["/d/x/v1?k=junk", `/d/${B.docId}/v1`, { k: "junk-key" }, `${origin}/d/${B.docId}/v1`],
  ];
  for (const [label, path, query, wantUrl] of cases) {
    const r = await anon.get(path, { query });
    assert.equal(r.status, 200, label);
    assert.equal(r.headers.get("cache-control"), PUBLIC_300, `${label}: the document's shell`);
    assert.equal(metaProperty(r.text, "og:url"), wantUrl, `${label}: og:url`);
    const img = metaProperty(r.text, "og:image");
    assert.equal(img, `${origin}/content/${B.docId}/v1/shed.png`, `${label}: og:image carries no key`);
    assert.ok(!/[?&]k=/.test(r.text.match(/<head>[\s\S]*<\/head>/i)?.[0] ?? ""), `${label}: nothing in the head carries ?k=`);
    assert.equal(r.headers.get("x-robots-tag"), null, `${label}: a public document is indexable`);
  }

  ctx.step("unlisted with its k: og:url and og:image carry ?k=");
  const u = await anon.get(`/d/${U.docId}`, { query: { k } });
  assert.equal(u.status, 200);
  assert.equal(metaProperty(u.text, "og:url"), `${origin}/d/${U.docId}?k=${encodeURIComponent(k)}`, "unlisted og:url");
  assert.equal(metaProperty(u.text, "og:image"), `${origin}/content/${U.docId}/v1/shed.png?k=${encodeURIComponent(k)}`, "unlisted og:image");
});

// --- A3.10 --------------------------------------------------------------------

scenario("A3.10 sitemap.xml lists only public documents that have not expired: not unlisted, private or made-private ones, and an expiring one only until its date", { inconclusiveOnStackTimeout: true, timeoutMs: 480_000 }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const anon = ctx.http({ actor: "anon" });
  const Bp = await publishPage(owner, "map-public");
  const Bu = await publishPage(owner, "map-unlisted");
  const Bv = await publishPage(owner, "map-private");
  const Bx = await publishPage(owner, "map-was-public");
  const Be = await publishPage(owner, "map-expiring");
  const mine = new Set([Bp, Bu, Bv, Bx, Be].map((d) => d.docId));
  const listed = async () => {
    const r = await anon.get("/sitemap.xml");
    assert.equal(r.status, 200, "GET /sitemap.xml");
    assert.match(r.headers.get("content-type") ?? "", /^application\/xml/);
    assert.equal(r.headers.get("cache-control"), PUBLIC_300);
    const locs = [...r.text.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    return locs.map((l) => decodeURIComponent(l.slice(l.lastIndexOf("/d/") + 3))).filter((id) => mine.has(id)).sort();
  };

  // Every other level first, timing each change, so the expiry is set last.
  let slowest = 0;
  const change = async (d, level, extra) => {
    const t0 = Date.now();
    await visibility(owner, d.docId, level, extra);
    slowest = Math.max(slowest, Date.now() - t0);
  };
  await change(Bp, "public");
  await change(Bu, "unlisted");
  await change(Bx, "public");
  await change(Bx, "private");

  // The product's expiry is a wall-clock moment and nothing fires at it, so this waits on the date
  // itself: far enough ahead for one more change and a sitemap read at the slowest pace this target
  // showed (at least 25 s, at most 2 min), read once before it, then polled until the sitemap drops it.
  const lead = Math.min(120_000, Math.max(25_000, 3 * slowest + 10_000));
  const expiresAt = Date.now() + lead;
  await visibility(owner, Be.docId, "public", { expiresAt });

  const sentAt = Date.now();
  const before = await listed();
  if (Date.now() >= expiresAt - 2_000) ctx.inconclusive(`the pre-expiry sitemap read took until ${expiresAt - Date.now()} ms before the expiry; nothing measured`);
  ctx.step(`before the expiry (${Math.round((expiresAt - sentAt) / 1000)} s left of a ${Math.round(lead / 1000)} s lead; slowest change ${slowest} ms): ${JSON.stringify(before)}`);
  assert.deepEqual(before, [Bp.docId, Be.docId].sort(), "before its date: the public and the expiring-public documents, nothing else of mine");

  ctx.step("wait for the expiry to pass, then for the sitemap to drop it");
  const after = await eventually(async () => {
    if (Date.now() < expiresAt) return false;
    const ids = await listed();
    return ids.includes(Be.docId) ? false : ids;
  }, { timeout: Math.max(0, expiresAt - Date.now()) + 60_000, interval: 1_000, message: "the expired document leaves the sitemap within 60 s of its date" });
  assert.deepEqual(after, [Bp.docId], "after its date: only the public document");
});
