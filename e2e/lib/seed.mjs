// SPDX-License-Identifier: Apache-2.0
// Seeding documents (and folders, teams and comment threads) through the user's own paths, the operator script, MCP, and the committed fixtures (SPEC §4, §9, §12, §13, §18).

/**
 * Three ways in, as the product has three:
 *
 *   publish(http, …)          POST /publish?filename&title&id&folderId with the
 *                             file as the raw body — the app's upload and the
 *                             CLI's `bikeshed publish`. A .zip is built with the
 *                             repo's own stored-zip writer (tools/zip.mjs).
 *   publishMcp(mcp, …)        the publish_document tool.
 *   publishOperator(target, …)  LOCAL only: the stack copy's scripts/publish.mjs
 *                             with Admin credentials against the emulators.
 *
 * publish and publishMcp take `patient: {ctx, …}`: a request a loaded stack
 * did not answer is sent again, after looking for the document it may have
 * made anyway, and the case ends INCONCLUSIVE when that keeps happening
 * (PATIENT, at publish).
 *
 * and two that copy rather than upload:
 *
 *   fork(http, …)             POST /fork {op: "create"}, the app's Fork (SPEC §21).
 *   forkMcp(mcp, …)           the fork_document tool, ledgered as fork() ledgers.
 *
 * and one that fills a document with feedback:
 *
 *   seedThreads(mcp, …)       n open comment threads, each as add_comment
 *                             opens one: n guarded add_comment calls, or on a
 *                             local stack one call and Admin copies of what
 *                             it wrote (SPEC §4, §19).
 *
 * and one that makes a principal rather than a document:
 *
 *   createTeam(http, …)       POST /team {op: "create"} (SPEC §18), ledgered
 *                             as {kind: "team"}.
 *
 * and one that makes a place to file documents in:
 *
 *   createFolder(http, …)     POST /folder (SPEC §13), ledgered as
 *                             {kind: "folder"}, so the production guard lets
 *                             later writes name it.
 *   createFolderMcp(mcp, …)   the create_folder tool, ledgered the same way.
 *
 * and three that make nothing but record what something else made:
 *
 *   ledgerDoc(target, …)      a document the BROWSER created (the app's Fork
 *                             button, its upload page), ledgered as
 *                             {kind: "doc"} exactly as these helpers do.
 *   ledgerFolder(target, …)   a folder the browser created (the workspace's
 *                             Folder button), ledgered as {kind: "folder"}
 *                             exactly as createFolder does.
 *   ledgerToken(target, …)    a personal token minted outside mintToken (the
 *                             CLI's browser login, the account page, an
 *                             OAuth exchange), ledgered as {kind: "token"}
 *                             exactly as session.mjs mintToken does.
 *
 * (A BrowserPool also ledgers, by itself, every document and folder its
 * users' pages create: browser.mjs, WHAT A PAGE CREATED. These two are for
 * the moment the case knows the id, before anything else names it.)
 *
 * Every document created is appended to the ledger, and so is every id
 * minted by absentDocId() for an absent-id probe (as "absent"). A creation
 * that answers 200 is ledgered even when the caller's `expect` turns it into
 * a throw: a document the case did not expect is still the run's. Ids are
 * `e2e-<run6>-<name>-<r4>`, at most 53 characters, so even the product's
 * "-xxxxxx" suffix for a taken id stays within its 60.
 *
 * Fixtures (e2e/fixtures/) are generated here, deterministically, and
 * committed; `node e2e/lib/seed.mjs --write-fixtures` regenerates them and
 * selftest/seed.test.mjs fails when the committed bytes drift.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { E2E_DIR, REPO_ROOT, assertPath } from "./paths.mjs";
import { appendLedger } from "./ledger.mjs";
import { rand4, runTag } from "./accounts.mjs";

export const FIXTURES_DIR = assertPath(join(E2E_DIR, "fixtures"), "fixtures");
export const DOC_ID_MAX = 53;
const DOC_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `e2e-<run6>-<name>-<r4>`, valid for the product and at most 53 characters. */
export function docIdFor(target, name = "doc") {
  const head = `e2e-${runTag(target.runId)}-`;
  const tail = `-${rand4()}`;
  const room = DOC_ID_MAX - head.length - tail.length;
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, room).replace(/-+$/, "") || "doc";
  const id = `${head}${slug}${tail}`;
  if (!DOC_ID_RE.test(id) || id.length > DOC_ID_MAX) throw new Error(`docIdFor produced an invalid id ${id}`);
  return id;
}

/**
 * An id for "the same 404 as an absent id" (SPEC §1.4b): minted like
 * docIdFor(target, name), never created, and ledgered as {kind: "absent"}.
 * The production guard then lets a write or an MCP act/comment tool name it,
 * once it has proved docs/<id> holds nothing (guard.absentDoc); without this
 * row such a probe is refused there as a document the run did not create.
 * Quarantine skips it, because it is not a document. Never publish at it.
 */
export function absentDocId(target, name = "absent") {
  const docId = docIdFor(target, name);
  appendLedger(target, { kind: "absent", docId });
  return docId;
}

/** The repo's stored-zip writer, from the tree a target runs (else this checkout). */
async function zipModule(target) {
  const fromTree = target?.stack?.treeDir ? join(target.stack.treeDir, "tools", "zip.mjs") : null;
  const path = fromTree && existsSync(fromTree) ? fromTree : join(REPO_ROOT, "tools", "zip.mjs");
  return import(pathToFileURL(path).href);
}

