// SPDX-License-Identifier: Apache-2.0
// A9 editing and commit: the edit frame, autosave, formatting, markers, draft banners, Done, commit gates, stale saves, the §7 walkthrough and deck fitting (SPEC §6a).

/**
 * One scenario per catalogue case, each with its own accounts and document:
 *
 *   A9.1  Edit on a TRUSTED document remounts the frame: a new iframe element,
 *         sandbox exactly "allow-same-origin", src /draft/<doc>/<entry>?r=N,
 *         an editable body, and a toolbar named "Formatting"
 *   A9.2  autosave: dirty → saving → saved, the save at least 1 s after the
 *         last keystroke, ONE POST /draft per pause, carrying the current
 *         baseVersion (v2 here, so a hard-coded "v1" cannot pass)
 *   A9.3  Bold, Italic, Underline, Strikethrough, Text colour, Font and the
 *         block select each change the text they were used on, and neither
 *         the frame nor the draft holds a <font>
 *   A9.4  the empty-container marking (data-bshd-empty and its stylesheet) is
 *         in the live edit frame and never in the draft
 *   A9.5  with a draft saved, an editor reads it under the banner and the
 *         label "v1 · draft"; a viewer reads v1 with neither
 *   A9.6  Done within 1 s of the last key saves that key; Done with no edit
 *         sends no POST /draft and leaves no draft
 *   A9.6  (X-a09-editing-1) a Done save slower than the debounce: Done's
 *         flush does not cancel the pending autosave (useInlineEditor.ts
 *         flush), so the timer fires during Done's save and posts the same
 *         edit a second time; one pause, one POST is the oracle
 *   A9.7 an open comment makes POST /commit 409 {unresolvedCount: 1} and the
 *         button disabled with its reason; resolved, the same commit is 200
 *   A9.8  a commit from the app: "Published v2.", publishedVia "editor",
 *         parentVersion "v1", no meta.draft
 *   A9.8  (S8, a SPEC QUESTION) …and the live log status/{doc}/y empty
 *         within 2 s, measured by the commit case and judged by its own:
 *         the app's own code means to clear it, and no SPEC sentence
 *         requires it of the in-app commit (see the case)
 *   A9.8  (X-a09-editing-1) Save pressed inside the debounce: no explicit
 *         save cancels the pending autosave (useInlineEditor.ts flush), so
 *         the timer still fires and posts the same edit again; when that
 *         POST /draft arrives after the commit it is refused as stale and the
 *         publisher is told somebody else published
 *   A9.9  a failed pre-commit save: the toast, and no POST /commit
 *   A9.10 an autosave against a superseded base: 409 and the toast; the
 *         base is superseded by a commit of the draft made while the editor
 *         edits, since an update is refused under somebody's editor (0.16.0)
 *   A9.11 docs/development/verification.md §7 on the scripted sample
 *   A9.11 BODYATTR on that commit
 *   A9.12 the scripted sample's script runs when trusted and reading, and not
 *         in the edit frame
 *   A9.13 a <style> put into <head> after load (an extension's) is not in
 *         the draft, while the author's is
 *   A9.14 a document's own data-bshd="whatever" survives the draft and the
 *         commit
 *   A9.15 a deck that sizes its slides by script is fitted by scaling the
 *         IFRAME in edit mode; the document's own styles are not touched
 *
 * Every account opts out of email before its first session (cast's
 * {notifications: false}: users/{uid} {emailNotifications: false}) and the two
 * cases that comment assert quietDoc() first, so no case sends a comment
 * notice. Sharing goes through share().
 *
 * Fixed waits: only where an ABSENCE is the oracle and the product is
 * time-based — the autosave debounce is 1 s (useInlineEditor.ts AUTOSAVE_MS),
 * so "no further POST /draft" (or toast) is watched for 2.5 s, and "no POST
 * /commit" for 2 s after the toast that the failed save produced (a commit
 * would be sent before that toast, not after it). What the page SENT is read
 * from User.capture, started before the action. One request is DELAYED
 * rather than failed (User.delayRequests), to make the pre-commit save slower
 * than the debounce (1.5 s) and to deliver the autosave after the commit
 * (until the commit has answered): the order a slow network can deliver them
 * in. A failed save is User.failRequests.
 *
 * Every user signs in through /signup (signInUi, sent again when the stack
 * cut its POST /session off) and then opens the document with User.open's
 * `reloads: 1` and `sessionCheck`: a load the stack stalled is loaded once
 * more, and a load whose own POST /session was cut off (the app then goes
 * signed out, with no Edit to press) too. The file declares its budget
 * (E2E_FILE_TIMEOUT_MS, below): its cases' own bounds sum past the 60
 * minutes lib/budget.mjs caps a computed one at, and a slow case late in
 * the file must end itself, not cancel the cases after it. On a quiet
 * stack the file takes about 15 minutes.
 *
 * Timing is read on the page's own clock (User.recordSaveStates: keystrokes
 * from a capture-phase input listener on the frame document, the start of a
 * save from the save-state attribute; the Done click from a capture-phase
 * click listener on the button). A case whose keystrokes or click did not
 * land inside the debounce ends INCONCLUSIVE, never PASS.
 *
 * The same structural probe is asked of the live frame (frame.mjs
 * inFrameDoc, from the parent's realm, so the scriptless edit frame is no
 * obstacle) and of stored bytes (bytes.mjs parseAndRun).
 *
 * S8 is judged only where the realtime rules are enforced in the app's
 * namespace (rtdb.mjs rtdbRulesStatus, live): without them the whole-log
 * remove the defect hinges on is allowed, and the case would pass blind.
 *
 * WHEN THE STACK DOES NOT ANSWER. On the loaded shared stack (run 0a2t,
 * invocation 9vq2, 2026-10-12: a load average of 41–53 on 16 CPUs, its
 * Firestore emulator near 380% CPU) a POST /session took 37–47 s, a POST
 * /publish 32–59 s, and POST /trust, POST /publish?update= and POST /publish
 * got no answer at all within 60 s; a page then never got its frame. The
 * product answered none of that, so nothing was measured, and this file used
 * to report it as a FAIL. So, as a07 and a08 do:
 *   - every setup call goes through lib/test.mjs untilLanded (publish's and
 *     share's `patient`, the account casts, POST /session, POST /trust, POST
 *     /publish?update=, a POST /draft and POST /commit sent from a session
 *     rather than a page, the agent's token): sent
 *     again only after its effect was looked for, and INCONCLUSIVE when the
 *     stack keeps not answering past ENV_BUDGET_MS into the case;
 *   - every session and agent client is made with `cutoffError: true`, so
 *     Hosting's cut-off 504 to a request the case judges throws
 *     E2E_STACK_CUTOFF instead of reaching an assertion as a 504;
 *   - every document is opened with User.open's `reloads` and
 *     `sessionCheck`, and every answer the case reads off a page (an
 *     autosave, a pre-commit save, a commit) goes through `answered()`;
 *   - every case that does anything declares ON_STACK, below: a wait that
 *     ran out (the case's own budget included) is INCONCLUSIVE only with
 *     evidence in its window that the stack stalled, from a page, from the
 *     case's own requests, or from its own requests answered 30 s or more
 *     late. An answer, however slow, is still judged, and an assertion
 *     still FAILS.
 * The two cases that judge what another case measured (S8, BODYATTR) end
 * INCONCLUSIVE when that case never got to measure it: nothing was measured.
 */

import { readLiveLogs } from "../../lib/live-log.mjs";
import { delayHostingResponse } from "../../lib/response-delay.mjs";
import assert from "node:assert/strict";
import { after } from "node:test";
import { answered, currentTarget, precondition, scenario, untilLanded } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { publish, readFixture, readSample, updateUpload } from "../../lib/seed.mjs";
import { share } from "../../lib/grant.mjs";
import { readDraftObject, draftStoragePrefix, closeAdmin, readDoc, readObject, rtdbGet } from "../../lib/admin.mjs";
import { quietDoc } from "../../lib/guard.mjs";
import { eventually } from "../../lib/assert.mjs";
import { frameText, inFrameDoc } from "../../lib/frame.mjs";
import { KNOWN_OWN_VALUES, bodyAttrDiff, decorations, diffFingerprint, entryHtml, fingerprint, foreignMarkers, parseAndRun, rehashZip, summarize } from "../../lib/bytes.mjs";
import { rtdbRulesStatus } from "../../lib/rtdb.mjs";
import { zipFiles } from "../../lib/zipread.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIXTURE = "crdt-paragraphs.html";
const FIXTURE_HTML = target ? readFixture(FIXTURE) : "";
const TOUR = "bikeshed-tour";

/** The debounce, useInlineEditor.ts AUTOSAVE_MS. */
const AUTOSAVE_MS = 1000;
/** How long "nothing more is posted" is watched (see the header). */
const QUIET_MS = 2_500;

// --- the loaded stack's bounds (see WHEN THE STACK DOES NOT ANSWER) -------------
// None is an oracle: nothing here asserts a latency.

/** A function request, this process's: past Hosting's own minute, so a stalled one ends in its cut-off 504, never in the client's deadline first. */
const FN_MS = 150_000;
/** A sign-in, a document opening, the editor binding: each waits on function answers and the page's listeners, so past Hosting's cut-off. */
const OPEN_MS = 90_000;
/**
 * What a page shows once the stack has pushed it (a snapshot: Save as new
 * version greyed out or not, a version label, the draft stored). Longer than
 * the Firestore SDK's own 10 s before it reports "Could not reach Cloud
 * Firestore backend", so a lost listener leaves the evidence pageStall reads.
 */
const LATENCY_MS = 60_000;
/** A page's save, or what follows it (an autosave, Done, the error toast after a refusal): the debounce, then an answer that may take Hosting's whole minute. */
const SAVE_MS = 90_000;
/** Save as new version: the pre-commit save, then POST /commit, each of which may take Hosting's minute. */
const COMMIT_MS = 150_000;
/** How long into a case a setup call the stack did not answer is still sent again (untilLanded's stopAt); past it, a non-answer ends the case INCONCLUSIVE. */
const ENV_BUDGET_MS = 300_000;
/** A case's bound: a dozen sequential writes at the latencies above take minutes. */
const CASE_MS = 600_000;
/** The S8 and BODYATTR cases only read what another case measured. */
const JUDGE_MS = 30_000;
/** The file's budget (lib/budget.mjs, which takes a product only): its 17 cases at CASE_MS one after another, and the two judges' 30 s each, rounded up to one more. */
export const E2E_FILE_TIMEOUT_MS = 18 * CASE_MS;

/**
 * Every case's stack options (lib/test.mjs; see the header).
 * `inconclusiveOnHttpStall` implies `inconclusiveOnCaseTimeout` (the body
 * runs against a budget whose running out is a wait the length of the case)
 * and so `inconclusiveOnPageStall` and `inconclusiveOnStackTimeout`;
 * `inconclusiveOnRequestStall` adds the case's own requests cut off as
 * evidence beside its pages'.
 */
const ON_STACK = Object.freeze({ inconclusiveOnRequestStall: true, inconclusiveOnHttpStall: true });

const stopAts = new WeakMap();
/** untilLanded's options for this case: `stopAt` is fixed by its first call. */
function patience(ctx) {
  if (!stopAts.has(ctx)) stopAts.set(ctx, Date.now() + ENV_BUDGET_MS);
  return { stopAt: stopAts.get(ctx) };
}

