// SPDX-License-Identifier: Apache-2.0
// The explorer beside a document: open or closed on the account, a drawer when narrow, and the lists it reads (SPEC §13 "The explorer").

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useAuth } from "../auth";
import { listMyDocs, listMyFolders, listMyReading, saveUserProfile, watchUser } from "../firestore";
import { useIsCompactToolbar } from "../hooks/useMediaQuery";
import { pathToFolder } from "../workspace/tree";
import { RECENT_READS_LIMIT } from "../workspace/recent";
import { ExplorerPanel } from "../components/ExplorerPanel";
import type { DocMeta, FolderMeta } from "../types";

/** What the toggle in the document's toolbar needs. */
export interface Explorer {
  /** A signed-in account reading, rather than editing: the toggle is drawn. */
  available: boolean;
  open: boolean;
  /** At 1100px and below: a drawer over the document, whose state is never remembered. */
  drawer: boolean;
  toggle: () => void;
  /** The viewer's word that it is editing. The explorer steps aside until it stops. */
  setSuppressed: (suppressed: boolean) => void;
}

/** Outside a viewer, and in tests that mount a toolbar alone: no toggle at all. */
const NONE: Explorer = {
  available: false,
  open: false,
  drawer: false,
  toggle: () => {},
  setSuppressed: () => {},
};

const ExplorerContext = createContext<Explorer>(NONE);

export const useExplorer = () => useContext(ExplorerContext);

/** The panel's id, which the toggle names in `aria-controls`. */
export const EXPLORER_ID = "doc-explorer";

/**
 * Above the keyed viewer, deliberately.
 *
 * Opening another document remounts `DocViewer` behind a full-page loading
 * state (App's `ViewerRoute`), and anything inside it goes with it: a panel
 * there would vanish, forget which folders were open and subscribe to the
 * workspace again on every switch, which is the one thing it is for. Here it
 * stays mounted for as long as the reader moves between documents.
 *
 * Open or closed is remembered on the account (`users/{uid}.explorerOpen`), so
 * it follows the reader to every device, and only where it is a column. At
 * 1100px and below it is a drawer over the document that starts closed every
 * time: opening one on a phone to jump somewhere is not a wish to have a column
 * on the desktop.
 */
export function ExplorerShell({ children }: { children: ReactNode }) {
  const { user, gate, emailLower } = useAuth();
  const { docId = "" } = useParams();
  const { pathname } = useLocation();
  const drawer = useIsCompactToolbar();
  const uid = gate === "ready" && user ? user.uid : null;

  const [remembered, setRemembered] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [suppressed, setSuppressed] = useState(false);
  // Set only when somebody opens it, so the filter takes focus then: not on a
  // page load, and not when it comes back after editing.
  const [focusWanted, setFocusWanted] = useState(false);
  const focused = useCallback(() => setFocusWanted(false), []);

  useEffect(() => {
    setRemembered(false);
    if (!uid) return;
    return watchUser(
      uid,
      (record) => setRemembered(record?.explorerOpen === true),
      () => setRemembered(false),
    );
  }, [uid]);

  // A drawer is opened to go somewhere, and once there it is in the way.
  useEffect(() => setDrawerOpen(false), [pathname, drawer]);

  const available = uid !== null && !suppressed;
  const open = available && (drawer ? drawerOpen : remembered);

  const toggle = useCallback(() => {
    if (!open) setFocusWanted(true);
    if (drawer) {
      setDrawerOpen((was) => !was);
      return;
    }
    if (!uid) return;
    const next = !remembered;
    setRemembered(next);
    // The snapshot that follows says the same; a refused write puts it back.
    void saveUserProfile(uid, emailLower, { explorerOpen: next }).catch(() => setRemembered(!next));
  }, [open, drawer, uid, remembered, emailLower]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    // Back to the button that opened it, which the drawer covered.
    document.querySelector<HTMLElement>(`[aria-controls="${EXPLORER_ID}"]`)?.focus();
  }, []);

  useEffect(() => {
    if (!open || !drawer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, drawer, closeDrawer]);

  // The lists, from the first time it opens on this route until the reader
  // leaves the viewer: closing and reopening it should not mean loading again.
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    if (open) setWanted(true);
  }, [open]);
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!wanted || !uid || !emailLower) return;
    const stopDocs = listMyDocs(
      emailLower,
      (next) => {
        setDocs(next);
        setLoading(false);
      },
      () => setLoading(false),
    );
    const stopFolders = listMyFolders(emailLower, setFolders, () => setFolders([]));
    return () => {
      stopDocs();
      stopFolders();
    };
  }, [wanted, uid, emailLower]);

  // Reads move with every minute somebody spends in a document and none of it
  // is live, so they are asked for again on each document the reader opens.
  const [reads, setReads] = useState<ReadonlyMap<string, number> | null>(null);
  useEffect(() => {
    if (!open || !uid) return;
    let live = true;
    listMyReading(uid, RECENT_READS_LIMIT)
      .then((map) => {
        if (live) setReads(map);
      })
      // Recent is the new versions alone until they can be read (ADR 0027).
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, uid, docId]);

  // Each opening starts from where the reader is: the folders above the open
  // document and nothing else, not Recent and not what was opened last time.
  // Switching documents while it stays open only adds the new one's folders.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const onToggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // Both are settled while rendering, not in an effect: the panel brings the
  // open document into view from its own effect, which runs before this one's
  // would, and an old set must never be painted.
  const folderOfCurrent = docs.find((d) => d.docId === docId)?.folderId ?? null;
  // Opening is the reader's wish, not the panel coming back after editing.
  const wantsOpen = drawer ? drawerOpen : remembered;
  const [wasOpen, setWasOpen] = useState(wantsOpen);
  if (wantsOpen !== wasOpen) {
    setWasOpen(wantsOpen);
    if (wantsOpen) setExpanded(new Set(pathToFolder(folderOfCurrent, folders)));
  }
  // The open document's folder, opened down to it, when it is first known.
  const [pathFor, setPathFor] = useState({ folderOfCurrent, folders });
  if (pathFor.folderOfCurrent !== folderOfCurrent || pathFor.folders !== folders) {
    setPathFor({ folderOfCurrent, folders });
    const path = pathToFolder(folderOfCurrent, folders);
    if (path.length > 0) setExpanded((prev) => (path.every((id) => prev.has(id)) ? prev : new Set([...prev, ...path])));
  }

  const value = useMemo<Explorer>(
    () => ({ available, open, drawer, toggle, setSuppressed }),
    [available, open, drawer, toggle],
  );

  return (
    <ExplorerContext.Provider value={value}>
      <div className="viewer-shell" data-explorer={open ? (drawer ? "drawer" : "open") : "closed"}>
        {open ? (
          <ExplorerPanel
            id={EXPLORER_ID}
            docs={docs}
            folders={folders}
            loading={loading}
            reads={reads}
            me={emailLower}
            currentDocId={docId}
            expanded={expanded}
            onToggle={onToggle}
            query={query}
            onQuery={setQuery}
            drawer={drawer}
            onClose={closeDrawer}
            focusWanted={focusWanted}
            onFocused={focused}
          />
        ) : null}
        {open && drawer ? (
          <button type="button" className="explorer-scrim" aria-label="Close the document list" onClick={closeDrawer} />
        ) : null}
        {children}
      </div>
    </ExplorerContext.Provider>
  );
}
