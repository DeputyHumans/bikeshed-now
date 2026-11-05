// SPDX-License-Identifier: Apache-2.0
// Dedicated public-media provisioning and immutable byte publication (SPEC §9).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeOrigin } from "../../tools/stamp-deployment.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MEDIA_FILES = Object.freeze([
  { name: "bikeshed-explainer.mp4", contentType: "video/mp4" },
  { name: "bikeshed-explainer.vtt", contentType: "text/vtt; charset=utf-8" },
  { name: "poster.webp", contentType: "image/webp" },
]);
export const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The ignored deployment file; a malformed configured file is never ignored. */
export function readMediaConfig(root = ROOT) {
  const path = join(root, "config", "deploy.json");
  if (!existsSync(path)) return {};
  let config;
  try { config = JSON.parse(readFileSync(path, "utf8")); } catch {
    throw new Error("config/deploy.json is not valid JSON");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config/deploy.json must hold an object");
  }
  return config;
}

function bucketName(value) {
  // A deliberately narrow subset of GCS names: simple names need no domain
  // verification and cannot be mistaken for Firebase's default bucket.
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value) ||
      value.startsWith("goog")) {
    throw new Error("media bucket must use 3–63 lowercase letters, digits or hyphens");
  }
  return value;
}

function revisionName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) {
    throw new Error("media revision must use 1–80 letters, digits, hyphens or underscores");
  }
  return value;
}

export function resolveMediaBucket({ override, env = process.env, config = readMediaConfig() } = {}) {
  const value = override ?? env.BIKESHED_MEDIA_BUCKET ?? config.mediaBucket ?? "";
  if (value === "") return "";
  return bucketName(value);
}

export function resolveMediaOrigin({ override, env = process.env, config = readMediaConfig() } = {}) {
  return normalizeOrigin(override ?? env.BIKESHED_PUBLIC_ORIGIN ?? config.domain);
}

/** Only this URL shape is public app configuration, never the deployment file. */
export function parseMediaBaseUrl(value) {
  const invalid = () => { throw new Error("landing media URL must name a direct GCS landing revision"); };
  if (typeof value !== "string" || value.includes("\\") || value.includes("%")) return invalid();
  const match = /^https:\/\/storage\.googleapis\.com\/([^/]+)\/landing\/([^/]+)$/.exec(value);
  if (!match) return invalid();
  try {
    const bucket = bucketName(match[1]);
    const revision = revisionName(match[2]);
    return { bucket, prefix: `landing/${revision}` };
  } catch { return invalid(); }
}

export function mediaBaseUrl(bucket, revision) {
  return `https://storage.googleapis.com/${bucketName(bucket)}/landing/${revisionName(revision)}`;
}

export function assertDedicatedMediaBucket({ project, contentBucket, mediaBucket }) {
  if (mediaBucket === contentBucket || mediaBucket === `${project}-content` ||
      /\.(?:appspot\.com|firebasestorage\.app)$/.test(mediaBucket)) {
    throw new Error("public media must use a dedicated bucket, never a content or Firebase default bucket");
  }
  bucketName(mediaBucket);
}

/**
 * Hosting serves the same site on the project's two default hosts, whatever the
 * custom domain, so a visitor can arrive on either. A bucket's CORS matches exact
 * origins, and the player fails outright on any origin it does not name.
 */
export function mediaCors(origin, project) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) throw new Error("media setup needs --origin or the deployment domain for CORS");
  return [{
    origin: [...new Set([normalized, `https://${project}.web.app`, `https://${project}.firebaseapp.com`])],
    method: ["GET", "HEAD"],
    responseHeader: ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control", "ETag", "Range"],
    maxAgeSeconds: 3600,
  }];
}

