// SPDX-License-Identifier: Apache-2.0
// Self-test: the I15 readers — cursorPosition, logAfter, feedAt, feedToLogIds and startPoller — against a stand-in get_changes that follows the product's cursor rules (SPEC §4, §19).

/**
 * Hermetic. A stand-in for get_changes keeps a log of real firebase-admin
 * Timestamps and answers as functions/src/mcp/tools.ts does: events after
 * the cursor's (at, id) in recorded order, a page of PAGE with `more`, the
 * cursor after the last event READ (or the one given, on a quiet poll),
 * encoded as functions/src/lib/events.ts encodeCursor encodes it, each event
 * shaped as the feed shapes it. Switches break it the ways that matter: a
 * cursor that includes its own last event (startAt for startAfter), a cursor
 * that never settles, a poll held in flight, a refusal, a throw. The cursor
 * format and the feed's fields are pinned against this checkout's source.
 * That the real product's feed maps onto its stored log is checked live (see
 * the lib owner's report), not here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Timestamp } from "firebase-admin/firestore";
import { CURSOR_VERSION, EVENTS_SOURCE, POLL_FINISH_MS, POLL_INTERVAL_MS, compareRecorded, cursorPosition, eventAt, feedAt, feedToLogIds, logAfter, startPoller } from "../lib/changes.mjs";
import { checkI15 } from "../lib/invariants.mjs";
import { REPO_ROOT } from "../lib/paths.mjs";

const DOC = "e2e-0poll-doc-abcd";
const TARGET = Object.freeze({ kind: "local", runId: "2610130900-poll" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const encode = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** encodeCursor, as events.ts writes it. */
const cursorOf = (docId, row = null) => encode({ v: 1, d: docId, ...(row ? { s: row.data.at.seconds, n: row.data.at.nanoseconds, e: row.id } : {}) });

let nextId = 0;
/** A stored event row; `ms` since a fixed epoch, `nanos` within the millisecond. */
function row(type, ms, { id = null, version = "v1", threadId = null, commentId = null, nanos = 0 } = {}) {
  const total = 1_760_000_000_000 + ms;
  const at = new Timestamp(Math.floor(total / 1000), (total % 1000) * 1_000_000 + nanos);
  nextId += 1;
  return { id: id ?? `ev${String(nextId).padStart(4, "0")}`, data: { at, type, audience: "readers", ...(version ? { version } : {}), ...(threadId ? { threadId } : {}), ...(commentId ? { commentId } : {}) } };
}

/** One stored row as get_changes reports it (tools.ts): type, at, version, threadId, and commentId on a comment. */
function feedEvent(r) {
  const at = r.data.at.toDate().toISOString();
  return {
    type: r.data.type,
    at: r.data.type === "fork.created" ? at.slice(0, 10) : at,
    ...(r.data.version ? { version: r.data.version } : {}),
    ...(r.data.threadId ? { threadId: r.data.threadId } : {}),
    ...(r.data.type === "comment.added" ? { commentId: r.data.commentId, by: "x@example.com", body: "…" } : { by: "x@example.com" }),
  };
}

/** A stand-in for an mcp.mjs client whose get_changes follows the product over `log`. */
function fakeChanges(log, { page = 3, inclusive = false, growEveryCall = false } = {}) {
  const calls = [];
  let hold = null;
  let refuseAt = null;
  let throwAt = null;
  const self = {
    calls,
    log,
    append(r) {
      log.push(r);
      log.sort(compareRecorded);
    },
    /** The next call reads, then waits for release(). */
    holdNext() {
      let readSignal;
      let releaseFn;
      const read = new Promise((r) => (readSignal = r));
      const released = new Promise((r) => (releaseFn = r));
      hold = { readSignal, released };
      return { read, release: () => releaseFn() };
    },
    refuseOnCall(n) {
      refuseAt = n;
    },
    throwOnCall(n, err) {
      throwAt = { n, err };
    },
    async call(name, args) {
      assert.equal(name, "get_changes");
      calls.push({ ...args, at: Date.now() });
      const n = calls.length;
      if (throwAt && n === throwAt.n) throw throwAt.err;
      if (refuseAt === n) return { isError: true, text: 'since: that is not a cursor this server gave out. Pass a cursor from an earlier result, "last" or "all"', json: undefined };
      if (growEveryCall) self.append(row("comment.added", 10_000 + n * 10, { threadId: "t-grow", commentId: `c${n}` }));
      const pos = args.since === "all" ? null : cursorPosition(args.since, { docId: args.id });
      const mark = pos ? { id: pos.id, data: { at: pos.at } } : null;
      const after = mark ? log.filter((r) => (inclusive ? compareRecorded(r, mark) >= 0 : compareRecorded(r, mark) > 0)) : [...log];
      const raw = after.slice(0, page + 1);
      const more = raw.length > page;
      const pg = raw.slice(0, page);
      const last = pg[pg.length - 1];
      const cursor = last ? cursorOf(args.id, last) : args.since === "all" ? cursorOf(args.id) : args.since;
      const out = { isError: false, text: "", json: { id: args.id, cursor, more, retryAfter: 60, events: pg.map(feedEvent), needsReply: [] } };
      if (hold) {
        const h = hold;
        hold = null;
        h.readSignal();
        await h.released;
      }
      return out;
    },
  };
  return self;
}

