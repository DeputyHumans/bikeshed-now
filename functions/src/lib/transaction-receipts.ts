// SPDX-License-Identifier: Apache-2.0
// Bound retry receipts to one server operation without replaying its effects after a lost acknowledgement (SPEC §6a, §17).
import { randomUUID } from "node:crypto";
import { FieldValue, type DocumentReference, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";

export type TransactionReceipt = Readonly<{ id: string; startedAtMs: number }>;
type ReceiptSnapshot = Pick<DocumentSnapshot, "data">;
const MAX_OPERATION_MS = 5 * 60_000;
const RETAIN_RECEIPT_MS = 10 * 60_000;

export function freshReceiptId(): TransactionReceipt {
  return Object.freeze({ id: randomUUID(), startedAtMs: Date.now() });
}

function requireFresh(receipt: TransactionReceipt, nowMs: number): void {
  if (nowMs - receipt.startedAtMs >= MAX_OPERATION_MS) {
    throw new Error("This operation took too long to confirm. Reload before trying again.");
  }
}

/** An already committed result wins even after the new-write deadline. Results
 * contain only the caller's bounded, non-secret return value, never a snapshot.
 */
export function readReceipt<T>(snapshot: ReceiptSnapshot, receipt: TransactionReceipt, nowMs = Date.now()): { found: true; result: T } | { found: false } {
  const own = snapshot.data()?.transactionReceipts?.[receipt.id];
  if (own && typeof own.recordedAtMs === "number" && Number.isFinite(own.recordedAtMs) && Object.hasOwn(own, "result")) {
    return { found: true, result: own.result as T };
  }
  requireFresh(receipt, nowMs);
  return { found: false };
}

/** Call only with a real operation's writes, after all transaction reads. A
 * crashed process may leave a receipt; a later write prunes it after twice the
 * maximum new-write age. An old invocation can then refuse, never reapply.
 */
export function recordReceipt<T>(tx: Transaction, ref: DocumentReference, snapshot: ReceiptSnapshot, receipt: TransactionReceipt, result: T, nowMs = Date.now()): void {
  requireFresh(receipt, nowMs);
  const fields: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(snapshot.data()?.transactionReceipts ?? {})) {
    const recordedAtMs = (value as { recordedAtMs?: unknown })?.recordedAtMs;
    if (typeof recordedAtMs === "number" && Number.isFinite(recordedAtMs) && nowMs - recordedAtMs >= RETAIN_RECEIPT_MS) fields[id] = FieldValue.delete();
  }
  fields[receipt.id] = { recordedAtMs: nowMs, result };
  tx.set(ref, { transactionReceipts: fields }, { merge: true });
}

/** Run only after runTransaction resolves, when no native callback can retry.
 * A failed cleanup is harmless: the next real write can expire this marker.
 */
export async function clearReceipt(ref: DocumentReference, receipt: TransactionReceipt): Promise<void> {
  try { await ref.update({ [`transactionReceipts.${receipt.id}`]: FieldValue.delete() }); }
  catch { /* bookkeeping is best-effort; never turn durable success into failure */ }
}
