// SPDX-License-Identifier: Apache-2.0
// A15 Forks: the signed-out fork that completes once after sign-in, the fork's record and count, lineage per caller, and the refusals (SPEC §21).

/**
 * SPEC §21, measured as a reader would meet it, each case with its own
 * accounts and documents:
 *
 *   A15.1  a signed-out reader presses Fork on a public document: the intent
 *          travels as ?fork=1 through /signup?next=, the fork is made once
 *          the document resolves as the account, the parameter is gone from
 *          the URL BEFORE the request goes, and going back to that page and
 *          reloading it makes no second fork
 *   A15.1b the same on an unlisted document opened with its key: the key
 *          travels with the intent, and the request goes only once the
 *          account's link grant exists
 *   A15.2  the fork's record: private, trusted:false (from a trusted public
 *          source), forked:true and nothing naming the parent, the caller's
 *          default marking (not the source's), no stats; v1 with
 *          publishedVia "fork" and the source's bytes (REHASH); the server-only
 *          forks/{id} pointer, which no client may get or list; the source's
 *          stats.forks up by exactly one per fork, its other stats and its
 *          updatedAt untouched
 *   A15.3  lineage over two hops (origin A → B → C): per caller, nearest
 *          first; ownerEmail only where the caller is a member; `changed` on
 *          the nearest parent only; the walk stops at the first parent the
 *          caller cannot open and says so; forks listed for the owner only,
 *          counted when hidden; a stranger gets the absent id's 404
 *   A15.3b a key opens only the document it was presented for: an unlisted
 *          parent is hidden from a fork's lineage until the caller holds its
 *          link grant, whatever key the lineage request carries
 *   A15.4  folders: a stranger's folder is refused 403 and an absent one 404,
 *          each saying why and writing nothing; the caller's own folder files
 *          the fork
 *   A15.4b a folder the caller VIEWS is refused too; made its editor, the
 *          fork is filed there and inherits the folder's members
 *   A15.4c an expired source is the absent id's bare 404 to a viewer (fork
 *          and lineage), writing nothing; its owner still forks it
 *   A15.4d "Fork this version" on an old version forks that version's bytes,
 *          which pass REHASH
 *
 * Waits on time: A15.4c waits for the expiry instant (the product's own
 * clock). A15.1 holds an absence for a few seconds after the page is ready,
 * because "no second fork" has no event to wait for.
 *
 * When the stack does not answer: on a loaded shared stack a function call
 * can go unanswered (Hosting's cut-off 504 at 60 s, or the client's own
 * deadline), so nothing was measured. Every case is inconclusiveOnStackTimeout,
 * and the browser cases inconclusiveOnPageStall as well. Every session's
 * client is made with `cutoffError`, so a cut-off 504 that a helper would
 * return (a fork, a lineage, a folder) throws E2E_STACK_CUTOFF instead of
 * reaching a precondition as an answer. The setup calls that may be sent
 * again are sent again (lib/test.mjs untilLanded): POST /session,
 * POST /trust and POST /marking, which are idempotent, and POST /publish,
 * POST /access and POST /visibility, whose effect is looked for first (the
 * lib's `patient`). A fork, a folder, a folder grant, a new version, an unlock
 * and a view are never sent again, nor A15.4c's expiry, whose date is counted
 * from its first send: one whose answer was lost ends the case INCONCLUSIVE.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { currentTarget, precondition, scenario, untilLanded } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { absentDocId, createFolder, fork, ledgerDoc, publish, updateUpload } from "../../lib/seed.mjs";
import { closeWindows, setVisibility, share, shareFolder } from "../../lib/grant.mjs";
import { closeAdmin, queryCollection, readCollection, readDoc, listObjects } from "../../lib/admin.mjs";
import { clientFirestore } from "../../lib/firestore-client.mjs";
import { eventually, sameBytes, sameHeadersExceptDate } from "../../lib/assert.mjs";
import { entryHtml, rehashZip } from "../../lib/bytes.mjs";
import { zipFiles } from "../../lib/zipread.mjs";
import { frameText } from "../../lib/frame.mjs";
import { observeForkOrder } from "../../lib/fork-order.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const BOTH = ["local", "prod"];
const SECOND = 1000;
/**
 * Every wait on the app's own UI. Generous because the Firestore emulator of a
 * shared stack has answered the app's Listen channel in 8-10 s under load, so
 * a document can sit on "Opening the document…" for most of a minute.
 */
const UI_WAIT_MS = 90 * SECOND;
/**
 * Each case's own bound. On a saturated shared stack every function call has
 * taken 10-60 s (POST /trust 50 s, POST /session 45 s, a fork 60 s), so a case
 * whose requests are each answered has run for 410 s. Nothing waits on this:
 * every request (60 s) and every UI wait has a bound of its own.
 */
const CASE_TIMEOUT_MS = 600 * SECOND;
/** The file's budget: every case at its bound, one after another (node:test runs a file's cases in sequence). */
export const E2E_FILE_TIMEOUT_MS = 9 * CASE_TIMEOUT_MS;
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** SPEC §21 "forks/{forkDocId} is { parentId, parentVersion, parentContentHash, forkedAt }". */
const FORK_RECORD_KEYS = ["forkedAt", "parentContentHash", "parentId", "parentVersion"];
/** functions/src/lib/folders.ts resolveFolderTarget: the two refusals, each about the request. */
const FOLDER_FORBIDDEN = "you cannot put anything in that folder";
const FOLDER_ABSENT = "destination folder not found";

// --- helpers ------------------------------------------------------------------

