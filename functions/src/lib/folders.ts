// SPDX-License-Identifier: Apache-2.0
// Effective-membership math and the subtree cascade (SPEC §4, §13, §18).

/**
 * Access flows downward: a grant on a folder applies to everything beneath it,
 * and a `team:{id}` grant applies to everyone in that team. Both are resolved by
 * DENORMALIZING effective membership onto every node:
 *
 *   approverMembers  = union(ownerEmail,       approvers,  parent.approverMembers)
 *   editorMembers    = union(approverMembers,  editors,    parent.editorMembers)
 *   suggesterMembers = union(editorMembers,    suggesters, parent.suggesterMembers)
 *   members          = union(suggesterMembers, viewers,    parent.members)
 *
 * with team references expanded to their members first. Each set is built ON
 * the one above it, so approver ⊆ editor ⊆ suggester ⊆ member holds by
 * construction — including under a parent written before a set existed, whose
 * missing array reads as empty.
 *
 * Because `parent.members` already folds in the whole ancestor chain, each node
 * needs only its DIRECT parent's computed arrays, so the cascade is a single
 * breadth-first pass, parent before child. The doc-list query, its composite
 * index, and the `canRead`/`list` rules never have to resolve inheritance
 * themselves — which is what keeps the `list` rule statically provable (SPEC §5).
 */

import { addEvent, type EventInput } from "./events";
import { randomBytes } from "crypto";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import {
  emptyGrants,
  grantLists,
  grantsOf,
  isTeamRef,
  normalizeEmail,
  teamIdOf,
  type RoleGrants,
} from "./access";
import { canEditFolder, opensEditingToAnyAccount, type DocAclData, type FolderAclData } from "./acl";
import { safeSegment } from "./http";
import { EMPTY_TEAM_INDEX, loadTeamIndex, type TeamIndex } from "./teams";
import { syncPresenceAccess } from "./presence";
import { syncPublicProjection } from "./publicdoc";

type Db = admin.firestore.Firestore;

export interface Membership {
  members: string[];
  suggesterMembers: string[];
  editorMembers: string[];
  approverMembers: string[];
}

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

