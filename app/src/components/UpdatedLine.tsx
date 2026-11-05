// SPDX-License-Identifier: Apache-2.0
// A card's line about its current version: how long it is to read, when it was published, and through what (SPEC §4, §17).

import type { Timestamp } from "firebase/firestore";
import { formatRelative, formatTimestamp } from "../firestore";
import { readingTime } from "../readingTime";
import { ViaBadge } from "./ViaBadge";

/**
 * "6 min read · Updated 2 h ago · agent". The workspace passes its
 * record's summary (workspace/tree.ts currentSummary), a shared folder the
 * server's listing; both mean the current version's publish, which a rename
 * or a share does not move.
 */
export function UpdatedLine({
  words,
  at,
  via = null,
}: {
  words: number | null | undefined;
  at: Timestamp | number | null | undefined;
  via?: string | null;
}) {
  const reading = readingTime(words);
  return (
    <>
      {reading ? <span className="doc-card-stat">{reading}</span> : null}
      {at != null ? (
        <span className="doc-card-stat" title={formatTimestamp(at)}>
          Updated {formatRelative(at)}
        </span>
      ) : null}
      <ViaBadge via={via} title={`Published through ${via}, not by a person in the browser`} />
    </>
  );
}
