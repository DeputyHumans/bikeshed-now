// SPDX-License-Identifier: Apache-2.0
// Self-test: changeLog reads a document's events in get_changes' order, and settleLog waits for exact counts, failing at once past them (SPEC §4, §19).

/**
 * Hermetic: a stand-in for the Admin SDK's Firestore handle serves
 * docs/<id>/events from a script (one snapshot per read, so a trigger can
 * "land" between two reads), with real firebase-admin Timestamps, and records
 * every read. What it proves is the order (at, then id by UTF-8 bytes, as
 * Firestore orders strings), the exact-count wait and its three ways to end,
 * and that nothing is read when the arguments are wrong. The event types come
 * from this checkout's functions/src/lib/events.ts. That a live stack's log
 * reads in the order get_changes reports is checked live (see the lib owner's
 * report), not here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Timestamp } from "firebase-admin/firestore";
import { EVENTS_SOURCE, LOG_SETTLE_MS, changeLog, compareRecorded, eventAt, eventTypes, eventsPath, logCounts, parseEventTypes, settleLog } from "../lib/changes.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const TARGET = Object.freeze({ kind: "local", runId: "2610110830-chlg" });
const DOC = "e2e-0chlg-doc-abcd";
const PATH = `docs/${DOC}/events`;

const ev = (id, type, seconds, nanoseconds = 0, extra = {}) => ({ id, data: { at: new Timestamp(seconds, nanoseconds), type, audience: "readers", ...extra } });

/** Serves `snapshots[i]` on read i (the last one from then on); a snapshot may be an Error to throw. */
function fakeDb(...snapshots) {
  const calls = [];
  return {
    calls,
    collection(path) {
      calls.push(path);
      return {
        async get() {
          const snap = snapshots[Math.min(calls.length - 1, snapshots.length - 1)];
          if (snap instanceof Error) throw snap;
          return { docs: snap.map((r) => ({ id: r.id, data: () => r.data })) };
        },
      };
    },
  };
}

const ids = (rows) => rows.map((r) => r.id);

test("changeLog: docs/<id>/events in recorded order, at then id by UTF-8 bytes, as [{id, data}]", async () => {
  // U+FF61 sorts before U+1F600 in UTF-8 (EF … < F0 …) but after it in UTF-16 (FF61 > D83D).
  const rows = [
    ev("b", "comment.added", 100, 5),
    ev("\u{1F600}x", "thread.opened", 100, 7),
    ev("z", "version.published", 99, 999_999_999),
    ev("a", "thread.resolved", 100, 5),
    ev("｡x", "thread.opened", 100, 7),
    ev("c", "comment.added", 101, 0),
    ev("y", "comment.added", 102, 1), // the same second: nanoseconds decide before the id does
    ev("x", "comment.added", 102, 2),
  ];
  const db = fakeDb(rows);
  const out = await changeLog(TARGET, DOC, { db });
  assert.deepEqual(ids(out), ["z", "a", "b", "｡x", "\u{1F600}x", "c", "y", "x"]);
  assert.deepEqual(db.calls, [PATH], "one read of the document's events");
  assert.equal(out[0].data.type, "version.published", "data as stored");
  assert.ok(out[0].data.at instanceof Timestamp, "at stays the Admin SDK's Timestamp");

  const shuffled = [...rows].reverse().sort(compareRecorded);
  assert.deepEqual(ids(shuffled), ids(out), "compareRecorded is the same order");
  assert.deepEqual(await changeLog(TARGET, DOC, { db: fakeDb([]) }), [], "an empty log");
});

test("eventAt: the time get_changes reports, Timestamp#toDate().toISOString(), which rounds to the millisecond", () => {
  for (const [s, n] of [[1_760_000_000, 0], [1_760_000_000, 999_999_999], [1_760_000_000, 1_000_000], [1_760_000_000, 999_999], [1_760_000_000, 499_999], [1_760_000_000, 500_000], [0, 500_000_000]]) {
    const want = new Timestamp(s, n).toDate().toISOString();
    assert.equal(eventAt(ev("x", "comment.added", s, n)), want, `${s}.${n}`);
    assert.equal(eventAt({ id: "x", data: { at: { seconds: s, nanoseconds: n }, type: "comment.added" } }), want, `${s}.${n} as a plain {seconds, nanoseconds}`);
  }
  assert.equal(eventAt(ev("x", "comment.added", 1_760_000_000, 999_999_999)), "2025-10-09T08:53:21.000Z", "rounded up into the next second, as toDate() does (toMillis() would floor)");
  assert.equal(eventAt(ev("x", "comment.added", 1_760_000_000, 1_499_999)), "2025-10-09T08:53:20.001Z");
});

