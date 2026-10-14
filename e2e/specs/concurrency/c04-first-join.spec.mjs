// SPDX-License-Identifier: Apache-2.0
// C4 simultaneous first join (client gate, held frames, free-running under RTDB latency) and C4b an open-edit non-member joining live editors: the v1 body once on every peer, and every copy merged (SPEC §6b, §16).

/**
 * C4 / C4b of the plan's concurrency table: "simultaneous first join (held
 * frames, RTDB latency, client gate) / open-edit non-member joins", invariant
 * I3 (the v1 sentinel once, the top-level count unchanged), suspects S1, S27.
 *
 * WHAT THE PRODUCT PROMISES
 *   SPEC §6b spec.md:792-794 "Several people may type into one document at
 *   the same time; their edits merge and every copy converges", and
 *   spec.md:800-802 "The **normative** property is that a document survives a
 *   round trip through the wire format byte-identical".
 *   SPEC §16 spec.md:1542-1544 "Anyone who may edit a document may edit it at
 *   any time. There is no lock, no holder and no hand-off: edits merge, and
 *   every copy converges on the same document whatever order the updates
 *   arrive in." spec.md:1556-1558 "When an editor opens a document, a log
 *   that holds anything wins over the bytes it loaded". spec.md:1567-1568 "A
 *   **public** open-editing document also carries the key `*`: any verified
 *   account" (in the live log; contrast spec.md:1570-1572, where an unlisted
 *   document's link holders "are not merged live with the members").
 *   The product's own statement of the race: useSharedDocument.ts:25-28 and
 *   crdt/log.ts:36-39 ("two people opening the editor in the same second
 *   would both seed and the document would appear twice").
 *
 * S1 (C4). Joining is connect → `await log.ready()` → bindSync
 *   (useSharedDocument.ts:66-72). ready() is the log's first value event
 *   (crdt/rtdb.ts:26-40): "everything already here", never "nobody else is
 *   seeding". bindSync seeds the loaded DOM into an EMPTY fragment
 *   (crdt/sync.ts:260-271), and the seed reaches the database only after an
 *   asynchronous append (crdt/log.ts:108-114). Every joiner whose ready()
 *   resolves between another's ready() and that one's seed landing finds the
 *   log empty and seeds too: Yjs merges both inserts, and every copy
 *   converges on the body twice (N joiners: N times).
 *
 * S27 (C4b). A non-member on a PUBLIC open-editing document is let into the
 *   live log (DocViewer.tsx:305-315 shareLive; useSharedDocument.ts:77 shows
 *   "Shared" whenever there is a log). Its WRITES pass (database.rules.json:100,
 *   editAccess/{d}/* from presence.ts:101-110), its READ of status/{d} does
 *   not (database.rules.json:56 needs presenceAccess, which mirrors members
 *   only), and a denied read resolves ready() as if the log were empty
 *   (crdt/rtdb.ts:33-38). So it seeds a second body into every member's copy
 *   and never receives a member's keystroke.
 *
 * THE SCENARIOS (each with n: [2, 5, 10, 20]; K trials per N by the plan)
 *   C4 client gate        SYNC-G, deterministic: amplify-mint-join's
 *                         join-before-bind holds every joiner after an empty
 *                         ready() (each by its latest run: requireJoinersHeld,
 *                         then a second with no new call at the gate) and
 *                         releases them together, with the RTDB proxy
 *                         delaying each direction by 250 ms from the release
 *                         on, so no seed can reach another joiner before it
 *                         binds. Once all show "Shared", no call reached the
 *                         gate after the release (else INCONCLUSIVE): the
 *                         runs that bound were the ones held. What the next
 *                         keystroke's autosave keeps is recorded as the harm.
 *   C4 held frames        SYNC-H on an UNPATCHED product: every joiner's
 *                         editable /draft/ frame navigation is held and
 *                         released together (overlap proof), so the runs that
 *                         bind start together. A held frame holds the run
 *                         that binds: the join effect's first run (on the
 *                         Edit press) is cancelled when useDocFrame drops the
 *                         reading document (useDocFrame.ts:146-151), and only
 *                         the run on the draft frame's load binds. The hold
 *                         is PER PAGE (one holdRequests of one request on
 *                         each joiner's page), so the n held navigations are
 *                         n joiners, one each; a page's second draft
 *                         navigation while held (its hold's `extra`), or any
 *                         page making other than exactly one draft
 *                         navigation request AND one draft frame commit
 *                         between its press and "Shared" (request and
 *                         framenavigated listeners on every page), means the
 *                         run that bound may not be the held one, and the
 *                         round is INCONCLUSIVE. The held pages, each page's
 *                         extra and its request and commit counts go in the
 *                         round's row.
 *   C4 free-running       SYNC-T on an UNPATCHED product, nothing held: the
 *                         joiners press Edit Δ apart (joiner i at t0 + i·Δ,
 *                         Δ = 0, 100, 300 and 1000 ms, each press time read
 *                         in its page; a gap more than 40 ms off Δ is
 *                         INCONCLUSIVE). Δ = 0 is "at the same moment"; the
 *                         larger offsets measure how far apart two people
 *                         may press Edit and still double the document: the
 *                         race's window, which is how often it happens to
 *                         people.
 *   Held frames and free-running each run their rounds (a fresh document per
 *   round) at two RTDB latencies through the stack's proxy: the emulator's
 *   own speed, and a 150 ms round trip (75 ms each way, a user far from the
 *   database's region). Each round's outcome, copies and sync measure go to
 *   <invocation>/c04-first-join.jsonl (lib/evidence.mjs measure, whatever
 *   the outcome) and the case's `rounds` evidence, so
 *   the rate per N, per latency and per offset can be counted over the
 *   trials.
 *   C4 positive controls  the same operations one after another, which must
 *                         PASS: on the gated stack the held joiners are let
 *                         go one at a time (gates releaseCaller: one
 *                         joiner's held runs, nobody else's), each only once
 *                         the earlier seed is on every still-held joiner's
 *                         socket; on the unpatched stack the joiners press
 *                         Edit one after another, the next once the first
 *                         seed is logged.
 *   C4b                   N−1 members edit live on a public open-editing
 *                         document; a verified non-member opens it and
 *                         presses Edit. First, a control inside the case:
 *                         the members alone hold the body once (I3) before
 *                         the joiner presses Edit (else the case FAILS as
 *                         itself, not as S27: the doubling is pinned on the
 *                         joiner's press). Then, unconditionally (plan A11.7
 *                         "PE sees the member's keys"; SPEC §16
 *                         spec.md:1567-1572, where only an UNLISTED
 *                         document's link holders "are not merged live with
 *                         the members"):
 *                         - every peer's body is once (I3);
 *                         - the joiner shares the live log: a joiner still
 *                           not "Shared" SHARED_WAIT_MS after its press is
 *                           "not merged: <joiner> is editing alone" (an S27
 *                           "fix" that drops open editors out of the log
 *                           would otherwise turn the case green);
 *                         - a member's probe keystroke reaches the joiner,
 *                           and the joiner's own probe reaches EVERY member,
 *                           each within I13's 2 s (checkI13, limitMs
 *                           PROBE_ARRIVAL_MS). The wait runs to the settle
 *                           deadline, so a late arrival is told from a
 *                           missing one in the evidence. The joiner-to-
 *                           members leg catches a joiner that may read the
 *                           log but whose writes are refused (it adopts the
 *                           log, seeds nothing and keeps I3).
 *                         Arrivals are read anywhere in the peer's body, not
 *                         by #id (lib/frame.mjs armArrival with a null id):
 *                         on a doubled body getElementById finds only the
 *                         first copy, where the joiner's keys, typed into
 *                         its own seed, are not.
 *   C4b positive control  the same N (n: N_ALL), the same members and the
 *                         same membersEnter path, with the joiner granted
 *                         editor after open editing (a member, so it may read
 *                         the log): must PASS. The grant comes after open
 *                         editing, as the C4b joiner meets the document; that
 *                         share drops editAccess/{d}/* (X-a11-live-3,
 *                         folders.ts:453 calls syncPresenceAccess without
 *                         publicEdit), which the row records as star:false.
 *                         It is immaterial here: every member, the joiner
 *                         included, writes through its own key
 *                         (database.rules.json:100), and `*` is only a
 *                         non-member's. It is the target of three controls:
 *                         controls-c04-open-edit-read (write without read:
 *                         a second body, the member's keys never arrive),
 *                         controls-c04-joiner-write (read without write: the
 *                         joiner's keys never reach the members, I3 holds)
 *                         and controls-c04-joiner-alone (shareLive off for
 *                         everyone but the owner on an open-editing
 *                         document: the joiner edits alone).
 *
 * STACKS. The client gate needs `--patches amplify-mint-join`; held frames
 * and free-running need the product UNPATCHED (`!gates`: even an unarmed
 * gate adds a request between ready() and bind, which is the very window
 * they measure). Every C4 variant needs `--rtdb-proxy`. So the whole file
 * runs on two stacks:
 *   run --suite concurrency --spec c04-first-join.spec.mjs --rtdb-proxy --patches amplify-mint-join
 *   run --suite concurrency --spec c04-first-join.spec.mjs --rtdb-proxy
 * C4b needs only `rtdb-rules` and runs on both.
 *
 * THE PROXY AND THE DATABASE EMULATOR. A round that sets an RTDB latency
 * resets it and waits for the proxy to hold nothing (rtdbLatency drained():
 * a reset sends nothing early) before it settles. Each C4 case, and C4b on a
 * stack with the proxy, records the proxy's counters over its own work
 * (connections, upgrades, the addresses it rewrote by kind, those left in
 * data): whether every page stayed on the proxy. The Database emulator can
 * fail its whole namespace under concurrent rule-checked writes (README Known
 * harness facts: an NPE in its rules evaluation; for 30 s writes fail and
 * every client is reset). What crossed such a failure in
 * logs/database-debug.log, from its "Namespace failure" line to its
 * "Shutdown to Active" (each widened by EMULATOR_MARGIN_MS), measured the
 * emulator, not the product. A round of held frames, free-running or their
 * serial control that crossed one is left out of the judgement, and recorded
 * as crossed (a fresh document and fresh page loads follow it); every other
 * round is judged as usual, and a case with no round left is INCONCLUSIVE. A
 * case of one round (the client gate, C4b), or one where the failure is not
 * accounted for by its rounds (a later one, or a body that ended early), ends
 * INCONCLUSIVE whatever it would have said. The emulator's lines are recorded.
 *
 * OUTCOMES. A sync precondition that did not hold (a gate that never held
 * its joiners, a fire spread over 40 ms, frames that never overlapped or
 * were not one held navigation per joiner, a C4 joiner or a C4b member never
 * "Shared") is INCONCLUSIVE. C4b's joiner not sharing is its oracle, not a
 * precondition. Each defect case's own assertion is I3 (C4) or I3 plus the
 * merge (C4b), asserted BEFORE the settle's outcome is judged; a settle that
 * failed (I1), or C4b's members doubled before the joiner pressed Edit, is
 * then thrown as a plain error, so it FAILS as itself instead of passing for
 * the defect's TODO. Everything that is setup is a precondition().
 */

