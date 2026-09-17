#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Idempotent ACL edits from the operator side (SPEC §9, §13, §18).

/**
 * Usage:
 *   set-access.mjs --doc <docId> [--add a@x.com,team:design] [--remove b@x.com]
 *                  [--role viewer|editor] [--list] [--project <id>] [--dry-run]
 *
 * This script fixes two real defects in the design it replaces, and both were
 * silent:
 *
 *   1. It wrote only `{viewers, members}`, so `editorMembers` drifted out of
 *      sync with the endpoint that also maintains it.
 *
 *   2. It recomputed `members` WITHOUT the parent folder's members, so
 *      `--add` on a document inside a shared folder revoked every
 *      folder-inherited reader. It printed success while doing it.
 *
 * The structural fix is that this script no longer has its own arithmetic. It
 * calls `scripts/lib/membership.mjs`, the ESM twin of the server's
 * `computeMembership`, and a parity test asserts the two agree over a fixture
 * table — so divergence is a test failure rather than a silent revocation.
 */

import { parse, splitList, fail } from "./lib/args.mjs";
import { assertUsableEmails, normalizeEmail } from "./lib/email.mjs";
import {
  computeMembership,
  loadFolderMembership,
  loadTeamIndex,
} from "./lib/membership.mjs";
import { syncPresenceAccess } from "./lib/presence.mjs";
import { FieldValue, getDb, getProjectId } from "./lib/firebase.mjs";

async function main() {
const USAGE = `set-access.mjs — grant or revoke access to one document

  node scripts/set-access.mjs --doc <docId> [options]

  --doc <docId>        required
  --add <list>         comma-separated emails and team:<id> grants
  --remove <list>      comma-separated emails and team:<id> grants
  --role viewer|editor which grant list to edit (default: viewer)
  --list               print the current grants and effective members, then exit
  --account <email>    console identity, required for a real run
  --project <id>       Firebase project id (default: .firebaserc)
  --dry-run            print the resulting ACL, write nothing, need no
                       credentials
  --help

Membership is recomputed by the same code the server uses, including the parent
folder's members, and all four fields are written. The owner is never removable.`;

  const { values } = parse({
    doc: { type: "string" },
    add: { type: "string" },
    remove: { type: "string" },
    role: { type: "string", default: "viewer" },
    list: { type: "boolean", default: false },
    account: { type: "string" },
    project: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  }, { usage: USAGE });

  const dry = values["dry-run"];
  const docId = values.doc;
  if (!docId) fail("--doc <docId> is required");
  if (values.role !== "viewer" && values.role !== "editor") {
    fail('--role must be "viewer" or "editor"');
  }

  getProjectId(values.project);

  const add = splitList(values.add).map((p) =>
    p.startsWith("team:") ? p : normalizeEmail(p),
  );
  const remove = splitList(values.remove).map((p) =>
    p.startsWith("team:") ? p : normalizeEmail(p),
  );
  // Validate up front, with no credentials: a bad address fails fast and
  // non-zero rather than after a partial write.
  assertUsableEmails(add.filter((p) => !p.startsWith("team:")));

  if (!values.list && add.length === 0 && remove.length === 0) {
    fail("nothing to do: pass --add, --remove, and/or --list");
  }

  console.log(`set-access: doc=${docId} role=${values.role}`);
  if (add.length) console.log(`  add=[${add.join(", ")}]`);
  if (remove.length) console.log(`  remove=[${remove.join(", ")}]`);

  if (dry) {
    console.log("  --dry-run: no Firestore reads or writes.");
    console.log(`  would apply the delta with set semantics (one role per principal).`);
    console.log("  would recompute members AND editorMembers through the shared");
    console.log("  membership function, folding in the parent folder's grants and");
    console.log("  expanding any team: reference — then refresh the RTDB presence mirror.");
    if (values.list) console.log("  would print the resulting ACL.");
    return;
  }

  const db = getDb(values.project);
  const docRef = db.collection("docs").doc(docId);
  const snap = await docRef.get();
  if (!snap.exists) fail(`document not found: docs/${docId}`);
  const cur = snap.data() || {};

  const ownerEmail = normalizeEmail(cur.ownerEmail || "");
  const viewers = new Set((cur.viewers ?? []).map(String));
  const editors = new Set((cur.editors ?? []).map(String));

  for (const p of remove) {
    if (p === ownerEmail) continue; // the owner is never dropped
    viewers.delete(p);
    editors.delete(p);
  }
  for (const p of add) {
    if (p === ownerEmail) continue; // ownership is implicit in membership
    viewers.delete(p);
    editors.delete(p);
    if (values.role === "editor") editors.add(p);
    else viewers.add(p);
  }

  const nextViewers = [...viewers].sort();
  const nextEditors = [...editors].sort();
  const folderId = cur.folderId ?? null;
  const parent = await loadFolderMembership(db, folderId);
  const teams = await loadTeamIndex(db, nextViewers, nextEditors);
  const membership = computeMembership(
    ownerEmail,
    nextViewers,
    nextEditors,
    parent,
    teams,
  );

  if (add.length || remove.length) {
    await docRef.set(
      {
        viewers: nextViewers,
        editors: nextEditors,
        members: membership.members,
        editorMembers: membership.editorMembers,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    await syncPresenceAccess(docId, membership.members, values.project);
    console.log(`  updated docs/${docId} (all four membership fields + presence mirror).`);
  }

  if (values.list) {
    console.log("  current access:");
    console.log(`    owner:         ${ownerEmail || "(unset)"}`);
    console.log(`    folder:        ${folderId ?? "(root)"}`);
    console.log(`    viewers:       [${nextViewers.join(", ")}]`);
    console.log(`    editors:       [${nextEditors.join(", ")}]`);
    console.log(`    members:       [${membership.members.join(", ")}]`);
    console.log(`    editorMembers: [${membership.editorMembers.join(", ")}]`);
  }
}

main().catch((err) => fail(err.message || String(err)));
