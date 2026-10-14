// SPDX-License-Identifier: Apache-2.0
// Self-test: a REST cast whose fresh address the Auth emulator says is taken (EMAIL_EXISTS) is cast again under another fresh one, and only then (SPEC §12, §14).

/**
 * localEmail's suffix is four characters of 36, and a long-lived shared stack
 * holds thousands of accounts per role under one run tag, so a fresh address
 * is now and then one already signed up (A7.7 failed in setup on it). The
 * Auth REST calls go to a recording fetch that answers the emulator's own
 * refusal, 400 {error: {code: 400, message: "EMAIL_EXISTS", errors: […]}}, to
 * the signUps it is told to, so this needs no stack.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cast, castUnverified, passwordFor, runTag } from "../lib/accounts.mjs";
import { createHttp } from "../lib/http.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const local = () => Object.freeze({
  kind: "local",
  runId: "2610121500-taken",
  runDir: tempDir("e2e-taken-"),
  origin: "http://127.0.0.1:39021",
  webApiKey: "demo-api-key",
  authRestBase: "http://127.0.0.1:39022/identitytoolkit.googleapis.com/v1",
  stack: { ports: { hosting: 39021, auth: 39022 } },
});

/** The firebase-tools Auth emulator's refusal (errors.js BadRequestError), as it serialises it. */
const refusal = (message) => ({ error: { code: 400, message, errors: [{ message, reason: "invalid", domain: "global" }] } });

/**
 * The Auth emulator, recorded: the signUps numbered in `refuse` (1-based) are
 * answered 400 with `message`; every other signUp mints uid-<n>; an update
 * says ok.
 */
function fakeAuth(t, { refuse = [], message = "EMAIL_EXISTS" } = {}) {
  const calls = [];
  let signUps = 0;
  let n = 0;
  const fetch = async (url, init) => {
    const u = new URL(String(url));
    const body = JSON.parse(init.body);
    calls.push({ op: u.pathname.split(":").pop(), body });
    const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("accounts:signUp")) {
      signUps += 1;
      if (refuse.includes(signUps)) return json(400, refusal(message));
      return json(200, { localId: `uid-${++n}`, idToken: "x" });
    }
    return json(200, {});
  };
  return { calls, signUpsSent: () => calls.filter((c) => c.op === "signUp").map((c) => c.body.email), http: createHttp(t, { evidence: false, fetch }) };
}

const accountRows = (t) => readLedger(t).filter((r) => r.kind === "account").map((r) => [r.role, r.email, r.uid]);
const shape = (t, role) => new RegExp(`^${role}-${runTag(t.runId)}-[a-z0-9]{4}@example\\.com$`);

test("cast: an address the emulator says is taken is replaced by a fresh one, and the account is the one that signed up; nothing is ledgered for the refusals", async () => {
  const t = local();
  const auth = fakeAuth(t, { refuse: [1, 2] });
  const [a] = await cast(t, ["suggester"], { http: auth.http, writeUser: async () => assert.fail("no record asked for") });
  const sent = auth.signUpsSent();
  assert.equal(sent.length, 3, "two refusals, then a signUp that made it");
  assert.equal(new Set(sent).size, 3, `a fresh address each time, never the taken one again: ${sent.join(", ")}`);
  for (const e of sent) assert.match(e, shape(t, "suggester"), "the same shape as before");
  assert.deepEqual({ ...a }, { role: "suggester", email: sent[2], password: passwordFor(sent[2]), uid: "uid-1" });
  assert.ok(Object.isFrozen(a));
  assert.deepEqual(auth.calls.map((c) => c.op), ["signUp", "signUp", "signUp", "update"], "verified once, for the account that exists");
  assert.deepEqual(auth.calls[3].body, { localId: "uid-1", emailVerified: true });
  assert.deepEqual(accountRows(t), [["suggester", sent[2], "uid-1"]], "one ledger row, for the account made");
});

test("cast: with several roles each is cast in turn, a refusal for one costing the others nothing", async () => {
  const t = local();
  const auth = fakeAuth(t, { refuse: [2] });
  const accounts = await cast(t, ["owner", "viewer", "editor"], { http: auth.http });
  assert.deepEqual(accounts.map((a) => [a.role, a.uid]), [["owner", "uid-1"], ["viewer", "uid-2"], ["editor", "uid-3"]]);
  assert.deepEqual(auth.signUpsSent().map((e) => e.split("-")[0]), ["owner", "viewer", "viewer", "editor"]);
  assert.deepEqual(accountRows(t).map((r) => r[0]), ["owner", "viewer", "editor"]);
});