/** A small document with a marker of its own, so every version's bytes differ. */
function docHtml(title, marker) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<h1>${title}</h1>
<p id="a15-1">A fork copies one version: ${marker}.</p>
<p id="a15-2">A second paragraph, so the page has some length.</p>
</body>
</html>
`;
}

/**
 * One session per role, by role. POST /session is idempotent, so one the stack
 * did not answer is sent again (untilLanded), and the case ends INCONCLUSIVE
 * when that keeps happening. The client throws E2E_STACK_CUTOFF for Hosting's
 * cut-off 504 (`cutoffError`), so no request of the case reads it as an answer.
 */
async function sessions(ctx, roles) {
  const accounts = await cast(target, roles, { notifications: false });
  const out = {};
  for (const a of accounts) {
    out[a.role] = (await untilLanded(ctx, `POST /session (${a.role})`, () => openSession(target, a, { cutoffError: true }), null)).out;
  }
  return out;
}

/** A unique tag for this case's titles. */
const caseTag = () => `${runTag(target.runId)}-${rand4()}`;

/**
 * Publish a small document as `s`; v1 or the case fails here. A publish the
 * stack did not answer is looked for, then sent again (the lib's `patient`).
 */
async function publishDoc(ctx, s, name, title) {
  const marker = `a15-${name}-${rand4()}${rand4()}`;
  const html = docHtml(title, marker);
  const up = await publish(s.http, { body: html, filename: "index.html", title, name, patient: { ctx } });
  precondition(up.versionId === "v1", `publish ${name}: ${up.status} ${JSON.stringify(up.json)}`);
  return { docId: up.docId, title, html, marker };
}

/** A new version of `docId` with new bytes, as its owner; v<n> or the case fails here. */
async function republish(s, doc, baseVersion, want) {
  const marker = `a15-update-${rand4()}${rand4()}`;
  const html = docHtml(doc.title, marker);
  const r = await updateUpload(s.http, doc.docId, { body: html, filename: "index.html", baseVersion });
  precondition(r.status === 200 && r.json?.versionId === want, `update ${doc.docId}: ${r.status} ${JSON.stringify(r.json)}`);
  return { html, marker };
}

/**
 * POST /fork {op: "create"} as `s` (seed.mjs fork(), which ledgers what a 200
 * made); whatever it answers: {status, json, docId, versionId, response}.
 */
function forkAs(s, docId, extra = {}) {
  return fork(s.http, { docId, ownerEmail: s.account.email, ...extra });
}

/** POST /fork {op: "create"} as `s`; 200 or the case fails here. */
async function mustFork(s, docId, extra = {}) {
  const r = await forkAs(s, docId, extra);
  precondition(r.status === 200 && r.docId, `POST /fork create ${docId} as ${s.account.role}: ${r.status} ${r.response.text.slice(0, 200)}`);
  return r.json;
}

/** A fork the app's Fork button made, ledgered the moment the page names it, before anything else does. */
function ledgerUiFork(forkId, sourceId, ownerEmail, actor) {
  ledgerDoc(target, { docId: forkId, via: "fork-ui", ownerEmail, actor, versionId: "v1", forkOf: sourceId });
}

/** POST /fork {op: "lineage"} as `http`, with the link key `k` if given. */
function lineageAs(http, docId, k = null) {
  return http.postJson("/fork", { op: "lineage", docId, ...(k ? { k } : {}) });
}

/** The lineage answer as `s`; 200 or the case fails here. forkedAt is reduced to its type, the only thing the SPEC fixes about it. */
async function lineageOf(s, docId, k = null) {
  const r = await lineageAs(s.http, docId, k);
  precondition(r.status === 200 && r.json, `POST /fork lineage ${docId} as ${s.account.role}: ${r.status} ${r.text.slice(0, 200)}`);
  const out = structuredClone(r.json);
  for (const f of out.forks?.visible ?? []) f.forkedAt = typeof f.forkedAt;
  return out;
}

/** The server-only forks/{id} records naming `parentId`, read with the Admin SDK: forks/* is shared by every spec on a stack. */
async function forksNaming(parentId) {
  const rows = await queryCollection(target, "forks", [["parentId", "==", parentId]]);
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/** docs/{id} through the Admin SDK; it must exist. */
async function record(docId) {
  const d = await readDoc(target, `docs/${docId}`);
  precondition(d, `docs/${docId} exists`);
  return d;
}

/** A version record through the Admin SDK; it must exist. */
async function versionRecord(docId, versionId) {
  const v = await readDoc(target, `docs/${docId}/versions/${versionId}`);
  precondition(v, `docs/${docId}/versions/${versionId} exists`);
  return v;
}

/** The stored bytes of a version as `http` downloads them: the entry HTML and the REHASH of the zip. */
async function stored(http, docId, versionId) {
  const r = await http.get(`/download/${encodeURIComponent(docId)}/${encodeURIComponent(versionId)}`);
  precondition(r.status === 200, `GET /download/${docId}/${versionId}: ${r.status}`);
  const html = entryHtml(zipFiles(r.buffer));
  const re = await rehashZip(r.buffer, { target });
  return { html, rehash: re.contentHash, fileCount: re.fileCount };
}

/** A rules-evaluated Firestore read's outcome, reduced to what a refusal is. */
const rule = (r) => ({ status: r.status, code: r.code, verdict: r.verdict });

/** POST /folder as `s` (seed.mjs createFolder(), which ledgers it); its id, or the case fails here. */
async function folderOf(s, name) {
  const r = await createFolder(s.http, { name, ownerEmail: s.account.email, expect: null });
  precondition(r.status === 200 && r.folderId, `POST /folder as ${s.account.role}: ${r.status} ${r.response.text.slice(0, 200)}`);
  return r.folderId;
}

/**
 * A window on `docId` for the length of `fn`: opened by a patient
 * setVisibility (one the stack did not answer is looked for in the record,
 * then sent again), and closed as soon as `fn` returns by closeWindows (which
 * never throws). When `fn` throws, or that close does not land, the case's
 * own end closes the window, and FAILS a case whose body passed if it cannot
 * (grant.mjs WINDOWS). `expiresAt: null` is sent explicitly, because leaving
 * it out clears an expiry (suspect S25).
 */
async function windowOn(ctx, owner, docId, visibility, fn) {
  const opened = await setVisibility(target, { owner, doc: docId, visibility, expiresAt: null, patient: { ctx } });
  const out = await fn(opened);
  await closeWindows();
  return out;
}

/**
 * POST `path` with `body` as `s`, sent again when the stack did not answer it
 * (untilLanded): only for a request whose effect is the same however many
 * times it lands, such as POST /trust or POST /marking with a fixed value.
 */
async function idempotent(ctx, s, path, body) {
  return (await untilLanded(ctx, `POST ${path}`, () => s.http.postJson(path, body), null)).out;
}

/**
 * `fn`'s value once it has held still for `ms` (sampled every 250 ms, up to
 * `ms` × 5 in all): an absence has no event to wait for, so it is a settle.
 */
async function settled(fn, ms) {
  const deadline = Date.now() + ms * 5;
  let value = await fn();
  let since = Date.now();
  while (Date.now() - since < ms && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const now = await fn();
    if (JSON.stringify(now) !== JSON.stringify(value)) {
      value = now;
      since = Date.now();
    }
  }
  return value;
}

/** The path segment after /d/ when the page shows a document other than `sourceId`, else null. */
function openedOther(u, sourceId) {
  const m = /^\/d\/([^/]+)$/.exec(new URL(u.page.url()).pathname);
  return m && decodeURIComponent(m[1]) !== sourceId ? decodeURIComponent(m[1]) : null;
}

/** The labels of the viewer's More actions menu, left open. */
async function openMoreMenu(u) {
  await u.page.getByRole("button", { name: "More actions" }).click();
  const menu = u.page.getByRole("menu", { name: "More actions" });
  await menu.waitFor({ state: "visible", timeout: UI_WAIT_MS });
  return { menu, labels: (await menu.getByRole("menuitem").allTextContents()).map((s) => s.trim()) };
}

// --- A15.1 --------------------------------------------------------------------

/** How long "no second fork" must hold once the page is ready again. */
const NO_REFORK_HOLD_MS = 4 * SECOND;

/**
 * The signed-out fork, on a `visibility` ("public" or "unlisted") document.
 * Unlisted, the reader opens it with its key, the key travels through
 * /signup?next= with the intent, and the fork must go only once the document
 * has resolved AS the account — which, on an unlisted document, is what
 * records the link grant (SPEC §21 "Signed out"; app/src/viewer/useFork.ts).
 */
async function signedOutFork(ctx, visibility) {
  ctx.step(`cast an owner and a reader-to-be; the owner publishes a document and makes it ${visibility}`);
  const { owner: O } = await sessions(ctx, ["owner"]);
  const [forker] = await cast(target, ["forker"]);
  const tag = caseTag();
  const S = await publishDoc(ctx, O, `a15-1-${visibility}`, `A15.1 ${visibility} source ${tag}`);
  await windowOn(ctx, O, S.docId, visibility, async (opened) => {
    const k = visibility === "unlisted" ? opened.linkToken : null;
    precondition(visibility !== "unlisted" || (typeof k === "string" && k.length >= 22), "the unlisted document has a link key");
    const keyQuery = k ? `k=${encodeURIComponent(k)}&` : "";
    const u = await ctx.users.user({ name: "reader" });
    // Capture create order synchronously; hold the authenticated unlock answer
    // so a missing resolvedFor guard cannot win a fast local response race.
    const order = await observeForkOrder(u.page, { origin: target.origin, docId: S.docId, key: k });
    const creates = order.creates;
    try {

    ctx.step(`signed out, the reader opens the ${visibility} document${k ? " with its key" : ""} and presses Fork in the toolbar`);
    await u.goto(`/d/${encodeURIComponent(S.docId)}${k ? `?k=${encodeURIComponent(k)}` : ""}`);
    await u.waitForFrame({ timeout: UI_WAIT_MS });
    precondition(!(await u.sessionCookie()), "the reader is signed out");
    const forkButton = u.page.locator(".viewer-toolbar").getByRole("button", { name: "Fork", exact: true });
    await forkButton.waitFor({ state: "visible", timeout: UI_WAIT_MS });
    await forkButton.click();
    await u.poll(() => new URL(u.page.url()).pathname === "/signup", { timeout: UI_WAIT_MS, what: "the sign-in page" });
    const next = new URL(u.page.url()).searchParams.get("next");
    assert.equal(next, `/d/${S.docId}?${keyQuery}fork=1`, "the intent travels as ?fork=1 (with the key, if any) through /signup?next=");
    assert.equal(creates.length, 0, "nothing is forked while signed out");

    ctx.step("the reader signs in on that page; the app returns to the document and opens the fork it made");
    order.beginSignIn();
    await u.signInUi(forker.email, forker.password, { here: true, timeout: UI_WAIT_MS });
    const forkId = await u.poll(() => openedOther(u, S.docId), { timeout: UI_WAIT_MS, what: "the fork opened in the viewer" });
    ledgerUiFork(forkId, S.docId, forker.email, "reader");
    await u.waitForFrame({ timeout: UI_WAIT_MS });
    assert.ok((await frameText(await u.frame())).includes(S.marker), "the fork shows the source's text");

    ctx.step("the first request: from the source's page, for the current version" + (k ? ", carrying the key, after the authenticated unlock answered" : ""));
    precondition(creates.length >= 1, "the page sent a POST /fork create");
    const sent = new URL(creates[0].href);
    assert.deepEqual(
      { path: sent.pathname, k: sent.searchParams.get("k") === k, docId: creates[0].docId, versionId: creates[0].versionId, key: creates[0].k, unlockAnswered: creates[0].unlockAnswered },
      { path: `/d/${S.docId}`, k: true, docId: S.docId, versionId: null, key: k ? "the link key" : null, unlockAnswered: k ? true : null },
      "the first POST /fork create",
    );
    const made = await record(forkId);
    assert.deepEqual({ ownerUid: made.ownerUid, ownerEmail: made.ownerEmail, forked: made.forked }, { ownerUid: forker.uid, ownerEmail: forker.email, forked: true }, "the fork is the reader's account's");

    ctx.step("back to the page the intent arrived on, then reload it; let the page settle");
    await u.page.goBack({ waitUntil: "load" });
    await u.waitForFrame({ timeout: UI_WAIT_MS });
    const back = new URL(u.page.url());
    await u.page.reload({ waitUntil: "load" });
    await u.waitForFrame({ timeout: UI_WAIT_MS });
    // The intent's effect runs in the render that resolves the document as the
    // account, which comes before the frame loads: a second fork would already
    // be on its way. An absence has no event to wait for, so the count must
    // hold still for a few seconds.
    const settledCreates = await settled(() => creates.length, NO_REFORK_HOLD_MS);

    ctx.step("once: the intent was gone from the URL when the request went and from the history entry, and going back and reloading made no second fork");
    const cells = {
      intentAtSend: sent.searchParams.get("fork"),
      backEntry: { path: back.pathname, fork: back.searchParams.get("fork") },
      createsAfterReload: settledCreates,
      forks: (await forksNaming(S.docId)).map((f) => f.id),
      statsForks: (await record(S.docId)).stats?.forks ?? 0,
    };
    assert.deepEqual(
      cells,
      { intentAtSend: null, backEntry: { path: `/d/${S.docId}`, fork: null }, createsAfterReload: 1, forks: [forkId], statsForks: 1 },
      `the signed-out fork, once: ${JSON.stringify(cells)}`,
    );
    } finally {
      await order.restore();
    }
  });
}

scenario("A15.1 a signed-out reader's Fork on a public document goes through sign-in and completes exactly once: ?fork=1 is gone from the URL before POST /fork, and going back and reloading forks nothing more", {
  tiers: BOTH,
  timeoutMs: CASE_TIMEOUT_MS,
  inconclusiveOnPageStall: true,
}, (ctx) => signedOutFork(ctx, "public"));

scenario("A15.1b the same on an unlisted document opened with its key: the key travels through sign-in with the intent, and the fork goes once, after the account's link grant exists", {
  tiers: BOTH,
  timeoutMs: CASE_TIMEOUT_MS,
  inconclusiveOnPageStall: true,
}, (ctx) => signedOutFork(ctx, "unlisted"));

// --- A15.2 --------------------------------------------------------------------

scenario("A15.2 a fork of a trusted public document is private, trusted:false, forked:true and marked by the forker's default, with nothing naming its parent; v1 is publishedVia fork with the source's bytes (REHASH); forks/{id} is server-only; stats.forks counts each fork once and nothing else moves", {
  tiers: BOTH,
  timeoutMs: CASE_TIMEOUT_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  ctx.step("cast an owner and a reader; the owner publishes a document, trusts it for everyone and makes it public");
  const { owner: O, reader: R } = await sessions(ctx, ["owner", "reader"]);
  const tag = caseTag();
  const S = await publishDoc(ctx, O, "a15-2-src", `A15.2 source ${tag}`);
  const trust = await idempotent(ctx, O, "/trust", { docId: S.docId, trusted: true });
  precondition(trust.status === 200 && trust.json?.trusted === true, `POST /trust: ${trust.status} ${trust.text.slice(0, 200)}`);
  ctx.step("the owner marks the source's exports; the reader's account has a default marking of its own");
  const ownerMarking = { enabled: true, label: `Owner policy ${tag}`, footer: "owner footer" };
  const readerDefault = { enabled: true, label: `Reader default ${tag}`, footer: "" };
  const marked = await idempotent(ctx, O, "/marking", { docId: S.docId, marking: ownerMarking });
  precondition(marked.status === 200, `POST /marking: ${marked.status} ${marked.text.slice(0, 200)}`);
  // The account default is the app's own client write to users/{uid} (Account page); set here directly.
  const preferences = await clientFirestore(target, { idToken: R.idToken, http: ctx.http({ actor: "reader-preferences" }) }).set(
    `users/${R.uid}`, { uid: R.uid, email: R.account.email, defaultMarking: readerDefault }, { merge: true },
  );
  precondition(preferences.verdict === "ALLOW", `the reader writes their default marking under the rules: ${preferences.status}`);
  const { token } = await mintToken(O, { name: `a15 source feedback ${tag}`, channel: "mcp" });
  const agent = ctx.mcp({ token, actor: "source-feedback", cutoffError: true });
  await agent.initialize();
  const thread = await agent.ok("add_comment", { id: S.docId, exact: S.marker, body: `Source-only comment ${tag}` });
  precondition(typeof thread.threadId === "string" && (await readCollection(target, `docs/${S.docId}/versions/v1/annotations`)).length === 1, "the source has feedback that could be copied");

  await windowOn(ctx, O, S.docId, "public", async () => {
    const view = await R.http.postJson("/view", { docId: S.docId, versionId: "v1", sessionId: `a15${randomBytes(8).toString("hex")}`, ms: 1000 });
    precondition(view.status === 200, `POST /view as the reader: ${view.status}`);
    const before = await record(S.docId);
    precondition(before.trusted === true && before.visibility === "public", `the source is trusted and public: ${JSON.stringify({ trusted: before.trusted, visibility: before.visibility })}`);
    const srcV1 = await versionRecord(S.docId, "v1");

    ctx.step("the reader, who is not a member, forks it with POST /fork, as the viewer's Fork does");
    const made = await mustFork(R, S.docId);
    assert.deepEqual({ versionId: made.versionId, title: made.title }, { versionId: "v1", title: S.title }, "the answer: v1, the source's title");
    const forkId = made.docId;

    ctx.step("docs/{fork}: the reader's, private, trusted:false, forked:true, at the root; nothing in it names the source");
    const rec = await record(forkId);
    assert.deepEqual(
      { ownerUid: rec.ownerUid, ownerEmail: rec.ownerEmail, title: rec.title, currentVersion: rec.currentVersion, visibility: rec.visibility, publicEdit: rec.publicEdit, trusted: rec.trusted, forked: rec.forked, folderId: rec.folderId, members: rec.members },
      { ownerUid: R.uid, ownerEmail: R.account.email, title: S.title, currentVersion: "v1", visibility: "private", publicEdit: false, trusted: false, forked: true, folderId: null, members: [R.account.email] },
      "the fork's record",
    );
    assert.ok(!JSON.stringify(rec).includes(S.docId), `docs/{fork} carries only forked:true, never the parent's id: ${JSON.stringify(Object.keys(rec).sort())}`);
    assert.deepEqual(rec.marking, readerDefault, "the fork's marking is the reader's account default, not the source owner's policy");
    assert.equal(rec.stats, undefined, "views are not copied: the fork has no stats");
    assert.deepEqual(await readCollection(target, `docs/${forkId}/versions/v1/annotations`), [], "the fork copies no source annotations or comments");
    assert.equal(await readDoc(target, `public/${forkId}`), null, "a private fork has no public projection");

    ctx.step("public and unlisted fork projections retain only the forked flag, never the parent id");
    await setVisibility(target, { owner: R, doc: forkId, visibility: "public", expiresAt: null, patient: { ctx } });
    const publicFork = await readDoc(target, `public/${forkId}`);
    assert.equal(publicFork?.forked, true, "the public fork projection says forked:true");
    assert.ok(!JSON.stringify(publicFork).includes(S.docId), "the public fork projection never names its parent");
    const unlistedFork = await setVisibility(target, { owner: R, doc: forkId, visibility: "unlisted", expiresAt: null, patient: { ctx } });
    const unlockFork = await ctx.http({ actor: "anonymous-fork" }).postJson("/unlock", { docId: forkId, k: unlistedFork.linkToken });
    assert.equal(unlockFork.status, 200, "the unlisted fork key unlocks");
    assert.equal(unlockFork.json?.forked, true, "the unlock answer says forked:true");
    assert.ok(!JSON.stringify(unlockFork.json).includes(S.docId), "the unlock answer never names the parent");
    await setVisibility(target, { owner: R, doc: forkId, visibility: "private", expiresAt: null, patient: { ctx } });

    ctx.step("its only version is v1, publishedVia fork, with the source's hash; the downloaded bytes are the source's and REHASH to it");
    const versions = await readCollection(target, `docs/${forkId}/versions`);
    assert.deepEqual(versions.map((v) => v.id), ["v1"], "the fork's versions");
    const v1 = versions[0].data;
    assert.deepEqual(
      { publishedVia: v1.publishedVia, parentVersion: v1.parentVersion, publishedByEmail: v1.publishedByEmail, contentHash: v1.contentHash },
      { publishedVia: "fork", parentVersion: null, publishedByEmail: R.account.email, contentHash: srcV1.contentHash },
      "the fork's v1 record",
    );
    const bytes = await stored(R.http, forkId, "v1");
    assert.equal(sha(Buffer.from(bytes.html)), sha(Buffer.from(S.html)), "the fork's index.html is the source's upload");
    assert.equal(bytes.rehash, v1.contentHash, "REHASH of the fork's v1");

    ctx.step("forks/{fork}: exactly the four keys, naming the source's v1 and its hash");
    const ptr = await readDoc(target, `forks/${forkId}`);
    assert.ok(ptr, "forks/{fork} exists");
    assert.deepEqual(Object.keys(ptr).sort(), FORK_RECORD_KEYS, "forks/{fork}'s keys");
    assert.deepEqual(
      { parentId: ptr.parentId, parentVersion: ptr.parentVersion, parentContentHash: ptr.parentContentHash, forkedAt: typeof ptr.forkedAt?.toMillis },
      { parentId: S.docId, parentVersion: "v1", parentContentHash: srcV1.contentHash, forkedAt: "function" },
    );

    ctx.step("no client may read forks/*: not the fork's owner, not the source's owner, not anonymously; the same token reads the fork's own record");
    const fsHttp = ctx.http({ actor: "firestore" });
    const asR = clientFirestore(target, { idToken: R.idToken, http: fsHttp });
    const asO = clientFirestore(target, { idToken: O.idToken, http: fsHttp });
    const asAnon = clientFirestore(target, { idToken: null, http: fsHttp });
    const own = await asR.get(`docs/${forkId}`);
    precondition(own.verdict === "ALLOW" && own.doc?.id === forkId, `the reader's token reads docs/{fork} under the rules: ${own.status} ${own.code} ${own.message}`);
    const reads = {
      "get forks/{fork} as the fork's owner": rule(await asR.get(`forks/${forkId}`)),
      "list forks as the fork's owner": rule(await asR.list("forks", { pageSize: 5 })),
      "get forks/{fork} as the source's owner": rule(await asO.get(`forks/${forkId}`)),
      "get forks/{fork} anonymously": rule(await asAnon.get(`forks/${forkId}`)),
    };
    const refused = { status: 403, code: "PERMISSION_DENIED", verdict: "DENY" };
    assert.deepEqual(reads, Object.fromEntries(Object.keys(reads).map((k) => [k, refused])), "forks/* is server-only under the rules");

    ctx.step("the source: stats.forks is 1; its other stats, its trust and its updatedAt did not move");
    const after1 = await record(S.docId);
    const { forks: f0, ...rest0 } = before.stats ?? {};
    const { forks: f1, ...rest1 } = after1.stats ?? {};
    assert.deepEqual({ before: f0 ?? 0, after: f1 }, { before: 0, after: 1 }, "stats.forks after one fork");
    assert.deepEqual(rest1, rest0, "the source's other stats are untouched");
    assert.ok(typeof rest0.views === "number" && rest0.views >= 1, `the view counter existed to be clobbered: ${JSON.stringify(rest0)}`);
    assert.deepEqual({ trusted: after1.trusted, updatedAt: after1.updatedAt?.toMillis?.() }, { trusted: true, updatedAt: before.updatedAt?.toMillis?.() }, "a fork is not a publish of the source");

    ctx.step("a second fork, titled: its own id from its title, and stats.forks is 2");
    const title2 = `A15.2 second ${tag}`;
    const made2 = await mustFork(R, S.docId, { title: title2 });
    assert.equal(made2.title, title2);
    assert.equal(made2.docId.startsWith(title2.toLowerCase().replace(/[^a-z0-9]+/g, "-")), true, `the id comes from the title: ${made2.docId}`);
    assert.equal((await record(S.docId)).stats?.forks, 2, "stats.forks after two forks");
    assert.deepEqual((await forksNaming(S.docId)).map((f) => f.id).sort(), [forkId, made2.docId].sort(), "forks/* naming the source");
  });
});

