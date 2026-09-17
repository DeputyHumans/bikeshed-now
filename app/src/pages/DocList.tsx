// SPDX-License-Identifier: Apache-2.0
// The workspace: folders, documents, and everything you can do to them (SPEC §5, §13).

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../auth";
import {
  formatRelative,
  listMyDocs,
  listMyFolders,
  listMyTeams,
  watchUser,
} from "../firestore";
import { createFolder, deleteFolder, duplicateDoc, renameItem } from "../folders";
import {
  docsInFolder,
  filterDocs,
  filterFolders,
  sortDocs,
  type SortKey,
} from "../workspace/tree";
import { useIsSingleColumn } from "../hooks/useMediaQuery";

import { Breadcrumb } from "../components/Breadcrumb";
import { FolderTree } from "../components/FolderTree";
import { Icon } from "../components/Icon";
import { Menu, type MenuEntry } from "../components/Menu";
import { MoveDialog } from "../components/MoveDialog";
import { SharePanel, type ShareTarget } from "../components/SharePanel";
import { UploadDialog } from "../components/UploadDialog";
import { CardSkeletons } from "../components/Spinner";
import { useToast } from "../components/Toast";
import { MARKING_OFF } from "../export/labels";
import type { DocMeta, FolderMeta, Marking, TeamMeta, UserRecord } from "../types";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Recently updated" },
  { value: "name", label: "Name" },
  { value: "views", label: "Most read" },
  { value: "lastViewed", label: "Recently read" },
];

function VisibilityChip({ doc }: { doc: DocMeta }) {
  const visibility = doc.visibility ?? "private";
  if (visibility === "private") return null;
  return (
    <span className="chip visibility-chip" data-visibility={visibility}>
      <Icon name={visibility === "public" ? "globe" : "eye"} size={12} />
      {visibility === "public" ? "Public" : "Link"}
    </span>
  );
}

function DocCard({
  doc,
  menu,
}: {
  doc: DocMeta;
  menu: MenuEntry[];
}) {
  return (
    <div className="doc-card">
      <div className="doc-card-head">
        <Link to={`/d/${doc.docId}`} className="doc-card-title">
          {doc.title}
        </Link>
        <span className="doc-card-menu">
          <Menu
            label={`Actions for ${doc.title}`}
            entries={menu}
            trigger={(props) => (
              <button {...props} type="button" className="icon-btn" aria-label="Actions">
                <Icon name="more" size={16} />
              </button>
            )}
          />
        </span>
      </div>
      <div className="doc-card-meta">
        <VisibilityChip doc={doc} />
        {doc.stats?.views ? (
          <span className="doc-card-stat numeric">
            <Icon name="eye" size={12} /> {doc.stats.views}
          </span>
        ) : null}
        {doc.stats?.apiReads ? (
          <span className="doc-card-stat numeric" title="Automated reads">
            <Icon name="key" size={12} /> {doc.stats.apiReads}
          </span>
        ) : null}
        <span className="doc-card-stat">{formatRelative(doc.updatedAt)}</span>
      </div>
    </div>
  );
}

