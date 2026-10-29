// SPDX-License-Identifier: Apache-2.0
// The e2e entry point: stack lifecycle, spec runs against a Target, reaping, self-tests (SPEC §12).

/**
 * Usage:
 *   node e2e/run.mjs run [--target local] [--tree HEAD|<rev>|worktree]
 *                        [--suite smoke|functional|concurrency|all]
 *                        [--spec <path-substring>]... [--grep <re>] [--n 2,5,10,20] [--trials <k>]
 *                        [--spec-file <absolute path>]...   (with --attach; lib/specfile.mjs)
 *                        [--keep] [--attach <runId>] [--install] [--patches <set>]...
 *                        [--email-off] [--app-env KEY=VALUE]... [--rtdb-proxy] [--gates] [--storage-shim]
 *                        [--jvm-heap <role>=<size>]... [--ttl <hours>]
 *                        [--concurrency <k>] [--timeout <ms>] [--max-load <x>] [--report-json <file>]
 *   node e2e/run.mjs stack up [--tree …] [--install] [--keep-ui] [--patches <set>]...
 *                             [--email-off] [--app-env KEY=VALUE]... [--rtdb-proxy] [--gates] [--storage-shim]
 *                             [--jvm-heap <role>=<size>]... [--ttl <hours>]
 *   node e2e/run.mjs stack down <runId> [--keep-tree]
 *   node e2e/run.mjs stack status [--json]
 *   node e2e/run.mjs reap [--all] [<runId>...]
 *   node e2e/run.mjs report <ref> [--merge] | compare <a> <b>
 *   node e2e/run.mjs classify [--merge] <ref> <id> <H|E|P|I|U> <note…>
 *   node e2e/run.mjs controls [<set>...] [--tree HEAD|<rev>]
 *   node e2e/run.mjs --self-test
 *
 * Stack options (lib/options.mjs), for `run` without --attach and for
 * `stack up`: --email-off (the product's own off switch: RESEND_API_KEY is a
 * single space), --app-env KEY=VALUE (an allowlisted app build variable;
 * VITE_FIREBASE_MEASUREMENT_ID=dummy builds the app with a generated dummy
 * id), --rtdb-proxy (the app dials RTDB through the aux process's latency
 * proxy), --gates (the gate service; implied by any amplify-* set) and
 * --storage-shim (the functions reach Storage through the aux process's shim,
 * which refuses a second create-only write or copy: lib/storage-shim.mjs).
 * They are recorded in stack.json and target.json as capabilities.
 *
 * --trials <k> runs every scenario k times per N, whatever it declares (for
 * authoring: E2E_TRIALS in the spec process; lib/test.mjs).
 *
 * Tier locks (lib/locks.mjs tierLockMode): smoke and functional take the
 * SHARED lock; concurrency takes the EXCLUSIVE one (a measurement run) unless
 * every N --n selects is at most 2 and --trials is at most 2 (an authoring
 * run), which takes the SHARED one, so authors validate in parallel. No --n or
 * no --trials is a measurement run. The memory gate, the stack cap and the
 * concurrency load gate apply whatever the mode. Each tier's lock (mode, why,
 * when, how long it waited) is recorded as `locks` in invocation.json (so in
 * results.json and --report-json) and is a line of summary.md.
 *
 * Specs reach the target ONLY through E2E_TARGET (a target.json path) and
 * e2e/lib/. The spec process gets the caller's env minus every deployment
 * binding, plus the stack's emulator hosts for a local target.
 *
 * Time: node --test's --test-timeout bounds each FILE. Without --timeout, a
 * tier gets the largest file budget among its files (lib/budget.mjs: a
 * spec's E2E_FILE_TIMEOUT_MS, or the sum of its cases' own timeouts), never
 * less than DEFAULT_TIMEOUT, and E2E_CASE_TIMEOUT_MS = DEFAULT_TIMEOUT for a
 * case with none of its own. --timeout <ms> is both, as before.
 *
 * Each `run` is one INVOCATION with its own directory,
 * e2e/.out/<runId>/invocations/<invId>/ (lib/invocation.mjs): parallel
 * `--attach` runs on one stack never see, delete or merge each other's results.
 *
 * --spec-file runs a spec file OUTSIDE e2e/specs (a scratch copy mutated for
 * a negative control) against an attached stack, in the one tier --suite
 * names (functional or concurrency), exactly as a spec runs. Its invocation
 * goes to e2e/.out/<runId>/scratch/<invId>/, out of the run's report and
 * merged view (lib/specfile.mjs says what it refuses, and why).
 *
 * Memory (lib/load.mjs, admission.mjs, jvm.mjs, lifetime.mjs, watchdog.mjs,
 * browsers.mjs): a stack starts only with enough free memory and a free slot
 * under E2E_MAX_STACKS live stacks; every JVM it starts has a heap cap
 * (--jvm-heap lowers one); a kept stack expires (--ttl, 4 h by default; each
 * --attach makes it at least 2 h from then; never past 8 h) and its watchdog
 * stops it then; while specs run, a stack whose emulator died ends the run,
 * naming the emulator; every Chrome carries a mark naming this run, and one
 * whose run is gone is stopped by reap.
 *
 * Exit codes of `run`: 0 all good (a known defect failing as expected, or NOT
 * REPRODUCED — its trial never reached the defect's window — included: both
 * are listed, with each scenario's "<defect> seen in s of K trials", never
 * counted as a pass); 1 a case failed, the stack failed or was
 * stopped under the run, or the stack's teardown left something running; 2
 * usage; 3 a case ended INCONCLUSIVE, or the concurrency load gate, the
 * memory gate or the stack cap never let it start; 130 interrupted (SIGINT,
 * SIGTERM, SIGHUP — the spec processes and a stack this run started are
 * stopped first). `stack up` exits 3 when the memory gate or the stack cap
 * never let the stack start.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { E2E_DIR, OUT_DIR, REPO_ROOT, SELFTEST_DIR, SPECS_DIR, assertRunId, runDir as runDirFor } from "./lib/paths.mjs";
import { acquireTierLock, tierLockMode } from "./lib/locks.mjs";
import { DEFAULT_MAX_LOAD, GIB, startLoadSampler, waitForLoad } from "./lib/load.mjs";
import { listStacks, readRecord, reap, saveRecord, stackFailures, startStack, stopStack } from "./lib/stack.mjs";
import { ADMISSION_CODE } from "./lib/admission.mjs";
import { coverageMaintenanceEligible } from "./lib/rtdb-coverage.mjs";
import { beginRtdbInvocationChild, captureRtdbRuntime, writeRtdbInvocationEvidence } from "./lib/rtdb-runtime.mjs";
import { jvmHeapConfig } from "./lib/jvm.mjs";
import { extendLease, readLease } from "./lib/lifetime.mjs";
import { RUN_OWNER_ENV, reapBrowsers, runOwnerValue } from "./lib/browsers.mjs";
import { PROD_NOT_IMPLEMENTED, loadTarget, specEnv } from "./lib/target.mjs";
import { groupAlive } from "./lib/proc.mjs";
import { MERGED_MD, classify, classifyMerged, compareMarkdown, compareRuns, countsLine, mergeInvocations, mergeRun, rateLine, tierLocksLine } from "./lib/report.mjs";
import { INVOCATIONS_DIR, SCRATCH_INVOCATIONS_DIR, createInvocation, nodeTestArgs, updateInvocationMeta } from "./lib/invocation.mjs";
import { assertTargetDeclared, controlVerdict, findTarget, greenGroups, greenRunArgs, listControlSets, makeControlsDir, readControl, redRunArgs } from "./lib/controls.mjs";
import { parseAppEnvArgs } from "./lib/options.mjs";
import { CASE_TIMEOUT_ENV, tierTimeouts } from "./lib/budget.mjs";
import { assertSpecsParse, specFilePlan } from "./lib/specfile.mjs";
import { node24, selfTestToolchain } from "./lib/prerequisites.mjs";
import { relFile } from "./lib/reporter.mjs";

/**
 * A suite is tiers in order; `only` narrows a tier to named spec files. The
 * smoke suite is the canaries and then the functional smoke spec: a quick
 * pass over the main paths, with the tier locks and timeouts of each tier.
 */
