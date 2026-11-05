// SPDX-License-Identifier: Apache-2.0
// The viewer's action row (SPEC §7).

import { Link, useNavigate } from "react-router-dom";
import { Wordmark } from "../brand/Wordmark";
import { expiringSoon, isExpired } from "../expiry";
import { useIsCondensed, useMediaQuery } from "../hooks/useMediaQuery";
import { breadcrumbFor } from "../workspace/tree";
import { AccountMenu } from "./AccountMenu";
import { Breadcrumb } from "./Breadcrumb";
import { ExpiryChip, expiryWords } from "./ExpiryChip";
import { ForkChip } from "./ForkChip";
import { Icon, type IconName } from "./Icon";
import { MoreMenu } from "./MoreMenu";
import { PresenceBar } from "./PresenceBar";
import { useToast } from "./Toast";
import type { MenuEntry } from "./Menu";
import type { Lineage } from "../forks";
import type { Peer } from "../presence";
import type { DocMeta, FolderMeta } from "../types";

export type PhoneAction = "edit" | "share" | "fork" | "slides" | "present";

/**
 * What a phone's second row has room for, and what waits in the menu.
 *
 * A row of 44 px targets beside the Document/Comments control holds three actions
 * and More at 360 px, and two and More below it, so something has to give. On a
 * document that is Present, the rarest thing to do on a phone; on a deck it is
 * Edit, because moving between slides and presenting them is what a deck is for.
 * `slots` counts More. Exported for the table in its test: jsdom lays out nothing,
 * and the order is the part with the edge cases.
 */
export function phoneActions({
  slots,
  canEdit,
  canShare,
  canFork,
  hasSlides,
}: {
  slots: number;
  canEdit: boolean;
  canShare: boolean;
  canFork: boolean;
  hasSlides: boolean;
}): { row: PhoneAction[]; menu: PhoneAction[] } {
  const reach: PhoneAction | null = canShare ? "share" : canFork ? "fork" : null;
  const edit: PhoneAction | null = canEdit ? "edit" : null;
  const order = (hasSlides ? ["slides", "present", reach, edit] : [edit, reach, "present"]).filter(
    (a): a is PhoneAction => a !== null,
  );
  return { row: order.slice(0, slots - 1), menu: order.slice(slots - 1) };
}

