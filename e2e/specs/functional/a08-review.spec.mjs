// SPDX-License-Identifier: Apache-2.0
// A8 the review pass: idle notice and commit gate, the highlight mark, claim → draft → accept, reject, stale, Previous/Next/Done, an interrupted accept, an author's change mid-review, tokens, the committed bytes (SPEC §22).

/**
 * Catalogue A8, each case on its own accounts and its own document. The
 * suggestions themselves are made over POST /suggestion (A7 drives the form);
 * everything an approver decides is decided in the app, as SPEC §22 says it
 * must be ("An approver decides suggestions in the editor, because accepting
 * is an edit there").
 *
 *   A8.1  an editor who may not decide sees the idle notice saying who can;
 *         "Save as new version" is greyed out with that reason; POST /commit
 *         over their saved draft is 409 with pendingSuggestions: 1
 *   A8.2  the pass marks its target with the CSS Custom Highlight API: a
 *         `bshd-review` highlight over exactly the quote, and ZERO mutations
 *         of the frame's document; Accept sends claim → POST /draft → accept,
 *         each after the last has answered; the change lands once, the
 *         decision is the approver's (web), and the pass ends saying so
 *   A8.3  Reject… with a reason leaves the note "Rejected: <reason>" (without
 *         one, "Rejected."), stamped with the approver, seen by the suggester;
 *         rejecting sends no claim and saves no draft
 *   A8.4  a suggestion the draft has already rewritten is stale in the pass:
 *         said so, Accept greyed out, nothing claimed; one that turns stale
 *         under the approver's click is refused before any claim; a stale
 *         suggestion is still rejectable
 *   A8.5  Previous and Next walk the pass and wrap; Done leaves it; deciding
 *         moves on to the following suggestion; the notice at the end of the
 *         pass is the true one ("Resolve the open comments, then publish…"
 *         after an accept with a comment open; "No suggestions are left to
 *         review." when nothing was accepted here)
 *   A8.6  an accept request that never reaches the server leaves the change in
 *         the saved draft and the suggestion pending, says so; accepting again
 *         finds it made, records it, and the text is there exactly once
 *   A8.7  the author revises while the approver's claim is on its way: the
 *         claim is refused 409 (changed) and nothing is applied; the pass then
 *         shows the new text, and accepting applies and records THAT text;
 *         the author's revise during the approver's live claim is refused 409
 *         with claimedBy
 *   A8.7b the accept's own check: with the accept held past the claim's two
 *         minutes, the author's revise is taken, and the accept, naming the
 *         old text, is refused 409 (changed); nothing is recorded, and the
 *         approver is told it failed
 *   A8.8 with a personal token (cli or mcp channel) an approver's claim,
 *         release, accept and reject are each 403 and change nothing, while
 *         the same approver's web session may claim; the author's tokens may
 *         revise and withdraw (200)
 *   A8.9  the version committed after an in-app accept holds the replacement
 *         once and passes REHASH, DECOR and BODYATTR beyond the known S3; the
 *         accept reached a co-editor once through the shared document
 *   A8.9 (BODYATTR) the same version's <html>/<body> attributes equal v1's
 *         exactly — known defect S3 (`spellcheck` on <body>)
 *
 * EMAIL. Creating a suggestion and every decision note write a comment, which
 * notifies the deciders and the thread's participants unless they opted out.
 * Every account here opts out before its first session (as a06 does) and every
 * case asserts quietDoc() before its first suggestion, so no case sends mail on
 * either tier and none declares an email effect.
 *
 * THE LOADED STACK. On the shared stack a write function has been measured
 * at tens of seconds (its emulators.log: saveDraft p50 0.9 s, p90 22 s, max
 * 55 s; createDoc p90 27 s; setAccess p90 34 s, and 31–48 s with the machine
 * otherwise quiet), and Hosting answers 504 itself when a function has not
 * answered within its minute. None of that is the product answering, so:
 *   - every wait on something the STACK does is bounded past Hosting's
 *     cut-off, and every answer the case reads goes through lib's answered()
 *     (or a client made with cutoffError), so a stalled request ends in that
 *     504 and the case INCONCLUSIVE, while any other answer is judged;
 *   - a page's chain of requests (claim → POST /draft → accept, a reject) is
 *     waited on request by request (lib: the capture's waitInTurn): no
 *     deadline while the stack is working, INCONCLUSIVE on a cut-off or a
 *     request with no answer at all (Hosting's cut-off and 16 s), and a FAIL
 *     only when the page, with none of its requests in flight, changes
 *     nothing for 30 s;
 *   - setup calls (sessions, the document, grants, suggestions, tokens) go
 *     through lib's untilLanded, or the `patient` of publish and share,
 *     which look for the call's effect before sending it again;
 *   - every case but A8.9 (BODYATTR) declares inconclusiveOnCaseTimeout and
 *     inconclusiveOnFunctionKill: a wait that ran out (the case's own budget
 *     included) while one of its pages saw the stack stall (a cut-off 504,
 *     its Firestore client losing the emulator), or while the emulator's log
 *     shows functions stopped at their 60 s with Hosting answering 504, is
 *     INCONCLUSIVE. That last one is how a case whose budget runs out in
 *     setup, before it has a page, is judged (seen: A8.6 spent 400 s in
 *     setup on POST /publish and POST /access cut off). Assertions are never
 *     excused, and a wait on the page alone keeps a short bound.
 *
 * Fixed waits: none but the product's own clock. Every absence asserted ("no
 * claim was sent", "nothing was applied") is read after a positive signal that
 * the flow it belongs to has already ended (its toast, or a later request in
 * the same sequence). A8.7b waits out the claim's two minutes, by sending the
 * author's revise again every 5 s until the server takes it.
 *
 * Only e2e/lib/ talks to the stack.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { answered, currentTarget, precondition, scenario, untilLanded } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { bearerHttp, mintToken, openSession } from "../../lib/session.mjs";
import { publish } from "../../lib/seed.mjs";
import { share } from "../../lib/grant.mjs";
import { closeAdmin, readCollection, readDoc, writeUser } from "../../lib/admin.mjs";
import { quietDoc } from "../../lib/guard.mjs";
import { eventually } from "../../lib/assert.mjs";
import { holdRequests } from "../../lib/sync.mjs";
import { bodyHash } from "../../lib/frame.mjs";
import { bodyAttrDiff, diffFingerprint, entryHtml, fingerprint, rehashZip, summarize } from "../../lib/bytes.mjs";
import { zipFiles } from "../../lib/zipread.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

/**
 * The file's budget (lib/budget.mjs): its eleven cases run one after another,
 * and their own timeouts sum past the 60 minutes the scan caps a computed
 * budget at; a slow case late in the file must end itself, not cancel the
 * cases after it.
 */
export const E2E_FILE_TIMEOUT_MS = 110 * 60_000;

const BOTH = ["local", "prod"];
const tag = () => `${runTag(target.runId)}${rand4()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the loaded stack's bounds (see the header) ----------------------------------

/** A function request, this process's or a page's: past Hosting's own minute, so a stalled one ends in its cut-off 504, never in a client deadline first. */
const FN_MS = 150_000;
/** How long into a case a setup call the stack did not answer is still sent again (untilLanded's stopAt); past it, a non-answer ends the case INCONCLUSIVE. */
const ENV_BUDGET_MS = 300_000;
/** A sign-in, a document opening, the editor binding: each waits on function answers and the page's listeners, so past Hosting's cut-off. */
const OPEN_MS = 90_000;
/**
 * What a page shows once the stack has pushed it (a Firestore listener's
 * snapshot: the idle notice's count, the pass moving on after a decision, the
 * end-of-pass notice; the live session's patch to a co-editor). Longer than
 * the Firestore SDK's own 10 s before it reports "Could not reach Cloud
 * Firestore backend", so a lost listener leaves the evidence pageStall reads.
 */
const PAGE_MS = 60_000;
/** What a page does on its own, with no request in between (Next, Previous, Done, a stale verdict, a toast after an answer it already has). */
const CLIENT_MS = 30_000;
/** The autosave after a key: the debounce (AUTOSAVE_MS, 1 s, app/src/viewer/useInlineEditor.ts), then an answer that may take Hosting's whole minute. */
const AUTOSAVE_WAIT_MS = 90_000;

const stopAts = new WeakMap();
/** untilLanded's options for this case: `stopAt` is fixed by its first call. */
function patience(ctx) {
  if (!stopAts.has(ctx)) stopAts.set(ctx, Date.now() + ENV_BUDGET_MS);
  return { stopAt: stopAts.get(ctx) };
}

// --- the document -----------------------------------------------------------

/** Each paragraph's text exactly, so an anchor can be built here as the app builds one. */
const TEXT = Object.freeze({
  "rv-1": "The quick brown fox jumps over the lazy dog near the riverbank.",
  "rv-2": "A second paragraph mentions lanterns and harbour lights at dusk.",
  "rv-3": "This sentence is really quite important to the argument.",
  "rv-4": "Closing words for the record, kept short.",
});

/** One quote per paragraph, each unique in the document. */
const Q = Object.freeze({
  1: { id: "rv-1", exact: "lazy dog" },
  2: { id: "rv-2", exact: "harbour lights" },
  3: { id: "rv-3", exact: "really quite important" },
  4: { id: "rv-4", exact: "Closing words" },
});

function reviewHtml(title, text = TEXT) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.6}</style>
</head>
<body>
<h1 id="rv-title">Review fixture</h1>
${Object.entries(text).map(([id, t]) => `<p id="${id}">${t}</p>`).join("\n")}
</body>
</html>
`;
}

/**
 * An anchor as `describeAnchorFromRange` makes one: the nearest id element as
 * root, the quote, 32 characters of context either side and the text offsets.
 */
function anchorFor(n) {
  const { id, exact } = Q[n];
  const text = TEXT[id];
  const at = text.indexOf(exact);
  precondition(at >= 0 && text.indexOf(exact, at + 1) < 0, `"${exact}" is not unique in #${id}`);
  return {
    elementId: id,
    exact,
    prefix: text.slice(Math.max(0, at - 32), at),
    suffix: text.slice(at + exact.length, at + exact.length + 32),
    start: at,
    end: at + exact.length,
  };
}

/** What paragraph n reads once quote n is replaced. */
const replaced = (n, replacement) => TEXT[Q[n].id].replace(Q[n].exact, replacement);
const occurrences = (hay, needle) => String(hay).split(needle).length - 1;

