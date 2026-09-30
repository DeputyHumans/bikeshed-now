#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Bring the state derived from each document's visibility into line with it (SPEC §9, §17).

/**
 * Usage:
 *   reconcile-visibility.mjs --dry-run [--database <url>] [--project <id>]
 *   reconcile-visibility.mjs --yes --account <email> --project <id> [--database <url>]
 *
 * Two things are derived from a document's visibility, and both were once
 * derived too generously. Anything written under the old rule stays wrong until
 * something rewrites it, and nothing else would:
 *
 *   public/{docId}       mirrored for every non-private document. Now only a
 *                        PUBLIC one: an unlisted document's row told anyone who
 *                        knew or listed the id its title and that it exists.
 *   editAccess/{docId}/* written for every open-editing non-private document.
 *                        Now only a PUBLIC one: on an unlisted document it let
 *                        any signed-in account push edits into it without the
 *                        link.
 *
 * The rules already refuse both (SPEC §17); this removes the rows themselves.
 * Idempotent: a second run finds nothing. Like delete-version, `--dry-run`
 * READS and so needs credentials; it writes nothing.
 *
 * The Realtime Database step needs its URL — `--database`, or the emulator —
 * because the Admin SDK cannot derive it. Without one that step is reported
 * as skipped, never as clean.
 */

import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { parse, fail } from "./lib/args.mjs";
import { getDb, getProjectId } from "./lib/firebase.mjs";

const USAGE = `reconcile-visibility.mjs — remove state derived from a visibility it no longer has

  node scripts/reconcile-visibility.mjs --dry-run [--database <url>]
  node scripts/reconcile-visibility.mjs --yes --account <email> --project <id> [--database <url>]

  --database <url>       the Realtime Database URL (default: the emulator, if set)
  --yes                  required for a real run
  --account <email>      console identity, required for a real run
  --project <id>         Firebase project id (default: .firebaserc)
  --dry-run              preview; performs no writes (reads, so needs credentials)
  --help

Deletes public/{id} for every document that is not public, and the open-editing
key editAccess/{id}/* for every document that is not public. Idempotent.`;

/** Read documents by id in batches, so a large collection is not N round trips. */
async function docsById(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 300) {
    const refs = ids.slice(i, i + 300).map((id) => db.collection("docs").doc(id));
    for (const snap of await db.getAll(...refs)) {
      out.set(snap.id, snap.exists ? snap.data() : null);
    }
  }
  return out;
}

const isPublic = (data) => data?.visibility === "public";

async function main() {
  const { values } = parse(
    {
      database: { type: "string" },
      account: { type: "string" },
      project: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
    { usage: USAGE },
  );
  const dry = values["dry-run"];

  if (!dry) {
    if (!values.yes) fail("refusing to write without --yes (use --dry-run to preview)");
    if (!values.account) {
      fail(
        "`--account <email>` is required for real runs (credentials are never " +
          "assumed); pass it explicitly or use --dry-run",
      );
    }
    if (!values.project) fail("`--project <id>` is required for real runs");
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIRESTORE_EMULATOR_HOST) {
      fail(
        "GOOGLE_APPLICATION_CREDENTIALS is not set. The Admin SDK would fall back " +
          "to ambient credentials, which may not be the identity named in --account.",
      );
    }
  }

  const projectId = getProjectId(values.project);
  const db = getDb(values.project);
  console.log(`project: ${projectId}${dry ? "   (dry run: nothing is written)" : ""}`);

  // --- 1. The world-readable projection ------------------------------------
  const rows = await db.collection("public").get();
  const docs = await docsById(db, rows.docs.map((r) => r.id));
  const stale = rows.docs.filter((r) => !isPublic(docs.get(r.id)));
  for (const row of stale) {
    const why = docs.get(row.id) ? docs.get(row.id).visibility ?? "private" : "absent";
    console.log(`  public/${row.id}  (${why})`);
    if (!dry) await row.ref.delete();
  }
  console.log(`projection: ${stale.length} of ${rows.size} row(s) ${dry ? "would be removed" : "removed"}`);

  // --- 2. The realtime open-editing key -------------------------------------
  const url =
    values.database ??
    (process.env.FIREBASE_DATABASE_EMULATOR_HOST
      ? `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${projectId}`
      : null);
  if (!url) {
    console.log("realtime:   SKIPPED — pass --database <url> to check editAccess");
    return;
  }
  const rtdb = getDatabaseWithUrl(url, admin.app());
  const open = await db.collection("docs").where("publicEdit", "==", true).get();
  let removed = 0;
  for (const snap of open.docs) {
    if (isPublic(snap.data())) continue;
    const key = rtdb.ref(`editAccess/${snap.id}/*`);
    if (!(await key.once("value")).exists()) continue;
    console.log(`  editAccess/${snap.id}/*  (${snap.data().visibility ?? "private"})`);
    if (!dry) await key.remove();
    removed += 1;
  }
  console.log(`realtime:   ${removed} open-editing key(s) ${dry ? "would be removed" : "removed"}`);
  await rtdb.goOffline();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
