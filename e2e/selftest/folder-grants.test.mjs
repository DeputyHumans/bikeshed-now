// SPDX-License-Identifier: Apache-2.0
// Self-test: folders the run makes are ledgered, folder grants and team members go out in the product's shape and only locally, and share() takes a request timeout (SPEC §12, §13, §18).

/**
 * Through http.mjs with a fake fetch standing in for the server, as
 * team-ledger.test.mjs does. On a production-shaped target the real guard
 * reads the run's own ledger.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttp } from "../lib/http.mjs";
import { appendLedger, readLedger } from "../lib/ledger.mjs";
import { runTag } from "../lib/accounts.mjs";
import { createFolder } from "../lib/seed.mjs";
import { principalOf, share, shareFolder, teamMembers, unshare, unshareFolder } from "../lib/grant.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const OWNER = "owner-0fold-abcd@example.com";
const local = () => Object.freeze({ kind: "local", runId: "2610110300-fold", runDir: tempDir("e2e-fold-"), origin: "http://127.0.0.1:39023", stack: { ports: { hosting: 39023 } } });
const prod = () => Object.freeze({ kind: "prod", runId: "2610110300-fold", origin: "https://folders-selftest.invalid", runDir: tempDir("e2e-fold-prod-") });

/** Answers each request with `answer(path, body)` → {status, json}; records every request. */
function server(answer) {
  const sent = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    sent.push({ path: u.pathname, method: init.method, body });
    const { status = 200, json = {} } = answer(u.pathname, body) ?? {};
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { sent, fetch };
}

