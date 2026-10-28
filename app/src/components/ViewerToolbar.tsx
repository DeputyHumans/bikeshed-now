// SPDX-License-Identifier: Apache-2.0
// The viewer's action row (SPEC §7).

import { Breadcrumb } from "./Breadcrumb";
import { ExpiryChip } from "./ExpiryChip";
import { ForkChip } from "./ForkChip";
import { Icon, type IconName } from "./Icon";
import { MoreMenu } from "./MoreMenu";
import { PresenceBar } from "./PresenceBar";
import type { MenuEntry } from "./Menu";
import type { Lineage } from "../forks";
import type { Peer } from "../presence";
import type { DocMeta, FolderMeta } from "../types";

/**
 * Below 1100px the secondary actions go icon-only: the LABEL is hidden, never
 * the accessible name. `aria-label` and the tooltip both stay, so the button is
 * identical to a screen reader at every width.
 *
 * Trust and Edit keep their labels at every width, because both CHANGE WHAT THE
 * DOCUMENT DOES, and an unlabelled icon is not something to hand a consequential
 * action to.
 */
function Action({
  icon,
  label,
  keepLabel,
  onClick,
  pressed,
  disabled,
  title,
}: {
  icon: IconName;
  label: string;
  keepLabel?: boolean;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={keepLabel ? "btn btn-sm btn-keep-label" : "btn btn-sm"}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      title={title ?? label}
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
      <span className="btn-label">{label}</span>
    </button>
  );
}

export function ViewerToolbar({
  title,
  folderId,
  folders,
  versionLabel,
  expiresAt,
  expiryOf = "document",
  onExpiry,
  peers,
  following,
  onToggleFollow,
  commentsOpen,
  onToggleComments,
  canEdit,
  editing,
  onToggleEdit,
  canShare,
  onShare,
  onFork,
  forking,
  forked,
  forkCount,
  lineage,
  onOpenForks,
  offerTrust,
  onOpenTrust,
  hasSlides,
  railOpen,
  onToggleRail,
  onOverview,
  onPresent,
  menuEntries,
  pane,
  onPane,
  singleColumn,
}: {
  title: string;
  /** The folder holding this document, for the trail back out of it. */
  folderId: string | null;
  folders: FolderMeta[];
  versionLabel: string;
  /** When the content stops being served; null or absent for never. */
  expiresAt?: DocMeta["expiresAt"] | number | null;
  /** Whose date that is: the document's, or the folder link this reader came through. */
  expiryOf?: "document" | "folder-link";
  /** The owner's tap on the expiry chip. The toolbar does not know which dialog it opens. */
  onExpiry?: () => void;
  peers: Peer[];
  following: string | null;
  onToggleFollow: (uid: string) => void;
  commentsOpen: boolean;
  /** Absent for a reader who came through a folder's link: they have no threads to open. */
  onToggleComments?: () => void;
  canEdit: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  /** Owner-only, matching who the server lets change an ACL. */
  canShare: boolean;
  onShare: () => void;
  /** Fork, for a reader who is not the owner. The owner's is in the menu. */
  onFork?: () => void;
  forking?: boolean;
  forked?: boolean;
  /** Forks made from this document; passed for its owner only. */
  forkCount?: number;
  lineage?: Lineage | null;
  /** Absent: no fork chip at all. */
  onOpenForks?: () => void;
  offerTrust: boolean;
  onOpenTrust: () => void;
  /** True once the document turns out to have slides to move between. */
  hasSlides: boolean;
  railOpen: boolean;
  onToggleRail: () => void;
  onOverview: () => void;
  onPresent: () => void;
  menuEntries: MenuEntry[];
  pane: "doc" | "comments";
  onPane: (pane: "doc" | "comments") => void;
  singleColumn: boolean;
}) {
  return (
    <div className="viewer-toolbar">
      {/* The title, with everything above it made walkable. A document opened
          from a link used to be a dead end: its folder was named nowhere, and
          the only way back to the workspace was the browser's back button. */}
      <div className="viewer-title">
        <Breadcrumb folderId={folderId} folders={folders} current={title} />
      </div>
      <span className="chip mono">{versionLabel}</span>
      {/* Beside the version rather than a banner above the document: a date
          is a fact about this document, and for most of its life not an
          urgent one. */}
      <ExpiryChip expiresAt={expiresAt ?? null} onOpen={onExpiry} of={expiryOf} />
      {onOpenForks ? (
        <ForkChip
          forked={forked === true}
          forkCount={forkCount ?? 0}
          lineage={lineage ?? null}
          onOpen={onOpenForks}
        />
      ) : null}

      <PresenceBar peers={peers} following={following} onToggleFollow={onToggleFollow} />

      <div className="viewer-toolbar-actions">
        {!onToggleComments ? null : singleColumn ? (
          <div className="pane-toggle" role="group" aria-label="Show">
            <button type="button" aria-pressed={pane === "doc"} onClick={() => onPane("doc")}>
              Document
            </button>
            <button
              type="button"
              aria-pressed={pane === "comments"}
              onClick={() => onPane("comments")}
            >
              Comments
            </button>
          </div>
        ) : (
          <Action
            icon="comment"
            label="Comments"
            pressed={commentsOpen}
            onClick={onToggleComments}
          />
        )}

        {offerTrust ? (
          <Action icon="shield" label="Scripts blocked" keepLabel onClick={onOpenTrust} />
        ) : null}

        {canEdit ? (
          <Action
            icon="edit"
            label={editing ? "Stop editing" : "Edit"}
            keepLabel
            pressed={editing}
            onClick={onToggleEdit}
          />
        ) : null}

        {/* Promoted out of the overflow menu deliberately. Sharing a document
            with the people who should review it IS the product's loop, and a
            reader who has just published looks for it by name — "I don't see a
            share button" is what a hidden one produces.

            It does NOT keep its label below 1100px: that set is for actions
            which change what the document IS, and sharing changes who can see
            it. Adding a fifth always-labelled action overflowed the bar at
            400px. */}
        {/* Fork takes the slot Share fills for an owner, and only for somebody
            who is not one. Forking is the reader's way to make a document
            theirs — the owner already has it — so the two never stand side
            by side and no reader's bar is wider than an owner's: the 400px
            overflow above is not reopened. The owner forks from the menu. */}
        {canShare ? (
          <Action icon="share" label="Share" onClick={onShare} />
        ) : onFork ? (
          <Action
            icon="fork"
            label="Fork"
            title="Make your own copy. The author sees that it was forked."
            onClick={onFork}
            disabled={forking}
          />
        ) : null}

        {/* Both appear only for a document that HAS slides, so an ordinary
            document's toolbar is unchanged. */}
        {hasSlides ? (
          <Action
            icon="slides"
            label="Slides"
            onClick={onToggleRail}
            pressed={railOpen}
            title={railOpen ? "Hide the slide list" : "Show the slide list"}
          />
        ) : null}
        {hasSlides ? (
          <Action
            icon="grid"
            label="All slides"
            onClick={onOverview}
            title="See every slide at once (O)"
          />
        ) : null}
        <Action icon="present" label="Present" onClick={onPresent} />
        <MoreMenu entries={menuEntries} />
      </div>
    </div>
  );
}
