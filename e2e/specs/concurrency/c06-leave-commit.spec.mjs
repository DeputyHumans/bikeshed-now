// SPDX-License-Identifier: Apache-2.0
// Concurrency C6 and C11a/b/c: editors leave the editor (Done inside the debounce, a removed member, one person's two tabs, everyone at once) and an agent's accept and commit_draft then publish what they saved, refused only while somebody is in the editor (SPEC §6a, §6b, §16, §22).

/**
 * Every scenario joins N editors live (lib/live.mjs joinShared: all
 * "Shared") on crdt-paragraphs, and the owner's personal token is the
 * AGENT: an MCP client calling commit_draft and accept_suggestion, the two
 * writes made outside the editor that SPEC §16 refuses "while anybody is in
 * it" and lets "drop a log nobody is using" (functions/src/lib/presence.ts
 * editorsRefusal, liveEditing: it counts status/{d}/peers nodes whose mode
 * is "edit"). Wherever the agent's accept goes ahead, status/{d}/y is read
 * BETWEEN the accept and commit_draft: commit_draft drops the log by itself,
 * so a read after both could not see the accept's own drop (accept.ts
 * clearEditLog; SPEC §22 "a log nobody is using is dropped with the write").
 *
 *   C6   EVERYONE STOPS, DONE INSIDE THE DEBOUNCE, THEN commit_draft.
 *        Each editor types tokens at the end of its own paragraph (the last
 *        token all at once), then every page presses Done at one instant
 *        (SYNC-T: lib/sync.mjs syncPages, spread <= 40 ms) and each Done
 *        lands inside the 1 s autosave debounce (app/src/viewer/
 *        useInlineEditor.ts AUTOSAVE_MS): measured per page as the time from
 *        its last input event to its Done, both on the page's clock; outside
 *        it the case is INCONCLUSIVE. So every Done's own save carries that
 *        editor's last keys, and N saves land together.
 *        Work: every Done saves its own typing (its first POST /draft after
 *        Done, 200, holding all its tokens); the session settles (I1, the
 *        plan's conditions); nobody is left "edit" in status/{d}/peers; the
 *        agent's commit_draft publishes v2; status/{d}/y is empty after it;
 *        the version carries no decoration (DECOR, BODYATTR apart from S3's
 *        `spellcheck`); everyone leaves at once and status/{d}/peers is
 *        empty within 5 s (I12). It also records, for EVERY save after Done
 *        (Done's own and the autosave timer's second, X-c06-leave-commit-1),
 *        which other editors' tokens it lacks, which was answered last, and
 *        whether the first saves were in flight together.
 *        Judge "C6 version": I2 (every token once and whole) and I5 (its
 *        body equals what every peer read) in the published version. It is
 *        NOT a test of S17: under local timing every save held every token
 *        (N=2: 6/6, N=5: 15/15), so the order they landed in could not
 *        matter. When a save that lacked a peer's token was answered last
 *        while the saves overlapped (S17's window, open), the version's I2
 *        is S17's question and this judge ends INCONCLUSIVE; "C6 latency"
 *        opens that window on purpose.
 *   C6 latency   S17's natural interleaving, opened by the RTDB proxy
 *        (`--rtdb-proxy`, LOCAL): every client→database byte is held
 *        LATENCY_MS (above DONE_LEAD_MS and the autosave deadline), the
 *        editors type and press Done at once as in C6, so every save after
 *        Done (the timer's second one too) is serialized before any other
 *        editor's last keys can reach it. The race proof: every such save is
 *        answered 200, holds its own editor's tokens, and lacks at least one
 *        other editor's (else INCONCLUSIVE); the union exists only in the
 *        live log. The one oracle: the version the agent's commit_draft
 *        publishes holds every token anybody saved (I2).
 *   C6 late save   the S17 interleaving made deterministic (SYNC-H): p1
 *        types and presses Done inside the debounce, and that save is HELD
 *        in flight (lib/sync.mjs holdRequests); meanwhile every other editor
 *        types a token, autosaves it (each save holding everything before
 *        it) and presses Done; then p1's save is released and lands last.
 *        The one oracle: the version commit_draft publishes holds every
 *        token anybody saved (I2). Everything before it is a precondition.
 *   C11a REVOKED GHOST. Everyone types, the owner removes pN while pN is in
 *        the editor (the RTDB mirrors drop pN: precondition), pN leaves the
 *        document in the app, the members press Done and leave. Work: the
 *        mirrors and the members' presence; it records I12 (and the nodes
 *        left) and the agent's writes (and the nodes it read). Judges:
 *        "C11a presence" (I12) and "C11a agent" (both go ahead). Each judges
 *        S11 and nothing else: a member's node left over, a member still
 *        "edit" when the agent writes, or a refusal that is not
 *        editorsRefusal for the one ghost, FAILS (a precondition), never
 *        reads as S11. S11 predicts the node of a member who lost access
 *        stays (its own remove is refused by the rules, and presence has no
 *        TTL), so it holds back every agent write.
 *   C11a closed   the other half of S11: pN, removed while in the editor,
 *        closes its tab while STILL in the editor (no leave in the app), so
 *        only the onDisconnect armed before the removal can remove its node;
 *        then the members press Done and leave. One case, the same S11-only
 *        preconditions, and one oracle: I12 and the agent's accept and
 *        commit_draft going ahead.
 *   C11b SAME PERSON, TWO TABS, ONE CLOSED. While pN's tab A is in the
 *        editor, a second tab of the same account opens the document and is
 *        closed. The one oracle: the agent's accept_suggestion and
 *        commit_draft are still refused. S21 predicts presence keyed by uid:
 *        tab B's write says "view" over A's "edit", and its onDisconnect
 *        removes the node A shares, so the agent goes ahead under an open
 *        editor.
 *   C11b both open   S21's first mechanism alone: tab B opens the document
 *        while tab A is in the editor and STAYS open; once B's presence write
 *        has landed (the peers snapshot changed: a proof that holds for any
 *        keying of presence), the agent's accept and commit_draft must be
 *        refused with editorsRefusal for one editor.
 *   C11c EVERYONE LEAVES AT ONCE: in the app (each page's router leaves the
 *        document, so each presence handle's leave() removes its node), or
 *        by every page unloading at one instant (no cleanup runs: only the
 *        server's onDisconnect removes the nodes). SYNC-T spread <= 40 ms.
 *        I12 within 5 s; then the agent's accept goes ahead and drops the
 *        live log (read before commit_draft), commit_draft publishes, y is
 *        empty, and the version holds the accepted change once (I8) and
 *        every saved token (I2).
 *
 * SERIAL POSITIVE CONTROLS (each must PASS, so a red case is not the oracle
 * failing for a harness reason): C6-serial (each editor in turn types,
 * presses Done inside the debounce and waits until every peer shows its last
 * token; then every C6 oracle and the version's I2 and I5), C6 latency serial
 * (the same, under C6 latency's delay), C6 late save serial (p1's Done save
 * lands at once, before the others type), C11a-serial (pN leaves the
 * document BEFORE it is removed), C11a closed serial (pN closes its tab in
 * the editor BEFORE it is removed), C11b-serial (the second tab opens and
 * closes BEFORE tab A enters the editor; the refusal, then the whole flow
 * once A presses Done), C11b both open serial (tab B opens FIRST, then tab A
 * enters the editor, so A's "edit" is the last write; the refusal while both
 * are open, then the whole flow). They run 2/1/1/1 trials at N = 2/5/10/20:
 * they show the oracle passes without the race, which needs no statistics.
 * "C11 canary" (N=2, no `n`, so a control can name it literally) is the
 * target of e2e/patches/controls-c06-editors-refusal and
 * controls-c06-log-kept; "C6 … [N=2]" of controls-c06-done-flush (Done's
 * flush a no-op), and "C11c all leave at once in the app … [N=2]" of
 * controls-c06-accept-keeps-log (accept.ts no longer clears the log).
 *
 * KNOWN DEFECTS (each case carries `defect:`, and its one assertion is the
 * defect's oracle; everything before it is a precondition):
 *   S17  "C6 late save", "C6 latency": the draft is one blob; saveDraft
 *        (functions/src/index.ts) checks only the base version and
 *        writeDraft (lib/draft.ts) overwrites, so the save that LANDS last
 *        wins whatever it was made from; commit_draft then publishes it and
 *        drops the live log that still held the lost keys. SPEC §16 lets
 *        the log be dropped ("a log nobody is using") and ADR 0015 names the
 *        race in "What would change this", so it is carried as a G1 ask
 *        (class I), with its harm: tokens saved (200) missing from v2.
 *   S11  "C11a presence", "C11a agent", "C11a closed": a removed editor's
 *        own remove() of its node is refused by the rules (no
 *        presenceAccess), presence has no TTL, and liveEditing counts every
 *        "edit" node, member or not.
 *   S21  "C11b", "C11b both open": one node per account
 *        (status/{d}/peers/{uid}); a second tab writes "view" over the first
 *        tab's "edit" and its onDisconnect removes the node both share.
 * Seen, not judged: when Done comes inside the debounce and its save is still
 * in flight at the debounce's deadline, the autosave timer sends the same
 * draft again (useInlineEditor.ts: flushUnsaved does not clear the timer,
 * and only leaving edit mode does), so a Done costs two POST /draft
 * (X-c06-leave-commit-1). C6 judges each editor's FIRST save after Done and
 * records every one.
 *
 * A failed sync precondition (a peer never "Shared", a spread over the
 * limit, a Done outside the debounce, a save never held, a latency window
 * that did not open, a presence that never showed or never changed) is
 * INCONCLUSIVE, never FAIL.
 *
 * Joining is live.mjs joinShared on every target: one POST /access on a
 * local stack, share() per editor through the operator script elsewhere (no
 * email; C11a's removal goes the same route. Both grant and removal must
 * deliver their own RTDB mirrors; no harness repair is permitted. Operator
 * databaseURL is explicitly configured. A deployed runtime's IAM/configuration
 * remains an external verification boundary rather than a local proof.
 *
 * Every Realtime Database read here (status/{d}/y, status/{d}/peers, the
 * access mirrors, waitI12's polls) goes through rtdbGetPatient, read again
 * on the Database emulator's 503; settleLive reads y that way by itself.
 * C11b's second tab is the lib's User.newTab: a page of the same context, a
 * User of its own.
 *
 * SPEC: §6a "No update is made under somebody's editor … refused … while
 * anybody has the document open in the editor"; §6a "Leaving edit mode saves
 * only an edit the autosave has not yet taken"; §6b "their edits merge and
 * every copy converges"; §16 "a write made outside the editor is refused
 * while anybody is in it, and drops a log nobody is using: an agent's accept
 * and commit_draft"; §16 "Deliberately not built: … presence for
 * non-members"; §22 "nothing is written while anybody has the editor open,
 * and a log nobody is using is dropped with the write".
 */

import { readLiveLogsPatient } from "../../lib/live-log.mjs";
import { presenceModes } from "../../lib/presence.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { closeAdmin, emailKey, readDoc, readObject } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { measure } from "../../lib/evidence.mjs";
import { tokenLog } from "../../lib/tokens.mjs";
import { readFixture } from "../../lib/seed.mjs";
import { operatorSetAccess, unshare } from "../../lib/grant.mjs";
import { mintToken } from "../../lib/session.mjs";
import { bodyAttrDiff, diffFingerprint, fingerprint, KNOWN_OWN_VALUES, parseAndRun } from "../../lib/bytes.mjs";
import { idSelector } from "../../lib/frame.mjs";
import { holdRequests, overlapProof, syncPages } from "../../lib/sync.mjs";
import { rtdbLatency } from "../../lib/proxy.mjs";
import { assertInvariant, checkI2, checkI5, checkI8, segmentsOfHtml, waitI12 } from "../../lib/invariants.mjs";
import { joinShared, rssFile, rtdbGetPatient, settleLive, startRssSampler } from "../../lib/live.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const FIXTURE = "crdt-paragraphs.html";
const BOTH = ["local", "prod"];
const LOCAL = ["local"];
const LIVE = { inconclusiveOnStackTimeout: true, inconclusiveOnPageStall: true };
const NS = [2, 5, 10, 20];
/** Positive controls: they show the oracle passes without the race, which needs no statistics. */
const CONTROL_TRIALS = Object.freeze({ 2: 2, 5: 1, 10: 1, 20: 1 });
const CASE_MS = 600_000;
const SERIAL_MS = 900_000;
const JUDGE_MS = 30_000;
/** Milliseconds between keystrokes: a fast typist. */
const KEY_DELAY_MS = 25;
/** C6: tokens each editor types (the last one all at once). */
const TOKENS = 3;
/** app/src/viewer/useInlineEditor.ts:21, AUTOSAVE_MS: the autosave fires this long after the last input. */
const AUTOSAVE_MS = 1_000;
/** A Done counts as inside the debounce when it comes at least this long before the autosave would. */
const DEBOUNCE_MARGIN_MS = 150;
/** How far ahead syncPages arms the simultaneous Done (short: the debounce is running). */
const DONE_LEAD_MS = 250;
/** How far ahead syncPages arms a simultaneous leave. */
const LEAVE_LEAD_MS = 400;
/**
 * C6 latency: every client→database byte is held this long (lib/proxy.mjs),
 * above DONE_LEAD_MS and the autosave deadline (AUTOSAVE_MS), so a save made
 * after Done (the timer's too) is serialized before another editor's last
 * keys can reach its page; wider at larger N, where typing at once spreads.
 */
