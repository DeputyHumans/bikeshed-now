// SPDX-License-Identifier: Apache-2.0
// The agent surface speaks JSON-RPC and has exactly the tools the spec lists (SPEC §19).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  handleMcp,
  INSTRUCTIONS,
  missingArguments,
  PROTOCOL_VERSION,
  SERVER_INFO,
} = require("../lib/mcp/server.js");
const {
  TOOLS,
  TOOL_NAMES,
  folderPath,
  toolByName,
  withReaderAddress,
  lineageForAgent,
} = require("../lib/mcp/tools.js");

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

test("the connect instructions fit the smallest budget and name only real tools", () => {
  // Every client injects this into the model's context. Codex treats the first
  // 512 characters as the self-contained part and Claude Code caps the whole
  // string at 2 KB, so the sentence that says where documents go has to be near
  // the front rather than merely present.
  assert.ok(
    Buffer.byteLength(INSTRUCTIONS, "utf8") <= 2048,
    `the instructions are ${Buffer.byteLength(INSTRUCTIONS, "utf8")} bytes`,
  );
  const head = INSTRUCTIONS.slice(0, 512);
  assert.match(head, /publish_document/);
  assert.match(head, /rather than/);
  assert.match(head, /artifact/);

  // A tool named here that does not exist costs an agent a round trip on a
  // refusal it cannot act on — the same rule the skills are held to.
  for (const [, name] of INSTRUCTIONS.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)) {
    assert.ok(TOOL_NAMES.includes(name), `the instructions name a tool ${name} that does not exist`);
  }
});

test("a publish result says where a reader opens the document", () => {
  // An agent over MCP has no way to know the origin — it is in its client's
  // config, not in the protocol — so the address has to come from the server or
  // it hands back a docId and calls that a link.
  const previous = process.env.BIKESHED_PUBLIC_ORIGIN;
  process.env.BIKESHED_PUBLIC_ORIGIN = "https://example.test";
  try {
    const result = withReaderAddress({ docId: "storage-migration" }, "storage-migration");
    assert.equal(result.url, "https://example.test/d/storage-migration");
    assert.equal(result.docId, "storage-migration", "the rest of the result survives");
  } finally {
    if (previous === undefined) delete process.env.BIKESHED_PUBLIC_ORIGIN;
    else process.env.BIKESHED_PUBLIC_ORIGIN = previous;
  }
});

