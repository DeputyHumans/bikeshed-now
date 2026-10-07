// SPDX-License-Identifier: Apache-2.0
// Client for the folder and organize endpoints (SPEC §2, §13).

import { post } from "./api";
import type { AccessChange, AccessState } from "./access";

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

export type OrganizeKind = "doc" | "folder";

function organize(payload: {
  kind: OrganizeKind;
  id: string;
  op: "move" | "rename" | "delete";
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
 * Delete a folder you own. Its children are reparented to its parent, never
 * orphaned. Deleting a DOCUMENT is deliberately unsupported (SPEC §13).
 */
export function deleteFolder(id: string): Promise<{ ok: true }> {
  return organize({ kind: "folder", id, op: "delete" });
}
