// SPDX-License-Identifier: Apache-2.0
// Self-test: teardown signals only processes that carry the stack's mark, never a stranger near its tree, and leaves no short TMPDIR (SPEC §12).

/**
 * Real processes, a fake stack record. Five shapes:
 *
 *   A  recorded group, marked, cwd = tree               → stopped
 *   B  unrecorded group whose leader and child are marked → stopped (group)
 *   C  a stranger whose cwd is the tree and whose argv names it
 *      (another session's grep, tail or editor helper)  → LEFT ALONE
 *   D  a stranger's group with one member's cwd in the tree → LEFT ALONE, both
 *   E  a stranger's leader whose child carries the mark → only the child stops
 *
 * Under the old rule (argv or cwd under the tree proves ownership, then signal
 * the whole group) C and both members of D were killed.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_TMP, OUT_DIR, ensureDir } from "../lib/paths.mjs";
import { STACK_MARK_KEY, SYSTEM_PATH, buildEnv, hasMark, isPidAlive, newStackMark, spawnDetached } from "../lib/proc.mjs";
import { reap, stopStack } from "../lib/stack.mjs";

const SPAWNER = fileURLToPath(new URL("./helpers/spawner.mjs", import.meta.url));
const KEEP = "setInterval(() => {}, 1000)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = [];

after(() => {
  for (const pid of started) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

async function pidFrom(file) {
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) {
      const n = Number(readFileSync(file, "utf8"));
      if (n > 0) return n;
    }
    await sleep(50);
  }
  throw new Error(`no pid in ${file}`);
}

test("stopStack signals marked processes only; strangers in or near the tree survive", async () => {
  const runId = `selftest-td${process.pid}`;
  const tmp = mkdtempSync(join(tmpdir(), "e2e-teardown-"));
  const stackDir = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-teardown-"));
  const treeDir = join(stackDir, "tree");
  mkdirSync(treeDir);
  const mark = newStackMark(runId);
  const path = [dirname(process.execPath), ...SYSTEM_PATH];
  const markedEnv = buildEnv({ path, tmpdir: tmp, set: { [STACK_MARK_KEY]: mark } });
  const plainEnv = buildEnv({ path, tmpdir: tmp });
  const logFile = join(tmp, "procs.log");
  const node = process.execPath;
  const spawnTracked = (args, o) => {
    const p = spawnDetached(node, args, { logFile, ...o });
    started.push(p.pid);
    return p;
  };
  try {
    const A = spawnTracked(["-e", KEEP], { cwd: treeDir, env: markedEnv });
    const B = spawnTracked([SPAWNER, join(tmp, "b.pid"), treeDir, mark], { cwd: treeDir, env: markedEnv });
    const C = spawnTracked(["-e", KEEP, join(treeDir, "firebase.json")], { cwd: treeDir, env: plainEnv });
    const D = spawnTracked([SPAWNER, join(tmp, "d.pid"), treeDir], { cwd: tmp, env: plainEnv });
    const E = spawnTracked([SPAWNER, join(tmp, "e.pid"), treeDir, mark], { cwd: tmp, env: plainEnv });
    const [b2, d2, e2] = await Promise.all([pidFrom(join(tmp, "b.pid")), pidFrom(join(tmp, "d.pid")), pidFrom(join(tmp, "e.pid"))]);
    await sleep(300);

    // The mark is read from the environment, and only there.
    assert.equal(hasMark(A.pid, mark), true, "A carries the mark");
    assert.equal(hasMark(b2, mark), true, "B's child inherited it");
    assert.equal(hasMark(C.pid, mark), false, "C does not, though its argv names the tree");
    assert.equal(hasMark(e2, mark), true, "E's child was given it");
    assert.equal(hasMark(E.pid, mark), false, "E's leader was not");

    const rec = {
      runId,
      mark,
      state: "ready",
      stackDir,
      treeDir,
      runDir: tmp,
      lockPath: join(tmp, "ports-none.lock"),
      processes: [{ name: "shim", pid: A.pid, pgid: A.pgid }],
    };
    const lines = [];
    const r = await stopStack(rec, { keepTree: true, graceMs: 2000, log: (m) => lines.push(m) });

    const alive = (pid) => isPidAlive(pid);
    assert.equal(alive(A.pid), false, "A (recorded, marked) stopped");
    assert.equal(alive(B.pid), false, "B's marked leader stopped");
    assert.equal(alive(b2), false, "B's marked child stopped with its group");
    assert.equal(alive(e2), false, "E's marked child stopped, by its own pid");
    assert.equal(alive(C.pid), true, `C, a stranger with cwd and argv in the tree, is alive\n${lines.join("\n")}`);
    assert.equal(alive(D.pid), true, `D's leader is alive\n${lines.join("\n")}`);
    assert.equal(alive(d2), true, `D's child, cwd in the tree, is alive\n${lines.join("\n")}`);
    assert.equal(alive(E.pid), true, `E's leader, whose group held a marked child, is alive\n${lines.join("\n")}`);

    assert.equal(r.state, "stopped", JSON.stringify(r, null, 2));
    const leftAlone = new Set(r.leftAlone.map((p) => p.pid));
    assert.ok(leftAlone.has(C.pid) && leftAlone.has(d2), `the strangers near the tree are reported: ${JSON.stringify(r.leftAlone)}`);
    assert.ok(lines.some((l) => /stray pid \d+ \(marked, in an unmarked group\): gone/.test(l)), lines.join("\n"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(stackDir, { recursive: true, force: true });
  }
});

test("NEGATIVE: a record without a mark signals nothing at all", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "e2e-teardown-"));
  try {
    const p = spawnDetached(process.execPath, ["-e", KEEP], { cwd: tmp, env: buildEnv({ path: [dirname(process.execPath), ...SYSTEM_PATH], tmpdir: tmp }), logFile: join(tmp, "x.log") });
    started.push(p.pid);
    const r = await stopStack({ runId: "selftest-nomark", state: "ready", stackDir: tmp, treeDir: tmp, runDir: tmp, processes: [{ name: "shim", pid: p.pid, pgid: p.pgid }] }, { log: () => {} });
    assert.equal(r.state, "stop-refused");
    assert.deepEqual(r.survivors, [p.pid]);
    assert.equal(isPidAlive(p.pid), true, "nothing was signalled");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the short TMPDIR /tmp/bshd-<runId> goes once the stack's processes are gone — kept tree or not — and reap removes an orphaned one", async () => {
  const runId = `selftest-tmp${process.pid}`;
  const short = `/tmp/bshd-${runId}`;
  const runDir = join(OUT_DIR, runId);
  const stackDir = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-teardown-"));
  const treeDir = join(stackDir, "tree");
  mkdirSync(treeDir);
  mkdirSync(short, { recursive: true });
  writeFileSync(join(short, "fire_emu_0123456789abcdef.sock"), "");
  symlinkSync(short, join(stackDir, "tmp"));
  const mark = newStackMark(runId);
  const env = buildEnv({ path: [dirname(process.execPath), ...SYSTEM_PATH], tmpdir: short, set: { [STACK_MARK_KEY]: mark } });
  try {
    const p = spawnDetached(process.execPath, ["-e", KEEP], { cwd: treeDir, env, logFile: join(stackDir, "p.log") });
    started.push(p.pid);
    await sleep(200);
    const rec = { runId, mark, state: "failed", stackDir, treeDir, runDir, tmpDir: short, lockPath: join(stackDir, "ports-none.lock"), processes: [{ name: "emulators", pid: p.pid, pgid: p.pgid }] };
    const r = await stopStack(rec, { graceMs: 1000, log: () => {} });
    assert.equal(r.state, "failed");
    assert.equal(r.treeKept, true, "a failed stack keeps its tree");
    assert.equal(r.tmpRemoved, true);
    assert.equal(existsSync(short), false, "…but not its short TMPDIR, once nothing runs");
    assert.equal(existsSync(treeDir), true);
    assert.equal(existsSync(join(stackDir, "tmp")), false, "the link to it went too");

    // An orphan: the stack dir was removed earlier, the TMPDIR was left, the
    // record (in the run directory) names it, nothing of the stack runs.
    mkdirSync(short, { recursive: true });
    writeFileSync(join(runDir, "stack.json"), JSON.stringify({ ...rec, state: "reaped", stackDir: join(stackDir, "gone") }));
    const reaped = await reap({ runIds: [runId], log: () => {} });
    assert.deepEqual(reaped.tmpRemoved, [short], JSON.stringify(reaped));
    assert.equal(existsSync(short), false);

    // NEGATIVE: while a marked process of the stack still runs, it stays.
    mkdirSync(short, { recursive: true });
    const q = spawnDetached(process.execPath, ["-e", KEEP], { cwd: treeDir, env, logFile: join(stackDir, "q.log") });
    started.push(q.pid);
    await sleep(200);
    writeFileSync(join(runDir, "stack.json"), JSON.stringify({ ...rec, state: "reaped", stackDir: join(stackDir, "gone"), processes: [] }));
    const kept = await reap({ runIds: [runId], log: () => {} });
    assert.deepEqual(kept.tmpRemoved, []);
    assert.equal(existsSync(short), true, "a TMPDIR something of the stack still uses is never removed");
  } finally {
    rmSync(short, { recursive: true, force: true });
    rmSync(stackDir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
