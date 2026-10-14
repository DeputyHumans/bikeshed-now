// SPDX-License-Identifier: Apache-2.0
// Self-test: a BrowserPool ledgers every document and folder its users' pages create, and only those (SPEC §12, §13, §21).

/**
 * Hermetic: a local server stands in for the stack's POST /publish, /folder
 * and /fork, answering as the product does. The page sends each request
 * itself (an upload through XMLHttpRequest, as app/src/upload.ts does; the
 * rest through fetch), so what is ledgered comes from the browser's own
 * traffic. The run's ledger file is read back, row by row. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool, pageCreation } from "../lib/browser.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>stand-in</title><link rel="icon" href="data:,"></head><body><p>stand-in</p>
<script>
  window.__results = {};
  window.__send = (label, path, { body = null, xhr = false } = {}) => {
    if (xhr) {
      const x = new XMLHttpRequest();
      x.open("POST", path);
      x.setRequestHeader("Content-Type", "application/octet-stream");
      x.onload = () => (window.__results[label] = { status: x.status, text: x.responseText });
      x.send(new Blob(["<!doctype html><title>Uploaded</title>"]));
      return;
    }
    fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => (window.__results[label] = { status: r.status, text: await r.text() }));
  };
</script></body></html>`;

const FOLDER_A = "Fa1bC2dE3fG4hI5jK6lM";
const FOLDER_B = "Fb9yX8wV7uT6sR5qP4oN";
const OWNER = "owner-0ui-abcd@example.com";
let n = 0;

function answer(path, query, body) {
  if (path === "/publish") {
    if (query.get("fail")) return [400, { error: "upload a self-contained .html, a .md file, or a .zip bundle" }];
    if (query.get("update")) return [200, { docId: query.get("update"), versionId: "v2" }];
    return [200, { docId: `e2e-ui-upload-${++n}`, versionId: "v1", title: "Uploaded" }];
  }
  if (path === "/folder") {
    if (body?.name === "answers without an id") return [200, { name: body.name }];
    return [200, { folderId: body?.parentId ? FOLDER_B : FOLDER_A, name: String(body?.name ?? "").trim() }];
  }
  if (path === "/fork") return body?.op === "create" ? [200, { docId: `e2e-ui-fork-${++n}`, versionId: "v1" }] : [200, { lineage: [] }];
  return [404, { error: "no such path" }];
}

let server;
let target;
let bare;
let pool;
let barePool;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "GET") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end(PAGE);
      }
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {}
      const [status, json] = answer(url.pathname, url.searchParams, body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  target = { kind: "local", runId: "2610111000-uiled", runDir: tempDir("e2e-ui-ledger-"), origin, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
  bare = { kind: "local", runId: "2610111000-uibare", origin, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
  pool = new BrowserPool({ target });
  barePool = new BrowserPool({ target: bare });
});

after(async () => {
  await pool?.close();
  await barePool?.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

/** Have the page send each request, wait for every answer to reach it, then for the pool to ledger it. */
async function send(u, list) {
  for (const [label, path, o] of list) await u.page.evaluate(([l, p, opts]) => window.__send(l, p, opts), [label, path, o ?? {}]);
  await u.page.waitForFunction((k) => k.every((l) => window.__results[l]), list.map(([l]) => l));
  return u.settleCreated();
}

const rows = (t) => readLedger(t).map(({ t: _t, runId: _r, ...row }) => row);

