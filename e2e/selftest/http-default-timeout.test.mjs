// SPDX-License-Identifier: Apache-2.0
// Self-test: a client's default request timeout (createHttp, openSession, mcpClient) bounds every request that gives none of its own (SPEC §12).

/**
 * Hermetic: a local server answers GET /slow?ms=N after N ms, and stands in
 * for the Auth emulator's signInWithPassword and the stack's POST /session
 * (answered after `sessionDelayMs`), so openSession runs its real path. Each
 * timeout is measured against a request the server answers later than the
 * bound and sooner than the next one, so the bound that applied is the one
 * that decided.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DEFAULT_REQUEST_TIMEOUT_MS, createHttp } from "../lib/http.mjs";
import { openSession } from "../lib/session.mjs";
import { mcpClient } from "../lib/mcp.mjs";
import { tempDir } from "./helpers/tmp.mjs";

let server;
let target;
let sessionDelayMs = 0;
const allow = { check: async () => ({ allow: true }) };
const account = { role: "owner", email: "owner@e2e.invalid", password: "not-a-real-password" };

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    req.resume();
    req.on("end", () => {
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/slow") return setTimeout(() => json(200, { ok: true }), Number(url.searchParams.get("ms") ?? 0));
      if (url.pathname.endsWith("/accounts:signInWithPassword")) return json(200, { idToken: "fake-id-token", refreshToken: "fake-refresh", localId: "uid-1", expiresIn: "3600" });
      if (url.pathname === "/session") return setTimeout(() => json(200, { status: "ok" }, { "set-cookie": "__session=fake-session-value; Path=/; HttpOnly; Secure" }), sessionDelayMs);
      if (url.pathname === "/mcp") return setTimeout(() => json(200, { jsonrpc: "2.0", id: 1, result: {} }), Number(url.searchParams.get("ms") ?? 0));
      return json(404, { error: "no such path" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = {
    kind: "local",
    runId: "selftest-http-timeout",
    origin: `http://127.0.0.1:${port}`,
    runDir: tempDir("e2e-http-timeout-"),
    stack: { ports: { hosting: port } },
    authRestBase: `http://127.0.0.1:${port}/identitytoolkit.googleapis.com/v1`,
    webApiKey: "demo-api-key",
  };
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

const client = (o = {}) => createHttp(target, { guard: allow, evidence: false, ...o });
const late = (p) => p.then(() => "answered", (e) => `threw: ${e.message}`);

test("a client without a default keeps DEFAULT_REQUEST_TIMEOUT_MS (60 s), as before", async () => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 60_000);
  const h = client();
  assert.equal(h.timeoutMs, 60_000);
  assert.equal(await late(h.get("/slow", { query: { ms: 300 } })), "answered");
});

test("the client's timeoutMs bounds a request that gives none, and one that passes timeoutMs: undefined", async () => {
  const h = client({ timeoutMs: 250 });
  assert.equal(h.timeoutMs, 250);
  assert.equal(await late(h.get("/slow", { query: { ms: 1_200 } })), "threw: timeout after 250 ms");
  // What seed.publish() sends when its caller gave no timeoutMs.
  assert.equal(await late(h.request("POST", "/slow", { query: { ms: 1_200 }, timeoutMs: undefined })), "threw: timeout after 250 ms");
  assert.equal(await late(h.postJson("/slow?ms=1200", { x: 1 })), "threw: timeout after 250 ms", "postJson too");
});

test("a request's own timeoutMs wins over the client's, both ways", async () => {
  const patient = client({ timeoutMs: 250 });
  assert.equal(await late(patient.get("/slow", { query: { ms: 600 }, timeoutMs: 5_000 })), "answered", "longer than the client's");
  const hasty = client({ timeoutMs: 5_000 });
  assert.equal(await late(hasty.get("/slow", { query: { ms: 1_200 }, timeoutMs: 250 })), "threw: timeout after 250 ms", "shorter than the client's");
});

test("NEGATIVE: a longer client default lets an answer through that 250 ms would have cut", async () => {
  assert.equal(await late(client({ timeoutMs: 5_000 }).get("/slow", { query: { ms: 600 } })), "answered");
});

test("with() keeps the default, or takes another", async () => {
  const h = client({ timeoutMs: 250 });
  const same = h.with({ actor: "other" });
  assert.equal(same.timeoutMs, 250);
  assert.equal(await late(same.get("/slow", { query: { ms: 1_200 } })), "threw: timeout after 250 ms");
  const longer = h.with({ timeoutMs: 5_000 });
  assert.equal(longer.timeoutMs, 5_000);
  assert.equal(await late(longer.get("/slow", { query: { ms: 600 } })), "answered");
});

test("a timeoutMs that is not a positive number is refused when the client is made", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "180000", {}]) {
    assert.throws(() => client({ timeoutMs: bad }), /createHttp: timeoutMs is a positive number of ms/, String(bad));
  }
  assert.equal(client({ timeoutMs: null }).timeoutMs, 60_000, "null is the default");
});

test("openSession({timeoutMs}): the session's client keeps it for every later request, the sign-in included", async () => {
  sessionDelayMs = 0;
  const s = await openSession(target, account, { timeoutMs: 250 });
  assert.equal(s.http.timeoutMs, 250);
  assert.equal(await late(s.http.get("/slow", { query: { ms: 1_200 } })), "threw: timeout after 250 ms");
  sessionDelayMs = 1_200;
  try {
    assert.equal(await late(openSession(target, account, { timeoutMs: 250 })), "threw: timeout after 250 ms", "POST /session is bounded by it too");
    const ok = await openSession(target, account, { timeoutMs: 5_000 });
    assert.equal(ok.status, "ok", "and a longer one waits for the slow answer");
  } finally {
    sessionDelayMs = 0;
  }
  const plain = await openSession(target, account);
  assert.equal(plain.http.timeoutMs, 60_000, "without it, the default");
});

test("mcpClient({timeoutMs}) passes it to the client it makes", async () => {
  const m = mcpClient(target, { guard: allow, evidence: false, timeoutMs: 250 });
  const r = await late(m.raw({ jsonrpc: "2.0", id: 1, method: "ping" }, { path: "/mcp?ms=1200" }));
  assert.equal(r, "threw: timeout after 250 ms");
  const plain = mcpClient(target, { guard: allow, evidence: false });
  assert.equal(await late(plain.raw({ jsonrpc: "2.0", id: 1, method: "ping" }, { path: "/mcp?ms=600" })), "answered");
});
