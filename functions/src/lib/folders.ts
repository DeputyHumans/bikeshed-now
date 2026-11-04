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
import { canEditFolder, canReadFolder, isPurged, isTrashed, opensEditingToAnyAccount, ownReachEntry, reachOf, type DocAclData, type FolderAclData, type ReachEntry } from "./acl";
import { safeSegment } from "./http";
import { EMPTY_TEAM_INDEX, findGrantsForTeam, referencedTeamIds, type TeamIndex } from "./teams";
import { syncPresenceAccess } from "./presence";
import { syncPublicProjection } from "./publicdoc";
import { freshReceiptId, readReceipt, recordReceipt, clearReceipt } from "./transaction-receipts";

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

/**
 * Every effective set from a node's own grants unioned with its parent's.
 *
 * A node in the Trash is its owner's alone (SPEC §4): its grants and its
 * parent's are kept on the record, so Restore can give them back, and count
 * for nothing until then. Every membership writer computes through here, so
 * no recompute — a folder cascade, a team change, an account move — can hand
 * a trashed document back to anyone.
 */
export function computeMembership(
  ownerEmail: string,
  grants: RoleGrants,
  parent: Membership | null,
  teams: TeamIndex = EMPTY_TEAM_INDEX,
  trashed = false,
): Membership {
  const owner = normalizeEmail(ownerEmail);
  if (trashed) {
    const alone = owner ? [owner] : [];
    return { members: alone, suggesterMembers: [...alone], editorMembers: [...alone], approverMembers: [...alone] };
  }
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

/**
 * A folder's reach: its parent's, then its own entry when it is not private
 * (SPEC §13, §17). The parent's already folds in every ancestor, so this is the
 * same one-level step `computeMembership` takes, and the cascade below computes
 * both in the same pass. A folder in the Trash reaches nobody, not even
 * through an ancestor's link (SPEC §4), and so neither does anything in it.
 */
export function computeReach(
  folderId: string,
  own: FolderAclData,
  parentReach: readonly ReachEntry[],
): ReachEntry[] {
  if (isTrashed(own)) return [];
  // Defensive against a corrupt chain naming this folder above itself.
  const out = parentReach.filter((e) => e.folderId !== folderId);
  const entry = ownReachEntry(folderId, own);
  if (entry) out.push(entry);
  // Firestore refuses `undefined`, and a public entry has no key to hash.
  return out.map((e) => (e.keyHash ? { ...e } : { folderId: e.folderId, visibility: e.visibility, expiresAt: e.expiresAt }));
}

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
 * costs the asker a document in their own name, which keeps the id even in
 * their Trash (SPEC §4).
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
      /** The target's reach, which a child folder inherits. Empty at the root. */
      reach: ReachEntry[];
    }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

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
  if (!id) return { ok: true, id: null, membership: null, ancestors: [], reach: [] };
  if (!safeSegment(id)) {
    return { ok: false, status: 400, error: "invalid folder id" };
  }

  const snap = await db.collection("folders").doc(id).get();
  // 404, the same answer, for a folder that is not there and for one the
  // caller cannot read: comparing the two must not tell a stranger that an id
  // is taken. 403 only for a folder they can read but not edit, which they
  // already know exists (SPEC §1.4b).
  const data = snap.exists ? (snap.data() as FolderAclData & Record<string, unknown>) : null;
  if (!data || !canReadFolder(data, caller.uid, caller.emailLower)) {
    return { ok: false, status: 404, error: "destination folder not found" };
  }
  if (!canEditFolder(data, caller.uid, caller.emailLower)) {
    return { ok: false, status: 403, error: "you cannot put anything in that folder" };
  }
  // Its owner is the only one left who can edit it: nothing goes into a
  // folder in the Trash, so nothing is left behind in it untrashed.
  if (isTrashed(data)) {
    return { ok: false, status: 409, error: "that folder is in the Trash — restore it first" };
  }

  return {
    ok: true,
    id,
    membership: membershipOf(data),
    ancestors: asArray(data.ancestors),
    reach: reachOf(data),
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
    // A new folder is private, so its reach is exactly its parent's.
    reach: computeReach(ref.id, {}, target.reach),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { folderId: ref.id, name };
}

/**
 * A delta to a node's current record, decided inside the transaction that
 * writes its membership. It may read through `read`, the same transaction's
 * reads, and nothing else: a change never writes, so every read still comes
 * before the transaction's writes. It may throw to refuse the change.
 */
