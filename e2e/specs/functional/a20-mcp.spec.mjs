// SPDX-License-Identifier: Apache-2.0
// A20 MCP: the thirty-one tools each succeeding and refused, JSON-RPC errors, the 401 challenge, client headers and the link key (SPEC §19).

/**
 * Catalogue A20.1–A20.6. The CLI's A20.7 is another unit's.
 *
 *   A20.1          tools/list is SPEC §19's thirty-one, and initialize says so
 *   A20.2.<tool>   one case per tool: what it does when it works, and each
 *                  way it is refused, with the server's exact words. The
 *                  plan's particulars live in their tool's case: idTaken
 *                  (publish_document), the move to the root (move_document),
 *                  50 threads (get_comments), 200,000 characters
 *                  (get_document), cursor paging (list_documents)
 *   A20.3          JSON-RPC: a missing required argument is a tool error
 *                  naming it, for every tool that requires one; -32601 for an
 *                  unknown tool or method; -32600; -32700; 202 for a
 *                  notification; a batch answers in order
 *   A20.3.parse    known defect X-a20-mcp-1: a malformed body sent as
 *                  application/json never reaches the handler
 *   A20.4          the 401 challenge, invalid_token, no-store, the exposed
 *                  header, 405s
 *   A20.5          X-Bikeshed-Client / -Agent stored verbatim; the channel
 *                  is mcp whatever the token was minted for (SPEC §17)
 *   A20.6          `k` opens an unlisted document on the nine tools SPEC §19
 *                  names; A20.6.extra the four more that take it, and the
 *                  five that never do
 *
 * Every account is cast with comment email off, so no case sends mail but the
 * invitations share() sends locally (on production share() is the operator
 * script, which sends none). Every document, fork and folder a case makes is
 * ledgered. Only e2e/lib/ talks to the stack.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { randomBytes } from "node:crypto";
import { answered, currentTarget, isHostingCutoff, precondition, scenario, stackDidNotAnswer } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { mintToken, openSession, revokeToken } from "../../lib/session.mjs";
import { absentDocId, createFolderMcp, docIdFor, forkMcp, ledgerDoc, publishMcp, seedThreads } from "../../lib/seed.mjs";
import { setVisibility, share, trackWindow } from "../../lib/grant.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { ACT_TOOLS, COMMENT_TOOLS } from "../../lib/guard.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const BOTH = ["local", "prod"];
// Case budgets (timeoutMs) are wide on purpose: on a shared stack a single
// Firestore write from a function has taken 10–30 s (measured: publish_document
// 22 s, POST /access 18 s), and nothing here is a latency assertion. The whole
// file has taken 50 minutes there (under 20 s on a quiet stack). Every case is
// a top-level scenario() with a literal timeoutMs, so run.mjs's budget scan
// sums them (capped at the tier's ceiling) and the file declares no budget.
//
// Every case is declared inconclusiveOnStackTimeout: on a saturated shared
// stack Hosting answers 504 after 60 s for a function that has not answered,
// and that is no product answer. A response a case reads itself (raw /mcp
// probes, a revoke) goes through answered() for the same reason.

/** SPEC §19's table, in its order. */
const SPEC_TOOLS = Object.freeze([
  "get_document_access", "set_document_access", "get_folder_access", "set_folder_access",
  "set_document_visibility", "rename_folder", "move_folder", "delete_folder",
  "list_documents", "get_document", "publish_document", "fork_document", "get_lineage", "update_document", "commit_draft",
  "suggest_edit", "revise_suggestion", "withdraw_suggestion", "accept_suggestion", "reject_suggestion", "list_folders",
  "get_folder", "create_folder", "move_document", "rename_document", "get_comments", "get_changes", "add_comment",
  "reply_to_comment", "resolve_thread", "reopen_thread",
]);
/** The nine SPEC §19 says take an optional `k`. */
const KEY_TOOLS = Object.freeze([
  "get_document", "update_document", "suggest_edit", "get_comments", "get_changes", "add_comment", "reply_to_comment", "resolve_thread", "reopen_thread",
]);

// --- The server's words ------------------------------------------------------------

const ABSENT = (id) => `no document with id "${id}"`;
const NO_FOLDER = (id) => `no folder with id "${id}"`;
const NO_VERSION = (v) => `no version "${v}"`;
const NOT_IN_VERSION = "that passage is not in the current version; quote it as a reader sees it, without Markdown or HTML, within one paragraph";
const OCCURS = (n) => `that passage occurs ${n} times; add a prefix or suffix of the words around the one you mean`;
const COMMENT_CROSSES = "a comment is anchored to text within one paragraph, and that passage spans more than one, or a line break; quote the part you mean";
const SUGGEST_CROSSES = "a suggestion changes text within one paragraph, and that passage spans more than one, or a line break; suggest each part on its own";
const REPLACEMENT_REQUIRED = "replacement is required: the new text, or an empty string to propose deleting the passage";
const SAME_REPLACEMENT = "the replacement is the same as the text it replaces";
const BAD_DOC_ID = "id may use lowercase letters, digits and hyphens between them, up to 60 characters";
const CONTENT_EMPTY = "content is empty";
const BODY_EMPTY = "body is empty";
const FOLDER_ABSENT = "destination folder not found";
const FOLDER_NOT_YOURS = "you cannot put anything in that folder";
const FOLDER_NAME = "folder name is required (up to 120 characters)";
const TITLE_RULE = "title is required (up to 200 characters)";
const CANNOT_EDIT = "you cannot edit that document";
const CANNOT_EDIT_BUT_SUGGEST = "you cannot edit that document, but you can suggest an edit to it with suggest_edit; its owner or an approver accepts or rejects it";
const CANNOT_COMMIT = "you cannot publish that document's draft";
const CANNOT_RENAME = "you cannot rename that document";
const CANNOT_MOVE = "you cannot move that document";
const CANNOT_SUGGEST = "you cannot suggest edits to that document";
const NOT_APPROVER = "only the owner or an approver can accept or reject a suggestion";
const NO_DRAFT = "There is no draft to publish.";
const RESOLVE_FIRST = "Resolve all comments before publishing a new version.";
const STALE = (now, was) => `the document is at ${now} now, not ${was}: somebody published since you read it. Read it again with get_document, then update that`;
const NO_SUCH_SUGGESTION = "no such suggestion";
const NO_SUCH_THREAD = "no such thread";
const ALREADY = (state) => `it has already been ${state}`;
const NOT_AUTHOR_CHANGE = "only the person who suggested it can change it";
const NOT_AUTHOR_WITHDRAW = "only the person who suggested it can withdraw it";
const SUGGESTION_NOT_RESOLVED = "that thread is a suggested edit: it is settled by accepting, rejecting or withdrawing it, not by resolving";
const NOT_A_CURSOR = 'since: that is not a cursor this server gave out. Pass a cursor from an earlier result, "last" or "all"';
const OTHER_DOC_CURSOR = (id) => `since: that cursor belongs to another document, not "${id}". Pass a cursor from an earlier result, "last" or "all"`;
const MISSING = (tool, names) =>
  `${tool}: missing required ${names.length === 1 ? "argument" : "arguments"} ${names.map((n) => `"${n}"`).join(", ")}. Call tools/list for this tool's schema.`;

/** The limits a tool states in its own description (SPEC §19). */
const SOURCE_LIMIT = 200_000;
const COMMENT_LIMIT = 50;

// --- The document every case reads ------------------------------------------------

const PARAS = Object.freeze([
  "The quick brown fox jumps over the lazy dog.",
  "Second paragraph says alpha once and alpha twice.",
  "Third paragraph closes the document.",
]);
/** A passage that runs from the first paragraph into the second. */
const ACROSS = "lazy dog. Second paragraph";

function page(title, paras = PARAS) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>\n<body>\n<h1>${title}</h1>\n${paras
    .map((p, i) => `<p id="p${i + 1}">${p}</p>`)
    .join("\n")}\n</body></html>\n`;
}

const tag = () => `${runTag(target.runId)}-${rand4()}`;

// --- Agents ----------------------------------------------------------------------------

/** How long one request may take before it counts as no answer. */
const CALL_MS = 180_000;

/**
 * A client of this case whose every request waits CALL_MS unless it says:
 * http.mjs's own default is 60 s, and under a load spike on the shared stack
 * (load average 27) one publish_document write took longer than that, though
 * nothing here asserts latency.
 */
const patientHttp = (ctx, o = {}) => ctx.http({ ...o, timeoutMs: CALL_MS });

/** An MCP client for this token whose every request waits CALL_MS. */
function mcpFor(ctx, token, actor, headers = {}) {
  return ctx.mcp({ http: patientHttp(ctx, { actor, headers: { authorization: `Bearer ${token}`, ...headers } }) });
}

/** One account's session, a minted token and an initialized MCP client on it. */
async function agentFor(ctx, acct, { channel = "mcp", headers } = {}) {
  const session = await openSession(target, acct, { http: patientHttp(ctx, { actor: acct.role }) });
  const { token, tokenId } = await mintToken(session, { name: `e2e a20 ${acct.role}`, channel });
  const mcp = mcpFor(ctx, token, `${acct.role}-mcp`, headers);
  await mcp.initialize();
  return { acct, email: acct.email, session, token, tokenId, mcp };
}

/**
 * Accounts for these roles (comment email off), each with its own MCP client,
 * set up side by side: on a shared stack every write queues behind everyone
 * else's, and the file has one 600 s budget.
 */
async function crew(ctx, roles, o = {}) {
  return Promise.all(
    roles.map(async (role) => {
      const [a] = await cast(target, [role], { notifications: false });
      return agentFor(ctx, a, o);
    }),
  );
}

/** The document record, read with the Admin SDK: a check that writes nothing (get_document records a read). */
const record = (id) => readDoc(target, `docs/${id}`);

/** publish_document as `who`, at a fresh run id; ledgered by publishMcp. */
async function publishDoc(who, name, { title, content, format = "html" } = {}) {
  const t = title ?? `A20 ${name} ${tag()}`;
  const body = content ?? (format === "html" ? page(t) : `# ${t}\n\n${PARAS.join("\n\n")}\n`);
  const out = await publishMcp(who.mcp, { title: t, content: body, format, id: docIdFor(target, `a20-${name}`) });
  precondition(!out.isError && out.docId, `publish_document (${name}): ${out.text.slice(0, 300)}`);
  return { id: out.docId, title: t, content: body, result: out.json };
}

async function shareAs(owner, docId, who, role) {
  const g = await share(target, { owner: owner.session, doc: docId, account: who.acct, role });
  precondition(g.status === 200, `share ${docId} with ${who.email} as ${role}: ${g.status}`);
}

/** The arguments seed.mjs's forkMcp sends as fork_document's own. */
const FORK_ARGS = Object.freeze(["id", "version", "title", "folder", "k"]);

/**
 * A tool call as `who`. Whatever a creating tool makes is ledgered the moment
 * its id is known, even in a call that wanted a refusal: create_folder through
 * seed.mjs's createFolderMcp, fork_document through its forkMcp (each sends
 * exactly the arguments given), and a published document with ledgerDoc,
 * because publishMcp would add an id and a format to a call that is under
 * test. The two helpers refuse before sending what they cannot ledger (a
 * folder with no name, a fork of no id): those probes, which A20.3 sends, go
 * out as they are, and anything they made is ledgered all the same.
 */
