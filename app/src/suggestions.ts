// SPDX-License-Identifier: Apache-2.0
// Client for the suggestion endpoint (SPEC §2, §22).

import { post } from "./api";
import type { Anchor, SuggestionState } from "./types";

/**
 * A suggestion's `suggestion` field is server-written only — the rules refuse
 * any client write that names it — so every change goes through
 * `POST /suggestion`, one op at a time.
 */

interface Where {
  docId: string;
  versionId: string;
  /** An unlisted document's key, when that is how the caller reads it. */
  k?: string;
}

const DECIDERS = "Only the owner or an approver can accept or reject a suggestion.";
const AUTHOR = "Only the person who suggested it can change or withdraw it.";

export function suggestEdit(
  where: Where & { anchor: Anchor; replacement: string; note?: string },
): Promise<{ annId: string; versionId: string }> {
  return post("/suggestion", { op: "create", ...where }, {
    forbidden: "You can read this document, but not suggest edits to it.",
  });
}

type Changed = Promise<{ state: SuggestionState }>;

export function reviseSuggestion(where: Where & { annId: string; replacement: string; note?: string }): Changed {
  return post("/suggestion", { op: "revise", ...where }, { forbidden: AUTHOR });
}

export function withdrawSuggestion(where: Where & { annId: string }): Changed {
  return post("/suggestion", { op: "withdraw", ...where }, { forbidden: AUTHOR });
}

/** Keep other approvers off it while this browser applies it. */
export function claimSuggestion(where: Where & { annId: string }): Changed {
  return post("/suggestion", { op: "claim", ...where }, { forbidden: DECIDERS });
}

/** Record an acceptance whose edit this browser has already made and saved. */
export function acceptSuggestion(where: Where & { annId: string }): Changed {
  return post("/suggestion", { op: "accept", ...where }, { forbidden: DECIDERS });
}

export function rejectSuggestion(where: Where & { annId: string; reason?: string }): Changed {
  return post("/suggestion", { op: "reject", ...where }, { forbidden: DECIDERS });
}