// --- the app's and the server's words ------------------------------------------

/** app/src/components/ReviewBar.tsx, app/src/viewer/useSuggestionReview.ts, app/src/pages/DocViewer.tsx. */
const APP = Object.freeze({
  idleCannot: (n) => `${n === 1 ? "1 suggested edit is" : `${n} suggested edits are`} waiting. Only the owner or an approver can accept or reject ${n === 1 ? "it" : "them"}.`,
  idleCan: (n) => `${n === 1 ? "1 suggested edit is" : `${n} suggested edits are`} waiting. Accept or reject ${n === 1 ? "it" : "each one"} before you publish a new version.`,
  saveTitleCannot: (n) => `${n === 1 ? "1 suggested edit is" : `${n} suggested edits are`} waiting. Only the owner or an approver can accept or reject ${n === 1 ? "it" : "them"}.`,
  saveTitleCan: (n) => `${n === 1 ? "1 suggested edit is" : `${n} suggested edits are`} waiting. Accept or reject ${n === 1 ? "it" : "each one"} before you publish.`,
  stale: "The text has changed since this was suggested, so it can’t be applied.",
  unrecorded: "The change is in the draft, but accepting it wasn’t recorded. Accept it again to record it.",
  endPublish: "That was the last suggestion. Publish the result with Save as new version.",
  endResolve: "That was the last suggestion. Resolve the open comments, then publish the result with Save as new version.",
  endNothing: "No suggestions are left to review.",
});
/** functions/src/lib/review.ts, functions/src/lib/suggestions.ts, functions/src/index.ts. */
const SERVER = Object.freeze({
  pendingOne:
    "1 suggested edit is waiting for a decision. Only the owner or an approver can accept or reject it, and no new version can be published until then. If it is yours, you may withdraw it.",
  changed: "Its author has changed it since you opened it. Look at it again before you decide.",
  applying: (email) => `${email} is applying it right now`,
  tokenDecides:
    "Through this endpoint a suggestion is decided in the app. An agent decides one with accept_suggestion or reject_suggestion.",
});

// --- cast, documents, suggestions ----------------------------------------------

/**
 * Accounts that get no comment email (as a06): the opt-out is written before
 * any session. An address the shared stack already holds (EMAIL_EXISTS: its
 * four-character suffix, among thousands of accounts per role) is cast again
 * at a fresh one by cast() itself (its `retryTaken`). The opt-out is a set,
 * safe to make again when the Firestore emulator let it run past the Admin
 * SDK's own deadline, so it is written here, through untilLanded, not by
 * cast's `notifications: false`.
 */
async function castQuiet(ctx, roles) {
  const accounts = [];
  for (const role of roles) {
    const { out: a } = await untilLanded(ctx, `cast ${role}`, async () => (await cast(target, [role]))[0], null, patience(ctx));
    accounts.push(a);
  }
  if (target.kind === "local") {
    for (const a of accounts) {
      const record = { uid: a.uid, email: a.email.toLowerCase(), emailNotifications: false };
      await untilLanded(ctx, `the opt-out of ${a.role}`, () => writeUser(target, a.uid, record), null, patience(ctx));
    }
  }
  return accounts;
}

/** A session (POST /session, safe to send again) whose client waits FN_MS and throws E2E_STACK_CUTOFF on Hosting's cut-off. */
async function sessionFor(ctx, acct) {
  const { out } = await untilLanded(ctx, `POST /session (${acct.role})`, () => openSession(target, acct, { timeoutMs: FN_MS, cutoffError: true }), null, patience(ctx));
  return out;
}

/** How many times a grant the stack left half-made (record, no mirror) is sent; see grant(). */
const GRANT_SENDS = 3;

// LIB-REQUEST: share-patient-mirror — share's `patient` takes the record
// alone as the grant's effect and returns `landed` with `mirror.ok` false
// when the RTDB mirror never follows (a finding, the caller to decide). On
// the loaded shared stack that is a function the emulator killed at its
// 60 s after the record's batch and before the mirror (run te3o, A8.3: both
// grants 504, record found, no mirror in 60 s; the approver's page then
// failed its presence write, PERMISSION_DENIED). A grant without its mirror
// is not made, so it is sent again here.
/**
 * Give `account` `role` on the document: POST /access, patient (lib
 * grant.mjs share's `patient`). A grant Hosting cut off is sent again only
 * after its effect was looked for in the record (the role's grant list, the
 * record's `updatedAt` moved), and a grant found there has its RTDB mirror
 * read until it is there too. Found WITHOUT its mirror, the function was
 * stopped between the two writes (functions/src/lib/folders.ts
 * persistDocMembership: the batch, then syncPresenceAccess), so the grant is
 * sent again: the same principal at the same role recomputes the members,
 * writes every member's mirror, and invites nobody (functions/src/index.ts
 * setAccess invites only members new to the record). Still half-made after
 * GRANT_SENDS sends, or past the setup budget, the stack did not make it:
 * the case is INCONCLUSIVE. An answer (a 200) is judged as before.
 */
async function grant(ctx, owner, docId, account, role) {
  for (let send = 1; ; send += 1) {
    const r = await share(target, { owner, doc: docId, account, role, timeoutMs: FN_MS, patient: { ctx, ...patience(ctx) } });
    precondition(r.landed || r.status === 200, `share ${role}: ${r.status} ${JSON.stringify(r.json)}`);
    if (!r.landed || r.mirror?.ok !== false) return;
    const why = `POST /access ${role} ${account.email} took effect in the record though Hosting cut it off, and its RTDB mirror never followed (${JSON.stringify(r.mirror)}): the function was stopped between the two writes`;
    if (send >= GRANT_SENDS || Date.now() >= patience(ctx).stopAt) ctx.inconclusive(`the stack did not make the grant, so nothing was measured: ${why}, ${send} time(s)`);
    ctx.step(`environment: ${why}; sending it again (send ${send + 1} of ${GRANT_SENDS})`);
  }
}

/**
 * An owner, the people named by `roles` ([{as, role}]), each with a session,
 * and one published review document shared at those roles. Ends with
 * quietDoc: from here on, a comment on it emails nobody.
 */
async function stage(ctx, { name, roles }) {
  const accounts = await castQuiet(ctx, ["owner", ...roles.map((r) => r.as)]);
  const sessions = [];
  for (const a of accounts) sessions.push(await sessionFor(ctx, a));
  const owner = sessions[0];
  const title = `E2E review ${name}`;
  const up = await publish(owner.http, { body: reviewHtml(title), filename: "index.html", title, name: `review-${name}`, ownerEmail: accounts[0].email, timeoutMs: FN_MS, patient: { ctx, ...patience(ctx) } });
  precondition(up.versionId === "v1", `publish answered ${up.status} ${JSON.stringify(up.json)}`);
  for (const [i, r] of roles.entries()) await grant(ctx, owner, up.docId, accounts[i + 1], r.role);
  await quietDoc(target, up.docId);
  const by = { owner };
  roles.forEach((r, i) => (by[r.as] = sessions[i + 1]));
  ctx.step(`document ${up.docId}: owner ${accounts[0].email}${roles.map((r, i) => `, ${r.role} ${accounts[i + 1].email}`).join("")}`);
  return { docId: up.docId, title, by };
}

async function postSuggestion(http, body) {
  const r = await http.postJson("/suggestion", body);
  return { status: r.status, json: r.json, cacheControl: r.headers.get("cache-control") };
}

/**
 * A pending suggestion on quote n, made by `session` over POST /suggestion.
 * Its effect is the annotation carrying this replacement, which every caller
 * makes unique with tag().
 */
async function suggest(ctx, session, docId, n, replacement) {
  const body = { op: "create", docId, versionId: "v1", anchor: anchorFor(n), replacement };
  const r = await untilLanded(ctx, `POST /suggestion create (${session.account.role})`, () => postSuggestion(session.http, body), async () => {
    const rows = await readCollection(target, `docs/${docId}/versions/v1/annotations`);
    const hit = rows.find((row) => row.data?.suggestion?.replacement === replacement);
    return hit ? { annId: hit.id } : null;
  }, patience(ctx));
  if (r.landed) return r.landed.annId;
  precondition(r.out.status === 200 && r.out.json?.annId, `create answered ${r.out.status} ${JSON.stringify(r.out.json)}`);
  return r.out.json.annId;
}

/** A personal token, minted (and ledgered) by `session`; sent again only when the stack did not answer, which at worst mints a second. */
async function tokenFor(ctx, session, name, channel) {
  const { out } = await untilLanded(ctx, `POST /tokens (${channel})`, () => mintToken(session, { name, channel }), null, patience(ctx));
  return out.token;
}

const annotationOf = (docId, annId) => readDoc(target, `docs/${docId}/versions/v1/annotations/${annId}`);
async function commentsOf(docId, annId) {
  const rows = await readCollection(target, `docs/${docId}/versions/v1/annotations/${annId}/comments`);
  return rows.map((r) => r.data).sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));
}
const who = (a) => (a ? { uid: a.uid, email: a.email, channel: a.channel } : a);

/** The draft's entry as the owner reads it over GET /draft (SPEC §2). */
async function draftHtml(owner, docId) {
  const r = await owner.http.get(`/draft/${encodeURIComponent(docId)}/index.html`);
  precondition(r.status === 200, `GET /draft answered ${r.status}`);
  return r.text;
}

// --- browser ------------------------------------------------------------------

/**
 * A browser user signed in through /signup. Hosting's cut-off on the page's
 * own POST /session is thrown with that answer (lib: the stack did not
 * answer), and signing in is safe to repeat, so untilLanded tries again.
 */
async function browserFor(ctx, session, name) {
  const u = await ctx.users.user({ name });
  const { out: s } = await untilLanded(ctx, `${name}'s sign-in`, () => u.signInUi(session.account.email, session.account.password, { timeout: OPEN_MS }), null, patience(ctx));
  precondition(s.status === "ok", `${name} signed in`);
  return u;
}

/** Open the document and the editor, and wait for the live session to have bound ("Shared"). */
async function openEditor(u, docId) {
  await u.open(docId, { timeout: OPEN_MS });
  const { share: state } = await u.enterEdit({ waitShared: true, timeout: OPEN_MS });
  precondition(state === "shared", `${u.name} joined the live session (${state})`);
}

