// SPDX-License-Identifier: Apache-2.0
// What base.css has to hold still on a touch screen (SPEC §7).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BASE_CSS = readFileSync(join(__dirname, "base.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const PRIMITIVES_CSS = readFileSync(join(__dirname, "primitives.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the touch block. jsdom applies no stylesheet, so its text is what can be read. */
function touchBlock(): string {
  const start = BASE_CSS.indexOf("@media (hover: none), (pointer: coarse)");
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = BASE_CSS.indexOf("{", start); i < BASE_CSS.length; i++) {
    if (BASE_CSS[i] === "{") depth++;
    if (BASE_CSS[i] === "}" && --depth === 0) return BASE_CSS.slice(start, i);
  }
  throw new Error("unterminated touch block");
}

describe("the touch floor", () => {
  it("keeps every target at 44 px", () => {
    expect(touchBlock()).toMatch(/min-height:\s*var\(--tap\)\s*!important/);
    expect(touchBlock()).toMatch(/min-width:\s*var\(--tap\)\s*!important/);
  });

  it("never makes a link a flex box, which draws no ellipsis and cuts words instead", () => {
    const rule = touchBlock().match(/a\[href\]:not\([^{]*\)\s*\{([^}]*)\}/g)?.at(-1) ?? "";
    expect(rule).toMatch(/display:\s*inline-block/);
    expect(rule).not.toMatch(/flex/);
  });

  it("sizes every text field at 16 px, below which iOS zooms the page on focus", () => {
    const rule = touchBlock().match(/([^{}]*)\{[^{}]*font-size:\s*16px\s*!important[^{}]*\}/);
    expect(rule, "no 16px rule in the touch block").toBeTruthy();
    const selector = (rule as RegExpMatchArray)[1];
    expect(selector).toMatch(/\binput\b/);
    expect(selector).toMatch(/\bselect\b/);
    expect(selector).toMatch(/\btextarea\b/);
    // The code field is larger on purpose, and an important 16 px would shrink it.
    expect(selector).toContain(".verify-code-input");
  });
});

describe("an icon in a row short of room", () => {
  it("does not give up its width", () => {
    expect(BASE_CSS).toMatch(/\bsvg\s*\{[^}]*flex-shrink:\s*0/);
  });
});

describe("a chip that is a button, on a touch screen", () => {
  it("draws its pill at a chip's height inside the 44 px a finger needs", () => {
    const pill = PRIMITIVES_CSS.match(/button\.chip:not\(\.recent-filter\)::before\s*\{([^}]*)\}/)?.[1] ?? "";
    // (44 - 24) / 2, top and bottom.
    expect(pill).toMatch(/inset:\s*10px 0/);
    expect(pill).toMatch(/content:\s*""/);
  });
});
