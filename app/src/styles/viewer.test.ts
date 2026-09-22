// SPDX-License-Identifier: Apache-2.0
// The viewer grid has a row for everything DocViewer can put above the document (SPEC §6).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const VIEWER_CSS = readFileSync(join(__dirname, "viewer.css"), "utf8");

/**
 * The in-flow children DocViewer renders inside `.viewer` before `.viewer-body`,
 * in order: a toolbar (viewer or edit), then the banners container, which is
 * present only while something has to be said. Dialogs are `position: fixed`
 * and take no track.
 *
 * jsdom lays out no grids, so this is asserted on the stylesheet itself. The
 * bug it pins was invisible to every local suite: with two row tracks and a
 * banner showing, auto-placement gave the banners the `1fr` track and dropped
 * the document into an implicit content-sized row, where the frame's
 * `height: 100%` had nothing to resolve against and collapsed to 150px under
 * a stretch of empty page.
 */
const ABOVE_BODY = ["toolbar", "banners"];

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.[\]"=]/g, (c) => `\\${c}`);
  const m = VIEWER_CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}

function declaration(selector: string, property: string): string | null {
  const m = rule(selector).match(new RegExp(`${property}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

/** Top-level track list: splits on whitespace outside parentheses. */
function tracks(value: string): string[] {
  return value.match(/[^\s(]+(?:\([^)]*\))?/g) ?? [];
}

describe("the viewer grid", () => {
  it("declares one row per child above the document, then the fill track", () => {
    const rows = tracks(declaration(".viewer", "grid-template-rows") ?? "");

    expect(rows).toHaveLength(ABOVE_BODY.length + 1);
    expect(rows.at(-1)).toBe("minmax(0, 1fr)");
  });

  it("pins the document to the fill track rather than trusting auto-placement", () => {
    // Without the pin, the body sits wherever the count of children before it
    // leaves it — and that count changes whenever a banner appears.
    expect(declaration(".viewer-body", "grid-row")).toBe(String(ABOVE_BODY.length + 1));
  });
});

/**
 * The browser's File → Print cannot be redirected to the export, so the page
 * has to print acceptably on its own: everything presentation mode hides is
 * hidden on paper too, plus the rail, and the viewer's fixed viewport height —
 * the thing that clips the frame to one box — comes off. jsdom evaluates no
 * print media, so this reads the stylesheet.
 */
/** The rules inside the first `@media <query> { … }` block, without the wrapper. */
function mediaBlock(query: string): string {
  const start = VIEWER_CSS.indexOf(`@media ${query}`);
  if (start < 0) return "";
  const open = VIEWER_CSS.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < VIEWER_CSS.length; i++) {
    if (VIEWER_CSS[i] === "{") depth++;
    if (VIEWER_CSS[i] === "}" && --depth === 0) return VIEWER_CSS.slice(open + 1, i);
  }
  return "";
}

/** Selectors of every rule in `css` whose declarations include `property: value`. */
const selectorsWith = (css: string, property: string, value: string) =>
  // Comments first, or the prose before a rule is read as part of its selector.
  Array.from(css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g))
    .filter((m) => new RegExp(`${property}\\s*:\\s*${value}\\s*;`).test(m[2]))
    .flatMap((m) => m[1].split(",").map((s) => s.trim()))
    .filter((s) => s && !s.startsWith("@"));

/**
 * The expiry chip sits on the toolbar, and on the narrowest screens the
 * toolbar is already full: the title is dropped and the actions wrap. A
 * nineteen-character chip there pushed the actions onto a second row — the
 * space it was moved out of a banner to save, taken back on phones. So at
 * that tier it goes icon-only like the secondary actions, and only there: a
 * tier up the words are the point.
 */
describe("the expiry chip on a narrow toolbar", () => {
  const LABEL = ".viewer-toolbar .expiry-chip .chip-label";

  it("hides its words at 400px", () => {
    expect(selectorsWith(mediaBlock("(max-width: 400px)"), "display", "none")).toContain(LABEL);
  });

  it("keeps them a tier up", () => {
    expect(selectorsWith(mediaBlock("(max-width: 860px)"), "display", "none")).not.toContain(
      LABEL,
    );
  });
});

describe("printing the page", () => {
  const printBlock = mediaBlock("print");

  it("hides on paper everything presentation mode hides, and the rail", () => {
    const presenting = selectorsWith(VIEWER_CSS, "display", "none")
      .filter((s) => s.startsWith(".is-presenting "))
      .map((s) => s.replace(".is-presenting ", ""));
    expect(presenting.length).toBeGreaterThan(0);

    const printed = selectorsWith(printBlock, "display", "none");
    for (const selector of [...presenting, ".slide-rail"]) {
      expect(printed, `${selector} is not hidden in print`).toContain(selector);
    }
  });

  it("lets the viewer grow to the document instead of clipping it to the viewport", () => {
    expect(selectorsWith(printBlock, "height", "auto")).toContain(".viewer");
  });
});
