#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Reverse setup, guarded (SPEC §9).

/**
 * Usage:
 *   teardown.mjs --yes --account <email> [--functions] [--project <id>] [--dry-run]
 *
 * Deletes the application's data and, optionally, its functions. NEVER deletes
 * the project.
 *
 * The defect this replaces was silent and specific: the original deleted TWO
 * functions by name, because it was written when there were two, and never
 * touched the folders collection at all. It reported success. Here the function
 * list comes from `scripts/lib/endpoints.mjs`, the single table that
 * firebase.json and the dev proxy also derive from, and a wiring test asserts
 * all three agree — so a new endpoint cannot be added without teardown learning
 * about it.
 */

import { spawnSync } from "node:child_process";
import { parse, fail } from "./lib/args.mjs";
import { functionNames } from "./lib/endpoints.mjs";
import {
  REPO_ROOT,
  getBucket,
  getBucketName,
  getDb,
  getProjectId,
  getRtdb,
} from "./lib/firebase.mjs";

/** Every collection this application owns. */
const COLLECTIONS = ["docs", "folders", "teams", "tokens", "public", "users"];

/** Every RTDB path this application writes. */
const RTDB_PATHS = ["status", "presenceAccess"];

async function main() {
  const { values } = parse({
    yes: { type: "boolean", default: false },
    functions: { type: "boolean", default: false },
    account: { type: "string" },
    project: { type: "string" },
    bucket: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  });

  const dry = values["dry-run"];
  const account = values.account;
  const projectId = getProjectId(values.project);
  const bucketName = getBucketName(values.project, values.bucket);
  const fns = functionNames();

  console.log(`teardown: project=${projectId} account=${account ?? "(unset)"}`);
  console.log(`  bucket:      gs://${bucketName}`);
  console.log(`  will delete: Firestore ${COLLECTIONS.map((c) => `${c}/**`).join(", ")}`);
  console.log(`  will empty:  gs://${bucketName}/docs/`);
  console.log(`  will clear:  RTDB ${RTDB_PATHS.join(", ")}`);
  if (values.functions) {
    console.log(`  will delete: ${fns.length} function(s) — ${fns.join(", ")}`);
  }
  console.log("  will NOT delete the project.");

  if (dry) {
    console.log("  --dry-run: nothing was deleted.");
    return;
  }
  if (!values.yes) {
    fail("refusing to delete without --yes (use --dry-run to preview)");
  }
  if (!account) {
    fail(
      "`--account <email>` is required for real runs (credentials are never " +
        "assumed); pass it explicitly or use --dry-run",
    );
  }

  const db = getDb(values.project);
  for (const name of COLLECTIONS) {
    console.log(`  deleting Firestore ${name}/** ...`);
    await db.recursiveDelete(db.collection(name));
    console.log("    done.");
  }

  console.log(`  emptying gs://${bucketName}/docs/ ...`);
  await getBucket(values.project, values.bucket).deleteFiles({
    prefix: "docs/",
    force: true,
  });
  console.log("    done.");

  const rtdb = getRtdb(values.project);
  if (rtdb) {
    for (const path of RTDB_PATHS) {
      console.log(`  clearing RTDB ${path} ...`);
      await rtdb.ref(path).remove();
      console.log("    done.");
    }
  } else {
    console.log("  no Realtime Database configured; skipping presence paths.");
  }

  if (values.functions) {
    console.log(`  deleting ${fns.length} Cloud Function(s) ...`);
    const res = spawnSync(
      "firebase",
      ["functions:delete", ...fns, "--project", projectId, "--force", "--account", account],
      { stdio: "inherit", cwd: REPO_ROOT },
    );
    if (res.error) {
      if (res.error.code === "ENOENT") fail("required tool not found: firebase");
      fail(`failed to run firebase: ${res.error.message}`);
    }
    if (res.status !== 0) fail(`firebase functions:delete exited with ${res.status}`);
  }

  console.log("teardown complete.");
}

main().catch((err) => fail(err.message || String(err)));