test("logCounts: {type: n} with sorted keys", () => {
  const rows = [ev("1", "thread.opened", 1), ev("2", "comment.added", 2), ev("3", "comment.added", 3)];
  assert.deepEqual(Object.entries(logCounts(rows)), [["comment.added", 2], ["thread.opened", 1]]);
  assert.deepEqual(logCounts([]), {});
});

test("eventTypes: the EventType union of the tree's events.ts; a tree without it throws rather than read this checkout's", () => {
  const types = eventTypes(TARGET);
  for (const t of ["version.published", "thread.opened", "thread.resolved", "comment.added", "access.changed", "doc.trust", "doc.visibility", "doc.moved", "fork.created"]) {
    assert.ok(types.includes(t), `${t} is a type the product records`);
  }
  assert.ok(types.every((t) => /^[a-z]+\.[a-z_]+$/.test(t)));
  assert.ok(Object.isFrozen(types));

  const tree = tempDir("e2e-chlg-tree-");
  assert.throws(() => eventTypes({ ...TARGET, stack: { treeDir: tree } }), new RegExp(`${EVENTS_SOURCE.replace(/\./g, "\\.")} is not in the stack's tree`));
  mkdirSync(join(tree, "functions/src/lib"), { recursive: true });
  writeFileSync(join(tree, EVENTS_SOURCE), 'export type EventType =\n  | "only.this"\n  | "and.that_one";\n');
  assert.deepEqual(eventTypes({ ...TARGET, stack: { treeDir: tree } }), ["only.this", "and.that_one"], "the stack's tree, not this checkout");
});

test("NEGATIVE: parseEventTypes refuses anything but a single union of string literals", () => {
  assert.deepEqual(parseEventTypes('export type EventType = "a.b" | "c.d";'), ["a.b", "c.d"]);
  const bad = [
    ["type EventType = \"a.b\";", /declares .* 0 times/],
    ['export type EventType = "a.b";\nexport type EventType = "c.d";', /2 times/],
    ['export type EventType =\n  | "a.b" // a note\n  | "c.d";', /not a union of dotted lowercase string literals/],
    ['export type EventType = "a.b" | Other;', /not a union/],
    ['export type EventType = "A.b";', /not a union/],
    ['export type EventType = "a.b" | "a.b";', /names a\.b twice/],
  ];
  for (const [src, re] of bad) assert.throws(() => parseEventTypes(src), re, src);
});

test("settleLog: resolves with the rows, in recorded order, on the first read that holds exactly the counts; 0 means absent", async () => {
  const publish = ev("p", "version.published", 10);
  const opened = ev("o", "thread.opened", 12);
  const added = ev("c", "comment.added", 11);
  const db = fakeDb([publish], [publish, opened], [opened, added, publish]);
  const rows = await settleLog(TARGET, DOC, { "version.published": 1, "thread.opened": 1, "comment.added": 1, "access.changed": 0 }, { db, interval: 5, timeout: 2_000 });
  assert.deepEqual(ids(rows), ["p", "c", "o"]);
  assert.equal(db.calls.length, 3, "it read until the triggers had landed, then stopped");

  const quiet = fakeDb([publish]);
  assert.deepEqual(ids(await settleLog(TARGET, DOC, { "version.published": 1, "access.changed": 0 }, { db: quiet, timeout: 2_000 })), ["p"], "a count of 0 is a type that must be absent");
  assert.equal(quiet.calls.length, 1);
  assert.equal(LOG_SETTLE_MS, 240_000);
});

