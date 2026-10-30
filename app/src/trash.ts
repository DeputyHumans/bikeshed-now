// SPDX-License-Identifier: Apache-2.0
// What the app knows about the Trash: what is in it, and how to say where it was (SPEC §4).

import type { DocMeta, FolderMeta } from "./types";

/**
 * In the Trash: `trashed` is a map, and nothing else is, as the server and the
 * rules decide it (functions/src/lib/acl.ts isTrashed). Restore writes null.
 */
export function isTrashed(item: Pick<DocMeta, "trashed"> | Pick<FolderMeta, "trashed"> | null | undefined): boolean {
  const t = item?.trashed as unknown;
  return t != null && typeof t === "object" && !Array.isArray(t);
}

/**
 * Where a trashed item came from, as its row says it: the folder it went
 * with, when it went with one, else the folder it was in while that is still
 * in the workspace, else nothing to say.
 */
export function trashedFrom(
  item: { trashed?: DocMeta["trashed"]; folderId?: string | null; parentId?: string | null },
  folderName: (id: string) => string | null,
): string | null {
  const along = item.trashed?.with;
  if (along) return `with the folder “${along.name}”`;
  const was = item.folderId ?? item.parentId ?? null;
  const name = was ? folderName(was) : null;
  return name ? `from “${name}”` : null;
}
