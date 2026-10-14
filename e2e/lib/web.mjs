// SPDX-License-Identifier: Apache-2.0
// The app's own comment writes on the web channel (open a thread, reply, resolve) exactly as app/src/firestore.ts makes them, through the rules (SPEC §4, §6).

/**
 * A person comments in the browser through three rules-evaluated Firestore
 * writes of app/src/firestore.ts, and nothing else:
 *
 *   createAnnotation  setDoc(annotations/<auto id>, {annId, anchor, authorUid,
 *                     authorEmail, actor, color, resolved: false,
 *                     createdAt: serverTimestamp()})
 *   addComment        setDoc(…/comments/<auto id>, {commentId, body, authorUid,
 *                     authorEmail, actor, createdAt: serverTimestamp()})
 *   setResolved       updateDoc(annotations/<id>, {resolved, resolvedBy})
 *
 * the email lower-cased, the actor {uid, email, channel: "web"}, the colour
 * TOKENS.annotation. These helpers send the same writes through a
 * clientFirestore (lib/firestore-client.mjs): setDoc is `fs.set` (the whole
 * document, NO precondition, so the rules judge a create or an update by what
 * is stored) and updateDoc is `fs.update` (a mask of the two fields, the
 * document must exist). A thread, as the app opens one, is the annotation and
 * then its first comment: webThread. selftest/web.test.mjs reads
 * app/src/firestore.ts, app/src/brand/tokens.ts and firestore.rules and fails
 * when the app's write shape moves away from this one, so a spec never goes
 * on testing a write the app no longer makes.
 *
 * Who: `fs` is a clientFirestore for the account `acct` names (an account
 * from cast(), or an openSession() result); the rules refuse an author who is
 * not the caller. Ids are Firestore auto-ids as the web SDK makes them
 * (autoId), unless the case passes its own (a trigger's order follows ids).
 *
 * ABORTED is retried as the web SDK retries it (it is not a permanent write
 * error there): a loaded emulator answers "ABORTED: Transaction lock timeout"
 * while a trigger's transaction holds what the rules read. Before each retry
 * of a creation the document is read back through the same client: one that
 * landed anyway is not written again. Any other refusal throws E2E_WEB_WRITE
 * at once, with the result as `err.result`.
 *
 * A write the rules SHOULD refuse is not what these are for: build its data
 * with annotationData / commentData / resolveData, change it, and send it with
 * the clientFirestore itself, so the refusal is the case's to assert.
 *
 * Production: every write under docs/<id>/versions/<v>/annotations is
 * comment-capable, so the guard sends it only after assertQuietDoc(<id>)
 * (lib/guard.mjs); these helpers change nothing about that.
 */

import { randomBytes } from "node:crypto";
import { toFields } from "./firestore-client.mjs";

/** TOKENS.annotation in app/src/brand/tokens.ts: the colour createAnnotation writes. */
export const ANNOTATION_COLOR = "#b5257b";
/** The context dom-anchor-text-quote keeps either side of a quote (its CONTEXT_LENGTH). */
export const ANCHOR_CONTEXT = 32;
/** The app's Anchor (app/src/annotation/anchor.ts describeAnchorFromRange), in its order. */
export const ANCHOR_KEYS = Object.freeze(["elementId", "exact", "prefix", "suffix", "start", "end"]);
/** createAnnotation's document, in its order (createdAt is the server's time). */
export const ANNOTATION_KEYS = Object.freeze(["annId", "anchor", "authorUid", "authorEmail", "actor", "color", "resolved", "createdAt"]);
/** addComment's document, in its order (createdAt is the server's time). */
export const COMMENT_KEYS = Object.freeze(["commentId", "body", "authorUid", "authorEmail", "actor", "createdAt"]);
/** setResolved's update: exactly these two fields. */
export const RESOLVE_KEYS = Object.freeze(["resolved", "resolvedBy"]);
/** How many times an ABORTED write is tried again before it throws. */
export const WEB_ABORT_RETRIES = 5;
/** The pause before retry k is k × this many ms. */
export const WEB_ABORT_BACKOFF_MS = 500;

const AUTO_ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const AUTO_ID_LENGTH = 20;
const DOC_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DOC_ID_MAX = 60;
const VERSION_RE = /^v[1-9][0-9]*$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A Firestore auto-id as the web SDK's doc(collection(…)) makes one: 20
 * characters of [A-Za-z0-9], each drawn without modulo bias.
 */
export function autoId() {
  const max = Math.floor(256 / AUTO_ID_CHARS.length) * AUTO_ID_CHARS.length;
  let id = "";
  while (id.length < AUTO_ID_LENGTH) {
    for (const b of randomBytes(40)) {
      if (b < max && id.length < AUTO_ID_LENGTH) id += AUTO_ID_CHARS[b % AUTO_ID_CHARS.length];
    }
  }
  return id;
}

