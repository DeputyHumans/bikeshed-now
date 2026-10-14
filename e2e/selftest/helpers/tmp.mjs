// SPDX-License-Identifier: Apache-2.0
// Self-test helper: temporary directories that are removed when the test file's process ends (SPEC §12).

/**
 *   import { tempDir } from "./helpers/tmp.mjs";
 *   const dir = tempDir("e2e-cli-");
 *
 * mkdtemp under the OS temp directory, remembered and removed on process exit
 * (node --test --test-force-exit still fires 'exit'), so a self-test leaves
 * nothing behind whether it passes, fails or is cut short by an assertion.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = new Set();
let hooked = false;

export function tempDir(prefix = "e2e-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  if (!hooked) {
    hooked = true;
    process.once("exit", cleanTemp);
  }
  return dir;
}

/** Remove every directory tempDir() made so far. */
export function cleanTemp() {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  made.clear();
}
