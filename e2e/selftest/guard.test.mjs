// SPDX-License-Identifier: Apache-2.0
// Self-test: the zero-email guard covers every function that can send email, and every choke point asks it (SPEC §12).

/**
 * Parity, from the product's own source:
 *   - every onRequest export in functions/src/index.ts that is bound to
 *     RESEND_API_KEY or reaches an email helper (sendInvitations,
 *     sendCommentNotice, sendVerificationCode, sendEmail — transitively through
 *     local functions) maps through firebase.json's rewrites to paths, and each
 *     path must be refused by an email rule on production;
 *   - every Firestore trigger bound to the secret must be in TRIGGER_COVERAGE,
 *     and for the comment trigger, every path that writes a comment — the MCP
 *     tools and the HTTP endpoints, found the same transitive way — must be
 *     comment-gated (assertQuietDoc before it goes);
 *   - every MCP tool in tools.ts is classified, and no classified name is stale.
 *
 * The negative controls are built in: removing ANY single rule from a copy of
 * the policy must make parity report a gap.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";
import { DEFAULT_POLICY, EMAIL_ROUTES, TRIGGER_COVERAGE, UNKNOWN_TOOL_PREFIX, createGuard, evaluate, installGuard, cliIntent } from "../lib/guard.mjs";
import { createHttp } from "../lib/http.mjs";
import { runCli } from "../lib/cli.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const INDEX_TS = readFileSync(join(REPO_ROOT, "functions", "src", "index.ts"), "utf8");
const TOOLS_TS = ["tools.ts", "management.ts"].map(name => readFileSync(join(REPO_ROOT, "functions", "src", "mcp", name), "utf8")).join("\n");
const FIREBASE_JSON = JSON.parse(readFileSync(join(REPO_ROOT, "firebase.json"), "utf8"));

const EMAIL_HELPERS = ["sendInvitations", "sendCommentNotice", "sendVerificationCode", "sendEmail"];
const COMMENT_WRITERS = ["createSuggestion", "changeSuggestion", "setThreadResolved", "acceptSuggestion"];
const COMMENT_WRITE_RE = /collection\("comments"\)\s*\.doc\(/;

const PROD = Object.freeze({ kind: "prod", runId: "selftest-guard", origin: "https://guard-selftest.invalid", runDir: tempDir("e2e-guard-") });
const LEDGER = { ledgerDocs: new Set(["ledger-doc"]), ledgerFolders: new Set(["ledger-folder"]) };

/** Top-level declarations of a TypeScript file: [{name, exported, text}]. */
function blocks(text) {
  const out = [];
  const lines = text.split("\n");
  let cur = null;
  const start = /^(export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*[=:])/;
  for (const line of lines) {
    const m = start.exec(line);
    if (m) {
      cur = { name: m[2] ?? m[3], exported: Boolean(m[1]), text: "" };
      out.push(cur);
    }
    if (cur) cur.text += line + "\n";
  }
  return out;
}

const calls = (text, names) => names.some((n) => new RegExp(`\\b${n}\\s*[(<]`).test(text));

/** Names that transitively reach `seeds` (calls) or match `re`, through local functions. */
function closure(all, seeds, re) {
  const reach = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of all) {
      if (reach.has(b.name)) continue;
      if (calls(b.text, [...reach]) || (re && re.test(b.text))) {
        reach.add(b.name);
        grew = true;
      }
    }
  }
  return reach;
}