const LATENCY_MS = Object.freeze({ 2: 3_000, 5: 4_000, 10: 6_000, 20: 10_000 });
/** A token typed by one editor shows at every other within this (live, or a reader's reload). */
const ARRIVE_MS = 30_000;
/** Presence follows a mode change, a leave or a Done within this. */
const PRESENCE_MS = 10_000;
/** The agent's write drops the log before it answers; read it back within this. */
const LOG_EMPTY_MS = 2_000;
/** C11a: how long the revoked editor's tab is watched after it closes (recorded, not judged). */
const GHOST_CLOSE_MS = 10_000;
/** An agent's tool call: a write on a shared emulator can take a while. */
const AGENT_MS = 120_000;
/** The suggestion the agent accepts: a passage of #e2e-40, which no editor types into (N <= 20). */
const SUGGESTION = Object.freeze({ id: "e2e-40", exact: "Bramble drift ember raven", replacement: "Bramble drift ember swan" });
const GB = 1024 ** 3;

/** functions/src/lib/presence.ts editorsRefusal: the refusal of a write made outside the editor. */
const editingRefusal = (editors, doing) =>
  `${editors === 1 ? "Somebody has" : `${editors} people have`} this document open in the editor, where this would be lost, so it was not ${doing}. Try again once they have left it, or ask them to do it there.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const paragraph = (i) => `e2e-${i + 1}`;
const isDraftPost = (url) => url.pathname === "/draft";
const latencyFor = (n) => LATENCY_MS[n] ?? LATENCY_MS[20];
const entries = (n) => `${n} entr${n === 1 ? "y" : "ies"}`;
/** The invocation's measurement file (lib/evidence.mjs measure): rows that outlive a PASS, which keeps no evidence. */
const MEASURE = "c06-leave-commit";
/** A save after Done as a measurement row: who, its status, and token counts (own, all, lacking). */
const saveSummary = (s) => ({ name: s.name, status: s.status, own: s.own, all: s.all, lacks: s.lacks.length, sentAt: Math.round(s.sentAt), respondedAt: Number.isFinite(s.respondedAt) ? Math.round(s.respondedAt) : null });

// --- what the work cases leave for their judges ---------------------------------------------

/** `${ref}|${n}|${trial}` → the observation a work case recorded. */
const observed = new Map();
const keyOf = (ref, ctx) => `${ref}|${ctx.n}|${ctx.trial}`;

/** A fresh observation for this case, stored at once so a judge sees how far it got. */
function record(ctx, ref) {
  const o = { ref, n: ctx.n, trial: ctx.trial, stage: "started", inconclusive: null };
  observed.set(keyOf(ref, ctx), o);
  return o;
}

/** The work case's observation of `field`, or INCONCLUSIVE when it was never measured. */
function observation(ctx, ref, field) {
  const o = observed.get(keyOf(ref, ctx));
  if (!o) ctx.inconclusive(`the ${ref} work case [N=${ctx.n}] #${ctx.trial} did not run in this process, so there is nothing to judge`);
  if (o.inconclusive) ctx.inconclusive(`the ${ref} work case [N=${ctx.n}] #${ctx.trial} was INCONCLUSIVE: ${o.inconclusive}`);
  if (o[field] == null) ctx.inconclusive(`the ${ref} work case [N=${ctx.n}] #${ctx.trial} stopped (${o.stage}) before it measured ${field}`);
  ctx.ev.json(`observed-${field}`, o[field]);
  return o[field];
}

/** End the case INCONCLUSIVE, and tell its judges why. */
function inconclusive(ctx, obs, reason) {
  if (obs) obs.inconclusive = reason;
  ctx.inconclusive(reason);
}

// --- joining ---------------------------------------------------------------------------------

/** Grants must deliver their own mirrors; a harness repair would hide S16. */
function join(ctx, { n, title }) {
  return joinShared(ctx, { n, fixture: FIXTURE, title, mirror: "stop" });
}

/** Both RTDB mirrors of `email` on `docId`, read through a 503: {presence, edit, gone}. */
async function mirrorOf(t, docId, email) {
  const key = emailKey(email);
  const [presence, edit] = await Promise.all([rtdbGetPatient(t, `presenceAccess/${docId}/${key}`), rtdbGetPatient(t, `editAccess/${docId}/${key}`)]);
  return { presence, edit, gone: presence === null && edit === null };
}

/** `mirrorOf` until the account has left both mirrors or `timeoutMs` passes; the last read. */
async function mirrorDropped(t, docId, email, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = await mirrorOf(t, docId, email);
    if (m.gone || Date.now() >= deadline) return m;
    await sleep(250);
  }
}

/** Revoke through the product/operator path, then require its mirror delivery. */
async function removeEditor(ctx, obs, { owner, docId, account, via }) {
  if (via === "operator") {
    // As share() picks the console identity: the owner's address on a local stack, the operator's elsewhere.
    const operator = ctx.target.kind === "local" ? (owner?.account?.email ?? process.env.E2E_OPERATOR_ACCOUNT) : undefined;
    const r = await operatorSetAccess(ctx.target, { docId, email: account.email, remove: true, timeoutMs: 120_000, ...(operator ? { operator } : {}) });
    if (r.code !== 0) throw new Error(`set-access.mjs --remove exited ${r.code}: ${r.stderr.slice(-400)}`);
  } else {
    await unshare(ctx.target, { owner, doc: docId, account, timeoutMs: 120_000 });
  }
  const mirror = await mirrorDropped(ctx.target, docId, account.email, 15_000);
  precondition(mirror.gone, `the product's ${via} revocation drops both RTDB mirrors (presence=${mirror.presence}, edit=${mirror.edit})`);
  return { via, mirror, stale: null, mirrored: null };
}

/**
 * Join N editors on a stack whose browsers dial RTDB through the proxy
 * (`--rtdb-proxy`), every connection through it (a stack fact: a FAIL when
 * not), the delay 0.
 */
async function joinThroughProxy(ctx, title) {
  const lat = rtdbLatency(ctx.target);
  await lat.reset();
  const joined = await join(ctx, { n: ctx.n, title });
  const conn = (await lat.stats()).stats.connections;
  precondition(conn >= ctx.n, `every browser's RTDB connection goes through the proxy (it carried ${conn} for ${ctx.n} peers)`);
  return { ...joined, lat };
}

/**
 * Hold every client→database byte `ms` late while `body` runs, then reset
 * the delay and let what was queued drain (the proxy is a FIFO: a chunk is
 * due at max(arrival + delay, the last chunk's due), so nothing queued
 * before the reset arrives sooner, and nothing after it overtakes). In a
 * finally: the proxy is stack-wide.
 */
async function underLatency(ctx, lat, ms, body) {
  try {
    const set = await lat.set({ up: ms, down: 0 });
    precondition(set.up === ms, `the proxy holds client→database bytes ${ms} ms (it says ${JSON.stringify(set)})`);
    return await body();
  } finally {
    await lat.reset().catch(() => undefined);
    ctx.step(`the delay is reset; ${ms + 500} ms for what was queued in the proxy to arrive`);
    await sleep(ms + 500);
  }
}

// --- memory -------------------------------------------------------------------------------

/** Sample the stack's and the browsers' memory around a case; the peak goes to the diagnostics. */
async function withRss(ctx, n, body) {
  const sampler = startRssSampler(ctx.target, { everyMs: 3_000, file: rssFile() });
  try {
    return await body();
  } finally {
    const rss = await sampler.stop();
    const p = rss.peak;
    ctx.ev.json("rss", rss);
    ctx.t.diagnostic(`RSS N=${n}: peak ${(p.totalBytes / GB).toFixed(2)} GB = stack ${(p.stackBytes / GB).toFixed(2)} GB + browsers ${(p.browserBytes / GB).toFixed(2)} GB (${rss.samples.length} samples)`);
  }
}

// --- the agent ----------------------------------------------------------------------------------

/** The owner's agent: a personal token (minted with the owner's session) and an initialized MCP client. */
async function agentFor(ctx, owner) {
  const { token } = await mintToken(owner, { name: `e2e c06 agent ${ctx.n ?? 2}`, channel: "mcp" });
  const mcp = ctx.mcp({ token, actor: "agent", timeoutMs: AGENT_MS });
  await mcp.initialize();
  return mcp;
}

/** A tool call's outcome as plain data: {isError, text, json}. */
async function agentCall(agent, tool, args) {
  const out = await agent.call(tool, args);
  return { isError: out.isError, text: out.text, json: out.json ?? null };
}

/** The agent proposes SUGGESTION on v1 (owner, so nobody is notified); its thread id. */
async function suggestionOn(agent, docId) {
  const out = await agent.call("suggest_edit", { id: docId, exact: SUGGESTION.exact, replacement: SUGGESTION.replacement });
  precondition(!out.isError && typeof out.json?.threadId === "string", `suggest_edit "${SUGGESTION.exact}" → "${SUGGESTION.replacement}": ${out.text.slice(0, 300)}`);
  return out.json.threadId;
}

/**
 * The agent's two writes, with the live log read around the first: how many
 * entries status/{d}/y holds just before accept_suggestion, and (when the
 * accept went ahead) once it answered, BEFORE commit_draft, which drops the
 * log by itself (tools.ts) and would hide an accept that left it.
 */
async function agentWrites(ctx, agent, docId, threadId) {
  const logBefore = await logEntriesNow(ctx.target, docId);
  const accept = await agentCall(agent, "accept_suggestion", { id: docId, threadId });
  const logAfterAccept = accept.isError ? null : await logEntriesAfter(ctx.target, docId);
  const commit = await agentCall(agent, "commit_draft", { id: docId });
  ctx.step(`the agent: accept_suggestion ${accept.isError ? `refused: ${accept.text}` : `accepted (status/${docId}/y: ${entries(logBefore)} before it, ${entries(logAfterAccept)} once it answered)`}; commit_draft ${commit.isError ? `refused: ${commit.text}` : JSON.stringify(commit.json)}`);
  return { accept, commit, logBefore, logAfterAccept };
}

// --- presence and the live log ------------------------------------------------------------------

/** status/{d}/peers as stored (rtdbGetPatient: a Database 503 is read again). */
async function peersRaw(t, docId) {
  return (await rtdbGetPatient(t, `status/${docId}/peers`)) ?? {};
}

/** status/{d}/peers as {uid: mode}. */
async function peerModes(t, docId) {
  return presenceModes(await peersRaw(t, docId));
}

/** Wait until `pred(modes)` holds; resolves {ok, modes} (the last read when it never held). */
async function waitModes(t, docId, pred, timeoutMs = PRESENCE_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const modes = await peerModes(t, docId);
    if (pred(modes)) return { ok: true, modes };
    if (Date.now() >= deadline) return { ok: false, modes };
    await sleep(150);
  }
}

const editorsIn = (modes, except = []) => Object.entries(modes).filter(([uid, m]) => m === "edit" && !except.includes(uid)).map(([uid]) => uid);

/**
 * I12 (waitI12) with every poll read through rtdbGetPatient, so a Database
 * 503 is read again rather than thrown; resolves waitI12's result plus
 * `peersLeft`, the uids of the last read (empty once it emptied).
 */
async function waitPeersGone(t, docId, since) {
  let last = null;
  const r = await waitI12(t, docId, { since, read: async () => (last = await rtdbGetPatient(t, `status/${docId}/peers`)) });
  return { ...r, peersLeft: Object.keys(presenceModes(last)) };
}

