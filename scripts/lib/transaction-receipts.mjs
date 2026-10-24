// SPDX-License-Identifier: Apache-2.0
// Bound operator retry receipts to one completed operation; kept in parity with the Functions helper (SPEC §9, §17).
import { randomUUID } from 'node:crypto';
import { FieldValue } from './firebase.mjs';
const MAX_OPERATION_MS = 5 * 60_000;
const RETAIN_RECEIPT_MS = 10 * 60_000;

export function freshReceiptId() {
  return Object.freeze({ id: randomUUID(), startedAtMs: Date.now() });
}

function requireFresh(receipt, nowMs) {
  if (nowMs - receipt.startedAtMs >= MAX_OPERATION_MS) {
    throw new Error('This operation took too long to confirm. Reload before trying again.');
  }
}

/** Durable acknowledgement wins even after the new-write deadline. */
export function readReceipt(snapshot, receipt, nowMs = Date.now()) {
  const own = snapshot.data()?.transactionReceipts?.[receipt.id];
  if (own && typeof own.recordedAtMs === 'number' && Number.isFinite(own.recordedAtMs) && Object.hasOwn(own, 'result')) {
    return { found: true, result: own.result };
  }
  requireFresh(receipt, nowMs);
  return { found: false };
}

/** Store only the bounded, non-secret result with the operation's real writes. */
export function recordReceipt(tx, ref, snapshot, receipt, result, nowMs = Date.now()) {
  requireFresh(receipt, nowMs);
  const fields = {};
  for (const [id, value] of Object.entries(snapshot.data()?.transactionReceipts ?? {})) {
    const recordedAtMs = value?.recordedAtMs;
    if (typeof recordedAtMs === 'number' && Number.isFinite(recordedAtMs) && nowMs - recordedAtMs >= RETAIN_RECEIPT_MS) fields[id] = FieldValue.delete();
  }
  fields[receipt.id] = { recordedAtMs: nowMs, result };
  tx.set(ref, { transactionReceipts: fields }, { merge: true });
}

/** Remove only this marker after native retries finish; cleanup is best-effort. */
export async function clearReceipt(ref, receipt) {
  try { await ref.update({ [`transactionReceipts.${receipt.id}`]: FieldValue.delete() }); }
  catch { /* A later real write can expire the marker without changing this result. */ }
}
