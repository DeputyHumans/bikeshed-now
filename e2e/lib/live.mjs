// SPDX-License-Identifier: Apache-2.0
// Live editing at scale: N editors joined as "Shared" on any target, the plan's settle conditions and deadlines (one editor's too), the live log read through a Database 503, probe keystrokes and their arrival, every peer's input clock, RTDB delay and memory readings (SPEC §6b, §16).

/**
 * SETTLE (the plan's "Settle conditions", live editing). A live session has
 * settled when, at once:
 *   - I1 holds on 3 consecutive samples (every peer's sha256(body.innerHTML)
 *     equal, and the same hash each time), on bodies that are not empty (at
 *     least `minLength` characters: 1, or a baseline's length when the
 *     scenario only adds text);
 *   - nothing is dirty or saving, and no save FAILED (`.save-state` "error":
 *     the editor keeps the edit unsaved and retries only on new input);
 *   - every peer that entered edit still shows a save state (none: it left
 *     edit mode) and shows "Shared" (`.share-state`), when `requireShared`;
 *   - no POST /draft for 3 s (any peer: none started or answered since);
 *   - `status/{d}/y` stable for 2 s (read as the emulator's admin).
 * "Entered edit" is the User's own record (`inEdit`: enterEdit, until done()
 * or a commit that published) or a save state seen during this wait. A peer
 * that never entered edit (a reader) is judged on its body only.
 * ONE editor (a scenario whose live session is one editor beside agents)
 * settles on every condition but I1's convergence, which needs two: in its
 * place its own body has the same hash on 3 consecutive samples (it stopped
 * changing); the result says `alone: true`.
 * The deadline is 15, 20, 30 and 60 s for N = 2, 5, 10 and 20 (SETTLE_DEADLINES_MS;
 * another N takes the next larger one, past 20 the last). A missed deadline is
 * an I1 FAILURE (an AssertionError "I1: …", what was still unsettled in its
 * message), never INCONCLUSIVE: the peers had the time the plan gives them.
 *
 * THE LIVE LOG, READ PATIENTLY. The harness's own read of status/{d}/y is
 * not the product's. The Database emulator has answered one 503 "Firebase
 * database instance is inactive" under load (run 2610130353-9akl, in the
 * same millisecond as the pages' own appends failed), and a case that threw
 * on it FAILED before convergence could be judged. rtdbGetPatient(target,
 * path) reads again while the Database answers 503, for up to
 * RTDB_RETRY.retryMs (5 s); past that it throws E2E_RTDB_UNAVAILABLE with a
 * `stackCut`, so a case with inconclusiveOnStackTimeout ends INCONCLUSIVE
 * (the stack did not answer) and any other case fails naming it, never as
 * I1. settleLive (when no `readY` is given) and joinShared's seed wait read
 * y this way; settleLive's `yRetries` counts the 503s it read through.
 *
 * JOINING. joinShared(ctx, {n}) is the canary's way in and any C-scenario's:
 * an owner and n−1 editors cast, the fixture published and shared, the
 * users made five contexts to a Chrome (ceil(n/5) Chromes) and signed in
 * through the UI five at a time, the document opened and edit mode entered
 * until "Shared": the first editor alone, until its seed is in the live
 * log, then the rest five at a time (simultaneous FIRST joins both seed:
 * S1, C4's own subject, so `seedFirst: false` when that is the point). A
 * peer that never shows "Shared", or a first seed that never reaches the
 * log, is a failed sync precondition: the case ends INCONCLUSIVE, never FAIL.
 * `body` publishes a generated document in place of the fixture (a cut of
 * one, a size); `enter: false` stops in reading mode, before any of the
 * entering and its seed precondition, for a case that enters each editor
 * itself (staggered joins, or a seed the rules refuse).
 * `role` is what every joiner but the owner is granted ("editor", or
 * "approver" for a case that decides suggestions in the app; a role that
 * cannot edit only with `enter: false`). `extra` casts accounts that never
 * get a browser (a suggester, a commenter, a link holder), granted their own
 * roles in the same grant request as the joiners; `notifications: false`
 * opts every account out of email. `beforeJoin` runs once the document is
 * published and shared and before any browser is made, so what it stages
 * (pending suggestions, comments) is there when the editors open it; its
 * value comes back as `staged`. joinAccountsPlan is that decision.
 * addMember(ctx, {owner, docId, name, role, device, k}) is ONE more person
 * for a document already joined, with what joinShared's N cannot have: its
 * own device (a phone), its own role or none at all (a link holder, who
 * opens the link with its key), and its own moment (after the others). It
 * is granted as joinShared grants (the same S16 stop on the operator path),
 * signed in through the UI, and left reading.
 *
 * The editors' grants (grantEditors) are, on a local stack, ONE POST /access
 * (grant.mjs shareMany: the product's one-request path, which invites every
 * new member into Mailpit), and on any other target, where that endpoint
 * would email them, share() per grant through the operator script
 * (scripts/set-access.mjs, which sends no email and writes the same RTDB
 * mirrors), one after another. `grantVia: "operator"` takes the production
 * path on a local stack too (the stack tree's script against its emulators),
 * which is how that path is proved without production; `grantVia: "access"`
 * anywhere but locally throws E2E_LOCAL_ONLY before anything is made.
 * Suspect S16 is real on that path, locally too: scripts/lib/firebase.mjs
 * starts its Admin app with no databaseURL, so firebase-admin cannot make a
 * Database handle ("Can't determine Firebase Database URL", with the
 * emulator host set or not), getRtdb() answers null, and set-access.mjs
 * never writes presenceAccess/editAccess. An editor without its edit mirror
 * still shows "Shared" while every write it makes to the live log is
 * PERMISSION_DENIED (measured: its keystrokes never reached the owner). So
 * on the operator path a mirror that reads back missing after the grants
 * (recorded in findings.jsonl as S16 by grant.mjs) ends the case
 * INCONCLUSIVE before any browser is made, naming S16: nothing the scenario
 * is about could be measured. The local POST /access path is unchanged.
 * `mirror: "write-missing"` (joinShared, addMember, grantEditors) does what
 * the plan prescribes instead: once every grant is made, the harness writes
 * the missing mirror from the document's record, as the product's grant
 * path would have (grant.mjs writeMirror: run documents and run accounts
 * only, its own narrow guard, a "mirror-written" finding beside S16's
 * "mirror-missing"), reads every missing grantee's mirror back, and goes
 * on; a mirror still missing after the write is the same INCONCLUSIVE. So
 * on production a C-scenario gets past S16's grant half and can measure its
 * runtime half (liveEditing outside the emulator). Only the operator path
 * writes: on POST /access the product writes the mirror itself, and that is
 * what a local case measures.
 *
 * INPUT CLOCKS. inputClocks(users) records, on every user's document frame,
 * the page-clock time of each `input` event from then on; read() gives each
 * peer's {n, first, last} and the span of them all. Under the RTDB proxy's
 * window (every client→database byte held for windowMs), edits whose span
 * is inside the window were all made before any of them could reach another
 * peer: the race proof of a typing race (C2, C3, C5). A frame replaced or a
 * page that navigated after arming would hide input, so read() names it.
 *
 * JOIN GATE. requireJoinersHeld(ctx, g, users, {key}) is the precondition of
 * a forced simultaneous join: every joiner held at join-before-bind by the
 * run that binds (see it for why the first held run is not that one).
 *
 * PROBES. typeProbe types a token and gives the page-clock time of its last
 * input event; probeArrivals arms every other peer first (frame.mjs
 * armArrival) and gives each peer's arrival delay: what I13 judges. With
 * `anywhere: true` each peer is armed anywhere in its body, for a body that
 * may be doubled (S1, S27), where the token can land in a second #id.
 */

import { readLiveLogsPatient } from "./live-log.mjs";
import { AssertionError } from "node:assert";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DOC_FRAME, armArrival, waitForArrival } from "./frame.mjs";
import { checkI1, checkI1Stable, readI1 } from "./invariants.mjs";

/** The plan's settle deadlines by N. */
export const SETTLE_DEADLINES_MS = Object.freeze({ 2: 15_000, 5: 20_000, 10: 30_000, 20: 60_000 });
/** The plan's settle conditions. */
export const SETTLE = Object.freeze({ i1Samples: 3, draftQuietMs: 3_000, yStableMs: 2_000, intervalMs: 250 });
/** How long a harness read of the Realtime Database is made again while it answers 503 (from the first 503), and how often. */
export const RTDB_RETRY = Object.freeze({ retryMs: 5_000, intervalMs: 500 });
const DRAFT_POST = Object.freeze({ method: "POST", path: "/draft" });
const GRANT_VIAS = Object.freeze(["access", "operator"]);
/** grant.mjs ROLES (kept here so that live.mjs loads grant.mjs only when it grants; selftest/live-join-roles.test.mjs compares the two). */
const JOIN_ROLES = Object.freeze(["viewer", "suggester", "editor", "approver"]);
/** The roles that edit live: grant.mjs EDITING_ROLES (an editAccess mirror; the product's isDocEditor). */
const LIVE_EDIT_ROLES = Object.freeze(["editor", "approver"]);
/** grant.mjs MIRROR_MODES (kept here for the same reason as JOIN_ROLES; selftest/mirror-write.test.mjs compares the two). */
const MIRROR_MODES = Object.freeze(["stop", "write-missing"]);

