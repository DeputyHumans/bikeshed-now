// SPDX-License-Identifier: Apache-2.0
// Self-test: the harness's reads of the live log go on through the Database's 503 for a few seconds, then end as the stack not answering, never as I1 (SPEC §12, §16).

/**
 * The Database emulator once answered a harness read of status/{d}/y 503
 * "Firebase database instance is inactive" (run 2610130353-9akl, C2 [N=2]
 * #1) and settleLive threw it: the case FAILED on the oracle's own read.
 * rtdbGetPatient reads again on a 503 for RTDB_RETRY.retryMs, then throws
 * E2E_RTDB_UNAVAILABLE with a `stackCut` (lib/test.mjs stackDidNotAnswer,
 * so inconclusiveOnStackTimeout ends the case INCONCLUSIVE). The real
 * admin.mjs rtdbGet is driven here through a stubbed global fetch: no socket
 * is opened, so its own error words are what the 503 test matches.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { RTDB_RETRY, isRtdbUnavailable, rtdbGetPatient, settleLive } from "../lib/live.mjs";
import { rtdbGet } from "../lib/admin.mjs";
import { onAnsweringStack, stackDidNotAnswer } from "../lib/test.mjs";

const INACTIVE = "Firebase database instance is inactive";
const DB_PORT = 39_998; // never bound: fetch is stubbed
const TARGET = Object.freeze({
  kind: "local",
  runId: "2610130000-rtpat",
  projectId: "demo-rtpatient",
  databaseURL: `http://127.0.0.1:${DB_PORT}/?ns=demo-rtpatient`,
  capabilities: new Set(["local", "admin-emulator"]),
  stack: { ports: { database: DB_PORT } },
});

/** A read that throws admin.mjs rtdbGet's own words for each status in `script` (a number), then returns the value. */
function scripted(script) {
  const calls = [];
  return {
    calls,
    async read(target, path) {
      calls.push(path);
      const next = script.length ? script.shift() : { value: null };
      if (typeof next === "number") throw new Error(`rtdbGet ${path}: ${next} ${next === 503 ? INACTIVE : "nope"}`);
      return next.value;
    },
  };
}

/** Replace global fetch for the length of `fn`: each request to the database is answered by `answer(url)` ({status, body}). */
async function withFetch(answer, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    assert.equal(u.port, String(DB_PORT), "only the stand-in database is asked");
    seen.push(u.pathname);
    const { status, body } = answer(u);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = real;
  }
}

test("isRtdbUnavailable: rtdbGet's 503 is; another status, an assertion or a non-error is not", () => {
  assert.deepEqual(RTDB_RETRY, { retryMs: 5_000, intervalMs: 500 });
  assert.equal(isRtdbUnavailable(new Error(`rtdbGet status/d/y: 503 ${INACTIVE}`)), true);
  assert.equal(isRtdbUnavailable(new Error("rtdbGet status/d/y: 500 boom")), false);
  assert.equal(isRtdbUnavailable(new Error("rtdbGet status/d/y: 5030 bytes")), false);
  assert.equal(isRtdbUnavailable(new AssertionError({ message: "I1: x: 503 y" })), false, "an assertion never is");
  assert.equal(isRtdbUnavailable(`rtdbGet status/d/y: 503 ${INACTIVE}`), false, "a string is not an error");
  assert.equal(isRtdbUnavailable(null), false);
});

test("a 503 is read again, intervalMs apart, and the value that follows is returned; onRetry hears each", async () => {
  const r = scripted([503, 503, { value: { e1: "a" } }]);
  const heard = [];
  const t0 = Date.now();
  const v = await rtdbGetPatient(TARGET, "status/d/y", { read: r.read, intervalMs: 40, onRetry: (err, attempt) => heard.push([attempt, /: 503 /.test(err.message)]) });
  assert.deepEqual(v, { e1: "a" });
  assert.equal(r.calls.length, 3, "NEGATIVE CONTROL: a reader that does not retry throws the first 503");
  assert.deepEqual(heard, [[1, true], [2, true]]);
  assert.ok(Date.now() - t0 >= 70, "it waited between reads");
});

test("anything but a 503 is thrown at once, unchanged, and read once", async () => {
  const r = scripted([500]);
  await assert.rejects(rtdbGetPatient(TARGET, "status/d/y", { read: r.read, intervalMs: 0 }), /^Error: rtdbGet status\/d\/y: 500 nope$/);
  assert.equal(r.calls.length, 1, "NEGATIVE CONTROL: a reader that retries every error reads a 500 again");
  const assertion = new AssertionError({ message: "x: 503" });
  await assert.rejects(rtdbGetPatient(TARGET, "p", { read: async () => { throw assertion; }, intervalMs: 0 }), (err) => err === assertion);
  await assert.rejects(rtdbGetPatient(TARGET, "", {}), TypeError);
  await assert.rejects(rtdbGetPatient(TARGET, "p", { retryMs: -1 }), TypeError);
  await assert.rejects(rtdbGetPatient(TARGET, "p", { read: 1 }), TypeError);
});