const SUITES = {
  smoke: [{ tier: "smoke" }, { tier: "functional", only: ["smoke.spec.mjs"] }],
  functional: [{ tier: "functional" }],
  concurrency: [{ tier: "concurrency" }],
  all: [{ tier: "smoke" }, { tier: "functional" }, { tier: "concurrency" }],
};
const DEFAULT_TIMEOUT = { smoke: 120_000, functional: 600_000, concurrency: 1_800_000 };
const DEFAULT_CONCURRENCY = { smoke: 1, functional: 4, concurrency: 1 };
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

const log = (m) => process.stderr.write(`[e2e] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message, code = 2) {
  process.stderr.write(`e2e: ${message}\n`);
  process.exit(code);
}

function specFiles(tier, filters, only = null) {
  const dir = join(SPECS_DIR, tier);
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".spec.mjs") && (!only || only.includes(name))) out.push(p);
    }
  };
  walk(dir);
  return filters.length === 0 ? out : out.filter((p) => filters.some((f) => relative(REPO_ROOT, p).includes(f)));
}

/**
 * One `node --test` over spec files, in its OWN process group (so an
 * interrupt can stop it and everything under it, and a terminal's Ctrl-C
 * reaches it only through us). Resolves the exit code; `onChild` gets the
 * child while it runs.
 */
function nodeTest(files, { concurrency, timeout, grep, env, resultsFile, onChild }) {
  const reporter = join(E2E_DIR, "lib", "reporter.mjs");
  const args = nodeTestArgs({ files, resultsFile, reporter: existsSync(reporter) ? "./e2e/lib/reporter.mjs" : null, concurrency, timeout, grep });
  log(`node ${args.slice(0, 7).join(" ")} … (${files.length} file(s))`);
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "inherit", "inherit"], detached: true });
    onChild?.(child);
    child.on("close", (code, signal) => {
      onChild?.(null);
      resolveRun(code ?? (signal ? 1 : 0));
    });
  });
}

/** Stop a detached child's whole group: SIGINT, then SIGTERM, then SIGKILL. */
async function stopChildGroup(child, { graceMs = 10_000 } = {}) {
  if (!child?.pid) return;
  const done = new Promise((r) => (child.exitCode != null || child.signalCode != null ? r() : child.once("close", r)));
  for (const [sig, wait] of [["SIGINT", graceMs], ["SIGTERM", 5000], ["SIGKILL", 2000]]) {
    try {
      process.kill(-child.pid, sig);
    } catch {
      return;
    }
    if (await Promise.race([done.then(() => true), sleep(wait).then(() => false)])) return;
  }
}

async function selfTest() {
  let toolchain;
  try {
    toolchain = selfTestToolchain();
  } catch (err) {
    fail(`self-test prerequisites: ${err.message}`);
  }
  log(`self-test toolchain: ${JSON.stringify({ node: toolchain.node, firebase: toolchain.firebase })}`);
  const files = readdirSync(SELFTEST_DIR).filter((n) => n.endsWith(".test.mjs")).sort().map((n) => join(SELFTEST_DIR, n));
  if (files.length === 0) fail("no self-tests found");
  const lock = await acquireTierLock("shared", { runId: `selftest-${process.pid}`, tier: "selftest", onWait: (why) => log(`waiting for the self-test tier lock: ${why}`) });
  let code;
  try {
    const child = spawn(toolchain.node.executable, ["--test", "--test-concurrency=2", "--test-force-exit", "--test-reporter=spec", ...files], { cwd: REPO_ROOT, env: toolchain.env, stdio: "inherit", detached: true });
    const stop = () => { void stopChildGroup(child); };
    for (const signal of SIGNALS) process.on(signal, stop);
    try {
      code = await new Promise((resolveRun, reject) => {
        child.once("error", reject);
        child.once("close", (c) => resolveRun(c ?? 1));
      });
    } finally {
      for (const signal of SIGNALS) process.off(signal, stop);
    }
  } finally {
    lock.release();
  }
  process.exit(code);
}

function aliveCheck(runId) {
  const rec = readRecord(runId);
  if (!rec) fail(`no stack ${runId}`);
  if (rec.state !== "ready") fail(`stack ${runId} is ${rec.state}, not ready${rec.failure?.reason ? `: ${rec.failure.reason}` : rec.stopReason?.reason ? ` (${rec.stopReason.reason})` : ""}`);
  const dead = (rec.processes ?? []).filter((p) => p.name !== "watchdog" && !groupAlive(p.pgid));
  if (dead.length > 0) fail(`stack ${runId}: ${dead.map((d) => d.name).join(", ")} not running`);
  const failures = stackFailures(rec);
  if (failures.length > 0) fail(`stack ${runId} failed: ${failures.map((f) => f.reason).join("; ")}`);
  if ((rec.processes ?? []).some((p) => p.name === "watchdog" && !groupAlive(p.pgid))) log(`stack ${runId}: its watchdog is not running, so nothing will stop it at expiry; stop it yourself when done`);
  return rec;
}

/** Stop orphans of crashed runs (and expired stacks, and orphaned browsers) before starting anything (kept stacks and failed trees stay). */
async function autoReap() {
  try {
    const r = await reap({ auto: true, log });
    if (r.stacks.length || r.locksRemoved.length) log(`reaped orphans: ${JSON.stringify(r)}`);
  } catch (err) {
    log(`reap of orphans failed (continuing): ${err.message}`);
  }
  try {
    const b = await reapBrowsers({ log });
    if (b.stopped.length) log(`reaped ${b.stopped.length} orphaned Chrome group(s) or process(es)`);
  } catch (err) {
    log(`reap of orphaned browsers failed (continuing): ${err.message}`);
  }
}

/**
 * While specs run against a stack: every `everyMs`, whether it is still
 * there. An emulator that died (named: one that ran out of memory says so),
 * an essential process gone, or a stack stopped under the run (its lease
 * expired, somebody stopped it) calls `onDown(reason, failures)` once.
 */
function watchStack(runId, onDown, everyMs = 10_000) {
  let told = false;
  const timer = setInterval(() => {
    if (told) return;
    const rec = readRecord(runId);
    let reason = null;
    let failures = [];
    if (!rec) reason = `the record of stack ${runId} is gone`;
    else if (rec.state === "failed") reason = `stack ${runId} FAILED: ${rec.failure?.reason ?? String(rec.error ?? "").split("\n")[0]}`;
    else if (rec.state !== "ready") reason = `stack ${runId} is ${rec.state}${rec.stopReason?.reason ? ` (${rec.stopReason.by}: ${rec.stopReason.reason})` : ""}`;
    else {
      failures = stackFailures(rec);
      if (failures.length) reason = `stack ${runId} FAILED: ${failures.map((f) => f.reason).join("; ")}`;
    }
    if (reason) {
      told = true;
      onDown(reason, failures);
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

function parseTtl(text) {
  if (text === undefined) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) fail(`--ttl wants hours above 0, got ${JSON.stringify(text)}`);
  return n;
}

async function cmdRun(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: "string", default: "local" },
      tree: { type: "string", default: "HEAD" },
      suite: { type: "string", default: "functional" },
      spec: { type: "string", multiple: true, default: [] },
      "spec-file": { type: "string", multiple: true, default: [] },
      grep: { type: "string" },
      n: { type: "string" },
      keep: { type: "boolean", default: false },
      attach: { type: "string" },
      install: { type: "boolean", default: false },
      patches: { type: "string", multiple: true, default: [] },
      concurrency: { type: "string" },
      timeout: { type: "string" },
      "max-load": { type: "string" },
      "report-json": { type: "string" },
      "email-off": { type: "boolean", default: false },
      "app-env": { type: "string", multiple: true, default: [] },
      "jvm-heap": { type: "string", multiple: true, default: [] },
      ttl: { type: "string" },
      "rtdb-proxy": { type: "boolean", default: false },
      gates: { type: "boolean", default: false },
      "storage-shim": { type: "boolean", default: false },
      trials: { type: "string" },
    },
  });
  if (values.target === "prod") fail(PROD_NOT_IMPLEMENTED);
  if (values.target !== "local") fail(`unknown target ${values.target}`);
  const tiers = SUITES[values.suite];
  if (!tiers) fail(`unknown suite ${values.suite} (smoke|functional|concurrency|all)`);
  if (values.n && !/^\d+(,\d+)*$/.test(values.n)) fail(`--n wants a list like 2,5,10,20`);
  if (values.trials !== undefined && !/^[1-9]\d{0,2}$/.test(values.trials)) fail(`--trials wants a whole number of trials from 1 to 999, got ${JSON.stringify(values.trials)}`);
  if (values.grep) new RegExp(values.grep);
  if (values.attach && values.patches.length) fail("--patches builds a stack; it cannot apply to an attached one");
  if (values.attach && (values["email-off"] || values["app-env"].length)) fail("--email-off and --app-env build a stack; they cannot apply to an attached one (its target.json says how it was built)");
  if (values.attach && (values["rtdb-proxy"] || values.gates)) fail("--rtdb-proxy and --gates build a stack; they cannot apply to an attached one (its target.json says how it was built)");
  if (values.attach && values["storage-shim"]) fail("--storage-shim builds a stack; it cannot apply to an attached one (its target.json says how it was built)");
  if (values.attach && (values["jvm-heap"].length || values.ttl !== undefined)) fail("--jvm-heap and --ttl build a stack; they cannot apply to an attached one (an attach extends its lease by itself)");
  let appEnv;
  let jvmHeap;
  try {
    appEnv = parseAppEnvArgs(values["app-env"]);
    jvmHeap = jvmHeapConfig(values["jvm-heap"]);
  } catch (err) {
    fail(err.message);
  }
  const ttlHours = parseTtl(values.ttl);
  if (ttlHours != null && !values.keep) fail("--ttl is the lease of a kept stack (--keep); a stack the run stops lives until the run ends (8 h at most)");

  if (values.timeout !== undefined && !/^[1-9]\d*$/.test(values.timeout)) fail(`--timeout wants a positive number of milliseconds, got ${JSON.stringify(values.timeout)}`);
  // A scratch spec file (lib/specfile.mjs): checked here, before any reap or stack.
  let scratch = null;
  try {
    scratch = specFilePlan({ specFiles: values["spec-file"], spec: values.spec, attach: values.attach ?? null, suite: values.suite });
  } catch (err) {
    fail(err.message);
  }
  const plan = scratch ? [{ tier: scratch.tier, files: scratch.files }] : tiers.map(({ tier, only }) => ({ tier, files: specFiles(tier, values.spec, only) })).filter((p) => p.files.length > 0);
  if (plan.length === 0) fail(`no spec files matched suite ${values.suite}${values.spec.length ? ` and --spec ${values.spec.join(" ")}` : ""}`);
  // The run's own selection, as the spec process will read it (E2E_N, E2E_TRIALS).
  const selection = { n: values.n ? values.n.split(",").map(Number) : null, trials: values.trials ? Number(values.trials) : null };
  // Each tier's file timeout, before any stack starts: a malformed
  // E2E_FILE_TIMEOUT_MS is a usage error, not a failed run.
  for (const p of plan) {
    // The tier lock it will take: an authoring concurrency run (every N <= 2, trials <= 2) shares, any other is alone.
    p.tierLock = tierLockMode(p.tier, selection);
    try {
      // `tier`: the spec process runs these files with E2E_SUITE = p.tier, so the budget counts their trials as it will.
      p.budget = tierTimeouts(p.files, { defaultMs: DEFAULT_TIMEOUT[p.tier], explicitMs: values.timeout ? Number(values.timeout) : null, trialsOverride: values.trials ? Number(values.trials) : null, tier: p.tier });
    } catch (err) {
      fail(err.message);
    }
  }

  try { assertSpecsParse(plan.flatMap(p => p.files), node24().executable); } catch (err) { fail(err.message); }
  await autoReap();

  // --- interrupt handling: one teardown, whoever asks first -----------------
  const ac = new AbortController();
  let stackRec = null; // set as soon as startStack makes the record
  let startPromise = null;
  let startFailed = false;
  let child = null; // the running node --test
  let lock = null; // the held tier lock
  let stopSampler = null;
  let inv = null;
  let rtdbBefore = null;
  let interrupted = null;
  let finishing = null;
  let stopWatch = null;
  let stackDown = null; // why the stack went away under the run
  // Per tier, the lock it takes (tierLockMode), then when it got it and how long it waited.
  const locks = Object.fromEntries(plan.map((p) => [p.tier, { ...p.tierLock }]));

  const finish = (code) =>
    (finishing ??= (async () => {
      let exit = code;
      stopWatch?.();
      if (child) await stopChildGroup(child);
      // A Chrome of this run that outlived its spec process (browsers.mjs).
      await reapBrowsers({ log }).catch((err) => log(`reap of orphaned browsers failed: ${err.message}`));
      try {
        lock?.release();
      } catch {}
      stopSampler?.();
      if (startPromise) await startPromise.catch(() => undefined);
      let teardown = null;
      if (stackRec && !startFailed && !values.keep) {
        // The record on disk, not this process's copy: the watchdog may have
        // marked the stack failed (naming the emulator) or stopped it already.
        const current = readRecord(stackRec.runId) ?? stackRec;
        // A failed run keeps its tree to be read; an interrupted one does not.
        teardown = await stopStack(current, { keepTree: exit !== 0 && !interrupted, log }).catch((err) => ({ state: "error", error: err.message, survivors: [] }));
        if (teardown.state !== "stopped" && !(teardown.state === "failed" && stackDown && !(teardown.survivors ?? []).length)) {
          const pg = [...new Set([...(teardown.survivors ?? []).map((s) => s.pgid), ...(teardown.unverified ?? []).map((u) => u.pgid)])];
          log(`teardown of stack ${stackRec.runId} ended "${teardown.state}"${pg.length ? `; still running: pgid ${pg.join(", ")}` : ""}${teardown.error ? ` (${teardown.error})` : ""} — stop it with: node e2e/run.mjs stack down ${stackRec.runId}`);
          exit = exit || 1;
        }
      } else if (stackRec && !startFailed) {
        log(`kept: stack ${stackRec.runId} at ${stackRec.origin}; stop with: node e2e/run.mjs stack down ${stackRec.runId}`);
      }
      let summary = null;
      if (inv) {
        try {
          summary = mergeRun(inv.dir).summary;
          log(`${countsLine(summary.counts, summary.total)} — ${join(inv.dir, "summary.md")}`);
          const lockLine = tierLocksLine(locks);
          if (lockLine) log(lockLine);
          if (stackDown) log(`the stack went down under the run (${stackDown}): the cases it cut short have no record above`);
          if (summary.counts.inconclusive > 0) {
            log(`${summary.counts.inconclusive} case(s) INCONCLUSIVE: neither a pass nor a fail`);
            exit = exit || 3;
          }
          // NOT REPRODUCED is listed and never counted as a pass, and leaves the exit as a TODO does.
          if (summary.counts["not-reproduced"] > 0) log(`${summary.counts["not-reproduced"]} case(s) NOT REPRODUCED: a known defect's trial never reached the defect's window; listed, never counted as a pass`);
          for (const r of summary.rates ?? []) log(`rate: ${rateLine(r)}`);
        } catch (err) {
          log(`no merged report: ${err.message}`);
        }
        updateInvocationMeta(inv.dir, { endedAt: new Date().toISOString(), exit, interrupted, stackDown, teardown: teardown && { state: teardown.state, survivors: teardown.survivors ?? [] } });
        log(`results in ${inv.dir}`);
      }
      if (values["report-json"]) {
        try {
          writeFileSync(values["report-json"], JSON.stringify({ runId: stackRec?.runId ?? values.attach ?? null, invocationDir: inv?.dir ?? null, exit, interrupted, stackDown, teardown: teardown?.state ?? null, locks, summary }, null, 2) + "\n");
        } catch (err) {
          log(`could not write ${values["report-json"]}: ${err.message}`);
        }
      }
      process.exit(exit);
    })());

  const onSignal = (sig) => {
    if (interrupted) {
      log(`${sig} again: already stopping`);
      return;
    }
    interrupted = sig;
    log(`${sig}: stopping the spec run${stackRec && !values.keep ? `, then stack ${stackRec.runId}` : ""}`);
    ac.abort(new Error(`interrupted by ${sig}`));
    void finish(130);
  };
  for (const sig of SIGNALS) process.on(sig, onSignal);

  // --- the target -------------------------------------------------------------
  let target;
  let targetFile;
  if (values.attach) {
    assertRunId(values.attach);
    const rec = aliveCheck(values.attach);
    // An attach keeps a kept stack alive: at least 2 h from now, never past its hard maximum.
    const ext = rec.stackDir ? extendLease(rec.stackDir, { by: { pid: process.pid, argv: process.argv.slice(2) } }) : null;
    if (ext) log(`stack ${values.attach} expires ${ext.to}${ext.addedMs > 0 ? ` (extended by ${Math.round(ext.addedMs / 60_000)} min)` : " (not extended: it already had longer)"}${ext.capped ? `, the hard maximum ${ext.lease.hardExpiresAt}` : ""}`);
    else log(`stack ${values.attach} has no lease (an older harness built it): nothing will stop it at expiry`);
    targetFile = join(runDirFor(values.attach), "target.json");
    target = loadTarget(targetFile);
  } else {
    startPromise = startStack({ tree: values.tree, install: values.install, keep: values.keep, patchSets: values.patches, emailOff: values["email-off"], appEnv, rtdbProxy: values["rtdb-proxy"], gates: values.gates, storageShim: values["storage-shim"], jvmHeap, ttlHours, log, signal: ac.signal, onRecord: (r) => (stackRec = r) });
    try {
      const started = await startPromise;
      target = started.target;
      targetFile = started.targetFile;
    } catch (err) {
      startFailed = true; // startStack tore down what it started
      if (interrupted) return finishing;
      if (err.code === ADMISSION_CODE) {
        log(`the stack was not started: ${err.message}`);
        return finish(3);
      }
      log(`the stack did not start: ${String(err.message).split("\n")[0]}`);
      return finish(1);
    } finally {
      startPromise = null;
    }
  }
  if (interrupted) return finishing;
  // A stack that dies under the run ends it at once, naming what died.
  stopWatch = watchStack(target.runId, (reason, failures) => {
    stackDown = reason;
    log(`${reason} — stopping the spec run`);
    // This run's own stack is recorded failed, with the reason, before its
    // teardown (an attached one is left to its watchdog, which does the same
    // and then stops it: a record marked failed here would end the watchdog).
    if (failures.length && !values.attach) {
      const cur = readRecord(target.runId);
      if (cur?.state === "ready") {
        cur.state = "failed";
        cur.error = reason;
        cur.failure = { at: new Date().toISOString(), by: "run", reason: failures.map((f) => f.reason).join("; "), failures };
        try {
          saveRecord(cur);
        } catch {}
      }
    }
    void finish(1);
  });

  try {
    inv = createInvocation(target.runDir, {
      runId: target.runId,
      argv: process.argv.slice(2),
      suite: values.suite,
      // relFile: relative to the repo, or absolute outside it, as the reporter writes a case's file.
      plan: plan.map((p) => ({ tier: p.tier, files: p.files.map((f) => relFile(f)) })),
      spec: values.spec,
      ...(scratch ? { specFile: scratch.files, scratch: true } : {}),
      grep: values.grep ?? null,
      n: selection.n,
      trials: selection.trials,
      // Per tier, the tier lock this run takes: {mode, authoring, reason}, then acquiredAt and waitedMs.
      locks,
      tree: values.attach ? null : values.tree,
      patches: values.patches,
      attach: values.attach ?? null,
      stackOptions: values.attach ? null : { emailOff: values["email-off"], appEnv: Object.keys(appEnv), rtdbProxy: values["rtdb-proxy"], gates: values.gates, storageShim: values["storage-shim"] },
      capabilities: [...target.capabilities].sort(),
      rtdbEngine: target.rtdbEngine ?? null,
      parallelism: Object.fromEntries(plan.map(({ tier }) => [tier, Number(values.concurrency ?? DEFAULT_CONCURRENCY[tier])])),
      timeouts: Object.fromEntries(
        plan.map(({ tier, budget: b }) => [
          tier,
          { fileTimeoutMs: b.fileTimeoutMs, caseTimeoutMs: b.caseTimeoutMs, explicit: b.explicit, driver: b.driver && relFile(b.driver), files: b.files.map((f) => ({ file: relFile(f.file), budgetMs: f.budgetMs, declaredMs: f.declaredMs, cases: f.cases, sumMs: f.sumMs, unresolved: f.unresolved.length })) },
        ]),
      ),
    }, { under: scratch ? SCRATCH_INVOCATIONS_DIR : INVOCATIONS_DIR });
    log(scratch ? `invocation ${inv.id} (--spec-file: ${inv.dir}, outside the run's report and merged view; read it with: node e2e/run.mjs report ${inv.dir})` : `invocation ${inv.id}`);
    stopSampler = startLoadSampler(join(inv.dir, "load.jsonl"));
    let exit = 0;
    for (const { tier, files, budget, tierLock } of plan) {
      if (interrupted) break;
      const mode = tierLock.mode;
      log(`${tier}: the ${mode.toUpperCase()} tier lock — ${tierLock.reason}`);
      const asked = Date.now();
      lock = await acquireTierLock(tierLock.mode, { runId: target.runId, tier, onWait: (why) => log(`waiting for the ${mode} tier lock: ${why}`) });
      locks[tier] = { ...tierLock, acquiredAt: new Date().toISOString(), waitedMs: Date.now() - asked };
      const recycleCoverage = coverageMaintenanceEligible(target, tier, mode, Number(values.concurrency ?? DEFAULT_CONCURRENCY[tier]));
      updateInvocationMeta(inv.dir, { locks, maintenance: { rtdbCoverage: recycleCoverage } });
      try {
        if (tier === "concurrency") {
          const max = Number(values["max-load"] ?? DEFAULT_MAX_LOAD);
          const gate = await waitForLoad({ max, onWait: (s) => log(`load ${s.one.toFixed(1)} ≥ ${max}; waiting`) });
          if (!gate.ok) {
            log(`load gate never opened (1-min load ${gate.sample.one.toFixed(1)}); concurrency tier NOT run`);
            exit = exit || 3;
            continue;
          }
        }
        if (interrupted) break;
        const env = specEnv(target, targetFile);
        // Every Chrome a spec launches carries this run's identity (browsers.mjs).
        env[RUN_OWNER_ENV] = runOwnerValue();
        env.E2E_SUITE = tier;
        env.E2E_INVOCATION_DIR = inv.dir;
        if (recycleCoverage) env.E2E_RTDB_COVERAGE_RECYCLE = "1";
        else delete env.E2E_RTDB_COVERAGE_RECYCLE;
        env.E2E_EVIDENCE_DIR = inv.dir;
        if (values.n) env.E2E_N = values.n;
        if (values.trials) env.E2E_TRIALS = values.trials;
        env[CASE_TIMEOUT_ENV] = String(budget.caseTimeoutMs);
        log(
          budget.explicit
            ? `${tier}: --timeout ${budget.fileTimeoutMs} ms for each file and each case without its own`
            : `${tier}: file timeout ${budget.fileTimeoutMs} ms (${budget.driver ? `${relFile(budget.driver)}'s budget` : "the tier default"}); a case without its own timeoutMs gets ${budget.caseTimeoutMs} ms`,
        );
        if (target.rtdbEngine) {
          const rec = readRecord(target.runId);
          rtdbBefore = await beginRtdbInvocationChild({ rec, invocationId: inv.id, invocationDir: inv.dir, before: rtdbBefore, parallelism: inv.meta.parallelism, locks }, { record: reference => updateInvocationMeta(inv.dir, { rtdbRuntime: reference }) });
        }
        const code = await nodeTest(files, {
          concurrency: Number(values.concurrency ?? DEFAULT_CONCURRENCY[tier]),
          timeout: budget.fileTimeoutMs,
          grep: values.grep,
          env,
          resultsFile: join(inv.dir, `results-${tier}.jsonl`),
          onChild: (c) => (child = c),
        });
        if (target.rtdbEngine) {
          const rec = readRecord(target.runId), after = await captureRtdbRuntime(rec);
          const reference = writeRtdbInvocationEvidence({ rec, invocationId: inv.id, invocationDir: inv.dir, before: rtdbBefore, after, parallelism: inv.meta.parallelism, locks });
          updateInvocationMeta(inv.dir, { rtdbRuntime: reference });
        }
        log(`${tier}: node --test exited ${code}`);
        if (code !== 0) exit = exit || code;
        if (stackDown) return finishing;
      } finally {
        lock?.release();
        lock = null;
      }
      // The canaries decide whether anything after them can be trusted.
      if (tier === "smoke" && exit !== 0) {
        const rest = plan.slice(plan.findIndex((p) => p.tier === tier) + 1).map((p) => p.tier);
        if (rest.length) log(`the smoke canaries failed: a harness problem, so ${rest.join(", ")} did not run`);
        break;
      }
    }
    if (interrupted) return finishing;
    return finish(exit);
  } catch (err) {
    if (interrupted) return finishing;
    log(`run failed: ${err.stack || err.message}`);
    return finish(1);
  }
}

