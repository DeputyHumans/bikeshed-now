// SPDX-License-Identifier: Apache-2.0
// Self-test: every JVM a stack starts runs under its heap cap, and one that runs out of heap is named, never left to hang (SPEC §12).

/**
 * The stack's java wrapper (lib/jvm.mjs) is written into a temp "stack" and
 * run with a real JVM: a small program (Hog.java, run from source) that
 * reports its max heap and sleeps, or allocates until it runs out (512 MiB at
 * most: with no cap it exits 42 instead of taking the machine's memory). An
 * argument naming the Firestore jar gives it the Firestore role, as
 * firebase-tools' `-jar …/cloud-firestore-emulator-v….jar` does. Needs Java.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JVM_HEAP_CEILING_MB, installJavaWrapper, javaWrapper, jvmEvents, jvmFailures, jvmHeapConfig, normalizeJvmHeap, parseHeapSize } from "../lib/jvm.mjs";
import { stackFailures } from "../lib/stack.mjs";
import { requireTool } from "../lib/proc.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const HOG = `public class Hog {
  public static void main(String[] a) throws Exception {
    System.out.println("max " + Runtime.getRuntime().maxMemory());
    if (a.length > 0 && a[0].equals("sleep")) { Thread.sleep(60_000); return; }
    // Bounded: if no cap stops it by 512 MiB, it exits 42 rather than take the machine's memory.
    java.util.List<byte[]> l = new java.util.ArrayList<>();
    for (int i = 0; i < 512; i++) l.add(new byte[1 << 20]);
    System.exit(42);
  }
}
`;
const HEAP = { firestore: 48, database: 40, other: 32 };
const FIRESTORE_ARG = "-Dfake.jar=/x/cloud-firestore-emulator-v0.jar";

function fakeStack() {
  const stackDir = tempDir("e2e-jvm-");
  const hog = join(stackDir, "Hog.java");
  writeFileSync(hog, HOG);
  const java = requireTool("java", "E2E_JAVA_BIN");
  const paths = installJavaWrapper({ stackDir, realJava: java, heap: HEAP, runId: "selftest-jvm" });
  return { stackDir, hog, java, paths };
}

/** Run a command to its end: {code, out, ms}; killed after `timeoutMs`. */
function runToEnd(cmd, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, out, ms: Date.now() - t0 });
    });
  });
}

/** Start a sleeping JVM, wait for its "max" line: {child, pid, max}. */
function sleeping(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => reject(new Error(`no max line: ${out}`)), 30_000);
    child.stdout.on("data", (c) => {
      out += c;
      const m = /max (\d+)/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve({ child, pid: child.pid, max: Number(m[1]) });
      }
    });
    child.stderr.on("data", (c) => (out += c));
  });
}

test("heap caps: each role defaults to its ceiling, may be lowered, never raised", () => {
  assert.deepEqual(jvmHeapConfig([]), { firestore: 2048, database: 1024, other: 512 });
  assert.deepEqual(JVM_HEAP_CEILING_MB, { firestore: 2048, database: 1024, other: 512 });
  assert.deepEqual(jvmHeapConfig(["firestore=1g", "other=256m"]), { firestore: 1024, database: 1024, other: 256 });
  assert.equal(parseHeapSize("2g"), 2048);
  assert.equal(parseHeapSize("768"), 768);
  assert.throws(() => jvmHeapConfig(["firestore=3g"]), /above the 2048m ceiling/);
  assert.throws(() => jvmHeapConfig(["database=2g"]), /above the 1024m ceiling/);
  assert.throws(() => jvmHeapConfig(["other=1g"]), /above the 512m ceiling/);
  assert.throws(() => jvmHeapConfig(["firestore=8m"]), /below the 16m floor/);
  assert.throws(() => jvmHeapConfig(["firestore=1g", "firestore=1g"]), /given twice/);
  assert.throws(() => jvmHeapConfig(["pubsub=1g"]), /role firestore\|database\|other/);
  assert.throws(() => normalizeJvmHeap({ firestore: 4096 }), /16 to 2048/);
  assert.throws(() => javaWrapper({ realJava: "/usr/bin/java", jvmDir: "/tmp/a'b", heap: HEAP }), /cannot go into the java wrapper/);
});

