// SPDX-License-Identifier: Apache-2.0
// firebase-admin bound to the Target: Firestore, Storage (with generations), RTDB (reads and a listener's every value) and Auth reads for oracles (SPEC §12).

/**
 * One named Admin app per target, never the default app, so nothing else in
 * the process can pick it up by accident.
 *
 * LOCAL: the SDK finds the emulators through the *_EMULATOR_HOST variables
 * run.mjs gives a spec process (target.emulatorEnv). If they are absent — a
 * scratch script run by hand — they are set here from the target; if they are
 * present and name ANY other host, this refuses rather than read or write a
 * stack that is not this target's (another session's, or the default ports).
 *
 * PRODUCTION (not runnable in this build; loadTarget refuses prod): the
 * operator's ADC, the project, bucket and database URL from the target.
 *
 * Oracles read through here; specs never write through it except the narrow
 * helpers below (an account record before its first session, as the
 * production tier must).
 */

import { initializeApp, getApps, applicationDefault, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getDatabase } from "firebase-admin/database";
import { getAuth } from "firebase-admin/auth";
import { assertTargetPort, emulatorEnv } from "./target.mjs";

const cache = new Map();

/** Point the SDK at this target's emulators, or refuse if something else is set. */
export function bindEmulatorEnv(target, env = process.env) {
  const want = emulatorEnv(target);
  for (const [k, v] of Object.entries(want)) {
    if (env[k] === undefined || env[k] === "") env[k] = v;
    else if (env[k] !== v) {
      throw new Error(`admin: ${k}=${env[k]} is not run ${target.runId}'s (${v}); refusing to bind the Admin SDK to another stack`);
    }
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("admin: GOOGLE_APPLICATION_CREDENTIALS is set in a local spec process; refusing (scrubEnv should have dropped it)");
  }
  return want;
}

/**
 * The Admin handles for a target: {app, db, bucket, rtdb, auth}.
 * Cached per runId.
 */
export function adminFor(target) {
  const key = `e2e-${target.runId}`;
  if (cache.has(key)) return cache.get(key);
  let app = getApps().find((a) => a.name === key);
  if (!app) {
    if (target.kind === "local") {
      bindEmulatorEnv(target);
      app = initializeApp(
        { projectId: target.projectId, storageBucket: target.bucket, databaseURL: target.databaseURL },
        key,
      );
    } else if (target.kind === "prod") {
      app = initializeApp(
        { credential: applicationDefault(), projectId: target.projectId, storageBucket: target.bucket, databaseURL: target.databaseURL },
        key,
      );
    } else {
      throw new Error(`admin: unknown target kind ${target.kind}`);
    }
  }
  const handles = {
    app,
    db: getFirestore(app),
    bucket: getStorage(app).bucket(target.bucket),
    rtdb: getDatabase(app),
    auth: getAuth(app),
  };
  cache.set(key, handles);
  return handles;
}

/** A Firestore document's data by slash path, or null. */
export async function readDoc(target, path) {
  const snap = await adminFor(target).db.doc(path).get();
  return snap.exists ? snap.data() : null;
}

/** A document and its commit revision, for version-fenced mirror repair. */
export async function readDocRevision(target, path) {
  const snap = await adminFor(target).db.doc(path).get();
  if (!snap.exists) return null;
  if (!snap.updateTime) throw new Error(`readDocRevision ${path}: missing updateTime`);
  return {
    data: snap.data(),
    revision: `${String(snap.updateTime.seconds).padStart(12, "0")}:${String(snap.updateTime.nanoseconds).padStart(9, "0")}`,
  };
}

