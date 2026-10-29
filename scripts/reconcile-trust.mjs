#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Bring every document's global trust into line with who may now grant it (SPEC §6c; ADR 0021).

/**
 * Usage:
 *   reconcile-trust.mjs --dry-run --superadmins <a,b> [--project <id>]
 *   reconcile-trust.mjs --yes --account <email> --project <id> --superadmins <a,b>
 *
 * Trusting a document for everyone used to be any owner's call, and a
 * document with no `trusted` flag at all counted as trusted. Both now fail
 * closed: only `trusted: true` is trust, and only a superadmin may set it,
 * on a document they own. Nothing else rewrites a flag set under the old
 * rule, so this does, once:
 *
 *   owner is a superadmin    → `trusted: true`, written out if it was absent,
 *                              so the document keeps running its script
 *   anyone else's document   → `trusted: false`; each reader may still run
 *                              its script for themselves (personal trust)
 *
 * The projection `public/{docId}` carries the flag too, and is rewritten
 * with it. Personal trust (`docs/{id}/trust/{uid}`) is never touched.
 * Idempotent: a second run finds nothing. `--dry-run` READS, so it needs
 * credentials, and writes nothing.
 *
 * `--superadmins` is the deployment's own list, the same addresses as the
 * functions' BIKESHED_SUPERADMINS. It is passed, never read from a file
 * here, so nobody's addresses are written into this repository.
 */

import { parse, fail } from "./lib/args.mjs";
import { getDb, getProjectId } from "./lib/firebase.mjs";

const USAGE = `reconcile-trust.mjs — make each document's global trust what ADR 0021 allows

  node scripts/reconcile-trust.mjs --dry-run --superadmins <a,b> [--project <id>]
  node scripts/reconcile-trust.mjs --yes --account <email> --project <id> --superadmins <a,b>

  --superadmins <a,b>    the deployment's superadmins (BIKESHED_SUPERADMINS), comma-separated
  --yes                  required for a real run
  --account <email>      console identity, required for a real run
  --project <id>         Firebase project id (default: .firebaserc)
  --dry-run              preview; performs no writes (reads, so needs credentials)
  --help

Sets trusted:true on every document a superadmin owns that was trusted under the
old rule (absent or true), and trusted:false on every other one. Idempotent.`;

/** The deployment's superadmins, lowercased, as the functions read them. */
export function parseSuperadmins(raw) {
  return new Set(
    String(raw ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/**
 * What one document's flag must become, or null when it is already right.
 * Only `trusted: false` is left alone outright: it is the safe state, and
 * nothing here ever widens trust beyond what a document already had.
 */
export function reconciledTrust(data, admins) {
  if (data?.trusted === false) return null;
  const owner = typeof data?.ownerEmail === "string" ? data.ownerEmail.toLowerCase() : "";
  const keeps = admins.has(owner);
  if (keeps) return data?.trusted === true ? null : true;
  return false;
}

async function main() {
  const { values } = parse(
    {
      superadmins: { type: "string" },
      account: { type: "string" },
      project: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
    { usage: USAGE },
  );
  const dry = values["dry-run"];
  if (values.superadmins === undefined) {
    fail("`--superadmins <a,b>` is required: the deployment's BIKESHED_SUPERADMINS (an empty string means none)");
  }
  const admins = parseSuperadmins(values.superadmins);

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
  console.log(`superadmins: ${admins.size}`);

  const docs = await db.collection("docs").get();
  const changes = { kept: 0, withdrawn: 0 };
  for (const snap of docs.docs) {
    const data = snap.data();
    const next = reconciledTrust(data, admins);
    if (next === null) continue;
    const was = data.trusted === undefined ? "absent" : String(data.trusted);
    console.log(`  docs/${snap.id}  ${was} -> ${next}  (owner ${next ? "is" : "is not"} a superadmin)`);
    changes[next ? "kept" : "withdrawn"] += 1;
    if (dry) continue;
    const batch = db.batch();
    batch.set(snap.ref, { trusted: next }, { merge: true });
    const pub = db.collection("public").doc(snap.id);
    if ((await pub.get()).exists) batch.set(pub, { trusted: next }, { merge: true });
    await batch.commit();
  }
  const verb = dry ? "would be" : "were";
  console.log(`trust: ${changes.kept} kept as true and ${changes.withdrawn} withdrawn ${verb} written, of ${docs.size} document(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`error: ${err.message}`);
      process.exit(1);
    });
}