import { AssertionError } from "node:assert";
import { after } from "node:test";
import { currentTarget, escapeRe, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { publish } from "../../lib/seed.mjs";
import { setVisibility, share, shareMany } from "../../lib/grant.mjs";
import { closeAdmin, emailKey, rtdbGet } from "../../lib/admin.mjs";
import { rtdbAs } from "../../lib/rtdb.mjs";
import { idToken } from "../../lib/session.mjs";
import { eventually } from "../../lib/assert.mjs";
import { tokenLog } from "../../lib/tokens.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { measure } from "../../lib/evidence.mjs";
import { rtdbLatency } from "../../lib/proxy.mjs";
import { holdRequests, overlapProof, requireConclusive, syncPages } from "../../lib/sync.mjs";
import { PROBE_ARRIVAL_MS, checkI13, checkI3, readI3, readI3All } from "../../lib/invariants.mjs";
import { joinShared, requireJoinersHeld, settleDeadlineMs, settleLive, typeProbe } from "../../lib/live.mjs";
import { armArrival, arrival } from "../../lib/frame.mjs";
import { DATABASE_LOG, drainDatabaseLog } from "../../lib/debuglogs.mjs";
import { grepLog, logFile, logMark } from "../../lib/logs.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const FIXTURE = "crdt-paragraphs.html";
const N_ALL = [2, 5, 10, 20];
/** Sharing for editing is POST /access, which sends invitations: local only. */
const EFFECTS = ["email:POST /access"];
const GATE = "join-before-bind";
/** From the gate's release on: a seed takes at least 500 ms to reach another joiner, which binds within milliseconds of its release. */
const GATE_DELAY = Object.freeze({ up: 250, down: 250 });
/** The latencies the held-frames and free-running rounds run at, through the stack's RTDB proxy. */
const LATENCIES = Object.freeze([
  Object.freeze({ label: "the emulator's own speed", key: "rtt0", up: 0, down: 0 }),
  Object.freeze({ label: "a 150 ms round trip", key: "rtt150", up: 75, down: 75 }),
]);
/** Rounds per latency, by N (a fresh document each), for held frames and the serial control. */
const ROUNDS = Object.freeze({ 2: 2, 5: 2, 10: 1, 20: 1 });
/** The free-running rounds, per latency: joiner i presses Edit at t0 + i·Δ. */
const PRESS_OFFSETS_MS = Object.freeze([0, 100, 300, 1000]);
/** A press more than this far off its planned time is no measurement of that offset (lib/sync.mjs SPREAD_LIMIT_MS.browser). */
const PRESS_TOLERANCE_MS = 40;
const EDIT_BUTTON = '.viewer-toolbar [aria-label="Edit"]';
/** This file's measurement rows: <E2E_INVOCATION_DIR>/c04-first-join.jsonl (lib/evidence.mjs measure). */
const MEASURE = "c04-first-join";
/** Before a gated release: no new call at the gate for this long (the binding runs still on their way arrive and are held). */
const GATE_QUIET_MS = 1_000;
/** C4b: how long after its Edit press the joiner may take to show "Shared"; past it, it is editing alone. */
const SHARED_WAIT_MS = 30_000;
/** C4b: I13's bound on a probe keystroke's arrival (plan I13 "within 2 s"; lib/invariants.mjs PROBE_ARRIVAL_MS). */
const I13_LIMIT_MS = PROBE_ARRIVAL_MS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (err) => String(err?.message ?? err).split("\n")[0];

// --- measurements -------------------------------------------------------------------

/**
 * One row of this file's measurements, appended (whatever the case's
 * outcome) to <E2E_INVOCATION_DIR>/c04-first-join.jsonl by lib measure. A
 * row it withheld or could not write is said in the case's steps, where the
 * same numbers already are.
 */
function record(ctx, row) {
  const r = measure(ctx, MEASURE, row);
  if (r?.withheld) ctx.step(`the ${MEASURE} row was withheld: a credential shape survived its redaction`);
  if (r?.error) ctx.step(`the ${MEASURE} row could not be written: ${r.error}`);
}

// --- the proxy and the Database emulator ----------------------------------------------

/** The proxy counters that say whether every page stayed on it (lib/proxy.mjs stats), as plain numbers. */
function proxyCounts(stats) {
  const k = stats?.rewriteKinds ?? {};
  return {
    connections: stats?.connections ?? null,
    upgrades: stats?.upgrades ?? null,
    handshake: k.handshake ?? null,
    reset: k.reset ?? null,
    control: k.control ?? null,
    stream: k.stream ?? null,
    hostsInData: stats?.hostsInData ?? null,
    errors: stats?.errors ?? null,
  };
}

/** The proxy's counters now, from `lat` (rtdbLatency). */
const proxyNow = async (lat) => proxyCounts((await lat.stats()).stats);

/** What the proxy counted between two readings: each counter's increase (null where either reading lacks it). */
function proxyDelta(before, after) {
  return Object.fromEntries(Object.keys(after).map((key) => [key, before[key] == null || after[key] == null ? null : after[key] - before[key]]));
}

/** After lat.reset(): wait until the proxy holds nothing (rtdbLatency drained()), and resolve what it still held when the wait began. */
async function drainProxy(lat) {
  const d = await lat.drained();
  return { ms: d.ms, polls: d.polls, queuedAtStart: d.atStart?.queued ?? null, heldAtStart: d.atStart?.held ?? null };
}

/** The Database emulator's own words when it fails a namespace (README Known harness facts), and when the namespace is back. */
const NAMESPACE_FAILURE_RE = /Namespace failure for |status Active to Shutdown/;
const NAMESPACE_BACK_RE = /status Shutdown to Active/;
/** A failure window is widened by this much each way: the log's times are the emulator's, a round's are this process's. */
const EMULATOR_MARGIN_MS = 1_000;

/** Bring logs/database-debug.log up to date (debuglogs.mjs drainDatabaseLog; a drain the watchdog is in the middle of is tried again). */
async function drainDbLog(ctx) {
  let r = null;
  try {
    for (let i = 0; i < 30; i += 1) {
      r = drainDatabaseLog(ctx.target.stack);
      if (!r?.busy) return r;
      await sleep(100);
    }
  } catch (err) {
    // The watchdog drains every 15 s anyway; the read below is then that late.
    ctx.step(`draining the Database emulator's log failed (${firstLine(err)}): it is read as the watchdog last left it`);
    return { error: firstLine(err) };
  }
  return r;
}

/**
 * The Database emulator's own log over a case: a drain and a mark now, then
 * `read()` → every line since the mark of a namespace failing or coming back
 * (after a drain). `scoped` counts the failure lines the case's rounds have
 * accounted for (judgedRounds).
 */
async function emulatorWatch(ctx) {
  const opts = { target: ctx.target, name: DATABASE_LOG };
  await drainDbLog(ctx);
  const since = logMark(opts);
  const re = new RegExp(`${NAMESPACE_FAILURE_RE.source}|${NAMESPACE_BACK_RE.source}`);
  return {
    startedAt: new Date().toISOString(),
    scoped: 0,
    async read() {
      await drainDbLog(ctx);
      // A log past its cap moves to <name>.1 (debuglogs.mjs): then the window is the rest of that one and all of the new.
      if (logMark(opts) >= since) return grepLog(re, { ...opts, since });
      return [...grepLog(re, { file: `${logFile(ctx.target.runId, DATABASE_LOG)}.1`, since }), ...grepLog(re, { ...opts, since: 0 })];
    },
  };
}

/** The failures among `lines`, as windows {from, to, lines} (ms; `to` the namespace's return, Infinity while it has not come back), each widened by EMULATOR_MARGIN_MS. */
function failureWindows(lines) {
  const at = (l) => Date.parse(/^\[([^\]]+)\]/.exec(l)?.[1] ?? "");
  const wins = [];
  let open = null;
  for (const line of [...lines].sort((a, b) => at(a) - at(b))) {
    const t = at(line);
    if (NAMESPACE_FAILURE_RE.test(line)) {
      if (!open) {
        open = { from: (Number.isFinite(t) ? t : -Infinity) - EMULATOR_MARGIN_MS, to: Infinity, lines: [] };
        wins.push(open);
      }
      open.lines.push(line.slice(0, 240));
    } else if (open && NAMESPACE_BACK_RE.test(line)) {
      open.to = (Number.isFinite(t) ? t : Infinity) + EMULATOR_MARGIN_MS;
      open.lines.push(line.slice(0, 240));
      open = null;
    }
  }
  return wins;
}