// --- Checks ----------------------------------------------------------------------

function fail(at, message) {
  return new TypeError(`${at}: ${message}`);
}

/** {uid, email lower-cased} of an account ({uid, email}) or a session ({uid, account: {email}}). */
function who(acct, at) {
  const uid = acct?.uid;
  const email = acct?.email ?? acct?.account?.email;
  if (typeof uid !== "string" || uid.length === 0 || typeof email !== "string" || !email.includes("@")) {
    throw fail(at, `acct is an account ({uid, email}, from cast()) or a session (openSession()), got ${JSON.stringify(acct && { uid: acct.uid, email })}`);
  }
  return { uid, email: email.toLowerCase() };
}

function checkDocId(docId, at) {
  if (typeof docId !== "string" || docId.length > DOC_ID_MAX || !DOC_ID_RE.test(docId)) {
    throw fail(at, `docId is a document id as the product makes them, got ${JSON.stringify(docId)}`);
  }
}

function checkVersion(versionId, at) {
  if (typeof versionId !== "string" || !VERSION_RE.test(versionId)) throw fail(at, `versionId is a version id ("v1", "v2", …), got ${JSON.stringify(versionId)}`);
}

function checkId(id, name, at) {
  if (typeof id !== "string" || id.length === 0 || id.includes("/") || id === "." || id === ".." || /^__.*__$/.test(id)) {
    throw fail(at, `${name} is a Firestore document id (non-empty, no "/"), got ${JSON.stringify(id)}`);
  }
}

function checkKeys(o, known, at) {
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw fail(at, `options are an object, got ${JSON.stringify(o)}`);
  const unknown = Object.keys(o).filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    const hint = unknown.includes("version") ? ' ("version" is versionId)' : "";
    throw fail(at, `unknown option ${unknown.map((k) => JSON.stringify(k)).join(", ")}${hint} (known: ${known.join(", ")})`);
  }
}

/** An Anchor with exactly the app's keys and a consistent position, copied in the app's order. */
function checkAnchor(anchor, at) {
  if (anchor === null || typeof anchor !== "object" || Array.isArray(anchor)) throw fail(at, `anchor is the app's Anchor (anchorIn() makes one), got ${JSON.stringify(anchor)}`);
  const keys = Object.keys(anchor);
  const missing = ANCHOR_KEYS.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !ANCHOR_KEYS.includes(k));
  if (missing.length || extra.length) {
    const strict = extra.includes("strict") ? " (strict marks an agent's server-anchored comment; the app never writes it)" : "";
    throw fail(at, `anchor has exactly the app's keys ${ANCHOR_KEYS.join(", ")}; missing [${missing.join(", ")}], extra [${extra.join(", ")}]${strict}`);
  }
  const { elementId, exact, prefix, suffix, start, end } = anchor;
  if (typeof elementId !== "string") throw fail(at, `anchor.elementId is a string, got ${JSON.stringify(elementId)}`);
  if (typeof exact !== "string" || exact.length === 0) throw fail(at, `anchor.exact is the quoted text, got ${JSON.stringify(exact)}`);
  if (typeof prefix !== "string" || typeof suffix !== "string") throw fail(at, "anchor.prefix and anchor.suffix are strings");
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end - start !== exact.length) {
    throw fail(at, `anchor.start and anchor.end bound the quote in the element's text (end - start = ${exact.length}), got ${start}…${end}`);
  }
  return { elementId, exact, prefix, suffix, start, end };
}

// --- Data ------------------------------------------------------------------------

/**
 * The Anchor the app makes when a reader selects `exact` inside the element
 * #elementId whose textContent is `text` (describeAnchorFromRange: a text
 * quote with ANCHOR_CONTEXT characters either side, and the quote's position
 * in that text). `exact` must occur once in `text`, or `at` says which
 * occurrence (its start).
 *
 * @param {string} text        the element's textContent
 * @param {string} elementId   its id ("" for the document root, as the app writes it)
 * @param {string} exact       the selected text
 * @param {{at?: number}} [o]
 * @returns {{elementId, exact, prefix, suffix, start, end}}
 */
