#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Operator setup and immutable publication of landing-page media (SPEC §9).

import { parse, fail } from "./lib/args.mjs";
import { getBucketName, getProjectId } from "./lib/firebase.mjs";
import { ensureMediaBucket, publishMedia, readMediaConfig, resolveMediaBucket, resolveMediaOrigin } from "./lib/media.mjs";

const USAGE = `media.mjs — dedicated public media, separate from private documents

  node scripts/media.mjs setup --account <email> [options]
  node scripts/media.mjs publish --directory <path> --revision <id> --account <email> [options]

  --account <email>     required for real runs; never uses the active identity
  --project <id>        project id (default: GCLOUD_PROJECT, then .firebaserc)
  --bucket <name>       private content bucket, for the isolation check
  --media-bucket <name> public bucket (then BIKESHED_MEDIA_BUCKET, config/deploy.json)
  --origin <origin>     setup CORS origin (then BIKESHED_PUBLIC_ORIGIN, deployment domain)
  --location <region>   setup location for a new bucket (default: us-central1)
  --directory <path>    publish exactly bikeshed-explainer.mp4, bikeshed-explainer.vtt,
                       and poster.webp from this directory without changing their bytes
  --revision <id>       immutable landing/<id>/ prefix; letters, digits, hyphens, underscores
  --dry-run             print intended commands, execute none, need no credentials
  --help

Setup changes only the named dedicated public bucket, never organization policy.
Publish refuses an occupied revision unless all bytes and metadata already match.
It prints the app environment setting; it does not edit files or deploy the app.`;

try {
  const { values, positionals } = parse({
    account: { type: "string" }, project: { type: "string" }, bucket: { type: "string" },
    "media-bucket": { type: "string" }, origin: { type: "string" },
    location: { type: "string", default: "us-central1" }, directory: { type: "string" },
    revision: { type: "string" }, "dry-run": { type: "boolean", default: false },
  }, { usage: USAGE });
  if (positionals.length !== 1 || !["setup", "publish"].includes(positionals[0])) {
    fail(`choose exactly one command: setup or publish\n\n${USAGE}`);
  }
  const [command] = positionals;
  if (command === "setup" && (values.directory || values.revision)) {
    fail("--directory and --revision belong to publish, not setup");
  }
  const config = readMediaConfig();
  const mediaBucket = resolveMediaBucket({ override: values["media-bucket"], config });
  if (!mediaBucket) fail("configure mediaBucket or pass --media-bucket before running the media command");
  const options = {
    project: getProjectId(values.project), contentBucket: getBucketName(values.project, values.bucket),
    mediaBucket, account: values.account, dryRun: values["dry-run"], location: values.location,
  };
  console.log(`media ${command}: project=${options.project} account=${options.account ?? "(unset)"}`);
  if (options.dryRun) console.log("  --dry-run: printing intended commands only.");
  if (command === "setup") {
    ensureMediaBucket({ ...options, origin: resolveMediaOrigin({ override: values.origin, config }) });
  } else {
    publishMedia({ ...options, directory: values.directory, revision: values.revision });
  }
} catch (error) { fail(error.message || String(error)); }
