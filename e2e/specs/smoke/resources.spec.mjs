// SPDX-License-Identifier: Apache-2.0
// Canary: the stack under test holds its memory down — every JVM capped, the debug logs capped, a watchdog, an owner and an expiry (SPEC §12).

/**
 * The self-tests prove each piece alone (jvm, debuglogs, lifetime); this
 * proves them wired into the stack actually running: that firebase-tools
 * found the stack's java wrapper first on its PATH for every JVM it started,
 * that the per-emulator debug logs are /dev/null and firebase-debug.log is
 * within its cap, and that the stack's watchdog is alive with a lease no
 * later than the hard maximum. A stack built before these existed lacks
 * `resource-caps` and is SKIPPED.
 *
 * Negative control: a stack started with `--jvm-heap firestore=16m` fails
 * its own readiness, naming the Firestore emulator (README, What a stack is);
 * selftest/jvm.test.mjs shows a JVM run without the wrapper has the machine's
 * default heap.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTarget } from "../../lib/target.mjs";
import { stackResources } from "../../lib/stack.mjs";
import { JVM_HEAP_CEILING_MB } from "../../lib/jvm.mjs";
import { MAX_LIFETIME_CEILING_HOURS, HOUR_MS } from "../../lib/lifetime.mjs";

const target = loadTarget();
const skip = target.kind !== "local" ? "local stacks only" : target.capabilities.has("resource-caps") ? false : "needs resource-caps (the stack was built by an older harness)";

test("canary: every JVM of the stack runs under its heap cap, and exits when out of heap", { skip }, () => {
  const r = stackResources(target.runId);
  const live = r.jvms.filter((j) => j.alive);
  assert.deepEqual([...new Set(live.map((j) => j.role))].sort(), ["database", "firestore", "other"], `the Firestore and Database emulators and the Storage rules runtime, all through the wrapper: ${JSON.stringify(r.jvms)}`);
  for (const j of live) {
    assert.ok(j.xmxMb != null, `${j.role} (pid ${j.pid}) has -Xmx on its command line`);
    assert.equal(j.xmxMb, r.caps[j.role], `${j.role} runs at the stack's cap`);
    assert.ok(j.xmxMb <= JVM_HEAP_CEILING_MB[j.role], `${j.role}: ${j.xmxMb}m is within the ${JVM_HEAP_CEILING_MB[j.role]}m ceiling`);
    assert.ok(j.exitOnOom, `${j.role} exits on OutOfMemoryError`);
  }
});

test("canary: the emulator debug logs are capped", { skip }, () => {
  const r = stackResources(target.runId);
  const by = Object.fromEntries(r.debugLogs.files.map((f) => [f.name, f]));
  assert.equal(by["firestore-debug.log"]?.link, "/dev/null");
  assert.equal(by["database-debug.log"]?.link, "/dev/null");
  assert.ok(by["firebase-debug.log"] && by["firebase-debug.log"].size <= r.debugLogs.maxBytes, `firebase-debug.log ${by["firebase-debug.log"]?.size} bytes, cap ${r.debugLogs.maxBytes}`);
  assert.ok(r.debugLogs.maxBytes <= 200 * 1024 * 1024);
});

test("canary: the stack has an owner, a watchdog and an expiry no later than its hard maximum", { skip }, () => {
  const r = stackResources(target.runId);
  assert.ok(Number.isInteger(r.owner?.pid) && Number.isInteger(r.owner?.startSec), JSON.stringify(r.owner));
  assert.equal(r.watchdog?.alive, true, "its watchdog is running");
  const created = Date.parse(r.createdAt);
  const expires = Date.parse(r.lease?.expiresAt);
  const hard = Date.parse(r.lease?.hardExpiresAt);
  assert.ok(expires <= hard && hard <= created + MAX_LIFETIME_CEILING_HOURS * HOUR_MS, JSON.stringify(r.lease));
  assert.ok(r.rss.totalBytes > 0 && r.rss.processes > 0, "its marked processes are counted");
});
