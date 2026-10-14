// SPDX-License-Identifier: Apache-2.0
// Synchronisation barriers for race scenarios: SYNC-T (time; for HTTP, checked, guarded and traced against a target), SYNC-H (held requests), the overlap proof and the Firestore listen gate (SPEC §12).

/**
 * A race test proves nothing unless the racers actually overlapped, so every
 * barrier here RECORDS what happened instead of assuming it:
 *
 *   SYNC-T, Node — N worker_threads each prepare (open a socket), then block
 *     in Atomics.wait on one SharedArrayBuffer word; the main thread flips it
 *     and notifies all at once. Each records its own fire time.
 *   SYNC-T, pages — each page gets a setTimeout to t0 − 3 ms, then busy-waits
 *     to t0 on its own high-resolution clock, then acts; each reports when it
 *     fired.
 *   SYNC-H — route N matching requests, hold them until all N are held, then
 *     continue all of them in one synchronous loop.
 *
 * The spread (latest fire − earliest) decides whether a run is conclusive:
 * over 15 ms for HTTP, or 40 ms in a browser, and the scenario is
 * INCONCLUSIVE, never PASS or FAIL. The overlap proof, max(send) <
 * min(firstByte), says every request was on the wire before any answer began —
 * the only state in which a server-side race can happen at all.
 *
 * Both ends of the proof come from ONE clock that saw the wire: the Node
 * actor's own socket events, or the browser's network timing (requestStart,
 * responseStart). Never the moment this process asked for a send — a request
 * the browser queued behind a busy socket goes out long after route.continue()
 * returned. A record missing either end makes the proof {ok:false, reason:
 * "unmeasured"}; requireConclusive(ctx, …) turns any unproven overlap or wide
 * spread into ctx.inconclusive().
 *
 * GUARDED SYNC-T. syncHttp's worker threads send with Node's own http, so
 * nothing lib/http.mjs does for a request happens to theirs by itself. Given
 * `{target}`, syncHttp does it for them, BEFORE any worker exists: every
 * request and its warm-up passes http.mjs assertReachable (the isolation
 * tripwire), then the guard (guard.mjs createGuard(target).check, which on
 * production refuses anything that could send an email or touch a document
 * the run does not own); one refusal and nothing at all is sent. Each goes
 * with User-Agent and X-Bikeshed-Agent `bikeshed-e2e/<runId>` unless it names
 * its own, and each sent hop (warm-up included) becomes one redacted row in
 * the sink a createHttp client would write to (the running case's
 * http.jsonl, so ctx.requests()), listed by pendingRequests while in flight.
 * Without a target, a request or warm-up to anything but loopback is refused
 * (E2E_GUARD, rule "sync-unguarded"): nothing unguarded leaves the machine.
 *
 * THE LISTEN GATE. A race between the frame and a Firestore read (the version
 * record, the document's meta) is made deterministic from the client side,
 * with the product untouched: holdListen() delays the browser's own listen
 * requests that ask for that read, as a slow connection would. The web SDK
 * sends every listen request as a form-encoded POST on one WebChannel
 * (`count=…&ofs=…&req0___data__=<JSON>`), one POST at a time, so the gate
 * matches on the DECODED body: percent-encoded, `/docs/<id>/versions` is not
 * in it.
 */

import http from "node:http";
import https from "node:https";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

export const SPREAD_LIMIT_MS = Object.freeze({ http: 15, browser: 40 });

const hr = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * max(send) < min(firstByte) over records carrying {sentAt, firstByteAt}.
 * reason: null when ok; "no-overlap" when measured and something was sent
 * after an answer began; "unmeasured" when a record lacks either end.
 */
export function overlapProof(records) {
  const rows = records.filter(Boolean);
  const missing = rows.filter((r) => !Number.isFinite(r.sentAt) || !Number.isFinite(r.firstByteAt));
  if (rows.length === 0 || missing.length > 0) {
    return { ok: false, n: rows.length, reason: "unmeasured", detail: rows.length === 0 ? "no records" : `${missing.length} record(s) lack sentAt/firstByteAt` };
  }
  const maxSend = Math.max(...rows.map((r) => r.sentAt));
  const minFirstByte = Math.min(...rows.map((r) => r.firstByteAt));
  const ok = maxSend < minFirstByte;
  return { ok, n: rows.length, maxSend, minFirstByte, marginMs: minFirstByte - maxSend, reason: ok ? null : "no-overlap" };
}

