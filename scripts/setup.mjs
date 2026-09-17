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
import { TRIGGERS, functionNames } from "./lib/endpoints.mjs";

const USAGE = `setup.mjs — bring the deployment's infrastructure up, idempotently

  node scripts/setup.mjs --account <email> [options]

  --account <email>    console identity, threaded into every gcloud and firebase
                       call. REQUIRED for a real run; never defaulted, because a
                       tool that picks up whatever identity happens to be active
                       is how the wrong project gets modified
  --project <id>       Firebase project id (default: .firebaserc)
  --bucket <name>      content bucket (default: config/deploy.json, then a
                       derived \${projectId}-content)
  --location <region>  default us-central1
  --dry-run            print the intended commands, run nothing, need no
                       credentials
  --help

Every step is check-then-act or naturally idempotent, so re-running converges.
Start with --dry-run. See docs/operations.md.`;

const { values } = parse({
  account: { type: "string" },
  project: { type: "string" },
  bucket: { type: "string" },
  location: { type: "string", default: "us-central1" },
  "dry-run": { type: "boolean", default: false },
}, { usage: USAGE });

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

/** Run a command and return its trimmed stdout, or "" on any failure. */
function capture(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  return res.status === 0 ? (res.stdout ?? "").trim() : "";
}

/**
 * Grant a role, idempotently. `add-iam-policy-binding` is already idempotent —
 * re-adding an existing binding is a no-op — so this just narrates it.
 */
