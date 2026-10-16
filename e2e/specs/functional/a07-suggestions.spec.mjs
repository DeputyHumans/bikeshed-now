// SPDX-License-Identifier: Apache-2.0
// A7 suggestions: who is offered Suggest edit, what a selection may be, normalisation, the revision and pending limits, withdrawal, versions and staleness (SPEC §22).

/**
 * Catalogue A7, each case on its own accounts and its own document:
 *
 *   A7.1  Suggest edit is offered to a suggester (and to the owner, who may
 *         suggest too — SPEC §22's table), never to a viewer; the form opens
 *         prefilled with the quote, caret at the end; Enter submits; the
 *         reading frame strikes the quote with `mark[data-bshd-sug]` and puts
 *         the replacement in `data-bshd-ins` on the LAST wrapper only, with
 *         the frame's textContent unchanged
 *   A7.2  a selection across two paragraphs, holding a line break, list or
 *         table, or inside a figure (SVG text) is refused on press with its
 *         reason and no form; one inside a single list item or table cell is
 *         taken (SPEC §22 "holding", not "inside")
 *   A7.3  normalisation: a line break pasted into the field becomes a space;
 *         Escape cancels; empty suggests a deletion; the form will not send a
 *         replacement equal to its quote and the endpoint answers it 400; a
 *         line break, tab, control or direction character answers 400
 *   A7.3b the same rule for the line and paragraph separators and a C1
 *         control (NEL), which SPEC §2 and §22 also forbid
 *   A7.4  twenty changes are kept in `revisions`; the twenty-first is 409, in
 *         the API and in the panel's Edit form; the panel says "Changed 20 times"
 *   A7.5  withdraw: author only; withdrawn, resolved, the note "Withdrawn.",
 *         quote and replacement kept; again is idempotent; no change after;
 *         an author who may no longer suggest may still withdraw, not change
 *   A7.6  twenty pending per author per version; the twenty-first is 409
 *         "You already have 20…" in the API and in the form (which stays
 *         open); another author is not held back; withdrawing frees a slot
 *   A7.7  a suggestion on a version that is no longer current is 409 with
 *         `currentVersion` and writes nothing; a reader of the old version is
 *         offered no write actions
 *   A7.8  a suggestion quoting text only the draft holds is drawn for the
 *         editor reading the draft, and listed as stale, undrawn, for a reader
 *         of the published version
 *
 * Only e2e/lib/ talks to the stack.
 *
 * WHEN THE STACK DOES NOT ANSWER. On a loaded shared stack Hosting answers
 * 504 itself after its minute for a function that has not answered, the
 * Admin SDK's Firestore calls run out of their 60 s deadline, and a page's
 * request is cut off the same way (2026-10-12, run 0a2t at a load of 42:
 * POST /publish, POST /access and POST /publish?update cut off in setup, and
 * an account's record write DEADLINE_EXCEEDED). The product answered none of
 * them, so nothing was measured. So:
 *   - every setup call goes through lib/test.mjs untilLanded (publish's and
 *     share's `patient`): sent again only after its effect was looked for in
 *     the record, and the case ends INCONCLUSIVE when that keeps happening;
 *   - every session client is made with `cutoffError: true`, so a cut-off on
 *     a request the case judges throws E2E_STACK_CUTOFF instead of reaching
 *     an assertion as a 504;
 *   - every document is opened with User.open's `reloads` and `sessionCheck`,
 *     and User.suggest's refusal carries the page's POST /suggestion as its
 *     `response`, so a cut-off there is the stack not answering;
 *   - every page response the case reads itself goes through `answered()`;
 *   - every case declares ON_STACK, below: a wait that ran out, the case's
 *     own budget included, is INCONCLUSIVE only with evidence that the stack
 *     stalled in its window.
 * An answer, however slow, is still judged, and an assertion still FAILS.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { answered, currentTarget, precondition, scenario, untilLanded } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { publish, readFixture, updateUpload } from "../../lib/seed.mjs";
import { share } from "../../lib/grant.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { frameText } from "../../lib/frame.mjs";

/**
 * Every case runs on both tiers. A suggestion writes an opening comment, which
 * fires the comment trigger; on production the guard lets POST /suggestion
 * through only on a quiet document (owner, approvers and every author are run
 * accounts with notifications off), so no case here declares an email effect.
 */
const BOTH = Object.freeze(["local", "prod"]);

/**
 * Every case's stack options (lib/test.mjs). `inconclusiveOnCaseTimeout`
 * (and so `inconclusiveOnPageStall` and `inconclusiveOnStackTimeout`): the
 * body runs against a budget, and running out of it is a wait whose window is
 * the whole case. `inconclusiveOnRequestStall`: a request the case itself
 * made that got Hosting's cut-off 504 in a wait's window is evidence, as a
 * page's is. Without it a case whose setup the stack kept cutting off ran out
 * of its budget before any page existed and FAILED with nothing measured (run
 * 0a2t, invocation 9azy, A7.8: POST /publish and POST /access each cut off at
 * 60 s, the budget gone while the browsers signed in).
 */
const ON_STACK = Object.freeze({ inconclusiveOnCaseTimeout: true, inconclusiveOnRequestStall: true });

/**
 * How long to wait for anything that goes through the server or the
 * annotations snapshot: a POST /suggestion's answer, a thread or a highlight
 * appearing, an error toast that follows a refusal, a sign-in, a page load.
 * Never a fixed sleep, only a bound. On a shared emulator stack under load
 * (measured 2026-10-11: function calls of 7–60 s behind Firestore emulator
 * transaction-lock timeouts, a Listen round trip of 7.7 s; 2026-10-12: a
 * load average of 42 on 16 CPUs, function p90 50 s, max 59 s) a 15 s bound
 * failed cases whose product behaviour was right, and so did the lib's 60 s
 * request default (POST /access, A7.1), so the bounds are generous; nothing
 * here asserts a latency.
 */
const SLOW = 90_000;
/** Every session client's request bound (openSession timeoutMs), the README's figure for a slow shared stack. */
const HTTP_MS = 180_000;
/** Case bounds: twenty sequential writes at the latencies above take minutes. */
const CASE_MS = 600_000;
const HEAVY_CASE_MS = 1_200_000;
/**
 * How long into a case a call the stack did not answer is still worth sending
 * again (lib/test.mjs untilLanded's `stopAt`, fixed by the case's first call).
 * A non-answer costs Hosting's minute and a minute looking for its effect;
 * past this, a non-answer ends the case INCONCLUSIVE at once, so a case whose
 * stack stays saturated is not spent resending. A case that meets none is
 * never affected.
 */
const ENV_BUDGET_MS = 300_000;
const stopAts = new WeakMap();
const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

/** untilLanded's options for this case. */
function patience(ctx) {
  if (!stopAts.has(ctx)) stopAts.set(ctx, Date.now() + ENV_BUDGET_MS);
  return { stopAt: stopAts.get(ctx) };
}

// --- the document -----------------------------------------------------------

/**
 * One small document with every shape a selection rule is about. Each
 * paragraph's text is known here exactly, so an anchor can be built in Node
 * the way the app builds one in the frame.
 */
const TEXT = Object.freeze({
  "sg-1": "The quick brown fox jumps over the lazy dog near the riverbank.",
  "sg-2": "A second paragraph mentions lanterns and harbour lights at dusk.",
  "sg-3": "This sentence is really quite important to the argument.",
  "sg-4": "Closing words for the record, kept short.",
});

