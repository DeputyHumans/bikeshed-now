// SPDX-License-Identifier: Apache-2.0
// A native transaction retry cannot turn the built-in CLI's first code exchange into a replay that revokes its new token (SPEC §23).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { loseFirstTransactionAcknowledgement } = require("./transaction-ack.js");
const { handleToken } = require("../lib/oauth/token.js");
const { CLI_CLIENT_ID } = require("../lib/oauth/clients.js");
const { refreshGrant, REPLAY_GRACE_MS } = require("../lib/oauth/grants.js");

function world(registration = "builtin") {
  const clientId = registration === "builtin" ? CLI_CLIENT_ID : "ack-dcr-client";
  const code = "native-ack-cli-code", verifier = "a".repeat(43), id = createHash("sha256").update(code).digest("hex");
  const { db, store } = fakeFirestore({ [`oauthCodes/${id}`]: {
    uid: "owner", emailLower: "owner@example.com", registration, clientId,
    clientName: "ACK client", clientHost: null, clientVerified: false, redirectHost: "app.example",
    redirectUri: "http://127.0.0.1:32100/callback", codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    resource: "https://bikeshed.example/mcp", expiresAt: Timestamp.fromMillis(Date.now() + 60_000), usedAt: null, tokenId: null, nonce: null,
  } });
  const exchange = () => withFakeAdmin({ db, users: { owner: { uid: "owner", email: "owner@example.com", emailVerified: true, disabled: false, tokensValidAfterTime: new Date(0).toUTCString() } } }, () => invoke(handleToken, { headers: { "content-type": "application/x-www-form-urlencoded" }, rawBody: Buffer.from(new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier }).toString()) }));
  return { db, store, id, exchange };
}
test("the CLI's first exchange survives native commit ACK loss without revoking its new token", async () => {
  const w = world(), count = loseFirstTransactionAcknowledgement(w.db);
  const result = await w.exchange();
  assert.equal(result.status, 200, "the original CLI exchange acknowledges its committed personal token");
  assert.match(result.body.access_token, /^bsk_/);
  const tokenId = w.store.get(`oauthCodes/${w.id}`).tokenId;
  assert.equal(w.store.get(`tokens/${tokenId}`).revokedAt, null, "the native retry does not revoke its own token");
  assert.equal([...w.store.keys()].filter(key => /^tokens\/[^/]+$/.test(key)).length, 1, "the retry mints only one personal token");
  assert.deepEqual(count(), { failures: 1, callbackCalls: 2 });
});

test("a native DCR code retry does not revoke a later refreshed generation", async () => {
  const w = world("dcr"); let later;
  loseFirstTransactionAcknowledgement(w.db, { afterCommit: async () => {
    const recovered = await w.exchange(); assert.equal(recovered.status, 200);
    later = await refreshGrant(w.db, recovered.body.refresh_token, {});
    assert.equal(later.ok, true);
  } });
  const response = await w.exchange(), grant = w.store.get(`tokens/${w.store.get(`oauthCodes/${w.id}`).tokenId}`);
  assert.equal(response.status, 400, "superseded original credentials are not returned as usable");
  assert.equal(response.body.error, "invalid_grant");
  assert.equal(grant.generation, 1, "the later refresh remains current");
  assert.equal(grant.revokedAt, null, "an own native retry never revokes the later grant generation");
  assert.ok(later.pair.refresh_token);
});
test("a native DCR code retry can acknowledge its own generation after the independent replay grace window", async () => {
  const w = world("dcr"), realNow = Date.now, firstNow = realNow();
  try {
    loseFirstTransactionAcknowledgement(w.db, { afterCommit: async () => { Date.now = () => firstNow + REPLAY_GRACE_MS + 1; } });
    const response = await w.exchange();
    assert.equal(response.status, 200, "an own native retry is not an independent expired-grace replay");
    const grant = w.store.get(`tokens/${w.store.get(`oauthCodes/${w.id}`).tokenId}`);
    assert.equal(grant.revokedAt, null);
    assert.equal(grant.generation, 0);
  } finally { Date.now = realNow; }
});
test("an independently replayed DCR code still revokes a refreshed generation", async () => {
  const w = world("dcr"), first = await w.exchange();
  assert.equal(first.status, 200);
  await withFakeAdmin({ db: w.db, users: { owner: { uid: "owner", email: "owner@example.com", emailVerified: true, disabled: false, tokensValidAfterTime: new Date(0).toUTCString() } } }, async () => {
    assert.equal((await refreshGrant(w.db, first.body.refresh_token, {})).ok, true);
  });
  const replay = await w.exchange();
  assert.equal(replay.status, 400);
  assert.ok(w.store.get(`tokens/${w.store.get(`oauthCodes/${w.id}`).tokenId}`).revokedAt, "a separate replay retains its theft response");
});
test("a DCR grant revoked before its native retry cannot recover a usable pair", async () => {
  const w = world("dcr");
  loseFirstTransactionAcknowledgement(w.db, { afterCommit: async () => { await w.db.doc(`tokens/${w.store.get(`oauthCodes/${w.id}`).tokenId}`).update({ revokedAt: Timestamp.now() }); } });
  const response = await w.exchange();
  assert.equal(response.status, 400);
  assert.equal(response.body.access_token, undefined);
  assert.ok(w.store.get(`tokens/${w.store.get(`oauthCodes/${w.id}`).tokenId}`).revokedAt);
});
test("a separate CLI code replay still revokes the committed token instead of recovering plaintext", async () => {
  const w = world(); loseFirstTransactionAcknowledgement(w.db);
  const first = await w.exchange();
  assert.equal(first.status, 200);
  const tokenId = w.store.get(`oauthCodes/${w.id}`).tokenId;
  assert.equal(JSON.stringify([...w.store.values()]).includes(first.body.access_token), false, "the retry receipt never persists plaintext");
  const replay = await w.exchange();
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, "invalid_grant");
  assert.ok(w.store.get(`tokens/${tokenId}`).revokedAt, "independent replay keeps its theft protection");
});
test("a CLI token revoked between the commit and native retry is never resurrected", async () => {
  const w = world();
  loseFirstTransactionAcknowledgement(w.db, { afterCommit: async () => {
    const tokenId = w.store.get(`oauthCodes/${w.id}`).tokenId;
    await w.db.doc(`tokens/${tokenId}`).update({ revokedAt: Timestamp.now() });
  } });
  const result = await w.exchange();
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "invalid_grant");
  assert.ok(w.store.get(`tokens/${w.store.get(`oauthCodes/${w.id}`).tokenId}`).revokedAt);
});
test("CLI retry receipt must still match its committed token secret and owner", async () => {
  for (const change of [{ hash: "different-hash" }, { uid: "someone-else" }]) {
    const w = world();
    loseFirstTransactionAcknowledgement(w.db, { afterCommit: async () => {
      await w.db.doc(`tokens/${w.store.get(`oauthCodes/${w.id}`).tokenId}`).update(change);
    } });
    const result = await w.exchange();
    assert.equal(result.status, 400, "a token with different identity or secret cannot satisfy the receipt");
    assert.equal(result.body.access_token, undefined);
  }
});