/** Product copy, verbatim (DocViewer.tsx, edit.ts, useSuggestionReview.ts). */
const COPY = {
  stale: "Somebody published a newer version. Reload to continue.",
  staleSaveState: "This document has a newer version. Reload to continue editing.",
  saveFailed: "The draft didn’t save, so nothing was published. Try again.",
  unresolvedReason: "Resolve every comment first. Annotations belong to a version, so publishing would leave them behind.",
  unresolved409: "Resolve all comments before publishing a new version.",
};

/** An ASCII token: typed as plain keys, unique to this run and case. */
const tok = (label) => `A9${label}${runTag(target.runId)}${rand4()}`;

// --- cast and documents -------------------------------------------------------

/**
 * Accounts that get no comment email (see the header): users/{uid} opted out
 * before any session (cast's {notifications: false}). One role at a time,
 * through untilLanded: a cast the stack did not answer (the Auth emulator's
 * REST call past the client's deadline, the opt-out's Admin write
 * DEADLINE_EXCEEDED) is cast again at a fresh address, so the roles already
 * made are kept and a half-made account is only an extra ledger row. An
 * address the long-lived stack already holds (EMAIL_EXISTS) is replaced by
 * cast itself (`retryTaken`).
 */
async function castQuiet(ctx, roles) {
  const out = [];
  for (const role of roles) {
    const { out: made } = await untilLanded(ctx, `cast ${role}`, () => cast(target, [role], { notifications: false, retryTaken: 3 }), null, patience(ctx));
    out.push(made[0]);
  }
  return out;
}

/** A session (POST /session, safe to send again) whose client waits FN_MS and throws E2E_STACK_CUTOFF on Hosting's cut-off. */
async function sessionFor(ctx, acct) {
  const { out } = await untilLanded(ctx, `POST /session (${acct.role})`, () => openSession(target, acct, { timeoutMs: FN_MS, cutoffError: true }), null, patience(ctx));
  return out;
}

/** How many times a grant the stack left half-made (record, no mirror) is sent; see grant(). */
const GRANT_SENDS = 3;

/**
 * Give `account` `role` (lib/grant.mjs share with `patient`): sent again only
 * when the stack did not answer and the record does not show the grant. A
 * grant found in the record WITHOUT its realtime mirror was stopped between
 * the two writes (functions/src/lib/folders.ts persistDocMembership), and an
 * editor without the mirror cannot join the live session, so it is sent
 * again (the same role again recomputes the members and invites nobody, as
 * a08 found); still half-made after GRANT_SENDS, the case is INCONCLUSIVE.
 */
async function grant(ctx, { owner, docId, account, role }) {
  for (let send = 1; ; send += 1) {
    const r = await share(target, { owner, doc: docId, account, role, timeoutMs: FN_MS, patient: { ctx, ...patience(ctx) } });
    precondition(r.landed || r.status === 200, `share ${role}: ${r.status} ${JSON.stringify(r.json)}`);
    if (!r.landed || r.mirror?.ok !== false) return;
    const why = `POST /access ${role} ${account.email} took effect in the record though the stack did not answer it, and its realtime mirror never followed (${JSON.stringify(r.mirror)})`;
    if (send >= GRANT_SENDS || Date.now() >= patience(ctx).stopAt) ctx.inconclusive(`the stack did not make the grant, so nothing was measured: ${why}, ${send} time(s)`);
    ctx.step(`environment: ${why}; sending it again (send ${send + 1} of ${GRANT_SENDS})`);
  }
}

/**
 * An owner with a session, one document published through POST /publish
 * (patient), and `readers` ([{label, role}]) shared at their roles.
 */
async function stage(ctx, { name, title, fixture = FIXTURE, body = null, filename = "index.html", readers = [] }) {
  const accounts = await castQuiet(ctx, ["owner", ...readers.map((r) => r.label)]);
  const owner = await sessionFor(ctx, accounts[0]);
  const patient = { ctx, ...patience(ctx) };
  const up = body
    ? await publish(owner.http, { body, filename, title, name, timeoutMs: FN_MS, patient })
    : await publish(owner.http, { fixture, title, name, timeoutMs: FN_MS, patient });
  precondition(up.versionId === "v1", `publish answered ${up.status} ${JSON.stringify(up.json)}`);
  for (const [i, r] of readers.entries()) await grant(ctx, { owner, docId: up.docId, account: accounts[i + 1], role: r.role });
  ctx.step(`document ${up.docId}: owner ${accounts[0].email}${readers.map((r, i) => `, ${r.role} ${accounts[i + 1].email}`).join("")}`);
  return { owner, accounts, docId: up.docId };
}

/**
 * The scripted sample (H) through POST /publish, optionally trusted by its
 * owner. POST /trust sets docs/<id>.trusted (functions/src/index.ts
 * trustDoc), the effect looked for before it is sent again.
 */
async function stageTour(ctx, { name, trusted = false, readers = [] }) {
  const s = readSample(target, TOUR);
  const staged = await stage(ctx, { name, title: s.title, body: s.bytes, filename: s.filename, readers });
  if (trusted) {
    const { out: t, landed } = await untilLanded(ctx, "POST /trust", () => staged.owner.http.postJson("/trust", { docId: staged.docId, trusted: true }), async () => (await readDoc(target, `docs/${staged.docId}`))?.trusted === true, patience(ctx));
    precondition(landed || (t.status === 200 && t.json?.trusted === true), `POST /trust answered ${t?.status} ${t?.text?.slice(0, 200)}`);
  }
  return { ...staged, html: s.bytes.toString("utf8") };
}

/**
 * POST /publish?update= from bytes as the owner, until v2 is current: sent
 * again only when the stack did not answer and the record does not already
 * name v2. Resolves once v2 is the current version.
 */
async function updateToV2(ctx, owner, docId, body) {
  const { out, landed } = await untilLanded(ctx, "POST /publish?update= (v2)", () => updateUpload(owner.http, docId, { body, baseVersion: "v1", timeoutMs: FN_MS }), async () => (await readDoc(target, `docs/${docId}`))?.currentVersion === "v2", patience(ctx));
  precondition(landed || (out.status === 200 && out.json?.versionId === "v2"), `update to v2 answered ${out?.status} ${JSON.stringify(out?.json)}`);
}

/**
 * A browser user signed in through /signup (safe to repeat: a POST /session
 * Hosting cut off is signed in again, the cut-off carried as the error's
 * response), then on /d/<doc>[/<v>] with its frame loaded (User.open with
 * `reloads: 1` and `sessionCheck`: a load the stack stalled, or whose own
 * POST /session it cut off, is loaded once more).
 */
async function signedIn(ctx, name, account, docId, { v = null } = {}) {
  const u = await ctx.users.user({ name });
  const { out: s } = await untilLanded(ctx, `${name}'s sign-in`, () => u.signInUi(account.email, account.password, { timeout: OPEN_MS }), null, patience(ctx));
  precondition(s.status === "ok", `${name} signed in (${s.status})`);
  await u.open(docId, { v, timeout: OPEN_MS, reloads: 1, sessionCheck: true });
  return u;
}

/** Enter edit mode on the open document, joined to the live session, so a keystroke is not lost to the bind. */
async function openEditor(u) {
  const r = await u.enterEdit({ waitShared: true, timeout: OPEN_MS });
  precondition(r.share === "shared", `${u.name} joined the live session (share state ${r.share})`);
  return r;
}

function noPageErrors(users) {
  for (const u of users) assert.deepEqual(u.log.errors.map((e) => e.message), [], `${u.name}: uncaught page errors`);
}

/**
 * Type into the frame and wait for the autosave that follows the last key,
 * however long the stack takes to answer it (User.typeAndAutosave, SAVE_MS):
 * through answered(), so Hosting's cut-off is the stack not answering; any
 * other answer is the product's and must be a 200 that reads "saved".
 */
async function typeAndSave(u, selector, text) {
  const save = await u.typeAndAutosave(selector, text, { delay: 15, timeout: SAVE_MS, expectStatus: null });
  answered(save.entry, `${u.name}'s autosave, POST /draft`);
  precondition(save.status === 200 && save.saveState === "saved", `${u.name}'s autosave after the last key was answered ${save.status} ${JSON.stringify(save.body)} (save state ${save.saveState})`);
  return save;
}

/** Every answer among captured rows through answered(): Hosting's cut-off 504 to any of them throws E2E_STACK_CUTOFF. */
function judgeRows(u, rows, what) {
  for (const r of rows) if (r.status != null) answered(r, `${u.name}'s page's ${r.method} ${r.path} (${what})`);
}

/**
 * Press Save as new version (User.saveAsNewVersion) and wait COMMIT_MS for
 * its toast, capturing the page's POST /draft and POST /commit meanwhile:
 * each answer goes through answered(), so a pre-commit save or a commit
 * Hosting cut off is the stack not answering, never "the draft didn't save".
 */
async function commitInApp(u) {
  const rows = u.capture({ paths: ["/draft", "/commit"] });
  let out;
  try {
    out = await u.saveAsNewVersion({ timeout: COMMIT_MS });
  } finally {
    rows.stop();
  }
  judgeRows(u, rows, "Save as new version");
  return { ...out, rows };
}

/** Captured requests as evidence: no html (the whole document), times relative to `t0` (ms). */
const postRows = (rows, t0 = 0) =>
  rows.map((r) => ({ path: r.path, t: Math.round(r.t - t0), status: r.status, state: r.state, baseVersion: r.postJson?.baseVersion ?? null }));

/** The stored draft entry (Storage, docs/<doc>/draft/<entry>) as text, or null. */
async function draftObject(docId, entry = "index.html") {
  const b = await readDraftObject(target, docId, entry);
  return b ? b.toString("utf8") : null;
}

/** A version as stored: GET /download, its entry HTML, REHASH, and its record. */
async function storedVersion(http, docId, versionId) {
  const r = await http.get(`/download/${encodeURIComponent(docId)}/${encodeURIComponent(versionId)}`, { expect: 200 });
  const html = entryHtml(zipFiles(r.buffer));
  const rehash = await rehashZip(r.buffer, { target });
  const record = await readDoc(target, `docs/${docId}/versions/${versionId}`);
  return { html, rehash: rehash.contentHash, record };
}

/**
 * A text change that is `token` typed once and nothing else, up to collapsible
 * whitespace: typing at the end of an element whose source ends in a newline
 * and indentation makes the browser drop that invisible run, which is the
 * editor's doing and changes nothing a reader sees.
 */
function plusToken(token) {
  const norm = (x) => String(x).replace(/\s+/g, " ").trim();
  return (v1Text, vNText) => vNText.split(token).length === 2 && norm(vNText.replace(token, "")) === norm(v1Text);
}

/** The comment tools, as the owner's agent: an mcp-channel token minted with the owner's session. */
async function ownerAgent(ctx, owner) {
  // Sent again only when the stack did not answer: at worst a second token is minted (and ledgered).
  const { out } = await untilLanded(ctx, "POST /tokens (mcp)", () => mintToken(owner, { name: `e2e a09 ${runTag(target.runId)}-${rand4()}`, channel: "mcp" }), null, patience(ctx));
  const mcp = ctx.mcp({ token: out.token, actor: "owner-mcp", timeoutMs: FN_MS, cutoffError: true });
  await mcp.initialize();
  return mcp;
}

/**
 * Whether the app's realtime namespace enforces the tree's database.rules.json,
 * live (rtdb.mjs rtdbRulesStatus). Production runs the deployed rules, which
 * nothing here can read back.
 */