export function DocList() {
  const { folderId = null } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, emailLower } = useAuth();
  const singleColumn = useIsSingleColumn();

  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [teams, setTeams] = useState<TeamMeta[]>([]);
  const [account, setAccount] = useState<UserRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [drawer, setDrawer] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sharing, setSharing] = useState<ShareTarget | null>(null);
  const [moving, setMoving] = useState<{
    kind: "doc" | "folder";
    id: string;
    title: string;
    folderId: string | null;
  } | null>(null);

  useEffect(() => {
    if (!emailLower) return;
    const stopDocs = listMyDocs(
      emailLower,
      (next) => {
        setDocs(next);
        setLoading(false);
      },
      (err) => {
        toast.error(err.message);
        setLoading(false);
      },
    );
    const stopFolders = listMyFolders(emailLower, setFolders, () => setFolders([]));
    const stopTeams = listMyTeams(emailLower, setTeams, () => setTeams([]));
    return () => {
      stopDocs();
      stopFolders();
      stopTeams();
    };
  }, [emailLower, toast]);

  useEffect(() => {
    if (!user) return;
    return watchUser(user.uid, setAccount);
  }, [user]);

  const visibleDocs = useMemo(() => {
    const scoped = search ? docs : docsInFolder(docs, folderId);
    return sortDocs(filterDocs(scoped, search), sort);
  }, [docs, folderId, search, sort]);

  const visibleFolders = useMemo(() => {
    const scoped = search
      ? folders
      : folders.filter((f) => (f.parentId ?? null) === folderId);
    return filterFolders(scoped, search).sort((a, b) => a.name.localeCompare(b.name));
  }, [folders, folderId, search]);

  const defaultMarking: Marking = account?.defaultMarking ?? MARKING_OFF;

  const docMenu = (doc: DocMeta): MenuEntry[] => {
    const isOwner = doc.ownerEmail === emailLower;
    return [
      { id: "open", label: "Open", onSelect: () => navigate(`/d/${doc.docId}`) },
      {
        id: "share",
        label: "Share…",
        disabled: !isOwner,
        reason: `Only ${doc.ownerEmail} can change sharing.`,
        onSelect: () =>
          setSharing({
            kind: "doc",
            id: doc.docId,
            title: doc.title,
            ownerEmail: doc.ownerEmail,
            viewers: doc.viewers,
            editors: doc.editors,
            members: doc.members,
          }),
      },
      {
        id: "rename",
        label: "Rename…",
        onSelect: () => {
          const name = window.prompt("New title", doc.title);
          if (name) void renameItem("doc", doc.docId, name).catch((e) => toast.error(e.message));
        },
      },
      {
        id: "move",
        label: "Move…",
        onSelect: () =>
          setMoving({
            kind: "doc",
            id: doc.docId,
            title: doc.title,
            folderId: doc.folderId ?? null,
          }),
      },
      {
        id: "duplicate",
        label: "Duplicate",
        onSelect: () =>
          void duplicateDoc(doc.docId, folderId)
            .then((copy) => navigate(`/d/${copy.docId}`))
            .catch((e) => toast.error(e.message)),
      },
      { id: "sep", separator: true },
      {
        id: "delete",
        label: "Deleting documents is not supported",
        disabled: true,
        // Stated rather than omitted. A missing option reads as an oversight;
        // a disabled one with a reason reads as a decision, which it is: this
        // is a review tool, and a version can be withdrawn through the admin
        // CLI with seven guards rather than by one misclick.
        reason:
          "A document is permanent by design. A single version can be withdrawn by a deployment operator.",
      },
    ];
  };

  const folderMenu = (folder: FolderMeta): MenuEntry[] => {
    const isOwner = folder.ownerEmail === emailLower;
    return [
      { id: "open", label: "Open", onSelect: () => navigate(`/folder/${folder.folderId}`) },
      {
        id: "share",
        label: "Share…",
        disabled: !isOwner,
        reason: `Only ${folder.ownerEmail} can change sharing.`,
        onSelect: () =>
          setSharing({
            kind: "folder",
            id: folder.folderId,
            title: folder.name,
            ownerEmail: folder.ownerEmail,
            viewers: folder.viewers,
            editors: folder.editors,
            members: folder.members,
          }),
      },
      {
        id: "rename",
        label: "Rename…",
        onSelect: () => {
          const name = window.prompt("New name", folder.name);
          if (name)
            void renameItem("folder", folder.folderId, name).catch((e) =>
              toast.error(e.message),
            );
        },
      },
      {
        id: "move",
        label: "Move…",
        onSelect: () =>
          setMoving({
            kind: "folder",
            id: folder.folderId,
            title: folder.name,
            folderId: folder.parentId,
          }),
      },
      { id: "sep", separator: true },
      {
        id: "delete",
        label: "Delete folder",
        danger: true,
        disabled: !isOwner,
        reason: `Only ${folder.ownerEmail} can delete this folder.`,
        onSelect: () => {
          // Worth confirming, and worth saying what actually happens: nothing
          // inside is lost, it moves up a level.
          if (
            !window.confirm(
              `Delete “${folder.name}”? Everything inside moves up one level — nothing is deleted.`,
            )
          ) {
            return;
          }
          void deleteFolder(folder.folderId).catch((e) => toast.error(e.message));
        },
      },
    ];
  };

  return (
    <div className="workspace">
      <FolderTree folders={folders} currentFolderId={folderId} drawerOpen={drawer} />

      <div>
        <Breadcrumb folderId={folderId} folders={folders} />

        <div className="workspace-toolbar">
          {singleColumn ? (
            <button
              type="button"
              className="btn btn-sm"
              aria-expanded={drawer}
              onClick={() => setDrawer((v) => !v)}
            >
              <Icon name="folder" size={15} /> Folders
            </button>
          ) : null}

          <label className="visually-hidden" htmlFor="workspace-search">
            Search
          </label>
          <input
            id="workspace-search"
            className="input workspace-search"
            type="search"
            placeholder="Search everything"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <label className="visually-hidden" htmlFor="workspace-sort">
            Sort
          </label>
          <select
            id="workspace-sort"
            className="toolbar-select"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          <span style={{ flex: 1 }} />

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              const name = window.prompt("Folder name");
              if (name)
                void createFolder(name, folderId).catch((e) => toast.error(e.message));
            }}
          >
            <Icon name="plus" size={15} /> Folder
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setUploading(true)}>
            <Icon name="download" size={15} /> Upload
          </button>
        </div>

        {loading ? (
          <CardSkeletons />
        ) : visibleDocs.length === 0 && visibleFolders.length === 0 ? (
          <div className="empty-state">
            {search ? (
              <p>Nothing matches “{search}”.</p>
            ) : (
              <>
                <h2>Nothing here yet</h2>
                <p>
                  {/* Worth saying on an empty workspace, because the alternative
                      is somebody concluding the share never arrived. */}
                  Upload a document to get started. Anything somebody shares with
                  your address appears here the moment they share it.
                </p>
                <button type="button" className="btn btn-primary" onClick={() => setUploading(true)}>
                  Upload a document
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="doc-grid">
            {visibleFolders.map((folder) => (
              <div key={folder.folderId} className="doc-card">
                <div className="doc-card-head">
                  <Link to={`/folder/${folder.folderId}`} className="doc-card-title">
                    <Icon name="folder" size={15} /> {folder.name}
                  </Link>
                  <span className="doc-card-menu">
                    <Menu
                      label={`Actions for ${folder.name}`}
                      entries={folderMenu(folder)}
                      trigger={(props) => (
                        <button {...props} type="button" className="icon-btn" aria-label="Actions">
                          <Icon name="more" size={16} />
                        </button>
                      )}
                    />
                  </span>
                </div>
                <div className="doc-card-meta">
                  <span className="doc-card-stat">
                    {folder.members.length}{" "}
                    {folder.members.length === 1 ? "person" : "people"}
                  </span>
                </div>
              </div>
            ))}
            {visibleDocs.map((doc) => (
              <DocCard key={doc.docId} doc={doc} menu={docMenu(doc)} />
            ))}
          </div>
        )}
      </div>

      {uploading ? (
        <UploadDialog
          folderId={folderId}
          accountDefaultMarking={defaultMarking}
          onClose={() => setUploading(false)}
          onUploaded={(result) => {
            setUploading(false);
            navigate(`/d/${result.docId}`);
          }}
        />
      ) : null}

      {sharing ? (
        <SharePanel
          target={sharing}
          teams={teams}
          isOwner={sharing.ownerEmail === emailLower}
          onClose={() => setSharing(null)}
          onChanged={() => {}}
        />
      ) : null}

      {moving ? (
        <MoveDialog
          kind={moving.kind}
          id={moving.id}
          title={moving.title}
          currentFolderId={moving.folderId}
          folders={folders}
          onClose={() => setMoving(null)}
          onMoved={() => setMoving(null)}
        />
      ) : null}
    </div>
  );
}
