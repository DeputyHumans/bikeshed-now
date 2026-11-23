// SPDX-License-Identifier: Apache-2.0
// A stand-in for the CSS Custom Highlight API, which jsdom lacks, so a test can read what is painted (ADR 0043).

/** One registered highlight, as the stand-in keeps it. */
export interface FakeHighlight {
  ranges: Range[];
  priority: number;
}

/**
 * Give a frame's window `Highlight` and `CSS.highlights`, as a browser does,
 * and return the registry so a test can read what was painted. Installed on
 * the FRAME's window, because the painter reads the document's own realm.
 */
export function installHighlightApi(win: Window): Map<string, FakeHighlight> {
  const registry = new Map<string, FakeHighlight>();
  class Highlight implements FakeHighlight {
    ranges: Range[];
    priority = 0;
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }
  Object.defineProperty(win, "Highlight", { value: Highlight, configurable: true });
  const css = (win as unknown as { CSS?: object }).CSS ?? {};
  Object.defineProperty(win, "CSS", { value: { ...css, highlights: registry }, configurable: true });
  return registry;
}

/** The text each registered highlight paints, by name, for asserting on. */
export function paintedTexts(registry: Map<string, FakeHighlight>): Record<string, string[]> {
  return Object.fromEntries([...registry.entries()].map(([name, h]) => [name, h.ranges.map((r) => r.toString())]));
}

/** Every piece of text painted under any name, for asserting a passage is painted at all. */
export function allPainted(registry: Map<string, FakeHighlight>): string[] {
  return [...registry.values()].flatMap((h) => h.ranges.map((r) => r.toString()));
}