test("503s that outlast retryMs end as the stack not answering (stackCut): INCONCLUSIVE under inconclusiveOnStackTimeout, never an assertion", async () => {
  const r = scripted(Array(1_000).fill(503));
  let err = null;
  const t0 = Date.now();
  try {
    await rtdbGetPatient(TARGET, "status/d/y", { read: r.read, retryMs: 200, intervalMs: 20 });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "it gave up");
  assert.ok(Date.now() - t0 >= 200, "after retryMs");
  assert.equal(err.code, "E2E_RTDB_UNAVAILABLE");
  assert.ok(!(err instanceof AssertionError));
  assert.ok(err.attempts >= 3 && err.attempts === r.calls.length, `${err.attempts} attempts, ${r.calls.length} reads`);
  assert.match(err.message, /^rtdbGetPatient: the Database emulator answered 503 to \d+ read\(s\) of status\/d\/y over \d+ ms \(rtdbGet status\/d\/y: 503 Firebase database instance is inactive\)$/);
  assert.match(err.cause.message, /: 503 /);
  const why = stackDidNotAnswer(err);
  assert.equal(typeof why, "string", "NEGATIVE CONTROL: without stackCut the stack's 503 is judged as a product failure");
  assert.match(why, /answered 503 to \d+ read\(s\) of status\/d\/y/);
  assert.equal(stackDidNotAnswer(new Error(`rtdbGet status/d/y: 503 ${INACTIVE}`)), null, "rtdbGet's raw 503 is no stack failure to the judge: thrown out of settleLive, it FAILED the case");
  const body = onAnsweringStack(async () => {
    throw err;
  });
  await assert.rejects(body({ ev: { text() {}, step() {} } }), (e) => e.code === "E2E_INCONCLUSIVE" && /the stack did not answer, so nothing was measured: the Database emulator answered 503/.test(e.message));
  const zero = scripted([503, { value: 1 }]);
  await assert.rejects(rtdbGetPatient(TARGET, "x", { read: zero.read, retryMs: 0 }), { code: "E2E_RTDB_UNAVAILABLE" });
  assert.equal(zero.calls.length, 1, "retryMs 0: the first 503 is the answer");
  const prod = await rtdbGetPatient({ kind: "prod" }, "x", { read: scripted([503]).read, retryMs: 0 }).catch((e) => e);
  assert.match(prod.message, /the Realtime Database answered 503/);
});

test("the real admin.mjs rtdbGet's 503 is read through (its own words match), over a stubbed fetch", async () => {
  let n = 0;
  await withFetch(() => (n++ < 2 ? { status: 503, body: INACTIVE } : { status: 200, body: { e1: "x" } }), async (seen) => {
    await assert.rejects(rtdbGet(TARGET, "status/d/y"), (e) => isRtdbUnavailable(e) && /^rtdbGet status\/d\/y: 503 Firebase database instance is inactive/.test(e.message), "rtdbGet itself throws on the 503");
    const v = await rtdbGetPatient(TARGET, "status/d/y", { intervalMs: 10 });
    assert.deepEqual(v, { e1: "x" });
    assert.deepEqual(seen, ["/status/d/y.json", "/status/d/y.json", "/status/d/y.json"]);
  });
});

/** A fake User on TARGET (settle-live.test.mjs's shape): one body, saved, Shared, no POST /draft. */
function fakeUser(name) {
  return {
    name,
    pool: { target: TARGET },
    inEdit: true,
    async frame() {
      return { evaluate: async () => "<p>same</p>" };
    },
    async saveState() {
      return "saved";
    },
    async shareState() {
      return "shared";
    },
    findResponses() {
      return [];
    },
  };
}

function clock(step = 250) {
  let t = 1_700_000_000_000;
  return () => (t += step);
}

test("settleLive reads y patiently by default: two 503s, then a stable log, settle with yRetries 2", async () => {
  let n = 0;
  await withFetch(() => (n++ < 2 ? { status: 503, body: INACTIVE } : { status: 200, body: { e1: "x" } }), async () => {
    const r = await settleLive([fakeUser("p1"), fakeUser("p2")], { docId: "d", now: clock(), intervalMs: 0 });
    assert.equal(r.yRetries, 2, "NEGATIVE CONTROL: the old default (a bare rtdbGet) throws the first 503");
    assert.equal(r.yEntries, 1);
  });
  // The old default, for the record: a bare rtdbGet as readY throws the 503 out of settleLive.
  n = 0;
  await withFetch(() => (n++ < 2 ? { status: 503, body: INACTIVE } : { status: 200, body: {} }), async () => {
    await assert.rejects(settleLive([fakeUser("p1"), fakeUser("p2")], { docId: "d", now: clock(), intervalMs: 0, readY: () => rtdbGet(TARGET, "status/d/y") }), /rtdbGet status\/d\/y: 503/);
  });
});

test("settleLive on a Database that keeps answering 503: E2E_RTDB_UNAVAILABLE (the stack), not an I1 failure", { timeout: 20_000 }, async () => {
  await withFetch(() => ({ status: 503, body: INACTIVE }), async () => {
    await assert.rejects(
      settleLive([fakeUser("p1"), fakeUser("p2")], { docId: "d", now: clock(), intervalMs: 0 }),
      (e) => e.code === "E2E_RTDB_UNAVAILABLE" && !(e instanceof AssertionError) && typeof stackDidNotAnswer(e) === "string",
    );
  });
});

test("settleLive's own readY is used as given (a spec's reader), and yRetries stays 0", async () => {
  let reads = 0;
  const r = await settleLive([fakeUser("p1"), fakeUser("p2")], { docId: "d", now: clock(), intervalMs: 0, readY: async () => (reads++, { e: 1 }) });
  assert.ok(reads >= 3);
  assert.equal(r.yRetries, 0);
});
