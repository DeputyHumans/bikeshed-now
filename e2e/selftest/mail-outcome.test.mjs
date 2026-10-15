// SPDX-License-Identifier: Apache-2.0
// Provider refusal timing never turns a missing application response into a product verdict (SPEC §14).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { judgeProviderFailureResponse } from "../lib/mail/outcome.mjs";

const request = { what: "POST /access", sentAt: 1_000, answeredAt: 61_000 };
const refusal = (ms) => ({ at: new Date(request.sentAt + ms).toISOString(), status: 500 });
function assertCutoffs(judge) {
  for (const requests of [[], [refusal(100)], [refusal(59_999)], [refusal(60_001)], [refusal(100), { ...refusal(500), status: 200 }]]) {
    const result = judge({ ...request, res: { status: 504 }, cutOff: true, requests });
    assert.equal(result.verdict, "INC", "a cutoff cannot prove success or the cause of failure");
    assert.match(result.reason, /no measured application response/);
    assert.ok(result.reason.includes(JSON.stringify(requests.map((r) => ({ ms: Date.parse(r.at) - request.sentAt, status: r.status })))), "the evidence preserves each observation and its time");
  }
}
function assertApplicationAnswers(judge) {
  assert.deepEqual(judge({ ...request, res: { status: 200 } }), { verdict: "PASS" });
  for (const status of [400, 500, 504]) {
    assert.throws(() => judge({ ...request, res: { status, text: "application error" } }), { code: "ERR_ASSERTION", actual: status, expected: 200 }, "a real non-200 answer stays a failure, including an application's own 504");
  }
}

test("cutoffs with no refusal, an early or late refusal, or later provider progress stay inconclusive", () => assertCutoffs(judgeProviderFailureResponse));
test("only a measured 200 passes; application errors remain decisive failures", () => assertApplicationAnswers(judgeProviderFailureResponse));
test("negative controls expose both a passing cutoff and a swallowed application error", async () => {
  const source = readFileSync(new URL("../lib/mail/outcome.mjs", import.meta.url), "utf8");
  for (const [before, after, oracle] of [
    ['verdict: "INC"', 'verdict: "PASS"', assertCutoffs],
    ['assert.equal(res.status, 200,', 'assert.equal(200, 200,', assertApplicationAnswers],
  ]) {
    assert.ok(source.includes(before), "the mutation changes live code");
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(before, after)).toString("base64")}`);
    assert.throws(() => oracle(mutant.judgeProviderFailureResponse), { code: "ERR_ASSERTION" }, "the same oracle rejects the wrong classifier");
  }
});
