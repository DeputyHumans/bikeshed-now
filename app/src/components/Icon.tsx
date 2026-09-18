// SPDX-License-Identifier: Apache-2.0
// The icon set: hand-authored paths, one stroke weight, no icon library.

/**
 * Thirty-one icons is not a dependency. A library would bring a thousand, a build
 * step to shake them, and a second visual language to reconcile with the mark —
 * for the sake of the thirty-one this interface actually uses.
 *
 * Every path is drawn on a 24-unit grid with a 1.7 stroke and round caps, so
 * they sit together, inherit `currentColor`, and stay crisp at any size.
 */

const PATHS = {
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  doc: "M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5",
  chevron: "m9 5 7 7-7 7",
  chevronDown: "m5 9 7 7 7-7",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M18 6 6 18",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  // Three real circles, not zero-length strokes. As `h.01` segments these
  // were only as wide as the stroke itself — about one pixel at the 15px
  // the toolbar renders them, in muted grey, which is how the only route
  // to Share became invisible. Every other icon is a SHAPE made of lines,
  // so a thin stroke still reads; a dot IS the stroke.
  more:
    "M12 4.6a1.45 1.45 0 1 0 0 2.9 1.45 1.45 0 0 0 0-2.9zM12 10.55a1.45 1.45 0 1 0 0 2.9 1.45 1.45 0 0 0 0-2.9zM12 16.5a1.45 1.45 0 1 0 0 2.9 1.45 1.45 0 0 0 0-2.9z",
  share: "M15 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM15 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4",
  comment: "M21 12a8 8 0 0 1-8 8H7l-4 3v-4.6A8 8 0 0 1 5 4h8a8 8 0 0 1 8 8z",
  edit: "M4 20h4l11-11a2.8 2.8 0 1 0-4-4L4 16z",
  download: "M12 3v12m0 0 4-4m-4 4-4-4M4 19h16",
  // The same arrow through the horizontal. Upload had been borrowing
  // `download`, so the button that sends a file up, the dropzone and the
  // drop hint all pointed down.
  upload: "M12 21V9m0 0 4 4m-4-4-4 4M4 5h16",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3.5 2",
  present: "M3 4h18v11H3zM12 15v5M8 20h8",
  // A rail of slides beside the one being shown, and the same rail opened out
  // into a grid. Both read at 14px, which is where the toolbar uses them.
  slides: "M3 5h5v14H3zM11 5h10v14H11z",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  stats: "M5 20V10M12 20V4M19 20v-7",
  eye: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  lock: "M6 11h12v9H6zM9 11V7a3 3 0 0 1 6 0v4",
  shield: "M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z",
  check: "m5 13 4.5 4.5L19 7",
  copy: "M9 9h10v12H9zM5 15V3h10",
  trash: "M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18",
  team: "M8 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20a6 6 0 0 1 12 0M17 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM15.5 15.2A5 5 0 0 1 22 20",
  key: "M15 9a4 4 0 1 0-3.5 3.97L10 14.5l-1.5-.5L7 15.5 5 15l-.5 2L3 17.5V20h3l7.2-7.2A4 4 0 0 0 15 9z",

  // --- The editor toolbar -------------------------------------------------
  // Every one of these replaced a TEXT label. "• List" and "1. List" wrapped
  // onto two lines inside a 34px button, and an emoji link glyph rendered in
  // full colour beside monochrome strokes. A toolbar is a row of things that
  // have to read as one set.
  listBullet:
    "M5 6.25a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5M5 11.25a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5M5 16.25a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5M10 7h10M10 12h10M10 17h10",
  // TWO rows, against the bulleted list's three, and that is the whole design.
  // The numerals are what distinguish the two icons, so they have to be
  // readable — and three legible numerals do not fit in a 24-unit grid at this
  // stroke weight. Drawn at three rows they collide into an inkblot at the 16px
  // the toolbar renders. Two rows buys each numeral six units, which is enough.
  listOrdered:
    "M3.7 6.9 5.6 5.7v5.6M4.1 11.3h3M3.6 13.6a1.9 1.9 0 1 1 3.3 1.4l-3.3 3.4h3.5M10 8.5h10M10 15.5h10",
  // A quote is an indent bar, not a pair of curled commas: at 16px a curl is
  // an ink blot, and the bar is what a blockquote actually looks like.
  quote: "M5 5.5v13M10 7.5h10M10 12h10M10 16.5h6",
  rule: "M3 12h18",
  code: "m9 7.5-5 4.5 5 4.5M15 7.5l5 4.5-5 4.5",
  link:
    "M9.6 13.6a3.6 3.6 0 0 0 5.1 0l2.7-2.7a3.6 3.6 0 0 0-5.1-5.1l-1.3 1.3M14.4 10.4a3.6 3.6 0 0 0-5.1 0l-2.7 2.7a3.6 3.6 0 0 0 5.1 5.1l1.3-1.3",
  alignLeft: "M4 6h16M4 12h10M4 18h13",
  alignCenter: "M4 6h16M7 12h10M6 18h12",
} satisfies Record<string, string>;

export type IconName = keyof typeof PATHS;

/**
 * Icons drawn as filled shapes rather than strokes.
 *
 * Kept to the cases where the mark IS a solid form — a dot has no outline to
 * stroke — so the one-weight rule still governs everything that is a drawing.
 */
const FILLED = new Set<IconName>(["more"]);

export function Icon({
  name,
  size = 18,
  title,
}: {
  name: IconName;
  size?: number;
  /** Supply only when the icon is the ONLY label. Otherwise it is decorative. */
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path
        d={PATHS[name]}
        {...(FILLED.has(name)
          ? { fill: "currentColor", stroke: "none" }
          : null)}
      />
    </svg>
  );
}
