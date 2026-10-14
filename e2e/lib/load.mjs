// SPDX-License-Identifier: Apache-2.0
// Machine load and memory sampling, and the gates a stack, a browser pool and the concurrency tier wait behind (SPEC §12).

/**
 * Convergence deadlines in the concurrency tier assume the machine is not
 * already busy. A load average of ~180 once tripled a 200 ms unit-test budget
 * here, so the concurrency tier waits for the 1-minute load to fall below a
 * threshold before it starts, and records samples while it runs so a slow
 * result can be read against what else the machine was doing.
 *
 * MEMORY. A session once had to be killed at more than 90 GB with swap full:
 * stacks and browser pools were started whatever the machine had left. So
 * starting a stack waits (stack.mjs, through admission.mjs) until all three
 * of these hold, each read fresh:
 *
 *   (a) PRESSURE   `sysctl -n kern.memorystatus_vm_pressure_level` is 1
 *                  (normal). 2 (warn) waits; 4 (critical) refuses AT ONCE.
 *   (b) SWAPPING   the vm_stat "Swapouts" counter rose by at most
 *                  E2E_MAX_SWAPOUTS (256) pages over a 5 s window: nothing is
 *                  being pushed out to swap right now.
 *   (c) FREE       `memory_pressure`'s "System-wide memory free percentage"
 *                  is at least E2E_MIN_FREE_PCT (25), AND that share of
 *                  hw.memsize is at least E2E_MIN_AVAILABLE_GB (8).
 *
 * (c) is the kernel's own figure, not free + inactive + speculative pages:
 * during the incident inactive memory alone (10.6 GB) would have passed an
 * 8 GB bar while the machine swapped itself to death. Swap USE (vm.swapusage)
 * is logged with every reading, for the record only: on macOS swap files are
 * added a gigabyte at a time and outlive the pressure that made them (19 of 20
 * GB used, with 81 % of memory free and nothing swapping, was measured).
 *
 * A browser pool waits before it makes contexts until (c)'s available figure
 * is at least E2E_POOL_BASE_GB (2) + N × E2E_POOL_CONTEXT_MB (600) for N
 * contexts (browser.mjs); it reads once, with no 5 s window. 600 MB is what a
 * context measured (0.5–0.6 GB each at N=20: 9.8–12.3 GB of browsers); the
 * 300 MB it was reserved 8 GB at N=20 against that.
 *
 * A LIVE CASE with N >= LIVE_RESERVE_MIN_N (10) on a local stack waits, before
 * its body runs (lib/test.mjs), until the pool's need for N contexts PLUS the
 * stack's growth, N × E2E_STACK_PEER_MB (700), is available (admitLive): the
 * stack admission's 8 GB is for a stack's start, and at N=20 a stack grew to
 * 14.5–15.3 GB (Functions workers 13.5 GB). 2 GB + 20 × 600 MB + 20 × 700 MB
 * is 27.4 GB, against a measured N=20 peak of 24.3–27.6 GB. A wait that never
 * opens ends the case INCONCLUSIVE.
 *
 * Every wait and refusal is a line in a load.jsonl with all three readings.
 * A gate that never opens fails: `stack up` and `run` exit 3; a pool or a
 * live case ends its case INCONCLUSIVE. Thresholds are configuration, never
 * a way to get a run through: lowering one to start on a machine short of
 * memory is exactly the failure this exists to stop.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { availableParallelism, loadavg, totalmem } from "node:os";

export const DEFAULT_MAX_LOAD = 8;

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;
export const MEMORY_DEFAULTS = Object.freeze({ minFreePct: 25, minAvailableGb: 8, maxSwapouts: 256, poolBaseGb: 2, poolContextMb: 600, stackPeerMb: 700 });
/** The N from which a case also reserves the stack's growth (admitLive). */
export const LIVE_RESERVE_MIN_N = 10;
/** The window over which swap-outs are counted for the stack gate. */
export const SWAPOUT_WINDOW_MS = 5000;
/** kern.memorystatus_vm_pressure_level values. */
export const PRESSURE = Object.freeze({ normal: 1, warn: 2, critical: 4 });

