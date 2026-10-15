// SPDX-License-Identifier: Apache-2.0
// C10a, C10b, C10c: N accepts at once (agents on different suggestions, approvers in the app, N on one suggestion) and their serial positive controls (SPEC §22, §6a, §16).

/**
 * Every case stages its own document: the fixture's p#e2e-1..N, an owner
 * (p1) and N−1 approvers (p2…pN), and a suggester who makes the pending
 * suggestions over POST /suggestion before anybody decides (one per
 * paragraph: the 5th and 6th words of #e2e-k become a unique replacement).
 * Every account is cast with email notifications off, and the document is
 * checked quiet (owner, approvers and comment authors all run accounts
 * opted out) before anybody decides, since every decision writes a note.
 * The grants go through live.mjs grantEditors (agents) or joinShared
 * (approvers in the app, the suggester an extra with no browser): one
 * POST /access on a local stack, the operator script elsewhere, so no case
 * sends email on production. The SYNC-T agent fire is syncHttp with the
 * target (isolation and the production guard before any worker starts).
 * A case is LOCAL only for what only a local stack has: the amplify set's
 * pause points (C10a gated, C10c claim-gated) and the RTDB proxy (C10b slow
 * link, C10c in the app).
 *
 * I8 on a draft (i8Of) is "accepted ⊆ draft, exactly once, in place":
 * invariants.mjs checkI8, given the draft's HTML and each accepted change's
 * paragraph, its text before and its quote, counts each replacement in the
 * draft's text, and each found once must also stand in its own paragraph in
 * place of its quote (SPEC §22: the source bytes of that text replaced, the
 * old text with that one span replaced), so a replacement put beside a kept
 * quote, or in another paragraph, fails it (controls-c10-i8-in-place).
 *
 *   C10a      N agents (each approver's own MCP token) accept N DIFFERENT
 *             suggestions at once. Variants: SYNC-T (N worker threads fire
 *             the N accept_suggestion calls within 15 ms, each socket warmed
 *             on a static file, and every call is on the wire before any
 *             answer begins: overlap proof) and GATED (amplify-c10-accept:
 *             every accept is held at `accept-after-read`, past its read of
 *             the working copy and before its claim, then all are released
 *             together). WORK: every agent is told "accepted", each
 *             suggestion is accepted once, by its own agent, with one
 *             "Accepted." note. JUDGE (S5): I8. S5 predicts an absence: an
 *             accepted change missing from the draft, its paragraph as v1
 *             had it. Any other shape (a replacement twice, one out of
 *             place: checkI8's shape "other") is no defect S5 names and FAILS
 *             the judge as a plain error (assertPredictedShape), never
 *             "failed as expected".
 *   C10a-serial  the same N accepts one after another: I8 and I9 must hold.
 *             S5's positive control, and the target of
 *             controls-c10-i8-unwritten and controls-c10-i8-in-place.
 *   C10b      N approvers in the editor, joined live, each in the review pass
 *             on its own suggestion, press Accept. Variants: SYNC-T (pressed
 *             in every page within 40 ms), SLOW LINK (LOCAL: pressed within
 *             40 ms with the live link slowed by the RTDB proxy, 1.5 s each
 *             way, past the autosave's 1 s debounce, until every page's own
 *             saves are done, then set back before the settle: the natural
 *             S17 path, with no request held) and HELD SAVE (SYNC-H: p1's
 *             accept save is held in its browser while p2…pN accept and
 *             their saves land, then let go: an earlier snapshot arriving
 *             last). WORK: every claim, save and accept answered 200, each
 *             suggestion accepted by its page's approver with one note, the
 *             live session settles (settleLive: I1, saves quiet, y stable)
 *             and every paragraph reads its replacement once in every peer.
 *             JUDGE: I8 on the draft. SYNC-T and SLOW LINK also record the
 *             SAVE RACE (saveRace: every page's POST /draft bodies, which
 *             replacements each holds, when it was sent and answered, and
 *             which match the draft); their judge is INCONCLUSIVE, "race not
 *             achieved", unless at least two pages' accept saves were each
 *             serialized without the other's replacement, since otherwise
 *             every later snapshot holds the earlier edits and a pass says
 *             nothing about S17. Locally the SYNC-T saves seldom race (the
 *             live link outruns the claims' jitter, even with the
 *             functions' workers warmed first: 1 of 4 trials at N=2), and
 *             when they did, each page's autosave a second after its own
 *             edit carried the other's change and landed last; the slow
 *             link races every time. S17 predicts the held save, and the
 *             slow link's last-landing save, drop the others' accepts from
 *             the draft: a page saves only on a timer its own input started
 *             (useInlineEditor.ts), so a change it receives after its last
 *             such save is never saved by it.
 *   C10b-serial  the approvers accept one after another, each waiting for its
 *             change at every peer and its autosave: I8 and I9 must hold.
 *             S17's positive control; C10b-serial (slow link) is the same
 *             with the link slowed throughout, the slow variant's.
 *   C10c      N approvers accept ONE suggestion. I9: one insertion (in the
 *             live document for the app, in the draft for agents) and one
 *             decision note, and every loser refused; I8 on the draft.
 *             Agents: SYNC-T (as C10a), and CLAIM-GATED (amplify-c10-accept:
 *             whichever takes the claim is held at `accept-after-claim`, so
 *             every other call is decided while that claim is live). For
 *             agents, I9 also has ONE WRITER (checkOneWriter): only the claim
 *             holder writes the draft, so it is last written by the decider.
 *             Counting cannot see a second agent applying the change (each
 *             writes the whole file from the same working copy, so one
 *             insertion, and an accept once decided is idempotent, so one
 *             note); the writer can, when its write lands last
 *             (controls-c10-draft-writer). In the
 *             app: SYNC-T (pressed within 40 ms) and HELD ACCEPT (SYNC-H: p1
 *             claims, saves, and its accept request is held in its browser
 *             while p2…pN press Accept together), both with the live link
 *             slowed by the stack's RTDB proxy, 1.5 s each way, so no page
 *             sees another's edit before its own claim answers: the claim is
 *             the only thing keeping a second insertion out. Losers: where
 *             the decision is held back until every other was answered
 *             (claim-gated, held accept) each must be refused 409 naming the
 *             claimer (claimedBy, the plan's I9). Where all race freely, a
 *             loser may also be refused because the suggestion is already
 *             decided ("it has already been accepted", state accepted) or,
 *             for an agent, told the settled outcome: SPEC §2 makes accept
 *             "idempotent once accepted". Measured on the emulator: two
 *             claims at once contend, and the losing transaction is retried
 *             about a second later, after the decision, so free races end
 *             "settled". HELD ACCEPT is the target of
 *             controls-c10-i9-claim-ignored.
 *
 * A failed sync precondition (a fire spread over the limit, an unproven
 * overlap, a gate that never held its callers, a peer never "Shared", a held
 * save that never reached the hold, a save race not achieved) is
 * INCONCLUSIVE, never FAIL. Each judge reads what its work case of the same
 * [N=n] #trial recorded, and is INCONCLUSIVE when that never measured, so a
 * defect's own assertion is the only thing a judge can fail on.
 *
 * Settle: live cases use settleLive (the plan's live conditions and
 * deadlines); agent cases wait for the server's records (each suggestion's
 * state, claim and notes, and the draft's bytes and last writer) to hold
 * still for 10 s (the plan's "server: counts stable for 10 s", lib/assert.mjs
 * settleStill).
 *
 * SPEC §22: "A claim is held by the approver applying it … so two approvers
 * cannot insert the same change twice"; "Accepting is an edit … waits for the
 * draft to save, and only then records the decision … and lands in the
 * draft"; "An agent's accept is the same edit, made in the source"; ADR 0015
 * rejects "recording the decision and trusting the agent to make the edit:
 * an accepted suggestion that never landed would be observable, and
 * unnoticed".
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4 } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { publish, readFixture } from "../../lib/seed.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { eventually, settleStill } from "../../lib/assert.mjs";
import { measure } from "../../lib/evidence.mjs";
import { createGuard } from "../../lib/guard.mjs";
import { overlapProof, requireConclusive, syncHttp, syncPages } from "../../lib/sync.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { rtdbLatency } from "../../lib/proxy.mjs";
import { admitWorkers, staticWarmUrl } from "../../lib/workers.mjs";
import { ACCEPT, parseMcpBody, toolOutcome } from "../../lib/mcp.mjs";
import { assertInvariant, checkI8, checkI9 } from "../../lib/invariants.mjs";
import { grantEditors, joinShared, rssFile, settleLive, startRssSampler } from "../../lib/live.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const FIXTURE = "crdt-paragraphs.html";
const BOTH = ["local", "prod"];
/** Only a local stack has the amplify set's pause points and the RTDB proxy. */
const LOCAL = ["local"];
/** Each work case's measurement row: <invocation>/c10-accepts.jsonl. */
const MEASURE = "c10-accepts";
/** amplify-c10-accept's pause point: functions/src/lib/accept.ts, after the working copy is read and the change made, before the claim. */
const GATE = "accept-after-read";
/** amplify-c10-accept's second pause point: after the claim is taken, before the draft write and the decision. */
const CLAIM_GATE = "accept-after-claim";
const AGENT_MS = 600_000;
const LIVE_MS = 1_200_000;
const JUDGE_MS = 60_000;
/** One request's own deadline: past Hosting's minute, so a stalled one ends in its 504 (INCONCLUSIVE). */
const FN_MS = 120_000;
const PAGE_MS = 60_000;
const CLIENT_MS = 30_000;
/** The plan's server settle: the records hold still this long. */
const SERVER_QUIET_MS = 10_000;
const SERVER_SETTLE_MS = 90_000;
/** C10c in-app: the live link, each way, while Accept is pressed (no page sees another's edit before its claim answers). */
const SLOW_LINK = Object.freeze({ up: 1_500, down: 1_500 });
/** A page's autosave is quiet once it has sent no POST /draft for this long (the debounce is 1 s). */
const SAVE_QUIET_MS = 3_000;
const GB = 1024 ** 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
function occurrences(hay, needle) {
  let n = 0;
  for (let i = String(hay).indexOf(needle); i !== -1; i = String(hay).indexOf(needle, i + 1)) n += 1;
  return n;
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
/** A document's text as the I8 judge reads it: no script or style, no tags (a replacement holds no markup and no entity). */
const textOf = (html) => String(html ?? "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, "");

// --- what the work cases leave for their judges ---------------------------------------------

/** `${ref}|${n}|${trial}` → the observation a work case recorded. */
const observed = new Map();
const keyOf = (ref, ctx) => `${ref}|${ctx.n}|${ctx.trial}`;

function record(ctx, ref) {
  const o = { ref, n: ctx.n, trial: ctx.trial, stage: "started", inconclusive: null };
  observed.set(keyOf(ref, ctx), o);
  return o;
}

function observation(ctx, ref, field) {
  const o = observed.get(keyOf(ref, ctx));
  if (!o) ctx.inconclusive(`the ${ref} work case [N=${ctx.n}] #${ctx.trial} did not run in this process, so there is nothing to judge`);
  if (o.inconclusive) ctx.inconclusive(`the ${ref} work case [N=${ctx.n}] #${ctx.trial} was INCONCLUSIVE: ${o.inconclusive}`);
  if (o[field] == null) ctx.inconclusive(`the ${ref} work case [N=${ctx.n}] #${ctx.trial} stopped (${o.stage}) before it measured ${field}`);
  ctx.ev.json(`observed-${field}`, o[field]);
  return o[field];
}

/** Run a work body; an INCONCLUSIVE it ends in is told to its judge. */
async function working(ctx, ref, body) {
  const obs = record(ctx, ref);
  try {
    return await body(obs);
  } catch (err) {
    if (err?.code === "E2E_INCONCLUSIVE") obs.inconclusive = err.reason ?? err.message;
    throw err;
  }
}

// --- the fixture's quotes ------------------------------------------------------------------

const FIXTURE_TEXT = new Map(
  [...readFixture(FIXTURE, { raw: true }).toString("utf8").matchAll(/<p id="(e2e-\d+)">([^<]*)<\/p>/g)].map((m) => [m[1], m[2]]),
);

/**
 * Paragraph k's quote: its 5th and 6th words, standing once in it, with an
 * anchor as the app's describeAnchorFromRange makes one (the paragraph as
 * root, up to 32 characters of context either side, text offsets). The
 * prefix reaches back to "Paragraph k. ", so quote and context are unique in
 * the document.
 */
function quoteOf(k) {
  const id = `e2e-${k}`;
  const text = FIXTURE_TEXT.get(id);
  precondition(typeof text === "string", `the fixture has #${id}`);
  const words = text.split(" ");
  const exact = words.slice(4, 6).join(" ");
  const start = words.slice(0, 4).join(" ").length + 1;
  precondition(text.indexOf(exact) === start && text.indexOf(exact, start + 1) < 0, `"${exact}" stands once in #${id}`);
  const end = start + exact.length;
  return { k, id, exact, text, anchor: { elementId: id, exact, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32), start, end } };
}

// --- I8 on the draft: once, and in place ------------------------------------------------------

/**
 * I8 over a draft (accepted ⊆ draft, exactly once), judged in place:
 * invariants.mjs checkI8 counts each replacement in the draft's text, and
 * each one found once must also stand in its own paragraph in place of its
 * quote, the paragraph read from the draft's HTML (elementText). SPEC §22:
 * the agent's accept "replaces exactly the source bytes of that text" and
 * keeps it "only if its text is the old text with that one span replaced";
 * the browser's replays the replacement over the quote. So a replacement
 * inserted beside a kept quote, or in another paragraph, is caught (counting
 * alone passes both). `d` is {text, html, accepted}, with `accepted` as
 * acceptedOf makes it: every entry names its paragraph, its text before and
 * its quote, so every entry is judged in place and has a shape.
 */
const i8Of = (d) => checkI8({ draftText: d.text, draftHtml: d.html, accepted: d.accepted });

/** Each accepted suggestion's replacement in a draft, as checkI8's entries tell it: how many times, and "in place", "absent" (its paragraph as v1 had it) or "other". */
const draftShape = (r) => Object.fromEntries(r.entries.map((e) => [e.annId, `×${e.count} ${e.shape}`]));

/**
 * A judge tagged with a suspect that predicts an ABSENCE (S5, S17: a lost
 * update leaves an accepted change out of the draft, its paragraph as it
 * was): every accepted suggestion must be either in place once or absent
 * with its paragraph untouched (checkI8's shapes "in place" and "absent").
 * Any other shape (a replacement twice, one out of place, a paragraph that
 * is neither) is no defect the tag names, so it is thrown as a plain Error,
 * which FAILS the case (lib/test.mjs: only an AssertionError of a defect case
 * is TODO), and never hides as "known defect, failed as expected". `r` is
 * i8Of's result; the judge's I8 assertion runs on it next.
 */
function assertPredictedShape(suspect, r) {
  const off = r.entries
    .filter((e) => e.shape !== "in place" && e.shape !== "absent")
    .map((e) => `${e.annId}: its replacement is in the draft ${e.count} time(s) and #${e.elementId} reads ${e.reads === null ? "(no such paragraph, or more than one)" : JSON.stringify(e.reads)}`);
  if (!off.length) return;
  const err = new Error(`I8, but not as ${suspect} predicts (an accepted change absent from the draft, its paragraph as it was): ${off.join("; ")}`);
  err.code = "E2E_NOT_PREDICTED";
  throw err;
}

// --- staging ---------------------------------------------------------------------------------

/**
 * On a published, shared document: one pending suggestion per k in `ks`,
 * the suggester's, over POST /suggestion; then the quiet-doc check (every
 * decision writes a note, which must reach nobody's inbox on production).
 * Resolves {entry, suggester, suggestions}.
 */
async function stageSuggestions(ctx, { docId, suggesterAcct, ks }) {
  const version = await readDoc(ctx.target, `docs/${docId}/versions/v1`);
  precondition(typeof version?.entry === "string" && version.entry, `v1 names its entry (${JSON.stringify(version?.entry)})`);
  const suggester = await openSession(ctx.target, suggesterAcct, { timeoutMs: FN_MS, cutoffError: true });
  const tag = rand4();
  const suggestions = [];
  for (const k of ks) {
    const q = quoteOf(k);
    const replacement = `c10-${tag}-s${k}-ok`;
    const r = await suggester.http.postJson("/suggestion", { op: "create", docId, versionId: "v1", anchor: q.anchor, replacement }, { timeoutMs: FN_MS });
    precondition(r.status === 200 && typeof r.json?.annId === "string", `POST /suggestion create on #${q.id}: ${r.status} ${JSON.stringify(r.json)}`);
    suggestions.push({ k, id: q.id, annId: r.json.annId, exact: q.exact, text: q.text, replacement });
  }
  const quiet = await createGuard(ctx.target).assertQuietDoc(docId);
  ctx.step(`document ${docId}: ${suggestions.length} pending suggestion(s): ${suggestions.map((s) => `#${s.id} "${s.exact}" → "${s.replacement}"`).join("; ")}; quiet (${quiet.people.length} people a note could reach, every one a run account opted out of email)`);
  return { entry: version.entry, suggester, suggestions };
}

/** Each staged suggestion as checkI8 judges it in place: its paragraph (the anchor's elementId), that paragraph's text in v1, and its quote. */
const acceptedOf = (suggestions) => suggestions.map(({ annId, id, text, exact, replacement }) => ({ annId, replacement, elementId: id, text, exact }));

/**
 * For the agent cases (no browser): an owner (p1) and n−1 approvers, a
 * suggester, one published fixture shared at those roles (grantEditors with
 * one role per account), and stageSuggestions. Notifications are off for
 * everyone.
 */
async function stageDoc(ctx, { n, ks, title }) {
  const names = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  ctx.step(`cast an owner (p1), ${n - 1} approver(s) and a suggester, email notifications off; the owner publishes ${FIXTURE}`);
  const all = await cast(ctx.target, [...names.map((p, i) => (i === 0 ? "owner" : `approver-${p}`)), "suggester"], { http: ctx.http({ actor: "harness" }), notifications: false });
  const accounts = all.slice(0, n);
  const suggesterAcct = all[n];
  const owner = await openSession(ctx.target, accounts[0], { timeoutMs: FN_MS, cutoffError: true });
  const up = await publish(owner.http, { fixture: FIXTURE, title, name: "c10", timeoutMs: FN_MS });
  precondition(up.status === 200 && up.versionId === "v1", `publish answered ${up.status} ${JSON.stringify(up.json)}`);
  const docId = up.docId;
  const grantees = [...accounts.slice(1), suggesterAcct];
  const granted = await grantEditors(ctx.target, { owner, doc: docId, accounts: grantees, roles: [...accounts.slice(1).map(() => "approver"), "suggester"], timeoutMs: FN_MS });
  ctx.step(`shared at approver (${n - 1}) and suggester (1) through ${granted.via === "access" ? "one POST /access" : `${granted.requests} operator script run(s)`}${granted.missing.length ? `; RTDB mirror missing for ${granted.missing.map((m) => m.email).join(", ")} (no agent writes the live log)` : ""}`);
  const staged = await stageSuggestions(ctx, { docId, suggesterAcct, ks });
  return { docId, names, accounts, owner, ...staged };
}

/** Each approver's agent: a session (the owner's is the stage's), an MCP token of its own, and a client on it. */
async function agentsOf(ctx, stage) {
  const out = [];
  for (const [i, acct] of stage.accounts.entries()) {
    const session = i === 0 ? stage.owner : await openSession(ctx.target, acct, { timeoutMs: FN_MS, cutoffError: true });
    const { token } = await mintToken(session, { name: `c10 agent ${stage.names[i]}`, channel: "mcp" });
    out.push({ name: stage.names[i], email: acct.email.toLowerCase(), uid: session.uid, token, mcp: ctx.mcp({ token, actor: `agent-${stage.names[i]}`, timeoutMs: FN_MS, cutoffError: true }) });
  }
  return out;
}

// --- reading the outcome ----------------------------------------------------------------------

const createdMs = (c) => c?.createdAt?.toMillis?.() ?? 0;
const who = (a) => (a ? { uid: a.uid ?? null, email: String(a.email ?? "").toLowerCase(), channel: a.channel ?? null } : null);

/** One suggestion's record and its notes (every comment but the opener), from the Admin SDK. */
async function readSuggestion(t, docId, annId) {
  const a = await readDoc(t, `docs/${docId}/versions/v1/annotations/${annId}`);
  const comments = (await readCollection(t, `docs/${docId}/versions/v1/annotations/${annId}/comments`)).map((r) => r.data).sort((x, y) => createdMs(x) - createdMs(y));
  return {
    annId,
    state: a?.suggestion?.state ?? null,
    resolved: a?.resolved ?? null,
    claim: a?.suggestion?.claim ? who(a.suggestion.claim) : null,
    decidedBy: who(a?.suggestion?.decidedBy),
    notes: comments.filter((c) => !c.opensSuggestion).map((c) => ({ body: c.body ?? null, authorEmail: String(c.authorEmail ?? "").toLowerCase(), generated: c.generated === true, channel: c.actor?.channel ?? null })),
  };
}

/** The draft's entry over GET /draft as the owner reads it (it falls back to v1 where there is no draft), and whether docs/{d}.draft exists. */
async function readDraft(stage) {
  const r = await stage.owner.http.with({ cutoffError: true }).get(`/draft/${encodeURIComponent(stage.docId)}/${stage.entry}`, { timeoutMs: FN_MS });
  precondition(r.status === 200, `GET /draft answered ${r.status}`);
  const meta = await readDoc(target, `docs/${stage.docId}`);
  return { html: r.text, text: textOf(r.text), hash: sha(r.text), hasDraft: Boolean(meta?.draft), updatedByEmail: meta?.draft?.updatedByEmail ?? null };
}

async function readOutcome(stage) {
  const anns = await Promise.all(stage.suggestions.map((s) => readSuggestion(target, stage.docId, s.annId)));
  return { anns, draft: await readDraft(stage) };
}

/**
 * The plan's server settle (lib/assert.mjs settleStill): every suggestion's
 * state, claim and notes, and the draft's bytes and last writer, unchanged
 * for SERVER_QUIET_MS. Running out is E2E_SETTLE_TIMEOUT, a wait, never an
 * assertion.
 */
async function settleServer(ctx, stage) {
  return settleStill(() => readOutcome(stage), {
    quietMs: SERVER_QUIET_MS,
    deadlineMs: SERVER_SETTLE_MS,
    what: "server settle: the suggestions' records and the draft",
    key: (o) => JSON.stringify([o.anns.map((a) => [a.annId, a.state, a.claim?.email ?? null, a.notes.length]), o.draft.hash, o.draft.updatedByEmail]),
    step: ctx.step,
  });
}

// --- agents --------------------------------------------------------------------------------------

/** A syncHttp row of POST /mcp tools/call → {status, isError, text, json}. */
function agentAnswer(row) {
  if (!row || row.error) return { status: null, isError: true, text: `transport: ${row?.error ?? "no result"}`, json: null };
  let messages;
  try {
    messages = parseMcpBody(row.headers?.["content-type"], row.body);
  } catch (e) {
    return { status: row.status, isError: true, text: `unparsable reply: ${e.message}`, json: null };
  }
  const msg = messages[0];
  if (row.status !== 200 || !msg) return { status: row.status, isError: true, text: `HTTP ${row.status} ${String(row.body ?? "").slice(0, 200)}`, json: null };
  if (msg.error) return { status: row.status, isError: true, text: `JSON-RPC ${msg.error.code} ${msg.error.message}`, json: null };
  const out = toolOutcome(msg.result);
  return { status: row.status, isError: out.isError, text: out.text, json: out.json ?? null };
}

/**
 * SYNC-T: `pairs` [{agent, annId}] fired as N accept_suggestion calls from N
 * worker threads at one instant, each on a socket it opened (and warmed, on
 * workers.mjs staticWarmUrl) before the barrier. syncHttp is given the target, so every call and its
 * warm-up passes the isolation check and the production guard before any
 * worker exists, and each is a row in the case's http.jsonl. INCONCLUSIVE
 * unless the spread is within 15 ms and every call was on the wire before
 * any answer began.
 */
async function acceptAtOnce(ctx, docId, pairs) {
  const url = new URL("/mcp", ctx.target.origin).href;
  // A static file opens each racer's socket and starts no Functions-emulator worker (GET /config is a function: N more workers, never reaped).
  const warm = staticWarmUrl(ctx.target);
  const requests = pairs.map(({ agent, annId }, i) => ({
    url,
    method: "POST",
    headers: { authorization: `Bearer ${agent.token}`, accept: ACCEPT, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "accept_suggestion", arguments: { id: docId, threadId: annId } } }),
    warm,
    actor: `agent-${agent.name}`,
  }));
  const run = await syncHttp(requests, { target: ctx.target, timeoutMs: FN_MS });
  precondition(run.guarded === true, "the accept race went through syncHttp's guarded path");
  const timing = run.results.map((r) => ({ i: r.i, status: r.status ?? null, error: r.error ?? null, firedAt: r.firedAt, sentAt: r.sentAt, firstByteAt: r.firstByteAt, endAt: r.endAt }));
  ctx.ev.json("fire", { spreadMs: run.spreadMs, conclusive: run.conclusive, overlap: run.overlap, timing });
  ctx.step(`fired ${pairs.length} accept_suggestion call(s) at once: spread ${run.spreadMs.toFixed(2)} ms; overlap ${run.overlap.ok ? `proven (every call sent ${run.overlap.marginMs.toFixed(1)} ms before the first answer began)` : run.overlap.reason}`);
  requireConclusive(ctx, { spread: run, overlap: run.overlap });
  const t0 = Math.min(...run.results.map((r) => r.sentAt).filter(Number.isFinite));
  const calls = run.results.map((r) => ({ i: r.i, sentMs: Math.round((r.sentAt - t0) * 10) / 10, firstByteMs: Math.round((r.firstByteAt - t0) * 10) / 10 }));
  return { pairs: pairs.map((p, i) => ({ ...p, answer: agentAnswer(run.results.find((r) => r.i === i)) })), race: { kind: "sync-t", spreadMs: run.spreadMs, overlapMarginMs: run.overlap.marginMs, calls } };
}

