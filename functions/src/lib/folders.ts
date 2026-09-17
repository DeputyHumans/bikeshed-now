// SPDX-License-Identifier: Apache-2.0
// Effective-membership math and the subtree cascade (SPEC §4, §13, §18).

/**
 * Access flows downward: a grant on a folder applies to everything beneath it,
 * and a `team:{id}` grant applies to everyone in that team. Both are resolved by
 * DENORMALIZING effective membership onto every node:
 *
 *   members       = union(ownerEmail, viewers, editors, parent.members)
 *   editorMembers = union(ownerEmail, editors,          parent.editorMembers)
 *
 * with team references expanded to their members first.
 *
 * Because `parent.members` already folds in the whole ancestor chain, each node
 * needs only its DIRECT parent's computed arrays, so the cascade is a single
 * breadth-first pass, parent before child. The doc-list query, its composite
 * index, and the `canRead`/`list` rules never have to resolve inheritance
 * themselves — which is what keeps the `list` rule statically provable (SPEC §5).
 */

import * as admin from "firebase-admin";
import { isTeamRef, normalizeEmail, teamIdOf } from "./access";
import { EMPTY_TEAM_INDEX, loadTeamIndex, type TeamIndex } from "./teams";
import { syncPresenceAccess } from "./presence";
import { syncPublicProjection } from "./publicdoc";

type Db = admin.firestore.Firestore;

export interface Membership {
  members: string[];
  editorMembers: string[];
}

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

/** Expand one grant list into the emails it actually names. */
function expand(principals: readonly string[], teams: TeamIndex): string[] {
  const out: string[] = [];
  for (const principal of principals) {
    if (isTeamRef(principal)) {
      const id = teamIdOf(principal);
      // A grant naming a deleted team expands to nothing, so it denies rather
      // than leaving stale access in place.
      if (id) out.push(...(teams.get(id) ?? []));
      continue;
    }
    const e = normalizeEmail(principal);
    if (e) out.push(e);
  }
  return out;
}

/** members/editorMembers from a node's own grants unioned with its parent's. */
export function computeMembership(
  ownerEmail: string,
  viewers: readonly string[],
  editors: readonly string[],
  parent: Membership | null,
  teams: TeamIndex = EMPTY_TEAM_INDEX,
): Membership {
  const memberSet = new Set<string>();
  const editorSet = new Set<string>();

  const owner = normalizeEmail(ownerEmail);
  if (owner) {
    memberSet.add(owner);
    editorSet.add(owner);
  }
  for (const e of expand(editors, teams)) {
    memberSet.add(e);
    editorSet.add(e);
  }
  for (const v of expand(viewers, teams)) {
    memberSet.add(v);
  }
  if (parent) {
    for (const m of parent.members) memberSet.add(m);
    for (const m of parent.editorMembers) editorSet.add(m);
  }
  return {
    members: [...memberSet].sort(),
    editorMembers: [...editorSet].sort(),
  };
}

/** Alias kept for call sites that read better as "this document's membership". */
export const computeDocMembership = computeMembership;

/** A folder's stored effective membership, or null if it does not exist. */
export async function loadFolderMembership(
  db: Db,
  folderId: string | null | undefined,
): Promise<Membership | null> {
  if (!folderId) return null;
  const snap = await db.collection("folders").doc(folderId).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  return {
    members: asArray(d.members),
    editorMembers: asArray(d.editorMembers),
  };
}

/** A URL- and Storage-safe slug derived from a display name. */
export function slugify(name: string): string {
  const base = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "untitled";
}

/** Allocate a collision-free docId from a slug: slug, slug-2, slug-3, … */
export async function uniqueDocId(db: Db, slug: string): Promise<string> {
  const base = slugify(slug);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const snap = await db.collection("docs").doc(candidate).get();
    if (!snap.exists) return candidate;
  }
  // Fifty collisions on one title is effectively impossible; fall back to an
  // opaque suffix rather than looping forever or failing the publish.
  return `${base}-${db.collection("docs").doc().id.slice(0, 6)}`;
}

/**
 * True if making `newParentId` the parent of `folderId` would create a cycle —
 * it IS the folder, or it sits inside the folder's subtree. Root (null) is safe.
 */
export async function wouldCycle(
  db: Db,
  folderId: string,
  newParentId: string | null,
): Promise<boolean> {
  if (!newParentId) return false;
  if (newParentId === folderId) return true;
  const snap = await db.collection("folders").doc(newParentId).get();
  if (!snap.exists) return false;
  return asArray(snap.data()?.ancestors).includes(folderId);
}