async function callAs(who, tool, args) {
  if (tool === "create_folder" && typeof args.name === "string") {
    return createFolderMcp(who.mcp, { name: args.name, ownerEmail: who.email, ...(args.parent !== undefined ? { parent: args.parent } : {}) });
  }
  if (tool === "fork_document" && typeof args.id === "string" && args.id.trim() && Object.keys(args).every((k) => FORK_ARGS.includes(k))) {
    return forkMcp(who.mcp, { ...args, ownerEmail: who.email });
  }
  const out = await who.mcp.call(tool, args);
  if (!out.isError && (tool === "publish_document" || tool === "fork_document") && typeof out.json?.docId === "string") {
    const fork = tool === "fork_document";
    const forkOf = fork && typeof args.id === "string" && args.id.trim() ? { forkOf: args.id.trim() } : {};
    ledgerDoc(target, { docId: out.json.docId, via: fork ? "mcp-fork" : "mcp", ownerEmail: who.email, actor: who.mcp.http.actor ?? null, versionId: out.json.versionId ?? null, ...forkOf });
  }
  return out;
}

/** A tool call that must fail with exactly this text. */
async function refused(who, tool, args, want, label = tool) {
  const out = await callAs(who, tool, args);
  assert.deepEqual({ isError: out.isError, text: out.text }, { isError: true, text: want }, `${label}: want the refusal ${JSON.stringify(want)}`);
  return out;
}

/** A tool call that must succeed; its structured result. */
async function ok(who, tool, args, label = tool) {
  const out = await callAs(who, tool, args);
  assert.equal(out.isError, false, `${label}: want success, got ${JSON.stringify(out.text.slice(0, 300))}`);
  return out.json;
}

const url = (id) => `${target.origin}/d/${id}`;
const audienceOf = (...emails) => ({ readers: emails.length, people: [...emails].sort(), morePeople: 0, teams: [] });

/** fork_document as `who`, through seed.mjs's forkMcp (callAs), which ledgers the fork; never throws on a tool error. */
const forkAs = (who, args) => callAs(who, "fork_document", args);

/** create_folder as `who`, ledgered by createFolderMcp; the raw tool outcome. */
const createFolderAs = (who, name, parent) => callAs(who, "create_folder", { name, ...(parent ? { parent } : {}) });

/** create_folder as `who`, which must succeed; its id. */
async function folder(who, name, parent) {
  const out = await createFolderAs(who, name, parent);
  assert.equal(out.isError, false, `create_folder ${name}: want success, got ${JSON.stringify(out.text.slice(0, 300))}`);
  precondition(typeof out.folderId === "string" && out.folderId, "create_folder returned a folderId");
  return out.folderId;
}

/** A pending suggestion by `who` on the first paragraph's "lazy dog". */
async function suggestion(who, docId, replacement = "sleepy cat", extra = {}) {
  const json = await ok(who, "suggest_edit", { id: docId, exact: "lazy dog", replacement, ...extra }, "suggest_edit (setup)");
  precondition(json.threadId, "suggest_edit returned a threadId");
  return json.threadId;
}

/** get_comments as `who`; the thread with this id, or undefined. */
async function threadOf(who, docId, threadId, o = {}) {
  const json = await ok(who, "get_comments", { id: docId, includeResolved: true, ...o }, "get_comments (read back)");
  return json.threads.find((t) => t.threadId === threadId);
}

// --- A20.1 ---------------------------------------------------------------------------------

scenario("A20.1 tools/list names exactly SPEC §19's thirty-one tools, each described with an object schema that declares its required arguments; initialize answers protocol 2025-06-18, tools.listChanged false and the tree's version", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 240_000,
}, async (ctx) => {
  const [o] = await crew(ctx, ["owner"]);
  const s = o.mcp.state;
  assert.equal(s.protocolVersion, "2025-06-18", "negotiated protocol");
  assert.deepEqual(s.serverInfo, { name: "bikeshed", version: target.expectVersion }, "serverInfo is the tree's (SPEC §19)");
  const init = await o.mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "a20", version: "1" } });
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } }, "capabilities");
  assert.ok(typeof init.result.instructions === "string" && init.result.instructions.length > 0 && init.result.instructions.length <= 2048, `instructions within Claude Code's 2 KB: ${init.result.instructions?.length}`);

  const tools = await o.mcp.listTools();
  const names = tools.map((t) => t.name);
  ctx.step(`tools/list: ${names.join(", ")}`);
  assert.equal(names.length, 31, `exactly 31 tools: ${names.join(", ")}`);
  assert.equal(new Set(names).size, 31, "the names are unique");
  assert.deepEqual([...names].sort(), [...SPEC_TOOLS].sort(), "the tool set is SPEC §19's table");
  const bad = [];
  for (const t of tools) {
    const props = Object.keys(t.inputSchema?.properties ?? {});
    const required = t.inputSchema?.required ?? [];
    if (typeof t.description !== "string" || t.description.trim().length < 20) bad.push(`${t.name}: no description`);
    if (t.inputSchema?.type !== "object") bad.push(`${t.name}: inputSchema.type ${JSON.stringify(t.inputSchema?.type)}`);
    for (const r of required) if (!props.includes(r)) bad.push(`${t.name}: requires ${r}, which its schema does not describe`);
    if (KEY_TOOLS.includes(t.name) && t.inputSchema?.properties?.k?.type !== "string") bad.push(`${t.name}: SPEC §19 says it takes k, its schema has none`);
  }
  assert.deepEqual(bad, [], "every tool's schema");
});

// --- A20.2: one case per tool ------------------------------------------------------

/** An HTML source of exactly `n` characters, all ASCII. */
function filler(n, title) {
  const head = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><p>`;
  const tail = "</p></body></html>";
  const room = n - head.length - tail.length;
  let body = "";
  for (let i = 0; body.length < room; i++) body += `w${i % 10} `;
  return head + body.slice(0, room) + tail;
}

const ROW_KEYS = ["expiresAt", "filedIn", "forked", "forks", "format", "id", "owner", "title", "updatedAt", "version", "visibility"];

scenario("A20.2.list_documents lists the caller's documents newest first as metadata only, pages by nextCursor to a null cursor, and never lists a document of somebody else's", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, x] = await crew(ctx, ["owner", "stranger"]);
  const [d1, xd] = await Promise.all([publishDoc(o, "list-1"), publishDoc(x, "list-x")]);
  const d2 = await publishDoc(o, "list-2", { format: "markdown" });
  const d3 = await publishDoc(o, "list-3");

  ctx.step("the owner's listing: three rows, newest first, metadata only");
  const all = await ok(o, "list_documents", {});
  assert.deepEqual(all.documents.map((r) => r.id), [d3.id, d2.id, d1.id], "newest first, only the owner's");
  assert.equal(all.nextCursor, null, "one page: no cursor");
  for (const r of all.documents) assert.deepEqual(Object.keys(r).sort(), ROW_KEYS, `${r.id}: the row's keys (no source)`);
  const row = (id) => all.documents.find((r) => r.id === id);
  assert.deepEqual(
    { ...row(d2.id), updatedAt: typeof row(d2.id).updatedAt },
    { id: d2.id, title: d2.title, version: "v1", format: "markdown", visibility: "private", expiresAt: null, owner: o.email, forked: false, forks: 0, filedIn: null, updatedAt: "string" },
    "a Markdown document's row",
  );
  assert.equal(row(d1.id).format, "html", "an HTML document's row says html");

  ctx.step("limit 2: two rows and a cursor; the cursor: the last row and no cursor");
  const p1 = await ok(o, "list_documents", { limit: 2 });
  assert.deepEqual({ ids: p1.documents.map((r) => r.id), next: p1.nextCursor }, { ids: [d3.id, d2.id], next: d2.id }, "page 1");
  const p2 = await ok(o, "list_documents", { limit: 2, cursor: p1.nextCursor });
  assert.deepEqual({ ids: p2.documents.map((r) => r.id), next: p2.nextCursor }, { ids: [d1.id], next: null }, "page 2");

  ctx.step("refused: the stranger's listing holds only the stranger's own document");
  const xs = await ok(x, "list_documents", {});
  assert.deepEqual(xs.documents.map((r) => r.id), [xd.id], "a stranger lists none of the owner's documents");
});

scenario("A20.2.get_document returns the stored source with its metadata and an earlier version on request, cuts a source over 200,000 characters at exactly 200,000 and says truncated; a stranger and an absent id get the same refusal, an unknown version its own", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, x] = await crew(ctx, ["owner", "stranger"]);
  const d = await publishDoc(o, "get");
  const g1 = await ok(o, "get_document", { id: d.id });
  assert.deepEqual(Object.keys(g1).sort(), ["canEdit", "canSuggest", "cursor", "expiresAt", "filedIn", "format", "forked", "id", "source", "sourceFile", "title", "truncated", "url", "version", "visibility"].sort(), "the result's keys");
  assert.deepEqual(
    { ...g1, cursor: typeof g1.cursor },
    { id: d.id, url: url(d.id), title: d.title, version: "v1", format: "html", sourceFile: "index.html", visibility: "private", expiresAt: null, canEdit: true, canSuggest: true, forked: false, filedIn: null, cursor: "string", truncated: false, source: d.content },
    "get_document of v1",
  );

  ctx.step("a second version; `version` names the first");
  const v2 = page(`${d.title} two`);
  const up = await ok(o, "update_document", { id: d.id, content: v2, baseVersion: "v1" });
  precondition(up.versionId === "v2", `update to v2: ${JSON.stringify(up)}`);
  const cur = await ok(o, "get_document", { id: d.id });
  const old = await ok(o, "get_document", { id: d.id, version: "v1" });
  assert.deepEqual({ v: cur.version, src: cur.source === v2 }, { v: "v2", src: true }, "current is v2");
  assert.deepEqual({ v: old.version, src: old.source === d.content }, { v: "v1", src: true }, "version: v1 gives v1's source");

  ctx.step("Markdown: the source is the Markdown, not its rendering; and two documents at the limit");
  const exactT = `A20 limit ${tag()}`;
  const overT = `A20 over ${tag()}`;
  const exact = filler(SOURCE_LIMIT, exactT);
  const over = filler(SOURCE_LIMIT + 1, overT);
  precondition(exact.length === SOURCE_LIMIT && over.length === SOURCE_LIMIT + 1, "the two sources are 200,000 and 200,001 characters");
  const [md, de, dv] = await Promise.all([
    publishDoc(o, "get-md", { format: "markdown" }),
    publishDoc(o, "get-200k", { title: exactT, content: exact }),
    publishDoc(o, "get-200k1", { title: overT, content: over }),
  ]);
  const gm = await ok(o, "get_document", { id: md.id });
  assert.deepEqual({ format: gm.format, sourceFile: gm.sourceFile, source: gm.source }, { format: "markdown", sourceFile: "index.md", source: md.content }, "Markdown source");

  ctx.step("200,000 characters exactly is whole; 200,001 is cut at 200,000 and says so");
  const ge = await ok(o, "get_document", { id: de.id });
  const gv = await ok(o, "get_document", { id: dv.id });
  assert.deepEqual({ truncated: ge.truncated, length: ge.source.length, same: ge.source === exact }, { truncated: false, length: SOURCE_LIMIT, same: true }, "a source of exactly 200,000 characters is whole");
  assert.deepEqual({ truncated: gv.truncated, length: gv.source.length, prefix: gv.source === over.slice(0, SOURCE_LIMIT) }, { truncated: true, length: SOURCE_LIMIT, prefix: true }, "a source of 200,001 characters is cut at 200,000 and says truncated");

  ctx.step("refused: a stranger and an absent id, word for word; an unknown version");
  await refused(x, "get_document", { id: d.id }, ABSENT(d.id), "stranger get_document");
  const absent = docIdFor(target, "a20-get-absent");
  await refused(x, "get_document", { id: absent }, ABSENT(absent), "absent id get_document");
  await refused(o, "get_document", { id: d.id, version: "v9" }, NO_VERSION("v9"), "owner get_document v9");
});

