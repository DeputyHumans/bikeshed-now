// SPDX-License-Identifier: Apache-2.0
// The workspace: folders, documents, and everything you can do to them (SPEC §5, §13).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../auth";
import {
  formatRelative,
  listMyDocs,
  listMyFolders,
  listMyTeams,
  watchUser,
} from "../firestore";
import { createFolder, deleteFolder, renameItem } from "../folders";
import { forkDoc } from "../forks";
import {
  docsInFolder,
  filterDocs,
  filterFolders,
  sortDocs,
  type SortKey,
} from "../workspace/tree";
import { useIsSingleColumn } from "../hooks/useMediaQuery";
import { useFileDrop } from "../hooks/useFileDrop";
import { UPLOAD_HINT, isUploadable, uploadDoc } from "../upload";
import { logEvent } from "../analytics";

import { Breadcrumb } from "../components/Breadcrumb";
import { FolderTree } from "../components/FolderTree";
import { Icon } from "../components/Icon";
import { Menu, type MenuEntry } from "../components/Menu";
import { MoveDialog } from "../components/MoveDialog";
import { ExpiryChip } from "../components/ExpiryChip";
import { SharePanel, type ShareTarget } from "../components/SharePanel";
import { folderVisibilityStateOf, liveReach, visibilityStateOf, type VisibilityState } from "../visibility";
import { SharedFolder } from "./SharedFolder";
import { UploadDialog } from "../components/UploadDialog";
import { UploadVersionDialog, versionUploadMessage } from "../components/UploadVersionDialog";
import { offersVersionUpload } from "../roles";
import { CardSkeletons } from "../components/Spinner";
import { coverUrl } from "../thumbs";
import { useCoverBackfill } from "../hooks/useCoverBackfill";
import { isExpired } from "../expiry";
import { useToast } from "../components/Toast";
import { MARKING_OFF } from "../export/labels";
import type { DocMeta, FolderMeta, Marking, TeamMeta, UserRecord } from "../types";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Recently updated" },
  { value: "name", label: "Name" },
  { value: "views", label: "Most read" },
  { value: "lastViewed", label: "Recently read" },
];

/**
 * The level a stranger meets: the record's own, or a folder's above it that
 * has not ended, whichever reaches further (SPEC §17 "A folder's reach"). A
 * private document in a public folder is public, and the card must not say
 * otherwise.
 */
function VisibilityChip({ own, through }: { own?: DocMeta["visibility"]; through?: "unlisted" | "public" | null }) {
  const mine = own ?? "private";
  const visibility = mine === "public" || through === "public" ? "public" : mine === "unlisted" || through ? "unlisted" : "private";
  if (visibility === "private") return null;
  const inherited = visibility !== mine;
  return (
    <span
      className="chip visibility-chip"
      data-visibility={visibility}
      title={inherited ? "Through a folder it is in" : undefined}
    >
      <Icon name={visibility === "public" ? "globe" : "eye"} size={12} />
      {visibility === "public" ? "Public" : "Link"}
    </span>
  );
}

function DocCard({
  doc,
  through,
  menu,
  onShare,
  showCover,
}: {
  doc: DocMeta;
  /** The level its folder's reach gives it, when the folder is one this account can read. */
  through: "unlisted" | "public" | null;
  menu: MenuEntry[];
  /** The owner's way to the date behind the expiry chip; absent for anyone else. */
  onShare?: () => void;
  /** False for an expired document read by anyone but its owner (SPEC §17). */
  showCover: boolean;
}) {
  const cover = showCover ? coverUrl(doc.docId, doc.thumb) : null;
  return (
    <div className="doc-card">
      {/* The same destination as the title, for a pointer. The title is the
          link a keyboard and a screen reader use, so this is neither a tab
          stop nor announced. The image is whatever version an editor last
          captured, which can trail the head until one opens it again. */}
      <Link
        to={`/d/${doc.docId}`}
        className="doc-card-thumb"
        tabIndex={-1}
        aria-hidden="true"
      >
        {cover ? (
          <img src={cover} alt="" loading="lazy" decoding="async" />
        ) : (
          <Icon name="doc" size={22} />
        )}
      </Link>
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
        <VisibilityChip own={doc.visibility} through={through} />
        {/* A fork usually carries its original's title, so in a list that
            holds both, this mark is what tells them apart. */}
        {doc.forked ? (
          <span className="chip" title="Forked from another document">
            <Icon name="fork" size={12} />
            Fork
          </span>
        ) : null}
        {/* Shown for every document that has a date, not only the expired
            ones: a workspace is where somebody notices that a document goes
            away next Tuesday, and the only place they would without opening
            it. */}
        <ExpiryChip expiresAt={doc.expiresAt} onOpen={onShare} />
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
        {doc.stats?.forks ? (
          <span
            className="doc-card-stat numeric"
            title={`Forked ${doc.stats.forks === 1 ? "once" : `${doc.stats.forks} times`}`}
          >
            <Icon name="fork" size={12} /> {doc.stats.forks}
          </span>
        ) : null}
        <span className="doc-card-stat">{formatRelative(doc.updatedAt)}</span>
      </div>
    </div>
  );
}