/**
 * GATED: the N calls sent together, each held at `accept-after-read` (after
 * its read of the working copy, before its claim) until all N are held, then
 * released in one go. INCONCLUSIVE when the gate never holds all N, or when
 * an accept answered while it should have been held.
 */
async function acceptGated(ctx, docId, pairs) {
  const g = gates(ctx.target);
  await g.hold(GATE, { key: docId });
  try {
    const answered = [];
    const pending = pairs.map((p, i) =>
      p.agent.mcp.call("accept_suggestion", { id: docId, threadId: p.annId }).then(
        (out) => (answered.push(i), { status: 200, isError: out.isError, text: out.text, json: out.json ?? null }),
        (err) => (answered.push(i), { thrown: err }),
      ),
    );
    const held = await requireHeld(ctx, g, GATE, pairs.length, { key: docId, timeoutMs: 90_000 });
    ctx.step(`all ${pairs.length} accept(s) are held at ${GATE}, each past its read of the working copy and before its claim (seq ${held.callers.map((c) => c.seq).join(", ")})`);
    await sleep(300);
    if (answered.length) ctx.inconclusive(`the sync precondition did not hold: ${answered.length} accept(s) answered while the pause point should have held them`);
    const rel = await g.release(GATE, { key: docId });
    if (rel.released.length !== pairs.length) ctx.inconclusive(`the sync precondition did not hold: the release let ${rel.released.length} of ${pairs.length} held accept(s) go`);
    ctx.step(`one release let all ${pairs.length} go together`);
    const answers = await Promise.all(pending);
    for (const a of answers) if (a.thrown) throw a.thrown;
    return { pairs: pairs.map((p, i) => ({ ...p, answer: answers[i] })), race: { kind: "gate", held: held.callers.length } };
  } finally {
    await g.release(GATE, { key: docId }).catch(() => undefined);
  }
}

