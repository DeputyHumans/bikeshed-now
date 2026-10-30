// SPDX-License-Identifier: Apache-2.0
// The Trash: what this account moved there, where it came from, Restore, and Delete forever (SPEC §4).

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { formatDay } from "../expiry";
import { formatRelative, formatTimestamp, listMyDocs, listMyFolders } from "../firestore";
import { type OrganizeKind } from "../folders";
import { UNKNOWN_AVAILABILITY, deletesOn, purgeAvailability, targetFor, type PurgeAvailability, type PurgeTarget } from "../purge";
import { isTrashed, trashedFrom } from "../trash";
import { restoreFromTrash } from "../trashActions";
import { FolderTree } from "../components/FolderTree";
import { Icon } from "../components/Icon";
import { PurgeDialog } from "../components/PurgeDialog";
import { Loading } from "../components/Spinner";
import { useToast } from "../components/Toast";
import type { DocMeta, FolderMeta, TrashMark } from "../types";

/**
 * Everything here is this account's own: a trashed item's members are its
 * owner alone, so the workspace's own queries bring back nothing else
 * (`listMyDocs` and `listMyFolders` with a `Listing`). Someone else's
 * document that went with a folder of this account's is in their Trash, not
 * here.
 *
 * A document opens, read-only, so its owner can see what it was before
 * restoring it. A folder does not: what was in it is listed beside it, and
 * its page would be a folder nobody else can see.
 *
 * Each row says when the Trash deletes it itself, 30 days after it arrived.
 * Delete forever and Empty trash are there only where the deployment's email
 * is on, because each needs a code sent to the account (`PurgeDialog`); where
 * it is off the page says the Trash empties itself, and offers nothing it
 * cannot do. Rows leave as the deletion lands, through the same listings.
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
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  // Every folder the account can see, the trashed ones included: one
  // subscription for the rail, the names a row says it came from, and the
  // folders in the Trash themselves.
  const [allFolders, setAllFolders] = useState<FolderMeta[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [purge, setPurge] = useState<PurgeAvailability>(UNKNOWN_AVAILABILITY);
  const [deleting, setDeleting] = useState<{ target: PurgeTarget; what: string } | null>(null);

  useEffect(() => {
    let live = true;
    purgeAvailability()
      .then((a) => live && setPurge(a))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!emailLower) return;
    const stopDocs = listMyDocs(emailLower, setDocs, (err) => toast.error(err.message), "trash");
    const stopFolders = listMyFolders(emailLower, setAllFolders, () => setAllFolders([]), "all");
    return () => {
      stopDocs();
      stopFolders();
    };
  }, [emailLower, toast]);

  const folders = useMemo(() => (allFolders ?? []).filter((f) => !isTrashed(f)), [allFolders]);
  const rows = useMemo<Row[] | null>(() => {
    if (!docs || !allFolders) return null;
    const names = new Map(folders.map((f) => [f.folderId, f.name]));
    const name = (id: string) => names.get(id) ?? null;
    const all: Row[] = [
      ...allFolders.filter(isTrashed).map((f) => ({ kind: "folder" as const, id: f.folderId, title: f.name, at: f.trashed?.at ?? null, from: trashedFrom(f, name) })),
      ...docs.map((d) => ({ kind: "doc" as const, id: d.docId, title: d.title, at: d.trashed?.at ?? null, from: trashedFrom(d, name) })),
    ];
    return all.sort((a, b) => (b.at?.toMillis?.() ?? 0) - (a.at?.toMillis?.() ?? 0));
  }, [docs, allFolders, folders]);

  const restore = (row: Row) => {
    setRestoring(row.id);
    void restoreFromTrash(toast, row.kind, row.id, row.title).finally(() => setRestoring(null));
  };
  const deleteRow = (row: Row) =>
    setDeleting({ target: targetFor(row.kind, row.id), what: row.kind === "folder" ? `The folder “${row.title}” and what of yours went with it` : `“${row.title}”` });
  const deletesWhen = (row: Row) => {
    const day = deletesOn(row.at?.toMillis?.() ?? null, purge.retentionDays);
    return day ? ` · deleted forever on ${formatDay(day.getTime())}` : "";
  };

  return (
    <div className="workspace">
      <FolderTree folders={folders} currentFolderId={null} inTrash />
      <div className="workspace-main">
        <div className="workspace-head">
          <h1 className="trash-title">Trash</h1>
          {purge.available && rows && rows.length > 0 ? (
            <div className="workspace-head-actions">
              <button type="button" className="btn btn-sm btn-quiet trash-delete" onClick={() => setDeleting({ target: { all: true }, what: "Everything in your Trash" })}>
                Empty trash
              </button>
            </div>
          ) : null}
        </div>
        <p className="field-hint trash-hint">
          What you move here is yours alone and read-only: its links and its sharing stop working until you restore it, and Restore gives them back. Anything still here {purge.retentionDays} days after it arrived is deleted forever{purge.available ? ", or sooner if you delete it yourself" : ""}.
        </p>
        {rows === null ? (
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
                    {deletesWhen(row)}
                  </span>
                </span>
                <span className="caption trash-when" title={formatTimestamp(row.at)}>
                  {formatRelative(row.at)}
                </span>
                <span className="trash-actions">
                  <button type="button" className="btn btn-sm" disabled={restoring === row.id} onClick={() => restore(row)}>
                    Restore
                  </button>
                  {purge.available ? (
                    <button type="button" className="btn btn-sm btn-quiet trash-delete" onClick={() => deleteRow(row)}>
                      Delete forever
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {deleting ? (
        <PurgeDialog
          target={deleting.target}
          what={deleting.what}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            toast.show("Deleted forever.");
          }}
        />
      ) : null}
    </div>
  );
}
