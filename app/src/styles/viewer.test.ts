// SPDX-License-Identifier: Apache-2.0
// The viewer grid has a row for everything DocViewer can put above the document (SPEC §6).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONDENSED_QUERY } from "../hooks/breakpoints";
import { EXPLORER_MAX_SHARE, EXPLORER_WIDTH } from "../viewer/explorerWidth";

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
/** A grid template's tracks: split on spaces outside parentheses, so `clamp(…, min(…))` is one. */
function tracks(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (current) out.push(current);
      current = "";
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
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
    .filter((m) => new RegExp(`${property}\\s*:\\s*${value}(?:\\s*!important)?\\s*;`).test(m[2]))
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

  it("hides its words on a phone", () => {
    expect(selectorsWith(mediaBlock(CONDENSED_QUERY), "display", "none")).toContain(LABEL);
  });

  it("keeps them a tier up", () => {
    expect(selectorsWith(mediaBlock("(max-width: 860px)"), "display", "none")).not.toContain(
      LABEL,
    );
  });
});

/**
 * jsdom applies no stylesheet and a query cannot read a variable, so the condition
 * exists twice. If they disagree, ViewerToolbar draws the phone's markup into the
 * desktop's layout, or the reverse.
 */
describe("the two rows on a phone", () => {
  it("are decided by the same condition in the stylesheet as in the code", () => {
    expect(mediaBlock(CONDENSED_QUERY)).not.toBe("");
  });

  it("fold the app header in, but only while a toolbar is on the page", () => {
    expect(selectorsWith(mediaBlock(CONDENSED_QUERY), "display", "none")).toContain(
      ".app-shell:has(.viewer-toolbar) .app-header",
    );
  });

  it("let the toggle take the slack, so the actions can never run off the screen", () => {
    expect(mediaBlock(CONDENSED_QUERY)).toMatch(/\.pane-toggle\s*\{[^}]*min-width:\s*0/);
  });

  it("keep the first folder whole a tier up, where the title shortens instead", () => {
    expect(mediaBlock("(max-width: 860px)")).toMatch(/breadcrumb a:first-of-type\s*\{\s*flex:\s*none/);
  });
});

/**
 * The bars leave while a reader scrolls down, and three things about how they leave
 * are what make it safe. jsdom lays out nothing, so the stylesheet is what can be read.
 */
describe("the bars while a reader scrolls down", () => {
  const rule = () =>
    mediaBlock(CONDENSED_QUERY).match(/\.viewer\[data-chrome="hidden"\][^{]*\{([^}]*)\}/) ?? [];

  it("leave the grid's flow, so its rows collapse and the frame really grows", () => {
    expect(rule()[1]).toMatch(/position:\s*absolute/);
  });

  it("stay in the page, for a screen reader and for Tab", () => {
    expect(rule()[1]).not.toMatch(/display:\s*none/);
    expect(rule()[1]).not.toMatch(/visibility:\s*hidden/);
  });

  it("come back when focus lands in them, with no script", () => {
    expect(rule()[0]).toContain(":not(:focus-within)");
  });

  it("take no transition, which would leave the frame's size stale for a moment", () => {
    expect(selectorsWith(mediaBlock(CONDENSED_QUERY), "transition", "none").join()).toContain(".viewer-toolbar");
  });
});

/**
 * The docked selection bar and the suggestion sheet are what the reader is using at
 * that moment, so nothing may lie over them; and iOS draws its keyboard over the page
 * without moving anything, so a form anchored to the bottom would open behind it.
 */
describe("selecting on a touch screen", () => {
  const stripped = VIEWER_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const zOf = (css: string, selector: string) =>
    Number(css.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{[^}]*z-index:\\s*(\\d+)`))?.[1]);
  const CONSENT_CSS = readFileSync(join(__dirname, "consent.css"), "utf8");

  it("draws the dock and the sheet above the consent card", () => {
    const consent = zOf(CONSENT_CSS, ".consent");
    expect(consent).toBeGreaterThan(0);
    expect(zOf(stripped, ".selection-dock")).toBeGreaterThan(consent);
    expect(zOf(stripped, ".suggest-sheet")).toBeGreaterThan(consent);
  });

  it("opens the suggestion sheet at the top, clear of the keyboard", () => {
    const sheet = stripped.match(/\.suggest-sheet\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(sheet).toMatch(/top:/);
    expect(sheet).not.toMatch(/bottom:/);
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

/**
 * The explorer wraps the viewer rather than living in it (viewer/explorer.tsx),
 * so its column is the shell's, and it repeats `.viewer-body`'s two lessons: a
 * track that exists only while the panel does, and the viewer pinned to the
 * last track whatever comes before it.
 */
describe("the explorer column", () => {
  /** The declarations of the rule whose selector is exactly `selector`, punctuation and all. */
  const exact = (selector: string) => {
    const at = VIEWER_CSS.indexOf(`\n${selector} {`);
    if (at < 0) throw new Error(`no rule for ${selector}`);
    return VIEWER_CSS.slice(VIEWER_CSS.indexOf("{", at) + 1, VIEWER_CSS.indexOf("}", at));
  };
  const value = (selector: string, property: string) =>
    exact(selector).match(new RegExp(`${property}\\s*:\\s*([^;]+);`))?.[1].trim() ?? null;

  it("is a track only while the explorer is open, as wide as the reader made it within the handle's own bounds", () => {
    expect(tracks(value(".viewer-shell", "grid-template-columns") ?? "")).toEqual(["minmax(0, 1fr)"]);
    // The handle's ARIA values come from EXPLORER_WIDTH: the stylesheet must
    // draw the column with the same numbers, or the two disagree on a width.
    const { min, max, initial } = EXPLORER_WIDTH;
    expect(tracks(value('.viewer-shell[data-explorer="open"]', "grid-template-columns") ?? "")).toEqual([
      `clamp(${min}px, var(--explorer-width, ${initial}px), min(${max}px, ${EXPLORER_MAX_SHARE * 100}vw))`,
      "minmax(0, 1fr)",
    ]);
  });

  it("follows its edge at once, with no transition for base.css's reduced-motion block to stretch", () => {
    expect(value(".viewer-shell", "transition")).toBe("none");
  });

  it("while its edge is dragged, keeps the document's frame from taking the pointer and the page from selecting", () => {
    expect(value(".viewer-shell[data-resizing] iframe", "pointer-events")).toBe("none");
    expect(value(".viewer-shell[data-resizing]", "user-select")).toBe("none");
  });

  it("pins the viewer to the last track, so it never lands in the explorer's", () => {
    expect(value(".viewer-shell > :not(.explorer, .explorer-scrim)", "grid-column")).toBe("-2 / -1");
  });

  it("leaves with the rest of the chrome when presenting, and takes its track with it", () => {
    const presenting = selectorsWith(VIEWER_CSS, "display", "none");
    expect(presenting).toContain(".is-presenting .explorer");
    expect(presenting).toContain(".is-presenting .explorer-scrim");
    // A pattern, as `selectorsWith` takes its value: the parentheses escaped.
    const oneTrack = "minmax\\(0, 1fr\\)";
    expect(selectorsWith(VIEWER_CSS, "grid-template-columns", oneTrack)).toContain(".is-presenting .viewer-shell");
    expect(selectorsWith(mediaBlock("print"), "grid-template-columns", oneTrack)).toContain(".viewer-shell");
  });
});
