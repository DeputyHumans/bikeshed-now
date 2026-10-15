// SPDX-License-Identifier: Apache-2.0
// Concurrency C12a–d: an agent's update against live editors, curl-only drafts racing an update, the draft objects and live log an update replaces, and the log an in-app commit leaves (SPEC §2, §6a, §16, §19).

/**
 * v0.16.0 (5c7c3de) changed what an update does, and every oracle here is
 * the CURRENT SPEC's:
 *   §6a  "No update is made under somebody's editor. /publish?update=, the
 *        CLI and update_document are refused with 409 { error, editors }
 *        while anybody has the document open in the editor … Once the
 *        version is current, the draft's files and its live log are dropped
 *        (§16); a refused or deduplicated update leaves both alone. A race
 *        remains … somebody who opens the editor between the question and
 *        the new version loses what they type in that window."
 *   §16  "The log belongs to the draft … a write made outside the editor is
 *        refused while anybody is in it, and drops a log nobody is using …
 *        An update deletes the draft's files with it; left in place, /draft
 *        would serve them. Without both, the next person to open the editor
 *        would bring the replaced draft back over the new version and
 *        autosave it."
 *   §2   POST /draft "409 { currentVersion } when baseVersion !==
 *        currentVersion"; GET /draft "serves the draft prefix, falling back
 *        to docs/{docId}/{baseVersion}/<relPath>"; /publish?update= "anybody
 *        having the document open in the editor a 409 { error, editors }".
 *   §19  update_document "refused while anybody has the document open in
 *        the editor".
 *
 * The agent is the owner's personal token (channel mcp). Its new content,
 * C_agent, is the fixture with the heading renamed and a paragraph
 * #c12-agent holding a marker; "the next editor sees the agent's version"
 * means a person who opens the editor afterwards finds that heading and
 * that marker, the sentinel once, and nothing of what was replaced.
 *
 *   C12a AGENT UPDATE VS EDITORS. N editors are "Shared" and type tokens
 *        without pause; once each has typed and presence shows all N in the
 *        editor, the agent's update_document and the owner's
 *        /publish?update= (the app's upload, with the session cookie) are
 *        fired at one instant (SYNC-T: spread <= 15 ms and the overlap
 *        proof), and every editor goes on typing until both are answered.
 *        The race proof is each editor's own token times, taken in Node: a
 *        token begun before the send, else INCONCLUSIVE; and a token ended
 *        after the answers, else INCONCLUSIVE, but only when nothing judged
 *        so far failed (a frame the product reloads because a version was
 *        minted must fail the oracles, not hide them). status/{d}/peers is
 *        read every 200 ms across the window and recorded (inputClocks too).
 *        Oracles judged AT ONCE on a read made right before the send and one
 *        made right after both answers: both are refused with
 *        editorsRefusal's words naming N editors (and `editors: N` on the
 *        HTTP 409); nothing is minted or uploaded; and "left alone": the
 *        draft's record (base, entry, bytes, updatedAt) and every object
 *        under docs/{d}/draft/ (name, Storage generation and metageneration,
 *        md5, size: admin.mjs listObjects {meta: true}) are exactly as they
 *        were, and status/{d}/y, watched through the Admin SDK's listener
 *        (admin.mjs watchRtdb), never takes a value with no entries.
 *        Autosave is a trailing 1 s debounce (useInlineEditor.ts AUTOSAVE_MS) and the
 *        editors type without pause, so nothing else writes the draft
 *        between the reads; a POST /draft that could have written there
 *        leaves the record/objects half unjudged, and a case that otherwise
 *        passes is then INCONCLUSIVE. Later, after the editors' next
 *        autosaves: each answers 200 on v1 (after a mint the app remounts an
 *        open editor on the new version, DocViewer.tsx:208-211, so its save
 *        answers 200 on v2: the base, not the status, shows a mint); the
 *        session settles (I1) with every token once (I2);
 *        nothing minted and the draft and log still there. Then everyone
 *        presses Done, the agent's update publishes v2, the live log is
 *        empty within 2 s, the draft's record and objects are gone, GET
 *        /draft serves v2's entry, and the next editor sees the agent's
 *        version. On a stack with amplify-c12-update its probe records, per
 *        update, what the functions' own Database client read for the
 *        editors question (connected, editors, modes, log, each read's ms),
 *        for X-c12-agent-vs-editors-2 (one mint under 5 open editors, seen
 *        once; its N=5 case is held at U until it has K=5 trials).
 *        Controls: controls-c12a-refusal-mints (the refusal answered only
 *        after the upload and the mint) and controls-c12a-refusal-drops (the
 *        draft's files and log dropped before the refusal).
 *   C12b CURL-ONLY DRAFTS VS THE UPDATE. N−1 editors POST /draft with a
 *        personal token (no editor, so no live log) on v1 while the agent's
 *        update_document on v1 is fired at the same instant (SYNC-T). Each
 *        draft is either saved before the update (and dropped by it) or
 *        refused as stale. Oracles, once the server holds still for 10 s:
 *        no draft record that is not of the current version, no object
 *        under docs/{d}/draft/, GET /draft serves v2's entry, and the next
 *        editor sees the agent's version.
 *   C12b straddle (SYNC-P, amplify-c12-update: draft-after-check) the
 *        window natural timing rarely opens: every curl draft is HELD after
 *        POST /draft's base check (v1 is current) and before it writes; the
 *        agent's update then publishes v2 and drops the draft; the drafts
 *        are let go and write. Two cases run it, one per mechanism, so that
 *        each fix turns its own case green:
 *          "C12b straddle", own oracle (S14: getDraft's base rule,
 *          functions/src/index.ts:1247-1268, serves docs/{d}/draft/ whatever
 *          base the draft was written on): GET /draft serves the agent's
 *          version and the next editor sees it. What was left is recorded.
 *          "C12b straddle draft write", own oracle (X-a12-versions-2:
 *          saveDraft checks the base, index.ts:1175-1181, outside any
 *          transaction with its write, draft.ts:106-131): no docs/{d}.draft on
 *          v1 and no object under docs/{d}/draft/. What GET /draft serves is
 *          recorded.
 *        The rule for ids, here and in C12c: an oracle keeps a plan
 *        suspect's id only while it fails through a mechanism the plan cites
 *        for that suspect and 0.16.0 still has (S14 cites getDraft,
 *        index.ts:1243-1270); a residual harm through another mechanism takes
 *        that mechanism's id, an existing one when the ledger tracks it
 *        (X-a12-versions-2) or a new X-c12 one (X-c12-agent-vs-editors-1:
 *        the update clears only a log that existed at its question). S6's
 *        cited mechanism (an update never clears the log) and the update
 *        half of S14's (publish.ts leaves the draft files) are gone in
 *        0.16.0, which C12b and C12c refute.
 *   C12b straddle serial positive control: the same drafts and update one
 *        after another (each draft saved, then the update, then each draft
 *        again on v1, refused as stale): every C12b oracle must PASS. It is
 *        the positive control of both straddle cases.
 *   C12c DELETED DRAFT OBJECTS, LEFTOVER LOG. N editors type, save and all
 *        press Done: nobody is in the editor, and the draft and its live log
 *        hold their tokens. The agent's update publishes v2. Oracles: the
 *        live log is empty within 2 s (refutes S6), the draft's record and
 *        objects are gone (refutes S14's update half), GET /draft serves v2's
 *        entry, and the next editor sees the agent's version and none of the
 *        tokens.
 *   C12c race (SYNC-P, amplify-c08-mint-races: update-before-id, after
 *        every refusal and before the version id) the window §6a names:
 *        the agent's update passes the editors question while nobody edits
 *        and the log is empty, and is held; min(N−1, 4) editors then open
 *        the editor (the first seeds the log from v1), each types a token
 *        and autosaves it on v1; the update is let go and publishes v2; the
 *        editors leave. Own oracle (X-c12-agent-vs-editors-1): the next
 *        editor to open the editor sees the agent's version.
 *   C12c race serial positive control: the same update, then the same
 *        editors opening, typing and leaving, one after another: the next
 *        editor sees the agent's version. Must PASS.
 *   C12d IN-APP COMMIT. N editors type and settle; all but p1 press Done;
 *        p1 presses "Save as new version". Oracles (SPEC §2, §6a): "Published
 *        v2.", v2 on v1 via the editor, the draft's record and objects gone,
 *        v2 holds every token once (I2) and the sentinel once (I3), and the
 *        next editor sees v2 (I2, I3). Then the agent's update on v2
 *        publishes v3, the live log is empty within 2 s, and the next editor
 *        sees the agent's version. Own oracle (defect S8, class Q, as a09's
 *        A9.8 keeps it): status/{d}/y is empty within 2 s of "Published
 *        v2.". A SPEC question, not a violation: SPEC §16 lists the writes
 *        made OUTSIDE the editor as the ones that drop a log nobody is
 *        using, and says nothing of the in-app commit, whose client-side
 *        clearLog (app/src/crdt/rtdb.ts:69-76) removes the whole node, which
 *        the rules (database.rules.json, status/$docId/y/$entry) never
 *        allow. It is judged only where the database enforces the tree's
 *        rules (rtdbRulesStatus, live; S31); elsewhere the case FAILS its
 *        precondition, as A9.8 does.
 *   C12d co-editor (S8's other side, class Q, recorded): as C12d, but p2
 *        stays in the editor and types without pause through p1's commit and
 *        3 s past it. Oracles: "Published v2.", and v2 and the next editor
 *        show the sentinel once (I3). Recorded: where p2's keys begun after
 *        p1's pre-commit save end up (v2; p2's page, whose edit frame the app
 *        remounts on v2 because the editing mode follows doc.currentVersion,
 *        DocViewer.tsx:208-211, and the base its own next save goes on; the
 *        live log; what the next editor sees; the draft its first keystroke
 *        saves): the evidence G1 needs to choose between dropping the log on
 *        commit (those keys lost) and keeping it (unpublished keys kept as
 *        the next draft). No SPEC sentence says which base a co-editor's
 *        open editor saves on once a version is published (§16 keeps the
 *        stale 409 for "somebody PUBLISHED a new version while you were
 *        editing"), so that is recorded, never judged.
 *
 * The three gated cases need both amplify sets (their callers pass the gate
 * service by when unarmed), and C12a's probe needs amplify-c12-update:
 *   node e2e/run.mjs run --suite concurrency --spec c12-agent-vs-editors.spec.mjs \
 *     --patches amplify-c08-mint-races --patches amplify-c12-update --n 2 --trials 2
 * Without them those three are SKIPPED with the missing capability; every
 * other case runs on any stack. A held request is let go well inside the
 * Hosting emulator's 60 s cut-off; a 504 instead is the stack's answer, and
 * the case is INCONCLUSIVE.
 *
 * In a `defect:` case only that defect's own oracle is an AssertionError (a
 * TODO); every other oracle that fails there is a plain error (a FAIL), so
 * one defect never hides another. A failed sync precondition (a spread or
 * an overlap that did not hold, a gate that never held, a peer never
 * "Shared", typing that did not span the race) is INCONCLUSIVE, never FAIL.
 * The Database emulator can fail its whole namespace for 30 s under
 * concurrent rule-checked writes (README Known harness facts); every case
 * here reads presence or the live log through it, so a case whose span
 * crossed such a failure in logs/database-debug.log ends INCONCLUSIVE
 * whatever it would have said, with the emulator's lines recorded (guarded).
 * Editors are granted as joinShared grants them (lib/live.mjs
 * grantEditors): locally one POST /access, elsewhere the operator script
 * with no email, so the ungated cases run on both tiers; a grant whose RTDB
 * mirror is missing (S16) is INCONCLUSIVE.
 */

import { readLiveLogsPatient } from "../../lib/live-log.mjs";
import { presenceModes } from "../../lib/presence.mjs";
import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { createHash } from "node:crypto";
import { after } from "node:test";
import { relative } from "node:path";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { publish, readFixture } from "../../lib/seed.mjs";
import { readDraftObject, draftStoragePrefix, closeAdmin, listObjects, readDoc, readObject, watchRtdb } from "../../lib/admin.mjs";
import { grepLog, logFile, logMark } from "../../lib/logs.mjs";
import { DATABASE_LOG, drainDatabaseLog } from "../../lib/debuglogs.mjs";
import { rtdbRulesStatus } from "../../lib/rtdb.mjs";
import { eventually } from "../../lib/assert.mjs";
import { scanTokens, tokenLog } from "../../lib/tokens.mjs";
import { idSelector } from "../../lib/frame.mjs";
import { measure } from "../../lib/evidence.mjs";
import { ACCEPT, DEFAULT_PROTOCOL, parseMcpBody, toolOutcome } from "../../lib/mcp.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { requireConclusive, syncHttp } from "../../lib/sync.mjs";
import { rtdbLatency } from "../../lib/proxy.mjs";
import { staticWarmUrl } from "../../lib/workers.mjs";
import { assertInvariant, checkI2, checkI3, readI3, readSegments, readVersions, segmentsOfHtml } from "../../lib/invariants.mjs";
import { grantEditors, inputClocks, joinShared, rssFile, rtdbGetPatient, settleLive, startRssSampler } from "../../lib/live.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const FIXTURE = "crdt-paragraphs.html";
const BOTH = ["local", "prod"];
const LOCAL = ["local"];
const LIVE = { inconclusiveOnStackTimeout: true, inconclusiveOnPageStall: true };
const CASE_MS = 900_000;
/** A request of the case's own, past Hosting's 60 s cut-off so a stalled one ends in its 504. */
const HTTP_MS = 150_000;
/** Milliseconds between keystrokes: a fast typist. */
const KEY_DELAY_MS = 25;
/** An update drops the log before it answers; read it back within this. */
const LOG_EMPTY_MS = 2_000;
/** Presence follows a Done or a leave within this. */
const PRESENCE_MS = 15_000;
/** How long a gate may wait for its callers. */
const HELD_MS = 40_000;
/** A held update must be let go this long after it was sent, well inside Hosting's 60 s cut-off. */
const HOLD_BUDGET_MS = 42_000;
/** C12c race: how many editors open the editor inside the held update's window (they must all enter and save within it). */
const RACE_EDITORS_MAX = 4;
/** C12a: how long the editors may type while the updates are in flight (they stop one token after both are answered). */
const RACE_TYPING_MS = 120_000;
/** C12d co-editor: how long p2 goes on typing after "Published v2.", so its keys land after the commit too. */
const CO_TYPING_AFTER_MS = 3_000;
/** C12a: how long the functions' probe lines may take to reach the stack's emulators.log. */
const PROBE_WAIT_MS = 5_000;
/** The probe amplify-c12-update adds to liveEditing (functions/src/lib/presence.ts). */
const PROBE_TAG = "[e2e-c12-probe]";
/** The plan's server settle: the state stable for 10 s. */
const SERVER_STABLE_MS = 10_000;
const SERVER_DEADLINE_MS = 120_000;
const GB = 1024 ** 3;