function suggestionDoc({ sg1 = "The quick <em>brown</em> fox jumps over the lazy dog near the riverbank.", title = "E2E suggestions" } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.6}td{border:1px solid #999;padding:2px 6px}</style>
</head>
<body>
<h1 id="sg-title">Suggestion fixture</h1>
<p id="sg-1">${sg1}</p>
<p id="sg-2">${TEXT["sg-2"]}</p>
<p id="sg-3">${TEXT["sg-3"]}</p>
<p id="sg-br">First line of the verse<br>second line of the verse</p>
<div id="sg-listbox">Before the list<ul><li id="sg-li">a single list item worth editing</li></ul>after the list</div>
<div id="sg-tablebox">Before the table<table><tbody><tr><td id="sg-td">a table cell worth editing</td></tr></tbody></table>after the table</div>
<figure id="sg-fig"><svg xmlns="http://www.w3.org/2000/svg" width="360" height="40" viewBox="0 0 360 40"><text id="sg-svgtext" x="4" y="26" font-size="18">Figure label inside a drawing</text></svg></figure>
<p id="sg-4">${TEXT["sg-4"]}</p>
</body>
</html>
`;
}

/** The paragraphs fixture's own text, by id (`p#e2e-1…40`). */
function paragraphsText() {
  const html = readFixture("crdt-paragraphs.html", { raw: true }).toString("utf8");
  const out = {};
  for (const m of html.matchAll(/<p id="(e2e-\d+)">([^<]*)<\/p>/g)) out[m[1]] = m[2];
  return out;
}

// --- the app's words ----------------------------------------------------------

/** app/src/annotation/exact.ts suggestibleRange. */
const REASON = Object.freeze({
  across: "A suggestion stays within one paragraph.",
  structure: "A suggestion can only change text, and this includes a line break, list, table or image.",
  figure: "Text inside a figure can’t be edited.",
});
/** functions/src/lib/suggestions.ts and functions/src/index.ts. */
const SERVER = Object.freeze({
  oneLine: "a replacement is text on one line: no line breaks, tabs or invisible direction marks",
  same: "the replacement is the same as the text it replaces",
  pendingLimit: "You already have 20 suggestions waiting on this version. Wait for some to be decided, or withdraw one.",
  revisionLimit: "This suggestion has been changed 20 times. Withdraw it and suggest it again.",
  newer: "This document has a newer version. Reload, then suggest the edit on it.",
  notAuthorWithdraw: "only the person who suggested it can withdraw it",
  notAuthorChange: "only the person who suggested it can change it",
  noLongerSuggester: "you may no longer suggest edits here, so you can withdraw this suggestion but not change it",
  withdrawn: "it has already been withdrawn",
});
/** app/src/annotation/Sidebar.tsx SuggestionChange. */
const STATUS = Object.freeze({
  waiting: "Waiting for the owner or an approver.",
  stale: "The text has changed since this was suggested, so it can’t be applied.",
});
const describeChange = (exact, replacement) =>
  replacement === "" ? `Suggested deleting “${exact}”.` : `Suggested replacing “${exact}” with “${replacement}”.`;

// --- helpers ------------------------------------------------------------------

/**
 * cast() one role at a time. A long-lived shared stack holds thousands of
 * accounts per role (2,321 owners on 0a2t by 2026-10-12), so a fresh
 * four-character suffix is now and then one already signed up (A7.7 once
 * failed in setup on `EMAIL_EXISTS`): cast replaces such an address with
 * another fresh one, `retryTaken` times. A cast the stack did not answer (the
 * Auth emulator's REST call past the client's deadline, the account record's
 * Admin write DEADLINE_EXCEEDED) is cast again through untilLanded, one role
 * at a time so the roles already made are kept: a fresh address each time, so
 * a half-made account is only an extra ledger row.
 */
async function castEach(ctx, roles, o) {
  const out = [];
  for (const role of roles) {
    const { out: made } = await untilLanded(ctx, `cast ${role}`, () => cast(target, [role], { ...o, retryTaken: 3 }), null, patience(ctx));
    out.push(made[0]);
  }
  return out;
}

/** A session (POST /session, safe to send again) whose client throws E2E_STACK_CUTOFF on Hosting's cut-off. */
async function sessionFor(ctx, acct) {
  const { out } = await untilLanded(ctx, `POST /session (${acct.role})`, () => openSession(target, acct, { timeoutMs: HTTP_MS, cutoffError: true }), null, patience(ctx));
  return out;
}

/**
 * Give `account` `role` (lib/grant.mjs share with `patient`): sent again only
 * when the stack did not answer and the record does not show the grant (the
 * address in the role's list and in no other, a change of role moving it).
 * True when it was answered 200 or found in the record instead.
 */
async function grant(ctx, { owner, docId, account, role }) {
  const g = await share(target, { owner, doc: docId, account, role, timeoutMs: HTTP_MS, patient: { ctx, ...patience(ctx) } });
  precondition(g.landed || g.status === 200, `share ${role}: ${g.status} ${JSON.stringify(g.json)}`);
  return true;
}

/** An owner with a session, the rest of the cast with sessions too, and a published document shared by role. */
async function setup(ctx, { roles = [], name, title, body, fixture } = {}) {
  // Notifications off, as production's run accounts always are: a suggestion's opener then sends no comment notice locally either.
  const accounts = await castEach(ctx, ["owner", ...roles.map((r) => r.as)], { notifications: false });
  const sessions = [];
  for (const a of accounts) sessions.push(await sessionFor(ctx, a));
  const [owner, ...rest] = sessions;
  const patient = { ctx, ...patience(ctx) };
  const up = fixture
    ? await publish(owner.http, { fixture, title, name, patient })
    : await publish(owner.http, { body: body ?? suggestionDoc({ title }), filename: "index.html", title, name, patient });
  precondition(up.versionId === "v1", `publish answered ${up.status} ${JSON.stringify(up.json)}`);
  for (const [i, r] of roles.entries()) await grant(ctx, { owner, docId: up.docId, account: accounts[i + 1], role: r.role });
  ctx.step(`document ${up.docId}: owner ${accounts[0].email}${roles.map((r, i) => `, ${r.role} ${accounts[i + 1].email}`).join("")}`);
  return { docId: up.docId, owner, others: rest, accounts };
}

/**
 * An anchor as `describeAnchorFromRange` makes one: the nearest id element as
 * root, the quote, 32 characters of context either side (dom-anchor-text-quote's
 * default) and the text offsets.
 */
function anchorIn(text, elementId, exact, occurrence = 0) {
  let at = -1;
  for (let i = 0, from = 0; i <= occurrence; i += 1) {
    at = text.indexOf(exact, from);
    if (at < 0) throw new Error(`"${exact}" not in #${elementId}`);
    from = at + 1;
  }
  return {
    elementId,
    exact,
    prefix: text.slice(Math.max(0, at - 32), at),
    suffix: text.slice(at + exact.length, at + exact.length + 32),
    start: at,
    end: at + exact.length,
  };
}

/** POST /suggestion as a session; the status, JSON and Cache-Control. */
async function post(session, body) {
  const r = await session.http.postJson("/suggestion", body);
  return { status: r.status, json: r.json, cacheControl: r.headers.get("cache-control") };
}

const create = (session, docId, { anchor, replacement, note, versionId = "v1" }) =>
  post(session, { op: "create", docId, versionId, anchor, replacement, ...(note ? { note } : {}) });

/**
 * A suggestion the case needs, not the one it judges: sent again only when the
 * stack did not answer and no pending suggestion of this author on this quote
 * with this replacement is in the record (each caller's quotes are distinct).
 */
async function createOk(ctx, session, docId, o) {
  const versionId = o.versionId ?? "v1";
  const email = String(session.account.email).toLowerCase();
  const { out, landed } = await untilLanded(ctx, `POST /suggestion create "${o.anchor.exact}"`, () => create(session, docId, o), async () => {
    const hit = (await annotationsOf(docId, versionId)).find((a) => String(a.data.authorEmail ?? "").toLowerCase() === email && a.data.anchor?.elementId === o.anchor.elementId && a.data.anchor?.exact === o.anchor.exact && a.data.suggestion?.replacement === o.replacement && a.data.suggestion?.state === "pending");
    return hit ? hit.id : null;
  }, patience(ctx));
  if (landed) return landed;
  precondition(out.status === 200 && out.json?.annId, `create answered ${out.status} ${JSON.stringify(out.json)}`);
  return out.json.annId;
}

/** A revise the case needs (A7.4's nineteen): sent again only when the stack did not answer and the record does not hold `replacement`. */
async function reviseOk(ctx, session, docId, annId, replacement) {
  const { out, landed } = await untilLanded(ctx, `POST /suggestion revise ${annId}`, () => post(session, { op: "revise", docId, versionId: "v1", annId, replacement }), async () => {
    const a = await annotationOf(docId, annId);
    return a?.suggestion?.replacement === replacement ? { status: 200, json: { state: a.suggestion.state }, landed: true } : null;
  }, patience(ctx));
  return out ?? landed;
}

const annotationsOf = (docId, versionId = "v1") => readCollection(target, `docs/${docId}/versions/${versionId}/annotations`);
const annotationOf = (docId, annId, versionId = "v1") => readDoc(target, `docs/${docId}/versions/${versionId}/annotations/${annId}`);
async function commentsOf(docId, annId, versionId = "v1") {
  const rows = await readCollection(target, `docs/${docId}/versions/${versionId}/annotations/${annId}/comments`);
  return rows.map((r) => r.data).sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));
}

