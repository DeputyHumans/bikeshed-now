// SPDX-License-Identifier: Apache-2.0
// Functions-emulator workers under concurrent requests: the ones a stack runs, the room a burst needs before it starts more, the idle ones retired through the emulator's own reload, and a warm-up that starts none (SPEC §12).

/**
 * WHY. The Functions emulator answers each concurrent request to a function
 * with a worker process of its own (`node …/functionsEmulatorRuntime`, its
 * env FUNCTION_TARGET=<entry point>), about 216 MB resident, and never reaps
 * an idle one: a worker lives until the stack stops or the emulator reloads
 * its source. A burst of k requests to one function leaves k workers; the
 * next burst to ANOTHER function adds k more. An HTTP-only concurrency file
 * (C17/C19/C20) at N=5 peaked at a stack RSS of 11.46 GB (58 processes) with
 * no browser at all, and a live N=20 stack held 62 or more workers (13.5 GB).
 * The live reservation (load.mjs admitLive) is per PEER, for N >= 10, and
 * reserves nothing for a burst of requests.
 *
 *   admitWorkers(ctx, {requests})   before a burst (its warm-up included) on a
 *                                   local stack: wait until the machine has
 *                                   E2E_POOL_BASE_GB + requests × the worker
 *                                   figure available (load.jsonl gate
 *                                   "function-workers"), or end the case
 *                                   INCONCLUSIVE. Production: nothing to
 *                                   reserve here (its workers are Cloud Run
 *                                   instances), so it resolves at once.
 *   functionWorkers(target)         the stack's workers now, by entry point,
 *                                   with their RSS (every process carrying the
 *                                   stack's mark whose command is the runtime).
 *   retireIdleWorkers(target)       the emulator's own reload, asked of the
 *                                   stack's Emulator Hub (PUT
 *                                   /functions/enableBackgroundTriggers, its
 *                                   public API: reloadTriggers), which kills
 *                                   every IDLE worker and lets a BUSY one
 *                                   finish its request first
 *                                   (RuntimeWorkerPool.refresh). The harness
 *                                   signals nothing. Concurrency tier only: it
 *                                   is stack-wide, and the next request to
 *                                   every function cold-starts.
 *   staticWarmUrl(target)           a static Hosting file to warm a syncHttp
 *                                   racer's socket on: GET /config is the
 *                                   appConfig function, so a warm-up there
 *                                   starts one more worker per racer.
 *
 * The worker figure is FUNCTION_WORKER_MB (250: measured 216 MB each, with
 * room), E2E_FUNCTION_WORKER_MB to RAISE it; a value below the default is
 * refused, since lowering a memory reservation is how a machine swaps itself
 * to death.
 *
 * WHY THE HUB, NOT THE SOURCE WATCHER. The emulator also reloads when a file
 * under functions/ changes, but its chokidar watcher ignores
 * /(^|[\/\\])\../ (dotfiles), tested against the WHOLE path, and every
 * stack tree lives under ~/.cache/bikeshed-e2e/stacks/: on these stacks the
 * watcher sees nothing at all (measured: a change made no reload in 60 s).
 * The hub's reload is also synchronous: it answers once the triggers are
 * reloaded and the idle workers have been told to exit. It re-enables
 * background triggers too, which nothing in this harness disables.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GIB, MIB, memoryThresholds, sampleMemory, waitForMemory } from "./load.mjs";
import { STACK_MARK_KEY, environments, envValues, processTable, rssBytes } from "./proc.mjs";
import { grepLog, logMark } from "./logs.mjs";

/** What one Functions-emulator worker is reserved at, in MiB (measured: about 216 MB resident each). */
export const FUNCTION_WORKER_MB = 250;
/** The environment variable that RAISES the worker figure (never below FUNCTION_WORKER_MB). */
export const FUNCTION_WORKER_ENV = "E2E_FUNCTION_WORKER_MB";
/** The load.jsonl gate name of admitWorkers' wait. */
export const WORKERS_GATE = "function-workers";
/** What a worker's command line carries (firebase-tools lib/emulator/functionsEmulatorRuntime.js). */
export const WORKER_RUNTIME = "functionsEmulatorRuntime";
/** A static file Hosting serves from app/dist (app/public/site.webmanifest): no function runs for it. */
export const STATIC_WARM_PATH = "/site.webmanifest";
/** The Emulator Hub's route that reloads the Functions emulator's triggers (hub.js PATH_ENABLE_FUNCTIONS → reloadTriggers). */
export const RELOAD_PATH = "/functions/enableBackgroundTriggers";
/** The emulator's line for every (re)load of the triggers (functionsEmulator.js loadTriggers), kept as evidence. */
export const RELOAD_LINE_RE = /Loaded functions definitions from source/;
/** How long retireIdleWorkers waits for the hub's answer by default (the reload rediscovers every trigger). */
export const RETIRE_WAIT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gb = (b) => `${(b / GIB).toFixed(1)} GB`;

