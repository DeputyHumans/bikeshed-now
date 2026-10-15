// SPDX-License-Identifier: Apache-2.0
// Keep change-feed cases and clients connected to evidence-based timeout judging (SPEC §12, §19).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function load() {
  const cases = [];
  const clients = [];
  const account = { role: "owner", email: "owner@example.com" };
  const target = { runId: "test", kind: "local" };
  const session = { account, uid: "u", http: {} };
  const agent = { initialize: async () => undefined };
  const context = {
    assert, Buffer,
    after() {}, currentTarget: () => target, readFixture: () => "<p id=\"e2e-1\">First text.</p>",
    scenario: (name, options, body) => cases.push({ name, options, body }),
    openSession: async (_target, _account, options) => { clients.push(["session", options]); return session; },
    mintToken: async () => ({ token: "tok", tokenId: "t" }),
    idToken: async (_target, _account, options) => { clients.push(["identity", options]); return "id"; },
    clientFirestore: (_target, options) => options,
    cast: async () => [account],
    publishMcp: async () => ({ isError: false, docId: "document", json: { cursor: "saved-cursor" } }),
    readDoc: async () => ({ cursor: "saved-cursor" }),
    docIdFor: () => "document", precondition: assert.ok,
  };
  const source = readFileSync(new URL("../specs/functional/a21-changes.spec.mjs", import.meta.url), "utf8");
  runInNewContext(source.replace(/^import .*;\n/gm, "") + "\nglobalThis.helpers = { sessionOf, agentOf, browserOf, stage };", context);
  const ctx = {
    http: (options) => { clients.push(["http", options]); return {}; },
    mcp: (options) => { clients.push(["mcp", options]); return agent; },
    step() {},
  };
  return { ...context.helpers, ctx, account, session, cases, clients };
}

test("every A21 trigger-dependent scenario opts into function-kill evidence, including the independent malformed and tied-boundary cases", () => {
  const { cases } = load();
  assert.equal(cases.length, 9);
  for (const c of cases) assert.equal(c.options.inconclusiveOnFunctionKill, true, c.name);
  assert.deepEqual(Array.from(cases.find((c) => c.name.startsWith("A21.3 ")).options.tiers), ["local"], "audience sharing remains explicitly local in this campaign");
});

test("all A21 session, identity, MCP and browser HTTP clients surface Hosting cutoffs", async () => {
  const x = load();
  await x.sessionOf(x.account);
  await x.agentOf(x.ctx, x.session, "agent");
  await x.browserOf(x.ctx, x.account);
  await x.stage(x.ctx, [], "name", "title");
  assert.ok(x.clients.length >= 7, "exercise both direct helper and stage client creation");
  for (const [kind, options] of x.clients) {
    assert.equal(options.cutoffError, true, `${kind} surfaces a Hosting cutoff`);
    assert.equal(options.timeoutMs, 180_000, `${kind} retains its explicit request budget`);
  }
});