const isoOr = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms));

/**
 * The rounds to judge: every row ({label, startedAt, endedAt, i3,
 * settleError}) that did not cross a namespace failure. The crossed ones are
 * recorded (one row naming them, the windows and the emulator's lines) and
 * left out; none left is INCONCLUSIVE. So is a `defect` case whose rounds
 * left all hold (I3 and the settle): the ones that crossed could have been
 * the ones to show it, so that pass would be no measurement of the scenario.
 * Marks the failures as accounted for, so the case is judged on its other
 * rounds.
 */
async function judgedRounds(ctx, watch, rows, what, { defect = false } = {}) {
  const lines = await watch.read();
  const wins = failureWindows(lines);
  if (wins.length === 0) return rows;
  const crossed = rows.filter((r) => wins.some((w) => Date.parse(r.startedAt) <= w.to && Date.parse(r.endedAt) >= w.from));
  const kept = rows.filter((r) => !crossed.includes(r));
  const windows = wins.map((w) => ({ from: isoOr(w.from), to: isoOr(w.to), lines: w.lines }));
  record(ctx, { scenario: `${what} emulator`, windows, crossed: crossed.map((r) => r.label), judged: kept.map((r) => r.label) });
  ctx.ev.json("emulator", { windows, crossed: crossed.map((r) => r.label), judged: kept.map((r) => r.label) });
  const said = `the Database emulator failed its namespace ${wins.length} time(s) (${windows.map((w) => `${w.from} to ${w.to}`).join("; ")}: ${wins[0].lines[0]})`;
  // Accounted for here, either way: the case is judged on its other rounds, or is INCONCLUSIVE for this reason alone.
  watch.scoped = lines.filter((l) => NAMESPACE_FAILURE_RE.test(l)).length;
  if (kept.length === 0) ctx.inconclusive(`${said}, and every round crossed it, so the case measured the emulator, not the product`);
  if (defect && kept.every((r) => r.i3.ok && !r.settleError)) ctx.inconclusive(`${said}: the round(s) that crossed it (${crossed.map((r) => r.label).join(", ")}) are left out, and every round left holds, so this is no measurement of the scenario: the ones left out could have been the ones to show the defect`);
  ctx.step(`${said}: the round(s) that crossed it are left out of the judgement (${crossed.map((r) => r.label).join(", ") || "none"}); judged on ${kept.map((r) => r.label).join(", ")}`);
  return kept;
}

/**
 * Run the case's body with an emulatorWatch, then read the log again. A
 * namespace failure its rounds did not account for (judgedRounds) ends the
 * case INCONCLUSIVE, even when the body FAILED or met its defect: for 30 s
 * the emulator refused writes and reset every client, so the case measured
 * the emulator. The lines go to the case's measurement rows first.
 */
async function onAWorkingEmulator(ctx, scenarioName, body) {
  const watch = await emulatorWatch(ctx);
  let error = null;
  try {
    await body(watch);
  } catch (err) {
    error = err;
  }
  const lines = await watch.read();
  const failures = lines.filter((l) => NAMESPACE_FAILURE_RE.test(l));
  if (failures.length > watch.scoped) {
    const said = failures.slice(watch.scoped).map((l) => l.slice(0, 240));
    record(ctx, { scenario: `${scenarioName} emulator`, startedAt: watch.startedAt, endedAt: new Date().toISOString(), namespaceFailures: lines.map((l) => l.slice(0, 240)), unaccounted: said.length, caseEnded: error ? firstLine(error) : null });
    ctx.inconclusive(`the Database emulator failed its namespace during the case (${said[0]}${said.length > 1 ? `, and ${said.length - 1} more line(s)` : ""}): it refused writes and reset every client for 30 s, so the case measured the emulator, not the product${error ? `; the case itself had ended: ${firstLine(error)}` : ""}`);
  }
  if (error) throw error;
}

// --- joining ------------------------------------------------------------------------

/** v1 as a reader's frame shows it: {sentinels, children}; the fixture has its sentinel once. */
async function baselineOf(u) {
  const b = await readI3(await u.frame());
  precondition(b.sentinels === 1 && b.children > 1, `v1 in ${u.name}'s reading frame has its sentinel once (${JSON.stringify(b)})`);
  return b;
}

/**
 * Runs IN the page (syncPages serialises it, and calls it at the shared t0):
 * wait `delay` ms (a timer, then a short spin, so the page stays responsive),
 * press the viewer's Edit button, and return the page clock at the press.
 */
async function pressEditInPage(delay) {
  const clock = () => performance.timeOrigin + performance.now();
  const start = clock();
  const wait = Number(delay) || 0;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, Math.max(0, wait - 4)));
    while (clock() - start < wait) {}
  }
  const b = document.querySelector('.viewer-toolbar [aria-label="Edit"]');
  if (!b) throw new Error("no Edit button on the page");
  const at = clock();
  b.click();
  return at;
}

/**
 * enterEdit's waits after a press made elsewhere (SYNC-T in the page, or a
 * press whose draft frame is held), which a second click would press again:
 * User.awaitEdit marks the user in edit and waits for the Formatting
 * toolbar, the editable /draft/ frame, then "Shared". It never clicks.
 */
const awaitShared = (u) => u.awaitEdit({ waitShared: true, timeout: 90_000 });

/** Run `wait` for every user; a user that never shows "Shared" ends the case INCONCLUSIVE (a failed sync precondition). */
async function allShared(ctx, users, wait, what) {
  const errs = await Promise.all(users.map((u) => wait(u).then(() => null, (err) => err)));
  if (errs.every((e) => e === null)) return;
  const states = await Promise.all(users.map((u) => u.shareState().catch(() => "unknown")));
  const not = users.filter((u, i) => states[i] !== "shared");
  if (not.length > 0) {
    const why = errs.find((e) => e !== null);
    ctx.inconclusive(`the sync precondition did not hold: ${what}: ${not.map((u) => `${u.name} ${JSON.stringify(states[users.indexOf(u)])}`).join(", ")} never showed "Shared" (${firstLine(why)})`);
  }
  throw errs.find((e) => e !== null);
}

/** status/{d}/y holds an entry (the first seed), or INCONCLUSIVE. Resolves its keys. */
async function waitLogged(ctx, docId, { timeout = 60_000 } = {}) {
  return eventually(async () => {
    const y = await rtdbGet(ctx.target, `status/${docId}/y`);
    return y && typeof y === "object" && Object.keys(y).length > 0 ? Object.keys(y) : false;
  }, { timeout, interval: 100, message: `a seed in status/${docId}/y` }).catch(() => ctx.inconclusive(`the sync precondition did not hold: no seed reached status/${docId}/y within ${timeout} ms`));
}

