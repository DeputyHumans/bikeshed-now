// SPDX-License-Identifier: Apache-2.0
// The folder rail (SPEC §13).

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "./Icon";
import { buildTree, flattenTree, pathToFolder } from "../workspace/tree";
import type { FolderMeta } from "../types";

export function FolderTree({
  folders,
  currentFolderId,
  drawerOpen,
  inTrash = false,
}: {
  folders: FolderMeta[];
  currentFolderId: string | null;
  drawerOpen?: boolean;
  /** The Trash page is open, so neither Everything nor a folder is the current one. */
  inTrash?: boolean;
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
      <ul className="folder-tree">
        <li className="folder-item">
          <button
            type="button"
            className="folder-link"
            aria-current={currentFolderId === null && !inTrash ? "page" : undefined}
            onClick={() => navigate("/")}
          >
            <span className="folder-twisty" />
            <Icon name="doc" size={15} />
            <span className="folder-name">Everything</span>
          </button>
        </li>
        {rows.map((node) => {
          const id = node.folder.folderId;
          const hasChildren = node.children.length > 0;
          const isOpen = expanded.has(id);
          return (
            <li key={id} className="folder-item">
              <button
                type="button"
                className="folder-link"
                aria-current={currentFolderId === id ? "page" : undefined}
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
        <li className="folder-item">
          <button
            type="button"
            className="folder-link"
            aria-current={inTrash ? "page" : undefined}
            onClick={() => navigate("/trash")}
          >
            <span className="folder-twisty" />
            <Icon name="trash" size={15} />
            <span className="folder-name">Trash</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
