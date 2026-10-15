// SPDX-License-Identifier: Apache-2.0
// Self-test: at most E2E_MAX_STACKS stacks live at once on the machine, counted from their records, raced for under one lock (SPEC §12).

/**
 * Scratch stacks and locks directories: never the machine's. liveStacks is
 * checked on records in each shape a stack can leave; then real processes
 * race admitStack (helpers/admit-racer.mjs) for slots. IPC keeps admitted
 * owners alive until the parent has observed both capacity and contention.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMISSION_CODE, DEFAULT_MAX_STACKS, admitStack, liveStacks, maxStacks } from "../lib/admission.mjs";
import { STACK_MARK_KEY, SYSTEM_PATH, buildEnv, newStackMark, selfIdentity, spawnDetached } from "../lib/proc.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const RACER = fileURLToPath(new URL("./helpers/admit-racer.mjs", import.meta.url));
const KEEP = "setInterval(() => {}, 1000)";
const HEALTHY = async () => ({ level: 1, swapoutsDelta: 0, windowMs: 5000, freePct: 80, memsize: 64 * 1024 ** 3, availableBytes: 51 * 1024 ** 3 });

function record(stacksDir, runId, rec) {
  mkdirSync(join(stacksDir, runId), { recursive: true });
  writeFileSync(join(stacksDir, runId, "stack.json"), JSON.stringify({ runId, processes: [], ...rec }));
}

async function race(n, { max }) {
  const dir = tempDir("e2e-admit-race-");
  const [stacksDir, locksDir] = [join(dir, "stacks"), join(dir, "locks")];
  const children = [];
  const admitted = [];
  const waiting = new Set();
  let released = false;
  let ready = 0;
  let done = 0;
  let deadline;
  try {
    return await new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error(`admission race did not finish: ${admitted.length} admitted, ${waiting.size} waiting, ${done} exited`)), 60_000);
      const advance = () => {
        if (admitted.length === n) {
          for (const c of children) if (c.connected) c.send("release");
        } else if (!released && admitted.length === max && waiting.size > 0) {
          // No owner leaves until the available capacity is occupied AND
          // another contender has actually observed the cap under the lock.
          released = true;
          children.find((c) => c.runId === admitted[0].runId).send("release");
        }
      };
      for (let i = 0; i < n; i++) {
        const runId = `selftest-race-${i}`;
        const c = spawn(process.execPath, [RACER, stacksDir, locksDir, String(max), runId], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
        c.runId = runId;
        children.push(c);
        c.on("error", reject);
        c.on("message", (message) => {
          if (message.event === "ready" && ++ready === n) for (const child of children) child.send("start");
          if (message.event === "waiting") waiting.add(runId);
          if (message.event === "admitted") admitted.push(message);
          advance();
        });
        c.on("close", (code) => {
          if (code !== 0) reject(new Error(`racer ${i} exited ${code}`));
          else if (++done === n) resolve(admitted);
        });
      }
    });
  } finally {
    clearTimeout(deadline);
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  }
}

test("E2E_MAX_STACKS: 3 by default, a whole number of at least 1", () => {
  assert.equal(DEFAULT_MAX_STACKS, 3);
  assert.equal(maxStacks({}), 3);
  assert.equal(maxStacks({ E2E_MAX_STACKS: "1" }), 1);
  assert.throws(() => maxStacks({ E2E_MAX_STACKS: "0" }), /at least 1/);
});

test("a stack is live while a recorded group runs, a process carries its mark, or it is starting with its owner alive", async () => {
  const stacksDir = join(tempDir("e2e-live-"), "stacks");
  const tmp = tempDir("e2e-live-tmp-");
  const env = buildEnv({ path: [dirname(process.execPath), ...SYSTEM_PATH], tmpdir: tmp });
  const group = spawnDetached(process.execPath, ["-e", KEEP], { cwd: tmp, env, logFile: join(tmp, "a.log") });
  const mark = newStackMark("selftest-live-e");
  const marked = spawnDetached(process.execPath, ["-e", KEEP], { cwd: tmp, env: { ...env, [STACK_MARK_KEY]: mark }, logFile: join(tmp, "e.log") });
  try {
    record(stacksDir, "selftest-live-a", { state: "ready", processes: [{ name: "emulators", pid: group.pid, pgid: group.pgid }] });
    record(stacksDir, "selftest-live-b", { state: "starting", owner: selfIdentity() });
    record(stacksDir, "selftest-live-c", { state: "starting", owner: { pid: process.pid, startSec: 1 } }); // the pid, reused by someone else
    record(stacksDir, "selftest-live-d", { state: "ready", processes: [{ name: "emulators", pid: 999_999, pgid: 999_999 }] });
    record(stacksDir, "selftest-live-e", { state: "ready", mark });
    record(stacksDir, "selftest-live-f", { state: "stopped", owner: selfIdentity() });
    assert.deepEqual(liveStacks({ stacksDir }).map((s) => s.runId), ["selftest-live-a", "selftest-live-b", "selftest-live-e"]);
    assert.deepEqual(liveStacks({ stacksDir, exclude: "selftest-live-b" }).map((s) => s.runId), ["selftest-live-a", "selftest-live-e"]);
  } finally {
    for (const p of [group, marked]) {
      try {
        process.kill(-p.pgid, "SIGKILL");
      } catch {}
    }
  }
});

test("three stacks racing for two slots: both slots fill before an owner leaves, and the third observes the cap", async () => {
  const rs = await race(3, { max: 2 });
  assert.deepEqual(rs.map((r) => r.priorLive).sort(), [0, 1, 1], "at most one other stack is live when a contender claims its slot");
  assert.equal(rs.filter((r) => r.waitedForSlot).length, 1, "exactly the contender beyond capacity waited for an owner to leave");
});

test("NEGATIVE: with the cap above the racers, all three hold a slot together without waiting", async () => {
  const rs = await race(3, { max: 10 });
  assert.deepEqual(rs.map((r) => r.priorLive).sort(), [0, 1, 2], "all three owners remain live together; only the cap held the third back");
  assert.equal(rs.some((r) => r.waitedForSlot), false);
});

test("a start that never gets a slot gives up with E2E_ADMISSION, naming the stacks that hold them", async () => {
  const dir = tempDir("e2e-admit-full-");
  const stacksDir = join(dir, "stacks");
  record(stacksDir, "selftest-full-a", { state: "starting", owner: selfIdentity() });
  let claimed = false;
  await assert.rejects(
    admitStack({ runId: "selftest-full-b", stacksDir, locksDir: join(dir, "locks"), max: 1, sample: HEALTHY, pollMs: 20, timeoutMs: 300, logFile: join(dir, "load.jsonl"), claim: () => (claimed = true) }),
    (err) => err.code === ADMISSION_CODE && /1 of 1 stacks live \(selftest-full-a\)/.test(err.message),
  );
  assert.equal(claimed, false);
});
