// SPDX-License-Identifier: Apache-2.0
// Folder-tree construction, filtering and sorting (SPEC §13).

import type { DocMeta, FolderMeta } from "../types";

/**
 * Extracted, rather than living inline in the three components that need it.
 *
 * In the design this replaces, tree building was written three times — in the
 * rail, in the list, and in the move dialog — so a fix in one was a bug in the
 * other two, and none of it could be tested because there was nothing to call.
 * This module is pure: it takes arrays and returns arrays, which is what makes
 * the workspace's behaviour assertable without mounting anything.
 */

export interface TreeNode {
  folder: FolderMeta;
  children: TreeNode[];
  depth: number;
}

/**
 * Build the forest.
 *
 * A folder whose parent is not in the list is treated as a ROOT rather than
 * dropped. That case is real and not exceptional: you can be granted a folder
 * without being granted its parent, and the alternative is that the folder
 * silently disappears from a workspace it was deliberately shared into.
 */
export function buildTree(folders: readonly FolderMeta[]): TreeNode[] {
  const byId = new Map<string, FolderMeta>();
  for (const f of folders) byId.set(f.folderId, f);

  const childrenOf = new Map<string | null, FolderMeta[]>();
  for (const f of folders) {
    const parent = f.parentId && byId.has(f.parentId) ? f.parentId : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(f);
    childrenOf.set(parent, list);
  }

  const byName = (a: FolderMeta, b: FolderMeta) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

  const build = (parentId: string | null, depth: number, seen: Set<string>): TreeNode[] =>
    (childrenOf.get(parentId) ?? [])
      .slice()
      .sort(byName)
      .filter((f) => !seen.has(f.folderId))
      .map((folder) => {
        // A corrupt parent chain must not hang the workspace. The cycle guard
        // in the move endpoint should make this impossible; this is what
        // happens if it ever does not.
        const next = new Set(seen).add(folder.folderId);
        return { folder, depth, children: build(folder.folderId, depth + 1, next) };
      });

  return build(null, 0, new Set());
}

/** Flatten for rendering, honouring which folders are expanded. */
export function flattenTree(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: readonly TreeNode[]) => {
    for (const node of list) {
      out.push(node);
      if (expanded.has(node.folder.folderId)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Every folder that must be open for `folderId` to be visible.
 *
 * Uses the stored `ancestors` array rather than walking parents, because that
 * array is maintained server-side by the same cascade that maintains membership
 * — so it is correct even when an intermediate folder is not in this user's
 * list at all.
 */
export function pathToFolder(
  folderId: string | null,
  folders: readonly FolderMeta[],
): string[] {
  if (!folderId) return [];
  const folder = folders.find((f) => f.folderId === folderId);
  if (!folder) return [];
  return [...folder.ancestors, folder.folderId];
}

/** The breadcrumb trail for a folder, root first. */
export function breadcrumbFor(
  folderId: string | null,
  folders: readonly FolderMeta[],
): FolderMeta[] {
  if (!folderId) return [];
  const byId = new Map(folders.map((f) => [f.folderId, f]));
  const folder = byId.get(folderId);
  if (!folder) return [];
  const trail = folder.ancestors
    .map((id) => byId.get(id))
    .filter((f): f is FolderMeta => Boolean(f));
  return [...trail, folder];
}

/** Folders a given folder may legally move into: not itself, not its subtree. */
export function validMoveTargets(
  folderId: string,
  folders: readonly FolderMeta[],
): FolderMeta[] {
  return folders.filter(
    (f) => f.folderId !== folderId && !f.ancestors.includes(folderId),
  );
}

// --- Documents -------------------------------------------------------------

export type SortKey = "recent" | "name" | "views" | "lastViewed";

/** Documents directly inside a folder, or at the root when null. */
export function docsInFolder(
  docs: readonly DocMeta[],
  folderId: string | null,
): DocMeta[] {
  return docs.filter((d) => (d.folderId ?? null) === folderId);
}

function millis(value: { toMillis?: () => number } | undefined): number {
  return value?.toMillis ? value.toMillis() : 0;
}

export function sortDocs(docs: readonly DocMeta[], key: SortKey): DocMeta[] {
  const list = docs.slice();
  switch (key) {
    case "name":
      return list.sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
      );
    case "views":
      return list.sort((a, b) => (b.stats?.views ?? 0) - (a.stats?.views ?? 0));
    case "lastViewed":
      return list.sort(
        (a, b) => millis(b.stats?.lastViewedAt) - millis(a.stats?.lastViewedAt),
      );
    default:
      return list.sort((a, b) => millis(b.updatedAt) - millis(a.updatedAt));
  }
}

/**
 * Client-side filter over a set that fits in memory.
 *
 * Deliberately not a search index. The workspace is one person's documents, and
 * an index would be a subsystem to keep in sync with the ACL — which is exactly
 * the kind of thing that leaks a title to somebody who cannot read the document.
 */
export function filterDocs(docs: readonly DocMeta[], queryText: string): DocMeta[] {
  const q = queryText.trim().toLowerCase();
  if (!q) return docs.slice();
  return docs.filter(
    (d) =>
      d.title.toLowerCase().includes(q) ||
      d.slug.toLowerCase().includes(q) ||
      d.ownerEmail.toLowerCase().includes(q),
  );
}

export function filterFolders(
  folders: readonly FolderMeta[],
  queryText: string,
): FolderMeta[] {
  const q = queryText.trim().toLowerCase();
  if (!q) return folders.slice();
  return folders.filter((f) => f.name.toLowerCase().includes(q));
}
