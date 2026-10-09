// SPDX-License-Identifier: Apache-2.0
// Client for the owner-only sharing endpoint (SPEC §2, §18).

import { get, post } from "./api";
import type { InheritedGrant, Role } from "./types";

/**
 * Writes to docs/* are server-side only — firestore.rules denies client writes —
 * so the share panel calls this endpoint rather than the Firestore SDK. The
 * `__session` cookie rides along automatically on the same-origin request.
 */

export interface AccessState {
  viewers: string[];
  editors: string[];
  /** Always sent by a current server; optional so an older one still reads. */
  suggesters?: string[];
  approvers?: string[];
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

/** What the document inherits from its folders, for its owner's share panel. */
export async function inheritedAccess(docId: string): Promise<InheritedGrant[]> {
  const { inherited } = await get<{ inherited: InheritedGrant[] }>("/access", { docId });
  return inherited;
}
