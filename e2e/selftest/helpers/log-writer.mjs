// SPDX-License-Identifier: Apache-2.0
// Self-test helper: write a debug log the way firebase-tools does, append (winston) or at its own offset (an emulator's stream) (SPEC §12).

/**
 *   node log-writer.mjs <file> <a|w> <bytesPerTick> <tickMs>
 *
 * Opens <file> with fs.createWriteStream and flags "a" (O_APPEND, as winston
 * opens firebase-debug.log) or "w" (as firebase-tools opens
 * firestore-debug.log), then writes numbered lines, <bytesPerTick> bytes
 * every <tickMs> ms, until killed. Prints "ready" once the stream is open.
 */

import { createWriteStream } from "node:fs";

const [file, flags, perTick, tickMs] = process.argv.slice(2);
const out = createWriteStream(file, { flags });
let n = 0;
out.on("open", () => process.stdout.write("ready\n"));
setInterval(() => {
  let chunk = "";
  while (chunk.length < Number(perTick)) chunk += `line ${n++} ${"x".repeat(100)}\n`;
  out.write(chunk);
}, Number(tickMs));
