// SPDX-License-Identifier: Apache-2.0
// MCP wire contracts through its HTTP wrapper: schema, CORS, errors, notifications and ordered batches (SPEC §19, §23).
const test = require("node:test");
const assert = require("node:assert/strict");
process.env.GCLOUD_PROJECT = "demo-bikeshed";
process.env.BIKESHED_PUBLIC_ORIGIN = "https://bikeshed.example";
delete process.env.FUNCTIONS_EMULATOR;
const { mcp } = require("../lib/index.js");
const { fakeFirestore, fakeToken, withFakeAdmin, invoke } = require("./fakes.js");
const { version } = require("../package.json");
function world() {
  const token = fakeToken({ uid: "mcp-reader", email: "reader@example.com", channel: "mcp" });
  const { db } = fakeFirestore({ [token.path]: token.record });
  const env = { db, users: { "mcp-reader": { uid: "mcp-reader", email: "reader@example.com", emailVerified: true, disabled: false, tokensValidAfterTime: new Date(0).toUTCString() } } };
  return { call: (body, extra = {}) => withFakeAdmin(env, () => invoke(mcp, { path: "/mcp", body, headers: { authorization: `Bearer ${token.bearer}`, ...extra.headers }, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "headers")) })) };
}
const request = (method, params = {}) => ({ jsonrpc: "2.0", id: 1, method, params });

