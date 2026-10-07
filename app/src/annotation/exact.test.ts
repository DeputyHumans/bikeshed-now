// SPDX-License-Identifier: Apache-2.0
// A suggestion replaces exactly what it quoted, or nothing (SPEC §22).

import { describe, expect, it } from "vitest";
import { rangeFromAnchor } from "./anchor";
import { alreadyApplied, exactRangeFromAnchor, suggestibleRange, trimToText } from "./exact";
import type { Anchor } from "../types";

function makeDoc(body: string): Document {
  return new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${body}</body></html>`, "text/html");
}

const anchor = (a: Partial<Anchor> & { exact: string }): Anchor => ({
  elementId: "s1",
  prefix: "",
  suffix: "",
  start: 0,
  end: a.exact.length,
  ...a,
});

describe("exactRangeFromAnchor", () => {
  it("finds the quote, and exactly the quote", () => {
    const doc = makeDoc(`<section id="s1"><p>We can cut over in a single weekend.</p></section>`);
    const r = exactRangeFromAnchor(doc, anchor({ exact: "a single weekend", prefix: "cut over in ", suffix: "." }));
    expect(r?.toString()).toBe("a single weekend");
  });

  it("chooses between repeats by their context", () => {
    const doc = makeDoc(`<section id="s1"><p>one week here, one week there, one week everywhere</p></section>`);
    const r = exactRangeFromAnchor(doc, anchor({ exact: "one week", prefix: "here, ", suffix: " there" }));
    expect(r).not.toBeNull();
    const before = doc.createRange();
    before.setStart(doc.querySelector("p")!.firstChild!, 0);
    before.setEnd(r!.startContainer, r!.startOffset);
    expect(before.toString()).toBe("one week here, ");
  });

  it("settles for one side of context when only one still matches", () => {
    const doc = makeDoc(`<section id="s1"><p>alpha beta gamma. delta beta epsilon.</p></section>`);
    // The text before the first "beta" changed; after it, it did not.
    const r = exactRangeFromAnchor(doc, anchor({ exact: "beta", prefix: "omega ", suffix: " gamma" }));
    expect(r).not.toBeNull();
    expect(r!.startOffset).toBe("alpha ".length);
  });

  it("refuses a quote that occurs twice with nothing to tell them apart", () => {
    const doc = makeDoc(`<section id="s1"><p>yes and yes</p></section>`);
    expect(exactRangeFromAnchor(doc, anchor({ exact: "yes" }))).toBeNull();
  });

  it("refuses a near miss that the comment resolver would accept", () => {
    // What makes it a different resolver: a highlight may land approximately,
    // a replacement may not.
    const doc = makeDoc(`<section id="s1"><p>We can cut over in a singel weekend.</p></section>`);
    const a = anchor({ exact: "a single weekend", prefix: "cut over in ", suffix: ".", start: 19, end: 35 });
    expect(rangeFromAnchor(doc, a)).not.toBeNull();
    expect(exactRangeFromAnchor(doc, a)).toBeNull();
  });

  it("never falls back to the stored offsets", () => {
    const doc = makeDoc(`<section id="s1"><p>Something else entirely now.</p></section>`);
    expect(exactRangeFromAnchor(doc, anchor({ exact: "original words", start: 0, end: 14 }))).toBeNull();
  });

  it("reads reflowed whitespace as the same text", () => {
    const doc = makeDoc(`<section id="s1"><p>cut over
         in   a
         single weekend.</p></section>`);
    const r = exactRangeFromAnchor(doc, anchor({ exact: "a single weekend", prefix: "cut over in ", suffix: "." }));
    expect(r?.toString().replace(/\s+/g, " ")).toBe("a single weekend");
  });

  it("looks in the whole body when its section has lost its id", () => {
    const doc = makeDoc(`<section><p>Find the needle here.</p></section>`);
    expect(exactRangeFromAnchor(doc, anchor({ exact: "the needle" }))?.toString()).toBe("the needle");
  });

  it("spans inline markup, as a quote across emphasis does", () => {
    const doc = makeDoc(`<section id="s1"><p>a <em>very</em> good idea</p></section>`);
    expect(exactRangeFromAnchor(doc, anchor({ exact: "very good" }))?.toString()).toBe("very good");
  });
});

describe("suggestibleRange", () => {
  const over = (doc: Document, from: [Node, number], to: [Node, number]) => {
    const r = doc.createRange();
    r.setStart(...from);
    r.setEnd(...to);
    return r;
  };

  it("accepts text inside one paragraph, inline markup and all", () => {
    const doc = makeDoc(`<p id="p">a <em>very</em> good idea</p>`);
    const p = doc.getElementById("p")!;
    expect(suggestibleRange(over(doc, [p.firstChild!, 0], [p.lastChild!, 5]))).toBe(true);
  });

  it("refuses a range across two paragraphs", () => {
    const doc = makeDoc(`<p id="a">first</p><p id="b">second</p>`);
    const r = over(doc, [doc.getElementById("a")!.firstChild!, 1], [doc.getElementById("b")!.firstChild!, 3]);
    expect(suggestibleRange(r)).toEqual({ reason: "A suggestion stays within one paragraph." });
  });

  it("refuses a range holding anything that is not text", () => {
    const doc = makeDoc(`<p id="p">line one<br>line two <img src="x.png" alt=""> end</p>`);
    const p = doc.getElementById("p")!;
    const r = over(doc, [p.firstChild!, 0], [p.lastChild!, 3]);
    expect(suggestibleRange(r)).toMatchObject({ reason: expect.stringMatching(/can only change text/) });
  });

  it("refuses text inside a figure, and an empty selection", () => {
    const doc = makeDoc(`<p id="p">x</p><svg><text id="t">label</text></svg>`);
    const t = doc.getElementById("t")!;
    expect(suggestibleRange(over(doc, [t.firstChild!, 0], [t.firstChild!, 3]))).toMatchObject({
      reason: expect.stringMatching(/figure/),
    });
    const p = doc.getElementById("p")!;
    expect(suggestibleRange(over(doc, [p.firstChild!, 0], [p.firstChild!, 0]))).toMatchObject({
      reason: expect.stringMatching(/Select/),
    });
  });
});

describe("alreadyApplied", () => {
  const a = anchor({ exact: "a single weekend", prefix: "We can cut over in ", suffix: ", without downtime." });

  it("recognises the replacement standing between the anchor's own context", () => {
    const doc = makeDoc(`<section id="s1"><p>We can cut over in two weekends, without downtime.</p></section>`);
    expect(alreadyApplied(doc, a, "two weekends")).toBe(true);
    expect(alreadyApplied(doc, a, "three weekends")).toBe(false);
  });

  it("recognises a deletion by its two contexts meeting", () => {
    const doc = makeDoc(`<section id="s1"><p>We can cut over in , without downtime.</p></section>`);
    expect(alreadyApplied(doc, a, "")).toBe(true);
  });

  it("is never sure of a spot it has no context to recognise", () => {
    const doc = makeDoc(`<section id="s1"><p>two weekends</p></section>`);
    expect(alreadyApplied(doc, anchor({ exact: "x" }), "two weekends")).toBe(false);
  });
});

describe("trimToText", () => {
  it("drops whitespace a drag or a double-click took with it", () => {
    const doc = makeDoc(`<p id="p">We can cut over in a single weekend.</p>`);
    const text = doc.getElementById("p")!.firstChild!;
    const r = doc.createRange();
    r.setStart(text, 18);
    r.setEnd(text, 36);
    expect(r.toString()).toBe(" a single weekend.");
    expect(trimToText(r).toString()).toBe("a single weekend.");
  });

  it("leaves a clean range, and an all-space one, as they are", () => {
    const doc = makeDoc(`<p id="p">a   b</p>`);
    const text = doc.getElementById("p")!.firstChild!;
    const spaces = doc.createRange();
    spaces.setStart(text, 1);
    spaces.setEnd(text, 4);
    expect(trimToText(spaces)).toBe(spaces);
  });
});
