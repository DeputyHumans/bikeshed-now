// SPDX-License-Identifier: Apache-2.0
// Machine-wide tier locks: functional runs share, a concurrency run is alone (SPEC §12).

/**
 * The concurrency tier measures convergence under load; a functional suite
 * running beside it is load nobody accounted for, and on a 16-core machine 20
 * Chrome contexts already fill it. So:
 *
 *   functional  SHARED     any number at once, never during an exclusive hold
 *   concurrency EXCLUSIVE  alone (a MEASUREMENT run)
 *               SHARED     an AUTHORING run: every N it selects (run.mjs --n)
 *                          at most AUTHORING_MAX_N (2) and its trials
 *                          (--trials) at most AUTHORING_MAX_TRIALS (2), so
 *                          authors validate in parallel (tierLockMode)
 *
 * A run with no --n (every N a spec declares, up to 20) or no --trials (each
 * scenario's own trials, the plan's 10/5/3/3 by default) is a measurement run.
 * The lock is the only thing the mode changes: the memory gate, the stack cap
 * and the concurrency load gate apply to every run whatever its mode.
 *
 * Protocol (files under ~/.cache/bikeshed-e2e/locks/tier/, the same for every
 * session of this user whatever its TMPDIR):
 *   exclusive: create `exclusive.lock` with O_EXCL (the intent), THEN wait for
 *              every live `shared-*.lock` to go.
 *   shared:    create own `shared-<pid>-<n>.lock`, THEN check for a live
 *              `exclusive.lock`; if there is one, delete own file and wait.
 * Each side announces before it looks, so at least one sees the other; the
 * shared side always yields, so there is no deadlock and no writer starvation.
 * Holders whose pid is dead are ignored and cleaned up.
 */

import { readdirSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LOCKS_DIR } from "./paths.mjs";
import { claimLockFile, lockIsLive } from "./ports.mjs";

export const TIER_MODE = Object.freeze({
  smoke: "shared",
  functional: "shared",
  concurrency: "exclusive",
});

/** The largest N an AUTHORING concurrency run may select and still share the tier lock (tierLockMode). */
export const AUTHORING_MAX_N = 2;
/** The most trials per N an AUTHORING concurrency run may run and still share the tier lock (tierLockMode). */
export const AUTHORING_MAX_TRIALS = 2;

/**
 * The tier lock a run of `tier` takes, and why: {tier, mode, authoring, reason}.
 *
 * smoke and functional: TIER_MODE (shared), whatever the selection. The
 * concurrency tier: SHARED only for an AUTHORING run, where `n` (run.mjs --n,
 * as numbers) is a non-empty list of whole numbers from 1 to AUTHORING_MAX_N
 * and `trials` (run.mjs --trials) is a whole number from 1 to
 * AUTHORING_MAX_TRIALS; else EXCLUSIVE, a MEASUREMENT run, and `reason` names
 * every part of the selection that made it one. `n: null` is no --n (every N
 * the specs declare) and `trials: null` no --trials (the plan's trials). A
 * scenario without `n` is not selected by --n: it runs whatever N its body
 * joins, which in an authoring run must be at most AUTHORING_MAX_N too.
 * An unknown tier throws.
 *
 * @param {string} tier
 * @param {{n?: number[]|null, trials?: number|null}} [selection]
 * @returns {{tier: string, mode: "shared"|"exclusive", authoring: boolean, reason: string}}
 */