/**
 * End a race case INCONCLUSIVE (ctx.inconclusive, which throws) unless the
 * racers fired within the spread limit and provably overlapped.
 */
export function requireConclusive(ctx, { spread = null, overlap = null } = {}) {
  if (spread && !spread.conclusive) ctx.inconclusive(`fire spread ${Number(spread.spreadMs).toFixed(1)} ms > ${spread.limit} ms`);
  if (overlap && !overlap.ok) {
    const margin = Number.isFinite(overlap.marginMs) ? ` (margin ${overlap.marginMs.toFixed(1)} ms)` : "";
    ctx.inconclusive(`overlap proof: ${overlap.reason}${overlap.detail ? ` — ${overlap.detail}` : ""}${margin}`);
  }
}

/** The spread of fire times and whether it keeps the run conclusive. */
export function spreadVerdict(fireTimes, kind = "http") {
  const ts = fireTimes.filter(Number.isFinite);
  const spreadMs = ts.length ? Math.max(...ts) - Math.min(...ts) : Infinity;
  const limit = SPREAD_LIMIT_MS[kind];
  return { spreadMs, limit, conclusive: spreadMs <= limit, verdict: spreadMs <= limit ? "CONCLUSIVE" : "INCONCLUSIVE" };
}

// --- SYNC-T, Node actors -------------------------------------------------

/**
 * Run `tasks` in worker threads released together. Each task is
 * `{module, fn, prepare?, arg}`: `module` a file URL, `fn` (and optionally
 * `prepare`) the names of exported functions. `prepare(arg)` runs BEFORE the
 * barrier and its result is passed to `fn(arg, state)` after it.
 * Resolves [{i, firedAt, doneAt, result?, error?, report?}] plus the spread
 * verdict: `report` is a prepare's own `state.e2eReport` (a cloneable value),
 * posted back after its fire. `onRelease(releasedAt)`, when given, is called
 * synchronously just before the barrier opens (its throw is ignored).
 */
export async function syncActors(tasks, { leadMs = 25, timeoutMs = 60_000, kind = "http", onRelease = null } = {}) {
  const n = tasks.length;
  const sab = new SharedArrayBuffer(8);
  const ctl = new Int32Array(sab); // [0] ready count, [1] gate
  const workers = tasks.map((task, i) => new Worker(new URL(import.meta.url), { workerData: { kind: "e2e-sync-actor", i, task, sab } }));
  const results = new Array(n);
  const done = workers.map(
    (w, i) =>
      new Promise((resolve) => {
        w.once("message", (m) => {
          results[i] = m;
          resolve();
        });
        w.once("error", (err) => {
          results[i] = { i, error: `worker error: ${err.message}` };
          resolve();
        });
        w.once("exit", (code) => {
          if (!results[i]) results[i] = { i, error: `worker exited ${code} before reporting` };
          resolve();
        });
      }),
  );
  const deadline = Date.now() + timeoutMs;
  while (Atomics.load(ctl, 0) < n) {
    if (Date.now() > deadline) {
      await Promise.all(workers.map((w) => w.terminate()));
      const err = new Error(`syncActors: only ${Atomics.load(ctl, 0)}/${n} actors became ready`);
      err.code = "E2E_SYNC_TIMEOUT";
      throw err;
    }
    await sleep(1);
  }
  await sleep(leadMs); // every worker is parked in Atomics.wait by now
  const releasedAt = hr();
  if (typeof onRelease === "function") {
    try {
      onRelease(releasedAt);
    } catch {}
  }
  Atomics.store(ctl, 1, 1);
  Atomics.notify(ctl, 1);
  const timer = setTimeout(() => workers.forEach((w) => w.terminate()), timeoutMs);
  await Promise.all(done);
  clearTimeout(timer);
  await Promise.all(workers.map((w) => w.terminate()));
  const spread = spreadVerdict(results.map((r) => r.firedAt), kind);
  return { releasedAt, results, ...spread };
}