/**
 * Below 1100px the secondary actions go icon-only: the LABEL is hidden, never
 * the accessible name. `aria-label` and the tooltip both stay, so the button is
 * identical to a screen reader at every width.
 *
 * Trust and Edit keep their labels down to a phone, because both CHANGE WHAT THE
 * DOCUMENT DOES, and an unlabelled icon is not something to hand a consequential
 * action to. On a phone fitting outranks that: Edit goes icon-only with its name
 * intact, and the trust offer is left to the banner that says it in words.
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
  signedIn = true,
  versionLabel,
  onDetails,
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
  onPrint,
  menuEntries,
  pane,
  onPane,
  singleColumn,
}: {
  title: string;
  /** The folder holding this document, for the trail back out of it. */
  folderId: string | null;
  folders: FolderMeta[];
  /** Signed out, the trail's root is the landing page: there is no workspace to go back to. */
  signedIn?: boolean;
  versionLabel: string;
  /** The chip's tap: the document's details. Absent, the chip is only a label. */
  onDetails?: () => void;
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
  /** Absent: no Print button. */
  onPrint?: () => void;
  menuEntries: MenuEntry[];
  pane: "doc" | "comments";
  onPane: (pane: "doc" | "comments") => void;
  singleColumn: boolean;
}) {
  const condensed = useIsCondensed();
  const roomy = useMediaQuery("(min-width: 360px)");
  const wide = useMediaQuery("(min-width: 601px)");
  const navigate = useNavigate();
  const toast = useToast();
  const slots = wide ? 6 : roomy ? 4 : 3;
  const { row, menu } = phoneActions({
    slots,
    canEdit,
    canShare,
    canFork: Boolean(onFork),
    hasSlides,
  });
  const rootTo = signedIn ? "/everything" : "/";

  const editAction = (
    <Action
      icon="edit"
      label={editing ? "Stop editing" : "Edit"}
      keepLabel
      pressed={editing}
      onClick={onToggleEdit}
    />
  );
  const slidesAction = (
    <Action
      icon="slides"
      label="Slides"
      onClick={onToggleRail}
      pressed={railOpen}
      title={railOpen ? "Hide the slide list" : "Show the slide list"}
    />
  );
  const presentAction = <Action icon="present" label="Present" onClick={onPresent} />;
  const shareAction = <Action icon="share" label="Share" onClick={onShare} />;
  const forkAction = onFork ? (
    <Action
      icon="fork"
      label="Fork"
      title="Make your own copy. The author sees that it was forked."
      onClick={onFork}
      disabled={forking}
    />
  ) : null;
  const paneToggle = onToggleComments ? (
    singleColumn ? (
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
      <Action icon="comment" label="Comments" pressed={commentsOpen} onClick={onToggleComments} />
    )
  ) : null;

  if (condensed) {
    const elements: Record<PhoneAction, React.ReactNode> = {
      edit: editAction,
      share: shareAction,
      fork: forkAction,
      slides: slidesAction,
      present: presentAction,
    };
    const expiry = expiryWords(expiresAt ?? null, expiryOf, onExpiry !== undefined);
    const urgent = isExpired(expiresAt ?? null) || expiringSoon(expiresAt ?? null);
    const onMenu: Partial<Record<PhoneAction, MenuEntry>> = {
      edit: { id: "m-edit", label: editing ? "Stop editing" : "Edit", onSelect: onToggleEdit },
      slides: { id: "m-slides", label: railOpen ? "Hide the slide list" : "Show the slide list", onSelect: onToggleRail },
      present: { id: "m-present", label: "Present", onSelect: onPresent },
    };
    // What the chips and the buttons with no room say elsewhere. Share and Fork
    // are already in the menu, for every reader they apply to.
    const entries: MenuEntry[] = [
      { id: "h-version", label: versionLabel, heading: true },
      ...(expiry && !urgent
        ? [{ id: "expiry", label: expiry.label, onSelect: onExpiry ?? (() => toast.show(expiry.explanation)) }]
        : []),
      ...menu.flatMap((action) => onMenu[action] ?? []),
      ...(hasSlides ? [{ id: "m-all-slides", label: "All slides", onSelect: onOverview }] : []),
      ...(onOpenForks && forked && !menuEntries.some((entry) => entry.id === "forks")
        ? [{
            id: "m-forks",
            // The chip's dot says this above a phone's width, in words to anyone who cannot see it.
            label: lineage?.ancestors[0]?.changed ? "Forks… (the original has changed)" : "Forks…",
            onSelect: onOpenForks,
          }]
        : []),
      { id: "sep-phone", separator: true },
      ...menuEntries,
    ];
    // The folder trail, which the bar has no room to draw. A reader who followed a
    // link has to be able to reach the folder holding the document from here too.
    const goTo: MenuEntry[] = signedIn
      ? [
          { id: "h-go", label: "Go to", heading: true },
          { id: "go-everything", label: "Everything", onSelect: () => navigate(rootTo) },
          ...breadcrumbFor(folderId, folders).map((folder) => ({
            id: `go-${folder.folderId}`,
            label: folder.name,
            onSelect: () => navigate(`/folder/${folder.folderId}`),
          })),
          { id: "sep-go", separator: true },
        ]
      : [];

    return (
      <div className="viewer-toolbar">
        <Link to="/" className="viewer-home" aria-label="Bikeshed home">
          <Wordmark variant="mark" />
        </Link>
        <div className="viewer-title">
          <Breadcrumb folderId={folderId} folders={folders} current={title} rootTo={rootTo} />
        </div>
        {/* The one chip that stays: a date in its last week is worth the room. */}
        {urgent ? <ExpiryChip expiresAt={expiresAt ?? null} onOpen={onExpiry} of={expiryOf} /> : null}
        <div className="viewer-account">
          <AccountMenu extra={goTo} />
        </div>
        <PresenceBar peers={peers} following={following} onToggleFollow={onToggleFollow} />
        <div className="viewer-toolbar-actions">
          {paneToggle}
          {row.map((action) => (
            <span key={action} className="viewer-action">
              {elements[action]}
            </span>
          ))}
          <MoreMenu entries={entries} />
        </div>
      </div>
    );
  }

  return (
    <div className="viewer-toolbar">
      {/* The title, with everything above it made walkable. A document opened
          from a link used to be a dead end: its folder was named nowhere, and
          the only way back to the workspace was the browser's back button. */}
      <div className="viewer-title">
        <Breadcrumb folderId={folderId} folders={folders} current={title} rootTo={rootTo} />
      </div>
      {onDetails ? (
        <button
          type="button"
          className="chip mono version-chip"
          onClick={onDetails}
          title="Details: how long it is, when it was made and updated, and every version"
        >
          {versionLabel}
        </button>
      ) : (
        <span className="chip mono">{versionLabel}</span>
      )}
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
        {paneToggle}

        {offerTrust ? (
          <Action icon="shield" label="Scripts blocked" keepLabel onClick={onOpenTrust} />
        ) : null}

        {canEdit ? editAction : null}

        {/* Promoted out of the overflow menu deliberately. Sharing a document
            with the people who should review it IS the product's loop, and a
            reader who has just published looks for it by name — "I don't see a
            share button" is what a hidden one produces.

            It does NOT keep its label below 1100px: that set is for actions
            which change what the document IS, and sharing changes who can see
            it. */}
        {/* Fork takes the slot Share fills for an owner, and only for somebody
            who is not one. Forking is the reader's way to make a document
            theirs — the owner already has it — so the two never stand side
            by side and no reader's bar is wider than an owner's. The owner forks
            from the menu. */}
        {canShare ? shareAction : forkAction}

        {/* Both appear only for a document that HAS slides, so an ordinary
            document's toolbar is unchanged. */}
        {hasSlides ? slidesAction : null}
        {hasSlides ? (
          <Action
            icon="grid"
            label="All slides"
            onClick={onOverview}
            title="See every slide at once (O)"
          />
        ) : null}
        {presentAction}
        {/* Out of the More menu because a reader who wants a PDF looks for it
            by name, and finding it under Download meant opening a menu first. */}
        {onPrint ? (
          <Action icon="print" label="Print" title="Print or save as PDF" onClick={onPrint} />
        ) : null}
        <MoreMenu entries={menuEntries} />
      </div>
    </div>
  );
}
