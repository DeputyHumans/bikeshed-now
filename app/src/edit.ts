// SPDX-License-Identifier: Apache-2.0
// Client for the draft and commit endpoints (SPEC §2, §6a).

import { ConflictError, post } from "./api";

/**
 * Content writes are server-side only, so inline editing calls these endpoints.
 * Versions stay immutable: a commit always mints a NEW version.
 *
 * The two 409s are DIFFERENT problems with different next actions, which is why
 * they are separate error types rather than one message. "Somebody published
 * while you were editing" means reload; "there are open comments" means resolve
 * them. Collapsing both into a banner makes one of them undiagnosable.
 */

export class StaleVersionError extends Error {
  constructor(readonly currentVersion?: string) {
    super("This document has a newer version. Reload to continue editing.");
    this.name = "StaleVersionError";
  }
}

export class UnresolvedCommentsError extends Error {
  constructor(readonly unresolvedCount: number) {
    super(
      `Resolve every comment before publishing a new version (${unresolvedCount} open).`,
    );
    this.name = "UnresolvedCommentsError";
  }
}

function rethrow(e: unknown): never {
  if (e instanceof ConflictError) {
    if (typeof e.detail.unresolvedCount === "number") {
      throw new UnresolvedCommentsError(e.detail.unresolvedCount);
    }
    if (typeof e.detail.currentVersion === "string" || e.detail.currentVersion === undefined) {
      throw new StaleVersionError(e.detail.currentVersion as string | undefined);
    }
  }
  throw e;
}

export interface DraftResult {
  baseVersion: string;
  entry: string;
  sourceEntry?: string;
  bytes: number;
  updatedByEmail: string;
}

/** Persist the edited entry as the shared draft. Debounced by the caller. */
export async function saveDraft(
  docId: string,
  baseVersion: string,
  html: string,
): Promise<DraftResult> {
  try {
    const result = await post<{ draft: DraftResult }>(
      "/draft",
      { docId, baseVersion, html },
      { forbidden: "You do not have edit access to this document." },
    );
    return result.draft;
  } catch (e) {
    return rethrow(e);
  }
}

export interface CommitResult {
  versionId: string;
  contentHash: string;
  fileCount: number;
  bytes: number;
  /** True when the bytes were identical: no new version was minted. */
  deduped: boolean;
}

export async function commitVersion(
  docId: string,
  baseVersion: string,
): Promise<CommitResult> {
  try {
    return await post<CommitResult>(
      "/commit",
      { docId, baseVersion },
      { forbidden: "You do not have edit access to this document." },
    );
  } catch (e) {
    return rethrow(e);
  }
}