/**
 * Browser users signed in through the UI, one per account, in parallel. The
 * app's own POST /session can get Hosting's cut-off (signInUi throws it with
 * the answer); signing in is safe to repeat, so untilLanded tries it again.
 */
async function browsers(ctx, accounts, names) {
  const users = await Promise.all(names.map((name) => ctx.users.user({ name })));
  await Promise.all(users.map((u, i) => untilLanded(ctx, `${u.name}'s sign-in`, () => u.signInUi(accounts[i].email, accounts[i].password, { timeout: SLOW }), null, patience(ctx))));
  return users;
}

/**
 * Open /d/<docId>[/<v>] as a signed-in user (User.open): the viewer, its
 * frame, and that load's own POST /session. A load whose wait ran out while
 * the page saw the stack stall (its Listen channel, a Hosting cut-off) is
 * loaded once more, and so is one whose POST /session got Hosting's cut-off:
 * the app reads that non-JSON 504 as "session_failed" and goes signed out
 * over a cookie that still serves the frame (app/src/auth.tsx postSession,
 * syncSession), so the toolbar offers "Sign in to comment" (run 0a2t,
 * invocation 5fil, A7.2). A second cut-off throws E2E_STACK_CUTOFF: the stack
 * not answering, INCONCLUSIVE. Any answer, a refusal included, stands and is
 * judged by what the page shows.
 */
const openDoc = (u, docId, { v = null } = {}) => u.open(docId, { v, timeout: SLOW, reloads: 1, sessionCheck: true });

/**
 * The page's next POST /suggestion after `mark` (User.waitForResponse, so one
 * that came back before the wait began counts), through answered(): Hosting's
 * cut-off is the stack not answering, never the product's 504.
 */
async function suggestionAnswer(u, mark) {
  return answered(await u.waitForResponse({ method: "POST", path: "/suggestion" }, { since: mark, timeout: SLOW }), `${u.name}'s POST /suggestion`);
}

/** The labels of the selection toolbar's buttons, once it shows. */
async function fabLabels(u, { timeout = 10_000 } = {}) {
  await u.page.locator(".selection-fab").first().waitFor({ state: "visible", timeout });
  return u.page.locator(".selection-fab").evaluateAll((els) => els.map((e) => e.textContent.trim()));
}

const popover = (u) => u.page.locator('.suggest-popover[role="dialog"]');

/**
 * The floating form once it shows with its field focused (it focuses the
 * field in an effect, a moment after it shows, so keys typed at once can go
 * elsewhere); its state as User.suggestState reads it.
 */
async function openForm(u, { timeout = 10_000 } = {}) {
  await popover(u).waitFor({ state: "visible", timeout });
  return u.poll(async () => {
    const f = await u.suggestState();
    return f.open && f.focused ? f : null;
  }, { timeout: 5_000, what: "the suggestion field to take focus" });
}

/**
 * Every POST /suggestion this user's pages send from now on, one row per
 * request from the moment it is SENT (User.capture). Start it before the page
 * loads: "nothing was sent" is read from these rows, never from `log.requests`,
 * which is written at the response and so has no row for a request still
 * waiting for its answer.
 */
const capturePosts = (u) => u.capture({ paths: "/suggestion" });
/** The captured rows as plain data: the op and the status (null while unanswered). */
const sentRows = (posts) => posts.map((p) => ({ op: p.op, status: p.status }));

/**
 * The frame's text as anchors see it: the anchor root's textContent, and the
 * body's without the app's own nodes (frameText withoutOwn). The peer overlay
 * (`[data-bshd="peers"]`, labels naming the other readers) is in the body by
 * design (SPEC §16) and differs from reader to reader, so it is not what a
 * suggestion must leave alone; a node of the document's, or a text node the
 * highlighter added, is kept.
 */
async function texts(frame, rootSel) {
  return { root: await frameText(frame, { selector: rootSel }), body: await frameText(frame, { withoutOwn: true }) };
}

/** The suggestion's highlight wrappers in the frame, in document order. */
function sugMarks(frame, annId) {
  return frame.evaluate((id) => Array.from(document.querySelectorAll("mark.bshd-hl, tspan.bshd-hl"))
    .filter((m) => m.getAttribute("data-bshd-sug") === id)
    .map((m) => ({ text: m.textContent, ins: m.getAttribute("data-bshd-ins"), ann: m.getAttribute("data-bshd-ann") })), annId);
}

function noPageErrors(users) {
  for (const u of users) assert.deepEqual(u.log.errors.map((e) => e.message), [], `${u.name}: uncaught page errors`);
}

/** Wait for a matching toast after `since`; its text. */
async function toastText(u, since, pred, timeout = 10_000) {
  return (await u.waitForToast(pred, { since, timeout })).text;
}

// --- A7.1 -------------------------------------------------------------------