/** `mirror` checked (joinShared, addMember, grantEditors): "stop" or "write-missing", else a TypeError naming `who`. */
function checkMirrorMode(mirror, who) {
  if (!MIRROR_MODES.includes(mirror)) {
    throw new TypeError(`${who}: mirror is "stop" (the default: a mirror that reads back missing on the operator path is reported, nothing written) or "write-missing" (the harness writes it there: grant.mjs writeMirror), got ${JSON.stringify(mirror)}`);
  }
}

/** With mirror "write-missing", a stand-in `impl` must stand in for the write and its read-back too, so a self-test never reaches the real Database. */
function checkMirrorImpl(impl, mirror, who) {
  if (impl != null && mirror === "write-missing" && (typeof impl.writeMirror !== "function" || typeof impl.readMirror !== "function")) {
    throw new TypeError(`${who}: with mirror "write-missing", impl also has writeMirror and readMirror (a self-test's stand-ins for grant.mjs)`);
  }
}
/** A cast label: it becomes the start of the account's email (accounts.mjs localEmail). */
const CAST_LABEL_RE = /^[a-z][a-z0-9-]{0,23}$/;
const EXTRA_KEYS = Object.freeze(["role", "grant", "name"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The settle deadline for N peers: the plan's for the smallest listed N ≥ n (60 s past 20). */
export function settleDeadlineMs(n) {
  if (!Number.isInteger(n) || n < 1) throw new TypeError(`settleDeadlineMs: n is a whole number of peers, got ${JSON.stringify(n)}`);
  const listed = Object.keys(SETTLE_DEADLINES_MS).map(Number).sort((a, b) => a - b);
  const at = listed.find((k) => k >= n) ?? listed.at(-1);
  return SETTLE_DEADLINES_MS[at];
}

/** The latest time any of these users started or got an answer to a POST /draft, or null. */
export function lastDraftAt(users) {
  let last = null;
  for (const u of users) {
    for (const r of u.findResponses?.(DRAFT_POST) ?? []) {
      const t = Math.max(Number(r.t) || 0, Number(r.at) || 0);
      if (last === null || t > last) last = t;
    }
  }
  return last;
}

function yHash(value) {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

// --- reading the Realtime Database through a 503 --------------------------------------

/**
 * Whether `err` is the Realtime Database answering 503 to a harness read:
 * admin.mjs rtdbGet words it "rtdbGet <path>: 503 <body>" (the emulator's
 * body: "Firebase database instance is inactive"). An assertion never is,
 * whatever its message.
 */
export function isRtdbUnavailable(err) {
  if (!(err instanceof Error) || err instanceof AssertionError || err.code === "ERR_ASSERTION") return false;
  return /: 503\b/.test(String(err.message));
}

function rtdbUnavailableError(target, path, last, attempts, ms) {
  const db = target?.kind === "local" ? "the Database emulator" : "the Realtime Database";
  const why = `${db} answered 503 to ${attempts} read(s) of ${path} over ${Math.round(ms)} ms (${String(last?.message ?? last).split("\n")[0].slice(0, 240)})`;
  const err = new Error(`rtdbGetPatient: ${why}`);
  err.code = "E2E_RTDB_UNAVAILABLE";
  err.stackCut = why; // lib/test.mjs stackDidNotAnswer: the stack did not answer
  err.cause = last;
  err.attempts = attempts;
  err.path = path;
  err.ms = ms;
  return err;
}

/**
 * admin.mjs rtdbGet(target, path), made again while the Database answers
 * 503 (isRtdbUnavailable), `intervalMs` apart, until `retryMs` have passed
 * since the first 503. Resolves the value. Any other error is thrown at once,
 * as the read threw it. 503s that outlast `retryMs` throw
 * E2E_RTDB_UNAVAILABLE: `stackCut` (so lib/test.mjs stackDidNotAnswer names
 * it, and a case with inconclusiveOnStackTimeout ends INCONCLUSIVE), `cause`
 * (the last 503), `attempts`, `path`, `ms`; `retryMs: 0` throws it on the
 * first 503. `read(target, path)` replaces rtdbGet (a self-test's stand-in,
 * or another reader with rtdbGet's error words); `onRetry(err, attempt)` is
 * told of each 503 that will be read again (its own throw is ignored).
 */
export async function rtdbGetPatient(target, path, { retryMs = RTDB_RETRY.retryMs, intervalMs = RTDB_RETRY.intervalMs, read = null, onRetry = null, now = Date.now } = {}) {
  if (typeof path !== "string" || !path) throw new TypeError(`rtdbGetPatient: path is a database path, got ${JSON.stringify(path)}`);
  if (!Number.isFinite(retryMs) || retryMs < 0) throw new TypeError(`rtdbGetPatient: retryMs is a number of ms (0 or more), got ${JSON.stringify(retryMs)}`);
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new TypeError(`rtdbGetPatient: intervalMs is a number of ms (0 or more), got ${JSON.stringify(intervalMs)}`);
  if (read != null && typeof read !== "function") throw new TypeError("rtdbGetPatient: read is (target, path) => value");
  if (onRetry != null && typeof onRetry !== "function") throw new TypeError("rtdbGetPatient: onRetry is (err, attempt) => void");
  const get = read ?? (await import("./admin.mjs")).rtdbGet;
  let since = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await get(target, path);
    } catch (err) {
      if (!isRtdbUnavailable(err)) throw err;
      const t = now();
      since ??= t;
      if (t - since >= retryMs) throw rtdbUnavailableError(target, path, err, attempt, t - since);
      try {
        onRetry?.(err, attempt);
      } catch {}
      await sleep(intervalMs);
    }
  }
}

// --- settling ----------------------------------------------------------------------------

/**
 * Wait until the live session of `users` on `docId` has settled (see
 * SETTLE), within the plan's deadline for `n` (default users.length).
 * Resolves {ms, hash, samples, saveStates, shareStates, lastDraftAt,
 * yEntries, yRetries, peers, alone}; throws an AssertionError "I1: …" naming
 * what was still unsettled at the deadline.
 *
 * One user is a live session too (one editor beside agents): every condition
 * holds as for N, except that I1's convergence, which needs two peers, is
 * replaced by its body's stability (the same hash on 3 consecutive samples);
 * `alone` is true and `hash` is that body's. No user is a TypeError.
 *
 * `minLength` (default 1) is the shortest body that counts: equal EMPTY bodies
 * are not convergence. `requireShared` (default true) asks every peer that
 * entered edit to show "Shared". `readY` (async () => the value of
 * status/{d}/y) and `now` are for self-tests and a spec's own reader.
 * `readBodies(users)` may provide authored-body samples for idle readers whose
 * presence overlays differ. Only the sampling changes; every deadline and
 * quiet/save/log condition still applies. By default the full live body is read.
 * By default y is read as the emulator's admin on the users' target, again on a
 * 503 (rtdbGetPatient: `yRetries` counts those; 503s past RTDB_RETRY.retryMs
 * throw E2E_RTDB_UNAVAILABLE, the stack not answering, never an I1 failure).
 */
export async function settleLive(users, { docId, n = users?.length, deadlineMs = null, readY = null, now = Date.now, intervalMs = SETTLE.intervalMs, minLength = 1, requireShared = true, readBodies = readI1 } = {}) {
  if (!Array.isArray(users) || users.length < 1) throw new TypeError("settleLive: give at least one user (two or more are judged on I1; one on its body's stability)");
  if (typeof docId !== "string" || !docId) throw new TypeError("settleLive: docId is required");
  if (!Number.isInteger(minLength) || minLength < 0) throw new TypeError(`settleLive: minLength is a whole number of characters, got ${JSON.stringify(minLength)}`);
  const limit = deadlineMs ?? settleDeadlineMs(n);
  const target = users[0]?.pool?.target ?? null;
  let yRetries = 0;
  const getY = readY ?? (() => readLiveLogsPatient(target, docId, { onRetry: () => (yRetries += 1) }));
  const alone = users.length === 1;
  const t0 = now();
  const series = [];
  const sawEditing = new Set(); // users seen with a save state during this wait
  let lastY = null;
  let yChangedAt = t0;
  let last = null;
  for (;;) {
    const samples = await readBodies(users);
    series.push(samples);
    if (series.length > SETTLE.i1Samples) series.shift();
    const i1 = alone ? loneBodySteady(series, SETTLE.i1Samples) : checkI1Stable(series, { samples: SETTLE.i1Samples });
    const saveStates = Object.fromEntries(await Promise.all(users.map(async (u) => [u.name, await u.saveState()])));
    const shareStates = Object.fromEntries(await Promise.all(users.map(async (u) => [u.name, typeof u.shareState === "function" ? await u.shareState() : null])));
    for (const [name, st] of Object.entries(saveStates)) if (st != null) sawEditing.add(name);
    const editing = users.filter((u) => u.inEdit === true || sawEditing.has(u.name)).map((u) => u.name);
    const busy = Object.entries(saveStates).filter(([, st]) => st === "dirty" || st === "saving");
    const failed = Object.entries(saveStates).filter(([, st]) => st === "error").map(([name]) => name);
    const left = editing.filter((name) => saveStates[name] == null);
    const unshared = requireShared ? editing.filter((name) => shareStates[name] != null && shareStates[name] !== "shared").map((name) => [name, shareStates[name]]) : [];
    const short = samples.filter((x) => !(Number(x.length) >= minLength));
    const draftAt = lastDraftAt(users);
    const y = await getY();
    const h = yHash(y);
    const t = now();
    if (h !== lastY) {
      lastY = h;
      yChangedAt = t;
    }
    const draftQuiet = draftAt === null || t - draftAt >= SETTLE.draftQuietMs;
    const yStable = t - yChangedAt >= SETTLE.yStableMs;
    last = { i1, now: alone ? loneBodyRead(samples) : checkI1(samples), saveStates, shareStates, busy, failed, left, unshared, short, draftAt, draftQuiet, yStable, yChangedAt, yEntries: y && typeof y === "object" ? Object.keys(y).length : 0, t };
    if (i1.ok && busy.length === 0 && failed.length === 0 && left.length === 0 && unshared.length === 0 && short.length === 0 && draftQuiet && yStable) {
      return { ms: t - t0, hash: i1.hash, samples: series.length, saveStates, shareStates, lastDraftAt: draftAt, yEntries: last.yEntries, yRetries, peers: users.length, alone };
    }
    if (t - t0 >= limit) break;
    await sleep(intervalMs);
  }
  const why = [];
  // The latest sample says what is wrong now; the series only that it kept changing.
  if (!last.now.ok) why.push(last.now.failures.join("; "));
  else if (!last.i1.ok) why.push(alone ? `its body was not the same on ${SETTLE.i1Samples} samples in a row: ${last.i1.failures.join("; ")}` : `converged on the last sample, but not on ${SETTLE.i1Samples} in a row: ${last.i1.failures.join("; ")}`);
  if (last.short.length) {
    const lengths = [...new Set(last.short.map((x) => Number(x.length) || 0))];
    why.push(`the body of ${last.short.map((x) => x.name).join(", ")} is ${lengths.join("/")} char(s), less than ${minLength}`);
  }
  if (last.busy.length) why.push(`still ${last.busy.map(([u, st]) => `${u} ${st}`).join(", ")}`);
  if (last.failed.length) why.push(`save state "error" on ${last.failed.join(", ")} (a POST /draft failed; nothing retries it without new input)`);
  if (last.left.length) why.push(`${last.left.join(", ")} entered edit and shows no save state (it left edit mode)`);
  if (last.unshared.length) why.push(`not "Shared": ${last.unshared.map(([u, st]) => `${u} ${st}`).join(", ")}`);
  if (!last.draftQuiet) why.push(`a POST /draft ${Math.round(last.t - last.draftAt)} ms before the deadline (needs ${SETTLE.draftQuietMs} ms quiet)`);
  if (!last.yStable) why.push(`status/${docId}/y changed ${Math.round(last.t - last.yChangedAt)} ms before the deadline (needs ${SETTLE.yStableMs} ms stable; ${last.yEntries} entries)`);
  if (yRetries > 0) why.push(`(status/${docId}/y answered 503 ${yRetries} time(s) while waiting, each read again)`);
  throw new AssertionError({ message: `I1: the live session of ${users.length} peer(s) on ${docId} did not settle within ${limit} ms (N=${n}${alone ? "; one peer: its body's stability in place of convergence" : ""}): ${why.join("; ")}`, operator: "I1" });
}

/** One user's I1 sample, judged on its own: a hash read. */
function loneBodyRead(samples) {
  const [s] = samples;
  const failures = typeof s?.hash === "string" && s.hash ? [] : [`${s?.name ?? "the peer"} gave no hash`];
  return { ok: failures.length === 0, failures, hash: failures.length === 0 ? s.hash : null };
}

/** One user's body over the last `samples` samples: read each time, and the same hash every time (I1's stability, without the convergence one peer cannot show). */
function loneBodySteady(series, samples) {
  const tail = series.slice(-samples);
  const failures = [];
  if (tail.length < samples) failures.push(`${tail.length} of ${samples} sample(s) taken`);
  const reads = tail.map((x) => loneBodyRead(x));
  reads.forEach((r, k) => {
    if (!r.ok) failures.push(`sample ${series.length - tail.length + k + 1}: ${r.failures.join("; ")}`);
  });
  const hashes = new Set(reads.filter((r) => r.ok).map((r) => r.hash));
  if (failures.length === 0 && hashes.size !== 1) failures.push(`${hashes.size} different hashes across ${samples} samples of ${tail[0]?.[0]?.name ?? "the peer"}: still changing`);
  return { ok: failures.length === 0, failures, hash: failures.length === 0 ? [...hashes][0] : null };
}

// --- joining ---------------------------------------------------------------------

/**
 * What joinShared publishes: {options, label}. `options` go to seed.mjs
 * publish beside the title: {body, filename} when a body is given (it wins
 * over the fixture; filename "index.html" unless named), else {fixture} as
 * before (and `filename` only when named). seed.mjs publish reads a fixture
 * IN PLACE of a body, so the fixture must not reach it beside one. `label`
 * names it in a step. A body is a non-empty string or Buffer.
 */
export function joinPublishOptions({ fixture = "crdt-paragraphs.html", body = null, filename = null } = {}) {
  if (filename != null && (typeof filename !== "string" || !filename)) throw new TypeError(`joinShared: filename is a file name, got ${JSON.stringify(filename)}`);
  if (body != null) {
    const bytes = Buffer.isBuffer(body) ? body.length : typeof body === "string" ? Buffer.byteLength(body) : -1;
    if (bytes < 0) throw new TypeError(`joinShared: body is the document's bytes (a string or a Buffer), got ${typeof body}`);
    if (bytes === 0) throw new TypeError("joinShared: body is empty");
    const name = filename ?? "index.html";
    return { options: { body, filename: name }, label: `a ${bytes >= 10_240 ? `${Math.round(bytes / 1024)} KB` : `${bytes}-byte`} ${name}` };
  }
  if (typeof fixture !== "string" || !fixture) throw new TypeError(`joinShared: give a fixture or a body, got fixture ${JSON.stringify(fixture)}`);
  return { options: filename != null ? { fixture, filename } : { fixture }, label: fixture };
}

/**
 * How the editors are granted on `target`: "access" (ONE POST /access,
 * grant.mjs shareMany: local only, it emails every new member) or "operator"
 * (share() per grant through the operator script: no email). `via` null
 * picks by target: "access" on a local stack, "operator" anywhere else.
 * "access" on any other target throws E2E_LOCAL_ONLY; anything but the two
 * names (or null) is a TypeError.
 */
export function joinGrantVia(target, via = null) {
  if (via != null && !GRANT_VIAS.includes(via)) throw new TypeError(`grantVia is "access", "operator" or null (by target), got ${JSON.stringify(via)}`);
  const local = target?.kind === "local";
  const chosen = via ?? (local ? "access" : "operator");
  if (chosen === "access" && !local) {
    const err = new Error(`grantVia: local only — "access" is ONE POST /access, which emails every new member (the guard refuses it on a ${target?.kind ?? "non-local"} target); "operator", share() per grant through the operator script, is the path there`);
    err.code = "E2E_LOCAL_ONLY";
    throw err;
  }
  return chosen;
}

/**
 * Give each of `accounts` (accounts or emails, in order) `role` on `doc` as
 * joinShared does (joinGrantVia): "access" is one grant.mjs shareMany (one
 * POST /access, every grant in it); "operator" is grant.mjs share() with
 * via "operator" for each account, ONE AFTER ANOTHER (each script run
 * rewrites the document's grant lists, so two at once could lose one).
 * Either verifies each grant's RTDB mirror as grant.mjs does (a missing one
 * is recorded in findings.jsonl, S16). No accounts: nothing is sent.
 * Resolves {via, requests, results, missing}: `requests` = POSTs or script
 * runs, `results` grant.mjs's answers in order, `missing` = [{email, mirror}]
 * for each account whose mirror was read back and is not what its role needs
 * (grant.mjs readMirror's `ok` false; an unread mirror is not counted).
 * `impl` = {share, shareMany} replaces grant.mjs (a self-test's stand-in).
 * `roles` (one per account, in order) gives each account its own role in
 * place of `role`: still ONE shareMany locally (mixed roles in one POST
 * /access), share() per account with its own role on the operator path. A
 * `roles` that is not one non-empty string per account is a TypeError
 * before anything is sent; null (the default) is `role` for everyone.
 *
 * `mirror` (grant.mjs MIRROR_MODES): "stop", the default, is all of the
 * above and the result has exactly those four keys. "write-missing" adds
 * `mirrored`: on the operator path, when any account's mirror read back
 * missing, ONCE after every grant, grant.mjs writeMirror(target, {doc})
 * writes the document's mirror from its record and each missing account's
 * mirror is read again (grant.mjs readMirror, with its role):
 * `mirrored` = {written: true, docId, write (writeMirror's answer),
 * accounts: [{email, role, before, after}], ok (every `after` ok)}. Nothing
 * missing, or the access path (the product writes the mirror there itself),
 * is `mirrored: null` and nothing is written. `missing` still lists what
 * read back missing after the grants (the S16 evidence). writeMirror's
 * errors (E2E_GUARD, E2E_MIRROR) propagate. With a stand-in `impl`,
 * "write-missing" needs its writeMirror and readMirror too (TypeError
 * before anything is sent).
 */
export async function grantEditors(target, { owner, doc, accounts, role = "editor", roles = null, via = null, timeoutMs = 120_000, impl = null, mirror = "stop" } = {}) {
  const how = joinGrantVia(target, via);
  if (!Array.isArray(accounts)) throw new TypeError("grantEditors: accounts is a list of accounts (or emails)");
  if (impl != null && (typeof impl.share !== "function" || typeof impl.shareMany !== "function")) throw new TypeError("grantEditors: impl is {share, shareMany} (a self-test's stand-in)");
  checkMirrorMode(mirror, "grantEditors");
  checkMirrorImpl(impl, mirror, "grantEditors");
  if (roles != null && (!Array.isArray(roles) || roles.length !== accounts.length || roles.some((r) => typeof r !== "string" || !r))) {
    throw new TypeError(`grantEditors: roles is one role per account (${accounts.length}), in order, got ${JSON.stringify(roles)}`);
  }
  const writes = mirror === "write-missing";
  if (accounts.length === 0) return { via: how, requests: 0, results: [], missing: [], ...(writes ? { mirrored: null } : {}) };
  const g = impl ?? (await import("./grant.mjs"));
  const roleOf = (i) => (roles == null ? role : roles[i]);
  const emailOf = (a) => String(typeof a === "string" ? a : a?.email).toLowerCase();
  const missingOf = (mirrors) => accounts.flatMap((a, i) => (mirrors[i] && mirrors[i].ok === false ? [{ email: emailOf(a), mirror: mirrors[i] }] : []));
  if (how === "access") {
    const r = await g.shareMany(target, { owner, doc, grants: accounts.map((a, i) => ({ account: a, role: roleOf(i) })), timeoutMs });
    return { via: how, requests: 1, results: [r], missing: missingOf(Array.isArray(r?.mirrors) ? r.mirrors : []), ...(writes ? { mirrored: null } : {}) };
  }
  const results = [];
  for (const [i, account] of accounts.entries()) results.push(await g.share(target, { owner, doc, account, role: roleOf(i), via: "operator", timeoutMs }));
  const mirrors = results.map((r) => r?.mirror);
  const missing = missingOf(mirrors);
  if (!writes) return { via: how, requests: results.length, results, missing };
  if (missing.length === 0) return { via: how, requests: results.length, results, missing, mirrored: null };
  // ONE write, after every grant: it replaces both nodes with what the record says now.
  const docId = typeof doc === "string" ? doc : doc?.docId;
  const write = await g.writeMirror(target, { doc: docId });
  const reread = [];
  for (const [i, account] of accounts.entries()) {
    if (!(mirrors[i] && mirrors[i].ok === false)) continue;
    const email = emailOf(account);
    reread.push({ email, role: roleOf(i), before: mirrors[i], after: await g.readMirror(target, docId, email, roleOf(i)) });
  }
  return { via: how, requests: results.length, results, missing, mirrored: { written: true, docId, write, accounts: reread, ok: reread.every((a) => a.after?.ok === true) } };
}

/** The joiners' accounts whose mirror is still not what they need after the harness wrote it (grantEditors' `mirrored`), or every missing one when nothing was written. */
function stillMissing(granted, emails) {
  const missing = granted.missing.filter((m) => emails.has(m.email));
  if (!granted.mirrored) return missing.map((m) => ({ email: m.email, after: null }));
  return granted.mirrored.accounts.filter((a) => emails.has(a.email) && a.after?.ok !== true).map((a) => ({ email: a.email, after: a.after ?? null }));
}

/**
 * Who joinShared casts and grants, decided (and checked) before anything is
 * made: {labels, roles, extra, cast}.
 *   labels  the cast labels, in order: "owner", "<role>-p2" … "<role>-pN",
 *           then each extra's (its `name`, else its role). With the default
 *           role these are exactly the old ones ("editor-pK").
 *   roles   one role per grantee (the joiners p2…pN, then each extra with
 *           `grant`), for grantEditors: null when no extra is granted, so
 *           the joiners' grant is the old call (`role` for everyone).
 *   extra   [{name, role, grant}] in order: `role` one of the four (when
 *           granted; a label only, when `grant: false`), `name` the cast label.
 *   cast    cast()'s options beyond http: {notifications} when it was given.
 * TypeError: n not a whole number ≥ 1; a role that is not viewer, suggester,
 * editor or approver; joiners in a role that cannot edit live while `enter`
 * (they would never show "Shared"); `extra` not a list of plain objects with
 * only role, grant and name; a label that is not a short lower-case word
 * (a-z, 0-9, "-": it starts the account's email); `notifications` not a
 * boolean.
 */
export function joinAccountsPlan({ n, role = "editor", extra = [], enter = true, notifications = undefined } = {}) {
  if (!Number.isInteger(n) || n < 1) throw new TypeError(`joinShared: n is a whole number of peers, got ${JSON.stringify(n)}`);
  if (!JOIN_ROLES.includes(role)) throw new TypeError(`joinShared: role is one of ${JOIN_ROLES.join(", ")}, got ${JSON.stringify(role)}`);
  if (enter && n > 1 && !LIVE_EDIT_ROLES.includes(role)) throw new TypeError(`joinShared: joiners granted ${role} cannot enter edit (only ${LIVE_EDIT_ROLES.join(" or ")} edit live); pass enter: false to open the document in reading mode`);
  if (notifications !== undefined && typeof notifications !== "boolean") throw new TypeError(`joinShared: notifications is true or false, got ${JSON.stringify(notifications)}`);
  if (!Array.isArray(extra)) throw new TypeError(`joinShared: extra is a list of {role, grant, name}, got ${JSON.stringify(extra)}`);
  const extras = extra.map((e, i) => {
    const who = `joinShared: extra[${i}]`;
    if (e === null || typeof e !== "object" || Array.isArray(e)) throw new TypeError(`${who} is {role, grant, name}, got ${JSON.stringify(e)}`);
    const unknown = Object.keys(e).filter((k) => !EXTRA_KEYS.includes(k));
    if (unknown.length) throw new TypeError(`${who} has ${unknown.join(", ")}: an extra is {role, grant = true, name = role}`);
    const grant = e.grant === undefined ? true : e.grant;
    if (typeof grant !== "boolean") throw new TypeError(`${who}.grant is true or false, got ${JSON.stringify(e.grant)}`);
    if (grant ? !JOIN_ROLES.includes(e.role) : typeof e.role !== "string" || !CAST_LABEL_RE.test(e.role)) {
      throw new TypeError(`${who}.role is ${grant ? `one of ${JOIN_ROLES.join(", ")}` : "a label (an ungranted account: a-z, 0-9, -)"}, got ${JSON.stringify(e.role)}`);
    }
    const name = e.name ?? e.role;
    if (typeof name !== "string" || !CAST_LABEL_RE.test(name)) throw new TypeError(`${who}.name is a cast label (a-z, 0-9, -; at most 24), got ${JSON.stringify(e.name)}`);
    return { name, role: e.role, grant };
  });
  const labels = [...Array.from({ length: n }, (_, i) => (i === 0 ? "owner" : `${role}-p${i + 1}`)), ...extras.map((e) => e.name)];
  const granted = extras.filter((e) => e.grant);
  const roles = granted.length > 0 ? [...Array.from({ length: n - 1 }, () => role), ...granted.map((e) => e.role)] : null;
  return { labels, roles, extra: extras, cast: notifications === undefined ? {} : { notifications } };
}

/**
 * N editors on one document, all "Shared". `ctx` is the scenario's. Resolves
 * {docId, owner (the owner's session), accounts, users, names, joinMs,
 * grantVia, role, extra, staged}. users[0] is the owner; accounts[i] is
 * users[i]'s. A peer that never shows "Shared" within `sharedMs` ends the
 * case INCONCLUSIVE (a failed sync precondition).
 *
 * The document is `fixture`, or `body` (a generated document: a string or
 * Buffer, published as `filename`, "index.html" by default), which wins over
 * the fixture (joinPublishOptions).
 *
 * WHO (joinAccountsPlan, checked before anything is made): every joiner but
 * the owner is granted `role` ("editor"; "approver" for a case that decides
 * suggestions in the app; a role that cannot edit only with `enter: false`).
 * `extra` = [{role, grant = true, name = role}] casts accounts that get no
 * browser (a suggester, a commenter; `grant: false` a link holder), each
 * granted its own role in the SAME grant request as the joiners; they come
 * back as `extra` = [{name, role, grant, account}]. `notifications: false`
 * casts every account opted out of email (cast()'s option).
 *
 * The grants go through grantEditors: one POST /access on a local stack,
 * share() per grant through the operator script anywhere else (no email);
 * `grantVia` ("access" | "operator") forces one, checked before anything is
 * made (joinGrantVia). The result's `grantVia` says which ran. On the
 * operator path, a JOINER whose RTDB mirror reads back missing after its
 * grant (suspect S16: its live writes would be refused) ends the case
 * INCONCLUSIVE before any browser is made. An extra's missing mirror does
 * not (it never writes the live log; grant.mjs records it in findings.jsonl).
 *
 * `beforeJoin({docId, owner, accounts, extra, publish})` runs once the
 * document is published and shared, before any browser is made, so what it
 * stages (pending suggestions, comments, a second version) is there when the
 * editors open it. `publish` is seed.mjs publish's answer. Its value comes
 * back as `staged` (undefined without one); a throw propagates.
 *
 * `enter: false` stops after opening (reading mode), before any entering or
 * its seed precondition; `waitShared: false` enters edit without waiting for
 * "Shared"; `seedFirst: false` lets the first five enter at once (an empty
 * live log: they may all seed).
 *
 * `impl` (a self-test's stand-ins, all six or none): {cast, openSession,
 * publish, signInMany, share, shareMany} in place of accounts.mjs,
 * session.mjs, seed.mjs, browser.mjs and grant.mjs; with `mirror:
 * "write-missing"`, writeMirror and readMirror too.
 *
 * `mirror: "write-missing"` (default "stop"): on the operator path, a
 * joiner's mirror that reads back missing (S16) is written by the harness
 * from the document's record once every grant is made (grantEditors'
 * `mirror`, grant.mjs writeMirror), read back, and the join goes on, with a
 * step saying so; only a joiner's mirror STILL missing after the write, or
 * a write the database did not take (E2E_MIRROR), ends the case
 * INCONCLUSIVE, before any browser is made. The result then also has
 * `mirrored` (grantEditors' answer: null when nothing was written). The
 * access path is the same either way.
 */
export async function joinShared(ctx, { n, fixture = "crdt-paragraphs.html", body = null, filename = null, title = "e2e live", batch = 5, enter = true, waitShared = true, seedFirst = true, sharedMs = 90_000, openMs = 90_000, grantVia = null, role = "editor", extra = [], notifications = undefined, beforeJoin = null, impl = null, mirror = "stop" } = {}) {
  if (!Number.isInteger(n) || n < 1) throw new TypeError(`joinShared: n is a whole number of peers, got ${JSON.stringify(n)}`);
  const doc = joinPublishOptions({ fixture, body, filename });
  const plan = joinAccountsPlan({ n, role, extra, enter, notifications });
  if (beforeJoin != null && typeof beforeJoin !== "function") throw new TypeError("joinShared: beforeJoin is an async function ({docId, owner, accounts, extra, publish}) => staged");
  const IMPL = ["cast", "openSession", "publish", "signInMany", "share", "shareMany"];
  if (impl != null && IMPL.some((k) => typeof impl[k] !== "function")) throw new TypeError(`joinShared: impl is {${IMPL.join(", ")}} (a self-test's stand-ins)`);
  checkMirrorMode(mirror, "joinShared");
  checkMirrorImpl(impl, mirror, "joinShared");
  const via = joinGrantVia(ctx.target, grantVia);
  const [{ cast }, { openSession }, { publish }, { signInMany }] = impl
    ? [impl, impl, impl, impl]
    : await Promise.all([import("./accounts.mjs"), import("./session.mjs"), import("./seed.mjs"), import("./browser.mjs")]);
  const t0 = Date.now();
  const names = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const others = plan.extra.length ? ` and ${plan.extra.map((e) => (e.grant ? `a ${e.role}` : `an ungranted ${e.name}`)).join(", ")} (no browser)` : "";
  const writesMirror = mirror === "write-missing" && via === "operator";
  ctx.step(`cast an owner and ${n - 1} ${role}(s)${others}; the owner publishes ${doc.label} and shares it${role === "editor" ? " for editing" : ` (${role})`}${n > 1 && via === "operator" ? ", one grant at a time through the operator script" : ""}${writesMirror ? "; an RTDB mirror the script leaves missing (S16) is written by the harness" : ""}`);
  const all = await cast(ctx.target, plan.labels, { http: ctx.http({ actor: "harness" }), ...plan.cast });
  const accounts = all.slice(0, n);
  const extras = plan.extra.map((e, i) => ({ ...e, account: all[n + i] }));
  const owner = await openSession(ctx.target, accounts[0], { timeoutMs: 120_000 });
  const up = await publish(owner.http, { ...doc.options, title, name: "live", timeoutMs: 120_000 });
  const docId = up.docId;
  const grantees = [...accounts.slice(1), ...extras.filter((e) => e.grant).map((e) => e.account)];
  let mirrored = null;
  if (grantees.length > 0) {
    const granted = await grantEditors(ctx.target, { owner, doc: docId, accounts: grantees, role, roles: plan.roles, via, timeoutMs: 120_000, impl: impl ? { share: impl.share, shareMany: impl.shareMany, writeMirror: impl.writeMirror, readMirror: impl.readMirror } : null, mirror }).catch((err) => {
      if (err?.code === "E2E_MIRROR") ctx.inconclusive(`the sync precondition did not hold: after scripts/set-access.mjs granted ${docId}, an RTDB mirror read back missing (suspect S16, recorded in findings.jsonl) and the harness could not write it: ${err.message}`);
      throw err;
    });
    const joiners = new Set(accounts.slice(1).map((a) => String(a.email).toLowerCase()));
    const missing = granted.missing.filter((m) => joiners.has(m.email));
    if (via === "operator" && missing.length > 0) {
      if (mirror === "stop") ctx.inconclusive(`the sync precondition did not hold: after scripts/set-access.mjs granted ${docId}, the RTDB mirror (presenceAccess/editAccess) of ${missing.map((m) => m.email).join(", ")} is missing (suspect S16, recorded in findings.jsonl), so their writes to the live log would be refused while they show "Shared"`);
      const still = stillMissing(granted, joiners);
      if (still.length > 0) {
        ctx.inconclusive(`the sync precondition did not hold: after scripts/set-access.mjs granted ${docId}, the RTDB mirror (presenceAccess/editAccess) of ${missing.map((m) => m.email).join(", ")} was missing (suspect S16, recorded in findings.jsonl), and after the harness wrote it from docs/${docId} the mirror of ${still.map((s) => s.email).join(", ")} still reads ${JSON.stringify(still.map((s) => s.after))}, so their writes to the live log would be refused while they show "Shared"`);
      }
      ctx.step(`suspect S16: scripts/set-access.mjs left the RTDB mirror of ${missing.map((m) => m.email).join(", ")} missing (recorded in findings.jsonl); the harness wrote presenceAccess/${docId} and editAccess/${docId} from docs/${docId}, as the product's grant path does (grant.mjs writeMirror), and read it back`);
    }
    mirrored = granted.mirrored ?? null;
  }
  let staged;
  if (beforeJoin) {
    ctx.step(`before anyone opens ${docId}: the case stages what the editors must find there`);
    staged = await beforeJoin({ docId, owner, accounts, extra: extras, publish: up });
  }
  ctx.step(`${n} user(s) in ${Math.ceil(n / batch)} Chrome(s), ${batch} contexts each; sign in through the UI ${batch} at a time`);
  const users = await ctx.users.many(n, { batch, names, consent: "denied" });
  await signInMany(users, accounts, { batch });
  ctx.step(`open ${docId}, ${batch} at a time`);
  for (let i = 0; i < users.length; i += batch) await Promise.all(users.slice(i, i + batch).map((u) => u.open(docId, { timeout: openMs })));
  if (enter) {
    const enterOne = async (u) => {
      try {
        await u.enterEdit({ waitShared, timeout: sharedMs });
      } catch (err) {
        const state = await u.shareState().catch(() => "unknown");
        if (waitShared && state !== "shared" && /share-state|within|Timeout/i.test(String(err?.message))) {
          ctx.inconclusive(`the sync precondition did not hold: ${u.name} never showed "Shared" within ${sharedMs} ms (share state ${JSON.stringify(state)})`);
        }
        throw err;
      }
    };
    let rest = users;
    if (seedFirst && waitShared && users.length > 1) {
      ctx.step(`${users[0].name} enters edit alone and seeds the live log`);
      await enterOne(users[0]);
      const deadline = Date.now() + sharedMs;
      for (;;) {
        const y = await readLiveLogsPatient(ctx.target, docId);
        if (y && typeof y === "object" && Object.keys(y).length > 0) break;
        if (Date.now() >= deadline) ctx.inconclusive(`the sync precondition did not hold: ${users[0].name}'s seed never reached status/${docId}/y within ${sharedMs} ms`);
        await sleep(200);
      }
      rest = users.slice(1);
    }
    ctx.step(`${rest.length === users.length ? "enter" : "the rest enter"} edit mode, ${batch} at a time${waitShared ? ', each until "Shared"' : ""}`);
    for (let i = 0; i < rest.length; i += batch) await Promise.all(rest.slice(i, i + batch).map(enterOne));
  }
  return { docId, owner, accounts, users, names, joinMs: Date.now() - t0, grantVia: via, role, extra: extras, staged, ...(mirror === "stop" ? {} : { mirrored }) };
}

/** The modules addMember calls that a self-test may replace (all three or none). */
const ADD_MEMBER_IMPL = Object.freeze(["cast", "share", "shareMany"]);

/**
 * One more person for a document already published (joinShared's, or a
 * case's own), with a browser of its own, left READING: an account cast for
 * it, granted `role` on `docId` (null: no grant at all, a link holder), a
 * user made on `device`, signed in through the UI, and the document opened
 * (with the link key `k`, `?k=`). It never presses Edit: a case enters edit
 * itself, when its scenario says so (u.enterEdit, or u.awaitEdit after a
 * press made elsewhere). Resolves {account, user, role, grantVia, granted,
 * signIn, opened}.
 *
 * For what joinShared's N do not cover: one of the N on a phone (C18), an
 * editor who stays reading (C22), an account with no grant that opens the
 * link with its key (C23), a person who arrives after the others (a serial
 * control, C4b's joiner with `open: false`).
 *
 *   name     the User's name ("p5"), not already a user of this case (its
 *            evidence files are named after it).
 *   role     "editor" (the default), "approver", "viewer" or "suggester",
 *            granted as joinShared grants (grantEditors: ONE POST /access
 *            locally, share() through the operator script anywhere else, or
 *            `via` "access" | "operator", joinGrantVia's rules), or null for
 *            an account with no grant (`via` is then a TypeError).
 *   label    the cast label, `<role>-<name>` (a link holder `link-<name>`)
 *            unless given: a short lower-case word (a-z, 0-9, "-"), since it
 *            starts the account's email.
 *   device   lib/browser.mjs's {width, height, touch} (a 400×800 touch phone),
 *            null for the desktop.
 *   k        the link key the document is opened with (`?k=`); never in a step.
 *   open     false: signed in, the document NOT opened (`k` is then a
 *            TypeError); `opened` is null.
 *   openMs   open()'s timeout (90 s, as joinShared's).
 *   notifications  cast()'s option (false: the account opted out of email);
 *            left out, cast gets {http} alone.
 *   impl     {cast, share, shareMany} stand-ins (a self-test's); with
 *            `mirror: "write-missing"`, writeMirror and readMirror too.
 *   mirror   "stop" (the default) or "write-missing": on the operator path,
 *            a mirror that reads back missing (S16) is written by the
 *            harness from the record and read back (grantEditors' `mirror`,
 *            grant.mjs writeMirror), and only one STILL not what `role`
 *            needs, or a write the database did not take, stops the case;
 *            `granted.mirrored` says what was written.
 *
 * Order: every argument is checked before anything is cast (TypeError; the
 * device by lib/browser.mjs checkDevice; E2E_LOCAL_ONLY for `via` "access"
 * off a local stack). Then the cast, the grant, and only then the browser.
 * On the operator path a mirror that reads back not what `role` needs (the
 * product's presenceAccess, and for an editing role editAccess: suspect S16,
 * recorded in findings.jsonl by grant.mjs) ends the case INCONCLUSIVE before
 * any browser is made: whatever the role, this person's page writes its
 * presence. The local path does not check it, as joinShared does not. A
 * sign-in that is not "ok" throws (User.signInUi). The user comes from
 * `ctx.users` with consent "denied", as joinShared's do, and through the
 * pool's memory gate.
 */
export async function addMember(ctx, { owner = null, docId, name, role = "editor", label = null, device = null, k = null, via = null, open = true, openMs = 90_000, notifications = undefined, timeoutMs = 120_000, impl = null, mirror = "stop" } = {}) {
  if (ctx === null || typeof ctx !== "object" || !ctx.target || typeof ctx.step !== "function" || typeof ctx.http !== "function" || typeof ctx.inconclusive !== "function") {
    throw new TypeError("addMember: ctx is the scenario's (target, step, http, users, inconclusive)");
  }
  if (typeof docId !== "string" || !docId) throw new TypeError(`addMember: docId is the document's id, got ${JSON.stringify(docId)}`);
  if (typeof name !== "string" || !name || name.length > 64 || name.trim() !== name) throw new TypeError(`addMember: name is the user's name (1–64 characters, no surrounding space), got ${JSON.stringify(name)}`);
  if (role !== null && !JOIN_ROLES.includes(role)) throw new TypeError(`addMember: role is one of ${JOIN_ROLES.join(", ")}, or null (no grant at all: a link holder), got ${JSON.stringify(role)}`);
  const castLabel = label ?? `${role ?? "link"}-${name}`;
  if (typeof castLabel !== "string" || !CAST_LABEL_RE.test(castLabel)) {
    throw new TypeError(`addMember: the cast label ${JSON.stringify(castLabel)} is not a short lower-case word (a-z, 0-9, "-"; at most 24: it starts the account's email)${label == null ? "; pass label" : ""}`);
  }
  if (k !== null && (typeof k !== "string" || !k)) throw new TypeError("addMember: k is the document's link key (a non-empty string) or null");
  if (typeof open !== "boolean") throw new TypeError(`addMember: open is true or false, got ${JSON.stringify(open)}`);
  if (!open && k !== null) throw new TypeError("addMember: k is the key the document is opened with, and open: false opens nothing");
  if (typeof openMs !== "number" || !Number.isFinite(openMs) || openMs <= 0) throw new TypeError(`addMember: openMs is a number of ms above 0, got ${JSON.stringify(openMs)}`);
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError(`addMember: timeoutMs is a number of ms above 0, got ${JSON.stringify(timeoutMs)}`);
  if (notifications !== undefined && typeof notifications !== "boolean") throw new TypeError(`addMember: notifications is true or false, got ${JSON.stringify(notifications)}`);
  if (impl != null && ADD_MEMBER_IMPL.some((f) => typeof impl[f] !== "function")) throw new TypeError(`addMember: impl is {${ADD_MEMBER_IMPL.join(", ")}} (a self-test's stand-ins)`);
  checkMirrorMode(mirror, "addMember");
  checkMirrorImpl(impl, mirror, "addMember");
  if (role === null && via != null) throw new TypeError(`addMember: via names how a grant is made, and role null grants nothing (got via ${JSON.stringify(via)})`);
  if (role !== null && (owner === null || typeof owner !== "object")) throw new TypeError("addMember: owner (the owner's session) is required to grant a role");
  const present = Array.isArray(ctx.usersSoFar) ? ctx.usersSoFar : [];
  if (present.some((u) => u?.name === name)) throw new TypeError(`addMember: ${name} already names a user of this case (its evidence files would be overwritten)`);
  const { checkDevice } = await import("./browser.mjs");
  const dev = checkDevice(device, "addMember");
  const grantVia = role === null ? null : joinGrantVia(ctx.target, via);
  const { cast } = impl ?? (await import("./accounts.mjs"));
  const where = device == null ? "a desktop" : `a ${dev.width}×${dev.height}${dev.touch ? " touch" : ""}`;
  const an = (word) => `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
  const who = role === null ? "an account with no grant (a link holder)" : an(role);
  ctx.step(`one more person, ${name}: ${who}, cast as ${castLabel}${role === null ? "" : `, granted ${role} on ${docId}${grantVia === "operator" ? " through the operator script" : ""}`}; ${where} browser signs in through the UI${open ? ` and opens ${docId}${k === null ? "" : " with its link key"}, reading` : ""}`);
  const [account] = await cast(ctx.target, [castLabel], { http: ctx.http({ actor: "harness" }), ...(notifications === undefined ? {} : { notifications }) });
  let granted = null;
  if (role !== null) {
    const nodes = `presenceAccess${LIVE_EDIT_ROLES.includes(role) ? "/editAccess" : ""}`;
    const refused = `its presence${LIVE_EDIT_ROLES.includes(role) ? " and its writes to the live log" : ""} would be refused`;
    granted = await grantEditors(ctx.target, { owner, doc: docId, accounts: [account], role, via: grantVia, timeoutMs, impl: impl ? { share: impl.share, shareMany: impl.shareMany, writeMirror: impl.writeMirror, readMirror: impl.readMirror } : null, mirror }).catch((err) => {
      if (err?.code === "E2E_MIRROR") ctx.inconclusive(`the sync precondition did not hold: after scripts/set-access.mjs granted ${docId} to ${name} (${role}), its RTDB mirror read back missing (suspect S16, recorded in findings.jsonl) and the harness could not write it: ${err.message}`);
      throw err;
    });
    if (grantVia === "operator" && granted.missing.length > 0) {
      if (mirror === "stop") ctx.inconclusive(`the sync precondition did not hold: after scripts/set-access.mjs granted ${docId} to ${name} (${role}), the RTDB mirror (${nodes}) of ${granted.missing.map((m) => m.email).join(", ")} is not what ${an(role)} needs, ${JSON.stringify(granted.missing[0].mirror)} (suspect S16, recorded in findings.jsonl), so ${refused}`);
      const still = stillMissing(granted, new Set([String(account.email).toLowerCase()]));
      if (still.length > 0) {
        ctx.inconclusive(`the sync precondition did not hold: after scripts/set-access.mjs granted ${docId} to ${name} (${role}), the RTDB mirror (${nodes}) of ${still.map((s) => s.email).join(", ")} was not what ${an(role)} needs (suspect S16, recorded in findings.jsonl), and after the harness wrote it from docs/${docId} it still reads ${JSON.stringify(still[0].after)}, so ${refused}`);
      }
      ctx.step(`suspect S16: scripts/set-access.mjs left ${name}'s RTDB mirror missing (recorded in findings.jsonl); the harness wrote presenceAccess/${docId} and editAccess/${docId} from docs/${docId}, as the product's grant path does (grant.mjs writeMirror), and read it back`);
    }
  }
  const user = await ctx.users.user({ name, device, consent: "denied" });
  const signIn = await user.signInUi(account.email, account.password);
  const opened = open ? await user.open(docId, { k, timeout: openMs }) : null;
  return { account, user, role, grantVia, granted, signIn, opened };
}

/**
 * The join gate's precondition for joiners entering edit at once (S1, C4):
 * every joiner held at `gate` (join-before-bind, amplify-mint-join) by the
 * run that will BIND. A joiner's join effect (useSharedDocument) runs when
 * edit mode starts and again when the editable draft frame replaces the
 * reading frame (it depends on the frame's document); the first run, once
 * released, returns as cancelled, and only the second binds. On a live stack
 * the second call came 13 ms and 616 ms after the first, so "N distinct
 * callers held" alone can be met before the run that matters has arrived.
 * So: N distinct callers held, then every joiner's editable /draft/ frame
 * (whose load re-runs the effect, in the same commit that makes the body
 * editable), then N distinct callers each with its LATEST run held again.
 * Any step that never holds ends the case INCONCLUSIVE. Resolves {first,
 * held} (requireHeld's results; `held.callers[i].latest` marks the binding
 * runs). Release with `g.release(gate)` as usual.
 */
export async function requireJoinersHeld(ctx, g, users, { key, gate = "join-before-bind", timeoutMs = 90_000 } = {}) {
  if (!Array.isArray(users) || users.length < 1) throw new TypeError("requireJoinersHeld: give the joining users");
  const { requireHeld } = await import("./gates.mjs");
  const n = users.length;
  const first = await requireHeld(ctx, g, gate, n, { key, timeoutMs, distinct: "caller" });
  try {
    await Promise.all(users.map((u) => u.waitForFrame({ match: /\/draft\//, editable: true, timeout: timeoutMs })));
  } catch (err) {
    ctx.inconclusive(`the sync precondition did not hold: a joiner's editable draft frame never loaded while it was held at ${gate} (${err?.message ?? err})`);
  }
  const held = await requireHeld(ctx, g, gate, n, { key, timeoutMs, distinct: "caller" });
  return { first, held };
}

