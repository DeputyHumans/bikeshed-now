// SPDX-License-Identifier: Apache-2.0
// The life of one isolated local stack: tree, build, Mailpit, shim, emulators, readiness, teardown (SPEC §12).

/**
 * One stack = one port block + one tree copy + four process groups:
 *
 *   mailpit     --listen/--smtp on the block, unlimited store
 *   shim        e2e/lib/mail/shim.mjs (Resend's POST /emails → Mailpit)
 *   emulators   firebase emulators:start --only auth,firestore,database,
 *               functions,hosting,storage, cwd = the tree copy
 *
 * Each is spawned DETACHED (its own process group) with an allowlisted env and
 * its own TMPDIR — firebase-tools writes hub-<project>.json into os.tmpdir(),
 * so two demo-bikeshed stacks sharing one would find each other's hub — and
 * its own HOME. Under the real HOME the emulator found the user's gcloud
 * Application Default Credentials ("Non-emulated services will access
 * production using these credentials") and would have handed them to every
 * function; firebase-tools would also read the user's login. The emulator
 * additionally gets, explicitly and never inherited:
 *   CI=true                                    no MOTD fetch, no update check
 *   FIREBASE_EMULATORS_PATH=<real ~/.cache/…>  the cached jars, so no download
 *   METADATA_SERVER_DETECTION=none             no GCE metadata probe for ADC
 *   FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH=true  functions discovered through
 *                                              a file, not a server on a random
 *                                              8xxx port outside the block
 *
 * firebase-tools starts the Firestore and Database emulators (Java) DETACHED,
 * each in its own process group, so they are found as descendants of the
 * emulator and recorded as their own groups; and teardown ends with a sweep for
 * any process that still carries the stack's mark.
 *
 * Every process the stack starts — the build steps too — carries
 * E2E_STACK_MARK=<runId>.<16 hex> (rec.mark) in its environment, inherited by
 * everything it spawns. Teardown and `reap` signal a group only when its
 * leader carries that mark, and a stray only by its own pid; a process that is
 * merely NEAR the tree (argv names it, cwd inside it) is reported and left
 * alone, because that is also what another session's grep or tail looks like.
 * stack.json (pids, pgids, ports, mark) is written to both
 * ~/.cache/bikeshed-e2e/stacks/<runId>/ and e2e/.out/<runId>/ after each
 * process starts, so a crash mid-start still leaves something to reap.
 *
 * EGRESS: every Node process the stack starts — the build steps, the shim,
 * the emulator CLI and every function worker it spawns — and every worker
 * thread in them preloads the egress guard (lib/egress-guard.mjs, copied to
 * <tree>/.e2e/ before any patch set is applied) through
 * NODE_OPTIONS=--require=<path>, so a connection to anything but loopback is
 * refused and logged to logs/egress.jsonl. Readiness checks the shim reports
 * the guard armed. Not guarded: `npm ci` (--install: it needs the registry)
 * and the non-Node processes — Mailpit and the Java emulators.
 *
 * RTDB RULES: firebase-tools would bind the tree's database.rules.json only
 * to `<projectId>-default-rtdb`, leaving `ns=<projectId>` — the app's and the
 * functions' namespace — open. The copy binds both (patch.mjs
 * rtdbRulesConfig), and readiness requires every bound namespace to read the
 * rules back byte-equal and an anonymous read of ns=<projectId> to be 401
 * (checkRtdbRules). The result is rec.rtdbRules, and the capability
 * `rtdb-rules`.
 *
 * STORAGE PRECONDITIONS: readiness then probes whether the Storage the
 * functions use refuses a second create-only write and copy
 * (ifGenerationMatch=0), which the product's CREATE_ONLY rests on
 * (lib/storage-preconditions.mjs). Recorded as rec.storagePreconditions and
 * never required: the emulator of firebase-tools 15.25.1 accepts both, so a
 * plain stack lacks the capability `storage-preconditions` and a case that
 * needs it is skipped there. A stack built with `--storage-shim` probes its
 * shim (below), which refuses both, and earns it.
 *
 * OPTIONS (lib/options.mjs): `emailOff` writes the product's own off switch
 * (RESEND_API_KEY=" ") while the shim keeps its dummy key; `appEnv` adds
 * allowlisted app build variables. Both are recorded in rec.options and
 * become capabilities of the target.
 *
 * MEMORY (a session once had to be killed at more than 90 GB):
 *   - ADMISSION (admission.mjs): a stack starts only with enough free memory
 *     (load.mjs) and a free slot under E2E_MAX_STACKS (3) live stacks; its
 *     record is written under the admission mutex, so it counts at once.
 *   - JVM HEAP CAPS (jvm.mjs): the emulator's PATH starts with
 *     <stackDir>/bin/java, which runs every JVM with -Xmx (Firestore 2048m,
 *     Database 1024m, any other 512m, `jvmHeap` lowers one) and
 *     ExitOnOutOfMemoryError, and records a JVM that ran out of heap, so
 *     readiness, `run` and the watchdog name that emulator.
 *   - DEBUG LOGS (debuglogs.mjs): firestore-debug.log and database-debug.log
 *     are /dev/null (their content is in firebase-debug.log too), and the
 *     watchdog cuts firebase-debug.log at half of E2E_DEBUG_LOG_MAX_MB (200).
 *     The Database emulator's records are copied out of firebase-debug.log
 *     into logs/database-debug.log (rec.logs.database) by the watchdog before
 *     each cut and by stopStack before the emulators are signalled (a clean
 *     exit unlinks firebase-debug.log) and once more after, from a hard link.
 *   - LIFETIME (lifetime.mjs, watchdog.mjs): rec.owner is the pid AND start
 *     second of the process that started the stack; <stackDir>/lease.json its
 *     expiry (kept: 4 h, `run --attach` makes it at least 2 h from then, never
 *     past 8 h from the start; not kept: 8 h). A watchdog process, started
 *     with the record and carrying the mark, stops the stack at expiry, at the
 *     hard maximum or when a non-kept stack's owner dies, and fails it when an
 *     emulator dies, with no harness command running.
 *
 * AUX (lib/stackaux.mjs): a stack built with `--gates` (or any amplify-*
 * patch set) or `--rtdb-proxy` runs one more essential process, the aux,
 * on two ports taken from the spare pool's end and renamed: `gate` (spare8:
 * the gate service and the proxy's control) and `rtdbProxy` (spare9, with
 * --rtdb-proxy: a raw TCP proxy to the Database emulator). A gated stack's
 * functions get E2E_GATE_URL and its app build VITE_E2E_GATE_URL; a proxied
 * stack's app bundle dials the proxy (EMULATOR_PORTS.database and the
 * database URL), which verifyBuild checks. Readiness requires the aux to
 * answer /health and, with the proxy, a read of the database through it.
 *
 * STORAGE SHIM (lib/storage-shim.mjs, `--storage-shim`): the aux also runs
 * the Storage shim on `storageShim` (spare7), in front of the Storage
 * emulator. The emulator gets NODE_OPTIONS with the shim's preload after the
 * egress guard (<tree>/.e2e/storage-shim-preload.mjs, rec.storageShim.preload)
 * and E2E_STORAGE_SHIM_HOST / _UPSTREAM / _LOG, so every function worker's
 * Storage emulator host is the shim. Readiness requires a Storage read
 * through the shim, then (after /config, which starts a function worker) a
 * worker's preload line naming the shim (rec.storageShim.redirect), and
 * probes the preconditions through the shim. Capability `storage-shim`.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { E2E_DIR, STACKS_DIR, LOCKS_DIR, ensureDir, logsDir, newRunId, runDir as runDirFor, stackDir as stackDirFor } from "./paths.mjs";
import { allocateBlock, isPidAlive, lockIsLive, updateLockFile, releaseLockFile } from "./ports.mjs";
import { materializeTree, removeTree } from "./tree.mjs";
import { BUCKET, PROJECT_ID, applyPatchSet, parseDotenv, patchAppConfig, patchFirebaseJson, writeFunctionsEnv } from "./patch.mjs";
import { STACK_MARK_KEY, SYSTEM_PATH, buildEnv, descendants, envValues, environments, groupAlive, groupOwnership, killGroup, killMarkedPids, markedProcesses, newStackMark, processStartSecs, processTable, processesUnder, requireTool, rssBytes, run, spawnDetached } from "./proc.mjs";
import { firebaseTools, node24 } from "./prerequisites.mjs";
import { captureRtdbRuntime, prepareRtdbRuntime } from "./rtdb-runtime.mjs";
import { tailLog } from "./logs.mjs";
import { localTarget, writeTarget } from "./target.mjs";
import { describeGuard, egressEnv, installEgressGuard } from "./egress.mjs";
import { appEnvBundleRule, normalizeStackOptions, stackGates, viteEnvFor } from "./options.mjs";
import { amplifyClientGates } from "./gates.mjs";
import { installJavaWrapper, jvmEvents, jvmFailures, jvmPaths, normalizeJvmHeap } from "./jvm.mjs";
import { DATABASE_LOG, databaseLogPaths, debugLogMaxBytes, drainDatabaseLog, pinDebugLog, prepareDebugLogs, unpinDebugLog } from "./debuglogs.mjs";
import { initialLease, lifetimeConfig, ownerAlive, ownerIdentity, ownerStarts, readLease, stackVerdict, writeLease } from "./lifetime.mjs";
import { admitStack } from "./admission.mjs";
import { probeStoragePreconditions, storagePreconditionsLine } from "./storage-preconditions.mjs";
import { STORAGE_SHIM_ROLE, STORAGE_SHIM_SPARE, describeStorageShimPreload, installStorageShimPreload, readStorageShimLog, shimRedirects, storageShimEnv } from "./storage-shim.mjs";
import { spawnWatchdog, watchdogPollMs } from "./watchdog.mjs";

export const EMULATORS = ["auth", "firestore", "database", "functions", "hosting", "storage"];
export const READY_TIMEOUT_MS = 240_000;

/** The spare-pool roles the aux process takes over, renamed: the gate service (and the proxy's control), and the RTDB proxy. */
export const AUX_ROLES = Object.freeze({ gate: "spare8", rtdbProxy: "spare9" });
/** The spare-pool role the Storage shim takes over, renamed (lib/storage-shim.mjs). */
export const STORAGE_SHIM_ROLES = Object.freeze({ [STORAGE_SHIM_ROLE]: STORAGE_SHIM_SPARE });
/** The aux process's heap cap (it holds a few small servers; the shim streams bodies). */
export const AUX_HEAP_MB = 64;

