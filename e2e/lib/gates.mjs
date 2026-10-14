// SPDX-License-Identifier: Apache-2.0
// Gates: the loopback service a patched stack's pause points (SYNC-P) and client gates (SYNC-G) ask whether to go on, and the spec-side client that holds and releases them (SPEC §12, §16).

/**
 * WHY. A race between two requests, or two joiners, is only a test when the
 * interleaving is the one meant. An AMPLIFY set (e2e/patches/amplify-<name>/,
 * applied to a stack COPY only, through the same `git apply --check`
 * machinery as a control) adds a call at a chosen point of the product:
 *
 *   server (functions)  await e2eGate("<name>", docId)   reads E2E_GATE_URL
 *   client (the app)    await e2eGate("<name>", docId)   reads VITE_E2E_GATE_URL
 *
 * Each call is `POST <gate>/gate/<name>/pass?key=<docId>&side=…&caller=…&run=…`
 * to this service, which answers at once unless a spec has HELD that gate
 * (for that key, or for every key): then the answer waits until the spec
 * RELEASES it. `caller` and `run` say who calls: the client helper one id per
 * page and a run number per call (a hook's effect runs again while its first
 * call is held, so one joiner may be held twice), the server helper one id
 * per request.
 * Both helpers FAIL CLOSED: a patched stack without its gate URL, or a gate
 * service that does not answer 200, throws in the product instead of going
 * on as if nothing had been asked. The env vars are set only on a stack
 * built with gates (`--gates`, implied by any amplify-* set: lib/stack.mjs).
 *
 * THE SERVICE runs in the stack's aux process (lib/stackaux.mjs) on the
 * stack port `gate`, a port of the stack's block, so the browser tripwire
 * lets the app reach it. Routes (JSON bodies; every /gate/ answer carries
 * `access-control-allow-origin: *`, and the product's POST has no body and no
 * custom header, so a browser sends it without a preflight):
 *
 *   POST /gate/<name>/pass?key=&side=&caller=&run=   the product's call (held or passed)
 *   POST /gate/<name>/hold     {key?, ttlMs?, armMs?}   arm it for that key (none: every key);
 *                                                     409 when that would overlap another arming
 *   GET  /gate/<name>/held?n=&timeoutMs=&key=&distinct=caller
 *                                                     wait until n are held (distinct: n callers,
 *                                                     each with its latest run held)
 *   POST /gate/<name>/release  {count?, disarm?, key?} let the first `count` go (key: that key's only)
 *   POST /gate/<name>/release-caller {caller?, key?, disarm?}
 *                                                     let ONE caller's held runs go, nobody else's
 *                                                     (no caller: the one whose latest run has been
 *                                                     held longest); stays armed unless disarm
 *   GET  /gates[?key=]                                counts of every gate (of that key)
 *   POST /gates/release-all                           let everything go, disarm all
 *
 * A held caller goes on by itself after `ttlMs` (GATE_HOLD_MAX_MS at most,
 * outcome "expired"), and an armed gate disarms itself after `armMs`
 * (GATE_ARM_MAX_MS at most): a spec that dies holding a gate never wedges
 * the stack for longer than that. A caller whose connection closes while
 * held is dropped ("aborted"). Release is FIFO and in one tick: every
 * response of a release is written before any other event is handled, which
 * is what "released together" means here.
 *
 * Arming is per (name, key): two cases on two documents hold the same gate
 * name without touching each other's callers (createGateService).
 *
 * THE CLIENT: `gates(target)` → {url, hold, waitHeld, release,
 * releaseCaller, counts, releaseAll}; a release with no key releases the
 * keys that client armed. `releaseCaller` lets one joiner go at a time (a
 * serial control at a client gate) by caller id, not by FIFO position.
 * `requireHeld(ctx, g, name, n)` turns a gate that never held its callers
 * into an INCONCLUSIVE case: a failed sync precondition is never a FAIL. At a
 * client gate it counts distinct callers (gateSide). `holdCalls(ctx, g, …)`
 * is a whole gated race at a SERVER gate: arm, send, every call held, none
 * answered, the racing action, one release of exactly those calls, and the
 * release again in a `finally`, with the INCONCLUSIVE rules in one place.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { PATCHES_DIR } from "./paths.mjs";

/** The functions' env var a patched server pause point reads (written to functions/.env.local of a gated stack only). */
export const GATE_ENV = "E2E_GATE_URL";
/** The app build variable a patched client gate reads (in the app's build env of a gated stack only). */
export const VITE_GATE_ENV = "VITE_E2E_GATE_URL";
/** The prefix of an amplify set's directory under e2e/patches/. */
export const AMPLIFY_PREFIX = "amplify-";
/** The metadata file of an amplify set (the control.json of an amplify). */
export const AMPLIFY_FILE = "amplify.json";
/** A gate's name: what the product passes as the first argument of e2eGate. */
export const GATE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The longest a held caller waits for a release before it goes on by itself. */
export const GATE_HOLD_MAX_MS = 120_000;
/** The longest a gate stays armed before it disarms itself. */
export const GATE_ARM_MAX_MS = 15 * 60_000;
/** The default wait for waitHeld. */
export const GATE_WAIT_MS = 30_000;
/** A gate's sides, as amplify.json names them. */
export const GATE_SIDES = Object.freeze(["server", "client"]);

