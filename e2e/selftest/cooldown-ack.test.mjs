// SPDX-License-Identifier: Apache-2.0
// Mail ACK judges distinguish a measured message count from infrastructure or malformed mailbox failures (SPEC §14).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../specs/functional/a23-cooldown-ack.spec.mjs", import.meta.url), "utf8");
const start = source.indexOf("async function noticeCount("), end = source.indexOf('\nscenario(', start);
assert.ok(start > 0 && end > start);
const body = source.slice(start, end);
function judge(text = body) { return new Function("assert", `${text}; return noticeCount;`)(assert); }
const invoke = (run, action, count) => run({ box: { expectMail: action } }, "local@example.com", "subject", count, "exact notice count");
test("ACK mail count judge passes only the measured expected count", async () => {
  const run = judge();
  await invoke(run, async () => ({ messages: [{}] }), 1);
  await invoke(run, async () => ({ messages: [] }), 0);
  await assert.rejects(invoke(run, async () => { throw Object.assign(new Error("not delivered"), { code: "E2E_MAIL", seen: [] }); }, 1), { code: "ERR_ASSERTION", message: /exact notice count/ });
  await assert.rejects(invoke(run, async () => { throw Object.assign(new Error("unexpected delivery"), { code: "E2E_MAIL", seen: [{}] }); }, 0), { code: "ERR_ASSERTION", message: /exact notice count/ });
});
test("ACK mail count judge never translates transport or malformed mailbox failures into an intended oracle", async () => {
  for (const failure of [Object.assign(new Error("socket reset"), { code: "E2E_HTTP", seen: [] }), Object.assign(new Error("bad mailbox response"), { code: "E2E_MAIL" })]) {
    await assert.rejects(invoke(judge(), async () => { throw failure; }, 1), error => error === failure);
  }
  const inverse = judge(body.replace('if (error?.code !== "E2E_MAIL" || !Array.isArray(error.seen)) throw error;', 'if (!Array.isArray(error.seen)) throw error;'));
  const transport = Object.assign(new Error("socket reset"), { code: "E2E_HTTP", seen: [] });
  await assert.rejects(invoke(inverse, async () => { throw transport; }, 1), { code: "ERR_ASSERTION" });
});
