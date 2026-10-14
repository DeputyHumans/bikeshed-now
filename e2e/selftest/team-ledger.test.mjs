// SPDX-License-Identifier: Apache-2.0
// Self-test: a team the run makes is ledgered as kind "team", also when the case's expect refused the 200, and production refuses to make one (SPEC §12, §18).

/**
 * createTeam is POST /team {op: "create"} through http.mjs, with a fake fetch
 * standing in for the server. On a production-shaped target the real guard
 * reads the run's own ledger and refuses the request before it is sent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttp } from "../lib/http.mjs";
import { appendLedger, LEDGER_KINDS, ledgerDocIds, readLedger } from "../lib/ledger.mjs";
import { runTag } from "../lib/accounts.mjs";
import { createTeam } from "../lib/seed.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const OWNER = "owner-0teams-abcd@example.com";
const local = () => Object.freeze({ kind: "local", runId: "2610110100-teams", runDir: tempDir("e2e-teams-"), origin: "http://127.0.0.1:39021", stack: { ports: { hosting: 39021 } } });
const prod = () => Object.freeze({ kind: "prod", runId: "2610110100-teams", origin: "https://teams-selftest.invalid", runDir: tempDir("e2e-teams-prod-") });

/** POST /team answers `status` with `json` (the product's create answer by default); every request is recorded. */
function server(status = 200, json = null) {
  const sent = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    sent.push({ path: u.pathname, method: init.method, body });
    const answer = json ?? { teamId: "tEAm0001", name: String(body?.name ?? "").trim() };
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  };
  return { sent, fetch };
}

const teamRows = (t) => readLedger(t).filter((r) => r.kind === "team").map(({ t: _t, runId: _r, ...row }) => row);

test("the ledger takes a team row, and nothing that walks documents counts it", () => {
  const t = local();
  assert.ok(LEDGER_KINDS.includes("team"));
  appendLedger(t, { kind: "team", teamId: "tEAm0001", ownerEmail: OWNER });
  appendLedger(t, { kind: "doc", docId: "e2e-0teams-doc-abcd", via: "upload" });
  assert.deepEqual(teamRows(t), [{ kind: "team", teamId: "tEAm0001", ownerEmail: OWNER }]);
  assert.deepEqual([...ledgerDocIds(t)], ["e2e-0teams-doc-abcd"]);
  assert.throws(() => appendLedger(t, { kind: "team", teamId: "x", token: "y" }), /never carries token/, "the credential rules hold for it too");
});

test("createTeam: POST /team {op: create, name}; the team is ledgered with its owner, actor and name", async () => {
  const t = local();
  const s = server();
  const http = createHttp(t, { actor: "owner", evidence: false, fetch: s.fetch });
  const out = await createTeam(http, { name: "A1.5 team", ownerEmail: OWNER });
  assert.deepEqual([out.status, out.teamId, out.name, out.json], [200, "tEAm0001", "A1.5 team", { teamId: "tEAm0001", name: "A1.5 team" }]);
  assert.equal(out.response.status, 200);
  assert.deepEqual(s.sent, [{ path: "/team", method: "POST", body: { op: "create", name: "A1.5 team" } }]);
  assert.deepEqual(teamRows(t), [{ kind: "team", teamId: "tEAm0001", ownerEmail: OWNER, actor: "owner", name: "A1.5 team" }]);

  const unnamed = await createTeam(createHttp(t, { evidence: false, fetch: s.fetch }));
  assert.match(s.sent.at(-1).body.name, new RegExp(`^e2e ${runTag(t.runId)} team [a-z0-9]{4}$`), "a default name carries the run tag");
  assert.equal(unnamed.name, s.sent.at(-1).body.name);
  assert.deepEqual([teamRows(t).at(-1).ownerEmail, teamRows(t).at(-1).actor], [null, "anon"], "ownerEmail is optional, as publish()'s is");
});

test("a 200 the case's expect refused is still ledgered; a refusal ledgers nothing; expect null takes any status", async () => {
  const t = local();
  const http = createHttp(t, { actor: "stranger", evidence: false, fetch: server().fetch });
  await assert.rejects(createTeam(http, { name: "surprise", expect: 403 }), (e) => e.code === "E2E_STATUS" && e.response.status === 200);
  assert.deepEqual(teamRows(t).map((r) => [r.teamId, r.actor]), [["tEAm0001", "stranger"]], "the unexpected team is the run's");

  const bad = createHttp(t, { evidence: false, fetch: server(400, { error: "team name is required (up to 120 characters)" }).fetch });
  await assert.rejects(createTeam(bad, { name: " " }), (e) => e.code === "E2E_STATUS" && e.response.status === 400, "default expect is 200");
  const free = await createTeam(bad, { name: "x".repeat(121), expect: null });
  assert.deepEqual([free.status, free.teamId], [400, undefined]);
  const asked = await createTeam(bad, { name: "", expect: 400 });
  assert.equal(asked.json.error, "team name is required (up to 120 characters)");
  assert.equal(teamRows(t).length, 1, "nothing was created, nothing more ledgered");
});

test("NEGATIVE: on production the guard refuses POST /team before it is sent, and nothing is ledgered", async () => {
  const t = prod();
  const s = server();
  const http = createHttp(t, { evidence: false, fetch: s.fetch });
  await assert.rejects(createTeam(http, { name: "never", ownerEmail: OWNER }), (e) => e.code === "E2E_GUARD" && e.rule === "team");
  assert.deepEqual([s.sent, teamRows(t)], [[], []]);
});
