// SPDX-License-Identifier: Apache-2.0
// The agent surface speaks JSON-RPC and has exactly six tools (SPEC §19).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  handleMcp,
  missingArguments,
  PROTOCOL_VERSION,
  SERVER_INFO,
} = require("../lib/mcp/server.js");
const { TOOLS, TOOL_NAMES, toolByName } = require("../lib/mcp/tools.js");

/** A minimal Express-ish response that records what was sent. */
function recorder() {
  const res = {
    statusCode: null,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.ended = true;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return res;
}

function post(body, headers = {}) {
  return {
    method: "POST",
    path: "/mcp",
    query: {},
    headers,
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
  };
}

// --- The tool surface ------------------------------------------------------

test("there are exactly six tools, and they are the six in the spec", () => {
  assert.deepEqual(TOOL_NAMES, [
    "list_documents",
    "get_document",
    "publish_document",
    "update_document",
    "get_comments",
    "reply_to_comment",
  ]);
  assert.equal(TOOLS.length, 6);
});

test("every tool declares a usable JSON schema", () => {
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
    const required = tool.inputSchema.required ?? [];
    const properties = Object.keys(tool.inputSchema.properties ?? {});
    for (const key of required) {
      assert.ok(properties.includes(key), `${tool.name}: required "${key}" is not a property`);
    }
    for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      assert.ok(schema.type, `${tool.name}.${name} has no type`);
    }
  }
});

test("lookup by name is exact", () => {
  assert.equal(toolByName("get_comments").name, "get_comments");
  assert.equal(toolByName("nope"), undefined);
});

test("get_comments is the tool that earns the surface", () => {
  // It returns each comment together with the passage it is anchored to, which
  // is what lets an agent revise without fetching and diffing the document.
  const tool = toolByName("get_comments");
  assert.match(tool.description, /anchored/i);
});

test("get_document returns source, not rendered HTML", () => {
  const tool = toolByName("get_document");
  assert.match(tool.description, /SOURCE/i);
});

// --- Arguments -------------------------------------------------------------

test("every declared required argument is actually enforced", () => {
  // The failure this replaces: a missing `id` reached Firestore and came back
  // as `Value for argument "documentPath" is not a valid resource path`. An
  // agent cannot act on that. It has to be told which argument to add.
  for (const tool of TOOLS) {
    const required = tool.inputSchema.required ?? [];
    if (required.length === 0) {
      assert.equal(missingArguments(tool, {}), null, `${tool.name} requires nothing`);
      continue;
    }
    const complaint = missingArguments(tool, {});
    assert.ok(complaint, `${tool.name} accepted an empty argument object`);
    assert.match(complaint, new RegExp(`^${tool.name}:`));
    for (const key of required) {
      assert.match(complaint, new RegExp(`"${key}"`), `${tool.name} did not name "${key}"`);
    }
    assert.match(complaint, /tools\/list/, "the complaint must say where the schema is");
  }
});

test("a complaint names every missing argument, not just the first", () => {
  const reply = toolByName("reply_to_comment");
  const complaint = missingArguments(reply, { id: "some-doc" });
  assert.match(complaint, /"threadId"/);
  assert.match(complaint, /"body"/);
  assert.doesNotMatch(complaint, /"id"/, "id was supplied and must not be listed");
  assert.match(complaint, /arguments/, "plural, because two are missing");
});

test("an empty string is missing: every required argument is an id or a body", () => {
  const get = toolByName("get_document");
  assert.ok(missingArguments(get, { id: "" }));
  assert.equal(missingArguments(get, { id: "x" }), null);
});

test("optional arguments are never demanded", () => {
  assert.equal(missingArguments(toolByName("list_documents"), {}), null);
  assert.equal(missingArguments(toolByName("get_comments"), { id: "x" }), null);
});

// --- Format is a property of the VERSION -----------------------------------

test("list_documents reads format from the current version, not the document", async () => {
  /**
   * The bug: `format` was read off the document record, where it does not
   * exist, so every row came back "html" — including Markdown documents. It is
   * one of seven fields this tool returns and the one an agent uses to decide
   * what it is about to receive.
   */
  const docs = [
    { id: "a-markdown-doc", currentVersion: "v2", format: "markdown" },
    { id: "an-html-doc", currentVersion: "v1", format: "html" },
    { id: "a-doc-with-no-version", currentVersion: null, format: null },
  ];

  const versionRef = (docId, versionId) => ({
    id: versionId,
    parent: { parent: { id: docId } },
  });

  const docSnapshots = docs.map((d) => ({
    id: d.id,
    data: () => ({
      title: d.id,
      currentVersion: d.currentVersion,
      ownerEmail: "owner@example.com",
      members: ["owner@example.com"],
      // Deliberately absent: `format` is NOT a field on a document record.
    }),
    ref: { collection: () => ({ doc: (v) => versionRef(d.id, v) }) },
  }));

  const query = {
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    startAfter: () => query,
    get: async () => ({ docs: docSnapshots }),
  };

  const db = {
    collection: () => ({ ...query, doc: () => ({ get: async () => ({ exists: false }) }) }),
    getAll: async (...refs) =>
      refs.map((r) => {
        const source = docs.find((d) => d.id === r.parent.parent.id);
        return { ref: r, data: () => ({ format: source.format }) };
      }),
  };

  const rows = (
    await toolByName("list_documents").run(
      { db, caller: { emailLower: "owner@example.com" } },
      { limit: 10 },
    )
  ).documents;

  assert.equal(rows.find((r) => r.id === "a-markdown-doc").format, "markdown");
  assert.equal(rows.find((r) => r.id === "an-html-doc").format, "html");
  // A document whose currentVersion is missing must not throw, and must not
  // claim to be Markdown on no evidence.
  assert.equal(rows.find((r) => r.id === "a-doc-with-no-version").format, "html");
});

// --- The protocol ----------------------------------------------------------

test("a request with no credential is refused before any database access", async () => {
  const res = recorder();
  await handleMcp(post({ jsonrpc: "2.0", id: 1, method: "initialize" }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers["www-authenticate"], 'Bearer realm="bikeshed"');
  assert.equal(res.body.error.message, "a personal access token is required");
});

test("a malformed credential is refused the same way", async () => {
  const res = recorder();
  await handleMcp(
    post({ jsonrpc: "2.0", id: 1, method: "initialize" }, { authorization: "Bearer nonsense" }),
    res,
  );
  assert.equal(res.statusCode, 401);
});

test("GET is declined explicitly rather than 404ing", async () => {
  // A 404 reads as "wrong URL" to a client that is simply asking for the SSE
  // channel this server does not offer.
  const res = recorder();
  await handleMcp({ method: "GET", path: "/mcp", query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.match(res.body.error.message, /POST-only/);
});

test("the protocol version and server identity are pinned", () => {
  assert.match(PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(SERVER_INFO.name, "bikeshed");
  assert.match(SERVER_INFO.version, /^\d+\.\d+\.\d+$/);
});

test("the published discovery document points at this endpoint", () => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const discovery = JSON.parse(
    readFileSync(
      join(__dirname, "..", "..", "app", "public", ".well-known", "mcp.json"),
      "utf8",
    ),
  );
  assert.equal(discovery.transport.url, "/mcp");
  assert.equal(discovery.transport.type, "streamable-http");
  assert.equal(discovery.authentication.type, "bearer");
  assert.equal(discovery.mcpVersion, PROTOCOL_VERSION);
  assert.equal(discovery.name, SERVER_INFO.name);
});