export function anchorIn(text, elementId, exact, { at } = {}) {
  if (typeof text !== "string") throw fail("anchorIn", `text is the element's textContent, got ${JSON.stringify(text)}`);
  if (typeof elementId !== "string") throw fail("anchorIn", `elementId is a string, got ${JSON.stringify(elementId)}`);
  if (typeof exact !== "string" || exact.length === 0) throw fail("anchorIn", `exact is the selected text, got ${JSON.stringify(exact)}`);
  let start;
  if (at === undefined) {
    start = text.indexOf(exact);
    if (start < 0) throw new Error(`anchorIn: ${JSON.stringify(exact)} is not in #${elementId}'s text`);
    if (text.indexOf(exact, start + 1) >= 0) throw new Error(`anchorIn: ${JSON.stringify(exact)} occurs more than once in #${elementId}'s text; pass {at: <its start>} to say which`);
  } else {
    if (!Number.isSafeInteger(at) || at < 0 || text.slice(at, at + exact.length) !== exact) throw new Error(`anchorIn: ${JSON.stringify(exact)} is not at ${JSON.stringify(at)} in #${elementId}'s text`);
    start = at;
  }
  const end = start + exact.length;
  return {
    elementId,
    exact,
    prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
    suffix: text.slice(end, Math.min(text.length, end + ANCHOR_CONTEXT)),
    start,
    end,
  };
}

/** The actor of a direct client write: {uid, email lower-cased, channel: "web"} (firestore.ts webActor). */
export function webActor(acct) {
  const a = who(acct, "webActor");
  return { uid: a.uid, email: a.email, channel: "web" };
}

/** createAnnotation's document without createdAt (the server's time, sent as a transform). */
export function annotationData(acct, { annId, anchor } = {}) {
  const a = who(acct, "annotationData");
  checkId(annId, "annId", "annotationData");
  return {
    annId,
    anchor: checkAnchor(anchor, "annotationData"),
    authorUid: a.uid,
    authorEmail: a.email,
    actor: { uid: a.uid, email: a.email, channel: "web" },
    color: ANNOTATION_COLOR,
    resolved: false,
  };
}

/** addComment's document without createdAt (the server's time, sent as a transform). */
export function commentData(acct, { commentId, body } = {}) {
  const a = who(acct, "commentData");
  checkId(commentId, "commentId", "commentData");
  if (typeof body !== "string") throw fail("commentData", `body is a string, got ${JSON.stringify(body)}`);
  return { commentId, body, authorUid: a.uid, authorEmail: a.email, actor: { uid: a.uid, email: a.email, channel: "web" } };
}

/** setResolved's two fields. */
export function resolveData(acct, resolved) {
  if (typeof resolved !== "boolean") throw fail("resolveData", `resolved is true or false, got ${JSON.stringify(resolved)}`);
  return { resolved, resolvedBy: webActor(acct) };
}

/** docs/<docId>/versions/<versionId>/annotations/<annId> */
export function annotationPath(docId, versionId, annId) {
  checkDocId(docId, "annotationPath");
  checkVersion(versionId, "annotationPath");
  checkId(annId, "annId", "annotationPath");
  return `docs/${docId}/versions/${versionId}/annotations/${annId}`;
}

/** …/annotations/<annId>/comments/<commentId> */
export function commentPath(docId, versionId, annId, commentId) {
  checkId(commentId, "commentId", "commentPath");
  return `${annotationPath(docId, versionId, annId)}/comments/${commentId}`;
}

// --- Sending ---------------------------------------------------------------------

function checkFs(fs, at) {
  if (!fs || typeof fs.set !== "function" || typeof fs.update !== "function" || typeof fs.get !== "function" || typeof fs.root !== "string") {
    throw fail(at, "fs is a clientFirestore (lib/firestore-client.mjs) for the account that writes");
  }
}

function checkRetries(n, at) {
  if (!Number.isSafeInteger(n) || n < 0) throw fail(at, `abortRetries is a whole number, got ${JSON.stringify(n)}`);
  return n;
}

/**
 * Send one write, retrying ABORTED as the SDK does; resolve with its result.
 * `creates`: before a retry, a document that is already there landed anyway.
 */
async function send(fs, path, write, { what, email, creates, abortRetries }) {
  for (let attempt = 0; ; attempt += 1) {
    const r = await write();
    if (r.ok) return { ...r, attempts: attempt + 1 };
    if (r.code === "ABORTED" && attempt < abortRetries) {
      if (creates) {
        const back = await fs.get(path);
        if (back.ok && back.doc) return { ...r, attempts: attempt + 1, landedAnyway: true };
      }
      await sleep(WEB_ABORT_BACKOFF_MS * (attempt + 1));
      continue;
    }
    const err = new Error(`${what} as ${email}: ${r.status} ${r.code ?? ""} ${r.message ?? ""}`.trim() + (attempt > 0 ? ` (after ${attempt + 1} attempts)` : ""));
    err.code = "E2E_WEB_WRITE";
    err.result = r;
    err.path = path;
    throw err;
  }
}

