// SPDX-License-Identifier: Apache-2.0
// The per-stack watchdog: stops its stack at expiry, at the hard maximum or when an orphan's owner dies, fails it when an emulator dies, keeps the Database emulator's log and caps its debug logs (SPEC §12).

/**
 *   node e2e/lib/watchdog.mjs <runId>      (started by startStack, never by hand)
 *
 * One small Node process per stack, started detached as soon as the stack's
 * record exists, carrying the stack's mark (so teardown and `reap` stop it
 * with the stack, and `stack status` counts it), with no harness command
 * needed to keep it going. Every E2E_WATCHDOG_POLL_MS (15 s) it reads the
 * record and the lease and applies lifetime.mjs stackVerdict:
 *
 *   stop  expiry, the hard maximum, or an orphan's owner gone: stopStack, the
 *         tree removed, rec.stopReason saying why;
 *   fail  a ready stack whose emulator died (jvm.mjs names one that ran out
 *         of memory): the record is marked failed with the reason, then
 *         stopped, the tree kept to be read;
 *
 * and holds the tree's debug logs under their cap (debuglogs.mjs), copying the
 * Database emulator's new records out of firebase-debug.log into
 * logs/database-debug.log first (drainDatabaseLog: a cut would lose them;
 * only for a record with logs.database, and never while the stack is being
 * stopped, when stopStack drains it). It exits
 * once the stack is stopped, by itself or by anybody else (a SIGINT or
 * SIGTERM from a teardown ends it at once). Each tick is written to
 * <stackDir>/watchdog.json; what it does goes to logs/watchdog.log.
 */

import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_DIR, assertPath, assertRunId, stackDir as stackDirFor } from "./paths.mjs";
import { STACK_MARK_KEY, buildEnv, spawnDetached, SYSTEM_PATH } from "./proc.mjs";
import { egressEnv } from "./egress.mjs";
import { ownerAlive, readLease, stackVerdict } from "./lifetime.mjs";
import { capDebugLogs, drainDatabaseLog } from "./debuglogs.mjs";

export const WATCHDOG_FILE = fileURLToPath(import.meta.url);
export const DEFAULT_POLL_MS = 15_000;
export const WATCHDOG_HEAP_MB = 48;