const KEY_MAX = 200;
const BODY_MAX = 64 * 1024;

// --- the service -----------------------------------------------------------

function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("cache-control", "no-store");
}

function send(res, status, body) {
  if (res.writableEnded || res.destroyed) return false;
  cors(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {});
      } catch {
        reject(Object.assign(new Error("body is not JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function boundedMs(value, max, fallback, what) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw Object.assign(new Error(`${what} is a positive number of ms`), { status: 400 });
  return Math.min(n, max);
}

/**
 * The gate state machine with an HTTP handler, no server of its own (the aux
 * process and the self-test mount it). `log(event)` gets one object per
 * arming, hold, release, expiry and abort.
 *
 * ARMING is per (name, key): `hold` with a key arms that key alone, and a
 * second document's arming of the same name leaves the first armed (two cases
 * at once never clobber each other's gate). A key of null arms EVERY key; it
 * would take another key's callers, so an every-key arming while a key is
 * armed, or a key's arming while every key is, is answered 409 (release the
 * other first). Arming the same key again refreshes it.
 *
 * CALLERS. A patched helper names its caller (`caller`, `run`): the client
 * helper one id per page and a run number per call, the server helper one id
 * per request. A caller's LATEST run is the one with the highest run number
 * it has called with (whatever its outcome); `held?distinct=caller` counts
 * the callers whose latest run is held, so one joiner held twice (its
 * effect ran again while its first call was held) is one caller, and a
 * caller whose newest call went on is not counted for an older one still
 * held. A call that names no caller is never a distinct caller.
 *
 * @returns {{handle(req, res): boolean, counts(key?): object, releaseAll(): number, close(): void}}
 */
export function createGateService({ log = () => {}, now = () => Date.now() } = {}) {
  const gates = new Map();
  let seq = 0;
  const counters = () => ({ arrived: 0, passed: 0, released: 0, expired: 0, aborted: 0 });
  const gate = (name) => {
    let g = gates.get(name);
    if (!g) {
      g = { armings: new Map(), held: [], waiters: [], latest: new Map(), ...counters(), byKey: new Map(), lastRelease: null, lastReleaseByKey: new Map() };
      gates.set(name, g);
    }
    return g;
  };
  const count = (g, key, what) => {
    g[what] += 1;
    let c = g.byKey.get(key);
    if (!c) g.byKey.set(key, (c = counters()));
    c[what] += 1;
  };
  /** The live armings of `g` (key|null → arming), the ones whose armMs ran out dropped. */
  const armingsNow = (g) => {
    for (const [key, a] of g.armings) {
      if (a.until <= now()) {
        log({ event: "disarmed", why: "armMs ran out", key });
        g.armings.delete(key);
      }
    }
    return g.armings;
  };
  /** The arming a caller with `key` meets: its key's, or the every-key one; null when none. */
  const armingFor = (g, key) => {
    const as = armingsNow(g);
    return (key != null ? as.get(key) : undefined) ?? as.get(null) ?? null;
  };
  const heldFor = (g, key) => (key == null ? g.held : g.held.filter((c) => c.key === key));
  const isLatest = (g, c) => c.caller != null && g.latest.get(c.caller)?.seq === c.seq;
  const view = (g, c) => ({ seq: c.seq, key: c.key, side: c.side, caller: c.caller, run: c.run, at: c.at, latest: isLatest(g, c) });
  /** What a waiter counts: every held call, or (distinct "caller") the callers whose latest run is held. */
  const measure = (g, key, distinct) => {
    const held = heldFor(g, key);
    const out = { held: held.length, entries: held.length, distinct: distinct ?? null, callers: held.map((c) => view(g, c)) };
    if (distinct === "caller") {
      out.distinctCallers = [...new Set(held.filter((c) => isLatest(g, c)).map((c) => c.caller))];
      out.held = out.distinctCallers.length;
    }
    return out;
  };
  const finish = (name, g, c, outcome, at = now()) => {
    clearTimeout(c.timer);
    const i = g.held.indexOf(c);
    if (i >= 0) g.held.splice(i, 1);
    if (outcome === "released" || outcome === "expired" || outcome === "aborted") count(g, c.key, outcome);
    log({ event: outcome, name, key: c.key, side: c.side, caller: c.caller, run: c.run, seq: c.seq, heldMs: at - c.at });
    if (outcome !== "aborted") send(c.res, 200, { name, key: c.key, side: c.side, caller: c.caller, run: c.run, seq: c.seq, outcome, heldMs: at - c.at, releasedAt: at });
  };
  const notify = (g) => {
    for (const w of [...g.waiters]) {
      const m = measure(g, w.key, w.distinct);
      if (m.held >= w.n) {
        clearTimeout(w.timer);
        g.waiters.splice(g.waiters.indexOf(w), 1);
        send(w.res, 200, { ok: true, ...m });
      }
    }
  };
  /** {name: {armed, key, held, arrived, passed, released, expired, aborted, lastRelease}}: every key's, or (with `key`) that key's alone. */
  const snapshot = (key = null) => {
    const out = {};
    for (const [name, g] of gates) {
      const as = armingsNow(g);
      if (key == null) {
        // `key`: the armed key when exactly one is armed (null: every key, or several: ask per key).
        out[name] = { armed: as.size > 0, key: as.size === 1 ? [...as.keys()][0] : null, held: g.held.length, arrived: g.arrived, passed: g.passed, released: g.released, expired: g.expired, aborted: g.aborted, lastRelease: g.lastRelease };
      } else {
        const c = g.byKey.get(key) ?? counters();
        out[name] = { armed: Boolean(armingFor(g, key)), key, held: heldFor(g, key).length, ...c, lastRelease: g.lastReleaseByKey.get(key) ?? null };
      }
    }
    return out;
  };
  const releaseAll = () => {
    let n = 0;
    for (const [name, g] of gates) {
      const at = now();
      // finish() takes each out of g.held; the copy keeps the loop steady.
      for (const c of [...g.held]) {
        finish(name, g, c, "released", at);
        n += 1;
      }
      g.armings.clear();
    }
    return n;
  };

  const route = async (req, res) => {
    const url = new URL(req.url, "http://gate.invalid");
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "OPTIONS" && parts[0] === "gate") {
      cors(res);
      res.statusCode = 204;
      res.end();
      return;
    }
    if (parts[0] === "gates" && parts.length === 1 && req.method === "GET") return send(res, 200, { ok: true, gates: snapshot(url.searchParams.get("key")) });
    if (parts[0] === "gates" && parts[1] === "release-all" && req.method === "POST") {
      await readBody(req);
      return send(res, 200, { ok: true, released: releaseAll() });
    }
    if (parts[0] !== "gate" || parts.length !== 3) return send(res, 404, { error: "no such gate route" });
    const name = decodeURIComponent(parts[1]);
    if (!GATE_NAME_RE.test(name)) return send(res, 400, { error: `not a gate name: ${JSON.stringify(name)}` });
    const op = parts[2];
    const g = gate(name);
    if (op === "pass" && req.method === "POST") {
      await readBody(req);
      const key = url.searchParams.get("key");
      const side = url.searchParams.get("side") ?? "unknown";
      const caller = url.searchParams.get("caller");
      const runText = url.searchParams.get("run");
      if (key != null && key.length > KEY_MAX) return send(res, 400, { error: "key too long" });
      if (caller != null && (caller.length === 0 || caller.length > KEY_MAX)) return send(res, 400, { error: "caller is 1 to 200 characters" });
      const run = runText == null ? null : Number(runText);
      if (run !== null && !(Number.isInteger(run) && run >= 1)) return send(res, 400, { error: "run is a whole number from 1" });
      const s = ++seq;
      count(g, key, "arrived");
      if (caller != null) {
        const prev = g.latest.get(caller);
        if (!prev || run === null || prev.run === null || run >= prev.run) g.latest.set(caller, { run, seq: s });
      }
      const armed = armingFor(g, key);
      if (!armed) {
        count(g, key, "passed");
        return send(res, 200, { name, key, side, caller, run, seq: s, outcome: "passed", heldMs: 0 });
      }
      const c = { seq: s, key, side, caller, run, at: now(), res, timer: null };
      c.timer = setTimeout(() => finish(name, g, c, "expired"), armed.ttlMs);
      res.on("close", () => {
        if (!res.writableFinished && g.held.includes(c)) finish(name, g, c, "aborted");
      });
      g.held.push(c);
      log({ event: "held", name, key, side, caller, run, seq: c.seq });
      notify(g);
      return;
    }
    if (op === "hold" && req.method === "POST") {
      const body = await readBody(req);
      const key = body.key == null ? null : String(body.key);
      if (key != null && key.length > KEY_MAX) return send(res, 400, { error: "key too long" });
      const ttlMs = boundedMs(body.ttlMs, GATE_HOLD_MAX_MS, 90_000, "ttlMs");
      const armMs = boundedMs(body.armMs, GATE_ARM_MAX_MS, 10 * 60_000, "armMs");
      const overlap = [...armingsNow(g).keys()].find((k) => (key === null ? k !== null : k === null));
      if (overlap !== undefined) {
        log({ event: "arming-refused", name, key, armed: overlap });
        return send(res, 409, {
          error: key === null
            ? `gate ${name} is armed for key ${JSON.stringify(overlap)}: an arming for every key would take its callers too (release it first)`
            : `gate ${name} is armed for every key: an arming for key ${JSON.stringify(key)} would overlap it (release it first)`,
        });
      }
      g.armings.set(key, { key, ttlMs, at: now(), until: now() + armMs });
      log({ event: "armed", name, key, ttlMs, armMs });
      return send(res, 200, { ok: true, name, armed: true, key, ttlMs, armMs });
    }
    if (op === "held" && req.method === "GET") {
      const n = Number(url.searchParams.get("n") ?? 1);
      const timeoutMs = boundedMs(url.searchParams.get("timeoutMs") ?? undefined, GATE_HOLD_MAX_MS, GATE_WAIT_MS, "timeoutMs");
      const key = url.searchParams.get("key");
      const distinct = url.searchParams.get("distinct");
      if (!Number.isInteger(n) || n < 0) return send(res, 400, { error: "n is a whole number" });
      if (distinct != null && distinct !== "caller") return send(res, 400, { error: `distinct is "caller", got ${JSON.stringify(distinct)}` });
      const w = { n, key, distinct, res, timer: null };
      w.timer = setTimeout(() => {
        const i = g.waiters.indexOf(w);
        if (i >= 0) g.waiters.splice(i, 1);
        send(res, 200, { ok: false, ...measure(g, key, distinct) });
      }, timeoutMs);
      res.on("close", () => {
        const i = g.waiters.indexOf(w);
        if (i >= 0) {
          clearTimeout(w.timer);
          g.waiters.splice(i, 1);
        }
      });
      g.waiters.push(w);
      notify(g);
      return;
    }
    if (op === "release" && req.method === "POST") {
      const body = await readBody(req);
      // With a key: that key's held callers and arming only. Without: every key's (as before).
      const key = body.key == null ? null : String(body.key);
      const pool = heldFor(g, key);
      const all = body.count === undefined || body.count === null;
      const n = all ? pool.length : Number(body.count);
      if (!Number.isInteger(n) || n < 0) return send(res, 400, { error: "count is a whole number" });
      const disarm = body.disarm === undefined ? all : body.disarm === true;
      const at = now();
      // Every response of the batch is written in this one synchronous loop.
      const batch = pool.slice(0, n);
      const released = batch.map((c) => ({ ...view(g, c), heldMs: at - c.at }));
      for (const c of batch) finish(name, g, c, "released", at);
      if (disarm) {
        if (key == null) g.armings.clear();
        else g.armings.delete(key);
        log({ event: "disarmed", why: "released", name, key });
      }
      g.lastRelease = { at, seqs: batch.map((c) => c.seq), key };
      for (const k of new Set([...(key != null ? [key] : []), ...batch.map((c) => c.key)])) g.lastReleaseByKey.set(k, { at, seqs: batch.filter((c) => c.key === k).map((c) => c.seq), key: k });
      const armed = key == null ? armingsNow(g).size > 0 : Boolean(armingFor(g, key));
      return send(res, 200, { ok: true, name, key, released, at, held: heldFor(g, key).length, armed });
    }
    if (op === "release-caller" && req.method === "POST") {
      // One caller's held runs (its latest and the superseded ones), in one tick, and nobody else's.
      const body = await readBody(req);
      const key = body.key == null ? null : String(body.key);
      if (body.caller != null && (typeof body.caller !== "string" || body.caller.length === 0 || body.caller.length > KEY_MAX)) return send(res, 400, { error: "caller is 1 to 200 characters" });
      if (body.disarm !== undefined && typeof body.disarm !== "boolean") return send(res, 400, { error: "disarm is true or false" });
      const pool = heldFor(g, key);
      // No caller named: the caller whose LATEST run has been held longest (held is FIFO).
      const chosen = body.caller ?? pool.find((c) => isLatest(g, c))?.caller ?? null;
      const at = now();
      const batch = chosen == null ? [] : pool.filter((c) => c.caller === chosen);
      const released = batch.map((c) => ({ ...view(g, c), heldMs: at - c.at }));
      for (const c of batch) finish(name, g, c, "released", at);
      if (body.disarm === true) {
        if (key == null) g.armings.clear();
        else g.armings.delete(key);
        log({ event: "disarmed", why: "released", name, key });
      }
      if (batch.length > 0) {
        g.lastRelease = { at, seqs: batch.map((c) => c.seq), key };
        for (const k of new Set([...(key != null ? [key] : []), ...batch.map((c) => c.key)])) g.lastReleaseByKey.set(k, { at, seqs: batch.filter((c) => c.key === k).map((c) => c.seq), key: k });
      }
      const armed = key == null ? armingsNow(g).size > 0 : Boolean(armingFor(g, key));
      return send(res, 200, { ok: true, name, key, caller: chosen, released, latest: released.some((r) => r.latest), at, held: heldFor(g, key).length, armed });
    }
    return send(res, 405, { error: `${req.method} ${op} is not a gate operation` });
  };

  return {
    /** Handle a request when it is a gate route; false when it is not one of ours. */
    handle(req, res) {
      const path = (req.url ?? "").split("?")[0];
      if (!/^\/gates?(\/|$)/.test(path)) return false;
      route(req, res).catch((err) => send(res, err.status ?? 500, { error: err.message }));
      return true;
    },
    counts: snapshot,
    releaseAll,
    close() {
      releaseAll();
      for (const g of gates.values()) for (const w of g.waiters) clearTimeout(w.timer);
    },
  };
}

/**
 * The gate service on its own server (the self-test's; the stack runs it in
 * the aux process). Resolves {url, port, service, close()}.
 */
export async function startGateServer({ port = 0, host = "127.0.0.1", log } = {}) {
  const service = createGateService({ log });
  const server = createServer((req, res) => {
    if (!service.handle(req, res)) send(res, 404, { error: "not a gate route" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const bound = server.address().port;
  return {
    url: `http://${host}:${bound}`,
    port: bound,
    service,
    close: () =>
      new Promise((resolve) => {
        service.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// --- the client --------------------------------------------------------------

function gateError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function checkName(name, who) {
  if (typeof name !== "string" || !GATE_NAME_RE.test(name)) throw new TypeError(`${who}: a gate name matches ${GATE_NAME_RE}, got ${JSON.stringify(name)}`);
}

/**
 * A client for the gate service at `url` (gates(target) is this with the
 * stack's port). Every call is a loopback request; a non-200 throws
 * E2E_GATE (with `status`, and the service's own error in the message).
 *
 * The client remembers the keys it armed: `release(name)` with no key
 * releases only those (each in turn), so two cases on two documents never
 * let each other's callers go. A client that armed `name` for every key, or
 * never armed it, releases every key, as before.
 */
export function gateClient(url, { fetchImpl = fetch } = {}) {
  const base = String(url).replace(/\/$/, "");
  /** name → the keys this client has armed it for (null: every key); never shrinks, so a late `finally` release stays on its own keys. */
  const mine = new Map();
  const call = async (method, path, body, { timeoutMs = 10_000 } = {}) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    } catch (err) {
      throw gateError("E2E_GATE", `gate service ${base}: ${method} ${path} failed: ${err.message}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (r.status !== 200) throw gateError("E2E_GATE", `gate service ${base}: ${method} ${path} answered ${r.status} ${typeof json?.error === "string" ? json.error : text.slice(0, 200)}`, { status: r.status });
    return json;
  };
  const releaseOne = (name, key, { count, disarm }) =>
    call("POST", `/gate/${encodeURIComponent(name)}/release`, { ...(count !== undefined ? { count } : {}), ...(disarm !== undefined ? { disarm } : {}), ...(key != null ? { key } : {}) });
  return {
    url: base,
    /**
     * Arm gate `name`: from now on its callers with `key` (or, with no key,
     * every caller) wait for a release. `ttlMs` bounds each hold (at most
     * GATE_HOLD_MAX_MS), `armMs` the arming (at most GATE_ARM_MAX_MS).
     * Another key's arming is left alone; an arming that would overlap one
     * (every key while a key is armed, or the reverse) throws E2E_GATE 409.
     */
    async hold(name, { key = null, ttlMs, armMs } = {}) {
      checkName(name, "hold");
      const r = await call("POST", `/gate/${encodeURIComponent(name)}/hold`, { key, ...(ttlMs ? { ttlMs } : {}), ...(armMs ? { armMs } : {}) });
      if (!mine.has(name)) mine.set(name, new Set());
      mine.get(name).add(key);
      return r;
    },
    /**
     * Wait until at least `n` callers are held at `name` (with `key`, when
     * given). `distinct: "caller"` counts CALLERS instead of calls: the
     * patched helpers' ids, each counted only while its latest run is held
     * (one joiner held twice is one). Resolves {held, callers: [{seq, key,
     * side, caller, run, at, latest}]} (+ {distinct, distinctCallers});
     * throws E2E_GATE_TIMEOUT (with `held`) when they never were: a sync
     * precondition that failed (see requireHeld).
     */
    async waitHeld(name, n, { timeoutMs = GATE_WAIT_MS, key = null, distinct = null } = {}) {
      checkName(name, "waitHeld");
      if (!Number.isInteger(n) || n < 0) throw new TypeError(`waitHeld: n is a whole number, got ${JSON.stringify(n)}`);
      if (distinct !== null && distinct !== "caller") throw new TypeError(`waitHeld: distinct is "caller" or null, got ${JSON.stringify(distinct)}`);
      const q = new URLSearchParams({ n: String(n), timeoutMs: String(timeoutMs), ...(key != null ? { key } : {}), ...(distinct ? { distinct } : {}) });
      const r = await call("GET", `/gate/${encodeURIComponent(name)}/held?${q}`, null, { timeoutMs: timeoutMs + 10_000 });
      if (distinct && r.distinct !== distinct) {
        throw gateError("E2E_GATE", `gate service ${base} does not tell callers apart (its aux process predates caller identity): stop the stack and start it again`);
      }
      const what = distinct ? "distinct caller(s)" : "caller(s)";
      if (!r.ok) throw gateError("E2E_GATE_TIMEOUT", `gate ${name}: ${r.held} of ${n} ${what} held within ${timeoutMs} ms`, { held: r.held, callers: r.callers, distinct, distinctCallers: r.distinctCallers });
      return { held: r.held, callers: r.callers, ...(distinct ? { distinct, distinctCallers: r.distinctCallers } : {}) };
    },
    /**
     * Let the first `count` held callers go (all of them by default), in one
     * tick. Releasing all disarms the gate unless `disarm: false`; a partial
     * release keeps it armed unless `disarm: true`. `key`: only that key's
     * callers and arming (null: every key's). With no `key`, the keys this
     * client armed (`count` applies to each), or every key when it armed
     * every key or never armed `name`. Resolves {released: [{seq, key, side,
     * caller, run, heldMs}], at, held, armed} (+ `keys` when it released
     * more than one key in turn).
     */
    async release(name, { count, disarm, key } = {}) {
      checkName(name, "release");
      if (key !== undefined) return releaseOne(name, key, { count, disarm });
      const armed = mine.get(name);
      if (!armed || armed.has(null)) return releaseOne(name, null, { count, disarm });
      const results = [];
      for (const k of armed) results.push([k, await releaseOne(name, k, { count, disarm })]);
      if (results.length === 1) return results[0][1];
      return {
        ok: true,
        name,
        keys: results.map(([k]) => k),
        released: results.flatMap(([, r]) => r.released),
        at: Math.max(...results.map(([, r]) => r.at)),
        held: results.reduce((sum, [, r]) => sum + r.held, 0),
        armed: results.some(([, r]) => r.armed),
      };
    },
    /**
     * Let ONE caller go: every held run of `caller` (its latest and the
     * superseded runs before it), in one tick, and nobody else's. With no
     * `caller`, the NEXT one: the caller whose latest run has been held
     * longest (FIFO among latest runs; a superseded run of another caller
     * ahead of it stays held until that caller is let go). This is the
     * serial release at a client gate, where `release(name, {count})` would
     * count FIFO positions across callers.
     *
     * The gate stays armed unless `disarm: true`. `key`: that key's callers
     * only; omitted, the one key this client armed `name` for (it armed
     * several: a TypeError, name one), else every key. Resolves {caller
     * (null when no caller's latest run was held, and then nothing was
     * released), released: [{seq, key, side, caller, run, at, latest,
     * heldMs}] (FIFO), latest (whether the caller's latest run was among
     * them), at, held, armed}. A gate service older than this method
     * answers 405, which throws E2E_GATE (restart the stack): it never
     * falls back to a FIFO release.
     */
    async releaseCaller(name, { key, caller = null, disarm } = {}) {
      checkName(name, "releaseCaller");
      if (caller !== null && (typeof caller !== "string" || caller.length === 0 || caller.length > KEY_MAX)) throw new TypeError(`releaseCaller: caller is a caller id (1 to ${KEY_MAX} characters) or null, got ${JSON.stringify(caller)}`);
      if (disarm !== undefined && typeof disarm !== "boolean") throw new TypeError(`releaseCaller: disarm is true or false, got ${JSON.stringify(disarm)}`);
      let k = key;
      if (k === undefined) {
        const armed = [...(mine.get(name) ?? [])];
        if (armed.length > 1) throw new TypeError(`releaseCaller: this client armed ${name} for ${armed.length} keys; name the key`);
        k = armed.length === 1 ? armed[0] : null;
      }
      try {
        return await call("POST", `/gate/${encodeURIComponent(name)}/release-caller`, { ...(caller !== null ? { caller } : {}), ...(k != null ? { key: k } : {}), ...(disarm !== undefined ? { disarm } : {}) });
      } catch (err) {
        if (err?.status === 405) throw gateError("E2E_GATE", `gate service ${base} cannot release one caller (its aux process predates release-caller): stop the stack and start it again`, { status: 405, cause: err });
        throw err;
      }
    },
    /**
     * {name: {armed, key, held, arrived, passed, released, expired, aborted,
     * lastRelease}} for every gate seen: every key's counts, or with `key`
     * that key's alone (`armed`: whether a caller with that key would be
     * held). Without a key, `key` is the armed key when exactly one is.
     */
    async counts({ key = null } = {}) {
      return (await call("GET", `/gates${key != null ? `?${new URLSearchParams({ key })}` : ""}`)).gates;
    },
    /** Release everything held and disarm every gate, whoever armed it (for a stack's last `finally`). Resolves how many were released. */
    async releaseAll() {
      return (await call("POST", "/gates/release-all", {})).released;
    },
  };
}

/** The stack port of a target's gate service, or null (a stack built without gates). */
export function gatePort(target) {
  const p = target?.stack?.ports?.gate;
  return Number.isInteger(p) && p > 0 ? p : null;
}

/** The URL a gated stack's product calls: http://127.0.0.1:<gate>. */
export function gateUrl(target) {
  const p = gatePort(target);
  if (!p) throw gateError("E2E_CAPABILITY", `stack ${target?.runId ?? "?"} has no gate service (build it with --gates or an amplify-* set)`);
  return `http://127.0.0.1:${p}`;
}

/** The gate client of a target's stack (capability `gates`). */
export function gates(target, o = {}) {
  if (target?.kind !== "local") throw gateError("E2E_CAPABILITY", "gates exist only on a local stack");
  if (!target.capabilities?.has?.("gates")) throw gateError("E2E_CAPABILITY", `stack ${target.runId} lacks the gates capability`);
  return gateClient(gateUrl(target), o);
}

const sides = new Map();
/** The side ("server" | "client") an amplify set under `root` gives gate `name`, or null when none names it. */
export function gateSide(name, root = PATCHES_DIR) {
  if (!sides.has(root)) {
    const m = new Map();
    for (const set of listAmplifySets(root)) for (const g of readAmplify(set, root).gates) m.set(g.name, g.side);
    sides.set(root, m);
  }
  return sides.get(root).get(name) ?? null;
}

/**
 * waitHeld, and a gate that never held its `n` callers ends the case
 * INCONCLUSIVE (a sync precondition, never a FAIL): `ctx.inconclusive`.
 * At a CLIENT gate (amplify.json side "client") it waits for `n` distinct
 * callers, each with its latest run held, unless `opts.distinct` says
 * otherwise: every run of a hook's effect calls the gate, so one joiner can
 * be held twice, and "both joiners held" must mean two joiners.
 */
export async function requireHeld(ctx, g, name, n, opts = {}) {
  const o = { ...opts };
  if (o.distinct === undefined && gateSide(name) === "client") o.distinct = "caller";
  try {
    return await g.waitHeld(name, n, o);
  } catch (err) {
    if (err?.code === "E2E_GATE_TIMEOUT") ctx.inconclusive(`the sync precondition did not hold: ${err.message}`);
    throw err;
  }
}

/** holdCalls' default wait for every call to be held (the gated races all used 90 s; the service caps a wait at GATE_HOLD_MAX_MS). */
export const HOLD_CALLS_WAIT_MS = 90_000;
/** holdCalls' pause once every call is held, before it checks that none answered: an answer already on its way gets there. */
export const HOLD_CALLS_GRACE_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A gated race at a SERVER gate (SYNC-P), its INCONCLUSIVE rules in one
 * place:
 *
 *   1. arm `gate` for `key` (that key alone: other documents' callers are
 *      never touched; `ttlMs` bounds each hold, as hold() takes it);
 *   2. `send()` → the calls, an array of promises (each call already sent:
 *      `() => agents.map((a) => a.mcp.call(…))`);
 *   3. wait until all of them are held at `gate` for `key` (`timeoutMs`);
 *      when they never are, the case is INCONCLUSIVE, naming the calls that
 *      had already answered (they never reached the gate);
 *   4. after `graceMs`, INCONCLUSIVE if any call has answered: it was not
 *      held, so this is not the race meant;
 *   5. `whileHeld({held})` runs (the action the held calls race: a commit, a
 *      publish), and its value is `during`; INCONCLUSIVE if any call
 *      answered meanwhile (a hold that expired, a caller that hung up);
 *   6. ONE release of `gate` for `key`, in one tick; INCONCLUSIVE unless it
 *      let exactly the calls go (more: another caller of the key was held
 *      too, and joined the race);
 *   7. every call's answer, in order. A call that REJECTED is thrown after
 *      all have settled, unchanged (the first in call order), so a Hosting
 *      cut-off or an MCP transport error keeps its shape for the case's
 *      judges.
 *
 * Whatever happens (an INCONCLUSIVE, a whileHeld that throws, a bad send),
 * `gate` is released for `key` in a `finally`. Every call gets its handlers
 * at once, so one left behind by an INCONCLUSIVE never rejects unhandled.
 * `ctx.step` hears when all are held and when the release let them go.
 *
 * Resolves {answers (each call's value, in order), during, held (waitHeld's
 * {held, callers}), release (the release's {released, at, held, armed})}.
 *
 * A CLIENT gate (amplify.json side "client") is a TypeError: a page's join
 * calls its gate once per run of its effect, so the release count is not
 * the number of joiners (use requireJoinersHeld, lib/live.mjs). TypeError,
 * before anything is armed, for a ctx without inconclusive(), a client `g`
 * without hold/waitHeld/release, a bad gate name, a key that is not a
 * string of 1–200 characters, a `send` or `whileHeld` that is not a
 * function, a timeoutMs that is not a positive number, a graceMs that is
 * not 0 or more, a ttlMs that is not positive; and (after the gate is armed
 * and released again) a `send()` that does not return a non-empty array of
 * promises.
 *
 * @param {{inconclusive(reason: string): never, step?: (line: string) => void}} ctx
 * @param {ReturnType<typeof gateClient>} g
 * @param {{gate: string, key: string, send: () => Promise<any>[], whileHeld?: ((arg: {held: object}) => any) | null, timeoutMs?: number, graceMs?: number, ttlMs?: number}} o
 * @returns {Promise<{answers: any[], during: any, held: {held: number, callers: object[]}, release: object}>}
 */
export async function holdCalls(ctx, g, { gate, key, send, whileHeld = null, timeoutMs = HOLD_CALLS_WAIT_MS, graceMs = HOLD_CALLS_GRACE_MS, ttlMs } = {}) {
  if (!ctx || typeof ctx.inconclusive !== "function") throw new TypeError("holdCalls: ctx is a case's ctx (it needs inconclusive())");
  if (!g || typeof g.hold !== "function" || typeof g.waitHeld !== "function" || typeof g.release !== "function") throw new TypeError("holdCalls: g is a gate client (gates(target))");
  checkName(gate, "holdCalls");
  if (typeof key !== "string" || key.length === 0 || key.length > KEY_MAX) throw new TypeError(`holdCalls: key is the race's own key (its document id), 1 to ${KEY_MAX} characters, got ${JSON.stringify(key) ?? String(key)}: arming every key would hold other cases' callers`);
  if (typeof send !== "function") throw new TypeError("holdCalls: send is a function that sends the calls and returns their promises");
  if (whileHeld !== null && typeof whileHeld !== "function") throw new TypeError("holdCalls: whileHeld is a function or null");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError(`holdCalls: timeoutMs is a positive number of ms, got ${JSON.stringify(timeoutMs) ?? String(timeoutMs)}`);
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new TypeError(`holdCalls: graceMs is a number of ms, 0 or more, got ${JSON.stringify(graceMs) ?? String(graceMs)}`);
  if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) throw new TypeError(`holdCalls: ttlMs is a positive number of ms, got ${JSON.stringify(ttlMs) ?? String(ttlMs)}`);
  if (gateSide(gate) === "client") throw new TypeError(`holdCalls: ${gate} is a client gate; a page calls it once per run of its effect, so its releases do not count joiners (use requireJoinersHeld, lib/live.mjs)`);
  const step = typeof ctx.step === "function" ? (line) => ctx.step(line) : () => {};
  await g.hold(gate, { key, ...(ttlMs !== undefined ? { ttlMs } : {}) });
  try {
    const calls = send();
    const list = Array.isArray(calls) ? calls : [];
    const answered = [];
    const outcomes = list.map((p, i) =>
      Promise.resolve(p).then(
        (value) => (answered.push(i), { ok: true, value }),
        (error) => (answered.push(i), { ok: false, error }),
      ),
    );
    if (!Array.isArray(calls) || list.length === 0 || list.some((p) => !p || typeof p.then !== "function")) {
      throw new TypeError(`holdCalls: send() returns a non-empty array of promises (the calls, already sent), got ${Array.isArray(calls) ? `an array of ${list.length}` : typeof calls}`);
    }
    const n = list.length;
    const which = () => [...answered].sort((a, b) => a - b).map((i) => `#${i + 1}`).join(", ");
    let held;
    try {
      held = await g.waitHeld(gate, n, { key, timeoutMs });
    } catch (err) {
      if (err?.code !== "E2E_GATE_TIMEOUT") throw err;
      const early = answered.length ? `; ${answered.length} of the ${n} call(s) (${which()}) had already answered, so they never waited at ${gate}` : "";
      ctx.inconclusive(`the sync precondition did not hold: ${err.message}${early}`);
    }
    step(`all ${n} call(s) are held at ${gate} for ${key} (seq ${held.callers.map((c) => c.seq).join(", ")})`);
    if (graceMs > 0) await sleep(graceMs);
    if (answered.length) ctx.inconclusive(`the sync precondition did not hold: ${answered.length} of ${n} call(s) (${which()}) answered while ${gate} should have held them`);
    const during = whileHeld ? await whileHeld({ held }) : null;
    if (answered.length) ctx.inconclusive(`the sync precondition did not hold: ${answered.length} of ${n} held call(s) (${which()}) answered before the release, while ${gate} should still have held them`);
    const release = await g.release(gate, { key });
    if (release.released.length !== n) ctx.inconclusive(`the sync precondition did not hold: the release of ${gate} for ${key} let ${release.released.length} held call(s) go, not the ${n} sent`);
    step(`one release of ${gate} let all ${n} go together`);
    const settled = await Promise.all(outcomes);
    const failed = settled.find((o) => !o.ok);
    if (failed) throw failed.error;
    return { answers: settled.map((o) => o.value), during, held, release };
  } finally {
    await g.release(gate, { key }).catch(() => undefined);
  }
}

// --- amplify sets --------------------------------------------------------------

/** Is `set` an amplify set's name (amplify-<name>)? The bare `amplify` directory is not one. */
export function isAmplifySet(set) {
  return typeof set === "string" && set.startsWith(AMPLIFY_PREFIX) && /^[a-z0-9][a-z0-9-]*$/.test(set);
}

/** Every amplify set under e2e/patches, sorted. */
export function listAmplifySets(root = PATCHES_DIR) {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => isAmplifySet(n) && statSync(join(root, n)).isDirectory()).sort();
}

/**
 * Read and check an amplify set's amplify.json:
 *   {"what": "...", "gates": [{"name", "side": "server"|"client", "where", "key"}]}
 * @returns {{set, dir, what, gates: {name, side, where, key}[], patches: string[]}}
 */
export function readAmplify(set, root = PATCHES_DIR) {
  if (!isAmplifySet(set)) throw new Error(`${set} is not an amplify set (${AMPLIFY_PREFIX}<name>)`);
  const dir = join(root, set);
  const file = join(dir, AMPLIFY_FILE);
  if (!existsSync(file)) throw new Error(`${set}: no ${AMPLIFY_FILE}`);
  const a = JSON.parse(readFileSync(file, "utf8"));
  if (typeof a.what !== "string" || !a.what.trim()) throw new Error(`${set}: ${AMPLIFY_FILE} needs "what"`);
  if (!Array.isArray(a.gates) || a.gates.length === 0) throw new Error(`${set}: ${AMPLIFY_FILE} needs a non-empty "gates" list`);
  const names = new Set();
  for (const g of a.gates) {
    if (!g || typeof g.name !== "string" || !GATE_NAME_RE.test(g.name)) throw new Error(`${set}: a gate name matches ${GATE_NAME_RE}, got ${JSON.stringify(g?.name)}`);
    if (names.has(g.name)) throw new Error(`${set}: gate ${g.name} is listed twice`);
    names.add(g.name);
    if (!GATE_SIDES.includes(g.side)) throw new Error(`${set}: gate ${g.name} side is ${GATE_SIDES.join(" or ")}`);
    if (typeof g.where !== "string" || !g.where.trim()) throw new Error(`${set}: gate ${g.name} needs "where"`);
  }
  const patches = readdirSync(dir).filter((n) => n.endsWith(".patch")).sort();
  if (patches.length === 0) throw new Error(`${set}: no *.patch files`);
  return { set, dir, what: a.what, gates: a.gates.map((g) => ({ name: g.name, side: g.side, where: g.where, key: g.key ?? null })), patches };
}

/** Whether any of these patch sets is an amplify set with a client gate (the app bundle must then carry the gate URL). */
export function amplifyClientGates(sets, root = PATCHES_DIR) {
  return (sets ?? []).filter(isAmplifySet).flatMap((s) => readAmplify(s, root).gates.filter((g) => g.side === "client").map((g) => ({ set: s, ...g })));
}
