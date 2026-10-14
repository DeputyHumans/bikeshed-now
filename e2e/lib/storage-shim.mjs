// SPDX-License-Identifier: Apache-2.0
// The stack's Storage shim (--storage-shim): a loopback proxy in front of the Storage emulator for the functions, which judges every ifGenerationMatch write and copy under one lock per object, as Cloud Storage does; its preload, its log and its client (SPEC §4, §12, §21).

/**
 * WHY. A new document's bytes go in CREATE_ONLY (functions/src/lib/publish.ts
 * `ifGenerationMatch: 0`), so two creates racing at one id rest on Storage
 * refusing the second with 412, which moves it to a suffixed id (SPEC §4); a
 * fork's copy and a thumbnail's upload go the same way (fork.ts, index.ts
 * POST /thumb). Cloud Storage implements generation preconditions. The
 * Storage emulator of firebase-tools 15.25.1 has none: it accepts the second
 * write and keeps the last bytes (lib/storage-preconditions.mjs). So on a
 * plain stack no case resting on the refusal can run, and no control that
 * drops CREATE_ONLY can be seen RED.
 *
 * WHAT. A stack built with `--storage-shim` runs this shim in its aux process
 * (lib/stackaux.mjs) on the block role `storageShim` (spare7), in front of
 * the Storage emulator, and its function workers dial the shim, not the
 * emulator. For each request the shim reads the method and URL
 * (storageRequestKind):
 *
 *   upload    POST /upload/storage/v1/b/<b>/o?name=<n> (uploadType media or
 *             multipart: the Node SDK's simple upload, which every product
 *             write uses, `resumable: false`)
 *   rewrite   POST [/storage/v1]/b/<sb>/o/<s>/rewriteTo/b/<b>/o/<n> (the SDK's
 *   copy        copy(); copyTo the same), the destination being <b>/<n>
 *   delete,   DELETE / PATCH [/storage/v1]/b/<b>/o/<n>
 *   patch
 *   resumable POST …?uploadType=resumable (a session; it writes nothing) and
 *             PUT …?upload_id= (the session's bytes, under ?name= when the
 *             emulator's Location names it)
 *
 * Every write of a named object (upload, rewrite/copy destination, delete,
 * patch, a resumable PUT with a name) takes that object's LOCK, one FIFO
 * mutex per (bucket, name), and holds it until the emulator's answer has
 * ended, so writes of one object never interleave. A write carrying
 * `ifGenerationMatch=<g>` (upload, rewrite, copy) is JUDGED under the lock:
 * the shim reads the object's metadata (`GET /b/<b>/o/<n>` as the emulator's
 * admin), and the precondition holds when g is 0 and the object does not
 * exist, or when the object's generation is g. If it holds, the request is
 * forwarded as sent (method, path, headers, body streamed); if not, the shim
 * answers 412 with Cloud Storage's body (`conditionNotMet`), and the
 * emulator never sees it. Reads take no lock. Everything else passes through
 * unchanged, the Host header included (so the emulator's resumable Location
 * names the shim).
 *
 * Fails loudly, never approximately:
 *   - a precondition the shim does not judge — ifGenerationNotMatch,
 *     ifMetageneration*, ifSourceGeneration*, ifSourceMetageneration*, any
 *     precondition on a read, a delete, a patch or a resumable upload, or a
 *     create-only upload with no ?name= (the name in a multipart body is not
 *     read) — answers 501 (`unjudged`), so a stack that advertises
 *     storage-preconditions never silently accepts what it cannot judge;
 *   - an ifGenerationMatch that is not a decimal number answers 400;
 *   - a metadata read that fails answers 503 (`error`), never a forward;
 *   - a judged or locked request the emulator has not answered within
 *     `holdMaxMs` (120 s) is cut off and answered 504.
 * Its stats count every request and every decision; its decisions (the last
 * SHIM_DECISIONS_KEPT, each with a `seq`) say what it judged and why.
 *
 * THE FUNCTIONS. firebase-tools hands each function worker
 * STORAGE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST from its emulator
 * registry, AFTER the functions' .env.local (functionsEmulator.js
 * getRuntimeEnvs: user envs, then emulator envs), so no dotenv line can move
 * them. The stack therefore preloads lib/storage-shim-preload.mjs (copied to
 * <tree>/.e2e/storage-shim-preload.mjs) into the emulator after the egress
 * guard, through NODE_OPTIONS, with E2E_STORAGE_SHIM_HOST (the shim),
 * E2E_STORAGE_SHIM_UPSTREAM (the emulator) and E2E_STORAGE_SHIM_LOG
 * (logs/storage-shim.jsonl). A worker inherits both (startNode spawns with
 * `...process.env, ...envs`). In a process whose FUNCTIONS_EMULATOR is "true"
 * and whose Storage hosts name the emulator, the preload points both at the
 * shim before any product code runs, and writes one line saying so;
 * anywhere else it does nothing. Readiness then requires a function worker's
 * line naming the shim (shimRedirects), so a stack whose workers would still
 * dial the emulator does not start.
 *
 * NOT THROUGH IT: the harness's own Admin client (adminFor, listObjects,
 * seed), the operator scripts and a spec's STORAGE_EMULATOR_HOST all keep the
 * emulator's own port (target.storageUrl), and the browser never talks to
 * Storage. Their writes take no lock and are not judged; reads see the same
 * bytes, since the shim stores nothing of its own.
 */

