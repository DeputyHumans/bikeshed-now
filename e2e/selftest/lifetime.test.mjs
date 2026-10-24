// SPDX-License-Identifier: Apache-2.0
// Self-test: every stack has an owner and an expiry, and its watchdog stops it at expiry, when an orphan's owner dies, or fails it when an emulator dies — with no harness command running (SPEC §12).

/**
 * The rules (lifetime.mjs) as units; then real watchdog processes
 * (watchdog.mjs, started as startStack starts one) on fake stacks under
 * ~/.cache/bikeshed-e2e/stacks whose only process is a marked sleeper in its
 * own group, as a stack's emulator is. Each fake stack lives seconds; `after`
 * stops whatever is left.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OUT_DIR, STACKS_DIR, ensureDir } from "../lib/paths.mjs";
import { STACK_MARK_KEY, SYSTEM_PATH, buildEnv, isPidAlive, newStackMark, processStartSecs, selfIdentity, spawnDetached } from "../lib/proc.mjs";
import { HOUR_MS, extendLease, initialLease, lifetimeConfig, ownerIdentity, readLease, stackVerdict, writeLease } from "../lib/lifetime.mjs";
import { readRecord, reapDecision, saveRecord, stopStack } from "../lib/stack.mjs";
import { spawnWatchdog } from "../lib/watchdog.mjs";
import { installJavaWrapper } from "../lib/jvm.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const KEEP = "setInterval(() => {}, 1000)";
const NODE_BIN = dirname(process.execPath);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const made = [];
let seq = 0;

after(async () => {
  for (const rec of made) {
    const now = readRecord(rec.runId) ?? rec;
    if (now.state !== "stopped" && now.state !== "failed") await stopStack(now, { log: () => {}, graceMs: 500 }).catch(() => undefined);
    rmSync(rec.stackDir, { recursive: true, force: true });
    rmSync(rec.runDir, { recursive: true, force: true });
  }
});

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`not within ${ms} ms: ${what}`);
}

/** A fake stack: record, lease, one marked sleeper named "emulators"; optionally a watchdog. */
function fakeStack({ keep = true, state = "ready", leaseMs = HOUR_MS, owner = ownerIdentity(), watchdog = true } = {}) {
  const runId = `selftest-wd${process.pid}-${++seq}`;
  const stackDir = ensureDir(join(STACKS_DIR, runId), "stackDir");
  const treeDir = ensureDir(join(stackDir, "tree"), "treeDir");
  const runDir = ensureDir(join(OUT_DIR, runId), "runDir");
  const logs = ensureDir(join(runDir, "logs"), "logs");
  const tmp = tempDir("e2e-lifetime-");
  const mark = newStackMark(runId);
  const env = buildEnv({ path: [NODE_BIN, ...SYSTEM_PATH], tmpdir: tmp, set: { [STACK_MARK_KEY]: mark } });
  const sleeper = spawnDetached(process.execPath, ["-e", KEEP], { cwd: treeDir, env, logFile: join(logs, "emulators.log") });
  const now = Date.now();
  const rec = {
    runId,
    mark,
    state,
    keep,
    createdAt: new Date(now).toISOString(),
    createdBy: { pid: owner.pid },
    owner,
    stackDir,
    treeDir,
    runDir,
    tmpDir: tmp,
    logs: { emulators: join(logs, "emulators.log"), watchdog: join(logs, "watchdog.log") },
    processes: [{ name: "emulators", ...sleeper }],
  };
  writeLease(stackDir, { ...initialLease({ createdAtMs: now, keep, config: { ttlMs: HOUR_MS, extendMs: 2 * HOUR_MS, maxMs: 8 * HOUR_MS } }), expiresAt: new Date(now + leaseMs).toISOString() });
  saveRecord(rec);
  made.push(rec);
  if (watchdog) {
    rec.processes.unshift(spawnWatchdog(rec, { nodeBin: NODE_BIN, pollMs: 300 }));
    saveRecord(rec);
  }
  return { rec, sleeper, wd: rec.processes.find((p) => p.name === "watchdog") };
}

/** A process that is somebody's owner, then is killed. */
async function mortalOwner() {
  const child = spawn(process.execPath, ["-e", KEEP], { stdio: "ignore" });
  await sleep(300);
  const startSec = processStartSecs([child.pid]).get(child.pid);
  return { child, identity: { pid: child.pid, startSec, startedAt: new Date(startSec * 1000).toISOString() } };
}