/** The settle, or the error it threw (judged after the defect's own oracle). */
async function trySettle(users, docId, n) {
  try {
    return { settled: await settleLive(users, { docId, n }), error: null };
  } catch (err) {
    return { settled: null, error: err };
  }
}

/**
 * A settle that failed, after the case's own oracle passed: an I1 failure.
 * In a `defect:` case every AssertionError is that defect's oracle (a TODO),
 * and I1 is not S1's or S27's, so there it is thrown as a plain error and FAILS.
 */
function throwSettle(error, { defect = false } = {}) {
  if (!error) return;
  if (!defect) throw error;
  const err = new Error(`not this defect's oracle, a settle that failed: ${error.message}`, { cause: error });
  err.code = "E2E_C04_SETTLE";
  throw err;
}

/** checkI3 with every failure prefixed by `label`. */
function i3With(label, shapes, baseline) {
  const r = checkI3({ peers: shapes, baseline });
  return { ...r, failures: r.failures.map((f) => (label ? `${label}: ${f}` : f)) };
}

/** How many copies of the body a peer shows (its sentinel count), the most over the peers. */
const copiesOf = (shapes) => Math.max(0, ...Object.values(shapes).map((s) => Number(s.sentinels) || 0));

/** I3 over every row's shapes: one result, each failure naming its round. */
function assertRowsI3(rows) {
  const failures = rows.flatMap((r) => r.i3.failures);
  if (failures.length === 0) return;
  const message = `I3: ${failures.join("; ")}`;
  throw new AssertionError({ message: message.length > 4000 ? `${message.slice(0, 4000)}…` : message, actual: failures, expected: [], operator: "I3" });
}

// --- C4 through the client gate --------------------------------------------------------

/** A held call as `<caller's first 8>#<run>`, `*` marking the caller's latest run. */
const runLabel = (c) => `${String(c.caller ?? "?").slice(0, 8)}#${c.run}${c.latest ? "*" : ""}`;

/** The gate's counts for `docId`: {held, arrived, passed, released, expired, aborted}. */
async function gateCounts(g, docId) {
  const c = (await g.counts({ key: docId }))[GATE];
  return { held: c?.held ?? 0, arrived: c?.arrived ?? 0, passed: c?.passed ?? 0, released: c?.released ?? 0, expired: c?.expired ?? 0, aborted: c?.aborted ?? 0 };
}

/**
 * requireJoinersHeld, then no new call at the gate for GATE_QUIET_MS, then
 * every joiner held by its latest run again. requireJoinersHeld can return
 * while a joiner's binding run is still on its way (its editable frame has
 * loaded, its ready() has not resolved), its superseded run then counting
 * as its latest; the quiet second lets that run arrive and be held first.
 * Resolves the held measure and the counts at the end of the quiet.
 */
async function holdAllBinding(ctx, g, users, docId) {
  await requireJoinersHeld(ctx, g, users, { key: docId, timeoutMs: 120_000 });
  const start = Date.now();
  let last = await gateCounts(g, docId);
  let since = Date.now();
  while (Date.now() - since < GATE_QUIET_MS) {
    if (Date.now() - start > 20_000) ctx.inconclusive(`the sync precondition did not hold: calls kept reaching ${GATE} for 20 s after every joiner was held (${JSON.stringify(last)})`);
    await sleep(100);
    const now = await gateCounts(g, docId);
    if (now.arrived !== last.arrived) since = Date.now();
    last = now;
  }
  const held = await requireHeld(ctx, g, GATE, users.length, { key: docId, timeoutMs: 30_000, distinct: "caller" });
  return { held, counts: last, quietMs: Date.now() - start };
}

/**
 * Every joiner held at join-before-bind after an empty ready(), by the run
 * that binds; then released together (`serial: false`), or one at a time,
 * each only once the seed is on every still-held joiner's socket (`serial`).
 * Proof that the binding runs were the ones let go: once every joiner shows
 * "Shared" (it bound, so its binding run had called the gate), no call
 * reached the gate after the release(s): none passed unheld, none expired,
 * none is still held. Otherwise the case is INCONCLUSIVE.
 */
async function gatedJoin(ctx, { serial }) {
  const n = ctx.n;
  const g = gates(ctx.target);
  const lat = rtdbLatency(ctx.target);
  await lat.reset();
  // From before any page opens: each page's connection, handshake and upgrade are then in the counts.
  const proxyBefore = await proxyNow(lat);
  const { docId, users } = await joinShared(ctx, { n, fixture: FIXTURE, title: `C4 ${serial ? "serial gate" : "gate"} N=${n}`, enter: false });
  const baseline = await baselineOf(users[0]);
  ctx.step(`v1 in ${users[0].name}'s reading frame: ${baseline.children} top-level elements, the sentinel once`);
  let entering = [];
  let order = null;
  const sync = { startedAt: new Date().toISOString() };
  try {
    await g.hold(GATE, { key: docId });
    ctx.step(`hold ${GATE} for ${docId}; all ${n} editors press Edit at once`);
    // Each resolves to null or the error it threw, so none is ever unhandled.
    entering = users.map((u) => u.enterEdit({ waitShared: true, timeout: 180_000 }).then(() => null, (err) => err));
    const { held, counts: before, quietMs } = await holdAllBinding(ctx, g, users, docId);
    sync.heldCallers = held.distinctCallers.length;
    sync.heldCalls = held.callers.length;
    sync.heldRuns = held.callers.map(runLabel);
    ctx.step(`all ${n} joiners held after log.ready(), each by its latest run, with no new call for ${GATE_QUIET_MS} ms (${quietMs} ms): ${held.callers.length} held call(s) of ${held.distinctCallers.length} caller(s) ${JSON.stringify(sync.heldRuns)}`);
    const states = await Promise.all(users.map((u) => u.shareState()));
    if (states.some((s) => s === "shared")) ctx.inconclusive(`the sync precondition did not hold: a joiner showed "Shared" while the gate held it (${JSON.stringify(states)})`);
    await lat.set(GATE_DELAY);
    ctx.step(`RTDB proxy: ${GATE_DELAY.up} ms up and ${GATE_DELAY.down} ms down from here on`);
    if (!serial) {
      const rel = await g.release(GATE, { key: docId });
      const releasedCallers = new Set(rel.released.filter((r) => r.latest).map((r) => r.caller));
      const missed = held.distinctCallers.filter((c) => !releasedCallers.has(c));
      if (missed.length > 0) ctx.inconclusive(`the sync precondition did not hold: one release did not let every held joiner's latest run go (${missed.length} of ${held.distinctCallers.length} caller(s) not in it)`);
      sync.released = rel.released.length;
      ctx.step(`one release let ${rel.released.length} held run(s) of ${releasedCallers.size} joiner(s) go at once`);
    } else {
      const r = await releaseOneAtATime(ctx, g, users, docId);
      order = r.order;
      sync.order = r.order;
      sync.releases = r.releases;
    }
    const errs = await Promise.all(entering);
    entering = [];
    await allShared(ctx, users, async (u) => {
      const e = errs[users.indexOf(u)];
      if (e) throw e;
    }, "after the release");
    const now = await gateCounts(g, docId);
    sync.lateCalls = { passed: now.passed - before.passed, expired: now.expired - before.expired, held: now.held };
    if (sync.lateCalls.passed > 0 || sync.lateCalls.expired > 0 || sync.lateCalls.held > 0) {
      ctx.inconclusive(`the sync precondition did not hold: after the release(s) ${sync.lateCalls.passed} call(s) passed ${GATE} unheld, ${sync.lateCalls.expired} expired and ${sync.lateCalls.held} are still held: a joiner's binding run was not among those let go`);
    }
    ctx.step(`every joiner shows "Shared" and no call reached ${GATE} after the release(s) (counts ${JSON.stringify(now)})`);
  } finally {
    await g.release(GATE, { key: docId }).catch(() => undefined);
    await Promise.all(entering).catch(() => undefined);
    await lat.reset().catch(() => undefined);
  }
  sync.drain = await drainProxy(lat);
  sync.proxy = proxyDelta(proxyBefore, await proxyNow(lat));
  ctx.step(`RTDB proxy back to 0 ms and drained in ${sync.drain.ms} ms; from before the pages opened it counted ${JSON.stringify(sync.proxy)}`);
  return { docId, users, baseline, sync, order };
}

/**
 * Let the held joiners go one at a time: g.releaseCaller lets ONE caller's
 * held runs go (its latest, the binding one, and any superseded run, which
 * returns as cancelled), the caller whose latest run has been held longest.
 * Then wait for that joiner to show "Shared", for the first seed in
 * status/{d}/y, and for the seed's key on every still-held joiner's
 * websocket (its subscription has it: crdt/log.ts:97-106) before the next.
 */
