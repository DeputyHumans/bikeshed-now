#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Remove legacy reading identities from member-readable document stats (SPEC §4, §17).

import { pathToFileURL } from "node:url";
import { FieldValue, FieldPath } from "firebase-admin/firestore";
import { parse, fail } from "./lib/args.mjs";
import { getDb, getProjectId } from "./lib/firebase.mjs";

/** Bounded scan; dotted deletion preserves concurrent counter and edit writes. */
export async function redactReaderStats(db, { dryRun = true, pageSize = 300 } = {}, sdk = { FieldValue, FieldPath }) {
  let cursor, scanned = 0, affected = 0;
  for (;;) {
    let query = db.collection("docs").orderBy(sdk.FieldPath.documentId()).limit(pageSize);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (!page.docs.length) break;
    for (const row of page.docs) {
      scanned += 1;
      if (!Object.hasOwn(row.data().stats ?? {}, "lastViewedByEmail")) continue;
      affected += 1;
      if (!dryRun) await row.ref.update({ "stats.lastViewedByEmail": sdk.FieldValue.delete() });
    }
    cursor = page.docs.at(-1).id;
  }
  return { scanned, affected, dryRun };
}

async function main() {
  const { values } = parse({
    account: { type: "string" }, project: { type: "string" },
    "dry-run": { type: "boolean", default: false }, yes: { type: "boolean", default: false },
  }, { usage: "redact-reader-stats.mjs --dry-run --project <id> | --yes --account <email> --project <id>" });
  if (!values["dry-run"]) {
    if (!values.yes || !values.account || !values.project) fail("writes require --yes, --account and --project (use --dry-run to preview)");
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIRESTORE_EMULATOR_HOST) {
      fail("GOOGLE_APPLICATION_CREDENTIALS is required; ambient identity is not assumed");
    }
  }
  console.log(`project: ${getProjectId(values.project)}`);
  console.log(JSON.stringify(await redactReaderStats(getDb(values.project), { dryRun: values["dry-run"] })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch((error) => { console.error(error.message); process.exit(1); });
}