scenario("A20.2.publish_document creates a private v1 at the requested id with its address, filedIn, access and cursor; a taken id is suffixed and says idTaken; a bad id, empty content, a folder that is not there and a folder of somebody else's are refused and create nothing", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, other] = await crew(ctx, ["owner", "other"]);
  const want = docIdFor(target, "a20-pub");
  const title = `A20 publish ${tag()}`;
  const content = page(title);
  const first = await publishMcp(o.mcp, { title, content, format: "html", id: want });
  assert.equal(first.isError, false, `publish_document: ${first.text.slice(0, 300)}`);
  const r = first.json;
  assert.deepEqual(
    { docId: r.docId, versionId: r.versionId, requestedId: r.requestedId, idTaken: r.idTaken, url: r.url, filedIn: r.filedIn, access: r.access, format: r.format, title: r.title, cursor: typeof r.cursor },
    { docId: want, versionId: "v1", requestedId: want, idTaken: false, url: url(want), filedIn: null, access: audienceOf(o.email), format: "html", title, cursor: "string" },
    "publish_document at a free id",
  );
  const rec = await readDoc(target, `docs/${want}`);
  const ver = await readDoc(target, `docs/${want}/versions/v1`);
  assert.deepEqual({ owner: rec?.ownerEmail, current: rec?.currentVersion, visibility: rec?.visibility ?? "private", via: ver?.publishedVia }, { owner: o.email, current: "v1", visibility: "private", via: "mcp" }, "the stored record");

  ctx.step("the same id again: not refused, suffixed, idTaken true; the first is untouched");
  const again = await publishMcp(o.mcp, { title: `${title} again`, content: page(`${title} again`), format: "html", id: want });
  assert.equal(again.isError, false, `publish_document at a taken id: ${again.text.slice(0, 300)}`);
  assert.equal(again.json.requestedId, want, "requestedId is what was asked for");
  assert.equal(again.json.idTaken, true, "idTaken");
  assert.match(again.json.docId, new RegExp(`^${want}-[a-z0-9]{6}$`), "the id is the requested one plus six random characters (SPEC §4)");
  assert.equal(again.json.url, url(again.json.docId), "the url names the id it got");
  const stillFirst = await record(want);
  assert.deepEqual({ title: stillFirst?.title, version: stillFirst?.currentVersion, owner: stillFirst?.ownerEmail }, { title, version: "v1", owner: o.email }, "the document at the taken id is unchanged");

  ctx.step("refused: a bad id, empty content, a missing folder (local) and somebody else's folder; nothing is created");
  const before = (await ok(o, "list_documents", {})).documents.length;
  await refused(o, "publish_document", { title: "A20 bad id", content: page("A20 bad id"), format: "html", id: "Not_A_Valid_Id" }, BAD_DOC_ID, "bad id");
  await refused(o, "publish_document", { title: "A20 empty", content: "   \n ", format: "html" }, CONTENT_EMPTY, "whitespace content");
  if (target.kind === "local") {
    await refused(o, "publish_document", { title: "A20 nowhere", content: page("A20 nowhere"), format: "html", folder: `a20nofolder${rand4()}` }, FOLDER_ABSENT, "a folder that is not there");
  } else ctx.step("the absent-folder probe is not sent on production: the guard refuses a folder the run did not create");
  const theirs = await folder(other, `A20 theirs ${tag()}`);
  await refused(o, "publish_document", { title: "A20 into theirs", content: page("A20 into theirs"), format: "html", folder: theirs }, FOLDER_NOT_YOURS, "somebody else's folder");
  assert.equal((await ok(o, "list_documents", {})).documents.length, before, "no refusal created a document");
});

scenario("A20.2.fork_document copies a version the caller can read into a private document they own at the root, with the original's bytes and lineage; a stranger and an absent id are told the id does not exist", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, v, x] = await crew(ctx, ["owner", "viewer", "stranger"]);
  const d = await publishDoc(o, "fork-src");
  const up = await ok(o, "update_document", { id: d.id, content: page(`${d.title} two`), baseVersion: "v1" });
  precondition(up.versionId === "v2", "the source has a v2");
  await shareAs(o, d.id, v, "viewer");

  ctx.step("the viewer forks v1 under a new title");
  const ftitle = `A20 forked ${tag()}`;
  const out = await forkAs(v, { id: d.id, version: "v1", title: ftitle });
  assert.equal(out.isError, false, `fork_document: ${out.text.slice(0, 300)}`);
  const f = out.json;
  assert.deepEqual(
    { versionId: f.versionId, title: f.title, filedIn: f.filedIn, access: f.access, url: f.url, cursor: typeof f.cursor, fresh: f.docId !== d.id },
    { versionId: "v1", title: ftitle, filedIn: null, access: audienceOf(v.email), url: url(f.docId), cursor: "string", fresh: true },
    "the fork",
  );
  const g = await ok(v, "get_document", { id: f.docId });
  assert.deepEqual({ source: g.source === d.content, forked: g.forked, visibility: g.visibility, canEdit: g.canEdit }, { source: true, forked: true, visibility: "private", canEdit: true }, "the fork holds v1's bytes, privately, as the viewer's");
  const row = (await ok(v, "list_documents", {})).documents.find((r) => r.id === f.docId);
  assert.deepEqual({ owner: row?.owner, forked: row?.forked }, { owner: v.email, forked: true }, "the viewer owns it");
  await refused(o, "get_document", { id: f.docId }, ABSENT(f.docId), "the original's owner cannot read the private fork");

  ctx.step("refused: a stranger, and an absent id, word for word");
  await refused(x, "fork_document", { id: d.id }, ABSENT(d.id), "stranger fork_document");
  const absent = absentDocId(target, "a20-fork-absent");
  await refused(x, "fork_document", { id: absent }, ABSENT(absent), "absent id fork_document");
});

scenario("A20.2.get_lineage names the original nearest first with changedSince, gives its owner a count of forks without naming one they cannot open; a stranger and an absent id are told the id does not exist", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, v, x] = await crew(ctx, ["owner", "viewer", "stranger"]);
  const d = await publishDoc(o, "lineage-src");
  await shareAs(o, d.id, v, "viewer");
  const out = await forkAs(v, { id: d.id });
  precondition(!out.isError, `fork_document: ${out.text.slice(0, 200)}`);
  const fork = out.json.docId;

  const l1 = await ok(v, "get_lineage", { id: fork });
  assert.deepEqual(
    l1,
    { id: fork, forked: true, forkedFrom: [{ id: d.id, title: d.title, version: "v1", owner: o.email, changedSince: false, url: url(d.id) }], moreYouCannotOpen: false, forks: { total: 0, youCannotOpen: 0, listed: [] } },
    "the fork's lineage, for its owner",
  );

  ctx.step("the original moves on: changedSince turns true");
  precondition((await ok(o, "update_document", { id: d.id, content: page(`${d.title} two`), baseVersion: "v1" })).versionId === "v2", "v2");
  const l2 = await ok(v, "get_lineage", { id: fork });
  assert.equal(l2.forkedFrom[0]?.changedSince, true, "changedSince after the original's v2");

  ctx.step("the original's owner: one fork, which they cannot open, counted and not named");
  const lo = await ok(o, "get_lineage", { id: d.id });
  assert.deepEqual(lo, { id: d.id, forked: false, forkedFrom: [], moreYouCannotOpen: false, forks: { total: 1, youCannotOpen: 1, listed: [] } }, "the original's lineage");

  ctx.step("refused: a stranger, and an absent id");
  await refused(x, "get_lineage", { id: d.id }, ABSENT(d.id), "stranger get_lineage");
  const absent = docIdFor(target, "a20-lineage-absent");
  await refused(x, "get_lineage", { id: absent }, ABSENT(absent), "absent id get_lineage");
});

scenario("A20.2.update_document mints the next version from its baseVersion, counts the open threads it leaves behind, and is a no-op for identical content; a stale baseVersion, a viewer, a suggester and empty content are refused with their own words and mint nothing", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, v, s] = await crew(ctx, ["owner", "viewer", "suggester"]);
  const d = await publishDoc(o, "update");
  await shareAs(o, d.id, v, "viewer");
  await shareAs(o, d.id, s, "suggester");
  const t = await ok(v, "add_comment", { id: d.id, exact: "quick brown fox", body: "An open thread on v1." });
  precondition(t.threadId, "a thread on v1");

  const v2 = page(`${d.title} two`);
  const r = await ok(o, "update_document", { id: d.id, content: v2, baseVersion: "v1" });
  assert.deepEqual(
    { versionId: r.versionId, deduped: r.deduped, threadsLeftBehind: r.threadsLeftBehind, url: r.url, hash: /^[0-9a-f]{64}$/.test(r.contentHash ?? "") },
    { versionId: "v2", deduped: false, threadsLeftBehind: 1, url: url(d.id), hash: true },
    "update_document from v1",
  );
  const rec = await readDoc(target, `docs/${d.id}/versions/v2`);
  assert.deepEqual({ via: rec?.publishedVia, parent: rec?.parentVersion, by: rec?.publishedByEmail }, { via: "mcp", parent: "v1", by: o.email }, "v2's record: via mcp, from v1, by the owner");
  assert.equal((await ok(o, "get_document", { id: d.id })).source, v2, "v2 holds the sent content");

  ctx.step("the same content again: deduped onto v2, nothing left behind");
  const same = await ok(o, "update_document", { id: d.id, content: v2, baseVersion: "v2" });
  assert.deepEqual({ versionId: same.versionId, deduped: same.deduped, threadsLeftBehind: same.threadsLeftBehind }, { versionId: "v2", deduped: true, threadsLeftBehind: 0 }, "identical content is a no-op");

  ctx.step("refused: a stale baseVersion, a viewer, a suggester, whitespace; still v2");
  await refused(o, "update_document", { id: d.id, content: page(`${d.title} stale`), baseVersion: "v1" }, STALE("v2", "v1"), "stale baseVersion");
  await refused(v, "update_document", { id: d.id, content: page("A20 viewer") }, CANNOT_EDIT, "viewer");
  await refused(s, "update_document", { id: d.id, content: page("A20 suggester") }, CANNOT_EDIT_BUT_SUGGEST, "suggester");
  await refused(o, "update_document", { id: d.id, content: "  \n" }, CONTENT_EMPTY, "whitespace content");
  assert.equal((await record(d.id))?.currentVersion, "v2", "no refusal moved the current version");
  assert.equal(await readDoc(target, `docs/${d.id}/versions/v3`), null, "no refusal minted a v3");
});

