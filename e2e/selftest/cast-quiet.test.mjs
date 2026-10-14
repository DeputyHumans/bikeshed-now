// SPDX-License-Identifier: Apache-2.0
// Self-test: cast(…, {notifications: false}) writes the opt-out record before any session, after the account is ledgered (SPEC §12, §14).

/**
 * Production accounts are cast with users/{uid} {emailNotifications: false}
 * already written (castAdmin). A local account gets the same record only when
 * asked, because some specs must watch the product write it at the first POST
 * /session. The Auth REST calls go to a recording fetch and the record write
 * to a stand-in, so this needs no stack.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cast, castOne, optOutRecord } from "../lib/accounts.mjs";
import { createHttp } from "../lib/http.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const local = () => Object.freeze({
  kind: "local",
  runId: "2610101200-cstq",
  runDir: tempDir("e2e-castq-"),
  origin: "http://127.0.0.1:39001",
  webApiKey: "demo-api-key",
  authRestBase: "http://127.0.0.1:39002/identitytoolkit.googleapis.com/v1",
  stack: { ports: { hosting: 39001, auth: 39002 } },
});

/** The Auth emulator's two calls, answered: signUp mints uid-<n>, update says ok. */
function fakeAuth(t) {
  const calls = [];
  let n = 0;
  const fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    const body = u.pathname.endsWith("accounts:signUp") ? { localId: `uid-${++n}`, idToken: "x" } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, http: createHttp(t, { evidence: false, fetch }) };
}

/** A writeUser stand-in that also records how much of the ledger existed when it was called. */
function recorder(t) {
  const writes = [];
  const writeUser = async (target, uid, data) => {
    writes.push({ uid, data, ledgered: readLedger(target).filter((r) => r.kind === "account").map((r) => r.uid) });
    return data;
  };
  return { writes, writeUser };
}

test("cast {notifications: false}: each account's users/{uid} gets emailNotifications false, once, after its ledger row", async () => {
  const t = local();
  const { http } = fakeAuth(t);
  const rec = recorder(t);
  const accounts = await cast(t, ["owner", "viewer"], { notifications: false, http, writeUser: rec.writeUser });
  assert.equal(accounts.length, 2);
  assert.deepEqual(rec.writes.map((w) => w.uid), ["uid-1", "uid-2"]);
  for (const [i, w] of rec.writes.entries()) {
    assert.deepEqual(w.data, { uid: accounts[i].uid, email: accounts[i].email.toLowerCase(), emailNotifications: false });
    assert.ok(w.ledgered.includes(w.uid), "the account is in the ledger before its record is written");
  }
  assert.deepEqual(readLedger(t).map((r) => [r.kind, r.uid]), [["account", "uid-1"], ["account", "uid-2"]]);
  assert.ok(accounts.every((a) => Object.isFrozen(a) && a.password && !("notifications" in a)), "the account objects are as before");
});

test("cast: without the option no record is written (the product writes it at the first session)", async () => {
  const t = local();
  const { http } = fakeAuth(t);
  const rec = recorder(t);
  await cast(t, ["owner"], { http, writeUser: rec.writeUser });
  await cast(t, ["owner"], { notifications: true, http, writeUser: rec.writeUser });
  await castOne(t, "owner", { http, writeUser: rec.writeUser });
  assert.deepEqual(rec.writes, []);
});

test("cast {analytics: false}, alone or with notifications, and castOne passes the options through", async () => {
  const t = local();
  const { http } = fakeAuth(t);
  const rec = recorder(t);
  await cast(t, ["a"], { analytics: false, http, writeUser: rec.writeUser });
  await castOne(t, "b", { notifications: false, analytics: false, http, writeUser: rec.writeUser });
  assert.deepEqual(rec.writes.map((w) => w.data), [
    { uid: "uid-1", email: rec.writes[0].data.email, analyticsOptOut: true },
    { uid: "uid-2", email: rec.writes[1].data.email, emailNotifications: false, analyticsOptOut: true },
  ]);
});

test("cast: a malformed option is refused before any account exists; production never takes notifications on", async () => {
  const t = local();
  const auth = fakeAuth(t);
  const rec = recorder(t);
  await assert.rejects(cast(t, ["owner"], { notifications: "no", http: auth.http, writeUser: rec.writeUser }), /notifications is true or false/);
  assert.deepEqual([auth.calls, readLedger(t), rec.writes], [[], [], []]);
  const prod = { ...t, kind: "prod" };
  await assert.rejects(cast(prod, ["owner"], { notifications: true }), /always cast with email and analytics off/);
  await assert.rejects(cast(prod, ["owner"], { analytics: true }), /always cast with email and analytics off/);
});

test("optOutRecord: exactly the opt-outs asked for, the email lowercased, and null when none", () => {
  const a = { uid: "u", email: "Owner-X@Example.com" };
  assert.equal(optOutRecord(a, {}), null);
  assert.equal(optOutRecord(a, { notifications: true, analytics: true }), null);
  assert.deepEqual(optOutRecord(a, { notifications: false }), { uid: "u", email: "owner-x@example.com", emailNotifications: false });
  assert.throws(() => optOutRecord(a, { analytics: 0 }), /analytics is true or false/);
});
