// SPDX-License-Identifier: Apache-2.0
// Self-test: at most E2E_MAX_STACKS stacks live at once on the machine, counted from their records, raced for under one lock (SPEC §12).

/**
 * Scratch stacks and locks directories: never the machine's. liveStacks is
 * checked on records in each shape a stack can leave; then real processes
 * race admitStack (helpers/admit-racer.mjs) for slots, each holding one for
 * 1.5 s.
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

function race(n, { max, holdMs = 1500 }) {
  const dir = tempDir("e2e-admit-race-");
  const [stacksDir, locksDir] = [join(dir, "stacks"), join(dir, "locks")];
  const startAt = Date.now() + 800;
  return Promise.all(
    Array.from({ length: n }, (_, i) => new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [RACER, stacksDir, locksDir, String(max), String(holdMs), `selftest-race-${i}`, String(startAt)], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`racer ${i} exited ${code}: ${out}`))));
    })),
  ).then((rs) => rs.sort((a, b) => a.admittedAt - b.admittedAt));
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

test("three stacks racing for two slots: two start at once, the third only once a slot is free", async () => {
  const rs = await race(3, { max: 2 });
  assert.ok(rs[1].admittedAt - rs[0].admittedAt < 1000, `the first two together (${rs[1].admittedAt - rs[0].admittedAt} ms apart)`);
  assert.ok(rs[2].admittedAt - rs[0].admittedAt >= 1400, `the third waited for a slot: ${rs[2].admittedAt - rs[0].admittedAt} ms after the first`);
});

test("NEGATIVE: with the cap above the racers, all three start at once", async () => {
  const rs = await race(3, { max: 10 });
  assert.ok(rs[2].admittedAt - rs[0].admittedAt < 1000, `all three within ${rs[2].admittedAt - rs[0].admittedAt} ms: only the cap holds the third back`);
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
