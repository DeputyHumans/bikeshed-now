// SPDX-License-Identifier: Apache-2.0
// The serializer is the single most valuable test in this app (SPEC §6a).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureAssetTags,
  clearHighlights,
  ensureHighlightStyles,
  highlightRange,
  serializeCleanHtml,
  assertNoDecoration,
} from "./highlighter";
import * as textPosition from "dom-anchor-text-position";
import { ANN_ATTR, EMPTY_ATTR, HL_CLASS, HL_STYLE_ID, OWN_ATTR, SUG_LAYER_ID } from "../brand/dom";
import { peerColor } from "../brand/tokens";
import { paintedItems } from "./paint";

/** The text each painted thread covers, by thread, joined. */
function paintedText(doc: Document): Record<string, string> {
  return Object.fromEntries(paintedItems(doc).map((item) => [item.annId, item.ranges.map((r) => r.toString()).join("")]));
}

/**
 * jsdom gives a Range no geometry at all. A click on a painted passage is
 * matched by where it lands, so each case states it: the passages whose text
 * is listed have one line box at the given rect, the rest have none.
 */
function layOut(boxes: Record<string, DOMRect>): void {
  const proto = Range.prototype as unknown as { getClientRects?: () => DOMRect[] };
  const had = proto.getClientRects;
  beforeEach(() => {
    proto.getClientRects = function (this: Range) {
      const box = boxes[this.toString()];
      return box ? [box] : [];
    };
  });
  afterEach(() => {
    proto.getClientRects = had;
  });
}

