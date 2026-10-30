// SPDX-License-Identifier: Apache-2.0
// Drive native Firestore retries through contention and lost atomic-commit acknowledgements (SPEC §6a, §17).
const { Transaction } = require("@google-cloud/firestore/build/src/transaction.js");

// Native runTransaction and runTransactionOnce remain unchanged. Only the
// transport, clock backoff and trace sink are replaced; code 14 is the actual
// SDK retryable UNAVAILABLE status, and code 10 is ABORTED contention.
// Rollback cannot undo a completed commit; retry options come from the caller.
function loseFirstTransactionAcknowledgement(db, { afterCommit = async () => {}, abortCommits = 0 } = {}) {
  const transact = db.runTransaction.bind(db); let failures = 0; let callbackCalls = 0;
  db.runTransaction = (work, { maxAttempts = 5 } = {}) => {
    let queued = [];
    const sdk = Object.create(Transaction.prototype);
    Object.assign(sdk, {
      _firestore: { _traceUtil: { startActiveSpan: (_name, fn) => fn({ setAttributes() {}, addEvent() {} }) } },
      _requestTag: "controlled-ack-loss", _maxAttempts: maxAttempts,
      _writeBatch: { _reset: () => { queued = []; } },
      _backoff: { backoffAndWait: async () => {}, resetToMax() {} },
      get: ref => ref.get(),
      create: (...args) => { queued.push(["create", args]); return sdk; },
      set: (...args) => { queued.push(["set", args]); return sdk; },
      update: (...args) => { queued.push(["update", args]); return sdk; },
      delete: (...args) => { queued.push(["delete", args]); return sdk; },
      commit: async () => {
        if (abortCommits > 0) {
          abortCommits--;
          throw Object.assign(new Error("Transaction lock timeout."), { code: 10 });
        }
        await transact(async tx => { for (const [method, args] of queued) tx[method](...args); });
        if (queued.length && failures === 0) {
          failures++;
          await afterCommit();
          throw Object.assign(new Error("committed; acknowledgement lost"), { code: 14 });
        }
      },
      rollback: async () => {},
    });
    return sdk.runTransaction(tx => { callbackCalls++; return work(tx); });
  };
  return () => ({ callbackCalls, failures });
}
module.exports = { loseFirstTransactionAcknowledgement };