// --- A15.3 --------------------------------------------------------------------

scenario("A15.3 lineage over two hops: nearest first, ownerEmail only to a member, changed on the nearest parent only, the walk stops at the first parent the caller cannot open, forks for the owner only (hidden ones counted), a stranger's 404", {
  tiers: BOTH,
  timeoutMs: CASE_TIMEOUT_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  ctx.step("cast four accounts and a stranger: A's owner, B's owner, C's owner, C's viewer");
  const { oa: Oa, ob: Ob, oc: Oc, dv: D, editor: E, approver: P, stranger: X } = await sessions(ctx, ["oa", "ob", "oc", "dv", "editor", "approver", "stranger"]);
  const tag = caseTag();
  const A = await publishDoc(ctx, Oa, "a15-3-origin", `A15.3 origin ${tag}`);

  await windowOn(ctx, Oa, A.docId, "public", async () => {
    ctx.step("B's owner forks the public A into B and shares B with C's owner; C's owner forks B into C and shares C with B's owner and with D");
    const Bt = `A15.3 middle ${tag}`;
    const B = (await mustFork(Ob, A.docId, { title: Bt })).docId;
    await share(target, { owner: Ob, doc: B, account: Oc.account, role: "viewer", patient: { ctx } });
    const Ct = `A15.3 leaf ${tag}`;
    const C = (await mustFork(Oc, B, { title: Ct })).docId;
    await share(target, { owner: Oc, doc: C, account: Ob.account, role: "viewer", patient: { ctx } });
    await share(target, { owner: Oc, doc: C, account: D.account, role: "viewer", patient: { ctx } });

    await share(target, { owner: Oc, doc: C, account: E.account, role: "editor", patient: { ctx } });
    await share(target, { owner: Oc, doc: C, account: P.account, role: "approver", patient: { ctx } });
    const aEntry = { docId: A.docId, title: A.title, versionId: "v1" };
    const bEntry = (changed) => ({ docId: B, title: Bt, versionId: "v1", ownerEmail: Ob.account.email, changed });
    const cListing = { docId: C, title: Ct, visibility: "private", forkedAt: "number", ownerEmail: Oc.account.email };

    ctx.step("unchanged: every caller's answer");
    assert.deepEqual(await lineageOf(Oc, C), {
      forked: true,
      ancestors: [bEntry(false), aEntry],
      hiddenAncestor: false,
      forks: { total: 0, hidden: 0, visible: [] },
    }, "lineage of C as its owner (a member of B, a public reader of A)");
    assert.deepEqual(await lineageOf(D, C), { forked: true, ancestors: [], hiddenAncestor: true }, "lineage of C as its viewer, who cannot open B");
    for (const member of [E, P]) assert.deepEqual(await lineageOf(member, C), { forked: true, ancestors: [], hiddenAncestor: true }, `lineage omits the owner's fork inventory for ${member.account.role}`);
    assert.deepEqual(await lineageOf(Ob, B), {
      forked: true,
      ancestors: [{ ...aEntry, changed: false }],
      hiddenAncestor: false,
      forks: { total: 1, hidden: 0, visible: [cListing] },
    }, "lineage of B as its owner (a public reader of A, a member of C)");
    assert.deepEqual(await lineageOf(Oa, A.docId), {
      forked: false,
      ancestors: [],
      hiddenAncestor: false,
      forks: { total: 1, hidden: 1, visible: [] },
    }, "lineage of A as its owner, who cannot open B");
    const stranger = await lineageAs(X.http, C);
    const absent = await lineageAs(X.http, absentDocId(target, "a15-3-absent"));
    assert.deepEqual({ status: stranger.status, bytes: stranger.buffer.length }, { status: 404, bytes: 0 }, "lineage of C as a stranger: the absent id's bare 404");
    assert.equal(sameHeadersExceptDate(stranger, absent).equal, true, `a stranger's refusal and an absent id's carry the same headers: ${JSON.stringify(sameHeadersExceptDate(stranger, absent).diff)}`);

    ctx.step("A alone publishes a v2: B's nearest parent is flagged changed; C's nearest parent (B) is not, and A, beyond it, carries no flag at all");
    await republish(Oa, A, "v1", "v2");
    assert.deepEqual((await lineageOf(Ob, B)).ancestors, [{ ...aEntry, changed: true }], "B's ancestors after A changed");
    assert.deepEqual((await lineageOf(Oc, C)).ancestors, [bEntry(false), aEntry], "C's ancestors after only A changed: the flag is the nearest parent's, never a farther one's");

    ctx.step("B publishes a v2 too: now C's nearest parent is flagged changed, and A still carries no flag");
    await republish(Ob, { docId: B, title: Bt }, "v1", "v2");
    assert.deepEqual((await lineageOf(Oc, C)).ancestors, [bEntry(true), aEntry], "C's ancestors after both changed");

    ctx.step("A goes private: the walk stops at it, and says so");
    await setVisibility(target, { owner: Oa, doc: A.docId, visibility: "private", expiresAt: null, patient: { ctx } });
    assert.deepEqual(await lineageOf(Oc, C), {
      forked: true,
      ancestors: [bEntry(true)],
      hiddenAncestor: true,
      forks: { total: 0, hidden: 0, visible: [] },
    }, "lineage of C as its owner once A is private");
    assert.deepEqual(await lineageOf(Ob, B), {
      forked: true,
      ancestors: [],
      hiddenAncestor: true,
      forks: { total: 1, hidden: 0, visible: [cListing] },
    }, "lineage of B as its owner once A is private");
  });
});