test("lifetime defaults: a kept stack 4 h, an attach makes it 2 h from then, the hard maximum 8 h and never more", () => {
  assert.deepEqual(lifetimeConfig({ env: {} }), { ttlMs: 4 * HOUR_MS, extendMs: 2 * HOUR_MS, maxMs: 8 * HOUR_MS });
  assert.deepEqual(lifetimeConfig({ env: {}, ttlHours: 1 }).ttlMs, HOUR_MS);
  assert.throws(() => lifetimeConfig({ env: { E2E_STACK_MAX_H: "9" } }), /at most 8/);
  assert.throws(() => lifetimeConfig({ env: {}, ttlHours: 9 }), /hard maximum/);
  assert.equal(lifetimeConfig({ env: { E2E_STACK_MAX_H: "2" } }).ttlMs, 2 * HOUR_MS, "the ttl never exceeds a lowered maximum");
  const t0 = Date.parse("2026-10-13T00:00:00Z");
  const config = lifetimeConfig({ env: {} });
  assert.deepEqual([initialLease({ createdAtMs: t0, keep: true, config }).expiresAt, initialLease({ createdAtMs: t0, keep: true, config }).hardExpiresAt], ["2026-10-13T04:00:00.000Z", "2026-10-13T08:00:00.000Z"]);
  assert.equal(initialLease({ createdAtMs: t0, keep: false, config }).expiresAt, "2026-10-13T08:00:00.000Z", "a stack the run stops expires at the hard maximum");
});

test("an attach extends by at most 2 h from then, never shortens, never passes the hard maximum", () => {
  const dir = tempDir("e2e-lease-");
  const t0 = Date.parse("2026-10-13T00:00:00Z");
  writeLease(dir, initialLease({ createdAtMs: t0, keep: true, config: lifetimeConfig({ env: {} }) }));
  const a = extendLease(dir, { now: t0 + 3.5 * HOUR_MS });
  assert.equal(a.to, "2026-10-13T05:30:00.000Z");
  assert.equal(a.addedMs, 1.5 * HOUR_MS, "adds what makes it 2 h from now: never more than 2 h");
  const b = extendLease(dir, { now: t0 + 3.6 * HOUR_MS });
  assert.equal(b.to, "2026-10-13T05:36:00.000Z");
  const c = extendLease(dir, { now: t0 + 1 * HOUR_MS });
  assert.equal(c.to, "2026-10-13T05:36:00.000Z", "never shortens");
  const d = extendLease(dir, { now: t0 + 7 * HOUR_MS });
  assert.deepEqual([d.to, d.capped], ["2026-10-13T08:00:00.000Z", true], "never past the hard maximum");
  assert.equal(readLease(dir).extensions.length, 4);
});

test("the verdict: expiry, the hard maximum, an orphan's owner gone, an emulator dead; a kept ready stack outlives its owner", () => {
  const now = Date.parse("2026-10-13T05:00:00Z");
  const lease = { expiresAt: "2026-10-13T06:00:00Z", hardExpiresAt: "2026-10-13T08:00:00Z" };
  const v = (rec, o = {}) => stackVerdict({ rec: { state: "ready", keep: true, owner: { pid: 1, startedAt: "t" }, ...rec }, lease, now, ownerIsAlive: true, ...o }).action;
  assert.equal(v({}), "none");
  assert.equal(v({}, { now: Date.parse("2026-10-13T06:00:00Z") }), "stop", "expired");
  assert.equal(v({}, { lease: { expiresAt: "2026-10-13T09:00:00Z", hardExpiresAt: "2026-10-13T05:00:00Z" } }), "stop", "max-lifetime even with a later lease");
  assert.equal(v({}, { ownerIsAlive: false }), "none", "kept and ready: it outlives its owner");
  assert.equal(v({ keep: false }, { ownerIsAlive: false }), "stop", "not kept, owner gone");
  assert.equal(v({ state: "starting" }, { ownerIsAlive: false }), "stop", "kept but still starting, owner gone");
  assert.equal(v({}, { failures: [{ reason: "the Firestore emulator ran out of memory" }] }), "fail");
  assert.equal(v({ state: "starting" }, { failures: [{ reason: "x" }] }), "none", "readiness judges a starting stack");
  assert.equal(v({ state: "stopped" }), "settled");
  assert.equal(v({ state: "stopping" }, { ownerIsAlive: false, failures: [{ reason: "x" }] }), "none", "a stack being stopped is its stopper's");
  assert.equal(v({ state: "stop-incomplete" }, { now: Date.parse("2026-10-13T06:00:00Z") }), "stop", "…unless its lease ran out");
  assert.match(stackVerdict({ rec: { state: "ready", keep: true }, lease, now: Date.parse("2026-10-13T06:00:01Z"), ownerIsAlive: true }).reason, /^expired: /);
  // reap's rule: an orphan, or expired.
  assert.deepEqual([reapDecision({ rec: { state: "ready", keep: true }, lease, ownerIsAlive: false, now }).reap, reapDecision({ rec: { state: "ready", keep: true }, lease, ownerIsAlive: false, now: Date.parse("2026-10-13T07:00:00Z") }).reap, reapDecision({ rec: { state: "ready", keep: false }, lease, ownerIsAlive: false, now }).reap], [false, true, true]);
});

