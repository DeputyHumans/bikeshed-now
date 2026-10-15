// SPDX-License-Identifier: Apache-2.0
// Pin the local Firestore trigger-delivery boundary without starting a stack or treating serialization as concurrency proof (SPEC §14).

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

export const PIN = Object.freeze({ firebase: "15.25.1", firestore: "1.22.0", sha256: "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c" });

export function assertPinnedInstallation(actual) {
  assert.deepEqual(actual, PIN, "this local-boundary proof requires the audited CLI, emulator version and JAR digest");
}

/** Bytecode shape is intentionally pinned: a different implementation needs a fresh boundary audit. */
export function inspectTriggerQueue(launcher, publisher) {
  assert.match(launcher, /class java\/util\/concurrent\/ThreadPoolExecutor[\s\S]{0,200}iconst_0[\s\S]{0,100}iconst_4[\s\S]{0,400}class java\/util\/concurrent\/LinkedBlockingQueue[\s\S]{0,450}ThreadPoolExecutor\."<init>":\(IIJLjava\/util\/concurrent\/TimeUnit;Ljava\/util\/concurrent\/BlockingQueue;\)V/,
    "the pinned Firestore publisher uses core=0, max=4 and an unbounded LinkedBlockingQueue");
  assert.match(launcher, /FunctionsEmulatorEventPublisher[\s\S]{0,1100}FunctionsEmulatorEventPublisher\."<init>":[^\n]*ExecutorService;\)V/,
    "the pinned executor is passed to FunctionsEmulatorEventPublisher");
  const method = publisher.split("void sendHttpRequestV2(")[1]?.split(/\n  (?:public|private|protected|void|static)/)[0];
  assert.match(method ?? "", /HttpRequest\.execute:\(\)Lcom\/google\/api\/client\/http\/HttpResponse;/,
    "the pinned V2 publisher blocks on the handler HTTP response");
  return { core: 0, maximum: 4, queue: "unbounded LinkedBlockingQueue", delivery: "blocking HttpRequest.execute" };
}

// This probe uses latches and queue state, not a guessed millisecond overlap window.
export const JAVA_PROBE = `
import java.util.concurrent.*;
public class TriggerQueueProbe {
  static String probe(int core) throws Exception {
    ThreadPoolExecutor pool = new ThreadPoolExecutor(core, 4, 60, TimeUnit.SECONDS, new LinkedBlockingQueue<Runnable>());
    CountDownLatch first = new CountDownLatch(1), started = new CountDownLatch(4), release = new CountDownLatch(1);
    Runnable task = () -> { first.countDown(); started.countDown(); try { release.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } };
    try {
      pool.execute(task);
      if (!first.await(5, TimeUnit.SECONDS)) throw new AssertionError("first task never started");
      for (int i = 1; i < 4; i++) pool.execute(task);
      if (core == 4 && !started.await(5, TimeUnit.SECONDS)) throw new AssertionError("parallel counterfactual never started all four");
      return "{\\"core\\":" + core + ",\\"maximum\\":" + pool.getMaximumPoolSize() + ",\\"active\\":" + pool.getActiveCount() + ",\\"queued\\":" + pool.getQueue().size() + "}";
    } finally { release.countDown(); pool.shutdown(); if (!pool.awaitTermination(5, TimeUnit.SECONDS)) throw new AssertionError("probe workers did not finish"); }
  }
  public static void main(String[] args) throws Exception { System.out.println("{\\"installedConfiguration\\":" + probe(0) + ",\\"counterfactualCoreFour\\":" + probe(4) + "}"); }
}
`;

function command(bin, args) {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${bin.split(/[\\/]/).at(-1)} completed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

export function probeQueueBehavior({ java = requireTool("java", "E2E_JAVA_BIN"), source = JAVA_PROBE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-trigger-queue-"));
  try {
    const file = join(dir, "TriggerQueueProbe.java");
    writeFileSync(file, source);
    const observed = JSON.parse(command(java, ["-Xmx128m", file]));
    assert.deepEqual(observed.installedConfiguration, { core: 0, maximum: 4, active: 1, queued: 3 }, "the installed executor configuration serializes four submitted tasks");
    assert.deepEqual(observed.counterfactualCoreFour, { core: 4, maximum: 4, active: 4, queued: 0 }, "raising the core count is an observed parallel negative control");
    return observed;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function probeInstalledTriggerQueue({ env = process.env } = {}) {
  const firebase = firebaseTools({ env });
  const require = createRequire(join(firebase.root, "package.json"));
  const { getDownloadDetails } = require(join(firebase.root, "lib/emulator/downloadableEmulators.js"));
  const info = getDownloadDetails("firestore");
  assert.ok(existsSync(info.downloadPath), "the pinned Firestore emulator must already be downloaded; this probe starts/downloads nothing");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(info.downloadPath)) hash.update(chunk);
  assertPinnedInstallation({ firebase: firebase.version, firestore: info.version, sha256: hash.digest("hex") });
  const java = requireTool("java", "E2E_JAVA_BIN", env);
  const javap = join(dirname(realpathSync(java)), process.platform === "win32" ? "javap.exe" : "javap");
  const dump = name => command(javap, ["-J-Xmx128m", "-classpath", info.downloadPath, "-c", "-p", `com.google.cloud.datastore.emulator.${name}`]);
  const structure = inspectTriggerQueue(dump("firestore.CloudFirestore"), dump("impl.events.FunctionsEmulatorEventPublisher"));
  const behavior = probeQueueBehavior({ java });
  return { schemaVersion: 1, kind: "unsupported-local-trigger-overlap", toolchain: PIN, structure, behavior,
    conclusion: "Automatic Firestore trigger delivery is serialized before the Functions worker pool; this is not a concurrent-handler PASS.",
    scope: "C15 trigger-overlap witness only; ordinary I10/I11/I15 assertions remain required", observedAt: new Date().toISOString() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await probeInstalledTriggerQueue(), null, 2)}\n`);
}