scenario("A15.3b a key opens only the document it was presented for: a parent reached only by its key is hidden from the fork's lineage, even with that key in the request, until the caller holds the parent's link grant", {
  tiers: BOTH,
  timeoutMs: CASE_TIMEOUT_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  ctx.step("cast an origin owner and a forker; the origin is unlisted; the forker forks it with its key, holding no link grant");
  const { oa: Oa, ob: Ob } = await sessions(ctx, ["oa", "ob"]);
  const tag = caseTag();
  const A = await publishDoc(ctx, Oa, "a15-3b-origin", `A15.3b origin ${tag}`);
  await windowOn(ctx, Oa, A.docId, "unlisted", async ({ linkToken: k }) => {
    precondition(typeof k === "string" && k.length >= 22, "the unlisted document has a link key");
    const grantPath = `docs/${A.docId}/linkGrants/${Ob.uid}`;
    const Bt = `A15.3b fork ${tag}`;
    const B = (await mustFork(Ob, A.docId, { title: Bt, k })).docId;
    precondition(!(await readDoc(target, grantPath)), "forking with the key recorded no link grant");
    const hidden = { forked: true, ancestors: [], hiddenAncestor: true, forks: { total: 0, hidden: 0, visible: [] } };

    ctx.step("without a grant the origin is hidden, and presenting the origin's key with the fork's lineage does not open it");
    assert.deepEqual(await lineageOf(Ob, B), hidden, "lineage of the fork, no grant on the origin");
    assert.deepEqual(await lineageOf(Ob, B, k), hidden, "lineage of the fork with the ORIGIN's key in the request");

    ctx.step("the forker opens the origin with its key while signed in (POST /unlock), which records the link grant; now the origin is listed, without its owner");
    const unlock = await Ob.http.postJson("/unlock", { docId: A.docId, k });
    precondition(unlock.status === 200 && (await readDoc(target, grantPath)), `POST /unlock recorded the forker's link grant: ${unlock.status}`);
    assert.deepEqual(await lineageOf(Ob, B), {
      forked: true,
      ancestors: [{ docId: A.docId, title: A.title, versionId: "v1", changed: false }],
      hiddenAncestor: false,
      forks: { total: 0, hidden: 0, visible: [] },
    }, "lineage of the fork once the forker holds the origin's grant");
    assert.deepEqual(await lineageOf(Oa, A.docId), { forked: false, ancestors: [], hiddenAncestor: false, forks: { total: 1, hidden: 1, visible: [] } }, "the origin's owner counts the fork it cannot open");
    const openedFork = await setVisibility(target, { owner: Ob, doc: B, visibility: "unlisted", expiresAt: null, patient: { ctx } });
    assert.deepEqual((await lineageOf(Oa, A.docId)).forks, { total: 1, hidden: 1, visible: [] }, "an unlisted descendant stays hidden without its own grant");
    assert.equal((await Oa.http.postJson("/unlock", { docId: B, k: openedFork.linkToken })).status, 200);
    assert.deepEqual((await lineageOf(Oa, A.docId)).forks, { total: 1, hidden: 0, visible: [{ docId: B, title: Bt, visibility: "unlisted", forkedAt: "number" }] }, "the descendant's own grant makes it visible, without its owner's email");
    const expiry = Date.now() + LEAD_MS;
    await setVisibility(target, { owner: Ob, doc: B, visibility: "public", expiresAt: expiry });
    await eventually(async () => (await Oa.http.get(`/content/${B}/v1/`)).status === 404, { timeout: TAKE_EFFECT_MS, interval: 500, message: "the descendant expires for the origin owner" });
    assert.deepEqual((await lineageOf(Oa, A.docId)).forks, { total: 1, hidden: 1, visible: [] }, "an expired public descendant is counted but hidden");
  });
});

