// SPDX-License-Identifier: Apache-2.0
// Public-media isolation, credential-free plans, and immutable publication (SPEC §9).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_FILES, MEDIA_CACHE_CONTROL, assertDedicatedMediaBucket, ensureMediaBucket,
  mediaBaseUrl, mediaCors, parseMediaBaseUrl, publishMedia, readMediaConfig,
  resolveMediaBucket, resolveMediaOrigin,
} from "../scripts/lib/media.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const options = {
  project: "demo-bikeshed", contentBucket: "demo-bikeshed-content", mediaBucket: "demo-bikeshed-media",
  account: "operator@example.com", origin: "https://example.com", revision: "v1",
};
const quiet = () => {};
const ok = (value = "") => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const failure = (code) => ({ status: 1, stdout: "", stderr: `ERROR: (gcloud.storage) HTTPError ${code}: refused` });
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "bikeshed-media-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const { name } of MEDIA_FILES) writeFileSync(join(directory, name), `reviewed input: ${name}\n`);
  return directory;
}

function configuredBucket() {
  return {
    projectNumber: "123456", cors: mediaCors(options.origin),
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "inherited" },
  };
}

/** Stateful fake: reruns see the effects of earlier operations in this case. */
function cloudModel({ absent = false } = {}) {
  const state = {
    bucket: absent ? null : configuredBucket(),
    policy: { bindings: absent ? [] : [{ role: "roles/storage.objectViewer", members: ["allUsers"] }] },
    objects: new Map(), calls: [], uploads: [], override: null,
  };
  const run = (command, args) => {
    assert.equal(command, "gcloud");
    state.calls.push(args);
    const result = state.override?.(args, state);
    if (result) return result;
    const words = args.filter((arg) => !arg.startsWith("--"));
    const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (words[0] === "projects") return ok("123456\n");
    const [, resource, operation, target] = words;
    if (resource === "buckets") {
      if (operation === "describe") return state.bucket ? ok(state.bucket) : failure(404);
      if (operation === "create") { state.bucket = configuredBucket(); state.bucket.cors = []; return ok(); }
      if (operation === "update") {
        state.bucket.iamConfiguration.uniformBucketLevelAccess.enabled = true;
        state.bucket.iamConfiguration.publicAccessPrevention = "inherited";
        state.bucket.cors = JSON.parse(readFileSync(flag("cors-file"), "utf8"));
        return ok();
      }
      if (operation === "get-iam-policy") return ok(state.policy);
      if (operation === "add-iam-policy-binding") {
        state.policy.bindings.push({ role: flag("role"), members: [flag("member")] });
        return ok();
      }
    }
    if (resource === "objects" && operation === "describe") {
      return state.objects.has(target) ? ok(state.objects.get(target)) : failure(404);
    }
    if (resource === "cp") {
      const source = operation, destination = target;
      if (state.objects.has(destination) && flag("if-generation-match") === "0") return failure(412);
      const bytes = readFileSync(source);
      const md5Hash = createHash("md5").update(bytes).digest("base64");
      if (flag("content-md5") && flag("content-md5") !== md5Hash) return failure(400);
      state.objects.set(destination, {
        size: String(bytes.length), md5Hash, contentType: flag("content-type"),
        cacheControl: flag("cache-control"), contentDisposition: flag("content-disposition"),
        metadata: { sha256: flag("custom-metadata")?.slice("sha256=".length) },
      });
      state.uploads.push({ source, destination, bytes });
      return ok();
    }
    throw new Error(`unhandled fake cloud operation: ${args.join(" ")}`);
  };
  return { state, dependencies: { run, log: quiet } };
}

function mutations(state) {
  return state.calls.filter((args) => ["create", "update", "add-iam-policy-binding"].includes(args[2]) || args[1] === "cp");
}