async function cmdStack(argv) {
  const [sub, ...rest] = argv;
  if (sub === "up") {
    const { values } = parseArgs({
      args: rest,
      options: {
        tree: { type: "string", default: "HEAD" },
        install: { type: "boolean", default: false },
        "keep-ui": { type: "boolean", default: false },
        patches: { type: "string", multiple: true, default: [] },
        target: { type: "string", default: "local" },
        "email-off": { type: "boolean", default: false },
        "app-env": { type: "string", multiple: true, default: [] },
        "jvm-heap": { type: "string", multiple: true, default: [] },
        ttl: { type: "string" },
        "rtdb-proxy": { type: "boolean", default: false },
        gates: { type: "boolean", default: false },
        "storage-shim": { type: "boolean", default: false },
      },
    });
    if (values.target !== "local") fail(values.target === "prod" ? PROD_NOT_IMPLEMENTED : `unknown target ${values.target}`);
    let appEnv;
    let jvmHeap;
    try {
      appEnv = parseAppEnvArgs(values["app-env"]);
      jvmHeap = jvmHeapConfig(values["jvm-heap"]);
    } catch (err) {
      fail(err.message);
    }
    const ttlHours = parseTtl(values.ttl);
    await autoReap();
    // An interrupt while the stack starts tears down what was started.
    const ac = new AbortController();
    const onSignal = (sig) => {
      log(`${sig}: abandoning the start`);
      ac.abort(new Error(`interrupted by ${sig}`));
    };
    for (const sig of SIGNALS) process.on(sig, onSignal);
    let started;
    try {
      started = await startStack({
        tree: values.tree,
        install: values.install,
        keep: true,
        keepUi: values["keep-ui"],
        patchSets: values.patches,
        emailOff: values["email-off"],
        appEnv,
        rtdbProxy: values["rtdb-proxy"],
        gates: values.gates,
        storageShim: values["storage-shim"],
        jvmHeap,
        ttlHours,
        log,
        signal: ac.signal,
      });
    } catch (err) {
      if (err.code === ADMISSION_CODE) fail(`the stack was not started: ${err.message}`, 3);
      fail(`the stack did not start: ${String(err.message).split("\n")[0]}`, ac.signal.aborted ? 130 : 1);
    }
    const { target, targetFile, record } = started;
    const lease = readLease(record.stackDir);
    process.stdout.write(JSON.stringify({ runId: target.runId, origin: target.origin, ports: target.stack.ports, targetFile, mailpitUrl: target.mail.mailpitUrl, shimUrl: target.mail.shimUrl, capabilities: [...target.capabilities].sort(), options: target.options, jvmHeapMb: record.jvm.heapMb, owner: record.owner, expiresAt: lease?.expiresAt ?? null, hardExpiresAt: lease?.hardExpiresAt ?? null }, null, 2) + "\n");
    process.exit(0);
  }
  if (sub === "down") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { "keep-tree": { type: "boolean", default: false } } });
    if (positionals.length !== 1) fail("usage: stack down <runId> [--keep-tree]");
    const runId = assertRunId(positionals[0]);
    const r = await stopStack(runId, { keepTree: values["keep-tree"], log });
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    process.exit(r.state === "stopped" || r.state === "failed" ? 0 : 1);
  }
  if (sub === "status") {
    const { values } = parseArgs({ args: rest, options: { json: { type: "boolean", default: false } } });
    const stacks = listStacks({ resources: true });
    if (values.json) process.stdout.write(JSON.stringify(stacks, null, 2) + "\n");
    else if (stacks.length === 0) process.stdout.write("no stacks\n");
    else {
      const gb = (b) => `${(b / GIB).toFixed(2)} GB`;
      const until = (iso) => {
        if (!iso) return "-";
        const ms = Date.parse(iso) - Date.now();
        const m = Math.round(Math.abs(ms) / 60_000);
        return `${iso} (${ms >= 0 ? "in" : "past, by"} ${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")})`;
      };
      for (const s of stacks) {
        const procs = (s.processes ?? []).map((p) => `${p.name}:${p.alive ? "up" : "down"}`).join(" ");
        process.stdout.write(`${s.runId}  ${s.state}${s.keep ? " (kept)" : ""}  ${s.ports ?? "-"}  ${s.origin ?? "-"}  ${procs}\n`);
        if (s.state === "unknown") continue;
        process.stdout.write(`    owner     pid ${s.owner?.pid ?? "?"}${s.owner?.startedAt ? ` started ${s.owner.startedAt}` : ""} — ${s.owner?.alive ? "alive" : "gone"}\n`);
        process.stdout.write(`    expires   ${until(s.expiresAt)}; hard maximum ${until(s.hardExpiresAt)}\n`);
        if (s.rss) process.stdout.write(`    rss       ${gb(s.rss.totalBytes)} over ${s.rss.processes} marked process(es): ${Object.entries(s.rss.by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${gb(v)}`).join(", ") || "-"}\n`);
        if (s.jvmHeapMb) process.stdout.write(`    jvm heap  ${Object.entries(s.jvmHeapMb).map(([k, v]) => `${k} ${v}m`).join(", ")}\n`);
        if (s.failure) process.stdout.write(`    FAILED    ${s.failure}\n`);
        if (s.stopReason) process.stdout.write(`    stopping  ${s.stopReason}\n`);
      }
    }
    process.exit(0);
  }
  fail("usage: stack up|down <runId>|status");
}

async function cmdReap(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { all: { type: "boolean", default: false } } });
  for (const id of positionals) assertRunId(id);
  const r = await reap({ all: values.all, runIds: positionals, log });
  // Chrome processes whose run is gone (browsers.mjs): only ones carrying the browser mark.
  r.browsers = await reapBrowsers({ log }).catch((err) => ({ error: err.message }));
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  process.exit(0);
}

/** Run this file again as a child `run`, its output into `logFile`; resolves its report-json. */
function childRun(args, { logFile, reportFile }) {
  return new Promise((resolveRun) => {
    const out = [];
    const child = spawn(process.execPath, [join(E2E_DIR, "run.mjs"), "run", ...args, "--report-json", reportFile], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const take = (c) => {
      out.push(c);
      process.stderr.write(c);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const forward = (sig) => child.kill(sig);
    for (const sig of SIGNALS) process.on(sig, forward);
    child.on("close", (code) => {
      for (const sig of SIGNALS) process.off(sig, forward);
      writeFileSync(logFile, Buffer.concat(out.map((c) => Buffer.from(c))));
      let report = null;
      try {
        report = JSON.parse(readFileSync(reportFile, "utf8"));
      } catch {}
      resolveRun({ code, report });
    });
  });
}

/**
 * A control's stacks fail on purpose, and a failed run keeps its tree to be
 * read; the ledger and the run's e2e/.out directory hold everything a control
 * needs, so its tree is removed (only a stack that is fully stopped).
 */
async function discardTree(report) {
  const id = report?.runId;
  if (!id || report.teardown !== "stopped") return;
  try {
    await reap({ runIds: [id], log: () => {} });
  } catch (err) {
    log(`could not remove the tree of ${id}: ${err.message}`);
  }
}

function casesOf(report) {
  if (!report?.invocationDir) return [];
  try {
    return JSON.parse(readFileSync(join(report.invocationDir, "results.json"), "utf8")).cases ?? [];
  } catch {
    return [];
  }
}

/**
 * Negative controls: for each set, its target case must FAIL (with the
 * expected message) on a stack built with the set applied, and PASS on one
 * built without — with the suite and stack options its control.json names.
 * A target named as an expanded case, "<scenario> [N=<k>]", runs on both
 * sides with --n <k> --trials 1 (lib/controls.mjs targetSelection).
 * The clean side is one stack per distinct (suite, stack options, selection
 * arguments). Writes
 * e2e/.out/controls-<stamp>[-<rand4>]/ledger.json, a directory of its own.
 */
async function cmdControls(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { tree: { type: "string", default: "HEAD" } } });
  const sets = positionals.length ? positionals : listControlSets();
  if (sets.length === 0) fail("no control sets under e2e/patches/controls-*");
  const controls = sets.map((s) => readControl(s));
  // The selection: a literal case, or an expanded "<scenario> [N=<k>]" run with --n <k> --trials 1 (lib/controls.mjs).
  for (const c of controls) c.selection = assertTargetDeclared(c);
  // Created exclusively: two invocations started in the same second get two directories.
  const dir = makeControlsDir(OUT_DIR);
  const sha = (() => {
    try {
      return execFileSync("git", ["rev-parse", values.tree === "worktree" ? "HEAD" : values.tree], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  })();
  const ledger = { startedAt: new Date().toISOString(), tree: values.tree, commit: sha, green: null, controls: [] };
  let interrupted = null;
  const stopHere = (sig) => {
    interrupted ??= sig;
  };
  for (const sig of SIGNALS) process.on(sig, stopHere);
  const bail = () => {
    ledger.endedAt = new Date().toISOString();
    ledger.interrupted = interrupted;
    ledger.ok = false;
    save();
    log(`controls interrupted by ${interrupted}; ledger so far: ${join(dir, "ledger.json")}`);
    process.exit(130);
  };
  const save = () => writeFileSync(join(dir, "ledger.json"), JSON.stringify(ledger, null, 2) + "\n");
  log(`controls: ${controls.map((c) => c.set).join(", ")} → ${dir}`);

  // GREEN: every target once, on a clean stack — one per (suite, stack options).
  const groups = greenGroups(controls);
  const greenCases = [];
  ledger.green = [];
  for (const [i, g] of groups.entries()) {
    const greenArgs = greenRunArgs(g, { tree: values.tree });
    const tag = groups.length === 1 ? "green" : `green-${i + 1}`;
    log(`GREEN${groups.length > 1 ? ` ${i + 1}/${groups.length}` : ""}: ${greenArgs.join(" ")}`);
    const green = await childRun(greenArgs, { logFile: join(dir, `${tag}.log`), reportFile: join(dir, `${tag}.json`) });
    greenCases.push(...casesOf(green.report));
    ledger.green.push({ args: greenArgs, exit: green.code, runId: green.report?.runId ?? null, invocationDir: green.report?.invocationDir ?? null, log: join(dir, `${tag}.log`), sets: g.controls.map((c) => c.set) });
    save();
    await discardTree(green.report);
    if (interrupted) bail();
  }

  let allOk = true;
  for (const c of controls) {
    const args = redRunArgs(c, { tree: values.tree });
    log(`RED ${c.set} (${c.oracle}): ${c.what}`);
    const red = await childRun(args, { logFile: join(dir, `${c.set}.log`), reportFile: join(dir, `${c.set}.json`) });
    await discardTree(red.report);
    if (interrupted) bail();
    const redRec = findTarget(casesOf(red.report), c);
    const greenRec = findTarget(greenCases, c);
    const verdict = controlVerdict(c, { red: redRec, green: greenRec });
    const brief = (r) => r && { status: r.status, message: r.error?.message?.split("\n")[0]?.slice(0, 400) ?? null, evidenceDir: r.evidenceDir ?? null };
    ledger.controls.push({
      set: c.set,
      oracle: c.oracle,
      what: c.what,
      patches: c.patches,
      target: c.target,
      selection: c.selection,
      stack: c.stack,
      expect: c.expect,
      red: { exit: red.code, runId: red.report?.runId ?? null, invocationDir: red.report?.invocationDir ?? null, case: brief(redRec), log: join(dir, `${c.set}.log`) },
      green: brief(greenRec),
      ok: verdict.ok,
      problems: verdict.problems,
    });
    save();
    log(`${c.set}: ${verdict.ok ? "OK — red with the patch, green without" : `NOT OK — ${verdict.problems.join("; ")}`}`);
    if (!verdict.ok) allOk = false;
  }
  ledger.endedAt = new Date().toISOString();
  ledger.ok = allOk;
  save();
  await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify({ ok: allOk, ledger: join(dir, "ledger.json"), controls: ledger.controls.map((c) => ({ set: c.set, oracle: c.oracle, ok: c.ok, red: c.red.case?.status ?? null, green: c.green?.status ?? null, problems: c.problems })) }, null, 2)}\n`, (error) => error ? reject(error) : resolve()));
  process.exit(allOk ? 0 : 1);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "--self-test" || cmd === "self-test") await selfTest();
  else if (cmd === "run") await cmdRun(rest);
  else if (cmd === "stack") await cmdStack(rest);
  else if (cmd === "reap") await cmdReap(rest);
  else if (cmd === "controls") await cmdControls(rest);
  else if (cmd === "report") {
    const merge = rest.includes("--merge");
    const args = rest.filter((a) => a !== "--merge");
    if (args.length !== 1) fail("usage: report <runId|runId/invId|dir> | report <runId|dir> --merge");
    if (merge) {
      const { dir } = mergeInvocations(args[0]);
      process.stdout.write(readFileSync(join(dir, MERGED_MD), "utf8"));
      process.exit(0);
    }
    const { dir } = mergeRun(args[0]);
    process.stdout.write(readFileSync(join(dir, "summary.md"), "utf8"));
    process.exit(0);
  } else if (cmd === "compare") {
    if (rest.length !== 2) fail("usage: compare <a> <b>");
    const r = compareRuns(rest[0], rest[1]);
    process.stdout.write(compareMarkdown(rest[0], rest[1], r));
    process.exit(r.regressions.length > 0 || r.lost.length > 0 ? 1 : 0);
  } else if (cmd === "classify") {
    // --merge: the id is looked up in the run's merged view (every invocation).
    const at = rest.indexOf("--merge");
    const merge = at >= 0 && at < 3;
    const args = merge ? rest.filter((_, i) => i !== at) : rest;
    if (args.length < 4) fail("usage: classify [--merge] <run> <id|unique substring> <H|E|P|I|U> <note…>");
    const [run, id, cls, ...note] = args;
    process.stdout.write(JSON.stringify((merge ? classifyMerged : classify)(run, id, cls, note.join(" ")), null, 2) + "\n");
    process.exit(0);
  }
  else if (cmd === "--target" && rest[0] === "prod") fail(PROD_NOT_IMPLEMENTED);
  else fail("usage: run.mjs run|stack up|stack down <runId>|stack status|reap|report|compare|classify|controls|--self-test  (see the header of e2e/run.mjs)");
} catch (err) {
  fail(err.stack || err.message, 1);
}
