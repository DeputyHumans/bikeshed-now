// SPDX-License-Identifier: Apache-2.0
// Reading and trust: the sandbox matrix, the trust dialog's three choices, one frame load, trust withdrawn by other people's versions, links, the click guard, nested details (SPEC §6, §6c, §6d).

/**
 * Catalogue A5, one scenario per case, each with its own accounts and
 * documents:
 *
 *   5.1 the sandbox matrix of docs/development/verification.md §5: a scripted
 *       upload (trusted:false) is sandboxed `allow-same-origin`, its script
 *       does not run, and the trust prompt shows; a script-free upload is
 *       sandboxed the same and never prompts; a trusted document (the owner's
 *       POST /trust, and locally the operator script) has no sandbox, its
 *       script runs, and nothing prompts
 *   5.2 the trust dialog: "Keep it sandboxed" changes nothing; "Run it for
 *       me" writes trust/{uid} for that reader alone, never `docs.trusted`;
 *       "Trust it for everyone" is shown to the owner only, POST /trust
 *       refuses everyone else (403 to a reader, 404 to a stranger, 401 to
 *       nobody), and the owner's press un-sandboxes it for every reader
 *   5.3 a reader holding a personal grant opens the document: the frame loads
 *       ONCE, already unsandboxed (the first load waits for their answer)
 *   5.4 trust carries into a new version only when the owner wrote it in the
 *       app: the owner's commit keeps `trusted` and every trust/{uid}; an
 *       editor's commit, the owner's own update_document, the owner's commit
 *       through a cli token and the owner's POST /publish?update= each
 *       withdraw both; a deduplicated update changes nothing
 *   5.5 links: an external link (with and without target=_blank), a link to
 *       the app's own page and one to another version open beside the
 *       document with no opener, and the frame stays put; a fragment scrolls
 *       the frame; a sibling file of the same version navigates the frame
 *   5.6 a drag that selects text on a deck that advances on click does not
 *       advance it, although the click happened; nor does a click on the
 *       highlight a comment then draws; a plain click still does
 *   5.7 a comment inside the nested <details> of the tour's #s5-sections is
 *       anchored to that section; after a reload its highlight is redrawn
 *       with both of its <details> open and the other eight still closed
 *
 * Expected behaviour is SPEC §6, §6c and §6d, verification.md §5 and §6, and
 * the product source cited at each oracle. Only e2e/lib/ talks to the stack.
 *
 * Negative controls: e2e/patches/controls-trust-onepass (5.3),
 * controls-noopener (5.5) and controls-clickguard (5.6). The other oracles
 * were seen red by mutating a scratch copy of this spec (a row given the
 * wrong document, Keep pressed as Run, a stranger made a reader, each
 * commit made by the other actor, the outer <details> closed after the
 * reload, no reload, a popup opened WITH an opener, a plain click in place
 * of the highlight's, the frame-load recorder stopped before "Run it for
 * me", the reader's access removed while the dialog is open).
 *
 * Frame loads are the lib's `User.watchFrameLoads` (one row per navigation
 * request, with the sandbox each load really had); clicks inside the frame
 * are `User.clickInFrame`, which hit-tests the point before it clicks.
 *
 * The loaded stack. On the shared stack a setup call took the whole of
 * http.mjs's 60 s deadline (POST /publish, POST /session), a case's setup
 * alone ran 214 s into its 240 s, a document's frame was not loaded within
 * 45 s while the page's Firestore client had lost the emulator, and the
 * emulator failed a rule's get() under the trust dialog's "Run it for me"
 * ("Service call error"). None of that is the product answering, so every
 * case declares lib/test.mjs's `inconclusiveOnCaseTimeout` (and so
 * `inconclusiveOnPageStall` and `inconclusiveOnStackTimeout`),
 * `inconclusiveOnRequestStall` and `inconclusiveOnFunctionKill`: a
 * non-answer, or a wait that ran out while one of the case's pages or its own
 * requests saw the stack stall (Hosting's cut-off, a Firestore client that
 * lost the emulator) or the emulator killed functions under load, ends it
 * INCONCLUSIVE, and nothing else does; an assertion always FAILS. Setup calls
 * (sessions, sign-ins, uploads, shares, tokens, the owner's own POST /trust)
 * go through lib's `untilLanded`, or the `patient` of publish and share,
 * which look for a call's effect before sending it again, with `stopAt:
 * "budget"`: sent again only while one more send and its look fit the case's
 * budget, so a stack that keeps not answering ends the case INCONCLUSIVE
 * before its budget runs out. The calls a case measures (a commit, update_document, an update
 * upload, a refused POST /trust, a dialog press) are sent once, and a
 * non-answer to one is INCONCLUSIVE. A dialog press (lib's
 * pressRetryingServiceError) or a comment (comment's retryServiceError) the
 * emulator refused with "Service call error" is pressed again (3 s apart, up
 * to 3 more times), and when every press was refused so, the case is
 * INCONCLUSIVE; any other refusal FAILS at once. All of it was seen working
 * on scratch copies: every client deadline made 1 ms (INCONCLUSIVE, "POST
 * /session (owner) got no answer"); one upload never answered in a case
 * whose budget holds two sends and their looks but not three (INCONCLUSIVE,
 * "not sent again: … would not end within the case's budget", and without
 * `stopAt: "budget"` a FAIL as the budget ran out mid-look); and the
 * access-removed refusal read as the emulator's (INCONCLUSIVE after 4
 * presses) beside the same refusal as it is (FAIL on its own words).
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { answered, currentTarget, precondition, scenario, untilLanded } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { bearerHttp, mintToken, openSession } from "../../lib/session.mjs";
import { publish, publishOperator, publishZip, readSample, updateUpload } from "../../lib/seed.mjs";
import { share } from "../../lib/grant.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { selectionText } from "../../lib/frame.mjs";
import { createGuard } from "../../lib/guard.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

/** The scripted sample (H) and the script-free one (B). */
const TOUR = "bikeshed-tour";
const SCRIPT_FREE = "design-review-shortener";
/** The dialog's accessible name: TrustDialog.tsx's Modal title. */
const TRUST_DIALOG = "This document wants to run its own code";
/** The only sandbox an untrusted reading frame gets (frameMode.ts frameSandbox, SPEC §6c). */
const SANDBOXED = "allow-same-origin";
/** useDocTrust.ts PERSONAL_TRUST_WAIT_MS: how long a first load waits for a reader's own answer (SPEC §6c "Bounded"). */
const PERSONAL_TRUST_WAIT_MS = 1500;
/** How long "nothing changes" has to hold: 12 samples 250 ms apart (a state that changes resets the count). */
const QUIET = { stableSamples: 12, interval: 250, timeout: 30_000 };

/**
 * How long a function request may take on a loaded shared stack: past
 * Hosting's own minute, so its cut-off 504 is what is seen (and judged by
 * lib/test.mjs as the stack not answering), never this client's deadline first.
 */
const FN_MS = 150_000;
/** How long a sign-in, a document's open or a reload may take on a loaded stack: a wait on a condition. */
const SLOW = Object.freeze({ timeout: 90_000 });

