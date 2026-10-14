// SPDX-License-Identifier: Apache-2.0
// Self-test: forkMcp sends fork_document and ledgers the fork it made as fork() does, so the production guard lets later tools name it (SPEC §12, §19, §21).

/**
 * The real mcpClient over http.mjs, a fake fetch standing in for POST /mcp
 * (JSON-RPC in, a tool result out). On a production-shaped target the real
 * guard reads the run's own ledger: an act tool on the fork is refused until
 * the fork is ledgered, and forkMcp is what ledgers it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttp } from "../lib/http.mjs";
import { mcpClient } from "../lib/mcp.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { forkMcp, ledgerDoc } from "../lib/seed.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const OWNER = "owner-0fork-abcd@example.com";
const SOURCE = "e2e-fork0a-a20-source-ab12";
const local = () => Object.freeze({ kind: "local", runId: "2610120510-fork", runDir: tempDir("e2e-forkmcp-"), origin: "http://127.0.0.1:39061", stack: { ports: { hosting: 39061 } } });
const prod = () => Object.freeze({ kind: "prod", runId: "2610120510-fork", origin: "https://fork-selftest.invalid", runDir: tempDir("e2e-forkmcp-prod-") });

/** POST /mcp: fork_document answers `answer(args, n)` (a fork by default), any other tool {ok: true}; every call is recorded. */
function server(answer = (args, n) => ({ docId: `a20-fork-${n}`, versionId: "v1", title: args.title ?? "Source" })) {
  const calls = [];
  const fetch = async (url, init) => {
    const msg = JSON.parse(init.body);
    calls.push({ path: new URL(url).pathname, name: msg.params?.name, args: msg.params?.arguments });
    const out = msg.params?.name === "fork_document" ? answer(msg.params?.arguments ?? {}, calls.length) : { ok: true };
    const result = out instanceof Error ? { content: [{ type: "text", text: out.message }], isError: true } : { content: [{ type: "text", text: JSON.stringify(out) }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

const client = (t, s, actor = "owner-mcp") => mcpClient(t, { http: createHttp(t, { actor, evidence: false, fetch: s.fetch }) });
const docRows = (t) => readLedger(t).filter((r) => r.kind === "doc").map(({ t: _t, runId: _r, ...row }) => row);

test("forkMcp: fork_document with only the arguments given, the fork ledgered as fork() ledgers one (via mcp-fork, forkOf the source)", async () => {
  const t = local();
  const s = server();
  const out = await forkMcp(client(t, s), { id: SOURCE, ownerEmail: OWNER });
  assert.deepEqual([out.isError, out.docId, out.versionId], [false, "a20-fork-1", "v1"]);
  assert.deepEqual(out.json, { docId: "a20-fork-1", versionId: "v1", title: "Source" });
  assert.deepEqual(s.calls, [{ path: "/mcp", name: "fork_document", args: { id: SOURCE } }], "nothing the case did not give");
  assert.deepEqual(docRows(t), [{ kind: "doc", docId: "a20-fork-1", ownerEmail: OWNER, actor: "owner-mcp", via: "mcp-fork", versionId: "v1", forkOf: SOURCE }]);
});

test("forkMcp: version, title, folder (an id or a createFolder result) and the key are sent as given; forkOf is the source as the product reads it, and never the key", async () => {
  const t = local();
  const s = server();
  const mcp = client(t, s, "editor-mcp");
  await forkMcp(mcp, { id: SOURCE, version: "v2", title: "A20 fork", folder: { folderId: "fOLDer1" }, k: "abcdefgh12345678" });
  await forkMcp(mcp, { id: ` ${SOURCE} `, folder: "fOLDer2" });
  assert.deepEqual(s.calls.map((c) => c.args), [
    { id: SOURCE, version: "v2", folder: "fOLDer1", title: "A20 fork", k: "abcdefgh12345678" },
    { id: ` ${SOURCE} `, folder: "fOLDer2" },
  ]);
  assert.deepEqual(docRows(t).map((r) => [r.docId, r.forkOf, r.ownerEmail, r.actor]), [["a20-fork-1", SOURCE, null, "editor-mcp"], ["a20-fork-2", SOURCE, null, "editor-mcp"]], "the product trims the id it forks");
  assert.doesNotMatch(JSON.stringify(readLedger(t)), /abcdefgh12345678/, "the link key is never ledgered");
});

test("NEGATIVE: a tool error creates nothing, ledgers nothing and does not throw; a wrong argument throws before anything is sent", async () => {
  const t = local();
  const s = server(() => new Error(`no document with id "${SOURCE}"`));
  const refused = await forkMcp(client(t, s), { id: SOURCE, ownerEmail: OWNER });
  assert.deepEqual([refused.isError, refused.docId, refused.versionId, refused.text], [true, undefined, undefined, `no document with id "${SOURCE}"`]);
  assert.deepEqual(docRows(t), []);

  const quiet = server();
  const mcp = client(t, quiet);
  await assert.rejects(forkMcp(mcp, { docId: SOURCE }), /unknown field "docId" \(known: id, version, title, folder, k, ownerEmail; docId is id\)/);
  await assert.rejects(forkMcp(mcp, { id: SOURCE, versionId: "v1", folderId: "f" }), /versionId is version, folderId is folder/);
  await assert.rejects(forkMcp(mcp, {}), /id is the document to fork, got undefined/);
  await assert.rejects(forkMcp(mcp, { id: "  " }), /id is the document to fork/);
  await assert.rejects(forkMcp(mcp, { id: SOURCE, folder: { id: "fOLDer1" } }), /folder is a folder id or a createFolder\/createFolderMcp result/);
  await assert.rejects(forkMcp({ call() {} }, { id: SOURCE }), /mcp is an mcpClient/);
  assert.deepEqual([quiet.calls, docRows(t)], [[], []]);
});

test("on production the guard refuses a fork of a document the run did not make, and lets an act on a fork through only once forkMcp has ledgered it", async () => {
  const t = prod();
  const s = server();
  const mcp = client(t, s);
  await assert.rejects(forkMcp(mcp, { id: "someone-elses-doc" }), (e) => e.code === "E2E_GUARD" && e.rule === "ledger");
  assert.deepEqual(s.calls, [], "refused before it was sent");
  ledgerDoc(t, { docId: SOURCE, via: "mcp", ownerEmail: OWNER });
  await assert.rejects(mcp.call("rename_document", { id: "a20-fork-1", title: "x" }), (e) => e.code === "E2E_GUARD", "an unledgered fork is refused");
  const fork = await forkMcp(mcp, { id: SOURCE, ownerEmail: OWNER });
  assert.equal(fork.docId, "a20-fork-1");
  const renamed = await mcp.call("rename_document", { id: fork.docId, title: "A20 renamed" });
  assert.equal(renamed.isError, false, "the ledger row is what lets the act through");
  assert.deepEqual(s.calls.map((c) => [c.name, c.args.id]), [["fork_document", SOURCE], ["rename_document", "a20-fork-1"]]);
});
