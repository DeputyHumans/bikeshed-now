// SPDX-License-Identifier: Apache-2.0
// Self-test: CLI call tracing observes real transport boundaries and preserves body/error/egress behavior (SPEC §12, §19).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../lib/cli.mjs";
import { traceToolCalls } from "../lib/cli-call-trace.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const body = JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "get_changes", arguments: { id: "private-id", k: "private-key" } } });

test("call trace records only allowed fields and does not consume the response", async () => {
  const events = []; let tick = 10;
  const response = new Response("private-response");
  let observed;
  const fetch = traceToolCalls(async (...args) => { observed = args; return response; }, (event) => events.push(event), () => tick++);
  const init = { method: "POST", headers: { Authorization: "Bearer private-token" }, body };
  assert.equal(await fetch("http://127.0.0.1/mcp", init), response);
  assert.deepEqual(observed, ["http://127.0.0.1/mcp", init]);
  assert.equal(await response.text(), "private-response");
  assert.deepEqual(events, [{ id: 1, tool: "get_changes", phase: "start", ms: 10 }, { id: 1, tool: "get_changes", phase: "end", ms: 11, status: 200 }]);
});

test("call trace preserves a transport refusal and ignores non-tool requests", async () => {
  const events = []; const failure = new Error("refused");
  const fetch = traceToolCalls(async () => { throw failure; }, (event) => events.push(event), () => 0);
  await assert.rejects(fetch("http://127.0.0.1/mcp", { body }), (error) => error === failure);
  assert.deepEqual(events.map((event) => event.phase), ["start", "error"]);
  await assert.rejects(fetch("http://127.0.0.1/mcp", { body: "not json" }), (error) => error === failure);
  assert.equal(events.length, 2);
});

test("runCli installs the observer after its guard and returns a real child's call sequence", async () => {
  const server = createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end('{"ok":true}'); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const runDir = tempDir("e2e-calltrace-");
  const tree = join(runDir, "tree"); mkdirSync(join(tree, "cli", "src"), { recursive: true });
  writeFileSync(join(tree, "cli", "src", "index.mjs"), `const response = await fetch(process.env.BIKESHED_ORIGIN + "/mcp", { method: "POST", body: ${JSON.stringify(body)} }); console.log(JSON.stringify({ ...await response.json(), guard: Boolean(globalThis[Symbol.for("bikeshed-e2e.egress-guard")]) }));`);
  const target = { kind: "local", runId: "2610150000-call", runDir, origin: `http://127.0.0.1:${port}`, stack: { treeDir: tree, ports: { hosting: port } } };
  try {
    const r = await runCli(target, ["changes", "--json"], { traceCalls: true, guard: { checkCli: async () => ({ allow: true }) } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json, { ok: true, guard: true });
    assert.deepEqual(r.calls.map(({ id, tool, phase, status }) => ({ id, tool, phase, ...(status ? { status } : {}) })), [{ id: 1, tool: "get_changes", phase: "start" }, { id: 1, tool: "get_changes", phase: "end", status: 200 }, { id: 1, tool: "get_changes", phase: "body" }]);
    assert.ok(r.calls[1].ms >= r.calls[0].ms);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});


test("call trace marks JSON completion after a held response body without inspecting it", async () => {
  const events = []; let release; let tick = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const response = { status: 200, json: async () => { await held; return { secret: "never logged" }; } };
  const fetch = traceToolCalls(async () => response, (event) => events.push(event), () => tick++);
  const result = await fetch("http://127.0.0.1/mcp", { body });
  const parsing = result.json();
  assert.deepEqual(events.map((event) => event.phase), ["start", "end"]);
  release();
  assert.deepEqual(await parsing, { secret: "never logged" });
  assert.deepEqual(events, [{ id: 1, tool: "get_changes", phase: "start", ms: 0 }, { id: 1, tool: "get_changes", phase: "end", ms: 1, status: 200 }, { id: 1, tool: "get_changes", phase: "body", ms: 2 }]);
});