/** A stand-in Admin db over `log` for changeLog/logAfter, counting reads. */
function fakeDb(log) {
  const reads = [];
  return {
    reads,
    collection(path) {
      reads.push(path);
      return { async get() { return { docs: log.map((r) => ({ id: r.id, data: () => r.data })) }; } };
    },
  };
}

/** What `p` rejects with (it must reject). */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

test("pinned to the product: encodeCursor's fields and version, decodeCursor's start rule, the feed's identifying fields", () => {
  const events = readFileSync(join(REPO_ROOT, EVENTS_SOURCE), "utf8");
  assert.match(events, new RegExp(`^const CURSOR_VERSION = ${CURSOR_VERSION};$`, "m"));
  assert.match(events, /v: CURSOR_VERSION,\s*d: c\.docId,\s*\.\.\.\(c\.at && c\.id \? \{ s: c\.at\.seconds, n: c\.at\.nanoseconds, e: c\.id \} : \{\}\),/);
  assert.match(events, /if \(parsed\.s === undefined\) \{\s*return parsed\.n === undefined && parsed\.e === undefined\s*\? \{ docId, at: null, id: null \}\s*:\s*\{ error: "that is not a cursor this server gave out" \};\s*\}/, "only a cursor with no position fields denotes the start");
  assert.match(events, /q = q\.startAfter\(cursor\.at, cursor\.id\)/, "the product reads strictly after the cursor");
  const tools = readFileSync(join(REPO_ROOT, "functions/src/mcp/tools.ts"), "utf8");
  assert.match(tools, /at: v\.type === "fork\.created" && at \? at\.slice\(0, 10\) : at,/);
  assert.match(tools, /\.\.\.\(v\.version \? \{ version: v\.version \} : \{\}\),\s*\.\.\.\(v\.threadId \? \{ threadId: v\.threadId \} : \{\}\),/);
  assert.match(tools, /Object\.assign\(out, \{ commentId: v\.commentId, by: c\.authorEmail, body: c\.body \}\);/);
  assert.match(tools, /const at = \(v\.at as admin\.firestore\.Timestamp \| undefined\)\?\.toDate\?\.\(\)\.toISOString\(\) \?\? null;/);
  assert.match(tools, /const cursor = encodeCursor\(last \? \{ docId: ref\.id, at: last\.data\(\)\.at, id: last\.id \} : from\);/, "a quiet poll gives back the cursor it was given");
  assert.deepEqual([POLL_INTERVAL_MS, POLL_FINISH_MS], [400, 60_000]);
});

test("cursorPosition: a position, the start, \"all\"; refused: \"last\", another document's, another version, a malformed one", () => {
  const r = row("thread.opened", 5, { id: "abc", nanos: 7 });
  assert.deepEqual(cursorPosition(cursorOf(DOC, r), { docId: DOC }), { docId: DOC, at: { seconds: r.data.at.seconds, nanoseconds: r.data.at.nanoseconds }, id: "abc" });
  assert.equal(cursorPosition(cursorOf(DOC)), null);
  assert.equal(cursorPosition("all"), null);
  const refused = [
    ["last", /"last" is kept by the server/],
    ["", /a cursor is a non-empty string/],
    [42, /a cursor is a non-empty string/],
    ["not-a-cursor", /is not a get_changes cursor/],
    [encode({ v: 2, d: DOC }), /a cursor of version 2; this reader knows version 1/],
    [encode({ v: 1 }), /names no document/],
    [encode({ v: 1, d: DOC, n: 0 }), /position is not/],
    [encode({ v: 1, d: DOC, e: "x" }), /position is not/],
    [encode({ v: 1, d: DOC, s: -62135596801, n: 0, e: "x" }), /position is not/],
    [encode({ v: 1, d: DOC, s: 253402300800, n: 0, e: "x" }), /position is not/],
    [encode({ v: 1, d: DOC, s: 1.5, n: 0, e: "x" }), /position is not \(seconds, nanoseconds, id\)/],
    [encode({ v: 1, d: DOC, s: 1, n: 1_000_000_000, e: "x" }), /position is not/],
    ...["", ".", "..", "a/b", "a\\b", "a\0b"].map((e) => [encode({ v: 1, d: DOC, s: 1, n: 0, e }), /position is not/]),
  ];
  for (const [c, re] of refused) assert.throws(() => cursorPosition(c, { docId: DOC }), (e) => e instanceof TypeError && re.test(e.message), String(c));
  assert.throws(() => cursorPosition(cursorOf("e2e-0poll-other-doc"), { docId: DOC }), /the cursor belongs to e2e-0poll-other-doc, not e2e-0poll-doc-abcd/);
});