async function releaseOneAtATime(ctx, g, users, docId) {
  const order = [];
  const releases = [];
  let keys = null;
  for (let k = 0; k < users.length; k += 1) {
    const r = await g.releaseCaller(GATE, { key: docId });
    if (!r.caller || !r.latest) ctx.inconclusive(`the sync precondition did not hold: release ${k + 1} found no joiner held by its latest run (caller ${r.caller}, ${r.released.length} run(s) let go, ${r.held} still held)`);
    releases.push(r.released.map(runLabel));
    const fresh = await eventually(async () => {
      const st = await Promise.all(users.map((u) => u.shareState()));
      const joined = users.filter((u, i) => st[i] === "shared" && !order.includes(u));
      return joined.length > 0 ? joined.map((u) => u.name) : false;
    }, { timeout: 60_000, interval: 100, message: "the joiner let go shows Shared" }).catch(() => null);
    if (!fresh || fresh.length !== 1) ctx.inconclusive(`the sync precondition did not hold: release ${k + 1} (${JSON.stringify(releases.at(-1))}) let ${fresh ? fresh.join(", ") : "nobody"} show "Shared", not exactly one joiner`);
    const u = users.find((x) => x.name === fresh[0]);
    order.push(u);
    const still = users.filter((x) => !order.includes(x));
    if (still.length === 0) break;
    keys ??= await waitLogged(ctx, docId);
    await eventually(() => still.every((x) => x.log.wsFrames.received.some((f) => keys.some((key) => f.includes(key)))), {
      timeout: 30_000, interval: 50, message: "the first seed on every still-held joiner's websocket",
    }).catch(() => ctx.inconclusive(`the sync precondition did not hold: the first seed (${keys.join(", ")}) never reached every still-held joiner's websocket within 30 s`));
    // The SDK applies a frame as it arrives; this only spaces the next release from that.
    await sleep(250);
    ctx.step(`release ${k + 1} (${releases.at(-1).join(", ")}): ${u.name} bound and shows "Shared"; the first seed is on ${still.map((x) => x.name).join(", ")}'s socket`);
  }
  return { order: order.map((u) => u.name), releases };
}

/** What the autosave after one keystroke keeps: the I3 shape of the html it posted (recorded, never asserted). */
async function draftShape(ctx, u, log) {
  try {
    const t = log.next(u.name, "e2e-1");
    const save = await u.typeAndAutosave('[id="e2e-1"]', t, { timeout: 30_000 });
    const html = save.entry?.postJson?.html;
    if (typeof html !== "string") return { error: "the autosave's body carried no html" };
    const parser = await ctx.users.parser();
    await parser.setContent(html);
    return { ...(await readI3(parser)), bytes: html.length };
  } catch (err) {
    return { error: firstLine(err) };
  }
}

scenario("C4 simultaneous first join, client gate: N editors held at join-before-bind after an empty log.ready() and released together; the v1 body is once on every peer (I3)", {
  tiers: ["local"],
  effects: EFFECTS,
  needs: ["gates", "patch:amplify-mint-join", "rtdb-proxy"],
  n: N_ALL,
  defect: "S1",
  timeoutMs: 600_000,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  await onAWorkingEmulator(ctx, "C4 gate", async () => {
    const { docId, users, baseline, sync } = await gatedJoin(ctx, { serial: false });
    const settle = await trySettle(users, docId, ctx.n);
    const shapes = await readI3All(users);
    const copies = copiesOf(shapes);
    ctx.step(`after the simultaneous join (${settle.error ? `no settle: ${firstLine(settle.error)}` : `settled in ${settle.settled.ms} ms`}): ${JSON.stringify(shapes)}`);
    // The harm, for the record: the next keystroke's autosave publishes what the peers hold into the draft.
    const draft = await draftShape(ctx, users[0], tokenLog(ctx.target.runId));
    ctx.step(`the autosave after one keystroke by ${users[0].name} kept: ${JSON.stringify(draft)}`);
    const row = { scenario: "C4 gate", docId, baseline: baseline.children, copies, duplicated: copies > 1, shapes, draft, settledMs: settle.settled?.ms ?? null, settleError: settle.error ? firstLine(settle.error) : null, ...sync };
    record(ctx, row);
    ctx.ev.json("gate", row);
    ctx.t.diagnostic(`C4 gate N=${ctx.n}: ${copies} cop${copies === 1 ? "y" : "ies"} of the body on every peer; the draft after a keystroke ${draft.error ? `(${draft.error})` : `has the sentinel ${draft.sentinels} time(s)`}`);
    assertRowsI3([{ i3: i3With(null, shapes, baseline) }]);
    throwSettle(settle.error, { defect: true });
  });
});

scenario("C4 positive control (serial), client gate: the same N editors held at join-before-bind are let go one at a time, each once the first seed is on every held joiner's socket; the v1 body is once on every peer (I3)", {
  tiers: ["local"],
  effects: EFFECTS,
  needs: ["gates", "patch:amplify-mint-join", "rtdb-proxy"],
  n: N_ALL,
  timeoutMs: 600_000,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  await onAWorkingEmulator(ctx, "C4 gate serial", async () => {
    const { docId, users, baseline, sync, order } = await gatedJoin(ctx, { serial: true });
    const settle = await trySettle(users, docId, ctx.n);
    const shapes = await readI3All(users);
    const copies = copiesOf(shapes);
    ctx.step(`after the serial release (order ${order.join(", ")}; ${settle.error ? `no settle: ${firstLine(settle.error)}` : `settled in ${settle.settled.ms} ms`}): ${JSON.stringify(shapes)}`);
    record(ctx, { scenario: "C4 gate serial", docId, baseline: baseline.children, copies, duplicated: copies > 1, shapes, settledMs: settle.settled?.ms ?? null, settleError: settle.error ? firstLine(settle.error) : null, ...sync });
    assertRowsI3([{ i3: i3With(null, shapes, baseline) }]);
    throwSettle(settle.error);
  });
});

// --- C4 unpatched: held frames, free-running, serial ------------------------------------

/** A fresh document from the fixture, shared for editing with every non-owner, opened by every user (reading mode). */
async function freshDoc(ctx, { owner, accounts, users, title }) {
  const up = await publish(owner.http, { fixture: FIXTURE, title, name: "c04", timeoutMs: 120_000 });
  if (accounts.length > 1) await shareMany(ctx.target, { owner, doc: up.docId, grants: accounts.slice(1).map((a) => ({ account: a, role: "editor" })), timeoutMs: 120_000 });
  for (const u of users) u.inEdit = false;
  for (let i = 0; i < users.length; i += 5) await Promise.all(users.slice(i, i + 5).map((u) => u.open(up.docId, { timeout: 90_000 })));
  return up.docId;
}

/**
 * Count, per page, the editable draft frame's navigations from now until
 * stop(), which resolves {requests: {name: k}, commits: {name: k}}: GET
 * navigation requests matching `re` (what the network saw), and child-frame
 * commits of a URL matching `re` (Playwright's framenavigated: what the page
 * loaded, which also sees a navigation restarted without a new request).
 * One of each per joiner between its press and "Shared" is the proof that the
 * navigation held for it is the one whose load bound.
 */
function watchDraftNavigations(users, re) {
  const requests = Object.fromEntries(users.map((u) => [u.name, 0]));
  const commits = Object.fromEntries(users.map((u) => [u.name, 0]));
  const listeners = users.map((u) => {
    const onRequest = (req) => {
      try {
        if (req.method() === "GET" && req.isNavigationRequest() && re.test(req.url())) requests[u.name] += 1;
      } catch {
        // a request with no frame (a service worker's): not the draft frame's
      }
    };
    const onCommit = (frame) => {
      if (frame !== u.page.mainFrame() && re.test(frame.url())) commits[u.name] += 1;
    };
    u.page.on("request", onRequest);
    u.page.on("framenavigated", onCommit);
    return { page: u.page, onRequest, onCommit };
  });
  return {
    stop() {
      for (const { page, onRequest, onCommit } of listeners) {
        page.off("request", onRequest);
        page.off("framenavigated", onCommit);
      }
      return { requests: { ...requests }, commits: { ...commits } };
    },
  };
}

/**
 * SYNC-H on the draft frames, ONE HOLD PER PAGE: each joiner's first
 * editable /draft/<doc>/ navigation is held (holdRequests of 1 on its own
 * page), all are let go in one loop, and the overlap proof runs over the n
 * records. INCONCLUSIVE (with the round's sync measure recorded first) when
 * a page's navigation was never held, when a page navigated its draft frame
 * again while held or before its release finished (its hold's `extra`), when
 * the held requests did not provably overlap, or when any page made other
 * than exactly ONE draft navigation request and ONE draft frame commit
 * between its press and "Shared".
 */