// --- A15.4 --------------------------------------------------------------------

scenario("A15.4 a fork into a stranger's folder is 403 and into an absent folder 404, each saying why and writing nothing; into the caller's own folder it is filed there", {
  tiers: BOTH,
  timeoutMs: CASE_TIMEOUT_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  ctx.step("cast an owner, a reader and a stranger; the owner publishes a public document; the reader and the stranger each make a folder");
  const { owner: O, reader: R, stranger: T } = await sessions(ctx, ["owner", "reader", "stranger"]);
  const tag = caseTag();
  const S = await publishDoc(ctx, O, "a15-4-src", `A15.4 source ${tag}`);
  const mine = await folderOf(R, `A15.4 mine ${tag}`);
  const theirs = await folderOf(T, `A15.4 theirs ${tag}`);
  const nowhere = randomBytes(15).toString("base64url").replace(/[-_]/g, "x").slice(0, 20);
  precondition(!(await readDoc(target, `folders/${nowhere}`)), "the absent folder id names nothing");

  await windowOn(ctx, O, S.docId, "public", async () => {
    const wouldBe = S.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    ctx.step("into the stranger's folder: 403 with the reason; into an absent folder: 404 with the reason");
    const intoTheirs = await forkAs(R, S.docId, { folderId: theirs });
    assert.deepEqual(await listObjects(target, `docs/${wouldBe}/`), [], "a forbidden destination leaves no copied objects");
    const intoNowhere = await forkAs(R, S.docId, { folderId: nowhere });
    assert.deepEqual(await listObjects(target, `docs/${wouldBe}/`), [], "an absent destination leaves no copied objects");
    assert.deepEqual(
      { theirs: { status: intoTheirs.status, error: intoTheirs.json?.error ?? null }, nowhere: { status: intoNowhere.status, error: intoNowhere.json?.error ?? null } },
      { theirs: { status: 403, error: FOLDER_FORBIDDEN }, nowhere: { status: 404, error: FOLDER_ABSENT } },
      "the refusals, each about the request",
    );

    ctx.step("nothing was written: no fork, no pointer, no count, no document at the id the title would take");
    assert.deepEqual(await forksNaming(S.docId), [], "forks/* naming the source");
    assert.equal((await record(S.docId)).stats?.forks ?? 0, 0, "the source's stats.forks");
    assert.equal(await readDoc(target, `docs/${wouldBe}`), null, `docs/${wouldBe}`);

    ctx.step("into the reader's own folder: 200, filed there");
    const made = await mustFork(R, S.docId, { folderId: mine });
    const rec = await record(made.docId);
    assert.deepEqual({ folderId: rec.folderId, ownerEmail: rec.ownerEmail, visibility: rec.visibility }, { folderId: mine, ownerEmail: R.account.email, visibility: "private" });
    assert.equal((await record(S.docId)).stats?.forks, 1, "the source's stats.forks after the one fork that was made");
  });
});

