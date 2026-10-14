// SPDX-License-Identifier: Apache-2.0
// Self-test: the MCP client parses JSON and SSE replies, carries the session id, batches, and exposes raw 401s (SPEC §19).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCEPT, mcpClient, parseMcpBody, toolOutcome } from "../lib/mcp.mjs";
import { tempDir } from "./helpers/tmp.mjs";

test("parseMcpBody: a JSON message, a JSON batch, and SSE frames (multi-line data, CRLF, batches)", () => {
  assert.deepEqual(parseMcpBody("application/json", '{"jsonrpc":"2.0","id":1,"result":{}}'), [{ jsonrpc: "2.0", id: 1, result: {} }]);
  assert.equal(parseMcpBody("application/json; charset=utf-8", '[{"id":1},{"id":2}]').length, 2);
  const sse = 'event: message\r\nid: 1\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":7,"result":{"ok":true}}\r\n\r\n: comment\n\nevent: message\ndata: [{"id":8},{"id":9}]\n\n';
  assert.deepEqual(parseMcpBody("text/event-stream", sse).map((m) => m.id), [7, 8, 9]);
  assert.deepEqual(parseMcpBody("application/json", ""), []);
  assert.throws(() => parseMcpBody("application/json", "<html>"));
});

test("toolOutcome: structuredContent wins, text is joined, errors carry no json", () => {
  assert.deepEqual(toolOutcome({ content: [{ type: "text", text: '{"a":1}' }], structuredContent: { a: 2 }, isError: false }).json, { a: 2 });
  assert.deepEqual(toolOutcome({ content: [{ type: "text", text: '{"a":1}' }], isError: false }).json, { a: 1 });
  const err = toolOutcome({ content: [{ type: "text", text: "no document" }], isError: true });
  assert.deepEqual([err.isError, err.text, err.json], [true, "no document", undefined]);
});

// A fake streamable-HTTP server: SSE replies, a session id, a 401 without a token.
const seen = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ headers: req.headers, body });
    if (req.headers.authorization !== "Bearer bsk_" + "f".repeat(32) + ".secretsecretsecretsecret") {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="bikeshed", error="invalid_token"' });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "sign in" } }));
      return;
    }
    const msg = JSON.parse(body);
    const answer = (m) => {
      if (m.method === "initialize") return { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "9.9.9" }, capabilities: {} } };
      if (m.method === "tools/list") return { jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "a" }, { name: "b" }] } };
      if (m.method === "tools/call" && m.params.name === "boom") return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "it broke" }], isError: true } };
      if (m.method === "tools/call") return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ echo: m.params.arguments }) }], isError: false } };
      if (!("id" in m)) return null;
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method "${m.method}"` } };
    };
    const out = (Array.isArray(msg) ? msg : [msg]).map(answer).filter(Boolean);
    if (out.length === 0) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-123" });
    res.end(`event: message\ndata: ${JSON.stringify(Array.isArray(msg) ? out : out[0])}\n\n`);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const port = server.address().port;
const target = Object.freeze({ kind: "local", runId: "2610101200-mcpt", origin: `http://127.0.0.1:${port}`, runDir: tempDir("e2e-mcp-"), stack: { ports: { hosting: port } } });
const allow = { check: async () => ({ allow: true }) };
const TOKEN = "bsk_" + "f".repeat(32) + ".secretsecretsecretsecret";

test("mcpClient: initialize records the version, then carries Mcp-Session-Id and the protocol version", async () => {
  seen.length = 0;
  const mcp = mcpClient(target, { token: TOKEN, guard: allow, evidence: false });
  const init = await mcp.initialize();
  assert.equal(init.serverInfo.version, "9.9.9");
  assert.equal(mcp.serverVersion, "9.9.9");
  assert.equal(seen[0].headers.accept, ACCEPT);
  assert.equal(seen[0].headers["mcp-session-id"], undefined, "no session id before the server sets one");
  assert.equal(JSON.parse(seen[1].body).method, "notifications/initialized", "initialized is sent");
  assert.equal(seen[1].headers["mcp-session-id"], "sess-123");
  const tools = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["a", "b"]);
  assert.equal(seen.at(-1).headers["mcp-session-id"], "sess-123");
  assert.equal(seen.at(-1).headers["mcp-protocol-version"], "2025-06-18");
});

test("mcpClient: call() splits tool errors from transport errors; ok() throws on a tool error", async () => {
  const mcp = mcpClient(target, { token: TOKEN, guard: allow, evidence: false });
  assert.deepEqual((await mcp.call("echo", { x: 1 })).json, { echo: { x: 1 } });
  const bad = await mcp.call("boom");
  assert.deepEqual([bad.isError, bad.text], [true, "it broke"]);
  await assert.rejects(mcp.ok("boom"), (e) => e.code === "E2E_MCP_TOOL");
  const unknown = await mcp.rpc("no/such");
  assert.equal(unknown.error.code, -32601);
});

test("mcpClient: a batch answers each request; notifications alone get 202; raw shows a 401 challenge", async () => {
  const mcp = mcpClient(target, { token: TOKEN, guard: allow, evidence: false });
  const b = await mcp.batch([{ method: "tools/list" }, { method: "tools/call", params: { name: "echo", arguments: { y: 2 } } }, { method: "notifications/initialized", notification: true }]);
  assert.equal(b.status, 200);
  assert.equal(b.messages.length, 2);
  assert.equal(await mcp.notify("notifications/initialized"), 202);
  const anon = mcpClient(target, { guard: allow, evidence: false });
  const r = await anon.raw({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /invalid_token/);
  await assert.rejects(anon.listTools(), (e) => e.code === "E2E_MCP_HTTP" && e.status === 401);
});