test("the watchdog stops a kept stack when its lease runs out, with no harness command running, and exits", async () => {
  const { rec, sleeper, wd } = fakeStack({ leaseMs: 1500 });
  await until(() => !isPidAlive(sleeper.pid), 15_000, "the stack's process stopped at expiry");
  await until(() => !isPidAlive(wd.pid), 10_000, "the watchdog exited");
  const after = JSON.parse(readFileSync(join(rec.runDir, "stack.json"), "utf8"));
  assert.equal(after.state, "stopped", "the watchdog exits only after the teardown");
  assert.equal(after.stopReason.by, "watchdog");
  assert.match(after.stopReason.reason, /^expired: /);
  assert.equal(existsSync(rec.stackDir), false, "an expired stack's tree is removed");
});

test("NEGATIVE: without its watchdog, the same expired stack keeps running", async () => {
  const { rec, sleeper } = fakeStack({ leaseMs: 1000, watchdog: false });
  await sleep(3000);
  assert.ok(isPidAlive(sleeper.pid), "nothing stopped it: the lease alone does nothing");
  assert.equal(readRecord(rec.runId).state, "ready");
  await stopStack(readRecord(rec.runId), { log: () => {}, graceMs: 500 });
});

test("the watchdog stops a stack the run does not keep as soon as its owner is gone", async () => {
  const owner = await mortalOwner();
  const { rec, sleeper } = fakeStack({ keep: false, owner: owner.identity });
  await sleep(800);
  assert.ok(isPidAlive(sleeper.pid), "alive while its owner is");
  owner.child.kill("SIGKILL");
  await until(() => !isPidAlive(sleeper.pid), 15_000, "stopped once the owner died");
  await until(() => JSON.parse(readFileSync(join(rec.runDir, "stack.json"), "utf8")).state === "stopped", 10_000, "the teardown finished");
  const after = JSON.parse(readFileSync(join(rec.runDir, "stack.json"), "utf8"));
  assert.match(after.stopReason.reason, /^owner-gone: /);
});

test("the watchdog fails a ready stack whose emulator ran out of memory, naming it, and keeps its tree", async () => {
  const { rec, sleeper } = fakeStack();
  const p = installJavaWrapper({ stackDir: rec.stackDir, realJava: "/usr/bin/true", heap: { firestore: 2048, database: 1024, other: 512 }, runId: rec.runId });
  writeFileSync(p.started, `firestore ${sleeper.pid} 2048m\n`);
  writeFileSync(p.oom, `firestore ${sleeper.pid}\n`);
  await until(() => !isPidAlive(sleeper.pid), 15_000, "stopped after the failure");
  const final = () => JSON.parse(readFileSync(join(rec.runDir, "stack.json"), "utf8"));
  await until(() => final().state !== "stopping", 10_000, "the teardown finished");
  const after = final();
  assert.equal(after.state, "failed");
  assert.match(after.failure.reason, /^the Firestore emulator \(pid \d+\) ran out of memory: java\.lang\.OutOfMemoryError at its -Xmx2048m cap$/);
  assert.ok(existsSync(rec.treeDir), "a failed stack's tree stays to be read");
});

test("a teardown by anybody else ends the watchdog at once", async () => {
  const { rec, wd } = fakeStack();
  await sleep(500);
  assert.ok(isPidAlive(wd.pid));
  const r = await stopStack(readRecord(rec.runId), { log: () => {}, graceMs: 2000 });
  assert.equal(r.state, "stopped");
  assert.equal(isPidAlive(wd.pid), false);
  assert.deepEqual(r.results.find((x) => x.name === "watchdog").sent, ["SIGINT"], `the stopper stops the watchdog, which does not race it: ${JSON.stringify(r.results)}`);
});

test("an owner is a pid and its start second: the same pid with another start is somebody else", () => {
  const me = selfIdentity();
  assert.ok(reapDecision({ rec: { state: "ready", keep: false, owner: me }, lease: null, ownerIsAlive: false }).reap);
  assert.equal(ownerIdentity().pid, process.pid);
});


test("teardown releases a reused group ID but retains unknown or same-process identities", async () => {
  const child = spawn(process.execPath, ["-e", KEEP], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } });
  try {
    await until(() => processStartSecs([child.pid]).has(child.pid), 5000, "unrelated process starts");
    const started = processStartSecs([child.pid]).get(child.pid);
    for (const [label, startedAt, expected] of [
      ["unknown", undefined, "stop-incomplete"],
      ["same", new Date(started * 1000).toISOString(), "stop-incomplete"],
      ["reused", new Date((started - 60) * 1000).toISOString(), "stopped"],
    ]) {
      const { rec } = fakeStack({ watchdog: false });
      rec.processes.push({ name: "emulators-child", pid: child.pid, pgid: child.pid, startedAt });
      saveRecord(rec);
      const result = await stopStack(rec, { log: () => {}, graceMs: 500 });
      assert.equal(result.state, expected, `${label} process identity determines slot retention`);
      await sleep(100); // Let child exit notifications settle before checking preservation.
      assert.equal(isPidAlive(child.pid), true, `${label} unrelated process is never signalled`);
      rec.processes = rec.processes.filter(p => p.pid !== child.pid);
      saveRecord(rec);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once("close", resolve));
      child.kill("SIGKILL");
      await closed;
    }
  }
});
