// SPDX-License-Identifier: Apache-2.0
// Comment highlights painted by the browser over live ranges, adding no node to the document (SPEC §6, ADR 0043).

import { HL_STYLE_ID, markOwn } from "../brand/dom";
import { TOKENS } from "../brand/tokens";
import { isVisible } from "./visible";

/**
 * A highlight used to be a `<mark>` wrapped around each run of the passage's
 * text. That is a new element in somebody else's layout: in a flex or grid
 * container a run of text is ONE anonymous item, and a mark around part of it
 * makes three, each placed and spaced on its own, so commenting on a slide of a
 * deck built from flex and grid rearranged the slide for every reader. Its
 * border widened tight lines until they wrapped, and the document's own rules —
 * `:first-child`, `mark { … }` — could match it.
 *
 * So HTML text is PAINTED instead, with the CSS Custom Highlight API: each
 * thread's ranges are registered in the frame's `CSS.highlights` under a name
 * of its own (`paintName`), and the
 * browser paints them, like a selection, without a node, an attribute or a box
 * anywhere in the document (ADR 0043). The ranges are live, so they follow the
 * text as the document lays out again, and text that is not shown is not
 * painted, which on a deck that stacks its slides is every slide but one.
 *
 * SVG text is the exception, measured: WebKit paints no highlight inside
 * `<text>`, so there the passage keeps its `<tspan>` (`highlighter.ts`). SVG
 * text has no flex or grid to break, and a `<tspan>` with no position of its
 * own moves no glyph.
 *
 * The look follows from what a highlight can paint: a tint and an underline in
 * the author's colour, the line struck through for a suggestion, the selected
 * thread's tint heavier. A highlight cannot draw a border, which is what the
 * mark used to survive a dark slide with; the underline is what carries the
 * colour on one. Screen only: a printout shows the document.
 */

/** One thread's painted passage: the HTML text runs of it, in its author's colour. */
export interface PaintItem {
  annId: string;
  ranges: Range[];
  color: string;
  /** A pending suggestion, whose text is struck through rather than underlined. */
  suggestion: boolean;
}

interface HighlightLike {
  priority: number;
}

type HighlightWindow = Window & {
  Highlight?: new (...ranges: Range[]) => HighlightLike;
  CSS?: { highlights?: Map<string, HighlightLike> };
  CSSStyleSheet?: { new (): CSSStyleSheet };
};

type SheetDocument = Document & { adoptedStyleSheets?: CSSStyleSheet[] };

/** Every highlight name this module registers starts with this, and nothing else's does. */
export const PAINT_PREFIX = "bshd-hl";
const SELECTED = `${PAINT_PREFIX}-selected`;
const FLASH = `${PAINT_PREFIX}-flash`;

interface PaintState {
  items: PaintItem[];
  selected: string | null;
  /** False while the reader hides comments, or presents (SPEC §6). */
  shown: boolean;
  /** A thread being blinked while hidden, and whether it is lit right now. */
  flash: { annId: string; lit: boolean } | null;
  /** The rules the painting needs, besides the caller's own (`extraCss`). */
  sheet: Sheet | null;
  extraCss: string;
  /** Whether the pointer is over a painted passage, for the hand cursor. */
  hovering: boolean;
}

const states = new WeakMap<Document, PaintState>();

function stateOf(doc: Document): PaintState {
  let state = states.get(doc);
  if (!state) {
    state = { items: [], selected: null, shown: true, flash: null, sheet: null, extraCss: "", hovering: false };
    states.set(doc, state);
  }
  return state;
}

function registry(doc: Document): { win: HighlightWindow; highlights: Map<string, HighlightLike> } | null {
  const win = doc.defaultView as HighlightWindow | null;
  const highlights = win?.CSS?.highlights;
  if (!win?.Highlight || !highlights) return null;
  return { win, highlights };
}

/** Whether this frame's browser can paint a highlight at all. */
export function canPaint(doc: Document): boolean {
  return registry(doc) !== null;
}

/**
 * A stylesheet for the frame: adopted, so no node enters the document, where
 * the browser can; a `<style>` of ours otherwise, which the strip removes like
 * any injection. Either way, replaced whole.
 */