/**
 * The file's budget (lib/budget.mjs): the seven timeouts below sum to the
 * 60 minutes the scan caps a computed budget at, and the Node that runs the
 * file cuts it whole at that bound; a stall late in the file must end its own
 * case, not cancel the cases after it.
 */
export const E2E_FILE_TIMEOUT_MS = 65 * 60_000;

/** Each case's timeout. */
const A51_MS = 480_000;
const A52_MS = 540_000;
const A53_MS = 420_000;
const A54_MS = 900_000;
const A55_MS = 420_000;
const A56_MS = 420_000;
const A57_MS = 420_000;
/** How many more presses a "Service call error" refusal may cost, and the back-off before each (lib/browser.mjs comment's, for the emulator, not a wait on the product). */
const SERVICE_RETRIES = 3;
const SERVICE_BACKOFF_MS = 3_000;

const tag = () => `${runTag(target.runId)}-${rand4()}`;

// --- the loaded stack ---------------------------------------------------------

/**
 * untilLanded's options for every setup call: sent again only while one more
 * send and its look still end inside the case's own budget
 * (ctx.budgetEndsAt, which inconclusiveOnCaseTimeout sets), so a stack that
 * keeps not answering ends the case INCONCLUSIVE through untilLanded, never as
 * a budget that ran out mid-look (A5.5 on the shared stack: three POST
 * /publish cut-offs ran 335 s into a 340 s budget).
 */
const PATIENCE = Object.freeze({ stopAt: "budget" });

/** A session (POST /session, safe to send again) whose client waits FN_MS for each answer. */
async function sessionFor(ctx, acct) {
  const { out } = await untilLanded(ctx, `POST /session (${acct.role})`, () => openSession(target, acct, { timeoutMs: FN_MS }), null, PATIENCE);
  return out;
}

/** A browser user signed in through /signup; signing in is safe to repeat, so a non-answer sends it again. */
async function signedIn(ctx, acct, name) {
  const u = await ctx.users.user({ name });
  const { out: s } = await untilLanded(ctx, `${name}'s sign-in`, () => u.signInUi(acct.email, acct.password, SLOW), null, PATIENCE);
  precondition(s.status === "ok", `${name} signed in through /signup`);
  return u;
}

/**
 * Open /d/<docId> and wait for the viewer and its loaded frame. The viewer
 * waits on the record over the page's Listen channel, which a loaded stack
 * can stall: User.waitShown loads the page once more only when THIS page saw
 * that happen (`reloads: 0` never does), and otherwise its failure is the
 * case's, judged by pageStall.
 */
async function openDoc(u, docId, { reloads = 1 } = {}) {
  const path = `/d/${encodeURIComponent(docId)}`;
  await u.goto(path, SLOW);
  const shown = await u.waitShown(".viewer-body", { what: `the viewer of ${docId}`, path, timeout: SLOW.timeout, reloads });
  await u.waitForFrame(SLOW);
  return shown;
}

/**
 * Share through lib's share (POST /access locally) with `patient`: a grant
 * the stack did not answer is looked for in the document's record before it
 * is sent again. On the loaded shared stack each of three POST /access in a
 * row got Hosting's cut-off, and the grant was in the record all the same
 * (the emulator ran the function late): sent again blind, the case ended
 * INCONCLUSIVE on a grant already made.
 */
async function shareWith(ctx, owner, docId, account, role) {
  await share(target, { owner, doc: docId, account, role, timeoutMs: FN_MS, patient: { ctx, ...PATIENCE } });
}

/**
 * The owner's POST /trust {trusted: true} as setup: sent again when the stack
 * did not answer, after looking for its effect (docs.trusted true, which the
 * caller has seen false). Resolves the answer, or null when it landed unanswered.
 */
async function trustForEveryone(ctx, owner, docId) {
  const { out } = await untilLanded(
    ctx,
    `POST /trust ${docId}`,
    () => owner.http.postJson("/trust", { docId, trusted: true }, { expect: 200, timeoutMs: FN_MS }),
    async () => ((await docRecord(docId))?.trusted === true ? true : null),
    PATIENCE,
  );
  return out;
}

// --- helpers ------------------------------------------------------------------

/** An owner with a session, and the rest of the cast as bare accounts. */
async function castWithOwner(ctx, roles) {
  const accounts = await cast(target, ["owner", ...roles]);
  const owner = await sessionFor(ctx, accounts[0]);
  return { owner, accounts };
}

/** Publish a sample through POST /publish (a browser upload: trusted:false, SPEC §6c), patiently. */
async function uploadSample(ctx, owner, sample, name) {
  const s = readSample(target, sample);
  const title = `${s.title} ${tag()}`;
  const up = await publish(owner.http, { body: s.bytes, filename: s.filename, title, name, timeoutMs: FN_MS, patient: { ctx, ...PATIENCE } });
  precondition(up.versionId === "v1", `the upload of ${sample} minted v1 (got ${up.versionId})`);
  return { docId: up.docId, html: s.bytes.toString("utf8"), title };
}

async function docRecord(docId) {
  return readDoc(target, `docs/${docId}`);
}