/**
 * The write the app's createAnnotation sends, for a batch with fs.commit():
 * setDoc's shape (the whole document, no precondition, createdAt a
 * REQUEST_TIME transform), as a writeBatch().set() sends it too. Nothing is
 * sent here.
 *
 * @returns {{annId, path, data, write}}
 */
export function webAnnotationWrite(fs, acct, o = {}) {
  checkFs(fs, "webAnnotationWrite");
  checkKeys(o, ["docId", "versionId", "anchor", "annId"], "webAnnotationWrite");
  const { docId, versionId, anchor, annId = autoId() } = o;
  const path = annotationPath(docId, versionId, annId);
  const data = annotationData(acct, { annId, anchor });
  const write = { update: { name: `${fs.root}/${path}`, fields: toFields(data) }, updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }] };
  return { annId, path, data, write };
}

/**
 * Open a thread as the app does: createAnnotation, then addComment, as `acct`
 * through `fs`. Throws E2E_WEB_WRITE when either write is refused; nothing is
 * sent when an argument is wrong.
 *
 * @param {object} fs       a clientFirestore for `acct`
 * @param {object} acct     an account ({uid, email}) or a session
 * @param {object} o
 * @param {string} o.docId
 * @param {string} o.versionId        "v1", …
 * @param {object} o.anchor           anchorIn(text, elementId, exact)
 * @param {string} o.body             the first comment
 * @param {string} [o.annId]          default autoId()
 * @param {string} [o.commentId]      default autoId()
 * @param {number} [o.abortRetries]   default WEB_ABORT_RETRIES
 * @returns {Promise<{annId, commentId, anchor, path}>}  `path` is the annotation's
 */
export async function webThread(fs, acct, o = {}) {
  checkFs(fs, "webThread");
  checkKeys(o, ["docId", "versionId", "anchor", "body", "annId", "commentId", "abortRetries"], "webThread");
  const { docId, versionId, anchor, body, annId = autoId(), commentId = autoId(), abortRetries = WEB_ABORT_RETRIES } = o;
  checkRetries(abortRetries, "webThread");
  const path = annotationPath(docId, versionId, annId);
  const data = annotationData(acct, { annId, anchor });
  commentData(acct, { commentId, body }); // checked before anything is sent
  await send(fs, path, () => fs.set(path, data, { serverTime: ["createdAt"] }), { what: `createAnnotation ${path}`, email: data.authorEmail, creates: true, abortRetries });
  await webReply(fs, acct, { docId, versionId, annId, body, commentId, abortRetries });
  return { annId, commentId, anchor: data.anchor, path };
}

/**
 * A comment on an existing thread, as the app's addComment writes it.
 *
 * @param {object} fs
 * @param {object} acct
 * @param {{docId, versionId, annId, body, commentId?, abortRetries?}} o
 * @returns {Promise<{commentId, path}>}
 */
export async function webReply(fs, acct, o = {}) {
  checkFs(fs, "webReply");
  checkKeys(o, ["docId", "versionId", "annId", "body", "commentId", "abortRetries"], "webReply");
  const { docId, versionId, annId, body, commentId = autoId(), abortRetries = WEB_ABORT_RETRIES } = o;
  checkRetries(abortRetries, "webReply");
  const path = commentPath(docId, versionId, annId, commentId);
  const data = commentData(acct, { commentId, body });
  await send(fs, path, () => fs.set(path, data, { serverTime: ["createdAt"] }), { what: `addComment ${path}`, email: data.authorEmail, creates: true, abortRetries });
  return { commentId, path };
}

/**
 * Resolve (or, with resolved: false, reopen) a thread as the app's
 * setResolved does: updateDoc of `resolved` and `resolvedBy` (the caller).
 *
 * @param {object} fs
 * @param {object} acct
 * @param {{docId, versionId, annId, resolved?: boolean, abortRetries?}} o   resolved defaults to true
 * @returns {Promise<{resolved, resolvedBy, path}>}
 */
export async function webResolve(fs, acct, o = {}) {
  checkFs(fs, "webResolve");
  checkKeys(o, ["docId", "versionId", "annId", "resolved", "abortRetries"], "webResolve");
  const { docId, versionId, annId, resolved = true, abortRetries = WEB_ABORT_RETRIES } = o;
  checkRetries(abortRetries, "webResolve");
  const path = annotationPath(docId, versionId, annId);
  const data = resolveData(acct, resolved);
  await send(fs, path, () => fs.update(path, data), { what: `setResolved(${resolved}) ${path}`, email: data.resolvedBy.email, creates: false, abortRetries });
  return { ...data, path };
}
