// SPDX-License-Identifier: Apache-2.0
// Self-test: Functions-emulator workers: the room a burst waits for (admitWorkers), the stack's workers read by mark and runtime, the idle ones retired through the Emulator Hub's reload, and a static warm-up URL (SPEC §12).

/**
 * admitWorkers is driven with a stand-in ctx and memory sampler, and once
 * through the real scenario() (a generated spec under node --test, the worker
 * figure raised far past any machine and E2E_POOL_WAIT_MS 0), which must end
 * the case INCONCLUSIVE before the rest of its body. functionWorkers reads
 * REAL processes: workers started by helpers/fake-functions-emulator.mjs as
 * firebase-tools starts them (the stack's mark, FUNCTION_TARGET, the runtime
 * on the command line), beside decoys that lack one of the three.
 * retireIdleWorkers runs against that stand-in's hub: a PUT
 * /functions/enableBackgroundTriggers reloads, ending idle workers at once and
 * a busy one after its request.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { E2E_DIR, OUT_DIR, REPO_ROOT } from "../lib/paths.mjs";
import { CASE_TIMEOUT_ENV } from "../lib/budget.mjs";
import { GIB, MIB } from "../lib/load.mjs";
import {
  FUNCTION_WORKER_ENV, FUNCTION_WORKER_MB, RELOAD_PATH, STATIC_WARM_PATH, WORKERS_GATE,
  admitWorkers, functionWorkerBytes, functionWorkers, retireIdleWorkers, staticWarmUrl, workerNeedBytes,
} from "../lib/workers.mjs";
import { tempDir } from "./helpers/tmp.mjs";
import { firebaseTools } from "../lib/prerequisites.mjs";
import { firebaseBehavior } from "./helpers/firebase-probes.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = tempDir("e2e-workers-");
const spawned = [];
after(() => {
  for (const p of spawned) {
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {}
  }
});

// --- admitWorkers -------------------------------------------------------------------

const reading = (availableGb) => ({ at: new Date().toISOString(), level: 1, freePct: 50, memsize: 64 * GIB, availableBytes: availableGb * GIB, swapUsedBytes: 0, swapTotalBytes: 0, swapoutsDelta: null, windowMs: 0 });
function stubCtx(target) {
  const steps = [];
  return {
    target,
    steps,
    step: (l) => steps.push(l),
    inconclusive(reason) {
      const e = new Error(`INCONCLUSIVE: ${reason}`);
      e.code = "E2E_INCONCLUSIVE";
      e.reason = reason;
      throw e;
    },
  };
}
const LOCAL = { kind: "local", runId: "2610131300-wk00", origin: "http://127.0.0.1:9" };

test("the worker figure: 250 MB each, raised by E2E_FUNCTION_WORKER_MB and never lowered; a burst needs the pool's headroom plus one worker per request", () => {
  assert.equal(FUNCTION_WORKER_MB, 250);
  assert.equal(functionWorkerBytes({}), 250 * MIB);
  assert.equal(functionWorkerBytes({ [FUNCTION_WORKER_ENV]: "400" }), 400 * MIB);
  for (const bad of ["100", "249", "0", "-5", "abc"]) assert.throws(() => functionWorkerBytes({ [FUNCTION_WORKER_ENV]: bad }), /may only raise the worker figure/, bad);
  assert.equal(workerNeedBytes(5, { thresholds: { poolBaseBytes: 2 * GIB }, workerBytes: 250 * MIB }), 2 * GIB + 5 * 250 * MIB);
  for (const bad of [0, -1, 1.5, "3", null]) assert.throws(() => workerNeedBytes(bad), TypeError);
});

test("admitWorkers: room at once resolves without a step; a wait is logged to load.jsonl and stepped; no room is INCONCLUSIVE naming the split; production samples nothing", async () => {
  const ctx = stubCtx(LOCAL);
  const roomy = await admitWorkers(ctx, { requests: 3, sample: async () => reading(40), env: {} });
  assert.equal(roomy.ok, true);
  assert.equal(roomy.needBytes, 2 * GIB + 3 * 250 * MIB);
  assert.equal(roomy.waitedMs, 0);
  assert.deepEqual(ctx.steps, []);

  const log = join(dir, "load.jsonl");
  let calls = 0;
  const waited = await admitWorkers(ctx, { requests: 4, what: "the C19 burst", sample: async () => reading(++calls < 3 ? 1 : 40), timeoutMs: 5_000, pollMs: 10, logFile: log, env: {} });
  assert.equal(waited.ok, true);
  assert.ok(waited.waitedMs > 0);
  assert.equal(ctx.steps.length, 1);
  assert.match(ctx.steps[0], /^environment: waited \d+ s for 3\.0 GB available before the C19 burst \(2 GB \+ 4 × 250 MB, one Functions-emulator worker per concurrent request\)$/);
  const rows = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.event), ["memory-wait", "memory-gate-open"]);
  assert.ok(rows.every((r) => r.gate === WORKERS_GATE && r.requests === 4 && r.need.minAvailableBytes === 2 * GIB + 4 * 250 * MIB));

  await assert.rejects(
    admitWorkers(stubCtx(LOCAL), { requests: 3, sample: async () => reading(1), timeoutMs: 0, logFile: null, env: {} }),
    (e) => e.code === "E2E_INCONCLUSIVE" && /^the machine never had room for 3 concurrent function request\(s\): it needs 2\.7 GB available \(2 GB \+ 3 × 250 MB, one Functions-emulator worker per concurrent request\), and has 1\.0 GB, after 0 s$/.test(e.reason),
  );
  await assert.rejects(
    admitWorkers(stubCtx(LOCAL), { requests: 2, sample: async () => reading(3), timeoutMs: 0, logFile: null, env: { [FUNCTION_WORKER_ENV]: "1024" } }),
    (e) => e.code === "E2E_INCONCLUSIVE" && /needs 4\.0 GB available \(2 GB \+ 2 × 1024 MB/.test(e.reason),
    "a raised figure raises the need",
  );

  const prod = await admitWorkers(stubCtx({ kind: "prod", runId: "2610131300-wk09", origin: "https://x.invalid" }), { requests: 50, sample: async () => assert.fail("production samples nothing") });
  assert.deepEqual({ ok: prod.ok, needBytes: prod.needBytes }, { ok: true, needBytes: 0 });
  assert.match(prod.skipped, /not a local stack \(prod\)/);

  for (const bad of [{}, { requests: 0 }, { requests: 2, what: "" }, { requests: 2, timeoutMs: -1 }, { requests: 2, pollMs: 0 }, { requests: 2, sample: 3 }]) {
    await assert.rejects(admitWorkers(stubCtx(LOCAL), bad), TypeError, JSON.stringify(bad));
  }
  await assert.rejects(admitWorkers({ target: LOCAL }, { requests: 1 }), TypeError, "a ctx without inconclusive");
});

test("through the real scenario(): a burst the machine has no room for ends the case INCONCLUSIVE before the rest of its body", { timeout: 90_000 }, async () => {
  const runId = `selftest-workers-${process.pid}`;
  const runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  after(() => rmSync(runDir, { recursive: true, force: true }));
  const marks = join(dir, "bodies");
  mkdirSync(marks, { recursive: true });
  const lib = (f) => pathToFileURL(join(E2E_DIR, "lib", f)).href;
  const spec = join(dir, "burst.spec.mjs");
  writeFileSync(spec, `// fixture spec, generated by selftest/workers.test.mjs
import { writeFileSync } from "node:fs";
import { scenario } from ${JSON.stringify(lib("test.mjs"))};
import { admitWorkers } from ${JSON.stringify(lib("workers.mjs"))};
scenario("burst", { trials: 1, timeoutMs: 30_000 }, async (ctx) => {
  writeFileSync(${JSON.stringify(marks)} + "/before", "ran");
  await admitWorkers(ctx, { requests: 4, what: "the fixture's burst" });
  writeFileSync(${JSON.stringify(marks)} + "/after", "ran");
});
`);
  const targetFile = join(dir, "target.json");
  writeFileSync(targetFile, JSON.stringify({ kind: "local", runId, runDir, origin: "http://127.0.0.1:9", projectId: "demo-bikeshed", capabilities: ["local"], stack: { ports: { hosting: 9 } } }));
  const env = { ...process.env, E2E_TARGET: targetFile, E2E_RUN_ID: runId, E2E_SUITE: "concurrency", [FUNCTION_WORKER_ENV]: "100000000", E2E_POOL_WAIT_MS: "0" };
  for (const k of ["NODE_TEST_CONTEXT", CASE_TIMEOUT_ENV, "E2E_INVOCATION_DIR", "E2E_N", "E2E_TRIALS"]) delete env[k];
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", "--test-concurrency=1", spec], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const killer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 60_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, out });
    });
  });
  assert.deepEqual(readdirSync(marks).sort(), ["before"], `the body stopped at admitWorkers:\n${r.out}`);
  assert.match(r.out, /outcome=inconclusive:.*the machine never had room for the fixture's burst: it needs [\d.]+ GB available \(2 GB \+ 4 × 100000000 MB, one Functions-emulator worker per concurrent request\)/, r.out);
});

// --- functionWorkers and retireIdleWorkers -----------------------------------------------

const MARK = `2610131300-wk01.${"ab12cd34ef56ab78"}`;
const OTHER_MARK = `2610131300-wk99.${"0000111122223333"}`;
const stackDir = join(dir, "stacks", "2610131300-wk01");
const tree = join(stackDir, "tree");
const logFile = join(dir, "out", "logs", "emulators.log");
mkdirSync(join(tree, "functions"), { recursive: true });
mkdirSync(join(dir, "out", "logs"), { recursive: true });
writeFileSync(join(stackDir, "stack.json"), JSON.stringify({ runId: "2610131300-wk01", mark: MARK }));
writeFileSync(logFile, "");
const baseTarget = { kind: "local", runId: "2610131300-wk01", runDir: join(dir, "out"), origin: "http://127.0.0.1:9", stack: { stackDir, treeDir: tree, ports: { hosting: 9 }, logs: { emulators: logFile } } };
/** The target of a stand-in hub on `port`: its hubUrl and that port among the stack's. */
const targetOn = (port) => ({ ...baseTarget, hubUrl: `http://127.0.0.1:${port}`, stack: { ...baseTarget.stack, ports: { hosting: 9, hub: port } } });
const CONC = { E2E_SUITE: "concurrency" };
const reloadLines = () => readFileSync(logFile, "utf8").split("\n").filter((l) => /Loaded functions definitions from source/.test(l)).length;