import http from "node:http";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_DIR, assertPath } from "./paths.mjs";

/** The capability of a stack whose aux process runs the shim and whose function workers proved they dial it. */
export const STORAGE_SHIM = "storage-shim";
/** The block role the shim listens on, and the spare-pool role it is taken from. */
export const STORAGE_SHIM_ROLE = "storageShim";
export const STORAGE_SHIM_SPARE = "spare7";
/** The preload's environment: the shim, the emulator it replaces, and its log. */
export const STORAGE_SHIM_ENV = "E2E_STORAGE_SHIM_HOST";
export const STORAGE_SHIM_UPSTREAM_ENV = "E2E_STORAGE_SHIM_UPSTREAM";
export const STORAGE_SHIM_LOG_ENV = "E2E_STORAGE_SHIM_LOG";
/** The preload's source, and where a stack's copy lives in its tree. */
export const STORAGE_SHIM_PRELOAD_SOURCE = assertPath(join(E2E_DIR, "lib", "storage-shim-preload.mjs"), "storage shim preload");
export const STORAGE_SHIM_PRELOAD_IN_TREE = ".e2e/storage-shim-preload.mjs";
/** Every generation precondition Cloud Storage takes as a query parameter; only ifGenerationMatch is judged. */
export const PRECONDITION_PARAMS = Object.freeze([
  "ifGenerationMatch", "ifGenerationNotMatch", "ifMetagenerationMatch", "ifMetagenerationNotMatch",
  "ifSourceGenerationMatch", "ifSourceGenerationNotMatch", "ifSourceMetagenerationMatch", "ifSourceMetagenerationNotMatch",
]);
/** How many decisions the shim keeps (oldest dropped first). */
export const SHIM_DECISIONS_KEPT = 1000;
/** A locked request the emulator has not answered by then is cut off (504). */
export const SHIM_LOCK_HOLD_MAX_MS = 120_000;
/** The metadata read under the lock. */
export const SHIM_META_TIMEOUT_MS = 10_000;

/** Cloud Storage's own words for a failed precondition. */
const CONDITION_NOT_MET = "At least one of the pre-conditions you specified did not hold.";
const ADMIN = "Bearer owner";
/** Hop-by-hop headers a forward drops (Transfer-Encoding is kept: Node then chunks the piped body itself). */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "te", "trailer", "upgrade", "expect"];

