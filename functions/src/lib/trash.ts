// SPDX-License-Identifier: Apache-2.0
// The Trash: moving a document or a folder out of everyone's reach, and back (SPEC §4, ADR 0024).

import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { randomBytes } from "crypto";
import { canManageSharing, canManageFolder, isTrashed, type DocAclData, type FolderAclData } from "./acl";
import { eventActor, type EventInput } from "./events";
import { persistDocMembership, persistFolderMembership, type Change } from "./folders";
import { load, ManagementError, type ManagementContext } from "./management";

type Db = admin.firestore.Firestore;
type Data = admin.firestore.DocumentData;

/**
 * What the Trash is
 * -----------------
 * A document in the Trash is its owner's alone and frozen: its members are
 * the owner (computeMembership), so the rules refuse everyone else the record,
 * and every read and write path refuses it as it refuses an expired document
 * (acl.ts isFrozen), the public mirror and every link included. Nothing is
 * deleted: its versions, feedback, grants and links stay where they are, so
 * Restore gives back exactly what it took.
 *
 * `trashed` on the record says so: `{ at, by, batch, with? }`. `by` is a uid,
 * never an address: only the owner trashes a document and only a folder's
 * owner trashes a folder, so "by you" or "with the folder, by its owner" is
 * all a reader needs. `batch` is shared by everything trashed together, which
 * is what restoring a folder brings back. `with` names the folder a document
 * or subfolder went with, as it was named then, because its owner may not be
 * able to read that folder once it is in the Trash. Where an item was is its
 * `folderId` or `parentId`, unchanged while it is trashed. Restore writes
 * `trashed: null`.
 *
 * A folder takes everything in it, other people's documents included, and
 * each owner can bring back their own: it comes back at their root while the
 * folder stays in the Trash. Nothing here is permanent deletion; that is the
 * next release's, behind an emailed code.
 */

export interface TrashMark {
  at: FieldValue;
  by: string;
  batch: string;
  with?: { folderId: string; name: string };
}

function newBatch(): string {
  return randomBytes(9).toString("base64url");
}

function batchOf(data: Data | undefined): string | null {
  const t = data?.trashed as { batch?: unknown } | null | undefined;
  return t && typeof t.batch === "string" ? t.batch : null;
}

function mark(ctx: ManagementContext, batch: string, along?: { folderId: string; name: string }): TrashMark {
  return { at: FieldValue.serverTimestamp(), by: ctx.caller.uid, batch, ...(along ? { with: along } : {}) };
}

function event(ctx: ManagementContext, type: "doc.trashed" | "doc.restored", data: Record<string, unknown>): EventInput {
  return { type, audience: "editors", actor: eventActor(ctx.actor), data };
}

/**
 * Where a restored item goes: back into `folderId` while that folder exists
 * and is not in the Trash itself, otherwise its owner's root. Read inside the
 * restoring transaction, so a folder trashed a moment earlier is seen.
 */
async function placeFor(db: Db, tx: admin.firestore.Transaction, folderId: unknown): Promise<string | null> {
  if (typeof folderId !== "string" || !folderId) return null;
  const snap = await tx.get(db.collection("folders").doc(folderId));
  return snap.exists && !isTrashed(snap.data()) ? folderId : null;
}

/** The document's owner moves it to the Trash. Idempotent: already there, it says so. */
export async function trashDocument(ctx: ManagementContext, id: string): Promise<{ id: string; batch: string }> {
  const { ref, data } = await load(ctx, "document", id, false);
  if (!canManageSharing(data as DocAclData, ctx.caller.emailLower)) {
    throw new ManagementError(403, "only the owner can move a document to the Trash");
  }
  const fresh = newBatch();
  let batch = fresh;
  const change: Change = (current) => {
    if (isTrashed(current)) {
      batch = batchOf(current) ?? fresh;
      return {};
    }
    return { trashed: mark(ctx, fresh) };
  };
  await persistDocMembership(ctx.db, ref, change, (_m, before) => (isTrashed(before) ? [] : [event(ctx, "doc.trashed", { batch: fresh })]));
  return { id, batch };
}

/** The document's owner brings it back, into its folder while that folder is still there. */
export async function restoreDocument(ctx: ManagementContext, id: string): Promise<{ id: string; folderId: string | null }> {
  const { ref, data } = await load(ctx, "document", id, false);
  if (!canManageSharing(data as DocAclData, ctx.caller.emailLower)) {
    throw new ManagementError(403, "only the owner can restore a document");
  }
  let folderId: string | null = typeof data.folderId === "string" ? data.folderId : null;
  const change: Change = async (current, tx) => {
    if (!isTrashed(current)) {
      folderId = typeof current.folderId === "string" ? current.folderId : null;
      return {};
    }
    folderId = await placeFor(ctx.db, tx, current.folderId);
    return { trashed: null, folderId };
  };
  await persistDocMembership(ctx.db, ref, change, (_m, before) =>
    isTrashed(before) ? [event(ctx, "doc.restored", { batch: batchOf(before), to: folderId })] : [],
  );
  return { id, folderId };
}

