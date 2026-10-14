// SPDX-License-Identifier: Apache-2.0
// Self-test: castUnverified signs up an unverified account at the address the caller chose, or its own, and ledgers it (SPEC §12, §14).

/**
 * A case that shares with an address before its account exists (A1.8) has to
 * know the address first and sign up with exactly that one afterwards. The
 * Auth REST call goes to a recording fetch, so this needs no stack.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { castUnverified, localEmail, passwordFor, runTag } from "../lib/accounts.mjs";
import { createHttp } from "../lib/http.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const local = () => Object.freeze({
  kind: "local",
  runId: "2610110100-unvrf",
  runDir: tempDir("e2e-unverified-"),
  origin: "http://127.0.0.1:39011",
  webApiKey: "demo-api-key",
  authRestBase: "http://127.0.0.1:39012/identitytoolkit.googleapis.com/v1",
  stack: { ports: { hosting: 39011, auth: 39012 } },
});

/** The Auth emulator, recorded: signUp mints uid-<n>, or answers `status` with an error. */
function fakeAuth(t, { status = 200 } = {}) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, body: JSON.parse(init.body) });
    const body = status === 200 ? { localId: `uid-${++n}`, idToken: "x" } : { error: { code: status, message: "EMAIL_EXISTS" } };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, http: createHttp(t, { evidence: false, fetch }) };
}

const accountRows = (t) => readLedger(t).filter((r) => r.kind === "account").map(({ t: _t, runId: _r, ...row }) => row);

test("castUnverified {email}: signs up exactly that address, unverified, and ledgers it", async () => {
  const t = local();
  const auth = fakeAuth(t);
  const email = `invitee-${runTag(t.runId)}-ab12@example.com`;
  const acct = await castUnverified(t, "invitee", { email, http: auth.http });
  assert.deepEqual({ ...acct }, { role: "invitee", email, password: passwordFor(email), uid: "uid-1", verified: false });
  assert.ok(Object.isFrozen(acct));
  assert.deepEqual(auth.calls.map((c) => c.path), ["/identitytoolkit.googleapis.com/v1/accounts:signUp"], "one signUp, and no accounts:update: the address stays unverified");
  assert.deepEqual(auth.calls[0].body, { email, password: passwordFor(email), returnSecureToken: true });
  assert.deepEqual(accountRows(t), [{ kind: "account", role: "invitee", email, uid: "uid-1", tier: "local", verified: false }]);

  const mixed = "Invitee-Case@Example.com";
  const again = await castUnverified(t, "invitee", { email: mixed, http: auth.http });
  assert.equal(auth.calls[1].body.email, mixed, "sent exactly as given: the Auth service decides about case");
  assert.equal(again.password, passwordFor("invitee-case@example.com"), "the password is the lowercased address's, as everywhere");
});

test("castUnverified without email: its own <role>-<run6>-<r4>@example.com, as before", async () => {
  const t = local();
  const auth = fakeAuth(t);
  const acct = await castUnverified(t, "signup", { http: auth.http });
  assert.match(acct.email, new RegExp(`^signup-${runTag(t.runId)}-[a-z0-9]{4}@example\\.com$`));
  assert.equal(auth.calls[0].body.email, acct.email);
  assert.equal(localEmail(t, "signup").replace(/-[a-z0-9]{4}@/, "@"), acct.email.replace(/-[a-z0-9]{4}@/, "@"));
  assert.deepEqual(accountRows(t).map((r) => [r.email, r.verified]), [[acct.email, false]]);
});

test("NEGATIVE: a malformed address is refused before any request; a taken one throws and ledgers nothing; production never signs up", async () => {
  const t = local();
  const auth = fakeAuth(t);
  for (const email of ["", "no-at-sign", "a b@example.com", "x@nodot", 42, null]) {
    await assert.rejects(castUnverified(t, "invitee", { email, http: auth.http }), /castUnverified: email must be an address/, JSON.stringify(email));
  }
  assert.deepEqual([auth.calls, readLedger(t)], [[], []]);

  const taken = fakeAuth(t, { status: 400 });
  await assert.rejects(castUnverified(t, "invitee", { email: "taken@example.com", http: taken.http }), (e) => e.code === "E2E_STATUS" && /EMAIL_EXISTS/.test(e.message));
  assert.deepEqual(readLedger(t), [], "nothing was created, nothing ledgered");

  await assert.rejects(castUnverified({ ...t, kind: "prod" }, "invitee", { email: "x@example.com" }), /local-only/);
});
