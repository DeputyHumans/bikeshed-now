// SPDX-License-Identifier: Apache-2.0
// The palette, the mirror, and the breakpoints are all executable claims (SPEC §7, §10).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTRAST_REQUIREMENTS,
  DERIVED,
  TOKENS,
  contrastRatio,
  parseColor,
  peerColor,
} from "./tokens";
import { BREAKPOINTS } from "../hooks/breakpoints";

const STYLES = join(__dirname, "..", "styles");
const TOKENS_CSS = readFileSync(join(STYLES, "tokens.css"), "utf8");

/** Every `--name: value;` declaration in a stylesheet. */
function declarations(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1], match[2].trim());
  }
  return out;
}

describe("the TypeScript mirror", () => {
  it("matches tokens.css exactly", () => {
    /**
     * The values are duplicated because three places need them in JavaScript —
     * the canvas stamp in the PNG export, the stylesheet injected into the
     * document iframe, and the peer palette — and none can read a custom
     * property from a stylesheet that has not been applied to the node they are
     * drawing. Duplication is fine; DRIFT is not, and this is what prevents it.
     */
    const css = declarations(TOKENS_CSS);
    const expected: [string, string][] = [
      ["--color-bg", TOKENS.bg],
      ["--color-surface", TOKENS.surface],
      ["--color-line", TOKENS.line],
      ["--color-ink", TOKENS.ink],
      ["--color-ink-muted", TOKENS.inkMuted],
      ["--color-accent", TOKENS.accent],
      ["--color-on-accent", TOKENS.onAccent],
      ["--color-focus", TOKENS.focus],
      ["--color-success", TOKENS.success],
      ["--color-warn", TOKENS.warn],
      ["--color-danger", TOKENS.danger],
      ["--color-annotation", TOKENS.annotation],
      ["--color-accent-strong", DERIVED.accentStrong],
      ["--color-accent-soft", DERIVED.accentSoft],
      ["--color-warn-fill", DERIVED.warnFill],
      ["--color-warn-soft", DERIVED.warnSoft],
    ];
    for (const [name, value] of expected) {
      expect(css.get(name), name).toBe(value);
    }
  });

  it("names exactly twelve semantic colour tokens, none after a colour", () => {
    // A token called --teal cannot be re-themed without a rename, and every
    // consumer then encodes a colour rather than a role.
    expect(Object.keys(TOKENS)).toHaveLength(12);
    const colourWords = /(teal|navy|butter|cream|sage|red|blue|green|orange|purple|pink)/i;
    for (const name of Object.keys(TOKENS)) {
      expect(name, `${name} names a colour, not a role`).not.toMatch(colourWords);
    }
  });
});

describe("contrast", () => {
  it("meets WCAG AA on every stated pair", () => {
    for (const row of CONTRAST_REQUIREMENTS) {
      const ratio = contrastRatio(row.fg, row.bg);
      expect(
        Number(ratio.toFixed(2)),
        `${row.name}: ${ratio.toFixed(2)} needs ${row.min}`,
      ).toBeGreaterThanOrEqual(row.min);
    }
  });

  it("computes known ratios correctly", () => {
    // Anchored against the two extremes, so a broken luminance function cannot
    // make the whole table pass vacuously.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("parses the colour formats the tokens actually use", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("#1a1a26")).toEqual([26, 26, 38]);
    expect(parseColor("rgba(26, 26, 38, 0.14)")).toEqual([26, 26, 38]);
    expect(() => parseColor("not a colour")).toThrow();
  });
});

describe("the focus ring", () => {
  it("is used for :focus-visible and nothing else", () => {
    /**
     * The point of reserving it: nothing else on the page is ever that colour,
     * so the ring is unmistakable wherever it lands. A second use would make it
     * one accent among several.
     */
    for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css"))) {
      if (file === "tokens.css") continue;
      const css = readFileSync(join(STYLES, file), "utf8");
      for (const rule of css.split("}")) {
        if (!rule.includes("--color-focus")) continue;
        expect(rule, `${file} uses --color-focus outside :focus-visible`).toContain(
          ":focus-visible",
        );
      }
    }
  });
});

