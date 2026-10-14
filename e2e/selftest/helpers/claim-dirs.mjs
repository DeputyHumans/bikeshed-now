// SPDX-License-Identifier: Apache-2.0
// Self-test helper: claim invocation and evidence directories in a burst, to race other processes doing the same (SPEC §12).

/**
 *   node claim-dirs.mjs <runDir> <count> <startAtEpochMs>
 *
 * Busy-waits until <startAtEpochMs> so every racer starts together, then
 * makes <count> invocations and <count> evidence directories with ONE shared
 * slug, and prints {invocations:[dir…], evidence:[dir…]} as JSON.
 */

import { createInvocation } from "../../lib/invocation.mjs";
import { Evidence } from "../../lib/evidence.mjs";

const [runDir, count, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
const invocations = [];
const evidence = [];
for (let i = 0; i < Number(count); i += 1) {
  invocations.push(createInvocation(runDir, { racer: process.pid }).dir);
  evidence.push(new Evidence({ runDir, slug: "same case name", always: false }).ensureDir());
}
process.stdout.write(JSON.stringify({ invocations, evidence }));
