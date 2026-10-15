// SPDX-License-Identifier: Apache-2.0
// Bind native ACK loss and retry evidence to each actually committed gate caller and callback ordinal (SPEC §12).
import { readLog, waitForLog } from "./logs.mjs";

const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const need = (ok, message) => { if (!ok) throw Object.assign(new Error(`native ACK proof: ${message}`), { code: "E2E_ACK_PROOF" }); };

/** Normal contention can precede the commit whose acknowledgement is lost. */
export function committedAckCallers(held, { operation, id, count = 1 }) {
  need(typeof operation === "string" && operation && typeof id === "string" && id, "operation and document key are required");
  need(Number.isInteger(count) && count > 0, "a positive caller count is required");
  need(held?.held === count && Array.isArray(held.callers) && held.callers.length === count, `exactly ${count} committed callers must be held`);
  const seen = new Set();
  return held.callers.map(row => {
    need(row.key === `${operation}:${id}` && row.side === "server", "held caller belongs to the exact server operation and key");
    need(UUID.test(row.caller ?? "") && !seen.has(row.caller), "held callers must have distinct request identities");
    need(Number.isSafeInteger(row.run) && row.run > 0, "held commit must name a positive callback ordinal");
    seen.add(row.caller);
    return { caller: row.caller, committedRun: row.run, retryRun: row.run + 1 };
  });
}

/** Validate complete captured output, including operator stdout. */
export function assertNativeAckProof(text, options) {
  const callers = committedAckCallers(options.held, options);
  const prefix = `${escape(options.operation)} ${escape(options.id)}`;
  const losses = [...text.matchAll(new RegExp(`\\bE2E_ACK_LOSS ${prefix} ([a-f0-9-]+)(?=\\s|$)`, "g"))];
  need(losses.length === callers.length, "every held caller must lose exactly one committed acknowledgement");
  const expected = new Set(callers.map(row => row.caller));
  need(losses.every(loss => expected.has(loss[1])), "loss identity must match an actually held committed caller");
  return callers.map(row => {
    const own = losses.filter(loss => loss[1] === row.caller);
    need(own.length === 1, "each committed caller must have exactly one loss marker");
    const retries = [...text.matchAll(new RegExp(`\\bE2E_ACK_RETRY ${prefix} ${escape(row.caller)} callback([0-9]+)(?=\\s|$)`, "g"))];
    need(retries.length > 0, "the committed caller must retry after losing its acknowledgement");
    for (const [index, retry] of retries.entries()) {
      need(retry.index > own[0].index, "retry evidence must follow the same caller's loss");
      need(Number(retry[1]) === row.retryRun + index, "retry ordinal must follow the held committed callback without skipping or repeating");
    }
    return { ...row, observedRetries: retries.map(retry => Number(retry[1])) };
  });
}

/** Wait only for the proven caller's next callback, then validate all markers. */
export async function waitForNativeAckProof({ file, since, ...options }) {
  const callers = committedAckCallers(options.held, options);
  for (const row of callers) {
    await waitForLog(`E2E_ACK_LOSS ${options.operation} ${options.id} ${row.caller}`, { file, since });
    await waitForLog(new RegExp(`E2E_ACK_RETRY ${escape(options.operation)} ${escape(options.id)} ${escape(row.caller)} callback${row.retryRun}(?=\\s|$)`), { file, since });
  }
  return assertNativeAckProof(readLog(file, since), options);
}