const REQUIRED = {
  get_document_access: ["id"], set_document_access: ["id"],
  get_folder_access: ["id"], set_folder_access: ["id"],
  set_document_visibility: ["id"], rename_folder: ["id", "name"],
  move_folder: ["id"], delete_folder: ["id"], list_versions: ["id"],
  "list_documents": [],
  "get_document": [
    "id"
  ],
  "publish_document": [
    "title",
    "content"
  ],
  "fork_document": [
    "id"
  ],
  "get_lineage": [
    "id"
  ],
  "update_document": [
    "id",
    "content"
  ],
  "commit_draft": [
    "id"
  ],
  "suggest_edit": [
    "id",
    "exact"
  ],
  "revise_suggestion": [
    "id",
    "threadId"
  ],
  "withdraw_suggestion": [
    "id",
    "threadId"
  ],
  "accept_suggestion": [
    "id",
    "threadId"
  ],
  "reject_suggestion": [
    "id",
    "threadId"
  ],
  "list_folders": [],
  "get_folder": [
    "id"
  ],
  "create_folder": [
    "name"
  ],
  "move_document": [
    "id"
  ],
  "rename_document": [
    "id",
    "title"
  ],
  "get_comments": [
    "id"
  ],
  "get_changes": [
    "id",
    "since"
  ],
  "add_comment": [
    "id",
    "exact",
    "body"
  ],
  "reply_to_comment": [
    "id",
    "threadId",
    "body"
  ],
  "resolve_thread": [
    "id",
    "threadId"
  ],
  "reopen_thread": [
    "id",
    "threadId"
  ]
};
test("MCP initialize and schemas pin protocol, required arguments and all thirteen optional keys", async () => {
  const w = world();
  const init = await w.call(request("initialize"));
  assert.deepEqual({ protocol: init.body.result.protocolVersion, server: init.body.result.serverInfo, capabilities: init.body.result.capabilities }, { protocol: "2025-06-18", server: { name: "bikeshed", version }, capabilities: { tools: { listChanged: false } } });
  const tools = (await w.call(request("tools/list"))).body.result.tools;
  assert.deepEqual(Object.fromEntries(tools.map((t) => [t.name, t.inputSchema.required ?? []])), REQUIRED, "required argument declarations match the public contract");
  for (const name of ["get_document", "update_document", "suggest_edit", "get_comments", "get_changes", "add_comment", "reply_to_comment", "resolve_thread", "reopen_thread", "fork_document", "get_lineage", "revise_suggestion", "withdraw_suggestion"]) {
    const schema = tools.find((t) => t.name === name).inputSchema;
    assert.equal(schema.properties.k?.type, "string", `${name} advertises its key`);
    assert.ok(!schema.required.includes("k"), `${name} does not require the key`);
  }
});
test("MCP empty arguments remain explicit tool refusals", async () => {
  const r = await world().call(request("tools/call", { name: "get_document", arguments: { id: "" } }));
  assert.equal(r.status, 200);
  assert.equal(r.body.result.isError, true);
  assert.equal(r.body.result.content[0].text, 'get_document: missing required argument "id". Call tools/list for this tool\'s schema.');
});
test("MCP unknown tool and method retain distinct exact errors", async () => {
  const w = world();
  const tool = await w.call(request("tools/call", { name: "absent_tool" }));
  assert.deepEqual(tool.body.error, { code: -32601, message: 'no tool named "absent_tool"' }, "unknown tool error");
  const method = await w.call(request("absent/method"));
  assert.deepEqual(method.body.error, { code: -32601, message: 'unknown method "absent/method"' }, "unknown method error");
});
test("MCP missing method and text parse refusal keep status and code", async () => {
  const w = world();
  const missing = await w.call({ jsonrpc: "2.0", id: 1 });
  assert.deepEqual({ status: missing.status, error: missing.body.error }, { status: 200, error: { code: -32600, message: "not a JSON-RPC request" } }, "missing method error");
  const parse = await w.call("{bad", { rawBody: Buffer.from("{bad"), headers: { "content-type": "text/plain" } });
  assert.deepEqual({ status: parse.status, body: parse.body }, { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } } }, "text parse error");
});
test("MCP notifications emit no body and mixed batches retain request order", async () => {
  const w = world();
  const notification = await w.call({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.deepEqual({ status: notification.status, body: notification.body }, { status: 202, body: undefined }, "notification has no response envelope");
  const batch = await w.call([{ ...request("ping"), id: 101 }, { jsonrpc: "2.0", method: "notifications/initialized" }, { ...request("absent/method"), id: 102 }, { ...request("tools/call", { name: "get_document", arguments: {} }), id: 103 }]);
  assert.deepEqual(batch.body.map((b) => b.id), [101, 102, 103], "mixed batch answers requests in order and omits the notification");
});
test("MCP browser preflight permits authenticated JSON POST before credential verification", async () => {
  const r = await invoke(mcp, { method: "OPTIONS", path: "/mcp", headers: { origin: "https://client.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
  assert.equal(r.status, 204, "preflight is accepted without a bearer credential");
  assert.equal(r.headers["access-control-allow-origin"], "https://client.example");
  assert.equal(r.headers["access-control-allow-headers"], "authorization,content-type");
  assert.ok(r.headers["access-control-allow-methods"].split(",").includes("POST"));
});
test("MCP PUT is refused with its POST-only Allow header", async () => {
  const r = await invoke(mcp, { method: "PUT", path: "/mcp" });
  assert.deepEqual({ status: r.status, allow: r.headers.allow, body: r.body }, { status: 405, allow: "POST", body: undefined });
});

test("MCP list pagination uses the last returned row as its continuation and ends at null", async () => {
  const { toolByName } = require("../lib/mcp/tools.js");
  const rows = ["newest", "middle", "oldest"].map((id) => ({ id, data: () => ({ title: id, currentVersion: null, members: ["reader@example.com"] }) }));
  let after = null, limit = 0;
  const q = { where: () => q, orderBy: () => q, limit: (n) => { limit = n; return q; }, startAfter: (doc) => { after = doc.id; return q; }, doc: (id) => ({ get: async () => ({ exists: true, id }) }), get: async () => ({ docs: rows.slice(after ? rows.findIndex((r) => r.id === after) + 1 : 0).slice(0, limit) }) };
  const ctx = { db: { collection: () => q }, caller: { emailLower: "reader@example.com" } };
  const first = await toolByName("list_documents").run(ctx, { limit: 2 });
  assert.deepEqual({ ids: first.documents.map((d) => d.id), cursor: first.nextCursor }, { ids: ["newest", "middle"], cursor: "middle" }, "first page carries the last included row");
  const second = await toolByName("list_documents").run(ctx, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual({ ids: second.documents.map((d) => d.id), cursor: second.nextCursor }, { ids: ["oldest"], cursor: null }, "the final page ends without overlap");
});

test("MCP publish reports the requested and allocated ids when storage chooses a suffix", async () => {
  const { toolByName } = require("../lib/mcp/tools.js");
  const publishing = require("../lib/lib/publish.js");
  const original = publishing.publishNewDocument;
  try {
    for (const actual of ["requested", "requested-abc123"]) {
      const { db } = fakeFirestore({ [`docs/${actual}`]: { title: "Title", currentVersion: "v1", ownerUid: "reader", ownerEmail: "reader@example.com", members: ["reader@example.com"], visibility: "private" } });
      publishing.publishNewDocument = async (input) => { assert.equal(input.docId, "requested"); return { docId: actual, versionId: "v1" }; };
      const result = await toolByName("publish_document").run({ db, caller: { uid: "reader", emailLower: "reader@example.com" }, actor: { tokenId: "test-token" } }, { id: "requested", title: "Title", content: "<p>Hello</p>", format: "html" });
      assert.deepEqual({ requested: result.requestedId, allocated: result.docId, taken: result.idTaken }, { requested: "requested", allocated: actual, taken: actual !== "requested" }, "idTaken describes the allocated id without overwriting requestedId");
    }
  } finally { publishing.publishNewDocument = original; }
});

// These cases isolate the authority boundary. A readable but versionless document
// may fail later for missing content; it must not look unreadable with the right
// key, and no key may leak a downstream diagnostic on a member-only operation.
const KEY_READERS = ["get_document", "update_document", "suggest_edit", "get_comments", "get_changes", "add_comment", "reply_to_comment", "resolve_thread", "reopen_thread", "fork_document", "get_lineage", "revise_suggestion", "withdraw_suggestion"];
const KEY_DENIED = ["accept_suggestion", "reject_suggestion", "commit_draft", "rename_document", "move_document"];
async function keyBoundary(name, k) {
  const admin = require("firebase-admin");
  const { toolByName } = require("../lib/mcp/tools.js");
  const storage = Object.getOwnPropertyDescriptor(admin, "storage");
  const { db } = fakeFirestore({ "docs/key-doc": { ownerUid: "owner", ownerEmail: "owner@example.com", members: ["owner@example.com"], editorMembers: ["owner@example.com"], visibility: "unlisted", publicEdit: true, linkToken: "current-key-long-enough", currentVersion: "v1", title: "Key document" } });
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({ getFiles: async () => [[]], file: () => ({ download: async () => [Buffer.from("<p>The passage</p>")] }) }) }) });
  try {
    const result = await toolByName(name).run({ db, caller: { uid: "reader", emailLower: "reader@example.com" }, actor: { channel: "mcp", tokenId: "test-token" } }, { id: "key-doc", k, since: "all", content: "<p>Replaced</p>", exact: "The passage", replacement: "New passage", body: "Comment", threadId: "missing-thread", title: "Renamed" });
    return { result };
  } catch (error) { return { error: error.message }; }
  finally { if (storage) Object.defineProperty(admin, "storage", storage); else delete admin.storage; }
}
for (const name of KEY_READERS) test(`MCP key boundary ${name} preserves its optional key`, async () => {
  for (const k of [undefined, "wrong-key-long-enough"]) assert.equal((await keyBoundary(name, k)).error, 'no document with id "key-doc"', `${name}: no downstream facts without the current key`);
  const allowed = await keyBoundary(name, "current-key-long-enough");
  assert.notEqual(allowed.error, 'no document with id "key-doc"', `${name}: the current key passes the document read gate`);
});
for (const name of KEY_DENIED) test(`MCP key boundary ${name} remains member-only`, async () => {
  assert.equal((await keyBoundary(name, "current-key-long-enough")).error, 'no document with id "key-doc"', `${name}: an unrelated link reader learns no member-only facts`);
});