/**
 * A block's named ports with the aux roles taken out of the spare pool: with
 * `gates`, `rtdbProxy` or `storageShim`, `spare8` becomes `gate`; with
 * `rtdbProxy`, `spare9` becomes `rtdbProxy`; with `storageShim`, `spare7`
 * becomes `storageShim`. Unchanged (the same object) without any.
 */
export function withAuxPorts(ports, { gates = false, rtdbProxy = false, storageShim = false } = {}) {
  if (!gates && !rtdbProxy && !storageShim) return ports;
  const out = { ...ports };
  const take = (role, from) => {
    if (!Number.isInteger(out[from])) throw new Error(`the block has no ${from} for the aux role ${role}`);
    out[role] = out[from];
    delete out[from];
  };
  for (const [role, from] of Object.entries(AUX_ROLES)) {
    if (role === "rtdbProxy" && !rtdbProxy) continue;
    take(role, from);
  }
  if (storageShim) for (const [role, from] of Object.entries(STORAGE_SHIM_ROLES)) take(role, from);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function say(log, msg) {
  (log ?? ((m) => process.stderr.write(`[e2e] ${m}\n`)))(msg);
}

/** Replace a file in one step: a reader (the watchdog, a status) never sees half of it. */
function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Write the record to both homes. */
export function saveRecord(rec) {
  rec.updatedAt = new Date().toISOString();
  const text = JSON.stringify(rec, null, 2) + "\n";
  if (existsSync(rec.stackDir)) writeAtomic(join(rec.stackDir, "stack.json"), text);
  ensureDir(rec.runDir, "runDir");
  writeAtomic(join(rec.runDir, "stack.json"), text);
}

export function readRecord(runId) {
  for (const file of [join(stackDirFor(runId), "stack.json"), join(runDirFor(runId), "stack.json")]) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }
  return null;
}

/**
 * A TMPDIR short enough for the Functions emulator's unix socket
 * (os.tmpdir()/fire_emu_<16 hex>.sock must fit macOS's 104-byte sun_path).
 * <stackDir>/tmp when it fits, else /tmp/bshd-<runId>, linked from the stack.
 */
function makeTmpDir(stackDir, runId) {
  const preferred = join(stackDir, "tmp");
  if (preferred.length + "/fire_emu_0123456789abcdef.sock".length <= 100) return ensureDir(preferred, "tmp");
  const short = `/tmp/bshd-${runId}`;
  mkdirSync(short, { recursive: true, mode: 0o700 });
  try {
    symlinkSync(short, preferred);
  } catch {}
  return short;
}

/**
 * Check the built app: the origin in llms.txt, the project, and the
 * database the bundle dials — `databasePort` (the stack's RTDB proxy with
 * --rtdb-proxy, else the emulator) in both the database URL and the one
 * EMULATOR_PORTS literal — and, with `gateRequired`, the gate URL a client
 * gate reads.
 */
export function verifyBuild(treeDir, origin, ports, { appEnv = {}, databasePort = ports.database, gateUrl = null, gateRequired = false } = {}) {
  const dist = join(treeDir, "app", "dist");
  const llms = readFileSync(join(dist, "llms.txt"), "utf8");
  if (!llms.includes(origin)) throw new Error(`dist/llms.txt does not name the stack origin ${origin}`);
  if (llms.includes("<deployment>")) throw new Error("dist/llms.txt still holds the <deployment> placeholder");
  if (!existsSync(join(dist, "index.html"))) throw new Error("dist/index.html missing");
  const assets = join(dist, "assets");
  const bundle = readdirSync(assets).filter((n) => n.endsWith(".js")).map((n) => readFileSync(join(assets, n), "utf8")).join("\n");
  if (!bundle.includes(PROJECT_ID)) throw new Error(`the app bundle does not contain ${PROJECT_ID}`);
  const dbUrl = `127.0.0.1:${databasePort}?ns=${PROJECT_ID}`;
  if (!bundle.includes(dbUrl)) throw new Error(`the app bundle does not contain the stack database URL ${dbUrl}`);
  // The minified EMULATOR_PORTS literal, e.g. {auth:32882,firestore:32883,database:32885}.
  // Exactly one, holding this stack's ports: a bare includes() over a megabyte
  // of minified code could match a port number by coincidence.
  const literals = [...bundle.matchAll(/\{auth:(\d+),firestore:(\d+),database:(\d+)\}/g)];
  if (literals.length !== 1) throw new Error(`the app bundle holds ${literals.length} EMULATOR_PORTS literals, expected exactly 1`);
  const [, a, f, d] = literals[0].map(Number);
  if (a !== ports.auth || f !== ports.firestore || d !== databasePort) {
    throw new Error(`the app bundle dials auth ${a}, firestore ${f}, database ${d}; the stack is on ${ports.auth}, ${ports.firestore}, ${databasePort}${databasePort !== ports.database ? ` (the RTDB proxy; the emulator is on ${ports.database})` : ""}`);
  }
  // A client gate reads VITE_E2E_GATE_URL: a gated build that lost it would fail closed at every join.
  const gateInBundle = gateUrl ? bundle.includes(gateUrl) : false;
  if (gateRequired && !gateInBundle) throw new Error(`the app bundle does not contain the gate URL ${gateUrl}, which its client gates read`);
  // An allowlisted build variable must have reached the bundle, or the option
  // silently did nothing — unless its rule only records that (options.mjs
  // APP_ENV_ALLOWLIST inBundle: "recorded"), because whether the app uses it
  // is what a case tests.
  const appEnvInBundle = {};
  for (const [k, v] of Object.entries(appEnv)) {
    appEnvInBundle[k] = !v || bundle.includes(v);
    if (!appEnvInBundle[k] && appEnvBundleRule(k) === "required") throw new Error(`the app bundle does not contain the value given for ${k}`);
  }
  return { llmsTxt: true, bundleBytes: bundle.length, emulatorPorts: literals[0][0], databasePort: d, gateInBundle, appEnv: Object.keys(appEnv), appEnvInBundle };
}

/** Build the copy: policy check, functions tsc, app vite build from a scratch env. */
async function buildTree(rec, { nodeBin, log }) {
  const tree = rec.treeDir;
  const buildLog = rec.logs.build;
  const basePath = [nodeBin, ...SYSTEM_PATH];
  const guarded = egressEnv({ file: rec.egress.file, log: rec.logs.egress });
  const env = buildEnv({ path: basePath, tmpdir: rec.tmpDir, home: rec.homeDir, set: { [STACK_MARK_KEY]: rec.mark, ...guarded, npm_config_update_notifier: "false", npm_config_fund: "false" } });
  const t0 = Date.now();
  say(log, "build: policy check");
  const signal = rec.signal;
  await run(join(nodeBin, "node"), ["tools/build-policy.mjs", "--check"], { cwd: tree, env, logFile: buildLog, signal });
  say(log, "build: functions (tsc)");
  await run(join(nodeBin, "npm"), ["run", "build"], { cwd: join(tree, "functions"), env, logFile: buildLog, signal });

  const example = parseDotenv(readFileSync(join(tree, "app", ".env.example"), "utf8"));
  // With --rtdb-proxy the bundle dials the proxy, never the emulator itself.
  const databasePort = rec.options?.rtdbProxy ? rec.ports.rtdbProxy : rec.ports.database;
  const gateUrl = rec.aux?.gates ? rec.aux.url : null;
  const viteEnv = viteEnvFor(example, { databasePort, projectId: PROJECT_ID, origin: rec.origin, appEnv: rec.options?.appEnv ?? {}, gateUrl });
  say(log, `build: app (vite)${Object.keys(rec.options?.appEnv ?? {}).length ? ` with ${Object.keys(rec.options.appEnv).join(", ")}` : ""}`);
  await run(join(nodeBin, "npx"), ["--no-install", "vite", "build"], {
    cwd: join(tree, "app"),
    env: buildEnv({ path: basePath, tmpdir: rec.tmpDir, home: rec.homeDir, set: { ...viteEnv, [STACK_MARK_KEY]: rec.mark, ...guarded, npm_config_update_notifier: "false" } }),
    logFile: buildLog,
    signal,
  });
  const gateRequired = Boolean(gateUrl) && amplifyClientGates((rec.patches ?? []).map((p) => p.set)).length > 0;
  const verified = verifyBuild(tree, rec.origin, rec.ports, { appEnv: rec.options?.appEnv ?? {}, databasePort, gateUrl, gateRequired });
  rec.webApiKey = example.VITE_FIREBASE_API_KEY;
  return { ms: Date.now() - t0, ...verified };
}