/** A fetch that never answers: it waits for the request's own abort. */
function silent() {
  const sent = [];
  const fetch = (url, init) =>
    new Promise((_, reject) => {
      sent.push(new URL(url).pathname);
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  return { sent, fetch };
}

const rows = (t, kind) => readLedger(t).filter((r) => r.kind === kind).map(({ t: _t, runId: _r, ...row }) => row);
const owner = (t, fetch) => ({ account: { email: OWNER }, http: createHttp(t, { actor: "owner", evidence: false, fetch }) });

test("createFolder: POST /folder {name[, parentId]}; the folder is ledgered with its owner, actor, parent and name", async () => {
  const t = local();
  let n = 0;
  const s = server((path, body) => ({ json: { folderId: `fOLD${++n}`, name: String(body.name).trim() } }));
  const http = createHttp(t, { actor: "owner", evidence: false, fetch: s.fetch });
  const top = await createFolder(http, { name: "Top", ownerEmail: OWNER });
  assert.deepEqual([top.status, top.folderId, top.name, top.parentId, top.json], [200, "fOLD1", "Top", null, { folderId: "fOLD1", name: "Top" }]);
  const inner = await createFolder(http, { name: "Inner", parentId: top, ownerEmail: OWNER });
  const byId = await createFolder(http, { name: "By id", parentId: "fOLD1" });
  const unnamed = await createFolder(createHttp(t, { evidence: false, fetch: s.fetch }));
  assert.deepEqual(s.sent.slice(0, 3), [
    { path: "/folder", method: "POST", body: { name: "Top" } },
    { path: "/folder", method: "POST", body: { name: "Inner", parentId: "fOLD1" } },
    { path: "/folder", method: "POST", body: { name: "By id", parentId: "fOLD1" } },
  ]);
  assert.match(s.sent[3].body.name, new RegExp(`^e2e ${runTag(t.runId)} folder [a-z0-9]{4}$`), "a default name carries the run tag");
  assert.deepEqual([inner.parentId, byId.parentId, unnamed.name], ["fOLD1", "fOLD1", s.sent[3].body.name]);
  assert.deepEqual(rows(t, "folder"), [
    { kind: "folder", folderId: "fOLD1", ownerEmail: OWNER, actor: "owner", parentId: null, name: "Top" },
    { kind: "folder", folderId: "fOLD2", ownerEmail: OWNER, actor: "owner", parentId: "fOLD1", name: "Inner" },
    { kind: "folder", folderId: "fOLD3", ownerEmail: null, actor: "owner", parentId: "fOLD1", name: "By id" },
    { kind: "folder", folderId: "fOLD4", ownerEmail: null, actor: "anon", parentId: null, name: s.sent[3].body.name },
  ]);
  await assert.rejects(createFolder(http, { parentId: { name: "no id" } }), /parentId is a folder id or a createFolder result/);
});

test("createFolder: a 200 the case's expect refused is still ledgered; a refusal ledgers nothing; expect null takes any status", async () => {
  const t = local();
  const ok = createHttp(t, { actor: "stranger", evidence: false, fetch: server(() => ({ json: { folderId: "fSURPRISE", name: "x" } })).fetch });
  await assert.rejects(createFolder(ok, { name: "x", expect: 403 }), (e) => e.code === "E2E_STATUS" && e.response.status === 200);
  assert.deepEqual(rows(t, "folder").map((r) => r.folderId), ["fSURPRISE"]);
  const no = createHttp(t, { evidence: false, fetch: server(() => ({ status: 404, json: { error: "destination folder not found" } })).fetch });
  await assert.rejects(createFolder(no, { name: "y", parentId: "nope" }), (e) => e.code === "E2E_STATUS" && e.response.status === 404, "default expect is 200");
  const free = await createFolder(no, { name: "y", parentId: "nope", expect: null });
  assert.deepEqual([free.status, free.folderId, free.json], [404, undefined, { error: "destination folder not found" }]);
  assert.equal(rows(t, "folder").length, 1, "nothing more ledgered");
});

test("createFolder on production: inside a folder the run made it is sent; inside one it did not, the guard refuses it before sending", async () => {
  const t = prod();
  appendLedger(t, { kind: "folder", folderId: "fMINE", ownerEmail: OWNER });
  const s = server(() => ({ json: { folderId: "fNEW", name: "n" } }));
  const http = createHttp(t, { evidence: false, fetch: s.fetch });
  await createFolder(http, { name: "n", parentId: "fMINE", ownerEmail: OWNER });
  await assert.rejects(createFolder(http, { name: "n", parentId: "fTHEIRS" }), (e) => e.code === "E2E_GUARD" && e.rule === "ledger-folder");
  assert.deepEqual(s.sent.map((r) => r.body.parentId), ["fMINE"]);
  assert.deepEqual(rows(t, "folder").map((r) => r.folderId), ["fMINE", "fNEW"], "the new folder is the run's, so later writes may name it");
});

test("principalOf: emails lower-cased, a team's id kept as it is", () => {
  assert.equal(principalOf(" Viewer-0fold-X@Example.com "), "viewer-0fold-x@example.com");
  assert.equal(principalOf({ email: "A@Example.com" }), "a@example.com");
  assert.equal(principalOf("team:AbC_9-z"), "team:AbC_9-z");
  assert.equal(principalOf({ teamId: "AbC_9-z", name: "t" }), "team:AbC_9-z", "a createTeam result");
  for (const bad of ["", "  ", null, {}, { email: " " }]) assert.throws(() => principalOf(bad), /an account, an email or a team is required/);
});

test("shareFolder / unshareFolder: POST /folder-access in the product's shape; a grant is ledgered only when it answered 200", async () => {
  const t = local();
  const s = server((path, body) => (body.folderId === "fREFUSE" ? { status: 403, json: {} } : { json: { viewers: [], suggesters: [], editors: [body.add?.[0]?.principal].filter(Boolean), approvers: [] } }));
  const o = owner(t, s.fetch);
  const g = await shareFolder(t, { owner: o, folder: { folderId: "fA" }, account: { teamId: "TeAm1" }, role: "editor" });
  assert.deepEqual([g.status, g.folderId, g.principal, g.json.editors], [200, "fA", "team:TeAm1", ["team:TeAm1"]]);
  await shareFolder(t, { owner: o, folder: "fA", account: "Grantee-0fold-Q@Example.com" });
  const u = await unshareFolder(t, { owner: o, folder: "fA", account: { email: "Grantee-0fold-Q@Example.com" } });
  assert.deepEqual([u.status, u.principal], [200, "grantee-0fold-q@example.com"]);
  await assert.rejects(shareFolder(t, { owner: o, folder: "fREFUSE", account: "x@example.com" }), (e) => e.code === "E2E_STATUS" && e.response.status === 403);
  const asked = await shareFolder(t, { owner: o, folder: "fREFUSE", account: "x@example.com", expect: 403 });
  assert.equal(asked.status, 403);
  assert.deepEqual(s.sent, [
    { path: "/folder-access", method: "POST", body: { folderId: "fA", add: [{ principal: "team:TeAm1", role: "editor" }] } },
    { path: "/folder-access", method: "POST", body: { folderId: "fA", add: [{ principal: "grantee-0fold-q@example.com", role: "viewer" }] } },
    { path: "/folder-access", method: "POST", body: { folderId: "fA", remove: ["grantee-0fold-q@example.com"] } },
    { path: "/folder-access", method: "POST", body: { folderId: "fREFUSE", add: [{ principal: "x@example.com", role: "viewer" }] } },
    { path: "/folder-access", method: "POST", body: { folderId: "fREFUSE", add: [{ principal: "x@example.com", role: "viewer" }] } },
  ]);
  assert.deepEqual(rows(t, "grant"), [
    { kind: "grant", folderId: "fA", email: "team:TeAm1", role: "editor", via: "folder-access" },
    { kind: "grant", folderId: "fA", email: "grantee-0fold-q@example.com", role: "viewer", via: "folder-access" },
  ]);
  await assert.rejects(shareFolder(t, { owner: o, folder: "fA", account: "x@example.com", expect: 403 }), (e) => e.code === "E2E_STATUS" && e.response.status === 200);
  assert.equal(rows(t, "grant").length, 3, "a grant the case did not expect is still the run's");
  await assert.rejects(shareFolder(t, { owner: o, folder: "fA", account: "x@example.com", role: "owner" }), /role must be one of/);
  await assert.rejects(shareFolder(t, { owner: o, account: "x@example.com" }), /folder id/);
  assert.equal(s.sent.length, 6, "a bad role or a missing folder sends nothing");
});

test("NEGATIVE: on production shareFolder and unshareFolder throw E2E_LOCAL_ONLY and send nothing", async () => {
  const t = prod();
  appendLedger(t, { kind: "folder", folderId: "fMINE", ownerEmail: OWNER });
  const s = server(() => ({ json: {} }));
  const o = owner(t, s.fetch);
  await assert.rejects(shareFolder(t, { owner: o, folder: "fMINE", account: "x@example.com" }), (e) => e.code === "E2E_LOCAL_ONLY" && /scripts\/set-access\.mjs takes documents only/.test(e.message));
  await assert.rejects(unshareFolder(t, { owner: o, folder: "fMINE", account: "x@example.com" }), (e) => e.code === "E2E_LOCAL_ONLY");
  assert.deepEqual([s.sent, rows(t, "grant")], [[], []]);
});

test("teamMembers: POST /team-members with only what was given, lower-cased; members, admins and affected come back", async () => {
  const t = local();
  const s = server(() => ({ json: { members: ["a@example.com", "o@example.com"], admins: ["o@example.com"], affected: 2 } }));
  const http = createHttp(t, { actor: "owner", evidence: false, fetch: s.fetch });
  const r = await teamMembers(http, { teamId: "TeAm1" }, { add: ["A@Example.com", { email: "B@example.com" }] });
  assert.deepEqual([r.status, r.members, r.admins, r.affected], [200, ["a@example.com", "o@example.com"], ["o@example.com"], 2]);
  await teamMembers(http, "TeAm1", { remove: [{ email: "b@example.com" }] });
  await teamMembers(http, "TeAm1", { admin: { email: "a@example.com", isAdmin: true } });
  assert.deepEqual(s.sent.map((x) => x.body), [
    { teamId: "TeAm1", add: ["a@example.com", "b@example.com"] },
    { teamId: "TeAm1", remove: ["b@example.com"] },
    { teamId: "TeAm1", admin: { email: "a@example.com", isAdmin: true } },
  ]);
  await assert.rejects(teamMembers(http, {}, { add: ["a@example.com"] }), /team id/);
  await assert.rejects(teamMembers(http, "TeAm1", { add: [""] }), /every add entry/);
  const free = await teamMembers(createHttp(t, { evidence: false, fetch: server(() => ({ status: 403, json: {} })).fetch }), "TeAm1", { add: ["a@example.com"], expect: null });
  assert.deepEqual([free.status, free.members, free.affected], [403, null, null]);
});

test("NEGATIVE: on production the guard refuses POST /team-members before it is sent", async () => {
  const t = prod();
  const s = server(() => ({ json: {} }));
  await assert.rejects(teamMembers(createHttp(t, { evidence: false, fetch: s.fetch }), "TeAm1", { add: ["a@example.com"] }), (e) => e.code === "E2E_GUARD" && e.rule === "team-members");
  assert.deepEqual(s.sent, []);
});

/** Settles with the call's rejection, or "no answer" if it is still waiting after `ms`. */
const within = (p, ms) => Promise.race([p.then(() => "resolved", (e) => e), new Promise((r) => setTimeout(() => r("no answer"), ms).unref())]);

test("timeoutMs reaches the request: share, unshare, shareFolder, unshareFolder, createFolder and teamMembers give up when told to", async () => {
  const t = local();
  const s = silent();
  const o = owner(t, s.fetch);
  const calls = {
    share: () => share(t, { owner: o, doc: "e2e-0fold-d-abcd", account: "v@example.com", verify: false, timeoutMs: 150 }),
    unshare: () => unshare(t, { owner: o, doc: "e2e-0fold-d-abcd", account: "v@example.com", timeoutMs: 150 }),
    shareFolder: () => shareFolder(t, { owner: o, folder: "fA", account: "v@example.com", timeoutMs: 150 }),
    unshareFolder: () => unshareFolder(t, { owner: o, folder: "fA", account: "v@example.com", timeoutMs: 150 }),
    createFolder: () => createFolder(o.http, { name: "slow", timeoutMs: 150 }),
    teamMembers: () => teamMembers(o.http, "TeAm1", { add: ["v@example.com"], timeoutMs: 150 }),
  };
  const out = {};
  for (const [name, call] of Object.entries(calls)) {
    const r = await within(call(), 5_000);
    out[name] = r instanceof Error ? r.message : r;
  }
  assert.deepEqual(out, Object.fromEntries(Object.keys(calls).map((k) => [k, "timeout after 150 ms"])));
  assert.deepEqual(s.sent, ["/access", "/access", "/folder-access", "/folder-access", "/folder", "/team-members"]);
  assert.deepEqual(rows(t, "grant"), [], "a request that never answered grants nothing in the ledger");
});
