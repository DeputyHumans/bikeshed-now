// SPDX-License-Identifier: Apache-2.0
// Self-test: createFolderMcp sends create_folder and ledgers the folder it made as createFolder does, so the production guard lets later tools name it (SPEC §12, §13, §19).

/**
 * The real mcpClient over http.mjs, a fake fetch standing in for POST /mcp
 * (JSON-RPC in, a tool result out). On a production-shaped target the real
 * guard reads the run's own ledger: a create_folder into a folder the run did
 * not make is refused before it is sent, and one into a folder createFolderMcp
 * made goes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttp } from "../lib/http.mjs";
import { mcpClient } from "../lib/mcp.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { runTag } from "../lib/accounts.mjs";
import { createFolderMcp } from "../lib/seed.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const OWNER = "owner-0fmcp-abcd@example.com";
const local = () => Object.freeze({ kind: "local", runId: "2610110850-fmcp", runDir: tempDir("e2e-fmcp-"), origin: "http://127.0.0.1:39041", stack: { ports: { hosting: 39041 } } });
const prod = () => Object.freeze({ kind: "prod", runId: "2610110850-fmcp", origin: "https://fmcp-selftest.invalid", runDir: tempDir("e2e-fmcp-prod-") });

/** POST /mcp: create_folder answers `answer(args)` (a folder by default), as a tool result; every call is recorded. */
function server(answer = (args, n) => ({ folderId: `fOLDer${n}`, name: String(args.name).trim() })) {
  const calls = [];
  const fetch = async (url, init) => {
    const msg = JSON.parse(init.body);
    calls.push({ path: new URL(url).pathname, method: msg.method, name: msg.params?.name, args: msg.params?.arguments });
    const out = answer(msg.params?.arguments ?? {}, calls.length);
    const result = out instanceof Error ? { content: [{ type: "text", text: out.message }], isError: true } : { content: [{ type: "text", text: JSON.stringify(out) }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

const client = (t, s, actor = "owner-mcp") => mcpClient(t, { http: createHttp(t, { actor, evidence: false, fetch: s.fetch }) });
const folderRows = (t) => readLedger(t).filter((r) => r.kind === "folder").map(({ t: _t, runId: _r, ...row }) => row);

test("createFolderMcp: create_folder {name}, the folder ledgered as createFolder ledgers one", async () => {
  const t = local();
  const s = server();
  const out = await createFolderMcp(client(t, s), { name: "A21.3 folder", ownerEmail: OWNER });
  assert.deepEqual([out.isError, out.folderId, out.name, out.parentId], [false, "fOLDer1", "A21.3 folder", null]);
  assert.deepEqual(out.json, { folderId: "fOLDer1", name: "A21.3 folder" });
  assert.deepEqual(s.calls, [{ path: "/mcp", method: "tools/call", name: "create_folder", args: { name: "A21.3 folder" } }], "no parent at the root");
  assert.deepEqual(folderRows(t), [{ kind: "folder", folderId: "fOLDer1", ownerEmail: OWNER, actor: "owner-mcp", parentId: null, name: "A21.3 folder" }]);
});

test("createFolderMcp: inside a parent (an id or a result), a default name with the run tag, the name the tool answered", async () => {
  const t = local();
  const s = server();
  const mcp = client(t, s);
  const outer = await createFolderMcp(mcp, { name: "outer", ownerEmail: OWNER });
  const inner = await createFolderMcp(mcp, { name: "  inner  ", parent: outer, ownerEmail: OWNER });
  await createFolderMcp(mcp, { name: "by id", parent: "fOLDer1" });
  await createFolderMcp(mcp, { name: "root again", parent: null });
  assert.deepEqual(s.calls.map((c) => c.args), [{ name: "outer" }, { name: "  inner  ", parent: "fOLDer1" }, { name: "by id", parent: "fOLDer1" }, { name: "root again" }]);
  assert.deepEqual([inner.parentId, inner.name], ["fOLDer1", "inner"], "the product's trimmed name");
  assert.deepEqual(folderRows(t).map((r) => [r.folderId, r.parentId, r.name, r.ownerEmail]), [["fOLDer1", null, "outer", OWNER], ["fOLDer2", "fOLDer1", "inner", OWNER], ["fOLDer3", "fOLDer1", "by id", null], ["fOLDer4", null, "root again", null]]);

  const unnamed = await createFolderMcp(mcp);
  assert.match(s.calls.at(-1).args.name, new RegExp(`^e2e ${runTag(t.runId)} folder [a-z0-9]{4}$`));
  assert.equal(unnamed.folderId, "fOLDer5");
});

test("NEGATIVE: a tool error creates nothing and ledgers nothing, and does not throw; a wrong argument throws before anything is sent", async () => {
  const t = local();
  const s = server((args) => (args.parent === "theirs" ? new Error("you cannot create a folder there") : { folderId: "fOLDer9", name: args.name }));
  const refused = await createFolderMcp(client(t, s), { name: "Into theirs", parent: "theirs", ownerEmail: OWNER });
  assert.deepEqual([refused.isError, refused.folderId, refused.text], [true, undefined, "you cannot create a folder there"]);
  assert.deepEqual(folderRows(t), []);

  const quiet = server();
  const mcp = client(t, quiet);
  await assert.rejects(createFolderMcp(mcp, { name: "x", parentId: "fOLDer1" }), /unknown field "parentId" \(known: name, parent, ownerEmail\)/);
  await assert.rejects(createFolderMcp(mcp, { name: "x", parent: { id: "fOLDer1" } }), /parent is a folder id or a createFolder\/createFolderMcp result/);
  await assert.rejects(createFolderMcp(mcp, { name: "x", parent: "" }), /parent is a folder id/);
  await assert.rejects(createFolderMcp({ call() {} }, { name: "x" }), /mcp is an mcpClient/);
  assert.deepEqual([quiet.calls, folderRows(t)], [[], []]);
});

test("on production the guard refuses create_folder into a folder the run did not make, and lets one into a folder createFolderMcp made", async () => {
  const t = prod();
  const s = server();
  const mcp = client(t, s);
  await assert.rejects(createFolderMcp(mcp, { name: "into a stranger's", parent: "fOLDerStranger" }), (e) => e.code === "E2E_GUARD" && e.rule === "ledger-folder");
  assert.deepEqual(s.calls, [], "refused before it was sent");
  const top = await createFolderMcp(mcp, { name: "top", ownerEmail: OWNER });
  const sub = await createFolderMcp(mcp, { name: "sub", parent: top, ownerEmail: OWNER });
  assert.deepEqual([top.folderId, sub.folderId, sub.parentId], ["fOLDer1", "fOLDer2", "fOLDer1"], "the ledger row is what lets the second one through");
});