export function sampleLoad() {
  const [one, five, fifteen] = loadavg();
  return { at: new Date().toISOString(), one, five, fifteen, cpus: availableParallelism() };
}

/** vm_stat's text → {pageSize, swapouts, pageouts} (cumulative counters). */
export function parseVmStat(text) {
  const size = /page size of (\d+) bytes/.exec(text);
  const count = (name) => {
    const m = new RegExp(`^"?${name}"?:\\s+(\\d+)\\.?$`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };
  const out = { pageSize: size ? Number(size[1]) : null, swapouts: count("Swapouts"), pageouts: count("Pageouts") };
  for (const [k, v] of Object.entries(out)) if (!Number.isFinite(v)) throw new Error(`vm_stat: no ${k} in its output`);
  return out;
}

/** `memory_pressure`'s text → the system-wide free percentage. */
export function parseFreePct(text) {
  const m = /System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/.exec(String(text));
  if (!m) throw new Error("memory_pressure: no \"System-wide memory free percentage\" in its output");
  return Number(m[1]);
}

/** `sysctl -n kern.memorystatus_vm_pressure_level` → 1, 2 or 4. */
export function parsePressureLevel(text) {
  const n = Number(String(text).trim());
  if (!Number.isInteger(n)) throw new Error(`kern.memorystatus_vm_pressure_level: not a number: ${JSON.stringify(String(text).trim())}`);
  return n;
}

/** `sysctl vm.swapusage`'s text → {totalBytes, usedBytes} (for the record only). */
export function parseSwapUsage(text) {
  const num = (name) => {
    const m = new RegExp(`${name} = ([\\d.]+)([KMGT])`).exec(text);
    if (!m) throw new Error(`vm.swapusage: no ${name} in ${JSON.stringify(String(text).trim())}`);
    return Number(m[1]) * 1024 ** (" KMGT".indexOf(m[2]));
  };
  return { totalBytes: num("total"), usedBytes: num("used") };
}

/** /proc/meminfo and /proc/vmstat → the same reading on Linux (no pressure level: normal). */
function readLinux() {
  const info = readFileSync("/proc/meminfo", "utf8");
  const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+) kB$`, "m").exec(info)?.[1] ?? NaN) * 1024;
  const vmstat = readFileSync("/proc/vmstat", "utf8");
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  return {
    level: PRESSURE.normal,
    freePct: Math.round((available / total) * 1000) / 10,
    memsize: total,
    swapouts: Number(/^pswpout (\d+)$/m.exec(vmstat)?.[1] ?? 0),
    pageouts: Number(/^pgpgout (\d+)$/m.exec(vmstat)?.[1] ?? 0),
    swapTotalBytes: kb("SwapTotal"),
    swapUsedBytes: kb("SwapTotal") - kb("SwapFree"),
  };
}

const run = (cmd, args = []) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });

/**
 * One instant reading: {at, level, freePct, memsize, availableBytes,
 * swapouts, pageouts (cumulative pages), swapUsedBytes, swapTotalBytes}.
 * `memory_pressure` is run without arguments, which only prints statistics
 * (its options allocate memory: never pass any).
 */
export function readMemory() {
  const at = new Date().toISOString();
  const r = process.platform === "linux"
    ? readLinux()
    : (() => {
        const vm = parseVmStat(run("vm_stat"));
        const swap = parseSwapUsage(run("sysctl", ["vm.swapusage"]));
        return {
          level: parsePressureLevel(run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])),
          freePct: parseFreePct(run("memory_pressure")),
          memsize: Number(run("sysctl", ["-n", "hw.memsize"]).trim()) || totalmem(),
          swapouts: vm.swapouts,
          pageouts: vm.pageouts,
          swapTotalBytes: swap.totalBytes,
          swapUsedBytes: swap.usedBytes,
        };
      })();
  return { at, ...r, availableBytes: Math.floor((r.freePct / 100) * r.memsize) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A reading with the swap-outs of the last `windowMs` (`swapoutsDelta`,
 * pages): two readings `windowMs` apart. `windowMs` 0 reads once and leaves
 * the delta null (a browser pool, which must not spend 5 s per context).
 */
export async function sampleMemory({ windowMs = SWAPOUT_WINDOW_MS, read = readMemory } = {}) {
  if (!windowMs) return { ...read(), swapoutsDelta: null, windowMs: 0 };
  const first = read();
  await sleep(windowMs);
  const second = read();
  return { ...second, swapoutsDelta: second.swapouts - first.swapouts, windowMs };
}

function envNumber(env, key, fallback, { min = 0, max = Infinity } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} wants a number from ${min} to ${max}, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * The memory thresholds, from the environment (E2E_MIN_FREE_PCT,
 * E2E_MIN_AVAILABLE_GB, E2E_MAX_SWAPOUTS, E2E_POOL_BASE_GB,
 * E2E_POOL_CONTEXT_MB, E2E_STACK_PEER_MB) or the defaults.
 */
export function memoryThresholds(env = process.env) {
  return {
    minFreePct: envNumber(env, "E2E_MIN_FREE_PCT", MEMORY_DEFAULTS.minFreePct, { min: 0, max: 100 }),
    minAvailableBytes: envNumber(env, "E2E_MIN_AVAILABLE_GB", MEMORY_DEFAULTS.minAvailableGb, { min: 0 }) * GIB,
    maxSwapouts: envNumber(env, "E2E_MAX_SWAPOUTS", MEMORY_DEFAULTS.maxSwapouts, { min: 0 }),
    poolBaseBytes: envNumber(env, "E2E_POOL_BASE_GB", MEMORY_DEFAULTS.poolBaseGb, { min: 0 }) * GIB,
    poolContextBytes: envNumber(env, "E2E_POOL_CONTEXT_MB", MEMORY_DEFAULTS.poolContextMb, { min: 0 }) * MIB,
    stackPeerBytes: envNumber(env, "E2E_STACK_PEER_MB", MEMORY_DEFAULTS.stackPeerMb, { min: 0 }) * MIB,
  };
}

/** The stack gate's need: (a), (b) and (c) of the header. */
export function stackNeed(t = memoryThresholds()) {
  return { pressure: true, maxSwapouts: t.maxSwapouts, minFreePct: t.minFreePct, minAvailableBytes: t.minAvailableBytes };
}

/** What a browser pool of `contexts` more contexts needs available (the base once per pool). */
export function poolNeedBytes(contexts, { withBase = true, thresholds = memoryThresholds() } = {}) {
  return (withBase ? thresholds.poolBaseBytes : 0) + contexts * thresholds.poolContextBytes;
}

/** How much a local stack grows with N live peers: N × E2E_STACK_PEER_MB from N = LIVE_RESERVE_MIN_N, else 0 (the stack admission covers a small case). */
export function stackGrowthBytes(n, { thresholds = memoryThresholds() } = {}) {
  return Number.isInteger(n) && n >= LIVE_RESERVE_MIN_N ? n * thresholds.stackPeerBytes : 0;
}

/** What a live case of N peers needs available before its body: the pool's base and N contexts, plus the stack's growth (0 below LIVE_RESERVE_MIN_N: only the pool's own gate then). */
export function liveNeedBytes(n, { thresholds = memoryThresholds() } = {}) {
  if (!(Number.isInteger(n) && n >= LIVE_RESERVE_MIN_N)) return 0;
  return poolNeedBytes(n, { thresholds }) + stackGrowthBytes(n, { thresholds });
}

const gb = (b) => `${(b / GIB).toFixed(1)} GB`;
const mbOf = (b) => `${Math.round(b / MIB)} MB`;

/**
 * Before a live case of N peers on a local stack: wait until liveNeedBytes(n)
 * is available (the pool's figure: no swap window), up to `timeoutMs`.
 * Resolves {ok, needBytes, waitedMs, sample, reason}; N below
 * LIVE_RESERVE_MIN_N is {ok: true, needBytes: 0} without a reading. `reason`
 * says what N needs and what the machine had, when it never came.
 */
export async function admitLive({ n, thresholds = memoryThresholds(), timeoutMs = 120_000, pollMs = 5000, sample = () => sampleMemory({ windowMs: 0 }), logFile = null, signal = null } = {}) {
  const needBytes = liveNeedBytes(n, { thresholds });
  if (needBytes === 0) return { ok: true, needBytes: 0, waitedMs: 0, sample: null, reason: null };
  const r = await waitForMemory({ need: { minAvailableBytes: needBytes }, gate: "live-n", sample, timeoutMs, pollMs, logFile, signal, detail: { n, pid: process.pid } });
  const split = `${gb(thresholds.poolBaseBytes).replace(".0 GB", " GB")} + ${n} × ${mbOf(thresholds.poolContextBytes)} for the browsers, ${n} × ${mbOf(thresholds.stackPeerBytes)} for the stack's growth`;
  const reason = r.ok ? null : `N=${n} needs ${gb(needBytes)} available (${split}), and the machine has ${gb(r.sample.availableBytes)}${r.critical ? " at critical memory pressure" : ""}, after ${Math.round(r.waitedMs / 1000)} s`;
  return { ok: r.ok, needBytes, waitedMs: r.waitedMs, sample: r.sample, reason };
}