// --- probes --------------------------------------------------------------------------

/**
 * Type `text` at the end of `selector` in the user's frame, as a person
 * would (User.typeInFrame), and resolve {after, inputs}: the page-clock time
 * of the document's last `input` event, and how many fired (0 throws: no
 * editor took the keys).
 */
export async function typeProbe(user, selector, text, { delay = 0, at = "end" } = {}) {
  const key = `__e2eProbe${Math.random().toString(36).slice(2)}`;
  const armed = await user.page.evaluate(
    ({ sel, key }) => {
      const doc = document.querySelector(sel)?.contentDocument;
      if (!doc) return false;
      const s = { n: 0, last: null, doc };
      s.fn = () => {
        s.n += 1;
        s.last = Date.now();
      };
      doc.addEventListener("input", s.fn, true);
      window[key] = s;
      return true;
    },
    { sel: DOC_FRAME, key },
  );
  if (!armed) throw new Error(`${user.name}: no document frame to type a probe into`);
  let failure = null;
  try {
    await user.typeInFrame(selector, text, { delay, at });
  } catch (err) {
    failure = err;
  }
  const count = await user.page.evaluate((key) => {
    const s = window[key];
    if (!s) return null;
    s.doc.removeEventListener("input", s.fn, true);
    delete window[key];
    return { n: s.n, last: s.last };
  }, key);
  if (failure) throw failure;
  if (!count || count.n === 0) throw new Error(`${user.name}: typing ${JSON.stringify(text)} into ${selector} fired no input event (is the editor open?)`);
  return { after: count.last, inputs: count.n };
}