test("media bucket is optional and resolves flag, environment, then ignored config", () => {
  const config = { mediaBucket: "demo-file-media" }, env = { BIKESHED_MEDIA_BUCKET: "demo-env-media" };
  assert.equal(resolveMediaBucket({ override: "demo-flag-media", env, config }), "demo-flag-media");
  assert.equal(resolveMediaBucket({ env, config }), "demo-env-media");
  assert.equal(resolveMediaBucket({ env: {}, config }), "demo-file-media");
  assert.equal(resolveMediaBucket({ env: {}, config: {} }), "");
  assert.equal(resolveMediaBucket({ override: "", env, config }), "");
  assert.equal(resolveMediaOrigin({ override: "https://flag.example", env: {}, config: { domain: "file.example" } }), "https://flag.example");
  assert.equal(resolveMediaOrigin({ env: { BIKESHED_PUBLIC_ORIGIN: "https://env.example" }, config: { domain: "file.example" } }), "https://env.example");
  assert.equal(resolveMediaOrigin({ env: {}, config: { domain: "file.example" } }), "https://file.example");
});

test("malformed configured media is rejected instead of silently disabling it", (t) => {
  const root = fixture(t);
  assert.deepEqual(readMediaConfig(root), {});
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "deploy.json"), "bad json");
  assert.throws(() => readMediaConfig(root), /not valid JSON/);
  writeFileSync(join(root, "config", "deploy.json"), "[]");
  assert.throws(() => readMediaConfig(root), /must hold an object/);
  for (const mediaBucket of ["UPPERCASE", "a", "x".repeat(64), "-demo-media", "demo-media-", "goog-media", 12, null]) {
    if (mediaBucket === null) continue;
    assert.throws(() => resolveMediaBucket({ env: {}, config: { mediaBucket } }), /media bucket/);
  }
});

test("public media URLs identify exactly one immutable landing revision", () => {
  const base = mediaBaseUrl(options.mediaBucket, "20261016_v1");
  assert.deepEqual(parseMediaBaseUrl(base), { bucket: options.mediaBucket, prefix: "landing/20261016_v1" });
  for (const bad of ["", `${base}/`, `${base}?x=1`, `${base}#x`, `${base}/file.mp4`, `${base}/../v2`,
    base.replace("https:", "http:"), base.replace("storage.googleapis.com", "evil.example"),
    base.replace("storage.googleapis.com", "user@storage.googleapis.com"),
    base.replace("storage.googleapis.com", "storage.googleapis.com:443"),
    base.replace("landing/", "landing%2f"), base.replace("landing/", "landing\\"),
    base.replace("landing/", "landing/../"), base.replace("20261016_v1", "."),
    base.replace(options.mediaBucket, "UPPERCASE")]) {
    assert.throws(() => parseMediaBaseUrl(bad), /^Error: landing media URL must name a direct GCS landing revision$/, bad);
  }
  for (const revision of ["", ".", "..", "v1/v2", "v1?x", "a".repeat(81)]) {
    assert.throws(() => mediaBaseUrl(options.mediaBucket, revision), /media revision/);
  }
});

test("content and both Firebase default bucket forms can never become public media", () => {
  for (const mediaBucket of [options.contentBucket, "demo-bikeshed.appspot.com", "demo-bikeshed.firebasestorage.app"]) {
    assert.throws(() => assertDedicatedMediaBucket({ ...options, mediaBucket }), /dedicated bucket/);
  }
  assert.throws(() => assertDedicatedMediaBucket({ ...options, contentBucket: "demo-custom-content", mediaBucket: "demo-custom-content" }), /dedicated bucket/);
});

test("unconfigured setup is a no-op; configured dry-runs execute no cloud or credential work", (t) => {
  const directory = fixture(t), lines = [];
  const dependencies = { run: () => assert.fail("dry-run executed a cloud command"), log: (line) => lines.push(line) };
  assert.deepEqual(ensureMediaBucket({ mediaBucket: "" }, dependencies), { skipped: true });
  ensureMediaBucket({ ...options, account: undefined, dryRun: true }, dependencies);
  const published = publishMedia({ ...options, directory, account: undefined, dryRun: true }, dependencies);
  assert.equal(published.assets.length, 3);
  assert.ok(lines.some((line) => line.includes("--if-generation-match=0")));
  assert.ok(lines.some((line) => line.includes("--content-md5=")));
  assert.ok(lines.some((line) => line.includes("--role=roles/storage.objectViewer")));
  assert.ok(lines.some((line) => line.includes("--cors-file=")));
});