async function startFake(workers, { reloadMs = 100, status = 200 } = {}) {
  const k = spawned.length;
  const cfgFile = join(dir, `fake-${k}.json`);
  const infoFile = join(dir, `fake-${k}.info.json`);
  writeFileSync(cfgFile, JSON.stringify({ logFile, infoFile, mark: MARK, workers, reloadMs, status }));
  const child = spawn(process.execPath, [join(E2E_DIR, "selftest", "helpers", "fake-functions-emulator.mjs"), cfgFile], { stdio: "ignore" });
  spawned.push(child);
  const info = await until(() => existsSync(infoFile) && JSON.parse(readFileSync(infoFile, "utf8")), "the stand-in hub listening");
  return { child, info, infoFile, target: targetOn(info.port), reloads: () => JSON.parse(readFileSync(infoFile, "utf8")).reloads };
}
function decoy(env, withRuntime = true) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", ...(withRuntime ? ["functionsEmulatorRuntime"] : ["some-other-node-process"])], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: "ignore" });
  spawned.push(child);
  return child;
}
async function until(fn, what, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await sleep(50);
  }
}

test("functionWorkers: exactly the processes with the stack's mark, a FUNCTION_TARGET and the worker runtime, by entry point with their RSS", { timeout: 60_000 }, async () => {
  const fake = await startFake([{ entryPoint: "createDoc", busyMs: 0 }, { entryPoint: "createDoc", busyMs: 0 }, { entryPoint: "forkDoc", busyMs: 0 }]);
  decoy({ E2E_STACK_MARK: MARK });
  decoy({ E2E_STACK_MARK: OTHER_MARK, FUNCTION_TARGET: "createDoc" });
  decoy({ E2E_STACK_MARK: MARK, FUNCTION_TARGET: "createDoc" }, false);
  const w = await until(() => {
    const r = functionWorkers(fake.target);
    return r.count === 3 ? r : null;
  }, "three workers seen");
  assert.equal(w.mark, MARK);
  assert.deepEqual(w.workers.map((x) => x.pid), fake.info.workers.map((p) => p.pid).sort((a, b) => a - b));
  assert.deepEqual(Object.fromEntries(Object.entries(w.byEntryPoint).map(([k, v]) => [k, v.count])), { createDoc: 2, forkDoc: 1 });
  assert.ok(w.workers.every((x) => x.rssBytes > 0), "each with its RSS");
  assert.equal(w.rssBytes, w.workers.reduce((a, x) => a + x.rssBytes, 0));
  assert.equal(functionWorkers({ kind: "prod", runId: "x" }), null);
  assert.throws(() => functionWorkers({ ...baseTarget, stack: { ...baseTarget.stack, stackDir: dir }, runDir: dir }), /names no mark/);
  fake.child.kill("SIGTERM");
  await until(() => functionWorkers(fake.target).count === 0, "the stand-in's workers gone");
});