describe("breakpoints", () => {
  it("every @media max-width in the stylesheets is one of the four tiers", () => {
    // CSS cannot read a custom property in a media condition, so the values are
    // literals in eleven files. This turns "keep them in sync" into a test.
    const allowed = new Set(BREAKPOINTS.map(String));
    for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css"))) {
      const css = readFileSync(join(STYLES, file), "utf8");
      // Scoped to @media conditions: `max-width` is also an ordinary property,
      // and a tooltip that caps its own width is not a breakpoint.
      for (const media of css.matchAll(/@media([^{]+)\{/g)) {
        for (const match of media[1].matchAll(/max-width:\s*(\d+)px/g)) {
          expect(
            allowed.has(match[1]),
            `${file} uses an unlisted breakpoint: ${match[1]}px`,
          ).toBe(true);
        }
      }
    }
  });

  it("the tiers are strictly descending", () => {
    for (let i = 1; i < BREAKPOINTS.length; i++) {
      expect(BREAKPOINTS[i]).toBeLessThan(BREAKPOINTS[i - 1]);
    }
  });
});

describe("peer colours", () => {
  it("are derived, so the same person is the same colour every time", () => {
    // Stability is the whole point: you trace a person by colour across the
    // chip, the caret, the rail marker, the thread and the highlight edge. An
    // assigned-on-join palette would shuffle between sessions.
    expect(peerColor("ana@example.com")).toBe(peerColor("ana@example.com"));
    expect(peerColor("ana@example.com")).not.toBe(peerColor("bo@example.com"));
  });

  it("are case-insensitive, because addresses are stored lowercased", () => {
    expect(peerColor("ana@example.com")).toBe(peerColor("ana@example.com".toLowerCase()));
  });

  it("are valid CSS colours", () => {
    expect(peerColor("ana@example.com")).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
  });
});

describe("every token a stylesheet uses actually exists", () => {
  /**
   * The bug this catches, which shipped: consent.css and legal.css were written
   * against `--space-3`, `--space-4` and friends. No such tokens exist — the
   * scale is `--s-1` .. `--s-8`. CSS does not warn about that. An unresolved
   * `var()` makes the whole declaration invalid at computed-value time, so
   * `padding: var(--space-3) var(--space-4)` silently became no padding at all,
   * and the cookie banner rendered jammed into the corner of the viewport.
   *
   * The rule is the one the codebase already follows without having stated it:
   *
   *   var(--x)            must resolve to a token defined in a stylesheet
   *   var(--x, fallback)  may be injected at runtime from JS
   *
   * That distinction needs no allowlist to maintain, and it is exactly right:
   * the four variables set from JavaScript — thread, peer and lock colour, and
   * folder depth — all supply a fallback precisely because they are absent
   * until an element sets them.
   */
  const cssFiles = readdirSync(STYLES).filter((f) => f.endsWith(".css"));

  const defined = new Set<string>();
  for (const file of cssFiles) {
    const css = readFileSync(join(STYLES, file), "utf8");
    for (const m of css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) defined.add(m[1]);
  }

  it("defines the tokens it claims to", () => {
    // A sanity floor, so a parsing regression cannot make this suite vacuous by
    // finding nothing and therefore complaining about nothing.
    expect(defined.size).toBeGreaterThan(40);
    expect(defined.has("--s-1")).toBe(true);
    expect(defined.has("--color-accent")).toBe(true);
  });

  for (const file of cssFiles) {
    it(`${file} references only tokens that exist`, () => {
      const css = readFileSync(join(STYLES, file), "utf8");
      const undefinedRefs: string[] = [];

      // `var(--x` followed by `)` — i.e. no comma, so no fallback.
      for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)) {
        if (!defined.has(m[1])) undefinedRefs.push(m[1]);
      }

      expect(
        [...new Set(undefinedRefs)],
        `${file} uses these without a fallback, and nothing defines them. ` +
          "Either the name is wrong (the spacing scale is --s-1..--s-8, not " +
          "--space-N), or it is injected at runtime and needs a fallback.",
      ).toEqual([]);
    });
  }
});
