#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Renders the identity gate from config/access-policy.json into its four
// committed artifacts, or verifies they are up to date (SPEC §1).

/**
 * Usage:
 *   node tools/build-policy.mjs          write the artifacts
 *   node tools/build-policy.mjs --check  re-render in memory, byte-compare, exit 1 on drift
 *
 * The outputs are COMMITTED rather than gitignored. A security boundary that is
 * not in git is not reviewable and has no diff history — you would find out
 * that the gate changed by reading production. `--check` runs as `pretest` and
 * as the first step of `npm run build`, so a hand-edit or a stale artifact fails
 * loudly instead of shipping.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderAppPolicy,
  renderDatabaseRules,
  renderFirestoreRules,
  renderFunctionsPolicy,
} from "../config/policy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "config", "access-policy.json");

/** Every generated artifact, with the renderer that produces it. */
function artifacts(policy, sourceHash) {
  const tmpl = (name) =>
    readFileSync(join(ROOT, "config", "templates", name), "utf8");
  return [
    {
      path: "firestore.rules",
      content: renderFirestoreRules(policy, tmpl("firestore.rules.tmpl"), sourceHash),
    },
    {
      path: "database.rules.json",
      content: renderDatabaseRules(policy, tmpl("database.rules.json.tmpl"), sourceHash),
    },
    {
      // Functions needs its own copy under functions/src/ because Cloud
      // Functions uploads only that directory and tsconfig pins rootDir to it.
      path: "functions/src/generated/policy.ts",
      content: renderFunctionsPolicy(policy, sourceHash),
    },
    {
      path: "app/src/generated/policy.ts",
      content: renderAppPolicy(policy, sourceHash),
    },
  ];
}

function main() {
  const check = process.argv.includes("--check");
  const raw = readFileSync(SOURCE);
  const sourceHash = createHash("sha256").update(raw).digest("hex");

  let policy;
  try {
    policy = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    console.error(`config/access-policy.json is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  if (
    policy.allowedEmailDomains !== undefined &&
    !Array.isArray(policy.allowedEmailDomains)
  ) {
    console.error("config/access-policy.json: allowedEmailDomains must be an array");
    process.exit(1);
  }

  const drift = [];
  for (const { path, content } of artifacts(policy, sourceHash)) {
    const abs = join(ROOT, path);
    if (check) {
      let current = null;
      try {
        current = readFileSync(abs, "utf8");
      } catch {
        /* missing counts as drift */
      }
      if (current !== content) drift.push(path);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    console.log(`  wrote ${path}`);
  }

  if (!check) {
    console.log(`policy rendered from config/access-policy.json (${sourceHash.slice(0, 12)}…)`);
    return;
  }
  if (drift.length > 0) {
    console.error("generated policy artifacts are out of date:");
    for (const p of drift) console.error(`  - ${p}`);
    console.error("\nrun `npm run build:policy` and commit the result.");
    process.exit(1);
  }
  console.log("policy artifacts: up to date");
}

main();