async function heldFramesJoin(ctx, { users, docId, label, sync, abandon }) {
  const re = new RegExp(`/draft/${escapeRe(docId)}/`);
  const navs = watchDraftNavigations(users, re);
  const holds = users.map((u) => holdRequests(u.page, re, 1, { method: "GET", predicate: (req) => req.isNavigationRequest(), timeoutMs: 60_000 }));
  try {
    try {
      await Promise.all(holds.map((h) => h.installed));
      await Promise.all(users.map((u) => u.page.locator(EDIT_BUTTON).first().click({ timeout: 30_000 })));
      try {
        await Promise.all(holds.map((h) => h.held));
      } catch (err) {
        if (err?.code === "E2E_SYNC_TIMEOUT") {
          sync.heldPages = users.filter((u, i) => holds[i].records.length > 0).map((u) => u.name);
          abandon(`${label}: not every joiner's draft frame navigation was held (held: ${JSON.stringify(sync.heldPages)} of ${users.length}): ${err.message}`);
        }
        throw err;
      }
      // Each release() continues its one held route synchronously when called, so this map lets every held navigation go in one loop.
      const rels = await Promise.all(holds.map((h) => h.release()));
      const records = rels.flatMap((r, i) => r.records.map((rec) => ({ ...rec, page: users[i].name })));
      const overlap = overlapProof(records);
      sync.heldPages = records.map((r) => r.page);
      sync.extra = Object.fromEntries(users.map((u, i) => [u.name, rels[i].extra]));
      sync.overlap = { ok: overlap.ok, n: overlap.n, marginMs: Number.isFinite(overlap.marginMs) ? Number(overlap.marginMs.toFixed(1)) : null, reason: overlap.reason };
      const pages = new Set(sync.heldPages);
      if (records.length !== users.length || pages.size !== users.length) abandon(`${label}: ${records.length} held navigation(s) of ${pages.size} page(s), not one for each of the ${users.length} joiners`);
      const again = users.filter((u) => sync.extra[u.name] > 0);
      if (again.length > 0) abandon(`${label}: ${again.map((u) => `${u.name} navigated its draft frame ${sync.extra[u.name]} more time(s)`).join(", ")} while held or being let go: the run that binds may not be the held one`);
      if (!overlap.ok) abandon(`${label}: overlap proof: ${overlap.reason}${overlap.detail ? ` — ${overlap.detail}` : ""}${Number.isFinite(overlap.marginMs) ? ` (margin ${overlap.marginMs.toFixed(1)} ms)` : ""}`);
    } finally {
      await Promise.all(holds.map((h) => h.unroute()));
    }
    await allShared(ctx, users, awaitShared, `${label}, after the held frames were let go`);
  } finally {
    sync.navigations = navs.stop();
  }
  const { requests, commits } = sync.navigations;
  const not1 = users.filter((u) => requests[u.name] !== 1 || commits[u.name] !== 1);
  if (not1.length > 0) abandon(`${label}: between the press and "Shared", ${not1.map((u) => `${u.name} made ${requests[u.name]} draft frame navigation request(s) and ${commits[u.name]} commit(s)`).join(", ")}, not exactly the one held`);
}

/**
 * One round: every user, reading `docId`, joins its live log at `latency`,
 * as `mode` says: "press" (SYNC-T: joiner i presses Edit at t0 + i·offsetMs,
 * each press time read in its page), "frames" (SYNC-H on the editable draft
 * frames' navigations, released together) or "serial" (one after another,
 * the next once the first seed is logged). Resolves the round's row, with
 * `i3` (its judge's result) and `settleError`.
 */
async function joinRound(ctx, { mode, users, docId, lat, latency, round, offsetMs = null }) {
  const n = users.length;
  const label = mode === "press" ? `${latency.key} Δ${offsetMs}` : `${latency.key} round ${round}`;
  const baseline = await baselineOf(users[0]);
  const sync = { startedAt: new Date().toISOString() };
  /** A sync precondition that did not hold: the round's row so far is recorded (outcome INCONCLUSIVE), then the case ends INCONCLUSIVE. */
  const abandon = (reason) => {
    record(ctx, { scenario: `C4 ${mode}`, mode, latency: latency.key, up: latency.up, down: latency.down, round, docId, ...sync, baseline: baseline.children, inconclusive: reason });
    ctx.inconclusive(`the sync precondition did not hold: ${reason}`);
  };
  const proxyBefore = await proxyNow(lat);
  await lat.set({ up: latency.up, down: latency.down });
  try {
    if (mode === "press") {
      const fire = await syncPages(users.map((u) => u.page), pressEditInPage, { arg: (i) => i * offsetMs, leadMs: n >= 10 ? 1_500 : 600 });
      precondition(fire.fires.every((f) => !f.error && Number.isFinite(f.result)), `every page pressed Edit (${JSON.stringify(fire.fires.map((f) => f.error ?? f.result))})`);
      requireConclusive(ctx, { spread: fire });
      const at = fire.fires.map((f) => f.result);
      const gaps = at.slice(1).map((t, i) => t - at[i]);
      sync.offsetMs = offsetMs;
      sync.spreadMs = Number(fire.spreadMs.toFixed(2));
      sync.gapsMs = gaps.map((g) => Number(g.toFixed(1)));
      const off = gaps.filter((g) => Math.abs(g - offsetMs) > PRESS_TOLERANCE_MS);
      if (off.length > 0) ctx.inconclusive(`the sync precondition did not hold: ${label}: the presses were ${JSON.stringify(sync.gapsMs)} ms apart, not ${offsetMs} ± ${PRESS_TOLERANCE_MS} ms`);
      await allShared(ctx, users, awaitShared, `${label}, after the synchronised presses`);
    } else if (mode === "frames") {
      await heldFramesJoin(ctx, { users, docId, label, sync, abandon });
    } else {
      for (const [i, u] of users.entries()) {
        await allShared(ctx, [u], (x) => x.enterEdit({ waitShared: true, timeout: 90_000 }), `${label}, ${u.name} entering alone`);
        if (i === 0) await waitLogged(ctx, docId);
      }
    }
  } finally {
    await lat.reset().catch(() => undefined);
  }
  sync.drain = await drainProxy(lat);
  sync.proxy = proxyDelta(proxyBefore, await proxyNow(lat));
  const settle = await trySettle(users, docId, n);
  const shapes = await readI3All(users);
  const i3 = i3With(label, shapes, baseline);
  const copies = copiesOf(shapes);
  const row = { mode, label, latency: latency.key, up: latency.up, down: latency.down, round, docId, ...sync, endedAt: new Date().toISOString(), baseline: baseline.children, copies, duplicated: !i3.ok, shapes, settledMs: settle.settled?.ms ?? null, settleError: settle.error ? firstLine(settle.error) : null };
  ctx.step(`${mode} at ${latency.label}, ${mode === "press" ? `presses ${offsetMs} ms apart (measured ${JSON.stringify(sync.gapsMs)})` : `round ${round}`}: ${copies} cop${copies === 1 ? "y" : "ies"} of the body${sync.overlap ? `; one held draft navigation per joiner (${JSON.stringify(sync.heldPages)}, extra ${JSON.stringify(sync.extra)}, navigations to "Shared" ${JSON.stringify(sync.navigations)}), overlapped by ${sync.overlap.marginMs} ms` : ""}; proxy drained in ${sync.drain.ms} ms, counted ${JSON.stringify(sync.proxy)}; ${row.settleError ? `no settle: ${row.settleError}` : `settled in ${row.settledMs} ms`}`);
  record(ctx, { scenario: `C4 ${mode}`, ...row });
  return { ...row, i3, settleError: settle.error };
}

/**
 * joinShared (reading mode), then, per latency, PRESS_OFFSETS_MS rounds
 * ("press") or ROUNDS[N] rounds (the others), a fresh document each.
 * Resolves the rows.
 */