const bar = (u) => u.page.locator(".review-bar");
const barButton = (u, label) => bar(u).getByRole("button", { name: label, exact: true });
const saveButton = (u) => u.page.getByRole("button", { name: "Save as new version", exact: true });

/** What the review bar shows, read in one go. */
function barState(u) {
  return u.page.evaluate(() => {
    const b = document.querySelector(".review-bar");
    if (!b) return null;
    const squash = (s) => (s ?? "").replace(/\s+/g, " ").trim();
    return {
      reviewing: b.classList.contains("is-reviewing"),
      notice: b.classList.contains("is-reviewing") ? null : squash(b.querySelector(":scope > span")?.textContent),
      count: squash(b.querySelector(".review-count")?.textContent) || null,
      by: squash(b.querySelector(".review-by")?.textContent) || null,
      del: b.querySelector(".review-change del")?.textContent ?? null,
      ins: b.querySelector(".review-change ins")?.textContent ?? null,
      stale: squash(b.querySelector(".review-stale")?.textContent) || null,
      buttons: Array.from(b.querySelectorAll("button")).map((x) => ({ label: squash(x.textContent), disabled: x.disabled })),
    };
  });
}

/**
 * Wait until the bar shows the pass on quote `exact`, as "<i> of <n>". The
 * default bound is the page's own (Next, Previous); after a decision, the pass
 * moves on when the annotations listener drops the decided one, so those
 * callers pass PAGE_MS.
 */
async function passOn(u, { count, exact, timeout = CLIENT_MS }) {
  return eventually(async () => {
    const s = await barState(u);
    if (!s?.reviewing || s.count !== count || s.del !== exact) throw new Error(`bar: ${JSON.stringify(s)}`);
    return s;
  }, { timeout, interval: 100, message: `${u.name}: the pass shows ${count}, "${exact}"` });
}

/** The idle notice `text`: its count comes from the annotations listener, so PAGE_MS. */
async function idleNotice(u, text, what) {
  return eventually(async () => {
    const s = await barState(u);
    if (!s || s.notice !== text) throw new Error(`bar: ${JSON.stringify(s)}`);
    return s;
  }, { timeout: PAGE_MS, message: what });
}

/**
 * Every POST to /suggestion, /draft and /commit this user's page sends from
 * now on, in the order it sent them (User.capture): the body's `op`, the body
 * itself as `postJson`, when it was sent and when it finished or failed (both
 * on this process's monotonic clock), its status and its JSON once settled.
 */
const capturePosts = (u) => u.capture({ paths: ["/suggestion", "/draft", "/commit"] });
const label = (r) => (r.op ? `${r.path}:${r.op}` : r.path);
/** A field of the request's JSON body: annId, replacement, a /draft's html. */
const sent = (r, key) => r?.postJson?.[key];
const isOp = (r, op, annId = null) => r.path === "/suggestion" && r.op === op && (annId == null || sent(r, "annId") === annId);
const opRows = (rows, op, annId = null) => rows.filter((r) => isOp(r, op, annId));
/** Rows as evidence: a /draft body is the whole document, so its html is kept as a length. */
const forEvidence = (rows) =>
  rows.map(({ postJson, ...r }) => ({ ...r, postJson: typeof postJson?.html === "string" ? { ...postJson, html: `${postJson.html.length} chars` } : postJson }));

/** Every answer the page has had since `since`, through lib's answered(): Hosting's cut-off 504 to any of them throws E2E_STACK_CUTOFF. */
function judgeAnswers(u, rows, since = 0) {
  for (const r of rows) if (r.seq >= since && r.status != null) answered(r, `${u.name}'s page's ${label(r)}`);
}

/** The frame's `bshd-review` highlight, read from the parent (the frame runs no script of its own). */
function reviewMark(u) {
  return u.page.evaluate(() => {
    const d = document.querySelector("iframe.doc-frame")?.contentDocument;
    const hl = d?.defaultView?.CSS?.highlights;
    const h = hl?.get("bshd-review");
    return {
      supported: Boolean(hl),
      size: hl?.size ?? null,
      ranges: h ? Array.from(h).map((r) => r.toString()) : [],
      sameDoc: d === window.__e2eWatchedDoc,
    };
  });
}

/**
 * Count every mutation of the frame's document from now on: nodes, attributes
 * and text, anywhere under <html>. Made with the FRAME's MutationObserver,
 * from the parent, as the app's own observers are (a cross-realm observer
 * observes nothing).
 */
