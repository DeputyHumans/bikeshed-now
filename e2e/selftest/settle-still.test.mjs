// SPDX-License-Identifier: Apache-2.0
// Self-test: settleStill waits for a value to hold still for its quiet window, restarts on every change, and runs out as a wait the case's stack judges can read (SPEC §12).

/**
 * Hermetic: `read` is a script of values over time. What it proves is the
 * plan's server settle ("counts stable for 10 s") as one helper: the quiet
 * window restarts on every change (a value that comes back to an earlier
 * one included), a projection `key` compares part of a value while the whole
 * is returned, a read that throws is not retried, and running out is
 * E2E_SETTLE_TIMEOUT worded as a wait. That last part is checked through the
 * real judge, lib/test.mjs functionKill, over a written emulators.log: it
 * excuses settleStill's timeout after a lock-timeout kill, and it does not
 * excuse the AssertionError a hand-rolled settle threw (c10's assert.ok).
 */

import { after, before, test } from "node:test";
import assert, { AssertionError } from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SETTLE_DEADLINE_MS, SETTLE_INTERVAL_MS, SETTLE_QUIET_MS, settleStill } from "../lib/assert.mjs";
import { logFile, logMark } from "../lib/logs.mjs";
import { OUT_DIR } from "../lib/paths.mjs";
import { functionKill } from "../lib/test.mjs";

const runId = `selftest-settle-still-${process.pid}`;
const runDir = join(OUT_DIR, runId);
const target = Object.freeze({ kind: "local", runId, runDir, projectId: "demo-bikeshed", capabilities: new Set(["local", "logs"]) });
const LOCK = ["⚠  functions: Error: 10 ABORTED: Transaction lock timeout.", "    at frame0 (/stand-in/node_modules/@grpc/grpc-js/build/src/call.js:1:19)", "⚠  Your function was killed because it raised an unhandled error."];

before(() => {
  mkdirSync(join(runDir, "logs"), { recursive: true });
  writeFileSync(logFile(runId), "");
});
after(() => rmSync(runDir, { recursive: true, force: true }));

/** A read that returns `script[i].value` until `script[i].untilMs` (since its first call), then the next; the last one forever. */
function scripted(script) {
  let t0 = null;
  const calls = [];
  const read = async () => {
    t0 ??= Date.now();
    const at = Date.now() - t0;
    calls.push(at);
    const step = script.find((s) => s.untilMs == null || at < s.untilMs) ?? script[script.length - 1];
    return typeof step.value === "function" ? step.value() : step.value;
  };
  return { read, calls, started: () => t0 };
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

test("the plan's constants: 10 s still, 120 s in all, a read a second", () => {
  assert.deepEqual([SETTLE_QUIET_MS, SETTLE_DEADLINE_MS, SETTLE_INTERVAL_MS], [10_000, 120_000, 1_000]);
});

test("a value that moves, then holds: resolved once it has held for quietMs from its LAST change, the step told once", async () => {
  const s = scripted([{ value: { n: 1 }, untilMs: 150 }, { value: { n: 2 }, untilMs: 300 }, { value: { n: 3 } }]);
  const lines = [];
  const t0 = Date.now();
  const v = await settleStill(s.read, { quietMs: 250, deadlineMs: 5_000, intervalMs: 20, what: "C13 pending", step: (l) => lines.push(l) });
  const took = Date.now() - t0;
  assert.deepEqual(v, { n: 3 });
  assert.ok(took >= 300 + 250 - 25, `it waited for the last change (≈300 ms) plus the quiet window (250 ms): ${took} ms`);
  assert.ok(took < 300 + 250 + 400, `and not much more: ${took} ms`);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^C13 pending: held still for 0\.3 s \(settled 0\.\d s after asking; \d+ read\(s\), 2 change\(s\)\)$/);
});

test("a value that comes BACK to an earlier one restarts the window: A, B, then A again holds for quietMs from its return", async () => {
  const s = scripted([{ value: "A", untilMs: 200 }, { value: "B", untilMs: 260 }, { value: "A" }]);
  const t0 = Date.now();
  assert.equal(await settleStill(s.read, { quietMs: 300, deadlineMs: 5_000, intervalMs: 10 }), "A");
  const took = Date.now() - t0;
  assert.ok(took >= 260 + 300 - 25, `the first A's 200 ms are not counted: ${took} ms`);
});

test("objects are compared by key (JSON by default), never by identity: a fresh object every read still settles", async () => {
  let reads = 0;
  const v = await settleStill(async () => ({ pending: 20, ids: ["a", "b"], read: ++reads > 0 }), { quietMs: 120, deadlineMs: 3_000, intervalMs: 10 });
  assert.deepEqual(v, { pending: 20, ids: ["a", "b"], read: true });
});

