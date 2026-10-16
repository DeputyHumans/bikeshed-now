// SPDX-License-Identifier: Apache-2.0
// Canary for the protocol clients: accounts, sessions, tokens, MCP, publish, share, CLI and OAuth against the target (SPEC §12).

/**
 * If this fails, the clients every functional spec stands on are broken: the
 * run is a HARNESS problem until shown otherwise. Each step asserts the
 * product's own contract, so a green run also proves the stack answers the
 * way the specs will assume.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadTarget } from "../../lib/target.mjs";
import { cast } from "../../lib/accounts.mjs";
import { openSession, mintToken, listTokens, revokeToken, idToken, closeSession } from "../../lib/session.mjs";
import { createHttp } from "../../lib/http.mjs";
import { mcpClient } from "../../lib/mcp.mjs";
import { publish, publishMcp, publishOperator, readFixture } from "../../lib/seed.mjs";
import { share } from "../../lib/grant.mjs";
import { runCli } from "../../lib/cli.mjs";
import { readDoc, readObject } from "../../lib/admin.mjs";
import { discover, register, pkce, authorizeParams, approveViaApi, exchangeCode, refresh, startReceiver } from "../../lib/oauth.mjs";

const target = loadTarget();
const sha = (b) => createHash("sha256").update(b).digest("hex");
const ctx = {};

test("clients: cast owner, viewer and stranger; each opens a session; /session writes users/{uid}", async () => {
  const [owner, viewer, stranger] = await cast(target, ["owner", "viewer", "stranger"]);
  for (const a of [owner, viewer, stranger]) {
    assert.match(a.email, /^[a-z]+-[a-z0-9]{6}-[a-z0-9]{4}@example\.com$/);
    assert.equal(await readDoc(target, `users/${a.uid}`), null, "no account record before the first session");
  }
  ctx.owner = await openSession(target, owner);
  ctx.viewer = await openSession(target, viewer);
  ctx.stranger = await openSession(target, stranger);
  for (const s of [ctx.owner, ctx.viewer, ctx.stranger]) {
    assert.equal(s.status, "ok");
    assert.ok(s.http.jar.has("__session"));
    const user = await readDoc(target, `users/${s.uid}`);
    assert.deepEqual({ uid: user.uid, email: user.email }, { uid: s.uid, email: s.account.email });
  }
});

test("clients: the owner mints a cli token, sees it listed, and it authenticates /mcp", async () => {
  ctx.token = await mintToken(ctx.owner, { name: "e2e canary", channel: "cli" });
  assert.match(ctx.token.token, /^bsk_[0-9a-f]{32}\.[A-Za-z0-9_-]{20,64}$/);
  const listed = await listTokens(ctx.owner);
  assert.equal(listed.status, 200);
  assert.ok(listed.json.tokens.some((t) => t.tokenId === ctx.token.tokenId && t.channel === "cli"));
});

test("clients: MCP initialize reports the tree's version and tools/list has exactly 32 tools", async () => {
  const mcp = mcpClient(target, { token: ctx.token.token, actor: "owner-mcp" });
  const init = await mcp.initialize();
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.equal(mcp.serverVersion, target.expectVersion);
  const tools = await mcp.listTools();
  assert.equal(tools.length, 32, tools.map((t) => t.name).join(", "));
  for (const t of tools) assert.doesNotMatch(t.name, /^(delete_document|.*_team|.*_trust)$/);
  ctx.mcp = mcp;
});

test("clients: publish through /publish and through publish_document; the stored bytes are the upload's", async () => {
  const html = readFixture("crdt-paragraphs.html", { raw: true });
  const up = await publish(ctx.owner.http, { fixture: "crdt-paragraphs.html", title: "E2E canary upload" });
  assert.equal(up.status, 200);
  assert.equal(up.versionId, "v1");
  assert.match(up.docId, /^e2e-[a-z0-9]{6}-crdt-paragraphs-[a-z0-9]{4}$/);
  const stored = await readObject(target, `docs/${up.docId}/v1/index.html`);
  assert.equal(sha(stored), sha(html));
  ctx.docId = up.docId;

  const viaMcp = await publishMcp(ctx.mcp, { title: "E2E canary via MCP", content: "<!doctype html><title>t</title><p id=x>hello from MCP</p>", format: "html" });
  assert.equal(viaMcp.isError, false, viaMcp.text);
  assert.equal(viaMcp.json.idTaken, false);
  const doc = await readDoc(target, `docs/${viaMcp.docId}`);
  assert.equal(doc.ownerEmail, ctx.owner.account.email);
  ctx.mcpDocId = viaMcp.docId;
});

test("clients: sharing with the viewer gives them /content; a stranger and anonymous get the absent-id 404", async () => {
  const path = `/content/${ctx.docId}/v1/index.html`;
  const before = await ctx.viewer.http.get(path);
  assert.equal(before.status, 404, "not shared yet");

  const shared = await share(target, { owner: ctx.owner, doc: ctx.docId, account: ctx.viewer.account, role: "viewer" });
  assert.equal(shared.status, 200);
  assert.ok(shared.members.includes(ctx.viewer.account.email));
  assert.deepEqual({ presence: shared.mirror.presence, edit: shared.mirror.edit }, { presence: true, edit: false }, "RTDB mirror");

  const r = await ctx.viewer.http.get(path);
  assert.equal(r.status, 200);
  assert.equal(sha(r.buffer), sha(readFixture("crdt-paragraphs.html", { raw: true })));
  const stranger = await ctx.stranger.http.get(path);
  const anon = await createHttp(target, { actor: "anon" }).get(path);
  const absent = await createHttp(target, { actor: "anon" }).get(`/content/e2e-absent-${target.runId}/v1/index.html`);
  for (const x of [stranger, anon]) {
    assert.equal(x.status, 404);
    assert.equal(sha(x.buffer), sha(absent.buffer), "byte-equal to an absent id's 404");
  }
});

test("clients: the CLI runs against the stack origin: list --json shows both documents", async () => {
  const r = await runCli(target, ["list", "--json", "--all"], { token: ctx.token.token });
  assert.equal(r.code, 0, r.stderr);
  const ids = (r.json?.documents ?? r.json ?? []).map((d) => d.id ?? d.docId);
  assert.ok(ids.includes(ctx.docId) && ids.includes(ctx.mcpDocId), `listed: ${JSON.stringify(ids)}`);
});

test("clients: the operator script publishes a sample into this stack", async (t) => {
  const r = await publishOperator(target, { sample: "bikeshed-tour", owner: ctx.owner.account });
  assert.equal(r.code, 0, r.stderr || r.stdout);
  // Not asserted here: a missing mirror is suspect S16, recorded in findings.jsonl.
  t.diagnostic(`presence/edit mirror after scripts/publish.mjs: ${JSON.stringify(r.mirror)}`);
  const doc = await readDoc(target, `docs/${r.docId}`);
  assert.equal(doc.ownerEmail, ctx.owner.account.email);
  const c = await ctx.owner.http.get(`/content/${r.docId}/${doc.currentVersion}/index.html`);
  assert.equal(c.status, 200);
});

test("clients: OAuth discovery, DCR and a PKCE exchange give a bsa_/bsr_ pair that lists 32 tools", async () => {
  const anon = createHttp(target, { actor: "oauth-app" });
  const d = await discover(anon);
  assert.equal(d.responses.prm.status, 200);
  assert.equal(d.prm.authorization_servers[0], d.as.issuer, "issuer byte-for-byte");
  assert.equal(d.responses.oidc.status, 404);
  const receiver = await startReceiver({ target });
  try {
    const reg = await register(anon, { redirectUris: [receiver.redirectUri] });
    assert.equal(reg.status, 201);
    assert.match(reg.clientId, /^bsdcr_/);
    const p = pkce();
    const params = authorizeParams({ clientId: reg.clientId, redirectUri: receiver.redirectUri, challenge: p.challenge });
    const approved = await approveViaApi(anon, await idToken(target, ctx.owner.account), params);
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal(approved.iss, d.as.issuer);
    assert.equal(approved.state, params.state);
    const pair = await exchangeCode(anon, { code: approved.code, verifier: p.verifier, clientId: reg.clientId, redirectUri: receiver.redirectUri });
    assert.equal(pair.status, 200, JSON.stringify(pair.json));
    assert.match(pair.json.access_token, /^bsa_[0-9a-f]{32}\./);
    assert.match(pair.json.refresh_token, /^bsr_[0-9a-f]{32}\./);
    const mcp = mcpClient(target, { token: pair.json.access_token, actor: "oauth-mcp" });
    await mcp.initialize();
    assert.equal((await mcp.listTools()).length, 32);
    const rotated = await refresh(anon, { refreshToken: pair.json.refresh_token, clientId: reg.clientId });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.json));
    assert.notEqual(rotated.json.refresh_token, pair.json.refresh_token, "refresh rotates");
  } finally {
    await receiver.close();
  }
});

test("clients: a revoked token gets the 401 challenge; DELETE /session clears the cookie", async () => {
  const revoked = await revokeToken(ctx.owner, ctx.token.tokenId);
  assert.equal(revoked.status, 200);
  const probe = await mcpClient(target, { token: ctx.token.token, actor: "revoked" }).raw({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(probe.status, 401);
  assert.match(probe.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  const out = await closeSession(ctx.viewer);
  assert.equal(out.status, 204);
  assert.equal(ctx.viewer.http.jar.has("__session"), false);
  assert.equal((await ctx.viewer.http.get(`/content/${ctx.docId}/v1/index.html`)).status, 404, "signed out: private content is 404");
});
