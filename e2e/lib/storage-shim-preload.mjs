// SPDX-License-Identifier: Apache-2.0
// Preloaded into the emulator of a --storage-shim stack: in a function worker it points the Storage emulator host at the stack's shim before any product code runs, and logs one line saying so (SPEC §4, §12).

/**
 * A --storage-shim stack (lib/storage-shim.mjs) starts `firebase
 * emulators:start` with
 *
 *   NODE_OPTIONS="--require=<tree>/.e2e/egress-guard.mjs --require=<tree>/.e2e/storage-shim-preload.mjs"
 *   E2E_STORAGE_SHIM_HOST=127.0.0.1:<shim>         the shim (block role storageShim)
 *   E2E_STORAGE_SHIM_UPSTREAM=127.0.0.1:<storage>  the Storage emulator it stands in front of
 *   E2E_STORAGE_SHIM_LOG=<logs>/storage-shim.jsonl
 *
 * and every function worker inherits all four (firebase-tools spawns a
 * worker with `...process.env, ...envs`). firebase-tools sets the worker's
 * STORAGE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST from its own
 * registry, after the functions' .env.local, so only a preload can move
 * them. This file, loaded before the runtime and the product:
 *
 *   - acts only where FUNCTIONS_EMULATOR is "true" (a function worker, or the
 *     functions' discovery), never in the emulator's own process;
 *   - points both hosts at the shim only when every one that is set names
 *     the Storage emulator of this stack, and at least one is set; hosts that
 *     already name the shim (a worker thread, which inherits the moved env)
 *     stay, `already: true`; anything else (a host it does not know, no host,
 *     a malformed variable) is left exactly as it was, and the line says why;
 *   - writes one JSON line per realm: {t, pid, ppid, thread, target
 *     (FUNCTION_TARGET or null), from, to, shim, upstream, redirected,
 *     already, why}.
 *
 * Readiness reads those lines (shimRedirects): a stack whose function workers
 * did not move does not start. It imports nothing but Node built-ins, holds
 * nothing open, prints nothing, and is copied into each stack's tree so a
 * stack keeps the preload it was built with (a controls set may patch it).
 */

import { appendFileSync } from "node:fs";
import { threadId } from "node:worker_threads";

const INSTALLED = Symbol.for("bikeshed-e2e.storage-shim-preload");
const HOST = /^127\.0\.0\.1:(\d{1,5})$/;
const env = process.env;

function line(o) {
  const file = env.E2E_STORAGE_SHIM_LOG;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify(o)}\n`);
  } catch {
    /* a log that cannot be written leaves readiness without the line, which fails the start */
  }
}

if (!globalThis[INSTALLED] && env.FUNCTIONS_EMULATOR === "true") {
  globalThis[INSTALLED] = true;
  const shim = env.E2E_STORAGE_SHIM_HOST ?? null;
  const upstream = env.E2E_STORAGE_SHIM_UPSTREAM ?? null;
  const from = { STORAGE_EMULATOR_HOST: env.STORAGE_EMULATOR_HOST ?? null, FIREBASE_STORAGE_EMULATOR_HOST: env.FIREBASE_STORAGE_EMULATOR_HOST ?? null };
  const set = [from.FIREBASE_STORAGE_EMULATOR_HOST, from.STORAGE_EMULATOR_HOST].filter((v) => v !== null);
  // A worker thread inherits the env its main thread already moved: nothing to do, and nothing wrong.
  const already = HOST.test(shim ?? "") && set.length > 0 && (from.FIREBASE_STORAGE_EMULATOR_HOST ?? shim) === shim && (from.STORAGE_EMULATOR_HOST ?? `http://${shim}`) === `http://${shim}`;
  let why = null;
  if (already) why = null;
  else if (!HOST.test(shim ?? "") || !HOST.test(upstream ?? "")) why = `E2E_STORAGE_SHIM_HOST and E2E_STORAGE_SHIM_UPSTREAM are 127.0.0.1:<port>, got ${JSON.stringify(shim)} and ${JSON.stringify(upstream)}`;
  else if (from.STORAGE_EMULATOR_HOST === null && from.FIREBASE_STORAGE_EMULATOR_HOST === null) why = "no Storage emulator host is set in this process";
  else if (from.FIREBASE_STORAGE_EMULATOR_HOST !== null && from.FIREBASE_STORAGE_EMULATOR_HOST !== upstream) why = `FIREBASE_STORAGE_EMULATOR_HOST is ${JSON.stringify(from.FIREBASE_STORAGE_EMULATOR_HOST)}, not the stack's Storage emulator ${upstream}`;
  else if (from.STORAGE_EMULATOR_HOST !== null && from.STORAGE_EMULATOR_HOST !== `http://${upstream}`) why = `STORAGE_EMULATOR_HOST is ${JSON.stringify(from.STORAGE_EMULATOR_HOST)}, not the stack's Storage emulator http://${upstream}`;
  if (why === null && !already) {
    // Both, so firebase-admin (FIREBASE_…) and @google-cloud/storage (STORAGE_…) agree.
    env.FIREBASE_STORAGE_EMULATOR_HOST = shim;
    env.STORAGE_EMULATOR_HOST = `http://${shim}`;
  }
  line({
    t: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    thread: threadId,
    target: env.FUNCTION_TARGET || null,
    from,
    to: { STORAGE_EMULATOR_HOST: env.STORAGE_EMULATOR_HOST ?? null, FIREBASE_STORAGE_EMULATOR_HOST: env.FIREBASE_STORAGE_EMULATOR_HOST ?? null },
    shim,
    upstream,
    redirected: why === null,
    already,
    why,
  });
}
