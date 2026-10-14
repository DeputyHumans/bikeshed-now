// SPDX-License-Identifier: Apache-2.0
// The zero-email guard: what a run may never send to production, enforced at every choke point (SPEC §12).

/**
 * Production runs must send no email at all. Three choke points ask this
 * module first — the Node HTTP client (http.mjs), every Playwright context
 * (installGuard), and the CLI wrapper (cli.mjs) — and all three use the same
 * pure `evaluate()`, so a rule cannot be enforced in one and forgotten in
 * another.
 *
 * On a LOCAL target everything is allowed: email goes to Mailpit, and the
 * local tier is where the email paths are tested.
 *
 * On PRODUCTION it refuses, fail-closed:
 *   - POST /access, /folder-access, /team, /team-members, and /verify/* — the
 *     endpoints that send invitations or codes;
 *   - Identity Toolkit accounts:sendOobCode and accounts:signUp;
 *   - Google Analytics hosts;
 *   - any write (non-GET) naming a document or folder this run did not create
 *     (the ledger), and any MCP tool this module does not classify — except
 *     an ABSENT-ID PROBE: an id this run minted with seed.absentDocId() and
 *     never created (ledgered "absent", and in the run's own e2e-<run6>-
 *     namespace), which a write or an MCP act/comment tool may name once
 *     absentDoc() proves docs/<id> does not exist and holds nothing, so no
 *     person can be reached through it. Only http.mjs and the browser's
 *     routes take such probes; the CLI wrapper and the browser's Firestore
 *     writes refuse them, as before;
 *   - a Firestore REST write (lib/firestore-client.mjs, on any host: a
 *     documents:commit or batchWrite, a PATCH, a DELETE, a createDocument
 *     POST) unless every document it names is under docs/<id> or public/<id>
 *     of a document this run created, folders/<id> of a folder it created, or
 *     users/<uid> of a run account; any other collection, another project, a
 *     transaction or an unknown method is refused. Absent-id probes are not
 *     taken. A write under docs/<id>/versions/<v>/annotations is
 *     comment-capable (below);
 *   - a Realtime Database REST write (lib/rtdb.mjs: the target's database,
 *     or any *.firebaseio.com / *.firebasedatabase.app host) unless it is
 *     under status/<id> of a document this run created; another database or
 *     namespace is refused for reads too, and `.settings` always (RTDB_REST);
 *   - a comment-capable action (anything that creates a comment and so fires
 *     onCommentCreated) unless assertQuietDoc() proves every possible
 *     recipient — owner, approvers, prior participants — is a run account with
 *     emailNotifications === false.
 *
 * `selftest/guard.test.mjs` parses functions/src/index.ts and mcp/tools.ts and
 * fails when an email-capable function or a comment-writing tool is not covered
 * here. Change the product, and that test says what to add.
 * `selftest/firestore-client.test.mjs` does the same for the comment trigger's
 * document path written over Firestore REST.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ledgerAbsentIds, ledgerAccounts, ledgerDocIds, readLedger } from "./ledger.mjs";
import { runTag } from "./accounts.mjs";

/** Endpoints that send email (or, for /team, are refused on production by the plan). */
/** `methods: "unsafe"` is every method but GET, HEAD and OPTIONS: fail-closed, whatever the endpoint accepts today. */
export const EMAIL_ROUTES = Object.freeze([
  { id: "access", methods: "unsafe", path: /^\/access\/*$/, reason: "sends email: POST /access (invitations)" },
  { id: "folder-access", methods: "unsafe", path: /^\/folder-access\/*$/, reason: "sends email: POST /folder-access (invitations)" },
  { id: "team", methods: "unsafe", path: /^\/team\/*$/, reason: "refused on production: POST /team (team changes precede invitations)" },
  { id: "team-members", methods: "unsafe", path: /^\/team-members\/*$/, reason: "sends email: POST /team-members (invitations)" },
  { id: "verify", methods: "*", path: /^\/verify(\/.*)?$/, reason: "sends email: /verify/* (verification codes)" },
]);

/** Identity Toolkit methods that send mail or create unverified accounts, on any host. */
export const IDENTITY_TOOLKIT_REFUSED = Object.freeze([
  { id: "idtk-send-oob", path: /\/accounts:sendOobCode$/, reason: "sends email: Identity Toolkit accounts:sendOobCode" },
  { id: "idtk-signup", path: /\/accounts:signUp$/, reason: "creates an account by sign-up: Identity Toolkit accounts:signUp (production accounts are made with the Admin SDK)" },
]);

/** Analytics hosts: a run's traffic must never be counted as a visitor's. */
export const GA_HOSTS = Object.freeze([
  /(^|\.)google-analytics\.com$/,
  /(^|\.)googletagmanager\.com$/,
  /^analytics\.google\.com$/,
  /(^|\.)doubleclick\.net$/,
]);

/** HTTP endpoints whose writes create comments (and so fire onCommentCreated). */
export const COMMENT_ROUTES = Object.freeze([
  { id: "suggestion", path: /^\/suggestion\/*$/, reason: "creates comments: POST /suggestion" },
]);

/** MCP tools, every one classified. An unclassified name is refused on production. */
export const READ_TOOLS = Object.freeze(new Set([
  "list_documents", "get_document", "get_lineage", "list_folders", "get_folder", "get_comments", "get_changes",
]));
export const CREATE_TOOLS = Object.freeze(new Set(["publish_document", "create_folder"]));
export const ACT_TOOLS = Object.freeze(new Set([
  "update_document", "commit_draft", "move_document", "rename_document", "fork_document",
]));
export const COMMENT_TOOLS = Object.freeze(new Set([
  "add_comment", "reply_to_comment", "resolve_thread", "reopen_thread",
  "suggest_edit", "revise_suggestion", "withdraw_suggestion", "accept_suggestion", "reject_suggestion",
]));
/** A deliberately unknown tool, for the -32601 case, may be named like this. */
export const UNKNOWN_TOOL_PREFIX = "e2e_no_such_";

/**
 * The Firestore REST API (v1), on any host. `path`, matched against the RAW
 * pathname, splits it into project, database, document path and custom
 * method; anything that only LOOKS like the API once percent-decoded (an
 * escaped ":" or "/") is refused. `collections` says what the first segment
 * of a written path names: a document, a folder or an account, each checked
 * against the ledger. Any other collection is refused. A write under a
 * document's `annotations` is comment-capable.
 */
export const FIRESTORE_REST = Object.freeze({
  path: /^\/v1(?:beta\d+)?\/projects\/([^/:]+)\/databases\/([^/:]+)\/documents((?:\/[^/:]+)*)(?::([A-Za-z]+))?$/,
  loose: /^\/v1[^/]*\/projects\/[^/]+\/databases\/[^/]+\/documents/,
  resource: /^projects\/([^/]+)\/databases\/([^/]+)\/documents\/(.+)$/,
  readMethods: Object.freeze(new Set(["runQuery", "runAggregationQuery", "batchGet", "listCollectionIds", "partitionQuery", "listen"])),
  writeMethods: Object.freeze(new Set(["commit", "batchWrite"])),
  collections: Object.freeze({ docs: "doc", public: "doc", folders: "folder", users: "account" }),
  commentSubtree: (segs) => segs[0] === "docs" && segs[2] === "versions" && segs[4] === "annotations",
});

/**
 * The Realtime Database REST API (`<database>/<path>.json`, lib/rtdb.mjs): a
 * request to the target's database origin (target.databaseURL), or to any
 * host in `hosts`. Another database than the target's is refused outright,
 * and so is another namespace (`?ns=`). Reads go. A write — any method but
 * GET, HEAD and OPTIONS, or one whose `x-http-method` names another — goes
 * only under `<root>/<docId>/…` for a root in `docRoots` (the one subtree the
 * rules let a client write, SPEC §6b) of a document this run created.
 * `.settings` (the rules themselves), any other dot path, any other subtree
 * and a path that is not `…/<path>.json` are refused. RTDB has no email
 * trigger; this keeps a run's writes on the run's own documents. The
 * browser's RTDB traffic is a websocket, which no route here sees.
 */
export const RTDB_REST = Object.freeze({
  hosts: Object.freeze([/\.firebaseio\.com$/, /\.firebasedatabase\.app$/]),
  docRoots: Object.freeze(new Set(["status"])),
});

/** Firestore triggers that send email, and how the guard covers each. */
export const TRIGGER_COVERAGE = Object.freeze({
  "docs/{docId}/versions/{versionId}/annotations/{annId}/comments/{commentId}": "quiet-doc",
});

/** CLI commands by what they do. The CLI reaches the deployment through /mcp. */
export const CLI_COMMANDS = Object.freeze({
  read: new Set(["list", "get", "comments", "changes", "lineage", "folders", "folder", "skills", "open", "help", "--help", "--version"]),
  comment: new Set(["comment", "reply", "resolve", "reopen", "suggest", "revise", "withdraw", "accept", "reject"]),
  act: new Set(["update", "commit", "mv", "rename", "fork"]),
  create: new Set(["publish", "mkdir"]),
  auth: new Set(["login", "logout"]),
});

export const DEFAULT_POLICY = Object.freeze({
  emailRoutes: EMAIL_ROUTES,
  identityToolkit: IDENTITY_TOOLKIT_REFUSED,
  gaHosts: GA_HOSTS,
  commentRoutes: COMMENT_ROUTES,
  readTools: READ_TOOLS,
  createTools: CREATE_TOOLS,
  actTools: ACT_TOOLS,
  commentTools: COMMENT_TOOLS,
  firestoreRest: FIRESTORE_REST,
  rtdbRest: RTDB_REST,
});

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const NO_IDS = Object.freeze(new Set());

/** The prefix docIdFor gives this run's ids (`e2e-<run6>-`), or null without a usable run id. */
function runPrefix(target) {
  if (typeof target.runId !== "string") return null;
  try {
    return `e2e-${runTag(target.runId)}-`;
  } catch {
    return null;
  }
}

/** An allowing verdict, carrying the documents check() must still prove quiet or absent. */
function allowed(rule, quiet, absent) {
  const v = { allow: true, rule: quiet.size > 0 ? "comment" : absent.size > 0 ? "absent-probe" : rule };
  if (quiet.size > 0) v.quietDocs = [...quiet];
  if (absent.size > 0) v.absentDocs = [...absent];
  return v;
}

export class GuardRefusal extends Error {
  constructor(verdict) {
    super(`e2e guard: ${verdict.reason}`);
    this.code = "E2E_GUARD";
    this.rule = verdict.rule;
    this.verdict = verdict;
  }
}

function normalizedPath(u) {
  let p = u.pathname;
  try {
    p = decodeURIComponent(p);
  } catch {}
  return p.replace(/\/{2,}/g, "/");
}

function bodyText(body) {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (body instanceof URLSearchParams) return body.toString();
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Every document id a request to the app names, and every folder id. */
export function referencedIds(u, json) {
  const docs = new Set();
  const folders = new Set();
  const q = u.searchParams;
  for (const k of ["doc", "docId", "update"]) if (q.get(k)) docs.add(q.get(k));
  for (const k of ["folderId", "parentId", "targetFolderId"]) if (q.get(k)) folders.add(q.get(k));
  const objs = Array.isArray(json) ? json : json ? [json] : [];
  for (const b of objs) {
    if (!b || typeof b !== "object") continue;
    for (const k of ["docId", "doc"]) if (typeof b[k] === "string" && b[k]) docs.add(b[k]);
    for (const k of ["folderId", "parentId", "targetFolderId"]) if (typeof b[k] === "string" && b[k]) folders.add(b[k]);
    // /organize: {kind: "doc"|"folder", id}
    if (typeof b.id === "string" && b.id && (b.kind === "doc" || b.kind === "folder")) (b.kind === "doc" ? docs : folders).add(b.id);
  }
  const m = /^\/(?:draft|content|download|thumb)\/(?:~[^/]+\/)?([^/]+)/.exec(normalizedPath(u));
  if (m) docs.add(m[1]);
  for (const f of [...folders]) if (f === "root" || f === "") folders.delete(f);
  return { docs, folders };
}

/** The MCP messages in a request body, flattened. */
function mcpMessages(json) {
  return (Array.isArray(json) ? json : json ? [json] : []).filter((m) => m && typeof m === "object");
}

/**
 * Decide one request. Pure: everything it needs is in `ctx`.
 *
 * @param {{method:string, url:string, body?:any}} req
 * @param {{target, policy?, ledgerDocs:Set, ledgerFolders:Set, ledgerAbsent?:Set, ledgerUids?:Set}} ctx
 *   ledgerAbsent: ids minted as absent-id probes (ledgerAbsentIds); none when omitted.
 *   ledgerUids: the run accounts' uids, for a Firestore REST write to users/<uid>; none when omitted.
 * @returns {{allow:boolean, rule?:string, reason?:string, quietDocs?:string[], absentDocs?:string[]}}
 *   quietDocs: documents that must pass assertQuietDoc before this may go.
 *   absentDocs: absent-id probes that must pass assertAbsent before this may go.
 */
export function evaluate(req, ctx) {
  const { target } = ctx;
  if (target.kind === "local") return { allow: true, rule: "local" };
  const policy = ctx.policy ?? DEFAULT_POLICY;
  const method = String(req.method ?? "GET").toUpperCase();
  let u;
  try {
    u = new URL(req.url);
  } catch {
    return { allow: false, rule: "bad-url", reason: `not a URL: ${req.url}` };
  }
  const host = u.hostname.toLowerCase();
  const path = normalizedPath(u);

  for (const re of policy.gaHosts) {
    if (re.test(host)) return { allow: false, rule: "ga-host", reason: `analytics host ${host}` };
  }
  for (const r of policy.identityToolkit) {
    if (r.path.test(path)) return { allow: false, rule: r.id, reason: r.reason };
  }
  // Fail-closed: a policy that does not mention Firestore REST still classifies it; only null turns it off.
  const fs = policy.firestoreRest === undefined ? FIRESTORE_REST : policy.firestoreRest;
  if (fs && fs.loose.test(path)) return firestoreRestVerdict(method, u, req.body, ctx, fs);
  // Likewise the Realtime Database REST API: only null turns it off.
  const rt = policy.rtdbRest === undefined ? RTDB_REST : policy.rtdbRest;
  if (rt && isRtdbRequest(u, target, rt)) return rtdbRestVerdict(method, u, ctx, rt);

  const appOrigin = new URL(target.origin).origin;
  if (u.origin !== appOrigin) return { allow: true, rule: "other-host" };

  for (const r of policy.emailRoutes) {
    const applies = r.methods === "*" || (r.methods === "unsafe" ? !SAFE_METHODS.has(method) : r.methods.includes(method));
    if (applies && r.path.test(path)) {
      return { allow: false, rule: r.id, reason: r.reason };
    }
  }
  if (SAFE_METHODS.has(method)) return { allow: true, rule: "read" };

  const json = parseJson(bodyText(req.body));
  const quiet = new Set();
  const own = (id) => ctx.ledgerDocs.has(id);
  const ownFolder = (id) => ctx.ledgerFolders.has(id);
  // An absent-id probe is not the run's document, but it is the run's to name:
  // ledgered "absent", in this run's namespace, and proved empty by check().
  const absentIds = ctx.ledgerAbsent ?? NO_IDS;
  const prefix = runPrefix(target);
  const absent = new Set();
  const probe = (id) => !own(id) && absentIds.has(id);
  const outside = (what, id) =>
    !prefix || !id.startsWith(prefix)
      ? { allow: false, rule: "absent-namespace", reason: `${what} names ${id}, ledgered as an absent-id probe but not an id this run minted (${prefix ?? "no run tag"}…)` }
      : null;

  if (path === "/mcp") {
    for (const m of mcpMessages(json)) {
      if (m.method !== "tools/call") continue;
      const name = String(m.params?.name ?? "");
      const args = m.params?.arguments ?? {};
      const id = typeof args.id === "string" ? args.id : null;
      const folder = typeof args.folder === "string" && args.folder && args.folder !== "root" ? args.folder : null;
      if (policy.readTools.has(name)) continue;
      if (name.startsWith(UNKNOWN_TOOL_PREFIX)) continue;
      if (policy.createTools.has(name)) {
        const parent = folder ?? (typeof args.parent === "string" && args.parent && args.parent !== "root" ? args.parent : null);
        if (parent && !ownFolder(parent)) return { allow: false, rule: "ledger-folder", reason: `${name} into folder ${parent}, which this run did not create` };
        continue;
      }
      if (policy.actTools.has(name) || policy.commentTools.has(name)) {
        if (id && probe(id)) {
          const refused = outside(name, id);
          if (refused) return refused;
          absent.add(id);
        } else if (!id || !own(id)) return { allow: false, rule: "ledger", reason: `${name} on ${id ?? "(no id)"}, a document this run did not create` };
        if (folder && !ownFolder(folder)) return { allow: false, rule: "ledger-folder", reason: `${name} into folder ${folder}, which this run did not create` };
        // A comment on an absent id is proved quiet by its absence: no owner, no approvers, no prior thread.
        if (policy.commentTools.has(name) && own(id)) quiet.add(id);
        continue;
      }
      return { allow: false, rule: "unclassified-tool", reason: `MCP tool ${name} is not classified by the e2e guard` };
    }
    return allowed("mcp", quiet, absent);
  }

  const { docs, folders } = referencedIds(u, json);
  // A new document's own id (POST /publish?id=) is a creation, not an act on someone else's.
  for (const d of docs) {
    if (own(d)) continue;
    if (probe(d)) {
      const refused = outside(`${method} ${path}`, d);
      if (refused) return refused;
      absent.add(d);
      continue;
    }
    return { allow: false, rule: "ledger", reason: `${method} ${path} names ${d}, a document this run did not create` };
  }
  for (const f of folders) {
    if (!ownFolder(f)) return { allow: false, rule: "ledger-folder", reason: `${method} ${path} names folder ${f}, which this run did not create` };
  }
  for (const r of policy.commentRoutes) {
    if (r.path.test(path)) {
      if (docs.size === 0) return { allow: false, rule: r.id, reason: `${r.reason} without a docId` };
      return allowed("comment", new Set([...docs].filter(own)), absent);
    }
  }
  return allowed("ledger-ok", NO_IDS, absent);
}

/**
 * A Firestore REST request on production (see FIRESTORE_REST). Reads go; a
 * write goes only when every document it names is the run's own, and one
 * under a document's annotations carries that document in quietDocs.
 * `ctx.ledgerUids` (a Set) holds the run accounts' uids; none when omitted.
 */
function firestoreRestVerdict(method, u, body, ctx, fs) {
  const { target } = ctx;
  const refuse = (rule, reason) => ({ allow: false, rule, reason });
  const raw = u.pathname.replace(/\/{2,}/g, "/");
  const m = fs.path.exec(raw);
  if (!m) return refuse("firestore-unclassified", `Firestore REST ${method} ${raw} is not a path the e2e guard can classify`);
  let parts;
  try {
    parts = { project: decodeURIComponent(m[1]), docPath: (m[3] ?? "").split("/").filter(Boolean).map(decodeURIComponent), custom: m[4] ?? null };
  } catch {
    return refuse("firestore-unclassified", `Firestore REST ${raw} does not decode`);
  }
  const project = target.projectId;
  const otherProject = (p) => (!project || p !== project ? refuse("firestore-project", `Firestore REST names project ${p}, not this target's (${project ?? "none"})`) : null);
  const wrong = otherProject(parts.project);
  if (wrong) return wrong;
  if (SAFE_METHODS.has(method)) return { allow: true, rule: "firestore-read" };
  if (parts.custom && fs.readMethods.has(parts.custom) && method === "POST") return { allow: true, rule: "firestore-read" };

  // Every document the request writes, as segments relative to the documents root.
  const written = [];
  if (parts.custom) {
    if (!fs.writeMethods.has(parts.custom) || method !== "POST") return refuse("firestore-unclassified", `Firestore REST ${method} :${parts.custom} is not classified by the e2e guard`);
    const json = parseJson(bodyText(body));
    const writes = json && Array.isArray(json.writes) ? json.writes : null;
    if (!writes || writes.length === 0) return refuse("firestore-unclassified", `Firestore REST :${parts.custom} without a list of writes`);
    for (const w of writes) {
      const name = w?.update?.name ?? w?.delete ?? w?.transform?.document;
      const r = typeof name === "string" ? fs.resource.exec(name) : null;
      if (!r) return refuse("firestore-unclassified", `Firestore REST :${parts.custom} holds a write the e2e guard cannot read (${JSON.stringify(Object.keys(w ?? {}))})`);
      const other = otherProject(r[1]);
      if (other) return other;
      written.push(r[3].split("/"));
    }
  } else if (method === "PATCH" || method === "DELETE") {
    written.push(parts.docPath);
  } else if (method === "POST") {
    // createDocument: POST <collection path>?documentId=<id> (no id: the server picks one).
    written.push([...parts.docPath, u.searchParams.get("documentId") || "(server-chosen id)"]);
  } else {
    return refuse("firestore-unclassified", `Firestore REST ${method} is not classified by the e2e guard`);
  }

  const quiet = new Set();
  const uids = ctx.ledgerUids ?? NO_IDS;
  for (const segs of written) {
    const where = segs.join("/");
    const kind = Object.hasOwn(fs.collections, segs[0]) ? fs.collections[segs[0]] : null;
    const id = segs[1];
    if (!kind || !id) return refuse("firestore-path", `Firestore write to ${where}: the e2e guard writes only under docs, public, folders and users`);
    if (kind === "doc" && !ctx.ledgerDocs.has(id)) return refuse("ledger", `Firestore write under ${segs[0]}/${id}, a document this run did not create (absent-id probes are not taken by Firestore writes)`);
    if (kind === "folder" && !ctx.ledgerFolders.has(id)) return refuse("ledger-folder", `Firestore write under folders/${id}, a folder this run did not create`);
    if (kind === "account" && !uids.has(id)) return refuse("ledger-account", `Firestore write under users/${id}, which is not a run account`);
    if (fs.commentSubtree(segs)) quiet.add(id);
  }
  return allowed("firestore-write", quiet, NO_IDS);
}

/** The target's database URL, or null when it names none (or an unparsable one). */
function databaseUrlOf(target) {
  try {
    return typeof target?.databaseURL === "string" && target.databaseURL ? new URL(target.databaseURL) : null;
  } catch {
    return null;
  }
}

/** A request to a Realtime Database: the target's database origin, or a database host. */
function isRtdbRequest(u, target, rt) {
  const db = databaseUrlOf(target);
  let app = null;
  try {
    app = new URL(target.origin).origin;
  } catch {}
  if (db && u.origin === db.origin && u.origin !== app) return true;
  return (rt.hosts ?? []).some((re) => re.test(u.hostname.toLowerCase()));
}

/**
 * A Realtime Database REST request on production (see RTDB_REST): reads go;
 * a write goes only under `<docRoot>/<docId>/…` of a document this run
 * created, never another database or namespace, never a dot path.
 */
function rtdbRestVerdict(method, u, ctx, rt) {
  const { target } = ctx;
  const refuse = (rule, reason) => ({ allow: false, rule, reason });
  const db = databaseUrlOf(target);
  if (!db || u.origin !== db.origin) return refuse("rtdb-project", `Realtime Database ${u.host} is not this target's (${db?.host ?? "none"})`);
  const own = db.searchParams.get("ns") ?? db.hostname.split(".")[0];
  const ns = u.searchParams.get("ns");
  if (ns !== null && ns !== own) return refuse("rtdb-namespace", `Realtime Database namespace ${ns} is not this target's (${own})`);
  const override = u.searchParams.get("x-http-method");
  const effective = override === null ? method : override.toUpperCase();
  if (SAFE_METHODS.has(method) && SAFE_METHODS.has(effective)) return { allow: true, rule: "rtdb-read" };
  // Segments from the RAW path, each decoded: a "/" or "." hidden in an escape is not a path the guard reads.
  const raw = u.pathname.replace(/\/{2,}/g, "/");
  if (!raw.endsWith(".json")) return refuse("rtdb-unclassified", `Realtime Database ${effective} ${raw} is not a REST path (…/<path>.json)`);
  let segs;
  try {
    segs = raw.slice(0, -".json".length).split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return refuse("rtdb-unclassified", `Realtime Database ${raw} does not decode`);
  }
  const where = `/${segs.join("/")}`;
  if (segs.some((s) => s.includes("/"))) return refuse("rtdb-unclassified", `Realtime Database ${raw}: an escaped "/" in a key`);
  if (segs.some((s) => s.startsWith("."))) return refuse("rtdb-path", `Realtime Database ${effective} ${where}: a dot path (.settings holds the rules)`);
  if (!rt.docRoots.has(segs[0]) || !segs[1]) {
    return refuse("rtdb-path", `Realtime Database ${effective} ${where}: the e2e guard writes only under ${[...rt.docRoots].map((r) => `${r}/<docId>`).join(", ")}`);
  }
  if (!ctx.ledgerDocs.has(segs[1])) return refuse("ledger", `Realtime Database write under ${segs[0]}/${segs[1]}, a document this run did not create`);
  return { allow: true, rule: "rtdb-write" };
}

/** The command and the ids a CLI argv acts on. */
export function cliIntent(args) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !String(next).startsWith("--") && !["json", "wait", "all", "delete", "watch", "paste", "no-browser", "help"].includes(key)) {
        flags[key] = String(next);
        i++;
      } else flags[key] = true;
    } else positionals.push(a);
  }
  const [command = "help", ...rest] = positionals;
  const idOf = (ref) => {
    if (!ref) return null;
    const m = /^https?:\/\/[^/]+\/d\/([^/?#]+)/i.exec(ref);
    return m ? decodeURIComponent(m[1]) : ref;
  };
  let kind = "unknown";
  for (const [k, set] of Object.entries(CLI_COMMANDS)) if (set.has(command)) kind = k;
  if (command === "skills" && rest[0] === "install") kind = "read"; // writes a local directory only
  const docId = ["read", "comment", "act"].includes(kind) && !["list", "folders", "skills", "help", "--help", "--version", "folder"].includes(command) ? idOf(rest[0]) : null;
  const folders = [];
  if (command === "mv" && rest[1] && rest[1] !== "root") folders.push(rest[1]);
  if (typeof flags.folder === "string") folders.push(flags.folder);
  if (typeof flags.parent === "string") folders.push(flags.parent);
  return { command, kind, docId, folders, flags, positionals: rest };
}

/** The uids of a ledger's accounts (a Map of rows, as ledgerAccounts returns), or none. */
function uidsOf(accounts) {
  const out = new Set();
  if (accounts && typeof accounts.values === "function") for (const a of accounts.values()) if (typeof a?.uid === "string" && a.uid) out.add(a.uid);
  return out;
}

/**
 * The guard for one target. `check(req)` is what http.mjs awaits before every
 * request; it resolves to the verdict and never lets a refused one through.
 *
 * @param {object} target
 * @param {object} [o]
 * @param {object} [o.policy]          DEFAULT_POLICY, or a test's copy
 * @param {Function} [o.ledger]        () => {docs:Set, folders:Set, accounts:Map, absent?:Set}
 *                                     (the accounts' uids gate Firestore REST writes to users/<uid>)
 * @param {Function} [o.quietCheck]    async (docId) => void, throws when not quiet
 * @param {Function} [o.absentCheck]   async (docId) => void, throws when docs/<id> is not empty
 */
export function createGuard(target, o = {}) {
  const policy = o.policy ?? DEFAULT_POLICY;
  const refusals = [];
  const ledger =
    o.ledger ??
    (() => {
      const rows = readLedger(target);
      return {
        docs: new Set(rows.filter((r) => r.kind === "doc").map((r) => r.docId)),
        folders: new Set(rows.filter((r) => r.kind === "folder").map((r) => r.folderId)),
        absent: ledgerAbsentIds(target, rows),
        accounts: ledgerAccounts(target),
      };
    });

  function record(req, verdict) {
    refusals.push({ t: new Date().toISOString(), method: req.method, rule: verdict.rule, reason: verdict.reason });
    try {
      mkdirSync(target.runDir, { recursive: true });
      appendFileSync(join(target.runDir, "guard.jsonl"), JSON.stringify(refusals.at(-1)) + "\n");
    } catch {}
  }

  async function assertQuietDoc(docId) {
    if (o.quietCheck) return o.quietCheck(docId);
    return quietDoc(target, docId, ledger().accounts);
  }

  async function assertAbsent(docId) {
    if (o.absentCheck) return o.absentCheck(docId);
    return absentDoc(target, docId);
  }

  async function check(req) {
    if (target.kind === "local") return { allow: true, rule: "local" };
    const l = ledger();
    let verdict = evaluate(req, { target, policy, ledgerDocs: l.docs, ledgerFolders: l.folders, ledgerAbsent: l.absent, ledgerUids: uidsOf(l.accounts) });
    if (verdict.allow && verdict.absentDocs) {
      for (const d of verdict.absentDocs) {
        try {
          await assertAbsent(d);
        } catch (e) {
          verdict = { allow: false, rule: "absent-probe", reason: `absent-id probe ${d}: ${e.message}` };
          break;
        }
      }
    }
    if (verdict.allow && verdict.quietDocs) {
      for (const d of verdict.quietDocs) {
        try {
          await assertQuietDoc(d);
        } catch (e) {
          verdict = { allow: false, rule: "quiet-doc", reason: `comment-capable action on ${d}: ${e.message}` };
          break;
        }
      }
    }
    if (!verdict.allow) record(req, verdict);
    return verdict;
  }

  /** The CLI wrapper's check: the same rules, from an argv. */
  async function checkCli(args) {
    if (target.kind === "local") return { allow: true, rule: "local" };
    const intent = cliIntent(args);
    const l = ledger();
    let verdict = { allow: true, rule: `cli-${intent.kind}` };
    if (intent.kind === "unknown") verdict = { allow: false, rule: "cli-unclassified", reason: `CLI command ${intent.command} is not classified by the e2e guard` };
    else if (["act", "comment"].includes(intent.kind) && (!intent.docId || !l.docs.has(intent.docId))) {
      verdict = { allow: false, rule: "ledger", reason: `bikeshed ${intent.command} on ${intent.docId ?? "(no id)"}, a document this run did not create` };
    } else {
      const foreign = intent.folders.find((f) => !l.folders.has(f));
      if (foreign && intent.kind !== "read") verdict = { allow: false, rule: "ledger-folder", reason: `bikeshed ${intent.command} into folder ${foreign}, which this run did not create` };
    }
    if (verdict.allow && intent.kind === "comment") {
      try {
        await assertQuietDoc(intent.docId);
      } catch (e) {
        verdict = { allow: false, rule: "quiet-doc", reason: `bikeshed ${intent.command} on ${intent.docId}: ${e.message}` };
      }
    }
    if (!verdict.allow) record({ method: "CLI" }, verdict);
    return verdict;
  }

  return { kind: target.kind, policy, check, checkCli, assertQuietDoc, assertAbsent, refusals };
}

/**
 * Prove an absent-id probe can reach nobody: docs/<docId> does not exist and
 * holds no subcollection (Firestore keeps a subcollection under a missing
 * document, so a missing document alone proves nothing). With nothing there,
 * there is no owner, approver or prior comment author for a write — or a
 * comment trigger — to reach. Reads through the Admin SDK (`o.db` for a
 * test's stand-in). Throws with the reason it is not absent.
 */
export async function absentDoc(target, docId, o = {}) {
  const db = o.db ?? (await import("./admin.mjs")).adminFor(target).db;
  const ref = db.collection("docs").doc(docId);
  const snap = await ref.get();
  if (snap.exists) throw new Error(`docs/${docId} exists, so it is not absent`);
  const under = await ref.listCollections();
  if (under.length > 0) throw new Error(`docs/${docId} does not exist but holds ${under.map((c) => c.id).sort().join(", ")}`);
  return { docId, absent: true };
}

/**
 * Prove a comment on `docId` can email nobody: the owner, every approver and
 * every prior comment author must be a run account (in the ledger) whose
 * users/{uid} has emailNotifications === false. Reads through the Admin SDK.
 * Throws with the first reason it is not quiet.
 */
export async function quietDoc(target, docId, accounts = ledgerAccounts(target)) {
  const { adminFor } = await import("./admin.mjs");
  const { db } = adminFor(target);
  const ref = db.collection("docs").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`no document ${docId}`);
  const data = snap.data() ?? {};
  const people = new Set();
  if (data.ownerEmail) people.add(String(data.ownerEmail).toLowerCase());
  for (const e of Array.isArray(data.approverMembers) ? data.approverMembers : []) people.add(String(e).toLowerCase());
  const versions = await ref.collection("versions").get();
  for (const v of versions.docs) {
    const anns = await v.ref.collection("annotations").get();
    for (const a of anns.docs) {
      const comments = await a.ref.collection("comments").get();
      for (const c of comments.docs) {
        const e = c.data()?.authorEmail;
        if (e) people.add(String(e).toLowerCase());
      }
    }
  }
  for (const email of people) {
    const acct = accounts.get(email);
    if (!acct) throw new Error(`${email} is not a run account, so a comment could email them`);
    const user = await db.collection("users").doc(acct.uid).get();
    if (!user.exists || user.data()?.emailNotifications !== false) {
      throw new Error(`${email} has not opted out of email (users/${acct.uid}.emailNotifications is not false)`);
    }
  }
  return { docId, people: [...people] };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Install the guard on a Playwright BrowserContext (which also covers its
 * popups, such as the /connect consent window). On a local target it installs
 * nothing. Routes are narrow: the email endpoints, the acting endpoints, the
 * Identity Toolkit methods, the analytics hosts, Firestore's write channels and
 * its REST API (FIRESTORE_REST, whose reads fall through).
 * Each matched request is decided by the same evaluate(); a refusal aborts it,
 * and anything else falls through to the context's other routes.
 *
 * @returns {Promise<{installed: string[], refusals: object[]}>}
 */
export async function installGuard(context, target, o = {}) {
  if (target.kind === "local" && !o.force) return { installed: [], refusals: [] };
  const guard = o.guard ?? createGuard(target);
  const origin = escapeRe(new URL(target.origin).origin);
  const patterns = [
    new RegExp(`^${origin}/(access|folder-access|team|team-members)/*([?#].*)?$`),
    new RegExp(`^${origin}/verify(/[^?#]*)?([?#].*)?$`),
    new RegExp(`^${origin}/(publish|draft|commit|suggestion|thumb|organize|fork|trust|marking|visibility|view|unlock|folder|mcp|tokens)(/[^?#]*)?([?#].*)?$`),
    /\/accounts:(sendOobCode|signUp)([?#].*)?$/,
    /^https?:\/\/([^/]*\.)?(google-analytics\.com|googletagmanager\.com|doubleclick\.net)(:\d+)?\//,
    /^https?:\/\/analytics\.google\.com(:\d+)?\//,
    /\/google\.firestore\.v1\.Firestore\/(Write|Commit)\//,
    /^https?:\/\/[^/?#]+\/v1[^/?#]*\/projects\/[^/?#]+\/databases\/[^/?#]+\/documents/,
  ];
  const handler = async (route) => {
    const request = route.request();
    let verdict;
    try {
      const url = request.url();
      const body = request.postDataBuffer?.() ?? request.postData?.() ?? undefined;
      if (/\/google\.firestore\.v1\.Firestore\/(Write|Commit)\//.test(url)) {
        verdict = await firestoreWriteVerdict(guard, target, body);
      } else {
        verdict = await guard.check({ method: request.method(), url, body });
      }
    } catch (e) {
      verdict = { allow: false, rule: "guard-error", reason: `guard failed closed: ${e.message}` };
    }
    if (!verdict.allow) {
      guard.refusals.push({ t: new Date().toISOString(), rule: verdict.rule, reason: verdict.reason, browser: true });
      return route.abort("blockedbyclient");
    }
    return route.fallback();
  };
  for (const p of patterns) await context.route(p, handler);
  return { installed: patterns.map(String), refusals: guard.refusals };
}

/**
 * A Firestore write from the app: refuse a write under a document this run
 * did not create, and a comment write on a document that is not quiet.
 */
async function firestoreWriteVerdict(guard, target, body) {
  if (target.kind === "local") return { allow: true, rule: "local" };
  // WebChannel bodies are form-encoded, with the JSON percent-encoded inside.
  let text = bodyText(body);
  try {
    text = decodeURIComponent(text.replace(/\+/g, " "));
  } catch {}
  const ids = new Set([...text.matchAll(/documents\/docs\/([^/"\\]+)/g)].map((m) => decodeURIComponent(m[1])));
  const own = ledgerDocIds(target);
  for (const d of ids) {
    if (!own.has(d)) return { allow: false, rule: "ledger", reason: `Firestore write under docs/${d}, a document this run did not create` };
  }
  if (/\/annotations\/[^/"\\]+(\/comments\/|"|\\)/.test(text)) {
    for (const d of ids) {
      try {
        await guard.assertQuietDoc(d);
      } catch (e) {
        return { allow: false, rule: "quiet-doc", reason: `Firestore comment write on ${d}: ${e.message}` };
      }
    }
  }
  return { allow: true, rule: "firestore-ok" };
}