/** How many entries status/{d}/y holds now. */
async function logEntriesNow(t, docId) {
  const y = await readLiveLogsPatient(t, docId);
  return y && typeof y === "object" ? Object.keys(y).length : 0;
}

/** How many entries status/{d}/y holds, read until it is empty or `timeoutMs` passes. */
async function logEntriesAfter(t, docId, timeoutMs = LOG_EMPTY_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await logEntriesNow(t, docId);
    if (n === 0 || Date.now() >= deadline) return n;
    await sleep(200);
  }
}

/** The plan's settle conditions (settleLive: a missed deadline is an I1 FAILURE; with no readY it reads y through a 503 by itself). */
function settle(users, docId, n) {
  return settleLive(users, { docId, n });
}

/**
 * settle(), with a missed deadline as a precondition: in a flow a known
 * defect's case runs, the session settling is setup, not the oracle, and its
 * AssertionError would otherwise read as that defect's TODO.
 */
async function settleFirst(users, docId, n) {
  try {
    return await settle(users, docId, n);
  } catch (err) {
    precondition(false, `the live session settles before the step under test: ${err?.message ?? err}`);
  }
}

/** The node every user's presence must show before the case can mean anything; else INCONCLUSIVE. */
async function requirePresence(ctx, obs, docId, uids, mode) {
  const r = await waitModes(ctx.target, docId, (m) => uids.every((uid) => m[uid] === mode), 30_000);
  if (!r.ok) inconclusive(ctx, obs, `the sync precondition did not hold: every editor's presence never showed mode "${mode}" (status/${docId}/peers: ${JSON.stringify(r.modes)})`);
  return r.modes;
}

// --- typing, Done and leaving ------------------------------------------------------------------

/** Type `tokens` one after another at the end of #id, as a person does (a real click, then the keys). */
async function typeTokens(u, id, tokens) {
  for (const t of tokens) await u.typeInFrame(idSelector(id), t, { delay: KEY_DELAY_MS, at: "end" });
}

/** Poll a user's frame until #id holds `text` (a reading frame reloads on a peer's save: an arrival probe would watch the old document). */
async function waitTextIn(u, id, text, timeoutMs = ARRIVE_MS) {
  return eventually(async () => {
    try {
      return await (await u.frame()).evaluate(({ sel, text }) => document.querySelector(sel)?.textContent.includes(text) === true, { sel: idSelector(id), text });
    } catch {
      return false;
    }
  }, { timeout: timeoutMs, interval: 150, message: `${u.name}'s frame shows ${text} in #${id}` });
}

/** `from` types one token into #id and waits for its autosave (200) and for the token at every user in `watchers`. */
async function typeSaveArrive(from, watchers, id, token) {
  const save = await from.typeAndAutosave(idSelector(id), token, { delay: KEY_DELAY_MS, at: "end", timeout: 60_000 });
  await Promise.all(watchers.filter((u) => u !== from).map((u) => waitTextIn(u, id, token)));
  return save;
}

/** Each user in turn types one token into its own paragraph, autosaves it, and waits for it at every other user. */
async function typeInTurn(users, log) {
  for (const [i, u] of users.entries()) await typeSaveArrive(u, users, paragraph(i), log.next(u.name, paragraph(i)));
}

/** In the page: press the Formatting toolbar's Done (React's onClick takes the DOM click). Serialised by syncPages, so self-contained. */
function pressDone() {
  const bar = document.querySelector('[role="toolbar"][aria-label="Formatting"]');
  const btn = bar ? [...bar.querySelectorAll("button")].find((b) => b.textContent.trim() === "Done") : null;
  if (!btn) throw new Error("no Done button in the Formatting toolbar");
  btn.click();
  return true;
}

/** A real click on Done, without waiting for the editor to close (its save may be held). */
async function clickDone(u) {
  await u.page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Done", exact: true }).click();
}

/**
 * Wait until every POST /draft `cap` (the user's capture) holds has settled,
 * then stop it. Done's save can be followed by one more: the autosave timer
 * is not cleared while that save is in flight (see the unit's report), so a
 * serial step waits for both before the next editor acts.
 */
async function savesLanded(u, cap, { except = null, stop = true, timeoutMs = 90_000 } = {}) {
  try {
    await eventually(() => [...cap].filter((r) => r !== except).every((r) => r.settled), { timeout: timeoutMs, interval: 100, message: `every POST /draft of ${u.name}${except ? " but the held one" : ""} has landed` });
  } finally {
    if (stop) cap.stop();
  }
}

/** Wait until the user's editor has closed (Done's save answered), and mark it as out of edit. */
async function editorClosed(u, timeout = 90_000) {
  await u.page.getByRole("toolbar", { name: "Formatting" }).waitFor({ state: "detached", timeout });
  u.inEdit = false;
}

/** In the page: leave the document inside the app (the router's own navigation; the connection stays). */
function leaveInApp() {
  history.pushState({}, "", "/");
  dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  return location.pathname;
}

/** In the page: unload it, as closing the tab does (no React cleanup runs; only the server's onDisconnect). */
function unloadPage() {
  setTimeout(() => location.assign("/"), 0);
  return true;
}

const atHome = (url) => url.pathname === "/";

/** One user leaves the document in the app. */
async function leaveOne(u) {
  await u.page.evaluate(leaveInApp);
  await u.page.waitForURL(atHome, { timeout: 30_000 });
  u.inEdit = false;
}

/** Every user leaves at one instant (SYNC-T): in the app, or by unloading. Resolves syncPages' result once every page is home. */
async function leaveAtOnce(users, how = "app") {
  const fired = await syncPages(users.map((u) => u.page), how === "app" ? leaveInApp : unloadPage, { leadMs: LEAVE_LEAD_MS });
  await Promise.all(users.map((u) => u.page.waitForURL(atHome, { timeout: 60_000 })));
  for (const u of users) u.inEdit = false;
  return fired;
}

// --- recording saves ---------------------------------------------------------------------------

/** Per user, the page-clock recording of save states and input events, and a capture of every POST /draft. */
async function armSaves(users) {
  return Promise.all(users.map(async (u) => ({ u, rec: await u.recordSaveStates(), cap: u.capture({ paths: ["/draft"], method: "POST" }) })));
}

/** Each armed user's input events since arming: {name, first, last, inputs}. */
async function inputWindows(armed) {
  return Promise.all(armed.map(async ({ u, rec }) => {
    const r = await rec.read();
    const ts = r.inputs.filter(Number.isFinite);
    return { name: u.name, first: ts.length ? Math.min(...ts) : null, last: ts.length ? Math.max(...ts) : null, inputs: ts.length };
  }));
}

/** Stop every armed user's capture (synchronous); in a finally, so a failure never hides the case's own. */
function stopCaptures(armed) {
  for (const { cap } of armed ?? []) {
    try {
      cap.stop();
    } catch {
      /* already stopped, or its page is gone */
    }
  }
}

/** Every captured POST /draft at or after `since` (this process's Date.now()), per armed user, once settled. */
async function savesSince(armed, since, timeoutMs = 90_000) {
  const rowsOf = () => armed.flatMap(({ u, cap }) => [...cap].filter((r) => r.t >= since).map((r) => ({ u, r })));
  await eventually(() => rowsOf().every(({ r }) => r.settled), { timeout: timeoutMs, interval: 100, message: "every POST /draft since the Done has settled" });
  return rowsOf();
}

/**
 * Every editor pressed Done at one instant (syncPages): each page's time
 * from its last input to its Done, judged against the debounce. A page that
 * found no Done button is a precondition; a spread over the limit or a Done
 * outside the debounce is INCONCLUSIVE. Resolves the timing rows.
 */
function judgeDoneTiming(ctx, obs, users, fired, windows) {
  const timing = users.map((u, i) => ({
    name: u.name,
    inputs: windows[i].inputs,
    sinceLastKeyMs: Number.isFinite(windows[i].last) && Number.isFinite(fired.fires[i].firedAt) ? fired.fires[i].firedAt - windows[i].last : null,
    lateMs: fired.fires[i].lateMs,
    error: fired.fires[i].error ?? null,
  }));
  if (obs) obs.race = { spreadMs: fired.spreadMs, limit: fired.limit, timing };
  ctx.ev.json("done-timing", { spreadMs: fired.spreadMs, limit: fired.limit, timing });
  const broken = timing.filter((x) => x.error);
  precondition(broken.length === 0, `every page found its Done button: ${broken.map((x) => `${x.name}: ${x.error}`).join("; ")}`);
  if (!fired.conclusive) inconclusive(ctx, obs, `the Done presses were not simultaneous: fire spread ${fired.spreadMs.toFixed(1)} ms > ${fired.limit} ms`);
  const outside = timing.filter((x) => !(x.inputs > 0 && x.sinceLastKeyMs >= 0 && x.sinceLastKeyMs < AUTOSAVE_MS - DEBOUNCE_MARGIN_MS));
  if (outside.length) inconclusive(ctx, obs, `Done was not inside the autosave debounce (${AUTOSAVE_MS - DEBOUNCE_MARGIN_MS} ms after the last key) for ${outside.map((x) => `${x.name} (${x.sinceLastKeyMs == null ? "no input" : `${Math.round(x.sinceLastKeyMs)} ms`})`).join(", ")}`);
  const since = timing.map((x) => Math.round(x.sinceLastKeyMs));
  ctx.step(`race: Done fired on ${users.length} page(s) within ${fired.spreadMs.toFixed(1)} ms, ${Math.min(...since)}–${Math.max(...since)} ms after each one's last key (the autosave would fire at ${AUTOSAVE_MS} ms)`);
  return timing;
}

/**
 * Each POST /draft after Done as data: who sent it, when it went and was
 * answered (this process's clock), its status, how many of the sender's own
 * tokens it holds, and which tokens OTHER editors typed it lacks.
 */
function saveRows(rows, log) {
  return rows
    .map(({ u, r }) => {
      const html = String(r.postJson?.html ?? "");
      return {
        name: u.name,
        sentAt: r.sentAt,
        respondedAt: r.respondedAt,
        status: r.status ?? r.state,
        own: log.typed.filter((t) => t.peer === u.name && html.includes(t.token)).length,
        all: log.typed.filter((t) => html.includes(t.token)).length,
        lacks: log.typed.filter((t) => t.peer !== u.name && !html.includes(t.token)).map((t) => t.token),
      };
    })
    .sort((a, b) => a.sentAt - b.sentAt);
}

// --- reading the peers, the draft and the version -----------------------------------------------

/** Chrome's parser over `html`, then body.innerHTML, hashed: how the version and every peer's body are read alike. */
async function parsedBodyHash(parser, html) {
  const inner = await parseAndRun(parser, html, (doc) => (doc.body ? doc.body.innerHTML : ""));
  return { hash: sha(inner), length: inner.length };
}

/** In a frame: the body's innerHTML without the app's own nodes (by data-bshd VALUE: the reading overlay), as a reader's document is. */
function readerBodyInPage(own) {
  const body = document.body;
  if (!body) return "";
  const clone = body.cloneNode(true);
  const values = new Set(own);
  for (const el of [...clone.querySelectorAll("[data-bshd]")]) if (values.has(el.getAttribute("data-bshd"))) el.remove();
  return clone.innerHTML;
}

/** Each user's frame body (the app's own nodes aside), parsed again by the version's parser: {name: hash}. */
async function peerBodyHashes(parser, users) {
  const out = {};
  for (const u of users) {
    const inner = await (await u.frame()).evaluate(readerBodyInPage, [...KNOWN_OWN_VALUES]);
    out[u.name] = (await parsedBodyHash(parser, `<!DOCTYPE html><html><head></head><body>${inner}</body></html>`)).hash;
  }
  return out;
}

/** GET /draft/<doc>/ (the entry) as the owner. */
async function readDraft(owner, docId) {
  const r = await owner.http.get(`/draft/${encodeURIComponent(docId)}/`, { expect: 200, timeoutMs: 60_000 });
  return r.text;
}

/** A version's stored entry, through the Admin SDK (no read is recorded). */
async function versionHtml(t, docId, versionId) {
  const rec = await readDoc(t, `docs/${docId}/versions/${versionId}`);
  const buf = await readObject(t, `docs/${docId}/${versionId}/${rec?.entry ?? "index.html"}`);
  return buf ? buf.toString("utf8") : null;
}

