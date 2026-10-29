// SPDX-License-Identifier: Apache-2.0
// The ACK-loss capability preserves the installed native retry loop and faults only an explicitly released real commit (SPEC §2, §6a).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const ts = require("typescript");
const { Transaction } = require("@google-cloud/firestore/build/src/transaction.js");
const patch = readFileSync(new URL("../patches/amplify-native-ack-loss/10-native-ack-helper.patch", import.meta.url), "utf8");
const source = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
async function helper(text = source) {
  const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return (await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`)).e2eAckTransaction;
}
function nativeDb() {
  const state = { durable: false, commits: 0, callbacks: 0 };
  return { state, async runTransaction(work, options) {
    state.options = options;
    const batch = { isEmpty: true, _reset() { this.isEmpty = true; } };
    const tx = Object.assign(Object.create(Transaction.prototype), {
      _firestore: { _traceUtil: { startActiveSpan: (_name, fn) => fn({ setAttributes() {}, addEvent() {} }) } },
      _requestTag: "ack-capability-test", _maxAttempts: 3, _writeBatch: batch,
      _backoff: { backoffAndWait: async () => {}, resetToMax() {} },
      update() { batch.isEmpty = false; return tx; },
      async commit() { if (!batch.isEmpty) { state.durable = true; state.commits++; } },
      async rollback() {},
    });
    return tx.runTransaction(async (native) => { state.callbacks++; return work(native); });
  } };
}
async function exercise({ outcome = "released", status = 200, text = source, environment = true, options } = {}) {
  const originalFetch = globalThis.fetch, originalLog = console.log, prior = process.env.E2E_GATE_URL;
  const db = nativeDb(), calls = [], markers = [];
  if (environment) process.env.E2E_GATE_URL = "http://127.0.0.1:1"; else delete process.env.E2E_GATE_URL;
  globalThis.fetch = async (url, options) => {
    assert.equal(db.state.durable, true, "gate must run after the actual commit");
    calls.push({ url, options });
    return { status, json: async () => ({ outcome }) };
  };
  console.log = (line) => markers.push(line);
  try {
    const run = await helper(text);
    const result = await run(db, "doc", "draft-link", async (tx) => { if (!db.state.durable) tx.update(); return "receipt"; }, options);
    return { ...db.state, calls, markers, result };
  } finally {
    globalThis.fetch = originalFetch; console.log = originalLog;
    if (prior === undefined) delete process.env.E2E_GATE_URL; else process.env.E2E_GATE_URL = prior;
  }
}
test("released gate loses one actual commit ACK and the installed SDK retries the same callback", async () => {
  const result = await exercise();
  assert.deepEqual({ commits: result.commits, callbacks: result.callbacks, result: result.result }, { commits: 1, callbacks: 2, result: "receipt" });
  assert.equal(result.calls.length, 1);
  const url = new URL(result.calls[0].url);
  assert.equal(url.searchParams.get("key"), "draft-link:doc");
  assert.equal(result.calls[0].options.method, "POST");
  assert.deepEqual(result.markers, [`E2E_ACK_LOSS draft-link doc ${url.searchParams.get("caller")}`, `E2E_ACK_RETRY draft-link doc ${url.searchParams.get("caller")} callback2`]);
});
test("unarmed setup commits once without a fabricated failure or retry marker", async () => {
  const result = await exercise({ outcome: "passed" });
  assert.equal(result.commits, 1); assert.equal(result.callbacks, 1); assert.deepEqual(result.markers, []);
});
test("expired gate is a failed fault precondition, never an ACK-loss retry", async () => {
  await assert.rejects(exercise({ outcome: "expired" }), /did not explicitly pass or release/);
});
test("failed gate and missing configuration fail closed", async () => {
  await assert.rejects(exercise({ status: 503 }), /did not explicitly pass or release/);
  await assert.rejects(exercise({ environment: false }), /E2E_GATE_URL is required/);
});
test("inverse without actual commit is rejected at the gate", async () => {
  await assert.rejects(exercise({ text: source.replace("await commit();", "// inverse: no commit") }), /gate must run after the actual commit/);
});
test("inverse without code14 cannot satisfy native callback2", async () => {
  await assert.rejects(exercise({ text: source.replace("{ code: 14 }", "{ code: 3 }") }), /acknowledgement lost/);
});
test("inverse without the loss cannot satisfy the retry assertion", async () => {
  const result = await exercise({ text: source.replace('throw Object.assign(new Error("e2e: committed transaction acknowledgement lost"), { code: 14 });', 'return;') });
  assert.throws(() => assert.equal(result.callbacks, 2), { code: "ERR_ASSERTION" });
});

const operatorPatch = readFileSync(new URL("../patches/amplify-native-ack-loss/50-operator-ack-helper.patch", import.meta.url), "utf8");
const operatorSource = operatorPatch.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).map(line => line.slice(1)).join("\n");
test("operator ESM twin preserves the same released native retry and unarmed setup behavior", async () => {
  const released = await exercise({ text: operatorSource });
  assert.deepEqual({ commits: released.commits, callbacks: released.callbacks, result: released.result }, { commits: 1, callbacks: 2, result: "receipt" });
  const url = new URL(released.calls[0].url);
  assert.deepEqual(released.markers, [`E2E_ACK_LOSS draft-link doc ${url.searchParams.get("caller")}`, `E2E_ACK_RETRY draft-link doc ${url.searchParams.get("caller")} callback2`]);
  const passed = await exercise({ text: operatorSource, outcome: "passed" });
  assert.deepEqual({ commits: passed.commits, callbacks: passed.callbacks, markers: passed.markers }, { commits: 1, callbacks: 1, markers: [] });
  await assert.rejects(exercise({ text: operatorSource, outcome: "expired" }), /did not explicitly pass or release/);
});
test("operator ESM twin inverses cannot pass the postcommit retry judge", async () => {
  await assert.rejects(exercise({ text: operatorSource.replace("await commit();", "// inverse: skip commit") }), /gate must run after the actual commit/);
  await assert.rejects(exercise({ text: operatorSource.replace("{ code: 14 }", "{ code: 3 }") }), /acknowledgement lost/);
  const missing = await exercise({ text: operatorSource.replace('throw Object.assign(new Error("e2e: committed transaction acknowledgement lost"), { code: 14 });', 'return;') });
  assert.throws(() => assert.equal(missing.callbacks, 2), { code: "ERR_ASSERTION" });
});

test("native ACK wrapper forwards exact SDK transaction options and retains their attempt limit", async () => {
  const options = { maxAttempts: 8 };
  const result = await exercise({ options });
  assert.equal(result.options, options, "caller transaction options reach the native SDK unchanged");
  const inverse = await exercise({ options, text: source.replace("}, options);", "});") });
  assert.throws(() => assert.equal(inverse.options, options), { code: "ERR_ASSERTION" });
});
