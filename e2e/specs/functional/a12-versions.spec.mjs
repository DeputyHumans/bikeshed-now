// SPDX-License-Identifier: Apache-2.0
// Versions: identical updates dedup and keep trust, the version menu and pinned threads, the newer-version banner, S13, update refusals, stale bases, delete-version (SPEC §2, §4, §6a, §6c, §9, §17, §19).

/**
 * A12, one scenario per catalogue case:
 *
 *   12.1 an identical update is a no-op on every account channel
 *        (/publish?update=, update_document, an editor's in-app commit):
 *        the dedup answer, nothing minted, nothing uploaded, the record and
 *        both trust scopes untouched; a changed update then withdraws both
 *        (SPEC §2, §6c, §9.1, §19)
 *   12.2 the More menu lists the last eight versions, newest first, the
 *        current one labelled; a pinned version loads that version's bytes
 *        and shows that version's threads only (DocViewer.tsx, SPEC §6)
 *   12.3 a reader pinned to an older version gets the newer-version banner
 *        (Open / Stay here); an unpinned reader follows to the new version
 *        and never sees the banner (useLiveSync.ts)
 *   12.3 (a second new version) the unpinned reader's next new version
 *        must not insert a stale "Open v2" banner into the DOM, including
 *        under CPU throttling: X-a12-versions-3 (no paint claim)
 *   12.4 restoring historical bytes creates a new current version through
 *        draft commit, MCP, upload and the real editor. Existing history is
 *        immutable; only a match with the current version is a no-op.
 *   12.5 /publish?update= refusals: an editor 200, an open editor 403, id /
 *        folderId / title 400, a pending suggestion 409 pendingSuggestions,
 *        an accepted change in the draft 409 acceptedInDraft; a refusal
 *        uploads nothing (SPEC §2, §6a)
 *   12.6 a stale base is refused naming the current version on every
 *        channel; update_document counts threadsLeftBehind (SPEC §2, §19)
 *   12.6 (racing a commit) a POST /draft whose base a concurrent commit is
 *        superseding is answered 200 and leaves a draft on the superseded
 *        version, which GET /draft then serves to every editor: X-a12-versions-2
 *   12.7 scripts/delete-version.mjs (LOCAL): every refusal writes nothing,
 *        the dry run writes nothing, the real run repoints, deletes bytes,
 *        record, annotations, draft and thumbnails, retags views, and the
 *        withdrawn id is re-minted clean (SPEC §4, §9)
 *   12.7 (public projection) the withdrawal leaves public/{docId} naming the
 *        withdrawn version, so an anonymous reader of a public document loads
 *        a version that no longer exists: X-a12-versions-1
 *
 * A loaded shared stack answers late: inside one failed run of this file on
 * wr3h, POST /publish took 11 s, POST /access 12 s, POST /publish?update= 24 s,
 * POST /draft 11 s and 22 s, POST /commit 22 s, and a page's Firestore Listen
 * POST 11 s. None of that is the product answering, so:
 *   - every client waits past Hosting's cut-off (HTTP_MS) and is made with
 *     cutoffError, and every answer a page got that a case reads goes through
 *     lib's answered(): a request the stack never answered ends in Hosting's
 *     504 and the case INCONCLUSIVE, any other answer is judged;
 *   - setup calls (sessions, documents, grants, setup updates) are sent again
 *     only after looking for their effect (lib untilLanded, `patient`);
 *   - every case declares inconclusiveOnHttpStall and inconclusiveOnRequestStall
 *     (so inconclusiveOnCaseTimeout, inconclusiveOnPageStall and
 *     inconclusiveOnStackTimeout too): a wait or the case's budget that ran
 *     out while the stack stalled is INCONCLUSIVE, never an assertion;
 *   - a page's frame wait that runs out while its own Firestore Listen POST has
 *     gone unanswered for 10 s or more is INCONCLUSIVE too (listenStall,
 *     LIB-REQUEST listen-stall-evidence: the lib's pageStall cannot see it).
 *
 * Triage behind those last two (classification E, plus H for the waits): on a
 * fresh stack, A12.4's "no POST /draft started after the last edit was
 * answered within 20000 ms (save state "saving"; …)" is reproduced exactly
 * by holding that autosave 25 s in the browser, with the request sent and
 * unanswered, and four post-commit edits in a row each sent their autosave
 * one debounce after the last key; A12.3's "frame … /v2/ not reached within
 * 30000 ms" on "Opening the document…" after Open v2 is reproduced exactly,
 * with no console line, by holding the page's one Listen POST, and without a
 * hold the page loads v2 in 0.15 s.
 *
 * Negative controls: e2e/patches/controls-version-banner (12.3, the
 * unpinned reader's banner), controls-update-refusal-bytes (12.5, a refusal
 * uploads nothing), controls-delete-version-refusal (12.7, a refusal writes
 * nothing). 12.4's S13 assertions and 12.6's stale-base refusals and
 * threadsLeftBehind are controlled by spec mutations (each assertion seen red
 * with a copy that makes the product do what it would without the check),
 * since the unit's three control sets are spent. 12.1's trust reads are
 * proven live inside the case: the changed update at its end must, and does,
 * show both scopes withdrawn. Each defect case's oracle has been seen to pass
 * with its fix: e2e/patches/a12-fix-draft-race (X-a12-versions-2) and
 * a12-fix-stale-banner (X-a12-versions-3) as stack patches, and
 * X-a12-versions-1 by a spec mutation that re-syncs the projection after the
 * withdrawal.
 *
 * Only e2e/lib/ talks to the stack.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { answered, currentTarget, precondition, scenario, untilLanded } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { docIdFor, publish, publishOperator, updateUpload } from "../../lib/seed.mjs";
import { recordFinding, setVisibility, share } from "../../lib/grant.mjs";
import { readDraftObject, draftStoragePrefix, closeAdmin, listObjects, readCollection, readDoc, readObject, rtdbGet } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { frameText } from "../../lib/frame.mjs";
import { clientFirestore } from "../../lib/firestore-client.mjs";
import { postThumb } from "../../lib/thumbs.mjs";
import { runOperator } from "../../lib/operator.mjs";
import { FIRESTORE_LISTEN_PATH } from "../../lib/browser.mjs";
import { rtdbAs } from "../../lib/rtdb.mjs";
import { changeLog, settleLog } from "../../lib/changes.mjs";
import { logFile, logMark, readLog } from "../../lib/logs.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const sha = (b) => createHash("sha256").update(b).digest("hex");
const tag = () => `${runTag(target.runId)}-${rand4()}`;

const BOTH = ["local", "prod"];
/** A wait on the stack outlasts Hosting's own cut-off (59 s), so a stalled request ends in its 504 (lib answered()). */
const HTTP_MS = 150_000;
/** The autosave after the last key: wr3h answered POST /draft in 11.4 s and 22.5 s inside the run where the lib's default 20 s ran out. */
const AUTOSAVE_WAIT_MS = 90_000;
/** Save as new version is POST /draft, then POST /commit. */
const COMMIT_WAIT_MS = 150_000;
/** A page's frame after a navigation or a new version: a few Firestore round trips, each 11 s on a loaded stack. */
const FRAME_MS = 90_000;
/** Every case: a wait or a budget that ran out while the stack stalled is INCONCLUSIVE (see the header). */
const STALLS = { inconclusiveOnHttpStall: true, inconclusiveOnRequestStall: true };

// --- the product's words --------------------------------------------------------

/** functions/src/index.ts updateFromUpload. */
const UPDATE_KEEPS = "an update keeps the document's address, folder and title";
/** functions/src/index.ts updateFromUpload and functions/src/mcp/tools.ts update_document, for a stale baseVersion. */
const staleUpload = (cur, base) => `the document is at ${cur} now, not ${base}: somebody published since you read it. Read it again, then update that`;
const staleTool = (cur, base) => `the document is at ${cur} now, not ${base}: somebody published since you read it. Read it again with get_document, then update that`;
/** functions/src/index.ts saveDraft and commitVersion. */
const STALE_DRAFT = "This document has a newer version. Reload before editing.";
const STALE_COMMIT = "This document has a newer version. Reload before publishing.";
/** functions/src/lib/review.ts, for a count of one. */
const PENDING_ONE = "1 suggested edit is waiting for a decision. Only the owner or an approver can accept or reject it, and no new version can be published until then. If it is yours, you may withdraw it.";
const ACCEPTED_ONE = "This document's unpublished draft holds 1 accepted suggestion, and publishing this would replace the draft and lose it. Publish the draft first, with commit_draft or \"Save as new version\" in the app, then read the document again and update it.";
/** app/src/pages/DocViewer.tsx, the toast for a deduplicated commit. */
const DEDUP_TOAST = "No changes to publish — the content is identical.";
/** app/src/components/ViewerBanners.tsx. */
const NEWER_BANNER = "A newer version has been published.";

// --- helpers --------------------------------------------------------------------