/** docs/{id}/trust as [{id, uid, email, trustedAt}], sorted by id. */
async function trustGrants(docId) {
  const rows = await readCollection(target, `docs/${docId}/trust`);
  return rows
    .map((r) => ({ id: r.id, uid: r.data.uid, email: r.data.email, trustedAt: r.data.trustedAt?.toMillis?.() ?? r.data.trustedAt ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * What the reader's viewer shows: the reading frame's sandbox attribute (null
 * = none), whether the trust prompt is offered (the toolbar's "Scripts
 * blocked" and the warning banner, both driven by useDocTrust's
 * shouldOffer), and, inside the frame, whether the tour's script ran: it
 * builds one #dot-nav link per section[id] before anything else.
 */
async function viewState(u) {
  const shell = await u.page.evaluate(() => {
    const el = document.querySelector("iframe.doc-frame");
    const banners = Array.from(document.querySelectorAll(".viewer-banners .banner")).map((b) => b.textContent.replace(/\s+/g, " ").trim());
    return {
      frame: Boolean(el),
      loading: Boolean(document.querySelector(".frame-loading")),
      sandbox: el ? el.getAttribute("sandbox") : null,
      offerButton: Boolean(document.querySelector('.viewer-toolbar button[aria-label="Scripts blocked"]')),
      trustBanner: banners.some((t) => /scripts are blocked|builds its content with scripts/.test(t)),
    };
  });
  if (!shell.frame || shell.loading) return { ...shell, ready: false };
  const f = await u.frame();
  const inside = await f.evaluate(() => ({
    ready: document.readyState === "complete" && location.href !== "about:blank",
    scripts: document.querySelectorAll("script").length,
    sections: document.querySelectorAll("section[id]").length,
    dots: document.getElementById("dot-nav")?.children.length ?? null,
  }));
  return { ...shell, ...inside };
}

/** The part of viewState an oracle compares: sandbox, offer, and whether the tour's script ran. */
function verdict(s) {
  return {
    sandbox: s.sandbox,
    offered: s.offerButton && s.trustBanner ? true : !s.offerButton && !s.trustBanner ? false : `inconsistent (button ${s.offerButton}, banner ${s.trustBanner})`,
    scriptRan: s.dots == null ? null : s.dots > 0 && s.dots === s.sections,
  };
}

/**
 * Wait until the viewer shows `want` ({sandbox, offered, scriptRan}) on
 * `stableSamples` consecutive samples. A sample that differs throws, so a
 * state that flips during the window resets it rather than passing.
 */
async function expectView(u, want, { stableSamples = 3, interval = 250, timeout = 45_000, message } = {}) {
  return eventually(
    async () => {
      const s = await viewState(u);
      if (!s.ready) throw new Error(`${u.name}: the frame is not loaded (${JSON.stringify(s)})`);
      const got = verdict(s);
      assert.deepEqual(got, want, `${u.name}: ${JSON.stringify(got)} (raw ${JSON.stringify(s)})`);
      return got;
    },
    { stableSamples, interval, timeout, message: message ?? `${u.name} shows ${JSON.stringify(want)}` },
  );
}

/** Open the trust dialog from the toolbar's "Scripts blocked" (ViewerToolbar.tsx). */
async function openTrustDialog(u) {
  await u.page.locator('.viewer-toolbar button[aria-label="Scripts blocked"]').first().click();
  const dlg = u.page.getByRole("dialog", { name: TRUST_DIALOG });
  await dlg.waitFor({ state: "visible", timeout: 10_000 });
  return dlg;
}

/**
 * Press one of the trust dialog's buttons and wait for the dialog to close.
 * A press the product reports refused (an error toast: a trust write the
 * rules or POST /trust turned down) fails at once with that toast's text,
 * rather than as a timeout waiting for a dialog that stays open.
 *
 * Except the emulator's own failure: under load it fails a rule's get()
 * ("Service call error. Function: [get], …"), and the rules never judged the
 * write. The dialog stays open after a refusal (TrustDialog.tsx `run` closes
 * it only on success), so lib/browser.mjs User.pressRetryingServiceError
 * presses the same button again, SERVICE_BACKOFF_MS apart and with the
 * refusals' toasts dismissed first (three stacked cover the dialog's
 * buttons), up to SERVICE_RETRIES more times; when every press was refused
 * so, it throws with a `stackCut` naming them, which lib/test.mjs reads as
 * the stack not answering. Resolves {serviceErrors}.
 */
async function pressInDialog(u, dlg, name, { timeout = 30_000 } = {}) {
  return u.pressRetryingServiceError(dlg.getByRole("button", { name, exact: true }), {
    retries: SERVICE_RETRIES,
    backoffMs: SERVICE_BACKOFF_MS,
    done: async () => (await dlg.count()) === 0,
    timeout,
    what: name,
  });
}

/** The dialog's buttons by name: which are present. */
async function dialogButtons(dlg) {
  const names = ["Run it for me", "Sandbox it again for me", "Trust it for everyone", "Keep it sandboxed"];
  const out = {};
  for (const n of names) out[n] = await dlg.getByRole("button", { name: n, exact: true }).count();
  return out;
}

/** "Run it for me" in the reader's own browser, and wait for its grant and the unsandboxed frame. */
async function grantPersonal(u, account, docId) {
  await expectView(u, { sandbox: SANDBOXED, offered: true, scriptRan: false }, { message: `${u.name} is offered the choice before granting` });
  const dlg = await openTrustDialog(u);
  await pressInDialog(u, dlg, "Run it for me");
  await eventually(async () => (await trustGrants(docId)).some((g) => g.id === account.uid), { timeout: 30_000, message: `trust/${account.uid} exists` });
  await expectView(u, { sandbox: null, offered: false, scriptRan: true }, { message: `${u.name}'s frame remounts unsandboxed` });
}

/** The pages open in a user's context. */
const pagesOf = (u) => u.context.pages();

function noPageErrors(users) {
  for (const u of users) assert.deepEqual(u.log.errors.map((e) => e.message), [], `${u.name}: uncaught page errors`);
}

// --- A5.1 ---------------------------------------------------------------------

scenario("A5.1 sandbox matrix: a scripted untrusted upload is sandboxed, runs nothing and prompts; a script-free one is sandboxed and silent; a trusted one runs its script unsandboxed and silent", { tiers: ["local", "prod"], timeoutMs: A51_MS, inconclusiveOnCaseTimeout: true, inconclusiveOnRequestStall: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  ctx.step("cast an owner; upload the scripted tour twice and the script-free sample once through POST /publish");
  const { owner, accounts } = await castWithOwner(ctx, []);
  const scripted = await uploadSample(ctx, owner, TOUR, "a51-scripted");
  const plain = await uploadSample(ctx, owner, SCRIPT_FREE, "a51-script-free");
  const trustedUp = await uploadSample(ctx, owner, TOUR, "a51-trusted");

  ctx.step("the owner trusts the second tour for everyone (POST /trust)");
  const t = await trustForEveryone(ctx, owner, trustedUp.docId);
  if (t !== null) assert.deepEqual(t.json, { trusted: true }, "POST /trust's answer");

  const rows = [
    { label: "scripted, untrusted", docId: scripted.docId, stored: false, want: { sandbox: SANDBOXED, offered: true, scriptRan: false } },
    { label: "script-free, untrusted", docId: plain.docId, stored: false, want: { sandbox: SANDBOXED, offered: false, scriptRan: null } },
    { label: "scripted, trusted by the owner", docId: trustedUp.docId, stored: true, want: { sandbox: null, offered: false, scriptRan: true } },
  ];
  if (target.kind === "local") {
    ctx.step("locally, also publish the tour with the operator script (scripts/publish.mjs writes trusted:true)");
    const op = await publishOperator(target, { sample: TOUR, owner: accounts[0], title: `Operator tour ${tag()}` });
    precondition(op.code === 0, `scripts/publish.mjs exited ${op.code}: ${op.stderr.slice(-400)}`);
    rows.push({ label: "scripted, trusted (operator script)", docId: op.docId, stored: true, want: { sandbox: null, offered: false, scriptRan: true } });
  }

  ctx.step("the stored flag is what each path writes: uploads false, POST /trust and the operator script true");
  for (const r of rows) assert.equal((await docRecord(r.docId))?.trusted, r.stored, `${r.label}: docs/${r.docId}.trusted`);

  const o = await signedIn(ctx, accounts[0], "owner");
  const seen = [];
  for (const r of rows) {
    ctx.step(`open "${r.label}" and hold the view for 3 s`);
    await openDoc(o, r.docId);
    const got = await expectView(o, r.want, { ...QUIET, message: `${r.label}: the matrix row` });
    const raw = await viewState(o);
    if (r.label.startsWith("script-free")) assert.equal(raw.scripts, 0, "the script-free sample has no <script>");
    else assert.ok(raw.scripts > 0 && raw.sections > 0, `${r.label}: the tour has its script and sections (${JSON.stringify(raw)})`);
    seen.push({ row: r.label, ...got });
  }
  ctx.ev.json("matrix", seen);
  noPageErrors([o]);
});

// --- A5.2 ---------------------------------------------------------------------

scenario("A5.2 trust dialog: Keep it sandboxed changes nothing, Run it for me writes trust/{uid} for that reader only, Trust it for everyone is the owner's alone", { tiers: ["local", "prod"], timeoutMs: A52_MS, inconclusiveOnCaseTimeout: true, inconclusiveOnRequestStall: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  ctx.step("cast an owner, two viewers and a stranger; the owner uploads the tour and shares it with both viewers");
  const { owner, accounts } = await castWithOwner(ctx, ["viewer", "viewer2", "stranger"]);
  const [, viewerAcct, viewer2Acct, strangerAcct] = accounts;
  const doc = await uploadSample(ctx, owner, TOUR, "a52-dialog");
  for (const a of [viewerAcct, viewer2Acct]) await shareWith(ctx, owner, doc.docId, a, "viewer");

  const [o, v] = await Promise.all([signedIn(ctx, accounts[0], "owner"), signedIn(ctx, viewerAcct, "viewer")]);
  await Promise.all([openDoc(o, doc.docId), openDoc(v, doc.docId)]);
  const sandboxedView = { sandbox: SANDBOXED, offered: true, scriptRan: false };
  await Promise.all([expectView(o, sandboxedView), expectView(v, sandboxedView)]);

  ctx.step("the viewer opens the dialog: Run it for me and Keep it sandboxed, and no Trust it for everyone");
  let dlg = await openTrustDialog(v);
  assert.deepEqual(await dialogButtons(dlg), { "Run it for me": 1, "Sandbox it again for me": 0, "Trust it for everyone": 0, "Keep it sandboxed": 1 }, "a reader's dialog");

  ctx.step("Keep it sandboxed: the dialog closes, and for 3 s no grant, no flag, no frame load and no change in the view");
  const vLoads = v.watchFrameLoads(doc.docId);
  await pressInDialog(v, dlg, "Keep it sandboxed", { timeout: 10_000 });
  await eventually(async () => {
    const [grants, rec, s] = await Promise.all([trustGrants(doc.docId), docRecord(doc.docId), viewState(v)]);
    assert.deepEqual({ grants, trusted: rec.trusted, loads: vLoads.summary(), view: verdict(s) }, { grants: [], trusted: false, loads: [], view: sandboxedView });
    return true;
  }, { ...QUIET, message: "Keep it sandboxed changed nothing" });

  ctx.step("Run it for me: trust/{viewer} is written with the viewer's uid and email, docs.trusted stays false, and the viewer's frame reloads unsandboxed with the script run");
  dlg = await openTrustDialog(v);
  await pressInDialog(v, dlg, "Run it for me");
  const grants = await eventually(async () => {
    const g = await trustGrants(doc.docId);
    return g.length > 0 ? g : false;
  }, { timeout: 30_000, message: "a personal grant is written" });
  assert.deepEqual(grants.map(({ id, uid, email }) => ({ id, uid, email })), [{ id: viewerAcct.uid, uid: viewerAcct.uid, email: viewerAcct.email.toLowerCase() }], "exactly the viewer's own grant");
  assert.ok(Number.isFinite(grants[0].trustedAt), "trustedAt is a server timestamp");
  await expectView(v, { sandbox: null, offered: false, scriptRan: true }, { message: "the viewer's frame is unsandboxed" });
  await vLoads.stop();
  const runLoads = vLoads.summary();
  ctx.ev.json("viewer-frame-loads", runLoads);
  const lastLoad = runLoads.at(-1);
  assert.ok(lastLoad && lastLoad.sandbox === null && lastLoad.committed === true, `the viewer's frame reloaded without a sandbox: ${JSON.stringify(runLoads)}`);
  assert.equal((await docRecord(doc.docId)).trusted, false, "a personal grant never writes docs.trusted");

  ctx.step("for that reader only: the owner's open frame stays sandboxed, and so does a reload of it");
  await expectView(o, sandboxedView, { ...QUIET, message: "the owner's view is unchanged by the viewer's grant" });
  await o.page.reload({ waitUntil: "load", timeout: SLOW.timeout });
  await o.waitForFrame(SLOW);
  await expectView(o, sandboxedView, { message: "the owner's reloaded view is still sandboxed" });

  ctx.step("POST /trust refuses everyone but the owner: 403 to each reader, 404 to a stranger, 401 with no session");
  const [vs, v2s, xs] = await Promise.all([sessionFor(ctx, viewerAcct), sessionFor(ctx, viewer2Acct), sessionFor(ctx, strangerAcct)]);
  const anon = ctx.http({ actor: "anonymous", timeoutMs: FN_MS });
  const refusals = {};
  for (const [who, http] of [["viewer", vs.http], ["viewer2", v2s.http], ["stranger", xs.http], ["anonymous", anon]]) {
    // Sent once: Hosting's cut-off is the stack not answering (answered), any other status is the product's.
    refusals[who] = answered(await http.postJson("/trust", { docId: doc.docId, trusted: true }), `${who}'s POST /trust`).status;
  }
  assert.deepEqual(refusals, { viewer: 403, viewer2: 403, stranger: 404, anonymous: 401 }, "POST /trust by anyone but the owner");
  assert.equal((await docRecord(doc.docId)).trusted, false, "no refused call changed the flag");

  ctx.step("the owner's dialog has Trust it for everyone; pressing it sets docs.trusted and un-sandboxes the owner's frame");
  dlg = await openTrustDialog(o);
  assert.deepEqual(await dialogButtons(dlg), { "Run it for me": 1, "Sandbox it again for me": 0, "Trust it for everyone": 1, "Keep it sandboxed": 1 }, "the owner's dialog");
  const trustMark = o.responseMark();
  // The press waits for the dialog to close, which follows POST /trust's answer; its refusal is read after that answer.
  const pressed = pressInDialog(o, dlg, "Trust it for everyone", { timeout: SLOW.timeout });
  pressed.catch(() => undefined);
  const tr = answered(await o.waitForResponse({ method: "POST", path: "/trust" }, { since: trustMark, timeout: SLOW.timeout }), "the owner's POST /trust from the dialog");
  await pressed;
  assert.equal(tr.status, 200, "the owner's POST /trust");
  await eventually(async () => (await docRecord(doc.docId)).trusted === true, { timeout: 10_000, message: "docs.trusted is true" });
  await expectView(o, { sandbox: null, offered: false, scriptRan: true }, { message: "the owner's frame is unsandboxed" });
  assert.deepEqual((await trustGrants(doc.docId)).map((g) => g.id), [viewerAcct.uid], "global trust writes no personal grant and removes none");

  ctx.step("for everyone: the second viewer, who never granted anything, opens it unsandboxed with the script run and no prompt");
  const w = await signedIn(ctx, viewer2Acct, "viewer2");
  await openDoc(w, doc.docId);
  await expectView(w, { sandbox: null, offered: false, scriptRan: true }, { ...QUIET, message: "the second viewer's view of a globally trusted document" });
  noPageErrors([o, v, w]);
});

// --- A5.3 ---------------------------------------------------------------------

scenario("A5.3 a reader's own trust grant gives exactly one frame load, unsandboxed, when they open the document again", { tiers: ["local", "prod"], timeoutMs: A53_MS, inconclusiveOnCaseTimeout: true, inconclusiveOnRequestStall: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  ctx.step("cast an owner and a viewer; the owner uploads the tour and shares it");
  const { owner, accounts } = await castWithOwner(ctx, ["viewer"]);
  const viewerAcct = accounts[1];
  const doc = await uploadSample(ctx, owner, TOUR, "a53-one-load");
  await shareWith(ctx, owner, doc.docId, viewerAcct, "viewer");

  ctx.step("the viewer signs in, opens it and presses Run it for me");
  const v = await signedIn(ctx, viewerAcct, "viewer");
  await openDoc(v, doc.docId);
  await grantPersonal(v, viewerAcct, doc.docId);

  ctx.step("the viewer opens the document again in a fresh page load, and every load of its reading frame is recorded");
  const loads = v.watchFrameLoads(doc.docId);
  // One page load and no other: a second would record its own frame loads (reloads: 0; a stall then is judged, never loaded again).
  await openDoc(v, doc.docId, { reloads: 0 });
  await expectView(v, { sandbox: null, offered: false, scriptRan: true }, { message: "the reopened frame is unsandboxed with the script run" });
  // Long enough for a sandboxed-first load to have been replaced, whatever the bound.
  await eventually(async () => loads.summary().map((l) => [l.frameIndex, l.path, l.sandbox, l.committed]), { ...QUIET, message: "the frame's loads hold still" });
  await loads.stop();
  const timing = await v.page.evaluate(() =>
    performance.getEntriesByType("resource").filter((e) => e.initiatorType === "iframe" && e.name.includes("/content/")).map((e) => ({ path: new URL(e.name).pathname, startMs: Math.round(e.startTime) })),
  );
  const summary = loads.summary();
  ctx.ev.json("frame-loads", { loads: summary, timing });
  ctx.step(`frame loads: ${JSON.stringify(summary.map((l) => l.sandbox))}; iframe resource timing ${JSON.stringify(timing)}`);

  // SPEC §6c "Bounded": past PERSONAL_TRUST_WAIT_MS a frame may load sandboxed
  // and remount. A sandboxed first load that started after the bound is that
  // permitted fallback, not a defect, and says nothing either way. pageMs is
  // the lib's time from the page's own navigation request to the frame's.
  const first = summary[0];
  if (summary.length === 2 && first.sandbox === SANDBOXED && first.pageMs != null && first.pageMs >= PERSONAL_TRUST_WAIT_MS) {
    ctx.inconclusive(`the first frame load started ${Math.round(first.pageMs)} ms into the page, past the ${PERSONAL_TRUST_WAIT_MS} ms bound, so loading twice was allowed`);
  }
  assert.deepEqual(
    summary.map((l) => ({ kind: l.kind, sandbox: l.sandbox, committed: l.committed })),
    [{ kind: "content", sandbox: null, committed: true }],
    `exactly one load, without a sandbox (loads ${JSON.stringify(summary)}, timing ${JSON.stringify(timing)})`,
  );
  noPageErrors([v]);
});

// --- A5.4 ---------------------------------------------------------------------

/** Edit the tour's lede, the way an in-app edit changes text. */
function edited(html, marker) {
  const at = html.indexOf("</h1>");
  precondition(at > 0, "the tour has an <h1>");
  return `${html.slice(0, at)} ${marker}${html.slice(at)}`;
}

/**
 * POST /draft then POST /commit with a session: exactly what the app's Save
 * as new version sends. The draft is setup (the same bytes again are the
 * same draft); the commit is what the case measures, sent once.
 */
async function commitInApp(ctx, session, docId, baseVersion, html) {
  await untilLanded(ctx, `POST /draft ${docId}@${baseVersion}`, () => session.http.postJson("/draft", { docId, baseVersion, html }, { expect: 200, timeoutMs: FN_MS }), null, PATIENCE);
  const c = await session.http.postJson("/commit", { docId, baseVersion }, { expect: 200, timeoutMs: FN_MS });
  precondition(c.json?.deduped === false && c.json?.versionId, `the commit minted a version: ${JSON.stringify(c.json)}`);
  return c.json.versionId;
}

scenario("A5.4 a version by anyone but the owner in the app withdraws global and personal trust; the owner's own commit keeps both", { tiers: ["local", "prod"], timeoutMs: A54_MS, inconclusiveOnCaseTimeout: true, inconclusiveOnRequestStall: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  ctx.step("cast an owner, an editor and a viewer; the owner uploads the tour and shares it");
  const { owner, accounts } = await castWithOwner(ctx, ["editor", "viewer"]);
  const [, editorAcct, viewerAcct] = accounts;
  const doc = await uploadSample(ctx, owner, TOUR, "a54-withdraw");
  await shareWith(ctx, owner, doc.docId, editorAcct, "editor");
  await shareWith(ctx, owner, doc.docId, viewerAcct, "viewer");
  const editor = await sessionFor(ctx, editorAcct);

  // Two personal grants, so "every grant" is not satisfied by deleting one.
  const [v, o] = await Promise.all([signedIn(ctx, viewerAcct, "viewer"), signedIn(ctx, accounts[0], "owner")]);
  const readers = [{ u: v, acct: viewerAcct }, { u: o, acct: accounts[0] }];
  const grantIds = readers.map((r) => r.acct.uid).sort();
  const trustBoth = async (version) => {
    ctx.step(`on ${version}: the viewer and the owner each grant personal trust in the dialog, then the owner trusts it for everyone`);
    for (const r of readers) {
      await openDoc(r.u, doc.docId);
      await grantPersonal(r.u, r.acct, doc.docId);
    }
    await trustForEveryone(ctx, owner, doc.docId);
    const grants = await trustGrants(doc.docId);
    const state = { trusted: (await docRecord(doc.docId)).trusted, grants: grants.map((g) => g.id) };
    precondition(isDeepStrictEqual(state, { trusted: true, grants: grantIds }), `both scopes in place on ${version}: ${JSON.stringify(state)}`);
    return grants;
  };
  const trustState = async () => {
    const rec = await docRecord(doc.docId);
    return { currentVersion: rec.currentVersion, trusted: rec.trusted, grants: (await trustGrants(doc.docId)).map((g) => g.id) };
  };

  const grants1 = await trustBoth("v1");

  ctx.step("the owner commits an edit in the app (POST /draft, POST /commit with the owner's session): v2 keeps both scopes");
  const v2html = edited(doc.html, `owner edit ${tag()}`);
  const v2 = await commitInApp(ctx, owner, doc.docId, "v1", v2html);
  assert.equal(v2, "v2");
  assert.deepEqual(await trustState(), { currentVersion: "v2", trusted: true, grants: grantIds }, "the owner's in-app commit keeps trust (keepsTrust)");
  assert.deepEqual((await trustGrants(doc.docId)).map((g) => g.trustedAt), grants1.map((g) => g.trustedAt), "the personal grants are the same ones, not rewritten");

  ctx.step("the editor commits an edit in the app: v3 withdraws the global flag and every personal grant");
  const v3html = edited(v2html, `editor edit ${tag()}`);
  const v3 = await commitInApp(ctx, editor, doc.docId, "v2", v3html);
  assert.equal(v3, "v3");
  assert.deepEqual(await trustState(), { currentVersion: "v3", trusted: false, grants: [] }, "an editor's commit withdraws both scopes");

  await trustBoth("v3");
  ctx.step("the OWNER updates it through MCP (update_document with an mcp token): v4 withdraws both scopes too");
  const { out: minted } = await untilLanded(ctx, "POST /tokens (mcp)", () => mintToken(owner, { name: "e2e a05 update", channel: "mcp" }), null, PATIENCE);
  const mcp = ctx.mcp({ token: minted.token, actor: "owner-mcp", timeoutMs: FN_MS });
  await untilLanded(ctx, "MCP initialize", () => mcp.initialize(), null, PATIENCE);
  const v4html = edited(v3html, `agent edit ${tag()}`);
  const up = await mcp.ok("update_document", { id: doc.docId, content: v4html, baseVersion: "v3" });
  assert.deepEqual({ versionId: up.versionId, deduped: up.deduped }, { versionId: "v4", deduped: false }, `update_document: ${JSON.stringify(up)}`);
  assert.deepEqual(await trustState(), { currentVersion: "v4", trusted: false, grants: [] }, "an update through a token withdraws both scopes, even the owner's");

  await trustBoth("v4");
  ctx.step("the same content again through update_document is deduplicated: nothing minted, both scopes kept");
  const again = await mcp.ok("update_document", { id: doc.docId, content: v4html, baseVersion: "v4" });
  assert.deepEqual({ versionId: again.versionId, deduped: again.deduped }, { versionId: "v4", deduped: true }, `the repeated update: ${JSON.stringify(again)}`);
  assert.deepEqual(await trustState(), { currentVersion: "v4", trusted: true, grants: grantIds }, "a deduplicated update changes nothing");

  ctx.step("the OWNER commits through a cli token (POST /draft, POST /commit with Bearer): not written in the app, so v5 withdraws both scopes");
  const { out: cli } = await untilLanded(ctx, "POST /tokens (cli)", () => mintToken(owner, { name: "e2e a05 commit", channel: "cli" }), null, PATIENCE);
  const ownerByToken = { http: bearerHttp(target, cli.token, { actor: "owner-cli", timeoutMs: FN_MS }) };
  const v5html = edited(v4html, `token edit ${tag()}`);
  assert.equal(await commitInApp(ctx, ownerByToken, doc.docId, "v4", v5html), "v5");
  assert.equal((await readDoc(target, `docs/${doc.docId}/versions/v5`))?.publishedBy?.channel, "cli", "v5 records the cli channel");
  assert.deepEqual(await trustState(), { currentVersion: "v5", trusted: false, grants: [] }, "the owner's commit through a token withdraws both scopes");

  await trustBoth("v5");
  ctx.step("the OWNER uploads a new version with the session (POST /publish?update=): an upload in all but name, so v6 withdraws both scopes");
  const v6html = edited(v5html, `upload edit ${tag()}`);
  const upd = await updateUpload(owner.http, doc.docId, { body: v6html, baseVersion: "v5", expect: 200, timeoutMs: FN_MS });
  assert.equal(upd.json?.versionId, "v6", `POST /publish?update=: ${JSON.stringify(upd.json)}`);
  assert.deepEqual(await trustState(), { currentVersion: "v6", trusted: false, grants: [] }, "an update upload withdraws both scopes, even the owner's");
  noPageErrors([v, o]);
});

// --- A5.5 ---------------------------------------------------------------------

const OUT_HOST = "outbound.example";
const LINKS_INDEX = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Links out of a document</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem; }
  .spacer { height: 3200px; }
  a { display: inline-block; margin: 0 1rem 0.6rem 0; padding: 0.2rem 0; }
</style>
</head>
<body>
<h1 id="top">Links out of a document</h1>
<p id="links">
  <a id="ext-plain" href="https://${OUT_HOST}/e2e-a05/plain">Another site</a>
  <a id="ext-blank" href="https://${OUT_HOST}/e2e-a05/blank" target="_blank">Another site, target blank</a>
  <a id="app-page" href="/llms.txt">The app's own page</a>
  <a id="other-version" href="../v9/index.html">Another version</a>
  <a id="frag" href="#far">Down to the end</a>
  <a id="sibling" href="other.html">The sibling file</a>
</p>
<div class="spacer"></div>
<section id="far"><h2>The far end</h2><p>The fragment link's target.</p></section>
<div class="spacer"></div>
</body>
</html>
`;
const LINKS_OTHER = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>The sibling file</title></head>
<body><h1 id="sibling-page">The sibling file</h1><p>Another file of the same version.</p></body>
</html>
`;

/** The frame's location and where #far sits in its viewport. */
async function frameWhere(u) {
  const f = await u.frame();
  return f.evaluate(() => {
    const far = document.getElementById("far");
    return {
      path: location.pathname,
      hash: location.hash,
      farTop: far ? Math.round(far.getBoundingClientRect().top) : null,
      viewport: innerHeight,
      sibling: Boolean(document.getElementById("sibling-page")),
    };
  });
}

scenario("A5.5 links: an external link opens beside the document with no opener, a fragment scrolls the frame, a sibling file navigates the frame", { tiers: ["local", "prod"], timeoutMs: A55_MS, inconclusiveOnCaseTimeout: true, inconclusiveOnRequestStall: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  ctx.step("cast an owner, who uploads a two-file bundle: index.html with five links, and other.html");
  const { owner, accounts } = await castWithOwner(ctx, []);
  const up = await publishZip(owner.http, { "index.html": LINKS_INDEX, "other.html": LINKS_OTHER }, { title: `Links ${tag()}`, name: "a55-links", timeoutMs: FN_MS, patient: { ctx, ...PATIENCE } });
  precondition(up.versionId === "v1", `the bundle minted v1: ${JSON.stringify(up.json)}`);
  const docId = up.docId;
  const entryPath = `/content/${docId}/v1/index.html`;

  const o = await signedIn(ctx, accounts[0], "owner");
  await openDoc(o, docId);
  const pageUrl = o.page.url();
  const start = await frameWhere(o);
  assert.deepEqual({ path: start.path, hash: start.hash }, { path: entryPath, hash: "" }, "the frame shows index.html");
  precondition(start.farTop > start.viewport, `#far starts below the frame's viewport (${JSON.stringify(start)})`);

  ctx.step("the fragment link scrolls the frame to #far: no navigation, no new page");
  const pagesBefore = pagesOf(o).length;
  await o.clickInFrame("#frag");
  const scrolled = await eventually(async () => {
    const w = await frameWhere(o);
    if (!(w.hash === "#far" && Math.abs(w.farTop) <= 2)) throw new Error(`not scrolled: ${JSON.stringify(w)}`);
    return w;
  }, { timeout: 10_000, message: "#far is at the top of the frame" });
  assert.equal(scrolled.path, entryPath, "the fragment kept the document");
  assert.equal(pagesOf(o).length, pagesBefore, "a fragment opens no page");

  for (const link of [
    { sel: "#ext-plain", href: `https://${OUT_HOST}/e2e-a05/plain`, external: true },
    { sel: "#ext-blank", href: `https://${OUT_HOST}/e2e-a05/blank`, external: true },
    { sel: "#app-page", href: new URL("/llms.txt", target.origin).href, external: false, loads: true },
    { sel: "#other-version", href: new URL(`/content/${docId}/v9/index.html`, target.origin).href, external: false },
  ]) {
    ctx.step(`${link.sel}: a new page opens at ${link.href} with no opener, and the frame and the viewer stay where they are`);
    const marks = { external: o.log.external.length, requests: o.log.requests.length };
    const popupP = o.context.waitForEvent("page", { timeout: 15_000 });
    await o.clickInFrame(link.sel);
    const popup = await popupP;
    // The new page's own navigation as the context saw it. An external host is
    // blocked by the tripwire before any network (and recorded); a stack URL is
    // fetched — an absent version answers 404, which Chrome shows as its error page.
    const rec = await eventually(
      () => [...o.log.external.slice(marks.external), ...o.log.requests.slice(marks.requests)].find((r) => r.url === link.href && (r.resourceType ?? r.type) === "document") ?? false,
      { timeout: 10_000, message: `the new page navigated to ${link.href}` },
    );
    const opened = { url: rec.url, blocked: o.log.external.slice(marks.external).some((r) => r.url === link.href) };
    assert.equal(opened.blocked, link.external, `${link.sel}: the tripwire blocked it exactly when it is another site`);
    if (link.loads) {
      await popup.waitForLoadState("load", SLOW);
      assert.equal(popup.url(), link.href, `${link.sel}: the new page shows ${link.href}`);
    }
    // Wrapped: eventually() reads a bare `false` as "not yet". A stack URL's page may wait on the stack's answer first.
    const { openerIsNull } = await eventually(async () => ({ openerIsNull: await popup.evaluate(() => window.opener === null) }), { timeout: 60_000, message: "the new page's window.opener is readable" });
    assert.equal(openerIsNull, true, `${link.sel}: window.opener is null in the new page (noopener)`);
    const w = await frameWhere(o);
    assert.deepEqual({ path: w.path, viewer: o.page.url() }, { path: entryPath, viewer: pageUrl }, `${link.sel}: the frame still shows index.html and the viewer did not move`);
    ctx.ev.json(`opened-${link.sel.slice(1)}`, opened);
    await popup.close();
  }

  ctx.step("the sibling link navigates the frame to other.html of the same version, and opens no page");
  const pagesNow = pagesOf(o).length;
  await o.clickInFrame("#sibling");
  const nav = await eventually(async () => {
    const w = await frameWhere(o);
    if (!w.sibling) throw new Error(`not navigated: ${JSON.stringify(w)}`);
    return w;
  }, { timeout: 15_000, message: "the frame shows other.html" });
  assert.equal(nav.path, `/content/${docId}/v1/other.html`, "the frame navigated within the version");
  assert.equal(o.page.url(), pageUrl, "the viewer did not move");
  assert.equal(pagesOf(o).length, pagesNow, "a sibling file opens no page");
  noPageErrors([o]);
});

// --- A5.6 ---------------------------------------------------------------------

/**
 * A hand-made deck that advances on any click on its document — the shape
 * SPEC §6d names — plus a counter on the window, registered at parse time
 * and so ahead of the viewer's own window listener, which proves the drag's
 * click really was dispatched.
 */
const CLICK_DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>A deck that advances on click</title>
<style>
  html, body { margin: 0; height: 100%; }
  .deck { position: relative; height: 100vh; }
  .deck > section { position: absolute; inset: 0; padding: 3rem; font: 22px/1.5 system-ui, sans-serif; }
  html.js .deck > section { visibility: hidden; }
  html.js .deck > section.active { visibility: visible; }
</style>
</head>
<body>
<div class="deck">
  <section class="slide" id="slide-one"><h1>Slide one</h1><p id="one-text">A passage on the first slide that a reader wants to comment on.</p></section>
  <section class="slide" id="slide-two"><h1>Slide two</h1><p id="two-text">The second slide.</p></section>
  <section class="slide" id="slide-three"><h1>Slide three</h1><p id="three-text">The third slide.</p></section>
</div>
<script>
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll(".deck > section"));
  var current = 0;
  window.__e2eWindowClicks = 0;
  window.addEventListener("click", function () { window.__e2eWindowClicks += 1; }, true);
  document.documentElement.classList.add("js");
  function show(i) {
    current = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach(function (s, k) { s.classList.toggle("active", k === current); });
    window.__e2eCurrent = current;
  }
  document.addEventListener("click", function () { show(current + 1); });
  show(0);
})();
</script>
</body>
</html>
`;

async function deckState(u) {
  const f = await u.frame();
  return f.evaluate(() => ({
    current: window.__e2eCurrent ?? null,
    active: Array.from(document.querySelectorAll(".deck > section.active")).map((s) => s.id),
    windowClicks: window.__e2eWindowClicks ?? null,
  }));
}

const DECK_QUOTE = "a reader wants to comment on";

scenario("A5.6 a drag that selects text on a click-to-advance deck does not advance it", { tiers: ["local", "prod"], timeoutMs: A56_MS, inconclusiveOnCaseTimeout: true, inconclusiveOnRequestStall: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  ctx.step("cast an owner, who uploads a deck that advances on click and trusts it for everyone, so its script runs");
  const { owner, accounts } = await castWithOwner(ctx, []);
  const up = await publish(owner.http, { body: CLICK_DECK, filename: "index.html", title: `Click deck ${tag()}`, name: "a56-click-deck", timeoutMs: FN_MS, patient: { ctx, ...PATIENCE } });
  await trustForEveryone(ctx, owner, up.docId);

  const o = await signedIn(ctx, accounts[0], "owner");
  await openDoc(o, up.docId);
  const initial = await eventually(async () => {
    const s = await deckState(o);
    if (s.current !== 0) throw new Error(`the deck's script has not run: ${JSON.stringify(s)}`);
    return s;
  }, { timeout: 15_000, message: "the deck's script ran and shows slide one" });
  precondition((await viewState(o)).sandbox === null, "the trusted deck's frame is unsandboxed");
  assert.deepEqual(initial, { current: 0, active: ["slide-one"], windowClicks: 0 });

  ctx.step(`drag across "${DECK_QUOTE}" on slide one with the real mouse`);
  // The deck is read before anything about the selection: a deck that moved hides the passage, and with it the selection.
  const sel = await o.selectText("#one-text", DECK_QUOTE, { fab: false });
  const afterDrag = await eventually(async () => {
    const s = await deckState(o);
    if (s.windowClicks < 1) throw new Error(`no click reached the window yet: ${JSON.stringify(s)}`);
    return s;
  }, { timeout: 5_000, message: "the drag's click was dispatched" });
  assert.deepEqual(afterDrag, { current: 0, active: ["slide-one"], windowClicks: 1 }, "the drag's click reached the window but the deck did not advance");
  assert.deepEqual({ via: sel.via, text: sel.text }, { via: "drag", text: DECK_QUOTE }, "a real drag selected exactly the passage");
  await o.page.locator(".selection-fab").first().waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await selectionText(await o.frame())).trim(), DECK_QUOTE, "the selection is still the passage, with the Comment button shown");

  ctx.step("comment on the passage, then click the highlight it draws: that click is the thread's, and the deck never sees it either");
  if (target.kind !== "local") await createGuard(target).assertQuietDoc(up.docId);
  // A press the emulator refused with "Service call error" is made again after
  // another real drag over the passage: one more click the deck must not take.
  const posted = await o.comment(`Deck comment ${tag()}`, { timeout: 45_000, retryServiceError: SERVICE_RETRIES, reselect: () => o.selectText("#one-text", DECK_QUOTE) });
  await eventually(async () => (await (await o.frame()).locator("mark.bshd-hl").count()) >= 1, { timeout: 30_000, message: "the passage is highlighted" });
  const drags = 1 + posted.serviceErrors;
  assert.deepEqual(await deckState(o), { current: 0, active: ["slide-one"], windowClicks: drags }, `each of the ${drags} drag(s) reached the window without advancing the deck, and commenting, in the viewer's own panel, sent no click into the frame`);
  await o.clickInFrame("mark.bshd-hl");
  const afterMark = await eventually(async () => {
    const s = await deckState(o);
    if (s.windowClicks < drags + 1) throw new Error(`the highlight's click has not arrived: ${JSON.stringify(s)}`);
    return s;
  }, { timeout: 5_000, message: "the highlight's click was dispatched" });
  assert.deepEqual(afterMark, { current: 0, active: ["slide-one"], windowClicks: drags + 1 }, "the highlight's click reached the window but the deck did not advance");

  ctx.step("a plain click on the slide, away from the passage and the Comment button, still advances the deck");
  const vp = await (await o.frame()).evaluate(() => ({ w: innerWidth, h: innerHeight }));
  await o.clickInFrame({ x: Math.round(vp.w / 2), y: Math.round(vp.h * 0.85) });
  const afterClick = await eventually(async () => {
    const s = await deckState(o);
    if (s.windowClicks < drags + 2) throw new Error(`the plain click has not arrived: ${JSON.stringify(s)}`);
    return s;
  }, { timeout: 5_000, message: "the plain click was dispatched" });
  assert.deepEqual(afterClick, { current: 1, active: ["slide-two"], windowClicks: drags + 2 }, "a plain click reaches the deck's own listener");
  noPageErrors([o]);
});