test("real setup and publication refuse an implicit account before any cloud operation", (t) => {
  const dependencies = { run: () => assert.fail("account refusal happened after a cloud call"), log: quiet };
  assert.throws(() => ensureMediaBucket({ ...options, account: undefined }, dependencies), /--account is required/);
  assert.throws(() => publishMedia({ ...options, directory: fixture(t), account: " " }, dependencies), /--account is required/);
});

test("setup creates only the dedicated bucket, converges CORS and IAM, then reruns without writes", () => {
  const model = cloudModel({ absent: true });
  ensureMediaBucket(options, model.dependencies);
  assert.equal(model.state.bucket.iamConfiguration.uniformBucketLevelAccess.enabled, true);
  assert.equal(model.state.bucket.iamConfiguration.publicAccessPrevention, "inherited");
  assert.deepEqual(model.state.bucket.cors, [{
    origin: ["https://example.com"], method: ["GET", "HEAD"],
    responseHeader: ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control", "ETag", "Range"], maxAgeSeconds: 3600,
  }]);
  const writes = mutations(model.state);
  assert.deepEqual(writes.map((call) => call[2]), ["create", "update", "add-iam-policy-binding"]);
  assert.ok(writes[0].includes("--default-storage-class=STANDARD"));
  assert.ok(writes.every((call) => call[3] === `gs://${options.mediaBucket}`));
  const grant = writes.find((call) => call[2] === "add-iam-policy-binding");
  assert.ok(grant.includes("--member=allUsers"));
  assert.ok(grant.includes("--role=roles/storage.objectViewer"));
  assert.ok(grant.includes("--condition=None"));
  assert.ok(model.state.calls.every((call) => call.includes(`--project=${options.project}`) && call.includes(`--account=${options.account}`) && call.includes("--verbosity=error")));
  model.state.calls.length = 0;
  ensureMediaBucket(options, model.dependencies);
  assert.deepEqual(mutations(model.state), []);
});

test("setup repairs settings on an existing owned bucket without replacing unrelated IAM", () => {
  const model = cloudModel();
  model.state.bucket.iamConfiguration = { uniformBucketLevelAccess: { enabled: false }, publicAccessPrevention: "enforced" };
  model.state.bucket.cors = [{ origin: ["*"], method: ["PUT"] }];
  model.state.policy = { bindings: [{ role: "roles/storage.objectAdmin", members: ["user:operator@example.com"] }] };
  ensureMediaBucket(options, model.dependencies);
  assert.equal(model.state.policy.bindings.length, 2);
  assert.equal(model.state.policy.bindings[0].role, "roles/storage.objectAdmin");
  assert.ok(!mutations(model.state).some((call) => call[2] === "create"));
  assert.deepEqual(model.state.bucket.cors, mediaCors(options.origin));
});

test("bucket ownership mismatches and missing ownership stop before mutations", () => {
  for (const projectNumber of ["999999", undefined]) {
    const model = cloudModel();
    model.state.bucket.projectNumber = projectNumber;
    assert.throws(() => ensureMediaBucket(options, model.dependencies), /does not belong/);
    assert.deepEqual(mutations(model.state), []);
  }
});