/** The agent's version: the fixture's heading renamed, and a paragraph holding a marker. */
const V1_HEADING = "E2E sentinel heading";
const AGENT_HEADING = "E2E agent heading";
const AGENT_ID = "c12-agent";

/** functions/src/lib/presence.ts editorsRefusal: the refusal of a write made outside the editor. */
const editingRefusal = (editors, doing) =>
  `${editors === 1 ? "Somebody has" : `${editors} people have`} this document open in the editor, where this would be lost, so it was not ${doing}. Try again once they have left it, or ask them to do it there.`;
/** commitNewVersion's STALE, and update_document's own base check (functions/src/lib/publish.ts, functions/src/mcp/tools.ts). */
const STALE_RE = /Somebody published a newer version while this one was uploading|the document is at v\d+ now, not v\d+/;
/** editorsRefusal's words, whatever the count. */
const EDITORS_RE = /open in the editor, where this would be lost/;
/** POST /draft's stale answer (functions/src/index.ts saveDraft). */
const DRAFT_STALE = "This document has a newer version. Reload before editing.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const paragraph = (i) => `e2e-${i + 1}`;
const isAssertion = (err) => err instanceof AssertionError || err?.code === "ERR_ASSERTION";
/** A promise that never rejects: {ok, value} or {ok: false, error}. */
const settled = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
const marker = (what) => `C12${what}${runTag(target.runId)}${rand4()}`.replace(/[^A-Za-z0-9]/g, "");

// --- oracles collected, so one failing never hides another ---------------------------------

/** Collect oracle results: `check(fn)` keeps an AssertionError and throws anything else at once. */
function oracleSet() {
  const failed = [];
  return {
    failed,
    async check(fn) {
      try {
        await fn();
      } catch (err) {
        if (!isAssertion(err)) throw err;
        failed.push(err.message);
      }
    },
  };
}

/** Several oracle sets judged as one. */
const merged = (...sets) => ({ failed: sets.flatMap((s) => s.failed) });

/**
 * The case's outcome from `others` (every oracle that is not the case's
 * defect's) and `own` (the defect's). Without a defect both are one
 * AssertionError; with one, a failure in `others` is a plain error (a FAIL)
 * and only `own` can be the TODO.
 */
function verdict({ defect = null, others, own = null }) {
  const ownMsgs = own?.failed ?? [];
  if (!defect) {
    const all = [...others.failed, ...ownMsgs];
    if (all.length) throw new AssertionError({ message: all.join(" | "), actual: all, expected: [], operator: "oracles" });
    return;
  }
  if (others.failed.length) {
    const err = new Error(`not ${defect}'s oracle: ${others.failed.join(" | ")}${ownMsgs.length ? ` (and ${defect}'s own: ${ownMsgs.join(" | ")})` : ""}`);
    err.code = "E2E_C12_OTHER_ORACLE";
    throw err;
  }
  if (ownMsgs.length) throw new AssertionError({ message: ownMsgs.join(" | "), actual: ownMsgs, expected: [], operator: defect });
}

// --- memory -------------------------------------------------------------------------------

/** Sample the stack's and the browsers' memory around a case; the peak goes to the diagnostics. */
async function withRss(ctx, body) {
  const sampler = startRssSampler(ctx.target, { everyMs: 3_000, file: rssFile() });
  try {
    return await body();
  } finally {
    const rss = await sampler.stop();
    const p = rss.peak;
    ctx.ev.json("rss", rss);
    ctx.t.diagnostic(`RSS N=${ctx.n}: peak ${(p.totalBytes / GB).toFixed(2)} GB = stack ${(p.stackBytes / GB).toFixed(2)} GB + browsers ${(p.browserBytes / GB).toFixed(2)} GB (${rss.samples.length} samples)`);
  }
}

// --- the Database emulator failing its namespace (README Known harness facts) ------------------

/** The Database emulator's own words when it fails a namespace, and when the namespace is back (logs/database-debug.log). */
const NAMESPACE_FAILURE_RE = /Namespace failure for |status Active to Shutdown/;
const NAMESPACE_BACK_RE = /status Shutdown to Active/;
/** A failure window is widened by this much each way: the log's times are the emulator's records', a case's are this process's. */
const EMULATOR_MARGIN_MS = 1_000;

const firstLine = (err) => String(err?.message ?? err).split("\n")[0];

/** Bring logs/database-debug.log up to date (debuglogs.mjs drainDatabaseLog; a drain the watchdog is in the middle of is tried again). */
async function drainDbLog() {
  let r = null;
  for (let i = 0; i < 30; i += 1) {
    r = drainDatabaseLog(target.stack);
    if (!r?.busy) return r;
    await sleep(100);
  }
  return r;
}

/**
 * The namespace failures among `lines` (the emulator's own, in its log's
 * order), as windows {from, to, lines} in ms: from the failure to the
 * namespace's return, each widened by EMULATOR_MARGIN_MS. A return with no
 * failure before it is a failure that began before the lines did (from
 * -Infinity); a failure with no return has not come back yet (to Infinity).
 */
function failureWindows(lines) {
  const at = (l) => Date.parse(/^\[([^\]]+)\]/.exec(l)?.[1] ?? "");
  const wins = [];
  let open = null;
  for (const line of lines) {
    const t = at(line);
    if (NAMESPACE_FAILURE_RE.test(line)) {
      if (!open) {
        open = { from: (Number.isFinite(t) ? t : -Infinity) - EMULATOR_MARGIN_MS, to: Infinity, lines: [] };
        wins.push(open);
      }
      open.lines.push(line.slice(0, 240));
    } else if (NAMESPACE_BACK_RE.test(line)) {
      if (!open) {
        open = { from: -Infinity, to: Infinity, lines: [] };
        wins.push(open);
      }
      open.to = (Number.isFinite(t) ? t : Infinity) + EMULATOR_MARGIN_MS;
      open.lines.push(line.slice(0, 240));
      open = null;
    }
  }
  return wins;
}

/**
 * LIB-REQUEST: c12-namespace-guard. c04-first-join carries its own copy of
 * the window reading (emulatorWatch, failureWindows); one lib helper over
 * debuglogs.mjs drainDatabaseLog would serve both.
 *
 * Run a case and judge it only if the Database emulator held its namespace
 * throughout. The emulator (v4.11.2) can fail its whole namespace under
 * concurrent rule-checked writes (an NPE in its rules evaluation): for 30 s
 * every read and write waits or fails and every client is reset (README Known
 * harness facts: "A case that crosses such a window measured the emulator,
 * not the product"). Every C12 case reads presence, the live log or both
 * through it, the updates' editors question among them
 * (functions/src/lib/presence.ts liveEditing waits on a namespace in
 * Shutdown), so a case whose span crossed a failure ends INCONCLUSIVE
 * whatever it would have said, the emulator's lines recorded. Seen at N=5 on
 * 0.16.0 (run 2610131651-km4o, C12a: the namespace failed 0.6 s after both
 * updates were refused, and settleLive's reads of the log then answered 503).
 * Where the stack keeps no Database log (production) the case runs as it is.
 */
async function guarded(ctx, body) {
  const file = ctx.target.kind === "local" && ctx.target.stack?.logs?.database ? logFile(ctx.target.runId, DATABASE_LOG) : null;
  if (!file) return withRss(ctx, body);
  try {
    await drainDbLog();
  } catch (err) {
    // The watchdog drains every 15 s anyway: the mark below is then that late.
    ctx.step(`draining the Database emulator's log failed (${firstLine(err)}): it is marked as the watchdog last left it`);
  }
  const since = logMark(file);
  const startedAt = Date.now();
  let outcome;
  let error = null;
  try {
    outcome = await withRss(ctx, body);
  } catch (err) {
    error = err;
  }
  const endedAt = Date.now();
  let lines;
  try {
    await drainDbLog();
    const re = new RegExp(`${NAMESPACE_FAILURE_RE.source}|${NAMESPACE_BACK_RE.source}`);
    // A log past its cap moves to <name>.1 (debuglogs.mjs): then the window is the rest of that one and all of the new.
    lines = logMark(file) >= since ? grepLog(re, { file, since }) : [...grepLog(re, { file: `${file}.1`, since }), ...grepLog(re, { file, since: 0 })];
  } catch (err) {
    if (error) throw error;
    throw new Error(`C12: the Database emulator's log could not be read after the case (${firstLine(err)})`);
  }
  const crossed = failureWindows(lines).filter((w) => w.from <= endedAt && w.to >= startedAt);
  if (crossed.length) {
    const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms));
    ctx.ev.json("database-namespace-failure", { case: { from: iso(startedAt), to: iso(endedAt) }, windows: crossed.map((w) => ({ from: iso(w.from), to: iso(w.to), lines: w.lines })), wouldHaveSaid: error ? firstLine(error) : "pass" });
    ctx.inconclusive(`the stack did not hold: the Database emulator failed its namespace inside this case (${crossed.map((w) => `${iso(w.from)} to ${iso(w.to)}`).join("; ")}, widened by ${EMULATOR_MARGIN_MS / 1000} s; "${crossed[0].lines[0]}"), so the case measured the emulator, not the product (README Known harness facts); it would have said: ${error ? firstLine(error).slice(0, 300) : "pass"}`);
  }
  if (error) throw error;
  return outcome;
}

// --- contents -----------------------------------------------------------------------------

/** The agent's whole new document: the fixture with the heading renamed and #c12-agent holding `mark`. */
function agentContent(mark) {
  const html = readFixture(FIXTURE, { raw: true }).toString("utf8");
  precondition(html.includes(`>${V1_HEADING}<`) && html.includes("</body>"), "the fixture has its sentinel heading and a </body>");
  return html.replace(`>${V1_HEADING}<`, `>${AGENT_HEADING}<`).replace("</body>", `<p id="${AGENT_ID}">${mark}</p>\n</body>`);
}

/** A curl editor's draft: the fixture with `mark` in its first paragraph. */
function curlDraft(mark) {
  const html = readFixture(FIXTURE, { raw: true }).toString("utf8");
  precondition(html.includes("Paragraph 1."), "the fixture has its first paragraph");
  return html.replace("Paragraph 1.", `Paragraph 1. ${mark}`);
}

// --- the agent ------------------------------------------------------------------------------

/** The owner's agent: a personal token (channel mcp) minted with the owner's session, and an initialized MCP client. */
async function agentFor(ctx, session, tag) {
  const { token } = await mintToken(session, { name: `e2e ${tag} agent`, channel: "mcp" });
  const mcp = ctx.mcp({ token, actor: "agent", timeoutMs: HTTP_MS, cutoffError: true });
  await mcp.initialize();
  return { token, mcp };
}

/** An update_document outcome's kind: success | deduped | stale | editors | other. */
function kindOf(out) {
  if (!out) return "other";
  if (!out.isError) return out.json?.deduped === true ? "deduped" : out.json?.versionId ? "success" : "other";
  if (STALE_RE.test(out.text)) return "stale";
  if (EDITORS_RE.test(out.text)) return "editors";
  return "other";
}

/** The agent's update_document → {kind, isError, text, json}. Hosting's cut-off throws (cutoffError), and the case's options judge it. */
async function agentUpdate(agent, docId, content, baseVersion) {
  const out = await agent.mcp.call("update_document", { id: docId, content, baseVersion });
  return { kind: kindOf(out), isError: out.isError, text: out.text ?? "", json: out.json ?? null };
}

/** The update published a new version (not deduplicated): its versionId, else a plain error naming what came back. */
function publishedVersion(out, what) {
  if (out.kind !== "success") {
    const err = new Error(`${what}: the agent's update_document did not publish (${out.kind}: ${out.isError ? out.text.slice(0, 300) : JSON.stringify(out.json)})`);
    err.code = "E2E_C12_UPDATE";
    throw err;
  }
  return out.json.versionId;
}