test("castUnverified without an address: its own address, replaced the same way when taken", async () => {
  const t = local();
  const auth = fakeAuth(t, { refuse: [1] });
  const a = await castUnverified(t, "signup", { http: auth.http });
  const sent = auth.signUpsSent();
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0], sent[1]);
  assert.deepEqual({ ...a }, { role: "signup", email: sent[1], password: passwordFor(sent[1]), uid: "uid-1", verified: false });
  assert.deepEqual(auth.calls.map((c) => c.op), ["signUp", "signUp"], "no accounts:update: it stays unverified");
  assert.deepEqual(readLedger(t).filter((r) => r.kind === "account").map((r) => [r.email, r.verified]), [[sent[1], false]]);
});

test("NEGATIVE: a taken address is cast again only retryTaken times (3 by default): the last refusal is thrown as it is, and nothing is ledgered", async () => {
  const t = local();
  const four = fakeAuth(t, { refuse: [1, 2, 3, 4] });
  const err = await cast(t, ["owner"], { http: four.http }).then(() => null, (e) => e);
  assert.equal(err?.code, "E2E_STATUS");
  assert.equal(err.response.status, 400);
  assert.equal(err.response.json.error.message, "EMAIL_EXISTS");
  assert.equal(four.signUpsSent().length, 4, "the first and three more: 3 by default");
  assert.equal(new Set(four.signUpsSent()).size, 4);

  const none = fakeAuth(t, { refuse: [1] });
  await assert.rejects(cast(t, ["owner"], { http: none.http, retryTaken: 0 }), (e) => e.code === "E2E_STATUS" && e.response.json.error.message === "EMAIL_EXISTS");
  assert.equal(none.signUpsSent().length, 1, "retryTaken: 0 sends one signUp, as before");

  const five = fakeAuth(t, { refuse: [1, 2, 3, 4, 5] });
  const [a] = await cast(t, ["owner"], { http: five.http, retryTaken: 5 });
  assert.equal(five.signUpsSent().length, 6);
  assert.equal(a.email, five.signUpsSent()[5]);

  const unverified = fakeAuth(t, { refuse: [1, 2] });
  await assert.rejects(castUnverified(t, "signup", { http: unverified.http, retryTaken: 1 }), (e) => e.code === "E2E_STATUS");
  assert.equal(unverified.signUpsSent().length, 2);
  assert.deepEqual(accountRows(t).map((r) => r[0]), ["owner"], "only the account that was made");
});

test("NEGATIVE: any other refusal is never retried, and a chosen address is never replaced: each is thrown after one signUp", async () => {
  const t = local();
  for (const message of ["WEAK_PASSWORD : Password should be at least 6 characters", "INVALID_EMAIL", "OPERATION_NOT_ALLOWED"]) {
    const auth = fakeAuth(t, { refuse: [1], message });
    await assert.rejects(cast(t, ["owner"], { http: auth.http }), (e) => e.code === "E2E_STATUS" && e.response.json.error.message === message);
    assert.equal(auth.signUpsSent().length, 1, message);
  }
  const chosen = fakeAuth(t, { refuse: [1] });
  const email = `invitee-${runTag(t.runId)}-ab12@example.com`;
  await assert.rejects(castUnverified(t, "invitee", { email, http: chosen.http }), (e) => e.code === "E2E_STATUS" && e.response.json.error.message === "EMAIL_EXISTS");
  assert.deepEqual(chosen.signUpsSent(), [email], "the address the caller chose, once");
  assert.deepEqual(readLedger(t), []);
});

test("a malformed retryTaken throws before any request", async () => {
  const t = local();
  const auth = fakeAuth(t);
  for (const v of [-1, 1.5, "3", null, 21, Number.NaN]) {
    await assert.rejects(cast(t, ["owner"], { http: auth.http, retryTaken: v }), /cast: retryTaken is how many times an address already signed up \(EMAIL_EXISTS\) is replaced by a fresh one, a whole number 0 to 20/, String(v));
    await assert.rejects(castUnverified(t, "signup", { http: auth.http, retryTaken: v }), /castUnverified: retryTaken is/, String(v));
  }
  assert.deepEqual(auth.calls, []);
  assert.deepEqual(readLedger(t), []);
});
