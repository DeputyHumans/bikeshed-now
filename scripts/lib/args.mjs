// SPDX-License-Identifier: Apache-2.0
// A thin wrapper over node:util parseArgs (SPEC §9).

import { parseArgs } from "node:util";

/**
 * Parse process.argv against an options spec.
 *
 * `strict: true` so a typo'd flag is an error rather than a silent no-op. On an
 * operator CLI that matters more than usual: `--dry-run` misspelt as `--dryrun`
 * would otherwise run for real.
 */
export function parse(options, { allowPositionals = true } = {}) {
  return parseArgs({
    args: process.argv.slice(2),
    options,
    allowPositionals,
    strict: true,
  });
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
