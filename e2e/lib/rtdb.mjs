// SPDX-License-Identifier: Apache-2.0
// The Realtime Database as the app reaches it: rules-evaluated REST as an account, the emulator's admin reads, and whether the rules are loaded (SPEC §6b, §12).

/**
 * The app keeps live presence and the live merge in the Realtime Database,
 * where database.rules.json decides (SPEC §6b). A spec that must observe a
 * rules refusal or acceptance sends the same REST request as a signed-in
 * client:
 *
 *   const db = rtdbAs(target, { idToken: await idToken(target, viewer), http: ctx.http({ actor: "viewer-rtdb" }) });
 *   const r = await db.put(`status/${docId}/y/${entry}`, value);
 *   r.verdict   // "ALLOW" (200) | "DENY" (401 "Permission denied") | null (anything else)
 *
 * WHO — the trap this module exists for: the RTDB emulator takes ANY
 * `Authorization: Bearer …` header as its admin and skips the rules ("Bearer
 * not-a-token" reads everything, 200). Only `?auth=<ID token>` is evaluated as
 * that user. So rtdbAs() sends the token ONLY as `?auth=`, strips any
 * Authorization header — even one the http client carries by default — and
 * sends no cookie. `idToken: null` is an anonymous caller (no `auth` at all).
 * rtdbAdmin() is the other side: `Bearer owner` and nothing else, past the
 * rules, for reading the stored truth.
 *
 * THE SECOND TRAP — a bad token is silently nobody. Measured on a stack's
 * emulator: it never answers that a token is bad. A `?auth=` value that is
 * not header.payload.signature with JSON-object header and payload, or whose
 * payload has no `sub` or no `iat`, is evaluated as NO token — the rules then
 * answer for an anonymous caller (401 "Permission denied" under the tree's
 * rules, 200 on a namespace with none), indistinguishable from a real denial.
 * It ignores the signature, `alg`, `exp`, `aud` and `iss`, so a stale ID
 * token is still its user. So rtdbAs() refuses, before anything is sent, a
 * token the emulator would read as nobody (rtdbTokenProblem; code
 * E2E_RTDB_TOKEN). Every Firebase ID token passes; a legacy database secret
 * does not (on production it is the admin, not a user).
 *
 * Every call resolves to
 *   { status, ok, denied, verdict, error, json, response }
 * where `ok` is a 200, `denied` a 401 whose body is {"error": "Permission
 * denied"} (what the rules — `.read`, `.write` or `.validate` — answer), and
 * `error` the body's error string otherwise. A 400, a 404, or a 401 with any
 * other error (production's answer to a token it cannot use) is neither ALLOW
 * nor DENY, so a request refused for the wrong reason never reads as a rules
 * denial. `json` is the value (GET) or the echo (PUT, PATCH, POST's {name}).
 *
 * WHERE: `<origin of target.databaseURL>/<path>.json`, carrying the target's
 * own query (`?ns=<projectId>` on a local stack: the namespace the app and
 * the functions use). Paths are relative to the database root; each segment
 * is percent-encoded, "." and ".." are refused, "" is the root.
 *
 * HOW: through createHttp — the isolation check, then the production guard
 * (guard.mjs RTDB_REST: a write goes only under status/<id> of a document the
 * run created), then the redacted trace, where `?auth=` is redacted like any
 * credential.
 *
 * RULES LOADED: before this harness version a stack's ns=<projectId> ran
 * with NO rules. A stack now binds them and proves it at readiness (capability
 * `rtdb-rules`); rtdbRulesStatus(target) checks it live, on any local stack.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createHttp } from "./http.mjs";
import { requireCapability } from "./target.mjs";
import { rtdbRulesFile } from "./patch.mjs";
import { within } from "./paths.mjs";

/** The emulator's admin bearer: past the rules, so rtdbAs() never sends it. */
export const RTDB_ADMIN_BEARER = "owner";

/** What the rules answer, with a 401: `.read`, `.write` and `.validate` alike. */
export const RTDB_DENIED = "Permission denied";

function databaseBase(target) {
  if (typeof target?.databaseURL !== "string" || !target.databaseURL) throw new Error(`rtdb: target ${target?.runId ?? "(no run id)"} has no databaseURL`);
  return new URL(target.databaseURL);
}

/** The namespace a target's databaseURL names: its `?ns=`, else the host's first label (a production instance). */
export function rtdbNamespace(target) {
  const base = databaseBase(target);
  return base.searchParams.get("ns") ?? base.hostname.split(".")[0];
}

function segmentsOf(path) {
  if (typeof path !== "string") throw new Error(`rtdb: a path is a string relative to the database root, got ${JSON.stringify(path)}`);
  const segs = path.split("/").filter((s) => s.length > 0);
  if (segs.some((s) => s === "." || s === "..")) throw new Error(`rtdb: ${path} has a "." or ".." segment`);
  return segs;
}

/**
 * The REST URL of `path` in the target's database:
 * `<origin>/<segments>.json?<the target's query>&<query>`. Query values are
 * sent as given (RTDB wants `orderBy="$key"` quoted: pass the quotes);
 * undefined and null leave a key out.
 */