test("NEGATIVE: past a count, settleLog fails at once (the log never shrinks); an unlisted type is past its 0", async () => {
  const twice = fakeDb([ev("p", "version.published", 1), ev("c1", "comment.added", 2), ev("c2", "comment.added", 3)]);
  const t0 = Date.now();
  await assert.rejects(
    settleLog(TARGET, DOC, { "version.published": 1, "comment.added": 1 }, { db: twice, timeout: 5_000, interval: 5, message: "the reply is recorded" }),
    (err) => {
      assert.equal(err.code, "E2E_LOG_OVERSHOOT");
      assert.match(err.message, /^the reply is recorded: docs\/e2e-0chlg-doc-abcd\/events holds more than wanted, and an event is never removed \(comment\.added 2, want 1\)/);
      assert.deepEqual(err.got, { "comment.added": 2, "version.published": 1 });
      assert.deepEqual(err.want, { "comment.added": 1, "version.published": 1 });
      assert.equal(err.rows.length, 3);
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 1_000, `it did not wait out its 5 s timeout (${Date.now() - t0} ms)`);
  assert.equal(twice.calls.length, 1);

  const stray = fakeDb([ev("p", "version.published", 1), ev("a", "access.changed", 2)]);
  await assert.rejects(settleLog(TARGET, DOC, { "version.published": 1 }, { db: stray, timeout: 5_000 }), (err) => err.code === "E2E_LOG_OVERSHOOT" && /access\.changed 1, want 0/.test(err.message));
  assert.equal(stray.calls.length, 1);
});

test("NEGATIVE: a log that stays short ends E2E_LOG_TIMEOUT, saying what is missing; a failed read is tried again, the last failure its cause", async () => {
  const short = fakeDb([ev("p", "version.published", 1)]);
  await assert.rejects(
    settleLog(TARGET, DOC, { "version.published": 1, "comment.added": 1 }, { db: short, timeout: 60, interval: 10 }),
    (err) => {
      assert.equal(err.code, "E2E_LOG_TIMEOUT");
      assert.match(err.message, /^settleLog: docs\/e2e-0chlg-doc-abcd\/events did not hold exactly \{"comment\.added":1,"version\.published":1\} within 60 ms \(\d+ read\(s\)\): comment\.added 0 of 1; it holds \{"version\.published":1\}$/);
      return true;
    },
  );
  assert.ok(short.calls.length >= 2, "it kept reading until the timeout");

  const flaky = fakeDb(new Error("14 UNAVAILABLE: the emulator is busy"), [ev("p", "version.published", 1)]);
  assert.deepEqual(ids(await settleLog(TARGET, DOC, { "version.published": 1 }, { db: flaky, interval: 5, timeout: 2_000 })), ["p"], "a failed read is not the end");
  assert.equal(flaky.calls.length, 2);

  const down = fakeDb(new Error("14 UNAVAILABLE: the emulator is down"));
  await assert.rejects(settleLog(TARGET, DOC, { "version.published": 1 }, { db: down, timeout: 30, interval: 10 }), (err) => {
    assert.equal(err.code, "E2E_LOG_TIMEOUT");
    assert.match(err.message, /the last read failed: 14 UNAVAILABLE: the emulator is down/);
    assert.match(err.cause.message, /emulator is down/);
    return true;
  });
});

test("NEGATIVE: a row with no server time is refused at once, by changeLog and by settleLog, never sorted or retried", async () => {
  const undated = { id: "u", data: { type: "comment.added", audience: "readers" } };
  await assert.rejects(changeLog(TARGET, DOC, { db: fakeDb([ev("p", "version.published", 1), undated]) }), (err) => err.code === "E2E_LOG_UNDATED" && /docs\/e2e-0chlg-doc-abcd\/events\/u \(comment\.added\) has no server time "at"/.test(err.message));
  const db = fakeDb([undated]);
  await assert.rejects(settleLog(TARGET, DOC, { "comment.added": 1 }, { db, timeout: 5_000, interval: 5 }), (err) => err.code === "E2E_LOG_UNDATED");
  assert.equal(db.calls.length, 1, "not retried: Admin never reads a pending server time");
  const halfDated = { id: "h", data: { at: { seconds: 1, nanoseconds: 1e9 }, type: "comment.added" } };
  await assert.rejects(changeLog(TARGET, DOC, { db: fakeDb([halfDated]) }), (err) => err.code === "E2E_LOG_UNDATED");
});

test("NEGATIVE: a malformed docId, want or option throws before anything is read", async () => {
  const cases = [
    ["docs/x", { "comment.added": 1 }, {}, /docId is a document id/],
    ["", { "comment.added": 1 }, {}, /docId is a document id/],
    ["Upper-Case", { "comment.added": 1 }, {}, /docId is a document id/],
    [DOC, { "comment.add": 1 }, {}, /"comment\.add" is not an event type the product records/],
    [DOC, { "comment.added": -1 }, {}, /count for comment\.added is a non-negative integer, got -1/],
    [DOC, { "comment.added": 1.5 }, {}, /non-negative integer, got 1\.5/],
    [DOC, { "comment.added": "1" }, {}, /non-negative integer, got "1"/],
    [DOC, ["comment.added"], {}, /want is \{"<event type>": <count>\}/],
    [DOC, null, {}, /want is/],
    [DOC, { "comment.added": 1 }, { timeout: "60s" }, /timeout is a whole number of ms/],
    [DOC, { "comment.added": 1 }, { interval: 0 }, /interval is a positive whole number/],
    [DOC, { "comment.added": 1 }, { message: 3 }, /message is a string/],
  ];
  for (const [docId, want, o, re] of cases) {
    const db = fakeDb([]);
    // A short bound, so an argument that slipped through ends at once rather than after LOG_SETTLE_MS.
    await assert.rejects(settleLog(TARGET, docId, want, { timeout: 50, interval: 10, ...o, db }), re, `${JSON.stringify(docId)} ${JSON.stringify(want)} ${JSON.stringify(o)}`);
    assert.deepEqual(db.calls, [], "nothing was read");
  }
  const db = fakeDb([]);
  await assert.rejects(changeLog(TARGET, "a/b", { db }), /docId is a document id/);
  assert.deepEqual(db.calls, []);
  assert.equal(eventsPath(DOC), PATH);
});
