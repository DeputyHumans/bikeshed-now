// SPDX-License-Identifier: Apache-2.0
// Refute premature final-reading observations, including an interval beat and either side of a transaction (SPEC §17).
import test from "node:test";
import assert from "node:assert/strict";
import { finalBeatSettled } from "../lib/reading-observation.mjs";

const stamp = (ms) => ({ toMillis: () => ms });
const expected = { expectedMs: 12_000, previousBeatMs: 100 };
const session = (ms = 12_000, at = 200) => ({ ms, lastBeatAt: stamp(at) });

test("a captured final beat agrees with both stored records and advances the server timestamp", () => {
  assert.equal(finalBeatSettled({ totalMs: 12_000 }, session(), expected), true);
});

for (const [name, stats, value, goal] of [
  ["earlier interval beat", { totalMs: 8_000 }, session(8_000), expected],
  ["session read before commit", { totalMs: 12_000 }, session(8_000), expected],
  ["aggregate read before commit", { totalMs: 8_000 }, session(), expected],
  ["registration timestamp", { totalMs: 12_000 }, session(12_000, 100), expected],
  ["missing final beacon", { totalMs: 12_000 }, session(), { ...expected, expectedMs: undefined }],
  ["empty time claim", { totalMs: 0 }, session(0), { ...expected, expectedMs: 0 }],
  ["missing session", { totalMs: 12_000 }, null, expected],
]) test(`does not accept ${name} as the final beat`, () => {
  assert.equal(finalBeatSettled(stats, value, goal), false);
});

// A separate realm keeps the instrumentation away from this test runner.
import vm from "node:vm";
import { observeFinalBeacon } from "../lib/reading-observation.mjs";

function realm(queued = true) {
  const sent = [];
  const values = new Map();
  const browser = vm.createContext({ Blob, URL, location: { href: "https://example.test/d/one" },
    navigator: { sendBeacon(url, data) { sent.push({ url, data, receiver: this }); return queued; } },
    sessionStorage: { removeItem: (key) => values.delete(key), getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
  });
  vm.runInContext(`(${observeFinalBeacon.toString()})({ docId: 'one', sessionId: 'session-one', key: 'test' })`, browser);
  return { browser, sent, rows: () => JSON.parse(values.get("test") ?? "[]") };
}

test("beacon observation preserves native Blob bytes, receiver and return value", async () => {
  const r = realm();
  const result = vm.runInContext(`navigator.sendBeacon('/view', new Blob([JSON.stringify({docId:'one',sessionId:'session-one',ms:12000})], {type:'application/json'}))`, r.browser);
  assert.equal(result, true);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].receiver, r.browser.navigator);
  assert.ok(r.sent[0].data instanceof Blob);
  assert.equal(r.sent[0].data.type, "application/json");
  assert.deepEqual(JSON.parse(await r.sent[0].data.text()), r.rows()[0].payload);
  assert.deepEqual(r.rows(), [{ payload: { docId: "one", sessionId: "session-one", ms: 12000 }, queued: true }]);
});

test("a native refusal stays false and cannot become a successful beacon", () => {
  const r = realm(false);
  assert.equal(vm.runInContext(`navigator.sendBeacon('/view', new Blob(['{"docId":"one","sessionId":"session-one","ms":1}']))`, r.browser), false);
  assert.equal(r.rows()[0].queued, false);
});

test("unrelated beacons remain native calls and cannot satisfy the final-beat observer", () => {
  const r = realm();
  vm.runInContext(`navigator.sendBeacon('/view', new Blob(['{"docId":"other","sessionId":"session-one","ms":1}']));
    navigator.sendBeacon('/view', new Blob(['{"docId":"one","sessionId":"other","ms":1}']));
    navigator.sendBeacon('/other', new Blob(['{"docId":"one","sessionId":"session-one","ms":1}']));`, r.browser);
  assert.equal(r.sent.length, 3);
  assert.deepEqual(r.rows(), []);
});

test("both exit events retain their exact payloads in order", () => {
  const r = realm();
  vm.runInContext(`for (const ms of [12000, 12001]) navigator.sendBeacon('/view', new Blob([JSON.stringify({docId:'one',sessionId:'session-one',ms})]));`, r.browser);
  assert.deepEqual(r.rows().map((row) => row.payload.ms), [12000, 12001]);
});