async function probe(url, init = {}, timeoutMs = 3000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal, redirect: "manual" });
    const text = await r.text();
    return { status: r.status, text };
  } catch (err) {
    return { status: 0, text: err.message };
  } finally {
    clearTimeout(t);
  }
}

/** Record the emulator's descendants that live in process groups of their own. */
export function trackChildren(rec) {
  const emu = rec.processes.find((p) => p.name === "emulators");
  if (!emu) return [];
  const added = [];
  for (const d of descendants(emu.pid, processTable())) {
    if (d.pgid === emu.pgid) continue;
    if (rec.processes.some((p) => p.pgid === d.pgid)) continue;
    const entry = { name: "emulators-child", pid: d.pid, pgid: d.pgid, parent: emu.pid, command: d.command.slice(0, 240), startedAt: new Date().toISOString() };
    rec.processes.push(entry);
    added.push(entry);
  }
  if (added.length > 0) saveRecord(rec);
  return added;
}

/** The processes a stack cannot run without (the watchdog is not one: it only guards; the aux is, where there is one). */
const ESSENTIAL = new Set(["mailpit", "shim", "emulators", "aux"]);

/**
 * What has failed in a stack: an emulator JVM that ran out of memory or
 * exited (jvm.mjs, named), and an essential process that is gone.
 * @returns {{emulator:string, pid:number, reason:string}[]}
 */
export function stackFailures(rec) {
  const out = jvmFailures(rec).map((f) => ({ emulator: f.emulator, pid: f.pid, reason: f.reason }));
  for (const p of rec?.processes ?? []) {
    if (ESSENTIAL.has(p.name) && !isPidAlive(p.pid)) out.push({ emulator: p.name, pid: p.pid, reason: `${p.name} (pid ${p.pid}) is not running` });
  }
  return out;
}

/**
 * During start-up: throw at once when an emulator ran out of memory (naming
 * it) or an essential process is gone (with its log's tail), so a start never
 * waits out READY_TIMEOUT_MS on a dead stack.
 */
function assertHealthy(rec) {
  const oom = jvmFailures(rec, { exited: false });
  if (oom.length > 0) {
    const err = new Error(`stack ${rec.runId} failed during start-up: ${oom.map((f) => f.reason).join("; ")}\n--- ${rec.logs.emulators} ---\n${tailLog(rec.logs.emulators, 20)}`);
    err.code = "E2E_STACK_OOM";
    throw err;
  }
  for (const p of rec.processes.filter((x) => ESSENTIAL.has(x.name))) {
    if (!isPidAlive(p.pid)) {
      const jvm = jvmFailures(rec);
      throw new Error(`${p.name} (pid ${p.pid}) exited during start-up${jvm.length ? ` (${jvm.map((f) => f.reason).join("; ")})` : ""}\n--- ${p.logFile} ---\n${tailLog(p.logFile, 40)}`);
    }
  }
}

/** Poll until `fn` returns a truthy value; checks the stack's processes (and an abort) each turn. */
async function until(rec, what, deadline, fn, pollMs = 500) {
  let last;
  while (Date.now() < deadline) {
    rec.signal?.throwIfAborted();
    assertHealthy(rec);
    trackChildren(rec);
    last = await fn();
    if (last && last.ok) return last;
    await sleep(pollMs);
  }
  throw new Error(`stack ${rec.runId} not ready: ${what} (last: ${JSON.stringify(last)?.slice(0, 400)})`);
}

