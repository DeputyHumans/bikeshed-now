// SPDX-License-Identifier: Apache-2.0
// The endpoint test double retries contended transactions and commits writes atomically (SPEC §12).

const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore } = require("./fakes.js");

function signal() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("conditional document updates reject a stale or deleted snapshot and accept the current one", async () => {
  const { db, store } = fakeFirestore({ "docs/one": { value: "original" } });
  const ref = db.doc("docs/one");
  const old = await ref.get();
  await ref.update({ value: "newer" });
  await assert.rejects(ref.update({ value: "lost" }, { lastUpdateTime: old.updateTime }), { code: 9 });
  assert.equal(store.get("docs/one").value, "newer");
  const current = await ref.get();
  await ref.update({ value: "accepted" }, { lastUpdateTime: current.updateTime });
  assert.equal(store.get("docs/one").value, "accepted");
  const beforeDelete = await ref.get();
  await ref.delete();
  await assert.rejects(ref.update({ value: "resurrected" }, { lastUpdateTime: beforeDelete.updateTime }), { code: 9 });
  assert.equal(store.has("docs/one"), false);
});

test("two increments that read the same value retry instead of losing one", async () => {
  const { db, store } = fakeFirestore({ "counters/one": { value: 0 } });
  const both = signal();
  let reads = 0;
  const increment = () => db.runTransaction(async (tx) => {
    const ref = db.doc("counters/one");
    const before = (await tx.get(ref)).data().value;
    reads++;
    if (reads === 2) both.resolve();
    await both.promise;
    tx.update(ref, { value: before + 1 });
    return before + 1;
  });
  assert.deepEqual((await Promise.all([increment(), increment()])).sort(), [1, 2]);
  assert.equal(store.get("counters/one").value, 2);
  assert.equal(reads, 3, "the second transaction reran its read and callback");
});

test("a query read retries when a matching document is created before commit", async () => {
  const { db, store } = fakeFirestore({ "reviews/a": { pending: true } });
  const read = signal();
  const release = signal();
  let calls = 0;
  const counting = db.runTransaction(async (tx) => {
    const snap = await tx.get(db.collection("reviews").where("pending", "==", true));
    calls++;
    read.resolve();
    await release.promise;
    tx.set(db.doc("totals/reviews"), { value: snap.docs.length });
  });
  await read.promise;
  await db.doc("reviews/b").set({ pending: true });
  release.resolve();
  await counting;
  assert.equal(store.get("totals/reviews").value, 2);
  assert.equal(calls, 2);
});

for (const kind of ["batch", "transaction"]) {
  test(`${kind}: a refused write leaves every earlier write uncommitted`, async () => {
    const { db, store } = fakeFirestore({ "docs/existing": { value: "original" } });
    const writes = (writer) => {
      writer.set(db.doc("docs/new"), { value: "must not survive" });
      writer.update(db.doc("docs/missing"), { value: "replacement" });
    };
    await assert.rejects(kind === "batch" ? (() => {
      const batch = db.batch();
      writes(batch);
      return batch.commit();
    })() : db.runTransaction(async (tx) => writes(tx)), /no document to update/);
    assert.equal(store.has("docs/new"), false);
    assert.deepEqual(store.get("docs/existing"), { value: "original" });
  });
}

