// SPDX-License-Identifier: Apache-2.0
// Self-test: absent-id probes — minted and ledgered by seed, let through the production guard only once proved empty (SPEC §1.4, §12).

/**
 * SPEC §1.4b parity ("the same 404 as an absent id") needs the same write
 * against an id that does not exist. On production the guard refuses a write
 * naming a document the run did not create, so seed.absentDocId() ledgers the
 * id as "absent" and the guard lets it through after absentDoc() proves
 * docs/<id> holds nothing. Everything else the guard refuses, it still does.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { absentDoc, createGuard, evaluate, installGuard } from "../lib/guard.mjs";
import { appendLedger, ledgerAbsentIds, ledgerDocIds, readLedger } from "../lib/ledger.mjs";
import { absentDocId, docIdFor } from "../lib/seed.mjs";
import { createHttp } from "../lib/http.mjs";
import { runCli } from "../lib/cli.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const prod = () => Object.freeze({ kind: "prod", runId: "2610101200-absnt", origin: "https://absent-selftest.invalid", runDir: tempDir("e2e-absent-") });
const P = prod();
const ABSENT = docIdFor(P, "a2-absent");
const ctxWith = (absent) => ({ target: P, ledgerDocs: new Set(["e2e-0absnt-mine-abcd"]), ledgerFolders: new Set(["folder-mine"]), ...(absent ? { ledgerAbsent: new Set(absent) } : {}) });
const req = (method, path, body) => ({ method, url: `${P.origin}${path}`, body: body === undefined ? undefined : JSON.stringify(body) });
const mcp = (name, args) => req("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

/** The parity probes a02-matrix-http sends against an absent id. */
const PROBES = [
  ["POST /draft", req("POST", "/draft", { docId: ABSENT, html: "<p>x</p>" })],
  ["POST /commit", req("POST", "/commit", { docId: ABSENT })],
  ["POST /publish?update=", req("POST", `/publish?update=${ABSENT}&filename=index.html`, "<p>x</p>")],
  ["POST /organize rename", req("POST", "/organize", { kind: "doc", id: ABSENT, op: "rename", title: "x" })],
  ["POST /thumb", req("POST", `/thumb?doc=${ABSENT}&v=v1&kind=cover`, "")],
  ["POST /fork", req("POST", "/fork", { docId: ABSENT, op: "create" })],
  ["POST /unlock", req("POST", "/unlock", { docId: ABSENT })],
  ["POST /view", req("POST", "/view", { docId: ABSENT })],
  ["POST /visibility", req("POST", "/visibility", { docId: ABSENT, visibility: "public" })],
  ["POST /suggestion", req("POST", "/suggestion", { docId: ABSENT, versionId: "v1", op: "create" })],
  ["MCP update_document", mcp("update_document", { id: ABSENT, content: "x" })],
  ["MCP fork_document", mcp("fork_document", { id: ABSENT })],
  ["MCP add_comment", mcp("add_comment", { id: ABSENT, exact: "x", body: "b" })],
  ["MCP accept_suggestion", mcp("accept_suggestion", { id: ABSENT, threadId: "t" })],
];

test("absentDocId: a docIdFor id, ledgered as absent, never counted as a document", () => {
  const t = prod();
  const id = absentDocId(t, "a2-absent");
  assert.match(id, /^e2e-0absnt-a2-absent-[a-z0-9]{4}$/);
  assert.deepEqual(readLedger(t).map((r) => [r.kind, r.docId]), [["absent", id]]);
  assert.deepEqual([...ledgerAbsentIds(t)], [id]);
  assert.deepEqual([...ledgerDocIds(t)], [], "an absent id is not a document, so quarantine never walks it");
  assert.match(absentDocId(t), /^e2e-0absnt-absent-[a-z0-9]{4}$/, "the default name");
  appendLedger(t, { kind: "doc", docId: id, via: "upload" });
  assert.ok(!ledgerAbsentIds(t).has(id), "an id the run went on to create is a document, no longer absent");
});