scenario("A20.2.commit_draft publishes the draft an accepted suggestion made as the next version; with no draft, with an open thread and for a viewer it is refused", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, v, s] = await crew(ctx, ["owner", "viewer", "suggester"]);
  const d = await publishDoc(o, "commit");
  await shareAs(o, d.id, v, "viewer");
  await shareAs(o, d.id, s, "suggester");

  ctx.step("refused before there is a draft: the owner (no draft) and a viewer");
  await refused(o, "commit_draft", { id: d.id }, NO_DRAFT, "owner, no draft");
  await refused(v, "commit_draft", { id: d.id }, CANNOT_COMMIT, "viewer");

  ctx.step("a suggestion accepted into the draft; an open comment holds the commit back");
  const sid = await suggestion(s, d.id, "sleepy cat");
  const acc = await ok(o, "accept_suggestion", { id: d.id, threadId: sid });
  precondition(acc.state === "accepted" && acc.inDraft === true, `accepted into the draft: ${JSON.stringify(acc)}`);
  const c = await ok(v, "add_comment", { id: d.id, exact: "Third paragraph", body: "Hold on." });
  await refused(o, "commit_draft", { id: d.id }, RESOLVE_FIRST, "an open thread");
  await ok(o, "resolve_thread", { id: d.id, threadId: c.threadId });

  ctx.step("commit_draft: v2 with the accepted change");
  const r = await ok(o, "commit_draft", { id: d.id });
  assert.deepEqual({ versionId: r.versionId, deduped: r.deduped, url: r.url }, { versionId: "v2", deduped: false, url: url(d.id) }, "commit_draft");
  const g = await ok(o, "get_document", { id: d.id });
  assert.equal(g.version, "v2", "current is v2");
  assert.ok(g.source.includes("The quick brown fox jumps over the sleepy cat.") && !g.source.includes("lazy dog"), `v2 holds the accepted change: ${g.source.slice(0, 400)}`);
  const rec = await readDoc(target, `docs/${d.id}/versions/v2`);
  assert.equal(rec?.publishedBy?.channel, "mcp", "v2 is stamped as published over mcp");
  await refused(o, "commit_draft", { id: d.id }, NO_DRAFT, "the draft went with the commit");
});

scenario("A20.2.suggest_edit opens a pending suggestion on a quoted passage of the current version, a repeat chosen by its prefix; a viewer, a passage not there, one across paragraphs, an ambiguous one, a missing replacement and one equal to its quote are refused", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, v, s] = await crew(ctx, ["owner", "viewer", "suggester"]);
  const d = await publishDoc(o, "suggest");
  await shareAs(o, d.id, v, "viewer");
  await shareAs(o, d.id, s, "suggester");

  const r = await ok(s, "suggest_edit", { id: d.id, exact: "lazy dog", replacement: "sleepy cat", note: "Kinder." });
  assert.deepEqual({ version: r.version, quote: r.quote, url: r.url, thread: typeof r.threadId }, { version: "v1", quote: "lazy dog", url: url(d.id), thread: "string" }, "suggest_edit");
  const t = await threadOf(o, d.id, r.threadId);
  assert.deepEqual({ quote: t?.quote, resolved: t?.resolved, suggestion: t?.suggestion, comments: t?.comments.map((c) => [c.author, c.via, c.body]) }, { quote: "lazy dog", resolved: false, suggestion: { replacement: "sleepy cat", state: "pending" }, comments: [[s.email, "mcp", "Kinder."]] }, "the owner reads it as a pending suggestion");

  ctx.step("a repeated passage, chosen by the words before it");
  const p = await ok(s, "suggest_edit", { id: d.id, exact: "alpha", prefix: "once and", replacement: "beta" });
  const ann = await readDoc(target, `docs/${d.id}/versions/v1/annotations/${p.threadId}`);
  assert.deepEqual({ exact: ann?.anchor?.exact, second: ann?.anchor?.prefix?.endsWith("alpha once and ") }, { exact: "alpha", second: true }, `the second alpha (prefix ${JSON.stringify(ann?.anchor?.prefix)})`);

  ctx.step("refused, with nothing written");
  const count = async () => (await readCollection(target, `docs/${d.id}/versions/v1/annotations`)).length;
  const n = await count();
  await refused(v, "suggest_edit", { id: d.id, exact: "lazy dog", replacement: "x" }, CANNOT_SUGGEST, "viewer");
  await refused(s, "suggest_edit", { id: d.id, exact: "not in this document", replacement: "x" }, NOT_IN_VERSION, "a passage not there");
  await refused(s, "suggest_edit", { id: d.id, exact: ACROSS, replacement: "x" }, SUGGEST_CROSSES, "a passage across paragraphs");
  await refused(s, "suggest_edit", { id: d.id, exact: "alpha", replacement: "x" }, OCCURS(2), "an ambiguous passage");
  await refused(s, "suggest_edit", { id: d.id, exact: "lazy dog" }, REPLACEMENT_REQUIRED, "no replacement");
  await refused(s, "suggest_edit", { id: d.id, exact: "lazy dog", replacement: "lazy dog" }, SAME_REPLACEMENT, "a replacement equal to its quote");
  assert.equal(await count(), n, "no refusal wrote an annotation");
});

scenario("A20.2.revise_suggestion changes its author's pending suggestion and keeps what it said before; another suggester, a missing replacement, a thread that is not a suggestion and a withdrawn one are refused", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, s, s2] = await crew(ctx, ["owner", "suggester", "suggester2"]);
  const d = await publishDoc(o, "revise");
  await shareAs(o, d.id, s, "suggester");
  await shareAs(o, d.id, s2, "suggester");
  const sid = await suggestion(s, d.id, "sleepy cat");

  const r = await ok(s, "revise_suggestion", { id: d.id, threadId: sid, replacement: "drowsy cat" });
  assert.deepEqual({ threadId: r.threadId, version: r.version, state: r.state, url: r.url }, { threadId: sid, version: "v1", state: "pending", url: url(d.id) }, "revise_suggestion");
  const t = await threadOf(o, d.id, sid);
  assert.deepEqual(
    { replacement: t?.suggestion?.replacement, state: t?.suggestion?.state, revisions: t?.suggestion?.revisions?.map((x) => [x.replacement, x.via, typeof x.at]) },
    { replacement: "drowsy cat", state: "pending", revisions: [["sleepy cat", "mcp", "string"]] },
    "the revision is kept",
  );

  ctx.step("refused");
  await refused(s2, "revise_suggestion", { id: d.id, threadId: sid, replacement: "x" }, NOT_AUTHOR_CHANGE, "another suggester");
  await refused(s, "revise_suggestion", { id: d.id, threadId: sid }, REPLACEMENT_REQUIRED, "no replacement");
  const c = await ok(o, "add_comment", { id: d.id, exact: "Third paragraph", body: "Not a suggestion." });
  await refused(s, "revise_suggestion", { id: d.id, threadId: c.threadId, replacement: "x" }, NO_SUCH_SUGGESTION, "a plain comment thread");
  await ok(s, "withdraw_suggestion", { id: d.id, threadId: sid });
  await refused(s, "revise_suggestion", { id: d.id, threadId: sid, replacement: "x" }, ALREADY("withdrawn"), "a withdrawn suggestion");
  assert.equal((await threadOf(o, d.id, sid))?.suggestion?.replacement, "drowsy cat", "no refusal changed it");
});

scenario("A20.2.withdraw_suggestion closes its author's pending suggestion as withdrawn, idempotently, leaving the thread; another suggester and an unknown thread are refused", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, s, s2] = await crew(ctx, ["owner", "suggester", "suggester2"]);
  const d = await publishDoc(o, "withdraw");
  await shareAs(o, d.id, s, "suggester");
  await shareAs(o, d.id, s2, "suggester");
  const sid = await suggestion(s, d.id);

  ctx.step("refused first: another suggester, an unknown thread");
  await refused(s2, "withdraw_suggestion", { id: d.id, threadId: sid }, NOT_AUTHOR_WITHDRAW, "another suggester");
  await refused(s, "withdraw_suggestion", { id: d.id, threadId: "a20NoSuchThread" }, NO_SUCH_SUGGESTION, "an unknown thread");
  assert.equal((await threadOf(o, d.id, sid))?.suggestion?.state, "pending", "still pending after the refusals");

  const r = await ok(s, "withdraw_suggestion", { id: d.id, threadId: sid });
  assert.deepEqual({ threadId: r.threadId, version: r.version, state: r.state, url: r.url }, { threadId: sid, version: "v1", state: "withdrawn", url: url(d.id) }, "withdraw_suggestion");
  const again = await ok(s, "withdraw_suggestion", { id: d.id, threadId: sid });
  assert.equal(again.state, "withdrawn", "withdrawing again is idempotent (SPEC §2)");
  const t = await threadOf(o, d.id, sid);
  assert.deepEqual({ state: t?.suggestion?.state, resolved: t?.resolved, notes: t?.comments.filter((c) => c.body === "Withdrawn.").length }, { state: "withdrawn", resolved: true, notes: 1 }, "the thread stays, closed, with one note");
  const open = await ok(o, "get_comments", { id: d.id });
  assert.equal(open.threads.some((x) => x.threadId === sid), false, "it is no longer listed as unresolved");
});

scenario("A20.2.accept_suggestion makes the change in the draft for the owner, idempotently; a suggester, an editor, an unknown thread and a rejected suggestion are refused", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, s, e] = await crew(ctx, ["owner", "suggester", "editor"]);
  const d = await publishDoc(o, "accept");
  await shareAs(o, d.id, s, "suggester");
  await shareAs(o, d.id, e, "editor");
  const sid = await suggestion(s, d.id, "sleepy cat");
  const rid = await ok(s, "suggest_edit", { id: d.id, exact: "closes the document", replacement: "ends it" });

  ctx.step("refused: a suggester, an editor, an unknown thread, a rejected suggestion");
  await refused(s, "accept_suggestion", { id: d.id, threadId: sid }, NOT_APPROVER, "suggester");
  await refused(e, "accept_suggestion", { id: d.id, threadId: sid }, NOT_APPROVER, "editor");
  await refused(o, "accept_suggestion", { id: d.id, threadId: "a20NoSuchThread" }, NO_SUCH_SUGGESTION, "an unknown thread");
  await ok(o, "reject_suggestion", { id: d.id, threadId: rid.threadId, reason: "No." });
  await refused(o, "accept_suggestion", { id: d.id, threadId: rid.threadId }, ALREADY("rejected"), "a rejected suggestion");
  assert.equal((await record(d.id))?.draft ?? null, null, "no refusal wrote a draft");

  const r = await ok(o, "accept_suggestion", { id: d.id, threadId: sid });
  assert.deepEqual(r, { threadId: sid, version: "v1", state: "accepted", inDraft: true, url: url(d.id) }, "accept_suggestion");
  const again = await ok(o, "accept_suggestion", { id: d.id, threadId: sid });
  assert.equal(again.state, "accepted", "accepting again reports the outcome (idempotent)");
  const rec = await record(d.id);
  assert.deepEqual({ draft: typeof rec?.draft?.entry, by: rec?.draft?.updatedByEmail, version: rec?.currentVersion }, { draft: "string", by: o.email, version: "v1" }, "the change is in a draft; no version was minted");
  const t = await threadOf(o, d.id, sid);
  assert.deepEqual({ state: t?.suggestion?.state, resolved: t?.resolved, notes: t?.comments.filter((c) => c.body === "Accepted.").length }, { state: "accepted", resolved: true, notes: 1 }, "the thread closes with one note");
});

