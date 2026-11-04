// SPDX-License-Identifier: Apache-2.0
// The workspace's list layout: one row per folder or document, and the switch between it and the grid (SPEC §13).

import { useCallback, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { Icon } from "./Icon";
import { Menu, type MenuEntry } from "./Menu";
import { ExpiryChip } from "./ExpiryChip";
import { UpdatedLine } from "./UpdatedLine";
import { useFileDrop } from "../hooks/useFileDrop";
import { coverUrl } from "../thumbs";
import { viaOf } from "../provenance";
import { liveReach } from "../visibility";
import { currentSummary, type SortKey } from "../workspace/tree";
import type { Layout } from "../workspace/prefs";
import type { DocMeta, FolderMeta } from "../types";

/** What a row says when the folder a document is filed in is not this account's to open. */
export const UNREADABLE_FOLDER = "A folder you can't open";

/**
 * The level a stranger meets: the record's own, or a folder's above it that
 * has not ended, whichever reaches further (SPEC §17 "A folder's reach"). A
 * private document in a public folder is public, and the card must not say
 * otherwise.
 */
export function VisibilityChip({ own, through }: { own?: DocMeta["visibility"]; through?: "unlisted" | "public" | null }) {
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

/** Grid or list, for the kind of page being looked at. */
export function LayoutToggle({ layout, onChange }: { layout: Layout; onChange: (next: Layout) => void }) {
  return (
    <div className="pane-toggle layout-toggle" role="group" aria-label="Layout">
      <button type="button" aria-pressed={layout === "grid"} title="Grid" onClick={() => onChange("grid")}>
        <Icon name="grid" size={15} title="Grid" />
      </button>
      <button type="button" aria-pressed={layout === "list"} title="List" onClick={() => onChange("list")}>
        <Icon name="listBullet" size={15} title="List" />
      </button>
    </div>
  );
}

/** The sorts a column header can pick, each in the direction sortDocs gives it. */
const HEADER_SORTS: Partial<Record<SortKey, "ascending" | "descending">> = {
  name: "ascending",
  recent: "descending",
  views: "descending",
};

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  col,
}: {
  label: string;
  sortKey: SortKey;
  sort?: SortKey;
  onSort?: (key: SortKey) => void;
  col: string;
}) {
  const active = sort === sortKey;
  const direction = HEADER_SORTS[sortKey];
  return (
    <span role="columnheader" data-col={col} aria-sort={active ? direction : undefined}>
      {onSort ? (
        <button type="button" className="doc-table-sort" data-active={active || undefined} onClick={() => onSort(sortKey)}>
          {label}
          {active ? <span aria-hidden="true">{direction === "ascending" ? " ↑" : " ↓"}</span> : null}
        </button>
      ) : (
        label
      )}
    </span>
  );
}

/**
 * The list: a table to a screen reader, and a grid of rows to CSS.
 *
 * ARIA roles on plain elements rather than <table>, because on a phone each
 * row is laid out again as two lines, and changing a table element's display
 * drops its semantics in some browsers. The cover is aria-hidden, as it is on
 * a card: the title is the link.
 */
export function DocTable({
  showLocation,
  sort,
  onSort,
  children,
}: {
  /** True when the rows come from more than one folder, as a search's do. */
  showLocation: boolean;
  sort?: SortKey;
  onSort?: (key: SortKey) => void;
  children: ReactNode;
}) {
  return (
    <div className="doc-table" role="table" aria-label="Documents" data-location={showLocation || undefined}>
      <div role="rowgroup" className="doc-table-head">
        <div role="row" className="doc-row">
          <span className="doc-row-thumb" aria-hidden="true" />
          <SortHeader label="Name" sortKey="name" sort={sort} onSort={onSort} col="name" />
          {showLocation ? <span role="columnheader" data-col="location">Folder</span> : null}
          <span role="columnheader" data-col="owner">Owner</span>
          <SortHeader label="Updated" sortKey="recent" sort={sort} onSort={onSort} col="updated" />
          <SortHeader label="Reads" sortKey="views" sort={sort} onSort={onSort} col="reads" />
          <span role="columnheader" data-col="actions">
            <span className="visually-hidden">Actions</span>
          </span>
        </div>
      </div>
      <div role="rowgroup">{children}</div>
    </div>
  );
}

