#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Withdraw ONE version of a document, guarded (SPEC §9).

/**
 * Usage:
 *   delete-version.mjs --doc <id> --list
 *   delete-version.mjs --doc <id> --version <vN> [--repoint <vN>] --dry-run
 *   delete-version.mjs --doc <id> --version <vN> [--repoint <vN>] --yes --account <email> --project <id>
 *
 * The sole, guarded exception to "versions are immutable". The publish path
 * stays append-only: nothing else can overwrite or remove a version. This exists
 * so a corrupted version can be withdrawn through tooling rather than by
 * hand-editing Firestore and Storage.
 *
 * ORDER IS LOAD-BEARING. `currentVersion` is repointed FIRST, in a transaction
 * that aborts if anything published mid-run, because the viewer resolves a bare
 * /d/{docId} from that field — deleting first strands every reader on a version
 * that no longer exists. The same transaction clears a `thumb` record naming
 * the version. Then the Storage bytes (the version record's storagePrefix is
 * the only pointer to them) and the thumbnails captured from them, then the
 * Firestore record.
 *
 * NOTE: unlike every other script here, `--dry-run` READS Firestore and Storage
 * and therefore needs credentials. A destructive preview that cannot show you
 * what it would destroy is worthless. It performs no writes.
 */

import { parse, fail } from "./lib/args.mjs";
import {
  FieldValue,
  getBucket,
  getBucketName,
  getDb,
  getProjectId,
} from "./lib/firebase.mjs";

const VERSION_RE = /^v(\d+)$/;

function versionNum(id) {
  const m = VERSION_RE.exec(id);
  return m ? Number(m[1]) : null;
}

/** Count documents in a collection without downloading them. */
async function countOf(ref) {
  return (await ref.count().get()).data().count;
}

const USAGE = `delete-version.mjs — withdraw ONE version of a document, guarded

  node scripts/delete-version.mjs --doc <id> --list
  node scripts/delete-version.mjs --doc <id> --version <vN> [--repoint <vN>] --dry-run
  node scripts/delete-version.mjs --doc <id> --version <vN> --yes --account <email>

  --doc <id>             required
  --version <vN>         the version to withdraw
  --repoint <vN>         where currentVersion should point afterwards
  --list                 print the document's versions and exit
  --yes                  required for a real run
  --account <email>      console identity, required for a real run
  --project <id>         Firebase project id (default: .firebaserc)
  --bucket <name>        content bucket (default: config/deploy.json)
  --dry-run              preview; performs no writes
  --help

  Refusal overrides, each corresponding to one of the seven refusals. Every one
  of them removes a guard, so pass them one at a time and read what it says:
  --allow-non-current    withdraw a version that is not currentVersion
  --allow-annotations    withdraw a version that carries annotations
  --drop-draft           discard a draft based on this version
  --keep-stats           leave aggregate stats untouched
  --keep-views           leave view sessions untouched

ORDER IS LOAD-BEARING: currentVersion is repointed first, in a transaction that
aborts if anything published mid-run, then the Storage bytes, then the record.

Unlike every other script here, --dry-run READS Firestore and Storage and so
needs credentials. A destructive preview that cannot show you what it would
destroy is worthless.`;