// --- A5.7 ---------------------------------------------------------------------

const NESTED = "#s5-sections details details";
const NESTED_QUOTE = "To demonstrate that rehydration opens";

/** Every <details> in the frame, in document order: in #s5-sections or not, open or not, and the highlights inside. */
async function detailsState(u) {
  const f = await u.frame();
  return f.evaluate((nestedSel) => {
    const nested = document.querySelector(nestedSel);
    const all = Array.from(document.querySelectorAll("details"));
    const marks = Array.from(document.querySelectorAll("mark.bshd-hl"));
    return {
      details: all.map((d) => ({ s5: Boolean(d.closest("#s5-sections")), open: d.open })),
      marks: marks.map((m) => ({ text: m.textContent, inNested: Boolean(nested && nested.contains(m)) })),
    };
  }, NESTED);
}

scenario("A5.7 a highlight inside a nested <details> reopens exactly its own ancestors after a reload", { tiers: ["local", "prod"], timeoutMs: A57_MS, inconclusiveOnCaseTimeout: true, inconclusiveOnRequestStall: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  ctx.step("cast an owner, who uploads the tour (ten <details>, two of them nested in #s5-sections)");
  const { owner, accounts } = await castWithOwner(ctx, []);
  const doc = await uploadSample(ctx, owner, TOUR, "a57-details");
  if (target.kind !== "local") await createGuard(target).assertQuietDoc(doc.docId);

  const o = await signedIn(ctx, accounts[0], "owner");
  await openDoc(o, doc.docId);
  const before = await detailsState(o);
  assert.deepEqual(
    { total: before.details.length, s5: before.details.filter((d) => d.s5).length, open: before.details.filter((d) => d.open).length, marks: before.marks.length },
    { total: 10, s5: 2, open: 0, marks: 0 },
    "the tour as published: ten closed <details>, two in #s5-sections",
  );

  ctx.step("open the outer and then the nested disclosure in #s5-sections by clicking their summaries");
  await o.clickInFrame("#s5-sections > details > summary");
  await eventually(async () => (await detailsState(o)).details.filter((d) => d.open).length === 1, { timeout: 5_000, message: "the outer disclosure opened" });
  await o.clickInFrame(`${NESTED} > summary`);
  await eventually(async () => (await detailsState(o)).details.filter((d) => d.open).length === 2, { timeout: 5_000, message: "the nested disclosure opened" });

  ctx.step(`drag over "${NESTED_QUOTE}" inside the nested disclosure and comment`);
  const sel = await o.selectText(`${NESTED} > p`, NESTED_QUOTE);
  assert.deepEqual({ via: sel.via, text: sel.text }, { via: "drag", text: NESTED_QUOTE }, "a real drag selected exactly the passage");
  await o.comment(`Nested details ${tag()}`, { timeout: 45_000, retryServiceError: SERVICE_RETRIES, reselect: () => o.selectText(`${NESTED} > p`, NESTED_QUOTE) });
  const ann = await eventually(async () => {
    const rows = await readCollection(target, `docs/${doc.docId}/versions/v1/annotations`);
    return rows.length === 1 ? rows[0].data : false;
  }, { timeout: 30_000, message: "exactly one annotation on v1" });
  assert.deepEqual({ elementId: ann.anchor.elementId, exact: ann.anchor.exact }, { elementId: "s5-sections", exact: NESTED_QUOTE }, "the anchor is scoped to the nearest id-bearing ancestor (SPEC §6)");

  ctx.step("reload: the highlight is redrawn inside the nested disclosure, both of its <details> are open and the other eight are closed");
  // A property on the frame's window, never on its DOM: gone only if the frame really is a new document.
  await (await o.frame()).evaluate(() => {
    window.__e2eBeforeReload = true;
  });
  await o.page.reload({ waitUntil: "load", timeout: SLOW.timeout });
  await o.waitForFrame(SLOW);
  assert.equal(await (await o.frame()).evaluate(() => window.__e2eBeforeReload === true), false, "the frame is a new document after the reload");
  const after = await eventually(async () => {
    const s = await detailsState(o);
    if (s.marks.length === 0) throw new Error("no highlight drawn yet");
    return s;
  }, { timeout: 45_000, stableSamples: 3, interval: 250, message: "the highlight is redrawn after the reload" });
  ctx.ev.json("details-after-reload", after);
  assert.ok(after.marks.length >= 1 && after.marks.every((m) => m.inNested), `every highlight wrapper is inside the nested <details>: ${JSON.stringify(after.marks)}`);
  assert.equal(after.marks.map((m) => m.text).join(""), NESTED_QUOTE, "the wrappers carry exactly the quote");
  assert.deepEqual(
    after.details.map((d) => (d.s5 ? `s5:${d.open ? "open" : "closed"}` : d.open ? "other:open" : "other:closed")),
    before.details.map((d) => (d.s5 ? "s5:open" : "other:closed")),
    "exactly the highlight's own ancestors are open",
  );
  noPageErrors([o]);
});
