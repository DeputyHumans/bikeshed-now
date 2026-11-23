// SPDX-License-Identifier: Apache-2.0
// The explorer's lists: Recent, Shared with me, and every folder with its documents (SPEC §13 "The explorer").

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";
import { MoreItems } from "./MoreItems";
import { useIncremental } from "../hooks/useIncremental";
import { buildTree, docsInFolder, filterDocs, sortDocs, type TreeNode } from "../workspace/tree";
import { recentRows } from "../workspace/recent";
import type { DocMeta, FolderMeta } from "../types";

/** What the open sections are keyed by beside folder ids, which Firestore never makes with a colon. */
export const RECENT_SECTION = "section:recent";
export const SHARED_SECTION = "section:shared";

/** Recent and Shared with me draw this many before "Show more": the tree below them is the point. */
export const SECTION_BATCH = 10;

function DocLink({ doc, depth, current }: { doc: DocMeta; depth: number; current: boolean }) {
  return (
    <li className="folder-item">
      <Link
        to={`/d/${doc.docId}`}
        className="folder-link explorer-doc"
        aria-current={current ? "page" : undefined}
        style={{ ["--folder-depth" as string]: depth }}
        title={doc.title}
      >
        <span className="folder-twisty" />
        <Icon name="doc" size={15} />
        <span className="folder-name">{doc.title}</span>
      </Link>
    </li>
  );
}

function Disclosure({
  label,
  icon,
  open,
  onToggle,
  depth = 0,
}: {
  label: string;
  icon: "clock" | "team" | "folder";
  open: boolean;
  onToggle: () => void;
  depth?: number;
}) {
  return (
    <button
      type="button"
      className="folder-link"
      aria-expanded={open}
      style={{ ["--folder-depth" as string]: depth }}
      onClick={onToggle}
    >
      <span className="folder-twisty" data-open={open}>
        <Icon name="chevron" size={13} />
      </span>
      <Icon name={icon} size={15} />
      <span className="folder-name">{label}</span>
    </button>
  );
}

