// SPDX-License-Identifier: Apache-2.0
// Every filesystem location the e2e harness reads or writes, resolved and checked once (SPEC §12).

/**
 * Two roots, and nothing in between.
 *
 *   REPO_ROOT    the checkout this file lives in, found from import.meta.url —
 *                never from process.cwd(), so `node e2e/run.mjs` from any
 *                directory resolves the same tree.
 *   E2E_TMP      ~/.cache/bikeshed-e2e — stack copies, stack records, port
 *                and tier locks. MACHINE-WIDE for this user, so it must not
 *                depend on TMPDIR: a terminal (/var/folders/…/T) and a
 *                sandboxed agent session (some other TMPDIR) would otherwise
 *                each see only their own locks, claim the same port block and
 *                overlap an exclusive tier. REALPATH'd (once it exists),
 *                because child processes report resolved paths.
 *
 * Evidence (logs, target.json, stack.json, screenshots) goes ONLY under
 * e2e/.out/<runId>/, which is gitignored.
 *
 * Every path handed out is asserted absolute, already resolved, and free of an
 * `undefined` or `null` segment — the signature of a template literal built
 * from a missing value, which would otherwise write to `functions/undefined/…`
 * (it has happened in this repository).
 */

import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Throw unless `p` is an absolute, normalised path with no missing-value segment. */
export function assertPath(p, label = "path") {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error(`${label}: expected a path string, got ${JSON.stringify(p)}`);
  }
  if (!isAbsolute(p)) throw new Error(`${label}: not absolute: ${p}`);
  if (resolve(p) !== p) throw new Error(`${label}: not resolved (has . or .. or a trailing slash): ${p}`);
  const segments = p.split(sep);
  for (const bad of ["undefined", "null", "NaN", "[object Object]"]) {
    if (segments.some((segment) => segment.split("-").includes(bad))) {
      throw new Error(`${label}: contains a "${bad}" segment, a value is missing: ${p}`);
    }
  }
  return p;
}

export const REPO_ROOT = assertPath(
  realpathSync(fileURLToPath(new URL("../..", import.meta.url))),
  "REPO_ROOT",
);
export const E2E_DIR = assertPath(join(REPO_ROOT, "e2e"), "E2E_DIR");
export const OUT_DIR = assertPath(join(E2E_DIR, ".out"), "OUT_DIR");
export const PATCHES_DIR = assertPath(join(E2E_DIR, "patches"), "PATCHES_DIR");
export const SPECS_DIR = assertPath(join(E2E_DIR, "specs"), "SPECS_DIR");
export const SELFTEST_DIR = assertPath(join(E2E_DIR, "selftest"), "SELFTEST_DIR");

/**
 * The per-user state root, independent of TMPDIR (and of XDG_CACHE_HOME, which
 * a sandbox may also rewrite): only HOME decides it. Created 0700.
 */
function stateRoot() {
  const cache = join(realpathSync(homedir()), ".cache");
  const root = join(cache, "bikeshed-e2e");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return realpathSync(root);
}

export const E2E_TMP = assertPath(stateRoot(), "E2E_TMP");
export const LOCKS_DIR = assertPath(join(E2E_TMP, "locks"), "LOCKS_DIR");
export const STACKS_DIR = assertPath(join(E2E_TMP, "stacks"), "STACKS_DIR");

/** A run id: lowercase, digits and dashes, safe inside doc ids and email local parts. */
export const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{3,39}$/;

export function assertRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new Error(`not a valid run id: ${JSON.stringify(runId)} (want ${RUN_ID_RE})`);
  }
  return runId;
}

/** `yymmddhhmm-xxxx`, e.g. `2610101432-k3x9`: sortable, short, collision-resistant. */
export function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    p(now.getFullYear() % 100) + p(now.getMonth() + 1) + p(now.getDate()) +
    p(now.getHours()) + p(now.getMinutes());
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return assertRunId(`${stamp}-${rand}`);
}

export function runDir(runId) {
  return assertPath(join(OUT_DIR, assertRunId(runId)), "runDir");
}

export function logsDir(runId) {
  return assertPath(join(runDir(runId), "logs"), "logsDir");
}

export function stackDir(runId) {
  return assertPath(join(STACKS_DIR, assertRunId(runId)), "stackDir");
}

export function treeDir(runId) {
  return assertPath(join(stackDir(runId), "tree"), "treeDir");
}

/** mkdir -p, after the same assertion every other path gets. */
export function ensureDir(p, label = "dir") {
  assertPath(p, label);
  mkdirSync(p, { recursive: true });
  return p;
}

/** Join under a root and refuse to escape it. */
export function within(root, ...parts) {
  assertPath(root, "root");
  const p = resolve(root, ...parts);
  if (p !== root && !p.startsWith(root + sep)) {
    throw new Error(`${p} escapes ${root}`);
  }
  return assertPath(p, "within");
}
