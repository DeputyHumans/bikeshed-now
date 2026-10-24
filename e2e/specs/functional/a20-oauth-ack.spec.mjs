// SPDX-License-Identifier: Apache-2.0
// Native OAuth code retries preserve their own results and later grants while independent code replay still revokes the credential (SPEC §23).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { publish } from "../../lib/seed.mjs";
import { createHttp } from "../../lib/http.mjs";
import { openSession } from "../../lib/session.mjs";
import { approveViaApi, exchangeCode, pkce, register, refresh } from "../../lib/oauth.mjs";
import { closeAdmin, readDoc } from "../../lib/admin.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { logFile, logMark } from "../../lib/logs.mjs";
import { waitForNativeAckProof } from "../../lib/native-ack.mjs";
const target = currentTarget();
after(() => target ? closeAdmin(target) : undefined);
scenario("A20.oauth-ack the CLI first code exchange survives native ACK loss with one usable token while an independent replay still revokes it", {
  tiers: ["local"], needs: ["admin-emulator", "logs", "gates", "patch:amplify-native-ack-loss"], timeoutMs: 240_000, inconclusiveOnHttpStall: true, inconclusiveOnRequestStall: true,
}, async ctx => {
  const [account] = await cast(target, ["owner"]), owner = await openSession(target, account, { timeoutMs: 90_000, cutoffError: true });
  const fixture = await publish(owner.http, { name: "oauth-ack", title: "OAuth acknowledgement", filename: "index.html", body: "<!doctype html><p>Private token proof</p>", timeoutMs: 90_000 });
  precondition(fixture.status === 200, "OAuth ACK fixture has private content");
  const proof = pkce(), redirectUri = "http://127.0.0.1:32100/callback", resource = `${target.origin}/mcp`;
  const approved = await approveViaApi(owner.http, owner.idToken, { response_type: "code", client_id: "bikeshed-cli", redirect_uri: redirectUri, resource, code_challenge: proof.challenge, code_challenge_method: "S256", state: "native-ack" });
  precondition(approved.status === 200 && approved.code, "OAuth ACK fixture obtained a real consent code");
  const codeId = createHash("sha256").update(approved.code).digest("hex"), operation = "oauth-code", key = `${operation}:${codeId}`, gate = "ack-after-commit", g = gates(target);
  const file = logFile(target.runId), since = logMark(file);
  const exchange = () => exchangeCode(owner.http, { code: approved.code, verifier: proof.verifier, clientId: "bikeshed-cli", redirectUri, resource });
  let pending, finished = false, tokenId;
  let ackHeld;
  try {
    await g.hold(gate, { key });
    pending = exchange().then(result => { finished = true; return result; });
    const held = ackHeld = await requireHeld(ctx, g, gate, 1, { key, timeoutMs: 90_000 });
    const committed = await readDoc(target, `oauthCodes/${codeId}`); tokenId = committed?.tokenId;
    precondition(!finished && committed?.usedAt && tokenId && (await readDoc(target, `tokens/${tokenId}`))?.revokedAt === null, "OAuth ACK code and unrevoked token committed while the first exchange waits");
    ctx.ev.json("oauth-ack-held", { codeId, tokenId, held });
    await g.release(gate, { key });
  } finally {
    await g.release(gate, { key }).catch(() => undefined);
    if (pending) await pending.catch(() => undefined);
  }
  const response = await pending;
  const [ack] = await waitForNativeAckProof({ file, since, held: ackHeld, operation, id: codeId });
  assert.equal(response.status, 200, "ACK CLI OAuth: the first exchange acknowledges its committed token");
  assert.match(response.json?.access_token ?? "", new RegExp(`^bsk_${tokenId}\\.`), "ACK CLI OAuth: response returns the one committed credential");
  assert.equal((await readDoc(target, `tokens/${tokenId}`)).revokedAt, null, "ACK CLI OAuth: native callback does not revoke its own token");
  const authenticated = await createHttp(target, { actor: "cli-ack-token-only" }).get(`/content/${fixture.docId}/v1/index.html`, { headers: { authorization: `Bearer ${response.json.access_token}` } });
  assert.equal(authenticated.status, 200, "ACK CLI OAuth: returned token authenticates a real endpoint request");
  const replay = await exchange();
  assert.equal(replay.status, 400, "ACK CLI OAuth: an independent replay remains invalid");
  assert.equal(replay.json?.error, "invalid_grant");
  assert.ok((await readDoc(target, `tokens/${tokenId}`)).revokedAt, "ACK CLI OAuth: an independent replay revokes the committed token");
  ctx.ev.json("oauth-ack-result", { codeId, tokenId, caller: ack.caller, ack, firstStatus: response.status, authenticatedStatus: authenticated.status, replayStatus: replay.status });
});