scenario("A15.4b a fork into a folder the caller only views is 403 and writes nothing; made the folder's editor, the fork is filed there with the folder's members", {
  tiers: BOTH,
  effects: ["email:POST /folder-access"],
  timeoutMs: CASE_TIMEOUT_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  ctx.step("cast an owner, a reader and a folder owner; the owner publishes a public document; the folder owner makes a folder and shares it with the reader as a viewer");
  const { owner: O, reader: R, folder: F } = await sessions(ctx, ["owner", "reader", "folder"]);
  const tag = caseTag();
  const S = await publishDoc(ctx, O, "a15-4b-src", `A15.4b source ${tag}`);
  const folderId = await folderOf(F, `A15.4b shared ${tag}`);
  const asViewer = await shareFolder(target, { owner: F, folder: folderId, account: R.account, role: "viewer", expect: null });
  precondition(asViewer.status === 200, `POST /folder-access viewer: ${asViewer.status} ${asViewer.response.text.slice(0, 200)}`);
  const folder = await readDoc(target, `folders/${folderId}`);
  precondition(folder?.members?.includes(R.account.email) && !folder?.editorMembers?.includes(R.account.email), `the reader views the folder and does not edit it: ${JSON.stringify({ members: folder?.members, editorMembers: folder?.editorMembers })}`);

  await windowOn(ctx, O, S.docId, "public", async () => {
    ctx.step("a folder the reader can read but not edit: 403 with the reason, and nothing written");
    const refused = await forkAs(R, S.docId, { folderId });
    assert.deepEqual({ status: refused.status, error: refused.json?.error ?? null }, { status: 403, error: FOLDER_FORBIDDEN }, "into a folder the caller views");
    const wouldBe = S.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    assert.deepEqual(await listObjects(target, `docs/${wouldBe}/`), [], "a viewer-only destination leaves no copied objects");
    assert.deepEqual(await forksNaming(S.docId), [], "forks/* naming the source");
    assert.equal((await record(S.docId)).stats?.forks ?? 0, 0, "the source's stats.forks");

    ctx.step("the folder owner makes the reader its editor; the same fork is filed there and its members include the folder's");
    const asEditor = await shareFolder(target, { owner: F, folder: folderId, account: R.account, role: "editor", expect: null });
    precondition(asEditor.status === 200, `POST /folder-access editor: ${asEditor.status} ${asEditor.response.text.slice(0, 200)}`);
    const made = await mustFork(R, S.docId, { folderId });
    const rec = await record(made.docId);
    assert.deepEqual(
      { folderId: rec.folderId, ownerEmail: rec.ownerEmail, members: [...(rec.members ?? [])].sort() },
      { folderId, ownerEmail: R.account.email, members: [F.account.email, R.account.email].sort() },
      "the fork is filed in the folder and its members are the folder's",
    );
  });
});