scenario("A20.2.reject_suggestion declines a pending suggestion with the reason in its note, idempotently; an editor, a reason over the limit and an accepted suggestion are refused", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, s, e] = await crew(ctx, ["owner", "suggester", "editor"]);
  const d = await publishDoc(o, "reject");
  await shareAs(o, d.id, s, "suggester");
  await shareAs(o, d.id, e, "editor");
  const sid = await suggestion(s, d.id);
  const aid = (await ok(s, "suggest_edit", { id: d.id, exact: "closes the document", replacement: "ends it" })).threadId;

  ctx.step("refused: an editor, a 5,001-character reason, an accepted suggestion");
  await refused(e, "reject_suggestion", { id: d.id, threadId: sid }, NOT_APPROVER, "editor");
  await refused(o, "reject_suggestion", { id: d.id, threadId: sid, reason: "r".repeat(5001) }, "a reason may be at most 5000 characters", "a 5,001-character reason");
  await ok(o, "accept_suggestion", { id: d.id, threadId: aid });
  await refused(o, "reject_suggestion", { id: d.id, threadId: aid }, ALREADY("accepted"), "an accepted suggestion");
  assert.equal((await threadOf(o, d.id, sid))?.suggestion?.state, "pending", "still pending after the refusals");

  const r = await ok(o, "reject_suggestion", { id: d.id, threadId: sid, reason: "Not this one" });
  assert.deepEqual(r, { threadId: sid, version: "v1", state: "rejected", url: url(d.id) }, "reject_suggestion");
  const again = await ok(o, "reject_suggestion", { id: d.id, threadId: sid, reason: "Not this one" });
  assert.equal(again.state, "rejected", "rejecting again is idempotent");
  const t = await threadOf(o, d.id, sid);
  assert.deepEqual({ state: t?.suggestion?.state, resolved: t?.resolved, notes: t?.comments.filter((c) => c.body === "Rejected: Not this one").length }, { state: "rejected", resolved: true, notes: 1 }, "the thread closes with the reason, once");
});

scenario("A20.2.list_folders lists every folder the caller can see with its whole path, sorted by path; a stranger sees none of them", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 240_000,
}, async (ctx) => {
  const [o, x] = await crew(ctx, ["owner", "stranger"]);
  const pn = `A20 parent ${tag()}`;
  const parent = await folder(o, pn);
  const child = await folder(o, "Child", parent);
  const r = await ok(o, "list_folders", {});
  assert.deepEqual(
    r,
    {
      folders: [
        { id: parent, name: pn, parent: null, path: pn, canWrite: true, readers: 1, shared: false },
        { id: child, name: "Child", parent, path: `${pn}/Child`, canWrite: true, readers: 1, shared: false },
      ],
      truncated: false,
    },
    "list_folders",
  );
  ctx.step("refused: a stranger's listing holds none of them");
  const xs = await ok(x, "list_folders", {});
  assert.deepEqual(xs, { folders: [], truncated: false }, "a stranger sees no folder of the owner's");
});

scenario("A20.2.get_folder names who can read and edit a folder; a stranger and an absent folder id get the same refusal", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 240_000,
}, async (ctx) => {
  const [o, x] = await crew(ctx, ["owner", "stranger"]);
  const name = `A20 folder ${tag()}`;
  const f = await folder(o, name);
  const r = await ok(o, "get_folder", { id: f });
  assert.deepEqual(r, { id: f, name, path: name, owner: o.email, ...audienceOf(o.email), editors: [o.email], moreEditors: 0, canWrite: true }, "get_folder");
  ctx.step("refused: a stranger and an absent id, each as a folder that does not exist");
  await refused(x, "get_folder", { id: f }, NO_FOLDER(f), "stranger get_folder");
  const absent = `a20absent${rand4()}${rand4()}`;
  await refused(x, "get_folder", { id: absent }, NO_FOLDER(absent), "absent folder id");
});

scenario("A20.2.create_folder creates a folder at the root or inside one the caller may write to; a name over 120 characters, a blank name, a parent of somebody else's and a parent that is not there are refused and create nothing", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 240_000,
}, async (ctx) => {
  const [o, other] = await crew(ctx, ["owner", "other"]);
  const name = `A20 create ${tag()}`;
  const r = await createFolderAs(o, name);
  assert.equal(r.isError, false, `create_folder: ${r.text.slice(0, 200)}`);
  assert.deepEqual({ name: r.json.name, id: typeof r.json.folderId }, { name, id: "string" }, "create_folder at the root");
  const inner = await folder(o, "Inner", r.json.folderId);
  const listed = (await ok(o, "list_folders", {})).folders.find((x) => x.id === inner);
  assert.deepEqual({ parent: listed?.parent, path: listed?.path }, { parent: r.json.folderId, path: `${name}/Inner` }, "a child is created inside its parent");

  ctx.step("refused, and nothing created");
  const theirs = await folder(other, `A20 theirs ${tag()}`);
  await refused(o, "create_folder", { name: "n".repeat(121) }, FOLDER_NAME, "121 characters");
  await refused(o, "create_folder", { name: "   " }, FOLDER_NAME, "a blank name");
  await refused(o, "create_folder", { name: "Into theirs", parent: theirs }, FOLDER_NOT_YOURS, "a parent of somebody else's");
  if (target.kind === "local") await refused(o, "create_folder", { name: "Nowhere", parent: `a20nofolder${rand4()}` }, FOLDER_ABSENT, "a parent that is not there");
  else ctx.step("the absent-parent probe is not sent on production: the guard refuses a folder the run did not create");
  assert.equal((await ok(o, "list_folders", {})).folders.length, 2, "only the two folders exist");
});

scenario("A20.2.move_document files a document into a folder saying who can now read it, and with no folder moves it back to the root; a viewer and a folder of somebody else's are refused", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, v, other] = await crew(ctx, ["owner", "viewer", "other"]);
  const d = await publishDoc(o, "move");
  await shareAs(o, d.id, v, "viewer");
  const fname = `A20 move ${tag()}`;
  const f = await folder(o, fname);

  const into = await ok(o, "move_document", { id: d.id, folder: f });
  assert.deepEqual(into, { id: d.id, folder: f, filedIn: { id: f, path: fname }, access: audienceOf(o.email, v.email), url: url(d.id) }, "move_document into the folder");
  const row = (await ok(o, "list_documents", {})).documents.find((r) => r.id === d.id);
  assert.deepEqual(row?.filedIn, { id: f, path: fname }, "list_documents says where it is filed");

  ctx.step("no folder: back to the workspace root");
  const back = await ok(o, "move_document", { id: d.id });
  assert.deepEqual(back, { id: d.id, folder: null, filedIn: null, access: audienceOf(o.email, v.email), url: url(d.id) }, "move_document with no folder");
  assert.equal((await readDoc(target, `docs/${d.id}`))?.folderId ?? null, null, "the record is at the root");

  ctx.step("refused: a viewer, and a folder of somebody else's");
  await refused(v, "move_document", { id: d.id, folder: f }, CANNOT_MOVE, "viewer");
  const theirs = await folder(other, `A20 theirs ${tag()}`);
  await refused(o, "move_document", { id: d.id, folder: theirs }, FOLDER_NOT_YOURS, "somebody else's folder");
  assert.equal((await readDoc(target, `docs/${d.id}`))?.folderId ?? null, null, "still at the root");
});

scenario("A20.2.rename_document changes the title and keeps the id and address; a viewer, a title over 200 characters and a blank one are refused", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 240_000,
}, async (ctx) => {
  const [o, v] = await crew(ctx, ["owner", "viewer"]);
  const d = await publishDoc(o, "rename");
  await shareAs(o, d.id, v, "viewer");
  const title = `A20 renamed ${tag()}`;
  const r = await ok(o, "rename_document", { id: d.id, title: `  ${title}  ` });
  assert.deepEqual(r, { id: d.id, title, url: url(d.id) }, "rename_document (trimmed)");
  const g = await ok(v, "get_document", { id: d.id });
  assert.deepEqual({ id: g.id, title: g.title, url: g.url, source: g.source === d.content }, { id: d.id, title, url: url(d.id), source: true }, "the id, the address and the bytes stay");

  ctx.step("refused");
  await refused(v, "rename_document", { id: d.id, title: "A20 viewer" }, CANNOT_RENAME, "viewer");
  await refused(o, "rename_document", { id: d.id, title: "t".repeat(201) }, TITLE_RULE, "201 characters");
  await refused(o, "rename_document", { id: d.id, title: "   " }, TITLE_RULE, "a blank title");
  assert.equal((await record(d.id))?.title, title, "no refusal renamed it");
});

scenario("A20.2.get_comments returns each unresolved thread with its quote and comments, oldest first, at most 50 with truncated beyond; threads names ids; a stranger, an absent id and an unknown version are refused", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, v, x] = await crew(ctx, ["owner", "viewer", "stranger"]);
  const d = await publishDoc(o, "comments");
  await shareAs(o, d.id, v, "viewer");
  const first = await ok(v, "add_comment", { id: d.id, exact: "quick brown fox", body: "First thread." });
  const r1 = await ok(o, "get_comments", { id: d.id });
  assert.deepEqual(
    { ...r1, threads: r1.threads.map((t) => ({ ...t, comments: t.comments.map((c) => ({ ...c, id: typeof c.id, at: typeof c.at })) })) },
    {
      id: d.id,
      version: "v1",
      truncated: false,
      threads: [{ threadId: first.threadId, quote: "quick brown fox", section: "", resolved: false, awaitingReply: false, comments: [{ id: "string", at: "string", author: v.email, via: "mcp", body: "First thread." }] }],
    },
    "get_comments with one agent's thread (an agent's comment awaits no reply)",
  );

  // Setup, not the thing under test: seed.mjs's seedThreads opens them as
  // add_comment does, on production one guarded add_comment after another, on
  // a local stack one call and Admin copies of it, each a millisecond newer.
  // Every account is cast with comment email off, so none mails anyone.
  const seeded = await seedThreads(o.mcp, { docId: d.id, n: COMMENT_LIMIT, exact: "Third paragraph" });
  precondition(seeded.version === "v1" && seeded.threadIds.length === COMMENT_LIMIT, `seedThreads opened ${seeded.threadIds.length} threads on ${seeded.version}`);
  ctx.step(`setup: ${COMMENT_LIMIT} more threads by the owner (seedThreads via ${seeded.via}): ${COMMENT_LIMIT + 1} open in all`);
  const ids = [first.threadId, ...seeded.threadIds];
  const r = await ok(o, "get_comments", { id: d.id });
  assert.deepEqual(
    { truncated: r.truncated, count: r.threads.length, ids: r.threads.map((t) => t.threadId) },
    { truncated: true, count: COMMENT_LIMIT, ids: ids.slice(0, COMMENT_LIMIT) },
    "51 open threads: the oldest 50, truncated",
  );
  const all = await ok(o, "get_comments", { id: d.id, includeResolved: true });
  assert.deepEqual({ truncated: all.truncated, count: all.threads.length }, { truncated: true, count: COMMENT_LIMIT }, "includeResolved is capped too");
  const named = await ok(o, "get_comments", { id: d.id, threads: [ids[COMMENT_LIMIT]] });
  assert.deepEqual({ truncated: named.truncated, ids: named.threads.map((t) => t.threadId) }, { truncated: false, ids: [ids[COMMENT_LIMIT]] }, "threads: [the 51st] fetches exactly it");

  ctx.step("refused: a stranger, an absent id, an unknown version");
  await refused(x, "get_comments", { id: d.id }, ABSENT(d.id), "stranger get_comments");
  const absent = docIdFor(target, "a20-comments-absent");
  await refused(x, "get_comments", { id: absent }, ABSENT(absent), "absent id get_comments");
  await refused(o, "get_comments", { id: d.id, version: "v9" }, NO_VERSION("v9"), "an unknown version");
});

