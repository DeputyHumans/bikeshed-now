// SPDX-License-Identifier: Apache-2.0
// Firestore as the app's SDK reaches it: rules-evaluated REST reads and writes under an account's ID token (SPEC §4, §12).

/**
 * The app writes annotations, comments, trust and the account record straight
 * to Firestore, where the SECURITY RULES decide. A spec that must observe a
 * rules refusal or acceptance sends the same request as a signed-in client:
 *
 *   const fs = clientFirestore(target, { idToken: await idToken(target, viewer), http: ctx.http({ actor: "viewer-fs" }) });
 *   const r = await fs.create(`docs/${docId}/versions/v1/annotations/${annId}`, fields);
 *   r.verdict   // "ALLOW" (200) | "DENY" (403 PERMISSION_DENIED) | null (anything else)
 *
 * Every call resolves to
 *   { status, code, message, verdict, ok, denied, json, response }
 * where `code` is the error's status string ("PERMISSION_DENIED",
 * "NOT_FOUND", …) or null, `message` its first 300 characters, `ok` is a 200
 * and `denied` a 403 PERMISSION_DENIED. A NOT_FOUND, a FAILED_PRECONDITION or
 * a malformed request is neither ALLOW nor DENY, so a write refused for the
 * wrong reason never reads as a rules denial. get() adds `doc`, list() adds
 * `docs` and `nextPageToken`: {name, path, id, data, createTime, updateTime},
 * with `data` decoded (timestamps as Date, integers as Number).
 *
 *   create(path, data, {serverTime = ["createdAt"]})
 *       a new document (`currentDocument: {exists: false}`), each serverTime
 *       field set to REQUEST_TIME as serverTimestamp() does; a field may not
 *       be both in `data` and in serverTime
 *   update(path, fields, {serverTime = []})
 *       exactly these top-level fields (an updateMask) of an existing
 *       document, as updateDoc does
 *   set(path, data, {serverTime = [], merge = false})
 *       setDoc: the whole document, whether or not it exists (no
 *       precondition, no mask), so the rules judge a create or an update by
 *       what is stored. `merge: true` is setDoc(…, {merge: true}): a mask of
 *       every leaf path in `data` (a nested map is recursed into; an array
 *       or an empty map is a leaf), the serverTime fields left out of it as
 *       the SDK leaves its sentinels
 *   remove(path)          an existing document, as deleteDoc does
 *   get(path)             one document, read through the rules
 *   list(collection, {pageSize, pageToken})
 *   runQuery(structuredQuery, {parent})
 *       a query, as the SDK's getDocs/onSnapshot sends one: the rules judge
 *       it by its constraints (a list rule must be provable from them), so
 *       the app's workspace query `members array-contains <me> orderBy
 *       createdAt desc` is the shape to send. `parent` is a document path for
 *       a subcollection query; the result adds `docs`. A 200 whose stream
 *       carries an error is not ok and has no verdict.
 *   commit(writes)        raw Firestore Write objects, for a batch
 *
 * Paths are relative to the database's documents (`docs/<id>/versions/v1/…`).
 *
 * WHERE: the REST API v1 at target.firestoreUrl — the stack's emulator on a
 * local target; on production the public Firestore origin when the Target
 * names none. A local target without a firestoreUrl throws.
 *
 * WHO: `Authorization: Bearer <ID token>`, or no Authorization at all when
 * `idToken` is null (an anonymous caller). `idToken` may be a function that
 * returns one, called per request. `session` (an openSession result) is the
 * same as `{idToken: () => session.idToken, http: session.http}`; an
 * `idToken` or `http` given beside it wins. The Auth emulator's admin credential
 * ("owner") reads and writes PAST the rules, so it is refused here: read the
 * stored truth through lib/admin.mjs instead. Cookies are never sent.
 *
 * HOW: through createHttp — the isolation check, then the production guard,
 * which classifies every Firestore REST write (guard.mjs): a write under a
 * document, folder or account this run did not create is refused, and any
 * write under a document's annotations is comment-capable, so it goes only
 * after assertQuietDoc proves nobody can be emailed — then the redacted trace.
 */

import { createHttp } from "./http.mjs";