// --- SYNC-T requests ------------------------------------------------------------------------
// Raw requests for syncHttp, which (given the target) checks each and its
// warm-up against the isolation tripwire and the production guard before any
// worker exists, adds the agent headers and traces every hop into the case's
// http.jsonl under its `actor`. Each racer's socket is warmed on a static file
// (workers.mjs staticWarmUrl): a warm-up on GET /config, a function, would
// start one more Functions-emulator worker per racer.

/** One tools/call as a raw request for syncHttp. */
function toolRequest(token, name, args, id, actor = "agent") {
  return {
    url: `${target.origin}/mcp`,
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: ACCEPT, "content-type": "application/json", "mcp-protocol-version": DEFAULT_PROTOCOL },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    warm: staticWarmUrl(target),
    actor,
  };
}

/** A curl editor's POST /draft with its personal token, as a raw request for syncHttp. */
function draftRequest(token, docId, baseVersion, html, actor) {
  return {
    url: `${target.origin}/draft`,
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ docId, baseVersion, html }),
    warm: staticWarmUrl(target),
    actor,
  };
}

/** The app's "Upload a new version…": POST /publish?update= with the session cookie, as a raw request for syncHttp. */
function uploadRequest(cookie, docId, baseVersion, html, actor = "owner-upload") {
  const q = new URLSearchParams({ filename: "index.html", update: docId, baseVersion });
  return {
    url: `${target.origin}/publish?${q}`,
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream" },
    body: html,
    warm: staticWarmUrl(target),
    actor,
  };
}

/** A tools/call row of syncHttp → {kind, isError, text, json, status}. */
function toolRow(r, id) {
  if (r.error) return { kind: "other", isError: true, text: `request failed: ${r.error}`, json: null, status: null };
  try {
    const messages = parseMcpBody(r.headers?.["content-type"], r.body);
    const msg = messages.find((m) => m.id === id) ?? messages[0];
    const out = msg?.result ? toolOutcome(msg.result) : null;
    if (!out) return { kind: "other", isError: true, text: `no tool result: ${r.status} ${String(r.body).slice(0, 200)}`, json: null, status: r.status };
    return { kind: kindOf(out), isError: out.isError, text: out.text ?? "", json: out.json ?? null, status: r.status };
  } catch (err) {
    return { kind: "other", isError: true, text: `unparsable answer ${r.status}: ${err.message}`, json: null, status: r.status };
  }
}

/** A plain JSON row of syncHttp → {status, json}. */
function jsonRow(r) {
  if (r.error) return { status: null, json: null, error: r.error };
  let json = null;
  try {
    json = JSON.parse(r.body);
  } catch {}
  return { status: r.status, json };
}

/** Fire `requests` at one instant (SYNC-T), INCONCLUSIVE unless the spread and the overlap proof hold, or when Hosting cut one off. */
async function fireTogether(ctx, requests, label) {
  const run = await syncHttp(requests, { target: ctx.target, timeoutMs: HTTP_MS });
  const wire = run.results.map((r) => ({ i: r.i, status: r.status ?? null, firedAt: r.firedAt, sentAt: r.sentAt, firstByteAt: r.firstByteAt, endAt: r.endAt, error: r.error ?? null }));
  ctx.ev.json(`fire-${label}`, { spreadMs: run.spreadMs, limit: run.limit, overlap: run.overlap, wire });
  ctx.step(`${label}: ${requests.length} request(s) fired within ${Number(run.spreadMs).toFixed(1)} ms (overlap ${run.overlap.ok ? `proved, margin ${Number(run.overlap.marginMs).toFixed(0)} ms` : run.overlap.reason})`);
  const cut = run.results.filter((r) => r.status === 504);
  if (cut.length) ctx.inconclusive(`the stack did not answer, so nothing was measured: Hosting answered 504 to ${cut.length} of the fired requests`);
  requireConclusive(ctx, { spread: run, overlap: run.overlap });
  return run;
}

// --- the server's state -----------------------------------------------------------------------

/** status/{d}/y read as the emulator's admin, read again through the Database's 503 for 5 s (past that, the stack did not answer: INCONCLUSIVE). */
const readLog = (docId) => readLiveLogsPatient(target, docId);

const entriesOf = (y) => (y && typeof y === "object" ? Object.keys(y).length : 0);

/** How many entries status/{d}/y holds, read until it is empty or `timeoutMs` passes. */
async function logEntriesAfter(docId, timeoutMs = LOG_EMPTY_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = entriesOf(await readLog(docId));
    if (n === 0 || Date.now() >= deadline) return n;
    await sleep(200);
  }
}

// Keep concrete snapshot paths after the metadata selecting them is removed.
// Reading only the current pointer would turn a failed cleanup into an empty,
// vacuously passing inventory.
const retiredDraftPrefixes = new Map();
function rememberDraft(docId, draft) {
  if (!draft) return;
  let prefixes = retiredDraftPrefixes.get(docId);
  if (!prefixes) retiredDraftPrefixes.set(docId, prefixes = new Set());
  prefixes.add(draftStoragePrefix(docId, draft));
}
async function draftObjects(docId, draft, versions) {
  rememberDraft(docId, draft);
  const prefixes = retiredDraftPrefixes.get(docId) ?? new Set();
  const lists = await Promise.all([...prefixes].map((prefix) => listObjects(target, `${prefix}/`)));
  const referenced = versions.map((version) => `${version.storagePrefix ?? `docs/${docId}/${version.id}`}/`);
  const bundles = await listObjects(target, `docs/${docId}/bundles/`);
  // A rejected save may have allocated its immutable snapshot without ever
  // returning metadata. Inventory those unreferenced objects as well.
  const unreferenced = bundles.filter((name) => !referenced.some((prefix) => name.startsWith(prefix)));
  return [...new Set([...lists.flat(), ...unreferenced])].sort();
}
async function versionPrefix(docId, versionId) {
  const meta = await readDoc(target, `docs/${docId}/versions/${versionId}`);
  return meta ? (meta.storagePrefix ?? `docs/${docId}/${versionId}`) : null;
}

/** What an update leaves behind: the pointer, the draft record, the version records, the draft's objects, the log's size. */
async function serverState(docId) {
  const d = await readDoc(target, `docs/${docId}`);
  const versions = await readVersions(target, docId);
  return {
    currentVersion: d?.currentVersion ?? null,
    draft: d?.draft ? { baseVersion: d.draft.baseVersion ?? null, entry: d.draft.entry ?? null } : null,
    versions: versions.map((v) => `${v.id}<${v.parentVersion ?? "-"}:${v.publishedVia}`),
    draftObjects: await draftObjects(docId, d?.draft, versions),
    yEntries: entriesOf(await readLog(docId)),
  };
}

/** The plan's server settle: serverState unchanged for SERVER_STABLE_MS. One that never holds still is a plain error. */
async function settleServer(ctx, docId, what) {
  const t0 = Date.now();
  let last = null;
  let since = t0;
  for (;;) {
    const snap = JSON.stringify(await serverState(docId));
    const now = Date.now();
    if (snap !== last) {
      last = snap;
      since = now;
    } else if (now - since >= SERVER_STABLE_MS) {
      ctx.step(`${what}: the server's state of ${docId} held still for ${SERVER_STABLE_MS / 1000} s: ${snap}`);
      ctx.ev.json(`server-${what.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, JSON.parse(snap));
      return JSON.parse(snap);
    }
    if (now - t0 > SERVER_DEADLINE_MS) {
      const err = new Error(`${what}: the server's state of ${docId} did not hold still for ${SERVER_STABLE_MS} ms within ${SERVER_DEADLINE_MS} ms: ${snap}`);
      err.code = "E2E_C12_UNSETTLED";
      throw err;
    }
    await sleep(1_000);
  }
}

/** v1's entry name. */
async function v1Entry(docId) {
  const v1 = await readDoc(target, `docs/${docId}/versions/v1`);
  precondition(typeof v1?.entry === "string", `v1 of ${docId} has an entry (${JSON.stringify(v1?.entry)})`);
  return v1.entry;
}

/** An editor's GET /draft/{d}/{entry}: {status, sha, text}. */
async function draftServed(http, docId, entry) {
  const r = await http.get(`/draft/${encodeURIComponent(docId)}/${entry}`, { timeoutMs: HTTP_MS });
  const buf = r.buffer ?? Buffer.from(r.text ?? "", "utf8");
  return { status: r.status, sha: sha(buf), text: buf.toString("utf8") };
}

// --- what a refused update must leave as it was (C12a) ---------------------------------------

const millis = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : ts ?? null);

/**
 * What a refused update must leave exactly as it was, read at once and in
 * parallel: docs/{d}.draft (base, entry, bytes, updatedAt) and every object
 * under docs/{d}/draft/ with its generation, metageneration, md5 and size
 * (listObjects {meta: true}: a rewrite of the same bytes and a
 * delete-then-rewrite each move the generation, which a name list cannot
 * see; SPEC §6a "a refused or deduplicated update leaves both alone"), with
 * the pointer, the version records and docs/{d}/v2/ ("nothing minted").
 * `from`/`to` bound the reads.
 */
async function footprint(docId) {
  const from = Date.now();
  const [d, versions, v2Prefix] = await Promise.all([
    readDoc(target, `docs/${docId}`),
    readVersions(target, docId),
    versionPrefix(docId, "v2"),
  ]);
  rememberDraft(docId, d?.draft);
  const [objects, v2] = await Promise.all([
    d?.draft ? listObjects(target, `${draftStoragePrefix(docId, d.draft)}/`, { meta: true }) : [],
    v2Prefix ? listObjects(target, `${v2Prefix}/`) : [],
  ]);
  return {
    from,
    to: Date.now(),
    currentVersion: d?.currentVersion ?? null,
    versions: versions.map((v) => `${v.id}<${v.parentVersion ?? "-"}:${v.publishedVia}`),
    v2Objects: v2.length,
    draft: d?.draft ? { storagePrefix: draftStoragePrefix(docId, d.draft), baseVersion: d.draft.baseVersion ?? null, entry: d.draft.entry ?? null, bytes: d.draft.bytes ?? null, updatedAt: millis(d.draft.updatedAt) } : null,
    objects,
  };
}

/**
 * Every POST /draft of these captures that could have written between
 * `from` and `to`: sent before `to` and not finished before `from` (or not
 * finished at all). Such an autosave rewrites the draft's record and objects
 * by itself, so a comparison across the window would prove nothing.
 */
function autosavesBetween(captures, users, from, to) {
  const out = [];
  captures.forEach((rows, i) => {
    for (const r of rows) {
      const done = r.doneAt == null ? null : performance.timeOrigin + r.doneAt;
      if (r.t <= to && (done === null || done >= from)) out.push({ name: users[i].name, sentAt: r.t, doneAt: done === null ? null : Math.round(done), status: r.status ?? null });
    }
  });
  return out;
}

/**
 * The C12a "left alone" oracle (SPEC §6a): between the read just before the
 * updates were fired and the read just after both were answered, the draft's
 * record and every object under docs/{d}/draft/ (name, generation,
 * metageneration, md5, size) are unchanged, unless an autosave wrote inside
 * that window (`confound`: then that half is not judged, and the case cannot
 * pass on it); and the live log (watchRtdb's rows) never took a value with no
 * entries from the first value on.
 */
function judgeLeftAlone({ pre, post, yLog, confound }) {
  const f = [];
  if (yLog?.error) {
    const err = new Error(`C12a: the Admin SDK's watch of the live log failed: ${yLog.error}`);
    err.code = "E2E_C12_WATCH";
    throw err;
  }
  const emptied = (yLog?.rows ?? []).filter((r) => r.n === 0);
  if (emptied.length) f.push(`status/{d}/y was emptied ${emptied.length} time(s) (first ${emptied[0].t - pre.from} ms after the read before the send; the watch saw ${yLog.rows.length} value(s))`);
  if (!confound.length) {
    if (JSON.stringify(pre.draft) !== JSON.stringify(post.draft)) f.push(`docs/{d}.draft changed across the answers: ${JSON.stringify(pre.draft)} → ${JSON.stringify(post.draft)}`);
    const before = new Map(pre.objects.map((o) => [o.name, o]));
    const after = new Map(post.objects.map((o) => [o.name, o]));
    const gone = pre.objects.filter((o) => !after.has(o.name)).map((o) => o.name);
    const added = post.objects.filter((o) => !before.has(o.name)).map((o) => o.name);
    // listObjects {meta: true} rows: a save moves the generation, a metadata-only update the metageneration.
    const moved = (a, b) => ["generation", "metageneration", "md5", "size"].filter((k) => a[k] !== b[k]);
    const rewritten = post.objects
      .filter((o) => before.has(o.name) && moved(before.get(o.name), o).length)
      .map((o) => `${o.name} (${moved(before.get(o.name), o).map((k) => `${k} ${before.get(o.name)[k]} → ${o[k]}`).join(", ")})`);
    if (gone.length) f.push(`${gone.length} object(s) under docs/{d}/draft/ deleted (${gone.slice(0, 3).join(", ")})`);
    if (added.length) f.push(`${added.length} object(s) under docs/{d}/draft/ added (${added.slice(0, 3).join(", ")})`);
    if (rewritten.length) f.push(`${rewritten.length} object(s) under docs/{d}/draft/ rewritten (${rewritten.slice(0, 3).join(", ")})`);
  }
  assert.ok(f.length === 0, `C12a left alone: a refused update leaves the draft and its live log as they were (SPEC §6a "a refused or deduplicated update leaves both alone") — ${f.join("; ")}`);
}