/**
 * The probe keystroke I13 measures: arm every peer but `from` for `text` in
 * #`id`, type it as `from`, and wait for each. Resolves {after, arrivals:
 * [{name, shared, ms}]} — ms from the last keystroke to the arrival (page
 * clocks on one machine), null when it did not arrive within `timeoutMs`.
 * `anywhere: true` arms each peer anywhere in its frame's BODY instead of in
 * #`id` (frame.mjs armArrival with id null): on a doubled body (S1, S27) the
 * text `from` types into its own first #`id` can be in another peer's
 * SECOND copy, which getElementById never finds. `from` still types at the
 * end of its own first #`id`. Timed the same way either way.
 */
export async function probeArrivals(users, { from, id, text, timeoutMs = 15_000, delay = 0, anywhere = false } = {}) {
  if (typeof anywhere !== "boolean") throw new TypeError(`probeArrivals: anywhere is a boolean, got ${JSON.stringify(anywhere)}`);
  const others = users.filter((u) => u !== from);
  await Promise.all(others.map((u) => armArrival(u, anywhere ? null : id, text)));
  const shared = Object.fromEntries(await Promise.all(others.map(async (u) => [u.name, (await u.shareState()) === "shared"])));
  const { after } = await typeProbe(from, `[id="${id}"]`, text, { delay });
  const arrivals = await Promise.all(
    others.map(async (u) => {
      try {
        const a = await waitForArrival(u, text, { timeout: timeoutMs });
        return { name: u.name, shared: shared[u.name], ms: Math.max(0, a.at - after) };
      } catch (err) {
        if (err?.code === "E2E_ARRIVAL" && err.reason === "timeout") return { name: u.name, shared: shared[u.name], ms: null };
        throw err;
      }
    }),
  );
  return { after, arrivals };
}

