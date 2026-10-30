// SPDX-License-Identifier: Apache-2.0
// Client for the folder and organize endpoints (SPEC §2, §13).

import { get, post } from "./api";
import type { AccessChange, AccessState, Inheritance } from "./access";
import type { InheritedGrant, InheritedReach } from "./types";

/**
 * folders/* is server-side only, so the workspace calls these endpoints rather
 * than the Firestore SDK. Sharing a folder cascades to its whole subtree
 * server-side, which is what keeps the doc-list query a single array-contains.
 */

export function createFolder(
  name: string,
  parentId?: string | null,
): Promise<{ folderId: string; name: string }> {
  return post("/folder", { name, parentId: parentId ?? null });
}

export function setFolderAccess(
  folderId: string,
  change: AccessChange,
): Promise<Omit<AccessState, "members">> {
  return post(
    "/folder-access",
    { folderId, ...change },
    { forbidden: "Only the folder owner can change sharing." },
  );
}

/** What the folder inherits from the folders above it, for its owner's share panel. */
export async function inheritedFolderAccess(folderId: string): Promise<Inheritance> {
  const { inherited, inheritedReach } = await get<{ inherited: InheritedGrant[]; inheritedReach?: InheritedReach[] }>("/folder-access", { folderId });
  return { grants: inherited, reach: inheritedReach ?? [] };
}

export type OrganizeKind = "doc" | "folder";

function organize(payload: {
  kind: OrganizeKind;
  id: string;
  op: "move" | "rename" | "trash" | "restore";
  targetFolderId?: string | null;
  name?: string;
}): Promise<{ ok: true }> {
  return post("/organize", payload);
}

/** Move an item into `targetFolderId`, or to the root when null. */
export function moveItem(
  kind: OrganizeKind,
  id: string,
  targetFolderId: string | null,
): Promise<{ ok: true }> {
  return organize({ kind, id, op: "move", targetFolderId });
}

export function renameItem(
  kind: OrganizeKind,
  id: string,
  name: string,
): Promise<{ ok: true }> {
  return organize({ kind, id, op: "rename", name });
}

/**
 * Move a document or a folder you own to the Trash (SPEC §4): a folder goes
 * with everything in it. Nothing is deleted yet: `restoreItem` brings it
 * back, and what is not brought back is deleted forever 30 days later.
 */
export function trashItem(kind: OrganizeKind, id: string): Promise<{ ok: true }> {
  return organize({ kind, id, op: "trash" });
}

/** Bring it back from the Trash, with every grant, where it was (SPEC §4). */
export function restoreItem(kind: OrganizeKind, id: string): Promise<{ ok: true }> {
  return organize({ kind, id, op: "restore" });
}
