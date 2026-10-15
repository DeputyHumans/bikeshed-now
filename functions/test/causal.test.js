// SPDX-License-Identifier: Apache-2.0
// Causal draft ordering accounts for both inserted and deleted CRDT items (SPEC §6b, §16).

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCausalStamp, causalOrder, storedCausalStamp, readStoredCausalStamp } = require("../lib/lib/causal.js");
const stamp = (vector, deletes = {}, generation = "a".repeat(64)) => ({ generation, vector, deletes });

test("same, older, newer and concurrent inserted histories are distinct", () => {
  const a = stamp({ 1: 10, 2: 3 });
  assert.equal(causalOrder(a, a), "same");
  assert.equal(causalOrder(stamp({ 1: 10, 2: 2 }), a), "behind");
  assert.equal(causalOrder(stamp({ 1: 10, 2: 4, 3: 1 }), a), "ahead");
  assert.equal(causalOrder(stamp({ 1: 11, 2: 2 }), a), "concurrent");
  assert.equal(causalOrder(stamp({ 1: 10, 2: 3 }, {}, "b".repeat(64)), a), "generation");
});

test("deletions order equal vectors and a missing deletion cannot be hidden by a newer insertion", () => {
  const before = stamp({ 1: 10 });
  const deleted = stamp({ 1: 10 }, { 1: [[2, 3]] });
  assert.equal(causalOrder(deleted, before), "ahead");
  assert.equal(causalOrder(before, deleted), "behind");
  assert.equal(causalOrder(stamp({ 1: 11 }), deleted), "concurrent");
  assert.equal(causalOrder(stamp({ 1: 11 }, { 1: [[1, 2], [3, 2]] }), deleted), "ahead");
  assert.equal(causalOrder(stamp({ 1: 10 }, { 1: [[2, 1], [4, 1]] }), deleted), "behind");
  assert.equal(causalOrder(stamp({ 1: 10 }, { 1: [[2, 1], [3, 2]] }), deleted), "same");
});

test("bounded metadata rejects malformed clocks, ranges, generations and unknown fields", () => {
  const valid = stamp({ 1: 10 }, { 1: [[2, 3]] });
  assert.deepEqual(parseCausalStamp(valid), valid);
  assert.deepEqual(parseCausalStamp(stamp({})), stamp({}), "an untouched empty shared body has no inserted items");
  for (const bad of [null, [], {}, { ...valid, extra: true }, { ...valid, generation: "" }, stamp({ x: 10 }), stamp({ 1: -1 }), stamp({ 1: 1.5 }), stamp({ 1: Infinity }), stamp({ 1: 10 }, { 1: [[9, 2]] }), stamp({ 1: 10 }, { 1: [[2, 0]] }), stamp({ 1: 10 }, { 1: [[4, 2], [3, 1]] }), stamp({ 1: 10 }, { 2: [[1, 2]] }), stamp({ 1: 10 }, { 1: [[1, 1, 1]] }), stamp({ 1: 10 }, { 1: "bad" }), stamp(Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [i, 1]))), stamp({ 1: 20000 }, { 1: Array.from({ length: 16385 }, (_, i) => [i, 1]) })]) assert.equal(parseCausalStamp(bad), null, JSON.stringify(bad).slice(0, 120));
});


test("stored histories avoid nested arrays and retain deletion ordering after a round trip", () => {
  const original = stamp({ 1: 10 }, { 1: [[2, 3]] });
  const stored = storedCausalStamp(original);
  assert.equal(typeof stored.deletesJson, "string");
  assert.deepEqual(readStoredCausalStamp(stored), original);
  assert.equal(readStoredCausalStamp({ ...stored, deletesJson: "invalid" }), null);
  assert.equal(readStoredCausalStamp({ ...stored, deletesJson: '{"1":[[2,20]]}' }), null);
});