test("evaluate: on production, every parity probe naming a ledgered absent id is allowed, pending the absence proof", () => {
  for (const [label, r] of PROBES) {
    const v = evaluate(r, ctxWith([ABSENT]));
    assert.equal(v.allow, true, `${label}: ${v.reason}`);
    assert.deepEqual(v.absentDocs, [ABSENT], `${label} carries the id for assertAbsent`);
    assert.equal(v.quietDocs, undefined, `${label}: an absent id needs no quiet proof, its absence is one`);
    assert.equal(v.rule, "absent-probe", label);
  }
  const mixed = evaluate(mcp("add_comment", { id: "e2e-0absnt-mine-abcd", exact: "x", body: "b" }), ctxWith([ABSENT]));
  assert.deepEqual([mixed.rule, mixed.quietDocs, mixed.absentDocs], ["comment", ["e2e-0absnt-mine-abcd"], undefined], "the run's own document still needs its quiet proof");
  const both = evaluate(req("POST", "/suggestion", [{ docId: "e2e-0absnt-mine-abcd" }, { docId: ABSENT }]), ctxWith([ABSENT]));
  assert.deepEqual([both.quietDocs, both.absentDocs], [["e2e-0absnt-mine-abcd"], [ABSENT]]);
});

test("NEGATIVE: without the absent row every one of those probes is refused, as before", () => {
  for (const ctx of [ctxWith(null), ctxWith([])]) {
    for (const [label, r] of PROBES) {
      const v = evaluate(r, ctx);
      assert.deepEqual([v.allow, v.rule], [false, "ledger"], `${label} with no absent row`);
    }
  }
});

test("NEGATIVE: an absent row does not open anything else", () => {
  const ctx = ctxWith([ABSENT, "launch-plan", "e2e-other1-doc-abcd"]);
  const v = (r) => evaluate(r, ctx);
  assert.equal(v(req("POST", "/access", { docId: ABSENT, add: [] })).rule, "access", "an email route is refused whatever it names");
  assert.equal(v(req("POST", "/folder-access", { docId: ABSENT })).rule, "folder-access");
  assert.equal(v(req("POST", "/verify/start", { docId: ABSENT })).rule, "verify");
  assert.equal(v(req("POST", "/draft", { docId: "launch-plan" })).rule, "absent-namespace", "a hand-ledgered id outside the run's namespace");
  assert.equal(v(mcp("update_document", { id: "e2e-other1-doc-abcd" })).rule, "absent-namespace", "another run's id");
  assert.equal(v(req("POST", "/organize", [{ kind: "doc", id: ABSENT, op: "move" }, { kind: "doc", id: "someone-elses", op: "move" }])).rule, "ledger", "a batch with a foreign id");
  assert.equal(v(req("POST", "/organize", { kind: "folder", id: ABSENT, op: "rename" })).rule, "ledger-folder", "an absent DOC id is not a folder");
  assert.equal(v(mcp("move_document", { id: ABSENT, folder: "folder-theirs" })).rule, "ledger-folder", "the folder is still checked");
  assert.equal(v(req("POST", "/draft", { docId: docIdFor(P, "a2-absent") })).rule, "ledger", "a fresh docIdFor id that was never ledgered");
  assert.equal(v(mcp("brand_new_tool", { id: ABSENT })).rule, "unclassified-tool");
  const noRun = evaluate(req("POST", "/draft", { docId: ABSENT }), { ...ctx, target: { ...P, runId: undefined } });
  assert.equal(noRun.rule, "absent-namespace", "no run id, no namespace, no probe");
});