function quote(value) {
  return /^[A-Za-z0-9_./:=@,+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function httpFailure(result, code) {
  // A command failing is not evidence that a globally named bucket is absent.
  // Only an explicit HTTP status can allow creation or a generation-race retry.
  return new RegExp(`(?:HTTPError\\s+|HTTP\\s+|status(?:\\s+code)?[ :=]+|not found:\\s*)${code}\\b`, "i")
    .test(result.stderr ?? "");
}

function runner({ project, account, dryRun = false }, { run = spawnSync, log = console.log } = {}) {
  if (!project) throw new Error("media operation needs a project");
  if (!dryRun && !account?.trim()) throw new Error("--account is required for a real media operation");
  const flags = [`--project=${project}`, ...(account ? [`--account=${account}`] : []), "--quiet", "--verbosity=error"];
  function command(args, { missing = false, generationRace = false } = {}) {
    const argv = [...args, ...flags];
    log(`  $ gcloud ${argv.map(quote).join(" ")}`);
    if (dryRun) return { status: 0, stdout: "", dryRun: true };
    const result = run("gcloud", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.error) {
      throw new Error(result.error.code === "ENOENT" ? "required tool not found: gcloud" : "could not run gcloud");
    }
    if (result.status !== 0) {
      if (missing && httpFailure(result, 404)) return null;
      if (generationRace && httpFailure(result, 412)) return { race: true };
      const detail = (result.stderr ?? "").split("\n").find((line) => line.includes("ERROR"));
      throw new Error(`gcloud ${args.slice(0, 3).join(" ")} failed${detail ? `: ${detail}` : ""}`);
    }
    return result;
  }
  function json(args, options) {
    const result = command([...args, "--format=json"], options);
    if (result === null || result.dryRun) return null;
    try { return JSON.parse(result.stdout); } catch { throw new Error("gcloud returned invalid JSON metadata"); }
  }
  return { command, json, log, dryRun };
}

function projectNumber(cloud, project) {
  const result = cloud.command(["projects", "describe", project, "--format=value(projectNumber)"]);
  if (cloud.dryRun) return "PROJECT_NUMBER";
  const number = result.stdout.trim();
  if (!/^\d+$/.test(number)) throw new Error("could not resolve the selected project's number");
  return number;
}

function verifyOwnership(metadata, number) {
  if (String(metadata?.projectNumber) !== number) {
    throw new Error("media bucket does not belong to the selected project; refusing to change it");
  }
}

function publicBinding(policy) {
  return policy?.bindings?.some((binding) => binding.role === "roles/storage.objectViewer" &&
    !binding.condition && binding.members?.includes("allUsers"));
}

function describeBucket(cloud, url, missing = false) {
  return cloud.json(["storage", "buckets", "describe", url, "--raw"], { missing });
}

function corsMatches(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== 1) return false;
  const [a] = actual, [e] = expected;
  const sameSet = (x, y) => Array.isArray(x) && [...x].sort().join("\n") === [...y].sort().join("\n");
  return sameSet(a.origin, e.origin) && sameSet(a.method, e.method) &&
    sameSet(a.responseHeader, e.responseHeader) && a.maxAgeSeconds === e.maxAgeSeconds;
}

/** Used by both setup.mjs and the narrow media-only operator command. */
export function ensureMediaBucket(options, dependencies) {
  const { project, contentBucket, mediaBucket, origin, location = "us-central1" } = options;
  if (!mediaBucket) return { skipped: true };
  assertDedicatedMediaBucket({ project, contentBucket, mediaBucket });
  const cors = mediaCors(origin, project);
  const cloud = runner(options, dependencies);
  const number = projectNumber(cloud, project);
  const url = `gs://${mediaBucket}`;
  let metadata = describeBucket(cloud, url, true);
  if (cloud.dryRun) cloud.log("  # if absent, create; otherwise verify project ownership before changing anything:");
  if (!metadata) {
    cloud.command(["storage", "buckets", "create", url, `--location=${location}`, "--default-storage-class=STANDARD",
      "--uniform-bucket-level-access", "--no-public-access-prevention"]);
    if (!cloud.dryRun) metadata = describeBucket(cloud, url);
  }
  if (!cloud.dryRun) verifyOwnership(metadata, number);

  const policy = cloud.json(["storage", "buckets", "get-iam-policy", url]);
  const needsUpdate = cloud.dryRun || !metadata?.iamConfiguration?.uniformBucketLevelAccess?.enabled ||
    metadata?.iamConfiguration?.publicAccessPrevention === "enforced" || !corsMatches(metadata?.cors, cors);
  if (needsUpdate) {
    let temp;
    try {
      const corsPath = cloud.dryRun ? "<media-cors.json>" : join(temp = mkdtempSync(join(tmpdir(), "bikeshed-media-cors-")), "cors.json");
      if (cloud.dryRun) cloud.log(`  # CORS file: ${JSON.stringify(cors)}`);
      else writeFileSync(corsPath, JSON.stringify(cors));
      cloud.command(["storage", "buckets", "update", url, "--uniform-bucket-level-access",
        "--no-public-access-prevention", `--cors-file=${corsPath}`]);
    } finally { if (temp) rmSync(temp, { recursive: true, force: true }); }
  }
  if (cloud.dryRun || !publicBinding(policy)) {
    cloud.command(["storage", "buckets", "add-iam-policy-binding", url,
      "--member=allUsers", "--role=roles/storage.objectViewer", "--condition=None"]);
  }
  if (!cloud.dryRun) {
    metadata = describeBucket(cloud, url);
    verifyOwnership(metadata, number);
    if (!metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled ||
        metadata.iamConfiguration?.publicAccessPrevention === "enforced" || !corsMatches(metadata.cors, cors) ||
        !publicBinding(cloud.json(["storage", "buckets", "get-iam-policy", url]))) {
      throw new Error("media bucket did not converge to public read, uniform access and CORS; inspect its policies");
    }
  }
  cloud.log(cloud.dryRun ? "  media setup dry-run complete; no commands executed." :
    "  media bucket configured; organization policies were not changed.");
  return { skipped: false };
}

function readAssets(directory) {
  if (!directory) throw new Error("media publish needs --directory with the three reviewed assets");
  return MEDIA_FILES.map((asset) => {
    const path = resolve(directory, asset.name);
    let bytes;
    try {
      if (!lstatSync(path).isFile()) throw new Error("not a regular file");
      bytes = readFileSync(path);
    } catch { throw new Error(`media input is missing or not a regular file: ${asset.name}`); }
    if (!bytes.length) throw new Error(`media input is empty: ${asset.name}`);
    return { ...asset, path, size: bytes.length,
      md5: createHash("md5").update(bytes).digest("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

function sameObject(metadata, asset) {
  return metadata && String(metadata.size) === String(asset.size) && metadata.md5Hash === asset.md5 &&
    metadata.contentType === asset.contentType && metadata.cacheControl === MEDIA_CACHE_CONTROL &&
    metadata.contentDisposition === "inline" && !metadata.contentEncoding &&
    metadata.metadata?.sha256 === asset.sha256;
}

/** Publish exact input bytes; an occupied revision is never overwritten. */
export function publishMedia(options, dependencies) {
  const { project, contentBucket, mediaBucket, directory, revision } = options;
  assertDedicatedMediaBucket({ project, contentBucket, mediaBucket });
  const base = mediaBaseUrl(mediaBucket, revision);
  const assets = readAssets(directory);
  const cloud = runner(options, dependencies);
  const number = projectNumber(cloud, project);
  const bucketUrl = `gs://${mediaBucket}`;
  const bucket = describeBucket(cloud, bucketUrl);
  if (!cloud.dryRun) {
    verifyOwnership(bucket, number);
    if (!bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled ||
        bucket.iamConfiguration?.publicAccessPrevention === "enforced" ||
        !publicBinding(cloud.json(["storage", "buckets", "get-iam-policy", bucketUrl]))) {
      throw new Error("media bucket is not configured for public reads; run media setup first");
    }
  }

  // Inspect the entire release before any upload, so a known conflict cannot
  // leave even an otherwise new asset from the proposed release behind.
  for (const asset of assets) {
    asset.url = `${bucketUrl}/landing/${revision}/${asset.name}`;
    asset.existing = cloud.json(["storage", "objects", "describe", asset.url, "--raw"], { missing: true });
    if (asset.existing && !sameObject(asset.existing, asset)) {
      throw new Error(`media revision already contains different bytes or metadata: ${asset.name}; choose a new revision`);
    }
  }
  for (const asset of assets) {
    if (asset.existing) { cloud.log(`  ${asset.name}: identical bytes and metadata, skipping.`); continue; }
    if (cloud.dryRun) cloud.log(`  # only if absent; size=${asset.size} sha256=${asset.sha256}`);
    const result = cloud.command(["storage", "cp", asset.path, asset.url,
      "--if-generation-match=0", `--content-md5=${asset.md5}`, `--content-type=${asset.contentType}`,
      `--cache-control=${MEDIA_CACHE_CONTROL}`, "--content-disposition=inline", `--custom-metadata=sha256=${asset.sha256}`],
    { generationRace: true });
    if (!cloud.dryRun) {
      const uploaded = cloud.json(["storage", "objects", "describe", asset.url, "--raw"]);
      if (!sameObject(uploaded, asset)) {
        throw new Error(`${asset.name}: ${result.race ? "another writer occupied the revision" : "uploaded object did not match"}; nothing was overwritten`);
      }
    }
  }
  cloud.log(`${cloud.dryRun ? "  # after successful publication: " : ""}VITE_LANDING_MEDIA_BASE_URL=${base}`);
  return { baseUrl: base, assets: assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })) };
}