async function realtimeRules(ctx) {
  if (target.kind !== "local") return { ok: true, reason: null, note: "production: the deployed rules" };
  const s = await rtdbRulesStatus(target, { http: ctx.http({ actor: "rtdb-rules" }) });
  return { ok: s.ok, reason: s.reason, note: `ns=${s.namespace} ${s.ok ? "enforces" : "does not enforce"} ${s.file} (${s.bytes} bytes)` };
}

/** The fixture's paragraph text, as its element's textContent. */
function paragraph(id) {
  const m = new RegExp(`<p id="${id}">([^<]*)</p>`).exec(FIXTURE_HTML);
  precondition(m, `the fixture has no <p id="${id}">`);
  return m[1];
}

// --- A9.1 ---------------------------------------------------------------------

scenario("A9.1 entering edit mode on a trusted document mounts a new iframe with sandbox=allow-same-origin, src /draft/…?r=N, an editable body and the Formatting toolbar", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  ctx.step("the owner publishes the scripted sample and trusts it, so the reading frame has no sandbox at all");
  const { accounts, docId } = await stageTour(ctx, { name: "a91-sandbox", trusted: true });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  const reading = await o.waitForFrame();
  assert.equal(reading.sandbox, null, `a trusted document is read with no sandbox (got ${JSON.stringify(reading.sandbox)})`);
  assert.equal(reading.src, `/content/${docId}/v1/index.html`);
  await o.page.evaluate(() => {
    document.querySelector("iframe.doc-frame").__e2eReadingFrame = true;
  });

  ctx.step("the owner presses Edit");
  const sessionAt = o.responseMark();
  await openEditor(o);
  const edit = await o.page.evaluate(() => {
    const el = document.querySelector("iframe.doc-frame");
    const body = el.contentDocument?.body;
    return {
      sameElement: el.__e2eReadingFrame === true,
      frames: document.querySelectorAll("iframe.doc-frame").length,
      sandbox: el.getAttribute("sandbox"),
      src: el.getAttribute("src"),
      contenteditable: body?.getAttribute("contenteditable") ?? null,
      isContentEditable: body?.isContentEditable ?? null,
    };
  });
  ctx.ev.json("edit-frame", edit);
  assert.deepEqual({ sameElement: edit.sameElement, frames: edit.frames }, { sameElement: false, frames: 1 }, "edit mode mounted a NEW iframe element, and only one");
  assert.equal(edit.sandbox, "allow-same-origin", "the edit frame is sandboxed without scripts, whatever trust says");
  const preparedRows = o.findResponses((r) => r.method === "GET" && r.path === `/draft/${docId}` && r.query.get("session") === "1", { since: sessionAt });
  assert.equal(preparedRows.length, 1, "entering Edit prepares exactly one checked draft snapshot");
  assert.equal(preparedRows[0].status, 200, "the prepared draft snapshot was authorized");
  const prepared = await preparedRows[0].response.json();
  const editUrl = new URL(edit.src, target.origin);
  assert.equal(editUrl.pathname, `/draft/${docId}/${prepared.entry}`, "the editor loads the checked snapshot's entry");
  assert.match(editUrl.searchParams.get("r") ?? "", /^\d+$/, "the edit frame remains cache-busted");
  assert.match(prepared.draftRevision, /^[a-f0-9]{64}$/, "the prepared snapshot has an opaque revision");
  assert.deepEqual(Object.fromEntries([...editUrl.searchParams].filter(([k]) => k !== "r")), { baseVersion: prepared.baseVersion, liveEpoch: prepared.liveEpoch, draftRevision: prepared.draftRevision }, "the editor frame requests exactly the prepared version, epoch and revision");
  assert.deepEqual({ contenteditable: edit.contenteditable, isContentEditable: edit.isContentEditable }, { contenteditable: "true", isContentEditable: true });
  const bar = o.page.getByRole("toolbar", { name: "Formatting", exact: true });
  assert.equal(await bar.count(), 1, "exactly one toolbar named Formatting");
  assert.equal(await bar.isVisible(), true);
  noPageErrors([o]);
});

// --- A9.2 ---------------------------------------------------------------------

/** Consecutive duplicates collapsed (a row may differ from the last only in its text). */
const transitions = (states) => states.map((x) => x.s).filter((s, i, a) => i === 0 || s !== a[i - 1]);

scenario("A9.2 autosave goes dirty → saving → saved at least 1 s after the last key, as one POST /draft per pause with the current baseVersion", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  ctx.step("the owner publishes v1 and then v2 (POST /publish?update=), so the current base is v2");
  const { owner, accounts, docId } = await stage(ctx, { name: "a92-autosave", title: "A9.2 autosave" });
  await updateToV2(ctx, owner, docId, FIXTURE_HTML.replace("Paragraph 40.", "Paragraph 40 (v2)."));

  const o = await signedIn(ctx, "owner", accounts[0], docId);
  await openEditor(o);
  const rec = await o.recordSaveStates();
  const posts = o.capture({ paths: "/draft" });
  const t1 = tok("a");
  const t2 = tok("b");

  for (const [i, t] of [t1, t2].entries()) {
    ctx.step(`burst ${i + 1}: type ${t} at the end of #e2e-${3 + i}, 15 ms a key, then wait for "saved" and ${QUIET_MS} ms more`);
    const before = await rec.read();
    // Any status: the answer is judged below. Hosting's cut-off is the stack not answering (answered()).
    const save = await o.typeAndAutosave(`#e2e-${3 + i}`, t, { delay: 15, timeout: SAVE_MS, expectStatus: null });
    answered(save.entry, "the owner's autosave, POST /draft");
    await sleep(QUIET_MS); // the absence of a second POST is the oracle; the debounce is 1 s
    judgeRows(o, posts, `burst ${i + 1}`);
    const now = await rec.read();
    precondition(now.armed, "the save-state recorder is still armed (no navigation)");
    const inputs = now.inputs.slice(before.inputs.length);
    precondition(inputs.length >= t.length, `the frame saw ${inputs.length} input events for ${t.length} keys`);
    const gaps = inputs.slice(1).map((x, k) => x - inputs[k]);
    if (Math.max(...gaps) >= AUTOSAVE_MS) ctx.inconclusive(`a gap of ${Math.round(Math.max(...gaps))} ms between keys: the burst was not one pause`);
    const states = now.states.slice(before.states.length);
    const lastInput = inputs[inputs.length - 1];
    ctx.ev.json(`burst-${i + 1}`, { inputs, states, posts: postRows(posts) });
    assert.deepEqual(transitions(states), ["dirty", "saving", "saved"], `burst ${i + 1}: save-state transitions`);
    const saving = states.find((x) => x.s === "saving");
    assert.ok(saving.t - lastInput >= AUTOSAVE_MS, `burst ${i + 1}: the save began ${Math.round(saving.t - lastInput)} ms after the last key, not at least ${AUTOSAVE_MS}`);
    assert.equal(posts.length, i + 1, `after burst ${i + 1}: one POST /draft per pause (got ${posts.length})`);
    const row = posts[i];
    assert.deepEqual({ status: row.status, docId: row.postJson?.docId, baseVersion: row.postJson?.baseVersion }, { status: 200, docId, baseVersion: "v2" }, `burst ${i + 1}: the POST carries the current base`);
    assert.ok([t1, t2].slice(0, i + 1).every((x) => row.postJson.html.includes(x)), `burst ${i + 1}: the posted html holds every token typed so far`);
  }
  posts.stop();
  await rec.stop();
  const meta = await readDoc(target, `docs/${docId}`);
  assert.equal(meta.draft?.baseVersion, "v2", "the stored draft is of v2");
  const stored = await draftObject(docId);
  assert.ok(stored?.includes(t1) && stored.includes(t2), "the stored draft holds both bursts");
  noPageErrors([o]);
});

// --- A9.3 ---------------------------------------------------------------------

/** What A9.3 applies, one control per paragraph, each on the paragraph's opening words. */
const FORMATS = [
  { id: "e2e-6", what: "Bold", via: "button", expect: "b" },
  { id: "e2e-7", what: "Italic", via: "button", expect: "i" },
  { id: "e2e-8", what: "Underline", via: "button", expect: "u" },
  { id: "e2e-9", what: "Strikethrough", via: "button", expect: "strike, s" },
  { id: "e2e-10", what: "Text colour", via: "color", value: "#c0392b", expect: "span" },
  { id: "e2e-11", what: "Font", via: "select", value: "Serif", expect: "span" },
];

/** In a parsed or live document: how each FORMATS paragraph and #e2e-12 came out. */
function formattingIn(doc, arg) {
  const out = { font: doc.querySelectorAll("font").length, rows: {} };
  for (const f of arg.formats) {
    const p = doc.getElementById(f.id);
    if (!p) {
      out.rows[f.id] = { missing: true };
      continue;
    }
    const words = `Paragraph ${f.id.slice(4)}`;
    const el = Array.from(p.querySelectorAll(f.expect)).find((x) => x.textContent === words) ?? null;
    out.rows[f.id] = {
      wrapped: el ? el.localName : null,
      color: el?.style?.color ?? null,
      fontFamily: el?.style?.fontFamily ?? null,
      text: p.textContent,
    };
  }
  const h2 = Array.from(doc.querySelectorAll("h2")).find((h) => h.textContent.startsWith("Paragraph 12."));
  out.heading = h2 ? { tag: h2.localName, text: h2.textContent } : null;
  return out;
}

scenario("A9.3 the formatting controls change the text they are used on, and neither the frame nor the draft contains a <font>", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { accounts, docId } = await stage(ctx, { name: "a93-format", title: "A9.3 formatting" });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  await openEditor(o);
  const bar = o.page.getByRole("toolbar", { name: "Formatting", exact: true });

  for (const f of FORMATS) {
    const words = `Paragraph ${f.id.slice(4)}`;
    ctx.step(`select "${words}" in #${f.id} and apply ${f.what}`);
    const sel = await o.selectText(`#${f.id}`, words, { fab: false });
    precondition(sel.text === words, `selected ${JSON.stringify(sel.text)}`);
    if (f.via === "button") await bar.getByRole("button", { name: f.what, exact: true }).click();
    else if (f.via === "color") await bar.getByLabel("Text colour", { exact: true }).fill(f.value);
    else await bar.getByLabel("Font", { exact: true }).selectOption({ label: f.value });
  }
  ctx.step('put the caret in #e2e-12 and choose "Heading 2" in the block select');
  await o.typeInFrame("#e2e-12", "", { at: "start" });
  await bar.getByLabel("Block type", { exact: true }).selectOption({ label: "Heading 2" });

  const live = await inFrameDoc(o, formattingIn, { formats: FORMATS });
  ctx.ev.json("live", live);
  ctx.step("wait for the autosave to store a draft holding every change made (the debounce is 1 s)");
  let draft = null;
  let stored = null;
  try {
    stored = await eventually(async () => {
      draft = await draftObject(docId);
      if (!draft) throw new Error("no draft stored yet");
      const got = await parseAndRun(ctx.users, draft, formattingIn, { formats: FORMATS });
      // The block change is the last one made, and every save serializes the
      // whole document: a draft holding it holds everything before it.
      if (!got.heading) throw new Error(`not yet: ${JSON.stringify(got)}`);
      return got;
      // A save Hosting cut off leaves its 504 among the page's responses, which pageStall reads when this runs out.
    }, { timeout: SAVE_MS, interval: 500, message: "a draft holding the last formatting change" });
  } finally {
    ctx.ev.text("draft.html", draft ?? "(none)");
  }
  ctx.ev.json("stored", stored);

  for (const [where, got] of [["the live frame", live], ["the stored draft", stored]]) {
    assert.equal(got.font, 0, `${where}: no <font> element`);
    for (const f of FORMATS) {
      const row = got.rows[f.id];
      const tagOk = f.expect === "span" ? row.wrapped === "span" : f.expect.split(", ").includes(row.wrapped);
      assert.ok(tagOk, `${where}: ${f.what} wrapped "Paragraph ${f.id.slice(4)}" in ${f.expect} (got ${JSON.stringify(row)})`);
      assert.equal(row.text, paragraph(f.id), `${where}: #${f.id}'s text is unchanged`);
    }
    assert.equal(got.rows["e2e-10"].color, "rgb(192, 57, 43)", `${where}: Text colour set the chosen colour`);
    assert.match(got.rows["e2e-11"].fontFamily, /Georgia/, `${where}: Font set the Serif stack`);
    assert.deepEqual(got.heading, { tag: "h2", text: paragraph("e2e-12") }, `${where}: #e2e-12's text is now a Heading 2`);
  }
  assert.doesNotMatch(draft, /<font[\s>]/i, "the draft's bytes contain no <font");
  noPageErrors([o]);
});

