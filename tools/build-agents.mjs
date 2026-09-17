#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copy AGENTS.md to the hosted llms.txt, or verify they match (SPEC §19).

/**
 * Usage:
 *   node tools/build-agents.mjs          write app/public/llms.txt
 *   node tools/build-agents.mjs --check  verify it matches, exit 1 if not
 *
 * Two copies exist because they serve two readers: AGENTS.md is what somebody
 * browsing the repository finds, and /llms.txt is what an agent fetches from a
 * running deployment. One source, one copy, and CI asserts they are identical —
 * so hosted instructions can never drift from the ones in the tree, which is
 * the failure mode that makes an agent confidently wrong.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "AGENTS.md");
const TARGET = join(ROOT, "app", "public", "llms.txt");

const source = readFileSync(SOURCE, "utf8");
const check = process.argv.includes("--check");

if (!check) {
  writeFileSync(TARGET, source);
  console.log("wrote app/public/llms.txt from AGENTS.md");
} else {
  let current = null;
  try {
    current = readFileSync(TARGET, "utf8");
  } catch {
    /* missing counts as drift */
  }
  if (current !== source) {
    console.error(
      "app/public/llms.txt does not match AGENTS.md.\n" +
        "run `npm run build:agents` and commit the result.",
    );
    process.exit(1);
  }
  console.log("agent instructions: in sync");
}
