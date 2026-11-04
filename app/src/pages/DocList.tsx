// SPDX-License-Identifier: Apache-2.0
// The workspace: folders, documents, and everything you can do to them (SPEC §5, §13).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../auth";
import {
  listMyDocs,
  listMyFolders,
  listMyReading,
  listMyTeams,
  watchUser,
} from "../firestore";
import { viaOf } from "../provenance";
import { createFolder, renameItem } from "../folders";
import { moveToTrash } from "../trashActions";
import { forkDoc } from "../forks";
import {
  currentSummary,
  docsInFolder,
  filterDocs,
  filterFolders,
  isSortKey,
  locationOf,
  sortDocs,
  type SortKey,
} from "../workspace/tree";
import { PREF_KEYS, isLayout, useRemembered, type Layout, type PrefKey } from "../workspace/prefs";
import {
  NO_FILTERS,
  RECENT_READS_LIMIT,
  filterRecent,
  isRecentFilters,
  recentRows,
  type RecentFilters,
  type RecentRow,
} from "../workspace/recent";
import { useIsSingleColumn } from "../hooks/useMediaQuery";
import { useFileDrop } from "../hooks/useFileDrop";
import { UPLOAD_HINT, isUploadable, uploadDoc } from "../upload";
import { logEvent } from "../analytics";

import { Breadcrumb } from "../components/Breadcrumb";
import { FolderTree, type WorkspacePage } from "../components/FolderTree";
import { Icon } from "../components/Icon";
import { UpdatedLine } from "../components/UpdatedLine";
import { Menu, type MenuEntry } from "../components/Menu";
import { MoreMenu } from "../components/MoreMenu";
import { MoveDialog } from "../components/MoveDialog";
import { ExpiryChip } from "../components/ExpiryChip";
import { SharePanel, type ShareTarget } from "../components/SharePanel";
import {
  DocRow,
  DocTable,
  FolderRow,
  LayoutToggle,
  RecentReason,
  UNREADABLE_FOLDER,
  VisibilityChip,
} from "../components/WorkspaceList";
import { folderVisibilityStateOf, liveReach, visibilityStateOf, type VisibilityState } from "../visibility";
import { SharedFolder } from "./SharedFolder";
import { UploadDialog } from "../components/UploadDialog";
import { UploadVersionDialog, versionUploadMessage } from "../components/UploadVersionDialog";
import { offersVersionUpload } from "../roles";
import { CardSkeletons, RowSkeletons } from "../components/Spinner";
import { coverUrl } from "../thumbs";
import { useCoverBackfill } from "../hooks/useCoverBackfill";
import { isExpired } from "../expiry";
import { useToast } from "../components/Toast";
import { DEPLOYMENT_MARKING } from "../config";
import type { DocMeta, FolderMeta, Marking, TeamMeta, UserRecord } from "../types";

/** The kinds of page this one component serves (SPEC §13). */
export type WorkspaceView = "recent" | "everything" | "shared" | "folder";

/** Each kind's own remembered layout, and where it starts before anyone chooses. */
const LAYOUT: Record<WorkspaceView, { key: PrefKey; initial: Layout }> = {
  // Recent and Shared span folders and are about time and people: rows.
  recent: { key: PREF_KEYS.layoutRecent, initial: "list" },
  shared: { key: PREF_KEYS.layoutShared, initial: "list" },
  // Everything and folders are for browsing, where a cover is recognisable.
  everything: { key: PREF_KEYS.layoutFolders, initial: "grid" },
  folder: { key: PREF_KEYS.layoutFolders, initial: "grid" },
};

/** Long enough for a cold function; past it, Recent stops waiting for your reads. */
const READS_TIMEOUT_MS = 8_000;

/** Recent's quick filters, in the order they are shown. */
const FILTERS: { key: keyof RecentFilters; label: string; needsReads: boolean }[] = [
  { key: "opened", label: "Opened by me", needsReads: true },
  { key: "shared", label: "Shared with me", needsReads: false },
  { key: "unread", label: "New since I read", needsReads: true },
];

const SORTS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Recently updated" },
  { value: "name", label: "Name" },
  { value: "views", label: "Most read" },
  // Anyone's last read, as the record keeps it: the only per-person reads a
  // reader may see are their own, and Recent is where those are.
  { value: "lastViewed", label: "Last read by anyone" },
];

