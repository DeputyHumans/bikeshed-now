// SPDX-License-Identifier: Apache-2.0
// A document's change log as stored: read through Admin in recorded order, waited on for exact counts per event type, read after a get_changes cursor, polled through get_changes and matched to the feed (SPEC §4, §19).

/**
 * docs/<docId>/events holds one record per change (functions/src/lib/events.ts):
 * {at, type, audience, version?, threadId?, commentId?, actor?, data?}, `at`
 * the server's clock when the EVENT was written. get_changes reads the log
 * ordered by `at`, then by document id, both ascending (eventsAfter), and so
 * does changeLog: it reads every row through the Admin SDK, past the rules,
 * and sorts them here. Ids compare by their UTF-8 bytes, as Firestore orders
 * strings. A row without a server `at` has no place in that order (the
 * product's ordered query would silently leave it out), so it is refused
 * (E2E_LOG_UNDATED), never dropped and never guessed.
 *
 * WAITING WITHOUT MOVING CURSORS. Three triggers (versions, threads,
 * comments) record their events AFTER the write that caused them:
 * milliseconds on a quiet stack, 10–44 s per trigger run measured on a loaded
 * shared one. A case waits for them before it reads get_changes, and must not
 * wait by polling get_changes, which saves the very cursors under test.
 * settleLog polls the stored log instead, and resolves with its rows.
 *
 * The log only grows: an event is created, never overwritten (a redelivered
 * trigger writes nothing), and nothing in the product deletes one. So a count
 * past the one wanted can never come back down, and settleLog fails at once
 * (E2E_LOG_OVERSHOOT) rather than waiting out its timeout.
 *
 * Event type names are checked against the `EventType` union in the source
 * the stack was built from (target.stack.treeDir; this checkout for a target
 * with no tree), so a misspelt type throws before anything is read instead of
 * waiting for an event that cannot exist.
 *
 *   const rows = await settleLog(target, docId, { "version.published": 1, "thread.opened": 1, "comment.added": 1 });
 *   const feed = await agent.mcp.ok("get_changes", { id: docId, since: "all", includeMine: true });
 *   assert.deepEqual(feed.events.map((e) => [e.type, e.at]), rows.map((r) => [r.data.type, eventAt(r)]));
 *
 * I15 ("get_changes reports each event once, and the counts match") is read
 * with three more: startPoller keeps every page an agent's poller gets and
 * stops only on a QUIET poll (the cursor given back unchanged, no more),
 * logAfter reads the stored events after the poller's first cursor, and
 * feedToLogIds names the stored event each feed event reports, for
 * invariants.mjs checkI15:
 *
 *   const poll = startPoller(agent.mcp, docId, cursor0);
 *   … the storm; settleLog …
 *   const { events } = await poll.finish();
 *   const logged = await logAfter(target, docId, cursor0);
 *   assertInvariant(checkI15({ events: feedToLogIds(events, logged), expected }));
 */

import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { adminFor } from "./admin.mjs";
import { REPO_ROOT, assertPath, within } from "./paths.mjs";

/** Where the product declares its event types (`export type EventType = | "…" …;`). */
export const EVENTS_SOURCE = "functions/src/lib/events.ts";
/**
 * settleLog's default bound. A single trigger run was measured at 10–44 s on
 * a loaded shared stack, queued behind other specs' work; a settle often
 * waits for several. It costs nothing when the stack is quick.
 */
export const LOG_SETTLE_MS = 240_000;
/** settleLog's pause between two reads of the log. */
export const LOG_INTERVAL_MS = 400;

/** The product's document id rule (functions/src/lib/folders.ts isValidDocId). */
const DOC_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DOC_ID_MAX = 60;
const NANOS = 1_000_000_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  return Object.assign(err, extra);
}

/** docs/<docId>/events, after checking docId is an id the product can have made. */
export function eventsPath(docId) {
  if (typeof docId !== "string" || docId.length > DOC_ID_MAX || !DOC_ID_RE.test(docId)) {
    throw new TypeError(`changes: docId is a document id as the product makes them (lowercase letters, digits, single hyphens between them, at most ${DOC_ID_MAX}), got ${JSON.stringify(docId)}`);
  }
  return `docs/${docId}/events`;
}