test("the wrapper runs a JVM under its role's cap: -Xmx in its argv (ps), and the JVM's own max heap within it", async () => {
  const { stackDir, hog, paths } = fakeStack();
  for (const [role, args] of [["firestore", [FIRESTORE_ARG, hog, "sleep"]], ["other", [hog, "sleep"]]]) {
    const j = await sleeping(paths.java, args);
    try {
      const argv = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(j.pid)], { encoding: "utf8" });
      assert.ok(argv.includes(` -Xmx${HEAP[role]}m `), `ps shows -Xmx${HEAP[role]}m for ${role}: ${argv}`);
      assert.ok(argv.includes("-XX:+ExitOnOutOfMemoryError"), argv);
      assert.ok(j.max <= HEAP[role] * 1024 * 1024, `${role}: the JVM's max heap ${j.max} is within ${HEAP[role]} MiB`);
    } finally {
      j.child.kill("SIGKILL");
    }
  }
  const started = jvmEvents(stackDir).started.map((s) => [s.role, s.heap]);
  assert.deepEqual(started, [["firestore", "48m"], ["other", "32m"]], "each start recorded with its role and cap");
  // firebase-tools' java -version probe is not a JVM of the stack.
  await runToEnd(paths.java, ["-version"]);
  assert.equal(jvmEvents(stackDir).started.length, 2);
});

test("NEGATIVE: the same JVM started without the wrapper has the machine's default max heap, far above any cap", async () => {
  const { hog, java } = fakeStack();
  const j = await sleeping(java, [hog, "sleep"]);
  j.child.kill("SIGKILL");
  assert.ok(j.max > JVM_HEAP_CEILING_MB.firestore * 1024 * 1024, `uncapped max heap ${j.max} is above the 2048 MiB Firestore cap: only the wrapper bounds it`);
});

test("a JVM that runs out of heap exits at once (code 3), and the stack's health names the emulator and its cap", async () => {
  const { stackDir, hog, paths } = fakeStack();
  const r = await runToEnd(paths.java, [FIRESTORE_ARG, hog]);
  assert.equal(r.code, 3, `ExitOnOutOfMemoryError: exit 3, not a hang (${r.ms} ms): ${r.out.slice(-800)}`);
  assert.ok(r.ms < 30_000, `it ended in ${r.ms} ms`);
  assert.match(r.out, /Terminating due to java\.lang\.OutOfMemoryError/);
  const ev = jvmEvents(stackDir);
  assert.deepEqual(ev.oom.map((o) => o.role), ["firestore"], "the OnOutOfMemoryError hook recorded the role");
  const failures = jvmFailures({ stackDir });
  assert.equal(failures.length, 1, JSON.stringify(failures));
  assert.match(failures[0].reason, /^the Firestore emulator \(pid \d+\) ran out of memory: java\.lang\.OutOfMemoryError at its -Xmx48m cap$/);
  // What readiness, `run` and the watchdog read: the same failure, by name.
  const health = stackFailures({ stackDir, processes: [] });
  assert.deepEqual(health.map((f) => f.emulator), ["Firestore emulator"]);
  assert.ok(existsSync(paths.oom));
});

test("a Firestore or Database JVM that is gone is a failure; the rules runtime's own exit is not", () => {
  const stackDir = tempDir("e2e-jvm-dead-");
  const p = installJavaWrapper({ stackDir, realJava: "/usr/bin/true", heap: HEAP, runId: "selftest-jvm" });
  writeFileSync(p.started, `firestore 999999 48m\nother 999998 32m\n${`database ${process.pid} 40m`}\n`);
  const f = jvmFailures({ stackDir });
  assert.deepEqual(f.map((x) => [x.role, x.pid]), [["firestore", 999999]], JSON.stringify(f));
  assert.match(f[0].reason, /the Firestore emulator \(pid 999999, -Xmx48m\) exited/);
});
