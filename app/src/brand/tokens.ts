// SPDX-License-Identifier: Apache-2.0
// The design tokens, mirrored from styles/tokens.css for code that needs them (SPEC §10).

/**
 * Twelve SEMANTIC tokens. None is named after a colour.
 *
 * A token called `--teal` cannot be re-themed without a rename, and every
 * consumer then encodes a colour rather than a role — which is how a palette
 * change becomes a hundred-file refactor. The design this replaces had exactly
 * that problem.
 *
 * `styles/tokens.css` is the source of truth; this mirror exists because three
 * places need the values in JavaScript — the canvas stamp in the PNG export, the
 * stylesheet injected into the document iframe, and the peer-colour palette —
 * and none of them can read a custom property from a stylesheet that has not
 * been applied to the node they are drawing.
 *
 * `brand/tokens.test.ts` parses the CSS and asserts this mirror matches, so the
 * duplication cannot drift, and recomputes the contrast table so a palette tweak
 * that breaks WCAG AA fails CI rather than shipping.
 */
export const TOKENS = {
  bg: "#ffffff",
  surface: "#f4f3f8",
  line: "rgba(26, 26, 38, 0.14)",
  ink: "#1a1a26",
  inkMuted: "#55526b",
  accent: "#4b3dd1",
  onAccent: "#ffffff",
  /**
   * Reserved for `:focus-visible` and nothing else, so the ring is the only
   * colour of its kind on the page and is unmistakable wherever it lands.
   */
  focus: "#00769b",
  success: "#18653f",
  warn: "#8a5200",
  danger: "#b02318",
  /** Highlights, and every surface that traces back to one. */
  annotation: "#b5257b",
} as const;

/** Derived values. Not new colours — variations of the twelve above. */
export const DERIVED = {
  accentStrong: "#3c30b0",
  accentSoft: "#edeafb",
  warnFill: "#f0b429",
  warnSoft: "#fcf0da",
} as const;

export type TokenName = keyof typeof TOKENS;

/**
 * Pairs that must meet WCAG AA, with the minimum each needs.
 *
 * 4.5 for body text, 3.0 for large text and for non-text indicators such as the
 * focus ring. The test recomputes every row from `TOKENS`, so this is an
 * executable claim rather than a comment.
 */
export const CONTRAST_REQUIREMENTS: ReadonlyArray<{
  readonly name: string;
  readonly fg: string;
  readonly bg: string;
  readonly min: number;
}> = [
  { name: "ink on bg", fg: TOKENS.ink, bg: TOKENS.bg, min: 4.5 },
  { name: "ink on surface", fg: TOKENS.ink, bg: TOKENS.surface, min: 4.5 },
  { name: "muted ink on bg", fg: TOKENS.inkMuted, bg: TOKENS.bg, min: 4.5 },
  { name: "muted ink on surface", fg: TOKENS.inkMuted, bg: TOKENS.surface, min: 4.5 },
  { name: "on-accent on accent", fg: TOKENS.onAccent, bg: TOKENS.accent, min: 4.5 },
  { name: "accent as text on bg", fg: TOKENS.accent, bg: TOKENS.bg, min: 4.5 },
  { name: "white on success", fg: "#ffffff", bg: TOKENS.success, min: 4.5 },
  { name: "white on warn", fg: "#ffffff", bg: TOKENS.warn, min: 4.5 },
  { name: "white on danger", fg: "#ffffff", bg: TOKENS.danger, min: 4.5 },
  { name: "annotation on bg", fg: TOKENS.annotation, bg: TOKENS.bg, min: 4.5 },
  // Non-text: the focus ring only has to be distinguishable from its backdrop.
  { name: "focus ring on bg", fg: TOKENS.focus, bg: TOKENS.bg, min: 3.0 },
  { name: "focus ring on surface", fg: TOKENS.focus, bg: TOKENS.surface, min: 3.0 },
];

// --- Contrast, computed rather than asserted -------------------------------

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Parse `#rgb`, `#rrggbb`, or an opaque `rgb()/rgba()` string. */
export function parseColor(input: string): [number, number, number] {
  const hex = input.trim();
  if (hex.startsWith("#")) {
    const body = hex.slice(1);
    const full =
      body.length === 3
        ? body
            .split("")
            .map((c) => c + c)
            .join("")
        : body;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(hex);
  if (!m) throw new Error(`cannot parse colour: ${input}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function relativeLuminance(color: string): number {
  const [r, g, b] = parseColor(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// --- Peer colours (SPEC §16) -----------------------------------------------

/**
 * One colour per person, derived from their address rather than assigned.
 *
 * Derivation is what makes it STABLE between sessions: the same person is the
 * same colour tomorrow, in a different document, on a different device. An
 * assigned-on-join palette would shuffle, and the whole point is that you can
 * trace a person by colour across the chip, the caret, the rail marker, the
 * thread and the highlight edge.
 *
 * Colour is never the only signal — carets carry name labels and chips encode
 * mode by dot shape — so these need to be distinguishable, not accessible on
 * their own.
 */
const PEER_HUES = [262, 200, 338, 152, 28, 286, 176, 8, 224, 62];

export function peerColor(emailLower: string): string {
  let hash = 0;
  for (let i = 0; i < emailLower.length; i++) {
    hash = (hash * 31 + emailLower.charCodeAt(i)) >>> 0;
  }
  const hue = PEER_HUES[hash % PEER_HUES.length];
  // Held at one saturation and lightness so no peer is louder than another, and
  // so every one of them stays legible against both bg and surface.
  return `hsl(${hue} 62% 42%)`;
}
