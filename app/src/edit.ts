// SPDX-License-Identifier: Apache-2.0
// Client for the draft and commit endpoints (SPEC §2, §6a).

import type { CausalStamp } from "./crdt/causal";
import { ConflictError, post } from "./api";

/**
 * Content writes are server-side only, so inline editing calls these endpoints.
 * Versions stay immutable: a commit always mints a NEW version.
 *
 * The 409s are DIFFERENT problems with different next actions, which is why
 * they are separate error types rather than one message. "Somebody published
 * while you were editing" means reload; "there are open comments" means resolve
 * them; "there are pending suggestions" means an approver has to decide them,
 * which the person publishing may not be able to do. Collapsing them into one
 * banner makes all but one undiagnosable.
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

export class PendingSuggestionsError extends Error {
  constructor(readonly pendingSuggestions: number) {
    super(
      `${pendingSuggestions === 1 ? "1 suggested edit is" : `${pendingSuggestions} suggested edits are`} ` +
        `waiting. Only the owner or an approver can accept or reject ${pendingSuggestions === 1 ? "it" : "them"}.`,
    );
    this.name = "PendingSuggestionsError";
  }
}

function rethrow(e: unknown): never {
  if (e instanceof ConflictError) {
    if (e.detail.draftChanged === true || e.detail.expired === true) throw e;
    // First: a pending suggestion is also an unresolved thread, so it is in
    // `unresolvedCount` too, and "resolve every comment" would send someone to
    // a Resolve button that is not there.
    const pending = e.detail.pendingSuggestions;
    if (typeof pending === "number" && pending > 0) {
      throw new PendingSuggestionsError(pending);
    }
    if (typeof e.detail.unresolvedCount === "number") {
      throw new UnresolvedCommentsError(e.detail.unresolvedCount);
    }
    if (typeof e.detail.currentVersion === "string") {
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
  session?: { liveEpoch: string; causal?: CausalStamp },
): Promise<DraftResult> {
  try {
    const result = await post<{ draft: DraftResult }>(
      "/draft",
      { docId, baseVersion, html, ...session },
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

/**
 * Save the draft, then publish it; or, when the save fails, publish nothing
 * and return null. A commit publishes the DRAFT's bytes, so publishing past a
 * failed save would promote the previous draft and report it as published.
 * The save is tried every time, rather than refused because the last one
 * failed: that refusal left no way out but typing something to make the
 * editor save again.
 */
export async function publishSaved(
  flush: () => Promise<boolean>,
  commit: () => Promise<CommitResult>,
): Promise<CommitResult | null> {
  return (await flush()) ? commit() : null;
}