/** The worker figure in bytes: FUNCTION_WORKER_MB, or E2E_FUNCTION_WORKER_MB when it raises it (a lower or malformed value throws). */
export function functionWorkerBytes(env = process.env) {
  const raw = env?.[FUNCTION_WORKER_ENV];
  if (raw === undefined || raw === "") return FUNCTION_WORKER_MB * MIB;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < FUNCTION_WORKER_MB) {
    throw new Error(`${FUNCTION_WORKER_ENV} may only raise the worker figure: a number of MiB from ${FUNCTION_WORKER_MB} up, got ${JSON.stringify(raw)}`);
  }
  return n * MIB;
}

/** What a burst of `requests` concurrent function requests needs available: the pool's headroom (E2E_POOL_BASE_GB) plus one worker per request. */
export function workerNeedBytes(requests, { thresholds = memoryThresholds(), workerBytes = functionWorkerBytes() } = {}) {
  if (!Number.isInteger(requests) || requests < 1) throw new TypeError(`workerNeedBytes: requests is a whole number from 1, got ${JSON.stringify(requests)}`);
  return thresholds.poolBaseBytes + requests * workerBytes;
}

/**
 * Before a burst of `requests` concurrent requests to a function (count its
 * warm-up's, which is what starts the workers): on a local stack, wait (up to
 * E2E_POOL_WAIT_MS, as a browser pool does) until workerNeedBytes(requests)
 * is available, logging to the invocation's load.jsonl; no room ends the case
 * INCONCLUSIVE through `ctx.inconclusive` ("the machine never had room for
 * <what>: …"). A wait is a `ctx.step`. Any other target resolves at once
 * (`skipped`). Resolves {ok, needBytes, waitedMs, sample, skipped?}.
 *
 *   await admitWorkers(ctx, { requests: 2 * ctx.n, what: "C17a's warm-up and race" });
 *
 * @param {{target:object, inconclusive:(why:string)=>never, step?:(line:string)=>void}} ctx
 * @param {{requests:number, what?:string|null, timeoutMs?:number|null, pollMs?:number, sample?:(()=>Promise<object>)|null, logFile?:string|null, env?:object}} o
 */