export function tierLockMode(tier, { n = null, trials = null } = {}) {
  const base = Object.hasOwn(TIER_MODE, tier) ? TIER_MODE[tier] : null;
  if (!base) throw new Error(`tierLockMode: unknown tier ${JSON.stringify(tier)} (${Object.keys(TIER_MODE).join("|")})`);
  if (tier !== "concurrency") return { tier, mode: base, authoring: false, reason: `the ${tier} tier always shares` };
  const why = [];
  if (n === null || n === undefined) why.push("no --n: every N the specs declare (up to 20)");
  else if (!Array.isArray(n) || n.length === 0) why.push(`--n selects no N (${JSON.stringify(n)})`);
  else {
    const over = n.filter((N) => !(Number.isInteger(N) && N >= 1 && N <= AUTHORING_MAX_N));
    if (over.length) why.push(`--n ${n.join(",")} selects N=${over.join(",")}, not from 1 to ${AUTHORING_MAX_N}`);
  }
  if (trials === null || trials === undefined) why.push("no --trials: each scenario's own trials, the plan's 10/5/3/3 by default");
  else if (!(Number.isInteger(trials) && trials >= 1 && trials <= AUTHORING_MAX_TRIALS)) why.push(`--trials ${trials}, not from 1 to ${AUTHORING_MAX_TRIALS}`);
  if (why.length) return { tier, mode: "exclusive", authoring: false, reason: `measurement run: ${why.join("; ")}` };
  return { tier, mode: "shared", authoring: true, reason: `authoring run: --n ${n.join(",")} --trials ${trials} (every N at most ${AUTHORING_MAX_N}, at most ${AUTHORING_MAX_TRIALS} trials)` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let counter = 0;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function liveShared(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!/^shared-.*\.lock$/.test(name)) continue;
    const path = join(dir, name);
    const content = readJson(path);
    if (content && lockIsLive(content)) out.push({ path, content });
    else if (content) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
  return out;
}

function liveExclusive(dir) {
  const path = join(dir, "exclusive.lock");
  const content = readJson(path);
  return content && lockIsLive(content) ? { path, content } : null;
}

/**
 * Acquire a tier lock.
 * @param {"shared"|"exclusive"} mode
 * @param {{runId:string, tier?:string, timeoutMs?:number, pollMs?:number, dir?:string, onWait?:(why:string)=>void}} o
 * @returns {Promise<{mode:string, path:string, release:()=>void}>}
 */
export async function acquireTierLock(mode, { runId, tier = mode, timeoutMs = 30 * 60_000, pollMs = 500, dir = join(LOCKS_DIR, "tier"), onWait } = {}) {
  if (mode !== "shared" && mode !== "exclusive") throw new Error(`unknown lock mode ${mode}`);
  mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const content = { pid: process.pid, runId, tier, mode, createdAt: new Date().toISOString() };
  let told = false;
  const wait = async (why) => {
    if (Date.now() > deadline) throw new Error(`timed out waiting for the ${mode} tier lock: ${why}`);
    if (!told && onWait) onWait(why);
    told = true;
    await sleep(pollMs);
  };

  if (mode === "exclusive") {
    const path = join(dir, "exclusive.lock");
    while (!claimLockFile(path, content)) {
      const holder = readJson(path);
      await wait(`exclusive held by run ${holder?.runId ?? "?"} (pid ${holder?.pid ?? "?"})`);
    }
    const release = () => {
      const now = readJson(path);
      if (now && now.pid === process.pid && now.runId === runId) {
        try {
          unlinkSync(path);
        } catch {}
      }
    };
    try {
      for (;;) {
        const shared = liveShared(dir);
        if (shared.length === 0) break;
        await wait(`${shared.length} shared holder(s): ${shared.map((s) => s.content.runId).join(", ")}`);
      }
    } catch (err) {
      release();
      throw err;
    }
    return { mode, path, release };
  }

  for (;;) {
    const path = join(dir, `shared-${process.pid}-${++counter}.lock`);
    if (!claimLockFile(path, content)) throw new Error(`could not create ${path}`);
    const ex = liveExclusive(dir);
    if (!ex) {
      return {
        mode,
        path,
        release: () => {
          try {
            unlinkSync(path);
          } catch {}
        },
      };
    }
    try {
      unlinkSync(path);
    } catch {}
    await wait(`exclusive held by run ${ex.content.runId} (pid ${ex.content.pid})`);
  }
}

/** What holds the tier locks right now. */
export function tierLockStatus(dir = join(LOCKS_DIR, "tier")) {
  mkdirSync(dir, { recursive: true });
  return {
    exclusive: liveExclusive(dir)?.content ?? null,
    shared: liveShared(dir).map((s) => s.content),
  };
}
