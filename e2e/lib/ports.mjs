// SPDX-License-Identifier: Apache-2.0
// The 24-port block each e2e stack runs on, claimed with an O_EXCL lock and proven free (SPEC §12).

/**
 * Why a block, a lock AND a bind test.
 *
 * - The user's long-lived emulator suite owns the default ports, other
 *   sessions' isolated stacks sit in 1xxxx and 2xxxx, and an editor helper was
 *   seen listening inside 3xxxx. So the range is 30000–39999 and every port is
 *   tested, never assumed.
 * - A bind test alone races: two runs can both see a block free and both start.
 *   The O_EXCL lock file is the claim; the bind test is the proof.
 * - A lock whose holder is dead is taken over, so a crashed run never leaks a
 *   block forever. The takeover is serialised by a second O_EXCL file.
 *
 * A port counts as free only if a listener can bind it on 127.0.0.1, ::1,
 * 0.0.0.0 and :: and nothing answers a connect on 127.0.0.1 or ::1. libuv sets
 * SO_REUSEADDR, under which BSD lets a specific address share a port with a
 * wildcard holder, so one bind proves less than it seems.
 */

import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { LOCKS_DIR, assertRunId } from "./paths.mjs";

export const RANGE_START = 30000;
export const RANGE_END = 39999;
export const BLOCK_SIZE = 24;

/**
 * Never bound by a stack, whatever the range says. The user's suite (from the
 * repo's firebase.json), Firebase's built-in defaults, and Mailpit's.
 */
export const DEFAULT_DENY = Object.freeze([
  9099, 8088, 9000, 5001, 5050, 9199, 4040, 4400, 4500, 9150, 9299, 9499,
  4000, 5000, 5002, 8080, 8085, 9005, 9399, 8025, 1025,
]);

/**
 * The role of each offset in a block. Readers use names, never offsets.
 * `spare` … `spare9` are the stack's spare-port POOL (lib/spare.mjs): a spec
 * that needs a loopback listener of its own (an OAuth receiver, an RTDB
 * proxy) claims one exclusively and releases it, so concurrent spec files on
 * one stack never collide. A block of 16 (one `spare`) was the old layout;
 * records and targets written by it still read, with a pool of one.
 */
export const PORT_ROLES = Object.freeze([
  "hub", "logging", "auth", "firestore", "firestoreWs", "database", "functions",
  "hosting", "storage", "eventarc", "tasks", "ui", "mailpit", "smtp", "shim", "spare",
  "spare2", "spare3", "spare4", "spare5", "spare6", "spare7", "spare8", "spare9",
]);

/** Parse E2E_DENY_PORTS: `1234,2000-2010`. */
export function parseDenyList(text = process.env.E2E_DENY_PORTS || "") {
  const out = new Set();
  for (const part of String(text).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`E2E_DENY_PORTS: not a port or range: ${JSON.stringify(part)}`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b < a || b - a > 10000) throw new Error(`E2E_DENY_PORTS: bad range ${part}`);
    for (let p = a; p <= b; p++) out.add(p);
  }
  return out;
}

export function denySet(extra = process.env.E2E_DENY_PORTS) {
  const set = parseDenyList(extra);
  for (const p of DEFAULT_DENY) set.add(p);
  return set;
}

/** Throw if a port is outside the e2e range or on a deny list. */
export function assertStackPort(port, deny = denySet()) {
  if (!Number.isInteger(port) || port < RANGE_START || port > RANGE_END) {
    throw new Error(`port ${port} is outside the e2e range ${RANGE_START}-${RANGE_END}`);
  }
  if (deny.has(port)) throw new Error(`port ${port} is on the deny list`);
  return port;
}

