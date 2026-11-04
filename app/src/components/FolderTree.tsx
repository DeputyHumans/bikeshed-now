// SPDX-License-Identifier: Apache-2.0
// The folder rail (SPEC §13).

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "./Icon";
import { buildTree, flattenTree, pathToFolder } from "../workspace/tree";
import type { FolderMeta } from "../types";

/** Which page of the workspace is open, so the rail marks it and nothing else. */
export type WorkspacePage = "recent" | "everything" | "shared" | "trash" | "folder";

/** A rail entry that is a page rather than a folder. */
function PageLink({ to, icon, label, current }: { to: string; icon: "clock" | "team" | "doc" | "trash"; label: string; current: boolean }) {
  const navigate = useNavigate();
  return (
    <li className="folder-item">
      <button
        type="button"
        className="folder-link"
        aria-current={current ? "page" : undefined}
        onClick={() => navigate(to)}
      >
        <span className="folder-twisty" />
        <Icon name={icon} size={15} />
        <span className="folder-name">{label}</span>
      </button>
    </li>
  );
}

export function FolderTree({
  folders,
  currentFolderId,
  drawerOpen,
  page,
}: {
  folders: FolderMeta[];
  currentFolderId: string | null;
  drawerOpen?: boolean;
  page: WorkspacePage;
}) {
  const navigate = useNavigate();
  const tree = useMemo(() => buildTree(folders), [folders]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  /**
   * Auto-expand to the current folder.
   *
   * Uses the stored `ancestors` array rather than walking parents, so it is
   * correct even when an intermediate folder is not in this user's own list —
   * which happens whenever somebody is granted a nested folder without its
   * parent.
   */
  useEffect(() => {
    if (!currentFolderId) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of pathToFolder(currentFolderId, folders)) next.add(id);
      return next;
    });
  }, [currentFolderId, folders]);

  const rows = flattenTree(tree, expanded);

  return (
    <nav
      className="folder-rail"
      aria-label="Folders"
      data-drawer={drawerOpen ? "open" : undefined}
    >
      {/* Ways through everything at once, apart from the tree: neither is a
          folder, and under Everything they would read as if they were. */}
      <ul className="folder-tree folder-tree-head">
        <PageLink to="/" icon="clock" label="Recent" current={page === "recent"} />
        <PageLink to="/shared" icon="team" label="Shared with me" current={page === "shared"} />
      </ul>
      <ul className="folder-tree">
        <PageLink to="/everything" icon="doc" label="Everything" current={page === "everything"} />
        {rows.map((node) => {
          const id = node.folder.folderId;
          const hasChildren = node.children.length > 0;
          const isOpen = expanded.has(id);
          return (
            <li key={id} className="folder-item">
              <button
                type="button"
                className="folder-link"
                aria-current={page === "folder" && currentFolderId === id ? "page" : undefined}
                style={{ ["--folder-depth" as string]: node.depth }}
                onClick={() => navigate(`/folder/${id}`)}
              >
                <span
                  className="folder-twisty"
                  data-open={isOpen}
                  role={hasChildren ? "button" : undefined}
                  aria-label={hasChildren ? (isOpen ? "Collapse" : "Expand") : undefined}
                  onClick={(e) => {
                    if (!hasChildren) return;
                    // The twisty toggles; the row navigates. Without stopping
                    // propagation, expanding a folder would also open it.
                    e.stopPropagation();
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    });
                  }}
                >
                  {hasChildren ? <Icon name="chevron" size={13} /> : null}
                </span>
                <Icon name="folder" size={15} />
                <span className="folder-name">{node.folder.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {/* At the foot, apart from the folders: it is where things go, not one of them (SPEC §4). */}
      <ul className="folder-tree folder-tree-foot">
        <PageLink to="/trash" icon="trash" label="Trash" current={page === "trash"} />
      </ul>
    </nav>
  );
}