// --- input clocks ---------------------------------------------------------------------

/**
 * The span of every peer's input, from per-peer records [{name, n, first,
 * last, replaced, lost}] (inputClocks' read, or the evidence it left):
 * {first, last, spanMs, silent, problems}. `first`/`last` are the earliest
 * and latest input of ANY peer (page clocks on one machine), `spanMs` =
 * last − first (null when nobody typed). `silent` names the peers with no
 * input. `problems` says, in words, why the records cannot prove a race:
 * a peer with no input, a frame replaced after arming (its later input went
 * unrecorded), a page that lost its recorder. Empty `problems` and a span
 * inside the window is the proof; the window is the caller's to compare.
 */
export function inputSpan(inputs) {
  if (!Array.isArray(inputs)) throw new TypeError("inputSpan: give the per-peer records [{name, n, first, last}]");
  const problems = [];
  const silent = [];
  let first = null;
  let last = null;
  for (const x of inputs) {
    if (x?.lost) {
      problems.push(`${x.name}'s page lost its input recorder (it navigated or closed${x.error ? `: ${x.error}` : ""}): its input is unknown`);
      continue;
    }
    if (x?.replaced) problems.push(`${x.name}'s document frame was replaced after arming: input in the new frame was not recorded`);
    if (!(Number(x?.n) > 0)) {
      silent.push(x?.name);
      problems.push(`${x?.name} fired no input event`);
      continue;
    }
    if (!Number.isFinite(x.first) || !Number.isFinite(x.last) || x.last < x.first) {
      problems.push(`${x.name}'s record is not a time range: first ${x.first}, last ${x.last}`);
      continue;
    }
    if (first === null || x.first < first) first = x.first;
    if (last === null || x.last > last) last = x.last;
  }
  return { first, last, spanMs: first === null ? null : last - first, silent, problems };
}

