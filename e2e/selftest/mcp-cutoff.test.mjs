// SPDX-License-Identifier: Apache-2.0
// Self-test: mcpClient passes cutoffError to the client it makes, so Hosting's cut-off on an MCP call throws E2E_STACK_CUTOFF as the other clients do (SPEC §12).

/**
 * A local server stands in for POST /mcp: it answers 504 as Hosting does
 * while moving this file's clock past the cut-off (a self-test cannot wait a
 * minute for it), or a quicker 504, or a JSON-RPC result. Checked with and
 * without the option, on raw() (which never throws on a status) and on
 * initialize(). No browser, no stack.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHttp } from "../lib/http.mjs";
import { mcpClient } from "../lib/mcp.mjs";
import { stackDidNotAnswer } from "../lib/test.mjs";

const CUT = "Hosting's cut-off for a function that has not answered";
const allow = { check: () => ({ allow: true }) };
const realNow = Date.now;
let skew = 0;
let mode = "cut";
let server;
let target;

/** What `p` rejects with (it must reject). */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

before(async () => {
  Date.now = () => realNow() + skew;
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (mode === "ok") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "stand-in", version: "0" }, capabilities: {} } }));
      }
      if (mode === "cut") skew += 60_005;
      res.statusCode = 504;
      res.setHeader("content-type", "text/plain");
      res.end("Timed out waiting for function to respond.");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-mcp-cutoff", origin: `http://127.0.0.1:${port}`, capabilities: ["local"], stack: { ports: { hosting: port } } };
});

after(async () => {
  Date.now = realNow;
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

const client = (o = {}) => mcpClient(target, { token: "bsk_" + "0".repeat(32) + ".abcdefgh", evidence: false, guard: allow, ...o });

test("mcpClient({cutoffError: true}): Hosting's cut-off on POST /mcp throws E2E_STACK_CUTOFF, from raw() and initialize() alike", async () => {
  mode = "cut";
  const c = client({ cutoffError: true, timeoutMs: 150_000 });
  assert.equal(c.http.cutoffError, true, "passed to the client it makes");
  assert.equal(c.http.timeoutMs, 150_000, "beside timeoutMs, as before");
  const raw = await rejection(c.raw({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  assert.equal(raw.code, "E2E_STACK_CUTOFF");
  assert.match(raw.message, new RegExp(`^POST /mcp answered 504 after 60\\d{3} ms, ${CUT}$`));
  assert.equal(raw.stackCut, raw.message);
  assert.equal(raw.response?.status, 504, "the answer rides along");
  assert.equal(stackDidNotAnswer(raw), raw.message, "the stack not answering, as every client's cut-off is");
  const init = await rejection(c.initialize());
  assert.equal(init.code, "E2E_STACK_CUTOFF", "initialize goes the same way, not E2E_MCP_HTTP");
});

test("NEGATIVE: without the option, as before: raw() returns Hosting's 504 as an answer and initialize() throws E2E_MCP_HTTP; with it, a quicker 504 is an answer", async () => {
  mode = "cut";
  const plain = client();
  assert.equal(plain.http.cutoffError, false, "off by default");
  const r = await plain.raw({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(r.status, 504, "returned, not thrown: the old behaviour");
  const init = await rejection(plain.initialize());
  assert.equal(init.code, "E2E_MCP_HTTP");
  assert.match(stackDidNotAnswer(init) ?? "", new RegExp(`^MCP initialize answered 504 after 60\\d{3} ms, ${CUT}$`), "still judged through res.response, as it always was");

  mode = "quick";
  const quick = await client({ cutoffError: true }).raw({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(quick.status, 504, "a quicker 504 is the product's answer, returned");
  mode = "ok";
  const c = client({ cutoffError: true });
  assert.equal((await c.initialize({ sendInitialized: false })).serverInfo.name, "stand-in", "an answer goes through untouched");
});

test("mcpClient: a client given as `http` keeps its own cutoffError; a cutoffError that is not a boolean throws as createHttp's does", () => {
  const own = createHttp(target, { evidence: false, guard: allow });
  assert.equal(mcpClient(target, { http: own, cutoffError: true }).http.cutoffError, false, "ignored with `http`, which keeps its own");
  for (const bad of ["yes", 1]) {
    assert.throws(() => client({ cutoffError: bad }), (e) => e instanceof TypeError && /^createHttp: cutoffError is true or false/.test(e.message), String(bad));
  }
  assert.equal(client({ cutoffError: null }).http.cutoffError, false, "null is the default, as createHttp takes it");
});