export async function admitWorkers(ctx, { requests, what = null, timeoutMs = null, pollMs = 5_000, sample = null, logFile = undefined, env = process.env } = {}) {
  if (!ctx || typeof ctx !== "object" || typeof ctx.inconclusive !== "function") throw new TypeError("admitWorkers: ctx is a case's ctx (target, inconclusive, step)");
  if (!Number.isInteger(requests) || requests < 1) throw new TypeError(`admitWorkers: requests is a whole number from 1 (the burst's concurrent requests), got ${JSON.stringify(requests)}`);
  if (what !== null && (typeof what !== "string" || !what.trim())) throw new TypeError(`admitWorkers: what is null or a non-empty label, got ${JSON.stringify(what)}`);
  if (timeoutMs !== null && !(Number.isInteger(timeoutMs) && timeoutMs >= 0)) throw new TypeError(`admitWorkers: timeoutMs is null (E2E_POOL_WAIT_MS) or milliseconds, got ${JSON.stringify(timeoutMs)}`);
  if (!(Number.isInteger(pollMs) && pollMs >= 1)) throw new TypeError(`admitWorkers: pollMs is whole milliseconds from 1, got ${JSON.stringify(pollMs)}`);
  if (sample !== null && typeof sample !== "function") throw new TypeError("admitWorkers: sample is null or a memory sampler");
  const target = ctx.target;
  if (target?.kind !== "local") return { ok: true, needBytes: 0, waitedMs: 0, sample: null, skipped: `not a local stack (${target?.kind ?? "no target"}): its function workers are not this machine's` };
  const thresholds = memoryThresholds(env);
  const workerBytes = functionWorkerBytes(env);
  const needBytes = workerNeedBytes(requests, { thresholds, workerBytes });
  const waitMs = timeoutMs ?? (await import("./browser.mjs")).poolWaitMs(env);
  const dir = env.E2E_INVOCATION_DIR;
  const file = logFile === undefined ? (dir ? join(dir, "load.jsonl") : null) : logFile;
  const r = await waitForMemory({
    need: { minAvailableBytes: needBytes },
    gate: WORKERS_GATE,
    sample: sample ?? (() => sampleMemory({ windowMs: 0 })),
    timeoutMs: waitMs,
    pollMs,
    logFile: file,
    detail: { requests, pid: process.pid },
  });
  const label = what ?? `${requests} concurrent function request(s)`;
  const split = `${gb(thresholds.poolBaseBytes).replace(".0 GB", " GB")} + ${requests} × ${Math.round(workerBytes / MIB)} MB, one Functions-emulator worker per concurrent request`;
  if (!r.ok) {
    ctx.inconclusive(`the machine never had room for ${label}: it needs ${gb(needBytes)} available (${split}), and has ${gb(r.sample.availableBytes)}${r.critical ? " at critical memory pressure" : ""}, after ${Math.round(r.waitedMs / 1000)} s`);
  }
  if (r.waitedMs > 0 && typeof ctx.step === "function") ctx.step(`environment: waited ${Math.round(r.waitedMs / 1000)} s for ${gb(needBytes)} available before ${label} (${split})`);
  return { ok: true, needBytes, waitedMs: r.waitedMs, sample: r.sample };
}

/** The stack record's mark, for a local target: from its stack dir, else its run dir. */
function stackMark(target) {
  for (const dir of [target?.stack?.stackDir, target?.runDir]) {
    if (typeof dir !== "string" || !dir) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, "stack.json"), "utf8"));
      if (typeof rec?.mark === "string" && rec.mark) return rec.mark;
    } catch {}
  }
  return null;
}

/**
 * The Functions-emulator workers of a local stack, now: every process whose
 * launch environment carries the stack's mark (E2E_STACK_MARK, inherited by
 * everything the stack starts) and whose command runs the emulator's worker
 * runtime, with its entry point (FUNCTION_TARGET) and RSS. Resolves
 * {mark, count, rssBytes, workers: [{pid, entryPoint, rssBytes}] (by pid),
 * byEntryPoint: {<entry point>: {count, rssBytes}}}; null for a target that
 * is not a local stack. Throws when the stack's record has no mark.
 * `scan` = {envs, table, rss} replaces the process reads (self-tests).
 */
