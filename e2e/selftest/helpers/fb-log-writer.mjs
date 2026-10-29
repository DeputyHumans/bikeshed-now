// SPDX-License-Identifier: Apache-2.0
// Self-test helper: write firebase-debug.log as firebase-tools does (its own logger when installed), and unlink it at a clean exit as its CLI does (SPEC §12).

/**
 *   node fb-log-writer.mjs <file> script <script.json>
 *   node fb-log-writer.mjs <file> stream <tickMs> <fillerBytes>
 *
 * Records go through firebase-tools' own logger (lib/logger.js useFileLogger
 * and lib/emulator/emulatorLogger.js, the package found from
 * E2E_FIREBASE_BIN or `firebase` on PATH), the way downloadableEmulators.js
 * _runBinary logs a JVM chunk: EmulatorLogger.forEmulator(name).log("DEBUG",
 * chunk). With no firebase-tools installed, or E2E_FB_WRITER=format, a copy
 * of its file format is written instead. Prints `mode real|format` first.
 *
 * script  logs each {emulator, type, text} of the JSON list in order
 *         (emulator null: logger.debug(text); type "BULLET": logLabeled;
 *         "DEBUG" or "INFO": EmulatorLogger.log),
 *         prints `done` once the file holds them, then stays up.
 * stream  every tickMs one database record `seq=<n>` (every 5th over two
 *         lines, every 7th in two chunks), then `fillerBytes` of a firestore
 *         chunk; prints `ready` after the first tick.
 *
 * On SIGINT it stops streaming, logs one database record `shutdown
 * seq=<n>` (n: the next seq, never written), then exits 0,
 * and, as firebase-tools' bin/cli.js does on an exit code under 2, unlinks
 * the log file.
 */

import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { firebaseTools } from "../../lib/prerequisites.mjs";

const [file, mode, a1, a2] = process.argv.slice(2);

const root = process.env.E2E_FB_WRITER === "format" ? null : firebaseTools({ optional: true })?.root;
let logChunk;
if (root) {
  const req = createRequire(join(root, "lib", "logger.js"));
  const { logger, useFileLogger } = req(join(root, "lib", "logger.js"));
  const { EmulatorLogger } = req(join(root, "lib", "emulator", "emulatorLogger.js"));
  useFileLogger(file);
  const loggers = new Map();
  logChunk = (emulator, type, text) => {
    if (emulator === null) return logger.debug(text);
    if (!loggers.has(emulator)) loggers.set(emulator, EmulatorLogger.forEmulator(emulator));
    if (type === "BULLET") loggers.get(emulator).logLabeled("BULLET", emulator, text);
    else loggers.get(emulator).log(type, text);
  };
} else {
  // logger.js useFileLogger's printf over annotateDebugLines, with EmulatorLogger.log's metadata.
  logChunk = (emulator, type, text) => {
    const meta = emulator === null ? [] : [JSON.stringify({ metadata: { emulator: { name: emulator }, message: text } })];
    const line =
      type === "BULLET" ? `[info] i  ${emulator}: ${[text, ...meta].join(" ")}`
      : type === "INFO" ? `[info] ${stripVTControlCharacters([text, ...meta].join(" "))}`
      : `[debug] ${stripVTControlCharacters([`[${new Date().toISOString()}] ${text}`, ...meta].join(" "))}`;
    appendFileSync(file, `${line}\n`);
  };
}
process.stdout.write(`mode ${root ? "real" : "format"}\n`);

let seq = 0;
let timer = null;
const clock = () => new Date().toISOString().slice(11, 23);

process.on("exit", (code) => {
  if (code < 2 && existsSync(file)) unlinkSync(file);
});
process.on("SIGINT", () => {
  clearInterval(timer);
  logChunk("database", "DEBUG", `${clock()} [main] INFO shutdown seq=${seq}\n`);
  setTimeout(() => process.exit(0), 300);
});

/** Resolve once the file has stopped growing for 150 ms (winston writes through a stream). */
async function settled() {
  let last = -1;
  for (;;) {
    await new Promise((r) => setTimeout(r, 150));
    const size = existsSync(file) ? statSync(file).size : 0;
    if (size === last) return;
    last = size;
  }
}

if (mode === "script") {
  for (const { emulator, type, text } of JSON.parse(readFileSync(a1, "utf8"))) logChunk(emulator, type, text);
  await settled();
  process.stdout.write("done\n");
  setInterval(() => {}, 1000);
} else if (mode === "stream") {
  const tickMs = Number(a1);
  const filler = Number(a2);
  const tick = () => {
    const n = seq++;
    const t = clock();
    if (n % 7 === 3) {
      logChunk("database", "DEBUG", `${t} [ws] INFO seq=${n} split `);
      logChunk("database", "DEBUG", `rest seq=${n}\n`);
    } else if (n % 5 === 0) {
      logChunk("database", "DEBUG", `${t} [ws] INFO seq=${n} first\n${t} [ws] INFO seq=${n} second\n`);
    } else {
      logChunk("database", "DEBUG", `${t} [ws] INFO seq=${n}\n`);
    }
    if (filler > 0) logChunk("firestore", "DEBUG", `FINE: ${"f".repeat(filler)}\n`);
  };
  tick();
  setTimeout(() => process.stdout.write("ready\n"), 100);
  timer = setInterval(tick, tickMs);
} else {
  process.stderr.write(`fb-log-writer: unknown mode ${mode}\n`);
  process.exit(2);
}