/** "Nothing minted" on a footprint: the pointer still on v1, one version record, nothing under docs/{d}/v2/. */
function judgeNothingMinted(state, label) {
  assert.ok(state.currentVersion === "v1" && state.versions.length === 1 && state.v2Objects === 0, `${label}: a refused update mints and uploads nothing — current ${state.currentVersion}, versions ${JSON.stringify(state.versions)}, ${state.v2Objects} object(s) under docs/{d}/v2/`);
}

// --- what the functions' editors question read (amplify-c12-update's probe) -------------------

/** Whether this stack's functions log their editors question (amplify-c12-update's 30-editors-question-probe.patch). */
const probing = (ctx) => ctx.target.kind === "local" && Boolean(ctx.target.capabilities?.has?.("patch:amplify-c12-update"));

function parseProbe(line) {
  const at = line.indexOf(PROBE_TAG);
  const open = line.indexOf("{", at);
  const close = line.lastIndexOf("}");
  if (at < 0 || open < 0 || close < open) return null;
  try {
    return JSON.parse(line.slice(open, close + 1));
  } catch {
    return null;
  }
}

/** The probe's lines for `docId` written since `since` (a logMark), parsed; waits up to PROBE_WAIT_MS for `want` of them. */
async function probeRows(docId, since, want) {
  const deadline = Date.now() + PROBE_WAIT_MS;
  for (;;) {
    const rows = grepLog(PROBE_TAG, { target, since }).map(parseProbe).filter((r) => r?.docId === docId);
    if (rows.length >= want || Date.now() >= deadline) return rows;
    await sleep(250);
  }
}

// --- the realtime rules (S31) -----------------------------------------------------------------

/**
 * Whether the app's realtime namespace enforces the tree's database.rules.json,
 * live (rtdb.mjs rtdbRulesStatus), as a09's A9.8 reads it: without them the
 * in-app commit's whole-log remove is allowed and S8 cannot be seen (S31).
 * Production runs the deployed rules, which nothing here can read back.
 */
async function realtimeRules(ctx) {
  if (ctx.target.kind !== "local") return { ok: true, reason: null, note: "production: the deployed rules" };
  const s = await rtdbRulesStatus(ctx.target, { http: ctx.http({ actor: "rtdb-rules" }) });
  return { ok: s.ok, reason: s.reason, note: `ns=${s.namespace} ${s.ok ? "enforces" : "does not enforce"} ${s.file} (${s.bytes} bytes)` };
}

// --- presence -------------------------------------------------------------------------------

/** status/{d}/peers as {uid: mode}; `retryMs` as rtdbGetPatient's (0: a 503 throws at once). */
async function peerModes(docId, { retryMs } = {}) {
  const peers = (await rtdbGetPatient(target, `status/${docId}/peers`, retryMs === undefined ? {} : { retryMs })) ?? {};
  return presenceModes(peers);
}

const editorsIn = (modes) => Object.entries(modes).filter(([, m]) => m === "edit").map(([uid]) => uid);

/** Wait until `pred(modes)` holds; resolves {ok, modes} (the last read when it never held). */
async function waitModes(docId, pred, timeoutMs = PRESENCE_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const modes = await peerModes(docId);
    if (pred(modes)) return { ok: true, modes };
    if (Date.now() >= deadline) return { ok: false, modes };
    await sleep(150);
  }
}

/**
 * Read status/{d}/peers every 200 ms until `stop()`: what the server's
 * editors question could have read while the updates were in flight. A 503
 * is a failed read, counted, not waited through, so the series keeps its
 * pace. On a stack built with --rtdb-proxy each read also takes the proxy's
 * counters (`open` browser connections to the Database and `connections`
 * ever made), so a page's dropped and remade socket shows at its time.
 * Resolves {reads: [{t, ms, editors, open?, connections?}], errors, proxy} on stop.
 */
function pollPresence(docId, proxy = null) {
  const reads = [];
  let errors = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      const t = Date.now();
      try {
        const modes = await peerModes(docId, { retryMs: 0 });
        const row = { t, ms: Date.now() - t, editors: editorsIn(modes).length };
        if (proxy) {
          try {
            const { stats } = await proxy.stats();
            row.open = stats.open;
            row.connections = stats.connections;
          } catch {
            row.open = null;
          }
        }
        reads.push(row);
      } catch {
        errors += 1;
      }
      await sleep(200);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { reads, errors, proxy: Boolean(proxy) };
    },
  };
}

/** Nobody in the editor, or INCONCLUSIVE. */
async function nobodyEditing(ctx, docId, after) {
  const r = await waitModes(docId, (m) => editorsIn(m).length === 0);
  if (!r.ok) ctx.inconclusive(`the sync precondition did not hold: status/${docId}/peers still shows an editor ${PRESENCE_MS / 1000} s after ${after} (${JSON.stringify(r.modes)})`);
}

// --- the live session -----------------------------------------------------------------------

/** The plan's settle conditions (settleLive: a missed deadline is an I1 FAILURE; it reads y through the Database's 503 itself). */
function settle(users, docId) {
  return settleLive(users, { docId, n: users.length });
}

/** settle(), with a missed deadline as a precondition: the session settling is setup, not the oracle. */
async function settleFirst(users, docId) {
  try {
    return await settle(users, docId);
  } catch (err) {
    precondition(false, `the live session settles before the step under test: ${err?.message ?? err}`);
  }
}

/** Every user types one token at the end of its own paragraph, at the same time. */
async function typeOneEach(users, log) {
  await Promise.all(users.map((u, i) => u.typeInFrame(idSelector(paragraph(i)), log.next(u.name, paragraph(i)), { delay: KEY_DELAY_MS, at: "end" })));
}

/** In the page: leave the document inside the app (the router's own navigation; presence's leave() runs). */
function leaveInApp() {
  history.pushState({}, "", "/");
  dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  return location.pathname;
}

async function leaveOne(u) {
  await u.page.evaluate(leaveInApp);
  await u.page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  u.inEdit = false;
}

/** In the frame: what a person sees of the document. */
function readView() {
  const heading = document.getElementById("e2e-sentinel");
  const agent = document.getElementById("c12-agent");
  return {
    heading: heading ? heading.textContent : null,
    agent: agent ? agent.textContent : null,
    sentinels: document.querySelectorAll('[id="e2e-sentinel"]').length,
    agents: document.querySelectorAll('[id="c12-agent"]').length,
    text: document.body ? document.body.textContent : "",
  };
}

/** Enter the editor until "Shared"; one that never shows it is a failed sync precondition (INCONCLUSIVE). */
async function enterShared(ctx, u, timeout = 90_000) {
  try {
    return await u.enterEdit({ waitShared: true, timeout });
  } catch (err) {
    const state = await u.shareState().catch(() => "unknown");
    if (state !== "shared") ctx.inconclusive(`the sync precondition did not hold: ${u.name} never showed "Shared" in the editor (share state ${JSON.stringify(state)}): ${String(err?.message ?? err).slice(0, 200)}`);
    throw err;
  }
}

let views = 0;

/**
 * The next editor: open the document (unless `open: false`), enter the
 * editor until "Shared" (else INCONCLUSIVE), and read what the frame shows
 * once two reads 750 ms apart agree (at most 15 s). Resolves the view, with
 * the tokens it shows and its I3 shape (readI3: the editor's own overlay
 * left out).
 */
async function editorView(ctx, u, docId, { open = true } = {}) {
  if (open) await u.open(docId, { timeout: 90_000 });
  await enterShared(ctx, u);
  let prev = null;
  let view = null;
  const deadline = Date.now() + 15_000;
  for (;;) {
    view = await (await u.frame()).evaluate(readView);
    if (prev && JSON.stringify(prev) === JSON.stringify(view)) break;
    if (Date.now() >= deadline) break;
    prev = view;
    await sleep(750);
  }
  const tokens = scanTokens(view.text).tokens.map((t) => t.token);
  const i3 = await readI3(await u.frame());
  views += 1;
  ctx.ev.json(`view-${views}-${u.name}`, { ...view, tokens, i3, text: undefined });
  return { ...view, tokens, i3 };
}

/** Leave the editor with Done, and wait until presence no longer says "edit" for anybody. */
async function doneAndWait(ctx, docId, users) {
  for (const u of users) await u.done({ timeout: 60_000 });
  await nobodyEditing(ctx, docId, `${users.map((u) => u.name).join(", ")} pressed Done`);
}

// --- judges ---------------------------------------------------------------------------------

/**
 * The next editor sees the agent's version: its heading, #c12-agent with
 * its marker, the sentinel once, none of `forbidden` (markers of what the
 * update replaced) and, with `noTokens`, no token typed before it.
 */
function judgeAgentView(view, { label, mark, forbidden = [], noTokens = false, who }) {
  const f = [];
  if (view.heading !== AGENT_HEADING) f.push(`its heading reads ${JSON.stringify(view.heading)}, not the agent's ${JSON.stringify(AGENT_HEADING)}`);
  if (view.agent !== mark) f.push(`#${AGENT_ID} holds ${JSON.stringify(view.agent)}, not the agent's marker`);
  if (view.sentinels !== 1) f.push(`the sentinel heading appears ${view.sentinels} time(s)`);
  if (view.agents > 1) f.push(`#${AGENT_ID} appears ${view.agents} times`);
  const seen = forbidden.filter((m) => view.text.includes(m));
  if (seen.length) f.push(`it shows ${seen.length} marker(s) of what the update replaced (${seen.join(", ")})`);
  if (noTokens && view.tokens.length) f.push(`it shows ${view.tokens.length} token(s) typed before the update (${view.tokens.slice(0, 4).join(" ")}${view.tokens.length > 4 ? " …" : ""})`);
  assert.ok(f.length === 0, `${label} next editor: ${who} opens the editor after the update and sees the agent's version — ${f.join("; ")}`);
}

/** An editor's GET /draft serves `versionId`'s stored entry. */
async function judgeDraftServed({ label, http, docId, entry, versionId, forbidden = [] }) {
  const prefix = await versionPrefix(docId, versionId);
  const stored = prefix ? await readObject(target, `${prefix}/${entry}`) : null;
  const got = await draftServed(http, docId, entry);
  const whose = stored && got.sha === sha(stored) ? `${versionId}'s entry` : forbidden.find((m) => got.text.includes(m)) ? `a replaced draft (${forbidden.find((m) => got.text.includes(m))})` : got.text.includes(`>${V1_HEADING}<`) ? "v1's content" : "something else";
  assert.ok(got.status === 200 && stored && got.sha === sha(stored), `${label} GET /draft: an editor's GET /draft serves the agent's version (${versionId}'s stored entry) — it answered ${got.status} with ${whose}`);
}

/** Nothing of the replaced draft is left: no record (or one of the current version) and no object under docs/{d}/draft/. */
function judgeDraftDropped(state, { label, versionId }) {
  const f = [];
  if (state.draft && state.draft.baseVersion !== versionId) f.push(`docs/{d}.draft is still there, on ${state.draft.baseVersion}`);
  if (state.draftObjects.length) f.push(`${state.draftObjects.length} object(s) left under docs/{d}/draft/ (${state.draftObjects.slice(0, 3).join(", ")})`);
  assert.ok(f.length === 0, `${label} draft: the update drops the draft it replaced — ${f.join("; ")}`);
}

/** The live log is empty within 2 s of the update's answer. */
async function judgeLogDropped(docId, { label, what }) {
  const left = await logEntriesAfter(docId);
  assert.equal(left, 0, `${label} log: status/${docId}/y is empty within ${LOG_EMPTY_MS / 1000} s of ${what} (it still holds ${left} entries)`);
}

// =====================================================================================
// C12a — the agent's update while N editors are in the editor
// =====================================================================================