/** Every document in a collection: [{id, data}]. */
export async function readCollection(target, path) {
  const snap = await adminFor(target).db.collection(path).get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

/** The comparison operators the Admin SDK's where() takes (WhereFilterOp). */
export const WHERE_OPS = Object.freeze(["<", "<=", "==", "!=", ">=", ">", "array-contains", "in", "not-in", "array-contains-any"]);
const LIST_OPS = new Set(["in", "not-in", "array-contains-any"]);

/**
 * The documents of a collection that match every filter: [{id, data}], in
 * Firestore's order (by document id when no inequality says otherwise).
 * Admin SDK, so past the rules, like readCollection; use it where a
 * collection is shared by every spec on a stack (forks/*, docs/*) and only
 * the case's own rows are its business.
 *
 *   await queryCollection(target, "forks", [["parentId", "==", sourceId]])
 *
 * `filters` is a list of [field, op, value] triples, ANDed, each one a
 * where(field, op, value): `field` a dotted field path, `op` one of
 * WHERE_OPS, `value` anything but undefined (a non-empty array for "in",
 * "not-in" and "array-contains-any"). An empty list reads the whole
 * collection. `path` is a collection path (an odd number of segments, such
 * as "docs/<id>/versions"). A malformed filter or path throws before
 * anything is read. The emulator serves any combination without an index;
 * production refuses one that needs a composite index it lacks
 * (FAILED_PRECONDITION). `o.db`
 * replaces adminFor(target).db (a self-test's stand-in).
 *
 * @param {object} target
 * @param {string} path
 * @param {Array<[string, string, *]>} [filters]
 * @param {{db?: object}} [o]
 * @returns {Promise<Array<{id: string, data: object}>>}
 */
export async function queryCollection(target, path, filters = [], { db } = {}) {
  const segments = typeof path === "string" ? path.split("/") : null;
  if (!segments || segments.some((s) => s === "") || segments.length % 2 !== 1) {
    throw new Error(`queryCollection: path is a collection path (an odd number of non-empty segments), got ${JSON.stringify(path)}`);
  }
  if (!Array.isArray(filters)) throw new Error(`queryCollection: filters is a list of [field, op, value] triples, got ${typeof filters}`);
  if (filters.length === 3 && typeof filters[0] === "string" && typeof filters[1] === "string") {
    throw new Error(`queryCollection: filters is a LIST of [field, op, value] triples: wrap ${JSON.stringify(filters)} in another [ ]`);
  }
  filters.forEach((f, i) => {
    const at = `queryCollection: filter ${i}`;
    if (!Array.isArray(f) || f.length !== 3) throw new Error(`${at} is a [field, op, value] triple, got ${JSON.stringify(f)}`);
    const [field, op, value] = f;
    if (typeof field !== "string" || !field || field.split(".").some((s) => s === "")) throw new Error(`${at}: field is a dotted field path, got ${JSON.stringify(field)}`);
    if (!WHERE_OPS.includes(op)) throw new Error(`${at}: op is one of ${WHERE_OPS.join(" ")}, got ${JSON.stringify(op)}`);
    if (value === undefined) throw new Error(`${at}: value is undefined (Firestore stores no undefined; did you mean null?)`);
    if (LIST_OPS.has(op) && (!Array.isArray(value) || value.length === 0)) throw new Error(`${at}: "${op}" takes a non-empty array, got ${JSON.stringify(value)}`);
  });
  let query = (db ?? adminFor(target).db).collection(path);
  for (const [field, op, value] of filters) query = query.where(field, op, value);
  const snap = await query.get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

/** The selected immutable draft snapshot; old records retain their legacy prefix. */
export function draftStoragePrefix(docId, draft) {
  const prefix = draft?.storagePrefix ?? `docs/${docId}/draft`;
  if (typeof prefix !== "string" || !prefix.startsWith(`docs/${docId}/`) || prefix.endsWith("/") || prefix.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("draft storage prefix must belong to its document");
  }
  return prefix;
}

/** Read the entry selected by current draft metadata, without falling back to a published version. */
export async function readDraftObject(target, docId, rel) {
  const data = await readDoc(target, `docs/${docId}`);
  if (!data?.draft) return null;
  return readObject(target, `${draftStoragePrefix(docId, data.draft)}/${rel}`);
}

/** A Storage object's bytes, or null when it does not exist. */
export async function readObject(target, objectKey) {
  const file = adminFor(target).bucket.file(objectKey);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buf] = await file.download();
  return buf;
}

/**
 * The objects under a prefix: their names, sorted (as before), or, with
 * `{meta: true}`, each one as Storage lists it, `{name, generation,
 * metageneration, md5, size}`, sorted by name in the same order (UTF-16 code
 * units, as Array#sort orders strings).
 *
 * A name list cannot see an object rewritten in place: a save of the same
 * bytes, or a delete followed by a save, leaves the name where it was. Each
 * one gives the object a new `generation` (a decimal string, as the JSON API
 * gives it); a metadata-only update moves `metageneration` instead. `md5` is
 * the base64 MD5 Storage computed of the bytes (null when it lists none, as
 * for a composed object), `size` the byte count. So "left alone" is
 * `assert.deepEqual(after, before)` over two such listings.
 *
 * The Storage EMULATOR's generation is its clock in milliseconds
 * (firebase-tools 15.25.1, storage/metadata.js `opts.generation ||
 * Date.now()`, pinned by selftest/admin-objects-meta.test.mjs): there, two
 * saves of one name within the same millisecond carry the same generation.
 * Measured on a stack (2026-10-13): 25 back-to-back save-and-list rounds of
 * one name never repeated one, 1 ms apart at the closest; a delete then a
 * save took 3 ms. Cloud Storage gives every save a new one.
 *
 * A listed object with no generation throws E2E_STORAGE_META (`object` names
 * it): a comparison by generation would hold for nothing. `meta` other than
 * a boolean, or a `bucket` with no getFiles, is a TypeError before anything
 * is listed. Every page is read (getFiles' autoPaginate). `o.bucket`
 * replaces adminFor(target).bucket (a self-test's stand-in).
 *
 * @param {object} target
 * @param {string} prefix
 * @param {{meta?: boolean, bucket?: object}} [o]
 * @returns {Promise<string[] | Array<{name: string, generation: string, metageneration: string|null, md5: string|null, size: number|null}>>}
 */
export async function listObjects(target, prefix, { meta = false, bucket = null } = {}) {
  if (typeof meta !== "boolean") throw new TypeError(`listObjects: meta is true or false, got ${JSON.stringify(meta) ?? String(meta)}`);
  if (bucket != null && typeof bucket.getFiles !== "function") throw new TypeError("listObjects: bucket is a Storage Bucket (getFiles)");
  const [files] = await (bucket ?? adminFor(target).bucket).getFiles({ prefix });
  if (!meta) return files.map((f) => f.name).sort();
  return files.map(listedObject).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A generation or metageneration as Storage lists it: a decimal string (or a whole number). */
function isDecimal(v) {
  return (typeof v === "string" && /^\d+$/.test(v)) || (Number.isSafeInteger(v) && v >= 0);
}

/** One getFiles File as listObjects' {meta: true} row. */
function listedObject(f) {
  const m = f?.metadata ?? {};
  if (!isDecimal(m.generation)) {
    const err = new Error(`listObjects: ${f?.name} was listed with no generation (${typeof m.generation === "string" ? JSON.stringify(m.generation) : String(m.generation)}): a comparison by generation would hold for nothing`);
    err.code = "E2E_STORAGE_META";
    err.object = f?.name ?? null;
    throw err;
  }
  const size = m.size == null || m.size === "" ? NaN : Number(m.size);
  return {
    name: f.name,
    generation: String(m.generation),
    metageneration: isDecimal(m.metageneration) ? String(m.metageneration) : null,
    md5: typeof m.md5Hash === "string" && m.md5Hash ? m.md5Hash : null,
    size: Number.isSafeInteger(size) && size >= 0 ? size : null,
  };
}

/**
 * An RTDB value at `path` (null when absent), over the REST API.
 *
 * Not through the SDK handle: its websocket keeps the process alive after the
 * last test, so every spec file would end in a test-runner timeout. Locally
 * the emulator's admin credential ("Bearer owner") reads past the rules; on
 * production the Admin app's ADC access token does.
 */
export async function rtdbGet(target, path) {
  const base = new URL(target.databaseURL);
  if (target.kind === "local") assertTargetPort(target, Number(base.port));
  const segments = String(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const url = new URL(`${base.origin}/${segments}.json`);
  for (const [k, v] of base.searchParams) url.searchParams.set(k, v);
  let auth = "Bearer owner";
  if (target.kind !== "local") {
    const token = await adminFor(target).app.options.credential.getAccessToken();
    auth = `Bearer ${token.access_token}`;
  }
  const r = await fetch(url, { headers: { authorization: auth } });
  if (!r.ok) throw new Error(`rtdbGet ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/**
 * Delete this target's Admin app (Firestore channels, and the RTDB websocket
 * if anything used the `rtdb` handle). Call it from an `after()` hook when a
 * spec used `adminFor(target).rtdb` directly; rtdbGet() needs nothing.
 */
export async function closeAdmin(target) {
  const key = `e2e-${target.runId}`;
  const handles = cache.get(key);
  cache.delete(key);
  if (handles) await deleteApp(handles.app);
}

/** How long watchRtdb waits for the Database's first value of the path (ms). */
export const RTDB_WATCH_FIRST_MS = 15_000;

/**
 * Watch `path` in the target's Realtime Database through the Admin SDK's own
 * listener and keep EVERY value it takes until stop(): one row per value
 * event, `{t, n, exists}` (`t` this process's clock when the SDK raised it,
 * `n` the node's child count, `exists` false while the node is absent), plus
 * `v: pick(value, snapshot)` when `pick` is given.
 *
 *   const w = await watchRtdb(ctx.target, `status/${docId}/y`);
 *   … the window …
 *   const { rows, error } = w.stop();
 *   assert.equal(error, null, "the watch held");
 *   assert.deepEqual(rows.filter((r) => r.n === 0), [], "the live log was never emptied");
 *
 * Why not a poll: a removal of a whole node that writers refill within
 * milliseconds (typing editors refilling status/{d}/y) is gone before a REST
 * read 200 ms later. The listener is sent every change the server applies,
 * the removal included, in order. Rows are never merged: two values with the
 * same count are two rows. A write that leaves the node as it was raises no
 * event at all (the emulator sends none: measured, an identical REST PUT
 * gave no row), so each row is a change.
 *
 * It resolves once the first value has arrived (the node as it stood when
 * the listener was bound: `first`, also rows[0]); nothing before that is
 * watched. No first value within `firstMs` throws E2E_RTDB_WATCH with
 * `stackCut` (the Database did not answer: a case with
 * inconclusiveOnStackTimeout ends INCONCLUSIVE, lib/test.mjs
 * stackDidNotAnswer); a listener cancelled before its first value throws
 * E2E_RTDB_WATCH without one. Each carries `path`, `firstMs` and `error`, and
 * leaves no listener behind. A cancel after the first value ends the rows and
 * is stop()'s `error`, as is the first throw of `pick` (that row's `v` is
 * undefined; the watch goes on). Judge a window only on a watch whose `error`
 * is null.
 *
 * stop() detaches the listener and returns `{path, rows, error}`, the same
 * object on every call. The socket is the target's Admin app's: it
 * reads the emulator directly, never through a --rtdb-proxy, and stays open
 * after stop(), so call closeAdmin(target) in an `after()` hook, as for any
 * use of adminFor(target).rtdb.
 *
 * A bad path (not a string, the root, a "." or ".." segment), firstMs, pick,
 * rtdb or now is a TypeError before anything is bound. `rtdb` replaces
 * adminFor(target).rtdb (a self-test's stand-in) and `now` Date.now.
 *
 * @param {object} target
 * @param {string} path
 * @param {{firstMs?: number, pick?: Function, rtdb?: object, now?: () => number}} [o]
 * @returns {Promise<{path: string, first: {t: number, n: number, exists: boolean, v?: *}, stop(): {path: string, rows: Array<{t: number, n: number, exists: boolean, v?: *}>, error: string|null}}>}
 */
export async function watchRtdb(target, path, { firstMs = RTDB_WATCH_FIRST_MS, pick = null, rtdb = null, now = Date.now } = {}) {
  const segs = typeof path === "string" ? path.split("/").filter(Boolean) : null;
  if (!segs || segs.length === 0) throw new TypeError(`watchRtdb: path is a database path below the root, got ${JSON.stringify(path) ?? String(path)}`);
  if (segs.some((s) => s === "." || s === "..")) throw new TypeError(`watchRtdb: ${path} has a "." or ".." segment`);
  if (typeof firstMs !== "number" || !Number.isFinite(firstMs) || firstMs <= 0) throw new TypeError(`watchRtdb: firstMs is a number of ms above 0, got ${JSON.stringify(firstMs) ?? String(firstMs)}`);
  if (pick != null && typeof pick !== "function") throw new TypeError("watchRtdb: pick is (value, snapshot) => what to keep of each value");
  if (rtdb != null && typeof rtdb.ref !== "function") throw new TypeError("watchRtdb: rtdb is a Database handle (ref)");
  if (typeof now !== "function") throw new TypeError("watchRtdb: now is () => ms");
  const where = segs.join("/");
  const ref = (rtdb ?? adminFor(target).rtdb).ref(where);
  const rows = [];
  let error = null;
  let stopped = null;
  let settle;
  const first = new Promise((resolve) => {
    settle = resolve;
  });
  const onValue = (snap) => {
    if (stopped) return;
    const row = { t: now(), n: snap.numChildren(), exists: snap.exists() };
    if (pick) {
      try {
        row.v = pick(snap.val(), snap);
      } catch (err) {
        row.v = undefined;
        error ??= `pick threw on value ${rows.length + 1}: ${String(err?.message ?? err).split("\n")[0]}`;
      }
    }
    rows.push(row);
    settle("value");
  };
  const onCancel = (err) => {
    error ??= `the listener was cancelled${rows.length ? ` after ${rows.length} value(s)` : ""}: ${String(err?.message ?? err).split("\n")[0]}`;
    settle("cancel");
  };
  ref.on("value", onValue, onCancel);
  let timer;
  const how = await Promise.race([
    first,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), firstMs);
    }),
  ]);
  clearTimeout(timer);
  if (how !== "value") {
    ref.off("value", onValue);
    stopped = { path: where, rows: [], error };
    const db = target?.kind === "local" ? "the Database emulator" : "the Realtime Database";
    const why = how === "timeout" ? `${db} gave no value of ${where} within ${firstMs} ms` : `${db} cancelled the watch of ${where} before its first value (${error})`;
    const err = new Error(`watchRtdb: ${why}`);
    err.code = "E2E_RTDB_WATCH";
    if (how === "timeout") err.stackCut = why;
    err.path = where;
    err.firstMs = firstMs;
    err.error = error;
    throw err;
  }
  return {
    path: where,
    first: { ...rows[0] },
    stop() {
      if (!stopped) {
        ref.off("value", onValue);
        stopped = { path: where, rows: rows.slice(), error };
      }
      return stopped;
    },
  };
}

/**
 * Write users/{uid}. On production this is done BEFORE any session, with
 * emailNotifications:false and analyticsOptOut:true, so nothing a run does
 * can email the account or count it as a visitor. Merged by default.
 */
export async function writeUser(target, uid, data, { merge = true } = {}) {
  if (!uid || typeof uid !== "string") throw new Error("writeUser: uid is required");
  await adminFor(target).db.collection("users").doc(uid).set(data, { merge });
  return data;
}

/**
 * Trust a document for everyone as the operator does: `scripts/publish.mjs`
 * writes `trusted: true` with Admin credentials. Through POST /trust it takes
 * a superadmin who owns the document (ADR 0021), and an e2e account is never
 * one on production, so a case about what a TRUSTED document does, rather
 * than about who may trust one, sets it here. The projection carries the flag
 * too, when there is one; a later visibility change rebuilds it from the record.
 */
export async function trustAsOperator(target, docId) {
  if (!docId || typeof docId !== "string") throw new Error("trustAsOperator: docId is required");
  const { db } = adminFor(target);
  await db.collection("docs").doc(docId).set({ trusted: true }, { merge: true });
  const pub = db.collection("public").doc(docId);
  if ((await pub.get()).exists) await pub.set({ trusted: true }, { merge: true });
}

/** The RTDB key the product uses for an email (dots become commas). */
export function emailKey(email) {
  return String(email).toLowerCase().split(".").join(",");
}