/**
 * Recompute and persist members/editorMembers/ancestors/depth for a folder and
 * everything beneath it.
 *
 * Call after a folder's own grants change, after it moves, or after a team it
 * grants to changes membership. The starting folder is read fresh against its
 * (unchanged) parent; each descendant is recomputed against its just-written
 * parent, so the traversal always visits a parent before its children. Folder
 * writes are awaited individually because a child must read its parent's fresh
 * values; each folder's documents are flushed in one batch.
 *
 * The cost is honest and bounded: a folder shared with 50 people containing 200
 * documents is 200 document writes. That is a batch, not a job queue, and the
 * trade is stated in docs/architecture.md so it is not discovered at scale.
 */
export async function recomputeSubtree(db: Db, rootId: string): Promise<void> {
  const queue: string[] = [rootId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const folderId = queue.shift() as string;
    if (visited.has(folderId)) continue; // defensive against a corrupt cycle
    visited.add(folderId);

    const ref = db.collection("folders").doc(folderId);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const data = snap.data() || {};

    const parentId: string | null =
      typeof data.parentId === "string" ? data.parentId : null;
    const parentSnap = parentId
      ? await db.collection("folders").doc(parentId).get()
      : null;
    const parent: Membership | null =
      parentSnap && parentSnap.exists
        ? {
            members: asArray(parentSnap.data()?.members),
            editorMembers: asArray(parentSnap.data()?.editorMembers),
          }
        : null;
    const parentAncestors =
      parentSnap && parentSnap.exists ? asArray(parentSnap.data()?.ancestors) : [];

    const viewers = asArray(data.viewers);
    const editors = asArray(data.editors);
    const teams = await loadTeamIndex(db, viewers, editors);
    const membership = computeMembership(
      String(data.ownerEmail || ""),
      viewers,
      editors,
      parent,
      teams,
    );
    const ancestors = parentId ? [...parentAncestors, parentId] : [];

    await ref.set(
      {
        members: membership.members,
        editorMembers: membership.editorMembers,
        ancestors,
        depth: ancestors.length,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Documents directly in this folder inherit its fresh membership.
    const docSnaps = await db
      .collection("docs")
      .where("folderId", "==", folderId)
      .get();
    if (!docSnaps.empty) {
      // One team read for the whole folder rather than one per document: the
      // grants in a folder overlap heavily, and N documents should not mean N
      // round trips.
      const docTeams = await loadTeamIndex(
        db,
        ...docSnaps.docs.flatMap((d) => [
          asArray(d.data()?.viewers),
          asArray(d.data()?.editors),
        ]),
      );
      const batch = db.batch();
      const touched: { id: string; members: string[] }[] = [];
      for (const docSnap of docSnaps.docs) {
        const dd = docSnap.data() || {};
        const dv = asArray(dd.viewers);
        const de = asArray(dd.editors);
        const docMembership = computeMembership(
          String(dd.ownerEmail || ""),
          dv,
          de,
          membership,
          docTeams,
        );
        batch.set(
          docSnap.ref,
          {
            members: docMembership.members,
            editorMembers: docMembership.editorMembers,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        touched.push({ id: docSnap.id, members: docMembership.members });
      }
      await batch.commit();
      // Presence is gated by a mirror of `members` that lives in RTDB, so every
      // place that recomputes membership must refresh it or a revoked reader
      // keeps seeing who else is in the document (SPEC §16).
      for (const t of touched) await syncPresenceAccess(t.id, t.members);
    }

    // Enqueue child folders, recomputed against this now-fresh folder.
    const childFolders = await db
      .collection("folders")
      .where("parentId", "==", folderId)
      .get();
    for (const child of childFolders.docs) queue.push(child.id);
  }
}

/**
 * Recompute one document's effective membership and persist it, keeping the
 * presence mirror and the public projection in step.
 *
 * Every endpoint that changes a document's grants, folder or visibility goes
 * through here, so the three things that must move together cannot drift apart.
 */
export async function persistDocMembership(
  db: Db,
  docRef: admin.firestore.DocumentReference,
  fields: {
    ownerEmail: string;
    viewers: string[];
    editors: string[];
    folderId: string | null;
  },
  extra: Record<string, unknown> = {},
): Promise<Membership> {
  const parent = await loadFolderMembership(db, fields.folderId);
  const teams = await loadTeamIndex(db, fields.viewers, fields.editors);
  const membership = computeMembership(
    fields.ownerEmail,
    fields.viewers,
    fields.editors,
    parent,
    teams,
  );
  await docRef.set(
    {
      viewers: fields.viewers,
      editors: fields.editors,
      members: membership.members,
      editorMembers: membership.editorMembers,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...extra,
    },
    { merge: true },
  );
  await syncPresenceAccess(docRef.id, membership.members);
  await syncPublicProjection(db, docRef.id);
  return membership;
}