scenario("A7.1 Suggest edit is offered to the suggester and the owner, not the viewer; the form is prefilled with the caret at the end and Enter submits; the frame strikes the quote, data-bshd-ins only on the last wrapper, textContent unchanged", { tiers: BOTH, timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, accounts } = await setup(ctx, {
    roles: [{ as: "suggester", role: "suggester" }, { as: "viewer", role: "viewer" }],
    name: "a71-offer",
    title: "A7.1 offer",
  });
  const [ownerAcct, sugAcct, viewerAcct] = accounts;
  const [o, s, v] = await browsers(ctx, [ownerAcct, sugAcct, viewerAcct], ["owner", "suggester", "viewer"]);
  await Promise.all([openDoc(o, docId), openDoc(s, docId), openDoc(v, docId)]);

  const QUOTE = "quick brown fox"; // three text nodes: "quick " | <em>brown</em> | " fox"
  const REPLACEMENT = "quick brown cat";
  ctx.step(`each selects "${QUOTE}" in #sg-1 (it crosses an <em>); the toolbar offers Suggest edit to the suggester and the owner, never the viewer`);
  const offers = {};
  for (const u of [v, o, s]) {
    const sel = await u.selectText("#sg-1", QUOTE);
    assert.equal(sel.text, QUOTE, `${u.name} selected the quote`);
    offers[u.name] = await fabLabels(u);
  }
  ctx.ev.json("offers", offers);
  assert.deepEqual(offers, { viewer: ["Comment"], owner: ["Comment", "Suggest edit"], suggester: ["Comment", "Suggest edit"] }, "who is offered Suggest edit (SPEC §22)");

  const before = await texts(await s.frame(), "#sg-1");
  ctx.step(
    `the suggester presses Suggest edit and types from the keyboard where the form put the caret: three Backspaces over "fox", then "cat", then Enter. ` +
      "User.suggest's keyboard mode sends nothing unless the field then holds exactly the replacement, so a caret anywhere but the end fails here",
  );
  // A refusal throws with the page's POST /suggestion as `response`, so Hosting's cut-off behind its toast is the stack not answering, not a refusal; an answer goes through answered() here.
  const sent = await s.suggest(REPLACEMENT, { keyboard: true, timeout: SLOW });
  answered(sent.response, "suggester's POST /suggestion");
  ctx.ev.json("form-opened", sent.opened);
  assert.deepEqual(
    { quote: sent.opened.quote?.trim(), value: sent.opened.value, start: sent.opened.start, end: sent.opened.end, focused: sent.opened.focused },
    { quote: QUOTE, value: QUOTE, start: QUOTE.length, end: QUOTE.length, focused: true },
    "the form names the quote and opens prefilled, focused, caret at the end",
  );
  assert.equal(sent.value, REPLACEMENT, "typed at the end");
  assert.ok(sent.response, "Enter submitted: the page sent POST /suggestion");
  const resJson = await sent.response.response.json().catch(() => null);
  assert.equal(sent.response.status, 200, `POST /suggestion: ${JSON.stringify(resJson)}`);
  assert.equal(resJson.versionId, "v1");
  const annId = resJson.annId;

  ctx.step("stored: one pending suggestion on v1, the suggester's, from the web, with a generated opener that says the change");
  const ann = await annotationOf(docId, annId);
  assert.deepEqual(
    { exact: ann.anchor.exact, elementId: ann.anchor.elementId, suggestion: ann.suggestion, authorEmail: ann.authorEmail, channel: ann.actor.channel, resolved: ann.resolved },
    { exact: QUOTE, elementId: "sg-1", suggestion: { replacement: REPLACEMENT, state: "pending" }, authorEmail: sugAcct.email, channel: "web", resolved: false },
  );
  const opener = await commentsOf(docId, annId);
  assert.deepEqual(opener.map((c) => ({ body: c.body, opensSuggestion: c.opensSuggestion, generated: c.generated })), [
    { body: describeChange(QUOTE, REPLACEMENT), opensSuggestion: true, generated: true },
  ]);

  ctx.step("the suggester's thread opens, selected, reading as the change");
  const thread = s.thread(QUOTE, { kind: "suggestion" });
  await thread.waitFor({ state: "visible", timeout: SLOW });
  assert.equal(await thread.getAttribute("aria-selected"), "true", "the new thread is selected");
  assert.equal((await thread.locator(".suggestion-change ins").textContent()).trim(), REPLACEMENT);
  assert.equal((await thread.locator(".suggestion-status").textContent()).trim(), STATUS.waiting);

  ctx.step("in every reader's frame: the quote is wrapped segment by segment in mark[data-bshd-sug], only the LAST carries data-bshd-ins, and textContent is what it was");
  for (const u of [s, v, o]) {
    const frame = await u.frame();
    const marks = await eventually(async () => {
      const m = await sugMarks(frame, annId);
      return m.length > 0 ? m : false;
    }, { timeout: SLOW, message: `${u.name}: the suggestion is drawn` });
    ctx.ev.json(`marks-${u.name}`, marks);
    assert.equal(marks.map((m) => m.text).join(""), QUOTE, `${u.name}: the wrappers hold exactly the quote`);
    assert.equal(marks.length, 3, `${u.name}: one wrapper per text node the quote crosses`);
    assert.deepEqual(marks.map((m) => m.ins), [null, null, REPLACEMENT], `${u.name}: data-bshd-ins on the last wrapper only`);
    assert.ok(marks.every((m) => m.ann === annId), `${u.name}: every wrapper names the annotation`);
    assert.deepEqual(await texts(frame, "#sg-1"), before, `${u.name}: the frame's textContent is unchanged by the suggestion`);
  }
  noPageErrors([o, s, v]);
});

// --- A7.2 -------------------------------------------------------------------

scenario("A7.2 a selection across two paragraphs, holding a line break, list or table, or inside a figure is refused on press with its reason and no form; one inside a single list item or table cell is taken", { tiers: BOTH, timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, accounts } = await setup(ctx, { roles: [{ as: "suggester", role: "suggester" }], name: "a72-refuse", title: "A7.2 refusals" });
  const [s] = await browsers(ctx, [accounts[1]], ["suggester"]);
  const posts = capturePosts(s);
  await openDoc(s, docId);

  const cases = [
    { what: "across two paragraphs", from: { sel: "#sg-1", exact: "lazy dog" }, to: { sel: "#sg-2", exact: "A second" }, reason: REASON.across },
    { what: "holding a line break", from: { sel: "#sg-br", exact: "the verse" }, to: { sel: "#sg-br", exact: "second line", occurrence: 0 }, reason: REASON.structure },
    { what: "holding a list", from: { sel: "#sg-listbox", exact: "Before the list" }, to: { sel: "#sg-listbox", exact: "after the list" }, reason: REASON.structure },
    { what: "holding a table", from: { sel: "#sg-tablebox", exact: "Before the table" }, to: { sel: "#sg-tablebox", exact: "after the table" }, reason: REASON.structure },
    { what: "inside a figure (SVG text)", from: { sel: "#sg-svgtext", exact: "label inside" }, to: { sel: "#sg-svgtext", exact: "label inside" }, reason: REASON.figure },
  ];
  const seen = [];
  for (const c of cases) {
    ctx.step(`refused: ${c.what}`);
    const sel = await s.selectBetween(c.from, c.to);
    const labels = await fabLabels(s);
    assert.deepEqual(labels, ["Comment", "Suggest edit"], `${c.what}: the action is offered, not hidden`);
    const mark = s.toastMark();
    // Pressed whatever the button says (refused: null), so a selection taken by mistake is this assertion failing, not the press throwing.
    const press = await s.pressSuggest();
    const said = await toastText(s, mark, (t) => t.text === c.reason).catch((e) => `none: ${e.message}`);
    const formOpen = await popover(s).isVisible();
    seen.push({ what: c.what, via: sel.via, selected: sel.text, refused: press.refused, reason: press.reason, said, formOpen });
    assert.deepEqual({ refused: press.refused, reason: press.reason, said, formOpen }, { refused: true, reason: c.reason, said: c.reason, formOpen: false }, `${c.what}: refused on press with the reason`);
    await (await s.frame()).evaluate(() => getSelection()?.removeAllRanges());
  }
  ctx.ev.json("refusals", seen);

  for (const ok of [
    { what: "inside one list item", sel: "#sg-li", exact: "single list item" },
    { what: "inside one table cell", sel: "#sg-td", exact: "table cell worth" },
  ]) {
    ctx.step(`taken: ${ok.what}`);
    const sel = await s.selectText(ok.sel, ok.exact);
    assert.equal(sel.text, ok.exact);
    const press = await s.pressSuggest();
    assert.deepEqual({ refused: press.refused, reason: press.reason }, { refused: false, reason: null }, `${ok.what}: not marked refused`);
    assert.equal((await openForm(s)).value, ok.exact, `${ok.what}: the form opens on the quote`);
    await s.page.keyboard.press("Escape");
    await popover(s).waitFor({ state: "detached", timeout: 10_000 });
  }

  ctx.step("nothing was sent and nothing stored");
  assert.deepEqual(sentRows(posts), [], "no POST /suggestion");
  assert.deepEqual(await annotationsOf(docId), [], "no annotation on v1");
  noPageErrors([s]);
});

// --- A7.3 -------------------------------------------------------------------

/**
 * Text arriving in the focused field in one insertion, as a paste does: one
 * `input` event carrying the whole string, line break included (Playwright's
 * insertText, CDP Input.insertText). Not the system clipboard: on a headful
 * or new-headless Chrome that can be the machine's own pasteboard, and a test
 * has no business overwriting what somebody copied.
 */