scenario("C12a agent update vs editors: while N editors type in the editor, the agent's update_document and the owner's /publish?update= fired at one instant are both refused 409 naming the N editors, nothing is minted, uploaded or dropped, and every editor's typing saves (200) and converges (I1, I2); once everyone has left the editor the update publishes, the live log and the draft are gone, GET /draft serves the new version, and the next editor sees the agent's version", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => guarded(ctx, async () => {
  const n = ctx.n;
  const { docId, users, owner } = await joinShared(ctx, { n, fixture: FIXTURE, title: `C12a N=${n}` });
  const entry = await v1Entry(docId);
  const agent = await agentFor(ctx, owner, "c12a");
  const log = tokenLog(target.runId);
  ctx.step("every editor types one token into its own paragraph; the session settles");
  await typeOneEach(users, log);
  await settleFirst(users, docId);
  const before = await serverState(docId);
  ctx.ev.json("before", before);
  precondition(before.draft?.baseVersion === "v1" && before.draftObjects.length > 0 && before.yEntries > 0, `the live session left a draft on v1 and a live log (${JSON.stringify(before)})`);
  const cookie = owner.http.jar.header(`${target.origin}/publish`);
  precondition(typeof cookie === "string" && cookie.includes("__session="), "the owner's session cookie is in its jar");
  const markA = marker("A");
  const markB = marker("B");

  ctx.step(`every editor types tokens without pause; once each has typed one and presence shows all ${n} in the editor, update_document (${markA}) and /publish?update= (${markB}) are fired at one instant, and everyone types until both are answered`);
  const clocks = await inputClocks(users);
  // Node-side token times: a frame the product reloads (as it does when a version is minted) is not a harness failure.
  const tokens = users.map(() => []);
  let answered = false;
  const typingDeadline = Date.now() + RACE_TYPING_MS;
  const typing = users.map(async (u, i) => {
    const id = paragraph(i);
    while (Date.now() < typingDeadline) {
      const wasAnswered = answered;
      const row = { start: Date.now(), end: null, error: null };
      tokens[i].push(row);
      try {
        await u.typeInFrame(idSelector(id), log.next(u.name, id), { delay: KEY_DELAY_MS, at: "end" });
      } catch (err) {
        row.error = String(err?.message ?? err).split("\n")[0].slice(0, 200);
        return;
      } finally {
        row.end = Date.now();
      }
      if (wasAnswered) return;
    }
  });
  const typingDone = Promise.allSettled(typing);
  // Evidence for X-c12-agent-vs-editors-2 (a mint under N open editors once, after ~30 s): presence over the window and, on a
  // --rtdb-proxy stack, the browsers' Database connections with it; the Database emulator's own log is kept by the stack's
  // teardown (it shows a restart, failure or warning in the window, never a single socket); and, on a stack with
  // amplify-c12-update, what the functions' own Database client read for each update's editors question (its probe).
  const proxy = ctx.target.kind === "local" && ctx.target.capabilities?.has?.("rtdb-proxy") ? rtdbLatency(ctx.target) : null;
  const probeSince = probing(ctx) ? logMark({ target }) : null;
  const presence = pollPresence(docId, proxy);
  // Every POST /draft from here on: an autosave inside the window would rewrite the record and objects by itself.
  const drafts = users.map((u) => u.capture({ paths: "/draft" }));
  let run;
  let modesAtFire;
  let seen;
  let watch = null;
  let yLog = null;
  let pre = null;
  let post = null;
  try {
    await eventually(() => tokens.every((t) => t.some((r) => r.end && !r.error)), { timeout: 60_000, interval: 50, message: "every editor typed a token" });
    modesAtFire = await peerModes(docId);
    if (editorsIn(modesAtFire).length !== n) ctx.inconclusive(`the sync precondition did not hold: presence showed ${editorsIn(modesAtFire).length} of ${n} editors in the editor as the updates were about to be fired (${JSON.stringify(modesAtFire)})`);
    // Every value status/{d}/y takes, through the Admin SDK's own listener: a removal of the whole node that the typing
    // editors refill within milliseconds arrives as a value with no entries, which a poll misses. Compaction appends before
    // it removes (app/src/crdt/log.ts compact), so a log in use never reads empty. No first value within 15 s is the stack
    // not answering (E2E_RTDB_WATCH, stackCut): INCONCLUSIVE under LIVE. The after() hook's closeAdmin ends its socket.
    watch = await watchRtdb(ctx.target, `status/${docId}/y`);
    // Autosave is a trailing 1 s debounce (app/src/viewer/useInlineEditor.ts AUTOSAVE_MS) and every editor types without
    // pause until the answers, so nothing should write the draft between these two reads but the updates themselves.
    pre = await footprint(docId);
    run = await fireTogether(ctx, [
      toolRequest(agent.token, "update_document", { id: docId, content: agentContent(markA), baseVersion: "v1" }, 1),
      uploadRequest(cookie, docId, "v1", agentContent(markB)),
    ], "C12a updates");
    post = await footprint(docId);
  } finally {
    answered = true;
    await typingDone;
    seen = await presence.stop();
    for (const c of drafts) c.stop();
    yLog = watch ? watch.stop() : null;
  }
  const race = await clocks.read();
  const winStart = Math.min(...run.results.map((r) => r.sentAt));
  const winEnd = Math.max(...run.results.map((r) => r.endAt));
  const dbLog = ctx.target.stack?.logs?.database ?? null;
  const proxied = seen.reads.filter((r) => Number.isInteger(r.connections));
  const reconnects = proxied.length ? proxied.at(-1).connections - proxied[0].connections : null;
  const databaseLog = { file: dbLog ? relative(process.cwd(), dbLog) : null, from: new Date(winStart).toISOString(), to: new Date(winEnd).toISOString() };
  const probed = probeSince === null ? null : await probeRows(docId, probeSince, 2);
  const typedAround = users.map((u, i) => ({
    name: u.name,
    tokens: tokens[i].length,
    before: tokens[i].some((r) => r.start < winStart && !r.error),
    after: tokens[i].some((r) => r.end > winEnd && !r.error),
    error: tokens[i].find((r) => r.error)?.error ?? null,
  }));
  const minEditors = seen.reads.length ? Math.min(...seen.reads.map((r) => r.editors)) : null;
  const confound = autosavesBetween(drafts, users, pre.from, post.to);
  const yMin = yLog.rows.length ? Math.min(...yLog.rows.map((r) => r.n)) : null;
  ctx.ev.json("race", { inputs: race, typedAround, presence: seen, modesAtFire, window: { winStart, winEnd, ms: Math.round(winEnd - winStart) }, reconnects, databaseLog, probe: probed, liveLog: { values: yLog.rows.length, min: yMin, rows: yLog.rows }, autosavesInWindow: confound });
  ctx.ev.json("footprint", { pre, post });
  ctx.step(`the updates were answered ${Math.round(winEnd - winStart)} ms after they were sent; typing: ${typedAround.map((t) => `${t.name} ${t.tokens} token(s)${t.before ? "" : " none before the send"}${t.after ? "" : " none after the answers"}${t.error ? ` (stopped: ${t.error})` : ""}`).join("; ")}; presence over the window: ${seen.reads.length} read(s), at least ${minEditors} editor(s) in the editor${seen.errors ? `, ${seen.errors} failed read(s)` : ""}${proxy ? `; Database connections through the proxy: ${reconnects ?? "?"} made over the window, at least ${proxied.length ? Math.min(...proxied.map((r) => r.open ?? Infinity)) : "?"} open` : ""}; the live log took ${yLog.rows.length} value(s), never fewer than ${yMin} entries; ${confound.length} autosave(s) between the reads around the send; the Database emulator's own log for ${databaseLog.from}–${databaseLog.to} is kept at ${databaseLog.file ?? "(no stack log)"}`);
  // A row missing for one of the two updates means its liveEditing never reached the reads: no Database handle (it then
  // answers null, "nobody can be editing live") or a throw before them.
  if (probed) ctx.step(`the functions' editors question (amplify-c12-update's probe), ${probed.length} of 2 read(s) logged: ${probed.map((p) => `${p.at} connected ${p.connected} editors ${p.editors} log ${p.log} (${p.connectedMs}+${p.peersMs}+${p.logMs} ms)`).join("; ") || "none"}`);
  const notBefore = typedAround.filter((t) => !t.before);
  if (notBefore.length) ctx.inconclusive(`the race did not hold: ${notBefore.map((t) => t.name).join(", ")} typed nothing before the updates were sent`);
  const upd = toolRow(run.results[0], 1);
  const up = jsonRow(run.results[1]);
  ctx.ev.json("refusals", { update_document: upd, upload: up });
  ctx.step(`update_document: ${upd.isError ? `refused: ${upd.text}` : JSON.stringify(upd.json)}; /publish?update=: ${up.status} ${JSON.stringify(up.json)}`);
  measure(ctx, "c12-agent-vs-editors", { scenario: "C12a race", answeredMs: Math.round(winEnd - winStart), update: upd.kind, uploadStatus: up.status, uploadEditors: up.json?.editors ?? null, minEditorsSeen: minEditors, presenceReads: seen.reads.length, proxyReconnects: reconnects, yValues: yLog.rows.length, yMin, autosavesInWindow: confound.length, probeEditors: probed ? probed.map((p) => p.editors) : null, probeConnected: probed ? probed.map((p) => p.connected) : null, probeReadMs: probed ? probed.map((p) => p.connectedMs + p.peersMs + p.logMs) : null });

  // Judged at once, on what the answers left: a frame the product reloads because a version was minted (or typing it stops)
  // must fail these, never hide them behind a race precondition read later.
  const o = oracleSet();
  await o.check(() => assert.equal(upd.isError ? upd.text : `not refused: ${JSON.stringify(upd.json)}`, editingRefusal(n, "published"), `C12a refusal: update_document is refused for the ${n} editor(s) in the editor`));
  await o.check(() => assert.ok(up.status === 409 && up.json?.error === editingRefusal(n, "published") && up.json?.editors === n, `C12a refusal: /publish?update= answers 409 { error, editors: ${n} } — it answered ${up.status} ${JSON.stringify(up.json)}`));
  const refusalFailed = o.failed.length > 0;
  await o.check(() => judgeNothingMinted(post, "C12a nothing minted"));
  await o.check(() => judgeLeftAlone({ pre, post, yLog, confound }));
  if (refusalFailed) {
    const now = await serverState(docId);
    ctx.ev.json("after-refusal", now);
    ctx.step(`the refusal did not hold; the server now: ${JSON.stringify(now)}`);
    verdict({ others: o });
  }
  const notAfter = typedAround.filter((t) => !t.after);
  if (notAfter.length) {
    // A failure already judged is the outcome; only a clean record so far is a race that did not hold.
    verdict({ others: o });
    ctx.inconclusive(`the race did not hold: ${notAfter.map((t) => `${t.name}${t.error ? ` (${t.error})` : ""}`).join(", ")} typed nothing after both updates were answered`);
  }

  ctx.step("every editor's autosave after its last key; then the session settles");
  const saves = await Promise.all(users.map(async (u, i) => {
    const last = tokens[i].at(-1).end;
    const s = await u.waitForAutosave({ after: last, timeout: 60_000, expectStatus: null });
    return { name: u.name, status: s.status, base: s.body?.draft?.baseVersion ?? null, body: s.status === 200 ? null : s.body };
  }));
  ctx.ev.json("autosaves", saves);
  // On v1: after a mint the app remounts each open editor on the new version (DocViewer.tsx:208-211, the editing mode
  // follows doc.currentVersion), so its next save answers 200 on v2; only the base tells the refused update's draft from that.
  await o.check(() => assert.deepEqual(saves.filter((s) => s.status !== 200 || s.base !== "v1"), [], "C12a saves: every editor's autosave after the refused updates answers 200 on v1, the draft the refusal left alone (a minted update would move it to v2, or make it the stale 409)"));
  await o.check(async () => {
    await settle(users, docId);
  });
  await o.check(async () => {
    const segs = {};
    for (const u of users) segs[u.name] = await readSegments(u, users.map((_, i) => paragraph(i)));
    assertInvariant(checkI2({ peers: segs, typed: log.typed }));
  });
  const mid = await serverState(docId);
  ctx.ev.json("after-refusal", mid);
  const v2Prefix = await versionPrefix(docId, "v2");
  const uploaded = v2Prefix ? await listObjects(target, `${v2Prefix}/`) : [];
  await o.check(() => assert.ok(mid.currentVersion === "v1" && mid.versions.length === 1 && uploaded.length === 0, `C12a nothing minted (after the settle): a refused update mints and uploads nothing — current ${mid.currentVersion}, versions ${JSON.stringify(mid.versions)}, ${uploaded.length} object(s) under docs/{d}/v2/`));
  await o.check(() => assert.ok(mid.draft?.baseVersion === "v1" && mid.draftObjects.length > 0 && mid.yEntries > 0, `C12a left alone (after the settle): the draft and its log are still there (draft ${JSON.stringify(mid.draft)}, ${mid.draftObjects.length} draft object(s), ${mid.yEntries} log entries)`));
  verdict({ others: o });

  ctx.step("everyone presses Done; once nobody is in the editor, the agent's update_document on v1");
  await doneAndWait(ctx, docId, users);
  const leftover = await serverState(docId);
  ctx.ev.json("before-update", leftover);
  const markC = marker("C");
  const out = await agentUpdate(agent, docId, agentContent(markC), "v1");
  ctx.step(`update_document: ${out.kind} ${out.isError ? out.text : JSON.stringify(out.json)}`);
  const o2 = oracleSet();
  await o2.check(() => assert.equal(out.kind, "success", `C12a after: once nobody is in the editor the agent's update publishes (${out.isError ? out.text : JSON.stringify(out.json)})`));
  const v = out.kind === "success" ? out.json.versionId : null;
  if (v) {
    await o2.check(() => judgeLogDropped(docId, { label: "C12a", what: "the agent's update" }));
    await o2.check(async () => judgeDraftDropped(await serverState(docId), { label: "C12a", versionId: v }));
    await o2.check(() => judgeDraftServed({ label: "C12a", http: owner.http, docId, entry, versionId: v }));
    await o2.check(async () => judgeAgentView(await editorView(ctx, users[1], docId), { label: "C12a", mark: markC, noTokens: true, who: users[1].name }));
  }
  verdict({ others: o2 });
  if (confound.length) ctx.inconclusive(`the race did not hold for half of "C12a left alone": ${confound.length} autosave(s) could have written the draft between the reads around the send (${confound.map((c) => `${c.name} sent ${c.sentAt - pre.from} ms after the first read`).join(", ")}), so its record and objects were not compared; every other oracle passed`);
}));

// =====================================================================================
// C12b — curl-only drafts and the agent's update
// =====================================================================================

/**
 * An owner, its document (v1 from the fixture) and N−1 editors that never
 * open the editor: each a session and a personal token (channel cli), for
 * POST /draft as curl would send it. Plus the owner's agent.
 */
