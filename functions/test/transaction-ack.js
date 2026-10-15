// SPDX-License-Identifier: Apache-2.0
// Drive the installed Firestore transaction retry loop after an atomic fake commit loses its acknowledgement (SPEC §6a).
const { Transaction } = require("@google-cloud/firestore/build/src/transaction.js");

// Native runTransaction and runTransactionOnce remain unchanged. Only the
// transport, clock backoff and trace sink are replaced; code 14 is the actual
// SDK retryable UNAVAILABLE status. Rollback cannot undo a completed commit.
function loseFirstTransactionAcknowledgement(db, { afterCommit = async () => {} } = {}) {
  const transact = db.runTransaction.bind(db); let failures = 0; let callbackCalls = 0;
  db.runTransaction = work => {
    let queued = [];
    const sdk = Object.create(Transaction.prototype);
    Object.assign(sdk, {
      _firestore: { _traceUtil: { startActiveSpan: (_name, fn) => fn({ setAttributes() {}, addEvent() {} }) } },
      _requestTag: "controlled-ack-loss", _maxAttempts: 3,
      _writeBatch: { _reset: () => { queued = []; } },
      _backoff: { backoffAndWait: async () => {}, resetToMax() {} },
      get: ref => ref.get(),
      set: (...args) => { queued.push(["set", args]); return sdk; },
      update: (...args) => { queued.push(["update", args]); return sdk; },
      delete: (...args) => { queued.push(["delete", args]); return sdk; },
      commit: async () => {
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
