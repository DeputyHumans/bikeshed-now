#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Every source file states its license and what it owns (SPEC §12).

/**
 * The header convention, and why it is two lines rather than eleven.
 *
 * A full Apache notice on a hundred files is eleven hundred lines of
 * boilerplate, and it would bury the one line that is actually useful to
 * somebody opening the file: what this module owns, and which section of the
 * spec it implements. So the rule is:
 *
 *   line 1   // SPDX-License-Identifier: Apache-2.0
 *   line 2   // <what this file owns> (SPEC §N)
 *
 * SPDX is what license scanners read, and it is legally sufficient when the
 * full text is in LICENSE at the root, which it is.
 *
 * The FULL notice goes on the files most likely to be copied OUT in isolation,
 * where the root LICENSE would not travel with them. Today that is the two
 * content-hash implementations: they are a normative wire format somebody may
 * reimplement from scratch, so they have to carry their own terms.
 *
 * The sample documents deliberately get SPDX only. They exist to be copied as
 * templates, and an eleven-line copyright notice inside somebody's own document
 * is a worse outcome than a one-line identifier they can delete.
 */

import { readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SPDX = "SPDX-License-Identifier: Apache-2.0";

/** Directories whose source files must carry the two-line header. */
const SOURCE_ROOTS = [
  "app/src",
  "functions/src",
  "scripts",
  "tools",
  "cli/src",
  "config",
  "rules-tests",
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".css", ".sh", ".py"]);

/** Files that must carry the full notice, not just the identifier. */
const FULL_NOTICE = ["functions/src/lib/hash.ts", "scripts/lib/hash.mjs"];

/** Sample documents: identifier only, in a comment of whatever syntax fits. */
const IDENTIFIER_ONLY = ["content/"];

const FULL_NOTICE_MARKERS = [
  "Licensed under the Apache License, Version 2.0",
  "http://www.apache.org/licenses/LICENSE-2.0",
  'distributed under the License is distributed on an "AS IS" BASIS',
];

function tracked() {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

const problems = [];

function check(path) {
  const text = readFileSync(join(ROOT, path), "utf8");
  const lines = text.split("\n");

  if (FULL_NOTICE.includes(path)) {
    for (const marker of FULL_NOTICE_MARKERS) {
      if (!text.includes(marker)) {
        problems.push(`${path}: needs the FULL Apache notice (missing: "${marker.slice(0, 40)}…")`);
        return;
      }
    }
    return;
  }

  if (IDENTIFIER_ONLY.some((prefix) => path.startsWith(prefix))) {
    if (!text.includes(SPDX)) {
      problems.push(`${path}: no ${SPDX} anywhere in the file`);
    }
    return;
  }

  /**
   * Two things legitimately occupy the first line and cannot move:
   * a shebang, and a TypeScript triple-slash directive — TypeScript only
   * honours the latter when it precedes all other content.
   */
  const offset =
    lines[0]?.startsWith("#!") || lines[0]?.startsWith("///") ? 1 : 0;
  const first = lines[offset] ?? "";
  const second = lines[offset + 1] ?? "";

  if (!first.includes(SPDX)) {
    problems.push(`${path}: line ${offset + 1} must be the SPDX identifier`);
    return;
  }

  // The purpose line. Generated files carry a GENERATED banner instead, which
  // says more about the file than a hand-written line would.
  const purpose = second.replace(/^\s*(\/\/|#|\/\*)\s*/, "").trim();
  if (purpose.length < 12) {
    problems.push(
      `${path}: line ${offset + 2} must say what this file owns, and cite its SPEC section`,
    );
  }
}

for (const path of tracked()) {
  const inSource = SOURCE_ROOTS.some((root) => path.startsWith(`${root}/`));
  const isSample = IDENTIFIER_ONLY.some((prefix) => path.startsWith(prefix));

  if (isSample) {
    if (path.endsWith(".html") || path.endsWith(".md")) check(path);
    continue;
  }
  if (!inSource) continue;
  if (!SOURCE_EXTENSIONS.has(extname(path))) continue;
  // Templates are rendered into files that carry their own banner.
  if (path.includes("/templates/")) continue;
  check(path);
}

if (problems.length > 0) {
  console.error(`missing or malformed headers (${problems.length}):`);
  for (const problem of problems) console.error(`  ${relative(".", problem)}`);
  process.exit(1);
}

console.log("headers: every source file states its license and its purpose");