/**
 * Whether a reading meets a need: {ok, critical, reasons}. Each part of the
 * need is checked only when given: `pressure` (a), `maxSwapouts` (b, needs a
 * windowed sample), `minFreePct` and `minAvailableBytes` (c). `critical` is
 * true at pressure level 4, which no wait can fix in time.
 */
export function memoryVerdict(sample, { pressure = false, maxSwapouts = null, minFreePct = null, minAvailableBytes = null } = {}) {
  const reasons = [];
  let critical = false;
  if (pressure && sample.level !== PRESSURE.normal) {
    critical = sample.level >= PRESSURE.critical;
    reasons.push(`memory pressure level ${sample.level} (${critical ? "critical" : sample.level === PRESSURE.warn ? "warn" : "not normal"})`);
  }
  if (maxSwapouts != null) {
    if (!Number.isFinite(sample.swapoutsDelta)) reasons.push("no swap-out count over a window");
    else if (sample.swapoutsDelta > maxSwapouts) reasons.push(`swapping: ${sample.swapoutsDelta} pages swapped out in ${sample.windowMs} ms > ${maxSwapouts}`);
  }
  if (minFreePct != null && !(sample.freePct >= minFreePct)) reasons.push(`memory free ${sample.freePct}% < ${minFreePct}%`);
  if (minAvailableBytes != null && !(sample.availableBytes >= minAvailableBytes)) reasons.push(`available memory ${gb(sample.availableBytes)} (${sample.freePct}% of ${gb(sample.memsize)}) < ${gb(minAvailableBytes)}`);
  return { ok: reasons.length === 0, critical, reasons };
}