// --- A15.4c -------------------------------------------------------------------

/** How far ahead the expiry is set, and how long after setting it the date must have taken effect. */
const LEAD_MS = 15 * SECOND;
const TAKE_EFFECT_MS = 40 * SECOND;

scenario("A15.4c an expired source is the absent id's bare 404 to its viewer for fork and lineage, and writes nothing; its owner still forks it", {
  tiers: BOTH,
  timeoutMs: CASE_TIMEOUT_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  ctx.step("cast an owner and a viewer; the owner publishes a document and shares it; the viewer forks it once while it is live");
  const { owner: O, viewer: V } = await sessions(ctx, ["owner", "viewer"]);
  const tag = caseTag();
  const S = await publishDoc(ctx, O, "a15-4c-src", `A15.4c source ${tag}`);
  await share(target, { owner: O, doc: S.docId, account: V.account, role: "viewer", patient: { ctx } });
  const live = await mustFork(V, S.docId);
  precondition((await record(S.docId)).stats?.forks === 1, "one fork while live");

  ctx.step(`the owner sets the expiry ${LEAD_MS / 1000} s ahead; wait for the date (the product's own clock), polling the viewer's read until it is refused`);
  const absent = absentDocId(target, "a15-4c-absent");
  const content = (id) => `/content/${encodeURIComponent(id)}/v1/index.html`;
  const setAt = Date.now();
  // Not patient: sent again after a lost answer, the date would already be past.
  await setVisibility(target, { owner: O, doc: S.docId, visibility: "private", expiresAt: setAt + LEAD_MS });
  await eventually(async () => (await V.http.get(content(S.docId))).status === 404, {
    timeout: Math.max(1000, setAt + TAKE_EFFECT_MS - Date.now()),
    interval: 500,
    message: `the viewer's GET /content becomes 404 within ${TAKE_EFFECT_MS / 1000} s of setting the expiry`,
  });

  ctx.step("the viewer's fork and lineage of the expired source, beside the same requests for an absent id");
  const forkExpired = (await forkAs(V, S.docId)).response;
  const forkAbsent = (await forkAs(V, absent)).response;
  const lineageExpired = await lineageAs(V.http, S.docId);
  const lineageAbsent = await lineageAs(V.http, absent);
  const shape = (r, a) => ({ status: r.status, bytes: r.buffer.length, sameBytes: sameBytes(r.buffer, a.buffer).equal, sameHeaders: sameHeadersExceptDate(r, a).equal });
  assert.deepEqual(
    { fork: shape(forkExpired, forkAbsent), lineage: shape(lineageExpired, lineageAbsent) },
    { fork: { status: 404, bytes: 0, sameBytes: true, sameHeaders: true }, lineage: { status: 404, bytes: 0, sameBytes: true, sameHeaders: true } },
    "an expired source answers its viewer as an absent id does",
  );
  assert.deepEqual((await forksNaming(S.docId)).map((f) => f.id), [live.docId], "no fork was made from the expired source");
  assert.equal((await record(S.docId)).stats?.forks, 1, "the source's stats.forks is unchanged");

  assert.deepEqual(await lineageOf(V, live.docId), { forked: true, ancestors: [], hiddenAncestor: true, forks: { total: 0, hidden: 0, visible: [] } }, "an expired source stops a live fork's ancestor walk");
  ctx.step("the owner, for whom it has not expired, still forks it");
  const ownFork = await mustFork(O, S.docId);
  assert.deepEqual((await lineageOf(O, ownFork.docId)).ancestors, [{ docId: S.docId, title: S.title, versionId: "v1", ownerEmail: O.account.email, changed: false }], "the source owner can still follow the expired ancestor");
  assert.deepEqual((await forksNaming(S.docId)).map((f) => f.id).sort(), [live.docId, ownFork.docId].sort(), "the owner's fork is recorded");
});