// Each formerly unexercised control is independent, so a broken code or link
// button cannot hide the other native formatting commands.
const EXTRA_FORMATS = [
  { name: "A9.3b Inline code changes the selected content and survives autosave", title: "Inline code", selector: "code", selection: true },
  { name: "A9.3b Bulleted list changes the selected content and survives autosave", title: "Bulleted list", selector: "ul > li", selection: false },
  { name: "A9.3b Numbered list changes the selected content and survives autosave", title: "Numbered list", selector: "ol > li", selection: false },
  { name: "A9.3b Blockquote changes the selected content and survives autosave", title: "Blockquote", selector: "blockquote", selection: false },
  { name: "A9.3b Horizontal rule changes the selected content and survives autosave", title: "Horizontal rule", selector: "hr", selection: false },
  { name: "A9.3b Link changes the selected content and survives autosave", title: "Link", selector: "a[href]", selection: true },
  { name: "A9.3b Align left changes the selected content and survives autosave", title: "Align left", align: "left", selection: false },
  { name: "A9.3b Align centre changes the selected content and survives autosave", title: "Align centre", align: "center", selection: false },
];
function extraFormatIn(doc, action) {
  const paragraph = doc.getElementById("e2e-3");
  const matches = action.selector ? Array.from(doc.querySelectorAll(action.selector)) : [];
  return {
    text: doc.body.textContent,
    font: doc.querySelectorAll("font").length,
    matches: matches.map((node) => ({ text: node.textContent, href: node.getAttribute("href") })),
    align: paragraph?.style.textAlign ?? null,
  };
}
for (const action of EXTRA_FORMATS) scenario(action.name, { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const body = FIXTURE_HTML.replace('<p id="e2e-3">', '<p id="e2e-3" style="text-align:right">');
  const { accounts, docId } = await stage(ctx, { name: "a93-extra", title: `A9.3 ${action.title}`, body });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  await openEditor(o);
  const before = await inFrameDoc(o, extraFormatIn, action);
  const selected = "Paragraph 3";
  if (action.selection) await o.selectText("#e2e-3", selected, { fab: false });
  else await o.typeInFrame("#e2e-3", "", { at: "end" });
  const dialogs = [];
  const onDialog = async (dialog) => { dialogs.push({ type: dialog.type(), message: dialog.message() }); await dialog.accept("https://example.invalid/review"); };
  o.page.on("dialog", onDialog);
  try {
    await o.page.getByRole("toolbar", { name: "Formatting", exact: true }).getByRole("button", { name: action.title, exact: true }).click();
  } finally { o.page.off("dialog", onDialog); }
  const judge = (state, where) => {
    assert.equal(state.text, before.text, `${action.title}: ${where} retains every authored text node`);
    assert.equal(state.font, 0, `${action.title}: ${where} contains no font element`);
    if (action.align) assert.equal(state.align, action.align, `${action.title}: ${where} applies the requested paragraph alignment`);
    else if (action.title === "Horizontal rule") assert.equal(state.matches.length, before.matches.length + 1, `${action.title}: ${where} inserts one rule`);
    else {
      const expectedText = action.selection ? selected : paragraph("e2e-3");
      assert.ok(state.matches.some((node) => node.text === expectedText), `${action.title}: ${where} has the requested semantic element around the selected content`);
      if (action.title === "Link") assert.ok(state.matches.some((node) => node.text === selected && node.href === "https://example.invalid/review"), `${where}: link retains the supplied destination`);
    }
  };
  judge(await inFrameDoc(o, extraFormatIn, action), "live frame");
  if (action.title === "Link") assert.deepEqual(dialogs, [{ type: "prompt", message: "Link to" }], "Link asks for its destination once");
  const saved = await eventually(async () => {
    const html = await draftObject(docId);
    return html ? { html, state: await parseAndRun(ctx.users, html, extraFormatIn, action) } : false;
  }, { timeout: SAVE_MS, interval: 250, message: `${action.title} autosaved` });
  ctx.ev.json("formatting", { before, stored: saved.state });
  judge(saved.state, "stored draft");
  noPageErrors([o]);
});

// --- A9.4 ---------------------------------------------------------------------

scenario("A9.4 the empty-container marking is in the live edit frame and never reaches the draft", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { accounts, docId, html } = await stageTour(ctx, { name: "a94-markers" });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  await openEditor(o);

  ctx.step("in the edit frame, #dot-nav (left empty for the script) is marked and the marking stylesheet is injected");
  const live = await inFrameDoc(o, (doc) => {
    const nav = doc.getElementById("dot-nav");
    const style = doc.getElementById("bshd-edit-placeholders");
    return { navMark: nav?.getAttribute("data-bshd-empty") ?? null, styleMarker: style?.getAttribute("data-bshd") ?? null, inHead: style?.parentElement === doc.head };
  });
  precondition(live.navMark === "#dot-nav" && live.styleMarker === "edit-placeholders" && live.inHead, `the marking is live in the edit frame: ${JSON.stringify(live)}`);

  const t = tok("m");
  ctx.step(`type ${t} into #s1-what's lede and let the autosave take it`);
  await typeAndSave(o, "#s1-what .lede", t);
  const draft = await draftObject(docId);
  precondition(draft?.includes(t), "the stored draft holds the typed token");
  ctx.ev.text("draft.html", draft);

  assert.doesNotMatch(draft, /data-bshd-empty/, "no data-bshd-empty attribute in the draft");
  assert.doesNotMatch(draft, /bshd-edit-placeholders|edit-placeholders/, "no placeholder stylesheet in the draft");
  const nav = await parseAndRun(ctx.users, draft, (doc) => {
    const n = doc.getElementById("dot-nav");
    return n ? { attrs: n.getAttributeNames().sort(), children: n.childNodes.length } : null;
  });
  assert.deepEqual(nav, { attrs: ["aria-label", "id"], children: 0 }, "#dot-nav is stored exactly as authored");
  const parser = await ctx.users.parser();
  const fp1 = await fingerprint(parser, html);
  const fpD = await fingerprint(parser, draft);
  assert.deepEqual(decorations(fpD, fp1), [], "DECOR: no decoration in the draft");
  const diff = diffFingerprint(fp1, fpD, plusToken(t), { ignoreBodyAttr: true });
  assert.deepEqual({ structure: diff.structure, lost: diff.lost, textAllowed: diff.text.allowed }, { structure: [], lost: [], textAllowed: true }, "the draft is v1 plus the token");
  noPageErrors([o]);
});

// --- A9.5 ---------------------------------------------------------------------

const DRAFT_BANNER = /^You're reading unpublished edits, last saved by (.+?)( just now| \d+m ago)\. Everyone else still sees v1 until they're saved as a new version\.$/;

async function readerView(u) {
  return u.page.evaluate(() => ({
    label: document.querySelector(".viewer-toolbar > .chip.mono")?.textContent ?? null,
    banners: Array.from(document.querySelectorAll(".viewer-banners .banner span")).map((s) => s.textContent.replace(/\s+/g, " ").trim()),
    src: document.querySelector("iframe.doc-frame")?.getAttribute("src") ?? null,
  }));
}

scenario("A9.5 with a draft saved, an editor reads it under the unpublished-edits banner and \"v1 · draft\"; a viewer reads v1 with neither", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { accounts, docId } = await stage(ctx, {
    name: "a95-banner",
    title: "A9.5 banners",
    readers: [{ label: "editor", role: "editor" }, { label: "viewer", role: "viewer" }],
  });
  const [ownerAcct, editorAcct, viewerAcct] = accounts;
  const t = tok("d");
  ctx.step(`the editor saves a draft of v1 with ${t} in #e2e-5 (POST /draft, what the autosave sends)`);
  const editorSession = await sessionFor(ctx, editorAcct);
  const html = FIXTURE_HTML.replace(`<p id="e2e-5">${paragraph("e2e-5")}`, `<p id="e2e-5">${paragraph("e2e-5")}${t}`);
  precondition(html !== FIXTURE_HTML, "the draft differs from v1");
  // functions/src/lib/draft.ts writeDraft records {baseVersion, bytes} on the document once the bytes are stored: the effect looked for before sending it again.
  const { out: saved, landed } = await untilLanded(ctx, "POST /draft", () => editorSession.http.postJson("/draft", { docId, baseVersion: "v1", html }), async () => {
    const d = await readDoc(target, `docs/${docId}`);
    return d?.draft?.baseVersion === "v1" && d.draft.bytes === Buffer.byteLength(html, "utf8");
  }, patience(ctx));
  precondition(landed || saved.status === 200, `POST /draft answered ${saved?.status} ${saved?.text?.slice(0, 200)}`);

  const [e, v, o] = await Promise.all([signedIn(ctx, "editor", editorAcct, docId), signedIn(ctx, "viewer", viewerAcct, docId), signedIn(ctx, "owner", ownerAcct, docId)]);

  ctx.step("the editor and the owner read the draft, each under the banner; the viewer reads v1");
  const views = {};
  for (const u of [e, o, v]) {
    views[u.name] = await eventually(async () => {
      const r = await readerView(u);
      if (u.name === "viewer" ? r.label !== "v1" : r.label !== "v1 · draft") throw new Error(JSON.stringify(r));
      return r;
    }, { timeout: LATENCY_MS, message: `${u.name}'s version label` });
    views[u.name].text = await frameText(await u.frame());
  }
  ctx.ev.json("views", views);
  for (const [who, by] of [["editor", "you"], ["owner", editorAcct.email.toLowerCase()]]) {
    const r = views[who];
    assert.equal(r.label, "v1 · draft", `${who}: the label`);
    const banner = r.banners.find((b) => b.startsWith("You're reading unpublished edits"));
    assert.ok(banner, `${who}: the draft banner (banners: ${JSON.stringify(r.banners)})`);
    assert.match(banner, DRAFT_BANNER, `${who}: the banner's text`);
    assert.equal(DRAFT_BANNER.exec(banner)[1], by, `${who}: the banner names who saved it`);
    assert.ok(DRAFT_BANNER.exec(banner)[2], `${who}: the banner says when the draft was saved`);
    assert.match(r.src, new RegExp(`^/draft/${docId}/index\\.html\\?r=\\d+$`), `${who}: the frame reads the draft`);
    assert.ok(r.text.includes(t), `${who}: the frame shows the draft's text`);
  }
  assert.deepEqual(
    { label: views.viewer.label, banner: views.viewer.banners.filter((b) => b.startsWith("You're reading unpublished edits")), src: views.viewer.src, hasToken: views.viewer.text.includes(t) },
    { label: "v1", banner: [], src: `/content/${docId}/v1/index.html`, hasToken: false },
    "the viewer reads v1: no banner, no draft label, no draft text",
  );
  noPageErrors([e, v, o]);
});