/** A GET that keeps the body's bytes: {status, buffer}, status 0 on a network error. */
async function probeBytes(url, init = {}, { timeoutMs = 3000, fetchImpl = fetch } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { ...init, signal: ac.signal, redirect: "manual" });
    return { status: r.status, buffer: Buffer.from(await r.arrayBuffer()) };
  } catch (err) {
    return { status: 0, buffer: Buffer.from(String(err?.message ?? err)) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Whether the stack's database enforces the tree's rules: every namespace in
 * rec.rtdbBinding reads its rules back (GET /.settings/rules.json, as the
 * emulator's admin) byte-equal to the tree's file, and an anonymous shallow
 * read of the root of ns=<projectId> — the app's and the functions'
 * namespace — is 401. A namespace with no rules of its own answers 200 to
 * that read, which is how the blind stack was found.
 *
 * @returns {Promise<{ok:boolean, namespace:string, namespaces:string[], file:string, bytes:number, sha256:string, equal:boolean, unequal:string[], anonymousStatus:number}>}
 */
export async function checkRtdbRules(rec, { fetchImpl = fetch } = {}) {
  const ns = rec.projectId;
  const rel = rec.rtdbBinding?.rules;
  if (!rel) throw new Error(`stack ${rec.runId}: no RTDB rules are bound (rec.rtdbBinding)`);
  const want = readFileSync(join(rec.treeDir, rel));
  const base = `http://127.0.0.1:${rec.ports.database}`;
  const namespaces = rec.rtdbBinding.namespaces?.length ? rec.rtdbBinding.namespaces : [ns];
  const unequal = [];
  for (const instance of namespaces) {
    const stored = await probeBytes(`${base}/.settings/rules.json?ns=${encodeURIComponent(instance)}`, { headers: { authorization: "Bearer owner" } }, { fetchImpl });
    if (stored.status !== 200 || !stored.buffer.equals(want)) unequal.push(instance);
  }
  const anonymous = await probeBytes(`${base}/.json?ns=${encodeURIComponent(ns)}&shallow=true`, {}, { fetchImpl });
  const equal = unequal.length === 0;
  return {
    ok: equal && anonymous.status === 401,
    namespace: ns,
    namespaces,
    file: rel,
    bytes: want.length,
    sha256: createHash("sha256").update(want).digest("hex"),
    equal,
    unequal,
    anonymousStatus: anonymous.status,
  };
}

/** Every readiness check, in order; returns timings. */
export async function waitReady(rec, { timeoutMs = READY_TIMEOUT_MS, log } = {}) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  const p = rec.ports;
  const u = (port, path = "/") => `http://127.0.0.1:${port}${path}`;
  const marks = {};

  await until(rec, "Mailpit /readyz", deadline, async () => {
    const r = await probe(u(p.mailpit, "/readyz"));
    return { ok: r.status === 200, status: r.status };
  });
  marks.mailpit = Date.now() - t0;
  const shimHealth = await until(rec, "shim /__e2e/health", deadline, async () => {
    const r = await probe(u(p.shim, "/__e2e/health"));
    let body = null;
    try {
      body = JSON.parse(r.text);
    } catch {}
    return { ok: r.status === 200, status: r.status, body };
  });
  // The shim is a Node process the stack started: the guard must be armed in it.
  if (rec.egress && shimHealth.body?.guard !== true) throw new Error(`the egress guard is not armed in the shim (health: ${JSON.stringify(shimHealth.body)})`);
  rec.shim = { features: shimHealth.body?.features ?? [], failRecipient: (shimHealth.body?.features ?? []).includes("fail-recipient"), guard: shimHealth.body?.guard === true };
  marks.shim = Date.now() - t0;

  await until(rec, "hub /emulators lists all six on their ports", deadline, async () => {
    const r = await probe(u(p.hub, "/emulators"));
    if (r.status !== 200) return { ok: false, status: r.status };
    let listed;
    try {
      listed = JSON.parse(r.text);
    } catch {
      return { ok: false, text: r.text.slice(0, 100) };
    }
    const wrong = EMULATORS.filter((name) => listed[name]?.port !== p[name]);
    return { ok: wrong.length === 0, wrong, listed: Object.keys(listed) };
  }, 1000);
  marks.hub = Date.now() - t0;
  say(log, `ready: hub lists ${EMULATORS.join(", ")} (${marks.hub} ms)`);

  const probes = {
    auth: async () => (await probe(u(p.auth, "/"))).status === 200,
    firestore: async () => (await probe(u(p.firestore, "/"))).status === 200,
    database: async () => (await probe(u(p.database, `/.json?ns=${PROJECT_ID}&shallow=true`), { headers: { authorization: "Bearer owner" } })).status === 200,
    storage: async () => (await probe(u(p.storage, "/"))).status > 0,
    functions: async () => (await probe(u(p.functions, "/"))).status > 0,
    hosting: async () => (await probe(u(p.hosting, "/"))).status === 200,
  };
  for (const [name, fn] of Object.entries(probes)) {
    await until(rec, `${name} probe`, deadline, async () => ({ ok: await fn() }));
  }
  marks.probes = Date.now() - t0;

  // The aux process: its control port answers, and with the proxy, the
  // database answers THROUGH it (what every browser of the stack dials).
  if (rec.aux) {
    const health = await until(rec, `aux /health on ${p.gate}`, deadline, async () => {
      const r = await probe(u(p.gate, "/health"));
      let body = null;
      try {
        body = JSON.parse(r.text);
      } catch {}
      return { ok: r.status === 200 && body?.ok === true && (!rec.aux.proxy || body?.proxy?.port === p.rtdbProxy) && (!rec.aux.storageShim || body?.storageShim?.port === p.storageShim), status: r.status, body };
    });
    rec.aux.health = health.body;
    if (rec.aux.proxy) {
      await until(rec, `a database read through the RTDB proxy on ${p.rtdbProxy}`, deadline, async () => {
        const r = await probe(u(p.rtdbProxy, `/.json?ns=${PROJECT_ID}&shallow=true`), { headers: { authorization: "Bearer owner" } });
        return { ok: r.status === 200, status: r.status };
      });
    }
    if (rec.aux.storageShim) {
      await until(rec, `a Storage listing through the Storage shim on ${p.storageShim}`, deadline, async () => {
        const r = await probe(u(p.storageShim, `/b/${encodeURIComponent(rec.bucket)}/o?maxResults=1`), { headers: { authorization: "Bearer owner" } });
        return { ok: r.status === 200, status: r.status };
      });
    }
    marks.aux = Date.now() - t0;
    say(log, `ready: aux on ${p.gate}${rec.aux.proxy ? `, RTDB proxy ${p.rtdbProxy} → ${p.database}` : ""}${rec.aux.storageShim ? `, Storage shim ${p.storageShim} → ${p.storage}` : ""} (${marks.aux} ms)`);
  }

  // The tree's RTDB rules, read back from every namespace they are bound to,
  // and refusing an anonymous read where the app and the functions live.
  if (rec.rtdbBinding?.rules) {
    const checked = await until(rec, `RTDB rules bound to ns=${rec.projectId} (${rec.rtdbBinding.rules} read back byte-equal; an anonymous read refused)`, deadline, () => checkRtdbRules(rec), 1000);
    rec.rtdbRules = Object.fromEntries(Object.entries(checked).filter(([k]) => k !== "ok"));
    marks.rtdbRules = Date.now() - t0;
    say(log, `ready: RTDB rules enforced in ns=${rec.projectId} (${marks.rtdbRules} ms)`);
  }

  await until(rec, "GET <hosting>/config = 200 (Hosting → Functions rewrite)", deadline, async () => {
    const r = await probe(u(p.hosting, "/config"), {}, 15000);
    return { ok: r.status === 200, status: r.status, body: r.text.slice(0, 120) };
  }, 1000);
  marks.config = Date.now() - t0;
  say(log, `ready: /config 200 (${marks.config} ms)`);

  // /config started a function worker: under the shim's preload, its Storage
  // emulator host must now be the shim, or the shim judges nothing.
  if (rec.aux?.storageShim) {
    const seen = await until(rec, `a function worker's Storage emulator host is the Storage shim on ${p.storageShim} (${rec.logs.storageShim})`, deadline, async () => {
      const r = shimRedirects(readStorageShimLog(rec.logs.storageShim), { shimPort: p.storageShim, upstreamPort: p.storage });
      // A worker left on the emulator never moves later: fail at once, naming it.
      if (r.refused.length > 0) throw new Error(`stack ${rec.runId} not ready: the Storage shim's preload did not move a function worker: ${r.reason}`);
      return r;
    });
    rec.storageShim.redirect = { ok: seen.ok, workers: seen.workers, redirected: seen.redirected };
    marks.storageShim = Date.now() - t0;
    say(log, `ready: function workers dial Storage through the shim on ${p.storageShim} (${seen.redirected} worker(s) so far; ${marks.storageShim} ms)`);
  }

  // The shim round trip: a canary that must land in Mailpit, then is removed.
  const subject = `e2e canary ${rec.runId} ${randomBytes(4).toString("hex")}`;
  const send = await probe(u(p.shim, "/emails"), {
    method: "POST",
    headers: { authorization: `Bearer ${readShimKey(rec)}`, "content-type": "application/json" },
    body: JSON.stringify({ from: "Bikeshed E2E <noreply@e2e.bikeshed.invalid>", to: `canary@${rec.runId}.e2e.invalid`, subject, text: "canary" }),
  });
  if (send.status !== 200) throw new Error(`shim canary refused: ${send.status} ${send.text}`);
  const found = await until(rec, "canary in Mailpit", deadline, async () => {
    const r = await probe(u(p.mailpit, `/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`));
    if (r.status !== 200) return { ok: false, status: r.status };
    const msgs = JSON.parse(r.text).messages ?? [];
    return { ok: msgs.length === 1, ids: msgs.map((m) => m.ID) };
  });
  await probe(u(p.mailpit, "/api/v1/messages"), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ IDs: found.ids }) });
  await probe(u(p.shim, "/__e2e/reset"), { method: "POST" });
  marks.mail = Date.now() - t0;
  say(log, `ready: shim → Mailpit round trip (${marks.mail} ms)`);

  // Whether Storage refuses a second create-only write and copy (the product's
  // CREATE_ONLY): recorded, never required, so a stack whose emulator ignores
  // ifGenerationMatch still starts, without the capability storage-preconditions.
  try {
    rec.storagePreconditions = await probeStoragePreconditions({ storageUrl: u(rec.aux?.storageShim ? p.storageShim : p.storage), bucket: rec.bucket, label: rec.runId });
  } catch (err) {
    rec.storagePreconditions = { honoured: null, reason: `the probe threw: ${String(err?.message ?? err).slice(0, 300)}` };
  }
  marks.storagePreconditions = Date.now() - t0;
  say(log, `ready: ${storagePreconditionsLine(rec.storagePreconditions)} (${marks.storagePreconditions} ms)`);
  return marks;
}

/** The shim's dummy key: <tree>/.e2e/shim-key (an email-off stack has none in .secret.local). */
function readShimKey(rec) {
  try {
    const m = /^(re_e2e_[0-9a-f]+)\s*$/.exec(readFileSync(join(rec.treeDir, ".e2e", "shim-key"), "utf8"));
    if (m) return m[1];
  } catch {}
  const text = readFileSync(join(rec.treeDir, "functions", ".secret.local"), "utf8");
  const m = /^RESEND_API_KEY=(re_e2e_[0-9a-f]+)$/m.exec(text);
  if (!m) throw new Error("the stack has no dummy Resend key");
  return m[1];
}

/**
 * Start a stack and wait until it is ready.
 * @param {object} o
 * @param {string} [o.runId]
 * @param {string} [o.tree="HEAD"]   HEAD | <rev> | worktree
 * @param {boolean} [o.install]      npm ci in the copy instead of symlinking node_modules
 * @param {boolean} [o.keep]         mark as kept (stack up): it outlives its owner, until its lease expires
 * @param {boolean} [o.keepUi]
 * @param {string[]} [o.patchSets]   e2e/patches/<set> to apply to the copy
 * @param {boolean} [o.emailOff]     the product's own email-off switch (lib/options.mjs)
 * @param {object} [o.appEnv]        allowlisted app build variables, {KEY: value|"dummy"}
 * @param {boolean} [o.rtdbProxy]    the app dials the Database emulator through the aux process's TCP proxy (lib/stackaux.mjs)
 * @param {boolean} [o.gates]        run the gate service (implied by an amplify-* patch set; lib/gates.mjs)
 * @param {boolean} [o.storageShim]  the functions reach Storage through the aux process's Storage shim (lib/storage-shim.mjs)
 * @param {object} [o.jvmHeap]       {firestore, database, other} MiB, each at most its ceiling (jvm.mjs)
 * @param {number} [o.ttlHours]      a kept stack's first lease, in hours (lifetime.mjs; default 4)
 * @param {(msg:string)=>void} [o.log]
 * @param {AbortSignal} [o.signal]    aborting it stops the start at the next step,
 *                                    tears down what was started, and rejects
 * @param {(rec:object)=>void} [o.onRecord]  called with the record as soon as it exists
 * @returns {Promise<{record:object, target:object, targetFile:string}>}
 *   Rejects with code E2E_ADMISSION when memory or a stack slot never came (admission.mjs).
 */