/**
 * CLAIM-GATED (C10c): the N calls sent together; `accept-after-claim` holds
 * whichever takes the claim, after its claim and before its draft write and
 * decision. Every other call is answered while that claim is live (or is
 * held there too, when it also took a claim); then all go. INCONCLUSIVE when
 * nothing is ever held, or the others neither answer nor hold within 60 s.
 */
async function acceptClaimGated(ctx, docId, pairs) {
  const g = gates(ctx.target);
  await g.hold(CLAIM_GATE, { key: docId });
  try {
    const answered = new Map();
    const pending = pairs.map((p, i) =>
      p.agent.mcp.call("accept_suggestion", { id: docId, threadId: p.annId }).then(
        (out) => (answered.set(i, Date.now()), { status: 200, isError: out.isError, text: out.text, json: out.json ?? null }),
        (err) => (answered.set(i, Date.now()), { thrown: err }),
      ),
    );
    await requireHeld(ctx, g, CLAIM_GATE, 1, { key: docId, timeoutMs: 90_000 });
    let heldNow = 0;
    await eventually(async () => {
      heldNow = (await g.counts({ key: docId }))[CLAIM_GATE]?.held ?? 0;
      return answered.size + heldNow >= pairs.length;
    }, { timeout: 60_000, interval: 200, message: "every accept answered or held with a claim" }).catch(() =>
      ctx.inconclusive(`the sync precondition did not hold: within 60 s of a claim being held, ${answered.size} accept(s) answered and ${heldNow} were held, of ${pairs.length}`),
    );
    const answeredWhileHeld = answered.size;
    ctx.step(`${heldNow} accept(s) hold a claim at ${CLAIM_GATE}; ${answeredWhileHeld} answered while it was held`);
    const rel = await g.release(CLAIM_GATE, { key: docId });
    ctx.step(`released ${rel.released.length} held accept(s)`);
    const answers = await Promise.all(pending);
    for (const a of answers) if (a.thrown) throw a.thrown;
    return { pairs: pairs.map((p, i) => ({ ...p, answer: answers[i] })), race: { kind: "claim-gate", heldWithClaim: heldNow, answeredWhileHeld } };
  } finally {
    await g.release(CLAIM_GATE, { key: docId }).catch(() => undefined);
  }
}

/** The serial positive control: each call answered before the next is sent. */
async function acceptSerially(ctx, docId, pairs) {
  const out = [];
  for (const p of pairs) {
    const a = await p.agent.mcp.call("accept_suggestion", { id: docId, threadId: p.annId });
    out.push({ ...p, answer: { status: 200, isError: a.isError, text: a.text, json: a.json ?? null } });
    ctx.step(`${p.agent.name} accepted ${p.annId}: ${a.isError ? `refused: ${a.text}` : JSON.stringify(a.json)}`);
  }
  return { pairs: out, race: { kind: "serial" } };
}

const answerLine = (p) => `${p.agent.name}: ${p.answer.isError ? `refused: ${p.answer.text}` : `state ${p.answer.json?.state}, inDraft ${p.answer.json?.inDraft}`}`;

/** Every agent was told the suggestion it accepted is accepted, in the draft. */
function assertEveryAgentAccepted(fired) {
  const bad = fired.pairs.filter((p) => p.answer.isError || p.answer.json?.state !== "accepted" || p.answer.json?.inDraft !== true);
  assert.deepEqual(bad.map(answerLine), [], "every agent's accept_suggestion answered state accepted, inDraft true");
}