function RowMenu({ label, entries }: { label: string; entries: MenuEntry[] }) {
  return (
    <span role="cell" data-col="actions">
      <Menu
        label={`Actions for ${label}`}
        entries={entries}
        trigger={(props) => (
          <button {...props} type="button" className="icon-btn" aria-label="Actions">
            <Icon name="more" size={16} />
          </button>
        )}
      />
    </span>
  );
}

export function DocRow({
  doc,
  through,
  menu,
  onShare,
  showCover,
  location,
  owner,
}: {
  doc: DocMeta;
  through: "unlisted" | "public" | null;
  menu: MenuEntry[];
  onShare?: () => void;
  showCover: boolean;
  /** Its folder in words, when the list shows where each row is filed. */
  location?: string;
  /** "You", or the owner's address. */
  owner: string;
}) {
  const cover = showCover ? coverUrl(doc.docId, doc.thumb) : null;
  const s = currentSummary(doc);
  const updated = <UpdatedLine words={s.words} at={s.at} via={viaOf(s.latest)} />;
  const views = doc.stats?.views ?? 0;
  return (
    <div role="row" className="doc-row">
      <Link to={`/d/${doc.docId}`} className="doc-row-thumb" tabIndex={-1} aria-hidden="true">
        {cover ? <img src={cover} alt="" loading="lazy" decoding="async" /> : <Icon name="doc" size={16} />}
      </Link>
      <span role="cell" data-col="name" className="doc-row-name">
        <Link to={`/d/${doc.docId}`} className="doc-row-title">
          {doc.title}
        </Link>
        <VisibilityChip own={doc.visibility} through={through} />
        {doc.forked ? (
          <span className="chip" title="Forked from another document">
            <Icon name="fork" size={12} />
            Fork
          </span>
        ) : null}
        <ExpiryChip expiresAt={doc.expiresAt} onOpen={onShare} />
      </span>
      {location !== undefined ? <span role="cell" data-col="location">{location}</span> : null}
      <span role="cell" data-col="owner">{owner}</span>
      <span role="cell" data-col="updated">{updated}</span>
      <span role="cell" data-col="reads" className="numeric" title={`Read ${views === 1 ? "once" : `${views} times`} by people`}>
        {views}
      </span>
      {/* A phone has room for one line under the title. It holds what the
          columns hold, so only one of the two is ever displayed, and a
          hidden one is hidden from a screen reader too. */}
      <span role="cell" data-col="summary">
        {location !== undefined ? <span className="doc-card-stat">{location}</span> : null}
        {updated}
      </span>
      <RowMenu label={doc.title} entries={menu} />
    </div>
  );
}

/** A folder you can drop files onto, as its card is: its own component because a hook cannot live in a loop. */
export function FolderRow({
  folder,
  menu,
  onFiles,
  onShare,
  location,
  owner,
}: {
  folder: FolderMeta;
  menu: MenuEntry[];
  onFiles: (files: File[], folderId: string) => void;
  onShare?: () => void;
  location?: string;
  owner: string;
}) {
  const drop = useFileDrop(
    useCallback((files: File[]) => onFiles(files, folder.folderId), [onFiles, folder.folderId]),
  );
  const people = `${folder.members.length} ${folder.members.length === 1 ? "person" : "people"}`;
  return (
    <div role="row" className="doc-row" data-kind="folder" data-drop-over={drop.over || undefined} {...drop.handlers}>
      <span className="doc-row-thumb" aria-hidden="true">
        <Icon name="folder" size={16} />
      </span>
      <span role="cell" data-col="name" className="doc-row-name">
        <Link to={`/folder/${folder.folderId}`} className="doc-row-title">
          {folder.name}
        </Link>
        <VisibilityChip own={folder.visibility} through={liveReach(folder)} />
        {folder.visibility && folder.visibility !== "private" ? (
          <ExpiryChip expiresAt={folder.expiresAt ?? null} onOpen={onShare} of="folder" />
        ) : null}
      </span>
      {location !== undefined ? <span role="cell" data-col="location">{location}</span> : null}
      <span role="cell" data-col="owner">{owner}</span>
      <span role="cell" data-col="people" aria-colspan={2}>{people}</span>
      <span role="cell" data-col="summary">{people}</span>
      <RowMenu label={folder.name} entries={menu} />
    </div>
  );
}