test("logAfter: strictly after the cursor's (at, id) in recorded order; the start and \"all\" are every event; a bad cursor reads nothing", async () => {
  const a = row("version.published", 0, { id: "a" });
  const b = row("thread.opened", 10, { id: "b", threadId: "t1" });
  const c = row("comment.added", 10, { id: "c", threadId: "t1", commentId: "k1" }); // same at as b: after it by id
  const d = row("thread.resolved", 20, { id: "d", threadId: "t1" });
  const db = fakeDb([d, c, a, b]);
  assert.deepEqual((await logAfter(TARGET, DOC, cursorOf(DOC, b), { db })).map((r) => r.id), ["c", "d"]);
  assert.deepEqual((await logAfter(TARGET, DOC, cursorOf(DOC, d), { db })).map((r) => r.id), []);
  assert.deepEqual((await logAfter(TARGET, DOC, cursorOf(DOC), { db })).map((r) => r.id), ["a", "b", "c", "d"]);
  assert.deepEqual((await logAfter(TARGET, DOC, "all", { db })).map((r) => r.id), ["a", "b", "c", "d"]);
  const reads = db.reads.length;
  await assert.rejects(logAfter(TARGET, DOC, cursorOf("e2e-0poll-other-doc", a), { db }), TypeError);
  await assert.rejects(logAfter(TARGET, "Not A Doc", "all", { db }), TypeError);
  assert.equal(db.reads.length, reads, "nothing read for a bad cursor or docId");
});

test("feedAt: eventAt, rounded as toDate rounds; a fork.created is its day", () => {
  const r = row("comment.added", 999, { threadId: "t", commentId: "k", nanos: 999_999 });
  assert.equal(feedAt(r), eventAt(r));
  assert.equal(feedAt(r), r.data.at.toDate().toISOString());
  const f = row("fork.created", 1234, { version: null });
  assert.equal(feedAt(f), eventAt(f).slice(0, 10));
  assert.match(feedAt(f), /^\d{4}-\d{2}-\d{2}$/);
});

test("feedToLogIds: each feed event as its stored row's id, matched on type, version, threadId, commentId and at; same fields in order; a repeat reuses the last; none is unlogged", () => {
  const rows = [
    row("version.published", 0, { id: "v" }),
    row("thread.opened", 5, { id: "t1o", threadId: "t1" }),
    row("comment.added", 5, { id: "k1", threadId: "t1", commentId: "c1" }),
    row("comment.added", 5, { id: "k2", threadId: "t1", commentId: "c2" }),
    row("thread.resolved", 9, { id: "r1", threadId: "t1" }),
    row("thread.resolved", 9, { id: "r2", threadId: "t1" }), // two flips recorded in the same millisecond
    row("fork.created", 12, { id: "f", version: null }),
  ].sort(compareRecorded);
  const feed = rows.map(feedEvent);
  assert.deepEqual(feedToLogIds(feed, rows), rows.map((r) => ({ id: r.id, kind: r.data.type })));
  // the second comment alone maps to its own row by commentId, not to the first comment of its thread and time
  assert.deepEqual(feedToLogIds([feedEvent(rows.find((r) => r.id === "k2"))], rows), [{ id: "k2", kind: "comment.added" }]);
  // a report repeated (a cursor that included its last event) is the same id twice, and checkI15 says so
  const repeated = feedToLogIds([...feed, feedEvent(rows.find((r) => r.id === "r2")), feedEvent(rows.find((r) => r.id === "r2"))], rows);
  assert.deepEqual(repeated.slice(-2), [{ id: "r2", kind: "thread.resolved" }, { id: "r2", kind: "thread.resolved" }]);
  const i15 = checkI15({ events: repeated, expected: { "version.published": 1, "thread.opened": 1, "comment.added": 2, "thread.resolved": 2, "fork.created": 1 } });
  assert.equal(i15.ok, false);
  assert.match(i15.failures[0], /^1 event\(s\) reported more than once: r2 ×3$/);
  // an event whose time is 1 ms off any stored one has no row
  const off = { ...feedEvent(rows.find((r) => r.id === "t1o")), at: new Date(Date.parse(feedEvent(rows.find((r) => r.id === "t1o")).at) + 1).toISOString() };
  const [u] = feedToLogIds([off], rows);
  assert.match(u.id, /^unlogged:thread\.opened\|v1\|t1\|\|2025-/);
  assert.equal(u.kind, "thread.opened");
  // a fork reported by its day maps; reported with its full time it would not
  assert.deepEqual(feedToLogIds([{ type: "fork.created", at: feedAt(rows.find((r) => r.id === "f")) }], rows), [{ id: "f", kind: "fork.created" }]);
  assert.throws(() => feedToLogIds("events", rows), TypeError);
  assert.throws(() => feedToLogIds([{ at: "x" }], rows), TypeError);
  assert.throws(() => feedToLogIds(feed, [{ id: 1 }]), TypeError);
});