export async function startStack({ runId = newRunId(), tree = "HEAD", install = false, keep = false, keepUi = false, patchSets = [], emailOff = false, appEnv = {}, rtdbProxy = false, gates = false, storageShim = false, jvmHeap = null, ttlHours = null, log, signal = null, onRecord = null } = {}) {
  signal?.throwIfAborted();
  const options = normalizeStackOptions({ emailOff, appEnv, rtdbProxy, gates, storageShim });
  // What the stack runs: the gate service is asked for, or an amplify set needs it.
  options.gates = stackGates({ gates: options.gates, patchSets });
  const heap = normalizeJvmHeap(jvmHeap);
  const lifetime = lifetimeConfig({ ttlHours });
  const debugMaxBytes = debugLogMaxBytes();
  const pollMs = watchdogPollMs();
  const node = node24();
  const nodeBin = node.bin;
  const nodeV = node.version;
  const firebase = firebaseTools();
  const firebaseBin = firebase.bin;
  say(log, `toolchain: ${JSON.stringify({ node, firebase })}`);
  const mailpitBin = requireTool("mailpit", "E2E_MAILPIT_BIN");
  const javaBin = requireTool("java", "E2E_JAVA_BIN");

  const rd = ensureDir(runDirFor(runId), "runDir");
  const ld = ensureDir(logsDir(runId), "logsDir");
  const sd = stackDirFor(runId);
  const base = {
    runId,
    // Provenance: every process this stack starts carries it (see the header).
    mark: newStackMark(runId),
    state: "starting",
    keep,
    createdAt: null,
    createdBy: { pid: process.pid, argv: process.argv.slice(1) },
    owner: ownerIdentity(),
    stackDir: sd,
    treeDir: join(sd, "tree"),
    runDir: rd,
    lifetime,
    processes: [],
  };
  // Memory, and a slot under the machine-wide cap; the record is written
  // under the admission mutex, so the next admission counts this stack.
  const admission = await admitStack({
    runId,
    signal,
    log: (m) => say(log, m),
    logFile: join(rd, "load.jsonl"),
    claim: () => {
      ensureDir(sd, "stackDir");
      const now = Date.now();
      base.createdAt = new Date(now).toISOString();
      writeLease(sd, initialLease({ createdAtMs: now, keep, config: lifetime }));
      writeAtomic(join(sd, "stack.json"), JSON.stringify({ ...base, updatedAt: base.createdAt }, null, 2) + "\n");
    },
  });
  if (admission.waitedMs > 0) say(log, `stack ${runId}: admitted after ${Math.round(admission.waitedMs / 1000)} s`);
  let block;
  try {
    block = await allocateBlock({ runId });
  } catch (err) {
    rmSync(sd, { recursive: true, force: true }); // nothing started: the slot is free again
    throw err;
  }
  const ports = withAuxPorts(block.named, { gates: options.gates, rtdbProxy: options.rtdbProxy, storageShim: options.storageShim });
  const auxed = options.gates || options.rtdbProxy || options.storageShim;
  const rec = {
    ...base,
    projectId: PROJECT_ID,
    bucket: BUCKET,
    origin: `http://127.0.0.1:${ports.hosting}`,
    tmpDir: makeTmpDir(sd, runId),
    homeDir: ensureDir(join(sd, "home"), "stack HOME"),
    portBase: block.base,
    portSize: block.ports.length,
    ports,
    lockPath: block.lockPath,
    node: { bin: nodeBin, version: nodeV },
    tools: { firebase: firebaseBin, mailpit: mailpitBin, java: javaBin },
    toolchain: { node, firebase },
    logs: {
      emulators: join(ld, "emulators.log"),
      mailpit: join(ld, "mailpit.log"),
      shim: join(ld, "shim.log"),
      shimJsonl: join(ld, "shim.jsonl"),
      build: join(ld, "build.log"),
      egress: join(ld, "egress.jsonl"),
      watchdog: join(ld, "watchdog.log"),
      // The Database emulator's own output, copied out of the tree's firebase-debug.log (debuglogs.mjs drainDatabaseLog).
      database: join(ld, DATABASE_LOG),
      ...(auxed ? { aux: join(ld, "aux.log") } : {}),
      // What the Storage shim's preload wrote in each function worker (lib/storage-shim-preload.mjs).
      ...(options.storageShim ? { storageShim: join(ld, "storage-shim.jsonl") } : {}),
    },
    options,
    // The aux process's ports and what it serves (lib/stackaux.mjs); null without --gates/--rtdb-proxy/--storage-shim.
    aux: auxed ? { url: `http://127.0.0.1:${ports.gate}`, control: ports.gate, gates: options.gates, proxy: options.rtdbProxy ? ports.rtdbProxy : null, storageShim: options.storageShim ? ports.storageShim : null } : null,
    jvm: { heapMb: heap, ...jvmPaths(sd) },
    debugLogs: { maxBytes: debugMaxBytes },
    admission,
    watchdogPollMs: pollMs,
  };
  saveRecord(rec);
  // Not saved: the signal is this process's, the record outlives it.
  Object.defineProperty(rec, "signal", { value: signal, enumerable: false, writable: true });
  onRecord?.(rec);
  const lease = readLease(sd);
  say(log, `stack ${runId}: ports ${block.base}-${block.base + block.ports.length - 1}, node ${nodeV}, expires ${lease?.expiresAt} (hard ${lease?.hardExpiresAt})`);

  try {
    // The watchdog guards the stack's lifetime from here on, whatever happens to this process.
    rec.processes.push(spawnWatchdog(rec, { nodeBin, pollMs }));
    saveRecord(rec);
    say(log, `tree: --tree ${tree}`);
    const t = await materializeTree({
      runId,
      tree,
      install,
      npmCi: (dir) => run(join(nodeBin, "npm"), ["ci", "--no-audit", "--no-fund"], {
        cwd: dir,
        env: buildEnv({ path: [nodeBin, ...SYSTEM_PATH], tmpdir: rec.tmpDir, set: { [STACK_MARK_KEY]: rec.mark } }),
        logFile: rec.logs.build,
        signal,
      }),
    });
    rec.fingerprint = t.fingerprint;
    rec.nodeModules = t.nodeModules;
    rec.expectVersion = JSON.parse(readFileSync(join(rec.treeDir, "package.json"), "utf8")).version;
    saveRecord(rec);

    const fb = patchFirebaseJson(rec.treeDir, ports, { keepUi });
    // Which namespaces the tree's RTDB rules are bound to; readiness reads them back.
    rec.rtdbBinding = fb.database;
    // With --rtdb-proxy the web SDK's database port is the proxy's (the emulator stays where firebase.json pins it).
    patchAppConfig(rec.treeDir, options.rtdbProxy ? { ...ports, database: ports.rtdbProxy } : ports, fb.defaults);
    const env = writeFunctionsEnv(rec.treeDir, ports, { emailOff: options.emailOff, gateUrl: options.gates ? rec.aux.url : null });
    ensureDir(join(rec.treeDir, ".e2e"), "tree state dir");
    writeFileSync(join(rec.treeDir, ".e2e", "shim-key"), `${env.apiKey}\n`, { mode: 0o600 });
    rec.shimKeyRef = ".e2e/shim-key";
    // Before the patch sets, so a controls set can patch the stack's copy.
    installEgressGuard(rec.treeDir);
    if (options.storageShim) installStorageShimPreload(rec.treeDir);
    rec.patches = [];
    for (const set of patchSets) rec.patches.push(applyPatchSet(rec.treeDir, set));
    const g = describeGuard(join(rec.treeDir, ".e2e", "egress-guard.mjs"));
    rec.egress = { file: g.file, sha256: g.sha256 };
    // The shim's preload as the tree now holds it (lib/storage-shim.mjs); readiness adds `redirect`.
    if (options.storageShim) rec.storageShim = { port: ports.storageShim, upstream: ports.storage, preload: describeStorageShimPreload(join(rec.treeDir, ".e2e", "storage-shim-preload.mjs")), redirect: null };
    saveRecord(rec);
    signal?.throwIfAborted();

    rec.build = await buildTree(rec, { nodeBin, log });
    saveRecord(rec);
    signal?.throwIfAborted();

    const sysPath = [nodeBin, ...SYSTEM_PATH];
    const marked = { [STACK_MARK_KEY]: rec.mark };
    const guarded = egressEnv({ file: rec.egress.file, log: rec.logs.egress });
    const mp = spawnDetached(mailpitBin, [
      "--listen", `127.0.0.1:${ports.mailpit}`,
      "--smtp", `127.0.0.1:${ports.smtp}`,
      "--max", "0",
      "--disable-version-check",
      "--send-api-auth-accept-any",
      "--database", join(rec.treeDir, ".e2e", "mailpit.db"),
      "--label", `e2e-${runId}`,
    ], { cwd: rec.treeDir, env: buildEnv({ path: sysPath, tmpdir: rec.tmpDir, home: rec.homeDir, set: marked }), logFile: rec.logs.mailpit });
    rec.processes.push({ name: "mailpit", ...mp });
    saveRecord(rec);
    signal?.throwIfAborted();

    const shim = spawnDetached(join(nodeBin, "node"), [
      join(E2E_DIR, "lib", "mail", "shim.mjs"),
      "--port", String(ports.shim),
      "--mailpit", `http://127.0.0.1:${ports.mailpit}`,
      "--log", rec.logs.shimJsonl,
      "--stack-dir", rec.treeDir,
    ], { cwd: rec.treeDir, env: buildEnv({ path: sysPath, tmpdir: rec.tmpDir, home: rec.homeDir, set: { ...marked, ...guarded, E2E_SHIM_KEY: env.apiKey } }), logFile: rec.logs.shim });
    rec.processes.push({ name: "shim", ...shim });
    saveRecord(rec);
    signal?.throwIfAborted();

    if (rec.aux) {
      const aux = spawnDetached(join(nodeBin, "node"), [
        `--max-old-space-size=${AUX_HEAP_MB}`,
        join(E2E_DIR, "lib", "stackaux.mjs"),
        "--control", String(ports.gate),
        ...(rec.aux.proxy ? ["--rtdb-proxy", String(ports.rtdbProxy), "--upstream", String(ports.database)] : []),
        ...(rec.aux.storageShim ? ["--storage-shim", String(ports.storageShim), "--storage-upstream", String(ports.storage)] : []),
      ], { cwd: rec.treeDir, env: buildEnv({ path: sysPath, tmpdir: rec.tmpDir, home: rec.homeDir, set: { ...marked, ...guarded } }), logFile: rec.logs.aux });
      rec.processes.push({ name: "aux", ...aux });
      saveRecord(rec);
      signal?.throwIfAborted();
    }

    const jars = join(homedir(), ".cache", "firebase", "emulators");
    const emuSet = { ...marked, ...guarded, CI: "true", METADATA_SERVER_DETECTION: "none", FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH: "true" };
    // The Storage shim's preload after the guard: every function worker then dials the shim (lib/storage-shim.mjs).
    if (rec.storageShim) Object.assign(emuSet, storageShimEnv({ preload: rec.storageShim.preload.file, shimPort: ports.storageShim, upstreamPort: ports.storage, log: rec.logs.storageShim, nodeOptions: guarded.NODE_OPTIONS }));
    if (existsSync(jars)) emuSet.FIREBASE_EMULATORS_PATH = jars;
    // Every JVM firebase-tools starts goes through the stack's java (heap caps), and
    // the per-emulator debug logs it would write without limit are /dev/null.
    const require = createRequire(join(firebase.root, "package.json"));
    const database = require(join(firebase.root, "lib/emulator/downloadableEmulators.js")).getDownloadDetails("database");
    const sourcePath = existsSync(jars) ? join(jars, basename(database.downloadPath)) : database.downloadPath;
    rec.rtdbEngine = prepareRtdbRuntime({ firebase: firebase.version, database: database.version, sourcePath, stackDir: sd, runDir: rd });
    say(log, `runtime: ${rec.rtdbEngine.label}; profile ${rec.rtdbEngine.profileSha256}`);
    const wrapper = installJavaWrapper({ stackDir: sd, realJava: javaBin, heap, runId, rtdbEngine: rec.rtdbEngine });
    rec.debugLogs.nulled = prepareDebugLogs(rec.treeDir);
    saveRecord(rec);
    const emu = spawnDetached(firebaseBin, [
      "emulators:start",
      "--project", PROJECT_ID,
      "--only", EMULATORS.join(","),
      "--config", join(rec.treeDir, "firebase.json"),
    ], {
      cwd: rec.treeDir,
      env: buildEnv({
        path: [wrapper.binDir, nodeBin, dirname(firebaseBin), dirname(javaBin), ...SYSTEM_PATH],
        tmpdir: rec.tmpDir,
        home: rec.homeDir,
        set: emuSet,
      }),
      logFile: rec.logs.emulators,
    });
    rec.processes.push({ name: "emulators", ...emu });
    saveRecord(rec);
    updateLockFile(rec.lockPath, runId, { pid: emu.pid, pids: rec.processes.map((x) => x.pid), stackDir: sd });

    rec.ready = await waitReady(rec, { log });
    rec.rtdbEngine.live = await captureRtdbRuntime(rec);
    trackChildren(rec);
    updateLockFile(rec.lockPath, runId, { pid: emu.pid, pids: rec.processes.map((x) => x.pid), stackDir: sd });
    rec.state = "ready";
    saveRecord(rec);
    const target = localTarget(rec);
    const targetFile = writeTarget(target);
    rec.targetFile = targetFile;
    saveRecord(rec);
    say(log, `stack ${runId} ready at ${rec.origin}`);
    return { record: rec, target, targetFile };
  } catch (err) {
    rec.state = "failed";
    rec.error = String(err?.message ?? err).slice(0, 4000);
    if (signal?.aborted) rec.interrupted = true;
    saveRecord(rec);
    say(log, `stack ${runId} ${signal?.aborted ? "interrupted" : "failed"}: ${String(err?.message ?? err).split("\n")[0]} — tearing down, keeping the tree`);
    await stopStack(rec, { keepTree: true, log }).catch((e) => say(log, `teardown after failure: ${e.message}`));
    rec.state = "failed";
    saveRecord(rec);
    throw err;
  }
}

