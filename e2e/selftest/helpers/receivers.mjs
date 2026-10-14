// SPDX-License-Identifier: Apache-2.0
// Self-test helper: one "spec file" starting OAuth receivers on a shared stack's spare pool, to race another doing the same (SPEC §12).

/**
 *   node receivers.mjs <target.json> <count> <holdMs> <startAtEpochMs> <tag>
 *
 * Busy-waits until <startAtEpochMs> so every racer starts together, then
 * starts <count> receivers AT ONCE through lib/oauth.mjs startReceiver({target})
 * (each claims a port from the pool, waiting when all are taken). Each one is
 * hit once with ?code=<tag>-<i> to prove the listener on that port is this
 * process's own, held for <holdMs>, and closed (releasing its claim). Prints
 * {ok:[{port, start, end, code}], errors:[message]} as JSON.
 */

import { readFileSync } from "node:fs";
import { startReceiver } from "../../lib/oauth.mjs";

const [targetFile, count, holdMs, startAt, tag] = process.argv.slice(2);
const target = JSON.parse(readFileSync(targetFile, "utf8"));
while (Date.now() < Number(startAt)) {}
const ok = [];
const errors = [];
await Promise.all(
  Array.from({ length: Number(count) }, async (_, i) => {
    try {
      const r = await startReceiver({ target, claimTimeoutMs: 30_000 });
      const start = Date.now();
      try {
        const res = await fetch(`${r.redirectUri}?code=${tag}-${i}`);
        const got = await r.wait(2000);
        if (res.status !== 200 || got.code !== `${tag}-${i}`) throw new Error(`port ${r.port} answered ${res.status} with ${got.code}`);
        await new Promise((s) => setTimeout(s, Number(holdMs)));
      } finally {
        const end = Date.now();
        await r.close();
        ok.push({ port: r.port, start, end, code: `${tag}-${i}` });
      }
    } catch (err) {
      errors.push(`${err.code ?? ""} ${err.message}`.trim());
    }
  }),
);
process.stdout.write(JSON.stringify({ ok, errors }));
