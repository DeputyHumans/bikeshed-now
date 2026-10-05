// SPDX-License-Identifier: Apache-2.0
// Client for forking a document and asking where one came from (SPEC §21).

import { post } from "./api";
import type { Visibility } from "./types";

/**
 * One endpoint, two questions. A fork is made with one click and opened at
 * once; renaming and filing it are what the workspace menus are for, so there
 * is nothing to ask first.
 *
 * Lineage is answered per caller and never read from Firestore: the record of
 * which document a fork came from is server-only, because every member of a
 * fork can read the fork's own record and a docId is the slug of a title.
 */

export interface ForkResult {
  docId: string;
  versionId: string;
  title: string;
}

export interface Ancestor {
  docId: string;
  title: string;
  /** The version the fork was made from. */
  versionId: string;
  /** Present only to a member of that ancestor. */
  ownerEmail?: string;
  /** First hop only: the original has changed since the fork was made. */
  changed?: boolean;
}

export interface ForkListing {
  docId: string;
  title: string;
  visibility: Visibility;
  forkedAt: number | null;
  ownerEmail?: string;
}

export interface Lineage {
  forked: boolean;
  /** Nearest first. Stops at the first one the caller cannot open. */
  ancestors: Ancestor[];
  hiddenAncestor: boolean;
  /** Present for the document's owner only. */
  forks?: { total: number; hidden: number; visible: ForkListing[] };
}

export function forkDoc(
  docId: string,
  opts: { versionId?: string; folderId?: string | null; linkKey?: string } = {},
): Promise<ForkResult> {
  return post(
    "/fork",
    {
      op: "create",
      docId,
      ...(opts.versionId ? { versionId: opts.versionId } : {}),
      ...(opts.folderId ? { folderId: opts.folderId } : {}),
      ...(opts.linkKey ? { k: opts.linkKey } : {}),
    },
    { forbidden: "You can't add documents to that folder." },
  );
}

export function getLineage(docId: string, linkKey?: string): Promise<Lineage> {
  return post("/fork", { op: "lineage", docId, ...(linkKey ? { k: linkKey } : {}) });
}