// --- A9.6 ---------------------------------------------------------------------

/** Wait for the editor to close (the Formatting toolbar gone): Done and a commit each await a save first, which may take Hosting's minute. */
async function leftEditor(u) {
  await u.page.getByRole("toolbar", { name: "Formatting" }).waitFor({ state: "detached", timeout: SAVE_MS });
}

scenario("A9.6 Done within 1 s of the last key posts that key's edit; Done without an edit posts nothing and leaves no draft", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { accounts, docId } = await stage(ctx, { name: "a96-done", title: "A9.6 Done" });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  ctx.step("half 1, no edit: open the editor, press Done, watch for any POST /draft");
  await openEditor(o);
  const qPosts = o.capture({ paths: "/draft" });
  await o.done({ timeout: SAVE_MS });
  await sleep(QUIET_MS); // the absence is the oracle; nothing is pending, and the debounce would be 1 s
  qPosts.stop();
  assert.deepEqual(postRows(qPosts), [], "Done without an edit sent no POST /draft");
  const qMeta = await readDoc(target, `docs/${docId}`);
  assert.equal("draft" in qMeta, false, "no draft record");
  assert.equal(await draftObject(docId), null, "no draft object");

  ctx.step("half 2, the same document: open the editor again, type a token and press Done at once, inside the 1 s debounce");
  await openEditor(o);
  const t = tok("x");
  const { lastInput, doneAt, savingAt, posts } = await typeThenDone(o, "#e2e-2", t, ctx);
  await leftEditor(o);
  posts.stop();
  judgeRows(o, posts, "Done");
  ctx.ev.json("timing", { lastInput, doneAt, savingAt, posts: postRows(posts) });
  ctx.step(`Done was pressed ${Math.round(doneAt - lastInput)} ms after the last key, the save began ${Math.round(savingAt - lastInput)} ms after it; ${posts.length} POST /draft followed`);
  const first = posts[0];
  assert.ok(first, "Done sent a POST /draft");
  assert.ok(savingAt - lastInput < AUTOSAVE_MS, `the save began ${Math.round(savingAt - lastInput)} ms after the last key: by Done, not by the debounce`);
  assert.deepEqual({ status: first.status, baseVersion: first.postJson?.baseVersion, hasToken: first.postJson?.html?.includes(t) }, { status: 200, baseVersion: "v1", hasToken: true }, "the POST Done sent carries the token");
  const stored = await draftObject(docId);
  assert.ok(stored?.includes(t), "the stored draft holds the token");
  noPageErrors([o]);
});

/** Where the Done click's page-clock time is kept: a symbol on the window, no node and no attribute. */
const DONE_AT_KEY = "e2e.a09.doneAt";

/**
 * Type `text` and press Done at once. Returns the page-clock times of the
 * last key, of the Done click and of the first save after the last key, and
 * the capture of POST /draft (still running), once its first row has
 * settled (FN_MS: past Hosting's cut-off, so a stalled save ends in its 504).
 * INCONCLUSIVE when the click did not land inside the debounce.
 */
async function typeThenDone(u, selector, text, ctx) {
  const rec = await u.recordSaveStates();
  const posts = u.capture({ paths: "/draft" });
  const done = u.page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Done", exact: true });
  await done.evaluate((b, key) => {
    b.addEventListener("click", () => {
      window[Symbol.for(key)] = performance.timeOrigin + performance.now();
    }, { capture: true, once: true });
  }, DONE_AT_KEY);
  await u.typeInFrame(selector, text, { delay: 0 });
  await done.click();
  await posts.waitFor({ path: "/draft" }, { timeout: FN_MS });
  judgeRows(u, posts, "Done's save");
  const doneAt = await u.page.evaluate((key) => window[Symbol.for(key)] ?? null, DONE_AT_KEY);
  const r = await rec.stop();
  const lastInput = r.inputs.at(-1);
  precondition(typeof doneAt === "number" && typeof lastInput === "number", "the last key and the Done click were recorded");
  if (doneAt - lastInput >= AUTOSAVE_MS) ctx.inconclusive(`Done was pressed ${Math.round(doneAt - lastInput)} ms after the last key, not inside the debounce`);
  // The page's clock: the first "saving" after the last key is when a save began.
  const savingAt = r.states.find((x) => x.s === "saving" && x.t > lastInput)?.t ?? null;
  precondition(savingAt !== null, `a save began after the last key (states ${JSON.stringify(transitions(r.states))})`);
  return { lastInput, doneAt, savingAt, posts };
}

/**
 * X-a09-editing-1 on Done's path. Done (DocViewer.tsx stopEditing) awaits
 * flushUnsaved, which calls flush (useInlineEditor.ts:87-114); flush never
 * clears the debounce timer the last key armed (:145-146). Only the edit
 * mode's cleanup does (:152), and that runs after Done's save has answered.
 * So a Done save slower than what is left of the 1 s debounce is followed by
 * the timer's own save of the same edit: two POST /draft for one pause.
 * SPEC §6a: autosave is debounced, and leaving edit mode saves only an edit
 * the autosave has not yet taken; the plan's 9.2, one POST per pause.
 * DocViewer.tsx's own comment on stopEditing says the flush on the way out
 * stands in for the timer the cleanup clears. The slow save is forced here
 * by holding Done's POST /draft 1.5 s in the page (User.delayRequests), as a
 * slow network or a loaded stack does. controls-a09-save-coalescing restores
 * the uncancelled concurrent save as its negative control.
 */
scenario("A9.6 a Done save that outlasts the debounce is not followed by a second POST /draft of the same edit", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { accounts, docId } = await stage(ctx, { name: "a96-twice", title: "A9.6 Done once" });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  await openEditor(o);
  ctx.step("the first POST /draft from this page is held 1.5 s before it goes on: Done's save, slower than the 1 s debounce");
  const slow = await o.delayRequests("/draft", { rules: [1_500] });
  const t = tok("z");
  let run;
  try {
    ctx.step(`type ${t} into #e2e-2 and press Done at once, inside the debounce`);
    run = await typeThenDone(o, "#e2e-2", t, ctx);
    await leftEditor(o);
    await sleep(QUIET_MS); // the absence of a later POST is the oracle; the debounce is 1 s
  } finally {
    await slow.restore();
  }
  const { lastInput, doneAt, savingAt, posts } = run;
  posts.stop();
  judgeRows(o, posts, "Done, held");
  const sent = posts.map((x) => `${x.status ?? x.state} sent +${Math.round(x.t - lastInput)} ms after the last key`);
  ctx.ev.json("timing", {
    lastInput,
    doneAt,
    savingAt,
    posts: postRows(posts, lastInput).map((x, i) => ({ ...x, hasToken: posts[i].postJson?.html?.includes(t) ?? false })),
    held: slow.rows.map((x) => ({ seq: x.seq, rule: x.rule, ms: x.ms, released: x.released, heldMs: x.releasedAt === null ? null : Math.round(x.releasedAt - x.heldAt) })),
  });
  ctx.step(`Done was pressed ${Math.round(doneAt - lastInput)} ms after the last key; POST /draft: ${sent.join(", ")}`);
  precondition(slow.rows[0]?.rule === "ms" && slow.rows[0].released === "rule", `Done's save was held its 1.5 s (${JSON.stringify(slow.rows[0] ?? null)})`);
  precondition(posts[0]?.status === 200 && posts[0].postJson?.html?.includes(t) === true, `Done's save carried the token and was answered 200 (${posts[0]?.status})`);
  if (savingAt - lastInput >= AUTOSAVE_MS) ctx.inconclusive(`the first save began ${Math.round(savingAt - lastInput)} ms after the last key: the debounce's, not Done's`);
  assert.equal(posts.length, 1, `Done's edit was posted ${posts.length} times for one pause: the debounce armed by the last key fired during Done's save (${sent.join(", ")})`);
});

// --- A9.7 ---------------------------------------------------------------------

scenario("A9.7 an open comment disables Save as new version with its reason and makes POST /commit 409 {unresolvedCount: 1}; resolved, the same commit is 200", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { owner, accounts, docId } = await stage(ctx, { name: "a97-gate", title: "A9.7 commit gate" });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  await openEditor(o);
  const t = tok("g");
  ctx.step(`the owner types ${t} and the autosave stores a draft`);
  await typeAndSave(o, "#e2e-3", t);

  ctx.step("the owner's agent opens a thread on #e2e-9 (add_comment); nobody it could email has notifications on");
  await quietDoc(target, docId);
  const mcp = await ownerAgent(ctx, owner);
  const exact = paragraph("e2e-9").slice("Paragraph 9. ".length).split(".")[0];
  precondition(FIXTURE_HTML.split(exact).length === 2, `"${exact}" is unique in the fixture`);
  const made = await mcp.ok("add_comment", { id: docId, exact, body: `A9.7 ${tok("c")}` });
  precondition(made?.threadId, `add_comment returned ${JSON.stringify(made)}`);

  const save = o.page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Save as new version", exact: true });
  await eventually(async () => (await save.isDisabled()) === true, { timeout: LATENCY_MS, message: "Save as new version disabled by the open thread" });
  assert.equal(await save.getAttribute("title"), COPY.unresolvedReason, "the button says why");

  ctx.step("POST /commit as the owner while the thread is open");
  const refused = await owner.http.postJson("/commit", { docId, baseVersion: "v1" });
  ctx.ev.json("refused", { status: refused.status, json: refused.json });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json, { error: COPY.unresolved409, unresolvedCount: 1, pendingSuggestions: 0 });

  ctx.step("resolve the thread (resolve_thread), then the same POST /commit");
  await mcp.ok("resolve_thread", { id: docId, threadId: made.threadId });
  await eventually(async () => (await save.isDisabled()) === false, { timeout: LATENCY_MS, message: "Save as new version enabled once resolved" });
  const ok = await owner.http.postJson("/commit", { docId, baseVersion: "v1" });
  assert.deepEqual({ status: ok.status, versionId: ok.json?.versionId, deduped: ok.json?.deduped }, { status: 200, versionId: "v2", deduped: false }, `the resolved commit: ${ok.text.slice(0, 200)}`);
  noPageErrors([o]);
});

// --- A9.8 ---------------------------------------------------------------------

/** What the A9.8 commit leaves for its live-log case (S8). */
const liveLog = { measured: false, rules: null, before: 0, left: null, leftAfterMs: null, docId: null };