async function pasteInto(u, text) {
  await u.page.keyboard.insertText(text);
}

const NOT_ONE_LINE = Object.freeze([
  ["line feed", "two\nweekends"],
  ["carriage return", "two\rweekends"],
  ["tab", "two\tweekends"],
  ["NUL", "two\u0000weekends"],
  ["unit separator", "two\u001fweekends"],
  ["DEL", "two\u007fweekends"],
  ["left-to-right mark", "two\u200eweekends"],
  ["right-to-left mark", "two\u200fweekends"],
  ["left-to-right embedding", "two\u202aweekends"],
  ["right-to-left override", "two\u202eweekends"],
  ["left-to-right isolate", "two\u2066weekends"],
  ["pop directional isolate", "two\u2069weekends"],
]);

scenario("A7.3 normalisation: a pasted line break becomes a space, Escape cancels, empty suggests a deletion, a replacement equal to its quote is never sent and answers 400, and a line break, tab, control or direction character answers 400", { tiers: BOTH, timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, accounts, others } = await setup(ctx, { roles: [{ as: "suggester", role: "suggester" }], name: "a73-norm", title: "A7.3 normalisation" });
  const [sugSession] = others;
  const [s] = await browsers(ctx, [accounts[1]], ["suggester"]);
  const posts = capturePosts(s);
  await openDoc(s, docId);

  ctx.step('Escape cancels: "lazy dog", type into the form, Escape — the form closes and nothing is sent');
  await s.selectText("#sg-1", "lazy dog");
  await s.pressSuggest({ refused: false });
  await openForm(s);
  await s.page.keyboard.type(" and cat");
  await s.page.keyboard.press("Escape");
  await popover(s).waitFor({ state: "detached", timeout: 10_000 });
  assert.deepEqual(sentRows(posts), [], "Escape sent nothing");

  ctx.step('unchanged: on "harbour lights" the form\'s Suggest button is disabled and Enter leaves the form open (that it sent nothing is counted at the end)');
  await s.selectText("#sg-2", "harbour lights");
  await s.pressSuggest({ refused: false });
  const unchanged = await openForm(s);
  assert.deepEqual({ value: unchanged.value, submitDisabled: unchanged.submitDisabled }, { value: "harbour lights", submitDisabled: true }, "Suggest is disabled while the field equals the quote");
  const unchangedMark = s.toastMark();
  await s.page.keyboard.press("Enter");
  assert.equal((await s.suggestState()).open, true, "the form stays open");

  ctx.step('a pasted line break becomes a space: in the same form, "harbour lights" ← paste "harbour\\nbeacons"');
  await s.page.keyboard.press("ControlOrMeta+A");
  await s.page.keyboard.press("Delete");
  await pasteInto(s, "harbour\nbeacons");
  assert.equal((await s.suggestState()).value, "harbour beacons", "the field holds a space, not a line break");
  let mark = s.responseMark();
  await s.page.keyboard.press("Enter");
  let res = await suggestionAnswer(s, mark);
  assert.equal(res.status, 200);
  const pastedId = (await res.response.json()).annId;
  await popover(s).waitFor({ state: "detached", timeout: SLOW });

  ctx.step('empty suggests deleting: "really " in #sg-3, field cleared, the hint says so, Enter');
  await s.selectText("#sg-3", "really");
  await s.pressSuggest({ refused: false });
  await openForm(s);
  await s.page.keyboard.press("ControlOrMeta+A");
  await s.page.keyboard.press("Delete");
  const emptied = await s.suggestState();
  assert.deepEqual({ value: emptied.value, hint: emptied.hint }, { value: "", hint: "Left empty, this suggests deleting it." });
  mark = s.responseMark();
  await s.page.keyboard.press("Enter");
  res = await suggestionAnswer(s, mark);
  assert.equal(res.status, 200);
  const deleteId = (await res.response.json()).annId;
  await popover(s).waitFor({ state: "detached", timeout: SLOW });

  ctx.step("stored: the pasted one with a space; the deletion with an empty replacement and an opener that says deleting");
  const pasted = await annotationOf(docId, pastedId);
  assert.deepEqual({ exact: pasted.anchor.exact, replacement: pasted.suggestion.replacement }, { exact: "harbour lights", replacement: "harbour beacons" });
  const del = await annotationOf(docId, deleteId);
  assert.deepEqual({ exact: del.anchor.exact, replacement: del.suggestion.replacement, state: del.suggestion.state }, { exact: "really", replacement: "", state: "pending" });
  assert.deepEqual((await commentsOf(docId, deleteId)).map((c) => c.body), [describeChange("really", "")]);
  const delThread = s.thread("really", { kind: "suggestion" });
  await delThread.waitFor({ state: "visible", timeout: SLOW });
  assert.equal((await delThread.locator(".suggestion-delete").textContent()).trim(), "(delete)", "the panel reads it as a deletion");
  const delMarks = await eventually(async () => {
    const m = await sugMarks(await s.frame(), deleteId);
    return m.length ? m : false;
  }, { timeout: SLOW, message: "the deletion is drawn" });
  assert.deepEqual(delMarks.map((m) => [m.text, m.ins]), [["really", null]], "a deletion is struck with nothing inserted");

  ctx.step("the endpoint: equal to its quote is 400; every line break, tab, control or direction character is 400, on create and on revise");
  const anchor = anchorIn(TEXT["sg-4"], "sg-4", "kept short");
  const same = await create(sugSession, docId, { anchor, replacement: "kept short" });
  assert.deepEqual({ status: same.status, error: same.json?.error, cache: same.cacheControl }, { status: 400, error: SERVER.same, cache: "private, no-store" });
  const answers = [];
  for (const [what, replacement] of NOT_ONE_LINE) {
    const r = await create(sugSession, docId, { anchor, replacement });
    answers.push({ what, status: r.status, error: r.json?.error });
  }
  ctx.ev.json("create-answers", answers);
  assert.deepEqual(answers.filter((a) => a.status !== 400 || a.error !== SERVER.oneLine), [], "create: each refused with 400 and the one-line reason");
  const revises = [];
  for (const [what, replacement] of NOT_ONE_LINE) {
    const r = await post(sugSession, { op: "revise", docId, versionId: "v1", annId: pastedId, replacement });
    revises.push({ what, status: r.status, error: r.json?.error });
  }
  assert.deepEqual(revises.filter((a) => a.status !== 400 || a.error !== SERVER.oneLine), [], "revise: each refused with 400 and the one-line reason");

  ctx.step("the form sent exactly two requests (the unchanged Enter sent none), raised no error, and only those two were stored; a refused revise changed nothing");
  assert.deepEqual(sentRows(posts), [{ op: "create", status: 200 }, { op: "create", status: 200 }], "two POST /suggestion from the form, both creates, both 200");
  assert.deepEqual(s.log.toasts.slice(unchangedMark).filter((t) => t.kind === "error").map((t) => t.text), [], "no error toast");
  assert.deepEqual((await annotationsOf(docId)).map((a) => a.id).sort(), [pastedId, deleteId].sort());
  assert.equal((await annotationOf(docId, pastedId)).suggestion.revisions, undefined, "no refused revise was recorded");
  noPageErrors([s]);
});

// --- A7.3b ------------------------------------------------------------------

/** One-line breakers SPEC §2/§22 forbid that the A7.3 list does not cover. */
const NOT_ONE_LINE_MORE = Object.freeze([
  ["line separator U+2028", "two\u2028weekends"],
  ["paragraph separator U+2029", "two\u2029weekends"],
  ["next line U+0085 (a C1 control)", "two\u0085weekends"],
]);

