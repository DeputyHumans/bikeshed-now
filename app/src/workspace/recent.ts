// SPDX-License-Identifier: Apache-2.0
// Recent: what you read and what got a new version, merged, newest first, and its quick filters (SPEC §13 "Recent").

import { currentSummary } from "./tree";
import type { DocMeta } from "../types";

/** How far back Recent looks, for a read and for a new version alike. */
export const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How many of your own reads one visit asks for (SPEC §5 "Your own reading"). */
export const RECENT_READS_LIMIT = 100;

export interface RecentRow {
  doc: DocMeta;
  /** Your last read, epoch ms, when you have one. */
  readAt: number | null;
  /** The current version's publish, epoch ms. */
  updatedAt: number | null;
  /** The later of the two that fall inside the window: what the row is ordered by. */
  at: number;
  /** Which of them put it here. */
  why: "read" | "updated";
  /** A version you did not publish came out after your last read. */
  isNew: boolean;
}

export interface RecentFilters {
  /** Only documents you have read. */
  opened: boolean;
  /** Only documents somebody else owns. */
  shared: boolean;
  /** Only documents with a version newer than your last read. */
  unread: boolean;
}

export const NO_FILTERS: RecentFilters = { opened: false, shared: false, unread: false };

export const isRecentFilters = (v: unknown): v is RecentFilters =>
  !!v &&
  typeof v === "object" &&
  ["opened", "shared", "unread"].every((k) => typeof (v as Record<string, unknown>)[k] === "boolean");

function millis(value: { toMillis?: () => number } | null | undefined): number | null {
  const ms = value?.toMillis ? value.toMillis() : null;
  return ms && ms > 0 ? ms : null;
}

/**
 * Whether the current version is known to be yours.
 *
 * Only while the summary names the head: in the moment between a publish and
 * its summary, `currentSummary` falls back to the record's own time and nobody
 * is known, which counts as somebody else, so your own publish can read as new
 * for those seconds rather than someone else's never reading as new.
 */
function publishedBy(doc: DocMeta, me: string): boolean {
  const latest = currentSummary(doc).latest;
  return !!latest && latest.byEmail === me;
}

/**
 * Merge the workspace with your reads.
 *
 * `reads` maps a docId to your last read, or is null when your reads could not
 * be fetched, and then Recent is the new versions alone. Only documents in the
 * workspace list appear, so a read row for a document you can no longer open,
 * or one in the Trash, shows nothing (ADR 0027).
 */
export function recentRows(
  docs: readonly DocMeta[],
  reads: ReadonlyMap<string, number> | null,
  me: string,
  now: number,
): RecentRow[] {
  const since = now - RECENT_WINDOW_MS;
  const rows: RecentRow[] = [];
  for (const doc of docs) {
    const readAt = reads?.get(doc.docId) ?? null;
    const updatedAt = millis(currentSummary(doc).at);
    const readIn = readAt !== null && readAt >= since;
    const updatedIn = updatedAt !== null && updatedAt >= since;
    if (!readIn && !updatedIn) continue;
    const why = readIn && (!updatedIn || readAt! >= updatedAt!) ? "read" : "updated";
    rows.push({
      doc,
      readAt,
      updatedAt,
      at: why === "read" ? readAt! : updatedAt!,
      why,
      isNew: readAt !== null && updatedAt !== null && updatedAt > readAt && !publishedBy(doc, me),
    });
  }
  return rows.sort((a, b) => b.at - a.at);
}

/**
 * The quick filters, combined. With no reads to go on, the two that need them
 * are not applied, and the page says why rather than showing nothing.
 */
export function filterRecent(
  rows: readonly RecentRow[],
  filters: RecentFilters,
  me: string,
  haveReads: boolean,
): RecentRow[] {
  return rows.filter(
    (r) =>
      (!filters.shared || r.doc.ownerEmail !== me) &&
      (!haveReads || !filters.opened || r.readAt !== null) &&
      (!haveReads || !filters.unread || r.isNew),
  );
}