/** Where the Firestore REST API lives for a production Target that names no firestoreUrl. */
export const FIRESTORE_PUBLIC_ORIGIN = "https://firestore.googleapis.com";

/** The Auth emulator's admin bearer: it bypasses the rules, so a client never sends it. */
const ADMIN_BEARER = "owner";

/** The origin the Firestore REST API is reached at for this target. */
export function firestoreOrigin(target) {
  if (typeof target?.firestoreUrl === "string" && target.firestoreUrl) return new URL(target.firestoreUrl).origin;
  if (target?.kind === "prod") return FIRESTORE_PUBLIC_ORIGIN;
  throw new Error(`clientFirestore: target ${target?.runId ?? "(no run id)"} (${target?.kind ?? "no kind"}) has no firestoreUrl`);
}

// --- Values --------------------------------------------------------------------

/** A JS value as a Firestore REST Value. Dates become timestamps, Buffers bytes. */
export function toValue(v) {
  if (v === null) return { nullValue: null };
  if (v === undefined) throw new Error("toValue: undefined has no Firestore value (leave the key out)");
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "bigint") return { integerValue: v.toString() };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`toValue: ${v} is not a finite number`);
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new Error("toValue: an invalid Date");
    return { timestampValue: v.toISOString() };
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { bytesValue: Buffer.from(v).toString("base64") };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFields(v) } };
  throw new Error(`toValue: a ${typeof v} has no Firestore value`);
}

/** A plain object as Firestore REST fields. */
export function toFields(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("toFields: want a plain object");
  return Object.fromEntries(Object.entries(data).map(([k, x]) => [k, toValue(x)]));
}

/** A Firestore REST Value as a JS value. Integers outside the safe range stay strings. */
export function fromValue(v) {
  if (!v || typeof v !== "object") throw new Error(`fromValue: not a Firestore value: ${JSON.stringify(v)}`);
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) {
    const n = Number(v.integerValue);
    return Number.isSafeInteger(n) ? n : String(v.integerValue);
  }
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("timestampValue" in v) return new Date(v.timestampValue);
  if ("bytesValue" in v) return Buffer.from(v.bytesValue, "base64");
  if ("referenceValue" in v) return v.referenceValue;
  if ("geoPointValue" in v) return { latitude: v.geoPointValue.latitude ?? 0, longitude: v.geoPointValue.longitude ?? 0 };
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ("mapValue" in v) return fromFields(v.mapValue.fields ?? {});
  throw new Error(`fromValue: unknown Firestore value ${Object.keys(v).join(", ")}`);
}

/** Firestore REST fields as a plain object. */
export function fromFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromValue(v)]));
}