/** Each suggestion accepted, resolved, unclaimed, decided by `by[annId]` on `channel`, with exactly one note: "Accepted." by them. */
function assertDecidedOnce(anns, by, channel) {
  const got = anns.map((a) => ({ annId: a.annId, state: a.state, resolved: a.resolved, claim: a.claim, decidedBy: a.decidedBy && { email: a.decidedBy.email, channel: a.decidedBy.channel }, notes: a.notes.map((x) => `${x.body} (${x.authorEmail}, ${x.channel}${x.generated ? ", generated" : ""})`) }));
  const want = anns.map((a) => ({ annId: a.annId, state: "accepted", resolved: true, claim: null, decidedBy: { email: by[a.annId], channel }, notes: [`Accepted. (${by[a.annId]}, ${channel}, generated)`] }));
  assert.deepEqual(got, want, "each suggestion is accepted once, by the one who accepted it, with one generated note Accepted.");
}

/**
 * C10c's losers: who was not the decider, and how each was answered. SPEC §2
 * and §22 allow two refusals and one report: 409 naming the live claim
 * (claimedBy, the plan's I9 form), a claim refused because the suggestion is
 * already decided ("it has already been accepted", state accepted), and an
 * accept told the settled outcome ("idempotent once accepted"). Anything
 * else is a loser checkI9 fails.
 */
function classifyLoser({ status, error, json, told }, winnerEmail, { strict = false } = {}) {
  const claimedBy = json?.claimedBy ?? (/^(.+) is applying it right now$/.exec(String(error ?? ""))?.[1] ?? null);
  if (status === 409 && claimedBy) return { kind: "claimed", claimedBy: String(claimedBy).toLowerCase(), loser: { status: 409, json: { claimedBy } }, named: String(claimedBy).toLowerCase() === winnerEmail };
  // With the decision held back until every other answered (strict), a settled answer is no answer the claim gave: checkI9 fails it.
  const asLoser = strict ? { loser: { status: told === "accepted" ? 200 : status, json: json ?? { error: error ?? `told ${told}` } } } : {};
  if (told === "accepted") return { kind: "told-accepted", ...asLoser };
  if (status === 409 && (json?.state === "accepted" || /^it has already been accepted$/.test(String(error ?? "")))) return { kind: "settled", ...asLoser };
  return { kind: "other", loser: { status, json: json ?? { error } } };
}

/** An agent's answer in classifyLoser's terms. */
function agentAsLoser(a) {
  if (!a.isError && a.json?.state === "accepted") return { told: "accepted" };
  return { status: a.isError && /is applying it right now$|^it has already been accepted$/.test(a.text) ? 409 : a.status, error: a.text, json: null };
}

// --- the agent scenarios' bodies ------------------------------------------------------------------

/** C10a: n agents, n different suggestions, fired by `how`; the work case's oracles, and the draft for its judge. */
async function c10aWork(ctx, ref, how) {
  await working(ctx, ref, async (obs) => {
    const n = ctx.n;
    const stage = await stageDoc(ctx, { n, ks: Array.from({ length: n }, (_, i) => i + 1), title: `C10a ${how} N=${n}` });
    const agents = await agentsOf(ctx, stage);
    obs.stage = "staged";
    const pairs = stage.suggestions.map((s, i) => ({ agent: agents[i], annId: s.annId, replacement: s.replacement }));
    ctx.step(`each agent accepts its own suggestion (${how}): ${pairs.map((p) => `${p.agent.name} → ${p.annId}`).join(", ")}`);
    const fired = how === "gated" ? await acceptGated(ctx, stage.docId, pairs) : await acceptAtOnce(ctx, stage.docId, pairs);
    obs.stage = "fired";
    ctx.ev.json("answers", fired.pairs.map((p) => ({ agent: p.agent.name, annId: p.annId, answer: p.answer })));
    ctx.step(`answers: ${fired.pairs.map(answerLine).join("; ")}`);
    const out = await settleServer(ctx, stage);
    const accepted = acceptedOf(stage.suggestions);
    obs.draft = { text: out.draft.text, html: out.draft.html, accepted, updatedByEmail: out.draft.updatedByEmail };
    obs.stage = "measured";
    const inDraft = draftShape(i8Of({ ...out.draft, accepted }));
    ctx.ev.text("draft.html", out.draft.html);
    ctx.step(`the draft (last written by ${out.draft.updatedByEmail}) holds each replacement: ${JSON.stringify(inDraft)} (I8 is the judge's)`);
    measure(ctx, MEASURE, { ref, how, race: fired.race, answers: fired.pairs.map((p) => p.answer.isError ? `refused: ${p.answer.text}` : p.answer.json?.state), inDraft });
    assertEveryAgentAccepted(fired);
    assertDecidedOnce(out.anns, Object.fromEntries(pairs.map((p) => [p.annId, p.agent.email])), "mcp");
    assertInvariant(i8Of({ ...out.draft, accepted }));
  });
}

/**
 * The judge: I8 over the draft the work case read, once and in place
 * (i8Of: lib checkI8). `suspect`: the defect its case is tagged with, whose
 * prediction (an absence) is checked first (assertPredictedShape). `race`:
 * the work case's save race (C10b), which must have been achieved, or the
 * judge is INCONCLUSIVE: a pass with no race says nothing about S17.
 */
function i8Judge(ctx, ref, { suspect = null, race = false } = {}) {
  const d = observation(ctx, ref, "draft");
  if (race) {
    const r = observation(ctx, ref, "saveRace");
    if (!r.achieved) ctx.inconclusive(`race not achieved: no two pages' accept saves each lacked the other's replacement (${r.summary}), so this trial can neither show S17 nor count as "not reproduced"`);
    ctx.step(`the accept saves raced: ${r.pairs.map((p) => p.join(" and ")).join("; ")} each saved without the other's replacement; the saves whose text is the draft's: ${r.last.join(", ") || "none matched"}`);
  }
  const i8 = i8Of(d);
  ctx.ev.json("i8", i8);
  ctx.step(`I8 over the draft (last written by ${d.updatedByEmail}): ${JSON.stringify(draftShape(i8))}`);
  if (suspect) assertPredictedShape(suspect, i8);
  assertInvariant(i8);
}

/**
 * I9's one writer, for agents: only the claim holder writes the draft
 * (functions/src/lib/accept.ts takes the claim before writeDraft and returns
 * on a refused one; a call that finds the suggestion already accepted
 * returns before both), so the draft must be last written by the decider.
 * Every agent writes the whole file from the same working copy, so a second
 * writer leaves the same bytes and one insertion, and an accept once decided
 * is idempotent and writes no note: counting insertions and notes cannot see
 * a second approver applying the change, and this can (whenever that second
 * write lands after the decider's). SPEC §22: the claim keeps every other
 * decision off it, "so two approvers cannot insert the same change twice".
 */
function checkOneWriter({ annId, draft, decider }) {
  const failures = [];
  if (!draft.hasDraft) failures.push(`${annId}: no draft was written, though ${decider} accepted it`);
  else if (draft.updatedByEmail !== decider) failures.push(`${annId}: the draft was last written by ${draft.updatedByEmail}, not by the decider ${decider}: an approver the claim should have kept off applied the change too`);
  return { invariant: "I9", ok: failures.length === 0, failures };
}

/** C10c by agents: n agents, one suggestion, fired by `how`; I9 (one writer, one insertion, one note) and I8 asserted here (no suspect predicts them). */
async function c10cAgents(ctx, how) {
  const n = ctx.n;
  const stage = await stageDoc(ctx, { n, ks: [1], title: `C10c agents ${how} N=${n}` });
  const agents = await agentsOf(ctx, stage);
  const s = stage.suggestions[0];
  const pairs = agents.map((agent) => ({ agent, annId: s.annId, replacement: s.replacement }));
  ctx.step(`all ${n} agents accept ${s.annId} (${how})`);
  const strict = how === "claim-gated";
  const fired = strict ? await acceptClaimGated(ctx, stage.docId, pairs) : await acceptAtOnce(ctx, stage.docId, pairs);
  ctx.ev.json("answers", fired.pairs.map((p) => ({ agent: p.agent.name, answer: p.answer })));
  ctx.step(`answers: ${fired.pairs.map(answerLine).join("; ")}`);
  const out = await settleServer(ctx, stage);
  const ann = out.anns[0];
  const winner = agents.find((a) => a.email === ann.decidedBy?.email) ?? null;
  const losers = fired.pairs.filter((p) => p.agent !== winner).map((p) => ({ agent: p.agent.name, ...classifyLoser(agentAsLoser(p.answer), winner?.email ?? null, { strict }) }));
  const kinds = losers.reduce((m, l) => ({ ...m, [l.kind]: (m[l.kind] ?? 0) + 1 }), {});
  const insertions = occurrences(out.draft.text, s.replacement);
  ctx.ev.json("losers", losers);
  ctx.ev.text("draft.html", out.draft.html);
  ctx.step(`decided by ${winner?.name ?? JSON.stringify(ann.decidedBy)}; the draft last written by ${out.draft.updatedByEmail}; ${insertions} insertion(s) in the draft; ${ann.notes.length} note(s); losers: ${JSON.stringify(kinds)}`);
  measure(ctx, MEASURE, { ref: "C10c agents", how, race: fired.race, insertions, notes: ann.notes.length, losers: kinds, lastWriterIsDecider: Boolean(winner) && out.draft.updatedByEmail === winner.email });
  assert.ok(winner, `the suggestion was decided by one of the agents (decidedBy ${JSON.stringify(ann.decidedBy)})`);
  // The one writer first: in a free race it is the only check a second approver's write can fail.
  assertInvariant(checkOneWriter({ annId: s.annId, draft: out.draft, decider: winner.email }));
  assertInvariant(checkI9({ suggestions: [{ annId: s.annId, insertions, notes: ann.notes.length }], losers: losers.filter((l) => l.loser).map((l) => l.loser) }));
  assertInvariant(i8Of({ ...out.draft, accepted: acceptedOf([s]) }));
  const misnamed = losers.filter((l) => l.kind === "claimed" && !l.named);
  assert.deepEqual(misnamed.map((l) => `${l.agent}: claimedBy ${l.claimedBy}`), [], `every claimedBy refusal names the decider (${winner.email})`);
  const winning = fired.pairs.find((p) => p.agent === winner);
  assert.equal(winning.answer.isError ? `refused: ${winning.answer.text}` : winning.answer.json?.state, "accepted", "the decider's agent was told accepted");
  assertDecidedOnce(out.anns, { [s.annId]: winner.email }, "mcp");
}

// --- the editor: joining approvers, the review pass ---------------------------------------------

/**
 * The approvers in the app: joinShared with every joiner granted approver
 * and a suggester as an extra with no browser, all cast with notifications
 * off, granted in one request; its beforeJoin stages the pending suggestions
 * before anybody opens the document (so the editor opens on them). Then
 * joinShared's own sequence: sign in and open 5 at a time, p1 enters edit
 * alone until its seed is in status/{d}/y, the rest 5 at a time, each until
 * "Shared" (a peer that never shows it is INCONCLUSIVE).
 */
