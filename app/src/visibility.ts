// SPDX-License-Identifier: Apache-2.0
// Client for visibility and open editing (SPEC §17).

import { post } from "./api";
import type { Visibility } from "./types";

export interface VisibilityState {
  visibility: Visibility;
  publicEdit: boolean;
  /** Present only while unlisted. It IS the access control for that level. */
  linkToken: string | null;
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
): Promise<VisibilityState> {
  return post<VisibilityState>(
    "/visibility",
    { docId, visibility, publicEdit },
    { forbidden: "Only the document owner can change who can see this." },
  );
}

/** The link to share, including the unlisted token when there is one. */
export function shareUrl(docId: string, state: VisibilityState): string {
  const base = `${window.location.origin}/d/${docId}`;
  return state.visibility === "unlisted" && state.linkToken
    ? `${base}?k=${state.linkToken}`
    : base;
}