/** A fingerprint with one root attribute taken out of both <html> and <body>. */
function withoutAttr(fp, name) {
  const drop = (a) => (a ? Object.fromEntries(Object.entries(a).filter(([k]) => k !== name)) : a);
  return { ...fp, bodyAttrs: drop(fp.bodyAttrs), htmlAttrs: drop(fp.htmlAttrs) };
}

/** The version against v1 and the peers: segments (I2), body hash (I5), DECOR, BODYATTR whole and apart from S3, its text. */
async function readVersion(ctx, { parser, docId, versionId, ids }) {
  const html = await versionHtml(ctx.target, docId, versionId);
  precondition(typeof html === "string" && html.length > 0, `the stored entry of ${versionId} is readable`);
  ctx.ev.text(`${versionId}.html`, html);
  const fp1 = await fingerprint(parser, readFixture(FIXTURE, { raw: true }).toString("utf8"));
  const fpV = await fingerprint(parser, html);
  const decor = diffFingerprint(fp1, fpV, true, { ignoreBodyAttr: true });
  return {
    versionId,
    hash: (await parsedBodyHash(parser, html)).hash,
    segs: await segmentsOfHtml(parser, html, ids),
    text: await parseAndRun(parser, html, (doc) => (doc.body ? doc.body.textContent : "")),
    decoration: decor.decoration,
    lost: decor.lost,
    structure: decor.structure,
    bodyAttr: bodyAttrDiff(fp1, fpV),
    beyondS3: bodyAttrDiff(withoutAttr(fp1, "spellcheck"), withoutAttr(fpV, "spellcheck")),
  };
}

/** DECOR on the version, and BODYATTR apart from the known S3 attribute: what no suspect here predicts to break. */
function assertCleanVersion(v) {
  assert.deepEqual(v.decoration, [], "DECOR: decoration in the version");
  assert.deepEqual(v.lost, [], "DECOR: author markers lost from the version");
  assert.deepEqual(v.structure, [], "DECOR: the version's structure changed");
  assert.equal(v.beyondS3.equal, true, `BODYATTR: the version's <html>/<body> attributes differ from v1's beyond the known S3 spellcheck: ${JSON.stringify({ body: v.beyondS3.body, html: v.beyondS3.html })}`);
}

/** I2 in the version, with the failure saying where. */
function i2InVersion(v, typed) {
  return checkI2({ peers: { [`version ${v.versionId}`]: v.segs }, typed });
}

/** I8 in the version, and the suggestion's quote gone from it. */
function assertAcceptedOnce(v, threadId) {
  assertInvariant(checkI8({ draftText: v.text, accepted: [{ annId: threadId, replacement: SUGGESTION.replacement }] }));
  assert.equal(v.text.includes(SUGGESTION.exact), false, `the accepted suggestion's quote "${SUGGESTION.exact}" is gone from ${v.versionId}`);
}

/** The agent's commit_draft published v2 (not deduped). */
function assertPublished(out, what) {
  assert.equal(out.isError, false, `${what}: the agent's commit_draft publishes once nobody is in the editor, got ${JSON.stringify(out.text.slice(0, 300))}`);
  assert.deepEqual({ versionId: out.json?.versionId, deduped: out.json?.deduped }, { versionId: "v2", deduped: false }, `${what}: commit_draft published v2`);
}

/** The live log is empty after the agent's write (SPEC §16: it "drops a log nobody is using"). */
async function assertLogDropped(t, docId, what) {
  const n = await logEntriesAfter(t, docId);
  assert.equal(n, 0, `C11 log: status/${docId}/y is empty after ${what} (it still holds ${entries(n)})`);
}

/**
 * The accept's OWN drop of the live log (accept.ts clearEditLog; SPEC §22
 * "a log nobody is using is dropped with the write"), read before
 * commit_draft could drop it. The log must have held the editors' typing
 * before the accept, or there was nothing to see dropped.
 */
function assertAcceptDroppedLog(docId, w) {
  precondition(w.logBefore > 0, `status/${docId}/y holds the editors' typing before the agent's accept (it held ${entries(w.logBefore)}), so the accept's drop can be seen`);
  assert.equal(w.logAfterAccept, 0, `C11 log: status/${docId}/y is empty after the agent's accept_suggestion, before commit_draft (it still holds ${entries(w.logAfterAccept)})`);
}

/** Every agent write the positive controls expect once nobody is in the editor: the accept goes ahead and drops the log, commit_draft publishes v2, and the log stays empty. */
async function assertAgentWentAhead(ctx, docId, w, what) {
  assert.equal(w.accept.isError, false, `${what}: nobody is in the editor, so the agent's accept_suggestion goes ahead (${w.accept.text.slice(0, 300)})`);
  assertAcceptDroppedLog(docId, w);
  assertPublished(w.commit, what);
  await assertLogDropped(ctx.target, docId, "the agent's accept and commit_draft");
}

// --- C6 --------------------------------------------------------------------------------------

const C6_NAME = "C6 everyone stops and presses Done inside the autosave debounce at once: every Done saves its own typing, nobody stays in the editor, the agent's commit_draft publishes the draft with no decoration (DECOR, BODYATTR apart from S3), the live log is empty after it, and status/{d}/peers empties within 5 s of everyone leaving (I12)";

scenario(C6_NAME, { tiers: BOTH, n: NS, timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const n = ctx.n;
  const obs = record(ctx, "C6");
  await withRss(ctx, n, async () => {
    const { docId, users, owner } = await join(ctx, { n, title: `C6 Done N=${n}` });
    obs.stage = "joined";
    const agent = await agentFor(ctx, owner);
    const parser = await ctx.users.parser();
    const log = tokenLog(ctx.target.runId);
    const plan = users.map((u, i) => ({ u, id: paragraph(i), tokens: Array.from({ length: TOKENS }, () => log.next(u.name, paragraph(i))) }));
    const ids = plan.map((p) => p.id);
    let armed = null;
    try {
      armed = await armSaves(users);
      ctx.step(`at once, each of ${n} editors types ${TOKENS - 1} tokens at the end of its own paragraph (#e2e-1…#e2e-${n}), then, again at once, its last one`);
      await Promise.all(plan.map(({ u, id, tokens }) => typeTokens(u, id, tokens.slice(0, -1))));
      await Promise.all(plan.map(({ u, id, tokens }) => typeTokens(u, id, tokens.slice(-1))));
      ctx.step(`everyone has stopped; every page presses Done at one instant (${DONE_LEAD_MS} ms ahead), inside the ${AUTOSAVE_MS} ms autosave debounce`);
      const fired = await syncPages(users.map((u) => u.page), pressDone, { leadMs: DONE_LEAD_MS });
      judgeDoneTiming(ctx, obs, users, fired, await inputWindows(armed));

      obs.stage = "leaving the editor";
      await Promise.all(users.map((u) => editorClosed(u)));
      const rows = await savesSince(armed, fired.t0 - 50);
      // Each editor's FIRST POST /draft after Done is Done's own save. A later
      // one is the autosave timer still firing while that save is in flight
      // (X-c06-leave-commit-1), judged nowhere; every one is in `saves`.
      const saves = saveRows(rows, log);
      const flushes = users.map((u, i) => {
        const mine = rows.filter((x) => x.u === u).map((x) => x.r).sort((a, b) => a.sentAt - b.sentAt);
        const html = String(mine[0]?.postJson?.html ?? "");
        return {
          name: u.name,
          saves: mine.length,
          statuses: mine.map((r) => r.status ?? r.state),
          ownTokens: plan[i].tokens.filter((t) => html.includes(t)).length,
          allTokens: log.typed.filter((t) => html.includes(t.token)).length,
          lastAllTokens: log.typed.filter((t) => String(mine.at(-1)?.postJson?.html ?? "").includes(t.token)).length,
          sentAt: mine[0]?.sentAt ?? null,
          answeredAt: mine[0]?.respondedAt ?? null,
          laterSentAt: mine.slice(1).map((r) => r.sentAt),
        };
      });
      const overlap = overlapProof(flushes.map((f) => ({ sentAt: f.sentAt, firstByteAt: f.answeredAt })));
      // S17's window: a save that lacked another editor's token was answered
      // LAST while the first saves were in flight together. Closed, the
      // version's I2 cannot tell anything about S17 ("C6 version" says so).
      const answered = saves.filter((s) => Number.isFinite(s.respondedAt)).sort((a, b) => a.respondedAt - b.respondedAt);
      const lastAnswered = answered.at(-1) ?? null;
      const lacking = saves.filter((s) => s.lacks.length > 0);
      obs.s17Window = {
        open: lacking.length > 0 && overlap.ok && (lastAnswered?.lacks.length ?? 0) > 0,
        saves,
        lacking: lacking.length,
        lastAnswered,
        overlap,
      };
      obs.flushes = { flushes, overlap, saves };
      ctx.ev.json("done-saves", obs.flushes);
      measure(ctx, MEASURE, { scenario: "C6 S17 window", open: obs.s17Window.open, typed: log.typed.length, lacking: lacking.length, lastAnswered: lastAnswered ? saveSummary(lastAnswered) : null, overlap: { ok: overlap.ok, marginMs: overlap.marginMs ?? null }, saves: saves.map(saveSummary) });
      ctx.step(`Done saves: ${flushes.map((f) => `${f.name} ${f.saves} POST /draft (${f.statuses.join("/")}), the first with ${f.allTokens}/${log.typed.length} tokens`).join(", ")}; in flight together: ${overlap.ok ? "yes" : `no (${overlap.reason})`}; ${lacking.length}/${saves.length} save(s) lacked another editor's token, the last answered (${lastAnswered?.name ?? "none"}) lacked ${lastAnswered?.lacks.length ?? "?"}`);
      assert.deepEqual(
        flushes.map((f) => ({ name: f.name, saved: f.saves >= 1, every200: f.statuses.every((s) => s === 200), ownTokens: f.ownTokens })),
        flushes.map((f) => ({ name: f.name, saved: true, every200: true, ownTokens: TOKENS })),
        "C6 Done: every editor's Done saves its unsaved typing: its first POST /draft after Done holds every token it typed, and every save is answered 200 (SPEC §6a)",
      );

      obs.stage = "settling";
      const settled = await settle(users, docId, n);
      ctx.step(`the readers settled in ${settled.ms} ms on ${settled.hash.slice(0, 16)} (I1)`);
      const nobody = await waitModes(ctx.target, docId, (m) => editorsIn(m).length === 0);
      ctx.step(`presence after Done: ${JSON.stringify(nobody.modes)}`);
      assert.deepEqual(editorsIn(nobody.modes), [], `C6: within ${PRESENCE_MS} ms of Done nobody is "edit" in status/${docId}/peers`);

      obs.stage = "reading the peers";
      const peerHashes = await peerBodyHashes(parser, users);
      const draftHash = (await parsedBodyHash(parser, await readDraft(owner, docId))).hash;
      ctx.step(`the draft ${draftHash.slice(0, 12)}; every reader ${JSON.stringify(peerHashes).slice(0, 300)}`);

      obs.stage = "committing";
      const out = await agentCall(agent, "commit_draft", { id: docId });
      obs.commit = out;
      ctx.step(`the agent's commit_draft: ${out.isError ? `refused: ${out.text}` : JSON.stringify(out.json)}`);
      assertPublished(out, "C6");
      await assertLogDropped(ctx.target, docId, "the agent's commit_draft");

      obs.stage = "reading the version";
      const v = await readVersion(ctx, { parser, docId, versionId: "v2", ids });
      obs.version = { ...v, peerHashes, draftHash, typed: log.typed };
      ctx.step(`v2 ${v.hash.slice(0, 12)}; BODYATTR v1→v2 ${JSON.stringify({ body: v.bodyAttr.body, html: v.bodyAttr.html })}`);
      assertCleanVersion(v);

      obs.stage = "leaving";
      const left = await leaveAtOnce(users, "app");
      ctx.step(`everyone left the document in the app at once (spread ${left.spreadMs.toFixed(1)} ms)`);
      const i12 = await waitPeersGone(ctx.target, docId, left.t0);
      ctx.step(i12.ok ? `status/${docId}/peers emptied ${i12.ms} ms after everyone left` : i12.failures.join("; "));
      assertInvariant(i12);
      obs.stage = "done";
    } finally {
      stopCaptures(armed);
    }
  });
});