async function commitAndMeasureLog(ctx) {
  // Recorded for the live-log case, which is blind where the app's realtime
  // namespace runs without the tree's rules; nothing here depends on them.
  const rules = await realtimeRules(ctx);
  ctx.step(`realtime rules: ${rules.note}`);
  const { owner, accounts, docId } = await stage(ctx, { name: "a98-commit", title: "A9.8 commit" });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  await openEditor(o);
  const t = tok("p");
  await typeAndSave(o, "#e2e-4", t);
  precondition((await readDoc(target, `docs/${docId}`)).draft?.baseVersion === "v1", "a draft of v1 is recorded before the commit");
  // The page appends its edit to the live log as it types; under load the append may land late, and S8 is blind without entries to clear.
  let yBefore = null;
  await eventually(async () => {
    yBefore = await readLiveLogs(target, docId);
    return yBefore !== null && Object.keys(yBefore).length > 0;
  }, { timeout: LATENCY_MS, interval: 250, message: "the live log holds the edit" }).catch(() => undefined);
  const before = yBefore ? Object.keys(yBefore).length : 0;
  ctx.step(`status/${docId}/y holds ${before} entries before the commit`);

  ctx.step("the owner presses Save as new version");
  const toastStart = o.toastMark();
  const commit = await commitInApp(o);
  const at = Date.now();
  assert.deepEqual({ outcome: commit.outcome, text: commit.text, kind: commit.toast.kind }, { outcome: "published", text: "Published v2.", kind: "info" });

  // For the live-log case (S8): status/{doc}/y within 2 s of the toast,
  // measured here, where the commit happened, and judged there.
  let left = yBefore;
  await eventually(async () => {
    left = await readLiveLogs(target, docId);
    return Object.keys(left ?? {}).length === 0;
  }, { timeout: 2_000, interval: 100, message: "the live log is cleared" }).catch(() => undefined);
  Object.assign(liveLog, { measured: true, rules, before, left: Object.keys(left ?? {}).length, leftAfterMs: Date.now() - at, docId });
  ctx.ev.json("live-log", liveLog);

  await sleep(Math.max(0, QUIET_MS - (Date.now() - at)));
  assert.deepEqual(o.log.toasts.slice(toastStart).filter((x) => x.kind !== "busy").map((x) => `${x.kind}: ${x.text}`), ["info: Published v2."], "an ordinary commit has no later error after the quiet window");
  await leftEditor(o);
  assert.equal(new URL(o.page.url()).pathname, `/d/${docId}`, "the viewer returns to the document's head");
  const meta = await readDoc(target, `docs/${docId}`);
  assert.equal(meta.currentVersion, "v2");
  assert.equal("draft" in meta, false, `meta.draft is removed (got ${JSON.stringify(meta.draft)})`);
  const v2 = await storedVersion(owner.http, docId, "v2");
  assert.deepEqual({ publishedVia: v2.record.publishedVia, parentVersion: v2.record.parentVersion }, { publishedVia: "editor", parentVersion: "v1" });
  assert.equal(v2.rehash, v2.record.contentHash, "REHASH v2");
  assert.ok(v2.html.includes(t), "v2 holds the typed token");
  noPageErrors([o]);
}

scenario("A9.8 a commit from the app says \"Published v2.\", records publishedVia editor and parentVersion v1, and removes meta.draft", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, commitAndMeasureLog);

/** S8 regression: the commit atomically retires the unchanged log it applied before saving. */
scenario("A9.8 a commit from the app leaves the live log status/{doc}/y empty within 2 s", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  if (!liveLog.measured) await commitAndMeasureLog(ctx);
  precondition(liveLog.rules.ok, `the realtime rules are enforced where the commit cleared the log, or the remove is allowed and nothing is proved: ${liveLog.rules.reason}`);
  precondition(liveLog.before > 0, `the live log held entries before the commit (${liveLog.before})`);
  ctx.step(`status/${liveLog.docId}/y: ${liveLog.before} entries before the commit, ${liveLog.left ?? 0} ${liveLog.leftAfterMs} ms after "Published v2."`);
  assert.ok(
    liveLog.left === 0,
    `S8: the published draft's live log still holds ${liveLog.left} entries ${liveLog.leftAfterMs} ms after "Published v2."`,
  );
});

scenario("A9.8 Save as new version pressed inside the debounce is followed by no stale-version error from the autosave it superseded", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { owner, accounts, docId } = await stage(ctx, { name: "a98-quick", title: "A9.8 quick commit" });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  await openEditor(o);
  const rec = await o.recordSaveStates();
  const drafts = o.capture({ paths: "/draft" });
  const commits = o.capture({ paths: "/commit" });
  ctx.step("send every request immediately; hold only the real /commit response for 1.5 s after the backend has completed the commit");
  const slow = await delayHostingResponse(o, "/commit", { delayMs: 1_500 });
  const t = tok("q");
  let commit;
  let since;
  try {
    ctx.step(`type ${t} and press Save as new version at once, inside the 1 s debounce`);
    await o.typeInFrame("#e2e-5", t, { delay: 0 });
    since = o.toastMark();
    commit = await o.saveAsNewVersion({ timeout: COMMIT_MS });
    // Hosting's cut-off to the pre-commit save or the commit is the stack not answering, never an outcome.
    judgeRows(o, drafts, "the pre-commit save");
    judgeRows(o, commits, "Save as new version");
    precondition(commit.outcome === "published" && commit.versionId === "v2", `the commit published v2 (${commit.text})`);
    await sleep(QUIET_MS); // the absence of a later error is the oracle; the debounce is 1 s
  } finally {
    await slow.restore();
  }
  drafts.stop();
  commits.stop();
  judgeRows(o, drafts, "the autosave after the commit");
  const r = await rec.stop();
  const lastInput = r.inputs.at(-1);
  const savingAt = r.states.find((x) => x.s === "saving" && x.t > lastInput)?.t ?? null;
  const toasts = o.log.toasts.slice(since).filter((x) => x.kind !== "busy").map((x) => `${x.kind}: ${x.text}`);
  const meta = await readDoc(target, `docs/${docId}`);
  ctx.ev.json("after", {
    lastInput,
    savingAt,
    toasts,
    drafts: postRows(drafts, lastInput),
    commits: postRows(commits, lastInput),
    delayedResponses: slow.rows,
    meta: { currentVersion: meta.currentVersion, draft: meta.draft ? { baseVersion: meta.draft.baseVersion } : null },
  });
  if (savingAt === null || savingAt - lastInput >= AUTOSAVE_MS) ctx.inconclusive(`the pre-commit save began ${savingAt === null ? "never" : `${Math.round(savingAt - lastInput)} ms`} after the last key, not inside the debounce`);
  precondition(slow.rows.length === 1 && slow.rows[0].status === 200 && slow.rows[0].error === null, "exactly one real successful commit response was held");
  precondition(slow.rows[0].backendAnsweredAt < lastInput + AUTOSAVE_MS && slow.rows[0].releasedAt > lastInput + AUTOSAVE_MS, "the backend finished the commit before the debounce, while its response stayed held beyond it");
  assert.equal("draft" in meta, false, "quick commit leaves no stale meta.draft after the quiet window");
  assert.equal(await draftObject(docId), null, "quick commit leaves no selected draft after the quiet window");
  const savedDraft = drafts.find(row => row.status === 200)?.json?.draft;
  precondition(typeof savedDraft?.storagePrefix === "string", "the pre-commit save identifies its immutable draft snapshot");
  const retiredObject = `${draftStoragePrefix(docId, savedDraft)}/${savedDraft.entry ?? "index.html"}`;
  assert.equal(await readObject(target, retiredObject), null, "quick commit leaves no stale draft object after the quiet window");
  assert.equal(postRows(drafts, lastInput).length, 1, "quick commit posts the one edit to /draft exactly once");
  assert.equal(meta.currentVersion, "v2", "quick commit leaves v2 current");
  const v2 = await storedVersion(owner.http, docId, "v2");
  assert.ok(v2.html.includes(t), "quick commit preserves the edit in v2");
  // Send times are this process's wall clock and the last key the page's: on one machine, within a few ms.
  assert.deepEqual(toasts, ["info: Published v2."], `after publishing, the publisher sees only "Published v2." (the one edit was posted ${drafts.length} times: ${drafts.map((x) => `${x.status} sent +${Math.round(x.t - lastInput)} ms after the last key`).join(", ")})`);
});

// --- A9.9 ---------------------------------------------------------------------

scenario("A9.9 a failed pre-commit save shows \"The draft didn’t save, so nothing was published. Try again.\" and sends no POST /commit", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { owner, accounts, docId } = await stage(ctx, { name: "a99-presave", title: "A9.9 failed save" });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  await openEditor(o);
  const t = tok("f");
  await typeAndSave(o, "#e2e-6", t);

  ctx.step("every POST /draft from this page now answers 500; press Save as new version");
  const commits = o.capture({ paths: "/commit" });
  const fail = await o.failRequests("/draft", { status: 500 });
  let first;
  try {
    first = await o.saveAsNewVersion({ timeout: COMMIT_MS });
    await sleep(2_000); // the absence of a POST /commit is the oracle; one would have been sent before the toast
  } finally {
    await fail.restore();
  }
  ctx.ev.json("failed", { toast: first.toast, failedSaves: fail.failed.length, commits: postRows(commits) });
  precondition(fail.failed.length === 1, `exactly one pre-commit save was failed (got ${fail.failed.length})`);
  assert.deepEqual(postRows(commits), [], "no POST /commit was sent");
  assert.deepEqual({ outcome: first.outcome, text: first.text, kind: first.toast.kind }, { outcome: "save-failed", text: COPY.saveFailed, kind: "error" });
  const meta = await readDoc(target, `docs/${docId}`);
  assert.equal(meta.currentVersion, "v1", "nothing was published");
  assert.equal(await readDoc(target, `docs/${docId}/versions/v2`), null, "no v2");

  ctx.step("control: with saves answered again, the same button publishes");
  const second = await commitInApp(o);
  commits.stop();
  assert.deepEqual({ outcome: second.outcome, versionId: second.versionId }, { outcome: "published", versionId: "v2" }, `second attempt: ${second.text}`);
  assert.equal(commits.length, 1, "the control sent exactly one POST /commit");
  const v2 = await storedVersion(owner.http, docId, "v2");
  assert.ok(v2.html.includes(t), "v2 holds the edit");
  // The failure was injected, so the console carries the 500; nothing else may throw.
  noPageErrors([o]);
});

// --- A9.10 --------------------------------------------------------------------

/**
 * As a page's Save as new version does, from the owner's session rather than
 * a page: POST /draft of v1 with `html`, then POST /commit of v1. Each is sent
 * again only when the stack did not answer and its effect is not in the
 * record (functions/src/lib/draft.ts writeDraft records {baseVersion, bytes};
 * the commit makes v2 current). Resolves once v2 is the current version.
 */
async function commitV2(ctx, owner, docId, html) {
  const { out: saved, landed } = await untilLanded(ctx, "the owner's POST /draft", () => owner.http.postJson("/draft", { docId, baseVersion: "v1", html }), async () => {
    const d = await readDoc(target, `docs/${docId}`);
    return d?.draft?.baseVersion === "v1" && d.draft.bytes === Buffer.byteLength(html, "utf8");
  }, patience(ctx));
  precondition(landed || saved.status === 200, `the owner's POST /draft answered ${saved?.status} ${saved?.text?.slice(0, 200)}`);
  const { out: c, landed: committed } = await untilLanded(ctx, "the owner's POST /commit (v2)", () => owner.http.postJson("/commit", { docId, baseVersion: "v1" }), async () => (await readDoc(target, `docs/${docId}`))?.currentVersion === "v2", patience(ctx));
  precondition(committed || (c.status === 200 && c.json?.versionId === "v2"), `the owner's POST /commit answered ${c?.status} ${JSON.stringify(c?.json)}`);
}