async function joinApprovers(ctx, { n, ks, title }) {
  const live = await joinShared(ctx, {
    n,
    fixture: FIXTURE,
    title,
    role: "approver",
    extra: [{ role: "suggester" }],
    notifications: false,
    beforeJoin: ({ docId, extra }) => stageSuggestions(ctx, { docId, suggesterAcct: extra[0].account, ks }),
  });
  precondition(live.role === "approver" && live.extra.length === 1 && live.extra[0].role === "suggester", `joinShared joined approvers beside one suggester (role ${live.role}, extra ${JSON.stringify(live.extra.map((e) => e.role))})`);
  precondition(live.staged?.suggestions?.length === ks.length, `the suggestions were staged before anybody joined (${live.staged?.suggestions?.length ?? 0} of ${ks.length})`);
  ctx.step(`${n} approver(s) joined and "Shared" in ${Math.round(live.joinMs / 1000)} s (grants through ${live.grantVia === "access" ? "one POST /access" : "the operator script"})`);
  return { docId: live.docId, names: live.names, accounts: live.accounts, owner: live.owner, users: live.users, ...live.staged };
}

const bar = (u) => u.page.locator(".review-bar");
const barButton = (u, label) => bar(u).getByRole("button", { name: label, exact: true });

/** What the review bar shows, read in one go (as a08-review reads it). */
function barState(u) {
  return u.page.evaluate(() => {
    const b = document.querySelector(".review-bar");
    if (!b) return null;
    const squash = (s) => (s ?? "").replace(/\s+/g, " ").trim();
    return {
      reviewing: b.classList.contains("is-reviewing"),
      notice: b.classList.contains("is-reviewing") ? null : squash(b.querySelector(":scope > span")?.textContent),
      count: squash(b.querySelector(".review-count")?.textContent) || null,
      del: b.querySelector(".review-change del")?.textContent ?? null,
      ins: b.querySelector(".review-change ins")?.textContent ?? null,
      stale: squash(b.querySelector(".review-stale")?.textContent) || null,
      buttons: Array.from(b.querySelectorAll("button")).map((x) => ({ label: squash(x.textContent), disabled: x.disabled })),
    };
  });
}

/**
 * Open the review pass and walk it (Next) to the suggestion quoting `exact`,
 * then wait until Accept is offered on it (the editing session bound, not
 * stale). `total` is how many suggestions are pending.
 */
async function openPassOn(u, exact, total) {
  const waiting = total === 1 ? "1 suggested edit is waiting." : `${total} suggested edits are waiting.`;
  await eventually(async () => {
    const s = await barState(u);
    if (!s || s.reviewing || !String(s.notice ?? "").startsWith(waiting)) throw new Error(`bar: ${JSON.stringify(s)}`);
    return s;
  }, { timeout: PAGE_MS, interval: 200, message: `${u.name}: the idle bar counts ${total} pending suggestion(s)` });
  await barButton(u, total === 1 ? "Review it" : "Review them").click({ timeout: CLIENT_MS });
  for (let hop = 0; hop <= total; hop += 1) {
    const s = await eventually(async () => {
      const st = await barState(u);
      if (!st?.reviewing || st.del == null) throw new Error(`bar: ${JSON.stringify(st)}`);
      return st;
    }, { timeout: CLIENT_MS, interval: 100, message: `${u.name}: the pass shows a suggestion` });
    if (s.del === exact) {
      return eventually(async () => {
        const st = await barState(u);
        const acc = st?.buttons?.find((b) => b.label === "Accept");
        if (!st?.reviewing || st.del !== exact || !acc || acc.disabled || st.stale) throw new Error(`bar: ${JSON.stringify(st)}`);
        return st;
      }, { timeout: PAGE_MS, interval: 100, message: `${u.name}: Accept is offered on "${exact}"` });
    }
    await barButton(u, "Next").click({ timeout: CLIENT_MS });
    await eventually(async () => {
      const st = await barState(u);
      if (!st?.reviewing || st.count === s.count) throw new Error(`bar: ${JSON.stringify(st)}`);
      return st;
    }, { timeout: CLIENT_MS, interval: 50, message: `${u.name}: Next moves the pass on from ${s.count}` });
  }
  throw new Error(`${u.name}: the pass never reached "${exact}" in ${total + 1} step(s)`);
}

/** Pressed in each page by syncPages: the review bar's Accept, as a person's click would (React's onClick). */
const PRESS_ACCEPT = () => {
  const b = Array.from(document.querySelectorAll(".review-bar.is-reviewing button")).find((x) => x.textContent.trim() === "Accept");
  if (!b) throw new Error("no Accept button in the review bar");
  if (b.disabled) throw new Error("Accept is disabled");
  b.click();
  return true;
};

/** SYNC-T in the pages: Accept pressed in every page within 40 ms, or INCONCLUSIVE. */
async function pressAcceptTogether(ctx, users) {
  const run = await syncPages(users.map((u) => u.page), PRESS_ACCEPT);
  const failed = run.fires.filter((f) => f.error);
  if (failed.length) ctx.inconclusive(`the sync precondition did not hold: Accept could not be pressed in ${failed.map((f) => `${users[f.i].name} (${f.error})`).join(", ")}`);
  ctx.step(`Accept pressed in ${users.length} page(s) at once: spread ${run.spreadMs.toFixed(1)} ms`);
  requireConclusive(ctx, { spread: run });
  return { kind: "sync-t", spreadMs: run.spreadMs };
}

const isOp = (r, op, annId = null) => r.path === "/suggestion" && r.op === op && (annId == null || r.postJson?.annId === annId);
/** A page's request rows as evidence: a /draft body is the whole document, so it is kept as its length. */
const forEvidence = (rows) => rows.map(({ postJson, ...r }) => ({ ...r, postJson: typeof postJson?.html === "string" ? { ...postJson, html: `${postJson.html.length} chars` } : postJson }));

/** The page's accept of `annId`, answered (lib's waitInTurn: INCONCLUSIVE on the stack's cut-off). */
function acceptAnswered(u, posts, since, annId) {
  return posts.waitInTurn((r) => isOp(r, "accept", annId), { since, what: `${u.name}'s Accept on ${annId}` });
}

/** A paragraph's text in the user's frame. */
async function paragraphText(u, id) {
  return (await u.frame()).evaluate((i) => document.getElementById(i)?.textContent ?? null, id);
}
async function frameText(u) {
  return (await u.frame()).evaluate(() => document.body?.textContent ?? "");
}

/** Wait until the replacement of `s` reads in place in every one of `users`' frames. */
async function reachesEveryone(users, s, what) {
  const want = s.text.replace(s.exact, s.replacement);
  await eventually(async () => {
    const got = await Promise.all(users.map(async (u) => [u.name, await paragraphText(u, s.id)]));
    const off = got.filter(([, t]) => t !== want);
    if (off.length) throw new Error(`#${s.id}: ${off.map(([n, t]) => `${n} reads ${JSON.stringify(t)}`).join("; ")}`);
    return true;
  }, { timeout: PAGE_MS, interval: 200, message: what });
}

/** Wait until none of these pages has a POST /draft in flight and none has sent one for SAVE_QUIET_MS. */
async function quietSaves(users, posts, since) {
  await eventually(async () => {
    const now = performance.now();
    for (const [i, u] of users.entries()) {
      const drafts = posts[i].filter((r) => r.seq >= since[i] && r.path === "/draft");
      const open = drafts.filter((r) => !r.settled);
      if (open.length) throw new Error(`${u.name}: ${open.length} POST /draft in flight`);
      const last = drafts.length ? Math.max(...drafts.map((r) => r.sentAt)) : -Infinity;
      if (now - last < SAVE_QUIET_MS) throw new Error(`${u.name}: a POST /draft ${Math.round(now - last)} ms ago`);
    }
    return true;
  }, { timeout: 2 * FN_MS, interval: 250, message: "the pages' autosaves are quiet" });
}

/** Sample the stack's and the browsers' memory around a live body; the peak goes to the diagnostics and the case's row. */
async function withRss(ctx, body) {
  const sampler = startRssSampler(ctx.target, { everyMs: 3_000, file: rssFile() });
  try {
    return await body();
  } finally {
    const rss = await sampler.stop();
    const p = rss.peak;
    ctx.ev.json("rss", rss);
    const line = `RSS N=${ctx.n}: peak ${(p.totalBytes / GB).toFixed(2)} GB = stack ${(p.stackBytes / GB).toFixed(2)} GB + browsers ${(p.browserBytes / GB).toFixed(2)} GB (${rss.samples.length} samples)`;
    ctx.t.diagnostic(line);
    ctx.step(line);
    measure(ctx, MEASURE, { rssPeakGb: Number((p.totalBytes / GB).toFixed(2)), stackGb: Number((p.stackBytes / GB).toFixed(2)), browsersGb: Number((p.browserBytes / GB).toFixed(2)) });
  }
}

/** No error toast on any of these pages since their marks. */
function assertNoErrorToasts(users, marks) {
  const errors = users.flatMap((u, i) => u.log.toasts.slice(marks[i]).filter((t) => t.kind === "error").map((t) => `${u.name}: ${t.text}`));
  assert.deepEqual(errors, [], "no page showed an error toast");
}

/** After settleLive: every peer reads each paragraph with its replacement once, in place (one insertion each in the live document). */
async function assertLiveOnce(users, suggestions) {
  const off = [];
  for (const u of users) {
    const text = await frameText(u);
    for (const s of suggestions) {
      const para = await paragraphText(u, s.id);
      const n = occurrences(text, s.replacement);
      if (n !== 1 || para !== s.text.replace(s.exact, s.replacement)) off.push(`${u.name} #${s.id}: replacement ×${n}, paragraph ${JSON.stringify(para)}`);
    }
  }
  assert.deepEqual(off, [], "every peer reads each accepted replacement once, in its paragraph, in place of its quote");
}

// --- C10b: approvers accept different suggestions in the app --------------------------------------

/**
 * The save race S17 needs (C10b SYNC-T and slow link). Each page's POST
 * /draft bodies since its mark, read for which replacements they hold, with
 * when each was sent and answered (ms from the first save sent, this
 * process's clock for every page). A page's ACCEPT SAVE is its first: the
 * save its accept waits for, serialized right after its own edit; the
 * autosave a second after that edit is its next. ACHIEVED when at least two
 * pages' accept saves each lack the other's replacement: both serialized
 * before the other's edit reached that page. Otherwise every later snapshot
 * already holds the earlier edits, and a passing judge says nothing about
 * S17. `last` names the saves whose text is the draft's (which landed last,
 * as far as the bodies tell); `remote` the saves that held another page's
 * replacement (a page saving a change it received). The bodies decide: the
 * times are when Playwright told this process, which can bunch several
 * pages' requests together (at N=5, five accept saves "sent" within 2 ms
 * each held the ones before it).
 */
