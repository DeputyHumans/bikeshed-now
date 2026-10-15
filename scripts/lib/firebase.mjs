// SPDX-License-Identifier: Apache-2.0
// Lazy firebase-admin initialization and deployment resolution (SPEC §9).

/**
 * Importing this module performs NO credential or network work. Admin is
 * initialized only when getDb() or getBucket() is first called, so every
 * `--dry-run` path runs without credentials — which is the property that makes
 * "run the dry run first" advice that people can actually follow, and the one
 * the verification table checks.
 */

import admin from "firebase-admin";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root: scripts/lib/firebase.mjs -> ../../ */
export const REPO_ROOT = join(__dirname, "..", "..");

let _app = null;
let _projectId = null;
let _deploy = undefined;

/** The gitignored deployment file, or {} when there is none. */
function deployConfig() {
  if (_deploy !== undefined) return _deploy;
  const path = join(REPO_ROOT, "config", "deploy.json");
  if (!existsSync(path)) {
    _deploy = {};
    return _deploy;
  }
  try {
    _deploy = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    _deploy = {};
  }
  return _deploy;
}

/**
 * Resolve the project id: explicit flag, then GCLOUD_PROJECT, then .firebaserc.
 * Needs no credentials.
 */
export function getProjectId(override) {
  if (override) {
    _projectId = override;
    return _projectId;
  }
  if (_projectId) return _projectId;
  if (process.env.GCLOUD_PROJECT) {
    _projectId = process.env.GCLOUD_PROJECT;
    return _projectId;
  }
  const rc = join(REPO_ROOT, ".firebaserc");
  if (existsSync(rc)) {
    try {
      const def = JSON.parse(readFileSync(rc, "utf8"))?.projects?.default;
      if (def) {
        _projectId = def;
        return _projectId;
      }
    } catch {
      /* fall through to the error below */
    }
  }
  throw new Error(
    "cannot resolve the project id: pass --project, set GCLOUD_PROJECT, or copy " +
      ".firebaserc.example to .firebaserc and fill it in",
  );
}

/**
 * Resolve the content bucket. NEVER guesses the Firebase default bucket.
 *
 * Its name changed: `${projectId}.appspot.com` is wrong for projects created
 * after 2024 and `.firebasestorage.app` is wrong for those created before.
 * Either guess means uploads land where nothing reads and deletes remove
 * nothing while reporting success — the worst class of silent failure an
 * operator tool can have. Resolution order is explicit flag, environment,
 * config/deploy.json, then a derived `${projectId}-content` that setup.mjs
 * actually creates. Using the Firebase default bucket is supported by naming it
 * explicitly, which is the point.
 */
export function getBucketName(projectOverride, bucketOverride) {
  if (bucketOverride) return bucketOverride;
  if (process.env.BIKESHED_BUCKET) return process.env.BIKESHED_BUCKET;
  const configured = deployConfig().bucket;
  if (configured) return configured;
  return `${getProjectId(projectOverride)}-content`;
}

/** Explicit RTDB target for operators; unlike bucket names, it is never derived. */
function getDatabaseUrl(projectOverride) {
  if (process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    if (!getProjectId(projectOverride).startsWith("demo-")) {
      throw new Error("Realtime Database emulator use requires a demo- project");
    }
    // Admin's database service requires a URL even when an emulator host is
    // set. Pin this invocation's demo namespace; never inherit a deployment.
    return `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/?ns=${encodeURIComponent(getProjectId(projectOverride))}`;
  }
  const value = process.env.BIKESHED_DATABASE_URL ?? deployConfig().databaseURL;
  if (value === undefined || value === "") return undefined;
  let parsed;
  try { parsed = typeof value === "string" ? new URL(value) : null; } catch { /* rejected below */ }
  if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password ||
    parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("databaseURL must be an HTTPS database URL without credentials, path, query or fragment");
  }
  return parsed.origin;
}

function getApp(projectOverride, bucketOverride) {
  if (_app) return _app;
  _app = admin.initializeApp({
    projectId: getProjectId(projectOverride),
    storageBucket: getBucketName(projectOverride, bucketOverride),
    databaseURL: getDatabaseUrl(projectOverride),
  });
  return _app;
}

/** Firestore handle. Initializes admin on first call. */
export function getDb(projectOverride) {
  return admin.firestore(getApp(projectOverride));
}

/** Storage bucket handle. Initializes admin on first call. */
export function getBucket(projectOverride, bucketOverride) {
  return admin
    .storage(getApp(projectOverride, bucketOverride))
    .bucket(getBucketName(projectOverride, bucketOverride));
}

/** Realtime Database handle, or null when the deployment has none. */
export function getRtdb(projectOverride) {
  const app = getApp(projectOverride);
  try {
    return admin.database(app);
  } catch {
    return null;
  }
}

export const FieldValue = admin.firestore.FieldValue;