test("startPoller: every page kept (more followed at once), stopped on the first quiet poll after finish(); I15 holds over the stored log", async () => {
  const log = [row("version.published", 0, { id: "v" })];
  const fake = fakeChanges(log, { page: 3 });
  const cursor0 = cursorOf(DOC, log[0]);
  const poll = startPoller(fake, DOC, cursor0, { intervalMs: 20 });
  await sleep(60);
  for (let i = 0; i < 7; i += 1) fake.append(row("comment.added", 100 + i, { threadId: "t1", commentId: `c${i}` }));
  await sleep(120);
  fake.append(row("thread.resolved", 200, { threadId: "t1" }));
  const out = await poll.finish();
  assert.ok(poll.finish() === poll.finish(), "finish() is one promise");
  const logged = await logAfter(TARGET, DOC, cursor0, { db: fakeDb(log) });
  assert.equal(logged.length, 8);
  const reported = feedToLogIds(out.events, logged);
  assert.deepEqual(checkI15({ events: reported, expected: { "comment.added": 7, "thread.resolved": 1 } }).failures, []);
  assert.deepEqual(new Set(reported.map((r) => r.id)), new Set(logged.map((r) => r.id)), "every logged event reported");
  assert.ok(out.polls.some((p) => p.more), "a page said more");
  const last = out.polls[out.polls.length - 1];
  assert.deepEqual([last.moved, last.more, last.afterFinish], [false, false, true], "the last poll: quiet, and started after finish()");
  assert.equal(out.cursor, cursorOf(DOC, logged[logged.length - 1]));
  const n = fake.calls.length;
  await sleep(80);
  assert.equal(fake.calls.length, n, "nothing polled after it stopped");
  assert.ok(fake.calls.every((c) => c.id === DOC && !("includeMine" in c)));
});

test("a poll in flight when finish() is called does not end it, even when it comes back quiet: the event written meanwhile is reported", async () => {
  const log = [row("version.published", 0, { id: "v" })];
  const fake = fakeChanges(log);
  const cursor0 = cursorOf(DOC, log[0]);
  const poll = startPoller(fake, DOC, cursor0, { intervalMs: 15 });
  await sleep(50);
  const held = fake.holdNext();
  await held.read; // that poll has read the log: nothing new
  fake.append(row("comment.added", 50, { id: "late", threadId: "t1", commentId: "c1" }));
  const done = poll.finish();
  held.release(); // …and comes back quiet, after finish()
  const out = await done;
  assert.deepEqual(feedToLogIds(out.events, await logAfter(TARGET, DOC, cursor0, { db: fakeDb(log) })), [{ id: "late", kind: "comment.added" }]);
  assert.ok(out.polls.some((p) => !p.moved && !p.afterFinish), "the held poll came back quiet, before finish() counted");
});