function watchMutations(u) {
  return u.page.evaluate(() => {
    const d = document.querySelector("iframe.doc-frame").contentDocument;
    const log = { count: 0, sample: [] };
    const take = (recs) => {
      for (const r of recs) {
        log.count += 1;
        if (log.sample.length < 20) log.sample.push({ type: r.type, target: r.target.nodeName, id: r.target.id || r.target.parentElement?.id || null, attr: r.attributeName });
      }
    };
    const mo = new d.defaultView.MutationObserver(take);
    mo.observe(d.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__e2eMutations = log;
    window.__e2eMutationObserver = mo;
    window.__e2eWatchedDoc = d;
    window.__e2eTake = take;
    return true;
  });
}
function mutationsSoFar(u) {
  return u.page.evaluate(() => {
    window.__e2eTake(window.__e2eMutationObserver.takeRecords());
    const d = document.querySelector("iframe.doc-frame")?.contentDocument;
    return { ...window.__e2eMutations, sameDoc: d === window.__e2eWatchedDoc };
  });
}

/** A paragraph's text in the user's current frame. */
async function paragraphText(u, id) {
  return (await u.frame()).evaluate((i) => document.getElementById(i)?.textContent ?? null, id);
}

function noPageErrors(users) {
  for (const u of users) assert.deepEqual(u.log.errors.map((e) => e.message), [], `${u.name}: uncaught page errors`);
}

/** The accepted (or rejected) record: state, resolved, no claim left, decided by `by` in the app. */
async function assertDecided(docId, annId, { state, by, replacement }) {
  const ann = await annotationOf(docId, annId);
  assert.deepEqual(
    { state: ann?.suggestion?.state, resolved: ann?.resolved, claim: ann?.suggestion?.claim ?? null, decidedBy: who(ann?.suggestion?.decidedBy) },
    { state, resolved: true, claim: null, decidedBy: { uid: by.uid, email: by.account.email.toLowerCase(), channel: "web" } },
    `the suggestion is ${state} by the approver, in the app`,
  );
  if (replacement !== undefined) assert.equal(ann.suggestion.replacement, replacement, "the replacement recorded is the one applied");
  return ann;
}

/** Reject… on the suggestion the pass shows, with `reason` (none: an empty box), sent with Enter; resolves the reject's settled row. */
async function rejectInPass(u, posts, annId, reason = "") {
  const mark = posts.mark();
  await barButton(u, "Reject…").click({ timeout: CLIENT_MS });
  const field = bar(u).getByRole("textbox", { name: "Why reject it? (optional)" });
  if (reason) await field.fill(reason);
  await field.press("Enter");
  return posts.waitInTurn((r) => isOp(r, "reject", annId), { since: mark, what: `Reject on ${annId}` });
}

// --- A8.1 ---------------------------------------------------------------------

scenario("A8.1 an editor who may not decide sees the idle notice naming who can, Save as new version is greyed out with that reason, and POST /commit over their draft is 409 with pendingSuggestions 1", { tiers: BOTH, timeoutMs: 540_000, inconclusiveOnCaseTimeout: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  const { docId, by } = await stage(ctx, { name: "a81", roles: [{ as: "suggester", role: "suggester" }, { as: "editor", role: "editor" }] });
  await suggest(ctx, by.suggester, docId, 1, `sleepy cat ${tag()}`);

  ctx.step("the editor opens the editor; the review bar is the idle notice, with no way into the pass");
  const e = await browserFor(ctx, by.editor, "editor");
  await openEditor(e, docId);
  const idle = await idleNotice(e, APP.idleCannot(1), "the editor's idle notice");
  assert.deepEqual({ reviewing: idle.reviewing, buttons: idle.buttons }, { reviewing: false, buttons: [] }, "nothing in the bar lets an editor decide");

  ctx.step("Save as new version is disabled, and its title says why and who can clear it");
  assert.equal(await saveButton(e).isDisabled(), true, "Save as new version is greyed out");
  assert.equal(await saveButton(e).getAttribute("title"), APP.saveTitleCannot(1), "the reason on Save as new version");

  ctx.step("the editor types, so there is a draft to publish; the autosave after the last key is answered and recorded");
  const token = ` edited ${tag()}`;
  // The autosave that follows the LAST key (User.typeAndAutosave), however
  // long the stack takes to answer it: Hosting's cut-off ends the case
  // INCONCLUSIVE (answered()); any other answer is the product's.
  const save = await e.typeAndAutosave(`#${Q[4].id}`, token, { delay: 15, timeout: AUTOSAVE_WAIT_MS, expectStatus: null });
  answered(save.entry, "the editor's autosave, POST /draft");
  assert.equal(save.status, 200, `the editor's autosave was answered ${save.status} ${JSON.stringify(save.body)}`);
  assert.equal(save.saveState, "saved", "the toolbar says the draft is saved");
  const recorded = await readDoc(target, `docs/${docId}`);
  assert.equal(recorded?.draft?.baseVersion, "v1", `the draft is recorded on v1: ${JSON.stringify(recorded?.draft ?? null)}`);
  precondition((await draftHtml(by.owner, docId)).includes(token.trim()), "the saved draft holds the editor's words");

  ctx.step("POST /commit over that draft is refused for the pending suggestion");
  const r = await by.editor.http.postJson("/commit", { docId, baseVersion: "v1" });
  ctx.ev.json("commit-409", { status: r.status, json: r.json });
  assert.equal(r.status, 409, `POST /commit: ${r.status} ${JSON.stringify(r.json)}`);
  assert.deepEqual(r.json, { error: SERVER.pendingOne, unresolvedCount: 1, pendingSuggestions: 1 }, "the refusal names the pending suggestion");
  const doc = await readDoc(target, `docs/${docId}`);
  assert.equal(doc.currentVersion, "v1", "no version was minted");
  assert.equal((await readCollection(target, `docs/${docId}/versions`)).length, 1, "v1 is the only version");
  noPageErrors([e]);
});

// --- A8.2 ---------------------------------------------------------------------

scenario("A8.2 the pass marks the quote with the CSS highlight API and zero mutations of the frame's document; Accept sends claim, then POST /draft, then accept, each after the last answered; the change lands once", { tiers: BOTH, timeoutMs: 540_000, inconclusiveOnCaseTimeout: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  const { docId, by } = await stage(ctx, { name: "a82", roles: [{ as: "suggester", role: "suggester" }, { as: "approver", role: "approver" }] });
  const R = `sleepy cat ${tag()}`;
  const annId = await suggest(ctx, by.suggester, docId, 1, R);

  ctx.step("the approver opens the editor; idle, the bar offers Review it, and Save as new version says what to do");
  const a = await browserFor(ctx, by.approver, "approver");
  const posts = capturePosts(a);
  await openEditor(a, docId);
  const idle = await idleNotice(a, APP.idleCan(1), "the approver's idle notice");
  assert.deepEqual(idle.buttons, [{ label: "Review it", disabled: false }], "the idle bar's only control is Review it");
  assert.equal(await saveButton(a).getAttribute("title"), APP.saveTitleCan(1), "the reason on Save as new version");

  ctx.step("watch the frame's document for any mutation, then press Review it");
  const before = await bodyHash(await a.frame());
  await watchMutations(a);
  await barButton(a, "Review it").click({ timeout: CLIENT_MS });
  const pass = await passOn(a, { count: "1 of 1", exact: Q[1].exact });
  assert.deepEqual({ by: pass.by, ins: pass.ins, stale: pass.stale }, { by: `${by.suggester.account.email}:`, ins: R, stale: null }, "the bar shows the change and who suggested it");

  ctx.step("the target is marked by a bshd-review highlight over exactly the quote, and nothing in the document changed");
  const mark = await eventually(async () => {
    const m = await reviewMark(a);
    if (m.ranges.length !== 1) throw new Error(`mark: ${JSON.stringify(m)}`);
    return m;
  }, { timeout: CLIENT_MS, message: "the review highlight is set" });
  assert.deepEqual({ supported: mark.supported, ranges: mark.ranges, sameDoc: mark.sameDoc }, { supported: true, ranges: [Q[1].exact], sameDoc: true }, "one highlight range, over the quote, in the watched document");
  assert.ok(mark.size >= 1, `CSS.highlights.size is ${mark.size}`);
  const quiet = await mutationsSoFar(a);
  ctx.ev.json("mutations-while-marked", quiet);
  assert.equal(quiet.sameDoc, true, "the observer watches the frame's current document");
  assert.equal(quiet.count, 0, `marking the target made 0 DOM mutations (saw ${quiet.count}: ${JSON.stringify(quiet.sample)})`);
  assert.equal((await bodyHash(await a.frame())).hash, before.hash, "body.innerHTML is byte-identical while marked");
  precondition(opRows(posts, "claim").length === 0 && posts.every((p) => p.path !== "/draft"), "nothing was claimed or saved before Accept");

  ctx.step("Accept: the browser sends claim, then POST /draft, then accept, each only after the previous one has answered");
  const clicked = posts.mark();
  await barButton(a, "Accept").click({ timeout: CLIENT_MS });
  await posts.waitInTurn((r) => isOp(r, "accept"), { since: clicked, what: "Accept" });
  const seq = posts.filter((p) => p.seq >= clicked);
  const accIdx = seq.findIndex((p) => isOp(p, "accept"));
  const upTo = seq.slice(0, accIdx + 1);
  ctx.ev.json("requests", forEvidence(seq));
  const order = upTo.map(label).join(" → ");
  assert.match(order, /^\/suggestion:claim( → \/draft)+ → \/suggestion:accept$/, `requests go claim → /draft → accept (got ${order})`);
  // SPEC §22: "claim → apply → save the draft → record", and the browser
  // "waits for the draft to save, and only then records the decision". The
  // edit also arms the editor's own autosave (AUTOSAVE_MS after the input),
  // a second POST /draft of the same bytes that is no step of the accept: on
  // a stack slower than that debounce it is sent while the accept's save is
  // still in flight, and may still be in flight as the accept goes out. So
  // the order is judged step by step: everything after the claim was sent
  // after the claim had answered, and the accept after a save holding the
  // replacement had answered 200.
  const claim = upTo[0];
  const acc = upTo[upTo.length - 1];
  for (const p of upTo.slice(1)) {
    assert.ok(claim.doneAt != null && claim.doneAt <= p.sentAt, `${label(p)} was sent after /suggestion:claim had answered`);
  }
  const savedFirst = upTo.filter((p) => p.path === "/draft" && p.status === 200 && p.doneAt != null && p.doneAt <= acc.sentAt && occurrences(sent(p, "html") ?? "", R) === 1);
  assert.ok(savedFirst.length >= 1, `/suggestion:accept was sent after /draft had answered, holding the replacement once (drafts: ${JSON.stringify(upTo.filter((p) => p.path === "/draft").map((p) => ({ status: p.status, answeredBeforeAccept: p.doneAt != null && p.doneAt <= acc.sentAt, holds: occurrences(sent(p, "html") ?? "", R) })))})`);
  const answeredBeforeAccept = upTo.filter((p) => p.doneAt != null && p.doneAt <= acc.sentAt);
  assert.deepEqual(answeredBeforeAccept.map((p) => p.status), answeredBeforeAccept.map(() => 200), `every step answered 200: ${JSON.stringify(upTo.map((p) => [label(p), p.status, p.json]))}`);
  assert.equal(acc.status, 200, `the accept answered ${acc.status} ${JSON.stringify(acc.json)}`);
  assert.deepEqual({ annId: sent(claim, "annId"), replacement: sent(claim, "replacement") }, { annId, replacement: R }, "the claim names this suggestion and the replacement being applied");
  assert.deepEqual({ annId: sent(acc, "annId"), replacement: sent(acc, "replacement") }, { annId, replacement: R }, "the accept names the same replacement");

  ctx.step("the pass ends with the true notice; the change is in the frame and the draft once; the approver's decision is recorded");
  await a.waitForToast((t) => t.text === APP.endPublish, { timeout: PAGE_MS });
  await assertDecided(docId, annId, { state: "accepted", by: by.approver, replacement: R });
  const notes = (await commentsOf(docId, annId)).filter((c) => !c.opensSuggestion);
  assert.deepEqual(notes.map((c) => ({ body: c.body, authorEmail: c.authorEmail, generated: c.generated, channel: c.actor?.channel })), [{ body: "Accepted.", authorEmail: by.approver.account.email.toLowerCase(), generated: true, channel: "web" }], "one note, Accepted., by the approver");
  assert.equal(await paragraphText(a, Q[1].id), replaced(1, R), "the approver's frame reads the replacement in place");
  const draft = await draftHtml(by.owner, docId);
  assert.deepEqual({ r: occurrences(draft, R), quote: occurrences(draft, Q[1].exact) }, { r: 1, quote: 0 }, "the stored draft holds the replacement once and the quote no more");
  await eventually(async () => (await reviewMark(a)).ranges.length === 0, { timeout: CLIENT_MS, message: "the highlight is gone once the pass ends" });
  const afterAccept = await mutationsSoFar(a);
  assert.ok(afterAccept.sameDoc && afterAccept.count > 0, `the observer is live: the accepted edit itself was seen (${afterAccept.count} mutations)`);
  noPageErrors([a]);
});

// --- A8.3 ---------------------------------------------------------------------

scenario("A8.3 Reject with a reason leaves the note Rejected: <reason>, without one Rejected., each stamped with the approver and seen by the suggester; rejecting claims nothing and saves no draft", { tiers: BOTH, timeoutMs: 600_000, inconclusiveOnCaseTimeout: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  const { docId, by } = await stage(ctx, { name: "a83", roles: [{ as: "suggester", role: "suggester" }, { as: "approver", role: "approver" }] });
  const first = await suggest(ctx, by.suggester, docId, 1, `sleepy cat ${tag()}`);
  const second = await suggest(ctx, by.suggester, docId, 3, `rather important ${tag()}`);
  const reason = `Not the register we use ${tag()}`;

  ctx.step("the approver opens the panel and presses Review on the first suggestion's thread: the editor opens on it");
  const a = await browserFor(ctx, by.approver, "approver");
  const posts = capturePosts(a);
  await a.open(docId, { timeout: OPEN_MS });
  await a.openComments({ timeout: PAGE_MS });
  await a.thread(Q[1].exact, { kind: "suggestion" }).getByRole("button", { name: "Review", exact: true }).click({ timeout: PAGE_MS });
  await a.page.getByRole("toolbar", { name: "Formatting" }).waitFor({ state: "visible", timeout: OPEN_MS });
  await passOn(a, { count: "1 of 2", exact: Q[1].exact, timeout: OPEN_MS });

  ctx.step(`Reject… with the reason "${reason}", sent with Enter`);
  await rejectInPass(a, posts, first, reason);
  await assertDecided(docId, first, { state: "rejected", by: by.approver });

  ctx.step("the pass moves on to the second; Reject… with no reason");
  await passOn(a, { count: "1 of 1", exact: Q[3].exact, timeout: PAGE_MS });
  const since = a.toastMark();
  await rejectInPass(a, posts, second);
  await a.waitForToast((t) => t.text === APP.endNothing, { since, timeout: PAGE_MS });
  await assertDecided(docId, second, { state: "rejected", by: by.approver });

  ctx.step("each thread's note is the server's, in the approver's name, from the app");
  const me = by.approver.account.email.toLowerCase();
  for (const [annId, body] of [[first, `Rejected: ${reason}`], [second, "Rejected."]]) {
    const notes = (await commentsOf(docId, annId)).filter((c) => !c.opensSuggestion);
    assert.deepEqual(notes.map((c) => ({ body: c.body, authorEmail: c.authorEmail, generated: c.generated, channel: c.actor?.channel })), [{ body, authorEmail: me, generated: true, channel: "web" }], `the note on ${annId}`);
  }
  const rejects = opRows(posts, "reject");
  assert.deepEqual(rejects.map((p) => ({ annId: sent(p, "annId"), status: p.status })), [{ annId: first, status: 200 }, { annId: second, status: 200 }], "two rejects were sent, one per suggestion");
  assert.deepEqual(posts.filter((p) => p.path === "/draft" || (p.path === "/suggestion" && p.op !== "reject")).map(label), [], "rejecting claimed nothing and saved no draft");
  assert.equal((await readDoc(target, `docs/${docId}`))?.draft ?? null, null, "the document has no draft");

  ctx.step("the suggester, reading the document, sees both notes under Show resolved");
  const s = await browserFor(ctx, by.suggester, "suggester");
  await s.open(docId, { timeout: OPEN_MS });
  await s.openComments({ timeout: PAGE_MS });
  const toggle = s.page.locator(".comments-panel button", { hasText: "Show resolved" });
  await toggle.click({ timeout: PAGE_MS });
  for (const [exact, body] of [[Q[1].exact, `Rejected: ${reason}`], [Q[3].exact, "Rejected."]]) {
    const t = s.thread(exact, { kind: "suggestion" }).first();
    await t.locator(".comment-body", { hasText: body }).first().waitFor({ state: "visible", timeout: PAGE_MS });
    assert.equal((await t.locator(".suggestion-status").textContent()).trim(), `Rejected by ${me}`, `the status of "${exact}"`);
  }
  noPageErrors([a, s]);
});

// --- A8.4 ---------------------------------------------------------------------

scenario("A8.4 a suggestion the draft has already rewritten is stale in the pass, Accept greyed out and nothing claimed; one turning stale under the click is refused before any claim; a stale suggestion is still rejectable", { tiers: BOTH, timeoutMs: 540_000, inconclusiveOnCaseTimeout: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  const { docId, title, by } = await stage(ctx, { name: "a84", roles: [{ as: "suggester", role: "suggester" }, { as: "approver", role: "approver" }] });
  const s1 = await suggest(ctx, by.suggester, docId, 1, `sleepy cat ${tag()}`);
  const s2 = await suggest(ctx, by.suggester, docId, 2, `harbour lamps ${tag()}`);

  ctx.step("the owner saves a draft that rewrites the first suggestion's quote (lazy dog → lazy hound)");
  const rewritten = { ...TEXT, [Q[1].id]: TEXT[Q[1].id].replace("lazy dog", "lazy hound") };
  const saved = await by.owner.http.postJson("/draft", { docId, baseVersion: "v1", html: reviewHtml(title, rewritten) });
  precondition(saved.status === 200, `POST /draft answered ${saved.status} ${JSON.stringify(saved.json)}`);

  ctx.step("the approver opens the editor on the draft and starts the pass: the first suggestion is stale there");
  const a = await browserFor(ctx, by.approver, "approver");
  const posts = capturePosts(a);
  await openEditor(a, docId);
  precondition((await paragraphText(a, Q[1].id)) === rewritten[Q[1].id], "the editor holds the draft's rewritten paragraph");
  await idleNotice(a, APP.idleCan(2), "the idle notice counts two");
  await barButton(a, "Review them").click({ timeout: CLIENT_MS });
  const stale = await eventually(async () => {
    const st = await passOn(a, { count: "1 of 2", exact: Q[1].exact });
    if (st.stale !== APP.stale) throw new Error(`bar: ${JSON.stringify(st)}`);
    return st;
  }, { timeout: CLIENT_MS, message: "the bar calls the first suggestion stale" });
  const buttons = Object.fromEntries(stale.buttons.map((b) => [b.label, b.disabled]));
  assert.deepEqual({ accept: buttons.Accept, reject: buttons["Reject…"] }, { accept: true, reject: false }, "Accept is greyed out and Reject… is not");
  await barButton(a, "Accept").click({ force: true, timeout: 5_000 });

  ctx.step("Next: the second is still pending; its quote changes in the frame and Accept is pressed in the same task, before the bar can re-judge");
  await barButton(a, "Next").click({ timeout: CLIENT_MS });
  await eventually(async () => {
    const st = await passOn(a, { count: "2 of 2", exact: Q[2].exact });
    const accept = st.buttons.find((b) => b.label === "Accept");
    if (st.stale || accept?.disabled !== false) throw new Error(`bar: ${JSON.stringify(st)}`);
    return st;
  }, { timeout: CLIENT_MS, message: "the second suggestion can be accepted" });
  const since = a.toastMark();
  // As a co-editor's remote patch lands (the shared document writes the DOM
  // directly), just before the approver's click: the click handler runs
  // before React re-renders the bar, so only Accept's own check stands
  // between a stale suggestion and a claim.
  const clicked = await a.page.evaluate(({ id, from, to }) => {
    const d = document.querySelector("iframe.doc-frame").contentDocument;
    const walker = d.createTreeWalker(d.getElementById(id), 4);
    let changed = false;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.data.includes(from)) {
        n.data = n.data.replace(from, to);
        changed = true;
        break;
      }
    }
    const accept = Array.from(document.querySelectorAll(".review-bar.is-reviewing button")).find((b) => b.textContent.trim() === "Accept");
    if (!changed || !accept || accept.disabled) return { changed, accept: Boolean(accept), disabled: accept?.disabled ?? null };
    accept.click();
    return { changed, clicked: true };
  }, { id: Q[2].id, from: "harbour lights", to: "harbour beacons" });
  precondition(clicked.clicked === true, `the quote changed and Accept was pressed: ${JSON.stringify(clicked)}`);
  // Said at once by the page itself; FN_MS only so that an app which claims
  // first (and then lets go) still reaches its toast on a slow stack, and the
  // oracle below, not this wait, is what it fails.
  await a.waitForToast((t) => t.kind === "error" && t.text === APP.stale, { since, timeout: FN_MS });
  await eventually(async () => (await barState(a))?.stale === APP.stale, { timeout: CLIENT_MS, message: "the bar re-judges the second as stale" });
  ctx.ev.json("requests", forEvidence(posts));
  assert.deepEqual(opRows(posts, "claim").map((p) => sent(p, "annId")), [], "no claim was sent for a stale suggestion");
  assert.deepEqual(posts.filter((p) => p.path === "/draft").length, 0, "nothing was saved for it either");

  ctx.step("a stale suggestion is still rejectable: Previous, Reject…, Enter");
  await barButton(a, "Previous").click({ timeout: CLIENT_MS });
  await passOn(a, { count: "1 of 2", exact: Q[1].exact });
  await rejectInPass(a, posts, s1);
  await assertDecided(docId, s1, { state: "rejected", by: by.approver });
  assert.deepEqual(opRows(posts, "reject").map((p) => [sent(p, "annId"), p.status]), [[s1, 200]], "the capture saw the reject it was sent");
  assert.deepEqual(opRows(posts, "claim").length, 0, "and still no claim");
  assert.equal((await annotationOf(docId, s2))?.suggestion?.state, "pending", "the second is still pending, unclaimed");
  assert.equal((await annotationOf(docId, s2))?.suggestion?.claim ?? null, null, "the second carries no claim");
  noPageErrors([a]);
});

