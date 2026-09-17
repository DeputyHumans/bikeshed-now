// SPDX-License-Identifier: Apache-2.0
// The strings an export can carry, and what they default to (SPEC §20).

import type { Marking } from "../types";

/**
 * There is no hardcoded marking here, and that is the point.
 *
 * The design this replaces stamped one company's fixed confidentiality notice
 * on every export, which is exactly the kind of thing that cannot survive being
 * open-sourced. Marking is now data: per document, seeded from an account
 * default, seeded in turn from a deployment default, and OFF unless somebody
 * turned it on.
 */

export const MARKING_OFF: Marking = { enabled: false, label: "", footer: "" };

/** Caps, mirrored from functions/src/lib/marking.ts. */
export const MAX_LABEL = 40;
export const MAX_FOOTER = 300;

/** A suggestion offered in the marking editor. Never applied automatically. */
export const SUGGESTED_LABEL = "CONFIDENTIAL";
export const SUGGESTED_FOOTER =
  "© {year} · {title} · {version} · Confidential — for review only.";

export const FOOTER_PLACEHOLDERS = [
  { token: "{year}", describes: "the year at export time" },
  { token: "{date}", describes: "the date at export time" },
  { token: "{title}", describes: "the document title" },
  { token: "{version}", describes: "the version being exported" },
  { token: "{user}", describes: "the address of whoever exported it" },
] as const;

export function clampMarking(marking: Marking): Marking {
  if (!marking.enabled) return MARKING_OFF;
  return {
    enabled: true,
    label: marking.label.trim().slice(0, MAX_LABEL),
    footer: marking.footer.trim().slice(0, MAX_FOOTER),
  };
}

export function markingIsVisible(marking: Marking): boolean {
  return marking.enabled && (marking.label.length > 0 || marking.footer.length > 0);
}
