// SPDX-License-Identifier: Apache-2.0
// Self-test: ledgerFolder records a folder the browser made as the run's, so the production guard lets later writes name it (SPEC §12, §13).

/**
 * A folder made with the workspace's Folder button never passes through
 * seed.mjs: the browser sends POST /folder and the product picks the id.
 * Unledgered, every later write that names it (a folder made inside it, an
 * upload into it, a rename) is refused on production (rule "ledger-folder").
 * These run against a production-shaped target with the real guard reading
 * the run's own ledger file, and a fake fetch standing in for the server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttp } from "../lib/http.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { createFolder, ledgerFolder } from "../lib/seed.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const prod = () => Object.freeze({ kind: "prod", runId: "2610111000-lfold", origin: "https://seed-selftest.invalid", runDir: tempDir("e2e-ledger-folder-") });
const OWNER = "owner-0lfold-abcd@example.com";
/** Firestore auto ids, as the product mints them: 20 letters and digits. */
const BROWSER_FOLDER = "Ab3dEf6hIj9lMn2pQr5t";
const INNER = "Zy8xWv7uTs6rQp5oNm4l";

function server() {
  const sent = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    sent.push({ path: u.pathname, method: init.method, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    const json = u.pathname === "/folder" ? { folderId: INNER, name: "Inner" } : { ok: true };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, fetch };
}

const rowsOf = (t) => readLedger(t).filter((r) => r.kind === "folder").map(({ t: _t, runId: _r, ...row }) => row);

test("ledgerFolder: createFolder's row plus via, for a folder the browser made; the guard then lets writes name it", async () => {
  const t = prod();
  const s = server();
  const http = createHttp(t, { actor: "owner", evidence: false, fetch: s.fetch });

  // Before: the browser's folder is not the run's, and the guard refuses to write into it.
  await assert.rejects(createFolder(http, { name: "Inner", parentId: BROWSER_FOLDER }), (e) => e.code === "E2E_GUARD" && e.rule === "ledger-folder");
  await assert.rejects(http.postJson("/organize", { kind: "folder", id: BROWSER_FOLDER, op: "rename", name: "Renamed" }), (e) => e.code === "E2E_GUARD" && e.rule === "ledger-folder");
  assert.equal(s.sent.length, 0, "refused before anything was sent");

  const row = ledgerFolder(t, { folderId: BROWSER_FOLDER, via: "folder-ui", ownerEmail: OWNER, actor: "owner", name: "Made in the browser" });
  assert.deepEqual(row, { kind: "folder", folderId: BROWSER_FOLDER, ownerEmail: OWNER, actor: "owner", parentId: null, name: "Made in the browser", via: "folder-ui" });
  assert.deepEqual(rowsOf(t).at(-1), row, "the row as written");
  assert.equal(readLedger(t).at(-1).runId, t.runId);

  // After: both go.
  const inner = await createFolder(http, { name: "Inner", parentId: BROWSER_FOLDER, ownerEmail: OWNER });
  assert.equal(inner.folderId, INNER);
  assert.equal((await http.postJson("/organize", { kind: "folder", id: BROWSER_FOLDER, op: "rename", name: "Renamed" })).status, 200);
  assert.deepEqual(s.sent.map((r) => [r.path, r.body.parentId ?? r.body.id]), [["/folder", BROWSER_FOLDER], ["/organize", BROWSER_FOLDER]]);

  // createFolder's fields, in createFolder's order, then via.
  const viaHelper = rowsOf(t).at(-1);
  assert.deepEqual(Object.keys(row), [...Object.keys(viaHelper), "via"]);

  // The minimum: folderId and via. A child names its parent; twice is two rows.
  const child = ledgerFolder(t, { folderId: "Q".repeat(20), via: "folder-ui", parentId: BROWSER_FOLDER });
  assert.deepEqual(child, { kind: "folder", folderId: "Q".repeat(20), ownerEmail: null, actor: null, parentId: BROWSER_FOLDER, name: null, via: "folder-ui" });
  ledgerFolder(t, { folderId: "Q".repeat(20), via: "folder-ui" });
  assert.equal(rowsOf(t).filter((r) => r.folderId === "Q".repeat(20)).length, 2);
});

test("NEGATIVE: ledgerFolder refuses what is not a product folder id, an unknown field, a missing via, and writes nothing", () => {
  const t = prod();
  const bad = [
    [{ folderId: "/folder/Ab3dEf6hIj9lMn2pQr5t", via: "folder-ui" }, /folderId is a folder id as the product makes them/],
    [{ folderId: "Ab3dEf6hIj9lMn2pQr5", via: "folder-ui" }, /folderId is a folder id/],
    [{ folderId: "Ab3dEf6hIj9lMn2pQr5t-", via: "folder-ui" }, /folderId is a folder id/],
    [{ folderId: { folderId: BROWSER_FOLDER }, via: "folder-ui" }, /folderId is a folder id/],
    [{ folderId: undefined, via: "folder-ui" }, /folderId is a folder id/],
    [{ folderId: BROWSER_FOLDER }, /via says how the folder was made/],
    [{ folderId: BROWSER_FOLDER, via: " " }, /via says how/],
    [{ folderId: BROWSER_FOLDER, via: "folder-ui", owner: OWNER }, /unknown field "owner"/],
    [{ folderId: BROWSER_FOLDER, via: "folder-ui", parentId: "root" }, /parentId is the parent folder's id/],
    [{ folderId: BROWSER_FOLDER, via: "folder-ui", name: "" }, /name is a non-empty string or null/],
    [{ folderId: BROWSER_FOLDER, via: "folder-ui", ownerEmail: 7 }, /ownerEmail is a non-empty string or null/],
  ];
  for (const [o, re] of bad) assert.throws(() => ledgerFolder(t, o), re, JSON.stringify(o));
  assert.throws(() => ledgerFolder({ kind: "prod" }, { folderId: BROWSER_FOLDER, via: "folder-ui" }), /target is a Target with a runDir/);
  assert.throws(() => ledgerFolder(t, null), /give \{folderId, via/);
  assert.deepEqual(readLedger(t), [], "nothing was written");
});