/**
 * Walk a folder's subtree, parents before children, applying `folder` and
 * `doc` to each node in its own membership transaction, as recomputeSubtree
 * does. `descend` decides whether a folder's contents are visited at all.
 * Counts what each change actually changed, by id, so a transaction retried
 * is not counted twice and a node left as it was is not counted at all.
 */
async function walk(
  db: Db,
  rootId: string,
  folder: (id: string) => Change,
  doc: Change,
  docEvents: (before: Data) => EventInput[],
  descend: (data: Data | undefined) => boolean,
): Promise<{ folders: number; documents: number }> {
  const changed = { folders: new Set<string>(), documents: new Set<string>() };
  const counted = (into: Set<string>, id: string, change: Change): Change => async (data, tx) => {
    const patch = await change(data, tx);
    if (Object.keys(patch).length > 0) into.add(id);
    else into.delete(id);
    return patch;
  };
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const ref = db.collection("folders").doc(id);
    const result = await persistFolderMembership(db, ref, counted(changed.folders, id, folder(id)));
    if (!result) continue;
    if (!descend((await ref.get()).data())) continue;
    const docs = await db.collection("docs").where("folderId", "==", id).get();
    for (const d of docs.docs) {
      await persistDocMembership(db, d.ref, counted(changed.documents, d.id, doc), (_m, before) => docEvents(before));
    }
    const children = await db.collection("folders").where("parentId", "==", id).get();
    for (const child of children.docs) queue.push(child.id);
  }
  return { folders: changed.folders.size, documents: changed.documents.size };
}

/**
 * The folder's owner moves it to the Trash with everything in it, other
 * people's documents too. Anything already in the Trash keeps its own batch,
 * so restoring this folder later does not bring it back.
 */
export async function trashFolder(ctx: ManagementContext, id: string): Promise<{ id: string; batch: string; folders: number; documents: number }> {
  const { data } = await load(ctx, "folder", id, false);
  if (!canManageFolder(data as FolderAclData, ctx.caller.emailLower)) {
    throw new ManagementError(403, "only the owner can move a folder to the Trash");
  }
  if (isTrashed(data)) return { id, batch: batchOf(data) as string, folders: 0, documents: 0 };
  const batch = newBatch();
  const along = { folderId: id, name: typeof data.name === "string" ? data.name : "Untitled folder" };
  const set = (withFolder: boolean): Change => (current) =>
    isTrashed(current) ? {} : { trashed: mark(ctx, batch, withFolder ? along : undefined) };
  const counts = await walk(
    ctx.db,
    id,
    (folderId) => set(folderId !== id),
    set(true),
    (before) => (isTrashed(before) ? [] : [event(ctx, "doc.trashed", { batch, with: along })]),
    // A subfolder already in the Trash took its contents with it then.
    (current) => batchOf(current) === batch,
  );
  return { id, batch, ...counts };
}

/**
 * The folder's owner brings it back with everything that went into the Trash
 * with it and has not come back on its own since. It returns to its parent
 * while that is still there, otherwise to the owner's root.
 */
export async function restoreFolder(ctx: ManagementContext, id: string): Promise<{ id: string; parentId: string | null; folders: number; documents: number }> {
  const { data } = await load(ctx, "folder", id, false);
  if (!canManageFolder(data as FolderAclData, ctx.caller.emailLower)) {
    throw new ManagementError(403, "only the owner can restore a folder");
  }
  const batch = batchOf(data);
  if (!batch) return { id, parentId: typeof data.parentId === "string" ? data.parentId : null, folders: 0, documents: 0 };
  let parentId: string | null = null;
  const inBatch = (current: Data | undefined) => batchOf(current) === batch;
  const counts = await walk(
    ctx.db,
    id,
    (folderId) => async (current, tx) => {
      if (!inBatch(current)) return {};
      if (folderId !== id) return { trashed: null };
      parentId = await placeFor(ctx.db, tx, current.parentId);
      return { trashed: null, parentId };
    },
    (current) => (inBatch(current) ? { trashed: null } : {}),
    (before) => (inBatch(before) ? [event(ctx, "doc.restored", { batch })] : []),
    // A folder that stays in the Trash keeps its contents there with it.
    (current) => !isTrashed(current),
  );
  return { id, parentId, ...counts };
}