/** The readings a load.jsonl line carries: all three, and swap used for the record. */
export function readings(s) {
  return { level: s.level, swapoutsDelta: s.swapoutsDelta ?? null, windowMs: s.windowMs ?? null, freePct: s.freePct, availableBytes: s.availableBytes, swapUsedBytes: s.swapUsedBytes, swapTotalBytes: s.swapTotalBytes };
}

function logLine(file, row) {
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify(row) + "\n");
  } catch {}
}

/**
 * Resolve once a reading meets `need`, or report that none did within
 * `timeoutMs` (at once on critical pressure, when `need.pressure`). Each wait
 * is logged to `logFile` (load.jsonl): one line when it starts, one per
 * `logEveryMs` while it lasts, one with the outcome, each with the readings.
 * @param {{need:object, gate:string, timeoutMs?:number, pollMs?:number, logEveryMs?:number, sample?:()=>Promise<object>, onWait?:(s:object, reasons:string[])=>void, logFile?:string, signal?:AbortSignal, detail?:object}} o
 * @returns {Promise<{ok:boolean, critical:boolean, sample:object, reasons:string[], waitedMs:number}>}
 */
export async function waitForMemory({ need, gate, timeoutMs = 10 * 60_000, pollMs = 5000, logEveryMs = 30_000, sample = () => sampleMemory(), onWait, logFile = null, signal = null, detail = {} } = {}) {
  const start = Date.now();
  let s = await sample();
  let v = memoryVerdict(s, need);
  if (v.ok) return { ok: true, critical: false, sample: s, reasons: [], waitedMs: 0 };
  const row = (extra) => ({ at: new Date().toISOString(), gate, need, ...detail, ...readings(s), reasons: v.reasons, ...extra });
  if (v.critical) {
    logLine(logFile, row({ event: "memory-refused", waitedMs: Date.now() - start }));
    return { ok: false, critical: true, sample: s, reasons: v.reasons, waitedMs: Date.now() - start };
  }
  logLine(logFile, row({ event: "memory-wait" }));
  onWait?.(s, v.reasons);
  let logged = Date.now();
  while (!v.ok) {
    if (Date.now() - start >= timeoutMs) {
      logLine(logFile, row({ event: "memory-refused", waitedMs: Date.now() - start }));
      return { ok: false, critical: false, sample: s, reasons: v.reasons, waitedMs: Date.now() - start };
    }
    signal?.throwIfAborted();
    await sleep(pollMs);
    s = await sample();
    v = memoryVerdict(s, need);
    if (v.critical) {
      logLine(logFile, row({ event: "memory-refused", waitedMs: Date.now() - start }));
      return { ok: false, critical: true, sample: s, reasons: v.reasons, waitedMs: Date.now() - start };
    }
    if (!v.ok && Date.now() - logged >= logEveryMs) {
      logLine(logFile, row({ event: "memory-wait" }));
      logged = Date.now();
    }
  }
  logLine(logFile, row({ event: "memory-gate-open", waitedMs: Date.now() - start }));
  return { ok: true, critical: false, sample: s, reasons: [], waitedMs: Date.now() - start };
}