export function rtdbUrl(target, path, query = {}) {
  const base = databaseBase(target);
  const u = new URL(`${base.origin}/${segmentsOf(path).map(encodeURIComponent).join("/")}.json`);
  for (const [k, v] of base.searchParams) u.searchParams.set(k, v);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** The outcome of one RTDB REST call, as every method here returns it. */
export function rtdbResult(r) {
  const ok = r.status === 200;
  const body = r.json;
  const error = !ok && body && typeof body === "object" && !Array.isArray(body) && typeof body.error === "string" ? body.error : null;
  const denied = r.status === 401 && error === RTDB_DENIED;
  return { status: r.status, ok, denied, verdict: ok ? "ALLOW" : denied ? "DENY" : null, error, json: body, response: r };
}

function noAuthQuery(query, who) {
  if (query && Object.hasOwn(query, "auth")) throw new Error(`${who}: the credential is not a query parameter here (${who === "rtdbAs" ? "pass idToken" : "the admin sends Bearer owner"})`);
}

/** A JWT segment decoded to a JSON object, or undefined. */
function jsonSegment(seg) {
  if (!/^[A-Za-z0-9_\-+/]+={0,2}$/.test(seg)) return undefined;
  try {
    const v = JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why the RTDB emulator would evaluate `token` as NO token — an anonymous
 * caller — or null when it reads it as the user the token names. Measured on
 * a stack's emulator: anything but header.payload.signature with JSON-object
 * header and payload, a `sub` and an `iat`, is silently nobody; the
 * signature, `alg`, `exp`, `aud` and `iss` are not checked. Every Firebase ID
 * token passes. The reason never contains the token.
 *
 * @param {*} token
 * @returns {string|null}
 */
export function rtdbTokenProblem(token) {
  if (typeof token !== "string" || token.length === 0) return "it is not a non-empty string";
  const parts = token.split(".");
  if (parts.length !== 3) return `it is not a JWT (header.payload.signature): ${parts.length} segment(s)`;
  if (!jsonSegment(parts[0])) return "its header is not a base64url JSON object";
  const claims = jsonSegment(parts[1]);
  if (!claims) return "its payload is not a base64url JSON object";
  if (typeof claims.sub !== "string" || claims.sub.length === 0) return "its payload names no user (no `sub`)";
  if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) return "its payload has no numeric `iat`";
  return null;
}

/**
 * An RTDB client for one caller, evaluated by the rules.
 *
 * @param {object} target
 * @param {object} [o]
 * @param {string|null|Function} [o.idToken]  the caller's Firebase ID token, sent only as ?auth=; null or omitted: anonymous; a function is called per request. A token the emulator would read as nobody (rtdbTokenProblem) rejects the request with E2E_RTDB_TOKEN before anything is sent
 * @param {object} [o.http]    a createHttp client (ctx.http({actor}) logs into the case); its default Authorization is stripped
 * @param {string} [o.actor]   the trace label for a fresh client ("rtdb")
 * @param {*} [o.evidence]     the evidence sink for a fresh client
 * @returns {{http, url(path, query?):string, request(method, path, {value, query}?), get(path, {query}?), put(path, value, {query}?), patch(path, value, {query}?), post(path, value, {query}?), delete(path, {query}?)}}
 */
export function rtdbAs(target, o = {}) {
  if (o.idToken === RTDB_ADMIN_BEARER) throw new Error('rtdbAs: "owner" is the emulator\'s admin credential, which skips the rules; use rtdbAdmin');
  databaseBase(target);
  const http = o.http ?? createHttp(target, { actor: o.actor ?? "rtdb", evidence: o.evidence });

  async function token() {
    const t = typeof o.idToken === "function" ? await o.idToken() : o.idToken;
    if (t === undefined || t === null) return null;
    if (typeof t !== "string" || t.length === 0) throw new Error("rtdbAs: idToken must be a non-empty string, a function returning one, or null");
    if (t === RTDB_ADMIN_BEARER) throw new Error('rtdbAs: "owner" is the emulator\'s admin credential, which skips the rules');
    const why = rtdbTokenProblem(t);
    if (why) {
      const err = new Error(`rtdbAs: the idToken is not one the RTDB emulator reads as a user: ${why}. It would evaluate the request as an anonymous caller, so a DENY would not be this account's; pass the account's Firebase ID token, or idToken: null for the anonymous caller`);
      err.code = "E2E_RTDB_TOKEN";
      throw err;
    }
    return t;
  }

  async function request(method, path, { value, query = {} } = {}) {
    noAuthQuery(query, "rtdbAs");
    const t = await token();
    const url = rtdbUrl(target, path, { ...query, ...(t ? { auth: t } : {}) });
    const r = await http.request(method, url, {
      ...(value !== undefined ? { json: value } : {}),
      // Any Bearer header is the emulator's admin: never one, whatever the client carries.
      headers: { authorization: null, cookie: null },
      noCookies: true,
    });
    return rtdbResult(r);
  }

  return {
    http,
    url: (path, query = {}) => rtdbUrl(target, path, query),
    request,
    get: (path, r = {}) => request("GET", path, { query: r.query }),
    put: (path, value, r = {}) => request("PUT", path, { value, query: r.query }),
    patch: (path, value, r = {}) => request("PATCH", path, { value, query: r.query }),
    post: (path, value, r = {}) => request("POST", path, { value, query: r.query }),
    delete: (path, r = {}) => request("DELETE", path, { query: r.query }),
  };
}

/**
 * The emulator's admin over REST: `Authorization: Bearer owner`, no ?auth=,
 * past the rules. Local stacks only (capability `admin-emulator`); on any
 * other target it throws E2E_CAPABILITY — read with rtdbGet (lib/admin.mjs).
 *
 *   get(path, {query})     the stored value, as rtdbResult (json is the value; null when absent)
 *   rules({namespace})     GET /.settings/rules.json?ns=<namespace, default the target's>
 *                          → {status, ok, text, buffer, response}: the rules text as loaded
 */
export function rtdbAdmin(target, o = {}) {
  requireCapability(target, "admin-emulator");
  if (target.kind !== "local") {
    const err = new Error(`rtdbAdmin: the emulator's admin exists only on a local stack (target ${target.kind}); read with rtdbGet (lib/admin.mjs)`);
    err.code = "E2E_CAPABILITY";
    throw err;
  }
  databaseBase(target);
  const http = o.http ?? createHttp(target, { actor: o.actor ?? "rtdb-admin", evidence: o.evidence });
  const send = (url) => http.request("GET", url, { headers: { authorization: `Bearer ${RTDB_ADMIN_BEARER}`, cookie: null }, noCookies: true });
  return {
    http,
    async get(path, { query = {} } = {}) {
      noAuthQuery(query, "rtdbAdmin");
      return rtdbResult(await send(rtdbUrl(target, path, query)));
    },
    async rules({ namespace = rtdbNamespace(target) } = {}) {
      const base = databaseBase(target);
      const r = await send(`${base.origin}/.settings/rules.json?ns=${encodeURIComponent(namespace)}`);
      return { status: r.status, ok: r.status === 200, text: r.text, buffer: r.buffer, response: r };
    },
  };
}

/**
 * Whether ns=<projectId> enforces the tree's RTDB rules on this stack, live:
 * the rules read back (as the admin) byte-equal to the file the stack's
 * firebase.json binds to that namespace, and an anonymous shallow read of the
 * root is a rules denial. Works on any local stack, including one built
 * before the binding (whose ns=<projectId> then answers 200: not ok). A spec
 * that asserts an RTDB DENY gates on it:
 *
 *   const s = await rtdbRulesStatus(ctx.target);
 *   precondition(s.ok, `RTDB rules in ns=${s.namespace}: ${s.reason}`);
 *
 * (or declares `needs: ["rtdb-rules"]`, which a stack has when its readiness
 * proved the same thing). A stack that fails the check resolves `ok: false`
 * with the `reason`; a target without a stack tree is `{ok: false, checked:
 * false}`. It throws only when the tree's firebase.json or rules file cannot
 * be read, or the database cannot be reached at all.
 *
 * @returns {Promise<{ok:boolean, checked:boolean, namespace:string, file:string|null, bytes?:number, sha256?:string, equal?:boolean, rulesStatus?:number, anonymousStatus?:number, reason:string|null}>}
 */
export async function rtdbRulesStatus(target, o = {}) {
  const namespace = o.namespace ?? rtdbNamespace(target);
  if (target.kind !== "local" || !target.stack?.treeDir) {
    return { ok: false, checked: false, namespace, file: null, reason: "only a local stack's RTDB rules can be read back" };
  }
  const tree = target.stack.treeDir;
  const rel = rtdbRulesFile(JSON.parse(readFileSync(within(tree, "firebase.json"), "utf8")), namespace);
  if (!rel) return { ok: false, checked: true, namespace, file: null, reason: `the stack's firebase.json binds no rules file to ${namespace}` };
  const want = readFileSync(within(tree, rel));
  const http = o.http ?? createHttp(target, { actor: o.actor ?? "rtdb-rules", evidence: o.evidence });
  const stored = await rtdbAdmin(target, { http }).rules({ namespace });
  const anonymous = await rtdbAs(target, { idToken: null, http }).get("", { query: { ns: namespace, shallow: "true" } });
  const equal = stored.status === 200 && Buffer.from(stored.buffer).equals(want);
  const ok = equal && anonymous.denied;
  const reasons = [];
  if (!equal) reasons.push(stored.status === 200 ? `the rules loaded in ${namespace} are not ${rel} (${stored.buffer.length} bytes, the file ${want.length})` : `reading ${namespace}'s rules answered ${stored.status}`);
  if (!anonymous.denied) reasons.push(`an anonymous read of ${namespace} answered ${anonymous.status}${anonymous.error ? ` ${anonymous.error}` : ""}, not a rules denial`);
  return {
    ok,
    checked: true,
    namespace,
    file: rel,
    bytes: want.length,
    sha256: createHash("sha256").update(want).digest("hex"),
    equal,
    rulesStatus: stored.status,
    anonymousStatus: anonymous.status,
    reason: ok ? null : reasons.join("; "),
  };
}
