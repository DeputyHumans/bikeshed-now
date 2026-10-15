// SPDX-License-Identifier: Apache-2.0
// Reproduce retained RTDB rule-value coverage and its replacement boundary in the pinned local emulator without starting a service (SPEC §12).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { firebaseTools } from "../e2e/lib/prerequisites.mjs";
import { requireTool } from "../e2e/lib/proc.mjs";
import { RTDB_COVERAGE_PIN } from "../e2e/lib/rtdb-coverage.mjs";

export const TRACKER_PROBE = String.raw`
import java.lang.reflect.Field;
import scala.Tuple2;
import scala.collection.immutable.Map;
import scala.collection.immutable.Map$;
import com.firebase.core.namespace.rules.tracker.ExpressionRuleTracker;

class TrackerRetention {
  static ExpressionRuleTracker tracker() throws Exception {
    Field unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); unsafeField.setAccessible(true);
    sun.misc.Unsafe unsafe = (sun.misc.Unsafe) unsafeField.get(null);
    ExpressionRuleTracker tracker = (ExpressionRuleTracker) unsafe.allocateInstance(ExpressionRuleTracker.class);
    Field nodes = ExpressionRuleTracker.class.getDeclaredField("nodes"); nodes.setAccessible(true);
    Map values = Map$.MODULE$.empty(); Map initial = Map$.MODULE$.empty();
    nodes.set(tracker, initial.$plus(new Tuple2(null, values)));
    return tracker;
  }
  static long[] retained(ExpressionRuleTracker tracker) throws Exception {
    Field nodes = ExpressionRuleTracker.class.getDeclaredField("nodes"); nodes.setAccessible(true);
    Map values = (Map) ((Map) nodes.get(tracker)).apply(null);
    long chars = 0; scala.collection.Iterator it = values.keysIterator();
    while (it.hasNext()) { Object value = it.next(); if (value instanceof String) chars += ((String)value).length(); }
    return new long[]{values.size(), chars};
  }
  public static void main(String[] args) throws Exception {
    ExpressionRuleTracker distinct = tracker(), repeated = tracker();
    for (int i = 0; i < 1000; i++) {
      distinct.trackNodeOutput(null, String.format("%04d", i) + "x".repeat(4092));
      repeated.trackNodeOutput(null, "x".repeat(4096));
    }
    System.gc();
    long[] d = retained(distinct), r = retained(repeated), reset = retained(tracker());
    if (d[0] != 1000 || d[1] != 4096000 || r[0] != 1 || r[1] != 4096 || reset[0] != 0) throw new AssertionError("unexpected tracker behavior");
    System.out.println("{\"distinctValues\":"+d[0]+",\"retainedCharacters\":"+d[1]+",\"repeatedValues\":"+r[0]+",\"replacementTrackerValues\":"+reset[0]+"}");
  }
}
`;

function command(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(r.status, 0, `${bin.split(/[\\/]/).at(-1)} completed: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
}

export function assertRetentionBehavior(actual) {
  assert.deepEqual(actual, { distinctValues: 1000, retainedCharacters: 4096000, repeatedValues: 1, replacementTrackerValues: 0 }, "the installed tracker retains every distinct string and a replacement retains none");
}

export async function probeRtdbCoverage({ env = process.env } = {}) {
  const firebase = firebaseTools({ env });
  const require = createRequire(join(firebase.root, "package.json"));
  const info = require(join(firebase.root, "lib/emulator/downloadableEmulators.js")).getDownloadDetails("database");
  assert.ok(existsSync(info.downloadPath), "the Database emulator must already be downloaded; this probe starts/downloads nothing");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(info.downloadPath)) hash.update(chunk);
  assert.deepEqual({ firebase: firebase.version, database: info.version, sha256: hash.digest("hex") }, RTDB_COVERAGE_PIN, "retention proof requires the audited installation");
  const java = requireTool("java", "E2E_JAVA_BIN", env), javap = join(dirname(realpathSync(java)), "javap");
  const dump = name => command(javap, ["-J-Xmx128m", "-classpath", info.downloadPath, "-c", "-p", name]);
  assert.match(dump("com.firebase.server.forge.App$"), /getstatic[^\n]+LiveRuleTrackerFactory/, "the emulator installs the live value tracker");
  const manager = dump("com.firebase.core.namespace.NamespaceManager");
  const replacement = manager.split(" setStableRules(")[1]?.split(/\n  (?:private|public)/)[0] ?? "";
  assert.match(replacement, /createRulesEngineAndIndexTree/, "every reinstall constructs a fresh engine");
  assert.match(replacement, /putfield[^\n]+_stableRulesEngine/, "the fresh engine replaces the retained tracker");
  const actor = dump("com.firebase.core.namespace.NamespaceActor");
  const observer = actor.split("$anonfun$new$5(")[1]?.split(/\n  (?:private|public)/)[0] ?? "";
  assert.match(observer, /VersionedProperty.value[\s\S]+BoxesRunTime.equals[\s\S]+ifne[\s\S]+NamespaceManager.updateRules/, "the metadata observer skips identical rule strings, requiring a whitespace-only round trip");
  const dir = mkdtempSync(join(tmpdir(), "e2e-rtdb-tracker-"));
  try {
    const file = join(dir, "TrackerRetention.java"); writeFileSync(file, TRACKER_PROBE);
    const behavior = JSON.parse(command(java, ["-Xmx128m", "--class-path", info.downloadPath, file]));
    assertRetentionBehavior(behavior);
    return { schemaVersion: 1, kind: "rtdb-rule-coverage-retention", toolchain: RTDB_COVERAGE_PIN, behavior, structure: { liveTracker: true, changedRuleStringReplacesTracker: true, identicalRuleStringSkipsReplacement: true }, observedAt: new Date().toISOString() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(`${JSON.stringify(await probeRtdbCoverage(), null, 2)}\n`);