test("check(): an absent probe goes only after assertAbsent, and one that exists is refused", async () => {
  const asked = [];
  const ledger = () => ({ docs: new Set(), folders: new Set(), absent: new Set([ABSENT]), accounts: new Map() });
  const empty = createGuard(P, { ledger, absentCheck: async (d) => void asked.push(d), quietCheck: async () => assert.fail("no quiet check for an absent id") });
  for (const [label, r] of PROBES) assert.equal((await empty.check(r)).allow, true, label);
  assert.equal(asked.length, PROBES.length, "every write asked once");
  assert.ok(asked.every((d) => d === ABSENT));
  assert.equal((await empty.check(req("GET", `/content/${ABSENT}/v1/index.html`))).allow, true);
  assert.equal(asked.length, PROBES.length, "a read needs no proof");

  const there = createGuard(P, { ledger, absentCheck: async (d) => { throw new Error(`docs/${d} exists, so it is not absent`); } });
  for (const [label, r] of PROBES) {
    const v = await there.check(r);
    assert.deepEqual([v.allow, v.rule], [false, "absent-probe"], label);
    assert.match(v.reason, /exists, so it is not absent/);
  }
  assert.equal(there.refusals.length, PROBES.length, "each refusal is recorded");
  assert.equal(typeof there.assertAbsent, "function");
});

test("absentDoc: missing and empty passes; a document, or a subcollection under a missing one, throws", async () => {
  const calls = [];
  const fakeDb = ({ exists, subs }) => ({
    collection: (c) => ({
      doc: (id) => {
        calls.push(`${c}/${id}`);
        return { get: async () => ({ exists }), listCollections: async () => subs.map((s) => ({ id: s })) };
      },
    }),
  });
  assert.deepEqual(await absentDoc(P, ABSENT, { db: fakeDb({ exists: false, subs: [] }) }), { docId: ABSENT, absent: true });
  assert.deepEqual(calls, [`docs/${ABSENT}`]);
  await assert.rejects(absentDoc(P, ABSENT, { db: fakeDb({ exists: true, subs: [] }) }), /exists, so it is not absent/);
  await assert.rejects(absentDoc(P, ABSENT, { db: fakeDb({ exists: false, subs: ["versions", "access"] }) }), /does not exist but holds access, versions/);
});

test("choke points: http.mjs sends a ledgered probe after the proof; the CLI and the browser's Firestore writes still refuse it", async () => {
  const t = prod();
  const id = absentDocId(t, "a2-absent");
  let fetched = 0;
  const fake = async () => (fetched++, new Response('{"error":"not found"}', { status: 404 }));
  let empty = true;
  const g = createGuard(t, { absentCheck: async (d) => { if (!empty) throw new Error(`docs/${d} exists, so it is not absent`); } });
  const http = createHttp(t, { guard: g, evidence: false, fetch: fake });
  assert.equal((await http.postJson("/draft", { docId: id, html: "<p>x</p>" })).status, 404, "read from the run's own ledger file");
  assert.equal(fetched, 1);
  await assert.rejects(http.postJson("/draft", { docId: docIdFor(t, "a2-absent") }), (e) => e.code === "E2E_GUARD" && e.rule === "ledger");
  empty = false;
  await assert.rejects(http.postJson("/draft", { docId: id }), (e) => e.code === "E2E_GUARD" && e.rule === "absent-probe");
  assert.equal(fetched, 1, "a refused probe never reaches fetch");

  await assert.rejects(runCli(t, ["update", id, "f.html"], { guard: g }), (e) => e.code === "E2E_GUARD" && /did not create/.test(e.message));

  const routes = [];
  await installGuard({ route: async (pattern, handler) => routes.push({ pattern, handler }) }, t, { guard: g });
  const url = "https://firestore.googleapis.com/google.firestore.v1.Firestore/Write/channel?x=1";
  let outcome = null;
  await routes.find((r) => r.pattern.test(url)).handler({
    request: () => ({ method: () => "POST", url: () => url, postDataBuffer: () => Buffer.from(`req0___data__=${encodeURIComponent(JSON.stringify({ name: `documents/docs/${id}/versions/v1` }))}`) }),
    abort: async () => (outcome = "abort"),
    fallback: async () => (outcome = "fallback"),
  });
  assert.equal(outcome, "abort");
});