function DocCard({
  doc,
  through,
  menu,
  onShare,
  showCover,
  location,
  reason,
}: {
  doc: DocMeta;
  /** The level its folder's reach gives it, when the folder is one this account can read. */
  through: "unlisted" | "public" | null;
  menu: MenuEntry[];
  /** The owner's way to the date behind the expiry chip; absent for anyone else. */
  onShare?: () => void;
  /** False for an expired document read by anyone but its owner (SPEC §17). */
  showCover: boolean;
  /** Where it is filed, when the cards on screen come from more than one folder. */
  location?: string;
  /** On Recent: why it is there, in place of its last update. */
  reason?: ReactNode;
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
      {location !== undefined ? <div className="doc-card-location">{location}</div> : null}
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
        {reason ?? <CardUpdated doc={doc} />}
      </div>
    </div>
  );
}

/** The card's line about its current version, from the record's summary of it. */
function CardUpdated({ doc }: { doc: DocMeta }) {
  const s = currentSummary(doc);
  return <UpdatedLine words={s.words} at={s.at} via={viaOf(s.latest)} />;
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

export function DocList({ view: given = "everything" }: { view?: Exclude<WorkspaceView, "folder"> } = {}) {
  const params = useParams();
  // A folder's address names it; everything else is the kind of page routed here.
  const view: WorkspaceView = params.folderId ? "folder" : given;
  const folderId = params.folderId ?? null;
  const across = view === "recent" || view === "shared";
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
  // Remembered in this browser, so opening a document and coming back finds
  // the workspace as it was left.
  const [sort, setSort] = useRemembered<SortKey>(PREF_KEYS.sort, "recent", isSortKey);
  const [layout, setLayout] = useRemembered(LAYOUT[view].key, LAYOUT[view].initial, isLayout);
  const [filters, setFilters] = useRemembered(PREF_KEYS.recentFilters, NO_FILTERS, isRecentFilters);
  // Your own reads, for Recent: kept between visits to it while this page
  // stays mounted, so coming back does not blank the list while they reload.
  const [reads, setReads] = useState<{ status: "loading" | "ready" | "failed"; map: Map<string, number> | null }>({
    status: "loading",
    map: null,
  });
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

  // Fetched again on every visit to Recent: a read moves with every minute
  // somebody spends in a document, and none of it is live.
  const uid = user?.uid;
  useEffect(() => {
    if (view !== "recent" || !uid) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), READS_TIMEOUT_MS);
    });
    Promise.race([listMyReading(uid, RECENT_READS_LIMIT), late])
      .then((map) => {
        if (live) setReads({ status: "ready", map });
      })
      .catch(() => {
        // The index still building after a deploy, offline, or refused: the
        // new versions alone, said so, rather than an error page (ADR 0027).
        if (live) setReads((prev) => (prev.map ? prev : { status: "failed", map: null }));
      })
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [view, uid]);

  const defaultMarkingRef = useRef(DEPLOYMENT_MARKING as Marking);
  defaultMarkingRef.current = account?.defaultMarking ?? DEPLOYMENT_MARKING;

  /**
   * Upload dropped files where they landed.
   *
   * No dialog: everything the dialog collects is already determined by the
   * drop. The server derives the title from the document exactly as it does
   * for an untitled dialog upload, the marking comes from the account default, and
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

  const me = emailLower ?? "";
  const haveReads = reads.status === "ready";
  const recent: RecentRow[] = useMemo(
    () => (view === "recent" ? recentRows(docs, reads.map, me, Date.now()) : []),
    [view, docs, reads.map, me],
  );
  const recentShown = useMemo(() => filterRecent(recent, filters, me, haveReads), [recent, filters, me, haveReads]);
  const recentById = useMemo(() => new Map(recentShown.map((r) => [r.doc.docId, r])), [recentShown]);

  // A search reaches every document, from any page; otherwise each kind of
  // page has its own selection.
  const visibleDocs = useMemo(() => {
    if (search) return sortDocs(filterDocs(docs, search), sort);
    if (view === "recent") return recentShown.map((r) => r.doc);
    if (view === "shared") return sortDocs(docs.filter((d) => d.ownerEmail !== me), sort);
    return sortDocs(docsInFolder(docs, folderId), sort);
  }, [docs, folderId, search, sort, view, recentShown, me]);

  // Covers nobody has captured yet are filled in here, for the cards on
  // screen, by an editor's browser. The viewer captures on open; this is for
  // every document nobody has opened since (SPEC §6d).
  useCoverBackfill(visibleDocs, emailLower ?? "");


  // Recent and Shared with me list documents; shared folders are in the rail.
  const visibleFolders = useMemo(() => {
    if (across && !search) return [];
    const scoped = search
      ? folders
      : folders.filter((f) => (f.parentId ?? null) === folderId);
    return filterFolders(scoped, search).sort((a, b) => a.name.localeCompare(b.name));
  }, [folders, folderId, search, across]);

  const defaultMarking: Marking = account?.defaultMarking ?? DEPLOYMENT_MARKING;

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
  // A search reaches into every folder, so what it finds says where each is.
  // The same test the scoping above uses, so the two never disagree; Recent
  // and Shared with me always come from every folder.
  const spansFolders = Boolean(search) || across;
  const placeOf = (id: string | null | undefined) => locationOf(id, folders) ?? UNREADABLE_FOLDER;
  const ownerLabel = (email: string) => (email === emailLower ? "You" : email);
  /** On Recent, and not while a search is on: why each document is there. */
  const reasonFor = (doc: DocMeta) => {
    if (view !== "recent" || search) return undefined;
    const row = recentById.get(doc.docId);
    return row ? <RecentReason row={row} me={me} /> : undefined;
  };
  // The folder this page is showing, looked up once for its header, its name
  // and whether this account can see it at all.
  const current = folderId ? folderById.get(folderId) : undefined;
  const currentFolderName = current?.name ?? "Everything";

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
        // Moving changes who can read it, so it is the owner's, as sharing
        // is (SPEC §13).
        id: "move",
        label: "Move…",
        disabled: !isOwner,
        reason: `Only ${doc.ownerEmail} can move this: moving it changes who can read it.`,
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
        id: "trash",
        label: "Move to Trash",
        danger: true,
        disabled: !isOwner,
        reason: `Only ${doc.ownerEmail} can move this to the Trash.`,
        onSelect: () => void moveToTrash(toast, "doc", doc.docId, doc.title),
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
        disabled: !isOwner,
        reason: `Only ${folder.ownerEmail} can move this folder: moving it changes who can read everything in it.`,
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
        id: "trash",
        label: "Move to Trash",
        danger: true,
        disabled: !isOwner,
        reason: `Only ${folder.ownerEmail} can move this folder to the Trash.`,
        onSelect: () => {
          // The one that asks: a folder takes everything in it, other
          // people's documents too, and they are told only by finding them
          // in their own Trash.
          if (
            !window.confirm(
              `Move “${folder.name}” and everything in it to the Trash? Anything in it that other people own goes too, and each of them can restore their own.`,
            )
          ) {
            return;
          }
          // Trashed from inside itself, the page would be left on a folder
          // only its owner can still see, in the Trash. Go up first.
          if (folder.folderId === folderId) {
            navigate(folder.parentId ? `/folder/${folder.parentId}` : "/everything");
          }
          void moveToTrash(toast, "folder", folder.folderId, folder.name);
        },
      },
    ];
  };

  // A folder this account is not a member of: its link may still open it,
  // read-only, exactly as it would for somebody signed out (SPEC §17).
  if (folderId && !foldersLoading && !current) return <SharedFolder />;

  // The open folder's own actions sit beside its name: sharing a folder used
  // to mean going up a level to find its card's menu. Its menu is the card's,
  // less "Open" (this is it) and, for its owner, less the Share the button
  // beside it already is; anyone else keeps Share there, disabled, with the
  // reason.
  const ownsCurrent = current?.ownerEmail === emailLower;
  const headerOmits = ownsCurrent ? ["open", "share"] : ["open"];

  return (
    <div className="workspace">
      <FolderTree folders={folders} currentFolderId={folderId} drawerOpen={drawer} page={view as WorkspacePage} />

      {/* The drop zone is the whole column, not just the grid: "free space" on
          a workspace with two documents in it is mostly below them. */}
      <div
        className="workspace-main"
        data-drop-over={workspaceDrop.over || undefined}
        {...workspaceDrop.handlers}
      >
        <div className="workspace-head">
          {view === "recent" ? (
            <h1 className="workspace-title">Recent</h1>
          ) : view === "shared" ? (
            <h1 className="workspace-title">Shared with me</h1>
          ) : (
            <Breadcrumb folderId={folderId} folders={folders} />
          )}
          {current ? (
            <div className="workspace-head-actions">
              {ownsCurrent ? (
                <button type="button" className="btn btn-sm" onClick={() => shareFolder(current)}>
                  <Icon name="share" size={15} /> Share
                </button>
              ) : null}
              <MoreMenu
                label="Folder actions"
                menuLabel={`Actions for ${current.name}`}
                entries={folderMenu(current).filter((e) => !headerOmits.includes(e.id))}
              />
            </div>
          ) : null}
        </div>

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

          {/* Recent's order is its point; a search on it is sorted as anywhere else. */}
          {view !== "recent" || search ? (
            <>
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
            </>
          ) : null}

          <LayoutToggle layout={layout} onChange={setLayout} />

          <span style={{ flex: 1 }} />

          {across ? null : (
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
          )}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setUploading(true)}>
            <Icon name="upload" size={15} /> Upload
          </button>
        </div>

        {view === "recent" && !search ? (
          <div className="recent-filters" role="group" aria-label="Show only">
            {FILTERS.map((f) => {
              const unavailable = f.needsReads && reads.status === "failed";
              return (
                <button
                  key={f.key}
                  type="button"
                  className="chip recent-filter"
                  aria-pressed={filters[f.key] && !unavailable}
                  disabled={unavailable}
                  title={unavailable ? "Your reading history isn't available just now" : undefined}
                  onClick={() => setFilters({ ...filters, [f.key]: !filters[f.key] })}
                >
                  {/* An icon, never CSS content: generated text joins the
                      accessible name, and the button would be called
                      "✓ New since I read" while it is on. aria-pressed says it. */}
                  {filters[f.key] && !unavailable ? <Icon name="check" size={12} /> : null}
                  {f.label}
                </button>
              );
            })}
            {reads.status === "failed" ? (
              <span className="recent-note">Your reading history isn't available just now, so this shows new versions only.</span>
            ) : null}
          </div>
        ) : null}

        {loading || foldersLoading || (view === "recent" && reads.status === "loading") ? (
          layout === "list" ? <RowSkeletons /> : <CardSkeletons />
        ) : visibleDocs.length === 0 && visibleFolders.length === 0 ? (
          <div className="empty-state">
            {search ? (
              <p>Nothing matches “{search}”.</p>
            ) : view === "recent" && recent.length > 0 ? (
              <>
                <p>Nothing matches these filters.</p>
                <button type="button" className="btn" onClick={() => setFilters(NO_FILTERS)}>
                  Clear filters
                </button>
              </>
            ) : view === "recent" ? (
              <>
                <h2>Nothing in the last 30 days</h2>
                <p>
                  What you read shows up here, and so does every new version
                  of a document you can read.
                </p>
                <p>
                  <Link to="/everything">Go to Everything</Link>
                </p>
              </>
            ) : view === "shared" ? (
              <>
                <h2>Nothing shared with you yet</h2>
                <p>When somebody shares a document with your address, it appears here the moment they do.</p>
              </>
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
            {layout === "list" ? (
              <DocTable
                showLocation={spansFolders}
                sort={sort}
                onSort={view === "recent" && !search ? undefined : setSort}
                recent={view === "recent" && !search}
              >
                {visibleFolders.map((folder) => (
                  <FolderRow
                    key={folder.folderId}
                    folder={folder}
                    menu={folderMenu(folder)}
                    onFiles={uploadFiles}
                    onShare={folder.ownerEmail === emailLower ? () => shareFolder(folder) : undefined}
                    location={spansFolders ? placeOf(folder.parentId) : undefined}
                    owner={ownerLabel(folder.ownerEmail)}
                  />
                ))}
                {visibleDocs.map((doc) => {
                  const isOwner = doc.ownerEmail === emailLower;
                  return (
                    <DocRow
                      key={doc.docId}
                      doc={doc}
                      through={liveReach(doc.folderId ? folderById.get(doc.folderId) : undefined)}
                      menu={docMenu(doc)}
                      onShare={isOwner ? () => shareDoc(doc) : undefined}
                      showCover={isOwner || !isExpired(doc.expiresAt)}
                      location={spansFolders ? placeOf(doc.folderId) : undefined}
                      owner={ownerLabel(doc.ownerEmail)}
                      reason={reasonFor(doc)}
                    />
                  );
                })}
              </DocTable>
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
                          location={spansFolders ? placeOf(doc.folderId) : undefined}
                          reason={reasonFor(doc)}
                        />
                      );
                    })}
                  </div>
                ) : null}
              </>
            )}
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
          // Only `true` is trust (SPEC §6c, ADR 0021).
          trusted={revisingDoc.trusted === true}
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
