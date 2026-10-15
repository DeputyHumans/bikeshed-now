// SPDX-License-Identifier: Apache-2.0
// Everything the viewer needs to say above the document (SPEC §6a, §6c, §16).

import { Icon } from "./Icon";

/**
 * Presentational only: every decision is made in a hook, and this file just
 * renders the result. That separation is what let the viewer shrink from one
 * 1,400-line component with seventeen effects into something reviewable.
 */

export function ViewerBanners(props: {
  /**
   * What is on screen is the draft, not the published version its label
   * names. `when` is already phrased ("5m ago", "on 4 Oct 2026") or empty.
   */
  draft?: { byEmail: string; byYou: boolean; when: string; version: string } | null;
  onEdit?: () => void;

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
}) {
  const rows: React.ReactNode[] = [];

  if (props.draft) {
    const { byEmail, byYou, when, version } = props.draft;
    rows.push(
      // First, because it is a fact about everything else on the page: an
      // editor reads the work in progress, and nothing else in the frame says
      // that it is not what everybody else sees.
      <div key="draft" className="banner" role="status">
        <Icon name="edit" size={15} />
        <span>
          You're reading unpublished edits, last saved by {byYou ? "you" : byEmail}
          {when ? ` ${when}` : ""}. Everyone else still sees {version} until they're saved as a
          new version.
        </span>
        {props.onEdit ? (
          <button type="button" className="btn btn-sm" onClick={props.onEdit}>
            Edit
          </button>
        ) : null}
      </div>,
    );
  }

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
          {props.orphanedCount === 1
            ? " matches the text it was written about. It is still in the panel."
            : " match the text they were written about. They are still in the panel."}
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

  // An expiry is deliberately NOT here. It was, for every future date, and a
  // document set to expire next year carried a banner for eleven months. It
  // is the chip beside the version now (`ExpiryChip`), which explains itself
  // on hover or tap and never takes a row from the document.

  if (rows.length === 0) return null;
  return <div className="viewer-banners">{rows}</div>;
}