// --- A8.5 ---------------------------------------------------------------------

scenario("A8.5 Previous and Next walk the pass and wrap, Done leaves it, a decision moves on to the following suggestion, and the notice at the end of the pass is the true one", { tiers: BOTH, timeoutMs: 720_000, inconclusiveOnCaseTimeout: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  const { docId, by } = await stage(ctx, { name: "a85", roles: [{ as: "suggester", role: "suggester" }, { as: "approver", role: "approver" }] });
  const R1 = `sleepy cat ${tag()}`;
  const ids = {
    1: await suggest(ctx, by.suggester, docId, 1, R1),
    2: await suggest(ctx, by.suggester, docId, 2, `harbour lamps ${tag()}`),
    3: await suggest(ctx, by.suggester, docId, 3, `rather important ${tag()}`),
  };
  ctx.step("the owner's agent opens an ordinary comment thread, which stays open");
  const mcp = ctx.mcp({ token: await tokenFor(ctx, by.owner, `e2e a85 ${tag()}`, "mcp"), actor: "owner-mcp", timeoutMs: FN_MS });
  await untilLanded(ctx, "MCP initialize", () => mcp.initialize(), null, patience(ctx));
  const point = `An open point ${tag()}`;
  // Its effect: an unresolved comment thread (not a suggestion) on the quote.
  await untilLanded(ctx, "MCP add_comment", () => mcp.ok("add_comment", { id: docId, exact: Q[4].exact, body: point }), async () => {
    const rows = await readCollection(target, `docs/${docId}/versions/v1/annotations`);
    return rows.some((r) => !r.data?.suggestion && !r.data?.resolved && r.data?.anchor?.exact === Q[4].exact) || null;
  }, patience(ctx));

  const a = await browserFor(ctx, by.approver, "approver");
  const posts = capturePosts(a);
  await openEditor(a, docId);
  await idleNotice(a, APP.idleCan(3), "the idle notice counts three");

  ctx.step("Review them: 1 of 3; Next, Next, Next wraps; Previous, Previous");
  await barButton(a, "Review them").click({ timeout: CLIENT_MS });
  await passOn(a, { count: "1 of 3", exact: Q[1].exact });
  for (const [press, count, n] of [["Next", "2 of 3", 2], ["Next", "3 of 3", 3], ["Next", "1 of 3", 1], ["Previous", "3 of 3", 3], ["Previous", "2 of 3", 2]]) {
    await barButton(a, press).click({ timeout: CLIENT_MS });
    await passOn(a, { count, exact: Q[n].exact });
    await eventually(async () => {
      const m = await reviewMark(a);
      if (m.ranges.length !== 1 || m.ranges[0] !== Q[n].exact) throw new Error(`mark: ${JSON.stringify(m)}`);
      return true;
    }, { timeout: CLIENT_MS, message: `the highlight follows to "${Q[n].exact}"` });
  }

  ctx.step("Done leaves the pass: the bar is idle again and the highlight is gone; the editor stays open");
  await barButton(a, "Done").click({ timeout: CLIENT_MS });
  await eventually(async () => (await barState(a))?.notice === APP.idleCan(3), { timeout: CLIENT_MS, message: "the bar is idle after Done" });
  await eventually(async () => (await reviewMark(a)).ranges.length === 0, { timeout: CLIENT_MS, message: "no highlight after Done" });
  assert.equal(await a.page.getByRole("toolbar", { name: "Formatting" }).isVisible(), true, "the editor is still open");

  ctx.step("Review them again; Accept the first: the pass moves on to the one after it, now 1 of 2");
  await barButton(a, "Review them").click({ timeout: CLIENT_MS });
  await passOn(a, { count: "1 of 3", exact: Q[1].exact });
  const accepting = posts.mark();
  await barButton(a, "Accept").click({ timeout: CLIENT_MS });
  await posts.waitInTurn((r) => isOp(r, "accept", ids[1]), { since: accepting, what: "Accept on the first" });
  await passOn(a, { count: "1 of 2", exact: Q[2].exact, timeout: PAGE_MS });
  await assertDecided(docId, ids[1], { state: "accepted", by: by.approver, replacement: R1 });

  ctx.step("Next to 2 of 2 and reject it: the pass moves on to the one left, 1 of 1; reject that too");
  await barButton(a, "Next").click({ timeout: CLIENT_MS });
  await passOn(a, { count: "2 of 2", exact: Q[3].exact });
  const since = a.toastMark();
  await rejectInPass(a, posts, ids[3]);
  await passOn(a, { count: "1 of 1", exact: Q[2].exact, timeout: PAGE_MS });
  await rejectInPass(a, posts, ids[2]);

  ctx.step("the last decision ends the pass with the notice for an accept made here and a comment still open");
  const end = await a.waitForToast((t) => t.text.startsWith("That was the last suggestion") || t.text === APP.endNothing, { since, timeout: PAGE_MS });
  assert.equal(end.text, APP.endResolve, "the end-of-pass notice");
  await eventually(async () => (await barState(a)) === null, { timeout: CLIENT_MS, message: "the bar is gone with nothing left" });
  for (const n of [2, 3]) await assertDecided(docId, ids[n], { state: "rejected", by: by.approver });

  ctx.step("a new suggestion arrives; a pass that only rejects ends with No suggestions are left to review.");
  const ids4 = await suggest(ctx, by.suggester, docId, 3, `rather vital ${tag()}`);
  await idleNotice(a, APP.idleCan(1), "the idle notice counts the new one");
  await barButton(a, "Review it").click({ timeout: CLIENT_MS });
  await passOn(a, { count: "1 of 1", exact: Q[3].exact });
  const since2 = a.toastMark();
  await rejectInPass(a, posts, ids4);
  const end2 = await a.waitForToast((t) => t.text.startsWith("That was the last suggestion") || t.text === APP.endNothing, { since: since2, timeout: PAGE_MS });
  assert.equal(end2.text, APP.endNothing, "nothing was accepted in this pass, so nothing is said to be ready to publish");
  await assertDecided(docId, ids4, { state: "rejected", by: by.approver });
  noPageErrors([a]);
});

