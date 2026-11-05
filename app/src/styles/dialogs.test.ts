// SPDX-License-Identifier: Apache-2.0
// What the share dialog's stylesheet has to hold still (SPEC §17).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIALOGS_CSS = readFileSync(join(__dirname, "dialogs.css"), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
function declarations(selector: string): string {
  const escaped = selector.replace(/[.[\]"=>*]/g, (c) => `\\${c}`);
  const m = DIALOGS_CSS.replace(/\/\*[\s\S]*?\*\//g, "").match(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`),
  );
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}

/**
 * A visibility option is a flex row: radio, icon, then a sentence. Left to
 * the flex algorithm the sentence's width is taken out of the ICON — an
 * `<svg width="18">` is a shrinkable item, and the lock, the eye and the globe
 * came out five to eleven pixels wide, hardly there. jsdom lays out no flex,
 * so the stylesheet is read: the icon may not shrink, and the sentence may.
 */
describe("the visibility options", () => {
  it("never take the icon's width for the sentence", () => {
    expect(declarations(".visibility-option > svg")).toMatch(/flex\s*:\s*none\s*;/);
  });

  it("let the sentence wrap instead", () => {
    expect(declarations(".visibility-option > span")).toMatch(/min-width\s*:\s*0\s*;/);
  });
});

/**
 * An owner's menu is taller than a phone, and a scroll of the page closes it, so
 * what runs off the bottom could never be reached. It scrolls inside itself.
 */
describe("a long menu on a phone", () => {
  it("stays on the screen and scrolls inside itself", () => {
    const menu = declarations(".menu");
    expect(menu).toMatch(/max-height\s*:\s*calc\(100dvh/);
    expect(menu).toMatch(/overflow-y\s*:\s*auto/);
  });
});

describe("a dialog on a phone", () => {
  it("sizes to the screen, however long an address it lists", () => {
    expect(declarations(".modal-backdrop")).toMatch(/grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/);
  });
});