test("key: a projection is compared, and the whole of the last value is resolved; a change outside the key does not restart the window", async () => {
  let i = 0;
  const t0 = Date.now();
  const v = await settleStill(async () => ({ state: "accepted", readAt: ++i }), { quietMs: 150, deadlineMs: 3_000, intervalMs: 10, key: (o) => o.state });
  assert.equal(v.state, "accepted");
  assert.ok(v.readAt > 3, `the last read's whole value: ${v.readAt}`);
  assert.ok(Date.now() - t0 < 1_000, "readAt changing on every read did not hold it up");
});

test("never still: E2E_SETTLE_TIMEOUT, worded as a wait, with the last value, the reads and the changes", async () => {
  let i = 0;
  const err = await rejection(settleStill(async () => ({ i: ++i }), { quietMs: 200, deadlineMs: 400, intervalMs: 20, what: "C14 threads and versions" }));
  assert.equal(err.code, "E2E_SETTLE_TIMEOUT");
  assert.match(err.message.split("\n")[0], /^C14 threads and versions: did not hold still for 200 ms within 400 ms \(\d+ read\(s\), \d+ change\(s\); the last value had held for \d+ ms\): \{"i":\d+\}$/);
  assert.deepEqual(err.value, { i });
  assert.equal(err.reads, i);
  assert.equal(err.changes, i - 1);
  assert.deepEqual([err.quietMs, err.deadlineMs, err.what], [200, 400, "C14 threads and versions"]);
  assert.ok(err.waitedMs >= 400 && err.stillMs < 200);
});

test("the timeout reads as a wait: functionKill excuses it after a lock-timeout kill; it does not excuse a hand-rolled settle's AssertionError", async () => {
  const since = logMark({ target });
  appendFileSync(logFile(runId), `${LOCK.join("\n")}\n`);
  const ctx = { target, logSince: since, ev: { json() {} } };
  let i = 0;
  const err = await rejection(settleStill(async () => ++i, { quietMs: 100, deadlineMs: 200, intervalMs: 20, what: "the server's records" }));
  const why = functionKill(err, ctx);
  assert.ok(typeof why === "string" && why.includes("the emulator killed 1 function(s) for a transaction lock timeout"), `excused: ${why}`);
  assert.match(why, /the server's records: did not hold still for 100 ms within 200 ms/);
  // c10's settleServer: assert.ok(now - t0 <= SERVER_SETTLE_MS, "server settle: … did not hold still for 10000 ms within 90000 ms")
  const handRolled = new AssertionError({ message: "server settle: the suggestions' records and the draft did not hold still for 10000 ms within 90000 ms" });
  assert.equal(functionKill(handRolled, ctx), null, "an assertion is never a wait");
});

test("a read that throws is thrown at once, the same error, never read again", async () => {
  const boom = Object.assign(new Error("4 DEADLINE_EXCEEDED: Deadline exceeded"), { code: 4 });
  let reads = 0;
  const err = await rejection(settleStill(async () => {
    reads += 1;
    if (reads === 2) throw boom;
    return 1;
  }, { quietMs: 500, deadlineMs: 2_000, intervalMs: 10 }));
  assert.ok(err === boom, "the read's own error object");
  assert.equal(reads, 2);
});

test("TypeErrors before anything is read; a key that returns an object is refused at the first read", async () => {
  let reads = 0;
  const read = async () => (reads += 1);
  const bad = [
    [() => settleStill("x"), /read is a function/],
    [() => settleStill(read, { quietMs: 0 }), /quietMs is a positive number/],
    [() => settleStill(read, { quietMs: 1_000, deadlineMs: 999 }), /deadlineMs is a number of ms, at least quietMs/],
    [() => settleStill(read, { intervalMs: -1 }), /intervalMs is a positive number/],
    [() => settleStill(read, { what: "  " }), /what names what is settling/],
    [() => settleStill(read, { key: "state" }), /key is a function/],
    [() => settleStill(read, { step: "log" }), /step is a function/],
  ];
  for (const [call, re] of bad) {
    const err = await rejection(call());
    assert.ok(err instanceof TypeError, String(err));
    assert.match(err.message, re);
  }
  assert.equal(reads, 0, "nothing was read");
  const err = await rejection(settleStill(read, { quietMs: 50, deadlineMs: 100, intervalMs: 10, key: (v) => ({ v }) }));
  assert.ok(err instanceof TypeError);
  assert.match(err.message, /key\(value\) returned object/);
  assert.equal(reads, 1);
});