test("a cursor that includes its own last event: the poller still ends (its cursor came back unchanged) and keeps the repeats, which checkI15 fails", async () => {
  const log = [row("version.published", 0, { id: "v" })];
  const fake = fakeChanges(log, { inclusive: true });
  const cursor0 = cursorOf(DOC, log[0]);
  const poll = startPoller(fake, DOC, cursor0, { intervalMs: 15, finishMs: 1_500 });
  await sleep(40);
  fake.append(row("thread.opened", 30, { id: "t", threadId: "t1" }));
  await sleep(60);
  const out = await poll.finish();
  const reported = feedToLogIds(out.events, await logAfter(TARGET, DOC, cursor0, { db: fakeDb(log) }));
  const i15 = checkI15({ events: reported, expected: { "thread.opened": 1 } });
  assert.equal(i15.ok, false, `I15 must fail on a repeated report: ${JSON.stringify(reported)}`);
  // t repeated on every poll; and the first cursor's own event (v), which is not after it, reported as an extra
  assert.match(i15.failures[0], /reported more than once: .*\bt ×\d+/);
  assert.match(i15.failures.join("; "), /unlogged:version\.published\|v1\|\|\|/);
});

test("a cursor that never settles: finish() gives up after finishMs with E2E_POLL_TIMEOUT, worded as a wait, carrying what it saw", async () => {
  const fake = fakeChanges([row("version.published", 0, { id: "v" })], { growEveryCall: true });
  const poll = startPoller(fake, DOC, "all", { intervalMs: 10, finishMs: 250 });
  await sleep(30);
  const err = await rejection(poll.finish());
  assert.equal(err.code, "E2E_POLL_TIMEOUT");
  assert.match(err.message, /^startPoller: the get_changes poller on e2e-0poll-doc-abcd saw no quiet poll \(its cursor given back unchanged, no more\) within 250 ms of finish\(\): \d+ poll\(s\) since, \d+ of them moved the cursor and \d+ said more$/);
  assert.ok(err.events.length > 0 && err.polls.length > 0 && typeof err.cursor === "string");
});

test("a refusal ends the poller (E2E_POLLER, with what it saw); a thrown error is finish()'s rejection unchanged; includeMine is passed", async () => {
  const log = [row("version.published", 0, { id: "v" })];
  const fake = fakeChanges(log);
  fake.refuseOnCall(3);
  const poll = startPoller(fake, DOC, "all", { intervalMs: 10, includeMine: true });
  await sleep(80);
  const err = await rejection(poll.finish());
  assert.equal(err.code, "E2E_POLLER");
  assert.match(err.message, /was refused: since: that is not a cursor this server gave out/);
  assert.equal(err.events.length, 1);
  assert.equal(err.polls.length, 2);
  assert.ok(fake.calls.every((c) => c.includeMine === true));
  const cut = Object.assign(new Error("POST /mcp answered 504 after 60005 ms"), { code: "E2E_STACK_CUTOFF", stackCut: "…" });
  const fake2 = fakeChanges(log);
  fake2.throwOnCall(2, cut);
  const poll2 = startPoller(fake2, DOC, "all", { intervalMs: 10 });
  await sleep(60);
  const err2 = await rejection(poll2.finish());
  assert.ok(err2 === cut, "the poll's own error object");
  assert.equal(err2.events, undefined, "never decorated");
});

test("abandon(): stops after the poll in flight, resolves what it saw, never rejects; TypeErrors before anything is sent", async () => {
  const fake = fakeChanges([row("version.published", 0, { id: "v" })]);
  const poll = startPoller(fake, DOC, "all", { intervalMs: 10 });
  await sleep(40);
  const out = await poll.abandon();
  assert.equal(out.events.length, 1);
  const n = fake.calls.length;
  await sleep(60);
  assert.equal(fake.calls.length, n);
  const refusing = fakeChanges([]);
  refusing.refuseOnCall(1);
  const p2 = startPoller(refusing, DOC, "all", { intervalMs: 10 });
  await sleep(30);
  assert.deepEqual((await p2.abandon()).events, []);
  const none = fakeChanges([]);
  for (const [args, re] of [
    [[{}, DOC, "all"], /mcp is an mcp\.mjs client/],
    [[none, "Not A Doc", "all"], /docId is a document id/],
    [[none, DOC, cursorOf("e2e-0poll-other-doc")], /belongs to e2e-0poll-other-doc/],
    [[none, DOC, "all", { intervalMs: 0 }], /intervalMs is a positive number/],
    [[none, DOC, "all", { includeMine: "yes" }], /includeMine is true or false/],
    [[none, DOC, "all", { finishMs: -1 }], /finishMs is a positive number/],
  ]) assert.throws(() => startPoller(...args), (e) => e instanceof TypeError && re.test(e.message));
  assert.equal(none.calls.length, 0, "nothing sent");
  const last = startPoller(fakeChanges([]), DOC, "last", { intervalMs: 10 });
  await last.abandon();
});