function dec(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * What a request to the Storage JSON API is, as the shim sees it.
 * @param {string} method
 * @param {string} url  the request target (path and query)
 * @param {object} [headers]  X-Goog-Upload-Protocol stands in for uploadType, as the emulator reads it
 * @returns {{method:string, path:string, kind:string, bucket:string|null, name:string|null, source:{bucket:string, name:string}|null,
 *   lock:string|null, ifGenerationMatch:string|null, preconditions:string[], judge:boolean, unjudged:string|null, invalid:string|null}}
 *   kind: upload | rewrite | copy | resumable-start | resumable-put | delete | patch | read | other.
 *   `lock` is "<bucket>/<name>" for a write of a named object; `judge` is true when the shim decides an
 *   ifGenerationMatch; `unjudged` is why the shim refuses the request with 501; `invalid` why with 400.
 */
export function storageRequestKind(method, url, headers = {}) {
  const m = String(method ?? "").toUpperCase();
  let u;
  try {
    u = new URL(String(url ?? ""), "http://storage-shim.invalid");
  } catch {
    u = new URL("http://storage-shim.invalid/");
  }
  const q = u.searchParams;
  const path = u.pathname;
  const preconditions = PRECONDITION_PARAMS.filter((k) => q.has(k));
  const gm = q.has("ifGenerationMatch") ? q.get("ifGenerationMatch") : null;
  const out = { method: m, path, kind: "other", bucket: null, name: null, source: null, lock: null, ifGenerationMatch: gm, preconditions, judge: false, unjudged: null, invalid: null };
  const others = preconditions.filter((k) => k !== "ifGenerationMatch");
  const named = (bucket, name) => {
    out.bucket = bucket;
    out.name = name;
    out.lock = bucket !== null && name ? `${bucket}/${name}` : null;
  };
  let r;
  if ((r = /^\/upload\/storage\/v1\/b\/([^/]+)\/o\/?$/.exec(path))) {
    const bucket = dec(r[1]);
    const type = q.get("uploadType") ?? (headers?.["x-goog-upload-protocol"] ? String(headers["x-goog-upload-protocol"]) : null);
    const name = q.has("name") ? q.get("name") : null;
    if (m === "POST" && type === "resumable") {
      out.kind = "resumable-start";
      out.bucket = bucket;
      out.name = name;
      if (preconditions.length) out.unjudged = `a resumable upload's ${preconditions.join(", ")} (the shim judges simple and multipart uploads only; the product sends resumable: false)`;
      return out;
    }
    if (m === "PUT") {
      out.kind = "resumable-put";
      named(bucket, name);
      if (preconditions.length) out.unjudged = `${preconditions.join(", ")} on a resumable upload's bytes (the shim judges simple and multipart uploads only)`;
      return out;
    }
    if (m === "POST") {
      out.kind = "upload";
      named(bucket, name);
      if (others.length) out.unjudged = `${others.join(", ")} on an upload (the shim judges ifGenerationMatch only)`;
      else if (gm !== null && !name) out.unjudged = "an ifGenerationMatch upload with no ?name= (the shim does not read the name from a multipart body)";
      else if (gm !== null) out.judge = true;
    } else if (preconditions.length) out.unjudged = `${preconditions.join(", ")} on ${m} ${path}`;
  } else if ((r = /^(?:\/storage\/v1)?\/b\/([^/]+)\/o\/([^/]+)\/(rewriteTo|copyTo)\/b\/([^/]+)\/o\/([^/]+)$/.exec(path)) && m === "POST") {
    out.kind = r[3] === "rewriteTo" ? "rewrite" : "copy";
    out.source = { bucket: dec(r[1]), name: dec(r[2]) };
    named(dec(r[4]), dec(r[5]));
    if (others.length) out.unjudged = `${others.join(", ")} on a ${out.kind} (the shim judges ifGenerationMatch only)`;
    else if (gm !== null) out.judge = true;
  } else if ((r = /^(?:\/storage\/v1)?\/b\/([^/]+)\/o\/([^/]+)$/.exec(path))) {
    if (m === "DELETE" || m === "PATCH" || m === "PUT") {
      out.kind = m === "DELETE" ? "delete" : "patch";
      named(dec(r[1]), dec(r[2]));
    } else {
      out.kind = "read";
      out.bucket = dec(r[1]);
      out.name = dec(r[2]);
    }
    if (preconditions.length) out.unjudged = `${preconditions.join(", ")} on a ${out.kind} (the shim judges uploads and copies only)`;
  } else if (preconditions.length) {
    out.unjudged = `${preconditions.join(", ")} on ${m} ${path} (the shim judges uploads and copies only)`;
  }
  if (out.judge && !/^(0|[1-9]\d{0,19})$/.test(gm)) {
    out.judge = false;
    out.invalid = `ifGenerationMatch is a generation (a decimal number), got ${JSON.stringify(gm)}`;
  }
  if ((out.judge || out.lock) && (out.bucket === null || out.name === null)) {
    out.judge = false;
    out.lock = null;
    out.invalid = `a malformed object path ${JSON.stringify(path)}`;
  }
  return out;
}

/** A Cloud Storage error body. */
function gcsError(code, message, reason) {
  return JSON.stringify({ error: { code, message, errors: [{ message, domain: "global", reason }] } });
}

/** A FIFO mutex per key. acquire(key) → {waitedMs, contended, release()}; release is idempotent. */
function lockTable() {
  const tails = new Map();
  let held = 0;
  return {
    get held() {
      return held;
    },
    async acquire(key) {
      const contended = tails.has(key);
      const prev = tails.get(key) ?? Promise.resolve();
      let open;
      const mine = new Promise((r) => (open = r));
      const tail = prev.then(() => mine);
      tails.set(key, tail);
      const t0 = Date.now();
      await prev;
      held += 1;
      let done = false;
      return {
        waitedMs: Date.now() - t0,
        contended,
        release() {
          if (done) return;
          done = true;
          held -= 1;
          open();
          if (tails.get(key) === tail) tails.delete(key);
        },
      };
    },
  };
}

/** Resolve once a request's body has been read to its end (or the request is gone). */
function drained(req) {
  return new Promise((resolve) => {
    if (req.readableEnded || req.destroyed) return resolve();
    req.once("end", resolve);
    req.once("close", resolve);
    req.once("error", resolve);
    req.resume();
  });
}

/**
 * Start the shim in this process. `upstreamPort` is the Storage emulator's.
 * Resolves {port, host, url, upstream, stats (a copy, read at each access),
 * decisions({since}), close()}.
 */
export async function startStorageShim({ listenPort = 0, host = "127.0.0.1", upstreamPort, upstreamHost = "127.0.0.1", metaTimeoutMs = SHIM_META_TIMEOUT_MS, holdMaxMs = SHIM_LOCK_HOLD_MAX_MS, log = () => {} } = {}) {
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new TypeError(`startStorageShim: listenPort is a port number, got ${JSON.stringify(listenPort)}`);
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw new TypeError(`startStorageShim: upstreamPort is the Storage emulator's port, got ${JSON.stringify(upstreamPort)}`);
  if (upstreamHost !== "127.0.0.1" || host !== "127.0.0.1") throw new TypeError("startStorageShim: loopback only (127.0.0.1)");
  for (const [k, v] of Object.entries({ metaTimeoutMs, holdMaxMs })) if (!Number.isInteger(v) || v < 1 || v > 600_000) throw new TypeError(`startStorageShim: ${k} is a whole number of ms from 1 to 600000, got ${JSON.stringify(v)}`);
  if (typeof log !== "function") throw new TypeError("startStorageShim: log is a function");

  const agent = new http.Agent({ keepAlive: true });
  const locks = lockTable();
  const counts = { seq: 0, requests: 0, open: 0, passed: 0, locked: 0, waited: 0, maxWaitMs: 0, judged: 0, forwarded: 0, refused: 0, unjudged: 0, invalid: 0, errors: 0, timeouts: 0 };
  const kept = [];
  const decide = (c, decision, fields = {}) => {
    counts.seq += 1;
    const d = { seq: counts.seq, t: new Date().toISOString(), kind: c.kind, bucket: c.bucket, name: c.name, ifGenerationMatch: c.ifGenerationMatch, current: null, decision, status: null, waitedMs: 0, ms: null, reason: null, ...fields };
    kept.push(d);
    if (kept.length > SHIM_DECISIONS_KEPT) kept.splice(0, kept.length - SHIM_DECISIONS_KEPT);
    if (decision !== "forward") log({ kind: "storage-shim", decision, object: c.lock ?? c.path, ifGenerationMatch: c.ifGenerationMatch, current: d.current, status: d.status, reason: d.reason });
    return d;
  };

  const sendJson = (res, status, body, shim) => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store", "x-e2e-storage-shim": shim, "content-length": Buffer.byteLength(body) });
    res.end(body);
  };

  /** The object's generation, null when it does not exist; {error} when the emulator could not say. */
  const readGeneration = (bucket, name) =>
    new Promise((resolve) => {
      const r = http.request({ host: upstreamHost, port: upstreamPort, method: "GET", path: `/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`, headers: { authorization: ADMIN, host: `${upstreamHost}:${upstreamPort}` }, agent }, (ur) => {
        const chunks = [];
        ur.on("data", (c) => chunks.push(c));
        ur.on("end", () => {
          if (ur.statusCode === 404) return resolve({ generation: null });
          if (ur.statusCode !== 200) return resolve({ error: `the emulator answered ${ur.statusCode} to the metadata read` });
          try {
            const g = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.generation;
            if (!/^\d+$/.test(String(g ?? ""))) return resolve({ error: `the metadata names no generation (${JSON.stringify(g)})` });
            resolve({ generation: String(g) });
          } catch (err) {
            resolve({ error: `the metadata is not JSON (${err.message})` });
          }
        });
        ur.on("error", (err) => resolve({ error: `the metadata read failed: ${err.message}` }));
      });
      r.setTimeout(metaTimeoutMs, () => r.destroy(new Error(`no answer within ${metaTimeoutMs} ms`)));
      r.on("error", (err) => resolve({ error: `the metadata read failed: ${err.message}` }));
      r.end();
    });

  /** Forward req as sent; done(status, error) once, when the emulator's answer has ended or the exchange failed. */
  const forward = (req, res, { cut = false, done }) => {
    let finished = false;
    let answered = false;
    const finish = (status, err = null) => {
      if (finished) return;
      finished = true;
      done(status, err);
    };
    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    const up = http.request({ host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers, agent }, (ur) => {
      answered = true;
      const out = { ...ur.headers };
      for (const h of HOP_BY_HOP) delete out[h];
      res.writeHead(ur.statusCode, ur.statusMessage, out);
      ur.pipe(res);
      ur.on("end", () => finish(ur.statusCode));
      ur.on("close", () => finish(ur.statusCode));
      ur.on("error", (err) => finish(ur.statusCode, err));
    });
    if (cut) {
      up.setTimeout(holdMaxMs, () => {
        counts.timeouts += 1;
        up.destroy(Object.assign(new Error(`the Storage emulator did not answer within ${holdMaxMs} ms`), { code: "E2E_SHIM_TIMEOUT" }));
      });
    }
    up.on("error", (err) => {
      const timeout = err.code === "E2E_SHIM_TIMEOUT";
      if (!timeout) counts.errors += 1;
      if (res.headersSent) res.destroy(err);
      else if (timeout) sendJson(res, 504, gcsError(504, `e2e storage shim: ${err.message}`, "timeout"), "timeout");
      else sendJson(res, 502, gcsError(502, `e2e storage shim: the Storage emulator could not be reached: ${err.message}`, "backendError"), "error");
      finish(0, err);
    });
    up.on("close", () => {
      if (!answered) finish(0);
    });
    req.once("close", () => {
      if (!req.complete) up.destroy(new Error("the client went away"));
    });
    res.on("close", () => {
      if (!res.writableFinished) up.destroy(new Error("the client went away"));
    });
    req.pipe(up);
  };

  const handle = async (req, res) => {
    counts.requests += 1;
    counts.open += 1;
    res.once("close", () => (counts.open -= 1));
    const c = storageRequestKind(req.method, req.url, req.headers);
    if (c.unjudged) {
      counts.unjudged += 1;
      decide(c, "unjudged", { status: 501, reason: c.unjudged });
      await drained(req);
      return sendJson(res, 501, gcsError(501, `e2e storage shim: cannot judge ${c.unjudged}; it refuses what it cannot judge (lib/storage-shim.mjs)`, "notImplemented"), "unjudged");
    }
    if (c.invalid) {
      counts.invalid += 1;
      decide(c, "invalid", { status: 400, reason: c.invalid });
      await drained(req);
      return sendJson(res, 400, gcsError(400, `e2e storage shim: ${c.invalid}`, "invalid"), "invalid");
    }
    if (!c.lock) {
      counts.passed += 1;
      return forward(req, res, { done: () => {} });
    }
    const lock = await locks.acquire(c.lock);
    counts.locked += 1;
    if (lock.contended) counts.waited += 1;
    counts.maxWaitMs = Math.max(counts.maxWaitMs, lock.waitedMs);
    const t0 = Date.now();
    // A client that went away while it waited sends nothing more: never hold the object for it.
    if (req.destroyed || res.destroyed) return lock.release();
    try {
      if (!c.judge) {
        counts.passed += 1;
        return forward(req, res, { cut: true, done: () => lock.release() });
      }
      counts.judged += 1;
      const cur = await readGeneration(c.bucket, c.name);
      if (cur.error) {
        counts.errors += 1;
        decide(c, "error", { status: 503, waitedMs: lock.waitedMs, ms: Date.now() - t0, reason: cur.error });
        await drained(req);
        sendJson(res, 503, gcsError(503, `e2e storage shim: could not judge ${c.lock}: ${cur.error}`, "backendError"), "error");
        return lock.release();
      }
      const holds = c.ifGenerationMatch === "0" ? cur.generation === null : cur.generation === c.ifGenerationMatch;
      if (!holds) {
        counts.refused += 1;
        decide(c, "refuse", { current: cur.generation, status: 412, waitedMs: lock.waitedMs, ms: Date.now() - t0, reason: cur.generation === null ? "the object does not exist" : `the object exists at generation ${cur.generation}` });
        await drained(req);
        sendJson(res, 412, gcsError(412, CONDITION_NOT_MET, "conditionNotMet"), "refused");
        return lock.release();
      }
      counts.forwarded += 1;
      const d = decide(c, "forward", { current: cur.generation, waitedMs: lock.waitedMs });
      return forward(req, res, {
        cut: true,
        done: (status) => {
          d.status = status;
          d.ms = Date.now() - t0;
          lock.release();
        },
      });
    } catch (err) {
      counts.errors += 1;
      lock.release();
      sendJson(res, 500, gcsError(500, `e2e storage shim: ${err?.message ?? err}`, "backendError"), "error");
    }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      counts.errors += 1;
      sendJson(res, 500, gcsError(500, `e2e storage shim: ${err?.message ?? err}`, "backendError"), "error");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, host, resolve);
  });
  const port = server.address().port;
  return {
    port,
    host,
    url: `http://${host}:${port}`,
    upstream: { host: upstreamHost, port: upstreamPort },
    get stats() {
      return { ...counts, held: locks.held };
    },
    /** The decisions kept whose seq is above `since`, oldest first (copies). */
    decisions({ since = 0 } = {}) {
      if (!Number.isInteger(since) || since < 0) throw new TypeError(`decisions: since is a decision's seq (a whole number), got ${JSON.stringify(since)}`);
      return kept.filter((d) => d.seq > since).map((d) => ({ ...d }));
    },
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      agent.destroy();
    },
  };
}

