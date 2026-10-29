// SPDX-License-Identifier: Apache-2.0
// The trust migration's decision: a superadmin's document keeps its trust, everyone else's is withdrawn (SPEC §6c; ADR 0021).

import test from "node:test";
import assert from "node:assert/strict";
import { parseSuperadmins, reconciledTrust } from "../scripts/reconcile-trust.mjs";

const admins = parseSuperadmins(" Admin@Example.com, second@example.com ");

test("the superadmin list is read as the functions read it", () => {
  assert.deepEqual([...admins].sort(), ["admin@example.com", "second@example.com"]);
  assert.equal(parseSuperadmins("").size, 0);
  assert.equal(parseSuperadmins(undefined).size, 0);
});

test("a superadmin's document trusted under the old rule keeps it, written out", () => {
  assert.equal(reconciledTrust({ ownerEmail: "admin@example.com" }, admins), true, "absent was trusted, and stays so explicitly");
  assert.equal(reconciledTrust({ ownerEmail: "ADMIN@example.com", trusted: true }, admins), null, "already right");
});

test("everyone else's trusted document is withdrawn, and an untrusted one is never widened", () => {
  assert.equal(reconciledTrust({ ownerEmail: "owner@example.com" }, admins), false);
  assert.equal(reconciledTrust({ ownerEmail: "owner@example.com", trusted: true }, admins), false);
  assert.equal(reconciledTrust({ ownerEmail: "owner@example.com", trusted: false }, admins), null);
  // A superadmin's document that is not trusted stays untrusted: the
  // migration only ever narrows.
  assert.equal(reconciledTrust({ ownerEmail: "admin@example.com", trusted: false }, admins), null);
  // No owner on record, no superadmins at all: withdrawn.
  assert.equal(reconciledTrust({}, admins), false);
  assert.equal(reconciledTrust({ ownerEmail: "admin@example.com", trusted: true }, new Set()), false);
});
