// SPDX-License-Identifier: Apache-2.0
// The viewer's action row (SPEC §7).

import { Icon, type IconName } from "./Icon";
import { MoreMenu } from "./MoreMenu";
import { PresenceBar } from "./PresenceBar";
import type { MenuEntry } from "./Menu";
import type { Peer } from "../presence";

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
  versionLabel,
  peers,
  following,
  onToggleFollow,
  commentsOpen,
  onToggleComments,
  canEdit,
  editing,
  onToggleEdit,
  offerTrust,
  onOpenTrust,
  onPresent,
  menuEntries,
  pane,
  onPane,
  singleColumn,
}: {
  title: string;
  versionLabel: string;
  peers: Peer[];
  following: string | null;
  onToggleFollow: (uid: string) => void;
  commentsOpen: boolean;
  onToggleComments: () => void;
  canEdit: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  offerTrust: boolean;
  onOpenTrust: () => void;
  onPresent: () => void;
  menuEntries: MenuEntry[];
  pane: "doc" | "comments";
  onPane: (pane: "doc" | "comments") => void;
  singleColumn: boolean;
}) {
  return (
    <div className="viewer-toolbar">
      <span className="viewer-title" title={title}>
        {title}
      </span>
      <span className="chip mono">{versionLabel}</span>

      <PresenceBar peers={peers} following={following} onToggleFollow={onToggleFollow} />

      <div className="viewer-toolbar-actions">
        {singleColumn ? (
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

        <Action icon="present" label="Present" onClick={onPresent} />
        <MoreMenu entries={menuEntries} />
      </div>
    </div>
  );
}