/** E2E_WATCHDOG_POLL_MS: at least 200 ms. */
export function watchdogPollMs(env = process.env) {
  const raw = env.E2E_WATCHDOG_POLL_MS;
  if (raw === undefined || raw === "") return DEFAULT_POLL_MS;
  if (!/^\d+$/.test(String(raw)) || Number(raw) < 200) throw new Error(`E2E_WATCHDOG_POLL_MS wants at least 200 ms, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

/**
 * Start a stack's watchdog: `node <this file> <runId>`, detached, marked,
 * under the egress guard, its output in logs/watchdog.log. It needs the real
 * HOME (paths.mjs finds the stack under ~/.cache), nothing else of the caller's.
 * @returns {{name:"watchdog", pid:number, pgid:number, cmd:string, args:string[], logFile:string, startedAt:string, pollMs:number}}
 */
export function spawnWatchdog(rec, { nodeBin, pollMs = rec.watchdogPollMs ?? DEFAULT_POLL_MS, home = process.env.HOME, guard = join(E2E_DIR, "lib", "egress-guard.mjs") } = {}) {
  assertRunId(rec.runId);
  const set = { [STACK_MARK_KEY]: rec.mark, E2E_WATCHDOG_POLL_MS: String(pollMs) };
  if (rec.logs?.egress && existsSync(guard)) Object.assign(set, egressEnv({ file: guard, log: rec.logs.egress }));
  const p = spawnDetached(join(nodeBin, "node"), [`--max-old-space-size=${WATCHDOG_HEAP_MB}`, WATCHDOG_FILE, rec.runId], {
    cwd: assertPath(rec.stackDir, "stackDir"),
    env: buildEnv({ path: [nodeBin, ...SYSTEM_PATH], tmpdir: rec.tmpDir ?? rec.stackDir, home, set }),
    logFile: rec.logs.watchdog,
  });
  return { name: "watchdog", ...p, pollMs };
}

function writeTick(stackDir, tick) {
  try {
    const path = join(stackDir, "watchdog.json");
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(tick, null, 2) + "\n");
    renameSync(tmp, path);
  } catch {}
}

/**
 * One look at the stack, and what it did: {verdict, logs, database, acted}
 * (`database`: the drain's result, or null when none ran).
 * `stack` is lib/stack.mjs (passed in: it imports this file).
 */
export async function watchdogTick(runId, { stack, now = Date.now(), log = () => {} }) {
  const rec = stack.readRecord(runId);
  if (!rec) return { verdict: { action: existsSync(stackDirFor(runId)) ? "none" : "settled", reason: "no record" }, logs: [], acted: false };
  // Before any cut: what the Database emulator printed since the last tick goes to logs/database-debug.log.
  let database = null;
  if (rec.logs?.database && rec.treeDir && existsSync(rec.treeDir) && rec.state !== "stopping" && rec.state !== "stopped") {
    try {
      database = drainDatabaseLog(rec);
      if (database?.reset) log(`firebase-debug.log was ${database.reset}; the Database emulator's records are read from its start again`);
      if (database?.rotated) log(`${database.file} passed half its cap; its older half is ${database.file}.1`);
      if (database?.trimmed) log(`${database.file}: cut back ${database.trimmed} bytes an interrupted drain had appended`);
    } catch (err) {
      log(`keeping the Database emulator's log failed: ${err.message}`);
    }
  }
  let logs = [];
  if (rec.treeDir && existsSync(rec.treeDir) && rec.debugLogs?.maxBytes) {
    try {
      logs = capDebugLogs(rec.treeDir, { maxBytes: rec.debugLogs.maxBytes });
      for (const l of logs.filter((x) => x.rotated)) log(`cut ${l.file} at ${l.size} bytes (kept its last ${l.keptBytes} in ${l.file}.1${l.head ? ", its head in a .head.log" : ""})`);
    } catch (err) {
      log(`capping the debug logs failed: ${err.message}`);
    }
  }
  const lease = readLease(rec.stackDir);
  const failures = rec.state === "ready" ? stack.stackFailures(rec) : [];
  const verdict = stackVerdict({ rec, lease, now, ownerIsAlive: ownerAlive(rec), failures });
  writeTick(rec.stackDir, { pid: process.pid, at: new Date(now).toISOString(), state: rec.state, verdict, expiresAt: lease?.expiresAt ?? null, hardExpiresAt: lease?.hardExpiresAt ?? null, logs: logs.map((l) => ({ file: l.file, size: l.size, rotated: l.rotated, link: l.link ?? null })), database: database ? { records: database.records, read: database.read, offset: database.offset, reset: database.reset, busy: !!database.busy, missing: !!database.missing } : null });
  if (verdict.action === "stop" || verdict.action === "fail") {
    log(`${verdict.action === "fail" ? "FAILED" : "stopping"}: ${verdict.reason}`);
    const fresh = stack.readRecord(runId) ?? rec;
    if (verdict.action === "fail") {
      fresh.state = "failed";
      fresh.error = verdict.reason;
      fresh.failure = { at: new Date(now).toISOString(), by: "watchdog", reason: verdict.reason, failures };
    }
    fresh.stopReason = { at: new Date(now).toISOString(), by: "watchdog", action: verdict.action, reason: verdict.reason };
    stack.saveRecord(fresh);
    const r = await stack.stopStack(fresh, { keepTree: verdict.action === "fail", log });
    log(`stack ${runId} ${r.state}${r.treeKept ? " (tree kept)" : ""}${r.survivors?.length ? `; survivors: ${r.survivors.map((s) => s.pid).join(", ")}` : ""}`);
    return { verdict, logs, database, acted: true, result: r };
  }
  return { verdict, logs, database, acted: false };
}

async function main(runId) {
  assertRunId(runId);
  const pollMs = watchdogPollMs();
  const stack = await import("./stack.mjs");
  const log = (m) => process.stdout.write(`[watchdog ${runId} ${new Date().toISOString()}] ${m}\n`);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      log(`${sig}: the stack is being stopped by somebody else; exiting`);
      process.exit(0);
    });
  }
  log(`watching stack ${runId} every ${pollMs} ms`);
  for (;;) {
    let t;
    try {
      t = await watchdogTick(runId, { stack, log });
    } catch (err) {
      log(`tick failed: ${err.stack || err.message}`);
      t = { verdict: { action: "none" } };
    }
    if (t.acted || t.verdict.action === "settled") {
      log(`done (${t.verdict.action}: ${t.verdict.reason ?? ""})`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// Not awaited at the top level: main() imports stack.mjs, which imports this
// file, and a pending top-level await here would hold that import forever.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2]).catch((err) => {
    process.stdout.write(`[watchdog] ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