scenario("C6 version: the version the agent's commit_draft published after everyone pressed Done at once holds every typed token once and whole (I2) and equals the body every peer read (I5)", { tiers: BOTH, n: NS, timeoutMs: JUDGE_MS }, async (ctx) => {
  const v = observation(ctx, "C6", "version");
  const w = observation(ctx, "C6", "s17Window");
  const last = w.lastAnswered ? `${w.lastAnswered.name}, lacking ${w.lastAnswered.lacks.length}` : "none";
  ctx.step(`S17's window under this timing: ${w.lacking}/${w.saves.length} save(s) after Done lacked another editor's token; the last answered: ${last}; the first saves in flight together: ${w.overlap.ok ? "yes" : "no"} → ${w.open ? "OPEN" : "closed: every save that could land last held every token, so this judges the version, not S17 (C6 latency opens the window)"}`);
  if (w.open) ctx.inconclusive(`S17's window opened under natural timing: a save lacking ${w.lastAnswered.lacks.length} token(s) of other editors (${w.lastAnswered.name}'s) was answered last while the saves were in flight together, so the version's I2 is S17's question here (C6 latency judges it), not this case's`);
  ctx.step(`v2 ${v.hash.slice(0, 12)} against ${Object.keys(v.peerHashes).length} reader(s) and the draft ${v.draftHash.slice(0, 12)}`);
  assertInvariant(i2InVersion(v, v.typed));
  const r = checkI5({ draftHash: v.hash, peerHashes: v.peerHashes, decoration: v.decoration, bodyAttr: v.beyondS3 });
  assert.ok(r.ok, `I5 (in the version, for "draft" read v2): ${r.failures.join("; ")}`);
});

// --- C6-serial ---------------------------------------------------------------------------------

/**
 * C6's positive control: each editor in turn types its tokens, presses Done
 * inside the debounce, waits for its editor to close (its save answered) and
 * for its last token at every other peer; then every C6 oracle, and the
 * version's I2 and I5, must hold. With `latencyMs` (C6 latency's control) the
 * turns run with every client→database byte that late, so each token reaches
 * the others only after it, as in C6 latency.
 */
async function c6Serial(ctx, n, { latencyMs = 0 } = {}) {
  await withRss(ctx, n, async () => {
    const title = `C6 serial${latencyMs ? " latency" : ""} N=${n}`;
    const { docId, users, owner, lat } = latencyMs ? await joinThroughProxy(ctx, title) : { ...(await join(ctx, { n, title })), lat: null };
    const agent = await agentFor(ctx, owner);
    const parser = await ctx.users.parser();
    const log = tokenLog(ctx.target.runId);
    const plan = users.map((u, i) => ({ u, id: paragraph(i), tokens: Array.from({ length: TOKENS }, () => log.next(u.name, paragraph(i))) }));
    const ids = plan.map((p) => p.id);
    const turns = async () => {
      ctx.step(`one editor after another${latencyMs ? `, every client→database byte ${latencyMs} ms late` : ""}: type ${TOKENS} tokens, press Done inside the debounce, wait for the last token at every other peer`);
      for (const { u, id, tokens } of plan) {
        const rec = await u.recordSaveStates();
        const cap = u.capture({ paths: ["/draft"], method: "POST" });
        await typeTokens(u, id, tokens);
        await clickDone(u);
        await editorClosed(u);
        await savesLanded(u, cap);
        const r = await rec.stop();
        const last = Math.max(...r.inputs.filter(Number.isFinite));
        const saving = r.states.find((s) => s.s === "saving" && s.t >= last);
        const sinceMs = saving ? saving.t - last : null;
        if (!(sinceMs != null && sinceMs < AUTOSAVE_MS - DEBOUNCE_MARGIN_MS)) ctx.inconclusive(`${u.name}'s Done was not inside the autosave debounce: its save began ${sinceMs == null ? "never" : `${Math.round(sinceMs)} ms`} after its last key`);
        await Promise.all(users.filter((o) => o !== u).map((o) => waitTextIn(o, id, tokens.at(-1))));
        ctx.step(`${u.name}: Done ${Math.round(sinceMs)} ms after its last key; every other peer shows ${tokens.at(-1)}`);
      }
    };
    if (lat) await underLatency(ctx, lat, latencyMs, turns);
    else await turns();
    const settled = await settle(users, docId, n);
    ctx.step(`the readers settled in ${settled.ms} ms (I1)`);
    const nobody = await waitModes(ctx.target, docId, (m) => editorsIn(m).length === 0);
    assert.deepEqual(editorsIn(nobody.modes), [], `C6: within ${PRESENCE_MS} ms of Done nobody is "edit" in status/${docId}/peers`);
    const peerHashes = await peerBodyHashes(parser, users);
    const out = await agentCall(agent, "commit_draft", { id: docId });
    ctx.step(`the agent's commit_draft: ${out.isError ? `refused: ${out.text}` : JSON.stringify(out.json)}`);
    assertPublished(out, "C6-serial");
    await assertLogDropped(ctx.target, docId, "the agent's commit_draft");
    const v = await readVersion(ctx, { parser, docId, versionId: "v2", ids });
    assertCleanVersion(v);
    assertInvariant(i2InVersion(v, log.typed));
    const r = checkI5({ draftHash: v.hash, peerHashes, decoration: v.decoration, bodyAttr: v.beyondS3 });
    assert.ok(r.ok, `I5 (in the version, for "draft" read v2): ${r.failures.join("; ")}`);
    const left = await leaveAtOnce(users, "app");
    assertInvariant(await waitPeersGone(ctx.target, docId, left.t0));
  });
}

scenario("C6-serial positive control: the same typing and Done inside the debounce one editor after another, then the agent's commit_draft: nobody stays in the editor, the live log is empty, the version is clean and holds every token once (I2) and every peer's body (I5), and status/{d}/peers empties within 5 s (I12)", { tiers: BOTH, n: NS, trials: CONTROL_TRIALS, timeoutMs: SERIAL_MS, ...LIVE }, async (ctx) => {
  await c6Serial(ctx, ctx.n);
});

// --- C6 latency ----------------------------------------------------------------------------------

/**
 * S17's natural interleaving, opened by RTDB latency: after a first round in
 * which every editor's token reaches everyone (phase 1), every
 * client→database byte is held latencyFor(N) while the editors type at once
 * and press Done at once inside the debounce, so each save after Done is
 * serialized before any other editor's last keys reach its page. The race
 * proof (else INCONCLUSIVE): every such save answered 200, holding its own
 * editor's tokens and lacking at least one other editor's. Then the delay
 * drains, the session settles, and the agent's commit_draft publishes.
 * Resolves {version, typed} for the oracle.
 */
