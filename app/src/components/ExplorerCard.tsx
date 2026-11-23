// SPDX-License-Identifier: Apache-2.0
// The card beside an explorer row whose name does not fit: the whole name, the cover and what the workspace card says (SPEC §13 "The explorer").

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isExpired } from "../expiry";
import { formatRelative, formatTimestamp } from "../firestore";
import { usePersonName } from "../people";
import { viaOf } from "../provenance";
import { readingTime } from "../readingTime";
import { coverUrl } from "../thumbs";
import type { DocMeta, FolderMeta } from "../types";
import { liveReach } from "../visibility";
import { currentSummary, locationOf } from "../workspace/tree";
import { UNREADABLE_FOLDER, VisibilityChip } from "./WorkspaceList";

/** The card's id, which the row it describes names in `aria-describedby`. */
export const EXPLORER_CARD_ID = "doc-explorer-card";

/** How long a pointer rests on a row before its card opens. */
export const CARD_DELAY_MS = 400;

/** The gap between the row and the card, and between the card and the window's edge. */
const GAP = 8;

/**
 * A tooltip, not a dialog: nothing in it takes focus or a click, so it opens
 * and closes with the row it describes. A pointer may cross onto it without
 * it going (WCAG 1.4.13), and Escape dismisses it wherever the focus is. It
 * is drawn into the body so the list's scrolling does not clip it, beside the
 * row over the document.
 */
export function ExplorerCard({
  doc,
  anchor,
  folders,
  me,
  onPointerEnter,
  onPointerLeave,
}: {
  doc: DocMeta;
  /** Where the row is on screen, as it opened. */
  anchor: DOMRect;
  folders: readonly FolderMeta[];
  me: string;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState({ top: anchor.top, left: anchor.right + GAP });
  const owner = usePersonName({ uid: doc.ownerUid, email: doc.ownerEmail });
  const mine = doc.ownerEmail === me;
  // Expired is readable by its owner alone, and so is its cover (SPEC §17).
  const cover = mine || !isExpired(doc.expiresAt) ? coverUrl(doc.docId, doc.thumb) : null;
  const folder = doc.folderId ? folders.find((f) => f.folderId === doc.folderId) : undefined;
  const where = locationOf(doc.folderId, folders) ?? UNREADABLE_FOLDER;
  const through = liveReach(folder);
  const shared = (doc.visibility ?? "private") !== "private" || through !== null;
  const s = currentSummary(doc);
  const reading = readingTime(s.words);
  const via = viaOf(s.latest);
  const views = doc.stats?.views ?? 0;

  // Kept inside the window, measured once it is drawn: moved up as far as it
  // would run off the bottom, and left as far as it would run off the side.
  useLayoutEffect(() => {
    const box = card.current?.getBoundingClientRect();
    const height = box?.height ?? 0;
    const width = box?.width ?? 0;
    setPlace({
      top: Math.max(GAP, Math.min(anchor.top, window.innerHeight - height - GAP)),
      left: Math.max(GAP, Math.min(anchor.right + GAP, window.innerWidth - width - GAP)),
    });
  }, [anchor.top, anchor.right, cover]);

  return createPortal(
    <div
      ref={card}
      id={EXPLORER_CARD_ID}
      role="tooltip"
      className="explorer-card"
      style={place}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {cover ? <img className="explorer-card-cover" src={cover} alt="" decoding="async" /> : null}
      <p className="explorer-card-title">{doc.title}</p>
      <p className="explorer-card-line">
        <span title={mine ? undefined : doc.ownerEmail}>{mine ? "You" : owner}</span>
        <span aria-hidden="true"> · </span>
        <span>{where}</span>
      </p>
      <p className="explorer-card-line">
        {shared ? <VisibilityChip own={doc.visibility} through={through} /> : <span className="chip">Private</span>}
        {/* UpdatedLine's words, without its badge: that is a button, and a
            tooltip holds nothing that takes a click. */}
        {reading ? <span>{reading}</span> : null}
        {s.at != null ? <span title={formatTimestamp(s.at)}>Updated {formatRelative(s.at)}</span> : null}
        {via ? <span className="chip badge-automated">agent</span> : null}
      </p>
      <p className="explorer-card-line">
        {views === 0 ? "Not read by anyone yet" : `Read ${views === 1 ? "once" : `${views} times`}`}
      </p>
    </div>,
    document.body,
  );
}