export type Change = (
  data: admin.firestore.DocumentData,
  read: (ref: admin.firestore.DocumentReference) => Promise<admin.firestore.DocumentSnapshot>,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/** Read every dependency through the same transaction as its membership write. */
async function transactionTeams(db: Db, tx: admin.firestore.Transaction, grants: RoleGrants): Promise<TeamIndex> {
  const index = new Map<string, string[]>();
  for (const id of referencedTeamIds(...grantLists(grants))) {
    const snap = await tx.get(db.collection("teams").doc(id));
    if (snap.exists) index.set(id, asArray(snap.data()?.members).map(normalizeEmail).filter(Boolean));
  }
  return index;
}

/** Recompute one folder and its own grant delta against current dependencies. */
export async function persistFolderMembership(
  db: Db,
  ref: admin.firestore.DocumentReference,
  change?: Change,
  opts: RecomputeOptions = {},
): Promise<{ data: admin.firestore.DocumentData; before: Membership; membership: Membership; grants: RoleGrants } | null> {
  const receipt = change ? freshReceiptId() : null;
  let originalData: admin.firestore.DocumentData | undefined;
  type Result = { before: Membership; membership: Membership; grants: RoleGrants };
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (receipt) {
      const committed = readReceipt<Result>(snap, receipt);
      if (committed.found) {
        if (!originalData) throw new Error("membership receipt has no request snapshot");
        return { data: originalData, ...committed.result };
      }
    }
    if (!snap.exists) return null;
    const data = snap.data() || {};
    const patch = (await change?.(data, (r) => tx.get(r))) ?? {};
    const next = { ...data, ...patch };
    // From the patched record: a restore may move it to the owner's root.
    const parentId = typeof next.parentId === "string" ? next.parentId : null;
    const parentSnap = parentId ? await tx.get(db.collection("folders").doc(parentId)) : null;
    const parent = parentSnap?.exists ? membershipOf(parentSnap.data()) : null;
    const parentAncestors = parentSnap?.exists ? asArray(parentSnap.data()?.ancestors) : [];
    const grants = grantsOf(next);
    const teams = await transactionTeams(db, tx, grants);
    const beforeTeams = await transactionTeams(db, tx, grantsOf(data));
    const before = computeMembership(String(data.ownerEmail || ""), grantsOf(data), parent, beforeTeams, isTrashed(data));
    const membership = computeMembership(String(data.ownerEmail || ""), grants, parent, teams, isTrashed(next));
    const ancestors = parentId ? [...parentAncestors, parentId] : [];
    tx.set(ref, { ...patch, ...membership, ancestors, depth: ancestors.length, reach: computeReach(ref.id, next as FolderAclData, parentSnap?.exists ? reachOf(parentSnap.data()) : []), ...stampOf(opts) }, { merge: true });
    if (receipt) {
      originalData = data; // request-local only: never persist a document snapshot in its receipt
      recordReceipt(tx, ref, snap, receipt, { before, membership, grants });
    }
    return { data, before, membership, grants };
  });
  if (receipt) await clearReceipt(ref, receipt);
  return result;
}

/**
 * Recompute and persist members/editorMembers/ancestors/depth/reach for a
 * folder and everything beneath it.
 *
 * Call after a folder's own grants or visibility change, after it moves, or
 * after a team it grants to changes membership. The starting folder is read fresh against its
 * (unchanged) parent; each descendant is recomputed against its just-written
 * parent, so the traversal always visits a parent before its children. Folder
 * writes are awaited individually because a child must read its parent's fresh
 * values; each node is recomputed in a transaction with its dependencies.
 *
 * The cost is honest and bounded: a folder shared with 50 people containing 200
 * documents is 200 document writes. Each is a transaction; the
 * trade is stated in docs/architecture/overview.md so it is not discovered at scale.
 */
/**
 * `touchUpdatedAt: false` is for a recompute that is not a change anybody made
 * to the record: an account moving to a new address (SPEC §14). `updatedAt`
 * is what every collaborator's card reads as "updated", so stamping it there
 * would announce an edit on every document the person could see.
 */
export interface RecomputeOptions {
  touchUpdatedAt?: boolean;
}

function stampOf(opts: RecomputeOptions): { updatedAt?: FieldValue } {
  return opts.touchUpdatedAt === false ? {} : { updatedAt: FieldValue.serverTimestamp() };
}