function shimError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * The client of a stack's shim: {port, url, controlUrl, upstreamUrl,
 * stats({since}) → Promise<{port, upstream, stats, decisions}>}. Needs the
 * capability storage-shim (E2E_CAPABILITY otherwise); a control route that
 * answers otherwise than 200 is E2E_STORAGE_SHIM.
 *
 *   const shim = storageShim(ctx.target);
 *   const { stats: before } = await shim.stats();
 *   … the race …
 *   const { stats, decisions } = await shim.stats({ since: before.seq });
 *   // decisions: [{seq, t, kind, bucket, name, ifGenerationMatch, current, decision, status, waitedMs, ms, reason}]
 */
export function storageShim(target, { fetchImpl = fetch } = {}) {
  if (target?.kind !== "local") throw shimError("E2E_CAPABILITY", "the Storage shim exists only on a local stack");
  if (!target.capabilities?.has?.(STORAGE_SHIM)) throw shimError("E2E_CAPABILITY", `stack ${target.runId} has no Storage shim (build it with --storage-shim)`);
  const ports = target.stack?.ports ?? {};
  const port = ports[STORAGE_SHIM_ROLE];
  const control = ports.gate;
  if (!Number.isInteger(port) || !Number.isInteger(control)) throw shimError("E2E_CAPABILITY", `stack ${target.runId}: no ${STORAGE_SHIM_ROLE} or gate port in its block`);
  const controlUrl = `http://127.0.0.1:${control}`;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    controlUrl,
    upstreamUrl: target.storageUrl ?? null,
    async stats({ since = 0 } = {}) {
      if (!Number.isInteger(since) || since < 0) throw new TypeError(`storageShim(target).stats: since is a decision's seq (a whole number), got ${JSON.stringify(since)}`);
      const r = await fetchImpl(`${controlUrl}/storage-shim/stats?since=${since}`);
      const text = await r.text();
      if (r.status !== 200) throw shimError("E2E_STORAGE_SHIM", `Storage shim control GET /storage-shim/stats: ${r.status} ${text.slice(0, 200)}`);
      const body = JSON.parse(text);
      return { port: body.port, upstream: body.upstream, stats: body.stats, decisions: body.decisions };
    },
  };
}

