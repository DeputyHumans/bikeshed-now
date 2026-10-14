// SPDX-License-Identifier: Apache-2.0
// Self-test: queryCollection sends each [field, op, value] triple as one Admin SDK where(), ANDed, and refuses a malformed one before reading (SPEC §12, §21).

/**
 * Hermetic: a stand-in for the Admin SDK's Firestore handle holds a few
 * documents and applies where(field, op, value) as Firestore does for the
 * operators used here, recording every call. What it proves is the
 * translation: the collection named, each filter sent once and in order, the
 * snapshot mapped to [{id, data}], and that nothing is read when the
 * arguments are wrong. That Firestore itself answers such a query is checked
 * live (see the lib owner's report), not here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { WHERE_OPS, queryCollection } from "../lib/admin.mjs";

const DOCS = {
  forks: [
    { id: "f-a", data: { parentId: "src-1", childId: "a", ownerUid: "u1", n: 1 } },
    { id: "f-b", data: { parentId: "src-2", childId: "b", ownerUid: "u1", n: 2 } },
    { id: "f-c", data: { parentId: "src-1", childId: "c", ownerUid: "u2", n: 3 } },
  ],
};

function get(data, field) {
  return field.split(".").reduce((v, k) => (v == null ? undefined : v[k]), data);
}

const APPLY = {
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
  ">": (a, b) => a > b,
  "<": (a, b) => a < b,
  in: (a, b) => b.includes(a),
};

/** A Firestore-shaped handle over DOCS: collection(path).where(…)….get() → {docs: [{id, data()}]}. */
function fakeDb() {
  const calls = [];
  const query = (path, filters) => ({
    where(field, op, value) {
      calls.push(["where", path, field, op, value]);
      return query(path, [...filters, [field, op, value]]);
    },
    async get() {
      calls.push(["get", path, filters.length]);
      const rows = (DOCS[path] ?? []).filter((d) => filters.every(([f, op, v]) => APPLY[op](get(d.data, f), v)));
      return { docs: rows.map((d) => ({ id: d.id, data: () => structuredClone(d.data) })) };
    },
  });
  return {
    calls,
    collection(path) {
      calls.push(["collection", path]);
      return query(path, []);
    },
  };
}

const TARGET = Object.freeze({ kind: "local", runId: "2610110600-qcol" });

test("queryCollection: the named collection, every triple one where() in order, the snapshot as [{id, data}]", async () => {
  const db = fakeDb();
  const out = await queryCollection(TARGET, "forks", [["parentId", "==", "src-1"]], { db });
  assert.deepEqual(out, [
    { id: "f-a", data: DOCS.forks[0].data },
    { id: "f-c", data: DOCS.forks[2].data },
  ]);
  assert.deepEqual(db.calls, [["collection", "forks"], ["where", "forks", "parentId", "==", "src-1"], ["get", "forks", 1]]);

  const and = fakeDb();
  const both = await queryCollection(TARGET, "forks", [["parentId", "==", "src-1"], ["ownerUid", "==", "u2"]], { db: and });
  assert.deepEqual(both.map((d) => d.id), ["f-c"], "filters are ANDed");
  assert.deepEqual(and.calls.filter((c) => c[0] === "where").map((c) => c.slice(2)), [["parentId", "==", "src-1"], ["ownerUid", "==", "u2"]]);

  const all = fakeDb();
  assert.deepEqual((await queryCollection(TARGET, "forks", [], { db: all })).map((d) => d.id), ["f-a", "f-b", "f-c"], "no filter is the whole collection");
  assert.deepEqual((await queryCollection(TARGET, "forks", undefined, { db: all })).length, 3, "filters default to none");
  assert.deepEqual((await queryCollection(TARGET, "forks", [["n", "in", [2, 3]]], { db: fakeDb() })).map((d) => d.id), ["f-b", "f-c"]);
  assert.deepEqual(await queryCollection(TARGET, "docs/d1/versions", [["n", ">", 0]], { db: fakeDb() }), [], "a subcollection path is a collection path");
  assert.equal(WHERE_OPS.length, 10);
});

test("NEGATIVE: a malformed path or filter throws before anything is read", async () => {
  const cases = [
    ["forks/f-a", [], /path is a collection path/],
    ["", [], /path is a collection path/],
    ["docs//versions", [], /path is a collection path/],
    [null, [], /path is a collection path/],
    ["forks", ["parentId", "==", "src-1"], /a LIST of \[field, op, value\] triples: wrap/],
    ["forks", "parentId == src-1", /filters is a list/],
    ["forks", [["parentId", "==="]], /filter 0 is a \[field, op, value\] triple/],
    ["forks", [["parentId", "===", "x"]], /filter 0: op is one of < <= == != >= > array-contains in not-in array-contains-any/],
    ["forks", [["parentId", "==", "x"], ["", "==", "x"]], /filter 1: field is a dotted field path/],
    ["forks", [["a..b", "==", "x"]], /field is a dotted field path/],
    ["forks", [["parentId", "==", undefined]], /value is undefined/],
    ["forks", [["n", "in", []]], /"in" takes a non-empty array/],
    ["forks", [["n", "array-contains-any", 3]], /"array-contains-any" takes a non-empty array/],
  ];
  for (const [path, filters, re] of cases) {
    const db = fakeDb();
    await assert.rejects(queryCollection(TARGET, path, filters, { db }), re, `${JSON.stringify(path)} ${JSON.stringify(filters)}`);
    assert.deepEqual(db.calls, [], "nothing was read");
  }
  // null is a value Firestore stores, and is sent.
  const db = fakeDb();
  await queryCollection(TARGET, "forks", [["parentId", "==", null]], { db });
  assert.deepEqual(db.calls[1], ["where", "forks", "parentId", "==", null]);
});