test("retireIdleWorkers: one PUT to the stack's own hub reloads; idle workers go at once, a busy one after its request (counted retired when it ends within settleMs); the reload line is kept as evidence", { timeout: 60_000 }, async () => {
  const fake = await startFake([{ entryPoint: "verifyEmail", busyMs: 0 }, { entryPoint: "verifyEmail", busyMs: 0 }, { entryPoint: "mcp", busyMs: 400 }, { entryPoint: "oauth", busyMs: 2_500 }]);
  await until(() => functionWorkers(fake.target).count === 4, "four workers");
  const lines = reloadLines();
  const r = await retireIdleWorkers(fake.target, { env: CONC, settleMs: 1_200, timeoutMs: 10_000, pollMs: 25 });
  assert.equal(r.reloaded, true, JSON.stringify(r));
  assert.equal(r.status, 200);
  assert.equal(fake.reloads(), 1, "one reload asked of the hub");
  assert.equal(reloadLines() - lines, 1);
  assert.match(r.line, /Loaded functions definitions from source/);
  assert.equal(r.before.count, 4);
  assert.deepEqual(r.retired.map((w) => w.entryPoint).sort(), ["mcp", "verifyEmail", "verifyEmail"], "the idle ones, and the busy one that finished within settleMs");
  assert.deepEqual(r.remaining.map((w) => w.entryPoint), ["oauth"], "the busy worker still finishing past settleMs");
  assert.deepEqual(r.started, []);
  assert.equal(r.after.count, 1);
  assert.match(r.summary, /^the Functions emulator reloaded: 3 of 4 worker\(s\) retired \([\d.]+ GB\), 1 still busy, 0 started since; 1 now/);
  await until(() => functionWorkers(fake.target).count === 0, "the busy worker exits after its request");

  const again = await retireIdleWorkers(fake.target, { env: CONC, settleMs: 300, timeoutMs: 10_000, pollMs: 25 });
  assert.equal(again.reloaded, true);
  assert.equal(fake.reloads(), 2);
  assert.deepEqual([again.before.count, again.retired.length], [0, 0]);
  fake.child.kill("SIGTERM");
});