scenario("A20.2.get_changes from the cursor publish_document gave returns another reader's thread and comment, then nothing and the same cursor; a malformed cursor and another document's cursor are refused", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, v] = await crew(ctx, ["owner", "viewer"]);
  const d = await publishDoc(o, "changes");
  const other = await publishDoc(o, "changes-other");
  await shareAs(o, d.id, v, "viewer");
  const cursor0 = d.result.cursor;
  precondition(typeof cursor0 === "string" && cursor0, "publish_document gave a cursor");

  const t = await ok(v, "add_comment", { id: d.id, exact: "quick brown fox", body: "Watch this." });
  const seen = await eventually(async () => {
    const r = await ok(o, "get_changes", { id: d.id, since: cursor0 }, "get_changes poll");
    const kinds = r.events.map((e) => e.type).filter((k) => k === "thread.opened" || k === "comment.added");
    if (kinds.length < 2) throw new Error(`events so far: ${JSON.stringify(r.events.map((e) => e.type))}`);
    return r;
  }, { timeout: 120_000, interval: 1000, message: "thread.opened and comment.added reach the owner's feed" });
  // Two triggers record these, so either may land first: compared by type.
  const ev = seen.events.filter((e) => e.type === "thread.opened" || e.type === "comment.added").sort((a, b) => (a.type < b.type ? -1 : 1));
  assert.deepEqual(
    ev.map((e) => ({ type: e.type, by: e.by, channel: e.channel, version: e.version, threadId: e.threadId, quote: e.quote, ...(e.type === "comment.added" ? { body: e.body } : {}) })),
    [
      { type: "comment.added", by: v.email, channel: "mcp", version: "v1", threadId: t.threadId, quote: "quick brown fox", body: "Watch this." },
      { type: "thread.opened", by: v.email, channel: "mcp", version: "v1", threadId: t.threadId, quote: "quick brown fox" },
    ],
    "the viewer's thread and comment",
  );
  assert.deepEqual({ id: seen.id, url: seen.url, retryAfter: seen.retryAfter, more: seen.more }, { id: d.id, url: url(d.id), retryAfter: 60, more: false }, "the page's envelope");

  ctx.step("polls with the cursor each returns until one is quiet: that one returns nothing and the same cursor");
  let since = seen.cursor;
  let quiet = null;
  for (let i = 0; i < 10 && !quiet; i++) {
    const r = await ok(o, "get_changes", { id: d.id, since }, "a later poll");
    if (r.events.length === 0) quiet = { r, since };
    else since = r.cursor;
  }
  precondition(quiet, "a quiet poll within ten");
  assert.deepEqual({ events: quiet.r.events, cursor: quiet.r.cursor }, { events: [], cursor: quiet.since }, "a quiet poll returns the same cursor");

  ctx.step("refused: a malformed cursor, another document's cursor, no since");
  await refused(o, "get_changes", { id: d.id, since: "not-a-cursor" }, NOT_A_CURSOR, "a malformed cursor");
  await refused(o, "get_changes", { id: d.id, since: other.result.cursor }, OTHER_DOC_CURSOR(d.id), "another document's cursor");
  await refused(o, "get_changes", { id: d.id }, MISSING("get_changes", ["since"]), "no since");
});

scenario("A20.2.add_comment opens a thread on a quoted passage of the current version, stamped mcp, anchored strictly; a stranger, an absent id, a passage not there, one across paragraphs, an ambiguous one and a blank body are refused and write nothing", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, v, x] = await crew(ctx, ["owner", "viewer", "stranger"]);
  const d = await publishDoc(o, "add");
  await shareAs(o, d.id, v, "viewer");
  const r = await ok(v, "add_comment", { id: d.id, exact: "jumps over", body: "  Why jump?  " });
  assert.deepEqual({ version: r.version, quote: r.quote, url: r.url, thread: typeof r.threadId }, { version: "v1", quote: "jumps over", url: url(d.id), thread: "string" }, "add_comment");
  const ann = await readDoc(target, `docs/${d.id}/versions/v1/annotations/${r.threadId}`);
  assert.deepEqual(
    { exact: ann?.anchor?.exact, strict: ann?.anchor?.strict, author: ann?.authorEmail, channel: ann?.actor?.channel, tokenId: ann?.actor?.tokenId, resolved: ann?.resolved },
    { exact: "jumps over", strict: true, author: v.email, channel: "mcp", tokenId: v.tokenId, resolved: false },
    "the stored thread",
  );
  const cs = await readCollection(target, `docs/${d.id}/versions/v1/annotations/${r.threadId}/comments`);
  assert.deepEqual(cs.map((c) => [c.data.body, c.data.authorEmail, c.data.actor?.channel]), [["Why jump?", v.email, "mcp"]], "one comment, trimmed");
  const p = await ok(v, "add_comment", { id: d.id, exact: "alpha", suffix: "twice", body: "The second one." });
  const pa = await readDoc(target, `docs/${d.id}/versions/v1/annotations/${p.threadId}`);
  assert.equal(pa?.anchor?.suffix, " twice.", "a repeat chosen by the words after it");

  ctx.step("refused, and nothing written");
  const n = (await readCollection(target, `docs/${d.id}/versions/v1/annotations`)).length;
  await refused(x, "add_comment", { id: d.id, exact: "jumps over", body: "x" }, ABSENT(d.id), "stranger");
  const absent = absentDocId(target, "a20-add-absent");
  await refused(x, "add_comment", { id: absent, exact: "jumps over", body: "x" }, ABSENT(absent), "absent id");
  await refused(v, "add_comment", { id: d.id, exact: "not in this document", body: "x" }, NOT_IN_VERSION, "a passage not there");
  await refused(v, "add_comment", { id: d.id, exact: ACROSS, body: "x" }, COMMENT_CROSSES, "a passage across paragraphs");
  await refused(v, "add_comment", { id: d.id, exact: "alpha", body: "x" }, OCCURS(2), "an ambiguous passage");
  await refused(v, "add_comment", { id: d.id, exact: "jumps over", body: "   " }, BODY_EMPTY, "a blank body");
  assert.equal((await readCollection(target, `docs/${d.id}/versions/v1/annotations`)).length, n, "no refusal wrote a thread");
});

scenario("A20.2.reply_to_comment adds a reply to a thread on the current version; an unknown thread, a blank body, a thread left on an earlier version and a stranger are refused", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, v, x] = await crew(ctx, ["owner", "viewer", "stranger"]);
  const d = await publishDoc(o, "reply");
  await shareAs(o, d.id, v, "viewer");
  const t = await ok(v, "add_comment", { id: d.id, exact: "quick brown fox", body: "Question." });
  const r = await ok(o, "reply_to_comment", { id: d.id, threadId: t.threadId, body: "Answer." });
  assert.deepEqual({ threadId: r.threadId, documentId: r.documentId, commentId: typeof r.commentId }, { threadId: t.threadId, documentId: d.id, commentId: "string" }, "reply_to_comment");
  const th = await threadOf(o, d.id, t.threadId);
  assert.deepEqual(th?.comments.map((c) => [c.author, c.via, c.body]), [[v.email, "mcp", "Question."], [o.email, "mcp", "Answer."]], "the thread, oldest first");

  ctx.step("refused");
  await refused(o, "reply_to_comment", { id: d.id, threadId: "a20NoSuchThread", body: "x" }, NO_SUCH_THREAD, "an unknown thread");
  await refused(o, "reply_to_comment", { id: d.id, threadId: t.threadId, body: "   " }, BODY_EMPTY, "a blank body");
  await refused(x, "reply_to_comment", { id: d.id, threadId: t.threadId, body: "x" }, ABSENT(d.id), "stranger");
  precondition((await ok(o, "update_document", { id: d.id, content: page(`${d.title} two`) })).versionId === "v2", "v2");
  await refused(v, "reply_to_comment", { id: d.id, threadId: t.threadId, body: "Too late." }, NO_SUCH_THREAD, "a thread left on v1");
  assert.equal((await threadOf(o, d.id, t.threadId, { version: "v1" }))?.comments.length, 2, "no refusal added a comment");
});

scenario("A20.2.resolve_thread closes a thread with one Resolved. note and hides it, idempotently; a suggestion's thread and an unknown thread are refused", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, v, s] = await crew(ctx, ["owner", "viewer", "suggester"]);
  const d = await publishDoc(o, "resolve");
  await shareAs(o, d.id, v, "viewer");
  await shareAs(o, d.id, s, "suggester");
  const t = await ok(v, "add_comment", { id: d.id, exact: "quick brown fox", body: "Fix this." });
  const r = await ok(v, "resolve_thread", { id: d.id, threadId: t.threadId });
  assert.deepEqual(r, { threadId: t.threadId, version: "v1", resolved: true, url: url(d.id) }, "resolve_thread (any reader may)");
  const again = await ok(o, "resolve_thread", { id: d.id, threadId: t.threadId });
  assert.equal(again.resolved, true, "resolving again is harmless");
  const th = await threadOf(o, d.id, t.threadId);
  assert.deepEqual({ resolved: th?.resolved, notes: th?.comments.filter((c) => c.body === "Resolved.").map((c) => c.author) }, { resolved: true, notes: [v.email] }, "one Resolved. note, by who resolved it");
  assert.equal((await ok(o, "get_comments", { id: d.id })).threads.some((x) => x.threadId === t.threadId), false, "hidden from the unresolved list");

  ctx.step("refused: a suggestion's thread, an unknown thread");
  const sid = await suggestion(s, d.id);
  await refused(o, "resolve_thread", { id: d.id, threadId: sid }, SUGGESTION_NOT_RESOLVED, "a suggestion's thread");
  await refused(o, "resolve_thread", { id: d.id, threadId: "a20NoSuchThread" }, NO_SUCH_THREAD, "an unknown thread");
  assert.deepEqual((await threadOf(o, d.id, sid))?.suggestion?.state, "pending", "the suggestion is still pending");
});

scenario("A20.2.reopen_thread opens a resolved thread again with one Reopened. note; an unknown thread and a suggestion's thread are refused", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o, v, s] = await crew(ctx, ["owner", "viewer", "suggester"]);
  const d = await publishDoc(o, "reopen");
  await shareAs(o, d.id, v, "viewer");
  await shareAs(o, d.id, s, "suggester");
  const t = await ok(v, "add_comment", { id: d.id, exact: "quick brown fox", body: "Fix this." });
  await ok(o, "resolve_thread", { id: d.id, threadId: t.threadId });
  const r = await ok(o, "reopen_thread", { id: d.id, threadId: t.threadId });
  assert.deepEqual(r, { threadId: t.threadId, version: "v1", resolved: false, url: url(d.id) }, "reopen_thread");
  const again = await ok(o, "reopen_thread", { id: d.id, threadId: t.threadId });
  assert.equal(again.resolved, false, "reopening an open thread is harmless");
  const th = await threadOf(o, d.id, t.threadId);
  assert.deepEqual({ resolved: th?.resolved, notes: th?.comments.filter((c) => c.body === "Reopened.").length }, { resolved: false, notes: 1 }, "one Reopened. note");
  assert.equal((await ok(o, "get_comments", { id: d.id })).threads.some((x) => x.threadId === t.threadId), true, "listed as unresolved again");

  ctx.step("refused: an unknown thread, a suggestion's thread");
  await refused(o, "reopen_thread", { id: d.id, threadId: "a20NoSuchThread" }, NO_SUCH_THREAD, "an unknown thread");
  const sid = await suggestion(s, d.id);
  await refused(o, "reopen_thread", { id: d.id, threadId: sid }, SUGGESTION_NOT_RESOLVED, "a suggestion's thread");
});

// --- A20.3 ----------------------------------------------------------------------------

/** On production the guard refuses an act or comment tool that names no run document. */
const guardedWithoutId = (name) => target.kind !== "local" && (ACT_TOOLS.has(name) || COMMENT_TOOLS.has(name));

