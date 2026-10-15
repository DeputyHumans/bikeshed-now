// SPDX-License-Identifier: Apache-2.0
// Self-test: a stack's emulator debug logs are bounded after each watchdog check, and the logs specs read are never touched (SPEC §12).

/**
 * A real writer process (helpers/log-writer.mjs) writes a debug log as
 * firebase-tools does, at about 3 MB/s, while capDebugLogs runs every 100 ms
 * with a 1 MB cap, as the stack's watchdog does every few seconds with a
 * 200 MB one. The mirrored per-emulator logs are /dev/null, and the reason is
 * pinned too: a log written at its own offset cannot be cut under its writer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, lstatSync, readFileSync, readlinkSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DEBUG_LOG_MAX_DEFAULT_MB, MIRRORED_LOGS, capDebugLogs, debugLogMaxBytes, prepareDebugLogs } from "../lib/debuglogs.mjs";
import { logMark, waitForLog } from "../lib/logs.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const WRITER = fileURLToPath(new URL("./helpers/log-writer.mjs", import.meta.url));
const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startWriter(file, flags) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, file, flags, String(32 * 1024), "10"], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.once("data", () => resolve(child));
    child.once("error", reject);
  });
}

/** Write for `ms` while capping every 100 ms (or not, with cap null): the largest sizes before and after each cap check. */
async function writeWhileCapping(dir, { ms = 2500, maxBytes = MB, cap = true } = {}) {
  const file = join(dir, "firebase-debug.log");
  const w = await startWriter(file, "a");
  let largest = 0;
  let rotations = 0;
  let largestAfter = 0;
  try {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(100);
      largest = Math.max(largest, statSync(file).size);
      if (cap) rotations += capDebugLogs(dir, { maxBytes }).filter((r) => r.rotated).length;
      largestAfter = Math.max(largestAfter, statSync(file).size);
    }
  } finally {
    w.kill("SIGKILL");
  }
  return { file, largest, largestAfter, rotations };
}

test("the cap: 200 MB by default, lowerable, never raised", () => {
  assert.equal(debugLogMaxBytes({}), 200 * MB);
  assert.equal(debugLogMaxBytes({ E2E_DEBUG_LOG_MAX_MB: "50" }), 50 * MB);
  assert.throws(() => debugLogMaxBytes({ E2E_DEBUG_LOG_MAX_MB: String(DEBUG_LOG_MAX_DEFAULT_MB + 1) }), /1 to 200/);
});

test("firestore-debug.log and database-debug.log are /dev/null: what the emulator writes there is kept nowhere", async () => {
  const dir = tempDir("e2e-debuglogs-mirrored-");
  writeFileSync(join(dir, "firestore-debug.log"), "an old one\n");
  prepareDebugLogs(dir);
  for (const name of MIRRORED_LOGS) assert.equal(readlinkSync(join(dir, name)), "/dev/null", name);
  // firebase-tools opens each with createWriteStream(name), mode "w".
  const s = createWriteStream(join(dir, "firestore-debug.log"));
  await new Promise((r) => s.write("FINE ".repeat(10_000), r));
  await new Promise((r) => s.end(r));
  assert.ok(lstatSync(join(dir, "firestore-debug.log")).isSymbolicLink());
  const listed = capDebugLogs(dir, { maxBytes: MB }).filter((r) => r.link);
  assert.deepEqual(listed.map((r) => r.link), ["/dev/null", "/dev/null"]);
});

test("firebase-debug.log, written without pause, is reduced at each cap check: newest half kept in .1, head kept once", async () => {
  const dir = tempDir("e2e-debuglogs-cap-");
  // The log specs read sits beside it, over the cap: never touched.
  const emulators = join(dir, "emulators.log");
  writeFileSync(emulators, `${"function console line\n".repeat(80_000)}`);
  const before = statSync(emulators).size;
  const r = await writeWhileCapping(dir);
  assert.ok(r.rotations >= 2, `cut ${r.rotations} times while being written`);
  assert.ok(r.largestAfter <= MB, `after each cap check the largest size was ${r.largestAfter}, within ${MB} bytes (before checks: ${r.largest})`);
  assert.ok(statSync(`${r.file}.1`).size <= MB / 2, "the kept tail is half the cap at most");
  const head = readFileSync(join(dir, "firebase-debug.head.log"), "utf8");
  assert.ok(head.startsWith("line 0 "), "the head holds the first lines (the start-up config)");
  // The writer appends: after a cut its next lines start the file again, no hole.
  const live = readFileSync(r.file, "utf8");
  assert.match(live.slice(0, 20), /^line \d+ x/, "the live file starts with a whole line after the cut, not a hole of NULs");
  assert.equal(statSync(emulators).size, before, "emulators.log is not touched");
});

test("a delayed watchdog may see an overshoot, but its next check truncates and retains only the bounded tail", () => {
  const dir = tempDir("e2e-debuglogs-late-");
  const file = join(dir, "firebase-debug.log");
  writeFileSync(file, "x".repeat(2 * MB));
  const [result] = capDebugLogs(dir, { maxBytes: MB });
  assert.equal(result.size, 2 * MB, "record the actual pre-check overshoot");
  assert.equal(result.rotated, true);
  assert.equal(statSync(file).size, 0, "a delayed cap check still truncates the live log");
  assert.equal(statSync(`${file}.1`).size, MB / 2, "overshoot does not increase retained tail bytes");
});

test("a line written after a mark is found in emulators.log while firebase-debug.log is being cut beside it", async () => {
  const dir = tempDir("e2e-debuglogs-fresh-");
  const emulators = join(dir, "emulators.log");
  writeFileSync(emulators, "start\n");
  const mark = logMark(emulators);
  const writing = writeWhileCapping(dir, { ms: 1500 });
  await sleep(700);
  writeFileSync(emulators, `start\n>  [email] skipped "Hello" to fresh@e2e.invalid: no API key configured\n`);
  const hit = await waitForLog(/\[email\] skipped "Hello" to fresh@e2e\.invalid/, { file: emulators, since: mark, timeout: 5000, pollMs: 50 });
  assert.ok(hit.line.includes("fresh@e2e.invalid"));
  assert.ok((await writing).rotations >= 1);
});

test("NEGATIVE: without the cap, the same writer takes the log past it", async () => {
  const dir = tempDir("e2e-debuglogs-nocap-");
  const r = await writeWhileCapping(dir, { cap: false });
  assert.ok(r.largest > MB, `uncapped, the log reached ${r.largest} bytes: only the cap holds it`);
  assert.equal(existsSync(`${r.file}.1`), false);
});

test("NEGATIVE: a log written at its own offset (mode \"w\") cannot be cut under its writer: the next write leaves a hole the size of everything before", async () => {
  const dir = tempDir("e2e-debuglogs-w-");
  const file = join(dir, "firestore-debug.log");
  const w = await startWriter(file, "w");
  try {
    await sleep(500);
    const before = statSync(file).size;
    truncateSync(file, 0);
    await sleep(300);
    const after = statSync(file).size;
    const head = readFileSync(file).subarray(0, 16);
    assert.ok(after >= before, `the size did not drop (${before} → ${after})`);
    assert.ok(head.every((b) => b === 0), "the file now starts with NULs");
  } finally {
    w.kill("SIGKILL");
  }
});