scenario("A20.oauth-ack-dcr a native code retry cannot revoke a later refreshed grant while independent code replay still can", {
  tiers: ["local"], needs: ["admin-emulator", "logs", "gates", "patch:amplify-native-ack-loss"], timeoutMs: 240_000, inconclusiveOnHttpStall: true, inconclusiveOnRequestStall: true,
}, async ctx => {
  const [account] = await cast(target, ["owner"]), owner = await openSession(target, account, { timeoutMs: 90_000, cutoffError: true });
  const proof = pkce(), redirectUri = "http://127.0.0.1:32100/callback", resource = `${target.origin}/mcp`;
  const registered = await register(owner.http, { redirectUris: [redirectUri], clientName: "DCR acknowledgement" });
  precondition(registered.status === 201 && registered.clientId, "DCR ACK fixture registered a real client");
  const clientId = registered.clientId;
  const approved = await approveViaApi(owner.http, owner.idToken, { response_type: "code", client_id: clientId, redirect_uri: redirectUri, resource, code_challenge: proof.challenge, code_challenge_method: "S256", state: "native-dcr-ack" });
  precondition(approved.status === 200 && approved.code, "DCR ACK fixture obtained a real consent code");
  const codeId = createHash("sha256").update(approved.code).digest("hex"), operation = "oauth-code", key = `${operation}:${codeId}`, gate = "ack-after-commit", g = gates(target);
  const file = logFile(target.runId), since = logMark(file);
  const exchange = () => exchangeCode(owner.http, { code: approved.code, verifier: proof.verifier, clientId, redirectUri, resource });
  let pending, finished = false;
  let ackHeld;
  try {
    await g.hold(gate, { key });
    pending = exchange().catch(error => ({ status: null, error: String(error?.message ?? error) })).then(result => { finished = true; return result; });
    const held = ackHeld = await requireHeld(ctx, g, gate, 1, { key, timeoutMs: 90_000 });
    const committed = await readDoc(target, `oauthCodes/${codeId}`), tokenId = committed?.tokenId;
    precondition(!finished && committed?.usedAt && tokenId, "DCR ACK original code is committed and unanswered");
    // Recovery is read-only and refresh uses another transaction entry point;
    // both finish while the original code-exchange commit stays held.
    const recovered = await exchange();
    precondition(recovered.status === 200 && recovered.json?.refresh_token, "DCR ACK independent grace recovery returns generation zero");
    const later = await refresh(owner.http, { refreshToken: recovered.json.refresh_token, clientId, resource });
    const advanced = await readDoc(target, `tokens/${tokenId}`);
    precondition(later.status === 200 && later.json?.refresh_token && advanced.generation === 1 && advanced.revokedAt === null, "DCR ACK later real refresh commits an unrevoked generation one");
    ctx.ev.json("dcr-ack-held", { codeId, tokenId, held, generation: advanced.generation });
    await g.release(gate, { key });
    const original = await pending;
    const [ack] = await waitForNativeAckProof({ file, since, held: ackHeld, operation, id: codeId });
    const retained = await readDoc(target, `tokens/${tokenId}`);
    assert.deepEqual({ generation: retained.generation, revokedAt: retained.revokedAt }, { generation: 1, revokedAt: null }, "ACK DCR OAuth: own retry preserves the newer unrevoked generation");
    assert.equal(original.status, 400, "ACK DCR OAuth: obsolete original credentials are not returned as usable");
    assert.equal(original.json?.error, "invalid_grant");
    const usable = await refresh(owner.http, { refreshToken: later.json.refresh_token, clientId, resource });
    assert.equal(usable.status, 200, "ACK DCR OAuth: the newer refresh credential remains usable");
    const replay = await exchange();
    assert.equal(replay.status, 400, "ACK DCR OAuth: an independent advanced-generation replay remains invalid");
    assert.ok((await readDoc(target, `tokens/${tokenId}`)).revokedAt, "ACK DCR OAuth: an independent advanced-generation replay still revokes the grant");
    ctx.ev.json("dcr-ack-result", { codeId, tokenId, caller: ack.caller, ack, originalStatus: original.status, usableStatus: usable.status, replayStatus: replay.status });
  } finally {
    await g.release(gate, { key }).catch(() => undefined);
    if (pending) await pending.catch(() => undefined);
  }
});