async function actorMain() {
  const { i, task, sab } = workerData;
  const ctl = new Int32Array(sab);
  try {
    const mod = await import(task.module);
    const state = task.prepare ? await mod[task.prepare](task.arg) : undefined;
    Atomics.add(ctl, 0, 1);
    Atomics.wait(ctl, 1, 0);
    const firedAt = hr();
    let result;
    let error;
    try {
      result = await mod[task.fn](task.arg, state, { firedAt });
    } catch (err) {
      error = err.message;
    }
    const report = state && typeof state === "object" && state.e2eReport !== undefined ? { report: state.e2eReport } : {};
    parentPort.postMessage({ i, firedAt, doneAt: hr(), result, error, ...report });
  } catch (err) {
    Atomics.add(ctl, 0, 1); // never leave the barrier waiting on a broken actor
    parentPort.postMessage({ i, error: `prepare failed: ${err.message}` });
  }
}

// --- the HTTP actor --------------------------------------------------------

/**
 * Prepare: one keep-alive socket per actor, optionally opened by a warm-up
 * request (GET `arg.warm`, with `arg.warmHeaders`). With `arg.trace`, the
 * warm-up's answer goes back as the state's e2eReport ({warm}), for its row.
 */
export async function httpPrepare(arg) {
  const lib = arg.url.startsWith("https:") ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 1 });
  if (!arg.warm) return { lib, agent };
  const w = await httpOnce(lib, agent, { url: arg.warm, method: "GET", headers: arg.warmHeaders ?? {} });
  if (!arg.trace) return { lib, agent };
  return { lib, agent, e2eReport: { warm: { status: w.status, headers: w.headers, body: w.body, startAt: w.startAt, endAt: w.endAt } } };
}

/** Fire: send one request on the prepared socket and time send, first byte and end. */
export async function httpFire(arg, state) {
  const r = await httpOnce(state.lib, state.agent, arg);
  state.agent.destroy();
  return r;
}

/** A body as the bytes sent: a Buffer or Uint8Array as its bytes (a Buffer reaches a worker as a plain Uint8Array), a string as UTF-8, anything else as its JSON. */
function bodyBytes(body) {
  if (body == null) return null;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
}

