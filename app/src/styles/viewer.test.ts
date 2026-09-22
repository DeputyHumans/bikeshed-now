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