/** This process and its ancestors: never signalled, whatever they carry. */
function selfAndAncestors(table) {
  const mine = new Set();
  for (let pid = process.pid, guard = 0; pid > 1 && guard < 64; guard++) {
    mine.add(pid);
    pid = table.find((p) => p.pid === pid)?.ppid ?? 0;
  }
  return mine;
}

/** What a stop's drain did, for rec.stopped.databaseLog. */
function drainSummary(r) {
  if (!r) return null;
  if (r.error) return { error: r.error };
  return { records: r.records, total: r.total, bytes: r.bytes, read: r.read, reset: r.reset, ...(r.busy ? { busy: true } : {}), ...(r.missing ? { missing: true } : {}) };
}

/** drainDatabaseLog for a stop: a drain another process holds is waited for (up to `waitMs`); never throws. */
async function drainForStop(rec, log, { waitMs = 5_000 } = {}) {
  const end = Date.now() + waitMs;
  for (;;) {
    let r;
    try {
      r = drainDatabaseLog(rec);
    } catch (err) {
      say(log, `stack ${rec.runId}: keeping the Database emulator's log failed: ${err.message}`);
      return { error: String(err?.message ?? err).slice(0, 500) };
    }
    if (!r?.busy || Date.now() >= end) return r;
    await sleep(200);
  }
}

/**
 * Stop a stack: SIGINT each recorded group (emulators first), 30 s, SIGTERM,
 * SIGKILL — each only while its leader carries the stack's mark; then every
 * other process that carries the mark (its group when the group's leader is
 * marked, else that pid alone); release the port lock; delete the tree unless
 * kept or failed. Processes near the tree without the mark are left alone and
 * listed in rec.stopped.leftAlone.
 *
 * The Database emulator's records still in firebase-debug.log are drained to
 * logs/database-debug.log after the watchdog is stopped and BEFORE the
 * emulators are signalled (firebase-tools unlinks the file when it exits
 * cleanly), the file is hard-linked into the stack dir, and the link is
 * drained once more when the processes are gone (the shutdown lines), then
 * removed: rec.stopped.databaseLog = {file, before, after, pinned} (each
 * drain {records, total, bytes, read, reset[, busy][, missing]} or {error}),
 * also returned as `databaseLog`. A drain never stops a teardown.
 *
 * state: "stopped" | "failed" (a stack that failed to start, now stopped) |
 * "stop-incomplete" (something marked survived; lock and tree kept) |
 * "stop-refused" (a record with no mark, from an older harness: nothing signalled).
 */