function httpOnce(lib, agent, { url, method = "GET", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const startAt = hr();
    const payload = bodyBytes(body);
    const req = lib.request(url, { method, agent, headers: { ...headers, ...(payload ? { "content-length": payload.length } : {}) } });
    let sentAt = null;
    req.on("finish", () => {
      sentAt = hr();
    });
    req.on("response", (res) => {
      const firstByteAt = hr();
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          url,
          method,
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          startAt,
          sentAt,
          firstByteAt,
          endAt: hr(),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

// --- guarded SYNC-T: the isolation check, the guard and the trace -----------------

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const GUARDED_OPTIONS = Object.freeze(["guard", "evidence", "actor", "allowPorts"]);

/** The host of `url` when it parses and is not loopback; null for loopback or a string that is no URL (which cannot be sent anyway). */
function offMachineHost(url) {
  if (typeof url !== "string") return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return LOOPBACK_HOSTS.has(u.hostname) ? null : u.host;
}

function syncGuardError(message, rule, verdict = null) {
  const err = new Error(message);
  err.code = "E2E_GUARD";
  err.rule = rule;
  if (verdict) err.verdict = verdict;
  return err;
}

/** `headers` with User-Agent and X-Bikeshed-Agent added, unless it names its own (in any case). */
function withAgentHeaders(headers, agent) {
  const own = new Set(Object.keys(headers ?? {}).map((k) => k.toLowerCase()));
  const out = {};
  for (const k of ["user-agent", "x-bikeshed-agent"]) if (!own.has(k)) out[k] = agent;
  return { ...out, ...(headers ?? {}) };
}

function headerValue(headers, name) {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return String(v);
  return "";
}

function isoAt(ms) {
  return new Date(Math.round(Number.isFinite(ms) ? ms : Date.now())).toISOString();
}

function checkGuardedOptions(opts) {
  const { target, guard = true, evidence, actor = "sync", allowPorts = [] } = opts;
  if (target === null || typeof target !== "object" || typeof target.kind !== "string" || typeof target.runId !== "string" || typeof target.origin !== "string") {
    throw new TypeError(`syncHttp: target is a loadTarget() target ({kind, runId, origin, …}), got ${JSON.stringify(target) ?? String(target)}`);
  }
  if (guard !== true && !(guard && typeof guard === "object" && typeof guard.check === "function")) {
    throw new TypeError(`syncHttp: guard is true (createGuard(target)) or a {check(req)} guard; it cannot be turned off for a target, got ${JSON.stringify(guard) ?? String(guard)}`);
  }
  if (evidence !== undefined && evidence !== false && typeof evidence !== "function" && typeof evidence !== "string") {
    throw new TypeError(`syncHttp: evidence is a sink function, a directory, false or undefined (the running case's), got ${JSON.stringify(evidence) ?? String(evidence)}`);
  }
  if (typeof actor !== "string" || !actor) throw new TypeError(`syncHttp: actor is a non-empty label for the trace, got ${JSON.stringify(actor) ?? String(actor)}`);
  if (!Array.isArray(allowPorts) || !allowPorts.every((p) => Number.isInteger(p) && p > 0 && p < 65536)) {
    throw new TypeError(`syncHttp: allowPorts is a list of ports, got ${JSON.stringify(allowPorts) ?? String(allowPorts)}`);
  }
  return { target, guard, evidence, actor, allowPorts };
}

/**
 * The guarded path of syncHttp: every hop checked and asked BEFORE any worker
 * exists, agent headers added, each sent hop traced into the sink, the fired
 * requests listed as pending while in flight.
 */
async function guardedSyncHttp(requests, opts, actorOpts) {
  const { target, guard, evidence, actor, allowPorts } = checkGuardedOptions(opts);
  const h = await import("./http.mjs");
  const g = guard === true ? (await import("./guard.mjs")).createGuard(target) : guard;
  const sink = h.evidenceSink(target, evidence);
  const agent = h.agentName(target);
  const startedAt = Date.now();
  const plan = requests.map((r, i) => {
    if (!r || typeof r !== "object" || typeof r.url !== "string" || !r.url) throw new TypeError(`syncHttp: request ${i} is {url, method, headers, body, warm?, actor?}, got ${JSON.stringify(r) ?? String(r)}`);
    if (r.warm != null && (typeof r.warm !== "string" || !r.warm)) throw new TypeError(`syncHttp: request ${i}'s warm is a URL string, got ${JSON.stringify(r.warm)}`);
    if (r.actor != null && (typeof r.actor !== "string" || !r.actor)) throw new TypeError(`syncHttp: request ${i}'s actor is a non-empty string, got ${JSON.stringify(r.actor)}`);
    const arg = { url: r.url, method: String(r.method ?? "GET").toUpperCase(), headers: withAgentHeaders(r.headers, agent), body: r.body ?? null, trace: true };
    if (r.warm) {
      arg.warm = r.warm;
      arg.warmHeaders = withAgentHeaders({}, agent);
    }
    const hops = [
      ...(arg.warm ? [{ warm: true, method: "GET", url: arg.warm, headers: arg.warmHeaders, body: undefined }] : []),
      { warm: false, method: arg.method, url: arg.url, headers: arg.headers, body: arg.body ?? undefined },
    ];
    return { i, actor: r.actor ?? actor, arg, hops };
  });
  let seq = 0;
  const base = (p, hop, t) => ({
    t: isoAt(t),
    seq: ++seq,
    pid: process.pid,
    actor: p.actor,
    method: hop.method,
    url: h.redactString(hop.url),
    reqHeaders: h.redactHeaders(hop.headers),
    reqBody: h.redactBody(hop.body, headerValue(hop.headers, "content-type")),
  });

  // 1. The isolation tripwire for every hop: cheap, and before the guard reads anything.
  for (const p of plan) for (const hop of p.hops) h.assertReachable(target, hop.url, allowPorts);
  // 2. The guard for every hop. One refusal: its row, then nothing is sent.
  for (const p of plan) {
    for (const hop of p.hops) {
      const verdict = await g.check({ method: hop.method, url: hop.url, headers: hop.headers, body: hop.body, actor: p.actor });
      if (verdict && verdict.allow === false) {
        sink(h.traceLine({ ...base(p, hop, Date.now()), guard: { refused: true, rule: verdict.rule, reason: verdict.reason }, sync: { i: p.i, warm: hop.warm } }));
        throw syncGuardError(`guard refused ${hop.method} ${h.redactString(hop.url)}${hop.warm ? " (a warm-up)" : ""}: ${verdict.reason} — syncHttp request ${p.i}, before the barrier: nothing was sent`, verdict.rule, verdict);
      }
    }
  }

  // 3. Fire. Warm-ups are in flight from now until the barrier opens (every actor is ready: its warm-up is over), the requests from then until they are answered.
  let warmUntrack = plan.filter((p) => p.arg.warm).map((p) => h.trackPending(evidence, { t: startedAt, actor: p.actor, method: "GET", url: p.arg.warm }));
  let fireUntrack = [];
  const here = import.meta.url;
  let run;
  try {
    run = await syncActors(
      plan.map((p) => ({ module: here, prepare: "httpPrepare", fn: "httpFire", arg: p.arg })),
      {
        ...actorOpts,
        onRelease: () => {
          for (const u of warmUntrack) u();
          warmUntrack = [];
          const t = Date.now();
          fireUntrack = plan.map((p) => h.trackPending(evidence, { t, actor: p.actor, method: p.arg.method, url: p.arg.url }));
        },
      },
    );
  } finally {
    for (const u of [...warmUntrack, ...fireUntrack]) u();
  }

  // 4. One row per hop sent, in request order: the warm-up, then the request.
  const lines = [];
  let leak = null;
  const push = (record) => {
    try {
      lines.push(h.traceLine(record));
    } catch (err) {
      leak ??= err;
    }
  };
  const rows = run.results.map((r) => {
    const p = plan[r.i];
    const [warmHop, fireHop] = p.arg.warm ? p.hops : [null, p.hops[0]];
    const w = r.report?.warm;
    if (warmHop && w) {
      push({ ...base(p, warmHop, w.startAt), status: w.status, ms: w.endAt - w.startAt, resHeaders: h.redactHeaders(w.headers), resBody: h.redactBody(w.body, String(w.headers?.["content-type"] ?? "")), sync: { i: p.i, warm: true } });
    } else if (warmHop && typeof r.error === "string" && r.error.startsWith("prepare failed: ")) {
      // The warm-up failed on the wire (an answer of any status is not a failure): its actor never fired.
      push({ ...base(p, warmHop, startedAt), ms: null, error: h.redactString(r.error.slice("prepare failed: ".length)), sync: { i: p.i, warm: true } });
    }
    if (r.result) {
      const x = r.result;
      push({ ...base(p, fireHop, x.startAt ?? r.firedAt), status: x.status, ms: x.endAt - x.startAt, resHeaders: h.redactHeaders(x.headers), resBody: h.redactBody(x.body, String(x.headers?.["content-type"] ?? "")), sync: { i: p.i, warm: false, firedAt: r.firedAt, sentAt: x.sentAt, firstByteAt: x.firstByteAt, endAt: x.endAt } });
      return { ...x, i: r.i, firedAt: r.firedAt };
    }
    if (Number.isFinite(r.firedAt)) {
      push({ ...base(p, fireHop, r.firedAt), ms: Number.isFinite(r.doneAt) ? r.doneAt - r.firedAt : null, error: h.redactString(String(r.error)), sync: { i: p.i, warm: false, firedAt: r.firedAt } });
    } else if (!String(r.error ?? "").startsWith("prepare failed: ")) {
      // Every actor was ready when the barrier opened, so one whose worker died (or was ended at timeoutMs) before reporting had fired.
      push({ ...base(p, fireHop, run.releasedAt), ms: null, error: h.redactString(String(r.error ?? "no report")), sync: { i: p.i, warm: false } });
    }
    return { i: r.i, error: r.error, firedAt: r.firedAt };
  });
  for (const line of lines) sink(line);
  if (leak) throw leak;
  return { ...run, results: rows, overlap: overlapProof(rows), guarded: true };
}

/**
 * SYNC-T for HTTP: fire `requests` ({url, method, headers, body, warm?,
 * actor?}) from N threads at once. Returns {results (each with startAt,
 * sentAt, firstByteAt, endAt, status, body), spreadMs, conclusive, verdict,
 * overlap}. A body is a string, a Buffer/Uint8Array (sent as its bytes) or a
 * value sent as its JSON.
 *
 * `target` (a loadTarget() target) GUARDS the run, before any worker exists:
 * every request and its warm-up passes http.mjs assertReachable(target, url,
 * allowPorts) (E2E_ISOLATION), then `guard` (true: guard.mjs
 * createGuard(target); or a {check(req)} of your own) is asked
 * {method, url, headers, body, actor} for each; a refusal writes its row
 * (`guard: {refused, rule, reason}`) and throws E2E_GUARD (`rule`, `verdict`)
 * with nothing sent. Each hop goes with User-Agent and X-Bikeshed-Agent
 * `bikeshed-e2e/<runId>` unless it names its own; each sent hop, warm-up
 * included, is one redacted row (http.mjs traceLine: `{t, seq, pid, actor,
 * method, url, reqHeaders, reqBody, status, ms, resHeaders, resBody | error,
 * sync: {i, warm, firedAt?, sentAt?, firstByteAt?, endAt?}}`) in the sink a
 * createHttp client with `evidence` writes to (default: the running case's,
 * so ctx.requests()); while in flight they are pendingRequests. `actor`
 * (default "sync"; a request's own `actor` wins) labels the rows. The result
 * gains `guarded: true`. A row that would still hold a credential is not
 * written, and syncHttp throws E2E_REDACTION after writing the others.
 *
 * Without `target` it runs unguarded and untraced, as it always did, but
 * refuses (E2E_GUARD, rule "sync-unguarded", nothing sent) any request or
 * warm-up whose host is not loopback: a run against anything but a local
 * stack must pass `target`. `guard`, `evidence`, `actor` and `allowPorts`
 * without `target` are a TypeError.
 */
export async function syncHttp(requests, opts = {}) {
  if (!Array.isArray(requests)) throw new TypeError(`syncHttp: requests is a list of {url, method, headers, body, warm?}, got ${JSON.stringify(requests) ?? String(requests)}`);
  const o = opts ?? {};
  const actorOpts = { kind: "http" };
  for (const k of ["leadMs", "timeoutMs", "kind"]) if (o[k] !== undefined) actorOpts[k] = o[k];
  if (o.target !== undefined && o.target !== null) return guardedSyncHttp(requests, o, actorOpts);
  const given = GUARDED_OPTIONS.filter((k) => o[k] !== undefined);
  if (given.length) throw new TypeError(`syncHttp: ${given.join(", ")} ${given.length === 1 ? "needs" : "need"} {target}: only a guarded run is checked, guarded and traced`);
  for (const [i, r] of requests.entries()) {
    for (const [what, url] of [["request", r?.url], ["warm-up", r?.warm]]) {
      const host = offMachineHost(url);
      if (host) throw syncGuardError(`syncHttp: refusing to send request ${i}'s ${what} to ${host} unguarded: nothing but loopback goes without {target} (the isolation check and the guard), and nothing was sent`, "sync-unguarded");
    }
  }
  const here = import.meta.url;
  const run = await syncActors(
    requests.map((arg) => ({ module: here, prepare: "httpPrepare", fn: "httpFire", arg })),
    actorOpts,
  );
  const rows = run.results.map((r) => (r.result ? { ...r.result, i: r.i, firedAt: r.firedAt } : { i: r.i, error: r.error, firedAt: r.firedAt }));
  return { ...run, results: rows, overlap: overlapProof(rows) };
}

// --- SYNC-T, pages -----------------------------------------------------------

function pageFireSource(action) {
  return `(async (t0, arg) => {
    const action = (${action.toString()});
    const clock = () => performance.timeOrigin + performance.now();
    const wait = Math.max(0, t0 - 3 - clock());
    await new Promise((r) => setTimeout(r, wait));
    while (clock() < t0) {}
    const firedAt = clock();
    let result, error;
    try { result = await action(arg); } catch (e) { error = String((e && e.message) || e); }
    return { firedAt, doneAt: clock(), result, error, lateMs: firedAt - t0 };
  })`;
}

/**
 * SYNC-T for pages/frames: each runs `action(arg)` in its own JS world at t0.
 * `action` is a function serialised by its source (no closures); `arg` is one
 * value, a list (one per target) or (i) => value. Evaluated as an expression,
 * so a page's CSP does not apply.
 */
export async function syncPages(targets, action, { arg = undefined, leadMs = 400, kind = "browser" } = {}) {
  const t0 = Date.now() + leadMs;
  const src = pageFireSource(action);
  const args = targets.map((_, i) => (typeof arg === "function" ? arg(i) : Array.isArray(arg) ? arg[i] : arg));
  const fires = await Promise.all(targets.map((t, i) => t.evaluate(`${src}(${JSON.stringify(t0)}, ${JSON.stringify(args[i] ?? null)})`)));
  const spread = spreadVerdict(fires.map((f) => f.firedAt), kind);
  return { t0, fires: fires.map((f, i) => ({ i, ...f })), ...spread };
}

// --- SYNC-H ----------------------------------------------------------------

/**
 * When the browser began sending a request and when the first byte of its
 * answer arrived, both on the browser's clock (Playwright's timing(): a wall
 * start time plus offsets from one monotonic base). Either is null when the
 * browser did not report it (-1), and then the record is unmeasured.
 */
export function browserWireTimes(request) {
  let t = null;
  try {
    t = request.timing();
  } catch {}
  const at = (offset) => (t && Number.isFinite(t.startTime) && t.startTime > 0 && Number.isFinite(offset) && offset >= 0 ? t.startTime + offset : null);
  return { sentAt: at(t?.requestStart), firstByteAt: at(t?.responseStart) };
}

/**
 * Hold the first `n` requests matching `url` (glob, RegExp or predicate) and
 * `method`, across one or more pages/contexts, until all n are held; then
 * `release()` continues them in one loop. Requests past the nth pass through
 * (counted in `extra`). Always call `unroute()` (or release) when done.
 */
export function holdRequests(hosts, url, n, { method = null, predicate = null, timeoutMs = 30_000 } = {}) {
  const list = Array.isArray(hosts) ? hosts : [hosts];
  const records = [];
  const routes = [];
  let extra = 0;
  let releasedAll = false;
  let resolveHeld;
  let rejectHeld;
  const held = new Promise((res, rej) => {
    resolveHeld = res;
    rejectHeld = rej;
  });
  held.catch(() => undefined);
  const timer = setTimeout(() => {
    const err = new Error(`holdRequests: ${routes.length}/${n} matching requests held within ${timeoutMs} ms`);
    err.code = "E2E_SYNC_TIMEOUT";
    err.held = routes.length;
    rejectHeld(err);
  }, timeoutMs);
  const handler = async (route) => {
    const req = route.request();
    if ((method && req.method() !== method) || (predicate && !predicate(req))) return route.fallback();
    if (releasedAll || routes.length >= n) {
      extra += 1;
      return route.fallback();
    }
    const rec = { i: routes.length, url: req.url(), method: req.method(), heldAt: Date.now() };
    records.push(rec);
    routes.push({ route, rec });
    if (routes.length === n) {
      clearTimeout(timer);
      resolveHeld(records);
    }
  };
  const installed = Promise.all(list.map((h) => h.route(url, handler)));
  const unroute = async () => {
    clearTimeout(timer);
    await Promise.all(list.map((h) => h.unroute(url, handler).catch(() => undefined)));
  };
  return {
    installed,
    held,
    records,
    get extra() {
      return extra;
    },
    /**
     * Continue every held request in one synchronous loop; then read, from
     * the browser's own timing of each, when it really went out and when its
     * first byte came back. `releasedAt` (this process's clock) is kept for
     * the record and never used as a send time.
     */
    async release() {
      releasedAll = true;
      clearTimeout(timer);
      const pending = [];
      for (const { route, rec } of routes) {
        rec.releasedAt = Date.now();
        pending.push(route.continue().catch((e) => (rec.error = e.message)));
      }
      await Promise.all(pending);
      await Promise.all(
        routes.map(async ({ route, rec }) => {
          const req = route.request();
          const res = await req.response().catch(() => null);
          rec.responseAt = Date.now();
          rec.status = res ? res.status() : null;
          Object.assign(rec, browserWireTimes(req));
        }),
      );
      await unroute();
      return { records, overlap: overlapProof(records), extra };
    },
    unroute,
  };
}

// --- the Firestore listen gate ------------------------------------------------

/** The path of the WebChannel the Firestore web SDK listens on: POSTs carry its requests, a GET is the back channel. */
export const LISTEN_CHANNEL = "/google.firestore.v1.Firestore/Listen/channel";

/**
 * A listen POST's body, as a predicate wants it: `decoded` the whole body
 * percent-decoded (so `"collectionId":"versions"` and `/docs/<id>/` can be
 * searched for), and `messages` each `req<N>___data__` field parsed as JSON
 * (null for one that is not). A body whose encoding is broken is decoded
 * field by field instead, so it never throws.
 */
export function decodeListenBody(raw) {
  const text = String(raw ?? "");
  let params = null;
  try {
    params = new URLSearchParams(text);
  } catch {
    params = null;
  }
  const messages = [];
  for (const [k, v] of params ?? []) {
    if (!/^req\d+___data__$/.test(k)) continue;
    try {
      messages.push(JSON.parse(v));
    } catch {
      messages.push(null);
    }
  }
  let decoded;
  try {
    decoded = decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    decoded = params ? [...params].map(([k, v]) => `${k}=${v}`).join("&") : text;
  }
  return { decoded, messages };
}

/**
 * Hold the browser's Firestore listen POSTs that `match`, each for `ms` from
 * the moment it is held (or, with `ms` null, until `release()`), and let
 * everything else through at once: a slow connection for one read, with the
 * product untouched.
 *
 * `host` is a Playwright Page or BrowserContext (a User means its page).
 * `match(decodedBody, {messages, url, method})` decides for each POST to
 * LISTEN_CHANNEL (see decodeListenBody); one that throws holds nothing. A GET
 * (the back channel, which never carries a request) always goes through. The
 * channel sends one POST at a time, so a held POST also holds the requests the
 * SDK queues behind it.
 *
 * Every request, held or not, goes on with route.fallback(): to the context's
 * own routes, so the isolation tripwire still judges it. Never
 * route.continue(), which would send it past the tripwire.
 *
 * Resolves, once the route is in place, {heldAt, records, release(), stop()}:
 * `heldAt` (live) the Date.now() of each hold, in order; `records` (live)
 * [{i, at, releasedAt, url, body (decoded), messages}]; `release()` lets every
 * request held so far go now (later matches are still held); `stop()`
 * releases them, removes the route and resolves `records`. Call stop() when
 * done, in a finally.
 */
export async function holdListen(host, match = () => true, ms = null) {
  const h = host && typeof host.route !== "function" && host.page ? host.page : host;
  if (!h || typeof h.route !== "function") throw new Error("holdListen: host is a Playwright Page or BrowserContext, or a User");
  if (typeof match !== "function") throw new Error(`holdListen: match is a function of the decoded body, got ${typeof match}`);
  if (ms !== null && !(Number.isFinite(ms) && ms >= 0)) throw new Error(`holdListen: ms is how long to hold each request, or null for until release(), got ${JSON.stringify(ms)}`);
  const heldAt = [];
  const records = [];
  const waiting = new Set();
  let stopped = false;
  const url = (u) => u.pathname.endsWith(LISTEN_CHANNEL);
  const handler = async (route) => {
    const req = route.request();
    if (!stopped && req.method() === "POST") {
      const body = decodeListenBody(req.postData() ?? "");
      let hold = false;
      try {
        hold = Boolean(match(body.decoded, { messages: body.messages, url: req.url(), method: req.method() }));
      } catch {
        hold = false;
      }
      if (hold) {
        const rec = { i: records.length, at: Date.now(), releasedAt: null, url: req.url(), body: body.decoded, messages: body.messages };
        records.push(rec);
        heldAt.push(rec.at);
        await new Promise((resolve) => {
          const w = {};
          w.go = () => {
            if (w.timer) clearTimeout(w.timer);
            waiting.delete(w);
            rec.releasedAt = Date.now();
            resolve();
          };
          if (ms !== null) w.timer = setTimeout(w.go, ms);
          waiting.add(w);
        });
      }
    }
    return route.fallback().catch(() => undefined);
  };
  await h.route(url, handler);
  const release = () => {
    for (const w of [...waiting]) w.go();
  };
  return {
    heldAt,
    records,
    release,
    async stop() {
      stopped = true;
      release();
      await h.unroute(url, handler).catch(() => undefined);
      return records;
    },
  };
}

// NOT awaited: an actor whose task module is this file imports it again, and
// a dynamic import of a module still in its own top-level await never settles.
if (!isMainThread && workerData?.kind === "e2e-sync-actor") void actorMain();