/**
 * The stale-base 409 now has one meaning: SPEC §16, spec.md:1552-1554, "The
 * stale-base `409` **stays**, and now means only what it always meant:
 * somebody PUBLISHED a new version while you were editing." From 0.16.0 an
 * update from bytes can no longer be that publish. SPEC §6a, spec.md:776-779:
 * "`/publish?update=`, the CLI and `update_document` are refused with `409 {
 * error, editors }` while anybody has the document open in the editor". This
 * case used to publish v2 that way, and on 0.16.0 that answers 409
 * {editors: 1}. A commit of the draft is not held (spec.md:774-775, "The
 * in-app commit publishes the draft itself and is not held"). POST /commit
 * asks nobody's presence (functions/src/index.ts:1289-1346, commitVersion,
 * and lib/draft.ts commitDraft, neither of which calls editorsRefusal). So
 * the owner saves a draft and commits it while the editor is in the editor:
 * the two requests a co-editor's Save as new version sends. The editor's
 * page is pinned to /d/<doc>/v1, so it stays on v1 as a page whose author
 * has not reloaded does, and its autosave still names v1.
 */
scenario("A9.10 an autosave against a superseded base answers 409 and the editor shows \"Somebody published a newer version. Reload to continue.\"", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { owner, accounts, docId } = await stage(ctx, { name: "a910-stale", title: "A9.10 stale", readers: [{ label: "editor", role: "editor" }] });
  ctx.step("the editor opens /d/<doc>/v1 (v1 is the head) and starts editing it");
  const e = await signedIn(ctx, "editor", accounts[1], docId, { v: "v1" });
  await openEditor(e);

  ctx.step("while the editor edits, the owner publishes v2 over v1 by committing a draft (POST /draft, then POST /commit), which nobody's editor holds back");
  await commitV2(ctx, owner, docId, FIXTURE_HTML.replace("Paragraph 39.", "Paragraph 39 (v2)."));
  await eventually(async () => (await readDoc(target, `docs/${docId}`)).currentVersion === "v2", { timeout: LATENCY_MS, message: "v2 is current" });

  const t = tok("s");
  ctx.step(`the editor, still on v1, types ${t}; the autosave posts baseVersion v1`);
  const since = e.toastMark();
  // Any status: the refusal is the oracle, asserted below. Hosting's cut-off is the stack not answering (answered()).
  const save = await e.typeAndAutosave("#e2e-7", t, { delay: 15, timeout: SAVE_MS, expectStatus: null });
  answered(save.entry, "the editor's autosave, POST /draft");
  const posted = save.entry.postJson ?? {};
  ctx.ev.json("stale", { status: save.status, body: save.body, baseVersion: posted.baseVersion, saveState: save.saveState });
  precondition(posted.baseVersion === "v1", `the autosave posted baseVersion ${posted.baseVersion}`);
  assert.equal(save.status, 409, "the stale autosave is refused");
  assert.equal(save.body?.currentVersion, "v2", "the refusal names the current version");
  const toast = await e.waitForToast((x) => x.kind === "error", { since, timeout: LATENCY_MS });
  assert.equal(toast.text, COPY.stale);
  await eventually(async () => (await e.saveState()) === "error", { timeout: LATENCY_MS, message: "save state error" });
  assert.equal((await e.page.locator(".save-state").textContent()).trim(), COPY.staleSaveState, "the save state says why");
  assert.equal("draft" in (await readDoc(target, `docs/${docId}`)), false, "no draft was written on the superseded base");
  noPageErrors([e]);
});

// --- A9.11 --------------------------------------------------------------------

/** docs/development/verification.md §7's counts, from a parsed document. */
function walkthroughCounts(doc) {
  const all = Array.from(doc.querySelectorAll("*"));
  const ids = all.filter((el) => el.hasAttribute("id")).map((el) => el.id);
  const seen = new Map();
  for (const i of ids) seen.set(i, (seen.get(i) ?? 0) + 1);
  const artifacts = all.filter((el) =>
    el.id.toLowerCase().startsWith("bshd-") ||
    Array.from(el.classList).some((c) => c.toLowerCase().startsWith("bshd-")) ||
    el.getAttributeNames().some((n) => n.startsWith("data-bshd-")),
  ).length;
  return {
    bshdArtifacts: artifacts,
    dataBshd: doc.querySelectorAll("[data-bshd]").length,
    contenteditable: doc.querySelectorAll("[contenteditable]").length,
    script: doc.querySelectorAll("script").length,
    style: doc.querySelectorAll("style").length,
    dotNavChildren: doc.getElementById("dot-nav")?.childNodes.length ?? null,
    sections: doc.querySelectorAll("section").length,
    details: doc.querySelectorAll("details").length,
    svg: doc.querySelectorAll("svg").length,
    ids: ids.length,
    duplicateIds: [...seen].filter(([, n]) => n > 1).map(([i]) => i).sort(),
  };
}

/** What A9.11 leaves for its BODYATTR case. */
const walkthrough = { bodyAttr: null };

scenario("A9.11 verification §7: resolve the thread, edit a heading, commit; v1 and v2 have the walkthrough's counts and v2 is clean (DECOR, REHASH)", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { owner, accounts, docId, html } = await stageTour(ctx, { name: "a911-walk", trusted: true });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  const dots = await inFrameDoc(o, (doc) => doc.getElementById("dot-nav")?.children.length ?? null);
  precondition(dots === 15, `reading the trusted sample, its script filled #dot-nav with 15 links (got ${dots})`);

  ctx.step("an open thread: the owner's agent comments on s1's lede");
  await quietDoc(target, docId);
  const mcp = await ownerAgent(ctx, owner);
  const exact = "Collect comments anchored to the exact passage";
  precondition(html.split(exact).length === 2, `"${exact}" is unique in the sample`);
  const made = await mcp.ok("add_comment", { id: docId, exact, body: `A9.11 ${tok("c")}` });
  precondition(made?.threadId, `add_comment returned ${JSON.stringify(made)}`);

  await openEditor(o);
  const save = o.page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Save as new version", exact: true });
  await eventually(async () => (await save.isDisabled()) === true, { timeout: LATENCY_MS, message: "the open thread disables Save as new version" });
  assert.equal(await save.getAttribute("title"), COPY.unresolvedReason, "and the button says why");
  await mcp.ok("resolve_thread", { id: docId, threadId: made.threadId });
  await eventually(async () => (await save.isDisabled()) === false, { timeout: LATENCY_MS, message: "resolved, Save as new version is enabled" });

  const t = tok("h");
  ctx.step(`edit a heading: type " ${t}" at the end of #s2-name's h2, then commit`);
  await typeAndSave(o, "#s2-name h2", ` ${t}`);
  const commit = await commitInApp(o);
  precondition(commit.outcome === "published" && commit.versionId === "v2", `the commit published v2 (${commit.text})`);

  const [s1, s2] = await Promise.all([storedVersion(owner.http, docId, "v1"), storedVersion(owner.http, docId, "v2")]);
  assert.equal(s1.html, html, "v1's stored bytes are the sample's");
  assert.equal(s1.rehash, s1.record.contentHash, "REHASH v1");
  assert.equal(s2.rehash, s2.record.contentHash, "REHASH v2");
  ctx.ev.text("v2.html", s2.html);
  const [c1, c2] = [await parseAndRun(ctx.users, s1.html, walkthroughCounts), await parseAndRun(ctx.users, s2.html, walkthroughCounts)];
  ctx.ev.json("counts", { v1: c1, v2: c2 });
  ctx.t.diagnostic(`§7 counts v1=${JSON.stringify(c1)} v2=${JSON.stringify(c2)}`);
  const want = { bshdArtifacts: 0, dataBshd: 0, contenteditable: 0, script: 1, style: 1, dotNavChildren: 0, sections: 15, details: 10, svg: 6, duplicateIds: [] };
  const pick = (c) => Object.fromEntries(Object.keys(want).map((k) => [k, c[k]]));
  assert.deepEqual(pick(c1), want, "v1 has the walkthrough's counts");
  assert.deepEqual(pick(c2), want, "v2 has the walkthrough's counts");
  // The walkthrough's "29 ids" counts `id="` in the bytes: one of them is
  // text, inside s5-sections' <pre><code> example. The DOM has one fewer.
  const rawIds = (h) => (h.match(/\sid="/g) ?? []).length;
  assert.deepEqual({ v1: rawIds(s1.html), v2: rawIds(s2.html) }, { v1: 29, v2: 29 }, "29 ids, counted as the walkthrough counts them");
  assert.deepEqual({ v1: c1.ids, v2: c2.ids }, { v1: 28, v2: 28 }, "28 elements carry an id, in v1 and in v2");
  const h2 = await parseAndRun(ctx.users, s2.html, (doc) => doc.querySelector("#s2-name h2")?.textContent ?? null);
  assert.equal(h2, `The name ${t}`, "the heading edit is in v2");

  const parser = await ctx.users.parser();
  const fp1 = await fingerprint(parser, s1.html);
  const fp2 = await fingerprint(parser, s2.html);
  ctx.ev.json("fingerprints", { v1: summarize(fp1), v2: summarize(fp2) });
  // Measured for the BODYATTR case before this case's own DECOR asserts, so a DECOR failure here leaves it something to judge.
  walkthrough.bodyAttr = bodyAttrDiff(fp1, fp2);
  ctx.ev.json("bodyattr", walkthrough.bodyAttr);
  const diff = diffFingerprint(fp1, fp2, { contains: [` ${t}`] }, { ignoreBodyAttr: true });
  assert.deepEqual(diff.decoration, [], "DECOR: decoration in v2");
  assert.deepEqual(diff.lost, [], "DECOR: lost author markers");
  assert.deepEqual(diff.structure, [], "DECOR: structure changed");
  assert.equal(diff.text.allowed, true, "the text change is exactly the heading edit");
  assert.equal(walkthrough.bodyAttr.equal, true, `BODYATTR: ${JSON.stringify(walkthrough.bodyAttr)}`);
  noPageErrors([o]);
});

scenario("A9.11 BODYATTR: the committed v2's <html> and <body> attributes equal v1's", { tiers: ["local", "prod"], timeoutMs: JUDGE_MS }, async (ctx) => {
  if (!walkthrough.bodyAttr) ctx.inconclusive("the A9.11 walkthrough case did not get to compare a committed v2 (see its outcome), so nothing was measured");
  ctx.step(`BODYATTR v1→v2: ${JSON.stringify(walkthrough.bodyAttr)}`);
  assert.equal(walkthrough.bodyAttr.equal, true, `BODYATTR: ${JSON.stringify({ body: walkthrough.bodyAttr.body, html: walkthrough.bodyAttr.html })}`);
});

// --- A9.12 --------------------------------------------------------------------

scenario("A9.12 the scripted sample's own script runs in the trusted reading frame and never in the edit frame", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { accounts, docId } = await stageTour(ctx, { name: "a912-noscript", trusted: true });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  const reading = await o.waitForFrame();
  const probe = (doc) => ({ dots: doc.getElementById("dot-nav")?.children.length ?? null, scripts: doc.scripts.length });
  const r = await inFrameDoc(o, probe);
  ctx.step(`reading, trusted: sandbox ${JSON.stringify(reading.sandbox)}, #dot-nav has ${r.dots} links`);
  assert.deepEqual({ sandbox: reading.sandbox, dots: r.dots, scripts: r.scripts }, { sandbox: null, dots: 15, scripts: 1 }, "control: allowed to, the script builds one #dot-nav link per section");

  await openEditor(o);
  const frameEl = await o.page.evaluate(() => document.querySelector("iframe.doc-frame").getAttribute("sandbox"));
  const tokens = String(frameEl ?? "").split(/\s+/).filter(Boolean);
  const ed = await inFrameDoc(o, probe);
  ctx.ev.json("edit", { sandbox: frameEl, ...ed });
  assert.equal(ed.scripts, 1, "the script element is in the edit frame, as authored");
  assert.equal(ed.dots, 0, "it did not run: #dot-nav is empty in the edit frame");
  assert.equal(tokens.includes("allow-scripts"), false, `the edit frame's sandbox has no allow-scripts (${JSON.stringify(frameEl)})`);
  noPageErrors([o]);
});

