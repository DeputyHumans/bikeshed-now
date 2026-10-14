// SPDX-License-Identifier: Apache-2.0
// One invocation of run.mjs: its own results directory under the run, its filters, and the node --test argv (SPEC §12).

/**
 * Several invocations can share one run: `run --attach <runId>` from parallel
 * agents against one kept stack. Each gets a directory nobody else writes:
 *
 *   e2e/.out/<runId>/invocations/<invId>/
 *     invocation.json       who ran what: argv, suite, the planned files per
 *                           tier, --spec/--grep/--n, tree, patches
 *     results-<tier>.jsonl  the reporter's records
 *     results.json, summary.md   the merge of the files above, and only them
 *     load.jsonl, http.jsonl, evidence/<case>/
 *
 * <invId> is `<UTC yyyymmddThhmmssZ>-p<pid>-<4 random>`, and the directory is
 * made with a plain mkdir that retries on EEXIST, so two invocations can never
 * get the same one and none ever deletes another's files.
 *
 * A run of a spec file outside e2e/specs (run.mjs --spec-file, lib/specfile.mjs)
 * is the same kind of invocation under e2e/.out/<runId>/scratch/<invId>/
 * (SCRATCH_INVOCATIONS_DIR) instead, which the run's report, merge and
 * classify never list.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { assertPath } from "./paths.mjs";

export const INVOCATIONS_DIR = "invocations";
/** Where a --spec-file run's invocation goes, beside invocations/ and out of every listing of it. */
export const SCRATCH_INVOCATIONS_DIR = "scratch";
export const INVOCATION_ID_RE = /^\d{8}T\d{6}Z-p\d+-[a-z0-9]{4}$/;

export function newInvocationId(now = new Date(), pid = process.pid) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${stamp}-p${pid}-${rand}`;
}

/**
 * Make this invocation's directory under `runDir`, exclusively, and write its
 * invocation.json. `under` is INVOCATIONS_DIR (the default) or
 * SCRATCH_INVOCATIONS_DIR (a --spec-file run).
 * @returns {{id:string, dir:string, meta:object}}
 */
export function createInvocation(runDir, meta = {}, { under = INVOCATIONS_DIR } = {}) {
  assertPath(runDir, "runDir");
  if (under !== INVOCATIONS_DIR && under !== SCRATCH_INVOCATIONS_DIR) throw new Error(`createInvocation: under is "${INVOCATIONS_DIR}" or "${SCRATCH_INVOCATIONS_DIR}", got ${JSON.stringify(under)}`);
  const parent = join(runDir, under);
  mkdirSync(parent, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = newInvocationId();
    const dir = join(parent, id);
    try {
      mkdirSync(dir);
    } catch (err) {
      if (err.code === "EEXIST") continue;
      throw err;
    }
    const full = { id, pid: process.pid, startedAt: new Date().toISOString(), ...meta };
    writeFileSync(join(dir, "invocation.json"), JSON.stringify(full, null, 2) + "\n");
    return { id, dir: assertPath(dir, "invocation dir"), meta: full };
  }
  throw new Error(`could not make an invocation directory under ${parent}`);
}

export function readInvocationMeta(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "invocation.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Record more about an invocation (how it ended) in its invocation.json. */
export function updateInvocationMeta(dir, patch) {
  const now = readInvocationMeta(dir) ?? {};
  writeFileSync(join(dir, "invocation.json"), JSON.stringify({ ...now, ...patch }, null, 2) + "\n");
}

/**
 * The directory a spec process writes evidence under: E2E_INVOCATION_DIR when
 * it is inside the target's run directory, else the run directory itself.
 */
export function evidenceRoot(target, env = process.env) {
  const inv = env.E2E_INVOCATION_DIR;
  if (inv) {
    assertPath(inv, "E2E_INVOCATION_DIR");
    const rel = relative(target.runDir, inv);
    if (!rel || rel.startsWith("..") || rel.startsWith(sep)) throw new Error(`E2E_INVOCATION_DIR ${inv} is not inside run ${target.runDir}`);
    return inv;
  }
  return target.runDir;
}

/**
 * The argv for one `node --test` over spec files: the human `spec` reporter on
 * stdout and the JSONL reporter into `resultsFile`. run.mjs and the self-test
 * both build it here, so what the self-test proves is what a run does.
 *
 * --test-force-exit: a body that never settles (a held route, a page.evaluate
 * with no timeout) must not keep the file's process — and so the run — alive
 * after every case has been reported.
 */
export function nodeTestArgs({ files, resultsFile, reporter, concurrency = 1, timeout = null, grep = null }) {
  const args = ["--test", "--test-force-exit", `--test-concurrency=${concurrency}`];
  if (timeout) args.push(`--test-timeout=${timeout}`);
  args.push("--test-reporter=spec", "--test-reporter-destination=stdout");
  if (reporter && resultsFile) args.push(`--test-reporter=${reporter}`, `--test-reporter-destination=${resultsFile}`);
  if (grep) args.push(`--test-name-pattern=${grep}`);
  args.push(...files);
  return args;
}
