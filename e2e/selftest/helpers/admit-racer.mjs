// SPDX-License-Identifier: Apache-2.0
// Self-test helper: one stack start racing others for a slot under the machine-wide cap, in a scratch stacks directory (SPEC §12).

/**
 * node admit-racer.mjs <stacksDir> <locksDir> <max> <runId>
 *
 * IPC starts all contenders after they are ready. An admitted owner stays
 * alive until the parent releases it, so scheduler speed cannot substitute
 * for the cap's behavior. Only memory readings are fake; admission, process
 * identities, records and the shared mutex are real.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admitStack } from "../../lib/admission.mjs";
import { ownerIdentity } from "../../lib/lifetime.mjs";

const [stacksDir, locksDir, max, runId] = process.argv.slice(2);
let start;
let release;
const started = new Promise((resolve) => (start = resolve));
const released = new Promise((resolve) => (release = resolve));
process.on("message", (message) => {
  if (message === "start") start();
  if (message === "release") release();
});
const healthy = async () => ({ level: 1, swapoutsDelta: 0, windowMs: 5000, freePct: 80, memsize: 64 * 1024 ** 3, availableBytes: 51 * 1024 ** 3, swapUsedBytes: 0, swapTotalBytes: 0 });
process.send({ event: "ready", runId });
await started;
let waitedForSlot = false;
const admitted = await admitStack({
  runId,
  stacksDir,
  locksDir,
  max: Number(max),
  sample: healthy,
  pollMs: 50,
  timeoutMs: 30_000,
  log: (message) => {
    if (!message.startsWith("waiting for a stack slot")) return;
    waitedForSlot = true;
    process.send({ event: "waiting", runId });
  },
  claim: () => {
    mkdirSync(join(stacksDir, runId), { recursive: true });
    writeFileSync(join(stacksDir, runId, "stack.json"), JSON.stringify({ runId, state: "starting", owner: ownerIdentity(), processes: [] }));
  },
});
process.send({ event: "admitted", runId, priorLive: admitted.live.length, waitedForSlot });
await released;
process.disconnect();