/** A top-level field name as a field path: backquoted unless it is a simple name. */
export function fieldPath(name) {
  if (typeof name !== "string" || name.length === 0) throw new Error(`fieldPath: not a field name: ${JSON.stringify(name)}`);
  return /^[A-Za-z_][A-Za-z_0-9]*$/.test(name) ? name : `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
}

/** Split and check a relative path: non-empty segments, none "." or "..", even (a document) or odd (a collection). */
function segmentsOf(path, want) {
  if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.endsWith("/")) {
    throw new Error(`clientFirestore: want a path relative to the documents root, got ${JSON.stringify(path)}`);
  }
  const segs = path.split("/");
  if (segs.some((s) => s.length === 0 || s === "." || s === "..")) throw new Error(`clientFirestore: ${path} has an empty, "." or ".." segment`);
  const isDoc = segs.length % 2 === 0;
  if (want === "document" && !isDoc) throw new Error(`clientFirestore: ${path} is a collection, not a document`);
  if (want === "collection" && isDoc) throw new Error(`clientFirestore: ${path} is a document, not a collection`);
  return segs;
}

function decodeDoc(raw, root) {
  if (!raw || typeof raw.name !== "string") return null;
  const prefix = `${root}/`;
  const path = raw.name.startsWith(prefix) ? raw.name.slice(prefix.length) : raw.name;
  return { name: raw.name, path, id: path.split("/").at(-1), data: fromFields(raw.fields ?? {}), createTime: raw.createTime ?? null, updateTime: raw.updateTime ?? null };
}

/** The outcome of one REST call, as every method returns it. */
export function firestoreResult(r) {
  const body = Array.isArray(r.json) ? r.json[0] : r.json;
  const err = body && typeof body === "object" ? body.error : undefined;
  const code = typeof err?.status === "string" ? err.status : null;
  const ok = r.status === 200;
  const denied = r.status === 403 && code === "PERMISSION_DENIED";
  return {
    status: r.status,
    code,
    message: String(err?.message ?? "").slice(0, 300),
    verdict: ok ? "ALLOW" : denied ? "DENY" : null,
    ok,
    denied,
    json: r.json,
    response: r,
  };
}

/** A value setDoc recurses into for a merge mask: a plain map, not a Date, bytes or an array. */
const isPlainMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array);

/**
 * The field mask setDoc(…, {merge: true}) sends for `data`: the path of every
 * leaf, segments as fieldPath() writes them, joined by "." — a nested plain
 * map is recursed into, an array or an empty map is a leaf (the SDK's
 * parseObject and parseData).
 */
export function mergeMask(data, prefix = []) {
  if (!isPlainMap(data)) throw new Error("mergeMask: want a plain object");
  const out = [];
  for (const [k, v] of Object.entries(data)) {
    const path = [...prefix, k];
    if (isPlainMap(v) && Object.keys(v).length > 0) out.push(...mergeMask(v, path));
    else out.push(path.map(fieldPath).join("."));
  }
  return out;
}

/** clientFirestore's options with `session` resolved into `idToken` and `http`. */
function withSession(o) {
  if (o.session === undefined) return o;
  const s = o.session;
  if (!s || typeof s !== "object" || typeof s.idToken !== "string" || s.idToken.length === 0 || !s.http || typeof s.http.request !== "function") {
    throw new Error("clientFirestore: session is an openSession result, {idToken, http, …}");
  }
  return {
    ...o,
    idToken: o.idToken !== undefined ? o.idToken : () => s.idToken,
    http: o.http ?? s.http,
  };
}

// --- The client ------------------------------------------------------------------

/**
 * A Firestore client for one caller.
 *
 * @param {object} target
 * @param {object} [o]
 * @param {string|null|Function} [o.idToken]  the caller's ID token; null or omitted: anonymous
 * @param {object} [o.session]    an openSession result: its ID token (read per request) and its http client
 * @param {object} [o.http]       a createHttp client (ctx.http({actor}) logs into the case); default a fresh one
 * @param {string} [o.actor]      the trace label for a fresh client ("firestore")
 * @param {*} [o.evidence]        the evidence sink for a fresh client
 * @param {string} [o.database]   "(default)"
 */
export function clientFirestore(target, o = {}) {
  o = withSession(o);
  const origin = firestoreOrigin(target);
  if (typeof target.projectId !== "string" || !target.projectId) throw new Error("clientFirestore: the target has no projectId");
  if (o.idToken === ADMIN_BEARER) throw new Error('clientFirestore: "owner" is the emulator\'s admin credential, which bypasses the rules; read through lib/admin.mjs instead');
  const database = o.database ?? "(default)";
  const root = `projects/${target.projectId}/databases/${database}/documents`;
  const base = `${origin}/v1/${root}`;
  const http = o.http ?? createHttp(target, { actor: o.actor ?? "firestore", evidence: o.evidence });
  const nameOf = (path) => `${root}/${segmentsOf(path, "document").join("/")}`;
  const urlOf = (path, want) => `${base}/${segmentsOf(path, want).map(encodeURIComponent).join("/")}`;

  async function bearer() {
    const t = typeof o.idToken === "function" ? await o.idToken() : o.idToken;
    if (t === undefined || t === null) return null;
    if (typeof t !== "string" || t.length === 0) throw new Error("clientFirestore: idToken must be a non-empty string, a function returning one, or null");
    if (t === ADMIN_BEARER) throw new Error('clientFirestore: "owner" is the emulator\'s admin credential, which bypasses the rules');
    return t;
  }

  async function send(method, url, { json, query } = {}) {
    const t = await bearer();
    const r = await http.request(method, url, {
      json,
      query,
      headers: { authorization: t ? `Bearer ${t}` : null, cookie: null },
      noCookies: true,
    });
    return firestoreResult(r);
  }

  const transforms = (serverTime) => {
    if (!Array.isArray(serverTime)) throw new Error("clientFirestore: serverTime is a list of field names");
    return serverTime.length ? { updateTransforms: serverTime.map((f) => ({ fieldPath: fieldPath(f), setToServerValue: "REQUEST_TIME" })) } : {};
  };

  async function commit(writes) {
    if (!Array.isArray(writes) || writes.length === 0) throw new Error("clientFirestore.commit: give a non-empty list of writes");
    return send("POST", `${base}:commit`, { json: { writes } });
  }

  return {
    root,
    base,
    http,
    commit,
    create(path, data, { serverTime = ["createdAt"] } = {}) {
      for (const f of serverTime) if (Object.hasOwn(data ?? {}, f)) throw new Error(`clientFirestore.create: ${f} is both in the data and a server time; pass {serverTime: []} to send the client's own value`);
      return commit([{ update: { name: nameOf(path), fields: toFields(data) }, currentDocument: { exists: false }, ...transforms(serverTime) }]);
    },
    update(path, fields, { serverTime = [] } = {}) {
      const keys = Object.keys(fields ?? {});
      if (keys.length === 0 && serverTime.length === 0) throw new Error("clientFirestore.update: no fields to update");
      for (const f of serverTime) if (keys.includes(f)) throw new Error(`clientFirestore.update: ${f} is both a field and a server time`);
      return commit([{ update: { name: nameOf(path), fields: toFields(fields ?? {}) }, updateMask: { fieldPaths: keys.map(fieldPath) }, currentDocument: { exists: true }, ...transforms(serverTime) }]);
    },
    set(path, data, { serverTime = [], merge = false } = {}) {
      if (!Array.isArray(serverTime)) throw new Error("clientFirestore: serverTime is a list of field names");
      if (typeof merge !== "boolean") throw new Error(`clientFirestore.set: merge is true or false, got ${JSON.stringify(merge)}`);
      for (const f of serverTime) if (Object.hasOwn(data ?? {}, f)) throw new Error(`clientFirestore.set: ${f} is both in the data and a server time`);
      const write = { update: { name: nameOf(path), fields: toFields(data) }, ...transforms(serverTime) };
      if (merge) write.updateMask = { fieldPaths: mergeMask(data) };
      return commit([write]);
    },
    remove(path) {
      return commit([{ delete: nameOf(path), currentDocument: { exists: true } }]);
    },
    async get(path) {
      const r = await send("GET", urlOf(path, "document"));
      return { ...r, doc: r.ok ? decodeDoc(r.json, root) : null };
    },
    async list(collection, { pageSize, pageToken } = {}) {
      const r = await send("GET", urlOf(collection, "collection"), { query: { pageSize, pageToken } });
      return { ...r, docs: r.ok ? (r.json?.documents ?? []).map((d) => decodeDoc(d, root)) : [], nextPageToken: r.ok ? (r.json?.nextPageToken ?? null) : null };
    },
    async runQuery(structuredQuery, { parent = null } = {}) {
      if (!structuredQuery || typeof structuredQuery !== "object" || Array.isArray(structuredQuery)) throw new Error("clientFirestore.runQuery: give a structuredQuery object ({from, where, orderBy, limit})");
      const url = parent == null ? `${base}:runQuery` : `${urlOf(parent, "document")}:runQuery`;
      const r = await send("POST", url, { json: { structuredQuery } });
      const rows = Array.isArray(r.json) ? r.json : [];
      const streamError = r.ok ? rows.find((x) => x && typeof x === "object" && x.error)?.error : undefined;
      if (streamError) {
        // The answer began as a 200 and then failed: neither the rules' ALLOW nor their DENY.
        return { ...r, ok: false, verdict: null, denied: false, code: typeof streamError.status === "string" ? streamError.status : null, message: String(streamError.message ?? "").slice(0, 300), docs: [] };
      }
      return { ...r, docs: r.ok ? rows.filter((x) => x && typeof x === "object" && x.document).map((x) => decodeDoc(x.document, root)) : [] };
    },
  };
}