// --- A9.13 --------------------------------------------------------------------

scenario("A9.13 a <style> put into the edit frame's <head> after it loaded never reaches the draft, while the author's own <style> does", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { accounts, docId } = await stage(ctx, { name: "a913-head", title: "A9.13 injected style" });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  await openEditor(o);
  const marker = `e2e-extension-${runTag(target.runId)}-${rand4()}`;
  ctx.step(`as a browser extension would, put <style id="${marker}"> into the edit frame's <head>`);
  await o.page.evaluate((marker) => {
    const d = document.querySelector("iframe.doc-frame").contentDocument;
    const s = d.createElement("style");
    s.id = marker;
    s.textContent = `/* ${marker} */ html { scroll-behavior: auto; }`;
    d.head.appendChild(s);
  }, marker);

  const t = tok("e");
  await typeAndSave(o, "#e2e-8", t);
  const stillLive = await inFrameDoc(o, (doc, m) => Boolean(doc.getElementById(m)), marker);
  precondition(stillLive, "the injected style was in the frame when the draft was serialized");
  const draft = await draftObject(docId);
  precondition(draft?.includes(t), "the stored draft holds the typed token");
  ctx.ev.text("draft.html", draft);
  assert.equal(draft.includes(marker), false, "the injected <style> is not in the draft");
  const parser = await ctx.users.parser();
  const fp1 = await fingerprint(parser, FIXTURE_HTML);
  const fpD = await fingerprint(parser, draft);
  assert.deepEqual({ style: fpD.tags.style ?? 0, head: fpD.topLevel.head }, { style: fp1.tags.style, head: fp1.topLevel.head }, "the draft's <head> holds exactly the author's elements");
  const authored = /<style>[^<]*<\/style>/.exec(FIXTURE_HTML)[0];
  assert.ok(draft.includes(authored), "the author's <style> is in the draft byte for byte");
  noPageErrors([o]);
});

// --- A9.14 --------------------------------------------------------------------

scenario("A9.14 a document's own data-bshd=\"whatever\" survives editing, the draft and the commit", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { owner, accounts, docId } = await stage(ctx, { name: "a914-foreign", title: "A9.14 foreign marker", fixture: "foreign-marker.html" });
  const v1html = readFixture("foreign-marker.html");
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  await openEditor(o);
  const markedLive = await inFrameDoc(o, (doc) => doc.getElementById("e2e-foreign")?.getAttribute("data-bshd") ?? null);
  assert.equal(markedLive, "whatever", "the edit frame keeps the author's marker");

  const t = tok("w");
  await typeAndSave(o, "#e2e-3", t);
  const draft = await draftObject(docId);
  precondition(draft?.includes(t), "the stored draft holds the typed token");
  const commit = await commitInApp(o);
  precondition(commit.outcome === "published" && commit.versionId === "v2", `the commit published v2 (${commit.text})`);
  const v2 = await storedVersion(owner.http, docId, "v2");
  assert.equal(v2.rehash, v2.record.contentHash, "REHASH v2");

  const parser = await ctx.users.parser();
  const fp1 = await fingerprint(parser, v1html);
  const block = (doc) => {
    const el = doc.getElementById("e2e-foreign");
    return el ? { marker: el.getAttribute("data-bshd"), inner: el.innerHTML } : null;
  };
  const want = await parseAndRun(ctx.users, v1html, block);
  for (const [what, html] of [["the draft", draft], ["v2", v2.html]]) {
    const fp = await fingerprint(parser, html);
    const diff = diffFingerprint(fp1, fp, { contains: [t] }, { ignoreBodyAttr: true });
    assert.deepEqual(diff.lost, [], `${what}: DECOR lost nothing of the author's`);
    assert.deepEqual(foreignMarkers(fp), { whatever: 1 }, `${what}: the author's data-bshd value, once`);
    assert.deepEqual(diff.decoration, [], `${what}: DECOR no decoration`);
    assert.deepEqual(await parseAndRun(ctx.users, html, block), want, `${what}: the marked block is the author's, attribute and content`);
  }
  noPageErrors([o]);
});

// --- A9.15 --------------------------------------------------------------------

/**
 * A deck whose 1920 px slides are sized by its own script (a --fit custom
 * property it sets on load). Script-free, the property is never set, the
 * transform reading it is invalid, and the slides are full size and centred
 * in a narrower frame — so their left edge is at a negative offset.
 */
const WIDE_DECK = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>E2E wide deck</title>
<style>
html, body { margin: 0; }
body { font-family: system-ui, sans-serif; background: #ececf2; }
.wide { display: flex; flex-direction: column; align-items: center; gap: 40px; padding: 40px 0; }
.slide { flex: none; box-sizing: border-box; width: 1920px; height: 1080px; padding: 80px; background: #fff; transform: scale(var(--fit)); transform-origin: top center; }
.slide h2 { font-size: 96px; margin: 0 0 40px; }
.slide p { font-size: 48px; margin: 0; }
</style>
</head>
<body>
<div class="wide">
<section class="slide" id="w-1"><h2>Wide slide one</h2><p>The first slide of a deck that sizes itself by script.</p></section>
<section class="slide" id="w-2"><h2>Wide slide two</h2><p>The second slide, at the same fixed width.</p></section>
<section class="slide" id="w-3"><h2>Wide slide three</h2><p>The third and last slide.</p></section>
</div>
<script>document.documentElement.style.setProperty("--fit", String(Math.min(1, innerWidth / 1920)));</script>
</body>
</html>
`;

/** Inside the frame: its layout width, each slide's box, and every style the document carries. */
function deckState(doc, arg) {
  const own = new Set(arg.own);
  const w = doc.defaultView;
  return {
    innerWidth: w.innerWidth,
    htmlStyle: doc.documentElement.getAttribute("style"),
    bodyStyle: doc.body.getAttribute("style"),
    slides: Array.from(doc.querySelectorAll(".slide")).map((s) => {
      const r = s.getBoundingClientRect();
      return { id: s.id, style: s.getAttribute("style"), transform: w.getComputedStyle(s).transform, width: s.offsetWidth, left: r.left + w.scrollX, right: r.right + w.scrollX };
    }),
    headStyles: Array.from(doc.head.querySelectorAll("style, link")).filter((el) => !own.has(el.getAttribute("data-bshd") ?? "")).map((el) => el.outerHTML.length),
    ownStyles: Array.from(doc.head.querySelectorAll("[data-bshd]")).map((el) => el.getAttribute("data-bshd")).filter((v) => own.has(v)),
  };
}

scenario("A9.15 a deck that sizes its slides by script is fitted in edit mode by scaling the iframe, and the document's own styles are not changed", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { accounts, docId } = await stage(ctx, { name: "a915-deck", title: "A9.15 wide deck", body: WIDE_DECK });
  const o = await signedIn(ctx, "owner", accounts[0], docId);
  const authoredStyle = /<style>[\s\S]*?<\/style>/.exec(WIDE_DECK)[0].length;
  const reading = await inFrameDoc(o, deckState, { own: KNOWN_OWN_VALUES });
  ctx.ev.json("reading", reading);
  precondition(reading.slides.length === 3 && reading.slides.every((s) => s.width === 1920 && s.transform === "none"), `script-free, the slides are full size: ${JSON.stringify(reading.slides)}`);
  precondition(reading.slides[0].left < 0, `reading, the deck overflows the frame on the left (left ${reading.slides[0].left}, frame ${reading.innerWidth})`);

  await openEditor(o);
  // Settled, not first seen: the inline style lands a render before the
  // frame is laid out at it (seen once: style.width 1952px, offsetWidth and
  // the frame's innerWidth still 1265). Two equal samples of a frame laid out
  // at the iframe's own width; a fit that never settles times out and fails.
  const { fit, editing } = await eventually(async () => {
    const f = await o.page.evaluate(() => {
      const el = document.querySelector("iframe.doc-frame");
      return { transform: el.style.transform, width: el.style.width, origin: el.style.transformOrigin, offsetWidth: el.offsetWidth, stage: el.parentElement?.clientWidth ?? null };
    });
    if (!/^scale\(/.test(f.transform)) throw new Error(`the iframe is not scaled: ${JSON.stringify(f)}`);
    const st = await inFrameDoc(o, deckState, { own: KNOWN_OWN_VALUES });
    if (f.offsetWidth !== parseFloat(f.width) || st.innerWidth !== f.offsetWidth) throw new Error(`not laid out yet: iframe ${JSON.stringify(f)}, frame innerWidth ${st.innerWidth}`);
    return { fit: f, editing: st };
  }, { timeout: LATENCY_MS, interval: 250, stableSamples: 2, message: "the edit frame to be scaled and laid out at the iframe's width" });
  const scale = Number(/^scale\(([\d.]+)\)$/.exec(fit.transform)?.[1]);
  ctx.ev.json("editing", { fit, scale, editing });
  ctx.step(`the iframe is laid out at ${fit.width} and scaled by ${scale}`);

  assert.ok(scale > 0 && scale < 1, `the IFRAME is scaled down (${fit.transform})`);
  assert.ok(editing.innerWidth >= 1920, `the frame is laid out wide enough for the slides (${editing.innerWidth})`);
  assert.ok(editing.slides.every((s) => s.left >= 0 && s.right <= editing.innerWidth), `every slide is inside the frame: ${JSON.stringify(editing.slides)}`);
  assert.deepEqual(
    { htmlStyle: editing.htmlStyle, bodyStyle: editing.bodyStyle, slides: editing.slides.map((s) => ({ style: s.style, transform: s.transform, width: s.width })), headStyles: editing.headStyles },
    { htmlStyle: null, bodyStyle: null, slides: reading.slides.map(() => ({ style: null, transform: "none", width: 1920 })), headStyles: [authoredStyle] },
    "the document's own styles are as authored: no style attribute set, no stylesheet added beyond the app's own markers",
  );

  const t = tok("k");
  await typeAndSave(o, "#w-1 h2", t);
  const draft = await draftObject(docId);
  precondition(draft?.includes(t), "the stored draft holds the token typed through the scaled frame");
  const parser = await ctx.users.parser();
  const fp1 = await fingerprint(parser, WIDE_DECK);
  const fpD = await fingerprint(parser, draft);
  const diff = diffFingerprint(fp1, fpD, { contains: [t] }, { ignoreBodyAttr: true });
  assert.deepEqual({ decoration: diff.decoration, structure: diff.structure, textAllowed: diff.text.allowed }, { decoration: [], structure: [], textAllowed: true }, "the draft is v1 plus the token");
  assert.equal(bodyAttrDiff(fp1, fpD).equal, true, `<html>/<body> authored attributes: ${JSON.stringify(bodyAttrDiff(fp1, fpD))}`);
  const styles = await parseAndRun(ctx.users, draft, (doc) => Array.from(doc.querySelectorAll("[style]")).map((el) => el.localName));
  assert.deepEqual(styles, [], "no element in the draft carries a style attribute");
  noPageErrors([o]);
});
