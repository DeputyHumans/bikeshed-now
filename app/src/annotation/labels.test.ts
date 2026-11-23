// SPDX-License-Identifier: Apache-2.0
// A suggestion's replacement in a layer of ours, beside its passage, where it can be seen, and never in the text (SPEC §22, ADR 0043).

import { afterEach, describe, expect, it, vi } from "vitest";
import { OWN_ATTR, SUG_LABEL_STYLE_ID, SUG_LAYER_ID } from "../brand/dom";
import { createSuggestionLabels } from "./labels";

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
});

/** Two slides in one box, the first shown; every passage ends on one stated line box. */
function deck() {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  frames.push(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = `<section id="s1"><p id="p1">We can cut over in a weekend.</p></section><section id="s2" style="visibility: hidden"><p id="p2">Two weeks.</p></section>`;
  const view = doc.defaultView!;
  const proto = view.Range.prototype as unknown as { getClientRects?: () => DOMRect[] };
  proto.getClientRects = () => [new DOMRect(10, 40, 120, 18)];
  Object.defineProperty(view, "innerWidth", { value: 1000, configurable: true });
  const queue: FrameRequestCallback[] = [];
  view.requestAnimationFrame = ((cb: FrameRequestCallback) => queue.push(cb)) as unknown as typeof view.requestAnimationFrame;
  view.cancelAnimationFrame = () => {};
  const flush = async () => {
    await Promise.resolve();
    for (const cb of queue.splice(0)) cb(0);
  };
  const over = (id: string) => {
    const range = doc.createRange();
    range.selectNodeContents(doc.getElementById(id)!);
    return range;
  };
  const labels = () => Array.from(doc.querySelectorAll<HTMLElement>(`#${SUG_LAYER_ID} .bshd-sug-label`));
  return { doc, flush, over, labels };
}

describe("a suggestion's label", () => {
  it("shows the replacement just above the end of its passage, in a layer the strip removes", async () => {
    const { doc, flush, over, labels } = deck();
    const before = doc.body.textContent;
    const layer = createSuggestionLabels(doc);
    layer.render([{ annId: "s1x", range: over("p1"), color: "#7c3aed", text: "two weekends" }]);
    await flush();
    const [label] = labels();
    expect(label.getAttribute("data-text")).toBe("two weekends");
    // The end of the last line box, in page coordinates; raised by the stylesheet.
    expect([label.style.left, label.style.top]).toEqual(["130px", "40px"]);
    expect(label.style.getPropertyValue("--bshd-author")).toBe("#7c3aed");
    // Generated content, never a text node: anchors measure the document's text.
    expect(doc.body.textContent).toBe(before);
    expect(doc.getElementById(SUG_LAYER_ID)!.getAttribute(OWN_ATTR)).toBe("sug-labels");
    expect(doc.getElementById(SUG_LABEL_STYLE_ID)!.textContent).toContain("content: attr(data-text)");
    layer.destroy();
    expect(doc.getElementById(SUG_LAYER_ID)).toBeNull();
    expect(doc.getElementById(SUG_LABEL_STYLE_ID)).toBeNull();
  });

  it("is drawn only where its passage can be seen, and follows the deck from slide to slide", async () => {
    const { doc, flush, over, labels } = deck();
    const layer = createSuggestionLabels(doc);
    layer.render([{ annId: "s2x", range: over("p2"), color: "#7c3aed", text: "Three weeks." }]);
    await flush();
    expect(labels()).toHaveLength(0);
    doc.getElementById("s1")!.setAttribute("style", "visibility: hidden");
    doc.getElementById("s2")!.setAttribute("style", "");
    await flush();
    expect(labels()).toHaveLength(1);
    layer.destroy();
  });

  it("hides while comments are hidden, and comes back", async () => {
    const { doc, flush, over, labels } = deck();
    const layer = createSuggestionLabels(doc);
    layer.render([{ annId: "s1x", range: over("p1"), color: "#7c3aed", text: "two weekends" }]);
    await flush();
    layer.setShown(false);
    await flush();
    expect(labels()).toHaveLength(0);
    expect(doc.getElementById(SUG_LAYER_ID)!.hidden).toBe(true);
    layer.setShown(true);
    await flush();
    expect(labels()).toHaveLength(1);
    layer.destroy();
  });

  it("stays inside the page at its right edge", async () => {
    const { doc, flush, over, labels } = deck();
    const proto = doc.defaultView!.HTMLElement.prototype;
    vi.spyOn(proto, "getBoundingClientRect").mockReturnValue(new DOMRect(130, 22, 1000, 18));
    const layer = createSuggestionLabels(doc);
    layer.render([{ annId: "s1x", range: over("p1"), color: "#7c3aed", text: "a very long replacement" }]);
    await flush();
    expect(labels()[0].style.left).toBe("0px");
    layer.destroy();
  });
});