// --- A8.6 ---------------------------------------------------------------------

scenario("A8.6 an accept request that never reaches the server leaves the change in the saved draft and the suggestion pending, and says so; accepting again records it and the text is there exactly once", { tiers: BOTH, timeoutMs: 540_000, inconclusiveOnCaseTimeout: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  const { docId, by } = await stage(ctx, { name: "a86", roles: [{ as: "suggester", role: "suggester" }, { as: "approver", role: "approver" }] });
  const R = `sleepy cat ${tag()}`;
  const annId = await suggest(ctx, by.suggester, docId, 1, R);

  const a = await browserFor(ctx, by.approver, "approver");
  const posts = capturePosts(a);
  ctx.step("the approver's next accept request is cut off before it leaves the browser");
  let cut = 0;
  const isSuggestion = (url) => url.pathname === "/suggestion";
  const cutAccept = async (route) => {
    let op = null;
    try {
      op = JSON.parse(route.request().postData() ?? "null")?.op ?? null;
    } catch {
      op = null;
    }
    if (op === "accept" && cut === 0) {
      cut += 1;
      return route.abort("failed");
    }
    return route.fallback();
  };
  await a.page.route(isSuggestion, cutAccept);
  await openEditor(a, docId);
  await idleNotice(a, APP.idleCan(1), "the idle notice");
  await barButton(a, "Review it").click({ timeout: CLIENT_MS });
  await passOn(a, { count: "1 of 1", exact: Q[1].exact });

  ctx.step("Accept: the change is made and saved, the accept fails, and the app says the change is in the draft but not recorded");
  const since = a.toastMark();
  const mark1 = posts.mark();
  await barButton(a, "Accept").click({ timeout: CLIENT_MS });
  const cutRow = await posts.waitInTurn((r) => isOp(r, "accept"), { since: mark1, what: "the first Accept" });
  const t1 = await a.waitForToast((t) => t.kind === "error", { since, timeout: CLIENT_MS });
  assert.equal(t1.text, APP.unrecorded, "the toast says what happened, and what to do");
  assert.deepEqual({ cut, failed: Boolean(cutRow.failure), status: cutRow.status }, { cut: 1, failed: true, status: null }, "the first accept request was the one cut off, with no answer");
  const pending = await annotationOf(docId, annId);
  assert.deepEqual({ state: pending.suggestion.state, resolved: pending.resolved, claimedBy: pending.suggestion.claim?.email ?? null }, { state: "pending", resolved: false, claimedBy: by.approver.account.email.toLowerCase() }, "still pending, under the approver's own claim");
  const draft1 = await draftHtml(by.owner, docId);
  assert.deepEqual({ r: occurrences(draft1, R), quote: occurrences(draft1, Q[1].exact) }, { r: 1, quote: 0 }, "the saved draft holds the change once");
  const bar1 = await passOn(a, { count: "1 of 1", exact: Q[1].exact });
  assert.equal(bar1.buttons.find((b) => b.label === "Accept")?.disabled, false, "Accept is still offered: the change already made is not stale");

  ctx.step("Accept again: it finds the change made, saves, records; nothing is applied twice");
  const since2 = a.toastMark();
  const mark2 = posts.mark();
  await barButton(a, "Accept").click({ timeout: CLIENT_MS });
  await posts.waitInTurn((r) => isOp(r, "accept"), { since: mark2, what: "the second Accept" });
  const t2 = await a.waitForToast((t) => t.kind === "error" || t.text === APP.endPublish, { since: since2, timeout: PAGE_MS });
  assert.equal(t2.text, APP.endPublish, "the retry ends the pass as an accept does");
  const retry = posts.filter((p) => p.seq >= mark2 && (p.path === "/suggestion" || p.path === "/draft"));
  ctx.ev.json("retry-requests", forEvidence(retry));
  assert.equal(retry.filter((p) => p.op === "accept").map((p) => p.status).join(","), "200", "one accept, answered 200");
  await assertDecided(docId, annId, { state: "accepted", by: by.approver, replacement: R });
  const notes = (await commentsOf(docId, annId)).filter((c) => !c.opensSuggestion).map((c) => c.body);
  assert.deepEqual(notes, ["Accepted."], "recorded once");
  assert.equal(await paragraphText(a, Q[1].id), replaced(1, R), "the frame holds the replacement exactly once, in place");
  const draft2 = await draftHtml(by.owner, docId);
  assert.deepEqual({ r: occurrences(draft2, R), quote: occurrences(draft2, Q[1].exact) }, { r: 1, quote: 0 }, "the draft holds the replacement exactly once");
  await a.page.unroute(isSuggestion, cutAccept);
  noPageErrors([a]);
});

// --- A8.7 ---------------------------------------------------------------------

scenario("A8.7 the author revises while the approver's claim is on its way: the claim is refused 409 changed and nothing is applied; accepting again applies and records the new text; a revise during the live claim is refused 409 claimedBy", { tiers: BOTH, timeoutMs: 600_000, inconclusiveOnCaseTimeout: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  const { docId, by } = await stage(ctx, { name: "a87", roles: [{ as: "suggester", role: "suggester" }, { as: "approver", role: "approver" }] });
  const R1 = `sleepy cat ${tag()}`;
  const R2 = `drowsy hound ${tag()}`;
  const R3 = `weary fox ${tag()}`;
  const annId = await suggest(ctx, by.suggester, docId, 1, R1);
  const where = { docId, versionId: "v1", annId };

  const a = await browserFor(ctx, by.approver, "approver");
  const posts = capturePosts(a);
  await openEditor(a, docId);
  await idleNotice(a, APP.idleCan(1), "the idle notice");
  await barButton(a, "Review it").click({ timeout: CLIENT_MS });
  const shown = await passOn(a, { count: "1 of 1", exact: Q[1].exact });
  precondition(shown.ins === R1, `the pass shows the first text: ${JSON.stringify(shown)}`);

  ctx.step("Accept; the claim, naming the first text, is held in the browser while the author revises it");
  // The claim is the first request after the click (the stale check is the page's own), so it is held at once.
  const holdClaim = holdRequests(a.page, (url) => url.pathname === "/suggestion", 1, { method: "POST", predicate: (req) => /"op":"claim"/.test(req.postData() ?? ""), timeoutMs: CLIENT_MS });
  await holdClaim.installed;
  const since = a.toastMark();
  const mark1 = posts.mark();
  await barButton(a, "Accept").click({ timeout: CLIENT_MS });
  await holdClaim.held;
  const revised = await postSuggestion(by.suggester.http, { op: "revise", ...where, replacement: R2 });
  precondition(revised.status === 200, `the author's revise answered ${revised.status} ${JSON.stringify(revised.json)}`);
  await holdClaim.release();

  ctx.step("the claim is refused 409 (changed), the app says so, and nothing was applied or saved");
  const claim = await posts.waitInTurn((r) => isOp(r, "claim"), { since: mark1, what: "the held claim" });
  assert.deepEqual({ status: claim.status, replacement: sent(claim, "replacement") }, { status: 409, replacement: R1 }, "the claim named the first text and was refused");
  assert.deepEqual(claim.json, { error: SERVER.changed, changed: true, replacement: R2 }, "the refusal says the author changed it, and to what");
  const toast = await a.waitForToast((t) => t.kind === "error", { since, timeout: CLIENT_MS });
  assert.equal(toast.text, SERVER.changed, "the approver is told");
  assert.deepEqual(posts.filter((p) => p.path === "/draft" || (p.path === "/suggestion" && p.op !== "claim")).map(label), [], "after the refused claim nothing was saved, released or accepted");
  assert.equal(await paragraphText(a, Q[1].id), TEXT[Q[1].id], "the frame is as it was: the first text was never applied");
  const mid = await annotationOf(docId, annId);
  assert.deepEqual({ state: mid.suggestion.state, replacement: mid.suggestion.replacement, claim: mid.suggestion.claim ?? null, revisions: (mid.suggestion.revisions ?? []).map((r) => r.replacement) }, { state: "pending", replacement: R2, claim: null, revisions: [R1] }, "pending, with the author's new text, unclaimed");

  ctx.step("the pass shows the new text; Accept again, with the accept held while the author tries another change");
  await eventually(async () => (await barState(a))?.ins === R2, { timeout: PAGE_MS, message: "the bar shows the author's new text" });
  // The accept goes out only after the claim and POST /draft have answered,
  // which a loaded stack takes its time over: the capture's waitInTurn waits
  // through them (judging each answer) and hands back the accept as it is sent.
  const holdAccept = holdRequests(a.page, (url) => url.pathname === "/suggestion", 1, { method: "POST", predicate: (req) => /"op":"accept"/.test(req.postData() ?? ""), timeoutMs: 2 * FN_MS });
  await holdAccept.installed;
  const since2 = a.toastMark();
  const mark2 = posts.mark();
  await barButton(a, "Accept").click({ timeout: CLIENT_MS });
  await posts.waitInTurn((r) => isOp(r, "accept"), { since: mark2, what: "the second Accept, up to its send", settled: false });
  await holdAccept.held;
  const blocked = await postSuggestion(by.suggester.http, { op: "revise", ...where, replacement: R3 });
  const me = by.approver.account.email.toLowerCase();
  assert.deepEqual({ status: blocked.status, json: blocked.json }, { status: 409, json: { error: SERVER.applying(me), claimedBy: me } }, "the author may not change it while the approver applies it");
  await holdAccept.release();
  const acc = await posts.waitInTurn((r) => isOp(r, "accept"), { since: mark2, what: "the released accept" });
  const t2 = await a.waitForToast((t) => t.kind === "error" || t.text === APP.endPublish, { since: since2, timeout: PAGE_MS });
  assert.equal(t2.text, APP.endPublish, "the second accept goes through");

  ctx.step("the text applied and the text recorded are the author's second, once; the first and third are nowhere");
  const done = await assertDecided(docId, annId, { state: "accepted", by: by.approver, replacement: R2 });
  assert.deepEqual((done.suggestion.revisions ?? []).map((r) => r.replacement), [R1], "the refused change left no revision");
  const claims = opRows(posts, "claim");
  assert.deepEqual(claims.map((p) => [sent(p, "replacement"), p.status]), [[R1, 409], [R2, 200]], "two claims: the first refused, the second for the new text");
  assert.deepEqual({ replacement: sent(acc, "replacement"), status: acc.status }, { replacement: R2, status: 200 }, "the accept named the new text");
  assert.equal(await paragraphText(a, Q[1].id), replaced(1, R2), "the frame reads the new text in place");
  const draft = await draftHtml(by.owner, docId);
  assert.deepEqual({ r2: occurrences(draft, R2), r1: occurrences(draft, R1), r3: occurrences(draft, R3), quote: occurrences(draft, Q[1].exact) }, { r2: 1, r1: 0, r3: 0, quote: 0 }, "the draft holds the new text once");
  noPageErrors([a]);
});