// --- A15.4d -------------------------------------------------------------------

scenario("A15.4d Fork this version, on an old version in the viewer, forks that version: the pointer names it, and the fork's bytes are its bytes and pass REHASH", {
  tiers: BOTH,
  timeoutMs: CASE_TIMEOUT_MS,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  ctx.step("cast an owner and a viewer; the owner publishes v1, then v2 with other bytes, and shares the document");
  const { owner: O, viewer: V } = await sessions(ctx, ["owner", "viewer"]);
  const tag = caseTag();
  const S = await publishDoc(ctx, O, "a15-4d-src", `A15.4d source ${tag}`);
  const v2 = await republish(O, S, "v1", "v2");
  await share(target, { owner: O, doc: S.docId, account: V.account, role: "viewer", patient: { ctx } });
  const [srcV1, srcV2] = [await versionRecord(S.docId, "v1"), await versionRecord(S.docId, "v2")];
  precondition(srcV1.contentHash && srcV1.contentHash !== srcV2.contentHash, "v1 and v2 hash differently");

  ctx.step("the viewer signs in; on the current version the menu offers Fork");
  const u = await ctx.users.user({ name: "viewer" });
  await u.signInUi(V.account.email, V.account.password, { timeout: UI_WAIT_MS });
  await u.open(S.docId, { timeout: UI_WAIT_MS });
  const head = await openMoreMenu(u);
  assert.ok(head.labels.includes("Fork") && !head.labels.includes("Fork this version"), `the menu on the current version: ${JSON.stringify(head.labels)}`);
  await u.page.keyboard.press("Escape");
  await head.menu.waitFor({ state: "detached", timeout: UI_WAIT_MS });

  ctx.step("on v1, the menu offers Fork this version; choosing it opens the fork");
  await u.open(S.docId, { v: "v1", timeout: UI_WAIT_MS });
  assert.ok((await frameText(await u.frame())).includes(S.marker), "the frame shows v1");
  const old = await openMoreMenu(u);
  assert.ok(old.labels.includes("Fork this version"), `the menu on v1: ${JSON.stringify(old.labels)}`);
  await old.menu.getByRole("menuitem", { name: "Fork this version", exact: true }).click();
  const forkId = await u.poll(() => openedOther(u, S.docId), { timeout: UI_WAIT_MS, what: "the fork opened in the viewer" });
  ledgerUiFork(forkId, S.docId, V.account.email, "viewer");
  await u.waitForFrame({ timeout: UI_WAIT_MS });

  ctx.step("forks/{fork} names v1 and v1's hash; the fork's v1 carries v1's hash, not v2's");
  const ptr = await readDoc(target, `forks/${forkId}`);
  assert.deepEqual({ parentId: ptr?.parentId, parentVersion: ptr?.parentVersion, parentContentHash: ptr?.parentContentHash }, { parentId: S.docId, parentVersion: "v1", parentContentHash: srcV1.contentHash }, "the pointer names the version on screen");
  const forkV1 = await versionRecord(forkId, "v1");
  assert.equal(forkV1.contentHash, srcV1.contentHash, "the fork's v1 hash is the source's v1 hash");
  assert.deepEqual((await readCollection(target, `docs/${forkId}/versions`)).map((v) => v.id), ["v1"], "forking an old version copies no other version records");
  assert.ok(typeof forkV1.storagePrefix === "string" && forkV1.storagePrefix.startsWith(`docs/${forkId}/`), "the fork names its own immutable storage prefix");
  assert.deepEqual(await listObjects(target, `docs/${forkId}/`), [`${forkV1.storagePrefix}/index.html`], "forking an old version copies only its selected bundle objects");

  ctx.step("REHASH: the fork's downloaded bytes are v1's upload and hash to the recorded contentHash");
  const bytes = await stored(V.http, forkId, "v1");
  assert.equal(sha(Buffer.from(bytes.html)), sha(Buffer.from(S.html)), `the fork's index.html is v1's (holds v2's marker: ${bytes.html.includes(v2.marker)})`);
  assert.equal(bytes.rehash, forkV1.contentHash, "REHASH of the fork's v1");
});