export function ExplorerPanel({
  id,
  docs,
  folders,
  loading,
  reads,
  me,
  currentDocId,
  expanded,
  onToggle,
  query,
  onQuery,
  drawer,
  onClose,
  focusWanted,
  onFocused,
  edge = null,
}: {
  id: string;
  docs: DocMeta[];
  folders: FolderMeta[];
  loading: boolean;
  /** Your last read of each document, or null until they are fetched or when they cannot be. */
  reads: ReadonlyMap<string, number> | null;
  me: string;
  currentDocId: string;
  /** Open sections and folders, kept above the panel so switching documents keeps them; each opening starts again from the open document's folder. */
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  query: string;
  onQuery: (query: string) => void;
  drawer: boolean;
  onClose: () => void;
  /** Somebody opened the panel, as opposed to it opening because it was left open. */
  focusWanted: boolean;
  onFocused: () => void;
  /** What sits on its right edge: the handle that resizes the column, where it is one. */
  edge?: ReactNode;
}) {
  const filter = useRef<HTMLInputElement | null>(null);
  const nav = useRef<HTMLElement | null>(null);

  const recent = useMemo(
    () => recentRows(docs, reads, me, Date.now()).map((row) => row.doc),
    [docs, reads, me],
  );
  const shared = useMemo(() => sortDocs(docs.filter((d) => d.ownerEmail !== me), "recent"), [docs, me]);
  const results = useMemo(() => (query.trim() ? sortDocs(filterDocs(docs, query), "recent") : []), [docs, query]);
  const tree = useMemo(() => buildTree(folders), [folders]);
  // A document filed in a folder this account cannot open is listed at the top
  // level rather than nowhere: it was shared with you, its folder was not (SPEC §13).
  const loose = useMemo(() => {
    const known = new Set(folders.map((f) => f.folderId));
    return sortDocs(docs.filter((d) => !d.folderId || !known.has(d.folderId)), "name");
  }, [docs, folders]);

  const recentList = useIncremental(recent.length, "recent", { batch: SECTION_BATCH });
  const sharedList = useIncremental(shared.length, "shared", { batch: SECTION_BATCH });
  const resultList = useIncremental(results.length, query);

  useEffect(() => {
    if (!focusWanted) return;
    filter.current?.focus();
    onFocused();
  }, [focusWanted, onFocused]);

  // Where you are, in view, once the lists have landed; not again while you scroll them.
  // In the tree, where its folders are: Recent lists it too, at the top.
  const landed = !loading;
  useEffect(() => {
    if (!landed) return;
    const here =
      nav.current?.querySelector<HTMLElement>('.explorer-tree [aria-current="page"]') ??
      nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
    here?.scrollIntoView?.({ block: "nearest" });
  }, [landed, currentDocId]);

  const docRows = (list: readonly DocMeta[], depth: number) =>
    list.map((doc) => <DocLink key={doc.docId} doc={doc} depth={depth} current={doc.docId === currentDocId} />);

  const folderRows = (nodes: readonly TreeNode[]): React.ReactNode[] =>
    nodes.map((node) => {
      const folderId = node.folder.folderId;
      const open = expanded.has(folderId);
      return (
        <li key={folderId} className="folder-item">
          <Disclosure
            label={node.folder.name}
            icon="folder"
            open={open}
            depth={node.depth}
            onToggle={() => onToggle(folderId)}
          />
          {open ? (
            <ul className="folder-tree">
              {folderRows(node.children)}
              {docRows(sortDocs(docsInFolder(docs, folderId), "name"), node.depth + 1)}
            </ul>
          ) : null}
        </li>
      );
    });

  return (
    <nav
      id={id}
      ref={nav}
      className="explorer"
      aria-label="Your documents"
      data-drawer={drawer ? "open" : undefined}
    >
      <div className="explorer-head">
        <input
          ref={filter}
          type="search"
          className="input explorer-filter"
          placeholder="Filter by title"
          aria-label="Filter your documents by title"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        {drawer ? (
          <button type="button" className="btn btn-quiet btn-sm explorer-close" aria-label="Close the document list" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        ) : null}
      </div>

      <div className="explorer-lists">
      {loading ? (
        <p className="caption explorer-note" role="status">Loading your documents…</p>
      ) : query.trim() ? (
        <>
          <ul className="folder-tree">{docRows(results.slice(0, resultList.shown), 0)}</ul>
          {results.length === 0 ? <p className="caption explorer-note">No document has that in its title.</p> : null}
          <MoreItems list={resultList} />
        </>
      ) : (
        <>
          <ul className="folder-tree folder-tree-head">
            <li className="folder-item">
              <Disclosure label="Recent" icon="clock" open={expanded.has(RECENT_SECTION)} onToggle={() => onToggle(RECENT_SECTION)} />
              {expanded.has(RECENT_SECTION) ? (
                <>
                  <ul className="folder-tree">{docRows(recent.slice(0, recentList.shown), 1)}</ul>
                  {recent.length === 0 ? <p className="caption explorer-note">Nothing read or updated in the last 30 days.</p> : null}
                  <MoreItems list={recentList} />
                </>
              ) : null}
            </li>
            <li className="folder-item">
              <Disclosure label="Shared with me" icon="team" open={expanded.has(SHARED_SECTION)} onToggle={() => onToggle(SHARED_SECTION)} />
              {expanded.has(SHARED_SECTION) ? (
                <>
                  <ul className="folder-tree">{docRows(shared.slice(0, sharedList.shown), 1)}</ul>
                  {shared.length === 0 ? <p className="caption explorer-note">Nobody has shared a document with you yet.</p> : null}
                  <MoreItems list={sharedList} />
                </>
              ) : null}
            </li>
          </ul>
          <ul className="folder-tree explorer-tree">
            {folderRows(tree)}
            {docRows(loose, 0)}
          </ul>
        </>
      )}
      </div>
      {edge}
    </nav>
  );
}
