// SPDX-License-Identifier: Apache-2.0
// Client for visibility and open editing (SPEC §17).

import { post } from "./api";
import { expiryMs } from "./expiry";
import type { DocMeta, Visibility } from "./types";

export interface VisibilityState {
  visibility: Visibility;
  publicEdit: boolean;
  /** Present only while unlisted. It IS the access control for that level. */
  linkToken: string | null;
  /** Epoch milliseconds, or null for a document that does not expire. */
  expiresAt: number | null;
}

/**
 * `publicEdit` widens WHO may edit to any verified account. It never widens to
 * "anyone": every write still requires a signed-in account, on every document,
 * whatever its owner chose (SPEC §17).
 */
export function setVisibility(
  docId: string,
  visibility: Visibility,
  publicEdit = false,
  /**
   * Epoch milliseconds, or null for no expiry.
   *
   * Sent on EVERY call, including the ones that only change visibility, because
   * the server writes the whole triple. Omitting it here would clear the date
   * as a side effect of ticking a different box — which is the kind of thing
   * nobody notices until the document is gone.
   */
  expiresAt: number | null = null,
): Promise<VisibilityState> {
  return post<VisibilityState>(
    "/visibility",
    { docId, visibility, publicEdit, expiresAt },
    { forbidden: "Only the document owner can change who can see this." },
  );
}

/**
 * The triple as a record carries it. Every field is optional there, because
 * most documents never set any of them, and what this returns is what the
 * dialog will send back whole on the first change it makes.
 */
export function visibilityStateOf(
  meta: Pick<DocMeta, "visibility" | "publicEdit" | "linkToken" | "expiresAt">,
): VisibilityState {
  return {
    visibility: meta.visibility ?? "private",
    publicEdit: meta.publicEdit ?? false,
    linkToken: meta.linkToken ?? null,
    expiresAt: expiryMs(meta.expiresAt),
  };
}

/** The link to share, including the unlisted token when there is one. */
export function shareUrl(docId: string, state: VisibilityState): string {
  const base = `${window.location.origin}/d/${docId}`;
  return state.visibility === "unlisted" && state.linkToken
    ? `${base}?k=${state.linkToken}`
    : base;
}
