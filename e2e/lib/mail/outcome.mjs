// SPDX-License-Identifier: Apache-2.0
// Judge provider-failure responses without attributing a shared stack's timeout from timing alone (SPEC §14).

import assert from "node:assert/strict";

/** A cutoff is missing evidence; an application's own error response remains a failure. */
export function judgeProviderFailureResponse({ res, cutOff = false, requests = [], what, sentAt, answeredAt }) {
  if (!cutOff) {
    assert.equal(res.status, 200, `${what} answered ${res.status} when the provider refused the send: ${String(res.text ?? "").slice(0, 200)}`);
    return { verdict: "PASS" };
  }
  const observed = requests.map((r) => ({ ms: Date.parse(r.at) - sentAt, status: r.status }));
  return {
    verdict: "INC",
    reason: `${what} had no measured application response before the ${answeredAt - sentAt} ms cutoff; provider observations ${JSON.stringify(observed)}. Their timing cannot distinguish product delay from shared-stack scheduling`,
  };
}