function grant(label, args) {
  console.log(`  ${label}`);
  if (DRY) {
    console.log(`  $ gcloud ${args.join(" ")}`);
    return;
  }
  const res = spawnSync("gcloud", args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (res.status !== 0) {
    const err = (res.stderr ?? "").split("\n").find((l) => l.includes("ERROR")) ?? "";
    fail(`could not grant ${label}: ${err || "see gcloud output"}`);
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

  /**
   * RTDB rules are deployed only if an instance EXISTS.
   *
   * Presence is documented as optional — without a Realtime Database it
   * degrades to a clean no-op — but `firebase deploy --only database` fails
   * hard when no instance is there, which made step 4 abort on a project that
   * had simply taken the documented option. Optional has to mean optional in
   * the script, not only in the prose beneath it.
   */
  const hasRtdb =
    !DRY &&
    probe("firebase", [
      "database:instances:list",
      "--project",
      projectId,
      ...fbAcct,
    ]);
  const ruleTargets = ["firestore:rules", "firestore:indexes", "storage"];
  if (DRY || hasRtdb) ruleTargets.push("database");

  console.log(
    `\n[4/8] Deploy Firestore rules and indexes, Storage rules${
      DRY || hasRtdb ? ", RTDB rules" : " (no RTDB instance — skipping its rules)"
    }`,
  );
  sh(
    "firebase",
    ["deploy", "--only", ruleTargets.join(","), "--project", projectId, ...fbAcct],
    { cwd: REPO_ROOT },
  );

  /**
   * The email secret must EXIST before functions deploy, even when email is off.
   *
   * `defineSecret` binds RESEND_API_KEY to every mailing function, and a
   * non-interactive deploy refuses to proceed if the secret has no version.
   * Secret Manager in turn refuses to store an empty payload. So "email is
   * optional" — which SPEC §13 and ADR 0008 both promise, and which is what
   * lets the quickstart run without a Resend account — is only true if
   * something creates a secret whose value the runtime reads as "off".
   *
   * That is this step. A single space is the payload, and `apiKey()` trims, so
   * the deployment mails nothing until somebody sets a real key. Creating it
   * here rather than telling the operator to is the difference between
   * optional and optional-if-you-read-step-8.
   */
  console.log("\n[5/8] Ensure the email secret exists (empty = email off)");
  if (DRY) {
    console.log(`  # ensure secret RESEND_API_KEY in ${projectId}`);
    console.log(`  $ gcloud secrets describe RESEND_API_KEY --project=${projectId}`);
    console.log("  # if absent, create it holding a single space, which reads as OFF:");
    console.log(
      `  $ printf ' ' | gcloud secrets create RESEND_API_KEY --replication-policy=automatic --data-file=- --project=${projectId}`,
    );
  } else if (
    probe("gcloud", ["secrets", "describe", "RESEND_API_KEY", `--project=${projectId}`, ...gcloudAcct])
  ) {
    console.log("  RESEND_API_KEY: already exists, leaving it alone.");
  } else {
    console.log("  RESEND_API_KEY: creating, holding a single space (email stays off)...");
    const res = spawnSync(
      "gcloud",
      [
        "secrets",
        "create",
        "RESEND_API_KEY",
        "--replication-policy=automatic",
        "--data-file=-",
        `--project=${projectId}`,
        ...gcloudAcct,
      ],
      { input: " ", stdio: ["pipe", "inherit", "inherit"] },
    );
    if (res.status !== 0) fail("could not create the RESEND_API_KEY secret");
  }

  /**
   * The RUNTIME service account's permissions.
   *
   * Google stopped granting the default compute service account broad roles on
   * new projects, so a fresh deployment comes up with a runtime identity that
   * can do almost nothing — and every symptom is remote from the cause:
   *
   *   no cloudbuild.builds.builder  the build fails at gcs-fetcher, exit 3
   *   no datastore.user             every request 500s on PERMISSION_DENIED
   *   no firebaseauth.admin         every sign-in fails with session_failed
   *   no storage.objectAdmin        documents publish but never serve
   *   no serviceAccountTokenCreator createSessionCookie cannot sign
   *
   * Each of those cost a debugging session on the first real deployment. They
   * are granted here so the next one costs none.
   *
   * Storage is scoped to the CONTENT BUCKET rather than the project: it is the
   * only bucket the runtime should touch, and a project-wide grant would also
   * hand it the build artifacts.
   */
  console.log("\n[6/10] Grant the runtime service account its permissions");
  const projectNumber = DRY
    ? "PROJECT_NUMBER"
    : capture("gcloud", [
        "projects",
        "describe",
        projectId,
        "--format=value(projectNumber)",
        ...gcloudAcct,
      ]);
  if (!projectNumber) fail("could not resolve the project number");
  const runtimeSa = `${projectNumber}-compute@developer.gserviceaccount.com`;
  const member = `serviceAccount:${runtimeSa}`;
  console.log(`  runtime identity: ${runtimeSa}`);

  for (const [role, why] of [
    ["roles/cloudbuild.builds.builder", "build the function containers"],
    ["roles/datastore.user", "read and write Firestore"],
    ["roles/firebaseauth.admin", "verify tokens and mint session cookies"],
    ["roles/firebasedatabase.admin", "maintain the presence mirror"],
  ]) {
    grant(`${role} — ${why}`, [
      "projects",
      "add-iam-policy-binding",
      projectId,
      `--member=${member}`,
      `--role=${role}`,
      "--condition=None",
      ...gcloudAcct,
    ]);
  }

  grant(`roles/storage.objectAdmin on gs://${bucket} only — serve document bytes`, [
    "storage",
    "buckets",
    "add-iam-policy-binding",
    `gs://${bucket}`,
    `--member=${member}`,
    "--role=roles/storage.objectAdmin",
    `--project=${projectId}`,
    ...gcloudAcct,
  ]);

  // Signing a session cookie means signing a JWT AS this identity, so it needs
  // the token-creator role ON ITSELF. Without it every sign-in fails, and the
  // error surfaces only in the function's own logs.
  grant("roles/iam.serviceAccountTokenCreator on itself — sign session cookies", [
    "iam",
    "service-accounts",
    "add-iam-policy-binding",
    runtimeSa,
    `--member=${member}`,
    "--role=roles/iam.serviceAccountTokenCreator",
    `--project=${projectId}`,
    ...gcloudAcct,
  ]);

  console.log("\n[7/10] Deploy Cloud Functions");
  sh("firebase", ["deploy", "--only", "functions", "--project", projectId, ...fbAcct], {
    cwd: REPO_ROOT,
  });

  /**
   * Make the HTTP endpoints publicly INVOKABLE.
   *
   * Firebase does not do this on a project whose organization restricts IAM
   * members, and the symptom is total: every function-backed path answers 403
   * with an HTML body, before any of this codebase runs. The app looks
   * completely broken while being perfectly deployed.
   *
   * "Publicly invokable" is not "public": each function authenticates its own
   * caller — session cookie, bearer token, or the deliberate anonymous branch
   * for a public document. The Firestore TRIGGER is excluded, because a trigger
   * reachable from the internet is a different thing entirely.
   *
   * If this step fails with FAILED_PRECONDITION, the organization has Domain
   * Restricted Sharing on. docs/operations.md says what to do about it.
   */
  console.log("\n[8/10] Allow unauthenticated invocation of the HTTP endpoints");
  const httpFunctions = functionNames().filter((n) => !TRIGGERS.includes(n));
  console.log(`  ${httpFunctions.length} HTTP endpoints; the trigger stays private`);
  for (const name of httpFunctions) {
    grant(`allUsers invoker on ${name}`, [
      "run",
      "services",
      "add-iam-policy-binding",
      name.toLowerCase(),
      "--region=us-central1",
      `--project=${projectId}`,
      "--member=allUsers",
      "--role=roles/run.invoker",
      ...gcloudAcct,
    ]);
  }

  console.log("\n[9/10] Build the app and deploy Hosting");
  sh("npm", ["--prefix", "app", "run", "build"], { cwd: REPO_ROOT });
  sh("firebase", ["deploy", "--only", "hosting", "--project", projectId, ...fbAcct], {
    cwd: REPO_ROOT,
  });

  console.log("\n[10/10] One-time MANUAL checklist (no clean CLI exists for these):");
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
  console.log("    Presence degrades to a clean no-op without it, and step 4");
  console.log("    skips the RTDB rules rather than failing, so this really is");
  console.log("    optional. Create one, then re-run setup to deploy its rules.");
  console.log("  Secret Manager, only if you want transactional email:");
  console.log(`    $ firebase functions:secrets:set RESEND_API_KEY --project ${projectId}`);
  console.log("    Step 5 already created this secret holding a space, which reads");
  console.log("    as OFF, so functions deploy and every send is a logged no-op.");
  console.log("    Set a real key only when you want mail actually delivered.");
  console.log("  Billing > Budgets & alerts: set a budget alert.");
  console.log("    Every byte of every document is proxied through a function, so");
  console.log("    traffic is a cost. This is a numbered step, not advice.");
  console.log(`\nsetup complete.${DRY ? " (dry-run)" : ""}`);
}

// Every other script here ends `main().catch(fail)`. setup is the FIRST one an
// operator runs, and the likeliest to hit a missing .firebaserc, so it is the
// one that must not answer with a stack trace.
try {
  main();
} catch (err) {
  fail(err.message || String(err));
}