// --- Event types -----------------------------------------------------------------

/**
 * The names in `export type EventType = | "a" | "b" …;`, in source order.
 * Anything in the union but string literals and `|` (a comment, another type)
 * throws: the list must be exactly what the product can record.
 *
 * @param {string} src     the TypeScript source
 * @param {string} [where] how to name it in an error
 * @returns {ReadonlyArray<string>}
 */
export function parseEventTypes(src, where = EVENTS_SOURCE) {
  const decl = [...String(src).matchAll(/^export type EventType =([^;]*);/gm)];
  if (decl.length !== 1) throw new Error(`eventTypes: ${where} declares \`export type EventType = …;\` ${decl.length} times, want once`);
  const body = decl[0][1];
  const literal = /"([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)"/g;
  const names = [...body.matchAll(literal)].map((m) => m[1]);
  const rest = body.replace(literal, "").replace(/[|\s]/g, "");
  if (names.length === 0 || rest !== "") {
    throw new Error(`eventTypes: EventType in ${where} is not a union of dotted lowercase string literals (left over: ${JSON.stringify(rest.slice(0, 60))})`);
  }
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length > 0) throw new Error(`eventTypes: EventType in ${where} names ${twice.join(", ")} twice`);
  return Object.freeze(names);
}

const typeCache = new Map();

/**
 * The event types the target's product can record, read from its tree's
 * functions/src/lib/events.ts (this checkout for a target with no tree).
 * A tree that lacks the file throws; it never falls back to this checkout's.
 *
 * @param {object} target
 * @returns {ReadonlyArray<string>}
 */
export function eventTypes(target) {
  const tree = target?.stack?.treeDir;
  const root = tree ? assertPath(tree, "treeDir") : REPO_ROOT;
  const file = within(root, EVENTS_SOURCE);
  if (typeCache.has(file)) return typeCache.get(file);
  const where = tree ? `the stack's tree (${root})` : "this checkout";
  if (!existsSync(file)) throw new Error(`eventTypes: ${EVENTS_SOURCE} is not in ${where}`);
  const types = parseEventTypes(readFileSync(file, "utf8"), `${EVENTS_SOURCE} in ${where}`);
  typeCache.set(file, types);
  return types;
}

// --- Order -------------------------------------------------------------------------

/** A row's `at` as {seconds, nanoseconds}, or E2E_LOG_UNDATED. */
function atOf(row, path = "the log") {
  const at = row?.data?.at;
  const ok = at && Number.isSafeInteger(at.seconds) && Number.isInteger(at.nanoseconds) && at.nanoseconds >= 0 && at.nanoseconds < NANOS;
  if (!ok) {
    throw logError(
      "E2E_LOG_UNDATED",
      `changes: ${path}/${row?.id} (${row?.data?.type ?? "no type"}) has no server time "at" (${JSON.stringify(at ?? null)}): every event is dated by the server (SPEC §4), and get_changes, which orders by it, would never report this one`,
      { row },
    );
  }
  return at;
}

/**
 * Recorded order, as get_changes reads the log: `at` ascending, then the
 * event's document id by its UTF-8 bytes (Firestore's string order). A
 * comparator for Array#sort over {id, data} rows; a row without a server
 * `at` throws E2E_LOG_UNDATED.
 */
export function compareRecorded(a, b) {
  const x = atOf(a);
  const y = atOf(b);
  return x.seconds - y.seconds || x.nanoseconds - y.nanoseconds || Buffer.compare(Buffer.from(String(a.id), "utf8"), Buffer.from(String(b.id), "utf8"));
}

/**
 * The time get_changes reports for a stored event: its `at` as an ISO string,
 * `Timestamp#toDate().toISOString()`, exactly what tools.ts sends. toDate()
 * ROUNDS to the millisecond (toMillis() would floor), so .9999995 s is the
 * next second; a plain {seconds, nanoseconds} is rounded the same way.
 * fork.created is the exception the feed makes: it reports only the day, the
 * first ten characters of this (SPEC §21).
 */