scenario("A7.3b a replacement holding a line separator, a paragraph separator or a C1 control (NEL) answers 400 like any other line break or control character, on create and on revise", { tiers: BOTH, defect: "X-a07-suggestions-1", timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, others } = await setup(ctx, { roles: [{ as: "suggester", role: "suggester" }], name: "a73b-seps", title: "A7.3b separators" });
  const [sugSession] = others;
  const anchor = anchorIn(TEXT["sg-4"], "sg-4", "kept short");
  ctx.step("positive controls: an ordinary line feed is refused by the same endpoint, on create and on revise; a plain suggestion to revise is taken");
  const lf = await create(sugSession, docId, { anchor, replacement: "kept\nshort" });
  precondition(lf.status === 400 && lf.json?.error === SERVER.oneLine, `a line feed answered ${lf.status} ${JSON.stringify(lf.json)}`);
  const base = await createOk(ctx, sugSession, docId, { anchor: anchorIn(TEXT["sg-2"], "sg-2", "harbour lights"), replacement: "harbour beacons" });
  const lfRevise = await post(sugSession, { op: "revise", docId, versionId: "v1", annId: base, replacement: "harbour\nbeacons" });
  precondition(lfRevise.status === 400 && lfRevise.json?.error === SERVER.oneLine, `a line feed revise answered ${lfRevise.status} ${JSON.stringify(lfRevise.json)}`);
  const answers = [];
  for (const [what, replacement] of NOT_ONE_LINE_MORE) {
    const c = await create(sugSession, docId, { anchor, replacement });
    answers.push({ op: "create", what, status: c.status, error: c.json?.error ?? null });
    const r = await post(sugSession, { op: "revise", docId, versionId: "v1", annId: base, replacement: `harbour${replacement.slice(3, -8)}beacons` });
    answers.push({ op: "revise", what, status: r.status, error: r.json?.error ?? null });
  }
  ctx.ev.json("answers", answers);
  const stored = await annotationsOf(docId);
  const extra = stored.filter((a) => a.id !== base);
  const revised = (await annotationOf(docId, base)).suggestion;
  ctx.ev.json("stored", {
    created: extra.map((a) => ({ id: a.id, replacement: [...String(a.data.suggestion?.replacement)].map((ch) => (ch.charCodeAt(0) > 126 || ch.charCodeAt(0) < 32 ? `U+${ch.charCodeAt(0).toString(16).padStart(4, "0")}` : ch)).join("") })),
    revisions: (revised.revisions ?? []).length,
  });
  ctx.step(`answers: ${JSON.stringify(answers.map((a) => [a.op, a.what, a.status]))}; created ${extra.length}, revisions ${(revised.revisions ?? []).length}`);
  assert.deepEqual(
    answers.map((a) => ({ op: a.op, what: a.what, status: a.status, error: a.error })),
    NOT_ONE_LINE_MORE.flatMap(([what]) => ["create", "revise"].map((op) => ({ op, what, status: 400, error: SERVER.oneLine }))),
    "each refused with 400 and the one-line reason",
  );
  assert.deepEqual({ created: extra.length, revisions: (revised.revisions ?? []).length }, { created: 0, revisions: 0 }, "nothing stored");
});

// --- A7.4 -------------------------------------------------------------------

scenario("A7.4 revisions: an Edit in the panel reads Changed once, twenty changes keep every earlier text, the twenty-first is 409 in the API and in the form, and the panel says Changed 20 times", { tiers: BOTH, timeoutMs: HEAVY_CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, accounts, others } = await setup(ctx, { roles: [{ as: "suggester", role: "suggester" }], name: "a74-revise", title: "A7.4 revisions" });
  const [sugSession] = others;
  const QUOTE = "lanterns and harbour lights";
  const r = (i) => `lanterns and beacons, take ${i}`;
  const annId = await createOk(ctx, sugSession, docId, { anchor: anchorIn(TEXT["sg-2"], "sg-2", QUOTE), replacement: r(0) });

  ctx.step("the author opens the panel and changes it once with Edit: the form is prefilled with the current text; Save; it reads Changed once");
  const [s] = await browsers(ctx, [accounts[1]], ["suggester"]);
  await openDoc(s, docId);
  await s.openComments({ timeout: SLOW });
  const thread = s.thread(QUOTE, { kind: "suggestion" });
  await thread.waitFor({ state: "visible", timeout: SLOW });
  await thread.getByRole("button", { name: "Edit", exact: true }).click();
  const form = thread.locator("form.suggest-form textarea");
  await form.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await form.inputValue(), r(0), "the Edit form starts from the current replacement");
  await form.press("ControlOrMeta+A");
  await s.page.keyboard.type(r(1));
  await form.press("Enter");
  await thread.locator(".suggestion-history summary").waitFor({ state: "visible", timeout: SLOW });
  assert.equal((await thread.locator(".suggestion-history summary").textContent()).trim(), "Changed once");
  const once = await annotationOf(docId, annId);
  assert.deepEqual({ replacement: once.suggestion.replacement, kept: once.suggestion.revisions.map((x) => x.replacement), channel: once.suggestion.revisions[0].actor.channel }, { replacement: r(1), kept: [r(0)], channel: "web" });

  ctx.step("nineteen more through POST /suggestion revise, each 200 pending");
  for (let i = 2; i <= 20; i += 1) {
    const a = await reviseOk(ctx, sugSession, docId, annId, r(i));
    assert.deepEqual({ i, status: a.status, json: a.json }, { i, status: 200, json: { state: "pending" } });
  }
  ctx.step("the twenty-first is 409 and changes nothing");
  const over = await post(sugSession, { op: "revise", docId, versionId: "v1", annId, replacement: r(21) });
  assert.deepEqual({ status: over.status, error: over.json?.error }, { status: 409, error: SERVER.revisionLimit }, "the twenty-first change is refused");
  const stored = await annotationOf(docId, annId);
  assert.equal(stored.suggestion.replacement, r(20), "the twentieth change stands");
  assert.deepEqual(stored.suggestion.revisions.map((x) => x.replacement), Array.from({ length: 20 }, (_, i) => r(i)), "revisions holds the 20 texts each change replaced, oldest first");
  assert.ok(stored.suggestion.revisions.every((x) => x.actor?.email === accounts[1].email && !("tokenId" in (x.actor ?? {}))), "each revision names its author and no token");
  assert.deepEqual((await commentsOf(docId, annId)).map((c) => c.body), [describeChange(QUOTE, r(20))], "the generated opener follows the latest text");

  ctx.step("the panel says Changed 20 times; a twenty-first Edit there is refused with the reason and the form stays open");
  await eventually(async () => (await thread.locator(".suggestion-history summary").textContent()).trim() === "Changed 20 times", { timeout: SLOW, message: 'the panel reads "Changed 20 times"' });
  await thread.getByRole("button", { name: "Edit", exact: true }).click();
  await form.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await form.inputValue(), r(20));
  await form.press("ControlOrMeta+A");
  await s.page.keyboard.type(r(21));
  const mark = s.toastMark();
  const sentAt = s.responseMark();
  await form.press("Enter");
  await suggestionAnswer(s, sentAt); // a cut-off is the stack not answering, not a refusal to read
  const said = await toastText(s, mark, (t) => t.kind === "error", SLOW);
  assert.equal(said, SERVER.revisionLimit, "the form says why");
  assert.equal(await form.isVisible(), true, "the form stays open with what was typed");
  assert.equal(await form.inputValue(), r(21));
  assert.equal((await annotationOf(docId, annId)).suggestion.revisions.length, 20, "still 20");
  noPageErrors([s]);
});

// --- A7.5 -------------------------------------------------------------------