/**
 * A folder you can drop onto.
 *
 * Its own component because a hook cannot live in a loop, and its own drop zone
 * because dropping a file "somewhere in the workspace" and dropping it "on that
 * folder" are different intentions and should not both mean the former.
 */
function FolderCard({
  folder,
  menu,
  onFiles,
  onShare,
}: {
  folder: FolderMeta;
  menu: MenuEntry[];
  onFiles: (files: File[], folderId: string) => void;
  /** The owner's way to the date behind the chip; absent for anyone else. */
  onShare?: () => void;
}) {
  const drop = useFileDrop(
    useCallback((files: File[]) => onFiles(files, folder.folderId), [onFiles, folder.folderId]),
  );
  return (
    <div className="doc-card" data-drop-over={drop.over || undefined} {...drop.handlers}>
      <div className="doc-card-head">
        <Link to={`/folder/${folder.folderId}`} className="doc-card-title">
          <Icon name="folder" size={15} /> {folder.name}
        </Link>
        <span className="doc-card-menu">
          <Menu
            label={`Actions for ${folder.name}`}
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
        <VisibilityChip own={folder.visibility} through={liveReach(folder)} />
        {folder.visibility && folder.visibility !== "private" ? (
          <ExpiryChip expiresAt={folder.expiresAt ?? null} onOpen={onShare} of="folder" />
        ) : null}
        <span className="doc-card-stat">
          {folder.members.length} {folder.members.length === 1 ? "person" : "people"}
        </span>
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
  // Folders arrive on their own listener. Until they have, a workspace holding
  // only folders would be announced as empty.
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [drawer, setDrawer] = useState(false);
  const [uploading, setUploading] = useState(false);
  // A document brings its visibility triple along; a folder its level and date.
  const [sharing, setSharing] = useState<{
    target: ShareTarget;
    visibility?: VisibilityState;
  } | null>(null);
  const [moving, setMoving] = useState<{
    kind: "doc" | "folder";
    id: string;
    title: string;
    folderId: string | null;
  } | null>(null);
  /** The document a new version is being uploaded to, by id: read live from the list. */
  const [revising, setRevising] = useState<string | null>(null);
  /** `{ done, total, fraction }` while a dropped batch is in flight. */
  const [dropping, setDropping] = useState<{
    done: number;
    total: number;
    fraction: number;
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
    const stopFolders = listMyFolders(
      emailLower,
      (next) => {
        setFolders(next);
        setFoldersLoading(false);
      },
      () => {
        setFolders([]);
        setFoldersLoading(false);
      },
    );
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

  const defaultMarkingRef = useRef(MARKING_OFF as Marking);
  defaultMarkingRef.current = account?.defaultMarking ?? MARKING_OFF;

  /**
   * Upload dropped files where they landed.
   *
   * No dialog: everything the dialog collects is already determined by the
   * drop. The title comes from the filename exactly as the dialog derives it,
   * the marking from the account default exactly as the dialog seeds it, and
   * the folder from what was dropped on. Asking again would be asking somebody
   * to confirm what they just did.
   *
   * Sequential rather than parallel, because each upload streams a whole bundle
   * and the progress figure has to mean something. The list is live, so each
   * document appears as it lands.
   */
  const uploadFiles = useCallback(
    async (files: File[], target: string | null) => {
      const usable = files.filter(isUploadable);
      const rejected = files.length - usable.length;
      if (rejected > 0) {
        toast.error(
          `${UPLOAD_HINT}. ${rejected === files.length ? "That is not one of those." : `${rejected} of those are not.`}`,
        );
      }
      if (usable.length === 0) return;

      let done = 0;
      setDropping({ done: 0, total: usable.length, fraction: 0 });
      for (const file of usable) {
        try {
          const result = await uploadDoc(file, {
            title: file.name.replace(/\.[^.]+$/, "") || undefined,
            folderId: target,
            marking: defaultMarkingRef.current,
            onProgress: (fraction) =>
              setDropping({ done, total: usable.length, fraction }),
          });
          logEvent({ name: "doc_publish", params: { source: "upload", format: result.format } });
          // Staying put is what makes dropping several files work, so the way
          // to the document is offered rather than taken.
          toast.show(`Uploaded ${result.title}.`, {
            label: "Open",
            onSelect: () => navigate(`/d/${result.docId}`),
          });
        } catch (e) {
          toast.error(`${file.name}: ${(e as Error).message}`);
        }
        done += 1;
        setDropping({ done, total: usable.length, fraction: 0 });
      }
      setDropping(null);
    },
    [navigate, toast],
  );

  const workspaceDrop = useFileDrop(
    useCallback((files: File[]) => void uploadFiles(files, folderId), [uploadFiles, folderId]),
    dropping === null,
  );

  const visibleDocs = useMemo(() => {
    const scoped = search ? docs : docsInFolder(docs, folderId);
    return sortDocs(filterDocs(scoped, search), sort);
  }, [docs, folderId, search, sort]);

  // Covers nobody has captured yet are filled in here, for the cards on
  // screen, by an editor's browser. The viewer captures on open; this is for
  // every document nobody has opened since (SPEC §6d).
  useCoverBackfill(visibleDocs, emailLower ?? "");

  const currentFolderName = useMemo(
    () => folders.find((f) => f.folderId === folderId)?.name ?? "Everything",
    [folders, folderId],
  );

  const visibleFolders = useMemo(() => {
    const scoped = search
      ? folders
      : folders.filter((f) => (f.parentId ?? null) === folderId);
    return filterFolders(scoped, search).sort((a, b) => a.name.localeCompare(b.name));
  }, [folders, folderId, search]);

  const defaultMarking: Marking = account?.defaultMarking ?? MARKING_OFF;

  const shareDoc = (doc: DocMeta) =>
    setSharing({
      target: {
        kind: "doc",
        id: doc.docId,
        title: doc.title,
        ownerEmail: doc.ownerEmail,
        viewers: doc.viewers,
        editors: doc.editors,
        suggesters: doc.suggesters,
        approvers: doc.approvers,
        members: doc.members,
      },
      visibility: visibilityStateOf(doc),
    });

  const shareFolder = (folder: FolderMeta) =>
    setSharing({
      target: {
        kind: "folder",
        id: folder.folderId,
        title: folder.name,
        ownerEmail: folder.ownerEmail,
        viewers: folder.viewers,
        editors: folder.editors,
        suggesters: folder.suggesters,
        approvers: folder.approvers,
        members: folder.members,
      },
      visibility: folderVisibilityStateOf(folder),
    });

  const folderById = useMemo(() => new Map(folders.map((f) => [f.folderId, f])), [folders]);

  /**
   * Filing is sharing, and filing under a shared folder is sharing with
   * strangers (SPEC §13). Nobody is emailed, so this is where the person who
   * filed it finds out.
   */
  const sayWhoCanReadNow = (kind: "doc" | "folder", title: string, target: string | null) => {
    const reach = liveReach(target ? folderById.get(target) : undefined);
    if (!reach) return;
    const who = reach === "public" ? "anyone" : "anyone with its link";
    toast.show(
      kind === "doc"
        ? `“${title}” can now be read by ${who}, through the folder it is in.`
        : `Everything in “${title}” can now be read by ${who}, through the folder it is in.`,
    );
  };

  const revisingDoc = revising ? (docs.find((d) => d.docId === revising) ?? null) : null;

  const docMenu = (doc: DocMeta): MenuEntry[] => {
    const isOwner = doc.ownerEmail === emailLower;
    return [
      { id: "open", label: "Open", onSelect: () => navigate(`/d/${doc.docId}`) },
      {
        id: "share",
        label: "Share…",
        disabled: !isOwner,
        reason: `Only ${doc.ownerEmail} can change sharing.`,
        onSelect: () => shareDoc(doc),
      },
      {
        id: "rename",
        label: "Rename…",
        onSelect: () => {
          const name = window.prompt("New title", doc.title);
          if (name)
            void toast
              .during("Renaming…", renameItem("doc", doc.docId, name))
              .catch((e) => toast.error(e.message));
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
      // Only to the real editor set, as the server asks (SPEC §2); hidden
      // rather than disabled, as the viewer's menu does, since a reader was
      // never going to publish here.
      ...(offersVersionUpload(doc, emailLower)
        ? [{ id: "upload-version", label: "Upload a new version…", onSelect: () => setRevising(doc.docId) }]
        : []),
      {
        // One click, into the folder being looked at, and straight into the
        // fork: renaming and moving it are the two items above (SPEC §21).
        id: "fork",
        label: "Fork",
        onSelect: () =>
          void toast
            .during("Forking…", forkDoc(doc.docId, { folderId }))
            .then((fork) => navigate(`/d/${fork.docId}`))
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
        onSelect: () => shareFolder(folder),
      },
      {
        id: "rename",
        label: "Rename…",
        onSelect: () => {
          const name = window.prompt("New name", folder.name);
          if (name)
            void toast
              .during("Renaming…", renameItem("folder", folder.folderId, name))
              .catch((e) => toast.error(e.message));
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
          // The server moves the contents up before it removes the folder, so
          // for a moment both are on screen; saying so keeps that from looking
          // like a glitch.
          void toast
            .during("Deleting the folder…", deleteFolder(folder.folderId))
            .catch((e) => toast.error(e.message));
        },
      },
    ];
  };

  // A folder this account is not a member of: its link may still open it,
  // read-only, exactly as it would for somebody signed out (SPEC §17).
  if (folderId && !foldersLoading && !folderById.has(folderId)) return <SharedFolder />;

  return (
    <div className="workspace">
      <FolderTree folders={folders} currentFolderId={folderId} drawerOpen={drawer} />

      {/* The drop zone is the whole column, not just the grid: "free space" on
          a workspace with two documents in it is mostly below them. */}
      <div
        className="workspace-main"
        data-drop-over={workspaceDrop.over || undefined}
        {...workspaceDrop.handlers}
      >
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
            disabled={creatingFolder}
            aria-busy={creatingFolder}
            onClick={() => {
              const name = window.prompt("Folder name");
              if (!name) return;
              setCreatingFolder(true);
              void createFolder(name, folderId)
                .catch((e) => toast.error(e.message))
                .finally(() => setCreatingFolder(false));
            }}
          >
            <Icon name="plus" size={15} /> Folder
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setUploading(true)}>
            <Icon name="upload" size={15} /> Upload
          </button>
        </div>

        {loading || foldersLoading ? (
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
          <>
            {/* Two grids, not one: a folder has no cover, and in a row with
                documents that do it would stretch to their height and stand
                mostly empty. */}
            {visibleFolders.length > 0 ? (
              <div className="doc-grid">
                {visibleFolders.map((folder) => (
                  <FolderCard
                    key={folder.folderId}
                    folder={folder}
                    menu={folderMenu(folder)}
                    onFiles={uploadFiles}
                    onShare={folder.ownerEmail === emailLower ? () => shareFolder(folder) : undefined}
                  />
                ))}
              </div>
            ) : null}
            {visibleDocs.length > 0 ? (
              <div className="doc-grid">
                {visibleDocs.map((doc) => {
                  const isOwner = doc.ownerEmail === emailLower;
                  return (
                    <DocCard
                      key={doc.docId}
                      doc={doc}
                      through={liveReach(doc.folderId ? folderById.get(doc.folderId) : undefined)}
                      menu={docMenu(doc)}
                      onShare={isOwner ? () => shareDoc(doc) : undefined}
                      showCover={isOwner || !isExpired(doc.expiresAt)}
                    />
                  );
                })}
              </div>
            ) : null}
          </>
        )}
      </div>

      {workspaceDrop.over ? (
        <div className="drop-hint" role="status">
          <Icon name="upload" size={18} />
          Drop to upload into {currentFolderName}
        </div>
      ) : null}

      {dropping ? (
        <div className="drop-hint" role="status" aria-live="polite">
          <span className="spinner" />
          Uploading {dropping.done + 1} of {dropping.total}
          <span className="upload-progress">
            <span
              className="upload-progress-bar"
              style={{ width: `${Math.round(dropping.fraction * 100)}%` }}
            />
          </span>
        </div>
      ) : null}

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

      {revisingDoc ? (
        <UploadVersionDialog
          docId={revisingDoc.docId}
          title={revisingDoc.title}
          headVersion={revisingDoc.currentVersion}
          // Missing means trusted (SPEC §6c).
          trusted={revisingDoc.trusted !== false}
          draftBy={revisingDoc.draft?.updatedByEmail ?? null}
          onClose={() => setRevising(null)}
          onPublished={(result) => {
            setRevising(null);
            toast.show(versionUploadMessage(result), {
              label: "Open",
              onSelect: () => navigate(`/d/${result.docId}`),
            });
          }}
        />
      ) : null}

      {sharing ? (
        <SharePanel
          target={sharing.target}
          teams={teams}
          isOwner={sharing.target.ownerEmail === emailLower}
          visibility={sharing.visibility}
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
          onMoved={(target) => {
            setMoving(null);
            sayWhoCanReadNow(moving.kind, moving.title, target);
          }}
        />
      ) : null}
    </div>
  );
}