test("retireIdleWorkers is refused outside the concurrency tier and for a hub that is not the stack's own, asking nothing; a hub that refuses or never answers is reloaded: false; production is skipped", { timeout: 60_000 }, async () => {
  const fake = await startFake([{ entryPoint: "sitemap", busyMs: 0 }]);
  await until(() => functionWorkers(fake.target).count === 1, "one worker");
  await assert.rejects(retireIdleWorkers(fake.target, { env: { E2E_SUITE: "functional" } }), (e) => e.code === "E2E_SHARED_STACK" && /refused outside the concurrency tier \(E2E_SUITE=functional\)/.test(e.message));
  await assert.rejects(retireIdleWorkers(fake.target, { env: {} }), (e) => e.code === "E2E_SHARED_STACK");
  await assert.rejects(retireIdleWorkers({ ...fake.target, stack: { ...fake.target.stack, ports: { hosting: 9 } } }, { env: CONC }), /is not run 2610131300-wk01's own Emulator Hub/);
  await assert.rejects(retireIdleWorkers({ ...fake.target, hubUrl: `http://localhost:${fake.info.port}` }, { env: CONC }), /own Emulator Hub/);
  await assert.rejects(retireIdleWorkers({ ...fake.target, hubUrl: undefined }, { env: CONC }), TypeError);
  assert.equal(fake.reloads(), 0, "nothing was asked of the hub");
  assert.equal(functionWorkers(fake.target).count, 1, "and the worker is still there");
  fake.child.kill("SIGTERM");

  const refusing = await startFake([], { status: 500 });
  const no = await retireIdleWorkers(refusing.target, { env: CONC, settleMs: 0, timeoutMs: 5_000 });
  assert.equal(no.reloaded, false);
  assert.match(no.reason, /the Emulator Hub answered 500 to PUT \/functions\/enableBackgroundTriggers/);
  assert.match(no.summary, /did not reload/);
  refusing.child.kill("SIGTERM");

  const slow = await startFake([], { reloadMs: 5_000 });
  const late = await retireIdleWorkers(slow.target, { env: CONC, settleMs: 0, timeoutMs: 300 });
  assert.equal(late.reloaded, false);
  assert.match(late.reason, /did not answer PUT \/functions\/enableBackgroundTriggers within 300 ms/);
  slow.child.kill("SIGTERM");

  assert.deepEqual(await retireIdleWorkers({ kind: "prod", runId: "x" }, { env: CONC }), { reloaded: false, skipped: "not a local stack (prod): no Functions emulator to reload" });
  for (const bad of [{ timeoutMs: -1 }, { settleMs: 1.5 }, { scan: 3 }, { fetchImpl: null }]) await assert.rejects(retireIdleWorkers(baseTarget, { env: CONC, ...bad }), TypeError, JSON.stringify(bad));
});

test("the installed firebase-tools: the hub's PUT route reloads the triggers, a reload refreshes the worker pools (idle killed, busy finishing), and the source watcher ignores every path under ~/.cache", async (t) => {
  assert.equal(RELOAD_PATH, "/functions/enableBackgroundTriggers");
  const firebase = firebaseTools({ optional: true });
  if (!firebase) return t.skip("firebase-tools is not installed here");
  const { root } = firebase;
  t.diagnostic(`firebase-tools ${firebase.version}: ${firebase.bin}`);
  const emu = join(root, "lib", "emulator");
  const hub = readFileSync(join(emu, "hub.js"), "utf8");
  const fe = readFileSync(join(emu, "functionsEmulator.js"), "utf8");
  const pool = readFileSync(join(emu, "functionsRuntimeWorker.js"), "utf8");
  assert.ok(hub.includes(`PATH_ENABLE_FUNCTIONS = "${RELOAD_PATH}"`), "hub.js names the route");
  assert.match(hub, /app\.put\(EmulatorHub\.PATH_ENABLE_FUNCTIONS, async \(req, res\) => \{[\s\S]{0,600}?await emu\.reloadTriggers\(\);\s*res\.status\(200\)/, "the PUT awaits reloadTriggers, then answers 200");
  assert.match(fe, /async reloadTriggers\(\) \{[\s\S]{0,400}?await this\.loadTriggers\(backend\);/, "reloadTriggers loads every backend's triggers");
  assert.match(fe, /async loadTriggers\(emulatableBackend, force = false\) \{[\s\S]{0,900}?this\.workerPools\[emulatableBackend\.codebase\]\.refresh\(\);/, "loadTriggers refreshes the worker pool");
  assert.match(pool, /refresh\(\) \{[\s\S]{0,300}?if \(w\.state === RuntimeWorkerState\.IDLE\) \{[\s\S]{0,200}?w\.runtime\.process\.kill\(\);[\s\S]{0,200}?else if \(w\.state === RuntimeWorkerState\.BUSY\) \{[\s\S]{0,200}?w\.state = RuntimeWorkerState\.FINISHING;/, "refresh kills IDLE workers and lets BUSY ones finish");
  assert.match(fe, /path\.join\(__dirname, "functionsEmulatorRuntime"\)/, "a worker runs functionsEmulatorRuntime");
  assert.match(fe, /envs\.FUNCTION_TARGET = /, "with FUNCTION_TARGET in its env");
  const judge = ({ watched }) => {
    assert.equal(watched.length, 1, "one source watcher was requested");
    const ignored = watched[0].options.ignored;
    const matches = (path) => ignored.some((rule) => rule instanceof RegExp && rule.test(path));
    assert.ok(matches("/users/probe/.cache/bikeshed-e2e/stacks/r/tree/functions/lib/index.js"), "a cached stack path is ignored");
    assert.equal(matches("/users/probe/work/functions/lib/index.js"), false, "ordinary source is not mistaken for a dotfile");
  };
  judge(await firebaseBehavior(root));
  // Remove the dotfile rule independent of its position in the ignored array.
  const dotfileLine = fe.split("\n").find((line) => line.includes("/(^|[\\/\\\\])\\../"));
  assert.ok(dotfileLine, "the watcher control found the installed dotfile rule");
  const withoutDotfiles = await firebaseBehavior(root, { source: fe.replace(dotfileLine, "") });
  assert.throws(() => judge(withoutDotfiles), /a cached stack path is ignored/, "NEGATIVE: dropping the dotfile rule is detected");
});

// --- the static warm-up ---------------------------------------------------------------

test("staticWarmUrl: the static file a racer warms its socket on, checked in a local stack's build; it is static in the app and in firebase.json", () => {
  const appDist = join(tree, "app", "dist");
  assert.throws(() => staticWarmUrl({ ...baseTarget, origin: "http://127.0.0.1:39001" }), /\/site\.webmanifest is not in the stack's built app/);
  mkdirSync(appDist, { recursive: true });
  writeFileSync(join(appDist, "site.webmanifest"), "{}");
  assert.equal(staticWarmUrl({ ...baseTarget, origin: "http://127.0.0.1:39001" }), "http://127.0.0.1:39001/site.webmanifest");
  assert.equal(staticWarmUrl({ kind: "prod", origin: "https://example.invalid" }), "https://example.invalid/site.webmanifest");
  assert.throws(() => staticWarmUrl({}), TypeError);

  assert.equal(STATIC_WARM_PATH, "/site.webmanifest");
  assert.ok(existsSync(join(REPO_ROOT, "app", "public", "site.webmanifest")), "app/public/site.webmanifest (vite copies it into app/dist)");
  const hosting = JSON.parse(readFileSync(join(REPO_ROOT, "firebase.json"), "utf8")).hosting;
  const fns = (hosting.rewrites ?? []).filter((r) => r.function && (r.source === STATIC_WARM_PATH || r.source === "**"));
  assert.deepEqual(fns, [], "no function is rewritten onto it");
  assert.ok((hosting.rewrites ?? []).some((r) => r.source === "/config" && r.function), "GET /config IS a function (appConfig): why it is no warm-up");
  const readme = readFileSync(join(E2E_DIR, "README.md"), "utf8");
  const guarded = readme.slice(readme.indexOf("**Guarded SYNC-T.**"), readme.indexOf("The listen gate, also `lib/sync.mjs`"));
  assert.match(guarded, /warm: staticWarmUrl\(ctx\.target\)/, "README's guarded SYNC-T example warms statically");
  assert.doesNotMatch(guarded, /warm: `\$\{ctx\.target\.origin\}\/config`/);
});