function saveRace(users, posts, marks, suggestions, draftText) {
  const rows = users.map((u, i) => posts[i].filter((r) => r.seq >= marks[i] && r.path === "/draft"));
  const sent = rows.flat().map((r) => r.sentAt).filter(Number.isFinite);
  const t0 = sent.length ? Math.min(...sent) : 0;
  const ms = (x) => (Number.isFinite(x) ? Math.round(x - t0) : null);
  const saves = users.map((u, i) =>
    rows[i].map((r, k) => {
      const text = textOf(r.postJson?.html);
      return { save: `${u.name}#${k}`, page: i, status: r.status, sentMs: ms(r.sentAt), respondedMs: ms(r.respondedAt), holds: suggestions.map((s) => occurrences(text, s.replacement)), isDraft: text === draftText };
    }),
  );
  const accept = saves.map((list) => list[0] ?? null);
  const pairs = [];
  for (let i = 0; i < users.length; i += 1) {
    for (let j = i + 1; j < users.length; j += 1) {
      if (accept[i] && accept[j] && accept[i].holds[j] === 0 && accept[j].holds[i] === 0) pairs.push([users[i].name, users[j].name]);
    }
  }
  const all = saves.flat();
  return {
    achieved: pairs.length > 0,
    pairs,
    saves: all,
    last: all.filter((x) => x.isDraft).map((x) => x.save),
    remote: all.filter((x) => x.holds.some((h, j) => h > 0 && j !== x.page)).map((x) => x.save),
    summary: all.map((x) => `${x.save} holds [${x.holds.join(",")}], sent ${x.sentMs} ms, answered ${x.respondedMs} ms`).join("; ") || "no POST /draft captured",
  };
}

/**
 * Before C10b's press on a local stack: N concurrent requests to each
 * function an accept calls (manageSuggestion, for the claim and the accept;
 * saveDraft, for the save), each refused 400 on its body before it reads or
 * writes anything, so N Functions-emulator workers of each are up and idle.
 * A cold worker answers its first request about half a second late
 * (measured, 2610131329-4m3i: with the presses 0 ms apart, the two pages'
 * accept saves went 90 and 612 ms apart, and a first save took 744 ms),
 * an emulator artefact that staggers the accept saves. Warm, they went 5
 * and 96 ms apart (2610131337-6knd), and neither trial raced; of the next
 * two, one did (2610131344-u4wy, saves 3 ms apart). Locally the live link
 * carries an edit to the other page in a few milliseconds, about the
 * claims' own jitter, so the SYNC-T judge is often INCONCLUSIVE at N=2 and
 * the SLOW LINK variant is the one that races every time. The
 * press would start the same workers; admitWorkers reserves room for them
 * first. Anywhere else nothing is sent: those are no emulator workers, and
 * the press meets the deployment as it is.
 */
async function warmAcceptWorkers(ctx, session, n) {
  if (ctx.target.kind !== "local") return;
  await admitWorkers(ctx, { requests: 2 * n, what: `C10b's ${n} claim and ${n} save worker(s)` });
  const burst = (path, body) => Promise.all(Array.from({ length: n }, () => session.http.postJson(path, body, { timeoutMs: FN_MS })));
  const [claims, saves] = await Promise.all([burst("/suggestion", { op: "e2e-warm-up" }), burst("/draft", { html: "" })]);
  const statuses = [...claims, ...saves].map((r) => r.status);
  precondition(statuses.every((x) => x === 400), `every warm-up request is refused 400 on its body, touching nothing (${JSON.stringify(statuses)})`);
  ctx.step(`warmed ${n} worker(s) each of POST /suggestion and POST /draft (${2 * n} request(s) at once, each refused 400 before it read or wrote anything)`);
}

/**
 * Run `body` with the live link slowed by the stack's RTDB proxy (SLOW_LINK
 * each way, above the autosave's 1 s debounce), and set back to no delay
 * afterwards, whatever happened. The proxy's stats go to the evidence (every
 * page stayed on the proxy: handshakes and resets against connections).
 */
async function withSlowLink(ctx, body) {
  const lat = rtdbLatency(ctx.target);
  await lat.reset();
  try {
    await lat.set(SLOW_LINK);
    ctx.step(`the live link is slowed to ${SLOW_LINK.up} ms up and ${SLOW_LINK.down} ms down: a page's own saves (its accept's, and its autosave 1 s after its edit) go before any other page's edit can reach it`);
    return await body();
  } finally {
    await lat
      .stats()
      .then((x) => ctx.ev.json("rtdb-proxy", x.stats))
      .catch(() => undefined);
    await lat.reset().catch(() => undefined);
  }
}

/**
 * C10b's work: n approvers, n suggestions, each in its own pass. `mode`:
 *   "together"     SYNC-T: Accept pressed in every page within 40 ms;
 *   "slow"         the same with the live link slowed (LOCAL, the RTDB
 *                  proxy), kept slow until every page's own saves are done,
 *                  then set back before the settle: the natural S17 path;
 *   "held"         p1's accept save held past the others' accepts and
 *                  saves (SYNC-H);
 *   "serial"       one after another, each waiting for its change at every
 *                  peer and its autosave: the positive control, which
 *                  asserts the draft itself;
 *   "serial-slow"  the same with the live link slowed throughout: the slow
 *                  variant's positive control.
 * "together" and "slow" record the save race (saveRace) for their judge.
 */
