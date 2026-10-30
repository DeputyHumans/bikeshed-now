// SPDX-License-Identifier: Apache-2.0
// The Trash: what this account moved there, where it came from, and Restore (SPEC §4).

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { formatRelative, formatTimestamp, listMyFolders, listMyTrash } from "../firestore";
import { restoreItem, type OrganizeKind } from "../folders";
import { trashedFrom } from "../trash";
import { FolderTree } from "../components/FolderTree";
import { Icon } from "../components/Icon";
import { Loading } from "../components/Spinner";
import { useToast } from "../components/Toast";
import type { DocMeta, FolderMeta, TrashMark } from "../types";

/**
 * Everything here is this account's own: a trashed item's members are its
 * owner alone, so the workspace's own queries bring back nothing else
 * (`listMyTrash`). Someone else's document that went with a folder of this
 * account's is in their Trash, not here.
 *
 * A document opens, read-only, so its owner can see what it was before
 * restoring it. A folder does not: what was in it is listed beside it, and
 * its page would be a folder nobody else can see.
 */

interface Row {
  kind: OrganizeKind;
  id: string;
  title: string;
  at: TrashMark["at"];
  from: string | null;
}

export function Trash() {
  const { emailLower } = useAuth();
  const toast = useToast();
  const [trash, setTrash] = useState<{ docs: DocMeta[]; folders: FolderMeta[] } | null>(null);
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    if (!emailLower) return;
    const stopTrash = listMyTrash(emailLower, setTrash, (err) => toast.error(err.message));
    const stopFolders = listMyFolders(emailLower, setFolders, () => setFolders([]));
    return () => {
      stopTrash();
      stopFolders();
    };
  }, [emailLower, toast]);

  const rows = useMemo<Row[]>(() => {
    if (!trash) return [];
    const names = new Map(folders.map((f) => [f.folderId, f.name]));
    const name = (id: string) => names.get(id) ?? null;
    const all: Row[] = [
      ...trash.folders.map((f) => ({ kind: "folder" as const, id: f.folderId, title: f.name, at: f.trashed?.at ?? null, from: trashedFrom(f, name) })),
      ...trash.docs.map((d) => ({ kind: "doc" as const, id: d.docId, title: d.title, at: d.trashed?.at ?? null, from: trashedFrom(d, name) })),
    ];
    return all.sort((a, b) => (b.at?.toMillis?.() ?? 0) - (a.at?.toMillis?.() ?? 0));
  }, [trash, folders]);

  const restore = (row: Row) => {
    setRestoring(row.id);
    void toast
      .during("Restoring…", restoreItem(row.kind, row.id))
      .then(() => toast.show(`“${row.title}” is back where it was, with its sharing.`))
      .catch((e) => toast.error(e.message))
      .finally(() => setRestoring(null));
  };

  return (
    <div className="workspace">
      <FolderTree folders={folders} currentFolderId={null} inTrash />
      <div className="workspace-main">
        <div className="workspace-head">
          <h1 className="trash-title">Trash</h1>
        </div>
        <p className="field-hint trash-hint">
          What you move here is yours alone and read-only: its links and its sharing stop working until you restore it, and Restore gives them back. Nothing here is deleted.
        </p>
        {trash === null ? (
          <Loading label="Opening the Trash" />
        ) : rows.length === 0 ? (
          <p className="empty-state">Your Trash is empty.</p>
        ) : (
          <ul className="trash-list">
            {rows.map((row) => (
              <li key={`${row.kind}:${row.id}`} className="trash-row">
                <Icon name={row.kind === "folder" ? "folder" : "doc"} size={16} />
                <span className="trash-name">
                  {row.kind === "doc" ? <Link to={`/d/${row.id}`}>{row.title}</Link> : <strong>{row.title}</strong>}
                  <span className="caption">
                    {row.kind === "folder" ? "Folder, with everything in it" : "Document"}
                    {row.from ? ` · ${row.from}` : ""}
                  </span>
                </span>
                <span className="caption trash-when" title={formatTimestamp(row.at)}>
                  {formatRelative(row.at)}
                </span>
                <button type="button" className="btn btn-sm" disabled={restoring === row.id} onClick={() => restore(row)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