test("pageCreation: only a creating POST on the target's own origin", () => {
  const o = "http://127.0.0.1:39123";
  assert.deepEqual(pageCreation("POST", `${o}/publish?filename=a.html&folderId=x`, null, o), { kind: "doc", via: "upload-ui" });
  assert.equal(pageCreation("POST", `${o}/publish?filename=a.html&update=e2e-x`, null, o), null, "a new version is not a creation");
  assert.deepEqual(pageCreation("POST", `${o}/folder`, { name: "n", parentId: FOLDER_A }, o), { kind: "folder", via: "folder-ui", parentId: FOLDER_A });
  assert.deepEqual(pageCreation("POST", `${o}/folder`, { name: "n", parentId: null }, o), { kind: "folder", via: "folder-ui", parentId: null });
  assert.deepEqual(pageCreation("post", `${o}/fork`, { op: "create", docId: "src" }, o), { kind: "doc", via: "fork-ui", forkOf: "src" });
  assert.equal(pageCreation("POST", `${o}/fork`, { op: "lineage", docId: "src" }, o), null);
  assert.equal(pageCreation("GET", `${o}/publish`, null, o), null);
  assert.equal(pageCreation("POST", `${o}/folder-access`, { folderId: FOLDER_A }, o), null);
  assert.equal(pageCreation("POST", "http://127.0.0.1:39124/folder", { name: "n" }, o), null, "another port is not the target");
  assert.equal(pageCreation("POST", "not a url", null, o), null);
});

test("an upload, two folders and a fork the page made are each ledgered as ledgerDoc and ledgerFolder write them", async () => {
  const u = await pool.user({ name: "owner" });
  u.email = OWNER; // what signInUi records
  await u.goto("/");
  const created = await send(u, [
    ["upload", "/publish?filename=index.html", { xhr: true }],
    ["root folder", "/folder", { body: { name: " Plans ", parentId: null } }],
    ["inner folder", "/folder", { body: { name: "Q3", parentId: FOLDER_A } }],
    ["fork", "/fork", { body: { op: "create", docId: "e2e-ui-source" } }],
  ]);
  assert.deepEqual(
    rows(target).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [
      { kind: "doc", docId: "e2e-ui-upload-1", ownerEmail: OWNER, actor: "owner", via: "upload-ui", versionId: "v1" },
      { kind: "doc", docId: "e2e-ui-fork-2", ownerEmail: OWNER, actor: "owner", via: "fork-ui", versionId: "v1", forkOf: "e2e-ui-source" },
      { kind: "folder", folderId: FOLDER_A, ownerEmail: OWNER, actor: "owner", parentId: null, name: "Plans", via: "folder-ui" },
      { kind: "folder", folderId: FOLDER_B, ownerEmail: OWNER, actor: "owner", parentId: FOLDER_A, name: "Q3", via: "folder-ui" },
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
  assert.equal(created.length, 4);
  assert.ok(created.every((r) => r.ledgered === true && r.error === null), JSON.stringify(created));
  assert.deepEqual(created.map((r) => [r.kind, r.via, r.id]).sort(), [["doc", "fork-ui", "e2e-ui-fork-2"], ["doc", "upload-ui", "e2e-ui-upload-1"], ["folder", "folder-ui", FOLDER_A], ["folder", "folder-ui", FOLDER_B]]);
  assert.deepEqual(pool.created().map((r) => r.user), ["owner", "owner", "owner", "owner"]);
});

test("NEGATIVE: a new version, a refused upload, a lineage read and an answer with no id ledger nothing", async () => {
  const before = rows(target).length;
  const u = await pool.user({ name: "other" });
  await u.goto("/");
  const created = await send(u, [
    ["update", "/publish?filename=index.html&update=e2e-ui-upload-1", { xhr: true }],
    ["refused", "/publish?filename=x.exe&fail=1", { xhr: true }],
    ["lineage", "/fork", { body: { op: "lineage", docId: "e2e-ui-source" } }],
    ["no id", "/folder", { body: { name: "answers without an id" } }],
  ]);
  assert.equal(rows(target).length, before, "the ledger did not grow");
  assert.deepEqual(created.map((r) => [r.kind, r.ledgered, r.error]), [["folder", false, "the answer named no folderId"]], "only the folder was a creation, and its answer named nothing");
});

test("a target with no run directory: the row says why nothing was ledgered, and nothing throws", async () => {
  const u = await barePool.user({ name: "bare" });
  await u.goto("/");
  const created = await send(u, [["folder", "/folder", { body: { name: "Somewhere" } }]]);
  assert.equal(created.length, 1);
  assert.deepEqual([created[0].ledgered, created[0].id], [false, FOLDER_A]);
  assert.match(created[0].error, /ledgerFolder: target is a Target with a runDir/);
});
