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
  assert.deepEqual(Array.from(cases.find((c) => c.name.startsWith("A21.3 ")).options.tiers), ["local", "prod"], "non-email audience coverage is reusable on both tiers");
  assert.equal(cases.find((c) => c.name.startsWith("A21.3 ")).options.effects, undefined, "the shared helper selects the tier-safe grant path");
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

/** Execute the actual audience body with deterministic, in-memory tier adapters. */
async function audience(kind, corrupt = () => {}) {
  const source = readFileSync(new URL("../specs/functional/a21-changes.spec.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("// --- A21.3 "), source.indexOf("// --- A21.4 "));
  const accounts = ["owner", "viewer", "editor"].map((role) => ({ role, email: `${role}@example.com` }));
  const at = "2026-10-15T00:00:00.000Z";
  const data = [];
  const events = [
    { type: "version.published", at },
    ...(kind === "local" ? accounts.slice(1).map((a) => ({ type: "access.changed", channel: "web", automated: false, added: [a.email], removed: [], by: accounts[0].email, at })) : []),
    { type: "doc.visibility", at }, { type: "doc.visibility", at }, { type: "doc.moved", at },
    { type: "thread.opened", at }, { type: "comment.added", at }, { type: "fork.created", id: "e-fork", version: "v1", at: "2026-10-15" },
  ];
  corrupt(events);
  const counts = (types) => Object.fromEntries(Object.entries(types.reduce((m, t) => ({ ...m, [t]: (m[t] ?? 0) + 1 }), {})).sort());
  const draft = { updatedByEmail: accounts[2].email, updatedAt: { toDate: () => new Date(at) } };
  const expectedDraft = { exists: true, lastEditedBy: accounts[2].email, lastEditedAt: at };
  let operatorTrusted = false;
  const http = { postJson: async (path, payload) => {
    assert.ok(["/trust", "/draft"].includes(path), "no direct mail-sending grant bypass");
    if (path === "/trust" && payload.trusted === false) {
      assert.equal(operatorTrusted, true, "the operator trusts before the owner restores the sandbox");
      operatorTrusted = false;
      events.push({ type: "doc.trust", at: "2026-10-15T00:00:01.000Z" });
    }
    return { status: 200 };
  } };
  let run;
  const target = { kind };
  const context = {
    assert: { ...assert, deepEqual: (a, b, message) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message) },
    trustAsOperator: async (t, docId) => { assert.equal(t, target); assert.equal(docId, "doc"); operatorTrusted = true; },
    target, accounts, DAY: /^\d{4}-\d{2}-\d{2}$/,
    scenario: (_name, _options, fn) => { run = fn; },
    tag: () => "scope", FIXTURE_HTML: "<body>text</body>",
    stage: async () => ({ owner: { http }, accounts, agent: { role: "owner", mcp: { ok: async () => ({}) } }, docId: "doc" }),
    share: async (t, args) => { assert.equal(t.kind, kind); data.push(args.role); },
    setVisibility: async () => {}, createFolderMcp: async () => ({ folderId: "folder" }),
    precondition: assert.ok, thread: async () => {}, browserOf: async () => ({}),
    sessionOf: async (account) => ({ role: account.role, http }), fork: async () => ({}),
    settle: async (_id, want) => {
      assert.deepEqual(Object.fromEntries(Object.entries(want).filter(([, n]) => n)), counts(events.map((e) => e.type)), `${kind}: only the local grant path records access events`);
      return events.map((data, i) => ({ id: String(i), data }));
    },
    readDoc: async () => ({ draft }), agentOf: async (_ctx, session) => session,
    changes: async (agent) => ({
      events: events.filter((e) => agent.role === "owner" || (agent.role === "editor" ? e.type !== "fork.created" : ["version.published", "thread.opened", "comment.added"].includes(e.type))),
      cursor: "end", state: agent.role === "viewer" ? {} : { draft: expectedDraft },
    }),
    counts, typesOf: (r) => counts(r.events.map((e) => e.type)),
    stripAt: ({ at: _at, ...e }) => e,
  };
  const shareEvents = source.match(/^const SHARE_EVENTS = .*;$/m)?.[0];
  assert.ok(shareEvents, "run the source tier selector too");
  runInNewContext(`${shareEvents}\n${body}`, context);
  await run({ step() {} });
  assert.deepEqual(data, ["viewer", "editor"], "both grants use the shared tier-safe adapter");
}

test("A21 audience runs its access-event assertions locally", async () => { await audience("local"); });
test("A21 audience keeps trust, visibility, move, fork and draft assertions without production access events", async () => { await audience("prod"); });

test("A21 local audience rejects a wrong access principal even when event counts match", async () => {
  await assert.rejects(audience("local", (events) => { events.find((e) => e.type === "access.changed").added = ["wrong@example.com"]; }), /access.changed: who was added/);
});
test("A21 production-safe audience still rejects an identified fork", async () => {
  await assert.rejects(audience("prod", (events) => { events.find((e) => e.type === "fork.created").by = "viewer@example.com"; }), /never by whom/);
});
