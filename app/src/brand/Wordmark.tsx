// SPDX-License-Identifier: Apache-2.0
// The wordmark: the mark plus real DOM text (SPEC §10).

import { Mark } from "./Mark";

/**
 * `bikeshed` in ink, `.now` in the accent.
 *
 * The secured domain IS the wordmark, and the paint lands on the part that
 * distinguishes this from the W3C specification preprocessor of the same name.
 * Lowercase throughout, because a domain is lowercase.
 *
 * Real text, not an image: it is selectable, searchable, translatable,
 * screen-reader-legible without an alt attribute, recolourable for a dark
 * surface, and crisp at any size and in print.
 */
export function Wordmark({
  variant = "full",
  size = 22,
}: {
  /** "mark" drops the text — used on a phone's document page, where the title takes its place. */
  variant?: "full" | "mark";
  size?: number;
}) {
  if (variant === "mark") {
    return (
      <span className="wordmark wordmark--mark">
        <Mark size={size} simple={size < 20} title="Bikeshed" />
      </span>
    );
  }
  return (
    <span className="wordmark">
      <Mark size={size} />
      <span className="wordmark-text">
        bikeshed<span className="wordmark-tld">.now</span>
      </span>
    </span>
  );
}
