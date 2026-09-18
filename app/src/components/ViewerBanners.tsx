// SPDX-License-Identifier: Apache-2.0
// Everything the viewer needs to say above the document (SPEC §6a, §16, §17).

import { Icon } from "./Icon";

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

  /** Anchors that no longer resolve against this version's text. */
  orphanedCount?: number;

  /** Set when the document is sandboxed and actually contains scripts. */
  offerTrust?: boolean;
  /**
   * Set when the blocked scripts are the only thing that would BUILD the
   * content — a deck whose slides are generated at runtime ships an empty
   * container, so there is nothing on screen at all to look partly empty.
   */
  scriptsBuildContent?: boolean;
  onOpenTrust?: () => void;

  /**
   * "Expires in 3 days", or the expired state. Null when it never expires.
   *
   * `isOwner` changes the SENTENCE, not just the button. The owner is the only
   * person who can still open an expired document, so telling a reviewer "only
   * you can open it" would be flatly untrue for them — and the thing they
   * actually need is who to ask.
   */
  expiry?: { label: string; expired: boolean; isOwner: boolean } | null;
  onOpenVisibility?: () => void;
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
        {/* Two sentences, because they describe two different screens. "Parts
            of it may look empty" is misleading in front of a document that is
            entirely empty — the reader is looking at nothing and being told to
            expect something, which reads as the app being broken rather than
            as a decision they can undo. */}
        <span>
          {props.scriptsBuildContent
            ? "This document builds its content with scripts, and they are blocked, so there is nothing to show yet."
            : "This document's scripts are blocked, so parts of it may look empty."}
        </span>
        <button type="button" className="btn btn-sm" onClick={props.onOpenTrust}>
          Review
        </button>
      </div>,
    );
  }

  if (props.expiry) {
    rows.push(
      <div
        key="expiry"
        className={props.expiry.expired ? "banner banner-warn" : "banner"}
        role="status"
      >
        <Icon name="clock" size={15} />
        <span>
          {/* Said in full, because "Expired" alone reads as "deleted" — and
              this product does not delete documents at all. What changed is who
              can open it. */}
          {!props.expiry.expired
            ? props.expiry.label
            : props.expiry.isOwner
              ? "This document has expired. Only you can open it now, and it cannot be edited until you change or clear the date."
              : "This document has expired and is no longer readable. Nothing has been deleted — its owner can restore it by changing the date."}
        </span>
        {props.expiry.isOwner ? (
          <button type="button" className="btn btn-sm" onClick={props.onOpenVisibility}>
            Change
          </button>
        ) : null}
      </div>,
    );
  }

  if (rows.length === 0) return null;
  return <div className="viewer-banners">{rows}</div>;
}