/** A small HTML document whose text says which revision it is. */
function docHtml(title, rev, extra = "") {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    "</head>",
    "<body>",
    `<h1 id="a12-title">${title}</h1>`,
    `<p id="a12-rev">This is revision ${rev} of the versions document.${extra}</p>`,
    `<p id="a12-quote">A passage to comment on in revision ${rev}.</p>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
const quoteOf = (rev) => `A passage to comment on in revision ${rev}.`;

/** A session that waits past Hosting's cut-off and throws on it; POST /session is sent again if the stack did not answer. */
async function sessionFor(ctx, account) {
  const { out } = await untilLanded(ctx, `POST /session (${account.role ?? "account"})`, () => openSession(target, account, { timeoutMs: HTTP_MS, cutoffError: true }), null, { stopAt: "budget" });
  return out;
}

/** An owner with a session, and the rest of the cast as bare accounts. */
async function castWithOwner(ctx, roles) {
  const accounts = await cast(target, ["owner", ...roles]);
  const owner = await sessionFor(ctx, accounts[0]);
  return { owner, accounts };
}

/** POST /publish of a docHtml revision as the owner, sent again only after looking for it; v1, or the case cannot start. */
async function publishDoc(ctx, owner, { title, rev = 1, name }) {
  const up = await publish(owner.http, { body: docHtml(title, rev), filename: "index.html", title, name, timeoutMs: HTTP_MS, patient: { ctx, stopAt: "budget" } });
  precondition((up.landed || up.status === 200) && up.versionId === "v1", `publish answered ${up.status} ${JSON.stringify(up.json)}`);
  return up.docId;
}

/** A grant as setup: sent again only after looking for it. */
const grant = (ctx, owner, docId, account, role) => share(target, { owner, doc: docId, account, role, timeoutMs: HTTP_MS, patient: { ctx, stopAt: "budget" } });

const docRecord = (docId) => readDoc(target, `docs/${docId}`);
const versionRecord = (docId, v) => readDoc(target, `docs/${docId}/versions/${v}`);

scenario("A12.8 a failed postcommit projection refresh still returns 200 for the durable draft and serves its exact bytes", {
  tiers: ["local"], needs: ["admin-emulator", "logs", "patch:a12-projection-unavailable"], timeoutMs: 180_000,
}, async (ctx) => {
  const { owner } = await castWithOwner(ctx, []);
  const title = `Projection fault ${tag()}`;
  const docId = await publishDoc(ctx, owner, { title, name: "a12-projection" });
  const visibility = await setVisibility(target, { owner, doc: docId, visibility: "public", timeoutMs: HTTP_MS });
  precondition(visibility.status === 200, "the public projection exists before saving the draft");
  const before = await docRecord(docId);
  const html = docHtml(title, 2, " Exact durable bytes after projection failure.");
  const log = logFile(target.runId), since = logMark(log);
  // A thrown dependency may drop the response on the inverse build. Retain that
  // observation and inspect durable state before judging the required response.
  const response = await owner.http.postJson("/draft", { docId, baseVersion: "v1", liveEpoch: before.liveEpoch ?? "initial", html }, { timeoutMs: HTTP_MS })
    .catch((error) => ({ status: null, json: undefined, error: String(error?.message ?? error) }));
  const marker = `E2E_PROJECTION_UNAVAILABLE ${docId}`;
  await eventually(() => readLog(log, since).includes(marker), { timeout: 10_000, interval: 100, message: "the exact draft reached the injected projection transaction failure" });
  const after = await docRecord(docId);
  assert.equal(after.currentVersion, "v1", "postcommit projection: saving a draft does not mint a version");
  assert.equal(after.draft?.baseVersion, "v1", "postcommit projection: draft metadata committed before the dependency failed");
  assert.notEqual(after.liveEpoch, before.liveEpoch ?? "initial", "postcommit projection: external draft retirement committed");
  assert.equal((await readDraftObject(target, docId, "index.html")).toString(), html, "postcommit projection: committed candidate bytes remain reachable and exact");
  ctx.ev.json("projection-failure-after-commit", { docId, marker, response, storagePrefix: after.draft.storagePrefix, liveEpoch: after.liveEpoch });
  assert.equal(response.status, 200, "postcommit projection: a durable draft must still answer 200 after projection failure");
  assert.equal(response.json?.draft?.storagePrefix, after.draft.storagePrefix, "postcommit projection: success names the exact persisted draft pointer");
  assert.equal(response.json?.draft?.liveEpoch, after.liveEpoch, "postcommit projection: success names the committed epoch");
  const served = await owner.http.get(`/draft/${docId}/index.html`, { timeoutMs: HTTP_MS });
  assert.equal(served.status, 200, "postcommit projection: the successful draft can be read back");
  assert.equal(served.text, html, "postcommit projection: read-back serves the committed bytes");
});

/**
 * A setup update through /publish?update= that must mint `want`. A request
 * the stack did not answer is sent again only once the pointer is found not
 * to have moved (lib untilLanded); found moved, it is the update's effect.
 */
async function updateTo(ctx, http, docId, { body, baseVersion, want }) {
  const { out } = await untilLanded(
    ctx,
    `POST /publish?update=${docId} to ${want}`,
    () => updateUpload(http, docId, { body, baseVersion, timeoutMs: HTTP_MS }),
    async () => ((await docRecord(docId))?.currentVersion === want ? want : null),
    { stopAt: "budget" },
  );
  const r = out ?? { status: 200, json: { versionId: want, deduped: false, landed: true } };
  precondition(r.status === 200 && r.json?.versionId === want && r.json?.deduped === false, `update to ${want}: ${r.status} ${JSON.stringify(r.json)}`);
  return r;
}

/** Version ids that exist, in numeric order. */
async function versionIds(docId) {
  const rows = await readCollection(target, `docs/${docId}/versions`);
  return rows.map((r) => r.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** Remember concrete paths before withdrawal; a missing record must not erase its byte evidence. */
const observedPrefixes = new Map();
async function versionObject(docId, versionId, rel) {
  const version = await versionRecord(docId, versionId);
  precondition(version, `version record ${docId}/${versionId} exists before reading its bytes`);
  return readObject(target, `${version.storagePrefix ?? `docs/${docId}/${versionId}`}/${rel}`);
}

/** Unselected immutable allocations are uploads too, even without a version record. */
async function unreferencedBundles(docId) {
  const [versions, document, objects] = await Promise.all([
    readCollection(target, `docs/${docId}/versions`), docRecord(docId),
    listObjects(target, `docs/${docId}/bundles/`),
  ]);
  const selected = versions.map(({ id, data }) => `${data.storagePrefix ?? `docs/${docId}/${id}`}/`);
  if (document?.draft) selected.push(`${draftStoragePrefix(docId, document.draft)}/`);
  return objects.filter((name) => !selected.some((prefix) => name.startsWith(prefix)));
}

/** Actual snapshot objects, retaining a removed pointer and exposing never-selected uploads. */
async function objectsUnder(docId, rel) {
  if (!/^(v[1-9]\d*|draft)\/$/.test(rel)) return listObjects(target, `docs/${docId}/${rel}`);
  const key = `${docId}/${rel}`;
  const metadata = rel === "draft/" ? (await docRecord(docId))?.draft : await versionRecord(docId, rel.slice(0, -1));
  if (metadata) observedPrefixes.set(key, rel === "draft/" ? draftStoragePrefix(docId, metadata) : metadata.storagePrefix ?? `docs/${docId}/${rel.slice(0, -1)}`);
  const prefix = observedPrefixes.get(key) ?? `docs/${docId}/${rel.slice(0, -1)}`;
  const objects = await listObjects(target, `${prefix}/`);
  return metadata ? objects : [...new Set([...objects, ...await unreferencedBundles(docId)])].sort();
}

/** docs/{docId}/trust as sorted ids. */
async function trustGrantIds(docId) {
  return (await readCollection(target, `docs/${docId}/trust`)).map((r) => r.id).sort();
}

/** A Firestore value tree as plain JSON: Timestamps as {$ts: millis}, keys sorted. */
function plain(v) {
  if (v && typeof v.toMillis === "function") return { $ts: v.toMillis() };
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, plain(v[k])]));
  return v;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));

/**
 * Personal trust as the app writes it (app/src/trust.ts setPersonalTrust):
 * setDoc of docs/{d}/trust/{uid} under the own-uid rule, as the reader, with
 * their own ID token (lib/firestore-client.mjs).
 */
async function grantPersonalTrust(session, docId) {
  const r = await clientFirestore(target, { session }).set(`docs/${docId}/trust/${session.uid}`, { uid: session.uid, email: session.account.email.toLowerCase() }, { serverTime: ["trustedAt"] });
  precondition(r.verdict === "ALLOW", `personal trust for ${session.account.email}: Firestore answered ${r.status} ${r.code ?? ""} ${r.message ?? ""}`);
}

/** An initialized MCP client on a freshly minted mcp-channel token, waiting past Hosting's cut-off and throwing on it. */
async function mcpFor(ctx, session, actor) {
  const { token } = await mintToken(session, { name: `e2e a12 ${actor}`, channel: "mcp" });
  const mcp = ctx.mcp({ token, actor, timeoutMs: HTTP_MS, cutoffError: true });
  await mcp.initialize();
  return mcp;
}

/** add_comment on the current version, quoting its comment passage; the thread id. */
async function addComment(mcp, docId, rev, body) {
  const out = await mcp.call("add_comment", { id: docId, exact: quoteOf(rev), body });
  precondition(!out.isError && out.json?.threadId, `add_comment answered ${out.text.slice(0, 300)}`);
  return out.json.threadId;
}

/** Unresolved annotation ids on a version. */
async function openThreads(docId, v) {
  return (await readCollection(target, `docs/${docId}/versions/${v}/annotations`)).filter((r) => r.data.resolved === false).map((r) => r.id).sort();
}

function noPageErrors(users) {
  for (const u of users) assert.deepEqual(u.log.errors.map((e) => e.message), [], `${u.name}: uncaught page errors`);
}

// --- the viewer -------------------------------------------------------------------

/*
 * LIB-REQUEST: listen-stall-evidence. lib/test.mjs pageStall takes a page's
 * Firestore client as stalled only on the SDK's console line ("Could not reach
 * Cloud Firestore backend") or on Hosting's cut-off 504. A Listen POST the
 * emulator leaves unanswered on an open channel produces neither (measured:
 * holding a reader's one Listen POST after Open v2 left it on "Opening the
 * document…" with an empty console, e2e/.out/2610122038-zm9v/scratch/
 * 20261013T034135Z-p61696-mi3d), and on wr3h a page's Listen POST took 11 s.
 * Until pageStall reads it, each reader page here captures its Listen POSTs,
 * and a frame wait that runs out while one of them has gone unanswered for
 * the SDK's own 10 s is INCONCLUSIVE; one that runs out with every Listen
 * POST answered (or none sent) still FAILS.
 */
const LISTEN_STALL_MS = 10_000;
const listens = new WeakMap();

/** A browser user whose Firestore Listen POSTs are captured from the start (evidence for listenStall). */
async function reader(ctx, name) {
  const u = await ctx.users.user({ name });
  listens.set(u, u.capture({ paths: FIRESTORE_LISTEN_PATH, method: "POST", responseJson: false }));
  return u;
}

/** Why the page's Firestore was not answering it, or null: a Listen POST still unanswered after LISTEN_STALL_MS. */
function listenStall(u) {
  const rows = listens.get(u);
  if (!rows) return null;
  const at = performance.now();
  const stalled = rows.filter((r) => r.state === "sent" && at - r.sentAt >= LISTEN_STALL_MS);
  if (stalled.length === 0) return null;
  const longest = Math.round(Math.max(...stalled.map((r) => at - r.sentAt)));
  return `${u.name}'s Firestore emulator left ${stalled.length} of the page's Listen POST(s) unanswered, the longest for ${longest} ms (the SDK's own threshold for an unreachable backend is ${LISTEN_STALL_MS} ms; ${rows.length} captured)`;
}

/** The document frame's src attribute. */
const frameSrc = (u) => u.page.evaluate(() => document.querySelector("iframe.doc-frame")?.getAttribute("src") ?? null);

/** The version a /content frame src names, or null. */
function srcVersion(src, docId) {
  const m = new RegExp(`/content/(?:~[^/]+/)?${docId}/(v\\d+)/`).exec(src ?? "");
  return m ? m[1] : null;
}

/**
 * Wait until the viewer's frame shows `v` (its src names it, it has loaded).
 * Run out while the page's own Firestore was not answering it, the case is
 * INCONCLUSIVE (listenStall); otherwise the wait's failure stands.
 */
async function waitFrameAt(ctx, u, docId, v, { timeout = FRAME_MS } = {}) {
  try {
    return await u.waitForFrame({ timeout, match: new RegExp(`/content/(?:~[^/]+/)?${docId}/${v}/`) });
  } catch (err) {
    const stall = listenStall(u);
    if (stall) ctx.inconclusive(`the stack did not answer, so nothing was measured: ${stall}, when a wait ran out — ${err.message}`);
    throw err;
  }
}

/**
 * The comment bodies the comments panel lists. The panel opens by itself when
 * the version has an unresolved thread (SPEC §6); only if it has not after a
 * while is it toggled, so a click never races the default and closes it.
 */
async function panelBodies(u) {
  const panel = u.page.locator('.viewer-body[data-comments="open"] .comments-panel');
  await panel.waitFor({ state: "visible", timeout: 8_000 }).catch(() => u.openComments());
  return u.page.locator(".comments-panel .thread .comment-body").evaluateAll((els) => els.map((e) => e.textContent.trim()));
}

/** The Versions group of the More menu (User.moreMenu, which leaves it closed): [{label, disabled}], newest first. */
async function versionMenu(u) {
  const { groups } = await u.moreMenu();
  return groups.filter((g) => g.heading === "Versions").flatMap((g) => g.items.map(({ label, disabled }) => ({ label, disabled })));
}

/** app/src/components/ViewerBanners.tsx: the newer-version banner's row. */
const BANNER_SEL = ".viewer-banners .banner";
const bannerRow = (u) => u.page.locator(BANNER_SEL, { hasText: NEWER_BANNER });
/** Every render of the newer-version banner from now on, reloads included (User.watchFor). */
const watchNewerBanner = (u) => u.watchFor(BANNER_SEL, NEWER_BANNER);

/** Every request of a page capture since `mark` through answered(): Hosting's cut-off on any of them ends the case INCONCLUSIVE. */
function pageAnswered(rows, mark, who) {
  for (const r of rows.slice(mark)) answered(r, `${who}'s ${r.method} ${r.path}`);
}

// --- A12.1 ----------------------------------------------------------------------

scenario("A12.1 an identical update is a no-op through /publish?update=, update_document and an editor's commit: the dedup answer, nothing minted or uploaded, global and personal trust kept; a changed update then withdraws both", { tiers: BOTH, timeoutMs: 360_000, ...STALLS }, async (ctx) => {
  ctx.step("cast an owner, an editor and a viewer; the owner publishes revision 1 and shares it");
  const { owner, accounts } = await castWithOwner(ctx, ["editor", "viewer"]);
  const [, editorAcct, viewerAcct] = accounts;
  const title = `A12.1 dedup ${tag()}`;
  const v1Html = docHtml(title, 1);
  const docId = await publishDoc(ctx, owner, { title, name: "a121-dedup" });
  await grant(ctx, owner, docId, editorAcct, "editor");
  await grant(ctx, owner, docId, viewerAcct, "viewer");
  const editor = await sessionFor(ctx, editorAcct);
  const viewer = await sessionFor(ctx, viewerAcct);

  ctx.step("the owner trusts it for everyone (POST /trust); the viewer and the editor each grant themselves personal trust");
  await owner.http.postJson("/trust", { docId, trusted: true }, { expect: 200 });
  await grantPersonalTrust(viewer, docId);
  await grantPersonalTrust(editor, docId);
  const grantsBefore = plain(await readCollection(target, `docs/${docId}/trust`));
  precondition(isDeepStrictEqual(grantsBefore.map((g) => g.id).sort(), [editor.uid, viewer.uid].sort()), `both personal grants: ${JSON.stringify(grantsBefore)}`);
  const v1 = await versionRecord(docId, "v1");
  const before = plain(await docRecord(docId));
  precondition(before.trusted === true && before.currentVersion === "v1", `trusted v1: ${JSON.stringify(pick(before, ["trusted", "currentVersion"]))}`);
  const dedup = { versionId: "v1", contentHash: v1.contentHash, fileCount: v1.fileCount, bytes: v1.bytes, deduped: true };

  /** Nothing minted, nothing uploaded, both trust scopes as they were; `record` also compares the whole docs record. */
  const unchanged = async (label, { record = true } = {}) => {
    const [now, versions, grants, v2Objects] = await Promise.all([docRecord(docId), versionIds(docId), readCollection(target, `docs/${docId}/trust`), objectsUnder(docId, "v2/")]);
    assert.deepEqual({ versions, v2Objects }, { versions: ["v1"], v2Objects: [] }, `${label}: no version minted and no bytes uploaded`);
    assert.deepEqual({ trusted: now.trusted, currentVersion: now.currentVersion, commits: now.stats?.commits ?? null }, { trusted: true, currentVersion: "v1", commits: before.stats?.commits ?? null }, `${label}: global trust and the pointer kept`);
    assert.deepEqual(plain(grants), grantsBefore, `${label}: every personal grant kept as it was`);
    if (record) assert.deepEqual(plain(now), before, `${label}: "a deduplicated update mints nothing and changes nothing" (SPEC §6c)`);
  };

  ctx.step("POST /publish?update= with revision 1's bytes and baseVersion v1: 200 with the dedup answer (SPEC §2)");
  const a = await updateUpload(owner.http, docId, { body: v1Html, baseVersion: "v1", timeoutMs: HTTP_MS });
  assert.equal(a.status, 200, `/publish?update= answered ${a.status} ${a.response.text.slice(0, 300)}`);
  assert.deepEqual(a.json, { docId, ...dedup }, "/publish?update= answers {docId, versionId, contentHash, fileCount, bytes, deduped}");
  await unchanged("/publish?update=");

  ctx.step("update_document with the same content and baseVersion v1: deduped, threadsLeftBehind 0");
  const mcp = await mcpFor(ctx, owner, "owner-mcp");
  const b = await mcp.call("update_document", { id: docId, content: v1Html, baseVersion: "v1" });
  assert.equal(b.isError, false, `update_document: ${b.text.slice(0, 300)}`);
  assert.deepEqual(pick(b.json, ["versionId", "contentHash", "fileCount", "bytes", "deduped", "threadsLeftBehind"]), { ...dedup, threadsLeftBehind: 0 }, "update_document's answer");
  await unchanged("update_document");

  ctx.step("the editor saves revision 1's bytes as the draft and commits it: deduped, the draft cleared, trust kept");
  await editor.http.postJson("/draft", { docId, baseVersion: "v1", html: v1Html }, { expect: 200 });
  precondition((await docRecord(docId)).draft?.baseVersion === "v1", "the editor's draft exists");
  precondition((await objectsUnder(docId, "draft/")).length > 0, "the retiring draft has stored bytes");
  const c = await editor.http.postJson("/commit", { docId, baseVersion: "v1" });
  assert.equal(c.status, 200, `/commit answered ${c.status} ${c.text.slice(0, 300)}`);
  assert.deepEqual(c.json, dedup, "/commit answers the dedup");
  // The draft save itself moved updatedAt and the edit stats, so not the whole record.
  await unchanged("an editor's identical commit", { record: false });
  const afterCommit = await docRecord(docId);
  assert.deepEqual({ draft: afterCommit.draft ?? null, draftObjects: await objectsUnder(docId, "draft/") }, { draft: null, draftObjects: [] }, "the deduplicated commit cleared the draft (SPEC §2)");

  ctx.step("contrast: a changed update mints v2 and withdraws both scopes (SPEC §6c), so the checks above could see a withdrawal");
  const d = await updateUpload(owner.http, docId, { body: docHtml(title, 2), baseVersion: "v1", timeoutMs: HTTP_MS });
  assert.equal(d.status, 200, `/publish?update= answered ${d.status}`);
  assert.deepEqual(pick(d.json, ["versionId", "deduped"]), { versionId: "v2", deduped: false });
  const withdrawn = await docRecord(docId);
  assert.deepEqual({ trusted: withdrawn.trusted, currentVersion: withdrawn.currentVersion, grants: await trustGrantIds(docId) }, { trusted: false, currentVersion: "v2", grants: [] }, "a changed update withdraws global and personal trust");
});

// --- A12.2 ----------------------------------------------------------------------

scenario("A12.2 the More menu lists the last eight versions newest first, the current one labelled and the shown one disabled; a pinned version loads that version and shows only that version's threads", { tiers: BOTH, timeoutMs: 600_000, ...STALLS }, async (ctx) => {
  ctx.step("cast an owner; publish revision 1 and comment on it through MCP");
  const { owner, accounts } = await castWithOwner(ctx, []);
  const title = `A12.2 menu ${tag()}`;
  const docId = await publishDoc(ctx, owner, { title, name: "a122-menu" });
  const mcp = await mcpFor(ctx, owner, "owner-mcp");
  const body = (v) => `A12.2 thread on ${v} ${tag()}`;
  const bodies = { v1: body("v1"), v9: body("v9"), v10: body("v10") };
  await addComment(mcp, docId, 1, bodies.v1);

  ctx.step("updates through /publish?update= mint v2 … v9; comment on v9; one more update mints v10; comment on v10");
  for (let rev = 2; rev <= 10; rev += 1) {
    await updateTo(ctx, owner.http, docId, { body: docHtml(title, rev), baseVersion: `v${rev - 1}`, want: `v${rev}` });
    if (rev === 9) await addComment(mcp, docId, 9, bodies.v9);
  }
  await addComment(mcp, docId, 10, bodies.v10);
  precondition(isDeepStrictEqual(await versionIds(docId), Array.from({ length: 10 }, (_, i) => `v${i + 1}`)), "ten versions exist");

  ctx.step("the owner opens /d/<doc>: the frame is v10 and the panel lists only v10's thread");
  const o = await reader(ctx, "owner");
  await o.signInUi(accounts[0].email, accounts[0].password);
  await o.open(docId);
  await waitFrameAt(ctx, o, docId, "v10");
  await eventually(async () => isDeepStrictEqual(await panelBodies(o), [bodies.v10]), { timeout: 15_000, interval: 250, message: "the panel lists v10's thread alone" }).catch(() => undefined);
  assert.deepEqual(await panelBodies(o), [bodies.v10], "unpinned: v10's thread only");

  ctx.step("More actions → Versions: v10 — current (disabled, it is shown), then v9 … v3; nothing older");
  const want = [{ label: "v10 — current", disabled: true }, ...[9, 8, 7, 6, 5, 4, 3].map((n) => ({ label: `v${n}`, disabled: false }))];
  assert.deepEqual(await versionMenu(o), want, "the last eight versions, newest first (DocViewer.tsx: reverse().slice(0, 8))");

  ctx.step("choosing v9 pins it: /d/<doc>/v9, the frame loads v9's bytes, and the panel lists only v9's thread");
  const chose = await o.chooseMenu("v9");
  precondition(chose.heading === "Versions", `v9 was chosen from the Versions group: ${JSON.stringify(chose)}`);
  await eventually(async () => new URL(o.page.url()).pathname === `/d/${docId}/v9`, { timeout: 10_000, message: "the URL pins v9" });
  await waitFrameAt(ctx, o, docId, "v9");
  assert.match(await frameText(await o.frame()), /This is revision 9 of the versions document\./, "the pinned frame shows revision 9");
  await eventually(async () => isDeepStrictEqual(await panelBodies(o), [bodies.v9]), { timeout: 15_000, interval: 250, message: "the panel lists v9's thread alone" }).catch(() => undefined);
  assert.deepEqual(await panelBodies(o), [bodies.v9], "pinned v9: v9's thread only");

  ctx.step("on v9 the menu labels v10 current and enabled, and disables v9");
  assert.deepEqual(await versionMenu(o), [{ label: "v10 — current", disabled: false }, { label: "v9", disabled: true }, ...[8, 7, 6, 5, 4, 3].map((n) => ({ label: `v${n}`, disabled: false }))], "the menu while v9 is pinned");

  ctx.step("/d/<doc>/v1, older than the menu reaches, still pins: revision 1's bytes and v1's thread only");
  await o.open(docId, { v: "v1" });
  await waitFrameAt(ctx, o, docId, "v1");
  assert.match(await frameText(await o.frame()), /This is revision 1 of the versions document\./, "the pinned frame shows revision 1");
  await eventually(async () => isDeepStrictEqual(await panelBodies(o), [bodies.v1]), { timeout: 15_000, interval: 250, message: "the panel lists v1's thread alone" }).catch(() => undefined);
  assert.deepEqual(await panelBodies(o), [bodies.v1], "pinned v1: v1's thread only");
  noPageErrors([o]);
});

// --- A12.3 ----------------------------------------------------------------------

scenario("A12.3 a reader pinned to an older version gets the newer-version banner and Open or Stay here; an unpinned reader follows each new version, with no banner for the first, not for one render", { tiers: BOTH, timeoutMs: 480_000, ...STALLS }, async (ctx) => {
  ctx.step("cast an owner and a viewer; publish revision 1 and share it");
  const { owner, accounts } = await castWithOwner(ctx, ["viewer"]);
  const title = `A12.3 banner ${tag()}`;
  const docId = await publishDoc(ctx, owner, { title, name: "a123-banner" });
  await grant(ctx, owner, docId, accounts[1], "viewer");

  ctx.step("the owner's browser pins /d/<doc>/v1; the viewer's reads /d/<doc> unpinned; both watch every render for the banner (User.watchFor)");
  const [o, v] = await Promise.all([reader(ctx, "pinned"), reader(ctx, "unpinned")]);
  await Promise.all([o.signInUi(accounts[0].email, accounts[0].password), v.signInUi(accounts[1].email, accounts[1].password)]);
  await Promise.all([o.open(docId, { v: "v1" }), v.open(docId)]);
  await Promise.all([waitFrameAt(ctx, o, docId, "v1"), waitFrameAt(ctx, v, docId, "v1")]);
  const [pinnedWatch, unpinnedWatch] = await Promise.all([watchNewerBanner(o), watchNewerBanner(v)]);
  assert.deepEqual(await pinnedWatch.sightings(), [], "no banner before anything is published");

  ctx.step("somebody publishes v2 (the owner's own session, through /publish?update=)");
  await updateTo(ctx, owner.http, docId, { body: docHtml(title, 2), baseVersion: "v1", want: "v2" });

  ctx.step("the unpinned reader follows to v2 by itself, and its watch never sees the banner, not for one render (held for 10 samples); the watch ends there");
  await waitFrameAt(ctx, v, docId, "v2");
  assert.match(await frameText(await v.frame()), /This is revision 2 of the versions document\./);
  const followed = await eventually(async () => ({ sightings: await unpinnedWatch.sightings(), frame: srcVersion(await frameSrc(v), docId) }), { timeout: 15_000, interval: 300, stableSamples: 10, message: "the unpinned reader's state holds still" });
  assert.deepEqual(followed, { sightings: [], frame: "v2" }, "an unpinned reader follows to v2 with no banner, ever");
  // Its watch ends with its first new version: on the next one the product can
  // render a stale banner for a render, which is the next case's (X-a12-versions-3).
  const unpinned = await unpinnedWatch.stop();
  const unpinnedDocs = await unpinnedWatch.documents();

  ctx.step("the pinned reader gets the banner with Open v2 and Stay here, and keeps reading v1");
  await bannerRow(o).waitFor({ state: "visible", timeout: 60_000 });
  const buttons = await bannerRow(o).locator("button").evaluateAll((els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(buttons, ["Open v2", "Stay here"], "the banner's choices");
  assert.equal(srcVersion(await frameSrc(o), docId), "v1", "the pinned frame still shows v1");
  assert.equal(new URL(o.page.url()).pathname, `/d/${docId}/v1`);

  // DocViewer.tsx onOpenNewVersion: navigate(`/d/${docId}`), the head, unpinned.
  // The viewer remounts (App.tsx ViewerRoute's key), so the page asks
  // Firestore for the document again before the frame can load v2.
  ctx.step("Open v2: the reader is unpinned at /d/<doc>, its frame loads v2, the banner is gone");
  await bannerRow(o).getByRole("button", { name: "Open v2", exact: true }).click();
  await eventually(async () => new URL(o.page.url()).pathname === `/d/${docId}`, { timeout: 10_000, message: "Open v2 navigates to the head, /d/<doc>" });
  await waitFrameAt(ctx, o, docId, "v2");
  await eventually(async () => (await bannerRow(o).count()) === 0, { timeout: 10_000, message: "the banner clears once v2 is open" });
  const pinnedV1 = await pinnedWatch.stop();

  ctx.step("the same reader pins /d/<doc>/v2 (a fresh load, with a fresh watch); somebody publishes v3; Stay here: the banner goes, the frame stays on v2");
  await o.open(docId, { v: "v2" });
  await waitFrameAt(ctx, o, docId, "v2");
  const pinnedV2Watch = await watchNewerBanner(o);
  await updateTo(ctx, owner.http, docId, { body: docHtml(title, 3), baseVersion: "v2", want: "v3" });
  await bannerRow(o).getByRole("button", { name: "Open v3", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await bannerRow(o).getByRole("button", { name: "Stay here", exact: true }).click();
  await eventually(async () => (await bannerRow(o).count()) === 0, { timeout: 10_000, message: "Stay here dismisses the banner" });
  assert.deepEqual({ path: new URL(o.page.url()).pathname, frame: srcVersion(await frameSrc(o), docId) }, { path: `/d/${docId}/v2`, frame: "v2" }, "Stay here keeps the reader on v2");

  ctx.step("the unpinned reader followed to v3 as well, in place (its banner on this second new version: the next case)");
  await waitFrameAt(ctx, v, docId, "v3");
  const followedV3 = await eventually(async () => ({ path: new URL(v.page.url()).pathname, frame: srcVersion(await frameSrc(v), docId) }), { timeout: 15_000, interval: 300, stableSamples: 5, message: "the unpinned reader's frame holds still" });
  const pinnedV2 = await pinnedV2Watch.stop();
  ctx.ev.json("banner-sightings", { pinnedV1, pinnedV2, unpinned, unpinnedDocs });
  assert.deepEqual(followedV3, { path: `/d/${docId}`, frame: "v3" }, "an unpinned reader follows to v3, unpinned");
  assert.equal(unpinnedDocs.length, 1, `the unpinned reader's one document was watched throughout its first new version (it followed in place): ${JSON.stringify(unpinnedDocs)}`);
  // An empty watch proves something only next to the same watch seeing it.
  const shown = (rows, n) => rows.some((r) => r.visible && r.text.includes(`Open ${n}`) && r.text.includes("Stay here"));
  assert.deepEqual({ v1: shown(pinnedV1, "v2"), v2: shown(pinnedV2, "v3") }, { v1: true, v2: true }, "the pinned reader's watch saw each banner, visible, with its choices (the watch works)");
  noPageErrors([o, v]);
});

/*
 * useLiveSync.ts keeps the last version it announced in state and updates it
 * in an EFFECT, after the render in which an unpinned reader's shownVersion
 * has already moved on. So when a second new version lands, that render
 * compares the new shownVersion with the previous announcement ("v2" against
 * "v3") and inserts "Open v2 / Stay here" until the effect catches up.
 * This oracle observes DOM insertion and layout visibility under CPU
 * throttling. It does not establish that the browser painted the banner.
 */
scenario("A12.3 (a second new version) an unpinned reader who followed one new version never sees the banner for the next one either, not even on a slower CPU", { tiers: BOTH, timeoutMs: 360_000, ...STALLS }, async (ctx) => {
  ctx.step("cast an owner and a viewer; publish revision 1 and share it; the viewer reads /d/<doc> unpinned and watches every render for the banner");
  const { owner, accounts } = await castWithOwner(ctx, ["viewer"]);
  const title = `A12.3 second ${tag()}`;
  const docId = await publishDoc(ctx, owner, { title, name: "a123-second" });
  await grant(ctx, owner, docId, accounts[1], "viewer");
  const v = await reader(ctx, "unpinned");
  await v.signInUi(accounts[1].email, accounts[1].password);
  await v.open(docId);
  await waitFrameAt(ctx, v, docId, "v1");
  const watch = await watchNewerBanner(v);

  ctx.step("somebody publishes v2: the reader follows, and the watch sees no banner (the first new version)");
  await updateTo(ctx, owner.http, docId, { body: docHtml(title, 2), baseVersion: "v1", want: "v2" });
  await waitFrameAt(ctx, v, docId, "v2");
  const afterFirst = await eventually(async () => ({ sightings: await watch.sightings(), frame: srcVersion(await frameSrc(v), docId) }), { timeout: 15_000, interval: 300, stableSamples: 5, message: "the reader's state holds still after v2" });
  precondition(isDeepStrictEqual(afterFirst, { sightings: [], frame: "v2" }), `the first new version is followed with no banner: ${JSON.stringify(afterFirst)}`);

  ctx.step("on a 6x slower CPU, somebody publishes v3: the reader follows, and the watch must still see no banner");
  const restore = await v.throttleCpu(6);
  try {
    await updateTo(ctx, owner.http, docId, { body: docHtml(title, 3), baseVersion: "v2", want: "v3" });
    await waitFrameAt(ctx, v, docId, "v3");
    await eventually(async () => srcVersion(await frameSrc(v), docId), { timeout: 15_000, interval: 300, stableSamples: 5, message: "the reader's frame holds still on v3" });
  } finally {
    await restore();
  }
  const sightings = await watch.stop();
  const docs = await watch.documents();
  ctx.ev.json("banner-sightings", { sightings, docs });
  precondition(docs.length === 1, `the reader's one document was watched throughout (it followed in place): ${JSON.stringify(docs)}`);
  assert.deepEqual(sightings.map((r) => ({ text: r.text, visible: r.visible, path: r.path })), [], "an unpinned reader never gets the newer-version banner, not for one render (useLiveSync.ts: the announcement is caught up in an effect, a render after shownVersion)");
  noPageErrors([v]);
});

// --- A12.4 ----------------------------------------------------------------------

scenario("A12.4 restoring historical bytes publishes a new current version through commit, MCP, upload and the editor without changing history", { tiers: BOTH, timeoutMs: 600_000, ...STALLS }, async (ctx) => {
  ctx.step("cast an owner; publish revision 1, then update to revision 2 (v2)");
  const { owner, accounts } = await castWithOwner(ctx, []);
  const title = `A12.4 revert ${tag()}`;
  const r1 = docHtml(title, 1);
  const docId = await publishDoc(ctx, owner, { title, name: "a124-revert" });
  await updateTo(ctx, owner.http, docId, { body: docHtml(title, 2), baseVersion: "v1", want: "v2" });
  const v1 = await versionRecord(docId, "v1");
  const v2 = await versionRecord(docId, "v2");
  const observed = {};

  ctx.step("in the app's terms: the owner saves revision 1's bytes as the draft of v2 and commits it");
  await owner.http.postJson("/draft", { docId, baseVersion: "v2", html: r1 }, { expect: 200 });
  precondition((await objectsUnder(docId, "draft/")).length > 0, "the retiring draft has stored bytes");
  const c = await owner.http.postJson("/commit", { docId, baseVersion: "v2" });
  assert.equal(c.status, 200, `/commit answered ${c.status} ${c.text.slice(0, 300)}`);
  const afterCommit = await docRecord(docId);
  observed.commit = { answer: c.json, currentVersion: afterCommit.currentVersion };
  ctx.step(`/commit answered ${JSON.stringify(c.json)}; currentVersion is ${afterCommit.currentVersion}`);
  assert.deepEqual(pick(c.json, ["versionId", "deduped", "contentHash"]), { versionId: "v3", deduped: false, contentHash: v1.contentHash }, "restoring v1 publishes v3, rather than discarding the draft as identical");
  assert.equal(afterCommit.currentVersion, "v3", "the restored version is current");
  assert.equal(String(await versionObject(docId, "v3", "index.html")), r1, "v3 holds the requested restoration");
  assert.equal(afterCommit.draft ?? null, null, "the published draft is cleared");

  ctx.step("through a token: restore v2 through update_document, then v1 through /publish?update=");
  const mcp = await mcpFor(ctx, owner, "owner-mcp");
  const r2 = docHtml(title, 2);
  const u = await mcp.call("update_document", { id: docId, content: r2, baseVersion: "v3" });
  assert.equal(u.isError, false, `update_document: ${u.text.slice(0, 300)}`);
  observed.updateDocument = pick(u.json, ["versionId", "deduped", "threadsLeftBehind"]);
  assert.deepEqual(pick(u.json, ["versionId", "deduped", "contentHash"]), { versionId: "v4", deduped: false, contentHash: v2.contentHash }, "MCP restores historical bytes as a new version");
  assert.equal((await docRecord(docId)).currentVersion, "v4", "MCP restoration becomes current before the next channel runs");
  assert.equal(String(await versionObject(docId, "v4", "index.html")), r2, "v4 holds the MCP restoration");
  const p = await updateUpload(owner.http, docId, { body: r1, baseVersion: "v4", timeoutMs: HTTP_MS });
  assert.equal(p.status, 200, `/publish?update= answered ${p.status}`);
  observed.publishUpdate = pick(p.json, ["versionId", "deduped"]);
  assert.deepEqual(pick(p.json, ["versionId", "deduped", "contentHash"]), { versionId: "v5", deduped: false, contentHash: v1.contentHash }, "upload restores historical bytes as a new version");
  const final = await docRecord(docId);
  assert.deepEqual({ versions: await versionIds(docId), currentVersion: final.currentVersion }, { versions: ["v1", "v2", "v3", "v4", "v5"], currentVersion: "v5" }, "every restoration minted and selected one version");
  for (const [id, bytes, parent] of [["v1", r1, null], ["v2", r2, "v1"], ["v3", r1, "v2"], ["v4", r2, "v3"], ["v5", r1, "v4"]]) {
    assert.equal(String(await versionObject(docId, id, "index.html")), bytes, `${id}: immutable bytes`);
    if (parent) assert.equal((await versionRecord(docId, id)).parentVersion, parent, `${id}: restoration retains linear provenance`);
  }

  ctx.step("in the app: type A and publish, type B and publish, remove B and publish the restored content");
  const fx = await publish(owner.http, { fixture: "crdt-paragraphs.html", title: `${title} in app`, name: "a124-inapp", timeoutMs: HTTP_MS, patient: { ctx, stopAt: "budget" } });
  precondition(fx.versionId === "v1", `publish answered ${fx.status}`);
  const appDoc = fx.docId;
  const o = await reader(ctx, "owner");
  // Every POST /draft and /commit the page sends, for answered(): a save or a
  // commit Hosting cut off is the stack's, not the editor's.
  const posts = o.capture({ paths: ["/draft", "/commit"] });
  await o.signInUi(accounts[0].email, accounts[0].password);
  await o.open(appDoc);
  await waitFrameAt(ctx, o, appDoc, "v1");
  const tokA = ` A12A${runTag(target.runId)}`;
  const tokB = ` A12B${rand4()}`;
  /*
   * Each Save waits for the debounced autosave that follows the LAST key
   * (User.typeAndAutosave; useInlineEditor.ts AUTOSAVE_MS, a time the product
   * sets), and that wait outlasts Hosting's cut-off: a saveDraft the stack
   * answers in 22 s is slow, not missing. Pressing Save inside the debounce
   * races the user's own pending autosave against the commit
   * (X-a12-versions-2), which is not what this case is about.
   */
  const autosave = async (text, opts = {}) => {
    const save = await o.typeAndAutosave("#e2e-1", text, { timeout: AUTOSAVE_WAIT_MS, expectStatus: null, ...opts });
    answered(save.entry, "the owner's autosave after the last key");
    precondition(save.status === 200, `the autosave after the last key was answered ${save.status} ${JSON.stringify(save.body).slice(0, 200)}`);
    return save;
  };
  const save = async () => {
    const mark = posts.mark();
    const out = await o.saveAsNewVersion({ timeout: COMMIT_WAIT_MS });
    pageAnswered(posts, mark, "the owner's page");
    return out;
  };
  const saveWith = async (text, want) => {
    await o.enterEdit({ timeout: FRAME_MS });
    await autosave(text);
    const out = await save();
    precondition(out.outcome === "published" && out.versionId === want, `Save as new version: ${out.text}`);
    await waitFrameAt(ctx, o, appDoc, want);
  };
  await saveWith(tokA, "v2");
  await saveWith(tokB, "v3");
  await o.enterEdit({ timeout: FRAME_MS });
  await autosave("", { thenBackspace: tokB.length });
  const v2Bytes = await versionObject(appDoc, "v2", "index.html");
  const draftBytes = await readDraftObject(target, appDoc, "index.html");
  ctx.ev.json("revert-draft", { v2: String(v2Bytes), draft: draftBytes && String(draftBytes) });
  assert.ok(draftBytes && sha(draftBytes) === sha(v2Bytes), "removing B restores exactly v2's bytes, without duplicating the document body");
  const inApp = await save();
  const appRecord = await docRecord(appDoc);
  const v3Bytes = await versionObject(appDoc, "v3", "index.html");
  const v4Bytes = await versionObject(appDoc, "v4", "index.html");
  observed.inApp = { toast: inApp.text, outcome: inApp.outcome, currentVersion: appRecord.currentVersion };
  assert.deepEqual({ outcome: inApp.outcome, versionId: inApp.versionId }, { outcome: "published", versionId: "v4" }, "the browser reports a published restoration");
  assert.notEqual(inApp.text, DEDUP_TOAST, "the app must not call the restored content identical to the current version");
  assert.deepEqual({ versions: await versionIds(appDoc), currentVersion: appRecord.currentVersion, draft: appRecord.draft ?? null }, { versions: ["v1", "v2", "v3", "v4"], currentVersion: "v4", draft: null }, "the restored version is current and the published draft is cleared");
  assert.equal(sha(v4Bytes), sha(v2Bytes), "v4 stores exactly the historical content requested");
  assert.ok(String(v3Bytes).includes(tokB.trim()), "the superseded version retains B unchanged");
  assert.ok(String(v4Bytes).includes(tokA.trim()) && !String(v4Bytes).includes(tokB.trim()), "current bytes keep A and remove B");
  await waitFrameAt(ctx, o, appDoc, "v4");
  const rendered = await frameText(await o.frame());
  assert.ok(rendered.includes(tokA.trim()) && !rendered.includes(tokB.trim()), "the reader renders the restored content");
  ctx.ev.json("historical-restoration", observed);
  noPageErrors([o]);
});

scenario("A12.4b operator publishing restores historical bytes as a new version and deduplicates only the current version", { tiers: ["local"], needs: ["operator-scripts"], timeoutMs: 180_000, ...STALLS }, async (ctx) => {
  const { owner } = await castWithOwner(ctx, []);
  const seeded = await publishOperator(target, { sample: "bikeshed-tour", owner: owner.account, timeoutMs: 30_000 });
  precondition(seeded.code === 0, `operator seed exited ${seeded.code}: ${scrub(seeded.stderr)}`);
  const docId = seeded.docId;
  const original = await versionObject(docId, "v1", "index.html");
  const v1 = await versionRecord(docId, "v1");
  const newer = docHtml(`Operator restore ${tag()}`, 2);
  await updateTo(ctx, owner.http, docId, { body: newer, baseVersion: "v1", want: "v2" });
  const restored = await publishOperator(target, { sample: "bikeshed-tour", owner: owner.account, id: docId, timeoutMs: 30_000 });
  assert.equal(restored.code, 0, `operator restoration exits: ${scrub(restored.stderr)}`);
  assert.equal((await docRecord(docId)).currentVersion, "v3", "operator restoration publishes historical bytes as a new current version");
  const v3 = await versionRecord(docId, "v3");
  assert.deepEqual(pick(v3, ["contentHash", "parentVersion"]), { contentHash: v1.contentHash, parentVersion: "v2" }, "operator restoration keeps content identity and provenance");
  assert.equal(sha(await versionObject(docId, "v3", "index.html")), sha(original), "operator restores original bytes");
  assert.equal(String(await versionObject(docId, "v2", "index.html")), newer, "operator preserves superseded content");
  const duplicate = await publishOperator(target, { sample: "bikeshed-tour", owner: owner.account, id: docId, timeoutMs: 30_000 });
  assert.equal(duplicate.code, 0);
  assert.match(duplicate.stdout, /already published as v3 .*NO-OP/, "an identical retry names the current version even though an earlier hash also matches");
  assert.deepEqual(await versionIds(docId), ["v1", "v2", "v3"], "identical current content mints nothing");
});

// --- A12.5 ----------------------------------------------------------------------

scenario("A12.5 /publish?update=: an editor 200, an open editor 403, id/folderId/title 400, a pending suggestion 409 pendingSuggestions, an accepted change in the draft 409 acceptedInDraft; no refusal uploads anything, and the in-app commit is not held", { tiers: BOTH, timeoutMs: 480_000, ...STALLS }, async (ctx) => {
  ctx.step("cast an owner, an editor, a suggester and a stranger; the owner publishes revision 1, shared with the editor and the suggester");
  const { owner, accounts } = await castWithOwner(ctx, ["editor", "suggester", "stranger"]);
  const [, editorAcct, suggesterAcct, strangerAcct] = accounts;
  const title = `A12.5 refusals ${tag()}`;
  const docId = await publishDoc(ctx, owner, { title, name: "a125-refusals" });
  await grant(ctx, owner, docId, editorAcct, "editor");
  await grant(ctx, owner, docId, suggesterAcct, "suggester");
  const editor = await sessionFor(ctx, editorAcct);
  const suggester = await sessionFor(ctx, suggesterAcct);
  const stranger = await sessionFor(ctx, strangerAcct);
  const nothingAt = async (label, v, versions) => {
    assert.deepEqual({ versions: await versionIds(docId), objects: await objectsUnder(docId, `${v}/`) }, { versions, objects: [] }, `${label}: nothing minted and nothing uploaded under ${v}/`);
  };

  ctx.step("E: the editor's /publish?update= is 200 with exactly the SPEC §2 keys, and v2 holds the bytes sent");
  const r2 = docHtml(title, 2);
  const e = await updateUpload(editor.http, docId, { body: r2, timeoutMs: HTTP_MS });
  assert.equal(e.status, 200, `editor: ${e.status} ${e.response.text.slice(0, 300)}`);
  assert.deepEqual(Object.keys(e.json).sort(), ["bytes", "contentHash", "deduped", "docId", "fileCount", "versionId"], "the answer's keys (SPEC §2)");
  assert.deepEqual(pick(e.json, ["docId", "versionId", "deduped"]), { docId, versionId: "v2", deduped: false });
  const v2rec = await versionRecord(docId, "v2");
  assert.deepEqual(pick(v2rec, ["parentVersion", "publishedVia", "publishedByEmail", "contentHash"]), { parentVersion: "v1", publishedVia: "upload", publishedByEmail: editorAcct.email.toLowerCase(), contentHash: e.json.contentHash });
  assert.equal(sha(await versionObject(docId, "v2", "index.html")), sha(Buffer.from(r2)), "v2's stored entry is the bytes sent");

  ctx.step("id, folderId and title with update are each 400 with the product's reason");
  const r3 = docHtml(title, 3);
  for (const [k, val] of [["id", docIdFor(target, "a125-other")], ["folderId", `a125-folder-${rand4()}`], ["title", "Another title"]]) {
    const r = await updateUpload(editor.http, docId, { body: r3, query: { [k]: val }, timeoutMs: HTTP_MS });
    assert.deepEqual({ status: r.status, error: r.json?.error }, { status: 400, error: UPDATE_KEEPS }, `update with ${k}`);
  }
  await nothingAt("the 400s", "v3", ["v1", "v2"]);

  ctx.step("PE: a stranger on a public open-editing document may edit, but /publish?update= is 403 (isDocEditor, not canEdit)");
  const pubTitle = `A12.5 open ${tag()}`;
  const pubId = await publishDoc(ctx, owner, { title: pubTitle, name: "a125-open" });
  try {
    await setVisibility(target, { owner, doc: pubId, visibility: "public", publicEdit: true, timeoutMs: HTTP_MS, patient: { ctx, stopAt: "budget" } });
    const canDraft = await stranger.http.postJson("/draft", { docId: pubId, baseVersion: "v1", html: docHtml(pubTitle, 2) });
    precondition(canDraft.status === 200, `the open editor may edit (POST /draft ${canDraft.status})`);
    const pe = await updateUpload(stranger.http, pubId, { body: docHtml(pubTitle, 3), timeoutMs: HTTP_MS });
    assert.equal(pe.status, 403, `open editor: ${pe.status} ${pe.response.text.slice(0, 200)}`);
    assert.deepEqual({ versions: await versionIds(pubId), objects: await objectsUnder(pubId, "v2/") }, { versions: ["v1"], objects: [] }, "the 403 minted and uploaded nothing");
  } finally {
    // The case closes it in any event; closing it here keeps the window short.
    await setVisibility(target, { owner, doc: pubId, visibility: "private", timeoutMs: HTTP_MS }).catch(() => undefined);
  }

  ctx.step("a pending suggestion on v2 (suggest_edit by the suggester): an update is 409 pendingSuggestions on both token channels, and uploads nothing");
  const sMcp = await mcpFor(ctx, suggester, "suggester-mcp");
  const sug = await sMcp.call("suggest_edit", { id: docId, exact: "revision 2 of", replacement: "revision two of" });
  precondition(!sug.isError && sug.json?.threadId, `suggest_edit: ${sug.text.slice(0, 300)}`);
  const pending = await updateUpload(owner.http, docId, { body: r3, timeoutMs: HTTP_MS });
  assert.deepEqual({ status: pending.status, json: pending.json }, { status: 409, json: { error: PENDING_ONE, pendingSuggestions: 1 } }, "/publish?update= with a pending suggestion");
  const oMcp = await mcpFor(ctx, owner, "owner-mcp");
  const pendingTool = await oMcp.call("update_document", { id: docId, content: r3, baseVersion: "v2" });
  assert.equal(pendingTool.isError, true, `update_document with a pending suggestion: ${pendingTool.text.slice(0, 200)}`);
  assert.ok(pendingTool.text.includes(PENDING_ONE), `update_document says why: ${pendingTool.text.slice(0, 300)}`);
  await nothingAt("the pending refusals", "v3", ["v1", "v2"]);

  ctx.step("…but an identical update stays a no-op: the gate is asked after the dedup (SPEC §6a)");
  const same = await updateUpload(owner.http, docId, { body: r2, timeoutMs: HTTP_MS });
  assert.deepEqual({ status: same.status, ...pick(same.json, ["versionId", "deduped"]) }, { status: 200, versionId: "v2", deduped: true }, "an identical update with a suggestion pending");

  ctx.step("the owner accepts it through accept_suggestion: the change is in the draft; an update is now 409 acceptedInDraft and leaves the draft");
  const acc = await oMcp.call("accept_suggestion", { id: docId, threadId: sug.json.threadId });
  precondition(!acc.isError && acc.json?.inDraft === true, `accept_suggestion: ${acc.text.slice(0, 300)}`);
  const draftBefore = await readDraftObject(target, docId, "index.html");
  precondition(draftBefore && String(draftBefore).includes("revision two of"), "the accepted change is in the draft");
  const held = await updateUpload(owner.http, docId, { body: r3, timeoutMs: HTTP_MS });
  assert.deepEqual({ status: held.status, json: held.json }, { status: 409, json: { error: ACCEPTED_ONE, acceptedInDraft: 1 } }, "/publish?update= over a draft holding an accepted change");
  const heldTool = await oMcp.call("update_document", { id: docId, content: r3, baseVersion: "v2" });
  assert.ok(heldTool.isError && heldTool.text.includes(ACCEPTED_ONE), `update_document over the accepted change: ${heldTool.text.slice(0, 300)}`);
  await nothingAt("the acceptedInDraft refusals", "v3", ["v1", "v2"]);
  assert.equal(sha(await readDraftObject(target, docId, "index.html")), sha(draftBefore), "the refused updates left the draft as it was");

  ctx.step("the in-app commit is not held: it publishes the draft as v3, with the accepted change");
  const commit = await owner.http.postJson("/commit", { docId, baseVersion: "v2" });
  assert.deepEqual({ status: commit.status, ...pick(commit.json, ["versionId", "deduped"]) }, { status: 200, versionId: "v3", deduped: false }, `/commit: ${commit.text.slice(0, 200)}`);
  assert.ok(String(await versionObject(docId, "v3", "index.html")).includes("This is revision two of the versions document."), "v3 holds the accepted replacement");
});

// --- A12.6 ----------------------------------------------------------------------

scenario("A12.6 a stale base is refused naming the current version (/publish?update=, update_document, /draft, /commit), identical bytes included; update_document counts threadsLeftBehind, and a deduplicated update leaves none", { tiers: BOTH, timeoutMs: 360_000, ...STALLS }, async (ctx) => {
  ctx.step("cast an owner; publish revision 1 and update it to revision 2 (v2)");
  const { owner } = await castWithOwner(ctx, []);
  const title = `A12.6 stale ${tag()}`;
  const docId = await publishDoc(ctx, owner, { title, name: "a126-stale" });
  const r2 = docHtml(title, 2);
  await updateTo(ctx, owner.http, docId, { body: r2, baseVersion: "v1", want: "v2" });
  const r3 = docHtml(title, 3);

  ctx.step("/publish?update=&baseVersion=v1: 409 naming v2, for new bytes and for v2's own bytes alike");
  for (const [label, body] of [["new bytes", r3], ["v2's bytes", r2]]) {
    const s = await updateUpload(owner.http, docId, { body, baseVersion: "v1", timeoutMs: HTTP_MS });
    assert.deepEqual({ status: s.status, json: s.json }, { status: 409, json: { error: staleUpload("v2", "v1"), currentVersion: "v2" } }, `/publish?update= with a stale base, ${label}`);
  }
  assert.deepEqual({ versions: await versionIds(docId), objects: await objectsUnder(docId, "v3/") }, { versions: ["v1", "v2"], objects: [] }, "the stale refusals minted and uploaded nothing");

  ctx.step("update_document with baseVersion v1: refused naming v2");
  const mcp = await mcpFor(ctx, owner, "owner-mcp");
  const t = await mcp.call("update_document", { id: docId, content: r3, baseVersion: "v1" });
  assert.equal(t.isError, true, `update_document with a stale base: ${t.text.slice(0, 200)}`);
  assert.ok(t.text.includes(staleTool("v2", "v1")), `update_document names the current version: ${t.text.slice(0, 300)}`);

  ctx.step("the app's paths: POST /draft and POST /commit on v1 are 409 with currentVersion v2");
  const dr = await owner.http.postJson("/draft", { docId, baseVersion: "v1", html: r3 });
  assert.deepEqual({ status: dr.status, json: dr.json }, { status: 409, json: { error: STALE_DRAFT, currentVersion: "v2" } }, "POST /draft on a stale base");
  const cm = await owner.http.postJson("/commit", { docId, baseVersion: "v1" });
  assert.deepEqual({ status: cm.status, json: cm.json }, { status: 409, json: { error: STALE_COMMIT, currentVersion: "v2" } }, "POST /commit on a stale base");
  assert.deepEqual({ versions: await versionIds(docId), draft: (await docRecord(docId)).draft ?? null }, { versions: ["v1", "v2"], draft: null }, "nothing minted, no draft written");

  ctx.step("an open thread on v2, then update_document on the fresh base v2: v3, threadsLeftBehind 1, the thread stays open on v2");
  const thread = await addComment(mcp, docId, 2, `A12.6 open thread ${tag()}`);
  const fresh = await mcp.call("update_document", { id: docId, content: r3, baseVersion: "v2" });
  assert.equal(fresh.isError, false, `update_document on the fresh base: ${fresh.text.slice(0, 300)}`);
  assert.deepEqual(pick(fresh.json, ["versionId", "deduped", "threadsLeftBehind"]), { versionId: "v3", deduped: false, threadsLeftBehind: 1 }, "update_document on the fresh base mints v3 and counts the one open thread it leaves behind (SPEC §19)");
  assert.deepEqual({ v2: await openThreads(docId, "v2"), v3: await openThreads(docId, "v3") }, { v2: [thread], v3: [] }, "the thread stays on the version it was opened on");

  ctx.step("an open thread on v3, then the identical content again on v3: deduped, threadsLeftBehind 0");
  await addComment(mcp, docId, 3, `A12.6 second thread ${tag()}`);
  const dd = await mcp.call("update_document", { id: docId, content: r3, baseVersion: "v3" });
  assert.equal(dd.isError, false, dd.text.slice(0, 300));
  assert.deepEqual(pick(dd.json, ["versionId", "deduped", "threadsLeftBehind"]), { versionId: "v3", deduped: true, threadsLeftBehind: 0 }, "a deduplicated update leaves nothing behind");
  assert.deepEqual(await versionIds(docId), ["v1", "v2", "v3"], "the deduplicated update minted nothing");
});

/*
 * The late save is the shape of an autosave still in flight when Save is
 * pressed: DocViewer.tsx's Save flushes and commits, but never cancels the
 * debounced autosave (useInlineEditor.ts), whose POST /draft still names the
 * base the commit is superseding. saveDraft checks that base against
 * currentVersion with a plain read (functions/src/index.ts:1175), and
 * writeDraft then uploads the entry to Storage (functions/src/lib/draft.ts:109)
 * and only after that writes the record (:121), outside any transaction. A
 * save whose check comes before the commit's transaction moves the pointer
 * (draft.ts:295), and whose write comes after it, leaves a draft on the
 * superseded base.
 *
 * Each attempt sends both at once, the late save RACE_LEAD_MS first, and it
 * carries RACE_PAD_BYTES of padding in an HTML comment, which holds it between
 * its check and its write for the length of that upload. Measured on
 * 2610130023-l7wb against the commit's transaction (v2's publishedAt, 29–53 ms
 * after the late save was sent): a 1 MB save wrote before it (6 of 6, no race),
 * a 2 MB one 2–8 ms after it, a 4 MB one 12–49 ms after it (12 of 12 stale),
 * and a 4 MB save's check alone is answered in 25–34 ms. Nothing is polled, so
 * on production the race costs no Storage list calls. The earlier trigger
 * (the commit's v2 bytes seen in Storage, listed every 50 ms) sent the late
 * save after the pointer had moved in 5 of 6 runs there: every one was refused
 * 409, and the case passed unexpectedly with nothing measured.
 *
 * Only the server sees the order of the late save's check, the transaction
 * and its write. So an attempt has RUN the race when it left a stale draft
 * (which proves that order), or when both requests were in flight together
 * (each sent before the other was answered: lib/sync.mjs overlapProof's
 * shape) and the late save was refused, as a fixed product refuses it. One
 * answered 200 with no draft left landed first and measured nothing, and the
 * case is INCONCLUSIVE when no attempt ran the race (seen: a copy with no
 * padding, whose late saves all landed first). Under the defect a 409 is a
 * check that came after the pointer moved, so five of those in a row would
 * pass it unexpectedly: none of the 25 measured attempts at 2–4 MB was one
 * (at 8 MB, 2 of 8 were: the larger body reached the check later).
 */
const RACE_PAD_BYTES = 4_000_000;
const RACE_LEAD_MS = 15;
const RACE_ATTEMPTS = 5;

/** An HTML comment of about `n` bytes. */
const padding = (n) => `<!-- ${"a late autosave, padded ".repeat(Math.ceil(n / 24)).slice(0, n)} -->`;

scenario("A12.6 (racing a commit) a POST /draft on the base a concurrent commit is superseding is refused or lands first: it never leaves a draft on the superseded version, which GET /draft would serve to every editor (SPEC §2)", { tiers: BOTH, timeoutMs: 480_000, ...STALLS }, async (ctx) => {
  ctx.step(`cast an owner; per attempt (at most ${RACE_ATTEMPTS}): publish revision 1, save revision 2 as the draft of v1, then a late POST /draft on v1 padded to ${RACE_PAD_BYTES} bytes and, ${RACE_LEAD_MS} ms after it, POST /commit`);
  const { owner } = await castWithOwner(ctx, []);
  const rows = [];
  for (let attempt = 1; attempt <= RACE_ATTEMPTS; attempt += 1) {
    const title = `A12.6 race ${tag()}`;
    const docId = await publishDoc(ctx, owner, { title, name: "a126-race" });
    await owner.http.postJson("/draft", { docId, baseVersion: "v1", html: docHtml(title, 2) }, { expect: 200 });
    const lateHtml = docHtml(title, 2, " A late autosave.") + padding(RACE_PAD_BYTES);
    const ms = {};
    const t0 = Date.now();
    const timed = (key, p) => p.then((r) => ((ms[key] = Date.now() - t0), r));
    const lateSent = timed("lateAnswered", owner.http.postJson("/draft", { docId, baseVersion: "v1", html: lateHtml }));
    lateSent.catch(() => undefined); // judged below, where it is awaited
    await new Promise((resolve) => setTimeout(resolve, RACE_LEAD_MS));
    ms.commitSent = Date.now() - t0;
    const [late, c] = await Promise.all([lateSent, timed("commitAnswered", owner.http.postJson("/commit", { docId, baseVersion: "v1" }))]);
    precondition(c.status === 200 && c.json?.versionId === "v2", `/commit: ${c.status} ${c.text.slice(0, 200)}`);
    precondition(late.status === 200 || late.status === 409, `the late POST /draft was answered ${late.status} ${late.text.slice(0, 200)}`);
    const rec = await docRecord(docId);
    // The commit's transaction, by the server's clock (functions/src/lib/draft.ts now() is a server timestamp).
    ms.pointerMoved = ((await versionRecord(docId, "v2"))?.publishedAt?.toMillis?.() ?? NaN) - t0;
    // What an editor's frame loads in edit mode (frameMode.ts frameSrc) and an editor reading the head with a draft present.
    const served = await owner.http.get(`/draft/${docId}/index.html`);
    const says = /This is revision (\d+) of the versions document\.( A late autosave\.)?/.exec(served.text ?? "");
    const draftBase = rec.draft?.baseVersion ?? null;
    const stale = draftBase !== null && draftBase !== rec.currentVersion;
    const inFlightTogether = ms.commitSent < ms.lateAnswered;
    const row = {
      attempt,
      docId,
      lateDraft: late.status,
      inFlightTogether,
      ms,
      currentVersion: rec.currentVersion,
      draftBase,
      draftObjects: (await objectsUnder(docId, "draft/")).length,
      getDraftServes: says ? `revision ${says[1]}${says[2] ? " with the late autosave" : ""}` : `HTTP ${served.status}`,
      raced: stale ? "yes: a draft was left on the superseded base" : !inFlightTogether ? "no: the late save was answered before the commit was sent" : late.status === 409 ? "yes: the late save was refused" : "no: the late save landed first, and the commit cleared its draft",
    };
    rows.push(row);
    ctx.step(`attempt ${attempt}: ${JSON.stringify(row)}`);
    if (stale) break;
  }
  ctx.ev.json("race", rows);
  const stale = rows.filter((r) => r.draftBase !== null && r.draftBase !== r.currentVersion);
  if (stale.length === 0 && !rows.some((r) => r.raced.startsWith("yes"))) ctx.inconclusive(`no attempt ran the race (none left a stale draft, and in none was the late save refused while both were in flight), so nothing was measured: ${JSON.stringify(rows.map((r) => r.raced))}`);
  assert.deepEqual(stale, [], "no draft is left on a superseded base: POST /draft is 409 when baseVersion !== currentVersion (SPEC §2), but saveDraft checks outside any transaction and writeDraft sets the draft unconditionally");
});

// --- A12.7 ----------------------------------------------------------------------

/** Lines of operator output with any bucket URL replaced, for evidence. */
const BUCKET_URL = new RegExp(`${["g", "s"].join("")}:\\/\\/\\S+`, "g");
const scrub = (s) => String(s ?? "").replace(BUCKET_URL, "<bucket>");

/** delete-version.mjs against the stack, its output kept (scrubbed) in the case's steps. */
async function deleteVersion(ctx, args, label) {
  const r = await runOperator(target, "delete-version.mjs", args, { timeoutMs: 120_000 });
  ctx.step(`delete-version ${label}: exit ${r.code}\n${scrub(r.stdout).trim()}\n${scrub(r.stderr).trim()}`);
  return r;
}

/** A view session for `versionId` through POST /view, as the viewer reading it. */
async function recordViewOf(session, docId, versionId) {
  const sessionId = `a12${randomBytes(8).toString("hex")}`;
  const r = await session.http.postJson("/view", { docId, versionId, sessionId, ms: 1500 });
  precondition(r.status === 200, `POST /view ${versionId}: ${r.status} ${r.text.slice(0, 200)}`);
  return sessionId;
}

scenario("A12.7 delete-version.mjs: each refusal and the dry run write nothing; the real run repoints and removes the version's bytes, record, annotations, draft and thumbnails, retags its views and the stats; the next update re-mints the id clean", { tiers: ["local"], needs: ["operator-scripts"], timeoutMs: 480_000, ...STALLS }, async (ctx) => {
  ctx.step("cast an owner and a viewer; publish revision 1, share it, update to revision 2 (v2)");
  const { owner, accounts } = await castWithOwner(ctx, ["viewer"]);
  const ownerEmail = accounts[0].email.toLowerCase();
  const title = `A12.7 withdraw ${tag()}`;
  const docId = await publishDoc(ctx, owner, { title, name: "a127-withdraw" });
  await grant(ctx, owner, docId, accounts[1], "viewer");
  const viewer = await sessionFor(ctx, accounts[1]);
  const r2 = docHtml(title, 2);
  await updateTo(ctx, owner.http, docId, { body: r2, baseVersion: "v1", want: "v2" });

  ctx.step("on v2: a view session, a cover thumbnail, a thread with one comment, and the owner's draft; one view session on v1 too");
  const [sid1, sid2] = [await recordViewOf(viewer, docId, "v1"), await recordViewOf(viewer, docId, "v2")];
  // lib/thumbs.mjs: the smallest JPEG the server accepts, at the stack tree's THUMB_REVISION.
  const th = await postThumb(owner.http, { docId, versionId: "v2", kind: "cover" });
  precondition(th.status === 200 && th.json?.stored === true, `POST /thumb: ${th.status} ${th.text.slice(0, 200)}`);
  const mcp = await mcpFor(ctx, owner, "owner-mcp");
  await addComment(mcp, docId, 2, `A12.7 thread on v2 ${tag()}`);
  await owner.http.postJson("/draft", { docId, baseVersion: "v2", html: docHtml(title, 2, " Drafted.") }, { expect: 200 });
  const epoch = (await docRecord(docId)).liveEpoch ?? "initial";
  const live = rtdbAs(target, { idToken: owner.idToken, http: ctx.http({ actor: "owner-live-log" }) });
  const logged = await live.put(`status/${docId}/y/${epoch}/withdrawalProbe`, "AAA=");
  precondition(logged.status === 200, `the owner wrote a retiring live-log entry: ${logged.status}`);

  const initialEventCounts = { "version.published": 2, "access.changed": 1, "thread.opened": 1, "comment.added": 1 };
  await settleLog(target, docId, initialEventCounts, { message: "withdrawal setup events" });

  /** Everything the withdrawal touches, as plain data. */
  const snapshot = async () => {
    const rec = await docRecord(docId);
    const views = Object.fromEntries((await readCollection(target, `docs/${docId}/views`)).map((r) => [r.id, r.data.versionId]));
    return {
      events: plain(await changeLog(target, docId)),
      currentVersion: rec.currentVersion,
      liveEpoch: rec.liveEpoch ?? "initial",
      liveLog: await rtdbGet(target, `status/${docId}/y`),
      draft: rec.draft ? rec.draft.baseVersion : null,
      thumb: rec.thumb ? rec.thumb.versionId : null,
      commits: rec.stats?.commits ?? null,
      lastEditedByEmail: rec.stats?.lastEditedByEmail ?? null,
      updatedAt: rec.updatedAt?.toMillis?.() ?? null,
      versions: await versionIds(docId),
      v2Annotations: (await readCollection(target, `docs/${docId}/versions/v2/annotations`)).length,
      objects: { v1: await objectsUnder(docId, "v1/"), v2: await objectsUnder(docId, "v2/"), draft: await objectsUnder(docId, "draft/"), thumbsV2: await objectsUnder(docId, "thumbs/v2/") },
      views,
    };
  };
  const before = await snapshot();
  precondition(before.liveLog?.[epoch]?.withdrawalProbe === "AAA=", "the retiring live log exists before withdrawal");
  precondition(
    before.currentVersion === "v2" && before.draft === "v2" && before.thumb === "v2" && before.commits === 1 && before.v2Annotations === 1 && before.objects.v2.length === 1 && before.objects.thumbsV2.length === 1 && before.objects.draft.length === 1,
    `the setup is in place: ${JSON.stringify(before)}`,
  );
  assert.deepEqual(before.views, { [sid1]: "v1", [sid2]: "v2" }, "the view sessions name their versions");
  ctx.ev.json("before", before);

  const base = ["--doc", docId, "--project", target.projectId];
  const real = [...base, "--yes", "--account", ownerEmail];
  const refusals = [
    { label: "without --yes", args: [...base, "--version", "v2", "--account", ownerEmail], err: "refusing to delete without --yes (use --dry-run to preview)" },
    { label: "without --account", args: [...base, "--version", "v2", "--yes"], err: "`--account <email>` is required for real runs" },
    { label: "a version that is not current", args: [...real, "--version", "v1"], err: "refusing: v1 is not the current version (v2). Pass --allow-non-current if you really mean to remove a superseded version." },
    { label: "while a draft exists", args: [...real, "--version", "v2"], err: `refusing: a draft exists (base=v2, by ${ownerEmail}). Repointing currentVersion would silently revive or strand it. Pass --drop-draft to discard it as part of this operation.` },
    { label: "a version with annotations", args: [...real, "--version", "v2", "--drop-draft"], err: "refusing: v2 carries 1 annotation(s) and 1 comment(s), which would be destroyed permanently. Export them first, then pass --allow-annotations." },
    { label: "a version that does not exist", args: [...real, "--version", "v9", "--drop-draft", "--allow-annotations"], err: "version not found: v9" },
  ];
  for (const r of refusals) {
    ctx.step(`refusal: ${r.label}`);
    const out = await deleteVersion(ctx, r.args, r.label);
    assert.equal(out.code, 1, `${r.label}: exit ${out.code}`);
    assert.ok(out.stderr.includes(`error: ${r.err}`), `${r.label}: stderr says ${JSON.stringify(scrub(out.stderr).trim().split("\n").at(-1))}`);
  }
  const single = await publishDoc(ctx, owner, { title: `${title} single`, name: "a127-single" });
  const one = await deleteVersion(ctx, ["--doc", single, "--project", target.projectId, "--yes", "--account", ownerEmail, "--version", "v1"], "the only version");
  assert.deepEqual({ code: one.code, said: one.stderr.includes(`error: refusing: v1 is the only version of ${single}`) }, { code: 1, said: true }, "the only version is refused");
  assert.deepEqual(await versionIds(single), ["v1"]);
  assert.deepEqual(await snapshot(), before, "no refusal wrote anything");

  ctx.step("the dry run prints the plan and writes nothing");
  const dry = await deleteVersion(ctx, [...base, "--version", "v2", "--drop-draft", "--allow-annotations", "--dry-run"], "--dry-run");
  assert.equal(dry.code, 0, `dry run exit ${dry.code}: ${scrub(dry.stderr).slice(0, 300)}`);
  for (const line of [
    `plan for ${docId}:`,
    "repoint currentVersion: v2 -> v1",
    "discard the draft (base=v2) and its objects",
    `/${(await versionRecord(docId, "v2")).storagePrefix ?? `docs/${docId}/v2`}/ (1 object(s), ${Buffer.byteLength(r2)} bytes)`,
    `/docs/${docId}/thumbs/v2/ (1 thumbnail(s))`,
    "clear thumb: it names v2",
    `delete Firestore: docs/${docId}/versions/v2 (+1 annotation(s), 1 comment(s))`,
    "stats.commits: 1 -> 0 (and clear lastEditedAt/lastEditedByEmail)",
    'retag 1 view session(s): versionId "v2" -> "v2-deleted"',
    "--dry-run: nothing was written.",
  ]) assert.ok(dry.stdout.includes(line), `the dry run's plan says ${JSON.stringify(line)}`);
  assert.deepEqual(await snapshot(), before, "the dry run wrote nothing");

  ctx.step("the real run withdraws v2");
  const run = await deleteVersion(ctx, [...real, "--version", "v2", "--drop-draft", "--allow-annotations"], "real run");
  assert.equal(run.code, 0, `exit ${run.code}: ${scrub(run.stderr).slice(0, 300)}`);
  assert.ok(run.stdout.includes(`withdrew ${docId}/v2; currentVersion is now v1.`), "it says what it did");
  await settleLog(target, docId, { ...initialEventCounts, "version.withdrawn": 1 }, { message: "exactly one withdrawal event" });
  const afterRun = await snapshot();
  const withdrawals = afterRun.events.filter((event) => event.data.type === "version.withdrawn");
  assert.deepEqual(withdrawals.map(({ data }) => pick(data, ["type", "audience", "version"])), [{ type: "version.withdrawn", audience: "readers", version: "v2" }], "withdrawal records the removed version exactly once for readers");
  assert.deepEqual(afterRun.events.filter((event) => event.data.type !== "version.withdrawn"), before.events, "withdrawal preserves all preceding events");
  const viewerMcp = await mcpFor(ctx, viewer, "viewer-withdrawal-mcp");
  const feed = await viewerMcp.ok("get_changes", { id: docId, since: "all", includeMine: true });
  assert.deepEqual(feed.events.filter((event) => event.type === "version.withdrawn").map((event) => pick(event, ["type", "version"])), [{ type: "version.withdrawn", version: "v2" }], "a viewer reads the withdrawal event through MCP");
  assert.match(afterRun.liveEpoch, /^[a-f0-9-]{36}$/, "withdrawal selects a fresh live epoch");
  assert.notEqual(afterRun.liveEpoch, before.liveEpoch, "withdrawal retires the previous live epoch");
  assert.equal((await rtdbGet(target, `editAccess/${docId}`))?.__liveEpoch, afterRun.liveEpoch, "withdrawal publishes the new live epoch to the edit-access mirror");
  ctx.ev.json("after", afterRun);
  const v1rec = await versionRecord(docId, "v1");
  assert.deepEqual(afterRun, {
    events: afterRun.events,
    currentVersion: "v1",
    liveEpoch: afterRun.liveEpoch,
    liveLog: null,
    draft: null,
    thumb: null,
    commits: 0,
    lastEditedByEmail: null,
    updatedAt: v1rec.publishedAt.toMillis(),
    versions: ["v1"],
    v2Annotations: 0,
    objects: { v1: before.objects.v1, v2: [], draft: [], thumbsV2: [] },
    views: { [sid1]: "v1", [sid2]: "v2-deleted" },
  }, "the withdrawal (SPEC §4, §9)");

  ctx.step("readers: v2's bytes are a 404, the document reads v1 again");
  const gone = await owner.http.get(`/content/${docId}/v2/index.html`);
  assert.equal(gone.status, 404, "the withdrawn version's content");
  const reads = await mcp.ok("get_document", { id: docId });
  assert.equal(reads.version, "v1", "get_document reads v1");

  ctx.step("the next update re-mints v2 (SPEC §4) with its own bytes, no annotations and no thumbnail; the old view keeps its tombstone");
  const r3 = docHtml(title, 3);
  const re = await updateUpload(owner.http, docId, { body: r3, baseVersion: "v1", timeoutMs: HTTP_MS });
  assert.deepEqual({ status: re.status, ...pick(re.json, ["versionId", "deduped"]) }, { status: 200, versionId: "v2", deduped: false }, "the withdrawn id is re-used");
  const remintedEvents = await settleLog(target, docId, { ...initialEventCounts, "version.published": 3, "version.withdrawn": 1 }, { message: "re-mint records one new publication" });
  const newPublications = remintedEvents.filter(({ id }) => !afterRun.events.some((event) => event.id === id));
  assert.deepEqual(newPublications.map(({ data }) => pick(data, ["type", "audience", "version"])), [{ type: "version.published", audience: "readers", version: "v2" }], "re-mint emits one new v2 publication after its withdrawal");
  assert.equal(sha(await versionObject(docId, "v2", "index.html")), sha(Buffer.from(r3)), "the new v2 holds the new bytes");
  assert.deepEqual({
    annotations: (await readCollection(target, `docs/${docId}/versions/v2/annotations`)).length,
    thumb: (await docRecord(docId)).thumb ?? null,
    thumbs: await objectsUnder(docId, "thumbs/v2/"),
    oldView: (await readDoc(target, `docs/${docId}/views/${sid2}`)).versionId,
  }, { annotations: 0, thumb: null, thumbs: [], oldView: "v2-deleted" }, "nothing of the withdrawn v2 attaches to the new one");
});

scenario("A12.7 (public projection) withdrawing the current version of a public document repoints public/{docId} too, so an anonymous reader opens the version that remains", { tiers: ["local"], needs: ["operator-scripts"], timeoutMs: 300_000, ...STALLS }, async (ctx) => {
  ctx.step("cast an owner; publish revision 1, update to revision 2, make it public");
  const { owner, accounts } = await castWithOwner(ctx, []);
  const ownerEmail = accounts[0].email.toLowerCase();
  const title = `A12.7 public ${tag()}`;
  const docId = await publishDoc(ctx, owner, { title, name: "a127-public" });
  await updateTo(ctx, owner.http, docId, { body: docHtml(title, 2), baseVersion: "v1", want: "v2" });
  try {
    await setVisibility(target, { owner, doc: docId, visibility: "public", timeoutMs: HTTP_MS, patient: { ctx, stopAt: "budget" } });
    const row = await eventually(async () => (await readDoc(target, `public/${docId}`)) ?? false, { timeout: 10_000, message: "public/{docId} exists" });
    precondition(row.currentVersion === "v2", `the projection names v2: ${JSON.stringify(row)}`);

    ctx.step("delete-version withdraws v2");
    const run = await deleteVersion(ctx, ["--doc", docId, "--project", target.projectId, "--yes", "--account", ownerEmail, "--version", "v2"], "real run");
    precondition(run.code === 0 && (await docRecord(docId)).currentVersion === "v1", `the withdrawal ran: exit ${run.code} ${scrub(run.stderr).slice(0, 300)}`);
    const current = await docRecord(docId);
    const publicAfter = await readDoc(target, `public/${docId}`);

    ctx.step("an anonymous reader opens /d/<doc>, which resolves the version from public/{docId} (useDocument.ts resolveReader)");
    const anon = await reader(ctx, "anonymous");
    await anon.open(docId);
    const src = await frameSrc(anon);
    const contentStatus = (await ctx.http({ actor: "anonymous", timeoutMs: HTTP_MS, cutoffError: true }).get(src)).status;
    const projection = (await readDoc(target, `public/${docId}`))?.currentVersion ?? null;
    const observed = { projection, frameVersion: srcVersion(src, docId), contentStatus };
    ctx.ev.json("anonymous", { src, ...observed });
    ctx.step(`observed ${JSON.stringify(observed)}`);
    assert.deepEqual(observed, { projection: "v1", frameVersion: "v1", contentStatus: 200 }, "public/{docId} follows the repoint, and the anonymous reader loads v1");
    assert.notEqual(current.liveEpoch, row.liveEpoch ?? "initial", "public withdrawal retires the previous live epoch");
    assert.equal(publicAfter?.liveEpoch, current.liveEpoch, "public readers receive the repointed live epoch");
  } finally {
    await setVisibility(target, { owner, doc: docId, visibility: "private", timeoutMs: HTTP_MS }).catch(() => undefined);
  }
});
