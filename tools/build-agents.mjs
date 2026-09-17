#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Keep the two generated agent documents in step with their sources (SPEC §19).

/**
 * Usage:
 *   node tools/build-agents.mjs          write both generated files
 *   node tools/build-agents.mjs --check  verify both, exit 1 on drift
 *
 * There are two audiences, and conflating them is how an agent ends up reading
 * the wrong instructions confidently:
 *
 *   CLAUDE.md          → AGENTS.md            for an agent CHANGING THIS SOURCE
 *   docs/agent-guide.md → app/public/llms.txt for an agent USING A DEPLOYMENT
 *
 * `AGENTS.md` is the cross-tool convention, so it must exist and must say the
 * same thing as `CLAUDE.md` rather than a stale paraphrase of it. `/llms.txt`
 * is what an agent fetches from a running deployment, so it must say the same
 * thing as the guide in the tree.
 *
 * Both are generated rather than hand-maintained for the same reason the
 * security rules are: two copies of one instruction drift, and the drift is
 * invisible until somebody acts on the wrong one.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A banner is prepended where the generated file has a name somebody would
 * plausibly open and edit. `llms.txt` gets none: it is served verbatim to
 * agents, and a note about this repository's build process is noise to a reader
 * who has never seen the repository.
 */
const PAIRS = [
  {
    source: "CLAUDE.md",
    target: "AGENTS.md",
    banner:
      "<!-- GENERATED from CLAUDE.md by tools/build-agents.mjs — DO NOT EDIT.\n" +
      "     Edit CLAUDE.md and run `npm run build:agents`.\n\n" +
      "     This file exists because AGENTS.md is the cross-tool convention, and\n" +
      "     an agent that reads it should get exactly what Claude Code reads,\n" +
      "     not a paraphrase that fell behind. -->\n\n",
  },
  {
    source: "docs/agent-guide.md",
    target: "app/public/llms.txt",
    banner: "",
  },
];

const check = process.argv.includes("--check");
let drifted = 0;

for (const { source, target, banner } of PAIRS) {
  const expected = banner + readFileSync(join(ROOT, source), "utf8");

  if (!check) {
    writeFileSync(join(ROOT, target), expected);
    console.log(`wrote ${target} from ${source}`);
    continue;
  }

  let current = null;
  try {
    current = readFileSync(join(ROOT, target), "utf8");
  } catch {
    /* missing counts as drift */
  }
  if (current !== expected) {
    console.error(`${target} does not match ${source}.`);
    drifted += 1;
  }
}

if (check) {
  if (drifted > 0) {
    console.error("\nrun `npm run build:agents` and commit the result.");
    process.exit(1);
  }
  console.log("agent instructions: in sync");
}