async function joinRounds(ctx, { mode, title }) {
  const n = ctx.n;
  const lat = rtdbLatency(ctx.target);
  await lat.reset();
  // From before any page opens: each page's connection, handshake and upgrade are then in the case's counts (a round's own are its reconnects).
  const proxyBefore = await proxyNow(lat);
  const { docId: first, owner, accounts, users } = await joinShared(ctx, { n, fixture: FIXTURE, title: `${title} N=${n}`, enter: false });
  const plan = mode === "press" ? PRESS_OFFSETS_MS.map((offsetMs, i) => ({ round: i + 1, offsetMs })) : Array.from({ length: ROUNDS[n] ?? 1 }, (_, i) => ({ round: i + 1, offsetMs: null }));
  const rows = [];
  let docId = first;
  try {
    for (const latency of LATENCIES) {
      for (const { round, offsetMs } of plan) {
        if (rows.length > 0) docId = await freshDoc(ctx, { owner, accounts, users, title: `${title} N=${n} ${latency.key} r${round}` });
        rows.push(await joinRound(ctx, { mode, users, docId, lat, latency, round, offsetMs }));
      }
    }
  } finally {
    await lat.reset().catch(() => undefined);
  }
  const rates = LATENCIES.map((l) => {
    const mine = rows.filter((r) => r.latency === l.key);
    if (mode === "press") return `${l.key}: ${mine.map((r) => `Δ${r.offsetMs} ${r.copies}×`).join(" ")}`;
    return `${l.key} ${mine.filter((r) => r.duplicated).length}/${mine.length}`;
  }).join("; ");
  ctx.ev.json("rounds", rows.map(({ i3, settleError, ...r }) => r));
  const proxy = proxyDelta(proxyBefore, await proxyNow(lat));
  record(ctx, { scenario: `C4 ${mode} case`, rounds: rows.length, proxy });
  ctx.ev.json("proxy", proxy);
  ctx.step(`RTDB proxy over the case, from before the pages opened: ${JSON.stringify(proxy)}`);
  const line = mode === "press" ? `C4 ${mode} N=${n}: copies of the body by press offset, ${rates}` : `C4 ${mode} N=${n}: duplicated in ${rates} round(s)`;
  ctx.step(line);
  ctx.t.diagnostic(line);
  return rows;
}

scenario("C4 simultaneous first join, held frames: N editors' editable draft frames are held and let go together on an unpatched product, at the emulator's speed and at a 150 ms round trip; the v1 body is once on every peer (I3)", {
  tiers: ["local"],
  effects: EFFECTS,
  needs: ["rtdb-proxy", "!gates"],
  n: N_ALL,
  defect: "S1",
  timeoutMs: 900_000,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  await onAWorkingEmulator(ctx, "C4 frames", async (watch) => {
    const rows = await judgedRounds(ctx, watch, await joinRounds(ctx, { mode: "frames", title: "C4 held frames" }), "C4 frames", { defect: true });
    assertRowsI3(rows);
    throwSettle(rows.find((r) => r.settleError)?.settleError, { defect: true });
  });
});

scenario("C4 simultaneous first join, free-running: N editors press Edit 0, 100, 300 and 1000 ms apart (SYNC-T) on an unpatched product, at the emulator's speed and at a 150 ms round trip; the v1 body is once on every peer (I3)", {
  tiers: ["local"],
  effects: EFFECTS,
  needs: ["rtdb-proxy", "!gates"],
  n: N_ALL,
  defect: "S1",
  timeoutMs: 1_500_000,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  await onAWorkingEmulator(ctx, "C4 press", async (watch) => {
    const rows = await judgedRounds(ctx, watch, await joinRounds(ctx, { mode: "press", title: "C4 free-running" }), "C4 press", { defect: true });
    assertRowsI3(rows);
    throwSettle(rows.find((r) => r.settleError)?.settleError, { defect: true });
  });
});

scenario("C4 positive control (serial), unpatched: N editors press Edit one after another, the next once the first seed is logged, at the emulator's speed and at a 150 ms round trip; the v1 body is once on every peer (I3)", {
  tiers: ["local"],
  effects: EFFECTS,
  needs: ["rtdb-proxy", "!gates"],
  n: N_ALL,
  timeoutMs: 900_000,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  await onAWorkingEmulator(ctx, "C4 serial", async (watch) => {
    const rows = await judgedRounds(ctx, watch, await joinRounds(ctx, { mode: "serial", title: "C4 serial" }), "C4 serial");
    assertRowsI3(rows);
    throwSettle(rows.find((r) => r.settleError)?.settleError);
  });
});

// --- C4b: an open-edit non-member joins --------------------------------------------

/**
 * Members (users[0] the owner) enter edit: the owner alone until its seed is
 * logged, then the rest five at a time, each until "Shared".
 */
async function membersEnter(ctx, members, docId) {
  await allShared(ctx, [members[0]], (u) => u.enterEdit({ waitShared: true, timeout: 90_000 }), `${members[0].name} entering alone`);
  await waitLogged(ctx, docId);
  const rest = members.slice(1);
  for (let i = 0; i < rest.length; i += 5) await allShared(ctx, rest.slice(i, i + 5), (u) => u.enterEdit({ waitShared: true, timeout: 90_000 }), "the members entering");
}

/**
 * One leg of the merge: arm every peer but `from` for `text` ANYWHERE in its
 * frame's body (lib/frame.mjs armArrival with a null id: every copy of a
 * doubled body, where getElementById would find only the first), type
 * `text` at the end of #`id` as `from` (lib typeProbe: a person's
 * keystrokes), and wait up to `timeoutMs` for each (lib arrival, read every
 * 50 ms; the time was taken in the page). Resolves {after, arrivals: [{name,
 * shared, ms, why}]}: ms from the last keystroke to the arrival (page clocks
 * on one machine), null with `why` when it did not arrive. The long wait
 * only tells "late" from "never"; I13 judges the time. Unlike lib
 * probeArrivals, a page that navigated or replaced its frame is reported
 * with its `why` rather than thrown.
 */
async function probeLeg(users, { from, id, text, timeoutMs }) {
  const others = users.filter((u) => u !== from);
  await Promise.all(
    others.map((u) =>
      armArrival(u, null, text).catch((err) => {
        throw new Error(`${u.name}: arming the arrival probe: ${firstLine(err)}`, { cause: err });
      }),
    ),
  );
  const shared = Object.fromEntries(await Promise.all(others.map(async (u) => [u.name, (await u.shareState()) === "shared"])));
  const { after } = await typeProbe(from, `[id="${id}"]`, text);
  const deadline = Date.now() + timeoutMs;
  const arrivals = await Promise.all(
    others.map(async (u) => {
      for (;;) {
        const a = await arrival(u, text);
        if (!a.armed) return { name: u.name, shared: shared[u.name], ms: null, why: "the page navigated, dropping the probe" };
        if (a.at !== null) return { name: u.name, shared: shared[u.name], ms: Math.max(0, a.at - after), why: null };
        if (a.reloaded) return { name: u.name, shared: shared[u.name], ms: null, why: "the document frame was replaced" };
        if (Date.now() >= deadline) return { name: u.name, shared: shared[u.name], ms: null, why: `not within ${timeoutMs} ms` };
        await sleep(50);
      }
    }),
  );
  // For the record: whether an arrival is also in the peer's FIRST #id, where a probe by id would have looked (false: it is in another copy).
  await Promise.all(
    arrivals.map(async (a) => {
      if (a.ms === null) return;
      const u = others.find((x) => x.name === a.name);
      a.inFirstId = await u
        .frame()
        .then((f) => f.evaluate(([i, t]) => document.getElementById(i)?.textContent.includes(t) === true, [id, text]))
        .catch(() => null);
    }),
  );
  return { after, arrivals };
}

/**
 * I13 on one leg, every arrival judged whatever its peer's share state
 * (plan A11.7 asks it unconditionally; a joiner not sharing is its own
 * failure): each failure as `not merged (I13, <from> → <to>): <checkI13's>`.
 */
function i13Leg(fromName, toLabel, arrivals) {
  const r = checkI13({ arrivals: arrivals.map((a) => ({ name: a.name, ms: a.ms, shared: true })), limitMs: I13_LIMIT_MS });
  return { ok: r.ok, maxMs: r.maxMs, failures: r.failures.map((f) => `not merged (I13, ${fromName} → ${toLabel}): ${f}`) };
}

/** The joiner's share state once it has had SHARED_WAIT_MS to join: {share, afterMs} (afterMs from the press, null when never "Shared"). */
async function joinerShareAfter(joiner, pressedAt) {
  const sharedAt = await eventually(async () => ((await joiner.shareState()) === "shared" ? Date.now() : false), {
    timeout: SHARED_WAIT_MS, interval: 100, message: `${joiner.name} shows "Shared"`,
  }).catch(() => null);
  if (sharedAt !== null) return { share: "shared", afterMs: sharedAt - pressedAt };
  return { share: await joiner.shareState().catch(() => "unknown"), afterMs: null };
}

/**
 * N−1 members live on a PUBLIC open-editing document, then a verified joiner
 * opens it and presses Edit: a non-member (`member: false`, C4b) or an
 * account granted editor AFTER open editing was turned on (`member: true`,
 * its positive control). Judged (see the header): the members' I3 before the
 * press (a plain error: FAILS as itself), then I3 on every peer, the joiner
 * sharing the live log, and I13 both ways between a member and the joiner.
 */