scenario("A7.5 withdraw: only its author may; it is withdrawn and resolved with the note Withdrawn., its quote and text kept; again is idempotent; it cannot be changed after; an author who may no longer suggest may still withdraw but not change", { tiers: BOTH, timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, owner, accounts, others } = await setup(ctx, {
    roles: [{ as: "suggester", role: "suggester" }, { as: "other", role: "suggester" }],
    name: "a75-withdraw",
    title: "A7.5 withdraw",
  });
  const [sugSession, otherSession] = others;
  const sugAcct = accounts[1];
  const A = { quote: "quick brown fox", replacement: "quick red fox" };
  const B = { quote: "really quite", replacement: "truly" };
  const annA = await createOk(ctx, sugSession, docId, { anchor: anchorIn(TEXT["sg-1"], "sg-1", A.quote), replacement: A.replacement });
  const annB = await createOk(ctx, sugSession, docId, { anchor: anchorIn(TEXT["sg-3"], "sg-3", B.quote), replacement: B.replacement });

  ctx.step("another suggester may neither withdraw nor change it: 403");
  const w403 = await post(otherSession, { op: "withdraw", docId, versionId: "v1", annId: annA });
  const r403 = await post(otherSession, { op: "revise", docId, versionId: "v1", annId: annA, replacement: "quick grey fox" });
  assert.deepEqual([w403.status, w403.json?.error, r403.status, r403.json?.error], [403, SERVER.notAuthorWithdraw, 403, SERVER.notAuthorChange]);

  ctx.step("the author presses Withdraw in the panel");
  const [s] = await browsers(ctx, [sugAcct], ["suggester"]);
  await openDoc(s, docId);
  await eventually(async () => (await sugMarks(await s.frame(), annA)).length > 0, { timeout: SLOW, message: "A is drawn before it is withdrawn" });
  await s.openComments({ timeout: SLOW });
  const thread = s.thread(A.quote, { kind: "suggestion" });
  await thread.waitFor({ state: "visible", timeout: SLOW });
  await thread.getByRole("button", { name: "Withdraw", exact: true }).click();
  const withdrawn = await eventually(async () => {
    const a = await annotationOf(docId, annA);
    return a?.suggestion?.state === "withdrawn" ? a : false;
  }, { timeout: SLOW, message: "A is withdrawn" });

  ctx.step("stored: withdrawn by its author, resolved, quote and replacement kept; the thread holds the opener and one note, Withdrawn.");
  assert.deepEqual(
    { state: withdrawn.suggestion.state, replacement: withdrawn.suggestion.replacement, decidedBy: withdrawn.suggestion.decidedBy?.email, resolved: withdrawn.resolved, exact: withdrawn.anchor.exact },
    { state: "withdrawn", replacement: A.replacement, decidedBy: sugAcct.email, resolved: true, exact: A.quote },
  );
  const notes1 = await commentsOf(docId, annA);
  assert.deepEqual(notes1.map((c) => ({ body: c.body, author: c.authorEmail, generated: c.generated ?? false, opens: c.opensSuggestion ?? false })), [
    { body: describeChange(A.quote, A.replacement), author: sugAcct.email, generated: true, opens: true },
    { body: "Withdrawn.", author: sugAcct.email, generated: true, opens: false },
  ]);
  ctx.step("no longer drawn (a withdrawn suggestion is resolved), while B still is");
  await eventually(async () => (await sugMarks(await s.frame(), annA)).length === 0, { timeout: SLOW, message: "A is no longer drawn" });
  assert.ok((await sugMarks(await s.frame(), annB)).length > 0, "B is still drawn");

  ctx.step("withdrawing again is 200 withdrawn and writes nothing; changing it now is 409");
  const again = await post(sugSession, { op: "withdraw", docId, versionId: "v1", annId: annA });
  assert.deepEqual({ status: again.status, json: again.json }, { status: 200, json: { state: "withdrawn" } });
  const after2 = await annotationOf(docId, annA);
  assert.equal(after2.suggestion.decidedAt?.toMillis?.(), withdrawn.suggestion.decidedAt?.toMillis?.(), "decidedAt untouched");
  assert.equal((await commentsOf(docId, annA)).filter((c) => c.body === "Withdrawn.").length, 1, "still one Withdrawn. note");
  const late = await post(sugSession, { op: "revise", docId, versionId: "v1", annId: annA, replacement: "quick grey fox" });
  assert.deepEqual({ status: late.status, error: late.json?.error, state: late.json?.state }, { status: 409, error: SERVER.withdrawn, state: "withdrawn" });

  ctx.step("the owner makes the author a viewer: B can be withdrawn, not changed");
  await grant(ctx, { owner, docId, account: sugAcct, role: "viewer" });
  const changeB = await post(sugSession, { op: "revise", docId, versionId: "v1", annId: annB, replacement: "genuinely" });
  assert.deepEqual({ status: changeB.status, error: changeB.json?.error }, { status: 403, error: SERVER.noLongerSuggester });
  const withdrawB = await post(sugSession, { op: "withdraw", docId, versionId: "v1", annId: annB });
  assert.deepEqual({ status: withdrawB.status, json: withdrawB.json }, { status: 200, json: { state: "withdrawn" } });
  assert.equal((await annotationOf(docId, annB)).suggestion.state, "withdrawn");
  noPageErrors([s]);
});

// --- A7.6 -------------------------------------------------------------------

scenario("A7.6 twenty pending suggestions per author per version: the twenty-first is 409 You already have 20… in the API and in the form, which stays open; another author is not held back; withdrawing one frees a slot", { tiers: BOTH, timeoutMs: HEAVY_CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, accounts, others } = await setup(ctx, {
    roles: [{ as: "suggester", role: "suggester" }, { as: "other", role: "suggester" }],
    fixture: "crdt-paragraphs.html",
    name: "a76-limit",
    title: "A7.6 pending limit",
  });
  const [sugSession, otherSession] = others;
  const paras = paragraphsText();
  const at = (i) => anchorIn(paras[`e2e-${i}`], `e2e-${i}`, `Paragraph ${i}`);

  ctx.step("the suggester leaves twenty, one per paragraph 1–20");
  const ids = [];
  for (let i = 1; i <= 20; i += 1) ids.push(await createOk(ctx, sugSession, docId, { anchor: at(i), replacement: `Section ${i}` }));
  ctx.step("the twenty-first, on paragraph 21, is 409 with the reason");
  const over = await create(sugSession, docId, { anchor: at(21), replacement: "Section 21" });
  assert.deepEqual({ status: over.status, error: over.json?.error }, { status: 409, error: SERVER.pendingLimit }, "the twenty-first pending suggestion is refused");
  const pendingBy = async (email) => (await annotationsOf(docId)).filter((a) => a.data.authorEmail === email && a.data.suggestion?.state === "pending").length;
  assert.equal(await pendingBy(accounts[1].email), 20, "twenty pending, not twenty-one");

  ctx.step("the same in the form: select Paragraph 22, Suggest edit, type, Enter — the error says why and the form keeps what was typed");
  const [s] = await browsers(ctx, [accounts[1]], ["suggester"]);
  await openDoc(s, docId);
  await s.selectText('[id="e2e-22"]', "Paragraph 22");
  await s.pressSuggest({ refused: false });
  await openForm(s);
  await s.page.keyboard.type(" (renamed)");
  const mark = s.toastMark();
  const sentAt = s.responseMark();
  await s.page.keyboard.press("Enter");
  assert.equal((await suggestionAnswer(s, sentAt)).status, 409);
  assert.equal(await toastText(s, mark, (t) => t.kind === "error", SLOW), SERVER.pendingLimit, "the form says why");
  const kept = await s.suggestState();
  assert.deepEqual({ open: kept.open, value: kept.value }, { open: true, value: "Paragraph 22 (renamed)" }, "the form stays open with what was typed");

  ctx.step("another suggester is not held back by the first one's twenty");
  const theirs = await create(otherSession, docId, { anchor: at(23), replacement: "Section 23" });
  assert.equal(theirs.status, 200, JSON.stringify(theirs.json));

  ctx.step("withdrawing one of the twenty frees a slot: paragraph 21 is then taken");
  const { out: w, landed: wLanded } = await untilLanded(ctx, `POST /suggestion withdraw ${ids[0]}`, () => post(sugSession, { op: "withdraw", docId, versionId: "v1", annId: ids[0] }), async () => (await annotationOf(docId, ids[0]))?.suggestion?.state === "withdrawn", patience(ctx));
  precondition(wLanded || w.status === 200, `withdraw: ${w?.status}`);
  const retry = await create(sugSession, docId, { anchor: at(21), replacement: "Section 21" });
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  assert.equal(await pendingBy(accounts[1].email), 20, "twenty pending again");
  noPageErrors([s]);
});

