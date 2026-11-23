// SPDX-License-Identifier: Apache-2.0
// Highlights painted into the frame's CSS.highlights, grouped, selected, hidden and lit, with nothing in the document (ADR 0043).

import { afterEach, describe, expect, it } from "vitest";
import { installHighlightApi, paintedTexts } from "../test/highlights";
import {
  hasPaint,
  paint,
  paintSelected,
  paintedAt,
  setFlash,
  setPaintHover,
  setPaintShown,
  unpaint,
  type PaintItem,
} from "./paint";

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
});

/** A frame with a browser's highlight registry, and its paragraphs' text as ranges. */
function framed(body = `<p id="a">alpha</p><p id="b">beta</p><p id="c">gamma</p>`) {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  frames.push(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = body;
  const registry = installHighlightApi(frame.contentWindow!);
  const over = (id: string) => {
    const range = doc.createRange();
    range.selectNodeContents(doc.getElementById(id)!);
    return range;
  };
  return { doc, registry, over, win: frame.contentWindow! };
}

const item = (annId: string, ranges: Range[], color: string, suggestion = false): PaintItem => ({ annId, ranges, color, suggestion });

describe("painting", () => {
  it("registers one highlight per author colour, and one per colour for suggestions", () => {
    const { doc, registry, over } = framed();
    paint(doc, [item("t1", [over("a")], "#111111"), item("t2", [over("b")], "#111111"), item("t3", [over("c")], "#222222", true)]);
    expect(paintedTexts(registry)).toEqual({
      "bshd-hl-c0": ["alpha", "beta"],
      "bshd-hl-sug1": ["gamma"],
    });
    const css = doc.getElementById("bshd-hl-style")!.textContent!;
    expect(css).toMatch(/::highlight\(bshd-hl-c0\) \{[^}]*#111111[^}]*underline/);
    expect(css).toMatch(/::highlight\(bshd-hl-sug1\) \{[^}]*#222222[^}]*line-through/);
    // Screen only: a printout shows the document.
    expect(css.startsWith("@media screen")).toBe(true);
  });

  it("adds no node to the body, and leaves the document's own highlights alone", () => {
    const { doc, registry, over } = framed();
    const theirs = { priority: 0 };
    registry.set("their-own", theirs as never);
    const before = doc.body.innerHTML;
    paint(doc, [item("t1", [over("a")], "#111111")]);
    expect(doc.body.innerHTML).toBe(before);
    unpaint(doc);
    expect([...registry.keys()]).toEqual(["their-own"]);
    expect(doc.getElementById("bshd-hl-style")).toBeNull();
  });

  it("paints the selected thread above the rest, and only it", () => {
    const { doc, registry, over } = framed();
    paint(doc, [item("t1", [over("a")], "#111111"), item("t2", [over("b")], "#222222")]);
    paintSelected(doc, "t2");
    expect(paintedTexts(registry)["bshd-hl-selected"]).toEqual(["beta"]);
    expect(registry.get("bshd-hl-selected")!.priority).toBeGreaterThan(registry.get("bshd-hl-c0")!.priority);
    paintSelected(doc, null);
    expect(registry.has("bshd-hl-selected")).toBe(false);
  });

  it("hides every thread and brings them back as they were", () => {
    const { doc, registry, over } = framed();
    paint(doc, [item("t1", [over("a")], "#111111")]);
    paintSelected(doc, "t1");
    setPaintShown(doc, false);
    expect(registry.size).toBe(0);
    expect(hasPaint(doc)).toBe(false);
    setPaintShown(doc, true);
    expect(paintedTexts(registry)).toEqual({ "bshd-hl-c0": ["alpha"], "bshd-hl-selected": ["alpha"] });
  });

  it("lights one thread on its own while the rest are hidden", () => {
    const { doc, registry, over } = framed();
    paint(doc, [item("t1", [over("a")], "#111111"), item("t2", [over("b")], "#222222")]);
    setPaintShown(doc, false);
    setFlash(doc, "t2", true);
    expect(paintedTexts(registry)).toEqual({ "bshd-hl-flash": ["beta"] });
    setFlash(doc, "t2", false);
    expect(registry.size).toBe(0);
    setFlash(doc, null);
    expect(registry.size).toBe(0);
  });

  it("uses an adopted stylesheet where the browser has one, so not even a <style> is added", () => {
    const { doc, over, win } = framed();
    const adopted: { css: string }[] = [];
    class Sheet {
      css = "";
      replaceSync(css: string) {
        this.css = css;
      }
    }
    Object.defineProperty(win, "CSSStyleSheet", { value: Sheet, configurable: true });
    Object.defineProperty(doc, "adoptedStyleSheets", {
      configurable: true,
      get: () => adopted,
      set: (sheets: { css: string }[]) => adopted.splice(0, adopted.length, ...sheets),
    });
    paint(doc, [item("t1", [over("a")], "#111111")]);
    expect(doc.getElementById("bshd-hl-style")).toBeNull();
    expect(adopted).toHaveLength(1);
    expect(adopted[0].css).toContain("::highlight(bshd-hl-c0)");
    // The hand over a painted passage is the stylesheet's alone.
    setPaintHover(doc, true);
    expect(adopted[0].css).toContain("cursor: pointer");
    setPaintHover(doc, false);
    expect(adopted[0].css).not.toContain("cursor: pointer");
    unpaint(doc);
    expect(adopted).toHaveLength(0);
  });
});

describe("finding a painted passage under a point", () => {
  function laidOut(boxes: Record<string, DOMRect>) {
    const made = framed(`<p id="a">alpha</p><p id="b" style="opacity: 0">beta</p>`);
    const proto = made.doc.defaultView!.Range.prototype as unknown as { getClientRects?: () => DOMRect[] };
    proto.getClientRects = function (this: Range) {
      const box = boxes[this.toString()];
      return box ? [box] : [];
    };
    return made;
  }

  it("is the thread whose line box holds the point, and none beside it", () => {
    const { doc, over } = laidOut({ alpha: new DOMRect(0, 0, 100, 20) });
    paint(doc, [item("t1", [over("a")], "#111111")]);
    expect(paintedAt(doc, 50, 10)).toBe("t1");
    expect(paintedAt(doc, 150, 10)).toBeNull();
    expect(paintedAt(doc, 50, 30)).toBeNull();
  });

  it("is never a passage the reader cannot see, though its box is under the point", () => {
    const { doc, over } = laidOut({ beta: new DOMRect(0, 0, 100, 20) });
    paint(doc, [item("t2", [over("b")], "#111111")]);
    expect(paintedAt(doc, 50, 10)).toBeNull();
  });

  it("is nothing while threads are hidden", () => {
    const { doc, over } = laidOut({ alpha: new DOMRect(0, 0, 100, 20) });
    paint(doc, [item("t1", [over("a")], "#111111")]);
    setPaintShown(doc, false);
    expect(paintedAt(doc, 50, 10)).toBeNull();
  });
});
