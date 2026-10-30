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

interface TrashMark {
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

/** The folder an item went to the Trash with, by id, or null. */
function withOf(data: Data | undefined): string | null {
  const t = data?.trashed as { with?: { folderId?: unknown } } | null | undefined;
  return t && typeof t.with?.folderId === "string" ? t.with.folderId : null;
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
async function placeFor(db: Db, read: Parameters<Change>[1], folderId: unknown): Promise<string | null> {
  if (typeof folderId !== "string" || !folderId) return null;
  const snap = await read(db.collection("folders").doc(folderId));
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
  const change: Change = async (current, read) => {
    if (!isTrashed(current)) {
      folderId = typeof current.folderId === "string" ? current.folderId : null;
      return {};
    }
    folderId = await placeFor(ctx.db, read, current.folderId);
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
 * is not counted twice and a node left as it was is not counted at all, and
 * decides `descend` from the record as its transaction left it, not a re-read.
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
  const written = new Map<string, Data>();
  const counted = (into: Set<string>, id: string, change: Change): Change => async (data, read) => {
    const patch = await change(data, read);
    if (Object.keys(patch).length > 0) into.add(id);
    else into.delete(id);
    written.set(id, { ...data, ...patch });
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
    if (!result || !descend(written.get(id))) continue;
    const [docs, children] = await Promise.all([
      db.collection("docs").where("folderId", "==", id).get(),
      db.collection("folders").where("parentId", "==", id).get(),
    ]);
    for (const d of docs.docs) {
      await persistDocMembership(db, d.ref, counted(changed.documents, d.id, doc), (_m, before) => docEvents(before));
    }
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
  // Already in the Trash: finish with its own batch. A walk that stopped part
  // way, a timeout on a large folder, is completed by asking again.
  const batch = batchOf(data) ?? newBatch();
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
  // Its batch while it is still in the Trash. Once it is out, whatever a
  // restore that stopped part way left behind still names it as the folder it
  // went with, so asking again finishes the job.
  const batch = batchOf(data);
  const inBatch = (current: Data | undefined) => (batch ? batchOf(current) === batch : withOf(current) === id);
  let parentId: string | null = typeof data.parentId === "string" ? data.parentId : null;
  const counts = await walk(
    ctx.db,
    id,
    (folderId) => async (current, read) => {
      if (!inBatch(current)) return {};
      if (folderId !== id) return { trashed: null };
      parentId = await placeFor(ctx.db, read, current.parentId);
      return { trashed: null, parentId };
    },
    (current) => (inBatch(current) ? { trashed: null } : {}),
    (before) => (inBatch(before) ? [event(ctx, "doc.restored", { batch: batchOf(before) })] : []),
    // A folder that stays in the Trash keeps its contents there with it.
    (current) => !isTrashed(current),
  );
  return { id, parentId, ...counts };
}

export interface TrashedItem {
  kind: "document" | "folder";
  id: string;
  title: string;
  /** When it went, in epoch milliseconds. */
  trashedAt: number | null;
  batch: string | null;
  /** The folder it went with, as it was named then; null when it went on its own. */
  with: { folderId: string; name: string } | null;
  /** The folder it was in, which Restore puts it back into while that is still there. */
  was: string | null;
}

/**
 * What is in the caller's Trash: what they own and is in it, newest first. By
 * owner uid, so it is right across an account's change of address, and with
 * no index beyond the one every equality query has.
 */
export async function listTrash(ctx: ManagementContext): Promise<{ documents: TrashedItem[]; folders: TrashedItem[] }> {
  const [docs, folders] = await Promise.all([
    ctx.db.collection("docs").where("ownerUid", "==", ctx.caller.uid).get(),
    ctx.db.collection("folders").where("ownerUid", "==", ctx.caller.uid).get(),
  ]);
  const item = (kind: TrashedItem["kind"], id: string, d: Data): TrashedItem => {
    const t = d.trashed as { at?: { toMillis?: () => number }; with?: { folderId?: unknown; name?: unknown } };
    const along = t.with && typeof t.with.folderId === "string" ? { folderId: t.with.folderId, name: String(t.with.name ?? "") } : null;
    const was = kind === "document" ? d.folderId : d.parentId;
    return {
      kind,
      id,
      title: String((kind === "document" ? d.title : d.name) ?? id),
      trashedAt: typeof t.at?.toMillis === "function" ? t.at.toMillis() : null,
      batch: batchOf(d),
      with: along,
      was: typeof was === "string" && was ? was : null,
    };
  };
  const newest = (a: TrashedItem, b: TrashedItem) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0);
  return {
    documents: docs.docs.filter((s) => isTrashed(s.data())).map((s) => item("document", s.id, s.data())).sort(newest),
    folders: folders.docs.filter((s) => isTrashed(s.data())).map((s) => item("folder", s.id, s.data())).sort(newest),
  };
}
