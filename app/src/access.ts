// SPDX-License-Identifier: Apache-2.0
// Client for the owner-only sharing endpoint (SPEC §2, §18).

import { post } from "./api";
import type { Role } from "./types";

/**
 * Writes to docs/* are server-side only — firestore.rules denies client writes —
 * so the share panel calls this endpoint rather than the Firestore SDK. The
 * `__session` cookie rides along automatically on the same-origin request.
 */

export interface AccessState {
  viewers: string[];
  editors: string[];
  members: string[];
}

export interface AccessChange {
  /** A principal is a lowercased email or a `team:{teamId}` reference. */
  add?: { principal: string; role: Role }[];
  remove?: string[];
}

export function setAccess(docId: string, change: AccessChange): Promise<AccessState> {
  return post<AccessState>(
    "/access",
    { docId, ...change },
    { forbidden: "Only the document owner can change sharing." },
  );
}