async function curlSetup(ctx, label) {
  const roles = ["owner", ...Array.from({ length: ctx.n - 1 }, (_, i) => `editor-p${i + 2}`)];
  const accts = await cast(target, roles, { http: ctx.http({ actor: "harness" }) });
  const owner = await openSession(target, accts[0], { timeoutMs: 120_000 });
  const up = await publish(owner.http, { fixture: FIXTURE, title: `${label} N=${ctx.n}`, name: "c12b", timeoutMs: 120_000 });
  const docId = up.docId;
  // Locally one POST /access (as joinShared grants); elsewhere the operator script, one editor at a time, with no email.
  const granted = await grantEditors(target, { owner, doc: docId, accounts: accts.slice(1), timeoutMs: 120_000 });
  if (granted.missing.length) ctx.inconclusive(`the sync precondition did not hold: the RTDB mirror of ${granted.missing.map((m) => m.email).join(", ")} is missing after the grant (suspect S16)`);
  const editors = [];
  for (const a of accts.slice(1)) {
    const s = await openSession(target, a, { timeoutMs: 120_000 });
    const { token } = await mintToken(s, { name: `e2e c12b curl ${a.role}`, channel: "cli" });
    editors.push({ name: a.role, account: a, token, mark: marker(`D${editors.length + 2}`), http: ctx.http({ actor: a.role, headers: { authorization: `Bearer ${token}` }, timeoutMs: HTTP_MS, cutoffError: true }) });
  }
  const agent = await agentFor(ctx, owner, "c12b");
  const entry = await v1Entry(docId);
  ctx.step(`${docId}: the owner's agent and ${editors.length} curl editor(s) (${editors.map((e) => e.name).join(", ")}), none of them in the editor`);
  return { accts, owner, docId, editors, agent, entry };
}

/** A curl editor's POST /draft on `baseVersion` with its own marker → {name, status, json}. */
async function curlSave(e, docId, baseVersion) {
  const r = await e.http.postJson("/draft", { docId, baseVersion, html: curlDraft(e.mark) }, { timeoutMs: HTTP_MS });
  if (r.status === 200) rememberDraft(docId, r.json?.draft);
  return { name: e.name, status: r.status, json: r.status === 200 ? { baseVersion: r.json?.draft?.baseVersion ?? null } : r.json ?? null };
}

/**
 * The C12b oracles, once the server holds still, in three sets a case files
 * as its own or its others: `current` (the document points at the agent's
 * version), `dropped` (no draft record of another version and no object under
 * docs/{d}/draft/: what POST /draft wrote), and `served` (GET /draft serves the
 * agent's version and, unless `nextEditor: false`, the next editor sees it:
 * what getDraft serves from what was left). Resolves {current, dropped,
 * served, state}.
 */
async function judgeCurl(ctx, s, versionId, markA, label, { nextEditor = true } = {}) {
  const state = await settleServer(ctx, s.docId, `${label} after`);
  const forbidden = s.editors.map((e) => e.mark);
  const current = oracleSet();
  const dropped = oracleSet();
  const served = oracleSet();
  await current.check(() => assert.equal(state.currentVersion, versionId, `${label} current: the document points at the agent's ${versionId} (it points at ${state.currentVersion})`));
  await dropped.check(() => judgeDraftDropped(state, { label, versionId }));
  await served.check(() => judgeDraftServed({ label, http: s.editors[0].http, docId: s.docId, entry: s.entry, versionId, forbidden }));
  if (nextEditor) {
    ctx.step(`the next editor: ${s.editors[0].name} signs in, opens the document and enters the editor`);
    const u = await ctx.users.user({ name: "next", consent: "denied" });
    await u.signInUi(s.editors[0].account.email, s.editors[0].account.password, { next: `/d/${s.docId}` });
    await u.waitForFrame({ timeout: 90_000 });
    const view = await editorView(ctx, u, s.docId, { open: false });
    ctx.step(`${u.name} sees: heading ${JSON.stringify(view.heading)}, #${AGENT_ID} ${JSON.stringify(view.agent)}, ${forbidden.filter((m) => view.text.includes(m)).length} curl marker(s)`);
    await served.check(() => judgeAgentView(view, { label, mark: markA, forbidden, who: `${u.name} (${s.editors[0].name})` }));
  }
  return { current, dropped, served, state };
}

scenario("C12b curl-only drafts vs the agent's update (SYNC-T): N−1 editors' POST /draft with personal tokens and the agent's update_document, all on v1, fired at one instant; every draft is saved before the update or refused as stale, the update publishes, and once the server holds still no draft of v1 is left (record or objects), GET /draft serves the agent's version and the next editor sees it", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => guarded(ctx, async () => {
  const s = await curlSetup(ctx, "C12b race");
  const markA = marker("A");
  const run = await fireTogether(ctx, [
    ...s.editors.map((e) => draftRequest(e.token, s.docId, "v1", curlDraft(e.mark), e.name)),
    toolRequest(s.agent.token, "update_document", { id: s.docId, content: agentContent(markA), baseVersion: "v1" }, 1),
  ], "C12b drafts and update");
  const drafts = run.results.slice(0, s.editors.length).map((r, i) => ({ name: s.editors[i].name, ...jsonRow(r) }));
  for (const draft of drafts) if (draft.status === 200) rememberDraft(s.docId, draft.json?.draft);
  const upd = toolRow(run.results.at(-1), 1);
  ctx.ev.json("answers", { drafts, update: upd });
  ctx.step(`drafts: ${drafts.map((d) => `${d.name} ${d.status}`).join(", ")}; update_document: ${upd.kind}${upd.json?.versionId ? ` ${upd.json.versionId}` : ""}`);
  measure(ctx, "c12-agent-vs-editors", { scenario: "C12b race", drafts: drafts.map((d) => d.status), update: upd.kind });
  const odd = drafts.filter((d) => d.status !== 200 && !(d.status === 409 && d.json?.error === DRAFT_STALE));
  if (odd.length) {
    const err = new Error(`a curl draft was answered neither 200 nor the stale 409: ${JSON.stringify(odd)}`);
    err.code = "E2E_C12_DRAFT";
    throw err;
  }
  const v = publishedVersion(upd, "C12b race");
  const j = await judgeCurl(ctx, s, v, markA, "C12b");
  verdict({ others: merged(j.current, j.dropped, j.served) });
}));

/**
 * The C12b straddle (SYNC-P, amplify-c12-update's draft-after-check): every
 * curl draft is held after POST /draft's base check (v1 is current) and
 * before it writes; the agent's update publishes v2 and drops the draft; the
 * drafts are let go and write. Resolves {s, v, markA, answers, between}.
 */
async function c12bStraddle(ctx, label) {
  const s = await curlSetup(ctx, label);
  const g = gates(ctx.target);
  const markA = marker("A");
  let saves = [];
  let v = null;
  let between = null;
  try {
    await g.hold("draft-after-check", { key: s.docId });
    ctx.step(`hold draft-after-check for ${s.docId}; ${s.editors.length} curl editor(s) POST /draft on v1`);
    saves = s.editors.map((e) => settled(curlSave(e, s.docId, "v1")));
    const held = await requireHeld(ctx, g, "draft-after-check", s.editors.length, { key: s.docId, timeoutMs: HELD_MS });
    ctx.step(`every draft passed its base check (v1 is current) and is held before it writes (seq ${held.callers.map((c) => c.seq).join(", ")})`);
    const out = await agentUpdate(s.agent, s.docId, agentContent(markA), "v1");
    ctx.step(`while they are held, the agent's update_document: ${out.kind} ${out.isError ? out.text : JSON.stringify(out.json)}`);
    v = publishedVersion(out, label);
    between = await serverState(s.docId);
    ctx.ev.json("between", between);
    ctx.step(`after the update, before the drafts write: ${JSON.stringify(between)}`);
    const rel = await g.release("draft-after-check");
    ctx.step(`released ${rel.released.length} held draft(s)`);
  } finally {
    await g.release("draft-after-check").catch(() => undefined);
  }
  const answers = [];
  for (const r of await Promise.all(saves)) {
    if (!r.ok) throw r.error;
    answers.push(r.value);
  }
  ctx.ev.json("drafts", answers);
  ctx.step(`the held drafts answered: ${answers.map((a) => `${a.name} ${a.status} ${JSON.stringify(a.json)}`).join("; ")}`);
  return { s, v, markA, answers, between };
}