function tryBind(host, port) {
  return new Promise((resolveBind) => {
    const server = createServer();
    server.once("error", (err) => {
      // A host this machine does not have (no IPv6) cannot conflict.
      if (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT") resolveBind(true);
      else resolveBind(false);
    });
    server.listen({ host, port, exclusive: true, ipv6Only: host.includes(":") && host !== "::" }, () => {
      server.close(() => resolveBind(true));
    });
  });
}

function somethingAnswers(host, port, timeoutMs = 300) {
  return new Promise((resolveConnect) => {
    const socket = connect({ host, port });
    const done = (answered) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveConnect(answered);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** True only when every bind succeeds and nothing answers. */
export async function isPortFree(port) {
  for (const host of ["127.0.0.1", "::1", "0.0.0.0", "::"]) {
    if (!(await tryBind(host, port))) return false;
  }
  for (const host of ["127.0.0.1", "::1"]) {
    if (await somethingAnswers(host, port)) return false;
  }
  return true;
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** A lock is live while any pid it names is alive. */
export function lockIsLive(content) {
  if (!content || typeof content !== "object") return false;
  const pids = [content.pid, ...(Array.isArray(content.pids) ? content.pids : [])];
  return pids.some((p) => isPidAlive(p));
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Create `path` with O_EXCL holding `content`. If it exists and every pid in it
 * is dead, take it over. Returns true when this process now holds it.
 */
export function claimLockFile(path, content) {
  const body = JSON.stringify(content, null, 2) + "\n";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o644);
      try {
        writeFileSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const existing = readJson(path);
    // A file mid-write by its creator reads as unparsable for a moment.
    if (existing === null) {
      let age = 0;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (age < 5000) return false;
    } else if (lockIsLive(existing)) {
      return false;
    }
    if (!takeOver(path, existing)) return false;
  }
  return false;
}

/** Remove a dead lock, serialised so two takers cannot both win. */
function takeOver(path, seen) {
  const mutex = `${path}.takeover`;
  try {
    const fd = openSync(mutex, "wx", 0o644);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    closeSync(fd);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // A taker that crashed inside the critical section: milliseconds, normally.
    try {
      if (Date.now() - statSync(mutex).mtimeMs > 10000) unlinkSync(mutex);
    } catch {}
    return false;
  }
  try {
    const now = readJson(path);
    // Re-read under the mutex: somebody may have taken it over already.
    if (now !== null && lockIsLive(now)) return false;
    if (seen && now && (now.pid !== seen.pid || now.createdAt !== seen.createdAt)) return false;
    const grave = `${path}.stale-${process.pid}-${Date.now()}`;
    try {
      renameSync(path, grave);
      unlinkSync(grave);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return true;
  } finally {
    try {
      unlinkSync(mutex);
    } catch {}
  }
}

/** Rewrite a lock this run holds, e.g. to hand it to the stack's long-lived pids. */
export function updateLockFile(path, runId, patch) {
  const now = readJson(path);
  if (!now || now.runId !== runId) {
    throw new Error(`lock ${path} is not held by run ${runId} (holder: ${now?.runId ?? "none"})`);
  }
  const next = { ...now, ...patch, runId, updatedAt: new Date().toISOString() };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, path);
  return next;
}

/** Delete a lock only if it is this run's. */
export function releaseLockFile(path, runId) {
  const now = readJson(path);
  if (!now) return false;
  if (now.runId !== runId) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

export function blockLockPath(base, dir = LOCKS_DIR) {
  return join(dir, `ports-${base}.lock`);
}

/**
 * A LIVE lock of another block whose ports overlap [base, base + size): blocks
 * of different sizes (a 16-port block from an older harness, a 24-port one
 * from this) have different lock files for overlapping ranges, so the O_EXCL
 * claim alone cannot see the clash. An unreadable lock (mid-write) counts.
 */
export function overlappingLock(base, size, { locksDir = LOCKS_DIR, ownPath = null } = {}) {
  let names = [];
  try {
    names = readdirSync(locksDir);
  } catch {
    return null;
  }
  for (const name of names) {
    const m = /^ports-(\d+)\.lock$/.exec(name);
    if (!m) continue;
    const path = join(locksDir, name);
    if (path === ownPath) continue;
    const other = readJson(path);
    const ob = Number.isInteger(other?.base) ? other.base : Number(m[1]);
    const os = Number.isInteger(other?.size) ? other.size : 16;
    if (!(ob < base + size && base < ob + os)) continue;
    if (other === null) return { path, base: ob, size: os, why: "unreadable" };
    if (lockIsLive(other)) return { path, base: ob, size: os, runId: other.runId ?? null, why: "live" };
  }
  return null;
}

/** Map a block's ports to their roles. */
export function namePorts(ports) {
  if (ports.length !== PORT_ROLES.length) throw new Error(`expected ${PORT_ROLES.length} ports`);
  return Object.fromEntries(PORT_ROLES.map((role, i) => [role, ports[i]]));
}

/**
 * Claim a free block of 24 consecutive ports in 30000–39999.
 *
 * @param {object} o
 * @param {string} o.runId              the claiming run
 * @param {number} [o.size=24]
 * @param {Set<number>} [o.deny]        defaults + E2E_DENY_PORTS
 * @param {number} [o.rangeStart] [o.rangeEnd]  narrowed only by self-tests
 * @param {string} [o.locksDir]
 * @param {() => number} [o.random]
 * @returns {Promise<{base:number, ports:number[], named:object, lockPath:string, release:()=>boolean}>}
 */
export async function allocateBlock({
  runId,
  size = BLOCK_SIZE,
  deny = denySet(),
  rangeStart = RANGE_START,
  rangeEnd = RANGE_END,
  locksDir = LOCKS_DIR,
  random = Math.random,
} = {}) {
  assertRunId(runId);
  if (rangeStart < RANGE_START || rangeEnd > RANGE_END) {
    throw new Error(`a block must lie inside ${RANGE_START}-${RANGE_END}`);
  }
  mkdirSync(locksDir, { recursive: true });
  const slots = Math.floor((rangeEnd - rangeStart + 1) / size);
  if (slots < 1) throw new Error("range too small for one block");
  const first = Math.floor(random() * slots);
  const skipped = [];
  for (let i = 0; i < slots; i++) {
    const base = rangeStart + ((first + i) % slots) * size;
    const ports = Array.from({ length: size }, (_, k) => base + k);
    if (ports.some((p) => deny.has(p))) {
      skipped.push({ base, why: "deny" });
      continue;
    }
    const lockPath = blockLockPath(base, locksDir);
    const createdAt = new Date().toISOString();
    if (!claimLockFile(lockPath, { pid: process.pid, runId, base, size, createdAt })) {
      skipped.push({ base, why: "locked" });
      continue;
    }
    const clash = overlappingLock(base, size, { locksDir, ownPath: lockPath });
    if (clash) {
      releaseLockFile(lockPath, runId);
      skipped.push({ base, why: `overlaps ${clash.why} block ${clash.base}+${clash.size}` });
      continue;
    }
    const busy = [];
    for (const p of ports) if (!(await isPortFree(p))) busy.push(p);
    if (busy.length > 0) {
      releaseLockFile(lockPath, runId);
      skipped.push({ base, why: `busy ${busy.join(",")}` });
      continue;
    }
    return {
      runId,
      base,
      ports,
      named: size === PORT_ROLES.length ? namePorts(ports) : null,
      lockPath,
      skipped,
      release: () => releaseLockFile(lockPath, runId),
    };
  }
  throw new Error(`no free ${size}-port block in ${rangeStart}-${rangeEnd} (${skipped.length} tried)`);
}
