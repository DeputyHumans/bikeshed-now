// SPDX-License-Identifier: Apache-2.0
// The stack's spare-port pool: one port per use, claimed exclusively across every process on the stack, released in finally (SPEC §12).

/**
 * A spec that needs a loopback listener of its own — an OAuth redirect
 * receiver, a latency proxy in front of the RTDB — must listen on one of the
 * STACK's ports: a browser following a redirect to any other loopback port
 * trips the isolation check, and the deny list and the 1xxxx/2xxxx ports of
 * other sessions are off limits anyway. A stack has nine such ports, the
 * roles `spare`, `spare2` … `spare9` of its block.
 *
 * Several spec files run at once on one stack (the functional tier runs four
 * files in parallel, and parallel `run --attach` invocations share a stack),
 * so a port is CLAIMED before it is used:
 *
 *   - one O_EXCL lock file per port, <runDir>/spare/<port>.lock, holding the
 *     claimer's pid, a random token and the purpose. Every process attached to
 *     the stack shares the run directory, so they all see the same claims;
 *   - a claim whose pid is dead is taken over (a crashed spec never leaks a
 *     port for longer than its own life);
 *   - after the claim, the port is proven free by binding it, so a stray
 *     listener of some other program is skipped rather than collided with;
 *   - when every port is claimed, the caller WAITS (polling) until one is
 *     released, up to `timeoutMs`, then fails with E2E_SPARE_TIMEOUT naming the
 *     holders. Waiting is right: a receiver lives for seconds.
 *
 * Release is by token, so a claimer can only ever release its own claim:
 *
 *   await withSparePort(target, async (port) => { … listen on port … });
 *   // or
 *   const claim = await claimSparePort(target, { purpose: "my-listener" });
 *   try { … } finally { claim.release(); }
 *
 * lib/oauth.mjs startReceiver() and lib/proxy.mjs startProxy() claim from this
 * pool themselves and release on close().
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { assertPath } from "./paths.mjs";
import { PORT_ROLES, claimLockFile, isPidAlive, isPortFree } from "./ports.mjs";

/** The block roles that make up the pool, in order. */
export const SPARE_ROLES = Object.freeze(PORT_ROLES.filter((r) => /^spare\d*$/.test(r)));

export const SPARE_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The pool of a target: its spare-role ports, in role order (one port for a target from a 16-port block). */
export function sparePorts(target) {
  const ports = target?.stack?.ports ?? {};
  return SPARE_ROLES.map((r) => ports[r]).filter((p) => Number.isInteger(p) && p > 0);
}

function claimsDir(target) {
  if (target?.kind !== "local") throw new Error("spare ports exist only on a local stack");
  if (!target.runDir) throw new Error("spare ports need target.runDir (where the claims live)");
  return assertPath(join(target.runDir, "spare"), "spare claims dir");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Remove a claim only if it still carries this token. */
function releaseClaim(path, token) {
  const now = readJson(path);
  if (!now || now.token !== token) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

/** Claims this process holds, released if it exits without doing so. */
const held = new Map();
let exitHook = false;
function remember(path, token) {
  held.set(path, token);
  if (!exitHook) {
    exitHook = true;
    process.once("exit", () => {
      for (const [p, t] of held) {
        try {
          releaseClaim(p, t);
        } catch {}
      }
    });
  }
}

/** Every current claim on the target's pool: [{port, pid, alive, purpose, at}]. */
export function spareClaims(target) {
  const dir = claimsDir(target);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d+\.lock$/.test(n))
    .map((n) => {
      const c = readJson(join(dir, n)) ?? {};
      return { port: Number(n.split(".")[0]), pid: c.pid ?? null, alive: isPidAlive(c.pid), purpose: c.purpose ?? null, at: c.at ?? null };
    })
    .sort((a, b) => a.port - b.port);
}

/**
 * Claim one free port of the pool (or the given `port`, which must be in it).
 *
 * @param {object} target
 * @param {object} [o]
 * @param {string} [o.purpose]      recorded in the claim, shown to whoever waits
 * @param {number} [o.port]         this pool port, not any
 * @param {number} [o.timeoutMs]    how long to wait for a free one (default 120 s)
 * @param {number} [o.pollMs]
 * @returns {Promise<{port:number, purpose:string, lockPath:string, release:()=>boolean}>}
 */
export async function claimSparePort(target, { purpose = "spare", port = null, timeoutMs = SPARE_TIMEOUT_MS, pollMs = 200 } = {}) {
  const dir = claimsDir(target);
  const pool = sparePorts(target);
  if (pool.length === 0) throw new Error(`stack ${target.runId} has no spare ports`);
  if (port != null && !pool.includes(port)) throw new Error(`port ${port} is not in stack ${target.runId}'s spare pool (${pool.join(", ")})`);
  const candidates = port != null ? [port] : pool;
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + timeoutMs;
  let busy = new Set();
  for (;;) {
    // A random starting point spreads concurrent claimers over the pool.
    const offset = Math.floor(Math.random() * candidates.length);
    busy = new Set();
    for (let k = 0; k < candidates.length; k += 1) {
      const p = candidates[(offset + k) % candidates.length];
      const lockPath = join(dir, `${p}.lock`);
      if (!claimLockFile(lockPath, { pid: process.pid, runId: target.runId, port: p, purpose, token, at: new Date().toISOString() })) continue;
      if (!(await isPortFree(p))) {
        // Something that is not a claimer holds it: leave it alone.
        releaseClaim(lockPath, token);
        busy.add(p);
        continue;
      }
      remember(lockPath, token);
      let released = false;
      return {
        port: p,
        purpose,
        lockPath,
        release() {
          if (released) return false;
          released = true;
          held.delete(lockPath);
          return releaseClaim(lockPath, token);
        },
      };
    }
    if (Date.now() >= deadline) {
      const claims = spareClaims(target);
      const err = new Error(
        `no spare port of stack ${target.runId} came free within ${timeoutMs} ms ` +
          `(pool ${candidates.join(", ")}; claimed: ${claims.map((c) => `${c.port} by pid ${c.pid} for ${c.purpose}`).join("; ") || "none"}` +
          `${busy.size ? `; held by something else: ${[...busy].join(", ")}` : ""})`,
      );
      err.code = "E2E_SPARE_TIMEOUT";
      err.claims = claims;
      throw err;
    }
    await sleep(pollMs);
  }
}

/** Claim a spare port, run fn(port, claim), and release it whatever happens. */
export async function withSparePort(target, fn, opts = {}) {
  const claim = await claimSparePort(target, opts);
  try {
    return await fn(claim.port, claim);
  } finally {
    claim.release();
  }
}