scenario("A20.3 a missing or empty required argument is a tool error naming exactly the missing ones, for every tool that requires any; an unknown tool and an unknown method are -32601, a message without a method -32600, a non-JSON body -32700; a notification is 202 and a batch answers its requests in order", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o] = await crew(ctx, ["owner"]);
  const d = await publishDoc(o, "rpc");
  const tools = await o.mcp.listTools();
  const bad = [];
  const sent = [];
  for (const t of tools) {
    const req = t.inputSchema?.required ?? [];
    if (req.length === 0) continue;
    const probes = [];
    // Everything missing, and the same with every required argument an empty string.
    if (!guardedWithoutId(t.name)) {
      probes.push([{}, req]);
      probes.push([Object.fromEntries(req.map((k) => [k, ""])), req]);
    }
    // The id given, the rest missing: the guard lets this through everywhere.
    if (req.includes("id") && req.length > 1) probes.push([{ id: t.name === "get_folder" ? "x" : d.id }, req.filter((k) => k !== "id")]);
    for (const [args, missing] of probes) {
      const out = await callAs(o, t.name, args);
      sent.push(`${t.name} ${JSON.stringify(args)}`);
      const want = MISSING(t.name, missing);
      if (!out.isError || out.text !== want) bad.push(`${t.name} ${JSON.stringify(args)}: want ${JSON.stringify(want)}, got isError=${out.isError} ${JSON.stringify(out.text.slice(0, 160))}`);
    }
  }
  ctx.step(`${sent.length} missing-argument probes`);
  assert.deepEqual(bad, [], "missing arguments are named exactly");
  const requiring = tools.filter((t) => (t.inputSchema?.required ?? []).length > 0).map((t) => t.name);
  const unprobed = requiring.filter((n) => !sent.some((x) => x.startsWith(`${n} `)));
  if (target.kind === "local") assert.deepEqual(unprobed, [], "every tool that requires an argument was probed");
  else ctx.step(`not probed on ${target.kind} (the guard needs a run document's id): ${unprobed.join(", ")}`);
  assert.equal(requiring.length, 29, `tools that require an argument: ${requiring.join(", ")}`);
  const doc = await record(d.id);
  assert.deepEqual({ version: doc?.currentVersion, title: doc?.title }, { version: "v1", title: d.title }, "no probe changed the document");

  ctx.step("an unknown tool and an unknown method: -32601");
  const unknown = `e2e_no_such_tool_${rand4()}`;
  const u = await o.mcp.rpc("tools/call", { name: unknown, arguments: {} });
  assert.deepEqual(u.error, { code: -32601, message: `no tool named "${unknown}"` }, "unknown tool");
  const m = await o.mcp.rpc("e2e/no_such_method", {});
  assert.deepEqual(m.error, { code: -32601, message: 'unknown method "e2e/no_such_method"' }, "unknown method");

  ctx.step("not a request: -32600; not JSON (text/plain): HTTP 400 -32700");
  const nr = answered((await o.mcp.raw({ jsonrpc: "2.0", id: 7 })).response, "POST /mcp without a method");
  assert.deepEqual({ status: nr.status, error: nr.json?.error }, { status: 200, error: { code: -32600, message: "not a JSON-RPC request" } }, "a message without a method");
  const pj = answered((await o.mcp.raw("{not json", { headers: { "content-type": "text/plain" } })).response, "POST /mcp of text/plain");
  assert.deepEqual({ status: pj.status, body: pj.json }, { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } } }, "a body that is not JSON");

  ctx.step("a notification: 202 and no body; a batch: one answer per request, in order");
  const n = answered((await o.mcp.raw({ jsonrpc: "2.0", method: "notifications/initialized" })).response, "POST /mcp of a notification");
  assert.deepEqual({ status: n.status, text: n.text }, { status: 202, text: "" }, "a notification");
  const b = await o.mcp.batch([{ method: "ping", id: 101 }, { method: "notifications/initialized", notification: true }, { method: "e2e/no_such_method", id: 102 }, { method: "tools/call", id: 103, params: { name: "get_document", arguments: {} } }]);
  answered(b.res.response, "POST /mcp of a batch");
  assert.equal(b.status, 200, "a batch");
  assert.deepEqual(
    b.messages.map((x) => ({ id: x.id, result: x.result && !x.result.content ? x.result : undefined, error: x.error?.code, isError: x.result?.isError })),
    [{ id: 101, result: {}, error: undefined, isError: undefined }, { id: 102, result: undefined, error: -32601, isError: undefined }, { id: 103, result: undefined, error: undefined, isError: true }],
    "answers for 101, 102 and 103, none for the notification",
  );
});

scenario("A20.3.parse a malformed body sent as application/json is answered as the JSON-RPC parse error, -32700, with private, no-store and the exposed WWW-Authenticate like every /mcp response", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  defect: "X-a20-mcp-1",
  timeoutMs: 240_000,
}, async (ctx) => {
  const [o] = await crew(ctx, ["owner"]);
  const r = await o.mcp.raw("{not json", { headers: { "content-type": "application/json" } });
  answered(r.response, "POST /mcp of malformed application/json");
  ctx.step(`answer: ${r.status} ${r.headers.get("content-type")} cache-control=${r.headers.get("cache-control")} expose=${r.headers.get("access-control-expose-headers")} ${JSON.stringify(r.text.slice(0, 160))}`);
  ctx.ev.json("parse-error-answer", { status: r.status, headers: Object.fromEntries(r.headers), text: r.text.slice(0, 2000) });
  assert.deepEqual(
    { status: r.status, cache: r.headers.get("cache-control"), expose: r.headers.get("access-control-expose-headers"), body: r.json },
    { status: 400, cache: "private, no-store", expose: "WWW-Authenticate", body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } } },
    "a malformed application/json body: the JSON-RPC parse error with /mcp's headers (SPEC §23, ADR 0009)",
  );
});

// --- A20.4 ----------------------------------------------------------------------------

/** A random credential in the shape of a personal token, built at run time. */
const fakeToken = () => `bsk_${randomBytes(16).toString("hex")}.${randomBytes(24).toString("base64url")}`;
const fakeAccess = () => `bsa_${randomBytes(16).toString("hex")}.${randomBytes(32).toString("base64url").slice(0, 43)}`;

scenario("A20.4 POST /mcp without a credential is 401 with the Bearer challenge naming the protected-resource metadata; a malformed, unknown, revoked or access-token-shaped credential adds error=\"invalid_token\"; every answer is private, no-store and exposes WWW-Authenticate; GET and DELETE are 405 JSON-RPC, PUT 405 with Allow: POST", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const [o] = await crew(ctx, ["owner"]);
  const challenge = `Bearer realm="bikeshed", resource_metadata="${target.origin}/.well-known/oauth-protected-resource/mcp"`;
  const invalid = `${challenge}, error="invalid_token"`;
  const body401 = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "sign in to connect, or send a personal access token" } };
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  const rows = [];
  const call = async (label, method, auth, body) => {
    const http = patientHttp(ctx, { actor: `a20-${label.replace(/\W+/g, "-")}` });
    const r = await http.request(method, "/mcp", {
      headers: { accept: "application/json, text/event-stream", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(auth ? { authorization: auth } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    rows.push({ label, status: r.status, cache: r.headers.get("cache-control"), expose: r.headers.get("access-control-expose-headers"), www: r.headers.get("www-authenticate"), allow: r.headers.get("allow") });
    return answered(r, `${method} /mcp (${label})`);
  };

  ctx.step("401s");
  const none = await call("no credential", "POST", null, ping);
  assert.deepEqual({ status: none.status, www: none.headers.get("www-authenticate"), body: none.json }, { status: 401, www: challenge, body: body401 }, "no credential");
  for (const [label, auth] of [["malformed", "Bearer not-a-token"], ["unknown token", `Bearer ${fakeToken()}`], ["access-token shape", `Bearer ${fakeAccess()}`]]) {
    const r = await call(label, "POST", auth, ping);
    assert.deepEqual({ status: r.status, www: r.headers.get("www-authenticate"), body: r.json }, { status: 401, www: invalid, body: body401 }, label);
  }
  const live = o.session;
  const minted = await mintToken(live, { name: "e2e a20 revoke", channel: "mcp" });
  const before = await call("a live token", "POST", `Bearer ${minted.token}`, ping);
  assert.deepEqual({ status: before.status, body: before.json }, { status: 200, body: { jsonrpc: "2.0", id: 1, result: {} } }, "the token works before it is revoked");
  const rv = answered(await revokeToken(live, minted.tokenId), "POST /tokens revoke");
  precondition(rv.status === 200, `revoke: ${rv.status}`);
  const revoked = await call("a revoked token", "POST", `Bearer ${minted.token}`, ping);
  assert.deepEqual({ status: revoked.status, www: revoked.headers.get("www-authenticate"), body: revoked.json }, { status: 401, www: invalid, body: body401 }, "a revoked token");

  ctx.step("the challenge names metadata that exists and names this endpoint");
  const prm = answered(await patientHttp(ctx, { actor: "a20-prm" }).get("/.well-known/oauth-protected-resource/mcp"));
  assert.deepEqual({ status: prm.status, resource: prm.json?.resource }, { status: 200, resource: `${target.origin}/mcp` }, "the protected-resource metadata");

  ctx.step("405s: GET and DELETE as JSON-RPC, PUT with Allow: POST; with or without a credential");
  const post405 = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "this server is POST-only" } };
  for (const [label, method, auth] of [["GET", "GET", null], ["GET with a token", "GET", `Bearer ${o.token}`], ["DELETE", "DELETE", null]]) {
    const r = await call(label, method, auth);
    assert.deepEqual({ status: r.status, body: r.json }, { status: 405, body: post405 }, label);
  }
  const put = await call("PUT", "PUT", null, {});
  assert.deepEqual({ status: put.status, allow: put.headers.get("allow"), text: put.text }, { status: 405, allow: "POST", text: "" }, "PUT");
  const notif = await call("a notification", "POST", `Bearer ${o.token}`, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notif.status, 202, "a notification");

  ctx.step("every answer: private, no-store and Access-Control-Expose-Headers: WWW-Authenticate");
  ctx.ev.json("mcp-headers", rows);
  const wrong = rows.filter((r) => r.cache !== "private, no-store" || r.expose !== "WWW-Authenticate").map((r) => `${r.label} ${r.status}: cache-control=${r.cache} expose=${r.expose}`);
  assert.deepEqual(wrong, [], "the /mcp headers on every answer (SPEC §23)");
});

// --- A20.5 ----------------------------------------------------------------------------

