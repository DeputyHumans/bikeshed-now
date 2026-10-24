// SPDX-License-Identifier: Apache-2.0
// Native retry evidence rejects missing losses, wrong identities and stale callback ordinals while retaining normal conflict retries (SPEC §12).
import test from "node:test";
import assert from "node:assert/strict";
import { assertNativeAckProof, committedAckCallers } from "../lib/native-ack.mjs";

const caller = "09d51c67-23ec-404a-9dcb-23acb309f764", other = "a66cd7a7-d6bd-43a9-987f-f5718e4c0d81";
const options = (run = 2) => ({ operation: "mcp-read", id: "d", held: { held: 1, callers: [{ key: "mcp-read:d", side: "server", caller, run }] } });
const loss = who => `E2E_ACK_LOSS mcp-read d ${who}\n`;
const retry = (who, run) => `E2E_ACK_RETRY mcp-read d ${who} callback${run}\n`;
test("a held second callback binds its lost ACK to callback three, including further native retries", () => {
  assert.deepEqual(assertNativeAckProof(loss(caller) + retry(caller, 3) + retry(caller, 4), options()), [{ caller, committedRun: 2, retryRun: 3, observedRetries: [3, 4] }]);
  assert.equal(assertNativeAckProof(loss(caller) + retry(caller, 2), options(1))[0].retryRun, 2);
});
test("two independently held native commits bind to their own callback ordinals", () => {
  const o = options(); o.count = 2; o.held.held = 2; o.held.callers.push({ ...o.held.callers[0], caller: other, run: 4 });
  const proof = assertNativeAckProof(loss(other) + loss(caller) + retry(caller, 3) + retry(other, 5), o);
  assert.deepEqual(proof.map(row => [row.caller, row.retryRun]), [[caller, 3], [other, 5]]);
});
for (const [name, text] of [
  ["hardcoded callback two", loss(caller) + retry(caller, 2)],
  ["wrong retry caller", loss(caller) + retry(other, 3)],
  ["wrong loss caller", loss(other) + retry(caller, 3)],
  ["missing loss", retry(caller, 3)],
  ["duplicate loss", loss(caller) + loss(caller) + retry(caller, 3)],
  ["retry before loss", retry(caller, 3) + loss(caller)],
  ["skipped ordinal", loss(caller) + retry(caller, 4)],
  ["ordinal prefix", loss(caller) + retry(caller, 30)],
  ["repeated retry", loss(caller) + retry(caller, 3) + retry(caller, 3)],
]) test(`native ACK proof rejects ${name}`, () => {
  assert.throws(() => assertNativeAckProof(text, options()), error => error.code === "E2E_ACK_PROOF");
});
for (const [name, change] of [
  ["wrong held key", o => { o.held.callers[0].key = "mcp-read:another"; }],
  ["client-side hold", o => { o.held.callers[0].side = "client"; }],
  ["missing ordinal", o => { delete o.held.callers[0].run; }],
  ["fractional ordinal", o => { o.held.callers[0].run = 1.5; }],
  ["duplicate caller", o => { o.count = 2; o.held.held = 2; o.held.callers.push({ ...o.held.callers[0] }); }],
]) test(`native ACK proof rejects ${name}`, () => {
  const o = options(); change(o);
  assert.throws(() => committedAckCallers(o.held, o), error => error.code === "E2E_ACK_PROOF");
});