async function openEditJoin(ctx, { member }) {
  const n = ctx.n;
  const log = tokenLog(ctx.target.runId);
  // On a stack with the RTDB proxy every page's live log goes through it: its counters from before any page opens say whether each stayed on it.
  const lat = ctx.target.capabilities?.has?.("rtdb-proxy") ? rtdbLatency(ctx.target) : null;
  const proxyBefore = lat ? await proxyNow(lat) : null;
  const { docId, owner, users: members } = await joinShared(ctx, { n: n - 1, fixture: FIXTURE, title: `C4b ${member ? "member joiner" : "open editor"} N=${n}`, enter: false });
  const [acct] = await cast(ctx.target, [member ? "editor-joiner" : "open-editor"], { http: ctx.http({ actor: "harness" }) });
  const joiner = await ctx.users.user({ name: "pj", consent: "denied" });
  const signed = await joiner.signInUi(acct.email, acct.password);
  precondition(signed.status === "ok", `the joiner signed in through /signup (${signed.status})`);
  const v = await setVisibility(ctx.target, { owner, doc: docId, visibility: "public", publicEdit: true, timeoutMs: 120_000 });
  precondition(v.visibility === "public" && v.publicEdit === true, `POST /visibility public with open editing: ${v.status} ${JSON.stringify(v.json)?.slice(0, 200)}`);
  if (member) {
    // After open editing, as the C4b joiner meets it; the share's own mirror check is recorded, never a precondition (the controls on this case break exactly that mirror).
    const g = await share(ctx.target, { owner, doc: docId, account: acct, role: "editor", timeoutMs: 120_000 });
    precondition(g.status === 200, `the joiner was granted editor: ${g.status}`);
    ctx.step(`the joiner ${acct.email} was granted editor; its mirror read back ${JSON.stringify(g.mirror)}`);
  }
  const [presence, edit] = await Promise.all([rtdbGet(ctx.target, `presenceAccess/${docId}`), rtdbGet(ctx.target, `editAccess/${docId}`)]);
  const key = emailKey(acct.email);
  const mirror = { presenceAccess: Boolean(presence?.[key]), editAccess: Boolean(edit?.[key]), star: edit?.["*"] === true };
  if (!member) {
    precondition(mirror.star, `editAccess/${docId}/* is set for a public open-editing document: ${JSON.stringify(Object.keys(edit ?? {}))}`);
    precondition(!mirror.presenceAccess && !mirror.editAccess, `the open editor is not a member (no mirror entry of its own): ${JSON.stringify(mirror)}`);
  }
  ctx.step(`${docId} is public with open editing; the joiner's mirror entries: ${JSON.stringify(mirror)}${member && !mirror.star ? " (editAccess/* dropped by the share after open editing: X-a11-live-3; a member writes through its own key)" : ""}`);
  const baseline = await baselineOf(members[0]);
  const row = { scenario: member ? "C4b member" : "C4b", docId, members: members.length, mirror, baseline: baseline.children };
  try {
    ctx.step(`${members.length} member(s) enter edit: ${members[0].name} alone until its seed is logged, then the rest`);
    await membersEnter(ctx, members, docId);
    // The control inside the case: the members alone keep one body, so any doubling after this is the joiner's press.
    const beforeShapes = await readI3All(members);
    const before = i3With("before the joiner pressed Edit", beforeShapes, baseline);
    row.membersBefore = { ok: before.ok, copies: copiesOf(beforeShapes), shapes: beforeShapes };
    ctx.step(`the members alone, before the joiner presses Edit: ${JSON.stringify(beforeShapes)} (I3 ${before.ok ? "holds" : "FAILS"})`);
    if (!before.ok) {
      const err = new Error(`not this case's oracle, the members' own join: I3 ${before.failures.join("; ")}`);
      err.code = "E2E_C04_MEMBERS";
      throw err;
    }
    ctx.step(`the joiner opens the public document and presses Edit`);
    await joiner.open(docId, { timeout: 90_000 });
    precondition((await joiner.page.locator(EDIT_BUTTON).count()) === 1, "open editing gives the joiner an Edit button");
    // The mechanism, for the record: what the joiner's own ID token may do to the live log (rules, ?auth=).
    const read = await rtdbAs(ctx.target, { idToken: await idToken(ctx.target, acct), http: ctx.http({ actor: "rtdb" }) }).get(`status/${docId}/y`).catch((err) => ({ verdict: null, error: firstLine(err) }));
    row.joinerRead = read.verdict ?? read.status ?? read.error;
    const pressedAt = Date.now();
    await joiner.enterEdit({ waitShared: false, timeout: 90_000 });
    const joined = await joinerShareAfter(joiner, pressedAt);
    row.joinerShare = joined.share;
    row.joinerSharedAfterMs = joined.afterMs;
    const peers = [...members, joiner];
    ctx.step(`the joiner's share state: ${joined.share}${joined.afterMs !== null ? ` (${joined.afterMs} ms after its press)` : ` after ${SHARED_WAIT_MS} ms`}; its own read of status/${docId}/y: ${row.joinerRead}`);
    // Merged peers converge; a joiner editing alone is judged on its own body, the members settled without it.
    const settle = joined.share === "shared" ? await trySettle(peers, docId, n) : members.length >= 2 ? await trySettle(members, docId, n - 1) : { settled: null, error: null };
    row.settledMs = settle.settled?.ms ?? null;
    row.settleError = settle.error ? firstLine(settle.error) : null;
    const shapes = await readI3All(peers);
    row.copies = copiesOf(shapes);
    row.shapes = shapes;
    const timeoutMs = settleDeadlineMs(n);
    const toJoiner = await probeLeg(peers, { from: members[0], id: "e2e-2", text: log.next(members[0].name, "e2e-2"), timeoutMs });
    const fromJoiner = await probeLeg(peers, { from: joiner, id: "e2e-3", text: log.next(joiner.name, "e2e-3"), timeoutMs });
    const toJoinerArrival = toJoiner.arrivals.filter((a) => a.name === joiner.name);
    const legIn = i13Leg(members[0].name, joiner.name, toJoinerArrival);
    const legOut = i13Leg(joiner.name, "the members", fromJoiner.arrivals);
    row.arrivals = { [`${members[0].name}→`]: toJoiner.arrivals, [`${joiner.name}→`]: fromJoiner.arrivals };
    row.i13 = { limitMs: I13_LIMIT_MS, toJoiner: { ok: legIn.ok, maxMs: legIn.maxMs }, fromJoiner: { ok: legOut.ok, maxMs: legOut.maxMs } };
    const said = (as) => as.map((a) => `${a.name} ${a.ms == null ? `never (${a.why})` : `${a.ms} ms`}`).join(", ");
    ctx.step(`I3 shapes ${JSON.stringify(shapes)}; ${members[0].name}'s probe reached ${said(toJoiner.arrivals)}; ${joiner.name}'s probe reached ${said(fromJoiner.arrivals)} (I13 bound ${I13_LIMIT_MS} ms)`);
    const failures = i3With(null, shapes, baseline).failures.map((f) => `I3 ${f}`);
    if (joined.share !== "shared") failures.push(`not merged: ${joiner.name} is editing alone: its share state is ${JSON.stringify(joined.share)} ${SHARED_WAIT_MS} ms after it pressed Edit`);
    failures.push(...legIn.failures, ...legOut.failures);
    row.failures = failures;
    if (failures.length > 0) {
      const message = `C4b: ${failures.join("; ")}`;
      throw new AssertionError({ message: message.length > 4000 ? `${message.slice(0, 4000)}…` : message, actual: failures, expected: [], operator: "C4b" });
    }
    throwSettle(settle.error, { defect: !member });
  } finally {
    if (lat) row.proxy = await proxyNow(lat).then((now) => proxyDelta(proxyBefore, now), (err) => ({ error: firstLine(err) }));
    record(ctx, row);
    ctx.ev.json("c4b", row);
  }
}

scenario("C4b an open-edit non-member joins N−1 members editing a public document live: every peer's v1 body is once (I3), the joiner shares the live log, and a probe keystroke crosses each way between a member and the joiner within 2 s (I13)", {
  tiers: ["local"],
  effects: EFFECTS,
  needs: ["rtdb-rules"],
  n: N_ALL,
  defect: "S27",
  timeoutMs: 600_000,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  await onAWorkingEmulator(ctx, "C4b", async () => {
    await openEditJoin(ctx, { member: false });
  });
});

scenario("C4b positive control: an account granted editor joins N−1 members editing a public open-editing document live: every peer's v1 body is once (I3), the joiner shares the live log, and a probe keystroke crosses each way between a member and the joiner within 2 s (I13)", {
  tiers: ["local"],
  effects: EFFECTS,
  needs: ["rtdb-rules"],
  n: N_ALL,
  timeoutMs: 600_000,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  await onAWorkingEmulator(ctx, "C4b member", async () => {
    await openEditJoin(ctx, { member: true });
  });
});