async function c10bWork(ctx, ref, mode) {
  await working(ctx, ref, async (obs) => withRss(ctx, async () => {
    const n = ctx.n;
    const live = await joinApprovers(ctx, { n, ks: Array.from({ length: n }, (_, i) => i + 1), title: `C10b ${mode} N=${n}` });
    const { docId, users, suggestions } = live;
    obs.stage = "joined";
    ctx.step(`each approver opens the review pass on its own suggestion: ${users.map((u, i) => `${u.name} → "${suggestions[i].exact}"`).join(", ")}`);
    await Promise.all(users.map((u, i) => openPassOn(u, suggestions[i].exact, n)));
    if (mode === "together" || mode === "slow") await warmAcceptWorkers(ctx, live.owner, n);
    const posts = users.map((u) => u.capture({ paths: ["/suggestion", "/draft"] }));
    const marks = posts.map((p) => p.mark());
    const toastMarks = users.map((u) => u.toastMark());
    const together = async () => {
      const pressed = await pressAcceptTogether(ctx, users);
      await Promise.all(users.map((u, i) => acceptAnswered(u, posts[i], marks[i], suggestions[i].annId)));
      return pressed;
    };
    const oneByOne = async () => {
      for (const [i, u] of users.entries()) {
        await barButton(u, "Accept").click({ timeout: CLIENT_MS });
        await acceptAnswered(u, posts[i], marks[i], suggestions[i].annId);
        await reachesEveryone(users, suggestions[i], `${u.name}'s accepted change reaches every peer`);
        await quietSaves([u], [posts[i]], [marks[i]]);
        ctx.step(`${u.name} accepted "${suggestions[i].exact}"; it reads at every peer and ${u.name}'s autosave is quiet`);
      }
      return { kind: "serial" };
    };
    let race = null;
    if (mode === "together") race = await together();
    else if (mode === "slow") {
      race = await withSlowLink(ctx, async () => {
        const pressed = await together();
        // Every page's own saves (its accept's, and its autosave a second after its edit) go while the link is still slow.
        await quietSaves(users, posts, marks);
        return { ...pressed, link: SLOW_LINK };
      });
    } else if (mode === "serial") race = await oneByOne();
    else if (mode === "serial-slow") race = { ...(await withSlowLink(ctx, oneByOne)), link: SLOW_LINK };
    else if (mode === "held") race = await heldSave(ctx, { users, posts, marks, suggestions });
    else throw new TypeError(`c10bWork: no mode ${mode}`);
    obs.stage = "accepted";
    ctx.ev.json("requests", users.map((u, i) => ({ user: u.name, rows: forEvidence(posts[i].filter((r) => r.seq >= marks[i])) })));
    const settled = await settleLive(users, { docId, n });
    ctx.step(`the live session settled in ${settled.ms} ms on ${settled.hash.slice(0, 16)}`);
    const out = await readOutcome(live);
    const accepted = acceptedOf(suggestions);
    obs.draft = { text: out.draft.text, html: out.draft.html, accepted, updatedByEmail: out.draft.updatedByEmail };
    const raced = mode === "together" || mode === "slow" ? saveRace(users, posts, marks, suggestions, out.draft.text) : null;
    if (raced) {
      obs.saveRace = raced;
      ctx.ev.json("save-race", raced);
      ctx.step(`the save race ${raced.achieved ? `was achieved: ${raced.pairs.map((p) => p.join(" and ")).join("; ")} each saved without the other's replacement` : "was NOT achieved (the judge will be INCONCLUSIVE)"}; saves: ${raced.summary}; the saves whose text is the draft's: ${raced.last.join(", ") || "none matched"}; saves holding a change received from another page: ${raced.remote.join(", ") || "none"}`);
    }
    obs.stage = "measured";
    const i8 = i8Of({ ...out.draft, accepted });
    const inDraft = draftShape(i8);
    ctx.ev.text("draft.html", out.draft.html);
    ctx.step(`the draft (last saved by ${out.draft.updatedByEmail}) holds each replacement: ${JSON.stringify(inDraft)}`);
    const saveRow = raced && { achieved: raced.achieved, pairs: raced.pairs.length, last: raced.last, remote: raced.remote, saves: raced.saves.map(({ save, status, sentMs, respondedMs, holds }) => ({ save, status, sentMs, respondedMs, holds })) };
    measure(ctx, MEASURE, { ref, mode, race, ...(saveRow ? { saveRace: saveRow } : {}), settledMs: settled.ms, inDraft });
    const steps = users.map((u, i) => posts[i].filter((r) => r.seq >= marks[i] && r.path === "/suggestion").map((r) => `${r.op} ${r.status}`).join(" → "));
    assert.deepEqual(steps.filter((x) => !/^claim 200 → accept 200$/.test(x)), [], `every page claimed and accepted its own suggestion, 200 each (${JSON.stringify(steps)})`);
    const saves = users.flatMap((u, i) => posts[i].filter((r) => r.seq >= marks[i] && r.path === "/draft" && r.status !== 200).map((r) => `${u.name}: POST /draft ${r.status ?? r.state}`));
    assert.deepEqual(saves, [], "every POST /draft answered 200");
    assertNoErrorToasts(users, toastMarks);
    assertDecidedOnce(out.anns, Object.fromEntries(suggestions.map((s, i) => [s.annId, live.accounts[i].email.toLowerCase()])), "web");
    await assertLiveOnce(users, suggestions);
    if (mode === "serial" || mode === "serial-slow") {
      assertInvariant(i8);
      assertInvariant(checkI9({ suggestions: out.anns.map((a, i) => ({ annId: a.annId, insertions: occurrences(out.draft.text, suggestions[i].replacement), notes: a.notes.length })) }));
    }
  }));
}

/**
 * SYNC-H for C10b: p1's first POST /draft after its Accept (the accept's own
 * save, its body serialized right after the edit) is held in p1's browser;
 * once p1's change has reached every peer, p2…pN press Accept together, are
 * answered, and every page's autosave is quiet; then p1's save goes on and
 * lands last, as a save delayed in the network would. INCONCLUSIVE when the
 * held save never reaches the hold, or the order did not hold.
 */
async function heldSave(ctx, { users, posts, marks, suggestions }) {
  const [p1, ...others] = users;
  const gate = deferred();
  const held = await p1.delayRequests("/draft", { method: "POST", rules: [() => gate.promise], maxMs: 120_000 });
  try {
    ctx.step(`${p1.name}'s accept save will be held in its browser; ${p1.name} presses Accept`);
    await barButton(p1, "Accept").click({ timeout: CLIENT_MS });
    await eventually(() => held.rows.length >= 1, { timeout: PAGE_MS, interval: 50, message: `${p1.name}'s accept save reaches the hold` }).catch(() => ctx.inconclusive(`the sync precondition did not hold: ${p1.name}'s accept save never reached the hold`));
    await reachesEveryone(users, suggestions[0], `${p1.name}'s accepted change reaches every peer through the live session`);
    ctx.step(`${p1.name}'s save is held; its change reads at every peer; ${others.map((u) => u.name).join(", ")} press Accept`);
    let race = { kind: "one-other" };
    if (others.length > 1) race = await pressAcceptTogether(ctx, others);
    else await barButton(others[0], "Accept").click({ timeout: CLIENT_MS });
    await Promise.all(others.map((u, j) => acceptAnswered(u, posts[j + 1], marks[j + 1], suggestions[j + 1].annId)));
    // p1's held save is its first POST /draft since the Accept; its autosave after it (not held) counts as any other save.
    const heldCapture = posts[0].find((r) => r.seq >= marks[0] && r.path === "/draft");
    if (!heldCapture) ctx.inconclusive(`the sync precondition did not hold: ${p1.name}'s capture never saw its held save`);
    await quietSaves(users, posts, [heldCapture.seq + 1, ...marks.slice(1)]);
    const heldRow = held.rows[0];
    const heldText = textOf(heldRow.postJson?.html);
    const heldHas = suggestions.map((s) => occurrences(heldText, s.replacement));
    const otherSaves = others.flatMap((u, j) => posts[j + 1].filter((r) => r.seq >= marks[j + 1] && r.path === "/draft"));
    ctx.ev.json("held-save", { heldAt: heldRow.heldAt, holds: heldHas, otherSaves: otherSaves.map((r) => ({ sentAt: r.sentAt, doneAt: r.doneAt, status: r.status })) });
    if (heldHas[0] !== 1 || heldHas.slice(1).some((x) => x !== 0)) ctx.inconclusive(`the sync precondition did not hold: ${p1.name}'s held save holds the replacements ${JSON.stringify(heldHas)}, not its own alone`);
    if (!otherSaves.length || !otherSaves.every((r) => r.sentAt > heldRow.heldAt && r.settled)) ctx.inconclusive(`the sync precondition did not hold: the others' saves were not all sent after ${p1.name}'s was held and answered before it was let go`);
    ctx.step(`${p1.name}'s held save holds only its own replacement; ${otherSaves.length} save(s) of the others were sent after it and answered; now it goes on`);
    gate.resolve();
    await acceptAnswered(p1, posts[0], marks[0], suggestions[0].annId);
    ctx.step(`${p1.name}'s save landed last (held ${Math.round(heldRow.releasedAt - heldRow.heldAt)} ms) and its accept was recorded`);
    return { ...race, held: "sync-h", heldMs: Math.round(heldRow.releasedAt - heldRow.heldAt), otherSaves: otherSaves.length };
  } finally {
    gate.resolve();
    await held.restore();
  }
}

// --- C10c in the app: approvers accept one suggestion -------------------------------------------

/**
 * C10c in the app. `mode` "together": every approver presses Accept within
 * 40 ms (SYNC-T) with the live link slowed, so none sees another's edit
 * before its own claim answers. "held-accept": p1 presses first, and p1's
 * accept (POST /suggestion op accept, sent once its edit is saved) is held in
 * its browser (SYNC-H) while p2…pN, whose frames still read the quote (the
 * slow link), press Accept together and are answered; then it goes on. The
 * others' claims are then decided while p1's claim is live, so every loser
 * must be refused 409 claimedBy (strict I9).
 */
async function c10cInApp(ctx, mode) {
  await withRss(ctx, async () => {
    const n = ctx.n;
    const live = await joinApprovers(ctx, { n, ks: [1], title: `C10c in-app ${mode} N=${n}` });
    const { docId, users, suggestions } = live;
    const s = suggestions[0];
    ctx.step(`all ${n} approvers open the review pass on "${s.exact}"`);
    await Promise.all(users.map((u) => openPassOn(u, s.exact, 1)));
    const posts = users.map((u) => u.capture({ paths: ["/suggestion", "/draft"] }));
    const marks = posts.map((p) => p.mark());
    const toastMarks = users.map((u) => u.toastMark());
    const lat = rtdbLatency(ctx.target);
    await lat.reset();
    const gate = deferred();
    const heldAcc = mode === "held-accept" ? await users[0].delayRequests("/suggestion", { method: "POST", match: ({ postJson }) => postJson?.op === "accept", rules: [() => gate.promise], maxMs: 120_000 }) : null;
    const strict = mode === "held-accept";
    let race;
    const claims = new Array(n);
    const claimOf = (i) => posts[i].waitInTurn((r) => isOp(r, "claim", s.annId), { since: marks[i], what: `${users[i].name}'s claim` });
    try {
      await lat.set(SLOW_LINK);
      ctx.step(`the live link is slowed to ${SLOW_LINK.up} ms up and ${SLOW_LINK.down} ms down: no page sees another's edit before its own claim answers`);
      let pressers = users;
      if (mode === "held-accept") {
        const [p1, ...others] = users;
        ctx.step(`${p1.name}'s accept request will be held in its browser; ${p1.name} presses Accept`);
        await barButton(p1, "Accept").click({ timeout: CLIENT_MS });
        claims[0] = await claimOf(0);
        assert.equal(claims[0].status, 200, `${p1.name}, alone, takes the claim: ${claims[0].status} ${JSON.stringify(claims[0].json)}`);
        await eventually(() => heldAcc.rows.length >= 1, { timeout: PAGE_MS, interval: 50, message: `${p1.name}'s accept reaches the hold` }).catch(() => ctx.inconclusive(`the sync precondition did not hold: ${p1.name}'s accept never reached the hold`));
        const still = await Promise.all(others.map(async (u) => [u.name, await paragraphText(u, s.id)]));
        const seen = still.filter(([, t]) => t !== s.text);
        if (seen.length) ctx.inconclusive(`the sync precondition did not hold: ${seen.map(([nm]) => nm).join(", ")} already read ${p1.name}'s edit before pressing Accept (the slow link did not hold it back)`);
        ctx.step(`${p1.name} holds the claim, its edit saved and its accept held; ${others.map((u) => u.name).join(", ")} still read the quote and press Accept`);
        pressers = others;
      }
      race = pressers.length > 1 ? await pressAcceptTogether(ctx, pressers) : (await barButton(pressers[0], "Accept").click({ timeout: CLIENT_MS }), { kind: "one" });
      const first = users.length - pressers.length;
      await Promise.all(pressers.map(async (u, j) => (claims[first + j] = await claimOf(first + j))));
      ctx.step(`claims: ${users.map((u, i) => `${u.name} ${claims[i].status}${claims[i].json?.claimedBy ? ` (claimedBy ${claims[i].json.claimedBy})` : claims[i].json?.error ? ` (${claims[i].json.error})` : ""}`).join(", ")}`);
      if (mode === "held-accept") {
        const heldAt = heldAcc.rows[0].heldAt;
        const early = pressers.filter((u, j) => !(claims[first + j].sentAt > heldAt));
        if (early.length) ctx.inconclusive(`the sync precondition did not hold: ${early.map((u) => u.name).join(", ")} sent a claim before ${users[0].name}'s accept was held`);
      }
      const took = users.map((u, i) => i).filter((i) => i >= (mode === "held-accept" ? 1 : 0) && claims[i].status === 200);
      await Promise.all(took.map((i) => acceptAnswered(users[i], posts[i], marks[i], s.annId)));
      const refused = users.map((u, i) => i).filter((i) => claims[i].status !== 200);
      await Promise.all(refused.map((i) => users[i].waitForToast((t) => t.kind === "error", { since: toastMarks[i], timeout: PAGE_MS })));
      if (mode === "held-accept") {
        ctx.step(`every other claim answered while ${users[0].name}'s claim was live; its accept goes on`);
        gate.resolve();
        await acceptAnswered(users[0], posts[0], marks[0], s.annId);
        race = { ...race, held: "sync-h", heldMs: Math.round(heldAcc.rows[0].releasedAt - heldAcc.rows[0].heldAt) };
      }
    } finally {
      gate.resolve();
      if (heldAcc) await heldAcc.restore();
      await lat.reset().catch(() => undefined);
    }
    ctx.ev.json("requests", users.map((u, i) => ({ user: u.name, rows: forEvidence(posts[i].filter((r) => r.seq >= marks[i])) })));
    const overlap = overlapProof(claims.map((r) => ({ sentAt: r.sentAt, firstByteAt: r.respondedAt })));
    ctx.step(`claims in flight together: ${overlap.ok ? `yes (margin ${overlap.marginMs.toFixed(1)} ms)` : overlap.reason} (recorded, not required)`);
    const settled = await settleLive(users, { docId, n });
    ctx.step(`the live session settled in ${settled.ms} ms on ${settled.hash.slice(0, 16)}`);
    const out = await readOutcome(live);
    const ann = out.anns[0];
    const winnerIdx = live.accounts.findIndex((a) => a.email.toLowerCase() === ann.decidedBy?.email);
    const insertions = occurrences(await frameText(users[0]), s.replacement);
    const losers = users
      .map((u, i) => ({ u, i }))
      .filter(({ i }) => i !== winnerIdx)
      .map(({ u, i }) => ({ user: u.name, status: claims[i].status, json: claims[i].json, ...classifyLoser({ status: claims[i].status, json: claims[i].json, error: claims[i].json?.error }, ann.decidedBy?.email ?? null, { strict }) }));
    const kinds = losers.reduce((m, l) => ({ ...m, [l.kind]: (m[l.kind] ?? 0) + 1 }), {});
    ctx.ev.json("losers", losers);
    ctx.ev.text("draft.html", out.draft.html);
    ctx.step(`decided by ${users[winnerIdx]?.name ?? JSON.stringify(ann.decidedBy)}; ${insertions} insertion(s) in the live document, ${occurrences(out.draft.text, s.replacement)} in the draft; ${ann.notes.length} note(s); losers: ${JSON.stringify(kinds)}`);
    measure(ctx, MEASURE, { ref: "C10c in-app", mode, race, claimsOverlap: overlap.ok, insertions, inDraft: occurrences(out.draft.text, s.replacement), notes: ann.notes.length, losers: kinds });
    // I9 first: one insertion in the live document, one note, and every loser refused naming the claimer.
    assertInvariant(checkI9({ suggestions: [{ annId: s.annId, insertions, notes: ann.notes.length }], losers: losers.filter((l) => l.loser).map((l) => l.loser) }));
    assertInvariant(i8Of({ ...out.draft, accepted: acceptedOf([s]) }));
    assert.ok(winnerIdx >= 0, `the suggestion was decided by one of the approvers (decidedBy ${JSON.stringify(ann.decidedBy)})`);
    if (mode === "held-accept") assert.equal(winnerIdx, 0, `${users[0].name}, who held the claim, decided it`);
    const misnamed = losers.filter((l) => l.kind === "claimed" && !l.named);
    assert.deepEqual(misnamed.map((l) => `${l.user}: claimedBy ${l.claimedBy}`), [], "every claimedBy refusal names the decider");
    const loserWrites = users
      .map((u, i) => ({ u, i }))
      .filter(({ i }) => i !== winnerIdx)
      .flatMap(({ u, i }) => posts[i].filter((r) => r.seq > claims[i].seq && (r.path === "/draft" || isOp(r, "accept"))).map((r) => `${u.name}: ${r.path}${r.op ? `:${r.op}` : ""}`));
    assert.deepEqual(loserWrites, [], "a refused page applied nothing: no POST /draft and no accept after its claim");
    assertNoErrorToasts([users[winnerIdx]], [toastMarks[winnerIdx]]);
    assertDecidedOnce(out.anns, { [s.annId]: live.accounts[winnerIdx].email.toLowerCase() }, "web");
    await assertLiveOnce(users, suggestions);
  });
}

// ===================================================================================================
// C10a: N agents accept N different suggestions at once
// ===================================================================================================

scenario("C10a agents accept N different suggestions at once (SYNC-T): every agent is told accepted, each suggestion accepted once by its own agent with one note", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  timeoutMs: AGENT_MS,
  inconclusiveOnStackTimeout: true,
}, (ctx) => c10aWork(ctx, "C10a", "sync-t"));

scenario("C10a judge (SYNC-T): I8, every replacement an agent's accept recorded is in the draft exactly once, in place", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  timeoutMs: JUDGE_MS,
}, async (ctx) => i8Judge(ctx, "C10a"));

scenario("C10a gated: N agent accepts of different suggestions held after reading the working copy and released together: every agent is told accepted, each suggestion accepted once with one note", {
  tiers: LOCAL,
  needs: ["gates", "patch:amplify-c10-accept"],
  n: [2, 5, 10, 20],
  timeoutMs: AGENT_MS,
  inconclusiveOnStackTimeout: true,
}, (ctx) => c10aWork(ctx, "C10a gated", "gated"));

scenario("C10a judge (gated): I8, every replacement an agent's accept recorded is in the draft exactly once, in place", {
  tiers: LOCAL,
  needs: ["gates", "patch:amplify-c10-accept"],
  n: [2, 5, 10, 20],
  timeoutMs: JUDGE_MS,
}, async (ctx) => i8Judge(ctx, "C10a gated"));

scenario("C10a-serial: N agents accept N different suggestions one after another; every replacement is in the draft once (I8), one insertion and one note each (I9)", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  timeoutMs: AGENT_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const n = ctx.n;
  const stage = await stageDoc(ctx, { n, ks: Array.from({ length: n }, (_, i) => i + 1), title: `C10a serial N=${n}` });
  const agents = await agentsOf(ctx, stage);
  const pairs = stage.suggestions.map((s, i) => ({ agent: agents[i], annId: s.annId, replacement: s.replacement }));
  const fired = await acceptSerially(ctx, stage.docId, pairs);
  assertEveryAgentAccepted(fired);
  const out = await settleServer(ctx, stage);
  const accepted = acceptedOf(stage.suggestions);
  ctx.ev.text("draft.html", out.draft.html);
  const i8 = i8Of({ ...out.draft, accepted });
  measure(ctx, MEASURE, { ref: "C10a-serial", inDraft: draftShape(i8) });
  assertInvariant(i8);
  assertInvariant(checkI9({ suggestions: out.anns.map((a, i) => ({ annId: a.annId, insertions: occurrences(out.draft.text, pairs[i].replacement), notes: a.notes.length })) }));
  assertDecidedOnce(out.anns, Object.fromEntries(pairs.map((p) => [p.annId, p.agent.email])), "mcp");
});

// ===================================================================================================
// C10b: N approvers accept N different suggestions in the app
// ===================================================================================================

scenario("C10b approvers press Accept on N different suggestions at once in the app (SYNC-T): every claim, save and accept answered, the live document converges with each replacement once and one note each", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  timeoutMs: LIVE_MS,
  inconclusiveOnStackTimeout: true,
  inconclusiveOnPageStall: true,
}, (ctx) => c10bWork(ctx, "C10b", "together"));