export async function recomputeSubtree(
  db: Db,
  rootId: string,
  opts: RecomputeOptions = {},
): Promise<void> {
  const queue: string[] = [rootId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const folderId = queue.shift() as string;
    if (visited.has(folderId)) continue;
    visited.add(folderId);
    const ref = db.collection("folders").doc(folderId);
    const result = await persistFolderMembership(db, ref, undefined, opts);
    if (!result) continue;
    // The traversal only discovers ids. Each write rereads its current node,
    // parent and teams, so an older traversal cannot restore revoked access.
    const docs = await db.collection("docs").where("folderId", "==", folderId).get();
    for (const doc of docs.docs) await persistDocMembership(db, doc.ref, undefined, undefined, opts);
    const children = await db.collection("folders").where("parentId", "==", folderId).get();
    for (const child of children.docs) queue.push(child.id);
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
  /** Apply a delta to the transaction's current record, never a caller's snapshot. */
  change?: Change,
  events: (membership: Membership, before: admin.firestore.DocumentData, previous: Membership) => EventInput[] = () => [],
  opts: RecomputeOptions = {},
): Promise<Membership> {
  const receipt = change ? freshReceiptId() : null;
  const membership = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (receipt) {
      const committed = readReceipt<Membership>(snap, receipt);
      // Do not rerun callbacks: endpoints retain the committed attempt's
      // before/after invitation delta in their request-local closure.
      if (committed.found) return committed.result;
    }
    // A tombstone is a document that no longer exists, kept only so its id is
    // never reused: a membership written onto it would be a record again.
    if (!snap.exists || isPurged(snap.data())) throw new Error("document no longer exists");
    const before = snap.data() || {};
    const patch = (await change?.(before, (r) => tx.get(r))) ?? {};
    const data = { ...before, ...patch };
    const folderId = typeof data.folderId === "string" ? data.folderId : null;
    const parentSnap = folderId ? await tx.get(db.collection("folders").doc(folderId)) : null;
    const parent = parentSnap?.exists ? membershipOf(parentSnap.data()) : null;
    const grants = grantsOf(data);
    const teams = await transactionTeams(db, tx, grants);
    const beforeFolderId = typeof before.folderId === "string" ? before.folderId : null;
    const beforeParentSnap = beforeFolderId && beforeFolderId !== folderId
      ? await tx.get(db.collection("folders").doc(beforeFolderId)) : null;
    const beforeParent = beforeFolderId === folderId ? parent : beforeParentSnap?.exists ? membershipOf(beforeParentSnap.data()) : null;
    const beforeTeams = await transactionTeams(db, tx, grantsOf(before));
    const previous = computeMembership(String(before.ownerEmail || ""), grantsOf(before), beforeParent, beforeTeams, isTrashed(before));
    const next = computeMembership(String(data.ownerEmail || ""), grants, parent, teams, isTrashed(data));
    tx.set(docRef, { ...patch, ...next, ...stampOf(opts) }, { merge: true });
    for (const event of events(next, before, previous)) addEvent(tx, docRef, event);
    if (receipt) recordReceipt(tx, docRef, snap, receipt, next);
    return next;
  });
  if (receipt) await clearReceipt(docRef, receipt);
  const fresh = (await docRef.get()).data() as DocAclData;
  await syncPresenceAccess(docRef.id, membership.members, membership.editorMembers, opensEditingToAnyAccount(fresh));
  await syncPublicProjection(db, docRef.id);
  return membership;
}

/**
 * Re-expand every grant that names this team.
 *
 * The affected set is an `array-contains` QUERY over `team:{id}` grants, not a
 * traversal, which is what lets this reuse the folder cascade rather than needing
 * a job queue. The cost is honest: a team granted on 200 documents is 200 writes.
 * That is a batch, and the trade is written down in docs/architecture/overview.md rather
 * than discovered at ten thousand documents.
 */
export async function refanTeam(
  db: Db,
  teamId: string,
  opts: RecomputeOptions = {},
): Promise<number> {
  const { docIds, folderIds } = await findGrantsForTeam(db, teamId);
  for (const id of docIds) {
    const ref = db.collection("docs").doc(id);
    const snap = await ref.get();
    if (!snap.exists) continue;
    await persistDocMembership(db, ref, undefined, undefined, opts);
  }
  for (const id of folderIds) {
    await recomputeSubtree(db, id, opts);
  }
  return docIds.length + folderIds.length;
}