/** Copy the preload into a stack tree: {file, sha256}. */
export function installStorageShimPreload(treeDir) {
  assertPath(treeDir, "treeDir");
  mkdirSync(join(treeDir, ".e2e"), { recursive: true });
  const file = join(treeDir, STORAGE_SHIM_PRELOAD_IN_TREE);
  copyFileSync(STORAGE_SHIM_PRELOAD_SOURCE, file);
  return describeStorageShimPreload(file);
}

/** {file, sha256} of an installed preload (re-read: a patch set may have changed it). */
export function describeStorageShimPreload(file) {
  assertPath(file, "storage shim preload");
  if (!existsSync(file)) throw new Error(`no storage shim preload at ${file}`);
  return { file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

/**
 * The emulator's environment additions on a --storage-shim stack: NODE_OPTIONS
 * with the preload AFTER what it already holds (the egress guard), and the
 * preload's three variables.
 */
export function storageShimEnv({ preload, shimPort, upstreamPort, log, nodeOptions = "" }) {
  const file = assertPath(preload, "storage shim preload");
  if (/[\s"'\\]/.test(file)) throw new Error(`the storage shim preload path cannot go into NODE_OPTIONS unquoted: ${file}`);
  for (const [k, v] of Object.entries({ shimPort, upstreamPort })) if (!Number.isInteger(v) || v < 1 || v > 65535) throw new TypeError(`storageShimEnv: ${k} is a port, got ${JSON.stringify(v)}`);
  if (typeof nodeOptions !== "string") throw new TypeError("storageShimEnv: nodeOptions is a string");
  return {
    NODE_OPTIONS: [nodeOptions.trim(), `--require=${file}`].filter(Boolean).join(" "),
    [STORAGE_SHIM_ENV]: `127.0.0.1:${shimPort}`,
    [STORAGE_SHIM_UPSTREAM_ENV]: `127.0.0.1:${upstreamPort}`,
    [STORAGE_SHIM_LOG_ENV]: assertPath(log, "storage shim log"),
  };
}

/** The preload's lines in `file` from byte `since` (malformed lines skipped; no file: []). */
export function readStorageShimLog(file, { since = 0 } = {}) {
  if (!file || !existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file).subarray(since).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/**
 * Whether the preload's lines prove the function workers dial the shim: at
 * least one worker (a line with a FUNCTION_TARGET, in its main thread)
 * redirected to `shimPort`, and none left on anything else.
 * @returns {{ok:boolean, workers:number, redirected:number, refused:{pid:number, target:string, why:string|null}[], reason:string|null}}
 */
export function shimRedirects(lines, { shimPort, upstreamPort }) {
  const shim = `127.0.0.1:${shimPort}`;
  const workers = (lines ?? []).filter((l) => l && typeof l.target === "string" && l.target && (l.thread ?? 0) === 0);
  const good = (l) => l.redirected === true && l.to?.FIREBASE_STORAGE_EMULATOR_HOST === shim && l.to?.STORAGE_EMULATOR_HOST === `http://${shim}` && l.upstream === `127.0.0.1:${upstreamPort}`;
  const redirected = workers.filter(good).length;
  const refused = workers.filter((l) => !good(l)).map((l) => ({ pid: l.pid, target: l.target, why: l.why ?? (l.redirected ? `redirected to ${JSON.stringify(l.to)}, not ${shim}` : null) }));
  const ok = redirected > 0 && refused.length === 0;
  const reason = ok ? null : refused.length ? `${refused.length} function worker(s) not pointed at the shim: ${refused.slice(0, 3).map((r) => `${r.target} (pid ${r.pid}): ${r.why}`).join("; ")}` : "no function worker has started under the preload yet";
  return { ok, workers: workers.length, redirected, refused, reason };
}