scenario("C10b judge (SYNC-T): with two accept saves each made without the other's change (or INCONCLUSIVE: race not achieved), I8, the draft holds every replacement accepted in the app exactly once, in place", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  timeoutMs: JUDGE_MS,
}, async (ctx) => i8Judge(ctx, "C10b", { race: true }));

scenario("C10b held save: one approver's accept save is held while the others accept and save, then lands last; every accept answered, the live document converges with each replacement once and one note each", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  timeoutMs: LIVE_MS,
  inconclusiveOnStackTimeout: true,
  inconclusiveOnPageStall: true,
}, (ctx) => c10bWork(ctx, "C10b held", "held"));

scenario("C10b judge (held save): I8, the draft holds every replacement accepted in the app exactly once, in place", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  defect: "S17",
  timeoutMs: JUDGE_MS,
}, async (ctx) => i8Judge(ctx, "C10b held", { suspect: "S17" }));

scenario("C10b-serial: N approvers accept N different suggestions in the app one after another; the draft holds each replacement once (I8), one insertion and one note each (I9)", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  timeoutMs: LIVE_MS,
  inconclusiveOnStackTimeout: true,
  inconclusiveOnPageStall: true,
}, (ctx) => c10bWork(ctx, "C10b-serial", "serial"));

scenario("C10b slow link: approvers press Accept on N different suggestions at once with the live link slowed past the autosave debounce, until every page's own saves are done; every claim, save and accept answered, the live document converges with each replacement once and one note each", {
  tiers: LOCAL,
  needs: ["rtdb-proxy"],
  n: [2, 5, 10, 20],
  timeoutMs: LIVE_MS,
  inconclusiveOnStackTimeout: true,
  inconclusiveOnPageStall: true,
}, (ctx) => c10bWork(ctx, "C10b slow", "slow"));

scenario("C10b judge (slow link): with two accept saves each made without the other's change (or INCONCLUSIVE: race not achieved), I8, the draft holds every replacement accepted in the app exactly once, in place", {
  tiers: LOCAL,
  needs: ["rtdb-proxy"],
  n: [2, 5, 10, 20],
  defect: "S17",
  timeoutMs: JUDGE_MS,
}, async (ctx) => i8Judge(ctx, "C10b slow", { suspect: "S17", race: true }));

scenario("C10b-serial (slow link): N approvers accept N different suggestions in the app one after another with the live link slowed; the draft holds each replacement once, in place (I8), one insertion and one note each (I9)", {
  tiers: LOCAL,
  needs: ["rtdb-proxy"],
  n: [2, 5, 10, 20],
  timeoutMs: LIVE_MS,
  inconclusiveOnStackTimeout: true,
  inconclusiveOnPageStall: true,
}, (ctx) => c10bWork(ctx, "C10b-serial slow", "serial-slow"));

// ===================================================================================================
// C10c: N accepts of one suggestion
// ===================================================================================================

scenario("C10c agents accept one suggestion at once (SYNC-T): the draft written by the decider alone, one insertion and one note, the others refused naming the claimer or told it is accepted (I9, I8); a free race is mostly decided before the losers' claims are read, so the claim itself is proven for agents only by C10c claim-gated", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  timeoutMs: AGENT_MS,
  inconclusiveOnStackTimeout: true,
}, (ctx) => c10cAgents(ctx, "sync-t"));

scenario("C10c claim-gated: N agent accepts of one suggestion; the one that takes the claim is held after it, and every other is refused 409 naming the claimer; one insertion and one note (I9, I8)", {
  tiers: LOCAL,
  needs: ["gates", "patch:amplify-c10-accept"],
  n: [2, 5, 10, 20],
  timeoutMs: AGENT_MS,
  inconclusiveOnStackTimeout: true,
}, (ctx) => c10cAgents(ctx, "claim-gated"));

scenario("C10c in-app: approvers press Accept on one suggestion at once with the live link slowed: one insertion and one note, the others refused naming the claimer or the settled decision (I9, I8)", {
  tiers: LOCAL,
  needs: ["rtdb-proxy"],
  n: [2, 5, 10, 20],
  timeoutMs: LIVE_MS,
  inconclusiveOnStackTimeout: true,
  inconclusiveOnPageStall: true,
}, (ctx) => c10cInApp(ctx, "together"));

scenario("C10c in-app held accept: while one approver's claim is live, the others press Accept with the live link slowed; the claim keeps them off: one insertion and one note, every other refused 409 claimedBy (I9, I8)", {
  tiers: LOCAL,
  needs: ["rtdb-proxy"],
  n: [2, 5, 10, 20],
  timeoutMs: LIVE_MS,
  inconclusiveOnStackTimeout: true,
  inconclusiveOnPageStall: true,
}, (ctx) => c10cInApp(ctx, "held-accept"));
