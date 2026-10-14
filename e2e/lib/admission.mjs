// SPDX-License-Identifier: Apache-2.0
// Whether a new stack may start: enough free memory, and a free slot under the machine-wide stack cap (SPEC §12).

/**
 * Up to eight agents at once each started stacks (a `controls` run starts
 * two, one after the other) and browser pools, with no machine-wide limit,
 * until the machine ran out of memory. So a stack starts only when
 *
 *   MEMORY  the stack gate in load.mjs holds: pressure level normal, no
 *           swapping over a 5 s window, memory_pressure's free share ≥ 25 %
 *           and ≥ 8 GB (critical pressure refuses at once), and
 *   A SLOT  fewer than E2E_MAX_STACKS (3) stacks are live under
 *           ~/.cache/bikeshed-e2e/stacks, whoever started them — `stack up`,
 *           `run`, `controls`, another session, an older harness.
 *
 * A stack is LIVE while any of its recorded process groups is, or any process
 * carrying its mark, or while it is still starting and its owner is alive (a
 * stack is counted from the moment its record exists, before its first
 * process). The count and the record of the newcomer are made under one
 * O_EXCL mutex (locks/admission.lock, taken over from a dead holder), so two
 * admissions at once cannot both take the last slot.
 *
 * Both are polled together until `E2E_STACK_WAIT_MS` (20 min); then the start
 * fails with code E2E_ADMISSION, which `stack up` and `run` turn into exit 3 —
 * at once, without waiting, on critical memory pressure. Every wait and
 * refusal is logged to the run's load.jsonl with the memory readings.
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { LOCKS_DIR, STACKS_DIR, ensureDir } from "./paths.mjs";
import { claimLockFile } from "./ports.mjs";
import { STACK_MARK_KEY, envValues, environments, groupAlive, identityAlive, processStartSecs } from "./proc.mjs";
import { memoryThresholds, memoryVerdict, readings, sampleMemory, stackNeed } from "./load.mjs";

export const DEFAULT_MAX_STACKS = 3;
export const DEFAULT_STACK_WAIT_MS = 20 * 60_000;
export const ADMISSION_CODE = "E2E_ADMISSION";

/** E2E_MAX_STACKS: a whole number, at least 1. */
export function maxStacks(env = process.env) {
  const raw = env.E2E_MAX_STACKS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_STACKS;
  if (!/^[1-9]\d*$/.test(String(raw))) throw new Error(`E2E_MAX_STACKS wants a whole number of at least 1, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

/** E2E_STACK_WAIT_MS: how long a start waits for memory and a slot. */
export function stackWaitMs(env = process.env) {
  const raw = env.E2E_STACK_WAIT_MS;
  if (raw === undefined || raw === "") return DEFAULT_STACK_WAIT_MS;
  if (!/^\d+$/.test(String(raw))) throw new Error(`E2E_STACK_WAIT_MS wants milliseconds, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Every live stack under `stacksDir` (one process-table scan for all of
 * them): [{runId, state, why}], `why` naming what keeps it live.
 */
export function liveStacks({ stacksDir = STACKS_DIR, exclude = null } = {}) {
  if (!existsSync(stacksDir)) return [];
  const recs = [];
  for (const runId of readdirSync(stacksDir).sort()) {
    if (runId === exclude) continue;
    const rec = readJson(join(stacksDir, runId, "stack.json"));
    if (rec) recs.push(rec);
  }
  if (recs.length === 0) return [];
  const marks = new Set(envValues(STACK_MARK_KEY, null, environments()).values());
  const starts = processStartSecs(recs.map((r) => r.owner?.pid).filter(Number.isInteger));
  const out = [];
  for (const rec of recs) {
    const group = (rec.processes ?? []).find((p) => groupAlive(p.pgid));
    let why = null;
    if (group) why = `${group.name} pgid ${group.pgid} is running`;
    else if (rec.mark && marks.has(rec.mark)) why = "a process carrying its mark is running";
    else if (rec.state === "starting" && rec.owner && identityAlive(rec.owner, { starts })) why = `starting, owner pid ${rec.owner.pid} alive`;
    if (why) out.push({ runId: rec.runId, state: rec.state, why });
  }
  return out;
}

function logRow(file, row) {
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), gate: "stack", ...row }) + "\n");
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until memory and a slot both allow a new stack, then — under the
 * admission mutex, re-counting — call `claim()`, which must write the
 * newcomer's record (so the next count sees it). Throws E2E_ADMISSION when
 * `timeoutMs` passes first, naming what was short.
 *
 * @param {object} o
 * @param {string} o.runId
 * @param {() => void} o.claim               writes <stacksDir>/<runId>/stack.json (state "starting")
 * @param {number} [o.max]                   E2E_MAX_STACKS
 * @param {object} [o.thresholds]            load.mjs memoryThresholds()
 * @param {() => Promise<object>} [o.sample] load.mjs sampleMemory (a 5 s window)
 * @param {() => object[]} [o.live]          liveStacks
 * @returns {Promise<{waitedMs:number, memory:object, live:object[], max:number}>}
 */
