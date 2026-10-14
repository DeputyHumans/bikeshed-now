// SPDX-License-Identifier: Apache-2.0
// Self-test: ledgerDoc records a document the browser made as the run's, so the production guard lets later acts name it (SPEC §12, §21).

/**
 * A fork made by the app's Fork button, or an upload made on its upload
 * page, never passes through seed.mjs: the browser sends the POST and the
 * product picks the id. Unledgered, every later act on it is refused on
 * production (rule "ledger") and quarantine never walks it. These run against
 * a production-shaped target with the real guard reading the run's own
 * ledger file, and a fake fetch standing in for the server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttp } from "../lib/http.mjs";
import { appendLedger, ledgerDocIds, readLedger } from "../lib/ledger.mjs";
import { docIdFor, fork, ledgerDoc } from "../lib/seed.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const prod = () => Object.freeze({ kind: "prod", runId: "2610110600-ldoc", origin: "https://seed-selftest.invalid", runDir: tempDir("e2e-ledger-doc-") });
const OWNER = "forker-0ldoc-abcd@example.com";
const BROWSER_FORK = "a15-source-title-k3x9qz";

function server() {
  const sent = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    sent.push({ path: u.pathname, method: init.method, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    const json = u.pathname === "/fork" ? { docId: "e2e-helper-fork", versionId: "v1" } : {};
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, fetch };
}

function run() {
  const t = prod();
  const source = docIdFor(t, "source");
  appendLedger(t, { kind: "doc", docId: source, via: "upload" });
  return { t, source };
}

const rowsOf = (t) => readLedger(t).filter((r) => r.kind === "doc").map(({ t: _t, runId: _r, ...row }) => row);

test("ledgerDoc: the row fork() appends, for a fork the browser made; the guard then lets a write name it", async () => {
  const { t, source } = run();
  const s = server();
  const http = createHttp(t, { actor: "reader", evidence: false, fetch: s.fetch });

  // Before: the browser's fork is not the run's, and the guard refuses to touch it.
  await assert.rejects(http.postJson("/draft", { docId: BROWSER_FORK, html: "<p>x</p>" }), (e) => e.code === "E2E_GUARD" && e.rule === "ledger");
  assert.equal(s.sent.length, 0, "refused before it was sent");

  const row = ledgerDoc(t, { docId: BROWSER_FORK, ownerEmail: OWNER, actor: "reader", via: "fork-ui", forkOf: source });
  assert.deepEqual(row, { kind: "doc", docId: BROWSER_FORK, ownerEmail: OWNER, actor: "reader", via: "fork-ui", versionId: null, forkOf: source });
  assert.deepEqual(rowsOf(t).at(-1), row, "the row as written");
  assert.ok(ledgerDocIds(t).has(BROWSER_FORK), "quarantine walks it");
  assert.equal(readLedger(t).at(-1).runId, t.runId);

  assert.equal((await http.postJson("/draft", { docId: BROWSER_FORK, html: "<p>x</p>" })).status, 200, "after: the guard lets the write go");
  assert.deepEqual(s.sent.at(-1), { path: "/draft", method: "POST", body: { docId: BROWSER_FORK, html: "<p>x</p>" } });

  // The same shape fork() writes, field for field (only the values differ).
  await fork(http, { docId: source, ownerEmail: OWNER });
  const viaHelper = rowsOf(t).at(-1);
  assert.deepEqual(Object.keys(row), Object.keys(viaHelper), "ledgerDoc's row has fork()'s fields in fork()'s order");

  // The minimum: docId and via; everything else null, no forkOf.
  const upload = ledgerDoc(t, { docId: "notes-from-the-upload-page", via: "upload-ui" });
  assert.deepEqual(upload, { kind: "doc", docId: "notes-from-the-upload-page", ownerEmail: null, actor: null, via: "upload-ui", versionId: null });
  const again = ledgerDoc(t, { docId: "notes-from-the-upload-page", via: "upload-ui", versionId: "v2" });
  assert.equal(again.versionId, "v2");
  assert.equal(rowsOf(t).filter((r) => r.docId === "notes-from-the-upload-page").length, 2, "appending twice is two rows of one document");
});

test("NEGATIVE: ledgerDoc refuses what is not a product document id, an unknown field, a missing via, and writes nothing", () => {
  const { t } = run();
  const before = readLedger(t).length;
  const bad = [
    [{ docId: "/d/abc", via: "fork-ui" }, /docId is a document id as the product makes them/],
    [{ docId: "Abc", via: "fork-ui" }, /docId is a document id/],
    [{ docId: "a--b", via: "fork-ui" }, /docId is a document id/],
    [{ docId: "-a", via: "fork-ui" }, /docId is a document id/],
    [{ docId: "a".repeat(61), via: "fork-ui" }, /at most 60/],
    [{ docId: undefined, via: "fork-ui" }, /got undefined/],
    [{ docId: "abc" }, /via says how the document was made/],
    [{ docId: "abc", via: " " }, /via says how/],
    [{ docId: "abc", via: "fork-ui", owner: OWNER }, /unknown field "owner" \(known: docId, ownerEmail, via, actor, versionId, forkOf\)/],
    [{ docId: "abc", via: "fork-ui", kind: "folder" }, /unknown field "kind"/],
    [{ docId: "abc", via: "fork-ui", ownerEmail: 3 }, /ownerEmail is a non-empty string or null/],
    [{ docId: "abc", via: "fork-ui", forkOf: "/d/src" }, /forkOf is the source's document id/],
    [{ docId: "abc", via: "fork-ui", password: "pw" }, /unknown field "password"/],
  ];
  for (const [o, re] of bad) assert.throws(() => ledgerDoc(t, o), re, JSON.stringify(o));
  assert.throws(() => ledgerDoc(t), /docId is a document id/);
  assert.throws(() => ledgerDoc(t, null), /give \{docId, via/);
  assert.throws(() => ledgerDoc({ runId: "x" }, { docId: "abc", via: "fork-ui" }), /target is a Target with a runDir/);
  assert.equal(ledgerDoc(t, { docId: "a".repeat(60), via: "fork-ui" }).docId.length, 60, "60 is the product's limit, and allowed");
  assert.equal(readLedger(t).length, before + 1, "only the valid one was written");
  // A credential-shaped value is still appendLedger's to refuse.
  assert.throws(() => ledgerDoc(t, { docId: "abc", via: "fork-ui", actor: "eyJhbGciOiJSUzI1NiJ9.e30.sig" }), /credential-shaped/);
});
