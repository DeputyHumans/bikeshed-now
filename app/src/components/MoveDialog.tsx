// SPDX-License-Identifier: Apache-2.0
// Move a document or folder (SPEC §13).

import { useMemo, useState } from "react";
import { Modal } from "./Modal";
import { useToast } from "./Toast";
import { moveItem, type OrganizeKind } from "../folders";
import { buildTree, flattenTree, validMoveTargets } from "../workspace/tree";
import type { FolderMeta } from "../types";

export function MoveDialog({
  kind,
  id,
  title,
  currentFolderId,
  folders,
  onClose,
  onMoved,
}: {
  kind: OrganizeKind;
  id: string;
  title: string;
  currentFolderId: string | null;
  folders: FolderMeta[];
  onClose: () => void;
  onMoved: (folderId: string | null) => void;
}) {
  const toast = useToast();
  const [target, setTarget] = useState<string | null>(currentFolderId);
  const [busy, setBusy] = useState(false);

  /**
   * A folder cannot move into itself or its own subtree.
   *
   * The server refuses it too — that check is the real one — but offering the
   * option and then rejecting it teaches people the interface is unreliable.
   */
  const candidates = useMemo(() => {
    const allowed = kind === "folder" ? validMoveTargets(id, folders) : folders;
    const allowedIds = new Set(allowed.map((f) => f.folderId));
    return flattenTree(
      buildTree(folders),
      new Set(folders.map((f) => f.folderId)),
    ).filter((node) => allowedIds.has(node.folder.folderId));
  }, [kind, id, folders]);

  const move = async () => {
    setBusy(true);
    try {
      await moveItem(kind, id, target);
      onMoved(target);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Move “${title}”`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || target === currentFolderId}
            onClick={() => void move()}
          >
            Move
          </button>
        </>
      }
    >
      <ul className="folder-tree" role="listbox" aria-label="Destination">
        <li>
          <button
            type="button"
            className="folder-link"
            role="option"
            aria-selected={target === null}
            aria-current={target === null ? "page" : undefined}
            onClick={() => setTarget(null)}
          >
            Everything (no folder)
          </button>
        </li>
        {candidates.map((node) => (
          <li key={node.folder.folderId}>
            <button
              type="button"
              className="folder-link"
              role="option"
              aria-selected={target === node.folder.folderId}
              aria-current={target === node.folder.folderId ? "page" : undefined}
              style={{ ["--folder-depth" as string]: node.depth }}
              onClick={() => setTarget(node.folder.folderId)}
            >
              <span className="folder-name">{node.folder.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="field-hint" style={{ marginTop: "var(--s-3)" }}>
        {/* The consequence people do not expect, so it is said before the move
            rather than discovered after it. */}
        Moving changes who can see this: a folder's readers can read everything
        inside it.
      </p>
    </Modal>
  );
}