scenario("C12b straddle (SYNC-P, amplify-c12-update): every curl draft is held after POST /draft's base check while the agent's update publishes v2 and drops the draft, then lets go and writes; GET /draft still serves the agent's version and the next editor sees it", {
  tiers: LOCAL,
  needs: ["gates", "patch:amplify-c12-update"],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => guarded(ctx, async () => {
  const { s, v, markA, answers } = await c12bStraddle(ctx, "C12b straddle");
  const { current, dropped, served, state } = await judgeCurl(ctx, s, v, markA, "C12b straddle");
  // What POST /draft left is "C12b straddle draft write"'s oracle (X-a12-versions-2), recorded here and judged there.
  ctx.step(`RECORDED, judged by the draft-write case (X-a12-versions-2): ${dropped.failed.length ? dropped.failed.join(" | ") : "nothing of the drafts was left"}`);
  measure(ctx, "c12-agent-vs-editors", { scenario: "C12b straddle", drafts: answers.map((a) => a.status), draftRecord: state.draft, draftObjects: state.draftObjects.length, ownFailed: served.failed.length });
  verdict({ others: current, own: served });
}));

scenario("C12b straddle draft write (SYNC-P, amplify-c12-update): every curl draft is held after POST /draft's base check while the agent's update publishes v2 and drops the draft, then lets go; once the server holds still nothing of a draft of v1 is left: no docs/{d}.draft on v1 and no object under docs/{d}/draft/", {
  tiers: LOCAL,
  needs: ["gates", "patch:amplify-c12-update"],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => guarded(ctx, async () => {
  const { s, v, markA, answers } = await c12bStraddle(ctx, "C12b straddle draft write");
  const { current, dropped, served, state } = await judgeCurl(ctx, s, v, markA, "C12b straddle draft write", { nextEditor: false });
  // What GET /draft serves from it is "C12b straddle"'s oracle (S14), recorded here and judged there.
  ctx.step(`RECORDED, judged by the straddle case (S14): ${served.failed.length ? served.failed.join(" | ") : "GET /draft serves the agent's version"}`);
  measure(ctx, "c12-agent-vs-editors", { scenario: "C12b straddle draft write", drafts: answers.map((a) => a.status), draftRecord: state.draft, draftObjects: state.draftObjects.length, ownFailed: dropped.failed.length });
  verdict({ others: current, own: dropped });
}));

scenario("C12b straddle serial positive control: the same curl drafts and update one after another — each draft saved on v1, then the agent's update, then each draft again on v1, refused as stale — leave no draft of v1, GET /draft serves the agent's version and the next editor sees it", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 },
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => guarded(ctx, async () => {
  const s = await curlSetup(ctx, "C12b serial");
  const markA = marker("A");
  const first = [];
  for (const e of s.editors) first.push(await curlSave(e, s.docId, "v1"));
  ctx.step(`each draft saved in turn: ${first.map((a) => `${a.name} ${a.status}`).join(", ")}`);
  precondition(first.every((a) => a.status === 200), `every curl draft saves on v1 before the update (${JSON.stringify(first)})`);
  const out = await agentUpdate(s.agent, s.docId, agentContent(markA), "v1");
  ctx.step(`then the agent's update_document: ${out.kind} ${out.isError ? out.text : JSON.stringify(out.json)}`);
  const v = publishedVersion(out, "C12b serial");
  const late = [];
  for (const e of s.editors) late.push(await curlSave(e, s.docId, "v1"));
  ctx.ev.json("drafts", { first, late });
  ctx.step(`then each draft again on v1: ${late.map((a) => `${a.name} ${a.status}`).join(", ")}`);
  const others = oracleSet();
  await others.check(() => assert.ok(late.every((a) => a.status === 409 && a.json?.error === DRAFT_STALE), `C12b serial stale: a draft on v1 after the update is refused as stale — ${JSON.stringify(late)}`));
  const j = await judgeCurl(ctx, s, v, markA, "C12b serial");
  verdict({ others: merged(others, j.current, j.dropped, j.served) });
}));

// =====================================================================================
// C12c — the draft's objects and the live log an update replaces
// =====================================================================================

scenario("C12c deleted draft objects, leftover log: N editors type, save and all press Done, leaving a draft and a live log nobody is using; the agent's update publishes v2, the live log is empty within 2 s, the draft's record and objects are gone, GET /draft serves v2 and the next editor sees the agent's version and none of the tokens", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => guarded(ctx, async () => {
  const n = ctx.n;
  const { docId, users, owner } = await joinShared(ctx, { n, fixture: FIXTURE, title: `C12c N=${n}` });
  const entry = await v1Entry(docId);
  const agent = await agentFor(ctx, owner, "c12c");
  const log = tokenLog(target.runId);
  ctx.step("every editor types one token into its own paragraph; the session settles; everyone presses Done");
  await typeOneEach(users, log);
  await settleFirst(users, docId);
  await doneAndWait(ctx, docId, users);
  const before = await serverState(docId);
  ctx.ev.json("before", before);
  ctx.step(`nobody is in the editor; left behind: ${JSON.stringify(before)}`);
  if (before.yEntries === 0) ctx.inconclusive("the sync precondition did not hold: the live log was already empty once everyone left the editor, so there is no leftover log to drop");
  precondition(before.draft?.baseVersion === "v1" && before.draftObjects.length > 0, `the session left a draft on v1 (${JSON.stringify(before)})`);
  const markA = marker("A");
  const out = await agentUpdate(agent, docId, agentContent(markA), "v1");
  ctx.step(`the agent's update_document: ${out.kind} ${out.isError ? out.text : JSON.stringify(out.json)}`);
  const v = publishedVersion(out, "C12c");
  const o = oracleSet();
  await o.check(() => judgeLogDropped(docId, { label: "C12c", what: "the agent's update" }));
  await o.check(async () => judgeDraftDropped(await serverState(docId), { label: "C12c", versionId: v }));
  await o.check(() => judgeDraftServed({ label: "C12c", http: owner.http, docId, entry, versionId: v }));
  await o.check(async () => judgeAgentView(await editorView(ctx, users[1], docId), { label: "C12c", mark: markA, noTokens: true, who: users[1].name }));
  verdict({ others: o });
}));

/**
 * C12c race and its serial control. `gated`: the agent's update is held at
 * update-before-id (after the editors question) while the race editors open
 * the editor, type and save on v1; else the update goes first and they do
 * the same after it.
 */
async function c12cRace(ctx, { gated }) {
  const n = ctx.n;
  const label = gated ? "C12c race" : "C12c race serial";
  const { docId, users, owner } = await joinShared(ctx, { n, fixture: FIXTURE, title: `${label} N=${n}`, enter: false });
  const agent = await agentFor(ctx, owner, gated ? "c12c-race" : "c12c-serial");
  const log = tokenLog(target.runId);
  const racers = users.slice(1, 1 + Math.min(n - 1, RACE_EDITORS_MAX));
  const markA = marker("A");
  const fresh = await serverState(docId);
  precondition(fresh.yEntries === 0 && fresh.draft === null && editorsIn(await peerModes(docId)).length === 0, `a fresh document: no live log, no draft, nobody in the editor (${JSON.stringify(fresh)})`);

  /** The racers open the editor (the first alone, until its seed is in the log), each types a token and its autosave answers 200. */
  const raceEditors = async (base) => {
    await enterShared(ctx, racers[0], 30_000);
    await eventually(async () => entriesOf(await readLog(docId)) > 0, { timeout: 15_000, interval: 200, message: `${racers[0].name}'s seed in the live log` })
      .catch(() => ctx.inconclusive(`the sync precondition did not hold: ${racers[0].name}'s seed never reached status/${docId}/y`));
    await Promise.all(racers.slice(1).map((u) => enterShared(ctx, u, 30_000)));
    return Promise.all(racers.map(async (u) => {
      const i = users.indexOf(u);
      const s = await u.typeAndAutosave(idSelector(paragraph(i)), log.next(u.name, paragraph(i)), { delay: KEY_DELAY_MS, timeout: 20_000, expectStatus: null });
      return { name: u.name, status: s.status, base: s.body?.draft?.baseVersion ?? null, wanted: base };
    }));
  };

  let out;
  let saves;
  if (gated) {
    const g = gates(ctx.target);
    try {
      await g.hold("update-before-id", { key: docId });
      ctx.step(`hold update-before-id for ${docId}; the agent's update_document on v1 while nobody is in the editor and the log is empty`);
      const sentAt = Date.now();
      const pending = settled(agentUpdate(agent, docId, agentContent(markA), "v1"));
      await requireHeld(ctx, g, "update-before-id", 1, { key: docId, timeoutMs: HELD_MS });
      const atQuestion = await serverState(docId);
      if (atQuestion.yEntries !== 0 || editorsIn(await peerModes(docId)).length) ctx.inconclusive(`the sync precondition did not hold: the update was held, but the log or presence was no longer empty (${JSON.stringify(atQuestion)})`);
      ctx.step(`the update passed the editors question and is held; ${racers.map((u) => u.name).join(", ")} open the editor, type a token each and autosave it on v1`);
      const steps = raceEditors("v1");
      steps.catch(() => undefined);
      const left = HOLD_BUDGET_MS - (Date.now() - sentAt);
      const raced = await Promise.race([steps.then((v) => ({ v })), sleep(Math.max(0, left)).then(() => null)]);
      if (!raced) {
        await g.release("update-before-id");
        await pending;
        ctx.inconclusive(`the sync precondition did not hold: ${racers.length} editor(s) did not enter the editor and save within the ${HOLD_BUDGET_MS / 1000} s a held update may wait before Hosting's cut-off`);
      }
      saves = raced.v;
      ctx.step(`inside the window: ${saves.map((s) => `${s.name} saved ${s.status} on ${s.base}`).join("; ")}; the log holds ${entriesOf(await readLog(docId))} entries`);
      if (saves.some((s) => s.status !== 200 || s.base !== "v1")) ctx.inconclusive(`the sync precondition did not hold: a racer's autosave inside the window was not a draft on v1 (${JSON.stringify(saves)})`);
      await g.release("update-before-id");
      const r = await pending;
      if (!r.ok) throw r.error;
      out = r.value;
    } finally {
      await g.release("update-before-id").catch(() => undefined);
    }
  } else {
    ctx.step("the agent's update_document on v1 while nobody is in the editor");
    out = await agentUpdate(agent, docId, agentContent(markA), "v1");
  }
  ctx.step(`the agent's update_document: ${out.kind} ${out.isError ? out.text : JSON.stringify(out.json)}`);
  const v = publishedVersion(out, label);
  const afterUpdate = await serverState(docId);
  ctx.ev.json("after-update", afterUpdate);
  ctx.step(`once ${v} is current: ${JSON.stringify(afterUpdate)}`);
  if (!gated) {
    ctx.step(`${racers.map((u) => u.name).join(", ")} open the editor, type a token each and autosave it on ${v}`);
    saves = await raceEditors(v);
    ctx.step(saves.map((s) => `${s.name} saved ${s.status} on ${s.base}`).join("; "));
    precondition(saves.every((s) => s.status === 200 && s.base === v), `every racer's autosave after the update is a draft on ${v} (${JSON.stringify(saves)})`);
  }
  ctx.step(`${racers.map((u) => u.name).join(", ")} leave the document in the app`);
  for (const u of racers) await leaveOne(u);
  await nobodyEditing(ctx, docId, "the racers left");
  const left = await serverState(docId);
  ctx.ev.json("racers-left", left);
  measure(ctx, "c12-agent-vs-editors", { scenario: label, saves: saves.map((s) => `${s.status}@${s.base}`), yAfterUpdate: afterUpdate.yEntries, yAfterLeave: left.yEntries, draftObjects: left.draftObjects.length });
  const p1 = users[0];
  ctx.step(`the next editor: ${p1.name} opens the editor`);
  const view = await editorView(ctx, p1, docId);
  ctx.step(`${p1.name} sees: heading ${JSON.stringify(view.heading)}, #${AGENT_ID} ${JSON.stringify(view.agent)}, ${view.tokens.length} token(s)`);
  const draftNow = await draftServed(owner.http, docId, await v1Entry(docId));
  ctx.step(`GET /draft meanwhile serves ${draftNow.text.includes(markA) ? "the agent's version" : draftNow.text.includes(`>${V1_HEADING}<`) ? "v1's content" : "something else"} (${draftNow.status})`);
  const own = oracleSet();
  await own.check(() => judgeAgentView(view, { label, mark: markA, who: p1.name }));
  // Recorded, not judged: whether one keystroke of the next editor saves what it was shown as the draft of the new version.
  const probe = await p1.typeAndAutosave(idSelector(paragraph(0)), log.next(p1.name, paragraph(0)), { delay: KEY_DELAY_MS, timeout: 30_000, expectStatus: null });
  const saved = (await readDraftObject(target, docId, await v1Entry(docId)))?.toString("utf8") ?? "";
  const savedIs = saved.includes(markA) ? "the agent's version" : saved.includes(`>${V1_HEADING}<`) ? "v1's content (the update reverted)" : saved ? "something else" : "absent";
  ctx.step(`OBSERVED: ${p1.name} types one token; its autosave answered ${probe.status} on ${probe.body?.draft?.baseVersion ?? "?"}, and the draft of ${v} now holds ${savedIs}`);
  measure(ctx, "c12-agent-vs-editors", { scenario: `${label} keystroke`, status: probe.status, base: probe.body?.draft?.baseVersion ?? null, draftHolds: savedIs });
  return own;
}

scenario("C12c race (SYNC-P, amplify-c08-mint-races): the agent's update passes the editors question while nobody edits and is held; editors then open the editor, type and save on v1; the update is let go and publishes; once they have left, the next editor to open the editor sees the agent's version", {
  tiers: LOCAL,
  needs: ["gates", "patch:amplify-c08-mint-races"],
  n: [2, 5, 10, 20],
  defect: "X-c12-agent-vs-editors-1",
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => guarded(ctx, async () => {
  const own = await c12cRace(ctx, { gated: true });
  verdict({ defect: "X-c12-agent-vs-editors-1", others: oracleSet(), own });
}));

scenario("C12c race serial positive control: the same update first, then the same editors opening the editor, typing, saving and leaving; the next editor to open the editor sees the agent's version", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 },
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => guarded(ctx, async () => {
  const own = await c12cRace(ctx, { gated: false });
  verdict({ others: own });
}));

// =====================================================================================
// C12d — the in-app commit, and the live log it leaves
// =====================================================================================

/** The refused writes to status/{d}/y a user's page logged since `mark` (its console). */
function refusedRemoves(u, docId, mark) {
  return u.log.console.slice(mark).filter((c) => /permission_denied/i.test(String(c.text)) && String(c.text).includes(`status/${docId}/y`)).map((c) => String(c.text).slice(0, 300));
}

/** How many entries status/{d}/y holds within `ms` of now (read until empty or `ms` passes), and when that read came. */
async function logLeftWithin(docId, ms) {
  const t0 = Date.now();
  const n = await logEntriesAfter(docId, ms);
  return { n, ms: Date.now() - t0 };
}

/** The S8 assertion (class Q), worded as A9.8 words it: a SPEC question, not a SPEC violation. */
function judgeS8(docId, { yBefore, left, refused, label }) {
  assert.equal(
    left.n,
    0,
    `${label} S8: the applied live log is empty within 2 s of publishing after every co-editor left; status/${docId}/y still holds ${left.n} entries after ${left.ms} ms`,
  );
}

scenario("C12d in-app commit: N editors type and settle, all but p1 press Done, p1 presses Save as new version: \"Published v2.\", the draft's record and objects are gone, v2 holds every token once (I2) and the sentinel once (I3), and the next editor sees v2; then the agent's update publishes v3, the live log is empty within 2 s and the next editor sees the agent's version. Own oracle (S8, class Q, a SPEC question): the live log is empty within 2 s of \"Published v2.\"", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => guarded(ctx, async () => {
  const n = ctx.n;
  // S8 is blind where the app's realtime namespace runs without the tree's rules (S31): the whole-log remove then succeeds.
  const rules = await realtimeRules(ctx);
  ctx.step(`realtime rules: ${rules.note}`);
  const { docId, users, owner } = await joinShared(ctx, { n, fixture: FIXTURE, title: `C12d N=${n}` });
  const entry = await v1Entry(docId);
  const agent = await agentFor(ctx, owner, "c12d");
  const log = tokenLog(target.runId);
  const ids = users.map((_, i) => paragraph(i));
  const [p1, p2] = users;
  ctx.step("every editor types one token into its own paragraph; the session settles; all but p1 press Done");
  await typeOneEach(users, log);
  await settleFirst(users, docId);
  for (const u of users.slice(1)) await u.done({ timeout: 60_000 });
  const alone = await waitModes(docId, (m) => editorsIn(m).length === 1);
  if (!alone.ok) ctx.inconclusive(`the sync precondition did not hold: presence never showed p1 alone in the editor (${JSON.stringify(alone.modes)})`);
  const yBefore = entriesOf(await readLog(docId));
  const consoleMark = p1.log.console.length;
  ctx.step(`${p1.name} presses Save as new version (the live log holds ${yBefore} entries)`);
  rememberDraft(docId, (await readDoc(target, `docs/${docId}`))?.draft);
  const commitDrafts = p1.capture({ paths: "/draft" });
  const saved = await p1.saveAsNewVersion({ timeout: HTTP_MS });
  commitDrafts.stop();
  for (const row of commitDrafts) if (row.status === 200) rememberDraft(docId, row.json?.draft);
  // S8's own oracle counts from the toast, read while presence catches up.
  const leftP = settled(logLeftWithin(docId, LOG_EMPTY_MS));
  ctx.step(`${p1.name}: ${saved.outcome} "${saved.text}"`);
  const o = oracleSet();
  await o.check(() => assert.deepEqual([saved.outcome, saved.versionId], ["published", "v2"], `C12d commit: Save as new version publishes v2 ("${saved.text}")`));
  await nobodyEditing(ctx, docId, `${p1.name} published`);
  const leftR = await leftP;
  if (!leftR.ok) throw leftR.error;
  const left = leftR.value;
  const refused = refusedRemoves(p1, docId, consoleMark);
  ctx.step(`S8 (class Q): ${(left.ms / 1000).toFixed(1)} s after "Published", status/${docId}/y holds ${left.n} entries (it held ${yBefore}); ${p1.name}'s page logged ${refused.length} refused write(s) to it; ${rules.note}`);
  ctx.ev.json("s8-observation", { yBefore, left, refusedRemove: refused, rules });
  measure(ctx, "c12-agent-vs-editors", { scenario: "C12d S8", yBefore, yAfterCommit: left.n, readAfterMs: left.ms, refusedRemove: refused.length, rules: rules.ok ? "enforced" : "not enforced" });
  const own = oracleSet();
  if (rules.ok) {
    precondition(yBefore > 0, `the live log held entries before the commit (${yBefore})`);
    await own.check(() => judgeS8(docId, { yBefore, left, refused: refused.length, label: "C12d" }));
  }

  const state = await serverState(docId);
  ctx.ev.json("after-commit", state);
  await o.check(() => assert.ok(state.currentVersion === "v2" && state.versions.includes("v2<v1:editor"), `C12d version: v2 is current, minted on v1 by the editor (${JSON.stringify(state.versions)}, current ${state.currentVersion})`));
  await o.check(() => judgeDraftDropped(state, { label: "C12d", versionId: "v2" }));
  const parser = await ctx.users.parser();
  const v2html = (await readObject(target, `${await versionPrefix(docId, "v2")}/${entry}`))?.toString("utf8") ?? "";
  await o.check(async () => assertInvariant(checkI2({ peers: { v2: await segmentsOfHtml(parser, v2html, ids) }, typed: log.typed })));
  await parser.setContent(v2html);
  const baseline = await readI3(parser);
  await o.check(() => assertInvariant(checkI3({ peers: { v2: baseline }, baseline: { children: 41 } })));
  ctx.step(`the next editor: ${p2.name} opens the editor on v2`);
  const view = await editorView(ctx, p2, docId);
  await o.check(async () => assertInvariant(checkI2({ peers: { [p2.name]: await readSegments(p2, ids) }, typed: log.typed })));
  await o.check(() => assert.ok(view.i3.sentinels === 1 && view.i3.children === baseline.children && view.heading === V1_HEADING, `C12d next editor: ${p2.name} sees v2 (sentinel ${view.i3.sentinels} time(s), ${view.i3.children} top-level element(s) for v2's ${baseline.children}, heading ${JSON.stringify(view.heading)})`));
  await p2.done({ timeout: 60_000 });
  await nobodyEditing(ctx, docId, `${p2.name} pressed Done`);
  if (o.failed.length) verdict({ others: o, own });

  const markA = marker("A");
  const out = await agentUpdate(agent, docId, agentContent(markA), "v2");
  ctx.step(`the agent's update_document on v2: ${out.kind} ${out.isError ? out.text : JSON.stringify(out.json)}`);
  const v = publishedVersion(out, "C12d");
  const o2 = oracleSet();
  await o2.check(() => judgeLogDropped(docId, { label: "C12d", what: "the agent's update after the in-app commit" }));
  await o2.check(async () => judgeDraftDropped(await serverState(docId), { label: "C12d", versionId: v }));
  await o2.check(async () => judgeAgentView(await editorView(ctx, p1, docId), { label: "C12d", mark: markA, noTokens: true, who: p1.name }));
  verdict({ others: merged(o, o2), own });
  // As A9.8: without the tree's rules the remove is allowed and S8's oracle proves nothing (S31).
  if (!rules.ok) precondition(false, `the realtime rules are enforced where the commit cleared the log, or the remove is allowed and S8's oracle proves nothing (S31): ${rules.reason}`);
}));

/**
 * In p2's frame: the document's text, for the tokens it holds.
 */
function bodyText() {
  return document.body ? document.body.textContent : "";
}

scenario("C12d co-editor typing through the commit (S8's other side, class Q, recorded): N editors type and settle, all but p1 and p2 press Done; p2 types without pause while p1 presses Save as new version and for 3 s after \"Published v2.\"; v2 and the next editor show the sentinel once (I3), and where p2's keys typed after p1's pre-commit save end up is recorded: v2, p2's page and its own next save, the live log, what the next editor sees and the draft its first keystroke saves", {
  tiers: BOTH,
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => guarded(ctx, async () => {
  const n = ctx.n;
  const rules = await realtimeRules(ctx);
  ctx.step(`realtime rules: ${rules.note}`);
  const { docId, users } = await joinShared(ctx, { n, fixture: FIXTURE, title: `C12d co-editor N=${n}` });
  const entry = await v1Entry(docId);
  const log = tokenLog(target.runId);
  const [p1, p2] = users;
  const p2Id = paragraph(1);
  ctx.step("every editor types one token into its own paragraph; the session settles; all but p1 and p2 press Done");
  await typeOneEach(users, log);
  await settleFirst(users, docId);
  for (const u of users.slice(2)) await u.done({ timeout: 60_000 });
  const two = await waitModes(docId, (m) => editorsIn(m).length === 2);
  if (!two.ok) ctx.inconclusive(`the sync precondition did not hold: presence never showed p1 and p2 alone in the editor (${JSON.stringify(two.modes)})`);
  const yBefore = entriesOf(await readLog(docId));
  const p1Drafts = p1.capture({ paths: "/draft" });
  // p2's edit frame loads: the editing mode follows doc.currentVersion (app/src/pages/DocViewer.tsx:208-211), so a new
  // version remounts it on that version (frameMode.ts frameKey) — recorded, with the base its next save goes on.
  const p2Loads = p2.capture({ paths: /^\/draft\//, method: "GET" });
  const consoleMark = p1.log.console.length;

  ctx.step(`${p2.name} types tokens without pause; once it has typed one, ${p1.name} presses Save as new version, and ${p2.name} goes on for ${CO_TYPING_AFTER_MS / 1000} s after "Published"`);
  const rows = [];
  let stopAt = Infinity;
  const typing = (async () => {
    while (Date.now() < stopAt) {
      const token = log.next(p2.name, p2Id);
      const row = { token, start: Date.now(), end: null, error: null };
      rows.push(row);
      try {
        await p2.typeInFrame(idSelector(p2Id), token, { delay: KEY_DELAY_MS, at: "end" });
      } catch (err) {
        row.error = String(err?.message ?? err).split("\n")[0].slice(0, 200);
        return;
      } finally {
        row.end = Date.now();
      }
    }
  })();
  let saved = null;
  let pressAt = null;
  let publishedAt = null;
  let leftP = null;
  try {
    await eventually(() => rows.some((r) => r.end && !r.error), { timeout: 60_000, interval: 50, message: `${p2.name} typed a token` });
    pressAt = Date.now();
    saved = await p1.saveAsNewVersion({ timeout: HTTP_MS });
    publishedAt = Date.now();
    leftP = settled(logLeftWithin(docId, LOG_EMPTY_MS));
    stopAt = publishedAt + CO_TYPING_AFTER_MS;
  } finally {
    if (stopAt === Infinity) stopAt = 0;
    await typing;
  }
  p1Drafts.stop();
  const preSave = p1Drafts.find((r) => r.t >= pressAt) ?? null;
  const typed = rows.filter((r) => !r.error);
  const late = preSave ? typed.filter((r) => r.start > preSave.t) : [];
  const afterPublished = typed.filter((r) => r.start > publishedAt);
  const early = typed.filter((r) => r.end < pressAt);
  ctx.step(`${p1.name}: ${saved.outcome} "${saved.text}"; its pre-commit save went ${preSave ? `${preSave.t - pressAt} ms after the press (${preSave.status})` : "unseen"}; ${p2.name} typed ${typed.length} token(s): ${early.length} before the press, ${late.length} begun after the pre-commit save was sent (${afterPublished.length} of them after "Published")${rows.find((r) => r.error) ? `; stopped: ${rows.find((r) => r.error).error}` : ""}`);
  if (!preSave) ctx.inconclusive(`the sync precondition did not hold: ${p1.name}'s pre-commit POST /draft was never seen`);
  if (!late.length) ctx.inconclusive(`the sync precondition did not hold: ${p2.name} began no token after ${p1.name}'s pre-commit save was sent`);

  const o = oracleSet();
  await o.check(() => assert.deepEqual([saved.outcome, saved.versionId], ["published", "v2"], `C12d co-editor commit: Save as new version publishes v2 while ${p2.name} types ("${saved.text}")`));
  const leftR = await leftP;
  if (!leftR.ok) throw leftR.error;
  const left = leftR.value;
  const refused = refusedRemoves(p1, docId, consoleMark);
  ctx.step(`${p2.name}'s autosave after its last key (recorded: its status and the base it went on); then its own page's text; then it presses Done`);
  // Recorded, not judged. No SPEC sentence says which base a co-editor's open editor saves on once a version is published:
  // SPEC §16 keeps the stale 409 for "somebody PUBLISHED a new version while you were editing", and the app instead
  // remounts the editor on the new version (DocViewer.tsx:208-211), so the next save goes on it.
  const p2Save = await p2.waitForAutosave({ after: rows.at(-1).end, timeout: 60_000, expectStatus: null }).catch((err) => ({ status: null, body: null, error: String(err?.message ?? err).slice(0, 300) }));
  const p2Text = await (await p2.frame()).evaluate(bodyText).catch(() => null);
  p2Loads.stop();
  // From the press: the page sees the new version (and remounts) before this process sees the toast.
  const remounts = p2Loads.filter((r) => r.t >= pressAt).map((r) => ({ afterPublishedMs: r.t - publishedAt, status: r.status, url: r.url.replace(/^.*\/draft\//, "/draft/") }));
  await p2.done({ timeout: 60_000 });
  await nobodyEditing(ctx, docId, `${p1.name} published and ${p2.name} pressed Done`);
  const yLeft = entriesOf(await readLog(docId));

  const v2html = (await readObject(target, `${await versionPrefix(docId, "v2")}/${entry}`))?.toString("utf8") ?? "";
  const parser = await ctx.users.parser();
  await parser.setContent(v2html);
  const baseline = await readI3(parser);
  await o.check(() => assertInvariant(checkI3({ peers: { v2: baseline }, baseline: { children: 41 } })));
  const next = users[2] ?? p1;
  ctx.step(`the next editor: ${next.name} opens the editor on v2`);
  const view = await editorView(ctx, next, docId);
  await o.check(() => assert.ok(view.i3.sentinels === 1 && view.i3.children === baseline.children, `C12d co-editor next editor: ${next.name} sees the sentinel once and v2's ${baseline.children} top-level elements (sentinel ${view.i3.sentinels} time(s), ${view.i3.children} element(s))`));
  const probe = await next.typeAndAutosave(idSelector(paragraph(users.indexOf(next))), log.next(next.name, paragraph(users.indexOf(next))), { delay: KEY_DELAY_MS, timeout: 30_000, expectStatus: null });
  const draftNow = (await readDraftObject(target, docId, entry))?.toString("utf8") ?? "";

  const count = (text) => (text == null ? null : late.filter((r) => text.includes(r.token)).length);
  const where = {
    late: late.length,
    inV2: count(v2html),
    inP2Page: count(p2Text),
    p2FrameLoadsAfterCommit: remounts,
    p2SaveAfterCommit: { status: p2Save.status, base: p2Save.body?.draft?.baseVersion ?? p2Save.body?.currentVersion ?? null, error: p2Save.error ?? null },
    yBefore,
    yWithin2s: left.n,
    yAfterP2Left: yLeft,
    refusedRemove: refused.length,
    nextEditor: next.name,
    nextEditorSees: count(view.text),
    nextKeystroke: { status: probe.status, base: probe.body?.draft?.baseVersion ?? null },
    draftOfV2Holds: count(draftNow),
    rules: rules.ok ? "enforced" : "not enforced",
  };
  ctx.ev.json("co-editor-keys", { ...where, tokens: rows, pressAt, preSave: { t: preSave.t, status: preSave.status }, publishedAt });
  const fate =
    where.inV2 === 0 && where.nextEditorSees === late.length && where.draftOfV2Holds === late.length
      ? `kept as unpublished text: in no version, but in the draft of v2${p2Save.status === 200 && where.p2SaveAfterCommit.base === "v2" ? ` (${p2.name}'s own editor, remounted on v2, saved them there)` : ""} and in what the next editor sees`
      : where.nextEditorSees === 0 && where.draftOfV2Holds === 0
        ? "lost: in no version, no draft and nothing the next editor sees"
        : "split";
  ctx.step(`RECORDED (S8's other side, class Q): of ${late.length} token(s) ${p2.name} began after the pre-commit save, v2 holds ${where.inV2}, ${p2.name}'s page held ${where.inP2Page} (its edit frame loaded ${remounts.length} time(s) after the press), its own next save answered ${p2Save.status} on ${where.p2SaveAfterCommit.base}; the live log held ${left.n} entries ${(left.ms / 1000).toFixed(1)} s after "Published" and ${yLeft} once ${p2.name} left; ${next.name} sees ${where.nextEditorSees} and its first keystroke (${probe.status} on ${where.nextKeystroke.base}) left ${where.draftOfV2Holds} in the draft of v2: ${fate}`);
  ctx.t.diagnostic(`C12d co-editor N=${n}: ${late.length} late token(s): v2 ${where.inV2}, next editor ${where.nextEditorSees}, draft of v2 ${where.draftOfV2Holds} (${fate}); y ${yBefore} → ${left.n} → ${yLeft}`);
  measure(ctx, "c12-agent-vs-editors", { scenario: "C12d co-editor", ...where, p2FrameLoadsAfterCommit: remounts.length, p2SaveAfterCommit: `${p2Save.status}@${where.p2SaveAfterCommit.base}`, fate });
  verdict({ others: o });
}));
