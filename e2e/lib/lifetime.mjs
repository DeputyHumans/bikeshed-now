// SPDX-License-Identifier: Apache-2.0
// Who owns a stack and how long it may live: owner identity, expiry, extension, the hard maximum (SPEC §12).

/**
 * Two kept stacks once ran for 49 hours, and stacks whose session had died
 * kept running with them. So every stack has
 *
 *   an OWNER    the pid AND start second of the process that started it
 *               (rec.owner); a pid alone is reused, the pair is not. A
 *               non-kept stack (`run` without --keep) whose owner is gone is
 *               an orphan, and so is any stack still starting when its owner
 *               dies.
 *   an EXPIRY   <stackDir>/lease.json {expiresAt, hardExpiresAt}. A kept stack
 *               gets E2E_STACK_TTL_H (4 h, or `--ttl <h>`) from its start; each
 *               `run --attach` makes it at least E2E_STACK_EXTEND_H (2 h) from
 *               then, so one attach adds at most 2 h; neither ever passes
 *               the HARD MAXIMUM, E2E_STACK_MAX_H (8 h, never more) after the
 *               start. A non-kept stack expires at the hard maximum (its
 *               owner's death stops it sooner).
 *
 * stackVerdict() is the one rule the stack's watchdog (watchdog.mjs) applies
 * every few seconds and `reap` applies when run: stop at expiry, at the hard
 * maximum, or when an orphan's owner is gone; fail a ready stack whose
 * emulator died (named by jvmFailures).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPath } from "./paths.mjs";
import { identityAlive, processStartSecs, selfIdentity } from "./proc.mjs";

export const HOUR_MS = 3_600_000;
export const LIFETIME_DEFAULTS = Object.freeze({ ttlHours: 4, extendHours: 2, maxHours: 8 });
/** The hard maximum may be lowered, never raised. */
export const MAX_LIFETIME_CEILING_HOURS = 8;
const LEASE_FILE = "lease.json";
const EXTENSIONS_KEPT = 20;

