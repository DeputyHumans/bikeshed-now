// SPDX-License-Identifier: Apache-2.0
// A document's details: how long it is, when it was made and last updated, by whom and through what, and every version (SPEC §4, §17).

import { Link } from "react-router-dom";
import { Modal } from "./Modal";
import { formatTimestamp } from "../firestore";
import { originOfVersion, viaOf } from "../provenance";
import { readingTime } from "../readingTime";
import { currentSummary } from "../workspace/tree";
import { ViaBadge } from "./ViaBadge";
import type { DocMeta, DocVersion, PublicDoc } from "../types";

/**
 * Opened from the version chip, which says the short form ("v7 · 6 min"),
 * and from the More menu. A member sees the record: created, updated, any
 * unsaved draft, and every version with who published it and through what.
 * A reader without an account record sees what the public mirror says: how
 * long it is and when it was updated, never by whom (SPEC §17).
 *
 * The More menu's Versions list stays as the quick switcher it is; this is
 * where a version's story is told.
 */

const ORIGIN: Record<string, string> = { upload: "uploaded", edit: "published from the editor", fork: "made as a fork" };

function Who({ email, via }: { email: string | null | undefined; via: string | null }) {
  if (!email && !via) return null;
  return (
    <>
      {email ? ` by ${email}` : ""}
      {via ? " " : ""}
      <ViaBadge via={via} title={`Published through ${via}, not by a person in the browser`} />
    </>
  );
}

export function DetailsPanel({
  title,
  docId,
  linkKey,
  meta,
  publicDoc,
  versions,
  viewing,
  words,
  slides,
  showDraft,
  onClose,
}: {
  title: string;
  docId: string;
  linkKey?: string;
  /** The member's record; null for a reader who reads the mirror. */
  meta: DocMeta | null;
  publicDoc: PublicDoc | null;
  /** Every version a member can read, oldest first, as the viewer loads them. */
  versions: DocVersion[];
  /** The version on screen. */
  viewing: string;
  /** That version's word count, as the viewer's chip reads it; undefined until counted. */
  words: number | undefined;
  /** Slides the viewer found, when the document is a deck. */
  slides: number;
  /** An editor's: the unpublished draft is theirs to know about. */
  showDraft: boolean;
  onClose: () => void;
}) {
  const reading = readingTime(words);
  // The card's answer: the current version's publish, which a rename does not move.
  const summary = meta ? currentSummary(meta) : null;
  const latest = summary?.latest ?? null;
  const updatedAt = summary ? summary.at : publicDoc?.updatedAt ?? null;
  const draft = showDraft ? meta?.draft : null;
  const keyed = linkKey ? `?k=${encodeURIComponent(linkKey)}` : "";

  return (
    <Modal title={`Details of “${title}”`} onClose={onClose}>
      <dl className="details-list">
        <dt>Length</dt>
        <dd>
          {reading ?? "Not counted yet"}
          {typeof words === "number" ? ` · ${words.toLocaleString()} ${words === 1 ? "word" : "words"}` : ""}
          {slides > 1 ? ` · ${slides} slides` : ""}
        </dd>

        {meta ? (
          <>
            <dt>Created</dt>
            <dd>
              {formatTimestamp(meta.createdAt)} by {meta.ownerEmail}
            </dd>
          </>
        ) : null}

        <dt>Updated</dt>
        <dd>
          {formatTimestamp(updatedAt)}
          {latest ? (
            <>
              {` (${latest.version})`}
              <Who email={latest.byEmail} via={viaOf(latest)} />
            </>
          ) : null}
        </dd>

        {draft ? (
          <>
            <dt>Unpublished</dt>
            <dd>
              Changes saved {formatTimestamp(draft.updatedAt)} by {draft.updatedByEmail}, not yet published
            </dd>
          </>
        ) : null}
      </dl>

      {versions.length > 0 ? (
        <>
          <h3 style={{ marginTop: "var(--s-4)" }}>Versions</h3>
          <ul className="activity-feed details-versions">
            {[...versions].reverse().map((v) => {
              const origin = originOfVersion(v);
              const how = origin ? ORIGIN[origin] : null;
              const length = readingTime(v.words);
              const current = v.versionId === meta?.currentVersion;
              return (
                <li key={v.versionId} className="activity-row">
                  <span>
                    {v.versionId === viewing ? (
                      <strong aria-current="page">{v.versionId}</strong>
                    ) : (
                      <Link to={`/d/${docId}/${v.versionId}${keyed}`} onClick={onClose}>
                        {v.versionId}
                      </Link>
                    )}
                    {current ? " · current" : ""}
                  </span>
                  <span>
                    {how ?? "published"}
                    <Who email={v.publishedByEmail} via={viaOf(v.publishedBy)} />
                  </span>
                  {length ? <span className="caption">{length}</span> : null}
                  <span className="activity-when">{formatTimestamp(v.publishedAt)}</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </Modal>
  );
}
