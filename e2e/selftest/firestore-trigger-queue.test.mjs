// SPDX-License-Identifier: Apache-2.0
// A pinned emulator serialization proof must reject a different queue, nonblocking delivery, or an actually concurrent execution (SPEC §14).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { firebaseTools } from "../lib/prerequisites.mjs";
import { JAVA_PROBE, PIN, assertPinnedInstallation, inspectTriggerQueue, probeQueueBehavior, probeInstalledTriggerQueue } from "../../tools/probe-e2e-trigger-queue.mjs";

const launcher = `
  76: new #260 // class java/util/concurrent/ThreadPoolExecutor
  79: dup
  80: iconst_0
  81: iconst_4
  82: ldc2_w #262 // long 60l
  85: getstatic #264 // Field java/util/concurrent/TimeUnit.SECONDS:Ljava/util/concurrent/TimeUnit;
  88: new #270 // class java/util/concurrent/LinkedBlockingQueue
  91: dup
  92: invokespecial #272 // Method java/util/concurrent/LinkedBlockingQueue."<init>":()V
  95: invokespecial #274 // Method java/util/concurrent/ThreadPoolExecutor."<init>":(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;)V
  100: new #277 // class com/google/cloud/datastore/emulator/impl/events/FunctionsEmulatorEventPublisher
  119: invokespecial #282 // Method com/google/cloud/datastore/emulator/impl/events/FunctionsEmulatorEventPublisher."<init>":(Lcom/google/common/net/HostAndPort;Lcom/google/api/client/http/HttpTransport;Ljava/util/concurrent/ExecutorService;)V`;
const publisher = `void sendHttpRequestV2(com.google.api.client.http.HttpHeaders, java.lang.String, byte[]) throws java.io.IOException;
  119: invokevirtual #447 // Method com/google/api/client/http/HttpRequest.execute:()Lcom/google/api/client/http/HttpResponse;
  private void otherMethod();`;

test("the local boundary rejects unpinned versions and changed JAR bytes", () => {
  assertPinnedInstallation({ ...PIN });
  for (const key of Object.keys(PIN)) assert.throws(() => assertPinnedInstallation({ ...PIN, [key]: "different" }), /audited CLI, emulator version and JAR digest/);
});

test("trigger limitation requires the pinned serialized executor and blocking V2 sender", () => {
  assert.deepEqual(inspectTriggerQueue(launcher, publisher), { core: 0, maximum: 4, queue: "unbounded LinkedBlockingQueue", delivery: "blocking HttpRequest.execute" });
  for (const [from, to] of [["iconst_0", "iconst_4"], ["iconst_4", "iconst_8"], ["LinkedBlockingQueue", "SynchronousQueue"], ["FunctionsEmulatorEventPublisher", "OtherPublisher"]]) {
    assert.throws(() => inspectTriggerQueue(launcher.replaceAll(from, to), publisher), { code: "ERR_ASSERTION" });
  }
  assert.throws(() => inspectTriggerQueue(launcher, publisher.replace("HttpRequest.execute", "HttpRequest.executeAsync")), /blocks on the handler/);
});

test("actual JVM queue state proves serialization and an independently concurrent counterfactual", () => {
  const result = probeQueueBehavior();
  assert.equal(result.installedConfiguration.active, 1);
  assert.equal(result.counterfactualCoreFour.active, 4);
  assert.throws(() => probeQueueBehavior({ source: JAVA_PROBE.replace("+ probe(0) +", "+ probe(4) +") }), /installed executor configuration serializes/);
  assert.throws(() => probeQueueBehavior({ source: JAVA_PROBE.replace("+ probe(4) +", "+ probe(0) +") }), /observed parallel negative control/);
});

test("the installed pinned Firestore JAR has the audited delivery boundary", async t => {
  const firebase = firebaseTools({ optional: true });
  if (!firebase) return t.skip("Firebase is not installed; no installed-emulator proof was obtained");
  const require = createRequire(join(firebase.root, "package.json"));
  const info = require(join(firebase.root, "lib/emulator/downloadableEmulators.js")).getDownloadDetails("firestore");
  if (!existsSync(info.downloadPath)) return t.skip("Firestore JAR is not downloaded; no installed-emulator proof was obtained");
  const proof = await probeInstalledTriggerQueue();
  assert.deepEqual(proof.toolchain, PIN);
  assert.equal(proof.kind, "unsupported-local-trigger-overlap");
  assert.match(proof.conclusion, /not a concurrent-handler PASS/);
});
