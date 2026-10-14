// SPDX-License-Identifier: Apache-2.0
// Self-test: every document seed.mjs creates reaches the ledger — a fork, and a 200 the case's expect refused (SPEC §12, §21).

/**
 * On production the guard refuses a write naming a document the run did not
 * create, and quarantine walks only ledgered documents. So a document made
 * without a ledger row both escapes quarantine and locks the run out of it.
 * These run against a production-shaped target with the real guard reading
 * the run's own ledger file, and a fake fetch standing in for the server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttp } from "../lib/http.mjs";
import { appendLedger, ledgerDocIds, readLedger } from "../lib/ledger.mjs";
import { docIdFor, fork, publish } from "../lib/seed.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const prod = () => Object.freeze({ kind: "prod", runId: "2610101200-forks", origin: "https://seed-selftest.invalid", runDir: tempDir("e2e-seed-ledger-") });
const FORK_ID = "e2e-selftest-source-copy";
const OWNER = "owner-0forks-abcd@example.com";

/**
 * A fake server: POST /fork and POST /publish answer `status` with `json`;
 * anything else 200 {}. Records every request it is sent.
 */
function server(status = 200, json = { docId: FORK_ID, versionId: "v1", title: "Source" }) {
  const sent = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    let body = init.body;
    if (typeof body === "string" && /json/.test(init.headers["content-type"] ?? "")) body = JSON.parse(body);
    sent.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method, body });
    const creating = u.pathname === "/fork" || u.pathname === "/publish";
    return new Response(JSON.stringify(creating ? json : {}), { status: creating ? status : 200, headers: { "content-type": "application/json" } });
  };
  return { sent, fetch };
}

/** A run with one ledgered source document and one ledgered folder. */
function run() {
  const t = prod();
  const source = docIdFor(t, "source");
  appendLedger(t, { kind: "doc", docId: source, via: "upload" });
  appendLedger(t, { kind: "folder", folderId: "folder-0forks", ownerEmail: OWNER });
  return { t, source };
}

const docRows = (t) => readLedger(t).filter((r) => r.kind === "doc");

test("fork: POST /fork {op: create, docId} and nothing else unless given; the fork is ledgered as a doc, via fork", async () => {
  const { t, source } = run();
  const s = server();
  const http = createHttp(t, { actor: "owner", evidence: false, fetch: s.fetch });
  const out = await fork(http, { docId: source, ownerEmail: OWNER });
  assert.deepEqual([out.status, out.docId, out.versionId, out.json.title], [200, FORK_ID, "v1", "Source"]);
  assert.equal(out.response.status, 200, "the http.mjs response, for its headers");
  assert.deepEqual(s.sent[0], { path: "/fork", query: {}, method: "POST", body: { op: "create", docId: source } });
  const { t: _t, runId, ...row } = docRows(t).at(-1);
  assert.equal(runId, t.runId);
  assert.deepEqual(row, { kind: "doc", docId: FORK_ID, ownerEmail: OWNER, actor: "owner", via: "fork", versionId: "v1", forkOf: source });
  assert.ok(ledgerDocIds(t).has(FORK_ID), "quarantine walks it");

  // The point of the row: the production guard now lets a later write name the fork.
  assert.equal((await http.postJson("/draft", { docId: FORK_ID, html: "<p>x</p>" })).status, 200);
  assert.deepEqual(s.sent.at(-1).body, { docId: FORK_ID, html: "<p>x</p>" });

  await fork(http, { docId: source, k: "linkkey0123", versionId: "v2", folderId: "folder-0forks", title: "A fork", ownerEmail: OWNER });
  assert.deepEqual(s.sent.at(-1).body, { op: "create", docId: source, k: "linkkey0123", versionId: "v2", folderId: "folder-0forks", title: "A fork" });
  assert.ok(!readLedger(t).some((r) => JSON.stringify(r).includes("linkkey0123")), "the link key is never ledgered");
  const noOwner = await fork(createHttp(t, { evidence: false, fetch: s.fetch }), { docId: source });
  assert.equal(noOwner.status, 200);
  assert.deepEqual([docRows(t).at(-1).ownerEmail, docRows(t).at(-1).actor], [null, "anon"], "ownerEmail is optional, as publish()'s is");
});

test("NEGATIVE: a refused fork ledgers nothing, and an unledgered fork is a document the production guard refuses to touch", async () => {
  const { t, source } = run();
  const before = docRows(t).length;
  for (const status of [404, 409, 403, 400]) {
    const out = await fork(createHttp(t, { evidence: false, fetch: server(status, { error: "no" }).fetch }), { docId: source, ownerEmail: OWNER });
    assert.equal(out.status, status, "no expectation unless asked: the status comes back");
    assert.equal(out.docId, undefined);
  }
  assert.equal(docRows(t).length, before, "nothing was created, nothing ledgered");

  // What forkAs-by-hand without the ledger row leaves behind.
  const s = server();
  const http = createHttp(t, { evidence: false, fetch: s.fetch });
  const raw = await http.postJson("/fork", { op: "create", docId: source });
  assert.equal(raw.json.docId, FORK_ID);
  await assert.rejects(http.postJson("/draft", { docId: FORK_ID, html: "<p>x</p>" }), (e) => e.code === "E2E_GUARD" && e.rule === "ledger");
  await assert.rejects(fork(http, {}), /give docId/);
  await assert.rejects(fork(http, { docId: docIdFor(t, "not-mine") }), (e) => e.code === "E2E_GUARD" && e.rule === "ledger", "a fork of a document the run did not create is refused before it is sent");
});

test("a 200 the case's expect refused is still ledgered: fork and publish both throw AND keep the row", async () => {
  const { t, source } = run();
  const s = server();
  const http = createHttp(t, { actor: "owner", evidence: false, fetch: s.fetch });
  await assert.rejects(fork(http, { docId: source, ownerEmail: OWNER, expect: [403, 404] }), (e) => e.code === "E2E_STATUS" && e.response.status === 200);
  assert.deepEqual(docRows(t).filter((r) => r.via === "fork").map((r) => r.docId), [FORK_ID], "the unexpected fork");

  const pub = server(200, { docId: "e2e-0forks-surprise-abcd", versionId: "v1" });
  const httpP = createHttp(t, { actor: "stranger", evidence: false, fetch: pub.fetch });
  await assert.rejects(publish(httpP, { body: "<p>x</p>", id: "e2e-0forks-surprise-abcd", expect: 403 }), (e) => e.code === "E2E_STATUS" && e.response.status === 200);
  assert.deepEqual(docRows(t).filter((r) => r.via === "upload" && r.actor === "stranger").map((r) => r.docId), ["e2e-0forks-surprise-abcd"], "the unexpected upload");

  // And an expect that holds behaves as before: a 403 throws nothing and ledgers nothing.
  const n = docRows(t).length;
  const denied = await publish(createHttp(t, { evidence: false, fetch: server(403, { error: "no" }).fetch }), { body: "<p>x</p>", expect: 403 });
  assert.equal(denied.status, 403);
  await assert.rejects(publish(createHttp(t, { evidence: false, fetch: server(500, { error: "x" }).fetch }), { body: "<p>x</p>" }), (e) => e.code === "E2E_STATUS");
  assert.equal(docRows(t).length, n);
});