export function functionWorkers(target, { mark = null, scan = null } = {}) {
  if (target?.kind !== "local") return null;
  const m = mark ?? stackMark(target);
  if (!m) throw new Error(`functionWorkers: run ${target.runId}'s stack record names no mark (stack.json in its stack or run directory)`);
  const envs = scan?.envs ?? environments();
  const marks = envValues(STACK_MARK_KEY, null, envs);
  const entry = envValues("FUNCTION_TARGET", null, envs);
  const table = scan?.table ?? processTable();
  const command = new Map(table.map((p) => [p.pid, p.command]));
  const pids = [...marks].filter(([pid, v]) => v === m && entry.has(pid) && String(command.get(pid) ?? "").includes(WORKER_RUNTIME)).map(([pid]) => pid).sort((a, b) => a - b);
  const rss = scan?.rss ?? (pids.length ? rssBytes(pids) : new Map());
  const workers = pids.map((pid) => ({ pid, entryPoint: entry.get(pid), rssBytes: rss.get(pid) ?? 0 }));
  const byEntryPoint = {};
  for (const w of workers) {
    const e = (byEntryPoint[w.entryPoint] ??= { count: 0, rssBytes: 0 });
    e.count += 1;
    e.rssBytes += w.rssBytes;
  }
  return { mark: m, count: workers.length, rssBytes: workers.reduce((a, w) => a + w.rssBytes, 0), workers, byEntryPoint };
}

/**
 * Retire a local stack's IDLE Functions-emulator workers through the
 * emulator's own reload (see the header), and report what went:
 * {reloaded, status, line, before: {count, rssBytes}, after: {count,
 * rssBytes}, retired: [{pid, entryPoint, rssBytes}], remaining (busy then;
 * they exit after their request), started (new since), ms, summary}.
 *
 * It asks the stack's Emulator Hub (`PUT <hub>/functions/enableBackgroundTriggers`,
 * on one of the stack's own ports) and waits up to `timeoutMs` for its
 * answer, which comes once the triggers are reloaded; then up to `settleMs`
 * for the workers it found before to exit. `line` is the emulator's
 * "Loaded functions definitions from source" line after a mark, when its log
 * already holds it (evidence; the hub's 200 is the proof). A hub that does
 * not answer 200 is `reloaded: false` with `reason`. Refused
 * (E2E_SHARED_STACK) outside the concurrency tier (`env.E2E_SUITE`): the
 * reload is stack-wide, so the next request to every function cold-starts,
 * which a functional author sharing the stack must not get. Call it between
 * bursts, after the case's server settle, never while a case on the same
 * stack is racing. Any other target: {reloaded: false, skipped}.
 * `scan` (self-tests) replaces functionWorkers(target); `fetchImpl` fetch.
 */
