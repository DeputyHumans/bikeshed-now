#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Ask the version trigger to count and summarize every document written before it did so itself (SPEC §4, §17).

/**
 * Usage:
 *   summarize-documents.mjs --dry-run [--project <id>]
 *   summarize-documents.mjs --yes --account <email> --project <id>
 *
 * A document's card says how long it is and when it was last updated, from
 * `latest`, the summary of its current version that the version-write trigger
 * keeps (functions/src/lib/latest.ts), and the trigger counts the version's
 * words while it is there. A document whose current version was written
 * before that release has neither.
 *
 * This does not count anything itself: the counter lives in the functions,
 * and a second copy here would be a second answer. It writes one field,
 * `summaryRequestedAt`, to each such current version, which fires the trigger,
 * which counts and summarizes as it does for every new version. Idempotent: a
 * document already summarized is skipped, and a second run finds nothing.
 * `--dry-run` READS, so it needs credentials, and writes nothing.
 */

import { parse, fail } from "./lib/args.mjs";
import { FieldValue, getDb, getProjectId } from "./lib/firebase.mjs";

const USAGE = `summarize-documents.mjs — count and summarize the documents written before the trigger did

  node scripts/summarize-documents.mjs --dry-run [--project <id>]
  node scripts/summarize-documents.mjs --yes --account <email> --project <id>

  --yes                  required for a real run
  --account <email>      console identity, required for a real run
  --project <id>         Firebase project id (default: .firebaserc)
  --dry-run              preview; performs no writes (reads, so needs credentials)
  --help

Marks each current version that has no word count, or whose document has no
summary of it, so the version trigger counts and summarizes it. Idempotent.`;

/** Why a document needs its summary asked for, or null when it has one. */
export function summaryWanted(doc, version) {
  if (!doc || typeof doc.currentVersion !== "string" || !doc.currentVersion) return null;
  if (!version) return null;
  if (typeof version.words !== "number") return "its current version is not counted";
  if (!doc.latest || doc.latest.version !== doc.currentVersion) return "it has no summary of its current version";
  if (doc.latest.words !== version.words) return "its summary has not caught up with the count";
  return null;
}

async function main() {
  const { values } = parse(
    {
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

  const docs = await db.collection("docs").get();
  let asked = 0;
  for (const snap of docs.docs) {
    const doc = snap.data();
    const current = typeof doc.currentVersion === "string" ? doc.currentVersion : "";
    if (!current) continue;
    const versionRef = snap.ref.collection("versions").doc(current);
    const reason = summaryWanted(doc, (await versionRef.get()).data());
    if (!reason) continue;
    console.log(`  docs/${snap.id}/versions/${current}: ${reason}`);
    asked += 1;
    if (!dry) await versionRef.update({ summaryRequestedAt: FieldValue.serverTimestamp() });
  }
  console.log(`${asked} of ${docs.size} document(s) ${dry ? "would be" : "were"} asked for; the version trigger counts and summarizes each within a minute`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`error: ${err.message}`);
      process.exit(1);
    });
}
