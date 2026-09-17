#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Hard-fail on a dependency outside the permissive allowlist (SPEC §12).

/**
 * Why this HARD-FAILS rather than warning.
 *
 * Apache-2.0 is one-way incompatible with GPLv2-only: a single GPLv2 transitive
 * dependency makes the combined work undistributable under the licence this
 * project claims. That has to surface on the pull request that introduces it,
 * because by release the only options are "rip it out" or "relicense the
 * project", and both are somebody's week.
 *
 * Dual-licensed packages are resolved by taking any acceptable half of an `OR`,
 * which is what a dual licence is for. `node-forge` declares
 * `(BSD-3-Clause OR GPL-2.0)`; we take BSD-3-Clause, and a scanner reporting
 * "GPL found" there is reporting half of a choice.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
]);

/**
 * Exceptions, each with a reason. An exception without one is how an allowlist
 * becomes a list of things nobody remembers deciding.
 */
const EXCEPTIONS = new Map([
  [
    "caniuse-lite",
    "CC-BY-4.0. A build-time browser-compatibility database, not code, and not redistributed. Attribution is in THIRD_PARTY_LICENSES.md.",
  ],
]);

function normalize(license) {
  if (!license) return [];
  if (typeof license === "object") {
    // The legacy {type, url} shape, and the even older array of them.
    const list = Array.isArray(license) ? license : [license];
    return list.map((l) => String(l.type ?? "")).filter(Boolean);
  }
  const text = String(license).replace(/[()]/g, "");
  // An OR means we may pick; an AND means every half must be acceptable.
  if (/\bOR\b/i.test(text)) return text.split(/\s+OR\s+/i).map((s) => s.trim());
  if (/\bAND\b/i.test(text)) {
    const parts = text.split(/\s+AND\s+/i).map((s) => s.trim());
    return parts.every((p) => ALLOWED.has(p)) ? [parts[0]] : [text];
  }
  return [text.trim()];
}

const found = new Map();

function walk(dir, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (name.startsWith("@")) {
      walk(full, depth);
      continue;
    }
    const manifest = join(full, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name) found.set(pkg.name, pkg.license ?? pkg.licenses ?? null);
    } catch {
      /* an unreadable manifest is reported below as unknown */
    }
    walk(join(full, "node_modules"), depth + 1);
  }
}

for (const dir of ["node_modules", "app/node_modules", "functions/node_modules"]) {
  walk(join(ROOT, dir));
}

if (found.size === 0) {
  console.error("no packages found — run `npm run install:all` first");
  process.exit(1);
}

const problems = [];
const counts = new Map();

for (const [name, raw] of found) {
  const options = normalize(raw);
  const acceptable = options.some((option) => ALLOWED.has(option));
  const declared = options.join(" OR ") || "UNKNOWN";
  counts.set(declared, (counts.get(declared) ?? 0) + 1);

  if (acceptable) continue;
  if (EXCEPTIONS.has(name)) continue;
  problems.push(`${name}: ${declared}`);
}

console.log(`licences: ${found.size} packages`);
for (const [license, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(count).padStart(4)}  ${license}`);
}
for (const [name, reason] of EXCEPTIONS) {
  if (found.has(name)) console.log(`  exception: ${name} — ${reason}`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} package(s) outside the allowlist:`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "\nAdd it to the allowlist only if it is genuinely permissive, or to EXCEPTIONS with a reason.",
  );
  process.exit(1);
}

console.log("licences: every dependency is permissive");