/**
 * Arm an input recorder on every user's document frame (DOC_FRAME): from now
 * on, the page-clock time (Date.now() in the top page) of each `input` event
 * the frame's document dispatches is counted, in the capture phase, before
 * the editor's own listeners. Nothing is written to the document. Resolves
 * {names, read()}; a user with no same-origin document frame throws, and the
 * recorders already armed are taken off first.
 *
 * read() stops every recorder and resolves {inputs: [{name, n, first, last,
 * replaced, lost}], ...inputSpan(inputs)}; later calls resolve the same.
 * `replaced`: the frame's document at read time is not the one armed (a
 * reload, a remount, edit mode left or entered), so input after that went
 * unrecorded. `lost`: the page no longer holds the recorder (it navigated;
 * `error` says how a closed page failed), so nothing is known. Both are
 * named in `problems`, as is a peer that fired no input.
 *
 *   const clocks = await inputClocks(users);
 *   await lat.set({ up: windowMs, down: 0 });
 *   … every peer's edits …
 *   const r = await clocks.read();
 *   if (r.problems.length || !(r.spanMs < windowMs - marginMs)) ctx.inconclusive(`the race did not hold: …`);
 */
export async function inputClocks(users) {
  if (!Array.isArray(users) || users.length === 0) throw new TypeError("inputClocks: give the users whose input to time");
  if (new Set(users).size !== users.length) throw new TypeError("inputClocks: a user is given twice (one recorder per page)");
  const key = `__e2eInputs${Math.random().toString(36).slice(2)}`;
  const arm = (u) =>
    u.page.evaluate(
      ({ sel, key }) => {
        const doc = document.querySelector(sel)?.contentDocument;
        if (!doc) return false;
        const s = { n: 0, first: null, last: null, doc };
        s.fn = () => {
          const t = Date.now();
          s.n += 1;
          if (s.first === null) s.first = t;
          s.last = t;
        };
        doc.addEventListener("input", s.fn, true);
        window[key] = s;
        return true;
      },
      { sel: DOC_FRAME, key },
    );
  const disarm = (u) =>
    u.page.evaluate(
      ({ sel, key }) => {
        const s = window[key];
        if (!s) return null;
        s.doc.removeEventListener("input", s.fn, true);
        delete window[key];
        return { n: s.n, first: s.first, last: s.last, replaced: document.querySelector(sel)?.contentDocument !== s.doc };
      },
      { sel: DOC_FRAME, key },
    );
  const armed = await Promise.allSettled(users.map(arm));
  const failed = users.filter((_, i) => armed[i].status !== "fulfilled" || armed[i].value !== true);
  if (failed.length) {
    await Promise.all(users.filter((_, i) => armed[i].status === "fulfilled" && armed[i].value === true).map((u) => disarm(u).catch(() => undefined)));
    const why = failed.map((u) => {
      const r = armed[users.indexOf(u)];
      return r.status === "fulfilled" ? `${u.name} (no same-origin ${DOC_FRAME})` : `${u.name} (${String(r.reason?.message ?? r.reason).split("\n")[0]})`;
    });
    throw new Error(`inputClocks: cannot record input on ${why.join(", ")}`);
  }
  let result = null;
  return {
    names: users.map((u) => u.name),
    read() {
      result ??= (async () => {
        const inputs = await Promise.all(
          users.map(async (u) => {
            try {
              const r = await disarm(u);
              if (!r) return { name: u.name, n: null, first: null, last: null, replaced: false, lost: true };
              return { name: u.name, ...r, lost: false };
            } catch (err) {
              return { name: u.name, n: null, first: null, last: null, replaced: false, lost: true, error: String(err?.message ?? err).split("\n")[0] };
            }
          }),
        );
        return { inputs, ...inputSpan(inputs) };
      })();
      return result;
    },
  };
}