// --- A7.7 -------------------------------------------------------------------

scenario("A7.7 a suggestion on a version that is no longer current is 409 with currentVersion and writes nothing; reading the old version offers no write actions, the head offers Suggest edit", { tiers: BOTH, timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, owner, accounts, others } = await setup(ctx, { roles: [{ as: "suggester", role: "suggester" }], name: "a77-version", title: "A7.7 versions" });
  const [sugSession] = others;
  ctx.step("the owner publishes v2 over v1");
  const body = suggestionDoc({ title: "A7.7 versions", sg1: "The quick <em>brown</em> fox jumps over the lazy dog near the old riverbank." });
  const { out: v2, landed: v2Landed } = await untilLanded(ctx, "POST /publish?update (v2)", () => updateUpload(owner.http, docId, { body, baseVersion: "v1", timeoutMs: HTTP_MS }), async () => {
    const d = await readDoc(target, `docs/${docId}`);
    return d?.currentVersion === "v2" ? { versionId: "v2" } : null;
  }, patience(ctx));
  precondition(v2Landed || (v2.status === 200 && v2.json?.versionId === "v2"), `update: ${v2?.status} ${JSON.stringify(v2?.json)}`);

  ctx.step("a suggestion on v1 is 409 naming v2, and nothing is written on v1");
  const anchor = anchorIn(TEXT["sg-3"], "sg-3", "really quite");
  const stale = await create(sugSession, docId, { anchor, replacement: "truly", versionId: "v1" });
  assert.deepEqual({ status: stale.status, json: stale.json }, { status: 409, json: { error: SERVER.newer, currentVersion: "v2" } });
  assert.deepEqual(await annotationsOf(docId, "v1"), [], "no annotation on v1");
  const fresh = await create(sugSession, docId, { anchor, replacement: "truly", versionId: "v2" });
  assert.deepEqual({ status: fresh.status, versionId: fresh.json?.versionId }, { status: 200, versionId: "v2" });

  ctx.step("in the app: reading v1 the toolbar offers no write actions; on the head it offers Suggest edit");
  const [o, s] = await browsers(ctx, [accounts[0], accounts[1]], ["owner", "suggester"]);
  await openDoc(o, docId, { v: "v1" });
  assert.equal(await o.page.getByRole("button", { name: "Edit", exact: true }).count(), 0, "even the owner cannot edit the archive");
  await openDoc(o, docId);
  await o.page.getByRole("button", { name: "Edit", exact: true }).waitFor();
  await openDoc(s, docId, { v: "v1" });
  await s.selectText("#sg-2", "harbour lights", { fab: false });
  await s.page.getByRole("button", { name: "Open latest", exact: true }).waitFor();
  assert.equal(await s.page.getByRole("button", { name: "Comment", exact: true }).count(), 0);
  const onOld = [];
  await openDoc(s, docId);
  await s.selectText("#sg-2", "harbour lights");
  const onHead = await fabLabels(s);
  assert.deepEqual({ onOld, onHead }, { onOld: [], onHead: ["Comment", "Suggest edit"] });
  noPageErrors([o, s]);
});

// --- A7.8 -------------------------------------------------------------------

scenario("A7.8 a suggestion quoting text only the draft holds is drawn for the editor reading the draft and listed as stale, undrawn, for a reader of the published version", { tiers: BOTH, timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, accounts, others } = await setup(ctx, {
    roles: [{ as: "editor", role: "editor" }, { as: "reader", role: "suggester" }],
    name: "a78-stale",
    title: "A7.8 stale",
  });
  const [editorSession] = others;
  const DRAFT_ONLY = "sleepy cat";
  const REPLACEMENT = "drowsy cat";
  ctx.step(`the editor saves a draft of v1 that adds "${DRAFT_ONLY}" to #sg-1 (POST /draft)`);
  const html = suggestionDoc({ title: "A7.8 stale", sg1: `The quick <em>brown</em> fox jumps over the lazy dog and a ${DRAFT_ONLY} near the riverbank.` });
  // functions/src/lib/draft.ts writeDraft records {baseVersion, bytes} on the document once the bytes are stored: the effect looked for before sending it again.
  const { out: saved, landed: draftLanded } = await untilLanded(ctx, "POST /draft", () => editorSession.http.postJson("/draft", { docId, baseVersion: "v1", html }), async () => {
    const d = await readDoc(target, `docs/${docId}`);
    return d?.draft?.baseVersion === "v1" && d.draft.bytes === Buffer.byteLength(html, "utf8");
  }, patience(ctx));
  precondition(draftLanded || saved.status === 200, `POST /draft: ${saved?.status} ${saved?.text?.slice(0, 200)}`);

  const [e, r] = await browsers(ctx, [accounts[1], accounts[2]], ["editor", "reader"]);
  await Promise.all([openDoc(e, docId), openDoc(r, docId)]);
  precondition((await frameText(await e.frame(), { withoutOwn: true })).includes(DRAFT_ONLY), "the editor reads the draft on the head");
  precondition(!(await frameText(await r.frame(), { withoutOwn: true })).includes(DRAFT_ONLY), "the reader reads the published v1");

  ctx.step(`the editor, reading the draft, selects "${DRAFT_ONLY}" and suggests "${REPLACEMENT}"`);
  await e.selectText("#sg-1", DRAFT_ONLY);
  await e.pressSuggest({ refused: false });
  await openForm(e);
  await e.page.keyboard.press("ControlOrMeta+A");
  await e.page.keyboard.type(REPLACEMENT);
  const sentAt = e.responseMark();
  await e.page.keyboard.press("Enter");
  const res = await suggestionAnswer(e, sentAt);
  assert.equal(res.status, 200);
  const { annId, versionId } = await res.response.json();
  assert.equal(versionId, "v1", "recorded against the published head");
  assert.equal((await annotationOf(docId, annId)).anchor.exact, DRAFT_ONLY);

  ctx.step("the editor: drawn in the draft, and pending — not stale — in the panel");
  const drawn = await eventually(async () => {
    const m = await sugMarks(await e.frame(), annId);
    return m.length ? m : false;
  }, { timeout: SLOW, message: "drawn for the editor" });
  assert.deepEqual(drawn.map((m) => [m.text, m.ins]), [[DRAFT_ONLY, REPLACEMENT]]);
  const eThread = e.thread(DRAFT_ONLY, { kind: "suggestion" });
  await eThread.waitFor({ state: "visible", timeout: SLOW });
  assert.deepEqual(
    { stale: await eThread.locator(".suggestion").getAttribute("data-stale"), status: (await eThread.locator(".suggestion-status").textContent()).trim() },
    { stale: null, status: STATUS.waiting },
  );

  ctx.step("the reader of v1: listed as stale with the reason, and drawn nowhere in the frame");
  await r.openComments({ timeout: SLOW });
  const rThread = r.thread(DRAFT_ONLY, { kind: "suggestion" });
  await rThread.waitFor({ state: "visible", timeout: SLOW });
  await eventually(async () => {
    const got = { stale: await rThread.locator(".suggestion").getAttribute("data-stale"), status: (await rThread.locator(".suggestion-status").textContent()).trim() };
    assert.deepEqual(got, { stale: "true", status: STATUS.stale }, "the reader is told it is stale");
    return true;
  }, { timeout: SLOW, message: "the reader's panel calls it stale" });
  assert.deepEqual(await sugMarks(await r.frame(), annId), [], "not drawn for the reader");
  noPageErrors([e, r]);
});