export async function stopStack(recOrRunId, { keepTree = false, log, graceMs } = {}) {
  const rec = typeof recOrRunId === "string" ? readRecord(recOrRunId) : recOrRunId;
  if (!rec) throw new Error(`no stack record for ${recOrRunId}`);
  if (!rec.mark) {
    const alive = (rec.processes ?? []).filter((p) => groupAlive(p.pgid)).map((p) => p.pgid);
    say(log, `stack ${rec.runId}: the record carries no provenance mark (an older harness made it), so nothing is signalled${alive.length ? `; recorded groups still alive: ${alive.join(", ")}` : ""}`);
    return { runId: rec.runId, state: "stop-refused", results: [], survivors: alive, treeKept: true };
  }
  const failed = rec.state === "failed";
  rec.state = "stopping";
  saveRecord(rec);
  const results = [];
  try {
    trackChildren(rec);
  } catch {}
  const killOpts = { mark: rec.mark, ...(graceMs != null ? { graceMs, termMs: graceMs } : {}) };
  // The watchdog first: it exits at once, and must not act on a stack being stopped.
  const order = { watchdog: -1, emulators: 0, "emulators-child": 1, shim: 2, aux: 2, mailpit: 3 };
  const procs = [...(rec.processes ?? [])].sort((a, b) => (order[a.name] ?? 9) - (order[b.name] ?? 9));
  const handled = new Set();
  // The caller's own group is never signalled: the watchdog stops its stack from inside it.
  const own = selfAndAncestors(processTable());
  let dbPaths = null;
  try {
    dbPaths = databaseLogPaths(rec);
  } catch (err) {
    say(log, `stack ${rec.runId}: no Database emulator log: ${err.message}`);
  }
  const databaseLog = { file: dbPaths?.out ?? null, before: null, after: null, pinned: false };
  let drainedBefore = false;
  // Once the watchdog is stopped, and before anything else is: the emulators' clean exit unlinks firebase-debug.log.
  const drainBefore = async () => {
    if (drainedBefore || !dbPaths) return;
    drainedBefore = true;
    databaseLog.before = drainSummary(await drainForStop(rec, log));
    try {
      databaseLog.pinned = !!pinDebugLog(rec).pinned;
    } catch {}
  };
  for (const p of procs) {
    if (p.name !== "watchdog") await drainBefore();
    if (handled.has(p.pgid)) continue;
    handled.add(p.pgid);
    if (own.has(p.pgid) || own.has(p.pid)) {
      results.push({ name: p.name, pgid: p.pgid, sent: [], gone: false, skipped: "the stopping process itself" });
      continue;
    }
    const r = await killGroup(p.pgid, killOpts);
    results.push({ name: p.name, ...r });
    say(log, `stop ${p.name} pgid ${p.pgid}: ${r.gone ? "gone" : "STILL RUNNING"}${r.sent.length ? ` after ${r.sent.join(" → ")}` : ""}${r.skipped ? ` (${r.skipped})` : ""}`);
  }

  // Anything else that carries this stack's mark: a whole group only when its
  // leader is marked too, otherwise each pid by itself.
  let table = processTable();
  let mine = selfAndAncestors(table);
  const strays = markedProcesses(rec.mark, table).filter((p) => !mine.has(p.pid));
  const leaders = new Set(strays.filter((p) => p.pid === p.pgid).map((p) => p.pgid));
  for (const pgid of leaders) {
    if (handled.has(pgid) || mine.has(pgid)) continue;
    handled.add(pgid);
    const r = await killGroup(pgid, killOpts);
    results.push({ name: "stray-group", ...r });
    say(log, `stop stray group ${pgid} (leader marked): ${r.gone ? "gone" : "STILL RUNNING"}${r.skipped ? ` (${r.skipped})` : ""}`);
  }
  await drainBefore();
  const loose = strays.filter((p) => !leaders.has(p.pgid) || !handled.has(p.pgid)).map((p) => p.pid);
  if (loose.length > 0) {
    const r = await killMarkedPids(loose, killOpts);
    for (const x of r) {
      results.push({ name: "stray-pid", ...x });
      say(log, `stop stray pid ${x.pid} (marked, in an unmarked group): ${x.gone ? "gone" : "STILL RUNNING"}${x.sent.length ? ` after ${x.sent.join(" → ")}` : ""}`);
    }
  }

  // What is left: marked processes are survivors; anything near the tree
  // without the mark is somebody else's and is only reported.
  table = processTable();
  mine = selfAndAncestors(table);
  const stillMarked = markedProcesses(rec.mark, table).filter((p) => !mine.has(p.pid));
  // A leader born after this group was recorded proves its ID was recycled.
  // Unknown start times and leaderless groups remain unverified; never signal
  // an unrelated process just because its ID appears in an old stack record.
  const leaderStarts = processStartSecs(procs.map(p => p.pgid));
  const unverified = procs
    .filter(p => !(leaderStarts.get(p.pgid) * 1000 > Date.parse(p.startedAt) + 2000))
    .filter((p) => groupAlive(p.pgid) && !own.has(p.pgid) && !own.has(p.pid))
    .map((p) => ({ name: p.name, pgid: p.pgid, ...groupOwnership(p.pgid, rec.mark) }))
    .filter((g) => !g.owned)
    .map((g) => ({ name: g.name, pgid: g.pgid, reason: g.reason }));
  const markedSet = new Set(stillMarked.map((p) => p.pid));
  const leftAlone = existsSync(rec.treeDir)
    ? processesUnder(rec.treeDir).filter((p) => !mine.has(p.pid) && !markedSet.has(p.pid)).map((p) => ({ pid: p.pid, pgid: p.pgid, command: p.command.slice(0, 200) }))
    : [];
  for (const p of leftAlone) say(log, `left alone (near the tree, no provenance mark): pid ${p.pid} pgid ${p.pgid} ${p.command.slice(0, 120)}`);
  for (const g of unverified) say(log, `recorded ${g.name} pgid ${g.pgid} is alive but not provably the stack's (${g.reason}); not signalled`);
  const survivors = stillMarked.map((p) => ({ pid: p.pid, pgid: p.pgid, command: p.command.slice(0, 200) }));
  for (const p of survivors) say(log, `SURVIVOR pid ${p.pid} pgid ${p.pgid}: ${p.command.slice(0, 120)}`);
  const incomplete = survivors.length > 0 || unverified.length > 0;
  if (dbPaths) {
    // The pinned link holds what the emulators printed while stopping.
    databaseLog.after = drainSummary(await drainForStop(rec, log));
    try {
      unpinDebugLog(rec);
    } catch {}
    const total = databaseLog.after?.total ?? databaseLog.before?.total ?? null;
    if (total) say(log, `stack ${rec.runId}: the Database emulator's log, ${total} record(s), is ${databaseLog.file}`);
  }
  rec.stopped = { at: new Date().toISOString(), results, survivors, unverified, leftAlone, databaseLog };
  if (!incomplete) releaseLockFile(rec.lockPath, rec.runId);
  const keep = keepTree || failed || incomplete;
  rec.state = incomplete ? "stop-incomplete" : failed ? "failed" : "stopped";
  // Its processes are gone: the short TMPDIR goes whether or not the tree is
  // kept (it holds sockets and the hub file, nothing anyone reads later).
  const tmpRemoved = incomplete ? false : removeShortTmp(rec);
  saveRecord(rec);
  if (!keep) removeTree(rec.stackDir);
  return { runId: rec.runId, state: rec.state, results, survivors, unverified, leftAlone, treeKept: keep, tmpRemoved, databaseLog };
}

/** The /tmp/bshd-<runId> TMPDIR of a record, when it is exactly that (else null). */
export function shortTmpOf(rec) {
  const want = `/tmp/bshd-${rec?.runId}`;
  return rec?.runId && rec.tmpDir === want ? want : null;
}

/** Remove a record's /tmp/bshd-<runId> and the link to it in the stack dir. Only call once its processes are gone. */
export function removeShortTmp(rec) {
  const tmp = shortTmpOf(rec);
  if (!tmp) return false;
  const existed = existsSync(tmp);
  rmSync(tmp, { recursive: true, force: true });
  try {
    const link = join(rec.stackDir, "tmp");
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  } catch {}
  return existed;
}

/** True while any recorded group of the stack, or any process carrying its mark, is alive. */
function stackAlive(rec) {
  if ((rec.processes ?? []).some((p) => groupAlive(p.pgid))) return true;
  if (!rec.mark) return true; // an older record: no way to prove it is idle
  const mine = selfAndAncestors(processTable());
  return markedProcesses(rec.mark).some((p) => !mine.has(p.pid));
}

/**
 * The resident memory of a stack: the sum over every live process carrying
 * its mark, and the same split by what each process is (an emulator JVM by
 * its role, a recorded process by its name, anything else — function
 * workers, the CLI's helpers — as "other").
 * @returns {{totalBytes:number, processes:number, by:Object<string, number>}}
 */
export function stackRss(rec, { marks = envValues(STACK_MARK_KEY), rss = rssBytes() } = {}) {
  const pids = rec?.mark ? [...marks].filter(([, m]) => m === rec.mark).map(([pid]) => pid) : [];
  const role = new Map();
  for (const j of jvmEvents(rec?.stackDir).started) role.set(j.pid, `java:${j.role}`);
  for (const p of rec?.processes ?? []) if (!role.has(p.pid)) role.set(p.pid, p.name);
  const by = {};
  let totalBytes = 0;
  for (const pid of pids) {
    const b = rss.get(pid) ?? 0;
    totalBytes += b;
    const k = role.get(pid) ?? "other";
    by[k] = (by[k] ?? 0) + b;
  }
  return { totalBytes, processes: pids.length, by };
}

/**
 * What holds a stack's resources down, read live (the smoke canary
 * specs/smoke/resources.spec.mjs reads it through here, never stack.json):
 * every JVM the wrapper started with the -Xmx its command line carries, the
 * debug logs' state, the watchdog, the owner, the lease, and the RSS.
 * @returns {{caps:object, jvms:{role:string, pid:number, alive:boolean, xmxMb:number|null, exitOnOom:boolean}[], debugLogs:{maxBytes:number, files:{name:string, link:string|null, size:number}[]}, watchdog:{pid:number, alive:boolean}|null, owner:object, lease:object|null, rss:object}}
 */
