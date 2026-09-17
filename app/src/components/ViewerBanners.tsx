// SPDX-License-Identifier: Apache-2.0
// Everything the viewer needs to say above the document (SPEC §6a, §16, §17).

import { Icon } from "./Icon";
import type { EditLock, EditRequest } from "../presence";

/**
 * Presentational only: every decision is made in a hook, and this file just
 * renders the result. That separation is what let the viewer shrink from one
 * 1,400-line component with seventeen effects into something reviewable.
 */

export function ViewerBanners(props: {
  /** Somebody else published while this reader was looking at an older version. */
  newVersion?: string | null;
  onOpenNewVersion?: () => void;
  onDismissNewVersion?: () => void;

  /** Somebody else saved the draft while this reader was editing it. */
  conflict?: { byEmail: string } | null;
  onTakeTheirs?: () => void;
  onKeepMine?: () => void;

  /** Somebody else holds the edit lock: this reader observes. */
  lock?: EditLock | null;
  observing?: boolean;
  asked?: boolean;
  onAskToEdit?: () => void;

  /** This reader holds the lock and is about to lose it to idleness. */
  idleWarning?: boolean;
  onStayEditing?: () => void;

  /** Somebody has asked this reader to hand over the lock. */
  requests?: EditRequest[];
  onHandOff?: (uid: string) => void;
  onDismissRequest?: (uid: string) => void;

  /** Anchors that no longer resolve against this version's text. */
  orphanedCount?: number;

  /** Set when the document is sandboxed and actually contains scripts. */
  offerTrust?: boolean;
  onOpenTrust?: () => void;

  peerColor?: string;
}) {
  const rows: React.ReactNode[] = [];

  if (props.newVersion) {
    rows.push(
      <div key="version" className="banner" role="status">
        <Icon name="doc" size={15} />
        <span>A newer version has been published.</span>
        <button type="button" className="btn btn-sm" onClick={props.onOpenNewVersion}>
          Open {props.newVersion}
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={props.onDismissNewVersion}>
          Stay here
        </button>
      </div>,
    );
  }

  if (props.conflict) {
    rows.push(
      // Last-writer-wins, never auto-clobbered. Silence keeps YOUR work: the
      // destructive option has to be chosen, not defaulted into.
      <div key="conflict" className="banner banner-warn" role="alert">
        <Icon name="edit" size={15} />
        <span>{props.conflict.byEmail} saved a change while you were editing.</span>
        <button type="button" className="btn btn-sm" onClick={props.onTakeTheirs}>
          Load theirs
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={props.onKeepMine}>
          Keep mine
        </button>
      </div>,
    );
  }

  if (props.observing && props.lock) {
    rows.push(
      <div key="lock" className="banner lock-banner" role="status">
        <Icon name="lock" size={15} />
        <span>
          <span className="lock-holder" style={{ ["--lock-color" as string]: props.peerColor }}>
            {props.lock.email}
          </span>{" "}
          is editing. You can still highlight and comment.
        </span>
        <span className="lock-actions">
          {props.asked ? (
            <span className="caption">Asked — they will see it.</span>
          ) : (
            <button type="button" className="btn btn-sm" onClick={props.onAskToEdit}>
              Ask to edit
            </button>
          )}
        </span>
      </div>,
    );
  }

  if (props.idleWarning) {
    rows.push(
      <div key="idle" className="banner banner-warn" role="alert">
        <Icon name="lock" size={15} />
        <span>You have been idle. Editing will pass to somebody else in a minute.</span>
        <button type="button" className="btn btn-sm" onClick={props.onStayEditing}>
          Keep editing
        </button>
      </div>,
    );
  }

  for (const request of props.requests ?? []) {
    rows.push(
      <div key={`req-${request.uid}`} className="banner" role="status">
        <Icon name="edit" size={15} />
        <span>{request.email} would like to edit.</span>
        <button type="button" className="btn btn-sm" onClick={() => props.onHandOff?.(request.uid)}>
          Hand over
        </button>
        <button
          type="button"
          className="btn btn-quiet btn-sm"
          onClick={() => props.onDismissRequest?.(request.uid)}
        >
          Not now
        </button>
      </div>,
    );
  }

  if (props.orphanedCount) {
    rows.push(
      // Reported rather than hidden: a comment whose passage was edited away
      // still has to be readable, or the feedback is simply lost.
      <div key="orphaned" className="banner" role="status">
        <Icon name="comment" size={15} />
        <span>
          {props.orphanedCount} comment{props.orphanedCount === 1 ? "" : "s"} no longer
          match the text they were written about. They are still in the panel.
        </span>
      </div>,
    );
  }

  if (props.offerTrust) {
    rows.push(
      <div key="trust" className="banner banner-warn" role="status">
        <Icon name="shield" size={15} />
        <span>This document's scripts are blocked, so parts of it may look empty.</span>
        <button type="button" className="btn btn-sm" onClick={props.onOpenTrust}>
          Review
        </button>
      </div>,
    );
  }

  if (rows.length === 0) return null;
  return <div className="viewer-banners">{rows}</div>;
}