function hours(env, key, fallback, max) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error(`${key} wants hours above 0, at most ${max}, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * The lifetime rules of a new stack: {ttlMs, extendMs, maxMs}. `ttlHours`
 * (stack up --ttl) wins over E2E_STACK_TTL_H; nothing may exceed the hard
 * maximum, and the hard maximum may not exceed 8 h.
 */
export function lifetimeConfig({ ttlHours = null, env = process.env } = {}) {
  const maxHours = hours(env, "E2E_STACK_MAX_H", LIFETIME_DEFAULTS.maxHours, MAX_LIFETIME_CEILING_HOURS);
  let ttl = hours(env, "E2E_STACK_TTL_H", Math.min(LIFETIME_DEFAULTS.ttlHours, maxHours), maxHours);
  if (ttlHours != null) {
    const n = Number(ttlHours);
    if (!Number.isFinite(n) || n <= 0 || n > maxHours) throw new Error(`--ttl wants hours above 0, at most ${maxHours} (the hard maximum), got ${JSON.stringify(ttlHours)}`);
    ttl = n;
  }
  const extend = hours(env, "E2E_STACK_EXTEND_H", Math.min(LIFETIME_DEFAULTS.extendHours, maxHours), maxHours);
  return { ttlMs: Math.round(ttl * HOUR_MS), extendMs: Math.round(extend * HOUR_MS), maxMs: Math.round(maxHours * HOUR_MS) };
}

/** The owner of what this process starts: {pid, startSec, startedAt, argv}. */
export function ownerIdentity() {
  const me = selfIdentity();
  return { ...me, startedAt: new Date(me.startSec * 1000).toISOString(), argv: process.argv.slice(1) };
}

/** Whether a record's owner is still that process (an older record with no owner: its creator's pid alone). */
export function ownerAlive(rec, { starts = null } = {}) {
  if (rec?.owner) return identityAlive(rec.owner, { starts });
  const pid = rec?.createdBy?.pid;
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Start seconds for every owner pid of these records, in one ps call. */
export function ownerStarts(recs) {
  return processStartSecs(recs.map((r) => r?.owner?.pid).filter(Number.isInteger));
}

/** The first lease of a stack created at `createdAtMs`. */
export function initialLease({ createdAtMs, keep, config }) {
  const hard = createdAtMs + config.maxMs;
  const expires = keep ? Math.min(createdAtMs + config.ttlMs, hard) : hard;
  return { expiresAt: new Date(expires).toISOString(), hardExpiresAt: new Date(hard).toISOString(), extendMs: config.extendMs, extensions: [] };
}

export function leasePath(stackDir) {
  return join(assertPath(stackDir, "stackDir"), LEASE_FILE);
}

/** A stack's lease, or null (an older stack, or one whose directory is gone). */
export function readLease(stackDir) {
  try {
    const l = JSON.parse(readFileSync(leasePath(stackDir), "utf8"));
    return Number.isFinite(Date.parse(l?.expiresAt)) && Number.isFinite(Date.parse(l?.hardExpiresAt)) ? l : null;
  } catch {
    return null;
  }
}

/** Write a lease atomically (a reader never sees half of one). */
export function writeLease(stackDir, lease) {
  const path = leasePath(stackDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lease, null, 2) + "\n");
  renameSync(tmp, path);
  return lease;
}

/**
 * Extend a stack's lease so it expires no sooner than `byMs` from `now`
 * (default: the lease's own extendMs, 2 h), and never after the hard maximum.
 * An extension adds at most `byMs`, and never shortens the lease.
 * @returns {{lease:object, from:string, to:string, addedMs:number, capped:boolean}|null}  null without a lease
 */
export function extendLease(stackDir, { now = Date.now(), byMs = null, by = null } = {}) {
  if (!existsSync(leasePath(stackDir))) return null;
  const lease = readLease(stackDir);
  if (!lease) return null;
  const step = byMs ?? lease.extendMs ?? LIFETIME_DEFAULTS.extendHours * HOUR_MS;
  const from = Date.parse(lease.expiresAt);
  const hard = Date.parse(lease.hardExpiresAt);
  const want = Math.max(from, now + step);
  const to = Math.min(want, hard);
  const next = {
    ...lease,
    expiresAt: new Date(to).toISOString(),
    extensions: [...(lease.extensions ?? []), { at: new Date(now).toISOString(), by: by ?? { pid: process.pid }, from: lease.expiresAt, to: new Date(to).toISOString() }].slice(-EXTENSIONS_KEPT),
  };
  writeLease(stackDir, next);
  return { lease: next, from: lease.expiresAt, to: next.expiresAt, addedMs: to - from, capped: want > hard };
}

const TERMINAL = new Set(["stopped", "failed", "reaped", "stop-refused"]);

/**
 * What to do with a stack now. One rule for the watchdog and for reap:
 *
 *   hard maximum reached              → stop  "max-lifetime"
 *   lease expired                     → stop  "expired"
 *   owner gone, and the stack is not
 *   kept or is still starting         → stop  "owner-gone"
 *   ready, and an emulator failed     → fail  <what failed>
 *   otherwise                         → none
 *
 * A stack already stopped → "settled". One being stopped ("stopping", or a
 * teardown that left something: "stop-incomplete") is left to its stopper —
 * who stops the watchdog first — unless its lease has run out meanwhile.
 * @returns {{action:"none"|"stop"|"fail"|"settled", reason:string|null}}
 */
export function stackVerdict({ rec, lease, now = Date.now(), ownerIsAlive, failures = [] }) {
  if (!rec) return { action: "settled", reason: "no record" };
  if (TERMINAL.has(rec.state)) return { action: "settled", reason: rec.state };
  if (lease) {
    const hard = Date.parse(lease.hardExpiresAt);
    if (now >= hard) return { action: "stop", reason: `max-lifetime: the hard maximum (${lease.hardExpiresAt}) was reached` };
    if (now >= Date.parse(lease.expiresAt)) return { action: "stop", reason: `expired: its lease ran out at ${lease.expiresAt}` };
  }
  if (rec.state === "stopping" || rec.state === "stop-incomplete") return { action: "none", reason: rec.state };
  if (!ownerIsAlive && (!rec.keep || rec.state === "starting")) {
    const who = rec.owner ? `pid ${rec.owner.pid} started ${rec.owner.startedAt}` : `pid ${rec.createdBy?.pid}`;
    return { action: "stop", reason: `owner-gone: ${rec.keep ? "a kept stack still starting" : "a stack that is not kept"} whose owner (${who}) is gone` };
  }
  if (rec.state === "ready" && failures.length > 0) return { action: "fail", reason: failures.map((f) => f.reason).join("; ") };
  return { action: "none", reason: null };
}