function mailingFunctions() {
  const all = blocks(INDEX_TS);
  const secretConsts = all.filter((b) => !b.exported && /RESEND_API_KEY/.test(b.text)).map((b) => b.name);
  const reach = closure(all.filter((b) => !b.exported), EMAIL_HELPERS);
  return all
    .filter((b) => b.exported && /\bon(Request|Document\w+)\(/.test(b.text))
    .filter((b) => /RESEND_API_KEY/.test(b.text) || secretConsts.some((c) => new RegExp(`\\b${c}\\b`).test(b.text)) || calls(b.text, [...reach]))
    .map((b) => ({ name: b.name, trigger: !/\bonRequest\(/.test(b.text), document: /document:\s*\n?\s*"([^"]+)"/.exec(b.text)?.[1] ?? null }));
}

function commentWritingEndpoints() {
  const all = blocks(INDEX_TS);
  const reach = closure(all.filter((b) => !b.exported), COMMENT_WRITERS, COMMENT_WRITE_RE);
  return all.filter((b) => b.exported && /\bonRequest\(/.test(b.text) && (calls(b.text, [...reach]) || COMMENT_WRITE_RE.test(b.text))).map((b) => b.name);
}

/** [{name, text}] for each tool in tools.ts. */
function toolBlocks() {
  const parts = TOOLS_TS.split(/\n  \{\n    name: "/).slice(1);
  return parts.map((p) => ({ name: p.slice(0, p.indexOf('"')), text: p }));
}

function commentWritingTools() {
  const helpers = closure(blocks(TOOLS_TS).filter((b) => !b.exported), COMMENT_WRITERS, COMMENT_WRITE_RE);
  return toolBlocks().filter((t) => calls(t.text, [...helpers]) || COMMENT_WRITE_RE.test(t.text)).map((t) => t.name);
}

function rewritePaths(fn) {
  return FIREBASE_JSON.hosting.rewrites.filter((r) => r.function === fn).map((r) => r.source);
}

function probeUrls(source) {
  const p = source.replace(/\/\*\*$/, "");
  return source.endsWith("/**") ? [`${p}/start`, `${p}/complete`, `${p}/anything`] : [p];
}

const mcpCall = (name, args) => ({ method: "POST", url: `${PROD.origin}/mcp`, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });

/** Every gap between the product and a policy. Empty means covered. */
async function parity(policy) {
  const gaps = [];
  const emailIds = new Set(policy.emailRoutes.map((r) => r.id));
  for (const fn of mailingFunctions()) {
    if (fn.trigger) {
      if (!TRIGGER_COVERAGE[fn.document]) gaps.push(`trigger ${fn.name} (${fn.document}) has no coverage`);
      continue;
    }
    if (fn.name === "mcp") {
      // MCP contains both read and write tools. Every invitation-capable tool
      // is refused explicitly; the rest retain their existing classifications.
      for (const name of ["set_document_access", "set_folder_access"]) {
        const verdict = evaluate(mcpCall(name, { id: "ledger-doc", add: [{ principal: "a@example.com", role: "viewer" }] }), { target: PROD, policy, ...LEDGER });
        if (verdict.allow || verdict.rule !== "management") gaps.push(`${name} is not covered by the management email gate`);
      }
      continue;
    }
    const sources = rewritePaths(fn.name);
    if (sources.length === 0) gaps.push(`${fn.name} sends email but has no Hosting rewrite to guard`);
    for (const source of sources) {
      for (const path of probeUrls(source)) {
        for (const method of ["POST", "PUT", "DELETE"]) {
          const v = evaluate({ method, url: `${PROD.origin}${path}`, body: JSON.stringify({ docId: "ledger-doc" }) }, { target: PROD, policy, ...LEDGER });
          if (v.allow || !emailIds.has(v.rule)) gaps.push(`${method} ${path} (${fn.name}) is not refused by an email rule (got ${v.rule})`);
        }
      }
    }
  }
  // The comment trigger's coverage is "quiet-doc": every comment-writing path must be gated.
  for (const name of commentWritingTools()) {
    const v = evaluate(mcpCall(name, { id: "ledger-doc", threadId: "t", exact: "x", body: "b" }), { target: PROD, policy, ...LEDGER });
    if (!(v.allow === false || v.quietDocs?.includes("ledger-doc"))) gaps.push(`MCP ${name} writes comments but is not quiet-gated`);
  }
  for (const fn of commentWritingEndpoints()) {
    for (const source of rewritePaths(fn)) {
      for (const path of probeUrls(source)) {
        const v = evaluate({ method: "POST", url: `${PROD.origin}${path}`, body: JSON.stringify({ docId: "ledger-doc", versionId: "v1", op: "create" }) }, { target: PROD, policy, ...LEDGER });
        if (!(v.allow === false || v.quietDocs?.includes("ledger-doc"))) gaps.push(`POST ${path} (${fn}) writes comments but is not quiet-gated`);
      }
    }
  }
  const classified = new Set([...policy.readTools, ...policy.managementTools, ...policy.createTools, ...policy.actTools, ...policy.commentTools]);
  const names = toolBlocks().map((t) => t.name);
  for (const n of names) if (!classified.has(n)) gaps.push(`tool ${n} is not classified`);
  for (const n of classified) if (!names.includes(n)) gaps.push(`classified tool ${n} no longer exists`);
  return gaps;
}

test("the parsers find what is really there (a parser that finds nothing would pass vacuously)", () => {
  const mailing = mailingFunctions().map((f) => f.name).sort();
  for (const known of ["setAccess", "setFolderAccess", "verifyEmail", "manageTeamMembers", "onCommentCreated"]) {
    assert.ok(mailing.includes(known), `${known} found as email-capable (found: ${mailing.join(", ")})`);
  }
  assert.equal(toolBlocks().length, 31, "31 tool blocks across the MCP modules");
  const writers = commentWritingTools().sort();
  for (const known of ["add_comment", "reply_to_comment", "resolve_thread", "reopen_thread", "suggest_edit", "revise_suggestion", "withdraw_suggestion", "accept_suggestion", "reject_suggestion"]) {
    assert.ok(writers.includes(known), `${known} found as comment-writing (found: ${writers.join(", ")})`);
  }
  assert.ok(!writers.includes("get_comments") && !writers.includes("publish_document"), "readers and publishers are not comment writers");
  assert.deepEqual(commentWritingEndpoints(), ["manageSuggestion"]);
});

test("parity: every email-capable function and comment-writing path is covered by the guard", async () => {
  assert.deepEqual(await parity(DEFAULT_POLICY), []);
});

test("negative controls: removing any one rule from the policy opens a gap", async () => {
  const variants = [];
  for (const r of DEFAULT_POLICY.emailRoutes) {
    if (r.id === "team") continue; // /team sends no email; it is refused by plan, not by parity
    variants.push([`email route ${r.id}`, { ...DEFAULT_POLICY, emailRoutes: DEFAULT_POLICY.emailRoutes.filter((x) => x !== r) }]);
  }
  for (const n of DEFAULT_POLICY.commentTools) {
    variants.push([`comment tool ${n}`, { ...DEFAULT_POLICY, commentTools: new Set([...DEFAULT_POLICY.commentTools].filter((x) => x !== n)), actTools: new Set([...DEFAULT_POLICY.actTools, n]) }]);
  }
  variants.push(["comment route /suggestion", { ...DEFAULT_POLICY, commentRoutes: [] }]);
  variants.push(["a read tool", { ...DEFAULT_POLICY, readTools: new Set([...DEFAULT_POLICY.readTools].slice(1)) }]);
  for (const [label, policy] of variants) {
    const gaps = await parity(policy);
    assert.ok(gaps.length > 0, `removing ${label} must open a gap`);
  }
  assert.ok(variants.length >= 15);
});

test("evaluate: production refusals, and the local target allows everything", () => {
  const ctx = { target: PROD, ...LEDGER };
  const v = (method, path, body) => evaluate({ method, url: `${PROD.origin}${path}`, body: body && JSON.stringify(body) }, ctx);
  assert.equal(v("POST", "/access", { docId: "ledger-doc", add: [] }).rule, "access");
  assert.equal(v("POST", "/%61ccess", { docId: "ledger-doc" }).rule, "access", "percent-encoded path");
  assert.equal(v("POST", "//access/", { docId: "ledger-doc" }).rule, "access", "doubled and trailing slashes");
  assert.equal(v("GET", "/verify/start").rule, "verify", "verify refuses every method");
  assert.equal(v("GET", "/access?docId=ledger-doc").allow, true, "GET /access sends nothing");
  assert.equal(evaluate({ method: "POST", url: "https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=x" }, ctx).rule, "idtk-send-oob");
  assert.equal(evaluate({ method: "POST", url: "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=x" }, ctx).rule, "idtk-signup");
  assert.equal(evaluate({ method: "POST", url: "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=x" }, ctx).allow, true);
  assert.equal(evaluate({ method: "GET", url: "https://www.googletagmanager.com/gtag/js?id=G-X" }, ctx).rule, "ga-host");
  assert.equal(evaluate({ method: "POST", url: "https://region1.google-analytics.com/g/collect" }, ctx).rule, "ga-host");
  assert.equal(v("POST", "/draft", { docId: "someone-elses" }).rule, "ledger");
  assert.equal(v("POST", "/publish?update=someone-elses").rule, "ledger");
  assert.equal(v("POST", "/publish?id=brand-new").allow, true, "creating at a new id is not acting on another's document");
  assert.equal(v("POST", "/publish?folderId=not-ours").rule, "ledger-folder");
  assert.equal(v("POST", "/organize", { kind: "doc", id: "someone-elses", op: "move" }).rule, "ledger");
  assert.equal(v("POST", "/suggestion", { docId: "ledger-doc", versionId: "v1", op: "create" }).quietDocs[0], "ledger-doc");
  assert.equal(v("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_document", arguments: { id: "anything" } } }).allow, true, "reads are reads");
  assert.equal(v("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_document", arguments: { id: "someone-elses" } } }).rule, "ledger");
  assert.equal(v("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "brand_new_tool", arguments: {} } }).rule, "unclassified-tool");
  assert.equal(v("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `${UNKNOWN_TOOL_PREFIX}x`, arguments: {} } }).allow, true);
  const batch = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "add_comment", arguments: { id: "someone-elses" } } },
  ];
  assert.equal(v("POST", "/mcp", batch).rule, "ledger", "a batch is judged message by message");
  const local = { kind: "local", runId: "x", origin: "http://127.0.0.1:39999", runDir: PROD.runDir };
  assert.equal(evaluate({ method: "POST", url: `${local.origin}/access`, body: "{}" }, { target: local, ...LEDGER }).allow, true);
  assert.deepEqual(EMAIL_ROUTES.map((r) => r.id), ["access", "folder-access", "team", "team-members", "verify"]);
});

test("check(): a comment-capable action waits for assertQuietDoc, and a loud document is refused", async () => {
  const loud = createGuard(PROD, { ledger: () => ({ docs: LEDGER.ledgerDocs, folders: LEDGER.ledgerFolders, accounts: new Map() }), quietCheck: async () => { throw new Error("owner has not opted out"); } });
  const r1 = await loud.check(mcpCall("add_comment", { id: "ledger-doc", exact: "x", body: "b" }));
  assert.deepEqual([r1.allow, r1.rule], [false, "quiet-doc"]);
  let asked = 0;
  const quiet = createGuard(PROD, { ledger: () => ({ docs: LEDGER.ledgerDocs, folders: LEDGER.ledgerFolders, accounts: new Map() }), quietCheck: async () => void asked++ });
  const r2 = await quiet.check(mcpCall("add_comment", { id: "ledger-doc", exact: "x", body: "b" }));
  assert.deepEqual([r2.allow, asked], [true, 1]);
  const r3 = await quiet.check(mcpCall("get_comments", { id: "ledger-doc" }));
  assert.deepEqual([r3.allow, asked], [true, 1], "a read does not need the quiet check");
});

test("choke point 1: http.mjs asks the guard first, and a refusal never reaches fetch", async () => {
  let fetched = 0;
  const rows = [];
  const http = createHttp(PROD, { guard: createGuard(PROD, { ledger: () => ({ docs: new Set(), folders: new Set(), accounts: new Map() }) }), evidence: (l) => rows.push(JSON.parse(l)), fetch: async () => (fetched++, new Response("{}")) });
  await assert.rejects(http.postJson("/access", { docId: "d", add: [{ email: "a@b.c", role: "viewer" }] }), (e) => e.code === "E2E_GUARD" && e.rule === "access");
  assert.equal(fetched, 0);
  assert.equal(rows.at(-1).guard.refused, true, "the refusal is in the trace");
});

test("choke point 2: installGuard routes a context and aborts refused requests; local installs nothing", async () => {
  const routes = [];
  const context = { route: async (pattern, handler) => routes.push({ pattern, handler }) };
  const g = createGuard(PROD, { ledger: () => ({ docs: new Set(["mine"]), folders: new Set(), accounts: new Map() }), quietCheck: async () => {} });
  const { installed } = await installGuard(context, PROD, { guard: g });
  assert.ok(installed.length >= 6);
  const fire = async (method, url, body) => {
    const hit = routes.find((r) => r.pattern.test(url));
    if (!hit) return "unrouted";
    let outcome = null;
    await hit.handler({ request: () => ({ method: () => method, url: () => url, postDataBuffer: () => (body ? Buffer.from(body) : null) }), abort: async () => (outcome = "abort"), fallback: async () => (outcome = "fallback") });
    return outcome;
  };
  assert.equal(await fire("POST", `${PROD.origin}/access`, JSON.stringify({ docId: "mine" })), "abort");
  assert.equal(await fire("POST", `${PROD.origin}/verify/start`, "{}"), "abort");
  assert.equal(await fire("GET", "https://www.googletagmanager.com/gtag/js?id=G-1"), "abort");
  assert.equal(await fire("POST", "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=k", "{}"), "abort");
  assert.equal(await fire("POST", `${PROD.origin}/draft`, JSON.stringify({ docId: "mine" })), "fallback");
  assert.equal(await fire("POST", `${PROD.origin}/draft`, JSON.stringify({ docId: "theirs" })), "abort");
  assert.equal(await fire("POST", "https://firestore.googleapis.com/google.firestore.v1.Firestore/Write/channel?x=1", "req0___data__=%7B%22documents%2Fdocs%2Ftheirs%2Fversions%22"), "abort");
  assert.equal(await fire("GET", `${PROD.origin}/content/mine/v1/index.html`), "unrouted", "reads are not routed at all");
  const local = await installGuard(context, { kind: "local", origin: "http://127.0.0.1:39999" });
  assert.deepEqual(local.installed, []);
});

test("choke point 3: the CLI wrapper refuses before spawning", async () => {
  assert.deepEqual(cliIntent(["comment", "https://x.invalid/d/abc?k=1", "text", "--body", "b", "--json"]).docId, "abc");
  assert.equal(cliIntent(["list", "--json"]).kind, "read");
  assert.equal(cliIntent(["mv", "doc1", "folder9"]).folders[0], "folder9");
  const g = createGuard(PROD, { ledger: () => ({ docs: new Set(["mine"]), folders: new Set(), accounts: new Map() }), quietCheck: async () => { throw new Error("not quiet"); } });
  await assert.rejects(runCli(PROD, ["update", "theirs", "f.html"], { guard: g }), (e) => e.code === "E2E_GUARD" && /did not create/.test(e.message));
  await assert.rejects(runCli(PROD, ["comment", "mine", "x", "--body", "y"], { guard: g }), (e) => e.code === "E2E_GUARD" && /not quiet/.test(e.message));
  await assert.rejects(runCli(PROD, ["frobnicate"], { guard: g }), (e) => e.code === "E2E_GUARD");
});