// --- A8.7b --------------------------------------------------------------------

/** functions/src/lib/suggestions.ts SUGGESTION_LIMITS.claimMs: how long an approver's claim keeps others off. */
const CLAIM_MS = 2 * 60 * 1000;

scenario("A8.7b once the approver's claim has lapsed, an author's revise is taken, and the accept itself is then refused 409 (changed): nothing is recorded and the failure is said", { tiers: BOTH, timeoutMs: 780_000, inconclusiveOnCaseTimeout: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  const { docId, by } = await stage(ctx, { name: "a87b", roles: [{ as: "suggester", role: "suggester" }, { as: "approver", role: "approver" }] });
  const R1 = `sleepy cat ${tag()}`;
  const R2 = `drowsy hound ${tag()}`;
  const annId = await suggest(ctx, by.suggester, docId, 1, R1);
  const where = { docId, versionId: "v1", annId };

  const a = await browserFor(ctx, by.approver, "approver");
  const posts = capturePosts(a);
  await openEditor(a, docId);
  await idleNotice(a, APP.idleCan(1), "the idle notice");
  await barButton(a, "Review it").click({ timeout: CLIENT_MS });
  await passOn(a, { count: "1 of 1", exact: Q[1].exact });

  ctx.step("Accept; claim, apply and save go through, and the accept is held in the browser");
  const holdAccept = holdRequests(a.page, (url) => url.pathname === "/suggestion", 1, { method: "POST", predicate: (req) => /"op":"accept"/.test(req.postData() ?? ""), timeoutMs: 2 * FN_MS });
  await holdAccept.installed;
  const since = a.toastMark();
  const mark = posts.mark();
  await barButton(a, "Accept").click({ timeout: CLIENT_MS });
  await posts.waitInTurn((r) => isOp(r, "accept"), { since: mark, what: "Accept, up to its send", settled: false });
  await holdAccept.held;
  const claimed = await annotationOf(docId, annId);
  const until = claimed?.suggestion?.claim?.until?.toMillis?.() ?? null;
  precondition(opRows(posts, "claim")[0]?.status === 200 && until, `the claim was taken: ${JSON.stringify(opRows(posts, "claim").map((p) => p.status))}`);
  const saved = posts.filter((p) => p.path === "/draft");
  precondition(saved.length >= 1 && occurrences(sent(saved.at(-1), "html") ?? "", R1) === 1, "the draft was saved with the first text before the accept");

  // Time-based by the product: the claim keeps the author off for CLAIM_MS,
  // and nothing but the clock lets go of it. The revise is sent again every
  // 5 s until the server takes it, each refusal a read-only 409; past the
  // claim's own expiry and one slow answer, a refusal is the product's.
  ctx.step(`the author's revise is refused while the claim holds (${CLAIM_MS / 1000} s), and taken once it has lapsed`);
  const refusals = [];
  let revised = null;
  for (;;) {
    const r = await postSuggestion(by.suggester.http, { op: "revise", ...where, replacement: R2 });
    if (!(r.status === 409 && r.json?.claimedBy)) {
      revised = r;
      break;
    }
    refusals.push(Date.now());
    assert.ok(Date.now() < until + FN_MS, `the claim still kept the author off ${Math.round((Date.now() - until) / 1000)} s after its own expiry (${refusals.length} refusals)`);
    await sleep(5_000);
  }
  assert.deepEqual({ status: revised.status, json: revised.json }, { status: 200, json: { state: "pending" } }, "the revise after the lapse");
  assert.ok(refusals.length >= 1 && refusals[0] < until, `the claim kept the author off first (${refusals.length} refusals)`);
  assert.ok(Date.now() >= until, "it was taken only after the claim's own expiry");

  ctx.step("the held accept, naming the first text, now reaches the server: 409 (changed), recorded nowhere");
  await holdAccept.release();
  const acc = await posts.waitInTurn((r) => isOp(r, "accept"), { since: mark, what: "the released accept" });
  assert.deepEqual({ status: acc.status, replacement: sent(acc, "replacement"), json: acc.json }, { status: 409, replacement: R1, json: { error: SERVER.changed, changed: true, replacement: R2 } }, "the accept is refused: its author has changed it");
  const toast = await a.waitForToast((t) => t.kind === "error", { since, timeout: CLIENT_MS });
  const after = await annotationOf(docId, annId);
  assert.deepEqual(
    { state: after.suggestion.state, resolved: after.resolved, replacement: after.suggestion.replacement, decidedBy: after.suggestion.decidedBy ?? null, revisions: (after.suggestion.revisions ?? []).map((r) => r.replacement) },
    { state: "pending", resolved: false, replacement: R2, decidedBy: null, revisions: [R1] },
    "nothing was recorded: still pending, with the author's new text",
  );
  assert.deepEqual((await commentsOf(docId, annId)).filter((c) => !c.opensSuggestion).map((c) => c.body), [], "no decision note");

  // What the approver is left with, kept as evidence (reported, not asserted:
  // SPEC §22 keeps an applied change in the draft when recording fails).
  const bar2 = await eventually(async () => {
    const s = await barState(a);
    return s?.ins === R2 ? s : false;
  }, { timeout: PAGE_MS, message: "the bar shows the author's new text" });
  const draft = await draftHtml(by.owner, docId);
  ctx.ev.json("left-behind", { toast: toast.text, bar: bar2, draft: { r1: occurrences(draft, R1), r2: occurrences(draft, R2), quote: occurrences(draft, Q[1].exact) }, frame: await paragraphText(a, Q[1].id) });
  noPageErrors([a]);
});

// --- A8.8 ---------------------------------------------------------------------