interface Sheet {
  set: (css: string) => void;
  remove: () => void;
}

function sheetFor(doc: Document): Sheet {
  const win = doc.defaultView as HighlightWindow | null;
  const host = doc as SheetDocument;
  if (win?.CSSStyleSheet && Array.isArray(host.adoptedStyleSheets)) {
    const sheet = new win.CSSStyleSheet();
    if (typeof sheet.replaceSync === "function") {
      host.adoptedStyleSheets = [...host.adoptedStyleSheets, sheet];
      return {
        set: (css) => sheet.replaceSync(css),
        remove: () => {
          host.adoptedStyleSheets = (host.adoptedStyleSheets ?? []).filter((s) => s !== sheet);
        },
      };
    }
  }
  let style = doc.getElementById(HL_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = HL_STYLE_ID;
    markOwn(style, "hl-style");
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  const node = style;
  return {
    set: (css) => {
      if (node.textContent !== css) node.textContent = css;
    },
    remove: () => node.remove(),
  };
}

/**
 * A highlight per thread, named for it, so devtools and a test can tell which
 * thread a painted range is — the registry being the only place a painted
 * passage exists. `c` for a comment, `s` for a suggestion, whose text is
 * struck. An id is an identifier already; anything else in one is replaced, so
 * the name is always a valid `::highlight()` argument.
 */
export function paintName(annId: string, suggestion: boolean): string {
  return `${PAINT_PREFIX}-${suggestion ? "s" : "c"}-${annId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function groupsOf(items: readonly PaintItem[]): { name: string; color: string; suggestion: boolean; ranges: Range[] }[] {
  return items.map((item) => ({ name: paintName(item.annId, item.suggestion), color: item.color, suggestion: item.suggestion, ranges: item.ranges }));
}

function rulesFor(state: PaintState): string {
  const rules: string[] = [];
  const coarse: string[] = [];
  for (const group of groupsOf(state.items)) {
    const c = group.color;
    rules.push(
      `::highlight(${group.name}) { background-color: color-mix(in srgb, ${c} 16%, transparent); ` +
        `text-decoration: ${group.suggestion ? "line-through" : "underline"} 2px ${c}; text-underline-offset: 0.18em; }`,
    );
    // A thumb needs more to find than an eye does, as the mark's fill was.
    coarse.push(`::highlight(${group.name}) { background-color: color-mix(in srgb, ${c} 26%, transparent); }`);
  }
  const selected = state.items.find((item) => item.annId === state.selected);
  if (selected) {
    // Only a heavier tint: the underline or the strike comes from the thread's own
    // highlight beneath, and both would draw if this one had a line too.
    rules.push(`::highlight(${SELECTED}) { background-color: color-mix(in srgb, ${selected.color} 36%, transparent); }`);
  }
  const flashing = state.items.find((item) => item.annId === state.flash?.annId);
  const flashColor = flashing?.color ?? TOKENS.annotation;
  rules.push(
    `::highlight(${FLASH}) { background-color: color-mix(in srgb, ${flashColor} 36%, transparent); text-decoration: underline 2px ${flashColor}; }`,
  );
  const hand = state.hovering ? "\n* { cursor: pointer !important; }" : "";
  return (
    `@media screen {\n${rules.join("\n")}\n@media (hover: none), (pointer: coarse) {\n${coarse.join("\n")}\n}\n}` +
    hand +
    (state.extraCss ? `\n${state.extraCss}` : "")
  );
}

/** Register what should be painted now, and nothing else of ours. */
function apply(doc: Document): void {
  const state = stateOf(doc);
  const reg = registry(doc);
  if (reg) {
    for (const name of [...reg.highlights.keys()]) if (name.startsWith(PAINT_PREFIX)) reg.highlights.delete(name);
    if (state.shown) {
      for (const group of groupsOf(state.items)) {
        const highlight = new reg.win.Highlight!(...group.ranges);
        highlight.priority = 1;
        reg.highlights.set(group.name, highlight);
      }
      const selected = state.items.find((item) => item.annId === state.selected);
      if (selected && selected.ranges.length > 0) {
        const highlight = new reg.win.Highlight!(...selected.ranges);
        highlight.priority = 2;
        reg.highlights.set(SELECTED, highlight);
      }
    }
    const flashing = state.flash?.lit ? state.items.find((item) => item.annId === state.flash?.annId) : null;
    if (flashing && flashing.ranges.length > 0) {
      const highlight = new reg.win.Highlight!(...flashing.ranges);
      highlight.priority = 3;
      reg.highlights.set(FLASH, highlight);
    }
  }
  if (!state.sheet) state.sheet = sheetFor(doc);
  state.sheet.set(rulesFor(state));
}

/** Paint these threads, replacing whatever this document had painted. */
export function paint(doc: Document, items: PaintItem[], extraCss = ""): void {
  const state = stateOf(doc);
  state.items = items;
  state.extraCss = extraCss;
  apply(doc);
}

/** The selected thread is painted heavier; null for none. */
export function paintSelected(doc: Document, annId: string | null): void {
  const state = stateOf(doc);
  if (state.selected === annId) return;
  state.selected = annId;
  apply(doc);
}

/** Show or hide every painted thread, keeping what they are for when they come back. */
export function setPaintShown(doc: Document, shown: boolean): void {
  const state = stateOf(doc);
  if (state.shown === shown) return;
  state.shown = shown;
  apply(doc);
}

/** Light or darken one thread's passage on its own, while the rest stay hidden. */
export function setFlash(doc: Document, annId: string | null, lit = false): void {
  const state = stateOf(doc);
  state.flash = annId ? { annId, lit } : null;
  apply(doc);
}

/** Unregister everything this document painted and remove its stylesheet. */
export function unpaint(doc: Document): void {
  const state = states.get(doc);
  const reg = registry(doc);
  if (reg) for (const name of [...reg.highlights.keys()]) if (name.startsWith(PAINT_PREFIX)) reg.highlights.delete(name);
  state?.sheet?.remove();
  // A `<style>` left by a sheet this module never made, such as one an older
  // frame wrote, goes too: the id is ours.
  doc.getElementById(HL_STYLE_ID)?.remove();
  states.delete(doc);
}

/** What this document paints, for adding one thread to it. */
export function paintedItems(doc: Document): PaintItem[] {
  return states.get(doc)?.items ?? [];
}

/** The first painted range of a thread, for bringing its passage into view. */
export function paintedRange(doc: Document, annId: string): Range | null {
  return states.get(doc)?.items.find((item) => item.annId === annId)?.ranges[0] ?? null;
}

/** Whether anything of ours is registered in this document's highlights. */
export function hasPaint(doc: Document): boolean {
  const reg = registry(doc);
  if (reg && [...reg.highlights.keys()].some((name) => name.startsWith(PAINT_PREFIX))) return true;
  return (states.get(doc)?.items.length ?? 0) > 0 && states.get(doc)?.shown === true;
}

/**
 * Which thread's painted passage is under a point in the frame's viewport, or
 * null. A painted passage is no element a click can land on, so it is found
 * the way a reader sees it: the point is inside one of the passage's own line
 * boxes, the passage is visible (a hidden slide's line boxes sit exactly
 * under the shown slide's), and nothing of the page's covers it there. Where
 * passages overlap, the smallest wins, as the innermost mark did.
 */
export function paintedAt(doc: Document, x: number, y: number): string | null {
  const state = states.get(doc);
  if (!state || !state.shown) return null;
  const top = typeof doc.elementFromPoint === "function" ? doc.elementFromPoint(x, y) : null;
  let best: { annId: string; area: number } | null = null;
  for (const item of state.items) {
    for (const range of item.ranges) {
      const rects = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
      if (!rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) continue;
      const start = range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement;
      if (!start || !isVisible(start)) continue;
      if (top && !range.intersectsNode(top) && !top.contains(range.commonAncestorContainer)) continue;
      const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
      if (!best || area < best.area) best = { annId: item.annId, area };
    }
  }
  return best?.annId ?? null;
}

/** Show the hand while the pointer is over a painted passage, through the stylesheet alone. */
export function setPaintHover(doc: Document, hovering: boolean): void {
  const state = states.get(doc);
  if (!state || state.hovering === hovering) return;
  state.hovering = hovering;
  state.sheet?.set(rulesFor(state));
}