test("only explicit 404 means absent; permission, network and empty failures never create", () => {
  for (const failed of [failure(403), failure(500), { status: 1, stdout: "", stderr: "" },
    { status: 1, stdout: "", stderr: "ERROR: DNS unavailable" }]) {
    const model = cloudModel();
    model.state.override = (args) => args[1] === "buckets" && args[2] === "describe" ? failed : null;
    assert.throws(() => ensureMediaBucket(options, model.dependencies), /failed/);
    assert.deepEqual(mutations(model.state), []);
  }
  const model = cloudModel({ absent: true });
  model.state.override = (args, state) => args[1] === "buckets" && args[2] === "describe" && !state.bucket ?
    { status: 1, stdout: "", stderr: "ERROR: (gcloud.storage.buckets.describe) resource not found: 404." } : null;
  ensureMediaBucket(options, model.dependencies);
  assert.ok(mutations(model.state).some((call) => call[2] === "create"));
});

test("an organization-policy refusal propagates without attempting any policy change", () => {
  const model = cloudModel();
  model.state.policy.bindings = [];
  model.state.override = (args) => args[2] === "add-iam-policy-binding" ? failure(412) : null;
  assert.throws(() => ensureMediaBucket(options, model.dependencies), /failed/);
  assert.ok(model.state.calls.every((call) => call[0] !== "org-policies" && call[0] !== "resource-manager"));
});

test("setup does not report success when settings did not converge", () => {
  const model = cloudModel();
  model.state.bucket.cors = [];
  model.state.override = (args) => args[2] === "update" ? ok() : null;
  assert.throws(() => ensureMediaBucket(options, model.dependencies), /did not converge/);
});

test("publish uploads exactly three reviewed files with checksums and metadata, then reruns without writes", (t) => {
  const directory = fixture(t), model = cloudModel();
  const originals = new Map(MEDIA_FILES.map(({ name }) => [name, readFileSync(join(directory, name))]));
  const result = publishMedia({ ...options, directory }, model.dependencies);
  assert.equal(result.baseUrl, mediaBaseUrl(options.mediaBucket, options.revision));
  assert.equal(model.state.uploads.length, 3);
  for (const uploaded of model.state.uploads) {
    assert.deepEqual(uploaded.bytes, originals.get(basename(uploaded.source)));
    assert.deepEqual(readFileSync(uploaded.source), originals.get(basename(uploaded.source)));
    assert.ok(uploaded.destination.startsWith(`gs://${options.mediaBucket}/landing/v1/`));
    const metadata = model.state.objects.get(uploaded.destination);
    assert.equal(metadata.cacheControl, MEDIA_CACHE_CONTROL);
    assert.equal(metadata.contentDisposition, "inline");
    assert.equal(metadata.metadata.sha256, createHash("sha256").update(uploaded.bytes).digest("hex"));
  }
  const uploads = mutations(model.state);
  assert.ok(uploads.every((call) => call[1] === "cp" && call.includes("--if-generation-match=0") && call.some((flag) => flag.startsWith("--content-md5="))));
  assert.ok(model.state.calls.every((call) => call.includes(`--project=${options.project}`) && call.includes(`--account=${options.account}`)));
  model.state.calls.length = 0;
  publishMedia({ ...options, directory }, model.dependencies);
  assert.deepEqual(mutations(model.state), []);
});

test("any pre-existing byte or metadata conflict is discovered before the first upload", (t) => {
  const directory = fixture(t), model = cloudModel();
  publishMedia({ ...options, directory }, model.dependencies);
  const posterUrl = `gs://${options.mediaBucket}/landing/v1/poster.webp`;
  const original = clone(model.state.objects.get(posterUrl));
  for (const change of [
    { size: "9999" }, { md5Hash: "unrelated" }, { contentType: "application/octet-stream" },
    { cacheControl: "private" }, { contentDisposition: "attachment" }, { contentEncoding: "gzip" },
    { metadata: { sha256: "unrelated" } },
  ]) {
    model.state.objects.clear();
    model.state.objects.set(posterUrl, { ...clone(original), ...change });
    model.state.calls.length = 0;
    assert.throws(() => publishMedia({ ...options, directory }, model.dependencies), /different bytes or metadata/);
    assert.deepEqual(mutations(model.state), []);
  }
});