// --- RTDB delay ---------------------------------------------------------------------

/**
 * Whether a delay set on the stack's RTDB proxy shows: `delayedMs` −
 * `baselineMs` is about `expectedMs` (at least 80 % of it, at most it plus
 * `slackMs`). {ok, failures, growthMs}.
 */
export function checkDelayEffect({ baselineMs, delayedMs, expectedMs, slackMs = 400 } = {}) {
  for (const [k, v] of Object.entries({ baselineMs, delayedMs, expectedMs })) if (!Number.isFinite(v)) throw new TypeError(`checkDelayEffect: ${k} is a number of ms`);
  const growthMs = delayedMs - baselineMs;
  const failures = [];
  if (growthMs < 0.8 * expectedMs) failures.push(`the round trip grew by ${Math.round(growthMs)} ms, not about the ${expectedMs} ms delay set (baseline ${Math.round(baselineMs)} ms, delayed ${Math.round(delayedMs)} ms)`);
  else if (growthMs > expectedMs + slackMs) failures.push(`the round trip grew by ${Math.round(growthMs)} ms, more than the ${expectedMs} ms delay set plus ${slackMs} ms`);
  return { ok: failures.length === 0, failures, growthMs };
}

/**
 * Measure the proxy's effect: the median REST round trip through it with no
 * delay, then with {up, down}, then the delay is set back to none.
 * `lat` is lib/proxy.mjs rtdbLatency(target). Resolves {baselineMs,
 * delayedMs, expectedMs, ...checkDelayEffect}.
 */
