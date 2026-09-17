// SPDX-License-Identifier: Apache-2.0
// A thin wrapper over node:util parseArgs (SPEC §9).

import { parseArgs } from "node:util";

/**
 * Parse process.argv against an options spec.
 *
 * `strict: true` so a typo'd flag is an error rather than a silent no-op. On an
 * operator CLI that matters more than usual: `--dry-run` misspelt as `--dryrun`
 * would otherwise run for real.
 *
 * Strict parsing throws, and an uncaught throw prints a Node stack trace — which
 * tells an operator nothing about which flag was wrong and buries the fact that
 * the run did not happen. So the throw is caught and turned into one line plus
 * the usage.
 *
 * `--help` is added to every spec here rather than in each script, because a
 * tool that destroys data has to be able to explain itself before it is run,
 * and "add it to each one" is how three of five end up without it.
 */
export function parse(options, { allowPositionals = true, usage } = {}) {
  const help = () => {
    console.log(usage ?? "no usage text was provided for this command");
    process.exit(0);
  };
  // Checked before parsing too, so `--help` still works alongside a typo.
  if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) help();

  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: { ...options, help: { type: "boolean", short: "h", default: false } },
      allowPositionals,
      strict: true,
    });
  } catch (err) {
    console.error(`error: ${err.message}`);
    if (usage) console.error(`\n${usage}`);
    return process.exit(1);
  }
}

/** Split a comma-separated CLI value into a trimmed, non-empty list. */
export function splitList(value) {
  if (value == null) return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Print a fatal error and exit non-zero. */
export function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
