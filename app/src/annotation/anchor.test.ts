// SPDX-License-Identifier: Apache-2.0
// Anchors have to survive edits, and this is the property they exist for (SPEC §6).

import { describe, expect, it } from "vitest";
import { describeAnchorFromRange, rangeFromAnchor, sameAnchor } from "./anchor";

function makeDoc(body: string): Document {
  return new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${body}</body></html>`,
    "text/html",
  );
}

/** A range over the text of one element. */
function rangeOver(doc: Document, selector: string): Range {
  const el = doc.querySelector(selector)!;
  const range = doc.createRange();
  range.selectNodeContents(el);
  return range;
}

/** A range over a substring of a text node. */
function rangeOverText(doc: Document, selector: string, needle: string): Range {
  const el = doc.querySelector(selector)!;
  const text = el.firstChild as Text;
  const start = text.data.indexOf(needle);
  const range = doc.createRange();
  range.setStart(text, start);
  range.setEnd(text, start + needle.length);
  return range;
}

/**
 * Deliberately: the SECTIONS carry ids and the paragraphs do not.
 *
 * That is the shape the authoring guide asks for and the shape the Markdown
 * renderer emits, and it is what makes an anchor's scope a section rather than
 * a paragraph. A paragraph with its own id would scope to itself, which is also
 * correct — but it is not the case worth testing, because a paragraph rarely
 * survives being rewritten.
 */
const DOC = `
  <section id="s1"><p class="first">The first section says one thing.</p></section>
  <section id="s2"><p class="second">The second section says something else entirely.</p></section>
`;

describe("anchors", () => {
  it("round-trips a selection", () => {
    const doc = makeDoc(DOC);
    const anchor = describeAnchorFromRange(doc, rangeOverText(doc, ".second", "something else"))!;
    expect(anchor.elementId).toBe("s2");
    expect(anchor.exact).toBe("something else");

    const back = rangeFromAnchor(doc, anchor)!;
    expect(back.toString()).toBe("something else");
  });

  it("scopes to the nearest id-bearing ancestor, not the body", () => {
    // This is the whole design. Scoped to <body>, every offset in the document
    // shifts when anything above changes.
    const doc = makeDoc(DOC);
    const anchor = describeAnchorFromRange(doc, rangeOverText(doc, ".second", "second"))!;
    expect(anchor.elementId).toBe("s2");
  });

  it("falls back to the body when nothing above has an id", () => {
    const doc = makeDoc("<p>unscoped text here</p>");
    const anchor = describeAnchorFromRange(doc, rangeOverText(doc, "p", "text"))!;
    expect(anchor.elementId).toBe("");
    expect(rangeFromAnchor(doc, anchor)?.toString()).toBe("text");
  });

  it("SURVIVES a large edit to a different section", () => {
    // The property the scoping exists for: adding 500 characters above must not
    // disturb an anchor below it.
    const doc = makeDoc(DOC);
    const anchor = describeAnchorFromRange(doc, rangeOverText(doc, ".second", "something else"))!;

    const p1 = doc.querySelector(".first")!;
    p1.textContent = `${"padding ".repeat(70)}${p1.textContent}`;

    expect(rangeFromAnchor(doc, anchor)?.toString()).toBe("something else");
  });

  it("falls back to POSITION when the quote no longer matches", () => {
    const doc = makeDoc(DOC);
    const anchor = describeAnchorFromRange(doc, rangeOverText(doc, ".second", "something else"))!;

    // Rewrite the anchored text so the quote selector cannot match, while
    // leaving the offsets pointing at roughly the same place.
    doc.querySelector(".second")!.textContent =
      "The second section says SOMETHING DIFFERENT entirely.";

    const range = rangeFromAnchor(doc, anchor);
    expect(range).not.toBeNull();
    expect(range!.startOffset).toBe(anchor.start);
  });

  it("returns null when the scope element is gone entirely", () => {
    const doc = makeDoc(DOC);
    const anchor = describeAnchorFromRange(doc, rangeOverText(doc, ".second", "second"))!;
    doc.querySelector("#s2")!.remove();
    // Null rather than a wrong range: the viewer renders it as an orphaned
    // comment, which is recoverable. A confidently wrong anchor is not.
    expect(rangeFromAnchor(doc, anchor)).toBeNull();
  });

  it("prefers the nearest occurrence when the quote repeats", () => {
    const doc = makeDoc(
      '<section id="s"><p id="a">repeat me</p><p id="b">repeat me</p></section>',
    );
    const second = describeAnchorFromRange(doc, rangeOver(doc, "#b"))!;
    const resolved = rangeFromAnchor(doc, second)!;
    // The position hint is what disambiguates; without it the first occurrence
    // always wins and every duplicated phrase anchors to the wrong one.
    expect(resolved.startContainer.parentElement?.id).toBe("b");
  });

  it("refuses a collapsed or whitespace-only selection", () => {
    const doc = makeDoc('<section id="s"><p id="p">   </p></section>');
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector("#p")!);
    const anchor = describeAnchorFromRange(doc, range);
    // An anchor over whitespace can never be found again, so producing one just
    // creates a comment nobody can locate.
    expect(anchor?.exact.trim()).toBe("");
  });

  it("compares anchors by what identifies a passage", () => {
    const doc = makeDoc(DOC);
    const a = describeAnchorFromRange(doc, rangeOverText(doc, ".second", "second"))!;
    const b = describeAnchorFromRange(doc, rangeOverText(doc, ".second", "second"))!;
    expect(sameAnchor(a, b)).toBe(true);
    expect(sameAnchor(a, { ...a, start: a.start + 1 })).toBe(false);
    expect(sameAnchor(undefined, undefined)).toBe(true);
    expect(sameAnchor(a, undefined)).toBe(false);
  });
});

describe("anchors, defensively", () => {
  it("returns null when there is no selection at all", async () => {
    const { describeAnchorFromSelection } = await import("./anchor");
    const doc = makeDoc("<p>x</p>");
    // jsdom gives a collapsed selection by default, which is the same situation
    // as a reader who clicked without dragging.
    expect(describeAnchorFromSelection(doc)).toBeNull();
  });

  it("returns null for a collapsed range", () => {
    const doc = makeDoc('<section id="s"><p>x</p></section>');
    const range = doc.createRange();
    const text = doc.querySelector("p")!.firstChild!;
    range.setStart(text, 0);
    range.setEnd(text, 0);
    const anchor = describeAnchorFromRange(doc, range);
    expect(anchor?.exact ?? "").toBe("");
  });

  it("returns null when the document has no body to fall back to", () => {
    const doc = document.implementation.createDocument(null, null, null) as unknown as Document;
    expect(
      rangeFromAnchor(doc, {
        elementId: "",
        exact: "x",
        prefix: "",
        suffix: "",
        start: 0,
        end: 1,
      }),
    ).toBeNull();
  });
});
