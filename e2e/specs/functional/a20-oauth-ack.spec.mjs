// SPDX-License-Identifier: Apache-2.0
// The CLI's first OAuth exchange survives a native commit retry while an independent code replay still revokes the credential (SPEC §23).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { publish } from "../../lib/seed.mjs";
import { createHttp } from "../../lib/http.mjs";
import { openSession } from "../../lib/session.mjs";
import { approveViaApi, exchangeCode, pkce } from "../../lib/oauth.mjs";
import { closeAdmin, readDoc } from "../../lib/admin.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { logFile, logMark, waitForLog } from "../../lib/logs.mjs";
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
  try {
    await g.hold(gate, { key });
    pending = exchange().then(result => { finished = true; return result; });
    const held = await requireHeld(ctx, g, gate, 1, { key, timeoutMs: 90_000 });
    const committed = await readDoc(target, `oauthCodes/${codeId}`); tokenId = committed?.tokenId;
    precondition(!finished && committed?.usedAt && tokenId && (await readDoc(target, `tokens/${tokenId}`))?.revokedAt === null, "OAuth ACK code and unrevoked token committed while the first exchange waits");
    ctx.ev.json("oauth-ack-held", { codeId, tokenId, held });
    await g.release(gate, { key });
  } finally {
    await g.release(gate, { key }).catch(() => undefined);
    if (pending) await pending.catch(() => undefined);
  }
  const response = await pending;
  const { match: loss } = await waitForLog(new RegExp(`E2E_ACK_LOSS ${operation} ${codeId} ([a-f0-9-]+)`), { file, since });
  await waitForLog(`E2E_ACK_RETRY ${operation} ${codeId} ${loss[1]} callback2`, { file, since });
  assert.equal(response.status, 200, "ACK CLI OAuth: the first exchange acknowledges its committed token");
  assert.match(response.json?.access_token ?? "", new RegExp(`^bsk_${tokenId}\\.`), "ACK CLI OAuth: response returns the one committed credential");
  assert.equal((await readDoc(target, `tokens/${tokenId}`)).revokedAt, null, "ACK CLI OAuth: native callback does not revoke its own token");
  const authenticated = await createHttp(target, { actor: "cli-ack-token-only" }).get(`/content/${fixture.docId}/v1/index.html`, { headers: { authorization: `Bearer ${response.json.access_token}` } });
  assert.equal(authenticated.status, 200, "ACK CLI OAuth: returned token authenticates a real endpoint request");
  const replay = await exchange();
  assert.equal(replay.status, 400, "ACK CLI OAuth: an independent replay remains invalid");
  assert.equal(replay.json?.error, "invalid_grant");
  assert.ok((await readDoc(target, `tokens/${tokenId}`)).revokedAt, "ACK CLI OAuth: an independent replay revokes the committed token");
  ctx.ev.json("oauth-ack-result", { codeId, tokenId, caller: loss[1], firstStatus: response.status, authenticatedStatus: authenticated.status, replayStatus: replay.status });
});