async function c6Latency(ctx) {
  const n = ctx.n;
  const ms = latencyFor(n);
  const { docId, users, owner, lat } = await joinThroughProxy(ctx, `C6 latency N=${n}`);
  const agent = await agentFor(ctx, owner);
  const parser = await ctx.users.parser();
  const log = tokenLog(ctx.target.runId);
  ctx.step("phase 1, no delay: each editor in turn types a token into its own paragraph, autosaves it and waits for it at every peer; the session settles");
  await typeInTurn(users, log);
  await settleFirst(users, docId, n);
  const plan = users.map((u, i) => ({ u, id: paragraph(i), tokens: Array.from({ length: TOKENS }, () => log.next(u.name, paragraph(i))) }));
  let armed = null;
  try {
    armed = await armSaves(users);
    await underLatency(ctx, lat, ms, async () => {
      ctx.step(`phase 2, every client→database byte ${ms} ms late: at once, each editor types ${TOKENS - 1} tokens at the end of its own paragraph, then its last; then every page presses Done at one instant (${DONE_LEAD_MS} ms ahead) inside the debounce`);
      await Promise.all(plan.map(({ u, id, tokens }) => typeTokens(u, id, tokens.slice(0, -1))));
      await Promise.all(plan.map(({ u, id, tokens }) => typeTokens(u, id, tokens.slice(-1))));
      const fired = await syncPages(users.map((u) => u.page), pressDone, { leadMs: DONE_LEAD_MS });
      judgeDoneTiming(ctx, null, users, fired, await inputWindows(armed));
      await Promise.all(users.map((u) => editorClosed(u)));
      // The timer's second save (X-c06-leave-commit-1) is sent as Done's own
      // is answered: give its request a moment to be captured.
      await sleep(300);
      const saves = saveRows(await savesSince(armed, fired.t0 - 50), log);
      ctx.ev.json("latency-saves", { latencyMs: ms, saves });
      measure(ctx, MEASURE, { scenario: "C6 latency window", latencyMs: ms, typed: log.typed.length, open: saves.length > 0 && saves.every((s) => s.lacks.length > 0), saves: saves.map(saveSummary) });
      ctx.step(`saves after Done: ${saves.map((s) => `${s.name} ${s.status}, own ${s.own}/${TOKENS + 1}, lacking ${s.lacks.length} of the others'`).join("; ")}`);
      precondition(saves.length > 0 && saves.every((s) => s.status === 200), `every save after Done is answered 200 (${saves.map((s) => `${s.name} ${s.status}`).join(", ") || "none"})`);
      for (const u of users) {
        const first = saves.find((s) => s.name === u.name);
        precondition(first && first.own === TOKENS + 1, `${u.name}'s Done save holds every token it typed (${first ? `${first.own}/${TOKENS + 1}` : "no save"}): C6's own oracle, not S17`);
      }
      const whole = saves.filter((s) => s.lacks.length === 0);
      if (whole.length) ctx.inconclusive(`the latency window did not open: ${whole.map((s) => s.name).join(", ")} sent a save after Done holding every editor's token, so the order the saves land in cannot lose one`);
      ctx.step(`race: each of ${saves.length} save(s) after Done was serialized before another editor's last keys reached it (every one lacks at least one), and each was answered 200`);
    });
  } finally {
    stopCaptures(armed);
  }
  await settleFirst(users, docId, n);
  const nobody = await waitModes(ctx.target, docId, (m) => editorsIn(m).length === 0);
  if (!nobody.ok) ctx.inconclusive(`the sync precondition did not hold: somebody is still "edit" in status/${docId}/peers ${PRESENCE_MS} ms after every Done and the delay drained: ${JSON.stringify(nobody.modes)}`);
  const out = await agentCall(agent, "commit_draft", { id: docId });
  ctx.step(`the agent's commit_draft: ${out.isError ? `refused: ${out.text}` : JSON.stringify(out.json)}`);
  precondition(!out.isError && out.json?.versionId === "v2", `the agent's commit_draft publishes v2 (${out.text.slice(0, 300)})`);
  const version = await readVersion(ctx, { parser, docId, versionId: "v2", ids: users.map((_, i) => paragraph(i)) });
  return { version, typed: log.typed };
}

scenario("C6 latency: with every client→database byte held past the debounce, everyone types and presses Done at once, so every save after Done lacks another editor's last keys; the version the agent's commit_draft publishes still holds every token anybody saved (I2)", { tiers: LOCAL, needs: ["rtdb-proxy"], n: NS, timeoutMs: CASE_MS, defect: "S17", ...LIVE }, async (ctx) => {
  const { version, typed } = await withRss(ctx, ctx.n, () => c6Latency(ctx));
  assertInvariant(i2InVersion(version, typed));
});

scenario("C6 latency serial control: under the same delay, each editor in turn types, presses Done inside the debounce and waits for its last token at every other peer; then the agent's commit_draft: nobody stays in the editor, the live log is empty, the version is clean and holds every token once (I2) and every peer's body (I5), and status/{d}/peers empties within 5 s (I12)", { tiers: LOCAL, needs: ["rtdb-proxy"], n: NS, trials: CONTROL_TRIALS, timeoutMs: SERIAL_MS, ...LIVE }, async (ctx) => {
  await c6Serial(ctx, ctx.n, { latencyMs: latencyFor(ctx.n) });
});

// --- C6 late save ------------------------------------------------------------------------------

/**
 * p1's Done save, delayed in flight (`hold`) or not, while every other
 * editor in turn types a token, autosaves it and presses Done; the agent's
 * commit_draft then publishes the draft. Resolves {version, typed} for the
 * oracle; everything before it is a precondition or INCONCLUSIVE.
 */
async function c6LateSave(ctx, { hold }) {
  const n = ctx.n;
  const { docId, users, owner } = await join(ctx, { n, title: `C6 late save N=${n}${hold ? "" : " serial"}` });
  const agent = await agentFor(ctx, owner);
  const parser = await ctx.users.parser();
  const log = tokenLog(ctx.target.runId);
  const [p1, ...rest] = users;
  ctx.step("phase 1: each editor in turn types a token into its own paragraph, autosaves it and waits for it at every peer; the session settles");
  await typeInTurn(users, log);
  await settleFirst(users, docId, n);

  const late = log.next(p1.name, paragraph(0));
  const cap = p1.capture({ paths: ["/draft"], method: "POST" });
  const held = hold ? holdRequests(p1.page, isDraftPost, 1, { method: "POST", timeoutMs: 30_000 }) : null;
  try {
    if (held) await held.installed;
    ctx.step(`phase 2: ${p1.name} types ${late} and presses Done inside the debounce${hold ? "; its save is held in flight" : "; its save lands at once"}`);
    const rec = await p1.recordSaveStates();
    await typeTokens(p1, paragraph(0), [late]);
    await clickDone(p1);
    if (held) {
      await held.held.catch(() => ctx.inconclusive(`the sync precondition did not hold: ${p1.name}'s Done save was never held (${held.records.length} held)`));
      // The autosave timer is not cleared while Done's save is in flight, so
      // it may send one more save at its deadline (not held: only the first
      // is). Let that one land before anybody else types.
      await sleep(AUTOSAVE_MS + 300);
      await savesLanded(p1, cap, { except: [...cap][0], stop: false });
    } else {
      await editorClosed(p1);
      await savesLanded(p1, cap, { stop: false });
    }
    const r = await rec.stop();
    const lastKey = Math.max(...r.inputs.filter(Number.isFinite));
    const saving = r.states.find((s) => s.s === "saving" && s.t >= lastKey);
    const sinceMs = saving ? saving.t - lastKey : null;
    if (!(sinceMs != null && sinceMs < AUTOSAVE_MS - DEBOUNCE_MARGIN_MS)) ctx.inconclusive(`${p1.name}'s Done was not inside the autosave debounce: its save began ${sinceMs == null ? "never" : `${Math.round(sinceMs)} ms`} after its last key`);
    const p1Saves = [...cap];
    ctx.ev.json("p1-saves", p1Saves.map((s) => ({ sentAt: s.sentAt, status: s.status, state: s.state, tokens: log.typed.filter((t) => String(s.postJson?.html ?? "").includes(t.token)).length })));
    const p1Save = p1Saves[0];
    precondition(p1Save && String(p1Save.postJson?.html ?? "").includes(late), `${p1.name}'s Done save carries ${late}`);
    await Promise.all(rest.map((u) => waitTextIn(u, paragraph(0), late)));
    ctx.step(`${p1.name}'s Done save began ${Math.round(sinceMs)} ms after its last key; every other editor shows ${late}`);

    ctx.step(`phase 3: ${rest.map((u) => u.name).join(", ")} in turn type a token, autosave it and wait for it at the others still editing; then they press Done`);
    const typedLater = [];
    for (const [j, u] of rest.entries()) {
      const id = paragraph(j + 1);
      const token = log.next(u.name, id);
      typedLater.push(token);
      await typeSaveArrive(u, rest, id, token);
    }
    await Promise.all(rest.map((u) => u.done()));
    const before = await readDraft(owner, docId);
    const inDraft = log.typed.filter((t) => before.includes(t.token)).length;
    precondition(inDraft === log.typed.length, `before ${p1.name}'s save lands, the draft holds every token saved so far (${inDraft}/${log.typed.length})`);
    if (held) {
      const p1Html = String(p1Save.postJson?.html ?? "");
      const lacking = typedLater.filter((t) => !p1Html.includes(t));
      if (lacking.length !== typedLater.length) ctx.inconclusive(`the sync precondition did not hold: ${p1.name}'s held save was not serialized before ${typedLater.join(", ")} were typed (it already holds ${typedLater.length - lacking.length} of them)`);
      ctx.step(`race: ${p1.name}'s save, serialized before ${typedLater.length} later token(s), is released after every later save`);
      const released = await held.release();
      ctx.ev.json("held-save", released.records);
      precondition(released.records[0]?.status === 200, `${p1.name}'s released save is answered 200 (${released.records[0]?.status})`);
      await editorClosed(p1);
    }
    p1.inEdit = false;
    await settleFirst(users, docId, n);
    const nobody = await waitModes(ctx.target, docId, (m) => editorsIn(m).length === 0);
    if (!nobody.ok) ctx.inconclusive(`the sync precondition did not hold: somebody is still "edit" in status/${docId}/peers ${PRESENCE_MS} ms after everyone pressed Done: ${JSON.stringify(nobody.modes)}`);
    const out = await agentCall(agent, "commit_draft", { id: docId });
    ctx.step(`the agent's commit_draft: ${out.isError ? `refused: ${out.text}` : JSON.stringify(out.json)}`);
    precondition(!out.isError && out.json?.versionId === "v2", `the agent's commit_draft publishes v2 (${out.text.slice(0, 300)})`);
    const v = await readVersion(ctx, { parser, docId, versionId: "v2", ids: users.map((_, i) => paragraph(i)) });
    return { version: v, typed: log.typed, typedLater };
  } finally {
    cap.stop();
    if (held) await held.unroute().catch(() => undefined);
  }
}

scenario("C6 late save: one editor's Done save is delayed in flight while the others type, autosave and leave; once it lands last, the version the agent's commit_draft publishes still holds every token anybody saved (I2)", { tiers: BOTH, n: NS, timeoutMs: CASE_MS, defect: "S17", ...LIVE }, async (ctx) => {
  const { version, typed } = await c6LateSave(ctx, { hold: true });
  assertInvariant(i2InVersion(version, typed));
});

scenario("C6 late save serial control: the same saves with the first editor's Done save landing at once, before the others type: the version the agent's commit_draft publishes holds every token (I2)", { tiers: BOTH, n: NS, trials: CONTROL_TRIALS, timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const { version, typed } = await c6LateSave(ctx, { hold: false });
  assertInvariant(i2InVersion(version, typed));
});

// --- C11a --------------------------------------------------------------------------------------

/**
 * The revoked-editor flow. pN goes (`how`: "leave", leaving the document in
 * the app; "close", closing its tab while still in the editor, so no React
 * cleanup runs and only the server's onDisconnect can remove its node) AFTER
 * the owner removes it while it is in the editor, or (`first`, the positive
 * control) BEFORE (for "leave" it presses Done first). Then the members
 * press Done and leave; I12 is measured from their leaving through
 * rtdbGetPatient (the uids left recorded); then the agent accepts the
 * suggestion and commits, with the live log read around the accept and the
 * presence it read recorded. Resolves what was measured; `obs` holds it too.
 */
async function c11aFlow(ctx, obs, { how, first }) {
  const n = ctx.n;
  const { docId, users, owner, accounts, grantVia, mirrored } = await join(ctx, { n, title: `C11a ${how}${first ? " first" : ""} N=${n}` });
  obs.stage = "joined";
  obs.grant = { via: grantVia, mirrored };
  const agent = await agentFor(ctx, owner);
  const log = tokenLog(ctx.target.runId);
  const revoked = users[n - 1];
  const revokedAcct = accounts[n - 1];
  const members = users.slice(0, n - 1);
  const uids = accounts.map((a) => a.uid);
  const memberUids = uids.slice(0, n - 1);
  obs.names = Object.fromEntries(accounts.map((a, i) => [a.uid, users[i].name]));
  obs.revokedName = revoked.name;
  obs.revokedUid = revokedAcct.uid;
  ctx.step("each editor in turn types a token into its own paragraph and autosaves it; the session settles");
  await typeInTurn(users, log);
  await settleFirst(users, docId, n);
  const threadId = await suggestionOn(agent, docId);
  await requirePresence(ctx, obs, docId, uids, "edit");
  const goes = async () => {
    if (how === "leave") {
      if (first) await revoked.done();
      await leaveOne(revoked);
    } else {
      await revoked.page.close();
      revoked.inEdit = false;
    }
  };
  const going = how === "leave" ? "leaves the document in the app" : "closes its tab while still in the editor (no leave in the app: only the server's onDisconnect)";
  if (first) {
    ctx.step(`${revoked.name} ${how === "leave" ? "presses Done and " : ""}${going}, first`);
    await goes();
    const gone = await waitModes(ctx.target, docId, (m) => !(revokedAcct.uid in m));
    if (!gone.ok) inconclusive(ctx, obs, `the sync precondition did not hold: ${revoked.name}'s node never went once it ${how === "leave" ? "left the document" : "closed its tab"}, before it was removed (status/${docId}/peers: ${JSON.stringify(gone.modes)})`);
  }
  ctx.step(`the owner removes ${revoked.name} from the document${first ? "" : " while it is in the editor"}`);
  obs.removal = await removeEditor(ctx, obs, { owner, docId, account: revokedAcct, via: grantVia });
  if (!first) {
    obs.revokedNode = (await peerModes(ctx.target, docId))[revokedAcct.uid] ?? null;
    ctx.step(`removed while editing: ${revoked.name}'s node says ${JSON.stringify(obs.revokedNode)}; it ${going}`);
    await goes();
  }
  ctx.step("the members press Done");
  await Promise.all(members.map((u) => u.done()));
  const viewing = await waitModes(ctx.target, docId, (m) => memberUids.every((uid) => m[uid] === "view"));
  if (!viewing.ok) inconclusive(ctx, obs, `the sync precondition did not hold: every member's presence never said "view" after Done (status/${docId}/peers: ${JSON.stringify(viewing.modes)})`);
  obs.peersBeforeLeaving = viewing.modes;
  ctx.step(`presence once every member pressed Done: ${JSON.stringify(viewing.modes)}`);
  obs.stage = "leaving";
  const left = await leaveAtOnce(members, "app");
  const i12 = await waitPeersGone(ctx.target, docId, left.t0);
  obs.peersLeft = i12.peersLeft;
  obs.i12 = i12;
  const named = (list) => list.map((uid) => `${obs.names[uid] ?? uid}${uid === obs.revokedUid ? " (removed)" : ""}`).join(", ");
  ctx.step(i12.ok ? `status/${docId}/peers emptied ${i12.ms} ms after the members left` : `${i12.failures.join("; ")} (${named(i12.peersLeft)})`);
  obs.stage = "the agent";
  obs.peersAtCall = await peerModes(ctx.target, docId);
  obs.agent = await agentWrites(ctx, agent, docId, threadId);
  return { docId, users, owner, threadId, log, revoked, revokedAcct, memberUids };
}

/**
 * What S11 predicts, and nothing else, before its oracle: no member's node
 * outlives everyone's leaving, no member is "edit" when the agent writes,
 * and a refusal is editorsRefusal for ONE editor, made while the removed
 * editor's ghost says "edit". Anything else is another defect, so it FAILS
 * (a precondition) instead of reading as S11's TODO.
 */
function onlyS11(what, o, { peers = true, agent = true } = {}) {
  const name = (uid) => o.names?.[uid] ?? uid;
  if (peers) {
    const members = (o.peersLeft ?? []).filter((uid) => uid !== o.revokedUid);
    precondition(members.length === 0, `${what}: only the removed editor's node may outlive everyone's leaving (S11); a member's is left too: ${members.map(name).join(", ")}`);
  }
  if (agent && o.agent) {
    const memberEditors = editorsIn(o.peersAtCall ?? {}).filter((uid) => uid !== o.revokedUid);
    precondition(memberEditors.length === 0, `${what}: no member is "edit" when the agent writes, but ${memberEditors.map(name).join(", ")} ${memberEditors.length === 1 ? "is" : "are"} (${JSON.stringify(o.peersAtCall)})`);
    for (const [out, doing] of [[o.agent.accept, "accepted"], [o.agent.commit, "published"]]) {
      if (!out.isError) continue;
      precondition(out.text === editingRefusal(1, doing), `${what}: the agent's write was refused, but not with S11's refusal (editorsRefusal for the one ghost): ${JSON.stringify(out.text.slice(0, 300))}`);
      precondition(o.peersAtCall?.[o.revokedUid] === "edit", `${what}: the agent was refused for one editor, but the removed editor's node did not say "edit" when it wrote (${JSON.stringify(o.peersAtCall)})`);
    }
  }
}

/** The agent's two writes as S11's oracle reads them. */
const agentOutcome = ({ accept, commit }) => ({ accept: accept.isError ? accept.text : "accepted", commit: commit.isError ? commit.text : "published" });

scenario("C11a revoked ghost: an editor is removed while in the editor and leaves the document, then the members press Done and leave; the mirrors drop it and every member's presence says view (what presence and the agent then do is judged below)", { tiers: BOTH, n: NS, timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const obs = record(ctx, "C11a");
  await withRss(ctx, ctx.n, async () => {
    const { docId, revoked, revokedAcct } = await c11aFlow(ctx, obs, { how: "leave", first: false });
    obs.stage = "closing the revoked tab";
    ctx.step(`${revoked.name}'s tab closes; its node is watched for ${GHOST_CLOSE_MS} ms (recorded, not judged)`);
    const t0 = Date.now();
    await revoked.page.close();
    const gone = await waitModes(ctx.target, docId, (m) => !(revokedAcct.uid in m), GHOST_CLOSE_MS);
    obs.ghostAfterClose = { gone: gone.ok, ms: gone.ok ? Date.now() - t0 : null, modes: gone.modes };
    ctx.ev.json("c11a-ghost", { grant: obs.grant, removal: obs.removal, revokedNode: obs.revokedNode, peersBeforeLeaving: obs.peersBeforeLeaving, peersLeft: obs.peersLeft, peersAtCall: obs.peersAtCall, afterClose: obs.ghostAfterClose });
    ctx.step(gone.ok ? `the revoked tab's node went ${obs.ghostAfterClose.ms} ms after the tab closed` : `the revoked tab's node is still there ${GHOST_CLOSE_MS} ms after the tab closed: ${JSON.stringify(gone.modes)}`);
    assertInvariant(obs.i12);
    assert.deepEqual(agentOutcome(obs.agent), { accept: "accepted", commit: "published" }, "C11a: nobody retains an editing veto after revocation and leave");
    obs.stage = "done";
  });
});

scenario("C11a presence: once the removed editor and every member have left the document, status/{d}/peers is empty within 5 s (I12)", { tiers: BOTH, n: NS, timeoutMs: JUDGE_MS }, async (ctx) => {
  const i12 = observation(ctx, "C11a", "i12");
  const o = observed.get(keyOf("C11a", ctx));
  ctx.step(`status/{d}/peers after everyone left: ${o.peersLeft.map((uid) => `${o.names?.[uid] ?? uid}${uid === o.revokedUid ? " (removed)" : ""}`).join(", ") || "empty"}; the removed editor's node while it was being removed: ${JSON.stringify(o.revokedNode ?? null)}`);
  onlyS11("C11a presence", o, { agent: false });
  assertInvariant(i12);
});

scenario("C11a agent: once every member has left the editor and the removed editor has left the document, the agent's accept_suggestion and commit_draft go ahead", { tiers: BOTH, n: NS, timeoutMs: JUDGE_MS }, async (ctx) => {
  const a = observation(ctx, "C11a", "agent");
  const o = observed.get(keyOf("C11a", ctx));
  ctx.step(`presence the agent read: ${JSON.stringify(o.peersAtCall)}`);
  onlyS11("C11a agent", o, { peers: false });
  assert.deepEqual(agentOutcome(a), { accept: "accepted", commit: "published" }, "C11a: nobody is in the editor, so the agent's accept_suggestion and commit_draft go ahead (SPEC §16: refused only while anybody is in it)");
});

scenario("C11a-serial positive control: the editor leaves the document before it is removed; then the members press Done and leave: status/{d}/peers empties within 5 s (I12), and the agent's accept (dropping the live log) and commit_draft publish the accepted change once (I8) and every saved token (I2), leaving the live log empty", { tiers: BOTH, n: NS, trials: CONTROL_TRIALS, timeoutMs: SERIAL_MS, ...LIVE }, async (ctx) => {
  const obs = { stage: "started" };
  const { docId, threadId, log } = await c11aFlow(ctx, obs, { how: "leave", first: true });
  assertInvariant(obs.i12);
  await assertAgentWentAhead(ctx, docId, obs.agent, "C11a-serial");
  const parser = await ctx.users.parser();
  const v = await readVersion(ctx, { parser, docId, versionId: "v2", ids: [...new Set(log.typed.map((t) => t.target))] });
  assertAcceptedOnce(v, threadId);
  assertInvariant(i2InVersion(v, log.typed));
});

scenario("C11a closed: an editor is removed while in the editor and closes its tab still in the editor (no leave in the app), then the members press Done and leave; status/{d}/peers is empty within 5 s (I12) and the agent's accept_suggestion and commit_draft go ahead", { tiers: BOTH, n: NS, timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const obs = { stage: "started", inconclusive: null };
  await withRss(ctx, ctx.n, () => c11aFlow(ctx, obs, { how: "close", first: false }));
  ctx.ev.json("c11a-closed", { grant: obs.grant, removal: obs.removal, revokedNode: obs.revokedNode, peersBeforeLeaving: obs.peersBeforeLeaving, peersLeft: obs.peersLeft, peersAtCall: obs.peersAtCall, i12: obs.i12, agent: obs.agent });
  onlyS11("C11a closed", obs);
  assert.deepEqual(
    { peersLeft: obs.peersLeft.map((uid) => obs.names[uid] ?? uid), ...agentOutcome(obs.agent) },
    { peersLeft: [], accept: "accepted", commit: "published" },
    `C11a closed: once the removed editor's tab has closed and every member has left, status/{d}/peers is empty within 5 s (I12) and the agent's accept_suggestion and commit_draft go ahead (SPEC §16: refused only while anybody is in it; ${obs.i12.ok ? "I12 held" : obs.i12.failures.join("; ")})`,
  );
});

scenario("C11a closed serial control: the editor closes its tab while in the editor before it is removed; then the members press Done and leave: status/{d}/peers empties within 5 s (I12), and the agent's accept (dropping the live log) and commit_draft publish the accepted change once (I8) and every saved token (I2), leaving the live log empty", { tiers: BOTH, n: NS, trials: CONTROL_TRIALS, timeoutMs: SERIAL_MS, ...LIVE }, async (ctx) => {
  const obs = { stage: "started" };
  const { docId, threadId, log } = await c11aFlow(ctx, obs, { how: "close", first: true });
  assertInvariant(obs.i12);
  await assertAgentWentAhead(ctx, docId, obs.agent, "C11a closed serial");
  const parser = await ctx.users.parser();
  const v = await readVersion(ctx, { parser, docId, versionId: "v2", ids: [...new Set(log.typed.map((t) => t.target))] });
  assertAcceptedOnce(v, threadId);
  assertInvariant(i2InVersion(v, log.typed));
});

// --- C11b --------------------------------------------------------------------------------------

/** INCONCLUSIVE unless tab A is still in the editor and "Shared". */
async function requireTabAEditing(ctx, e) {
  const editing = await e.page.getByRole("toolbar", { name: "Formatting" }).isVisible();
  const share = await e.shareState();
  if (!(editing && share === "shared")) ctx.inconclusive(`the sync precondition did not hold: tab A (${e.name}) is not in the editor and "Shared" when the agent writes (toolbar ${editing}, share state ${share})`);
}

/**
 * Open the document in tab B and wait until its presence write has landed:
 * status/{d}/peers reads differently from just before the open (a proof that
 * holds however presence is keyed, so a fix keyed per tab passes it too);
 * else INCONCLUSIVE. Resolves the peers read.
 */
async function openTabB(ctx, tab, docId) {
  const before = JSON.stringify(await peersRaw(ctx.target, docId));
  await tab.open(docId, { timeout: 90_000 });
  const after = await eventually(async () => {
    const now = await peersRaw(ctx.target, docId);
    return JSON.stringify(now) !== before ? now : false;
  }, { timeout: PRESENCE_MS, interval: 150, message: `${tab.name}'s presence write lands` }).catch(() => null);
  if (!after) ctx.inconclusive(`the sync precondition did not hold: ${tab.name}'s presence never showed in status/${docId}/peers within ${PRESENCE_MS} ms of it opening the document`);
  return after;
}

/**
 * One person's two tabs. pN types and autosaves in tab A, everyone else
 * presses Done. `tabFirst` (the positive control): pN presses Done, the
 * second tab opens and closes, and only then does tab A enter the editor
 * again. Otherwise tab B opens and closes while tab A is in the editor.
 * Resolves the agent's two answers while tab A is in the editor.
 */
async function c11bFlow(ctx, { tabFirst }) {
  const n = ctx.n;
  const { docId, users, owner, accounts } = await join(ctx, { n, title: `C11b two tabs N=${n}${tabFirst ? " serial" : ""}` });
  const agent = await agentFor(ctx, owner);
  const log = tokenLog(ctx.target.runId);
  const e = users[n - 1];
  const eUid = accounts[n - 1].uid;
  const others = users.slice(0, n - 1);
  const uids = accounts.map((a) => a.uid);
  ctx.step(`${e.name} (tab A) types a token and autosaves it; every peer shows it`);
  await typeSaveArrive(e, users, paragraph(n - 1), log.next(e.name, paragraph(n - 1)));
  await settleFirst(users, docId, n);
  const threadId = await suggestionOn(agent, docId);
  await requirePresence(ctx, null, docId, uids, "edit");
  // One person's second tab (lib/browser.mjs User.newTab): the same context,
  // so the same account and presence node, with its own page and inEdit.
  const tabB = await e.newTab();
  const openAndCloseB = async () => {
    await tabB.open(docId, { timeout: 90_000 });
    const asB = await waitModes(ctx.target, docId, (m) => m[eUid] === "view", 5_000);
    ctx.step(`${tabB.name} opened the document: ${e.name}'s node says ${JSON.stringify(asB.modes[eUid] ?? null)}`);
    await tabB.close();
    const t0 = Date.now();
    const gone = await waitModes(ctx.target, docId, (m) => !(eUid in m), 5_000);
    ctx.step(`${tabB.name} closed: ${e.name}'s node ${gone.ok ? `went after ${Date.now() - t0} ms` : `says ${JSON.stringify(gone.modes[eUid] ?? null)}`}`);
    return { modeWhileOpen: asB.modes[eUid] ?? null, goneAfterClose: gone.ok };
  };
  let tab = null;
  if (tabFirst) {
    ctx.step(`${e.name} presses Done; a second tab of the same account opens the document and closes; then tab A enters the editor again`);
    await e.done();
    tab = await openAndCloseB();
    await e.enterEdit({ waitShared: true, timeout: 90_000 });
    const back = await waitModes(ctx.target, docId, (m) => m[eUid] === "edit");
    if (!back.ok) ctx.inconclusive(`the sync precondition did not hold: tab A's presence never said "edit" once it was back in the editor (${JSON.stringify(back.modes)})`);
  }
  ctx.step(`the others (${others.map((u) => u.name).join(", ")}) press Done`);
  await Promise.all(others.map((u) => u.done()));
  const otherUids = uids.slice(0, n - 1);
  const viewing = await waitModes(ctx.target, docId, (m) => otherUids.every((uid) => m[uid] === "view") && m[eUid] === "edit");
  if (!viewing.ok) ctx.inconclusive(`the sync precondition did not hold: presence never showed the others "view" and ${e.name} "edit" (status/${docId}/peers: ${JSON.stringify(viewing.modes)})`);
  if (!tabFirst) {
    ctx.step(`while tab A is in the editor, a second tab of ${e.name}'s account opens the document and closes`);
    tab = await openAndCloseB();
    await sleep(1_000);
  }
  await requireTabAEditing(ctx, e);
  const modes = await peerModes(ctx.target, docId);
  ctx.step(`presence the agent will read: ${JSON.stringify(modes)}`);
  ctx.ev.json("c11b-presence", { tab, modes });
  const accept = await agentCall(agent, "accept_suggestion", { id: docId, threadId });
  const commit = await agentCall(agent, "commit_draft", { id: docId });
  ctx.step(`the agent: accept_suggestion ${accept.isError ? `refused: ${accept.text}` : "accepted"}; commit_draft ${commit.isError ? `refused: ${commit.text}` : JSON.stringify(commit.json)}`);
  return { docId, users, e, others, agent, threadId, log, accept, commit };
}

/** The refusal both agent writes must get while tab A is in the editor. */
function assertRefusedWhileEditing(accept, commit, who, what = "C11b") {
  assert.deepEqual(
    agentOutcome({ accept, commit }),
    { accept: editingRefusal(1, "accepted"), commit: editingRefusal(1, "published") },
    `${what}: while a tab of ${who} is in the editor, the agent's accept_suggestion and commit_draft are refused (SPEC §16)`,
  );
}

/** After the refusal, tab A presses Done: nobody is "edit", and the agent's writes go ahead and publish the accepted change once (I8) and every saved token (I2). */
async function c11bThenAhead(ctx, { docId, e, agent, threadId, log }, what) {
  ctx.step(`${e.name} presses Done; the agent accepts and commits again`);
  await e.done();
  const nobody = await waitModes(ctx.target, docId, (m) => editorsIn(m).length === 0);
  assert.deepEqual(editorsIn(nobody.modes), [], `${what}: within ${PRESENCE_MS} ms of Done nobody is "edit" in status/${docId}/peers`);
  const w = await agentWrites(ctx, agent, docId, threadId);
  await assertAgentWentAhead(ctx, docId, w, what);
  const parser = await ctx.users.parser();
  const v = await readVersion(ctx, { parser, docId, versionId: "v2", ids: [...new Set(log.typed.map((t) => t.target))] });
  assertAcceptedOnce(v, threadId);
  assertInvariant(i2InVersion(v, log.typed));
}

scenario("C11b same person in two tabs: while one tab of an editor is in the editor, a second tab of the same account opens the document and closes; the agent's accept_suggestion and commit_draft are still refused", { tiers: BOTH, n: NS, timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const { e, accept, commit } = await c11bFlow(ctx, { tabFirst: false });
  assertRefusedWhileEditing(accept, commit, e.name);
});

scenario("C11b-serial positive control: the second tab opens and closes before the first tab enters the editor; the agent's accept and commit_draft are refused while it is in the editor, then go ahead once it presses Done: the accept drops the live log, the version holds the accepted change once (I8) and every saved token (I2), and status/{d}/peers empties within 5 s of everyone leaving (I12)", { tiers: BOTH, n: NS, trials: CONTROL_TRIALS, timeoutMs: SERIAL_MS, ...LIVE }, async (ctx) => {
  const flow = await c11bFlow(ctx, { tabFirst: true });
  assertRefusedWhileEditing(flow.accept, flow.commit, flow.e.name, "C11b-serial");
  await c11bThenAhead(ctx, flow, "C11b-serial");
  const left = await leaveAtOnce(flow.users.filter((u) => !u.page.isClosed()), "app");
  assertInvariant(await waitPeersGone(ctx.target, flow.docId, left.t0));
});

/**
 * S21's first mechanism alone: one person's two tabs, BOTH open when the
 * agent writes. pN types and autosaves in tab A, everyone else presses Done.
 * `tabFirst` (the positive control): pN presses Done, tab B opens the
 * document (its presence lands), and only then does tab A enter the editor
 * again, so A's "edit" is the last write. Otherwise tab B opens while tab A
 * is in the editor. Tab B stays open; the agent's two answers are taken
 * while both tabs are open and tab A is in the editor and "Shared".
 */
async function c11bBothOpenFlow(ctx, { tabFirst }) {
  const n = ctx.n;
  const { docId, users, owner, accounts } = await join(ctx, { n, title: `C11b both open N=${n}${tabFirst ? " serial" : ""}` });
  const agent = await agentFor(ctx, owner);
  const log = tokenLog(ctx.target.runId);
  const e = users[n - 1];
  const eUid = accounts[n - 1].uid;
  const others = users.slice(0, n - 1);
  const uids = accounts.map((a) => a.uid);
  const otherUids = uids.slice(0, n - 1);
  ctx.step(`${e.name} (tab A) types a token and autosaves it; every peer shows it`);
  await typeSaveArrive(e, users, paragraph(n - 1), log.next(e.name, paragraph(n - 1)));
  await settleFirst(users, docId, n);
  const threadId = await suggestionOn(agent, docId);
  await requirePresence(ctx, null, docId, uids, "edit");
  ctx.step(`the others (${others.map((u) => u.name).join(", ")}) press Done`);
  await Promise.all(others.map((u) => u.done()));
  const viewing = await waitModes(ctx.target, docId, (m) => otherUids.every((uid) => m[uid] === "view") && m[eUid] === "edit");
  if (!viewing.ok) ctx.inconclusive(`the sync precondition did not hold: presence never showed the others "view" and ${e.name} "edit" (status/${docId}/peers: ${JSON.stringify(viewing.modes)})`);
  const tabB = await e.newTab();
  let whileOpen;
  if (tabFirst) {
    ctx.step(`${e.name} presses Done; a second tab of the same account opens the document and stays open; then tab A enters the editor again`);
    await e.done();
    const out = await waitModes(ctx.target, docId, (m) => m[eUid] === "view");
    if (!out.ok) ctx.inconclusive(`the sync precondition did not hold: tab A's presence never said "view" after its Done (${JSON.stringify(out.modes)})`);
    await openTabB(ctx, tabB, docId);
    await e.enterEdit({ waitShared: true, timeout: 90_000 });
    const back = await waitModes(ctx.target, docId, (m) => m[eUid] === "edit");
    if (!back.ok) ctx.inconclusive(`the sync precondition did not hold: tab A's presence never said "edit" once it was back in the editor with ${tabB.name} open (${JSON.stringify(back.modes)})`);
    whileOpen = await peersRaw(ctx.target, docId);
  } else {
    ctx.step(`while tab A is in the editor, a second tab of ${e.name}'s account opens the document and stays open`);
    whileOpen = await openTabB(ctx, tabB, docId);
  }
  await requireTabAEditing(ctx, e);
  if (tabB.page.isClosed() || !new URL(tabB.page.url()).pathname.startsWith(`/d/${encodeURIComponent(docId)}`)) ctx.inconclusive(`the sync precondition did not hold: ${tabB.name} is not open on the document when the agent writes (${tabB.page.isClosed() ? "closed" : tabB.page.url()})`);
  const modes = await peerModes(ctx.target, docId);
  ctx.step(`both tabs open, tab A in the editor; presence the agent will read: ${JSON.stringify(modes)}`);
  ctx.ev.json("c11b-both-open", { whileOpen, modes });
  const accept = await agentCall(agent, "accept_suggestion", { id: docId, threadId });
  const commit = await agentCall(agent, "commit_draft", { id: docId });
  ctx.step(`the agent: accept_suggestion ${accept.isError ? `refused: ${accept.text}` : "accepted"}; commit_draft ${commit.isError ? `refused: ${commit.text}` : JSON.stringify(commit.json)}`);
  return { docId, users, e, tabB, others, agent, threadId, log, accept, commit };
}

scenario("C11b both open: while one tab of an editor is in the editor, a second tab of the same account opens the document and stays open; while both are open the agent's accept_suggestion and commit_draft are refused", { tiers: BOTH, n: NS, timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const { e, accept, commit } = await c11bBothOpenFlow(ctx, { tabFirst: false });
  assertRefusedWhileEditing(accept, commit, e.name, "C11b both open");
});

scenario("C11b both open serial control: the second tab opens first and the first tab then enters the editor; while both are open the agent's accept and commit_draft are refused, then go ahead once it presses Done: the accept drops the live log, the version holds the accepted change once (I8) and every saved token (I2), and status/{d}/peers empties within 5 s of everyone leaving, both tabs included (I12)", { tiers: BOTH, n: NS, trials: CONTROL_TRIALS, timeoutMs: SERIAL_MS, ...LIVE }, async (ctx) => {
  const flow = await c11bBothOpenFlow(ctx, { tabFirst: true });
  assertRefusedWhileEditing(flow.accept, flow.commit, flow.e.name, "C11b both open serial");
  await c11bThenAhead(ctx, flow, "C11b both open serial");
  const left = await leaveAtOnce([...flow.users, flow.tabB].filter((u) => !u.page.isClosed()), "app");
  assertInvariant(await waitPeersGone(ctx.target, flow.docId, left.t0));
});

// --- C11c --------------------------------------------------------------------------------------

/** Everyone typed and saved; then everyone leaves at one instant (`how`: "app" or "unload"); I12, then the agent's accept (the log read before commit_draft) and commit. */
async function c11c(ctx, how) {
  const n = ctx.n;
  await withRss(ctx, n, async () => {
    const { docId, users, owner, accounts } = await join(ctx, { n, title: `C11c leave ${how} N=${n}` });
    const agent = await agentFor(ctx, owner);
    const parser = await ctx.users.parser();
    const log = tokenLog(ctx.target.runId);
    ctx.step("each editor in turn types a token into its own paragraph and autosaves it; the session settles");
    await typeInTurn(users, log);
    await settle(users, docId, n);
    const threadId = await suggestionOn(agent, docId);
    await requirePresence(ctx, null, docId, accounts.map((a) => a.uid), "edit");
    ctx.step(how === "app" ? "every editor leaves the document in the app at one instant (each page's router; every presence handle's leave())" : "every page unloads at one instant, as a closed tab does (no cleanup runs: the server's onDisconnect alone)");
    const fired = await leaveAtOnce(users, how);
    ctx.ev.json("leave-timing", { spreadMs: fired.spreadMs, fires: fired.fires });
    if (!fired.conclusive) ctx.inconclusive(`the editors did not leave at one instant: fire spread ${fired.spreadMs.toFixed(1)} ms > ${fired.limit} ms`);
    const i12 = await waitPeersGone(ctx.target, docId, fired.t0);
    ctx.step(i12.ok ? `status/${docId}/peers emptied ${i12.ms} ms after everyone left (spread ${fired.spreadMs.toFixed(1)} ms)` : i12.failures.join("; "));
    assertInvariant(i12);
    const w = await agentWrites(ctx, agent, docId, threadId);
    await assertAgentWentAhead(ctx, docId, w, "C11c");
    const v = await readVersion(ctx, { parser, docId, versionId: "v2", ids: users.map((_, i) => paragraph(i)) });
    assertAcceptedOnce(v, threadId);
    assertInvariant(i2InVersion(v, log.typed));
  });
}

scenario("C11c all leave at once in the app: status/{d}/peers is empty within 5 s (I12); then the agent's accept_suggestion and commit_draft go ahead, the live log is empty, and the version holds the accepted change once (I8) and every saved token (I2)", { tiers: BOTH, n: NS, timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  await c11c(ctx, "app");
});

scenario("C11c all close at once (every page unloads, as a closed tab does): status/{d}/peers is empty within 5 s through onDisconnect alone (I12); then the agent's accept_suggestion and commit_draft go ahead, the live log is empty, and the version holds the accepted change once (I8) and every saved token (I2)", { tiers: BOTH, n: NS, timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  await c11c(ctx, "unload");
});

// --- the controls' canary ----------------------------------------------------------------------

// The target of e2e/patches/controls-c06-editors-refusal and controls-c06-log-kept:
// a control's case is named literally in its spec, so it carries no `n`.
scenario("C11 canary: at N=2 the agent's commit_draft is refused while the other editor is in the document, and once both have left the editor it publishes and the live log is empty", { tiers: BOTH, timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const { docId, users, owner, accounts } = await join(ctx, { n: 2, title: "C11 canary" });
  const agent = await agentFor(ctx, owner);
  const log = tokenLog(ctx.target.runId);
  const [p1, p2] = users;
  ctx.step(`${p2.name} types a token and autosaves it; ${p1.name} presses Done`);
  await typeSaveArrive(p2, users, paragraph(1), log.next(p2.name, paragraph(1)));
  await p1.done();
  const one = await waitModes(ctx.target, docId, (m) => m[accounts[0].uid] === "view" && m[accounts[1].uid] === "edit");
  if (!one.ok) ctx.inconclusive(`the sync precondition did not hold: presence never showed ${p1.name} "view" and ${p2.name} "edit" (${JSON.stringify(one.modes)})`);
  const refused = await agentCall(agent, "commit_draft", { id: docId });
  ctx.step(`while ${p2.name} edits, the agent's commit_draft: ${refused.isError ? `refused: ${refused.text}` : JSON.stringify(refused.json)}`);
  assert.equal(refused.isError ? refused.text : `published ${JSON.stringify(refused.json)}`, editingRefusal(1, "published"), `C11 refusal: commit_draft is refused while ${p2.name} is in the editor`);
  await p2.done();
  const nobody = await waitModes(ctx.target, docId, (m) => editorsIn(m).length === 0);
  if (!nobody.ok) ctx.inconclusive(`the sync precondition did not hold: presence still shows an editor after both pressed Done (${JSON.stringify(nobody.modes)})`);
  const out = await agentCall(agent, "commit_draft", { id: docId });
  ctx.step(`once both left the editor, the agent's commit_draft: ${out.isError ? `refused: ${out.text}` : JSON.stringify(out.json)}`);
  assertPublished(out, "C11 canary");
  await assertLogDropped(ctx.target, docId, "the agent's commit_draft");
});