export async function rtdbDelayEffect(lat, { up = 0, down = 0, samples = 3, slackMs = 400 } = {}) {
  await lat.reset();
  try {
    const baseline = await lat.roundTrip({ samples });
    await lat.set({ up, down });
    const delayed = await lat.roundTrip({ samples });
    const expectedMs = up + down;
    return { baselineMs: baseline.ms, delayedMs: delayed.ms, expectedMs, ...checkDelayEffect({ baselineMs: baseline.ms, delayedMs: delayed.ms, expectedMs, slackMs }) };
  } finally {
    await lat.reset();
  }
}

// --- memory -------------------------------------------------------------------------

/**
 * Sample, every `everyMs`, the resident memory of the target's stack (every
 * process carrying its mark: lib/stack.mjs stackResources) and of THIS
 * process's Chromes (their process groups, found by this process's browser
 * mark: lib/browsers.mjs). stop() resolves {samples, peak: {stackBytes,
 * browserBytes, totalBytes, at}, peakBy (the stack's split at its peak)}.
 * With `file`, each sample is also a JSON line there.
 */
export function startRssSampler(target, { everyMs = 3_000, file = null } = {}) {
  const samples = [];
  let peak = { stackBytes: 0, browserBytes: 0, totalBytes: 0, at: null };
  let peakBy = null;
  let stopped = false;
  let running = null;
  const once = async () => {
    const [{ stackResources }, { browserMark, markedBrowsers }, { processTable, rssBytes }] = await Promise.all([import("./stack.mjs"), import("./browsers.mjs"), import("./proc.mjs")]);
    const res = stackResources(target.runId);
    const table = processTable();
    const mine = browserMark();
    const leaders = markedBrowsers({ table }).filter((b) => b.mark === mine && b.pid === b.pgid).map((b) => b.pgid);
    const pids = table.filter((p) => leaders.includes(p.pgid)).map((p) => p.pid);
    const rss = pids.length ? rssBytes(pids) : new Map();
    const browserBytes = [...rss.values()].reduce((a, b) => a + b, 0);
    const s = { at: new Date().toISOString(), stackBytes: res.rss.totalBytes, stackProcesses: res.rss.processes, browserBytes, browsers: leaders.length, browserProcesses: pids.length };
    samples.push(s);
    if (file) {
      try {
        appendFileSync(file, `${JSON.stringify(s)}\n`);
      } catch {}
    }
    if (s.stackBytes + s.browserBytes > peak.totalBytes) {
      peak = { stackBytes: s.stackBytes, browserBytes: s.browserBytes, totalBytes: s.stackBytes + s.browserBytes, at: s.at };
      peakBy = res.rss.by;
    }
  };
  const loop = (async () => {
    while (!stopped) {
      running = once().catch(() => undefined);
      await running;
      if (!stopped) await sleep(everyMs);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await running;
      await loop;
      await once().catch(() => undefined);
      return { samples, peak, peakBy };
    },
  };
}

/** The invocation's file for RSS lines (E2E_INVOCATION_DIR/rss.jsonl), or null outside a run. */
export function rssFile(env = process.env) {
  return env.E2E_INVOCATION_DIR ? join(env.E2E_INVOCATION_DIR, "rss.jsonl") : null;
}