function clickAt(doc: Document, x: number, y: number, on: Element = doc.body): void {
  on.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
}

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

  it("unwraps any highlight wrapper that reaches it, keeping its text and its structure", () => {
    // A painted highlight adds no node (ADR 0043), but an SVG wrapper does, and
    // a frame from before painting could still hand over a <mark>.
    const doc = makeDoc(
      `<section id=s1><p>alpha <mark class="${HL_CLASS}" ${ANN_ATTR}="a1"><b>beta</b></mark> gamma</p></section>`,
    );

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

  it("keeps authored editing attributes when no editor overrides are supplied", () => {
    const doc = makeDoc('<p contenteditable="false" spellcheck="false">x</p>');
    doc.body.setAttribute("contenteditable", "plaintext-only");
    doc.body.setAttribute("spellcheck", "false");
    expect(serializeCleanHtml(doc)).toContain('<body contenteditable="plaintext-only" spellcheck="false"><p contenteditable="false" spellcheck="false">x</p>');
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
    expect(paintedItems(doc).map((item) => [item.annId, item.color])).toEqual([["a1", peerColor("ana@example.com")]]);
  });

  it("paints HTML text and adds nothing to the document, which a layout could trip on", () => {
    // A <mark> around part of a run of text in a flex or grid container made
    // three items of one, and the slide rearranged itself for every reader.
    const body = `<section id=s1><div style="display:flex;gap:1rem">alpha <b>beta</b> gamma delta</div></section>`;
    const doc = makeDoc(body);
    const before = doc.body.innerHTML;
    const div = doc.querySelector("div")!;
    const range = doc.createRange();
    range.setStart(div.firstChild!, 2);
    range.setEnd(div.lastChild!, 6);
    highlightRange(doc, range, "a1");
    expect(doc.body.innerHTML).toBe(before);
    expect(paintedText(doc)).toEqual({ a1: "pha beta gamma" });
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

  it("paints the HTML text of a passage and wraps only its SVG text", () => {
    // Measured: WebKit paints no highlight inside SVG <text>, so there alone a
    // wrapper stays; Chromium and Firefox would have painted both.
    const doc = makeDoc(figure);
    highlightRange(doc, rangeOver(doc, "section"), "a1");
    expect(doc.querySelector("mark")).toBeNull();
    expect(doc.querySelector(`text > tspan.${HL_CLASS}`)).not.toBeNull();
    expect(paintedText(doc)).toEqual({ a1: "prose" });
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
  layOut({
    alpha: new DOMRect(0, 0, 100, 20),
    beta: new DOMRect(0, 40, 100, 20),
    "alpha beta": new DOMRect(0, 0, 300, 20),
  });

  it("marks exactly one thread as selected", async () => {
    const { setSelectedHighlight } = await import("./highlighter");
    const doc = makeDoc("<section id=s1><p>alpha</p><p>beta</p></section>");
    highlightRange(doc, rangeOver(doc, "p:first-child"), "a1");
    highlightRange(doc, rangeOver(doc, "p:last-child"), "a2");

    setSelectedHighlight(doc, "a2");
    const css = doc.getElementById(HL_STYLE_ID)!.textContent!;
    // One heavier rule, in the selected thread's colour; the painter keeps one.
    expect(css.match(/::highlight\(bshd-hl-selected\)/g)).toHaveLength(1);

    setSelectedHighlight(doc, null);
    expect(doc.getElementById(HL_STYLE_ID)!.textContent).not.toContain("bshd-hl-selected)");
    expect(doc.querySelector("[data-selected]")).toBeNull();
  });

  it("reports a click on a painted passage, by where it lands, and detaches cleanly", async () => {
    const { attachHighlightClick } = await import("./highlighter");
    const doc = makeDoc("<section id=s1><p>alpha</p></section>");
    highlightRange(doc, rangeOver(doc, "p"), "a1");

    const seen: string[] = [];
    const detach = attachHighlightClick(doc, (id) => seen.push(id));
    clickAt(doc, 10, 10);
    expect(seen).toEqual(["a1"]);

    detach();
    clickAt(doc, 10, 10);
    expect(seen).toEqual(["a1"]);
  });

  it("ignores a click that is not on a highlight", async () => {
    const { attachHighlightClick } = await import("./highlighter");
    const doc = makeDoc("<section id=s1><p>alpha</p><p>beta</p></section>");
    highlightRange(doc, rangeOver(doc, "p:first-child"), "a1");
    const seen: string[] = [];
    attachHighlightClick(doc, (id) => seen.push(id));
    // Beside the line box, and on another paragraph's.
    clickAt(doc, 150, 10);
    clickAt(doc, 10, 50, doc.querySelector("p:last-child")!);
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

    clickAt(doc, 10, 10, doc.querySelector("p")!);
    expect(advance).not.toHaveBeenCalled();

    // Plain text is still the document's to answer.
    clickAt(doc, 10, 50, doc.querySelector("p:last-child")!);
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it("opens the innermost of two passages that overlap, as the innermost mark did", async () => {
    const { attachHighlightClick } = await import("./highlighter");
    const doc = makeDoc("<section id=s1><p>alpha beta</p></section>");
    const p = doc.querySelector("p")!;
    const word = doc.createRange();
    word.setStart(p.firstChild!, 0);
    word.setEnd(p.firstChild!, 5);
    highlightRange(doc, rangeOver(doc, "p"), "wide");
    highlightRange(doc, word, "word");
    const seen: string[] = [];
    attachHighlightClick(doc, (id) => seen.push(id));
    clickAt(doc, 10, 10);
    clickAt(doc, 250, 10);
    expect(seen).toEqual(["word", "wide"]);
  });

  it("does not open a passage the reader cannot see, or one something of the page covers", async () => {
    const { attachHighlightClick } = await import("./highlighter");
    // A hidden slide's line boxes sit exactly under the shown slide's.
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.body.innerHTML = `<section id=s1 style="visibility: hidden"><p>alpha</p></section><section id=s2><p>beta</p></section><div id=cover></div>`;
    const proto = frame.contentWindow!.Range.prototype as unknown as { getClientRects?: () => DOMRect[] };
    proto.getClientRects = function (this: Range) {
      return [new DOMRect(0, 0, 100, 20)];
    };
    highlightRange(doc, rangeOver(doc, "#s1 p"), "hidden");
    highlightRange(doc, rangeOver(doc, "#s2 p"), "shown");
    const seen: string[] = [];
    attachHighlightClick(doc, (id) => seen.push(id));
    clickAt(doc, 10, 10);
    expect(seen).toEqual(["shown"]);
    // A cover over the passage takes the click, as it takes the pointer.
    (doc as Document & { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => doc.getElementById("cover");
    clickAt(doc, 10, 10);
    expect(seen).toEqual(["shown"]);
    frame.remove();
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
    expect(Object.keys(paintedText(doc))).toEqual(["open"]);
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

  describe("an agent's comment, anchored on the server (SPEC §19)", () => {
    // What `add_comment` stores: found by quote in the block's text, whitespace
    // collapsed, measured against <body>, offsets local to the paragraph.
    const agentAnchor = (exact: string, prefix: string, suffix: string, start: number) => ({
      elementId: "",
      exact,
      prefix,
      suffix,
      start,
      end: start + exact.length,
      strict: true,
    });
    // Hand-written HTML wraps its lines, so the raw text has a newline and an
    // indent where a reader sees one space.
    const wrapped = () =>
      makeDoc(
        `<p>Rollout notes for the payments migration.</p>\n` +
          `<p>Every team will be\n      moved by the 30th without interruption.</p>`,
      );
    const draw = async (doc: Document, anchor: ReturnType<typeof agentAnchor>) => {
      const { redrawHighlights } = await import("./highlighter");
      const { rangeFromAnchor } = await import("./anchor");
      const { exactRangeFromAnchor } = await import("./exact");
      // The two resolvers useAnnotationLayer passes, not stand-ins.
      return redrawHighlights(
        doc,
        [{ annId: "agent", resolved: false, anchor, authorEmail: "agent@example.com" }] as never,
        (a) => rangeFromAnchor(doc, a),
        (a) => exactRangeFromAnchor(doc, a),
      );
    };
    const drawnText = (doc: Document) => (paintedText(doc).agent ?? "").replace(/\s+/g, " ");

    it("highlights exactly the quoted words where the source wraps the line", async () => {
      const doc = wrapped();
      const result = await draw(doc, agentAnchor("will be moved by the 30th", "Every team ", " without interruption.", 11));
      expect(result.drawn).toEqual(["agent"]);
      expect(drawnText(doc)).toBe("will be moved by the 30th");
    });

    it("is orphaned, not drawn at its offsets, when the quote is not there", async () => {
      const doc = wrapped();
      const result = await draw(doc, agentAnchor("Finance moves first", "", "", 11));
      expect(result.orphaned).toEqual(["agent"]);
      expect(result.drawn).toEqual([]);
      expect(paintedItems(doc)).toHaveLength(0);
    });
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

  it("strikes the passage and shows the replacement in a label of ours, outside the text", () => {
    const doc = sugDoc();
    highlightRange(doc, rangeOverText(doc, "a single weekend"), "s1x", {
      suggestion: { replacement: "two weekends" },
    });
    // Struck through: painted, three runs ("a ", "single" inside <em>, " weekend"), no wrapper.
    const [item] = paintedItems(doc);
    expect(item).toMatchObject({ annId: "s1x", suggestion: true });
    expect(item.ranges.map((r) => r.toString())).toEqual(["a ", "single", " weekend"]);
    expect(doc.querySelector(`.${HL_CLASS}`)).toBeNull();
    // The label layer is ours, marked so the strip removes it whole.
    expect(doc.getElementById(SUG_LAYER_ID)?.getAttribute(OWN_ATTR)).toBe("sug-labels");
  });

  it("adds nothing to the document's text, which every anchor is measured against", () => {
    const doc = sugDoc();
    const before = doc.body.textContent;
    highlightRange(doc, rangeOverText(doc, "a single weekend"), "s1x", {
      suggestion: { replacement: "two weekends" },
    });
    expect(doc.body.textContent).toBe(before);
  });

  it("shows no label for a deletion", () => {
    const doc = sugDoc();
    highlightRange(doc, rangeOverText(doc, "a single weekend"), "s1x", { suggestion: { replacement: "" } });
    expect(doc.getElementById(SUG_LAYER_ID)).toBeNull();
    expect(paintedItems(doc)).toHaveLength(1);
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
    expect(() => assertNoDecoration(doc, "the test")).toThrow(/painted highlight.*injected sug-labels|injected sug-labels.*painted highlight/);
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