scenario("A20.5 X-Bikeshed-Client and X-Bikeshed-Agent are stored verbatim on the version, the thread, the comment, the reply and the read an MCP call makes; the channel is mcp even for a token minted for the CLI, the tokenId is that token's, and without the headers the actor carries neither", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 420_000,
}, async (ctx) => {
  const CLIENT = `bikeshed-e2e-client/1.2.3 (a20; ${rand4()})`;
  const AGENT = `e2e-agent model=test-${rand4()} "quoted" [bracketed]`;
  const [acct] = await cast(target, ["owner"], { notifications: false });
  const o = await agentFor(ctx, acct, { channel: "cli", headers: { "x-bikeshed-client": CLIENT, "x-bikeshed-agent": AGENT } });
  const bare = mcpFor(ctx, o.token, "owner-bare", { "x-bikeshed-agent": null });
  await bare.initialize();
  const want = { uid: acct.uid, email: acct.email, channel: "mcp", tokenId: o.tokenId, client: CLIENT, agent: AGENT };
  const wantBare = { uid: acct.uid, email: acct.email, channel: "mcp", tokenId: o.tokenId };
  ctx.step(`a token minted for the cli (${o.tokenId}), used over /mcp with both headers`);

  const d = await publishDoc(o, "provenance");
  const v1 = await readDoc(target, `docs/${d.id}/versions/v1`);
  assert.deepEqual(v1?.publishedBy, want, "v1.publishedBy");
  await ok(o, "get_document", { id: d.id });
  const view = await eventually(async () => (await readDoc(target, `docs/${d.id}/views/api-${o.tokenId}-v1`)) ?? false, { timeout: 30_000, message: "the read's view session" });
  assert.deepEqual({ actor: view.actor, automated: view.automated, ms: view.ms }, { actor: want, automated: true, ms: 0 }, "the automated read (SPEC §17)");
  const t = await ok(o, "add_comment", { id: d.id, exact: "quick brown fox", body: "Provenance." });
  const ann = await readDoc(target, `docs/${d.id}/versions/v1/annotations/${t.threadId}`);
  assert.deepEqual(ann?.actor, want, "the thread's actor");
  const cs = await readCollection(target, `docs/${d.id}/versions/v1/annotations/${t.threadId}/comments`);
  assert.deepEqual(cs.map((c) => c.data.actor), [want], "the comment's actor");

  ctx.step("the same token without either header: no client, no agent");
  const reply = await bare.call("reply_to_comment", { id: d.id, threadId: t.threadId, body: "Bare." });
  assert.equal(reply.isError, false, reply.text);
  const rc = await readDoc(target, `docs/${d.id}/versions/v1/annotations/${t.threadId}/comments/${reply.json.commentId}`);
  assert.deepEqual(rc?.actor, wantBare, "a reply sent with no self-reported headers");
  const up = await bare.call("update_document", { id: d.id, content: page(`${d.title} two`) });
  assert.equal(up.isError, false, up.text);
  assert.deepEqual((await readDoc(target, `docs/${d.id}/versions/v2`))?.publishedBy, wantBare, "v2.publishedBy without the headers");
  const via = (await threadOf(o, d.id, t.threadId, { version: "v1" }))?.comments.map((c) => c.via);
  assert.deepEqual(via, ["mcp", "mcp"], "get_comments says via mcp for both");
});

// --- A20.6 ----------------------------------------------------------------------------

/** An unlisted, open-editing document of the owner's, its key, and a stranger with no grant. */
async function unlistedOpen(ctx, name) {
  const [o, x] = await crew(ctx, ["owner", "stranger"]);
  const d = await publishDoc(o, name);
  let vis;
  try {
    vis = await setVisibility(target, { owner: o.session, doc: d.id, visibility: "unlisted", publicEdit: true, timeoutMs: CALL_MS });
  } catch (err) {
    // LIB-REQUEST: cutoff-opens-window — grant.mjs setVisibility settles a
    // 504 as a refusal ("nothing changed on the server") and forgets the
    // window, but Hosting's cut-off 504 only means the function had not
    // answered within 60 s: it ran on, and the document was left unlisted
    // with nobody to close it (e2e-44wr3h-a20-key-extra-1o7u, invocation
    // 20261012T053104Z-p46960-xyr2, found unlisted hours later and made
    // private by hand). So a request the stack did not answer registers the
    // window again, and the case's teardown closes it.
    if (stackDidNotAnswer(err)) trackWindow(target, { owner: o.session, doc: d.id, visibility: "unlisted" });
    throw err;
  }
  precondition(vis.status === 200 && vis.linkToken, `unlisted with open editing: ${vis.status}`);
  return { o, x, d, k: vis.linkToken };
}

/** How many times a case asks for its unlisted document to be private again before its teardown takes over. */
const CLOSE_TRIES = 3;

// LIB-REQUEST: teardown-cutoff — test.mjs closeCaseWindows(true) FAILS a case
// whose body passed (E2E_WINDOW_OPEN) when its two tries both meet Hosting's
// cut-off, though the product judged nothing wrong; under
// inconclusiveOnStackTimeout it could keep trying while the case has time, or
// end the case INCONCLUSIVE when the window then closes. makePrivateAgain()
// below is the local workaround.
/**
 * The owner makes the document private again, as the case's last act, asking
 * up to CLOSE_TRIES times while the stack does not answer. The teardown
 * scenario() runs (lib/test.mjs closeCaseWindows) tries twice and FAILS a case
 * whose body passed when both tries meet Hosting's 60 s cut-off, though
 * nothing of the product was judged wrong: on the loaded shared stack the
 * teardown of A20.6.extra got 504 at 60 s twice, and the retry a minute later
 * closed it in 458 ms (invocation 20261012T124044Z-p81473-524d). A cut-off 504
 * keeps the window registered (setVisibility restores it on any status but
 * 200), so whatever is still open after these tries is the teardown's again,
 * and it still fails the case. Anything but the stack not answering throws.
 */
async function makePrivateAgain(ctx, owner, docId) {
  for (let i = 1; i <= CLOSE_TRIES; i++) {
    try {
      const r = await setVisibility(target, { owner: owner.session, doc: docId, visibility: "private", expect: [200, 504], timeoutMs: CALL_MS });
      if (r.status === 200) {
        // setVisibility forgets the window on any 200, so this is the only check of it.
        assert.equal(r.visibility, "private", `POST /visibility private answered 200 with visibility ${JSON.stringify(r.visibility)}`);
        ctx.step(`${docId} is private again${i > 1 ? ` (try ${i})` : ""}`);
        return;
      }
      ctx.step(`try ${i} of ${CLOSE_TRIES} to make ${docId} private: ${notAnswered(r.response)}`);
    } catch (err) {
      const why = stackDidNotAnswer(err);
      if (!why) throw err;
      ctx.step(`try ${i} of ${CLOSE_TRIES} to make ${docId} private: ${why}`);
    }
  }
}

/** A short account of a /visibility answer that was not 200. */
const notAnswered = (r) => (isHostingCutoff(r) ? `504 after ${Math.round(r.ms)} ms, Hosting's cut-off` : `${r.status} after ${Math.round(r.ms ?? 0)} ms`);

scenario("A20.6 a link key opens an unlisted open-editing document to a non-member on each of the nine tools SPEC §19 names; without it, or with a wrong one, each answers exactly as for an id that does not exist", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 600_000,
}, async (ctx) => {
  const { o, x, d, k } = await unlistedOpen(ctx, "key");
  const wrongK = `${k.slice(0, -2)}${k.endsWith("aa") ? "bb" : "aa"}`;
  let threadId = null;
  const steps = [
    ["get_document", () => ({ id: d.id }), (r) => r.source === d.content && r.canEdit === true],
    ["get_comments", () => ({ id: d.id }), (r) => Array.isArray(r.threads) && r.version === "v1"],
    ["get_changes", () => ({ id: d.id, since: "all" }), (r) => r.id === d.id && r.state?.canEdit === true],
    ["add_comment", () => ({ id: d.id, exact: "quick brown fox", body: "With the key." }), (r) => typeof (threadId = r.threadId) === "string"],
    ["reply_to_comment", () => ({ id: d.id, threadId, body: "Still with the key." }), (r) => r.threadId === threadId],
    ["resolve_thread", () => ({ id: d.id, threadId }), (r) => r.resolved === true],
    ["reopen_thread", () => ({ id: d.id, threadId }), (r) => r.resolved === false],
    ["update_document", () => ({ id: d.id, content: page(`${d.title} by link`), baseVersion: "v1" }), (r) => r.versionId === "v2"],
    ["suggest_edit", () => ({ id: d.id, exact: "lazy dog", replacement: "sleepy cat" }), (r) => r.version === "v2"],
  ];
  assert.deepEqual(steps.map((s) => s[0]).sort(), [...KEY_TOOLS].sort(), "the nine of SPEC §19");
  const log = [];
  for (const [tool, args, good] of steps) {
    for (const [label, extra] of [["no k", {}], ["wrong k", { k: wrongK }]]) {
      const out = await x.mcp.call(tool, { ...args(), ...extra });
      log.push({ tool, label, isError: out.isError, text: out.text.slice(0, 120) });
      assert.deepEqual({ isError: out.isError, text: out.text }, { isError: true, text: ABSENT(d.id) }, `${tool} ${label}: the absent id's answer`);
    }
    const out = await x.mcp.call(tool, { ...args(), k });
    log.push({ tool, label: "k", isError: out.isError, text: out.text.slice(0, 120) });
    assert.equal(out.isError, false, `${tool} with k: ${out.text.slice(0, 200)}`);
    assert.ok(good(out.json), `${tool} with k did what it does: ${out.text.slice(0, 300)}`);
  }
  ctx.ev.json("key-calls", log);

  ctx.step("using the key recorded no grant: without it, still the absent id's answer");
  await refused(x, "get_document", { id: d.id }, ABSENT(d.id), "get_document without k after the keyed calls");
  const rec = await readDoc(target, `docs/${d.id}/versions/v2`);
  assert.equal(rec?.publishedBy?.email, x.email, "v2 is the link holder's");
  await makePrivateAgain(ctx, o, d.id);
});

scenario("A20.6.extra fork_document, get_lineage, revise_suggestion and withdraw_suggestion take the key too (SPEC §21, §22), and the tools that decide, commit, rename or move never do: with the key a non-member still gets the absent id's answer", {
  tiers: BOTH,
  inconclusiveOnStackTimeout: true,
  timeoutMs: 600_000,
}, async (ctx) => {
  const { o, x, d, k } = await unlistedOpen(ctx, "key-extra");
  const sid = (await ok(x, "suggest_edit", { id: d.id, exact: "lazy dog", replacement: "sleepy cat", k })).threadId;
  const takes = [
    ["get_lineage", { id: d.id }, (r) => r.id === d.id && r.forked === false],
    ["revise_suggestion", { id: d.id, threadId: sid, replacement: "drowsy cat" }, (r) => r.state === "pending"],
    ["withdraw_suggestion", { id: d.id, threadId: sid }, (r) => r.state === "withdrawn"],
    ["fork_document", { id: d.id }, (r) => typeof r.docId === "string" && r.versionId === "v1"],
  ];
  for (const [tool, args, good] of takes) {
    await refused(x, tool, args, ABSENT(d.id), `${tool} without k`);
    const out = tool === "fork_document" ? await forkAs(x, { ...args, k }) : await x.mcp.call(tool, { ...args, k });
    assert.equal(out.isError, false, `${tool} with k: ${out.text.slice(0, 200)}`);
    assert.ok(good(out.json), `${tool} with k: ${out.text.slice(0, 300)}`);
  }
  const sid2 = (await ok(x, "suggest_edit", { id: d.id, exact: "closes the document", replacement: "ends it", k })).threadId;
  ctx.step("never a key: accept, reject, commit, rename, move");
  for (const [tool, args] of [
    ["accept_suggestion", { id: d.id, threadId: sid2 }],
    ["reject_suggestion", { id: d.id, threadId: sid2 }],
    ["commit_draft", { id: d.id }],
    ["rename_document", { id: d.id, title: "A20 by key" }],
    ["move_document", { id: d.id }],
  ]) {
    await refused(x, tool, { ...args, k }, ABSENT(d.id), `${tool} with k`);
  }
  const g = await record(d.id);
  assert.deepEqual({ title: g?.title, version: g?.currentVersion, folder: g?.folderId ?? null, draft: g?.draft ?? null }, { title: d.title, version: "v1", folder: null, draft: null }, "nothing a refused call could change changed");
  assert.equal((await threadOf(o, d.id, sid2))?.suggestion?.state, "pending", "the second suggestion is still pending");
  await makePrivateAgain(ctx, o, d.id);
});
