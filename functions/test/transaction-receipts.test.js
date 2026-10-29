// SPDX-License-Identifier: Apache-2.0
// Receipt cleanup and expiry preserve concurrent operations while refusing an old callback whose proof was pruned (SPEC §6a).
const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore } = require("./fakes.js");
const { freshReceiptId, readReceipt, recordReceipt, clearReceipt } = require("../lib/lib/transaction-receipts.js");
const receipt = (id, startedAtMs = 0) => ({ id, startedAtMs });
const snapshot = data => ({ data: () => data });

test("receipt IDs are distinct opaque UUIDs with an immutable local deadline", () => {
  const first = freshReceiptId(), second = freshReceiptId();
  assert.match(first.id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.notEqual(first.id, second.id);
  assert.ok(Math.abs(first.startedAtMs - Date.now()) < 1000);
  assert.ok(Object.isFrozen(first));
});
test("an absent receipt refuses new work at five minutes, but its own durable result remains readable", () => {
  const token = receipt("mine");
  assert.deepEqual(readReceipt(snapshot({}), token, 299_999), { found: false });
  assert.throws(() => readReceipt(snapshot({}), token, 300_000), /too long to confirm/);
  assert.deepEqual(readReceipt(snapshot({ transactionReceipts: { mine: { recordedAtMs: 1, result: { accepted: true } } } }), token, 900_000), { found: true, result: { accepted: true } });
  assert.throws(() => readReceipt(snapshot({ transactionReceipts: { other: { recordedAtMs: 1, result: true } } }), token, 900_000), /too long to confirm/, "another request cannot prove this expired request committed");
});
test("a callback that passes its deadline after reading cannot record or apply another write", () => {
  let writes = 0;
  assert.throws(() => recordReceipt({ set() { writes++; } }, {}, snapshot({}), receipt("mine"), true, 300_000), /too long to confirm/);
  assert.equal(writes, 0);
});
test("a real write prunes only stale receipts; own cleanup preserves newer and concurrently added receipts", async () => {
  const w = fakeFirestore({ "docs/d": { keep: "document", transactionReceipts: {
    old: { recordedAtMs: 1, result: "old" }, recent: { recordedAtMs: 500_000, result: "recent" },
  } } }), ref = w.db.doc("docs/d"), token = receipt("mine", 600_000);
  await w.db.runTransaction(async tx => {
    const before = await tx.get(ref);
    recordReceipt(tx, ref, before, token, { counted: true }, 600_001);
    tx.update(ref, { keep: "changed" });
  });
  assert.equal(w.store.get("docs/d").transactionReceipts.old, undefined, "the stale marker is removed by a later real write");
  assert.deepEqual(w.store.get("docs/d").transactionReceipts.recent, { recordedAtMs: 500_000, result: "recent" });
  assert.deepEqual(readReceipt(await ref.get(), token, 600_002), { found: true, result: { counted: true } });
  await ref.update({ "transactionReceipts.later": { recordedAtMs: 600_003, result: "later" } });
  await clearReceipt(ref, token);
  assert.equal(w.store.get("docs/d").transactionReceipts?.mine, undefined, "a resolved request removes only its own marker");
  assert.equal(w.store.get("docs/d").transactionReceipts?.later?.result, "later", "own cleanup preserves a concurrent receipt");
  assert.equal(w.store.get("docs/d").transactionReceipts?.recent?.result, "recent");
  assert.equal(w.store.get("docs/d").keep, "changed");
});
test("cleanup failure retains the receipt without turning a confirmed operation into failure", async () => {
  const w = fakeFirestore({ "docs/d": { transactionReceipts: { mine: { recordedAtMs: 1, result: true } } } });
  await assert.doesNotReject(clearReceipt({ update: async () => { throw new Error("transport unavailable"); } }, receipt("mine")));
  assert.deepEqual(readReceipt(await w.db.doc("docs/d").get(), receipt("mine"), 999_999), { found: true, result: true });
});