export function eventAt(row) {
  const at = atOf(row);
  const date = typeof at.toDate === "function" ? at.toDate() : new Date(at.seconds * 1000 + Math.round(at.nanoseconds / 1_000_000));
  return date.toISOString();
}

/** {type: count} over rows, keys sorted, so two counts compare with deepEqual. */
export function logCounts(rows) {
  const m = new Map();
  for (const r of rows ?? []) {
    const t = String(r?.data?.type);
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// --- Reading -----------------------------------------------------------------------

/**
 * Every event in docs/<docId>/events, in recorded order: [{id, data}], `data`
 * as the Admin SDK gives it (`at` a Timestamp). Admin, so past the rules: what
 * is stored, whoever may read it. `o.db` replaces adminFor(target).db (a
 * self-test's stand-in).
 *
 * @param {object} target
 * @param {string} docId
 * @param {{db?: object}} [o]
 * @returns {Promise<Array<{id: string, data: object}>>}
 */
export async function changeLog(target, docId, { db } = {}) {
  const path = eventsPath(docId);
  const snap = await (db ?? adminFor(target).db).collection(path).get();
  const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  for (const r of rows) atOf(r, path);
  return rows.sort(compareRecorded);
}

/** `want` checked against the target's event types: {type: n > 0}, keys sorted. */
function wantedCounts(target, want) {
  if (want === null || typeof want !== "object" || Array.isArray(want)) {
    throw new TypeError(`settleLog: want is {"<event type>": <count>}, got ${JSON.stringify(want)}`);
  }
  const known = eventTypes(target);
  const out = {};
  for (const [type, n] of Object.entries(want)) {
    if (!known.includes(type)) throw new TypeError(`settleLog: ${JSON.stringify(type)} is not an event type the product records (${EVENTS_SOURCE}: ${known.join(" ")})`);
    if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`settleLog: the count for ${type} is a non-negative integer, got ${JSON.stringify(n)}`);
    if (n > 0) out[type] = n;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** What separates `got` from `want`: types short of their count, and types past it. */
function countDiff(want, got) {
  const types = [...new Set([...Object.keys(want), ...Object.keys(got)])].sort();
  const missing = [];
  const extra = [];
  for (const type of types) {
    const w = want[type] ?? 0;
    const g = got[type] ?? 0;
    if (g < w) missing.push({ type, want: w, got: g });
    if (g > w) extra.push({ type, want: w, got: g });
  }
  return { missing, extra };
}

const describeDiff = ({ missing, extra }) =>
  [
    ...missing.map((d) => `${d.type} ${d.got} of ${d.want}`),
    ...extra.map((d) => `${d.type} ${d.got}, want ${d.want}`),
  ].join("; ");

/**
 * Wait until docs/<docId>/events holds EXACTLY `want`: each listed type that
 * many times, and no event of any other type (a count of 0 is a type that
 * must be absent). Resolves with the rows in recorded order (changeLog).
 *
 * Reads the stored log every `interval` ms; never calls get_changes, so no
 * saved cursor moves. Throws:
 *   - TypeError before reading anything, for a docId the product cannot
 *     make, a `want` that is not {type: non-negative integer}, or a type
 *     that is not in the tree's EventType union;
 *   - E2E_LOG_OVERSHOOT as soon as any type is past its count: the log never
 *     shrinks, so waiting cannot help (an event recorded twice, one the case
 *     did not expect, or a `want` that is short);
 *   - E2E_LOG_UNDATED at once for a row with no server `at`;
 *   - E2E_LOG_TIMEOUT when `timeout` ms pass without the counts holding. A
 *     read that failed (the emulator under load) is tried again until then,
 *     and the last failure is the error's `cause`.
 * Each error carries `want`, `got` and `rows` (the last read), and its message
 * begins with `message` when one is given. These are plain errors, so in a
 * `defect:` case where the log IS the defect's oracle, wrap the call in
 * ctx.oracle(); elsewhere they FAIL the case.
 *
 * @param {object} target
 * @param {string} docId
 * @param {Record<string, number>} want   {"<event type>": count}
 * @param {object} [o]
 * @param {number} [o.timeout]    ms, default LOG_SETTLE_MS (240 s)
 * @param {number} [o.interval]   ms between reads, default LOG_INTERVAL_MS (400)
 * @param {string} [o.message]    what is being waited for, to begin an error with
 * @param {object} [o.db]         a stand-in for adminFor(target).db
 * @returns {Promise<Array<{id: string, data: object}>>}
 */
export async function settleLog(target, docId, want, { timeout = LOG_SETTLE_MS, interval = LOG_INTERVAL_MS, message = null, db } = {}) {
  const path = eventsPath(docId);
  const wanted = wantedCounts(target, want);
  if (!Number.isSafeInteger(timeout) || timeout < 0) throw new TypeError(`settleLog: timeout is a whole number of ms, got ${JSON.stringify(timeout)}`);
  if (!Number.isSafeInteger(interval) || interval <= 0) throw new TypeError(`settleLog: interval is a positive whole number of ms, got ${JSON.stringify(interval)}`);
  if (message !== null && typeof message !== "string") throw new TypeError(`settleLog: message is a string, got ${JSON.stringify(message)}`);
  const lead = message ? `${message}: ` : "settleLog: ";
  const t0 = Date.now();
  let samples = 0;
  let rows = null;
  let got = null;
  let lastErr = null;
  for (;;) {
    samples += 1;
    try {
      rows = await changeLog(target, docId, { db });
      got = logCounts(rows);
      lastErr = null;
    } catch (err) {
      if (err?.code === "E2E_LOG_UNDATED") throw err;
      lastErr = err;
    }
    const elapsed = Date.now() - t0;
    const extra = { want: wanted, got, rows, samples, elapsedMs: elapsed };
    if (!lastErr) {
      if (isDeepStrictEqual(got, wanted)) return rows;
      const diff = countDiff(wanted, got);
      if (diff.extra.length > 0) {
        throw logError(
          "E2E_LOG_OVERSHOOT",
          `${lead}${path} holds more than wanted, and an event is never removed (${describeDiff(diff)}): want ${JSON.stringify(wanted)}, it holds ${JSON.stringify(got)} (after ${elapsed} ms, ${samples} read(s))`,
          { ...extra, diff },
        );
      }
    }
    if (elapsed >= timeout) {
      const why = lastErr ? `the last read failed: ${lastErr.message}` : `${describeDiff(countDiff(wanted, got))}; it holds ${JSON.stringify(got)}`;
      throw logError("E2E_LOG_TIMEOUT", `${lead}${path} did not hold exactly ${JSON.stringify(wanted)} within ${timeout} ms (${samples} read(s)): ${why}`, { ...extra, cause: lastErr ?? undefined });
    }
    await sleep(Math.min(interval, Math.max(1, timeout - elapsed)));
  }
}

// --- Cursors, the feed, and a poller (I15) ----------------------------------------

/**
 * The get_changes cursor format this reader knows: base64url JSON {v, d,
 * s?, n?, e?} (functions/src/lib/events.ts encodeCursor), `v` this version,
 * `d` the document, and (s, n, e) the last event it had read: its `at` in
 * seconds and nanoseconds, and its id. A self-test pins it to the source.
 */
export const CURSOR_VERSION = 1;
/** startPoller's default pause between two polls (no pause after a page that says `more`). */
export const POLL_INTERVAL_MS = 400;
/** How long a finishing poller may go without a quiet poll before finish() gives up (E2E_POLL_TIMEOUT). */
export const POLL_FINISH_MS = 60_000;

/**
 * Where a get_changes cursor points: {docId, at: {seconds, nanoseconds}, id}
 * (after that event), or null for the log's start (a cursor given before
 * any event was read, or "all"). TypeError for "last" (the server keeps that
 * one; read it through get_changes), anything that is not one of these
 * cursors, a version other than CURSOR_VERSION, or (with `docId`) another
 * document's cursor. The product refuses all of those too (decodeCursor),
 * rather than reading them as "start over".
 *
 * @param {string} cursor
 * @param {{docId?: string | null}} [o]
 * @returns {{docId: string, at: {seconds: number, nanoseconds: number}, id: string} | null}
 */
export function cursorPosition(cursor, { docId = null } = {}) {
  if (cursor === "all") return null;
  if (cursor === "last") throw new TypeError('cursorPosition: "last" is kept by the server for each token; read it through get_changes, it cannot be decoded here');
  if (typeof cursor !== "string" || cursor.length === 0) throw new TypeError(`cursorPosition: a cursor is a non-empty string from get_changes (or "all"), got ${JSON.stringify(cursor) ?? String(cursor)}`);
  let p = null;
  try {
    p = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {}
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new TypeError(`cursorPosition: ${JSON.stringify(cursor.slice(0, 48))} is not a get_changes cursor (base64url JSON)`);
  if (p.v !== CURSOR_VERSION) throw new TypeError(`cursorPosition: a cursor of version ${JSON.stringify(p.v) ?? "none"}; this reader knows version ${CURSOR_VERSION} (${EVENTS_SOURCE} encodeCursor)`);
  if (typeof p.d !== "string" || p.d.length === 0) throw new TypeError(`cursorPosition: the cursor names no document (${JSON.stringify(p.d) ?? "none"})`);
  if (docId !== null && p.d !== docId) throw new TypeError(`cursorPosition: the cursor belongs to ${p.d}, not ${docId}`);
  if (p.s === undefined) return null;
  if (!Number.isSafeInteger(p.s) || !Number.isInteger(p.n) || p.n < 0 || p.n >= NANOS || typeof p.e !== "string" || p.e.length === 0) {
    throw new TypeError(`cursorPosition: the cursor's position is not (seconds, nanoseconds, id): ${JSON.stringify({ s: p.s, n: p.n, e: p.e })}`);
  }
  return { docId: p.d, at: { seconds: p.s, nanoseconds: p.n }, id: p.e };
}

/**
 * The stored events AFTER `cursor`'s position, in recorded order: what a
 * get_changes poller starting from that cursor should be told about (by
 * audience and includeMine it may be told less: the feed leaves out events
 * this caller may not see, or caused, and comments deleted since). `cursor`
 * as cursorPosition takes it ("all": every event). A bad docId or cursor
 * throws before anything is read. `o.db` replaces adminFor(target).db.
 *
 * @param {object} target
 * @param {string} docId
 * @param {string} cursor
 * @param {{db?: object}} [o]
 * @returns {Promise<Array<{id: string, data: object}>>}
 */
export async function logAfter(target, docId, cursor, { db } = {}) {
  eventsPath(docId);
  const pos = cursorPosition(cursor, { docId });
  const rows = await changeLog(target, docId, { db });
  if (!pos) return rows;
  const mark = { id: pos.id, data: { at: pos.at } };
  return rows.filter((r) => compareRecorded(r, mark) > 0);
}

/**
 * The `at` get_changes reports for a stored event: eventAt (the ISO time,
 * rounded to the millisecond as Timestamp#toDate rounds), except a
 * fork.created, which the feed reports as its day alone (SPEC §21).
 */
export function feedAt(row) {
  const iso = eventAt(row);
  return row?.data?.type === "fork.created" ? iso.slice(0, 10) : iso;
}

const keyOf = (f) => [f.type, f.version ?? "", f.threadId ?? "", f.commentId ?? "", f.at ?? ""].map((x) => String(x)).join("|");

/**
 * A stored row's identifying fields as get_changes shows them (tools.ts):
 * type, at (feedAt), version and threadId when set, and commentId on a
 * comment.added only. (The feed also merges some types' `data` into the
 * event; no stored `data` names any of these five fields.)
 */
function feedFields(row) {
  const d = row.data ?? {};
  return { type: d.type, at: feedAt(row), version: d.version || undefined, threadId: d.threadId || undefined, commentId: d.type === "comment.added" ? d.commentId : undefined };
}

/**
 * Each feed event (get_changes' `events`, every page a poller kept) as the
 * stored event it reports: [{id, kind}] in feed order, for checkI15. A feed
 * event is matched on type, version, threadId, commentId and `at` as the
 * feed reports them (feedAt). Feed events with the same fields take the
 * stored rows with those fields in recorded order (the feed keeps that
 * order); one past them reuses the last of them, so checkI15 counts that
 * event twice; one with no stored row at all is `unlogged:<fields>`, an
 * extra of its kind. `rows` are logAfter's (or changeLog's) rows. A logged
 * event the feed never reported is simply absent from the result: compare
 * the ids yourself (rows.filter((r) => !ids.has(r.id))), knowing what the
 * poller may not be told (logAfter).
 *
 * @param {Array<{type: string, at?: string, version?: string, threadId?: string, commentId?: string}>} feed
 * @param {Array<{id: string, data: object}>} rows
 * @returns {Array<{id: string, kind: string}>}
 */
export function feedToLogIds(feed, rows) {
  if (!Array.isArray(feed) || feed.some((e) => !e || typeof e !== "object" || typeof e.type !== "string")) throw new TypeError("feedToLogIds: feed is get_changes' events, an array of {type, at, …}");
  if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.id !== "string" || !r.data || typeof r.data !== "object")) throw new TypeError("feedToLogIds: rows are the stored log's [{id, data}] (logAfter, changeLog)");
  const ids = new Map();
  for (const r of rows) {
    const k = keyOf(feedFields(r));
    if (!ids.has(k)) ids.set(k, []);
    ids.get(k).push(r.id);
  }
  const used = new Map();
  return feed.map((e) => {
    const k = keyOf(e);
    const list = ids.get(k) ?? [];
    const i = used.get(k) ?? 0;
    used.set(k, i + 1);
    return { id: list[i] ?? (list.length ? list[list.length - 1] : `unlogged:${k}`), kind: e.type };
  });
}

function pollerError(code, message, state) {
  return Object.assign(logError(code, message), state);
}

/**
 * An agent's get_changes poller on `docId`, from `cursor` (a cursor, "all"
 * or "last"), started at once. Each poll passes the cursor the last one
 * gave back; a page that says `more` is followed at once, anything else
 * after `intervalMs`. EVERY page's events are kept, in order, so an event
 * reported twice is there twice.
 *
 * `finish()` asks it to stop, and it stops on the first QUIET poll that
 * STARTED after finish() was called: the cursor given back unchanged
 * (SPEC §19, "the same value back on a quiet poll") and no more. Not on a
 * poll with no events: under a cursor that does not move past what it
 * reports, every poll repeats the last event, and a poller waiting for an
 * empty one would never end; this one ends and keeps the repeats, for
 * checkI15 to see. Not on a poll already in flight when finish() was called
 * either: its read may predate the last event. finish() resolves {events,
 * polls: [{at, ms, events, more, moved, afterFinish}], cursor}, and is the
 * same promise on every call. It rejects with:
 *   - E2E_POLL_TIMEOUT when no quiet poll came within `finishMs` of
 *     finish() (checked between polls), worded as a wait ("… within <ms>
 *     ms …");
 *   - E2E_POLLER when a get_changes was refused or answered without events
 *     and a cursor (the poller had stopped there);
 * both carrying {events, polls, cursor}; or with the error a poll THREW,
 * unchanged (a Hosting cut-off, an MCP transport error).
 * `abandon()` stops it after the poll in flight and resolves {events,
 * polls, cursor}; it never rejects (for a case that is failing anyway).
 *
 * `mcp` is an mcp.mjs client (`call(name, args)` → {isError, text, json}).
 * `includeMine: true` passes includeMine. TypeError, before anything is
 * sent, for an mcp without call(), a bad docId, a cursor that is neither
 * "all", "last" nor this document's cursor, or a bad option.
 *
 * @param {{call(name: string, args: object): Promise<{isError: boolean, text: string, json: any}>}} mcp
 * @param {string} docId
 * @param {string} cursor
 * @param {{intervalMs?: number, includeMine?: boolean, finishMs?: number}} [o]
 * @returns {{finish(): Promise<{events: object[], polls: object[], cursor: string}>, abandon(): Promise<{events: object[], polls: object[], cursor: string}>}}
 */
export function startPoller(mcp, docId, cursor, { intervalMs = POLL_INTERVAL_MS, includeMine = false, finishMs = POLL_FINISH_MS } = {}) {
  if (!mcp || typeof mcp.call !== "function") throw new TypeError("startPoller: mcp is an mcp.mjs client (call(name, args))");
  eventsPath(docId);
  if (cursor !== "last") cursorPosition(cursor, { docId });
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError(`startPoller: intervalMs is a positive number of ms, got ${JSON.stringify(intervalMs) ?? String(intervalMs)}`);
  if (typeof includeMine !== "boolean") throw new TypeError(`startPoller: includeMine is true or false, got ${JSON.stringify(includeMine) ?? String(includeMine)}`);
  if (!Number.isFinite(finishMs) || finishMs <= 0) throw new TypeError(`startPoller: finishMs is a positive number of ms, got ${JSON.stringify(finishMs) ?? String(finishMs)}`);
  const events = [];
  const polls = [];
  let cur = cursor;
  let error = null;
  let started = 0;
  let finishAt = null;
  let finishAfter = null;
  let finishing = null;
  let abandoned = false;
  let wake = null;
  const state = () => ({ events: [...events], polls: polls.map((p) => ({ ...p })), cursor: cur });
  const nap = (ms) =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(h);
        wake = null;
        resolve();
      };
      const h = setTimeout(done, ms);
      wake = done;
    });
  const loop = (async () => {
    for (;;) {
      if (abandoned) return;
      if (finishAt !== null && Date.now() - finishAt >= finishMs) {
        const since = polls.filter((p) => p.afterFinish);
        error = pollerError("E2E_POLL_TIMEOUT", `startPoller: the get_changes poller on ${docId} saw no quiet poll (its cursor given back unchanged, no more) within ${finishMs} ms of finish(): ${since.length} poll(s) since, ${since.filter((p) => p.moved).length} of them moved the cursor and ${since.filter((p) => p.more).length} said more`, {});
        return;
      }
      started += 1;
      const seq = started;
      const sent = cur;
      const t0 = Date.now();
      let out;
      try {
        out = await mcp.call("get_changes", { id: docId, since: sent, ...(includeMine ? { includeMine: true } : {}) });
      } catch (err) {
        error = err;
        return;
      }
      const j = out?.json;
      if (!out || out.isError || !j || !Array.isArray(j.events) || typeof j.cursor !== "string") {
        error = pollerError("E2E_POLLER", `startPoller: get_changes on ${docId} from ${String(sent).slice(0, 24)}… ${out?.isError ? `was refused: ${String(out.text ?? "").slice(0, 300)}` : "answered without events and a cursor"}; the poller stopped there`, {});
        return;
      }
      const moved = j.cursor !== sent;
      const more = j.more === true;
      const afterFinish = finishAfter !== null && seq > finishAfter;
      polls.push({ at: t0, ms: Date.now() - t0, events: j.events.length, more, moved, afterFinish });
      events.push(...j.events);
      cur = j.cursor;
      if (more) continue;
      if (!moved && afterFinish) return;
      if (abandoned) return;
      // finish() came while this poll was in flight: the poll that counts starts now.
      if (finishAfter !== null && !afterFinish) continue;
      await nap(intervalMs);
    }
  })();
  return {
    finish() {
      if (!finishing) {
        finishAt = Date.now();
        finishAfter = started;
        wake?.();
        finishing = loop.then(() => {
          if (!error) return state();
          if (error.code === "E2E_POLLER" || error.code === "E2E_POLL_TIMEOUT") throw Object.assign(error, state());
          throw error;
        });
      }
      return finishing;
    },
    async abandon() {
      abandoned = true;
      wake?.();
      await loop.catch(() => undefined);
      return state();
    },
  };
}