/** The effective membership stored on a document or folder. A missing set is empty. */
export function membershipOf(data: object | null | undefined): Membership {
  const record = (data ?? {}) as Record<string, unknown>;
  const strings = (v: unknown) => asArray(v).filter((x) => typeof x === "string");
  return {
    members: strings(record.members),
    suggesterMembers: strings(record.suggesterMembers),
    editorMembers: strings(record.editorMembers),
    approverMembers: strings(record.approverMembers),
  };
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

/** Every effective set from a node's own grants unioned with its parent's. */
export function computeMembership(
  ownerEmail: string,
  grants: RoleGrants,
  parent: Membership | null,
  teams: TeamIndex = EMPTY_TEAM_INDEX,
): Membership {
  const owner = normalizeEmail(ownerEmail);
  // One rung of the ladder: everyone on the rung above, this rung's own grants,
  // and what the parent holds at this rung.
  const rung = (above: Iterable<string>, own: readonly string[], inherited: readonly string[]) =>
    new Set([...above, ...expand(own, teams), ...inherited]);

  const approverSet = rung(owner ? [owner] : [], grants.approvers, parent?.approverMembers ?? []);
  const editorSet = rung(approverSet, grants.editors, parent?.editorMembers ?? []);
  const suggesterSet = rung(editorSet, grants.suggesters, parent?.suggesterMembers ?? []);
  const memberSet = rung(suggesterSet, grants.viewers, parent?.members ?? []);
  return {
    members: [...memberSet].sort(),
    suggesterMembers: [...suggesterSet].sort(),
    editorMembers: [...editorSet].sort(),
    approverMembers: [...approverSet].sort(),
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
  return membershipOf(snap.data());
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

/**
 * True if `id` may be asked for as a docId: `slugify`'s own output space, so
 * lowercase letters, digits and single inner hyphens, at most 60 characters.
 *
 * Narrower than Firestore needs, on purpose. The id is also a Realtime Database
 * key in presence, where `.` or `#` would silently turn presence off; the app
 * builds `/d/${docId}` without encoding it; and it is quoted into a
 * Content-Disposition filename. Nothing here needs escaping in any of them.
 */
export function isValidDocId(id: string): boolean {
  return id.length <= 60 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id);
}

/** What a publisher is told when `isValidDocId` refuses their id. */
export const BAD_DOC_ID =
  "id may use lowercase letters, digits and hyphens between them, up to 60 characters";

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Six random characters from the docId alphabet. */
function randomSuffix(): string {
  return Array.from(randomBytes(6), (b) => SUFFIX_ALPHABET[b % SUFFIX_ALPHABET.length]).join("");
}

/**
 * Allocate a free docId: `wanted` itself if nobody holds it, else
 * `wanted-<six random characters>`.
 *
 * The suffix is random rather than a count. A count told the publisher how
 * many documents already held the name, and made the next one guessable. What
 * the suffix still reveals, that `wanted` is taken, is accepted: finding it out
 * costs the asker a document that can never be deleted (SPEC §4).
 *
 * `skipWanted` is for a caller that already knows `wanted` is unusable even
 * though no document record holds it yet — see `placeNewDocument`.
 */
export async function uniqueDocId(
  db: Db,
  wanted: string,
  skipWanted = false,
): Promise<string> {
  const base = slugify(wanted);
  const free = async (id: string) => !(await db.collection("docs").doc(id).get()).exists;
  if (!skipWanted && (await free(base))) return base;
  // 36^6 ids per name: a single retry is already more than chance needs.
  for (let i = 0; i < 5; i++) {
    const candidate = `${base}-${randomSuffix()}`;
    if (await free(candidate)) return candidate;
  }
  throw new Error("could not allocate a document id");
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

/** Who is acting, reduced to the two fields a folder decision reads. */
export interface FolderCaller {
  uid: string;
  emailLower: string;
}

/**
 * A destination folder that has been found and authorized, or the reason it
 * cannot be used. `id: null` is the workspace root, which every account may
 * write to and which therefore needs no lookup.
 */
export type FolderTarget =
  | {
      ok: true;
      id: string | null;
      /** The parent membership a child inherits. Null at the root. */
      membership: Membership | null;
      /** The target's own ancestor chain, so a child can extend it. */
      ancestors: string[];
    }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Resolve "put this inside that folder" once, for every caller that asks it.
 *
 * Five places used to ask it separately — createDoc, createFolder, both halves
 * of organize, and the MCP publish tool — with five copies of the same four
 * steps and three different refusal messages for the same refusal. A sixth
 * copy was about to be written for the folder tools, which is the second call
 * site rule saying the check has one owner now.
 *
 * It authorizes with `canEditFolder`, which is "may change what is INSIDE this
 * folder". That is the correct question for every caller here: creating a
 * subfolder, moving a document in and publishing into it are the same act. One
 * of the five copies tested `editorMembers.includes(...)` by hand instead,
 * which happens to agree today only because a folder's owner is always in its
 * own `editorMembers` — an accident, not a guarantee.
 */
export async function resolveFolderTarget(
  db: Db,
  folderId: unknown,
  caller: FolderCaller,
): Promise<FolderTarget> {
  const id = typeof folderId === "string" ? folderId.trim() : "";
  if (!id) return { ok: true, id: null, membership: null, ancestors: [] };
  if (!safeSegment(id)) {
    return { ok: false, status: 400, error: "invalid folder id" };
  }

  const snap = await db.collection("folders").doc(id).get();
  // 404 rather than 403 for a folder that is not there: a caller who may not
  // write to a folder should not learn the difference between "not yours" and
  // "does not exist" by comparing status codes.
  if (!snap.exists) {
    return { ok: false, status: 404, error: "destination folder not found" };
  }
  const data = snap.data() as FolderAclData & Record<string, unknown>;
  if (!canEditFolder(data, caller.uid, caller.emailLower)) {
    return { ok: false, status: 403, error: "you cannot put anything in that folder" };
  }

  return {
    ok: true,
    id,
    membership: membershipOf(data),
    ancestors: asArray(data.ancestors),
  };
}

/**
 * Write a new folder inside an already-resolved target.
 *
 * `ancestors` is stored rather than walked, because the cycle guard and the
 * cascade both need the whole chain and neither can afford a read per level.
 */
export async function createFolderRecord(
  db: Db,
  caller: FolderCaller,
  name: string,
  target: Extract<FolderTarget, { ok: true }>,
): Promise<{ folderId: string; name: string }> {
  const membership = computeMembership(caller.emailLower, emptyGrants(), target.membership);
  const ancestors = target.id ? [...target.ancestors, target.id] : [];
  const ref = db.collection("folders").doc();
  await ref.set({
    folderId: ref.id,
    name,
    slug: slugify(name),
    parentId: target.id,
    ownerUid: caller.uid,
    ownerEmail: caller.emailLower,
    ...emptyGrants(),
    ...membership,
    ancestors,
    depth: ancestors.length,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { folderId: ref.id, name };
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
 * trade is stated in docs/architecture/overview.md so it is not discovered at scale.
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
      parentSnap && parentSnap.exists ? membershipOf(parentSnap.data()) : null;
    const parentAncestors =
      parentSnap && parentSnap.exists ? asArray(parentSnap.data()?.ancestors) : [];

    const grants = grantsOf(data);
    const teams = await loadTeamIndex(db, ...grantLists(grants));
    const membership = computeMembership(
      String(data.ownerEmail || ""),
      grants,
      parent,
      teams,
    );
    const ancestors = parentId ? [...parentAncestors, parentId] : [];

    await ref.set(
      {
        ...membership,
        ancestors,
        depth: ancestors.length,
        updatedAt: FieldValue.serverTimestamp(),
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
        ...docSnaps.docs.flatMap((d) => grantLists(grantsOf(d.data()))),
      );
      const batch = db.batch();
      const touched: { id: string; membership: Membership; publicEdit: boolean }[] = [];
      for (const docSnap of docSnaps.docs) {
        const dd = docSnap.data() || {};
        const docMembership = computeMembership(
          String(dd.ownerEmail || ""),
          grantsOf(dd),
          membership,
          docTeams,
        );
        batch.set(
          docSnap.ref,
          { ...docMembership, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        touched.push({ id: docSnap.id, membership: docMembership, publicEdit: opensEditingToAnyAccount(dd as DocAclData) });
      }
      await batch.commit();
      // Presence is gated by a mirror of `members` in RTDB and shared document
      // state by a mirror of `editorMembers`, so every place that recomputes
      // membership must refresh BOTH — or a revoked reader keeps seeing who
      // else is in the document, and a revoked editor keeps typing into it
      // (SPEC §16).
      for (const t of touched) {
        await syncPresenceAccess(t.id, t.membership.members, t.membership.editorMembers, t.publicEdit);
        await syncPublicProjection(db, t.id);
      }
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
    grants: RoleGrants;
    folderId: string | null;
  },
  extra: Record<string, unknown> = {},
  /**
   * The change-log events this write makes, given the membership it computed:
   * written in the same batch, so the record and its event cannot disagree.
   */
  events: (membership: Membership) => EventInput[] = () => [],
): Promise<Membership> {
  const parent = await loadFolderMembership(db, fields.folderId);
  const teams = await loadTeamIndex(db, ...grantLists(fields.grants));
  const membership = computeMembership(fields.ownerEmail, fields.grants, parent, teams);
  const batch = db.batch();
  batch.set(
    docRef,
    {
      ...fields.grants,
      ...membership,
      updatedAt: FieldValue.serverTimestamp(),
      ...extra,
    },
    { merge: true },
  );
  for (const e of events(membership)) addEvent(batch, docRef, e);
  await batch.commit();
  const fresh = (await docRef.get()).data() as DocAclData;
  await syncPresenceAccess(docRef.id, membership.members, membership.editorMembers, opensEditingToAnyAccount(fresh));
  await syncPublicProjection(db, docRef.id);
  return membership;
}