scenario("A8.8 with a personal token an approver's claim, release, accept and reject are each 403 and change nothing, while their web session may claim; the author's tokens may revise and withdraw", { tiers: BOTH, timeoutMs: 480_000, inconclusiveOnCaseTimeout: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  const { docId, by } = await stage(ctx, { name: "a88", roles: [{ as: "suggester", role: "suggester" }, { as: "approver", role: "approver" }] });
  const R = `sleepy cat ${tag()}`;
  const annId = await suggest(ctx, by.suggester, docId, 1, R);
  const where = { docId, versionId: "v1", annId };
  /** A token's client: waits FN_MS, and Hosting's cut-off throws E2E_STACK_CUTOFF (the case is INCONCLUSIVE); any other answer is judged. */
  const tokenHttp = (token, actor) => bearerHttp(target, token, { actor, timeoutMs: FN_MS, cutoffError: true });

  ctx.step("tokens: the approver's cli and mcp channels, and the owner's cli");
  const deciders = [];
  for (const [label, session, channel] of [["approver-cli", by.approver, "cli"], ["approver-mcp", by.approver, "mcp"], ["owner-cli", by.owner, "cli"]]) {
    deciders.push({ label, http: tokenHttp(await tokenFor(ctx, session, `e2e a88 ${label} ${tag()}`, channel), label) });
  }
  const ops = [
    { op: "claim", replacement: R },
    { op: "release" },
    { op: "accept", replacement: R },
    { op: "reject", reason: "not through a token" },
  ];
  const cells = [];
  for (const d of deciders) {
    for (const o of ops) {
      const r = await postSuggestion(d.http, { ...where, ...o });
      cells.push({ who: d.label, op: o.op, status: r.status, error: r.json?.error ?? null, noStore: /\bno-store\b/.test(r.cacheControl ?? "") });
    }
  }
  ctx.ev.json("token-cells", cells);
  const bad = cells.filter((c) => c.status !== 403 || c.error !== SERVER.tokenDecides || !c.noStore);
  assert.deepEqual(bad, [], `every token decision is 403 "${SERVER.tokenDecides}", no-store`);
  const untouched = await annotationOf(docId, annId);
  assert.deepEqual({ state: untouched.suggestion.state, resolved: untouched.resolved, claim: untouched.suggestion.claim ?? null, decidedBy: untouched.suggestion.decidedBy ?? null }, { state: "pending", resolved: false, claim: null, decidedBy: null }, "nothing a token sent changed the suggestion");
  assert.deepEqual((await commentsOf(docId, annId)).map((c) => c.opensSuggestion === true), [true], "the thread holds only its opener");

  ctx.step("positive control: the same approver's web session may claim, and release");
  const webClaim = await postSuggestion(by.approver.http, { op: "claim", ...where, replacement: R });
  assert.deepEqual({ status: webClaim.status, json: webClaim.json }, { status: 200, json: { state: "pending" } }, "a web claim is taken");
  assert.equal((await annotationOf(docId, annId)).suggestion.claim?.email, by.approver.account.email.toLowerCase(), "the claim is stored");
  const webRelease = await postSuggestion(by.approver.http, { op: "release", ...where });
  assert.deepEqual({ status: webRelease.status, json: webRelease.json }, { status: 200, json: { state: "pending" } }, "and let go of");

  ctx.step("the author's mcp token revises (200), their cli token withdraws (200)");
  const sMcp = tokenHttp(await tokenFor(ctx, by.suggester, `e2e a88 author-mcp ${tag()}`, "mcp"), "suggester-mcp");
  const sCli = tokenHttp(await tokenFor(ctx, by.suggester, `e2e a88 author-cli ${tag()}`, "cli"), "suggester-cli");
  const R2 = `drowsy hound ${tag()}`;
  const rev = await postSuggestion(sMcp, { op: "revise", ...where, replacement: R2 });
  assert.deepEqual({ status: rev.status, json: rev.json }, { status: 200, json: { state: "pending" } }, "revise with a token");
  const afterRev = await annotationOf(docId, annId);
  assert.deepEqual({ replacement: afterRev.suggestion.replacement, revisions: (afterRev.suggestion.revisions ?? []).map((r) => ({ replacement: r.replacement, channel: r.actor?.channel })) }, { replacement: R2, revisions: [{ replacement: R, channel: "mcp" }] }, "the change is kept, stamped mcp");
  const wd = await postSuggestion(sCli, { op: "withdraw", ...where });
  assert.deepEqual({ status: wd.status, json: wd.json }, { status: 200, json: { state: "withdrawn" } }, "withdraw with a token");
  const gone = await annotationOf(docId, annId);
  assert.deepEqual({ state: gone.suggestion.state, resolved: gone.resolved, decidedBy: who(gone.suggestion.decidedBy) }, { state: "withdrawn", resolved: true, decidedBy: { uid: by.suggester.uid, email: by.suggester.account.email.toLowerCase(), channel: "cli" } }, "withdrawn by the author, through the cli");
  const notes = (await commentsOf(docId, annId)).filter((c) => !c.opensSuggestion);
  assert.deepEqual(notes.map((c) => ({ body: c.body, channel: c.actor?.channel })), [{ body: "Withdrawn.", channel: "cli" }], "the note says so");
});

// --- A8.9 ---------------------------------------------------------------------

/** What A8.9 leaves for its BODYATTR case: the comparison, or why there is none. */
const committed = { bodyAttr: null, versionId: null, stopped: "A8.9 did not run" };

/** BODYATTR with one attribute name taken out of both sides. */
function withoutAttr(fp, name) {
  const drop = (x) => (x ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== name)) : x);
  return { ...fp, bodyAttrs: drop(fp.bodyAttrs), htmlAttrs: drop(fp.htmlAttrs) };
}

async function storedVersion(http, docId, versionId) {
  const r = await http.get(`/download/${encodeURIComponent(docId)}/${encodeURIComponent(versionId)}`, { expect: 200 });
  const html = entryHtml(zipFiles(r.buffer));
  const rehash = await rehashZip(r.buffer, { target });
  const record = await readDoc(target, `docs/${docId}/versions/${versionId}`);
  return { html, rehash: rehash.contentHash, record };
}

scenario("A8.9 the version committed after an in-app accept holds the replacement once and passes REHASH, DECOR and BODYATTR beyond the known S3; the accept reached a co-editor once", { tiers: BOTH, timeoutMs: 720_000, inconclusiveOnCaseTimeout: true, inconclusiveOnFunctionKill: true }, async (ctx) => {
  committed.stopped = "A8.9 stopped before it committed a version";
  const { docId, by } = await stage(ctx, { name: "a89", roles: [{ as: "suggester", role: "suggester" }, { as: "approver", role: "approver" }, { as: "editor", role: "editor" }] });
  const R = `sleepy cat ${tag()}`;
  const annId = await suggest(ctx, by.suggester, docId, 1, R);

  ctx.step("the approver and an editor are both in the editor, sharing it");
  const [a, e] = await Promise.all([browserFor(ctx, by.approver, "approver"), browserFor(ctx, by.editor, "editor")]);
  const posts = capturePosts(a);
  await openEditor(a, docId);
  await openEditor(e, docId);
  await idleNotice(a, APP.idleCan(1), "the approver's idle notice");

  ctx.step("the approver accepts in the pass; the editor's frame shows the replacement once, and both frames converge");
  await barButton(a, "Review it").click({ timeout: CLIENT_MS });
  await passOn(a, { count: "1 of 1", exact: Q[1].exact });
  const since = a.toastMark();
  const accepting = posts.mark();
  await barButton(a, "Accept").click({ timeout: CLIENT_MS });
  await posts.waitInTurn((r) => isOp(r, "accept"), { since: accepting, what: "Accept" });
  await a.waitForToast((t) => t.kind === "error" || t.text === APP.endPublish, { since, timeout: PAGE_MS }).then((t) => assert.equal(t.text, APP.endPublish, "the accept went through"));
  await assertDecided(docId, annId, { state: "accepted", by: by.approver, replacement: R });
  await eventually(async () => (await paragraphText(e, Q[1].id)) === replaced(1, R), { timeout: PAGE_MS, message: "the co-editor reads the replacement in place" });
  await eventually(async () => {
    const [x, y] = await Promise.all([bodyHash(await a.frame()), bodyHash(await e.frame())]);
    if (x.hash !== y.hash) throw new Error(`hashes differ: ${x.hash.slice(0, 12)} vs ${y.hash.slice(0, 12)}`);
    return x.hash;
  }, { timeout: PAGE_MS, interval: 250, stableSamples: 3, message: "I1: both frames are the same document" });
  // Each editor's autosave answers in its own time: past Hosting's cut-off,
  // so a save it cut off shows here as "error" with its 504 for pageStall.
  await eventually(async () => {
    const states = await Promise.all([a.saveState(), e.saveState()]);
    if (states.some((s) => s === "dirty" || s === "saving" || s === "error")) throw new Error(`save states ${JSON.stringify(states)}`);
    return states;
  }, { timeout: FN_MS, interval: 1000, stableSamples: 3, message: "both editors settled" });

  ctx.step("the approver presses Save as new version");
  const committing = posts.mark();
  // POST /draft (the flush), then POST /commit: two answers on a loaded stack.
  const commit = await a.saveAsNewVersion({ timeout: 2 * FN_MS });
  judgeAnswers(a, posts, committing);
  assert.deepEqual({ outcome: commit.outcome, versionId: commit.versionId }, { outcome: "published", versionId: "v2" }, `commit toast: ${commit.text}`);

  ctx.step("v2 as stored: REHASH, the replacement once where the quote was, DECOR clean against v1");
  const [s1, s2] = await Promise.all([storedVersion(by.owner.http, docId, "v1"), storedVersion(by.owner.http, docId, "v2")]);
  assert.equal(s1.rehash, s1.record.contentHash, "REHASH v1");
  assert.equal(s2.rehash, s2.record.contentHash, "REHASH v2");
  assert.deepEqual({ parentVersion: s2.record.parentVersion, publishedVia: s2.record.publishedVia }, { parentVersion: "v1", publishedVia: "editor" });
  assert.deepEqual({ r: occurrences(s2.html, R), quote: occurrences(s2.html, Q[1].exact) }, { r: 1, quote: 0 }, "v2 holds the replacement once and the quote no more");
  const at = s2.html.indexOf(`id="${Q[1].id}"`);
  assert.ok(at >= 0 && s2.html.slice(at, s2.html.indexOf("</p>", at)).includes(R), `the replacement is inside #${Q[1].id}`);
  const parser = await ctx.users.parser();
  const fp1 = await fingerprint(parser, s1.html);
  const fp2 = await fingerprint(parser, s2.html);
  ctx.ev.json("fingerprints", { v1: summarize(fp1), v2: summarize(fp2) });
  ctx.ev.text("v2.html", s2.html);
  const diff = diffFingerprint(fp1, fp2, (t1, t2) => occurrences(t1, Q[1].exact) === 1 && t2 === t1.replace(Q[1].exact, R), { ignoreBodyAttr: true });
  assert.deepEqual(diff.decoration, [], "DECOR: decoration in v2");
  assert.deepEqual(diff.lost, [], "DECOR: lost author markers");
  assert.deepEqual(diff.structure, [], "DECOR: structure changed");
  assert.equal(diff.text.allowed, true, "the only text change is the quote replaced, once");

  committed.bodyAttr = bodyAttrDiff(fp1, fp2);
  committed.versionId = commit.versionId;
  committed.stopped = null;
  ctx.ev.json("bodyattr", committed.bodyAttr);
  const beyondS3 = bodyAttrDiff(withoutAttr(fp1, "spellcheck"), withoutAttr(fp2, "spellcheck"));
  assert.equal(beyondS3.equal, true, `BODYATTR differs beyond the known S3 spellcheck: ${JSON.stringify(beyondS3)}`);
  noPageErrors([a, e]);
});

scenario("A8.9 (BODYATTR) the version committed after the accept has <html> and <body> attributes equal to v1's", { tiers: BOTH, defect: "S3", timeoutMs: 30_000 }, async (ctx) => {
  // Nothing to compare when A8.9 stopped first (its own outcome says why):
  // nothing was measured here, so this is no verdict on S3 either way.
  if (!committed.bodyAttr) ctx.inconclusive(`${committed.stopped}, so there is no committed version to compare with v1`);
  ctx.step(`BODYATTR v1→${committed.versionId}: ${JSON.stringify(committed.bodyAttr)}`);
  assert.equal(committed.bodyAttr.equal, true, `BODYATTR: ${JSON.stringify({ body: committed.bodyAttr.body, html: committed.bodyAttr.html })}`);
});