/**
 * Resolve once the 1-minute load is below `max`, or report that it never was.
 * @returns {Promise<{ok:boolean, sample:object, waitedMs:number}>}
 */
export async function waitForLoad({ max = DEFAULT_MAX_LOAD, timeoutMs = 10 * 60_000, pollMs = 5000, sample = sampleLoad, onWait } = {}) {
  const start = Date.now();
  let s = sample();
  let told = false;
  while (!(s.one < max)) {
    if (Date.now() - start >= timeoutMs) return { ok: false, sample: s, waitedMs: Date.now() - start };
    if (!told && onWait) onWait(s);
    told = true;
    await new Promise((r) => setTimeout(r, pollMs));
    s = sample();
  }
  return { ok: true, sample: s, waitedMs: Date.now() - start };
}

/**
 * Append a sample (load, and memory as `mem`: the three gate readings, with
 * the swap-outs since the previous sample) to a JSONL file every
 * `intervalMs` until stopped.
 */
export function startLoadSampler(file, intervalMs = 5000) {
  let prev = null;
  const write = () => {
    let mem = null;
    try {
      const r = readMemory();
      mem = readings({ ...r, swapoutsDelta: prev ? r.swapouts - prev.swapouts : null, windowMs: prev ? Date.parse(r.at) - Date.parse(prev.at) : null });
      prev = r;
    } catch {}
    try {
      appendFileSync(file, JSON.stringify({ ...sampleLoad(), mem }) + "\n");
    } catch {}
  };
  write();
  const timer = setInterval(write, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    write();
  };
}