export async function retireIdleWorkers(target, { timeoutMs = RETIRE_WAIT_MS, settleMs = 5_000, pollMs = 250, env = process.env, scan = null, fetchImpl = fetch, now = Date.now } = {}) {
  if (!target || typeof target !== "object") throw new TypeError("retireIdleWorkers: target is a loadTarget() target");
  for (const [k, v] of Object.entries({ timeoutMs, settleMs, pollMs })) {
    if (!Number.isInteger(v) || v < 0) throw new TypeError(`retireIdleWorkers: ${k} is whole milliseconds, got ${JSON.stringify(v)}`);
  }
  if (scan !== null && typeof scan !== "function") throw new TypeError("retireIdleWorkers: scan is null or () => functionWorkers()'s result");
  if (typeof fetchImpl !== "function") throw new TypeError("retireIdleWorkers: fetchImpl is a fetch");
  if (target.kind !== "local") return { reloaded: false, skipped: `not a local stack (${target.kind}): no Functions emulator to reload` };
  if (env?.E2E_SUITE !== "concurrency") {
    const err = new Error(`retireIdleWorkers: refused outside the concurrency tier (E2E_SUITE=${env?.E2E_SUITE ?? "unset"}): the reload is stack-wide, and the functional authors share their stacks`);
    err.code = "E2E_SHARED_STACK";
    throw err;
  }
  let hub;
  try {
    hub = new URL(String(target.hubUrl));
  } catch {
    throw new TypeError(`retireIdleWorkers: run ${target.runId}'s target has no hubUrl (${JSON.stringify(target.hubUrl)})`);
  }
  const ports = Object.values(target.stack?.ports ?? {});
  if (hub.protocol !== "http:" || hub.hostname !== "127.0.0.1" || !ports.includes(Number(hub.port))) {
    throw new Error(`retireIdleWorkers: ${hub.origin} is not run ${target.runId}'s own Emulator Hub (loopback, one of its ports)`);
  }
  const logFile = typeof target.stack?.logs?.emulators === "string" ? target.stack.logs.emulators : null;
  const read = scan ?? (() => functionWorkers(target));
  const t0 = now();
  const before = read();
  const mark = logFile ? logMark(logFile) : null;
  let status = 0;
  let reason = null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(new URL(RELOAD_PATH, hub.origin).href, { method: "PUT", signal: ac.signal, redirect: "manual" });
    status = r.status;
    const text = await r.text().catch(() => "");
    if (status !== 200) reason = `the Emulator Hub answered ${status} to PUT ${RELOAD_PATH}: ${text.slice(0, 200)}`;
  } catch (err) {
    reason = `the Emulator Hub did not answer PUT ${RELOAD_PATH} within ${timeoutMs} ms: ${String(err?.message ?? err).slice(0, 200)}`;
  } finally {
    clearTimeout(timer);
  }
  const reloaded = status === 200;
  const had = new Map(before.workers.map((w) => [w.pid, w]));
  let after = read();
  const deadline = now() + settleMs;
  while (reloaded && after.workers.some((w) => had.has(w.pid)) && now() < deadline) {
    await sleep(Math.max(pollMs, 1));
    after = read();
  }
  let line = null;
  if (logFile && mark !== null) {
    try {
      line = grepLog(RELOAD_LINE_RE, { file: logFile, since: mark })[0] ?? null;
    } catch {}
  }
  const still = new Set(after.workers.map((w) => w.pid));
  const retired = before.workers.filter((w) => !still.has(w.pid));
  const remaining = before.workers.filter((w) => still.has(w.pid));
  const started = after.workers.filter((w) => !had.has(w.pid));
  const freed = retired.reduce((a, w) => a + w.rssBytes, 0);
  const summary = reloaded
    ? `the Functions emulator reloaded: ${retired.length} of ${before.count} worker(s) retired (${gb(freed)}), ${remaining.length} still busy, ${started.length} started since; ${after.count} now (${gb(after.rssBytes)})`
    : `the Functions emulator did not reload: ${reason}`;
  return {
    reloaded,
    status,
    line,
    ...(reason ? { reason } : {}),
    before: { count: before.count, rssBytes: before.rssBytes },
    after: { count: after.count, rssBytes: after.rssBytes },
    retired,
    remaining,
    started,
    ms: now() - t0,
    summary,
  };
}

/**
 * The URL a syncHttp racer warms its socket on without starting a function
 * worker: STATIC_WARM_PATH on the target's origin. On a local stack the file
 * must be in the stack's built app (app/dist), else this throws: a warm path
 * that stopped being static would start one worker per racer unnoticed.
 *
 *   const requests = racers.map((r) => ({ url, method: "POST", body, headers, warm: staticWarmUrl(ctx.target) }));
 */
export function staticWarmUrl(target) {
  if (!target || typeof target.origin !== "string") throw new TypeError("staticWarmUrl: target is a loadTarget() target");
  if (target.kind === "local" && typeof target.stack?.treeDir === "string") {
    const built = join(target.stack.treeDir, "app", "dist", ...STATIC_WARM_PATH.split("/").filter(Boolean));
    if (!existsSync(built)) throw new Error(`staticWarmUrl: ${STATIC_WARM_PATH} is not in the stack's built app (${built}), so Hosting would not serve it statically`);
  }
  return new URL(STATIC_WARM_PATH, target.origin).href;
}
