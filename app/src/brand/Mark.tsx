// SPDX-License-Identifier: Apache-2.0
// The Bikeshed mark, as inline SVG (SPEC §10).

/**
 * A gable roof over three ruled lines, the middle one picked out.
 *
 * A document sheltered under a shed roof, with one passage highlighted: the
 * mark encodes the name and the product in one figure.
 *
 * Inline rather than an <img>, because an image cannot inherit `currentColor`,
 * cannot be recoloured for a dark surface, and is never crisp in print. The
 * design this replaces shipped a 67 KB PNG wordmark whose only accessible name
 * was its alt text.
 */
export function Mark({
  size = 24,
  simple = false,
  title,
}: {
  size?: number;
  /** Drop the third line and thicken the stroke: below ~20px, three 2px lines inside a 10px interior anti-alias into mush. */
  simple?: boolean;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d="M4 14 16 4l12 10" strokeWidth={simple ? 3.2 : 2.6} />
      <path d="M6.5 15v13M25.5 15v13" strokeWidth={simple ? 3.2 : 2.6} />
      {simple ? (
        <path d="M11 19.5h10M11 25.5h10" strokeWidth={2.8} />
      ) : (
        <>
          <path d="M11 18.5h10M11 26.5h10" strokeWidth={2} />
          {/* The highlighted passage: the one part of the mark that is not ink. */}
          <path d="M11 22.5h7" strokeWidth={2} stroke="var(--color-annotation)" />
        </>
      )}
    </svg>
  );
}