/** A stored zip of `{name: data}` or `[{name, data}]`. */
export async function zipBundle(entries, target) {
  const { storedZip } = await zipModule(target);
  const list = Array.isArray(entries) ? entries : Object.entries(entries).map(([name, data]) => ({ name, data }));
  return storedZip(list.map(({ name, data }) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8") })));
}

function recordDoc(target, json, via, { actor = null, ownerEmail = null, ...extra } = {}) {
  if (json?.docId) appendLedger(target, { kind: "doc", docId: json.docId, ownerEmail, actor, via, versionId: json.versionId ?? null, ...extra });
}

/**
 * Send a request that creates a document, and ledger what a 200 made — also
 * when the caller's `expect` turns that 200 into a throw (http.mjs's
 * E2E_STATUS), because a creation the case did not expect is exactly the one
 * that must not escape the ledger, and so quarantine.
 */
async function creating(send, record) {
  let r;
  try {
    r = await send();
  } catch (e) {
    if (e?.code === "E2E_STATUS" && e.response?.status === 200) record(e.response);
    throw e;
  }
  if (r.status === 200) record(r);
  return r;
}

/**
 * POST /publish as the client's actor (a session or a token client).
 *
 * @param {object} http       from session.http or bearerHttp()
 * @param {object} o
 * @param {string|Buffer} [o.body]   the file bytes (or o.fixture / o.file)
 * @param {string} [o.fixture]       a name in e2e/fixtures/
 * @param {string} [o.file]          a path to read
 * @param {string} o.filename        e.g. index.html, notes.md, bundle.zip
 * @param {string} [o.title]
 * @param {string|false} [o.id]      default docIdFor(name); false sends no id
 * @param {string} [o.folderId]
 * @param {object} [o.marking]
 * @param {number|number[]} [o.expect]  default 200; a 200 it refuses is still ledgered
 * @param {number} [o.timeoutMs]     the request's
 * @param {{ctx: object, attempts?: number, lookupMs?: number, intervalMs?: number, stopAt?: number|"budget"|null}|null} [o.patient]
 *        send it again when the stack did not answer (see PATIENT below); needs the id it names
 * @param {{readDoc: Function, rtdbGet: Function}|null} [o.admin]  a stand-in for lib/admin.mjs's reads (self-tests)
 * @returns {Promise<{status, json, docId, versionId, response, landed?}>}
 *
 * PATIENT. With `patient`, a request the stack did not answer (lib/test.mjs
 * unanswered: Hosting's cut-off 504, the client's deadline) goes through
 * untilLanded: the id it named is ledgered at once (the request may have made
 * the document), then the document's effect is looked for (publishedDoc), and
 * only then is it sent again; the case ends INCONCLUSIVE when that keeps
 * happening. A document found instead of an answer is ledgered and returned
 * as {status: null, json: {docId, versionId, title, fileCount, format},
 * docId, versionId, response: null, landed: true}; an answer as publish
 * returns it, plus `landed: false`. A resend after the first request made the
 * document after all is answered under a suffixed id (the product's rule for
 * a taken id): use the docId returned.
 */
export async function publish(http, o = {}) {
  if (o.patient !== null && o.patient !== undefined) return publishPatiently(http, o);
  const target = http.target;
  let body = o.body;
  if (o.fixture) body = readFixture(o.fixture, { raw: true });
  if (o.file) body = readFileSync(o.file);
  if (body === undefined) throw new Error("publish: give body, fixture or file");
  const filename = o.filename ?? (o.fixture ? o.fixture : o.file ? basename(o.file) : "index.html");
  const id = o.id === false ? undefined : (o.id ?? docIdFor(target, o.name ?? filename.replace(/\.[^.]+$/, "")));
  const query = { filename, title: o.title, id, folderId: o.folderId, marking: o.marking ? JSON.stringify(o.marking) : undefined, ...(o.query ?? {}) };
  const r = await creating(
    () =>
      http.request("POST", "/publish", {
        query,
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8"),
        expect: o.expect ?? 200,
        timeoutMs: o.timeoutMs,
      }),
    (res) => recordDoc(target, res.json, "upload", { actor: http.actor, ownerEmail: o.ownerEmail }),
  );
  return { status: r.status, json: r.json, docId: r.json?.docId, versionId: r.json?.versionId, response: r };
}

const PATIENT_FIELDS = Object.freeze(["ctx", "attempts", "lookupMs", "intervalMs", "stopAt"]);

/** `patient` checked: {ctx, opts} for lib/test.mjs untilLanded. */
function patience(patient, who) {
  if (patient === null || typeof patient !== "object" || Array.isArray(patient)) throw new TypeError(`${who}: patient is {${PATIENT_FIELDS.join(", ")}}, got ${JSON.stringify(patient) ?? String(patient)}`);
  const unknown = Object.keys(patient).filter((k) => !PATIENT_FIELDS.includes(k));
  if (unknown.length > 0) throw new TypeError(`${who}: patient has unknown field ${unknown.map((k) => JSON.stringify(k)).join(", ")} (known: ${PATIENT_FIELDS.join(", ")})`);
  if (patient.ctx === null || typeof patient.ctx !== "object") throw new TypeError(`${who}: patient.ctx is the case's ctx (its steps say what was sent again; it ends the case INCONCLUSIVE), got ${patient.ctx === null ? "null" : typeof patient.ctx}`);
  const { ctx, ...rest } = patient;
  return { ctx, opts: Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
}

/** `admin` as publish and publishMcp take it: null, or a stand-in {readDoc, rtdbGet} for lib/admin.mjs. */
async function recordReader(admin, who) {
  if (admin === null || admin === undefined) return import("./admin.mjs");
  if (typeof admin?.readDoc !== "function" || typeof admin?.rtdbGet !== "function") throw new Error(`${who}: admin is a stand-in {readDoc, rtdbGet} for lib/admin.mjs (self-tests), or null`);
  return admin;
}

/**
 * The effect of a POST /publish or publish_document that named `docId`
 * (functions/src/lib/publish.ts publishNewDocument writes the bytes, then the
 * record and its first version in one batch, then the RTDB presence mirror,
 * and answers): the record with a current version, and the mirror,
 * presenceAccess/<id>, its last write. {docId, versionId, title, fileCount,
 * format}, or null while either is missing.
 */
async function publishedDoc(target, docId, reader) {
  const d = await reader.readDoc(target, `docs/${docId}`);
  if (typeof d?.currentVersion !== "string" || !d.currentVersion) return null;
  const presence = await reader.rtdbGet(target, `presenceAccess/${docId}`);
  if (presence === null || presence === undefined) return null;
  const v = await reader.readDoc(target, `docs/${docId}/versions/${d.currentVersion}`);
  return { docId, versionId: d.currentVersion, title: d.title ?? null, fileCount: v?.fileCount ?? null, format: v?.format ?? null };
}

/** publish with `patient`: see PATIENT at publish. */
async function publishPatiently(http, o) {
  const target = http.target;
  const { ctx, opts } = patience(o.patient, "publish");
  if (o.id === false) throw new Error("publish: patient needs the id the request names (id: false sends none, so a resend could not be told from what the first one made)");
  const filename = o.filename ?? (o.fixture ? o.fixture : o.file ? basename(o.file) : "index.html");
  const id = o.id ?? docIdFor(target, o.name ?? filename.replace(/\.[^.]+$/, ""));
  const reader = await recordReader(o.admin, "publish");
  const { untilLanded } = await import("./test.mjs");
  const ledger = (versionId) => recordDoc(target, { docId: id, versionId }, "upload", { actor: http.actor, ownerEmail: o.ownerEmail });
  let ledgered = false;
  const r = await untilLanded(ctx, `POST /publish ${id}`, () => publish(http, { ...o, id, patient: null }), () => publishedDoc(target, id, reader), {
    ...opts,
    onFail: () => {
      if (ledgered) return;
      ledgered = true;
      ledger(null); // the request may have made it
    },
  });
  if (r.out) return { ...r.out, landed: false };
  ledger(r.landed.versionId);
  return { status: null, json: r.landed, docId: id, versionId: r.landed.versionId, response: null, landed: true };
}

/** POST /publish with a stored zip built from `entries`. */
export async function publishZip(http, entries, o = {}) {
  const body = await zipBundle(entries, http.target);
  return publish(http, { ...o, body, filename: o.filename ?? "bundle.zip" });
}

/**
 * POST /fork {op: "create"} as the client's actor: a copy of a version the
 * caller can read, as a new private document they own (SPEC §21). Only the
 * fields given are sent. The new document is ledgered as {kind: "doc",
 * via: "fork", forkOf: <the source>} (the link key never is), so on
 * production quarantine walks it and the guard lets later writes name it.
 *
 * Its id is the product's — a slug of the title, made unique — not a
 * docIdFor id: pass `title` to choose it. No status is expected unless
 * `expect` says so; a 200 is ledgered even when `expect` refuses it.
 *
 * @param {object} http              from session.http or bearerHttp()
 * @param {object} o
 * @param {string} o.docId           the document to fork
 * @param {string} [o.k]             the source's link key
 * @param {string} [o.versionId]     default the source's current version
 * @param {string} [o.folderId]      default the caller's root
 * @param {string} [o.title]         default the source's title
 * @param {string} [o.ownerEmail]    the caller's email, for the ledger row
 * @param {number|number[]} [o.expect]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{status, json, docId, versionId, response}>}  docId and versionId are the fork's
 */
export async function fork(http, o = {}) {
  if (typeof o.docId !== "string" || !o.docId) throw new Error("fork: give docId, the document to fork");
  const target = http.target;
  const body = { op: "create", docId: o.docId };
  for (const k of ["k", "versionId", "folderId", "title"]) if (o[k] !== undefined) body[k] = o[k];
  const r = await creating(
    () => http.postJson("/fork", body, { expect: o.expect, timeoutMs: o.timeoutMs }),
    (res) => recordDoc(target, res.json, "fork", { actor: http.actor, ownerEmail: o.ownerEmail, forkOf: o.docId }),
  );
  return { status: r.status, json: r.json, docId: r.json?.docId, versionId: r.json?.versionId, response: r };
}

/** The product's document id rule (functions/src/lib/folders.ts isValidDocId): what a created document's id always is. */
const PRODUCT_DOC_ID_MAX = 60;
const LEDGER_DOC_FIELDS = Object.freeze(["docId", "ownerEmail", "via", "actor", "versionId", "forkOf"]);

/**
 * Ledger a document the run created some other way than these helpers: the
 * app's Fork button or upload page in a browser, the CLI, a raw MCP tool. On
 * production the guard refuses every later act on a document the ledger does
 * not hold, and quarantine walks only ledgered documents, so a spec ledgers
 * such a document the moment it knows the id (the page it opened, the
 * response's `docId`), before anything else names it.
 *
 * The row is the one publish()/fork() append: {kind: "doc", docId,
 * ownerEmail, actor, via, versionId[, forkOf]}. `via` says how it was made
 * ("fork-ui", "upload-ui", "cli", …); a fork names its source in `forkOf`.
 * `docId` must be an id the product can have made (lowercase letters, digits
 * and single hyphens between them, at most 60 characters), so a path, a URL
 * or an undefined is refused rather than ledgered. An unknown field throws
 * (`owner` for `ownerEmail` would otherwise ledger nothing useful); nothing
 * is sent anywhere. Appending a document twice is harmless.
 *
 * @param {object} target
 * @param {object} o
 * @param {string} o.docId           the created document's id
 * @param {string} o.via             how it was made, e.g. "fork-ui"
 * @param {string|null} [o.ownerEmail]  its owner's email
 * @param {string|null} [o.actor]    the case's name for whoever made it
 * @param {string|null} [o.versionId]  its first version, if known
 * @param {string} [o.forkOf]        a fork's source document
 * @returns {object} the row appended (without `t` and `runId`)
 */
export function ledgerDoc(target, o = {}) {
  if (!target?.runDir) throw new Error("ledgerDoc: target is a Target with a runDir");
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error("ledgerDoc: give {docId, via, ownerEmail?, actor?, versionId?, forkOf?}");
  const unknown = Object.keys(o).filter((k) => !LEDGER_DOC_FIELDS.includes(k));
  if (unknown.length > 0) throw new Error(`ledgerDoc: unknown field ${unknown.map((k) => JSON.stringify(k)).join(", ")} (known: ${LEDGER_DOC_FIELDS.join(", ")})`);
  const productId = (id) => typeof id === "string" && id.length <= PRODUCT_DOC_ID_MAX && DOC_ID_RE.test(id);
  if (!productId(o.docId)) throw new Error(`ledgerDoc: docId is a document id as the product makes them (lowercase letters, digits, hyphens between them, at most ${PRODUCT_DOC_ID_MAX}), got ${JSON.stringify(o.docId)}`);
  if (typeof o.via !== "string" || !o.via.trim()) throw new Error(`ledgerDoc: via says how the document was made ("fork-ui", "upload-ui", …), got ${JSON.stringify(o.via)}`);
  for (const k of ["ownerEmail", "actor", "versionId"]) {
    if (o[k] != null && (typeof o[k] !== "string" || !o[k])) throw new Error(`ledgerDoc: ${k} is a non-empty string or null, got ${JSON.stringify(o[k])}`);
  }
  if (o.forkOf !== undefined && !productId(o.forkOf)) throw new Error(`ledgerDoc: forkOf is the source's document id, got ${JSON.stringify(o.forkOf)}`);
  const row = { kind: "doc", docId: o.docId, ownerEmail: o.ownerEmail ?? null, actor: o.actor ?? null, via: o.via, versionId: o.versionId ?? null };
  if (o.forkOf !== undefined) row.forkOf = o.forkOf;
  return appendLedger(target, row);
}

/** A folder id as the product makes them: Firestore's 20-character auto id (functions/src/lib/folders.ts createFolderRecord). */
const PRODUCT_FOLDER_ID_RE = /^[A-Za-z0-9]{20}$/;
const LEDGER_FOLDER_FIELDS = Object.freeze(["folderId", "via", "ownerEmail", "actor", "parentId", "name"]);

/**
 * Ledger a folder the run created some other way than createFolder or
 * createFolderMcp: the workspace's Folder button in a browser, the CLI. On
 * production the guard refuses every later write that names a folder the
 * ledger does not hold (rule "ledger-folder"), so a spec ledgers such a folder
 * the moment it knows the id (POST /folder's answer, the page it opened),
 * before anything else names it.
 *
 * The row is createFolder's, {kind: "folder", folderId, ownerEmail, actor,
 * parentId, name}, plus `via`: how it was made ("folder-ui", "cli", …).
 * `folderId` (and a `parentId` that is not null) must be an id the product
 * can have made, Firestore's 20-character auto id, so a path, a URL, a
 * createFolder result or an undefined is refused rather than ledgered. An
 * unknown field throws (`owner` for `ownerEmail` would otherwise ledger
 * nothing useful); nothing is sent anywhere. Appending a folder twice is
 * harmless.
 *
 * @param {object} target
 * @param {object} o
 * @param {string} o.folderId          the created folder's id
 * @param {string} o.via               how it was made, e.g. "folder-ui"
 * @param {string|null} [o.ownerEmail] its owner's email
 * @param {string|null} [o.actor]      the case's name for whoever made it
 * @param {string|null} [o.parentId]   the folder it was made in; null (the default) is the root
 * @param {string|null} [o.name]       its name, as the product answered it
 * @returns {object} the row appended (without `t` and `runId`)
 */
export function ledgerFolder(target, o = {}) {
  if (!target?.runDir) throw new Error("ledgerFolder: target is a Target with a runDir");
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error("ledgerFolder: give {folderId, via, ownerEmail?, actor?, parentId?, name?}");
  const unknown = Object.keys(o).filter((k) => !LEDGER_FOLDER_FIELDS.includes(k));
  if (unknown.length > 0) throw new Error(`ledgerFolder: unknown field ${unknown.map((k) => JSON.stringify(k)).join(", ")} (known: ${LEDGER_FOLDER_FIELDS.join(", ")})`);
  const productId = (id) => typeof id === "string" && PRODUCT_FOLDER_ID_RE.test(id);
  if (!productId(o.folderId)) throw new Error(`ledgerFolder: folderId is a folder id as the product makes them (20 letters and digits), got ${JSON.stringify(o.folderId)}`);
  if (typeof o.via !== "string" || !o.via.trim()) throw new Error(`ledgerFolder: via says how the folder was made ("folder-ui", "cli", …), got ${JSON.stringify(o.via)}`);
  for (const k of ["ownerEmail", "actor", "name"]) {
    if (o[k] != null && (typeof o[k] !== "string" || !o[k])) throw new Error(`ledgerFolder: ${k} is a non-empty string or null, got ${JSON.stringify(o[k])}`);
  }
  if (o.parentId != null && !productId(o.parentId)) throw new Error(`ledgerFolder: parentId is the parent folder's id, or null for the root, got ${JSON.stringify(o.parentId)}`);
  const row = { kind: "folder", folderId: o.folderId, ownerEmail: o.ownerEmail ?? null, actor: o.actor ?? null, parentId: o.parentId ?? null, name: o.name ?? null, via: o.via };
  return appendLedger(target, row);
}

/** A personal token's id as the product makes them: 16 random bytes in hex (functions/src/lib/tokens.ts ID_BYTES), the part of bsk_<id>.<secret> before the dot. */
const PRODUCT_TOKEN_ID_RE = /^[0-9a-f]{32}$/;
/** The channels a personal token has (functions/src/lib/tokens.ts TokenChannel). */
export const TOKEN_CHANNELS = Object.freeze(["cli", "mcp", "api"]);
const LEDGER_TOKEN_FIELDS = Object.freeze(["tokenId", "uid", "channel", "name", "via"]);
/** A Firebase uid: 1 to 128 characters, no whitespace and no slash. */
const UID_RE = /^[^\s/]{1,128}$/;

/**
 * Ledger a personal token the run minted some other way than session.mjs
 * mintToken (which ledgers its own): the CLI's browser login (`bikeshed
 * login`, an OAuth exchange that answers a bsk_ token), the account page's
 * Access tokens, a raw POST /tokens. The run's ledger is its record of what
 * it holds on a deployment, so a spec ledgers such a token the moment it
 * knows its id (the saved config.json, a token list, the revealed value).
 *
 * The row is mintToken's, {kind: "token", tokenId, uid, channel, name}, plus
 * `via` (how it was made: "cli-login", "account-ui", …) only when given.
 * `tokenId` must be an id the product can have made (32 lowercase hex
 * digits); the whole token, secret included, is refused without being
 * echoed, and so is anything else credential-shaped (lib/ledger.mjs).
 * `channel` is one of TOKEN_CHANNELS, `uid` the account's uid, `name` the
 * token's name as the product lists it (a string, "" included, or null).
 * An unknown field throws; nothing is sent anywhere. Twice is harmless.
 *
 * @param {object} target
 * @param {object} o
 * @param {string} o.tokenId         the token's id (never the token)
 * @param {string} o.uid             the account it belongs to
 * @param {"cli"|"mcp"|"api"} o.channel
 * @param {string|null} [o.name]     its name, as the product lists it
 * @param {string} [o.via]           how it was made, e.g. "cli-login"
 * @returns {object} the row appended (without `t` and `runId`)
 */
export function ledgerToken(target, o = {}) {
  if (!target?.runDir) throw new Error("ledgerToken: target is a Target with a runDir");
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error("ledgerToken: give {tokenId, uid, channel, name?, via?}");
  const unknown = Object.keys(o).filter((k) => !LEDGER_TOKEN_FIELDS.includes(k));
  if (unknown.length > 0) throw new Error(`ledgerToken: unknown field ${unknown.map((k) => JSON.stringify(k)).join(", ")} (known: ${LEDGER_TOKEN_FIELDS.join(", ")}); a row never carries the token itself`);
  if (typeof o.tokenId === "string" && /^bs[kar]_/.test(o.tokenId)) throw new Error("ledgerToken: tokenId is the whole token, secret included: give only its id, the 32 hex digits after bsk_ (the value is not repeated here)");
  if (typeof o.tokenId !== "string" || !PRODUCT_TOKEN_ID_RE.test(o.tokenId)) {
    throw new Error(`ledgerToken: tokenId is a token's id as the product makes them (32 lowercase hex digits), got ${typeof o.tokenId === "string" ? `a string of ${o.tokenId.length} characters` : JSON.stringify(o.tokenId) ?? String(o.tokenId)}`);
  }
  if (typeof o.uid !== "string" || !UID_RE.test(o.uid)) throw new Error(`ledgerToken: uid is the account's uid, got ${JSON.stringify(o.uid) ?? String(o.uid)}`);
  if (!TOKEN_CHANNELS.includes(o.channel)) throw new Error(`ledgerToken: channel is one of ${TOKEN_CHANNELS.join(", ")}, got ${JSON.stringify(o.channel) ?? String(o.channel)}`);
  if (o.name != null && typeof o.name !== "string") throw new Error(`ledgerToken: name is a string or null, got ${JSON.stringify(o.name)}`);
  if (o.via !== undefined && (typeof o.via !== "string" || !o.via.trim())) throw new Error(`ledgerToken: via says how the token was made ("cli-login", "account-ui", …), got ${JSON.stringify(o.via) ?? String(o.via)}`);
  const row = { kind: "token", tokenId: o.tokenId, uid: o.uid, channel: o.channel, name: o.name ?? null };
  if (o.via !== undefined) row.via = o.via;
  return appendLedger(target, row);
}

/**
 * POST /team {op: "create", name} as the client's actor: a team the caller
 * owns, administers and is the only member of (SPEC §18). A 200 is ledgered
 * as {kind: "team", teamId, ownerEmail, actor, name}, also when `expect`
 * refuses it. The name is sent as given (the product trims it and refuses an
 * empty one or one over 120 characters); without one it is
 * `e2e <run6> team <r4>`.
 *
 * Production refuses POST /team (guard.mjs, rule "team"), so this is a
 * local-stack helper in practice; the ledger row is the run's record of the
 * team either way.
 *
 * @param {object} http              from session.http or bearerHttp()
 * @param {object} [o]
 * @param {string} [o.name]          default `e2e <run6> team <r4>`
 * @param {string} [o.ownerEmail]    the caller's email, for the ledger row
 * @param {number|number[]|null} [o.expect]  default 200; null expects nothing
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{status, json, teamId, name, response}>}  `name` is the one the server answered, else the one sent
 */
export async function createTeam(http, o = {}) {
  const target = http.target;
  const name = o.name === undefined ? `e2e ${runTag(target.runId)} team ${rand4()}` : o.name;
  const r = await creating(
    () => http.postJson("/team", { op: "create", name }, { expect: o.expect === undefined ? 200 : (o.expect ?? undefined), timeoutMs: o.timeoutMs }),
    (res) => {
      if (typeof res.json?.teamId === "string" && res.json.teamId) {
        appendLedger(target, { kind: "team", teamId: res.json.teamId, ownerEmail: o.ownerEmail ?? null, actor: http.actor ?? null, name: res.json.name ?? name });
      }
    },
  );
  return { status: r.status, json: r.json, teamId: r.json?.teamId, name: r.json?.name ?? name, response: r };
}

/**
 * POST /folder {name, parentId} as the client's actor: a folder the caller
 * owns, at their root or inside `parentId` (one they may put things in). A
 * 200 is ledgered as {kind: "folder", folderId, ownerEmail, actor, parentId,
 * name}, also when `expect` refuses it, so on production the guard lets
 * later writes name it (rule "ledger-folder") and a folder made inside it.
 * `name` is sent as given (the product trims it and refuses an empty one or
 * one over 120 characters); without it, `e2e <run6> folder <r4>`.
 * `parentId` is sent only when given (null is the root, as is no parentId).
 *
 * @param {object} http              from session.http or bearerHttp()
 * @param {object} [o]
 * @param {string} [o.name]          default `e2e <run6> folder <r4>`
 * @param {string|object|null} [o.parentId]  a folder id, or a createFolder result
 * @param {string} [o.ownerEmail]    the caller's email, for the ledger row
 * @param {number|number[]|null} [o.expect]  default 200; null expects nothing
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{status, json, folderId, name, parentId, response}>}  `name` is the one the server answered, else the one sent
 */
export async function createFolder(http, o = {}) {
  const target = http.target;
  const name = o.name === undefined ? `e2e ${runTag(target.runId)} folder ${rand4()}` : o.name;
  const parentId = o.parentId !== null && typeof o.parentId === "object" ? o.parentId.folderId : o.parentId;
  if (o.parentId !== undefined && o.parentId !== null && typeof o.parentId === "object" && typeof parentId !== "string") throw new Error("createFolder: parentId is a folder id or a createFolder result");
  const body = { name };
  if (parentId !== undefined) body.parentId = parentId;
  const r = await creating(
    () => http.postJson("/folder", body, { expect: o.expect === undefined ? 200 : (o.expect ?? undefined), timeoutMs: o.timeoutMs }),
    (res) => {
      if (typeof res.json?.folderId === "string" && res.json.folderId) {
        appendLedger(target, { kind: "folder", folderId: res.json.folderId, ownerEmail: o.ownerEmail ?? null, actor: http.actor ?? null, parentId: parentId ?? null, name: res.json.name ?? name });
      }
    },
  );
  return { status: r.status, json: r.json, folderId: r.json?.folderId, name: r.json?.name ?? name, parentId: parentId ?? null, response: r };
}

/**
 * POST /publish?update=<docId> — a new version from bytes. Not a creation: nothing is ledgered.
 * `timeoutMs` is the request's, as publish() takes it (else the client's: http.mjs's 60 s by
 * default); past Hosting's 60 s cut-off, a loaded stack's own 504 is what the case sees.
 */
export async function updateUpload(http, docId, o = {}) {
  let body = o.body;
  if (o.fixture) body = readFixture(o.fixture, { raw: true });
  if (body === undefined) throw new Error("updateUpload: give body or fixture");
  const r = await http.request("POST", "/publish", {
    query: { filename: o.filename ?? "index.html", update: docId, baseVersion: o.baseVersion, k: o.k, ...(o.query ?? {}) },
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8"),
    expect: o.expect,
    timeoutMs: o.timeoutMs,
  });
  return { status: r.status, json: r.json, response: r };
}

/**
 * publish_document through an MCP client. `id` defaults to docIdFor(title).
 * With `patient` (and `admin`) as publish takes them: a call the stack did
 * not answer (an HTTP 504 at Hosting's cut-off, the client's deadline) goes
 * through untilLanded, the id it named is ledgered (via "mcp") at once, and
 * a document found instead of an answer is returned as {isError: false,
 * text: null, json: {docId, versionId, title, fileCount, format}, result:
 * null, docId, landed: true}; an answer as before, plus `landed: false`.
 * @returns {Promise<{isError, text, json, docId, landed?}>}
 */
export async function publishMcp(mcp, { title, content, format = "html", id, folder, patient = null, admin = null } = {}) {
  const target = mcp.http.target;
  const wanted = id === false ? undefined : (id ?? docIdFor(target, title ?? "mcp"));
  if (patient !== null && patient !== undefined) {
    const { ctx, opts } = patience(patient, "publishMcp");
    if (!wanted) throw new Error("publishMcp: patient needs the id the call names (id: false sends none, so a resend could not be told from what the first one made)");
    const reader = await recordReader(admin, "publishMcp");
    const { untilLanded } = await import("./test.mjs");
    const ledger = (versionId) => recordDoc(target, { docId: wanted, versionId }, "mcp", { actor: mcp.http.actor });
    let ledgered = false;
    const r = await untilLanded(ctx, `MCP publish_document ${wanted}`, () => publishMcp(mcp, { title, content, format, id: wanted, folder }), () => publishedDoc(target, wanted, reader), {
      ...opts,
      onFail: () => {
        if (ledgered) return;
        ledgered = true;
        ledger(null); // the call may have made it
      },
    });
    if (r.out) return { ...r.out, landed: false };
    ledger(r.landed.versionId);
    return { isError: false, text: null, json: r.landed, result: null, docId: wanted, landed: true };
  }
  const out = await mcp.call("publish_document", { title, content, format, ...(wanted ? { id: wanted } : {}), ...(folder ? { folder } : {}) });
  if (!out.isError) recordDoc(target, out.json, "mcp", { actor: mcp.http.actor });
  return { ...out, docId: out.json?.docId };
}

const FOLDER_MCP_FIELDS = Object.freeze(["name", "parent", "ownerEmail"]);

/**
 * create_folder through an MCP client (SPEC §13, §19): a folder the token's
 * account owns, at its root or inside `parent` (a folder id, or a
 * createFolder / createFolderMcp result; sent only when given, null is the
 * root). A success is ledgered as createFolder's row, {kind: "folder",
 * folderId, ownerEmail, actor, parentId, name}, so on production the guard
 * lets later writes and tools name it (rule "ledger-folder"), and a folder
 * made inside it. Like publishMcp it never throws on a tool error: check
 * `isError` (a refusal creates nothing, and nothing is ledgered). A JSON-RPC
 * or HTTP failure throws, as mcp.call does. `name` is sent as given (the
 * product trims it and refuses an empty one or one over 120 characters);
 * without it, `e2e <run6> folder <r4>`.
 *
 * @param {object} mcp                an initialized mcpClient (lib/mcp.mjs)
 * @param {object} [o]
 * @param {string} [o.name]           default `e2e <run6> folder <r4>`
 * @param {string|object|null} [o.parent]  a folder id, or a createFolder/createFolderMcp result
 * @param {string} [o.ownerEmail]     the token's account's email, for the ledger row
 * @returns {Promise<{isError, text, json, result, folderId, name, parentId}>}  `folderId` undefined unless it was made; `name` the one the tool answered, else the one sent
 */
export async function createFolderMcp(mcp, o = {}) {
  const target = mcp?.http?.target;
  if (!target || typeof mcp.call !== "function") throw new Error("createFolderMcp: mcp is an mcpClient (lib/mcp.mjs)");
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error("createFolderMcp: give {name?, parent?, ownerEmail?}");
  const unknown = Object.keys(o).filter((k) => !FOLDER_MCP_FIELDS.includes(k));
  if (unknown.length > 0) throw new Error(`createFolderMcp: unknown field ${unknown.map((k) => JSON.stringify(k)).join(", ")} (known: ${FOLDER_MCP_FIELDS.join(", ")})`);
  const name = o.name === undefined ? `e2e ${runTag(target.runId)} folder ${rand4()}` : o.name;
  const parentId = o.parent !== null && typeof o.parent === "object" ? o.parent.folderId : o.parent;
  if (o.parent != null && (typeof parentId !== "string" || parentId === "")) throw new Error("createFolderMcp: parent is a folder id or a createFolder/createFolderMcp result");
  const args = { name };
  if (parentId != null) args.parent = parentId;
  const out = await mcp.call("create_folder", args);
  const made = !out.isError && typeof out.json?.folderId === "string" && out.json.folderId !== "";
  const answered = made && typeof out.json.name === "string" ? out.json.name : name;
  if (made) appendLedger(target, { kind: "folder", folderId: out.json.folderId, ownerEmail: o.ownerEmail ?? null, actor: mcp.http.actor ?? null, parentId: parentId ?? null, name: answered });
  return { ...out, folderId: made ? out.json.folderId : undefined, name: answered, parentId: parentId ?? null };
}

const FORK_MCP_FIELDS = Object.freeze(["id", "version", "title", "folder", "k", "ownerEmail"]);
const FORK_MCP_HINTS = Object.freeze({ docId: "id", versionId: "version", folderId: "folder" });

/**
 * fork_document through an MCP client (SPEC §19, §21): a copy of a version
 * the token's account can read, as a new private document it owns. Only the
 * arguments given are sent, as given: `id` the source, `version` (default
 * its current one), `title`, `folder` (a folder id, or a createFolder /
 * createFolderMcp result) and `k`, its link key. A success is ledgered as
 * fork() ledgers one, {kind: "doc", docId, ownerEmail, actor, via:
 * "mcp-fork", versionId, forkOf} (`forkOf` the source's id as the product
 * reads it, trimmed; never the key), so on production quarantine walks the
 * fork and the guard lets later tools name it. Like publishMcp it never
 * throws on a tool error: check `isError` (a refusal creates nothing, and
 * nothing is ledgered). A JSON-RPC or HTTP failure throws, as mcp.call does.
 * An unknown field (`docId` for `id`) throws before anything is sent.
 *
 * @param {object} mcp                 an initialized mcpClient (lib/mcp.mjs)
 * @param {object} o
 * @param {string} o.id                the document to fork
 * @param {string} [o.version]         e.g. "v3"
 * @param {string} [o.title]           default the source's title
 * @param {string|object} [o.folder]   a folder id, or a createFolder/createFolderMcp result; default the root
 * @param {string} [o.k]               the source's link key
 * @param {string} [o.ownerEmail]      the token's account's email, for the ledger row
 * @returns {Promise<{isError, text, json, result, docId, versionId}>}  the fork's docId and versionId, undefined unless it was made
 */
export async function forkMcp(mcp, o = {}) {
  const target = mcp?.http?.target;
  if (!target || typeof mcp.call !== "function") throw new Error("forkMcp: mcp is an mcpClient (lib/mcp.mjs)");
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error("forkMcp: give {id, version?, title?, folder?, k?, ownerEmail?}");
  const unknown = Object.keys(o).filter((k) => !FORK_MCP_FIELDS.includes(k));
  if (unknown.length > 0) {
    const hint = unknown.filter((k) => FORK_MCP_HINTS[k]).map((k) => `${k} is ${FORK_MCP_HINTS[k]}`);
    throw new Error(`forkMcp: unknown field ${unknown.map((k) => JSON.stringify(k)).join(", ")} (known: ${FORK_MCP_FIELDS.join(", ")}${hint.length ? `; ${hint.join(", ")}` : ""})`);
  }
  if (typeof o.id !== "string" || !o.id.trim()) throw new Error(`forkMcp: id is the document to fork, got ${JSON.stringify(o.id) ?? String(o.id)}`);
  const folder = o.folder !== null && typeof o.folder === "object" ? o.folder.folderId : o.folder;
  if (o.folder !== null && typeof o.folder === "object" && (typeof folder !== "string" || folder === "")) throw new Error("forkMcp: folder is a folder id or a createFolder/createFolderMcp result");
  const args = {};
  for (const [k, v] of [["id", o.id], ["version", o.version], ["folder", folder], ["title", o.title], ["k", o.k]]) if (v !== undefined) args[k] = v;
  const out = await mcp.call("fork_document", args);
  const made = !out.isError && typeof out.json?.docId === "string" && out.json.docId !== "";
  if (made) recordDoc(target, out.json, "mcp-fork", { actor: mcp.http.actor ?? null, ownerEmail: o.ownerEmail ?? null, forkOf: o.id.trim() });
  return { ...out, docId: made ? out.json.docId : undefined, versionId: made ? out.json.versionId : undefined };
}

/** add_comment's own bound (functions/src/mcp/tools.ts): a body is trimmed and kept to this many characters. */
const COMMENT_BODY_MAX = 5000;
/** Threads per Admin batch: two writes each (the thread and its first comment), well inside Firestore's 500. */
const SEED_BATCH_THREADS = 200;
/** The most threads one seedThreads call opens. */
export const SEED_THREADS_MAX = 500;
/** How seedThreads opens its threads. */
export const SEED_THREADS_VIA = Object.freeze(["admin", "tool"]);
const SEED_THREADS_FIELDS = Object.freeze(["docId", "n", "exact", "prefix", "suffix", "k", "body", "via", "db"]);

/** A seeding step that did not hold: setup, not the thing under test, so it FAILS even a defect case (test.mjs precondition). */
function seedPrecondition(message, extra = {}) {
  const err = new Error(`precondition: seedThreads: ${message}`);
  err.code = "E2E_PRECONDITION";
  return Object.assign(err, extra);
}

/**
 * `n` open comment threads on a document's current version, oldest first,
 * each as add_comment opens one: the thread on `exact` and its first
 * comment, by the token's account, on the mcp channel (SPEC §4, §19). Setup
 * for what a long list shows (get_comments' cap of 50, its order past it),
 * not a test of add_comment.
 *
 *   via "tool"   n add_comment calls, one after another, so createdAt order
 *                is call order. Each goes through http.mjs, so on production
 *                the guard sends it only once the document is proved quiet
 *                (assertQuietDoc). The default on every target but a local one.
 *   via "admin"  LOCAL only: on any other target it throws E2E_LOCAL_ONLY
 *                before anything is sent. ONE add_comment opens the first
 *                thread; the other n − 1 are copies of what it wrote (the
 *                thread and its comment, read back through lib/admin.mjs),
 *                written in Admin batches, each with fresh ids, its own body
 *                and createdAt the first's plus 1, 2, … ms. So the anchor,
 *                the actor and every other field are the product's own, and
 *                fifty threads cost one tool call. It returns only once the
 *                clock has passed the last copy's createdAt, so a thread
 *                opened afterwards sorts after every one of them. The
 *                default on a local target.
 *
 * Either way each thread fires what a real one fires (the change log's
 * triggers, onCommentCreated): cast the accounts with comment email off.
 * A refused add_comment throws E2E_PRECONDITION with the tool's words, its
 * `outcome`, and the `threadIds` opened before it. A request the stack did
 * not answer throws as http.mjs, mcp.mjs or the Admin SDK threw it, so
 * inconclusiveOnStackTimeout (lib/test.mjs) can judge it. Every argument is
 * checked before anything is sent.
 *
 * @param {object} mcp                 an initialized mcpClient for the author's token
 * @param {object} o
 * @param {string} o.docId             the document
 * @param {number} o.n                 how many threads, 1 to SEED_THREADS_MAX
 * @param {string} o.exact             the passage, as add_comment takes it
 * @param {string} [o.prefix]          sent only when given
 * @param {string} [o.suffix]          sent only when given
 * @param {string} [o.k]               the link key, sent only when given
 * @param {string|function} [o.body]   one body for all, or (i) => thread i's (1-based); default `Thread <i>.`
 * @param {"admin"|"tool"} [o.via]     default "admin" on a local target, else "tool"
 * @param {object} [o.db]              replaces adminFor(target).db (a self-test's stand-in)
 * @returns {Promise<{threadIds: string[], version: string, via: "admin"|"tool"}>}  threadIds oldest first
 */
export async function seedThreads(mcp, o = {}) {
  const target = mcp?.http?.target;
  if (!target || typeof mcp.call !== "function") throw new TypeError("seedThreads: mcp is an mcpClient (lib/mcp.mjs) for the author's token");
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new TypeError("seedThreads: give {docId, n, exact, prefix?, suffix?, k?, body?, via?}");
  const unknown = Object.keys(o).filter((k) => !SEED_THREADS_FIELDS.includes(k));
  if (unknown.length > 0) throw new TypeError(`seedThreads: unknown field ${unknown.map((k) => JSON.stringify(k)).join(", ")} (known: ${SEED_THREADS_FIELDS.join(", ")})`);
  const show = (v) => JSON.stringify(v) ?? String(v);
  if (typeof o.docId !== "string" || !o.docId) throw new TypeError(`seedThreads: docId is the document's id, got ${show(o.docId)}`);
  if (!Number.isInteger(o.n) || o.n < 1 || o.n > SEED_THREADS_MAX) throw new TypeError(`seedThreads: n is a whole number from 1 to ${SEED_THREADS_MAX}, got ${show(o.n)}`);
  if (typeof o.exact !== "string" || !o.exact.trim()) throw new TypeError(`seedThreads: exact is the passage to quote, got ${show(o.exact)}`);
  for (const k of ["prefix", "suffix", "k"]) if (o[k] !== undefined && typeof o[k] !== "string") throw new TypeError(`seedThreads: ${k} is a string, got ${show(o[k])}`);
  if (o.via !== undefined && !SEED_THREADS_VIA.includes(o.via)) throw new TypeError(`seedThreads: via is ${SEED_THREADS_VIA.map((v) => `"${v}"`).join(" or ")}, got ${show(o.via)}`);
  if (o.body !== undefined && typeof o.body !== "string" && typeof o.body !== "function") throw new TypeError(`seedThreads: body is a string or (i) => string, got ${show(o.body)}`);
  const via = o.via ?? (target.kind === "local" ? "admin" : "tool");
  if (via === "admin" && target.kind !== "local") {
    const err = new Error(`seedThreads: local only — via "admin" writes through the Admin SDK, which a run never does on ${target.kind}; leave via unset there (guarded add_comment calls)`);
    err.code = "E2E_LOCAL_ONLY";
    throw err;
  }
  const n = o.n;
  const bodyOf = typeof o.body === "function" ? o.body : o.body === undefined ? (i) => `Thread ${i}.` : () => o.body;
  const sent = [];
  const stored = [];
  for (let i = 1; i <= n; i += 1) {
    const raw = bodyOf(i);
    if (typeof raw !== "string") throw new TypeError(`seedThreads: body ${i} is a string, got ${show(raw)}`);
    if (!raw.trim()) throw new TypeError(`seedThreads: body ${i} is empty once trimmed (add_comment refuses "body is empty")`);
    sent.push(raw);
    stored.push(raw.trim().slice(0, COMMENT_BODY_MAX));
  }

  const ids = [];
  let version = null;
  /** add_comment for thread i (1-based): its threadId, or E2E_PRECONDITION. */
  const open = async (i) => {
    const args = { id: o.docId, exact: o.exact, body: sent[i - 1] };
    for (const k of ["prefix", "suffix", "k"]) if (o[k] !== undefined) args[k] = o[k];
    const out = await mcp.call("add_comment", args);
    const threadId = out.json?.threadId;
    if (out.isError || typeof threadId !== "string" || !threadId) {
      throw seedPrecondition(`add_comment ${i} of ${n} on ${o.docId} was refused: ${out.text || "no threadId in its answer"}`, { outcome: out, threadIds: ids.slice() });
    }
    const v = out.json.version;
    if (typeof v !== "string" || !v) throw seedPrecondition(`add_comment ${i} of ${n} named no version`, { outcome: out, threadIds: ids.slice() });
    if (version !== null && v !== version) {
      throw seedPrecondition(`add_comment ${i} of ${n} opened its thread on ${v}, not ${version}: ${o.docId} was published again while seeding`, { outcome: out, threadIds: ids.slice() });
    }
    version = v;
    ids.push(threadId);
    return threadId;
  };

  if (via === "tool") {
    for (let i = 1; i <= n; i += 1) await open(i);
    return { threadIds: ids, version, via };
  }

  const first = await open(1);
  if (n === 1) return { threadIds: ids, version, via };
  const db = o.db ?? (await import("./admin.mjs")).adminFor(target).db;
  const { Timestamp } = await import("firebase-admin/firestore");
  const annPath = `docs/${o.docId}/versions/${version}/annotations`;
  const anns = db.collection(annPath);
  const [annSnap, comSnap] = await Promise.all([anns.doc(first).get(), anns.doc(first).collection("comments").get()]);
  if (!annSnap.exists) throw seedPrecondition(`add_comment answered thread ${first}, but ${annPath}/${first} holds nothing`, { threadIds: ids.slice() });
  if (comSnap.docs.length !== 1) throw seedPrecondition(`thread ${first} holds ${comSnap.docs.length} comments, not the one add_comment writes`, { threadIds: ids.slice() });
  const ann = annSnap.data();
  const com = comSnap.docs[0].data();
  const t0 = typeof ann?.createdAt?.toMillis === "function" ? ann.createdAt.toMillis() : NaN;
  if (!Number.isFinite(t0)) throw seedPrecondition(`thread ${first} has no server createdAt to follow`, { threadIds: ids.slice() });
  for (let start = 2; start <= n; start += SEED_BATCH_THREADS) {
    const batch = db.batch();
    const made = [];
    for (let i = start; i <= Math.min(n, start + SEED_BATCH_THREADS - 1); i += 1) {
      const ref = anns.doc();
      const note = ref.collection("comments").doc();
      const at = Timestamp.fromMillis(t0 + (i - 1));
      batch.create(ref, { ...ann, annId: ref.id, createdAt: at });
      batch.create(note, { ...com, commentId: note.id, body: stored[i - 1], createdAt: at });
      made.push(ref.id);
    }
    await batch.commit();
    ids.push(...made);
  }
  const wait = t0 + (n - 1) - Date.now() + 1;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return { threadIds: ids, version, via };
}

/** The sample documents under content/ that publish.mjs can seed. */
export const SAMPLES = Object.freeze(["bikeshed-tour", "design-review-shortener", "markdown-reference", "deck-animated", "deck-quarter-review"]);

/**
 * A sample's entry file, for publishing it through a user's path:
 * {bytes, filename, title}. Read from the stack TREE on a local target (the
 * bytes that tree was built with), from this checkout otherwise.
 */
export function readSample(target, sample) {
  if (!SAMPLES.includes(sample)) throw new Error(`readSample: unknown sample ${sample} (${SAMPLES.join(", ")})`);
  const root = target?.kind === "local" && target.stack?.treeDir ? assertPath(target.stack.treeDir, "treeDir") : REPO_ROOT;
  const dir = join(root, "content", sample);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const filename = manifest.entry ?? "index.html";
  return { bytes: readFileSync(join(dir, "bundle", filename)), filename, title: manifest.title ?? sample };
}

/**
 * LOCAL only: the stack copy's scripts/publish.mjs, as an operator would run
 * it, against this stack's emulators. The bundle is content/<sample>/bundle in
 * the TREE; the doc id is generated unless given; viewers default to none (a
 * manifest's own example addresses are never granted).
 *
 * The script writes the RTDB presence/edit mirrors best-effort and silently
 * skips them when it has no database handle (suspect S16). So the mirror is
 * read back here and `mirror` says whether the owner is in it; a missing one
 * is recorded in <runDir>/findings.jsonl, never thrown.
 *
 * @returns {Promise<{code, stdout, stderr, docId, mirror}>}
 */
export async function publishOperator(target, { sample, owner, id, title, viewers = [], timeoutMs = 120_000 } = {}) {
  if (target.kind !== "local") throw new Error("publishOperator is local-only: production documents are created through the user's paths");
  if (!SAMPLES.includes(sample)) throw new Error(`publishOperator: unknown sample ${sample} (${SAMPLES.join(", ")})`);
  const ownerEmail = typeof owner === "string" ? owner : owner?.email;
  if (!ownerEmail) throw new Error("publishOperator: owner (an account or an email) is required");
  const tree = assertPath(target.stack.treeDir, "treeDir");
  const manifestPath = join(tree, "content", sample, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  const docId = id ?? docIdFor(target, sample);
  const args = [
    join(tree, "scripts", "publish.mjs"),
    "--doc", docId,
    "--dir", join(tree, "content", sample, "bundle"),
    "--owner", ownerEmail,
    "--viewers", viewers.map((v) => (typeof v === "string" ? v : v.email)).join(","),
    "--title", title ?? manifest.title ?? sample,
    "--account", ownerEmail,
    "--project", target.projectId,
    "--bucket", target.bucket,
  ];
  if (manifest.entry) args.push("--entry", manifest.entry);
  // operator.mjs: the tree's script, an env built from nothing (the stack's
  // HOME, emulator hosts, a dummy ADC, the egress guard), cwd = the tree.
  const { runOperator } = await import("./operator.mjs");
  const r = await runOperator(target, "publish.mjs", args.slice(1), { timeoutMs });
  if (r.code !== 0) return { ...r, docId, mirror: null };
  appendLedger(target, { kind: "doc", docId, ownerEmail, via: "operator", sample });
  const { readMirror, recordFinding } = await import("./grant.mjs");
  const mirror = await readMirror(target, docId, ownerEmail, "approver");
  if (!mirror.ok) recordFinding(target, { kind: "mirror-missing", suspect: "S16", docId, email: ownerEmail, role: "owner", mirror, via: "scripts/publish.mjs" });
  return { ...r, docId, mirror };
}

// --- Fixtures --------------------------------------------------------------

const SPDX_HTML = "<!-- SPDX-License-Identifier: Apache-2.0 -->";

/** A tiny deterministic PRNG (mulberry32), so generated text never changes. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "amber basil cedar delta ember fable garnet harbor island juniper kestrel lantern meadow nickel orchard " +
  "pepper quarry raven saffron timber umber velvet willow xenon yarrow zephyr anchor bramble copper drift " +
  "estuary fennel glacier hollow indigo jasper kelp linen marble nectar ochre pebble quill russet slate " +
  "thistle upland vellum walnut"
).split(" ");

function sentence(rand, n) {
  const w = Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]);
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return `${w.join(" ")}.`;
}

function page(title, style, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${SPDX_HTML}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${style}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

const PROSE = "body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.55}";

function crdtParagraphs() {
  const rand = prng(1);
  const paras = Array.from({ length: 40 }, (_, i) => `<p id="e2e-${i + 1}">Paragraph ${i + 1}. ${sentence(rand, 9)} ${sentence(rand, 7)}</p>`);
  return page("E2E paragraphs", PROSE, `<h1 id="e2e-sentinel">E2E sentinel heading</h1>\n${paras.join("\n")}`);
}

/** About 300 KB, more than 200,000 characters of body text (the S10 threshold). */
function largeDoc() {
  const rand = prng(2);
  const sections = [];
  for (let s = 1; s <= 40; s++) {
    const paras = Array.from({ length: 15 }, (_, i) => `<p id="large-${s}-${i + 1}">${Array.from({ length: 6 }, () => sentence(rand, 12)).join(" ")}</p>`);
    sections.push(`<section id="large-${s}">\n<h2>Section ${s}</h2>\n${paras.join("\n")}\n</section>`);
  }
  return page("E2E large document", PROSE, `<h1 id="e2e-sentinel">E2E large document</h1>\n${sections.join("\n")}`);
}

/** An author's own data-bshd value: the serializer strips by VALUE, so this must survive. */
function foreignMarker() {
  return page(
    "E2E foreign marker",
    PROSE,
    `<h1 id="e2e-sentinel">E2E foreign marker</h1>
<p id="e2e-1">The next element carries an author's own data-bshd value, which is not one of Bikeshed's.</p>
<div id="e2e-foreign" data-bshd="whatever"><p id="e2e-2">This block is the author's, marked data-bshd="whatever".</p></div>
<p id="e2e-3">A closing paragraph after the marked block.</p>`,
  );
}

/** Sections whose ids are bare numerals: `#1` is not a valid selector. */
function digitSections() {
  const rand = prng(3);
  const sections = Array.from({ length: 5 }, (_, i) => `<section id="${i + 1}">\n<h2>Slide ${i + 1}</h2>\n<p>${sentence(rand, 10)}</p>\n</section>`);
  return page(
    "E2E digit-id sections",
    "html,body{margin:0}body{font-family:system-ui,sans-serif}section{min-height:100vh;box-sizing:border-box;padding:3rem;border-bottom:1px solid #ccc}",
    sections.join("\n"),
  );
}

export const FIXTURES = Object.freeze({
  "crdt-paragraphs.html": crdtParagraphs,
  "large-doc.html": largeDoc,
  "foreign-marker.html": foreignMarker,
  "digit-sections.html": digitSections,
});

/** Every fixture's bytes, generated: {name: string}. */
export function generateFixtures() {
  return Object.fromEntries(Object.entries(FIXTURES).map(([name, fn]) => [name, fn()]));
}

/** Write the fixtures into `dir` (default e2e/fixtures/). */
export function writeFixtures(dir = FIXTURES_DIR) {
  mkdirSync(dir, { recursive: true });
  const out = generateFixtures();
  for (const [name, text] of Object.entries(out)) writeFileSync(join(dir, name), text);
  return Object.keys(out);
}

/** Names whose committed bytes differ from what the generator makes. */
export function fixtureDrift(dir = FIXTURES_DIR) {
  const out = generateFixtures();
  return Object.entries(out)
    .filter(([name, text]) => !existsSync(join(dir, name)) || readFileSync(join(dir, name), "utf8") !== text)
    .map(([name]) => name);
}

/** A committed fixture, as text (or a Buffer with raw:true). */
export function readFixture(name, { raw = false } = {}) {
  const p = join(FIXTURES_DIR, name);
  if (!existsSync(p)) throw new Error(`no fixture ${name} (run: node e2e/lib/seed.mjs --write-fixtures)`);
  return raw ? readFileSync(p) : readFileSync(p, "utf8");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--write-fixtures")) {
    for (const n of writeFixtures()) console.log(`wrote e2e/fixtures/${n}`);
  } else if (process.argv.includes("--check-fixtures")) {
    const drift = fixtureDrift();
    if (drift.length > 0) {
      console.error(`fixtures drifted: ${drift.join(", ")} (run --write-fixtures)`);
      process.exit(1);
    }
    console.log("fixtures match the generator");
  } else {
    console.error("usage: node e2e/lib/seed.mjs --write-fixtures | --check-fixtures");
    process.exit(2);
  }
}
