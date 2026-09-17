#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Idempotent infrastructure bring-up (SPEC §9).

/**
 * Usage:
 *   setup.mjs --account <email> [--project <id>] [--location us-central1] [--dry-run]
 *
 * Every step is check-then-act or naturally idempotent, so re-running converges.
 * `--dry-run` prints the intended commands WITHOUT executing and WITHOUT
 * credentials.
 *
 * Credentials are never assumed: `--account` is threaded explicitly into every
 * gcloud and firebase call and is REQUIRED for real runs. An operator tool that
 * silently picks up whatever identity happens to be active is how the wrong
 * project gets modified.
 */

import { spawnSync } from "node:child_process";
import { parse, fail } from "./lib/args.mjs";
import { REPO_ROOT, getBucketName, getProjectId } from "./lib/firebase.mjs";

const { values } = parse({
  account: { type: "string" },
  project: { type: "string" },
  bucket: { type: "string" },
  location: { type: "string", default: "us-central1" },
  "dry-run": { type: "boolean", default: false },
});

const DRY = values["dry-run"];
const LOCATION = values.location;
const ACCOUNT = values.account;

// gcloud takes `--account=<email>`, firebase takes `--account <email>`. Matching
// each tool's own convention keeps the printed commands copy-pasteable.
const gcloudAcct = ACCOUNT ? [`--account=${ACCOUNT}`] : [];
const fbAcct = ACCOUNT ? ["--account", ACCOUNT] : [];

function sh(cmd, args, { cwd } = {}) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  if (DRY) return { status: 0 };
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (res.error) {
    if (res.error.code === "ENOENT") fail(`required tool not found: ${cmd}`);
    fail(`failed to run ${cmd}: ${res.error.message}`);
  }
  if (res.status !== 0) fail(`${cmd} exited with status ${res.status}`);
  return res;
}

/** Silent probe. Skipped entirely in dry-run, so it needs no credentials. */
function probe(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
  if (res.error && res.error.code === "ENOENT") fail(`required tool not found: ${cmd}`);
  return res.status === 0;
}

function ensure(label, describe, create) {
  if (DRY) {
    console.log(`  # ensure ${label}`);
    console.log(`  $ ${describe.join(" ")}`);
    console.log("  # if absent:");
    console.log(`  $ ${create.join(" ")}`);
    return;
  }
  if (probe(describe[0], describe.slice(1))) {
    console.log(`  ${label}: already exists, skipping.`);
  } else {
    console.log(`  ${label}: creating...`);
    sh(create[0], create.slice(1));
  }
}

function requireBin(name) {
  if (DRY) return;
  const res = spawnSync(name, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
  if (res.error && res.error.code === "ENOENT") {
    fail(`required tool not found on PATH: ${name}`);
  }
}

function main() {
  const projectId = getProjectId(values.project);
  const bucket = getBucketName(values.project, values.bucket);

  if (!DRY && !ACCOUNT) {
    fail(
      "`--account <email>` is required for real runs (credentials are never " +
        "assumed); pass it explicitly or use --dry-run",
    );
  }

  console.log(`setup: project=${projectId} account=${ACCOUNT ?? "(unset)"}`);
  console.log(`  bucket=gs://${bucket} location=${LOCATION}`);
  if (DRY) console.log("  --dry-run: printing intended commands only.\n");

  requireBin("gcloud");
  requireBin("firebase");

  console.log("\n[1/7] Enable Google Cloud services");
  sh("gcloud", [
    "services",
    "enable",
    "firestore.googleapis.com",
    "storage.googleapis.com",
    "firebasedatabase.googleapis.com",
    "cloudfunctions.googleapis.com",
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "eventarc.googleapis.com",
    "secretmanager.googleapis.com",
    `--project=${projectId}`,
    ...gcloudAcct,
  ]);

  console.log("\n[2/7] Ensure the Firestore (native) database");
  ensure(
    "firestore (default) database",
    ["gcloud", "firestore", "databases", "describe", "--database=(default)", `--project=${projectId}`, ...gcloudAcct],
    [
      "gcloud",
      "firestore",
      "databases",
      "create",
      "--database=(default)",
      `--location=${LOCATION}`,
      "--type=firestore-native",
      `--project=${projectId}`,
      ...gcloudAcct,
    ],
  );

  console.log("\n[3/7] Ensure the private content bucket");
  // Uniform access and public-access-prevention are not optional: the entire
  // access model rests on the bucket being unreachable except through the
  // authorizing proxy.
  ensure(
    `bucket gs://${bucket}`,
    ["gcloud", "storage", "buckets", "describe", `gs://${bucket}`, `--project=${projectId}`, ...gcloudAcct],
    [
      "gcloud",
      "storage",
      "buckets",
      "create",
      `gs://${bucket}`,
      `--project=${projectId}`,
      `--location=${LOCATION}`,
      "--uniform-bucket-level-access",
      "--public-access-prevention",
      ...gcloudAcct,
    ],
  );

  console.log("\n[4/7] Deploy Firestore rules and indexes, Storage rules, RTDB rules");
  sh(
    "firebase",
    [
      "deploy",
      "--only",
      "firestore:rules,firestore:indexes,storage,database",
      "--project",
      projectId,
      ...fbAcct,
    ],
    { cwd: REPO_ROOT },
  );

  console.log("\n[5/7] Deploy Cloud Functions");
  sh("firebase", ["deploy", "--only", "functions", "--project", projectId, ...fbAcct], {
    cwd: REPO_ROOT,
  });

  console.log("\n[6/7] Build the app and deploy Hosting");
  sh("npm", ["--prefix", "app", "run", "build"], { cwd: REPO_ROOT });
  sh("firebase", ["deploy", "--only", "hosting", "--project", projectId, ...fbAcct], {
    cwd: REPO_ROOT,
  });

  console.log("\n[7/7] One-time MANUAL checklist (no clean CLI exists for these):");
  console.log("  Authentication > Sign-in method:");
  console.log("    - Enable the Google provider.");
  console.log("    - Enable the GitHub provider, and request the `user:email` scope.");
  console.log("      Without that scope Firebase receives no address for users who");
  console.log("      keep theirs private, and an email-keyed ACL cannot grant them");
  console.log("      anything at all.");
  console.log("  Authentication > Settings > Authorized domains:");
  console.log("    - Add EVERY host the app is served from, including any custom");
  console.log("      domain. signInWithPopup rejects an unlisted origin with");
  console.log("      auth/unauthorized-domain, which reads as a broken button.");
  console.log("  Hosting > Add custom domain, for a name outside *.web.app.");
  console.log("  Realtime Database > Create database, if you want peer presence.");
  console.log("    Presence degrades to a clean no-op without it.");
  console.log("  Secret Manager, only if you want transactional email:");
  console.log(`    $ firebase functions:secrets:set RESEND_API_KEY --project ${projectId}`);
  console.log("    Email is optional; with no key every send is a logged no-op.");
  console.log("  Billing > Budgets & alerts: set a budget alert.");
  console.log("    Every byte of every document is proxied through a function, so");
  console.log("    traffic is a cost. This is a numbered step, not advice.");
  console.log(`\nsetup complete.${DRY ? " (dry-run)" : ""}`);
}

main();
