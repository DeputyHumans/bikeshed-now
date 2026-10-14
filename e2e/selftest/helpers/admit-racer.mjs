// SPDX-License-Identifier: Apache-2.0
// Self-test helper: one stack start racing others for a slot under the machine-wide cap, in a scratch stacks directory (SPEC §12).

/**
 *   node admit-racer.mjs <stacksDir> <locksDir> <max> <holdMs> <runId> <startAtEpochMs>
 *
 * Busy-waits until <startAtEpochMs> so every racer asks at once, then runs
 * admitStack against the scratch directories with healthy memory readings
 * (the slot is what is raced), writing its record as startStack does (state
 * "starting", this process as owner). Prints {runId, admittedAt} once
 * admitted, holds the slot <holdMs>, and exits: its owner gone, the record no
 * longer counts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admitStack } from "../../lib/admission.mjs";
import { ownerIdentity } from "../../lib/lifetime.mjs";

const [stacksDir, locksDir, max, holdMs, runId, startAt] = process.argv.slice(2);
const healthy = async () => ({ level: 1, swapoutsDelta: 0, windowMs: 5000, freePct: 80, memsize: 64 * 1024 ** 3, availableBytes: 51 * 1024 ** 3, swapUsedBytes: 0, swapTotalBytes: 0 });
while (Date.now() < Number(startAt)) {}
await admitStack({
  runId,
  stacksDir,
  locksDir,
  max: Number(max),
  sample: healthy,
  pollMs: 50,
  timeoutMs: 30_000,
  claim: () => {
    mkdirSync(join(stacksDir, runId), { recursive: true });
    writeFileSync(join(stacksDir, runId, "stack.json"), JSON.stringify({ runId, state: "starting", owner: ownerIdentity(), processes: [] }));
  },
});
process.stdout.write(`${JSON.stringify({ runId, admittedAt: Date.now() })}\n`);
await new Promise((r) => setTimeout(r, Number(holdMs)));
