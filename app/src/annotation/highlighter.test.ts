// SPDX-License-Identifier: Apache-2.0
// The serializer is the single most valuable test in this app (SPEC §6a).

import { describe, expect, it, vi } from "vitest";
import {
  captureAssetTags,
  clearHighlights,
  ensureHighlightStyles,
  highlightRange,
  serializeCleanHtml,
  assertNoDecoration,
} from "./highlighter";
import * as textPosition from "dom-anchor-text-position";
import { ANN_ATTR, EMPTY_ATTR, HL_CLASS, HL_STYLE_ID, OWN_ATTR } from "../brand/dom";

/**
 * Everything this app injects passes through serializeCleanHtml on its way to a
 * published version. A bug here does not throw and does not look wrong: it
 * writes corrupted bytes, and nobody notices until the document is.
 */

function makeDoc(body: string, head = ""): Document {
  return new DOMParser().parseFromString(
    `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`,
    "text/html",
  );
}

function rangeOver(doc: Document, selector: string): Range {
  const el = doc.querySelector(selector)!;
  const range = doc.createRange();
  range.selectNodeContents(el);
  return range;
}

describe("serializeCleanHtml", () => {
  it("is the identity on a document nothing has touched", () => {
    const doc = makeDoc("<section id=s1><p>Hello <em>there</em></p></section>");
    const out = serializeCleanHtml(doc);
    expect(out).toContain("<section id=\"s1\">");
    expect(out).toContain("<em>there</em>");
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("preserves the doctype, which outerHTML drops", () => {
    // A document that loses its doctype renders in quirks mode forever after.
    const doc = makeDoc("<p>x</p>");
    expect(serializeCleanHtml(doc)).toMatch(/^<!DOCTYPE html>\n<html/);
  });

  it("unwraps highlights, keeping their text and their structure", () => {
    const doc = makeDoc("<section id=s1><p>alpha <b>beta</b> gamma</p></section>");
    highlightRange(doc, rangeOver(doc, "p"), "a1");
    expect(doc.querySelectorAll(`mark.${HL_CLASS}`).length).toBeGreaterThan(0);

    const out = serializeCleanHtml(doc);
    expect(out).not.toContain(HL_CLASS);
    expect(out).not.toContain(ANN_ATTR);
    expect(out).toContain("alpha");
    expect(out).toContain("<b>beta</b>");
    expect(out).toContain("gamma");
  });

  it("does not re-parent nested elements while unwrapping", () => {
    const doc = makeDoc("<section id=s1><p>one <b>two <i>three</i></b> four</p></section>");
    highlightRange(doc, rangeOver(doc, "p"), "a1");
    const out = serializeCleanHtml(doc);
    // The <i> must still be inside the <b>: a highlight is presentational and
    // must never change the document's structure.
    expect(out).toMatch(/<b>two <i>three<\/i><\/b>/);
  });

  it("strips the injected stylesheet", () => {
    const doc = makeDoc("<p>x</p>");
    ensureHighlightStyles(doc);
    expect(doc.querySelector(`[${OWN_ATTR}]`)).not.toBeNull();
    expect(serializeCleanHtml(doc)).not.toContain(OWN_ATTR);
  });

  it("KEEPS a node that uses our attribute with a value we never write", () => {
    // The whole point of the value check. Removing on attribute presence alone
    // would silently delete an author's own markup.
    const doc = makeDoc(`<div ${OWN_ATTR}="something-else">theirs</div><p>x</p>`);
    const out = serializeCleanHtml(doc);
    expect(out).toContain("something-else");
    expect(out).toContain("theirs");
  });

  it("removes placeholder marking as an ATTRIBUTE, leaving the element", () => {
    const doc = makeDoc(`<div id="chart" ${EMPTY_ATTR}="#chart"></div>`);
    const out = serializeCleanHtml(doc);
    expect(out).not.toContain(EMPTY_ATTR);
    expect(out).toContain('<div id="chart"></div>');
  });

  it("removes contenteditable, which is an affordance and not content", () => {
    const doc = makeDoc('<body><p contenteditable="true">x</p>');
    expect(serializeCleanHtml(doc)).not.toContain("contenteditable");
  });

  it("does not mutate the live document", () => {
    const doc = makeDoc("<section id=s1><p>alpha</p></section>");
    ensureHighlightStyles(doc);
    highlightRange(doc, rangeOver(doc, "p"), "a1");
    const before = doc.documentElement.outerHTML;
    serializeCleanHtml(doc);
    // Stripping in place would make the editor's own view flicker and could
    // move the caret mid-keystroke.
    expect(doc.documentElement.outerHTML).toBe(before);
  });

  describe("the authored-asset budget", () => {
    it("drops an asset tag that appeared after load", () => {
      const doc = makeDoc("<p>x</p>", "<style>body{}</style>");
      const authored = captureAssetTags(doc);

      const extension = doc.createElement("style");
      extension.id = "some-extension-preloader";
      extension.textContent = ".x{}";
      doc.head.appendChild(extension);

      const out = serializeCleanHtml(doc, { authoredAssets: authored });
      expect(out).toContain("body{}");
      expect(out).not.toContain("some-extension-preloader");
    });

    it("is a multiset: a duplicate of an authored tag is dropped, the original survives", () => {
      const doc = makeDoc("<p>x</p>", "<style>body{}</style>");
      const authored = captureAssetTags(doc);
      const duplicate = doc.createElement("style");
      duplicate.textContent = "body{}";
      doc.head.appendChild(duplicate);

      const out = serializeCleanHtml(doc, { authoredAssets: authored });
      expect(out.match(/body\{\}/g)).toHaveLength(1);
    });

    it("keeps BOTH when the author genuinely wrote the same tag twice", () => {
      const doc = makeDoc("<p>x</p>", "<style>body{}</style><style>body{}</style>");
      const authored = captureAssetTags(doc);
      const out = serializeCleanHtml(doc, { authoredAssets: authored });
      expect(out.match(/body\{\}/g)).toHaveLength(2);
    });

    it("leaves script-injected assets alone when no inventory is supplied", () => {
      // The export path snapshots a POST-script DOM, where a stylesheet the
      // document's own script injected is load-bearing rather than contamination.
      const doc = makeDoc("<p>x</p>");
      const injected = doc.createElement("style");
      injected.textContent = ".generated{}";
      doc.head.appendChild(injected);
      expect(serializeCleanHtml(doc)).toContain(".generated{}");
    });
  });
});

describe("assertNoDecoration", () => {
  it("throws when a highlight survived into edit mode", () => {
    const doc = makeDoc("<section id=s1><p>alpha</p></section>");
    highlightRange(doc, rangeOver(doc, "p"), "a1");
    expect(() => assertNoDecoration(doc, "edit mode")).toThrow(/decoration survived/);
  });

  it("throws when the injected stylesheet survived", () => {
    const doc = makeDoc("<p>x</p>");
    ensureHighlightStyles(doc);
    expect(() => assertNoDecoration(doc, "edit mode")).toThrow();
  });

  it("is silent on a clean document", () => {
    const doc = makeDoc("<p>x</p>");
    expect(() => assertNoDecoration(doc, "edit mode")).not.toThrow();
  });

  it("is silent after the strip that edit mode performs", () => {
    const doc = makeDoc("<section id=s1><p>alpha</p></section>");
    ensureHighlightStyles(doc);
    highlightRange(doc, rangeOver(doc, "p"), "a1");
    clearHighlights(doc);
    doc.querySelector(`[${OWN_ATTR}]`)?.remove();
    expect(() => assertNoDecoration(doc, "edit mode")).not.toThrow();
  });
});

describe("highlightRange", () => {
  it("opens a collapsed <details> so the highlight is visible", () => {
    // Rehydrating into a folded section and leaving it folded means the reader
    // sees a comment about text that is not on screen.
    const doc = makeDoc(
      "<section id=s1><details><summary>More</summary><p>hidden text</p></details></section>",
    );
    const details = doc.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    highlightRange(doc, rangeOver(doc, "details p"), "a1");
    expect(details.open).toBe(true);
  });

  it("opens NESTED details, not just the nearest one", () => {
    const doc = makeDoc(
      "<section id=s1><details><summary>Outer</summary><details><summary>Inner</summary><p>deep</p></details></details></section>",
    );
    highlightRange(doc, rangeOver(doc, "details details p"), "a1");
    for (const d of Array.from(doc.querySelectorAll("details"))) {
      expect((d as HTMLDetailsElement).open).toBe(true);
    }
  });


  it("carries the author's colour, so a highlight traces to a person", () => {
    const doc = makeDoc("<section id=s1><p>alpha</p></section>");
    highlightRange(doc, rangeOver(doc, "p"), "a1", {
      authorEmail: "ana@example.com",
    });
    const mark = doc.querySelector("mark") as HTMLElement;
    expect(mark.style.cssText).toContain("--bshd-author");
  });
});

describe("inside SVG text", () => {
  /**
   * SVG paints no foreign child of a text content element, so an HTML <mark>
   * wrapped around a label in a figure made the label disappear. jsdom does
   * not lay out, so "the label stays visible" cannot be asserted here; the
   * wrapper's NAMESPACE can, and that is what decides whether it paints.
   */
  const SVG_NS = "http://www.w3.org/2000/svg";
  const figure =
    '<section id=s1><p>prose</p><figure><svg viewBox="0 0 100 20">' +
    '<text id="lane" x="0" y="10">LINEAR</text></svg></figure></section>';

  it("wraps SVG text in a <tspan>, not a <mark>", () => {
    const doc = makeDoc(figure);
    highlightRange(doc, rangeOver(doc, "#lane"), "a1", { authorEmail: "ana@example.com" });
    expect(doc.querySelector("mark")).toBeNull();
    const wrapper = doc.querySelector(`#lane > .${HL_CLASS}`)!;
    expect(wrapper.localName).toBe("tspan");
    expect(wrapper.namespaceURI).toBe(SVG_NS);
    expect(wrapper.getAttribute(ANN_ATTR)).toBe("a1");
    expect((wrapper as SVGElement).style.cssText).toContain("--bshd-author");
    expect(wrapper.textContent).toBe("LINEAR");
  });

  it("gives each text node the wrapper its own namespace needs", () => {
    const doc = makeDoc(figure);
    highlightRange(doc, rangeOver(doc, "section"), "a1");
    expect(doc.querySelector(`p > mark.${HL_CLASS}`)).not.toBeNull();
    expect(doc.querySelector(`text > tspan.${HL_CLASS}`)).not.toBeNull();
    expect(doc.querySelector("text mark")).toBeNull();
  });

  it("unwraps a tspan on clear and on serialize, leaving the <text> as authored", () => {
    const doc = makeDoc(figure);
    highlightRange(doc, rangeOver(doc, "#lane"), "a1");
    const out = serializeCleanHtml(doc);
    expect(out).not.toContain("tspan");
    expect(out).not.toContain(HL_CLASS);
    expect(out).toContain('<text id="lane" x="0" y="10">LINEAR</text>');

    clearHighlights(doc);
    expect(doc.querySelector("tspan")).toBeNull();
    expect(doc.querySelector("#lane")!.childNodes).toHaveLength(1);
  });

  it("selects and clicks through a tspan exactly as through a mark", async () => {
    const { setSelectedHighlight, attachHighlightClick } = await import("./highlighter");
    const doc = makeDoc(figure);
    highlightRange(doc, rangeOver(doc, "#lane"), "a1");

    setSelectedHighlight(doc, "a1");
    expect(doc.querySelector("tspan")!.getAttribute("data-selected")).toBe("true");
    setSelectedHighlight(doc, null);
    expect(doc.querySelector("[data-selected]")).toBeNull();

    const seen: string[] = [];
    attachHighlightClick(doc, (id) => seen.push(id));
    doc.querySelector("tspan")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(seen).toEqual(["a1"]);
  });

  it("is decoration the invariant assertion catches", () => {
    const doc = makeDoc(figure);
    highlightRange(doc, rangeOver(doc, "#lane"), "a1");
    expect(() => assertNoDecoration(doc, "a test")).toThrow(/highlight/);
  });

  it("is drawn with a stroke, because a border does not apply to SVG text", () => {
    // And not an underline: SVG text decorations ignore text-decoration-color,
    // so an underline could not carry the author's colour.
    const doc = makeDoc(figure);
    ensureHighlightStyles(doc);
    const css = doc.getElementById(HL_STYLE_ID)!.textContent!;
    const rule = /tspan\.bshd-hl\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/paint-order:\s*stroke fill/);
    expect(rule).toMatch(/stroke:\s*var\(--bshd-author/);
  });
});

describe("selection and clicks", () => {
  it("marks exactly one thread as selected", async () => {
    const { setSelectedHighlight } = await import("./highlighter");
    const doc = makeDoc("<section id=s1><p>alpha</p><p>beta</p></section>");
    highlightRange(doc, rangeOver(doc, "p:first-child"), "a1");
    highlightRange(doc, rangeOver(doc, "p:last-child"), "a2");

    setSelectedHighlight(doc, "a2");
    expect(doc.querySelector(`[${ANN_ATTR}="a1"]`)?.getAttribute("data-selected")).toBeNull();
    expect(doc.querySelector(`[${ANN_ATTR}="a2"]`)?.getAttribute("data-selected")).toBe("true");

    setSelectedHighlight(doc, null);
    expect(doc.querySelector("[data-selected]")).toBeNull();
  });

  it("reports a click on a highlight, and detaches cleanly", async () => {
    const { attachHighlightClick } = await import("./highlighter");
    const doc = makeDoc("<section id=s1><p>alpha</p></section>");
    highlightRange(doc, rangeOver(doc, "p"), "a1");

    const seen: string[] = [];
    const detach = attachHighlightClick(doc, (id) => seen.push(id));
    doc.querySelector("mark")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(seen).toEqual(["a1"]);

    detach();
    doc.querySelector("mark")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(seen).toEqual(["a1"]);
  });

  it("ignores a click that is not on a highlight", async () => {
    const { attachHighlightClick } = await import("./highlighter");
    const doc = makeDoc("<section id=s1><p>alpha</p></section>");
    const seen: string[] = [];
    attachHighlightClick(doc, (id) => seen.push(id));
    doc.querySelector("p")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(seen).toEqual([]);
  });

  it("keeps a click on a highlight from the document's own listeners", async () => {
    // The click is the thread's. A deck that advances on click would otherwise
    // move off the passage the reader just opened.
    const { attachHighlightClick } = await import("./highlighter");
    const doc = makeDoc("<section id=s1><p>alpha</p><p>beta</p></section>");
    highlightRange(doc, rangeOver(doc, "p:first-child"), "a1");
    const advance = vi.fn();
    doc.addEventListener("click", advance);
    attachHighlightClick(doc, () => {});

    doc.querySelector("mark")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(advance).not.toHaveBeenCalled();

    // Plain text is still the document's to answer.
    doc.querySelector("p:last-child")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it("leaves a resolved annotation undrawn, and does not call it orphaned", async () => {
    const { redrawHighlights } = await import("./highlighter");
    const doc = makeDoc("<section id=s1><p>alpha</p></section>");
    const anchor = { elementId: "s1", exact: "alpha", prefix: "", suffix: "", start: 0, end: 5 };
    let resolverCalls = 0;
    const result = redrawHighlights(
      doc,
      [
        { annId: "open", resolved: false, anchor },
        { annId: "done", resolved: true, anchor },
      ] as never,
      () => {
        resolverCalls += 1;
        return rangeOver(doc, "p");
      },
    );

    // Resolving a comment has to make the document visibly cleaner, or there
    // is no reason to do it.
    expect(result.drawn).toEqual(["open"]);
    expect(doc.querySelectorAll(`mark.${HL_CLASS}`)).toHaveLength(1);
    // Skipped BEFORE the anchor is resolved: whether a settled comment's
    // passage still matches is not a question worth answering.
    expect(resolverCalls).toBe(1);
    expect(result.orphaned).toEqual([]);
  });

  it("reports an anchor it cannot resolve as orphaned rather than dropping it", async () => {
    const { redrawHighlights } = await import("./highlighter");
    const doc = makeDoc("<section id=s1><p>alpha</p></section>");
    const result = redrawHighlights(
      doc,
      [
        {
          annId: "gone",
          anchor: {
            elementId: "missing-section",
            exact: "x",
            prefix: "",
            suffix: "",
            start: 0,
            end: 1,
          },
        } as never,
      ],
      () => null,
    );
    // A comment whose passage was edited away still has to be readable, or the
    // feedback is simply lost.
    expect(result.orphaned).toEqual(["gone"]);
    expect(result.drawn).toEqual([]);
  });

  it("clearHighlights is safe on a document with none", () => {
    const doc = makeDoc("<p>x</p>");
    expect(() => clearHighlights(doc)).not.toThrow();
  });

  it("captures an empty inventory for a document with no asset tags", () => {
    expect(captureAssetTags(makeDoc("<p>x</p>")).size).toBe(0);
  });
});

describe("suggestion marks (SPEC §22)", () => {
  const sugDoc = () =>
    makeDoc(`<section id="s1"><p id="p">We can cut over in a <em>single</em> weekend.</p></section>`);
  const rangeOverText = (doc: Document, text: string): Range => {
    const p = doc.getElementById("p")!;
    const start = p.textContent!.indexOf(text);
    return textPosition.toRange(p, { start, end: start + text.length })!;
  };

  it("strikes every segment and hangs the replacement on the last one only", async () => {
    const { SUG_ATTR, INS_ATTR } = await import("../brand/dom");
    const doc = sugDoc();
    highlightRange(doc, rangeOverText(doc, "a single weekend"), "s1x", {
      suggestion: { replacement: "two weekends" },
    });
    const marks = Array.from(doc.querySelectorAll(`.${HL_CLASS}`));
    expect(marks.length).toBe(3); // "a ", "single" inside <em>, " weekend"
    expect(marks.every((m) => m.getAttribute(SUG_ATTR) === "s1x")).toBe(true);
    expect(marks.map((m) => m.getAttribute(INS_ATTR))).toEqual([null, null, "two weekends"]);
  });

  it("adds nothing to the document's text, which every anchor is measured against", () => {
    const doc = sugDoc();
    const before = doc.body.textContent;
    highlightRange(doc, rangeOverText(doc, "a single weekend"), "s1x", {
      suggestion: { replacement: "two weekends" },
    });
    expect(doc.body.textContent).toBe(before);
  });

  it("hangs nothing on a deletion", async () => {
    const { INS_ATTR } = await import("../brand/dom");
    const doc = sugDoc();
    highlightRange(doc, rangeOverText(doc, "a single weekend"), "s1x", { suggestion: { replacement: "" } });
    expect(doc.querySelector(`[${INS_ATTR}]`)).toBeNull();
  });

  it("is stripped from published bytes, with the author's words kept and the replacement nowhere", () => {
    const doc = sugDoc();
    ensureHighlightStyles(doc);
    highlightRange(doc, rangeOverText(doc, "a single weekend"), "s1x", {
      suggestion: { replacement: "two weekends" },
    });
    const html = serializeCleanHtml(doc);
    for (const trace of ["data-bshd-sug", "data-bshd-ins", "two weekends", HL_CLASS]) {
      expect(html, trace).not.toContain(trace);
    }
    expect(html).toContain("We can cut over in a <em>single</em> weekend.");
  });

  it("is caught by the dev-only assertion if it ever survives", () => {
    const doc = sugDoc();
    highlightRange(doc, rangeOverText(doc, "a single weekend"), "s1x", {
      suggestion: { replacement: "two weekends" },
    });
    expect(() => assertNoDecoration(doc, "the test")).toThrow(/suggestion mark/);
  });

  it("a pending suggestion that no longer resolves is stale, not orphaned; a decided one is not drawn", async () => {
    const { redrawHighlights } = await import("./highlighter");
    const doc = sugDoc();
    const base = {
      authorUid: "u1",
      authorEmail: "ana@example.com",
      actor: { uid: "u1", email: "ana@example.com", channel: "web" as const },
      color: "#b5257b",
      createdAt: null as never,
      anchor: { elementId: "s1", exact: "x", prefix: "", suffix: "", start: 0, end: 1 },
    };
    const result = redrawHighlights(
      doc,
      [
        { ...base, annId: "gone", resolved: false, suggestion: { replacement: "y", state: "pending" } },
        { ...base, annId: "done", resolved: true, suggestion: { replacement: "y", state: "accepted" } },
        { ...base, annId: "comment", resolved: false },
      ],
      () => null,
      () => null,
    );
    expect(result).toEqual({ drawn: [], orphaned: ["comment"], stale: ["gone"] });
  });
});