async function main() {
  const { values } = parse({
    doc: { type: "string" },
    version: { type: "string" },
    repoint: { type: "string" },
    list: { type: "boolean", default: false },
    account: { type: "string" },
    project: { type: "string" },
    bucket: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    "allow-non-current": { type: "boolean", default: false },
    "allow-annotations": { type: "boolean", default: false },
    "drop-draft": { type: "boolean", default: false },
    "keep-stats": { type: "boolean", default: false },
    "keep-views": { type: "boolean", default: false },
  }, { usage: USAGE });

  const docId = values.doc;
  const dry = values["dry-run"];
  const listOnly = values.list;
  if (!docId) fail("`--doc <docId>` is required");
  if (!listOnly && !values.version) {
    fail("`--version <vN>` is required (or use --list)");
  }

  const projectId = getProjectId(values.project);

  // Preflight: the two ways this script could silently do nothing.
  if (!process.env.BIKESHED_BUCKET && !values.bucket) {
    const derived = getBucketName(values.project, values.bucket);
    console.warn(
      `  note: no --bucket or BIKESHED_BUCKET; using the derived name gs://${derived}.\n` +
        "  If that is not where this deployment's content lives, the Storage delete\n" +
        "  will remove nothing and report success. Pass --bucket explicitly to be sure.",
    );
  }
  const bucketName = getBucketName(values.project, values.bucket);

  if (!listOnly && !dry) {
    if (!values.yes) fail("refusing to delete without --yes (use --dry-run to preview)");
    if (!values.account) {
      fail(
        "`--account <email>` is required for real runs (credentials are never " +
          "assumed); pass it explicitly or use --dry-run",
      );
    }
    if (!values.project) fail("`--project <id>` is required for real runs");
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      fail(
        "GOOGLE_APPLICATION_CREDENTIALS is not set. The Admin SDK would fall back " +
          "to ambient credentials, which may not be the identity named in --account.",
      );
    }
  }

  const db = getDb(values.project);
  const bucket = getBucket(values.project, values.bucket);
  const docRef = db.collection("docs").doc(docId);
  const versionsRef = docRef.collection("versions");

  const snap = await docRef.get();
  if (!snap.exists) fail(`document not found: ${docId}`);
  const meta = snap.data();

  const versSnap = await versionsRef.get();
  const versions = versSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (versionNum(a.id) ?? 0) - (versionNum(b.id) ?? 0));

  console.log(`document: ${docId}`);
  console.log(`project:  ${projectId}   bucket: gs://${bucketName}`);
  console.log(`current:  ${meta.currentVersion}`);
  console.log(
    `draft:    ${meta.draft ? `base=${meta.draft.baseVersion} entry=${meta.draft.entry} by=${meta.draft.updatedByEmail}` : "(none)"}`,
  );
  console.log("versions:");
  for (const v of versions) {
    const anns = await countOf(versionsRef.doc(v.id).collection("annotations"));
    const marker = v.id === meta.currentVersion ? "  <- current" : "";
    console.log(
      `  ${v.id.padEnd(5)} entry=${v.entry} files=${v.fileCount} bytes=${v.bytes} annotations=${anns}${marker}`,
    );
  }

  if (listOnly) return;

  const doomed = values.version;
  const target = versions.find((v) => v.id === doomed);

  // Every refusal, evaluated before any write.
  if (!target) fail(`version not found: ${doomed}`);
  if (versions.length < 2) fail(`refusing: ${doomed} is the only version of ${docId}`);

  const isCurrent = meta.currentVersion === doomed;
  if (!isCurrent && !values["allow-non-current"]) {
    fail(
      `refusing: ${doomed} is not the current version (${meta.currentVersion}). ` +
        "Pass --allow-non-current if you really mean to remove a superseded version.",
    );
  }

  const highest = versions[versions.length - 1];
  if (isCurrent && highest.id !== doomed) {
    fail(
      `refusing: ${doomed} is currentVersion but ${highest.id} exists and is higher — ` +
        "the database is inconsistent. Investigate before deleting anything.",
    );
  }

  if (meta.draft && !values["drop-draft"]) {
    fail(
      `refusing: a draft exists (base=${meta.draft.baseVersion}, by ${meta.draft.updatedByEmail}). ` +
        "Repointing currentVersion would silently revive or strand it. " +
        "Pass --drop-draft to discard it as part of this operation.",
    );
  }

  const repoint = values.repoint ?? versions.filter((v) => v.id !== doomed).pop().id;
  if (!versions.some((v) => v.id === repoint)) fail(`--repoint target not found: ${repoint}`);
  if (repoint === doomed) fail("--repoint target cannot be the version being deleted");

  const annCount = await countOf(versionsRef.doc(doomed).collection("annotations"));
  let commentCount = 0;
  if (annCount > 0) {
    const annSnap = await versionsRef.doc(doomed).collection("annotations").get();
    for (const a of annSnap.docs) commentCount += await countOf(a.ref.collection("comments"));
    if (!values["allow-annotations"]) {
      fail(
        `refusing: ${doomed} carries ${annCount} annotation(s) and ${commentCount} comment(s), ` +
          "which would be destroyed permanently. Export them first, then pass --allow-annotations.",
      );
    }
  }

  const prefix = `docs/${docId}/${doomed}/`;
  const [objects] = await bucket.getFiles({ prefix });
  const files = objects.filter((o) => !o.name.endsWith("/"));
  const totalBytes = files.reduce((n, o) => n + Number(o.metadata.size ?? 0), 0);
  if (target.fileCount != null && files.length !== target.fileCount) {
    console.warn(
      `  warning: Storage lists ${files.length} object(s) under ${prefix} but ` +
        `versions/${doomed}.fileCount is ${target.fileCount}. Check the bucket first.`,
    );
  }

  // Thumbnails captured from this version live beside it, not under it, so
  // the prefix above does not reach them. They are its content all the same.
  const thumbsPrefix = `docs/${docId}/thumbs/${doomed}/`;
  const [thumbObjects] = await bucket.getFiles({ prefix: thumbsPrefix });
  const thumbFiles = thumbObjects.filter((o) => !o.name.endsWith("/"));
  const clearsThumb = meta.thumb?.versionId === doomed;

  const viewsQuery = docRef.collection("views").where("versionId", "==", doomed);
  const viewCount = values["keep-views"] ? 0 : await countOf(viewsQuery);

  const commits = Number(meta.stats?.commits ?? 0);
  const nextCommits = Math.max(0, commits - 1);

  console.log("");
  console.log(`plan for ${docId}:`);
  console.log(`  repoint currentVersion: ${meta.currentVersion} -> ${repoint}`);
  if (meta.draft) {
    console.log(`  discard the draft (base=${meta.draft.baseVersion}) and its objects`);
  }
  console.log(
    `  delete Storage: gs://${bucketName}/${prefix} (${files.length} object(s), ${totalBytes} bytes)`,
  );
  for (const o of files) console.log(`      - gs://${bucketName}/${o.name}`);
  console.log(
    `  delete Storage: gs://${bucketName}/${thumbsPrefix} (${thumbFiles.length} thumbnail(s))`,
  );
  if (clearsThumb) console.log(`  clear thumb: it names ${doomed}`);
  console.log(
    `  delete Firestore: docs/${docId}/versions/${doomed} (+${annCount} annotation(s), ${commentCount} comment(s))`,
  );
  if (!values["keep-stats"]) {
    console.log(
      `  stats.commits: ${commits} -> ${nextCommits}${nextCommits === 0 ? " (and clear lastEditedAt/lastEditedByEmail)" : ""}`,
    );
  }
  if (!values["keep-views"]) {
    console.log(`  retag ${viewCount} view session(s): versionId "${doomed}" -> "${doomed}-deleted"`);
  }
  console.log(
    `  NOTE: version ids mint as max(N)+1 over EXISTING versions, so the next commit re-mints "${doomed}".`,
  );

  if (dry) {
    console.log("\n  --dry-run: nothing was written.");
    return;
  }

  console.log("");
  console.log(`  repointing currentVersion -> ${repoint} ...`);
  let removedDraftPrefix = null;
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(docRef);
    if (!fresh.exists) throw new Error("the document disappeared mid-run");
    const cur = fresh.data().currentVersion;
    if (cur !== meta.currentVersion) {
      throw new Error(
        `currentVersion changed mid-run (${meta.currentVersion} -> ${cur}); ` +
          "aborted without deleting anything",
      );
    }
    const update = {
      currentVersion: repoint,
      // A withdrawal is not a publish, so updatedAt goes BACK to the repoint
      // target's publish time rather than forward to now.
      updatedAt: versions.find((v) => v.id === repoint).publishedAt,
    };
    const removedDraft = fresh.data().draft;
    if (removedDraft) {
      if (!values["drop-draft"]) throw new Error("A draft appeared mid-run; refused without --drop-draft.");
      const prefix = removedDraft.storagePrefix ?? `docs/${docId}/draft`;
      if (typeof prefix !== "string" || !(prefix === `docs/${docId}/draft` ||
          prefix.startsWith(`docs/${docId}/drafts/`) && /^[a-zA-Z0-9-]+$/.test(prefix.slice(`docs/${docId}/drafts/`.length)))) {
        throw new Error("Invalid draft storage prefix");
      }
      removedDraftPrefix = `${prefix}/`;
      update.draft = FieldValue.delete();
    }
    // Read fresh: a capture can land between the plan and this transaction.
    if (fresh.data().thumb?.versionId === doomed) update.thumb = FieldValue.delete();
    if (!values["keep-stats"]) {
      update["stats.commits"] = nextCommits;
      if (nextCommits === 0) {
        update["stats.lastEditedAt"] = FieldValue.delete();
        update["stats.lastEditedByEmail"] = FieldValue.delete();
      }
    }
    tx.update(docRef, update);
  });
  console.log("    done.");

  if (removedDraftPrefix) {
    console.log("  deleting draft objects ...");
    await bucket.deleteFiles({ prefix: removedDraftPrefix, force: true });
    console.log("    done.");
  }
  console.log(`  deleting gs://${bucketName}/${prefix} ...`);
  await bucket.deleteFiles({ prefix, force: true });
  console.log("    done.");
  console.log(`  deleting gs://${bucketName}/${thumbsPrefix} ...`);
  await bucket.deleteFiles({ prefix: thumbsPrefix, force: true });
  console.log("    done.");

  console.log(`  deleting docs/${docId}/versions/${doomed} (recursive) ...`);
  await db.recursiveDelete(versionsRef.doc(doomed));
  console.log("    done.");

  if (!values["keep-views"] && viewCount > 0) {
    // Version ids are re-minted, so an untagged old session would be conflated
    // with a future version carrying the same id.
    console.log(`  retagging ${viewCount} view session(s) ...`);
    const viewsSnap = await viewsQuery.get();
    let batch = db.batch();
    let n = 0;
    for (const d of viewsSnap.docs) {
      batch.update(d.ref, { versionId: `${doomed}-deleted` });
      if (++n % 400 === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }
    if (n % 400 !== 0) await batch.commit();
    console.log("    done.");
  }

  console.log("");
  console.log(`withdrew ${docId}/${doomed}; currentVersion is now ${repoint}.`);
}

main().catch((err) => fail(err.message || String(err)));