export function stackResources(runId) {
  const rec = readRecord(runId);
  if (!rec) throw new Error(`no stack ${runId}`);
  const jvms = jvmEvents(rec.stackDir).started.map((j) => {
    let command = "";
    try {
      command = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(j.pid)], { encoding: "utf8" });
    } catch {}
    const xmx = / -Xmx(\d+)m /.exec(` ${command} `);
    return { role: j.role, pid: j.pid, alive: j.alive, xmxMb: xmx ? Number(xmx[1]) : null, exitOnOom: command.includes(" -XX:+ExitOnOutOfMemoryError ") };
  });
  const files = [];
  for (const name of ["firebase-debug.log", "firestore-debug.log", "database-debug.log"]) {
    try {
      const st = lstatSync(join(rec.treeDir, name));
      files.push({ name, link: st.isSymbolicLink() ? readlinkSync(join(rec.treeDir, name)) : null, size: st.isSymbolicLink() ? 0 : st.size });
    } catch {}
  }
  const wd = (rec.processes ?? []).find((p) => p.name === "watchdog");
  return {
    caps: rec.jvm?.heapMb ?? null,
    jvms,
    debugLogs: { maxBytes: rec.debugLogs?.maxBytes ?? null, files },
    watchdog: wd ? { pid: wd.pid, alive: isPidAlive(wd.pid) } : null,
    owner: rec.owner ?? null,
    keep: !!rec.keep,
    createdAt: rec.createdAt,
    lease: readLease(rec.stackDir),
    rss: stackRss(rec),
  };
}

/**
 * Every stack this machine knows of, with liveness, owner and expiry; with
 * `resources`, each one's resident memory too (stackRss, one process-table
 * scan for all of them).
 */
export function listStacks({ resources = false } = {}) {
  if (!existsSync(STACKS_DIR)) return [];
  const recs = [];
  const out = [];
  for (const runId of readdirSync(STACKS_DIR).sort()) {
    const rec = readRecord(runId);
    if (!rec) out.push({ runId, state: "unknown" });
    else recs.push(rec);
  }
  const starts = ownerStarts(recs);
  const scan = resources ? { marks: envValues(STACK_MARK_KEY, null, environments()), rss: rssBytes() } : null;
  for (const rec of recs) {
    const lease = readLease(rec.stackDir);
    const alive = ownerAlive(rec, { starts });
    out.push({
      runId: rec.runId,
      state: rec.state,
      keep: !!rec.keep,
      origin: rec.origin,
      ports: rec.portBase ? `${rec.portBase}-${rec.portBase + (rec.portSize ?? (Object.keys(rec.ports ?? {}).length || 16)) - 1}` : null,
      // Kept for older readers: the owner, by pid AND start second where the record has one.
      creatorAlive: alive,
      owner: rec.owner ? { pid: rec.owner.pid, startedAt: rec.owner.startedAt, alive } : { pid: rec.createdBy?.pid ?? null, startedAt: null, alive },
      expiresAt: lease?.expiresAt ?? null,
      hardExpiresAt: lease?.hardExpiresAt ?? null,
      jvmHeapMb: rec.jvm?.heapMb ?? null,
      failure: rec.failure?.reason ?? (rec.state === "failed" && rec.error ? String(rec.error).split("\n")[0] : null),
      stopReason: rec.stopReason?.reason ?? null,
      processes: (rec.processes ?? []).map((p) => ({ name: p.name, pgid: p.pgid, alive: groupAlive(p.pgid) })),
      ...(scan ? { rss: stackRss(rec, scan) } : {}),
      createdAt: rec.createdAt,
      treeDir: rec.treeDir,
    });
  }
  return out;
}

/**
 * reap's rule for one stack (without --all or names): an ORPHAN — its owner
 * gone, and it is not kept or not ready — or EXPIRED — its lease ran out or it
 * reached the hard maximum (lifetime.mjs stackVerdict).
 * @returns {{reap:boolean, expired:boolean, why:string|null}}
 */
export function reapDecision({ rec, lease, ownerIsAlive, now = Date.now() }) {
  if (!rec) return { reap: false, expired: false, why: null };
  const v = stackVerdict({ rec, lease, now, ownerIsAlive });
  const expired = v.action === "stop" && /^(expired|max-lifetime)/.test(v.reason);
  const orphan = !ownerIsAlive && (!rec.keep || rec.state !== "ready");
  if (expired) return { reap: true, expired, why: v.reason };
  if (orphan) return { reap: true, expired, why: `orphan: owner pid ${rec.owner?.pid ?? rec.createdBy?.pid} is gone` };
  return { reap: false, expired, why: null };
}

/**
 * Kill orphaned and expired stacks. Default: stacks whose owner is gone and
 * that are either not kept or not ready, and every stack whose lease ran out
 * or that reached the hard maximum (lifetime.mjs). `all`: every stack.
 * `runIds`: just those. `auto` (run and stack up call it first): the default
 * rule, but a stack with nothing left running is not touched, so a failed
 * stack's tree stays for whoever is reading it. Only processes carrying the
 * stack's mark are signalled (see stopStack). Dead port locks are removed.
 */
export async function reap({ all = false, runIds = [], auto = false, log, now = Date.now() } = {}) {
  const done = [];
  const tmpRemoved = [];
  for (const s of listStacks()) {
    const named = runIds.length > 0;
    if (named && !runIds.includes(s.runId)) continue;
    let why = named ? "named" : all ? "--all" : null;
    if (!named && !all) {
      const rec0 = readRecord(s.runId);
      const d = reapDecision({ rec: rec0, lease: rec0 ? readLease(rec0.stackDir) : null, ownerIsAlive: s.creatorAlive, now });
      if (!d.reap) continue;
      why = d.why;
      const expired = d.expired;
      if (!expired && auto && !(s.processes ?? []).some((p) => p.alive) && s.state !== "starting" && s.state !== "stopping" && s.state !== "ready") {
        // Nothing to stop, and the tree stays for whoever reads it; the short
        // TMPDIR does not, once nothing of the stack is running.
        const idle = readRecord(s.runId);
        if (idle && shortTmpOf(idle) && existsSync(shortTmpOf(idle)) && !stackAlive(idle) && removeShortTmp(idle)) tmpRemoved.push(shortTmpOf(idle));
        continue;
      }
    }
    const rec = readRecord(s.runId);
    if (!rec) continue;
    if (!rec.treeDir || !rec.treeDir.startsWith(STACKS_DIR)) {
      say(log, `reap ${s.runId}: record has no stack tree path, not signalling anything`);
      continue;
    }
    if (rec.state !== "stopped" && rec.state !== "failed") rec.stopReason = { at: new Date(now).toISOString(), by: "reap", reason: why };
    const r = await stopStack(rec, { keepTree: false, log });
    if (r.tmpRemoved) tmpRemoved.push(shortTmpOf(rec));
    if (r.state === "stopped" || r.state === "failed") {
      rec.state = "reaped";
      rec.reapedAt = new Date().toISOString();
      try {
        writeFileSync(join(rec.runDir, "stack.json"), JSON.stringify(rec, null, 2) + "\n");
      } catch {}
      // An automatic reap keeps a failed stack's tree: somebody may be reading it.
      if (!(auto && r.state === "failed") && existsSync(rec.stackDir)) removeTree(rec.stackDir);
    }
    done.push({ runId: s.runId, state: r.state, why });
  }
  const locks = [];
  if (existsSync(LOCKS_DIR)) {
    for (const name of readdirSync(LOCKS_DIR)) {
      if (!/^ports-\d+\.lock$/.test(name)) continue;
      const path = join(LOCKS_DIR, name);
      let content = null;
      try {
        content = JSON.parse(readFileSync(path, "utf8"));
      } catch {}
      if (content && !lockIsLive(content)) {
        releaseLockFile(path, content.runId);
        locks.push(name);
      }
    }
  }
  // A short TMPDIR whose stack directory is already gone (removed by an
  // earlier reap): removed when the run's record names it and nothing of the
  // stack runs. One with no record at all is left, and listed.
  const strayTmp = [];
  let names = [];
  try {
    names = readdirSync("/tmp");
  } catch {}
  for (const name of names) {
    const m = /^bshd-([a-z0-9][a-z0-9-]{3,39})$/.exec(name);
    if (!m || (runIds.length > 0 && !runIds.includes(m[1]))) continue;
    const rec = readRecord(m[1]);
    if (!rec) {
      strayTmp.push(`/tmp/${name}`);
      continue;
    }
    // A stack its creator is still starting or stopping may have no process
    // running for a moment; its TMPDIR is not idle.
    if ((rec.state === "starting" || rec.state === "stopping") && isPidAlive(rec.createdBy?.pid)) continue;
    if (shortTmpOf(rec) === `/tmp/${name}` && !stackAlive(rec) && removeShortTmp(rec)) tmpRemoved.push(`/tmp/${name}`);
  }
  return { stacks: done, locksRemoved: locks, tmpRemoved, ...(strayTmp.length ? { strayTmp } : {}) };
}