export async function admitStack({
  runId,
  claim,
  max = maxStacks(),
  thresholds = memoryThresholds(),
  timeoutMs = stackWaitMs(),
  pollMs = 1000,
  sample = () => sampleMemory(),
  stacksDir = STACKS_DIR,
  locksDir = LOCKS_DIR,
  live = () => liveStacks({ stacksDir, exclude: runId }),
  logFile = null,
  log = null,
  signal = null,
}) {
  if (typeof claim !== "function") throw new TypeError("admitStack: claim() writes the newcomer's record");
  const start = Date.now();
  const need = stackNeed(thresholds);
  const mutex = join(ensureDir(locksDir, "locks dir"), "admission.lock");
  let told = null;
  let last = { memory: null, live: [], reasons: [] };
  const tell = (kind, text, row) => {
    if (told === text) return;
    told = text;
    log?.(text);
    logRow(logFile, { event: kind, runId, ...row });
  };
  for (;;) {
    signal?.throwIfAborted();
    const memory = await sample();
    const mv = memoryVerdict(memory, need);
    last = { memory, live: last.live, reasons: mv.reasons };
    if (mv.critical) {
      logRow(logFile, { event: "memory-refused", runId, need, ...readings(memory), reasons: mv.reasons, waitedMs: Date.now() - start });
      const err = new Error(`stack ${runId} not started: ${mv.reasons.join("; ")}: refused at once`);
      err.code = ADMISSION_CODE;
      err.reasons = mv.reasons;
      throw err;
    }
    if (!mv.ok) {
      tell("memory-wait", `waiting for memory before stack ${runId} starts: ${mv.reasons.join("; ")}`, { need, ...readings(memory), reasons: mv.reasons });
    } else if (claimLockFile(mutex, { pid: process.pid, runId, createdAt: new Date().toISOString() })) {
      let admitted = false;
      try {
        const now = live();
        last.live = now;
        if (now.length < max) {
          claim();
          admitted = true;
        } else {
          last.reasons = [`${now.length} of ${max} stacks live (${now.map((s) => s.runId).join(", ")})`];
          tell("slot-wait", `waiting for a stack slot before stack ${runId} starts: ${last.reasons[0]}`, { max, live: now });
        }
      } finally {
        const holder = readJson(mutex);
        if (holder?.pid === process.pid && holder?.runId === runId) {
          try {
            unlinkSync(mutex);
          } catch {}
        }
      }
      if (admitted) {
        const waitedMs = Date.now() - start;
        logRow(logFile, { event: "admitted", runId, waitedMs, ...readings(memory), live: last.live.length, max });
        return { waitedMs, memory: readings(memory), live: last.live, max };
      }
    }
    if (Date.now() - start >= timeoutMs) {
      const why = last.reasons.length ? last.reasons.join("; ") : "the admission lock stayed held";
      logRow(logFile, { event: "admission-refused", runId, waitedMs: Date.now() - start, reasons: last.reasons, ...(last.memory ? readings(last.memory) : {}), live: last.live });
      const err = new Error(`stack ${runId} not started: after ${Math.round((Date.now() - start) / 1000)} s, ${why}`);
      err.code = ADMISSION_CODE;
      err.reasons = last.reasons;
      throw err;
    }
    await sleep(Math.max(10, Math.min(pollMs, timeoutMs - (Date.now() - start))));
  }
}
