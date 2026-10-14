// SPDX-License-Identifier: Apache-2.0
// Installing the egress guard into a stack and reading what it refused (SPEC §12).

/**
 * The guard itself is lib/egress-guard.mjs (preloaded, self-contained). This
 * module is the harness side:
 *
 *   installEgressGuard(treeDir)   copy it to <tree>/.e2e/egress-guard.mjs, so a
 *                                 stack keeps the guard it was built with; a
 *                                 controls set may patch that copy
 *   egressEnv({file, log})        NODE_OPTIONS (--require=<file>) and E2E_EGRESS_LOG
 *                                 for a process, its worker threads and its children
 *   egressLog(target)             <runDir>/logs/egress.jsonl
 *   readEgress(target, {since})   the refusals logged after a mark
 *   waitForEgress(target, pred)   poll until a refusal matching pred is logged
 *
 * Every line is written synchronously by the refusing process, so unlike the
 * emulator's own log there is no late flush to wait out: a refusal is in the
 * file before the refused call has even failed.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { E2E_DIR, assertPath } from "./paths.mjs";

export const GUARD_SOURCE = assertPath(join(E2E_DIR, "lib", "egress-guard.mjs"), "egress guard");
/** Where a stack's copy lives, relative to its tree. */
export const GUARD_IN_TREE = ".e2e/egress-guard.mjs";
export const REFUSED_CODE = "E2E_EGRESS_REFUSED";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Copy the guard into a stack tree. Returns {file, url, sha256}. */
export function installEgressGuard(treeDir) {
  assertPath(treeDir, "treeDir");
  const dir = join(treeDir, ".e2e");
  mkdirSync(dir, { recursive: true });
  const file = join(treeDir, GUARD_IN_TREE);
  copyFileSync(GUARD_SOURCE, file);
  return describeGuard(file);
}

/** {file, url, sha256} of an installed guard (re-read: a patch set may have changed it). */
export function describeGuard(file) {
  assertPath(file, "egress guard file");
  if (!existsSync(file)) throw new Error(`no egress guard at ${file}`);
  return { file, url: pathToFileURL(file).href, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

/**
 * The environment that arms the guard in a process, in every worker thread it
 * starts, and in everything it spawns.
 *
 * `--require`, not `--import`: Node runs `--import` preloads in the main
 * thread only, so a worker thread (vite, rollup, a pino transport, piscina)
 * would run unguarded. `--require` preloads run in every worker that inherits
 * the environment, and since Node 20.19 / 22.12 `require()` loads this ES
 * module (it has no top-level await). A Node too old for that fails to start
 * with ERR_REQUIRE_ESM: closed, not open. Each realm installs its own guard.
 * @param {{file:string, log:string}} o   the installed guard and the stack's egress log
 */
export function egressEnv({ file, log }) {
  const path = assertPath(file, "egress guard file");
  if (/[\s"'\\]/.test(path)) throw new Error(`the egress guard path cannot go into NODE_OPTIONS unquoted: ${path}`);
  return { NODE_OPTIONS: `--require=${path}`, E2E_EGRESS_LOG: assertPath(log, "egress log") };
}

/** The stack's egress log; throws for a target whose stack has no guard. */
export function egressLog(target) {
  const file = target?.stack?.logs?.egress;
  if (!file) {
    const err = new Error(`stack ${target?.runId} has no egress guard (built by an older harness)`);
    err.code = "E2E_CAPABILITY";
    throw err;
  }
  return assertPath(file, "egress log");
}

/** The current end of the egress log, to pass as `since`. */
export function egressMark(target) {
  try {
    return statSync(egressLog(target)).size;
  } catch (err) {
    if (err.code === "E2E_CAPABILITY") throw err;
    return 0;
  }
}

/** The refusals logged after byte `since` (a target, or a log path). Malformed lines are skipped. */
export function readEgress(targetOrFile, { since = 0 } = {}) {
  const file = typeof targetOrFile === "string" ? assertPath(targetOrFile, "egress log") : egressLog(targetOrFile);
  if (!existsSync(file)) return [];
  const text = readFileSync(file).subarray(since).toString("utf8");
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/**
 * Wait until a refusal matching `pred` is logged after `since`.
 * @returns {Promise<object>} the record; rejects E2E_EGRESS_TIMEOUT with what was seen
 */
export async function waitForEgress(target, pred, { since = 0, timeout = 30_000, pollMs = 200 } = {}) {
  const end = Date.now() + timeout;
  let seen = [];
  for (;;) {
    seen = readEgress(target, { since });
    const hit = seen.find(pred);
    if (hit) return hit;
    if (Date.now() >= end) break;
    await sleep(pollMs);
  }
  const err = new Error(`no matching egress refusal within ${timeout} ms; logged since the mark: ${seen.map((r) => `${r.kind} ${r.host}:${r.port}`).join(", ") || "none"}`);
  err.code = "E2E_EGRESS_TIMEOUT";
  err.seen = seen;
  throw err;
}