test("an unconfigured deployment omits the address rather than guessing one", () => {
  // A bare `/d/<id>` path looks like an address and is not one.
  const saved = {
    origin: process.env.BIKESHED_PUBLIC_ORIGIN,
    gcloud: process.env.GCLOUD_PROJECT,
    google: process.env.GOOGLE_CLOUD_PROJECT,
  };
  delete process.env.BIKESHED_PUBLIC_ORIGIN;
  delete process.env.GCLOUD_PROJECT;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  try {
    assert.ok(!("url" in withReaderAddress({ docId: "x" }, "x")));
  } finally {
    for (const [key, value] of [
      ["BIKESHED_PUBLIC_ORIGIN", saved.origin],
      ["GCLOUD_PROJECT", saved.gcloud],
      ["GOOGLE_CLOUD_PROJECT", saved.google],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("there are exactly twenty-one tools, and they are the twenty-one in the spec", () => {
  assert.deepEqual(TOOL_NAMES, [
    "list_documents",
    "get_document",
    "publish_document",
    "fork_document",
    "get_lineage",
    "update_document",
    "commit_draft",
    "suggest_edit",
    "revise_suggestion",
    "withdraw_suggestion",
    "accept_suggestion",
    "reject_suggestion",
    "list_folders",
    "create_folder",
    "move_document",
    "rename_document",
    "get_comments",
    "add_comment",
    "reply_to_comment",
    "resolve_thread",
    "reopen_thread",
  ]);
  assert.equal(TOOLS.length, 21);
});

test("the surface has no tool that deletes or shares", () => {
  // Both are stated refusals rather than gaps: deleting a folder reparents
  // everything beneath it, and deciding who can read a document is not a
  // decision to automate. docs/agents/agent-guide.md says so to the agent; this says
  // so to whoever adds the tenth tool.
  for (const name of TOOL_NAMES) {
    assert.doesNotMatch(name, /delete|remove|share|grant|access/);
  }
});

test("fork_document needs only the document, and takes the same key the read tools do", () => {
  const tool = toolByName("fork_document");
  assert.deepEqual(tool.inputSchema.required, ["id"]);
  assert.deepEqual(
    Object.keys(tool.inputSchema.properties).sort(),
    ["folder", "id", "k", "title", "version"],
  );
  assert.equal(
    tool.inputSchema.properties.k.description,
    toolByName("get_document").inputSchema.properties.k.description,
  );
  // The disclosure travels with the tool, because there is no dialog on this
  // path to make it in.
  assert.match(tool.description, /author sees that it was forked/);
  assert.notEqual(missingArguments(tool, {}), null);
});

test("get_lineage needs only the document, and takes the same key the read tools do", () => {
  const tool = toolByName("get_lineage");
  assert.deepEqual(tool.inputSchema.required, ["id"]);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["id", "k"]);
  assert.equal(
    tool.inputSchema.properties.k.description,
    toolByName("get_document").inputSchema.properties.k.description,
  );
});

test("a lineage an agent cannot read answers exactly as an absent id", async () => {
  const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) };
  await assert.rejects(
    () => toolByName("get_lineage").run({ db, caller: { uid: "u", emailLower: "u@example.com" } }, { id: "secret-plan" }),
    { message: 'no document with id "secret-plan"' },
  );
});

test("lineage reaches an agent renamed and dated, with nothing added", () => {
  const previous = process.env.BIKESHED_PUBLIC_ORIGIN;
  process.env.BIKESHED_PUBLIC_ORIGIN = "https://example.test";
  try {
    const out = lineageForAgent("gamma", {
      forked: true,
      ancestors: [
        { docId: "beta", title: "Beta", versionId: "v1", ownerEmail: "b@example.com", changed: true },
        { docId: "alpha", title: "Alpha", versionId: "v2" },
      ],
      hiddenAncestor: true,
      forks: {
        total: 2,
        hidden: 1,
        visible: [{ docId: "delta", title: "Delta", visibility: "public", forkedAt: Date.UTC(2026, 9, 5) }],
      },
    });
    assert.deepEqual(out, {
      id: "gamma",
      forked: true,
      forkedFrom: [
        { id: "beta", title: "Beta", version: "v1", owner: "b@example.com", changedSince: true, url: "https://example.test/d/beta" },
        { id: "alpha", title: "Alpha", version: "v2", url: "https://example.test/d/alpha" },
      ],
      moreYouCannotOpen: true,
      forks: {
        total: 2,
        youCannotOpen: 1,
        listed: [
          { id: "delta", title: "Delta", visibility: "public", forkedAt: "2026-10-05T00:00:00.000Z", url: "https://example.test/d/delta" },
        ],
      },
    });
    // Not the owner: no inventory key at all, rather than an empty one that
    // would read as "nobody forked it".
    assert.ok(!("forks" in lineageForAgent("gamma", { forked: true, ancestors: [], hiddenAncestor: true })));
  } finally {
    if (previous === undefined) delete process.env.BIKESHED_PUBLIC_ORIGIN;
    else process.env.BIKESHED_PUBLIC_ORIGIN = previous;
  }
});

test("list_documents says which rows are forks and how often each was forked, off the record", async () => {
  const rows = [
    { id: "a-fork", data: { forked: true, stats: { forks: 0 } } },
    { id: "an-original", data: { stats: { forks: 2, views: 9 } } },
    { id: "neither", data: {} },
  ];
  const query = {
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    get: async () => ({
      docs: rows.map((r) => ({
        id: r.id,
        data: () => ({ title: r.id, currentVersion: null, members: ["me@example.com"], ...r.data }),
        ref: { collection: () => ({ doc: () => null }) },
      })),
    }),
  };
  const db = { collection: () => query, getAll: async () => [] };
  const out = await toolByName("list_documents").run({ db, caller: { emailLower: "me@example.com" } }, {});
  const byId = new Map(out.documents.map((d) => [d.id, d]));
  assert.deepEqual([byId.get("a-fork").forked, byId.get("a-fork").forks], [true, 0]);
  assert.deepEqual([byId.get("an-original").forked, byId.get("an-original").forks], [false, 2]);
  assert.deepEqual([byId.get("neither").forked, byId.get("neither").forks], [false, 0]);
});

test("move_document treats the workspace root as an omitted argument", () => {
  // `folder` must stay OPTIONAL. missingArguments rejects an empty string, so
  // making it required would leave no way to say "move this out to the root" —
  // and an agent would discover that only from a refusal it cannot act on.
  const tool = toolByName("move_document");
  assert.deepEqual(tool.inputSchema.required, ["id"]);
  assert.match(tool.inputSchema.properties.folder.description, /OMIT/);
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

test("get_document says a source is cut before the source starts", async () => {
  /**
   * An agent reads the result as JSON text, in key order. With `truncated`
   * last, the one field saying the source was incomplete came after 200,000
   * characters of it — and an agent that missed it and sent the source back
   * through update_document published a version missing the rest.
   */
  const tool = toolByName("get_document");
  assert.match(tool.description, /200,000 characters/);
  assert.match(tool.description, /update_document/);

  const admin = require("firebase-admin");
  const realStorage = Object.getOwnPropertyDescriptor(admin, "storage");
  const prevBucket = process.env.BIKESHED_BUCKET;
  const whole = `<head><style>${"x".repeat(200_000)}</style></head><body></body>`;
  Object.defineProperty(admin, "storage", {
    configurable: true,
    value: () => ({
      bucket: () => ({ file: () => ({ download: async () => [Buffer.from(whole)] }) }),
    }),
  });
  process.env.BIKESHED_BUCKET = "test-bucket";
  try {
    const caller = { uid: "u1", emailLower: "owner@example.com" };
    const data = { ownerUid: "u1", members: [caller.emailLower], currentVersion: "v1", title: "Deck" };
    const version = { exists: true, data: () => ({ entry: "index.html", format: "html" }) };
    const ref = {
      id: "big-deck",
      get: async () => ({ exists: true, data: () => data }),
      set: async () => {},
      collection: (name) => ({
        doc: () => (name === "versions" ? { get: async () => version } : { set: async () => {} }),
      }),
    };
    const db = { collection: () => ({ doc: () => ref }) };

    const result = await tool.run({ db, caller, actor: { tokenId: "t1" } }, { id: "big-deck" });
    assert.equal(result.truncated, true);
    assert.equal(result.source.length, 200_000);
    const text = JSON.stringify(result);
    assert.ok(text.indexOf('"truncated"') < text.indexOf('"source"'), "truncated must precede source");
  } finally {
    if (realStorage) Object.defineProperty(admin, "storage", realStorage);
    else delete admin.storage;
    if (prevBucket === undefined) delete process.env.BIKESHED_BUCKET;
    else process.env.BIKESHED_BUCKET = prevBucket;
  }
});

// --- Folder paths ----------------------------------------------------------

test("a path names every level the caller can see", () => {
  const names = new Map([
    ["f1", "Design"],
    ["f2", "Reviews"],
  ]);
  assert.equal(folderPath([], "Design", names), "Design");
  assert.equal(folderPath(["f1"], "Reviews", names), "Design/Reviews");
  assert.equal(folderPath(["f1", "f2"], "Q3", names), "Design/Reviews/Q3");
});

test("an ancestor the caller cannot see is a level, not a gap", () => {
  // Membership cascades DOWN only: a grant made directly on a child leaves its
  // parent invisible. Dropping that level would make a nested folder read as a
  // top-level one and an agent would file things by a path nobody has; printing
  // the id would look like somewhere it could navigate to.
  const names = new Map([["f2", "Reviews"]]);
  assert.equal(folderPath(["f1", "f2"], "Q3", names), "…/Reviews/Q3");
  assert.equal(folderPath(["f1"], "Reviews", names), "…/Reviews");
  assert.equal(folderPath(["f1", "f9"], "Q3", names), "…/…/Q3");
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

test("publish_document takes an optional id, and refuses a malformed one before touching anything", async () => {
  const tool = toolByName("publish_document");
  assert.equal(tool.inputSchema.properties.id.type, "string");
  assert.ok(!tool.inputSchema.required.includes("id"));

  // Any database or storage access would throw here: a malformed id must be
  // refused before the bundle is read, uploaded, or an id allocated.
  const untouchable = new Proxy({}, {
    get() {
      throw new Error("touched the database");
    },
  });
  await assert.rejects(
    tool.run(
      { db: untouchable, caller: { emailLower: "owner@example.com", uid: "u" } },
      { title: "t", content: "# t", id: "Not An Id" },
    ),
    /id may use lowercase letters, digits and hyphens between them/,
  );
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

// --- Unlisted documents need their link (SPEC §17) -------------------------

const LINK = "tok_0123456789abcdefghijk";
const STRANGER = { uid: "u-stranger", emailLower: "stranger@example.com" };

/**
 * One unlisted document with one open thread, and optionally a link grant for
 * the stranger. Enough of Firestore for loadDoc and get_comments.
 */
function unlistedDb({ grantToken = null, doc = {} } = {}) {
  const empty = { exists: false, get: () => undefined, data: () => undefined };
  const comments = {
    orderBy: () => comments,
    get: async () => ({
      docs: [{ data: () => ({ authorEmail: "ana@example.com", body: "Too long." }) }],
    }),
  };
  const annotations = {
    where: () => annotations,
    limit: () => annotations,
    get: async () => ({
      docs: [
        {
          id: "t1",
          data: () => ({ anchor: { exact: "the passage" }, resolved: false }),
          ref: { collection: () => comments },
        },
      ],
    }),
  };
  const docRef = (id) => ({
    id,
    get: async () =>
      id === "memo"
        ? {
            exists: true,
            data: () => ({
              title: "Memo",
              currentVersion: "v1",
              ownerUid: "u-owner",
              ownerEmail: "owner@example.com",
              members: ["owner@example.com"],
              visibility: "unlisted",
              linkToken: LINK,
              ...doc,
            }),
          }
        : empty,
    collection: (name) => ({
      doc: (child) =>
        name === "linkGrants"
          ? {
              get: async () =>
                child === STRANGER.uid && grantToken
                  ? { exists: true, get: (f) => ({ uid: child, token: grantToken })[f] }
                  : empty,
            }
          : { get: async () => ({ exists: child === "v1" }), collection: () => annotations },
    }),
  });
  return { collection: () => ({ doc: docRef }) };
}

async function comments(db, args) {
  return toolByName("get_comments").run({ db, caller: STRANGER }, args);
}

test("an unlisted document answers a keyless stranger exactly as an absent id does", async () => {
  const db = unlistedDb();
  await assert.rejects(comments(db, { id: "memo" }), { message: 'no document with id "memo"' });
  await assert.rejects(comments(db, { id: "nope" }), { message: 'no document with id "nope"' });
  await assert.rejects(comments(db, { id: "memo", k: "tok_wrong_wrong_wrong_wr" }), {
    message: 'no document with id "memo"',
  });
});

test("the link's key, or a current grant, opens an unlisted document to an agent", async () => {
  const withKey = await comments(unlistedDb(), { id: "memo", k: LINK });
  assert.equal(withKey.threads[0].quote, "the passage");

  const granted = await comments(unlistedDb({ grantToken: LINK }), { id: "memo" });
  assert.equal(granted.threads.length, 1, "the account opened the link before");

  await assert.rejects(comments(unlistedDb({ grantToken: "tok_rotated_away_long_ago" }), { id: "memo" }), {
    message: 'no document with id "memo"',
  });
});

test("open editing lets a stranger edit, never move: moving makes the mover a member", async () => {
  // Filing a document into a folder unions that folder's members into the
  // document's. With open editing as the gate, any account could file someone's
  // document into its own folder and read its member list and statistics.
  const db = unlistedDb({ doc: { visibility: "public", linkToken: undefined, publicEdit: true } });
  await assert.rejects(
    toolByName("move_document").run({ db, caller: STRANGER }, { id: "memo", folder: "mine" }),
    { message: "you cannot move that document" },
  );
});

test("the key is an optional argument on every tool that reads one document", () => {
  for (const name of ["get_document", "update_document", "suggest_edit", "get_comments", "add_comment", "reply_to_comment", "resolve_thread", "reopen_thread"]) {
    const schema = toolByName(name).inputSchema;
    assert.equal(schema.properties.k?.type, "string", name);
    assert.ok(!schema.required.includes("k"), `${name} must not demand a key`);
  }
});

// --- The protocol ----------------------------------------------------------

test("a request with no credential is refused before any database access", async () => {
  const res = recorder();
  await handleMcp(post({ jsonrpc: "2.0", id: 1, method: "initialize" }), res);
  assert.equal(res.statusCode, 401);
  // The challenge names where to sign in (SPEC §23); oauth-flow.test.js pins
  // the full value against a configured origin.
  assert.match(
    res.headers["www-authenticate"],
    /^Bearer realm="bikeshed", resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"$/,
  );
  assert.equal(res.body.error.message, "sign in to connect, or send a personal access token");
});

test("a malformed credential is refused the same way", async () => {
  const res = recorder();
  await handleMcp(
    post({ jsonrpc: "2.0", id: 1, method: "initialize" }, { authorization: "Bearer nonsense" }),
    res,
  );
  assert.equal(res.statusCode, 401);
  assert.match(res.headers["www-authenticate"], /, error="invalid_token"$/);
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
  // Signing in first, a personal token beside it, and every address relative
  // so nothing stamps the file (SPEC §19, §23).
  const { PRM_MCP_PATH, AS_METADATA_PATH } = require("../lib/oauth/metadata.js");
  assert.equal(discovery.authentication.type, "oauth2");
  assert.equal(discovery.authentication.resourceMetadata, PRM_MCP_PATH);
  assert.equal(discovery.authentication.authorizationServer, AS_METADATA_PATH);
  assert.deepEqual(discovery.authentication.alternatives.map((a) => a.type), ["bearer"]);
  assert.equal(discovery.mcpVersion, PROTOCOL_VERSION);
  assert.equal(discovery.name, SERVER_INFO.name);
});