test("publication refuses a private, foreign or missing bucket before uploading", (t) => {
  const directory = fixture(t);
  for (const change of [
    (state) => { state.bucket.projectNumber = "999999"; },
    (state) => { state.bucket.iamConfiguration.publicAccessPrevention = "enforced"; },
    (state) => { state.bucket.iamConfiguration.uniformBucketLevelAccess.enabled = false; },
    (state) => { state.policy.bindings = []; },
    (state) => { state.bucket = null; },
  ]) {
    const model = cloudModel(); change(model.state);
    assert.throws(() => publishMedia({ ...options, directory }, model.dependencies));
    assert.deepEqual(mutations(model.state), []);
  }
});

test("generation races accept only identical bytes and metadata and never overwrite", (t) => {
  const directory = fixture(t), populated = cloudModel();
  publishMedia({ ...options, directory }, populated.dependencies);
  for (const conflicting of [false, true]) {
    const model = cloudModel();
    let raced = false;
    model.state.override = (args, state) => {
      if (args[1] !== "cp" || raced) return null;
      raced = true;
      const existing = clone(populated.state.objects.get(args[3]));
      if (conflicting) existing.md5Hash = "a different writer's bytes";
      state.objects.set(args[3], existing);
      return failure(412);
    };
    if (conflicting) {
      assert.throws(() => publishMedia({ ...options, directory }, model.dependencies), /another writer occupied/);
      assert.equal(model.state.uploads.length, 0);
    } else {
      publishMedia({ ...options, directory }, model.dependencies);
      assert.equal(model.state.uploads.length, 2);
    }
    assert.ok(mutations(model.state).every((call) => call.includes("--if-generation-match=0")));
  }
});

test("successful upload commands still require matching GCS readback", (t) => {
  const directory = fixture(t), model = cloudModel();
  model.state.override = (args) => args[1] === "cp" ? ok() : null;
  assert.throws(() => publishMedia({ ...options, directory }, model.dependencies), /failed/);
});

test("a local input changed after hashing cannot bypass the server checksum", (t) => {
  const directory = fixture(t), model = cloudModel();
  let changed = false;
  model.state.override = (args) => {
    if (args[1] === "cp" && !changed) { changed = true; writeFileSync(args[2], "changed after local hashing"); }
    return null;
  };
  assert.throws(() => publishMedia({ ...options, directory }, model.dependencies), /failed/);
  assert.equal(model.state.uploads.length, 0);
});

test("missing, empty or non-file assets are refused before cloud work", (t) => {
  for (const fault of ["missing", "empty", "directory"]) {
    const directory = fixture(t), path = join(directory, "poster.webp");
    rmSync(path);
    if (fault === "empty") writeFileSync(path, "");
    if (fault === "directory") mkdirSync(path);
    const model = cloudModel();
    assert.throws(() => publishMedia({ ...options, directory }, model.dependencies), /media input/);
    assert.deepEqual(model.state.calls, []);
  }
});

test("media CLI rejects unknown commands and typoed flags, and dry-runs without gcloud on PATH", (t) => {
  const directory = fixture(t);
  const invoke = (...args) => spawnSync(process.execPath, [join(ROOT, "scripts", "media.mjs"), ...args], {
    cwd: ROOT, encoding: "utf8", env: { PATH: directory },
  });
  for (const args of [["wrong"], ["setup", "--dryrun"], ["setup", "publish"], ["setup", "--revision", "v1"]]) {
    const result = invoke(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /error:/);
    assert.doesNotMatch(result.stderr, /at file:/);
  }
  const common = ["--project", options.project, "--bucket", options.contentBucket, "--media-bucket", options.mediaBucket, "--dry-run"];
  const setup = invoke("setup", ...common, "--origin", options.origin);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /no commands executed/);
  const publish = invoke("publish", ...common, "--directory", directory, "--revision", "v1");
  assert.equal(publish.status, 0, publish.stderr);
  assert.match(publish.stdout, /VITE_LANDING_MEDIA_BASE_URL=/);
});
