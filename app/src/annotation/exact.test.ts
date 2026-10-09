// SPDX-License-Identifier: Apache-2.0
// A suggestion replaces exactly what it quoted, or nothing (SPEC §22).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rangeFromAnchor } from "./anchor";
import { exactRangeFromAnchor, resolveSuggestion, suggestibleRange, trimToText } from "./exact";
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

  it("ends a quote that ends its paragraph inside that paragraph", () => {
    // Rendered Markdown puts a line break between blocks. Mapped to the start
    // of THAT text node, the range crossed into the section, and the last
    // words of every paragraph were refused as spanning two.
    const doc = makeDoc(
      `<section id="s1">\n<p><strong>Audience: developers and engineering leads</strong></p>\n<p>Next.</p>\n</section>`,
    );
    const r = exactRangeFromAnchor(doc, anchor({ exact: "developers and engineering leads", prefix: "Audience: ", suffix: "\nNext." }));
    expect(r?.toString()).toBe("developers and engineering leads");
    expect(r!.endContainer.parentElement?.tagName).toBe("STRONG");
    expect(suggestibleRange(r!)).toBe(true);
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

describe("resolveSuggestion: the quote and its replacement, found by one rule", () => {
  const a = anchor({ exact: "a single weekend", prefix: "We can cut over in ", suffix: ", without downtime." });
  const state = (body: string, an: Anchor, replacement: string) =>
    resolveSuggestion(makeDoc(`<section id="s1"><p>${body}</p></section>`), an, replacement).state;

  it("is pending where the quote stands between its context", () => {
    expect(state("We can cut over in a single weekend, without downtime.", a, "two weekends")).toBe("pending");
  });

  it("is applied where the replacement stands between its context", () => {
    expect(state("We can cut over in two weekends, without downtime.", a, "two weekends")).toBe("applied");
    expect(state("We can cut over in two weekends, without downtime.", a, "three weekends")).toBe("stale");
  });

  it("is applied when only one side of the context still matches the replacement", () => {
    // What the user's draft held: the change made, the text after it since rewritten.
    expect(state("We can cut over in two weekends, with an hour of downtime.", a, "two weekends")).toBe("applied");
  });

  it("is pending when only one side of the context still matches the quote", () => {
    expect(state("We can cut over in a single weekend, with an hour of downtime.", a, "two weekends")).toBe("pending");
  });

  it("knows a replacement that contains its quote is applied, not pending again", () => {
    // "X" → "Y, X": the quote is still there after accepting, so finding it
    // proved nothing, and accepting again inserted Y twice.
    const ins = anchor({ exact: "developers and engineering leads", prefix: "Audience: ", suffix: ". Next" });
    const rep = "product managers, developers and engineering leads";
    expect(state("Audience: developers and engineering leads. Next", ins, rep)).toBe("pending");
    expect(state("Audience: product managers, developers and engineering leads. Next", ins, rep)).toBe("applied");
    // One side of the context rewritten too: still the same accepted change.
    expect(state("Readers: product managers, developers and engineering leads. Next", ins, rep)).toBe("applied");
  });

  it("knows a quote that contains its replacement is pending until it is shortened", () => {
    // At the start of a block there is no prefix, and "good idea." inside the
    // unapplied quote matches the replacement between its context.
    const cut = anchor({ exact: "very good idea", suffix: "." });
    expect(state("very good idea.", cut, "good idea")).toBe("pending");
    expect(state("good idea.", cut, "good idea")).toBe("applied");
  });

  it("is stale when the quote and the replacement each match one side, in different places", () => {
    const t = anchor({ exact: "alpha", prefix: "P1 ", suffix: " S1" });
    expect(state("P1 alpha X. Y beta S1", t, "beta")).toBe("stale");
  });

  it("is stale when neither stands there", () => {
    expect(state("Something else entirely.", a, "two weekends")).toBe("stale");
  });

  it("recognises a deletion by its two contexts meeting, and only by both", () => {
    expect(state("We can cut over in , without downtime.", a, "")).toBe("applied");
    const atStart = anchor({ exact: "a single weekend", suffix: ", without downtime." });
    // With nothing before it, the suffix alone is there whether or not the quote was deleted.
    expect(state(", without downtime.", atStart, "")).toBe("stale");
    expect(state("a single weekend, without downtime.", atStart, "")).toBe("pending");
  });

  it("is never sure of a spot it has no context to recognise", () => {
    expect(state("two weekends", anchor({ exact: "x" }), "two weekends")).toBe("stale");
    expect(state("one x here", anchor({ exact: "x" }), "two weekends")).toBe("pending");
  });

  it("is stale where the quote now spans structure", () => {
    const doc = makeDoc(`<section id="s1"><p>We can cut over in a single</p>\n<p>weekend, without downtime.</p></section>`);
    expect(resolveSuggestion(doc, a, "two weekends").state).toBe("stale");
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

  it("keeps a paragraph's last words in their paragraph when the drag took the line break", () => {
    const doc = makeDoc(`<section id="s"><p id="p"><strong>Audience: developers and engineering leads</strong></p>\n<p>Next.</p></section>`);
    const text = doc.querySelector("strong")!.firstChild!;
    const r = doc.createRange();
    r.setStart(text, 10);
    r.setEnd(doc.getElementById("p")!.nextSibling!, 1);
    const trimmed = trimToText(r);
    expect(trimmed.toString()).toBe("developers and engineering leads");
    expect(suggestibleRange(trimmed)).toBe(true);
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

describe("the golden quote cases, shared with the server", () => {
  /**
   * The server finds an agent's quote without a DOM (functions/src/lib/quote.ts)
   * and stores the anchor it found; this resolver must then find it in the
   * real one. Both read one fixture, so neither can move alone.
   */
  const file = join(__dirname, "..", "..", "..", "functions", "test", "fixtures", "quote-vectors.json");
  const { cases } = JSON.parse(readFileSync(file, "utf8")) as {
    cases: {
      name: string;
      html: string;
      exact: string;
      prefix?: string;
      suffix?: string;
      expect: { ok?: boolean; prefix?: string; suffix?: string; error?: string };
    }[];
  };

  it("has cases to agree on", () => {
    expect(cases.length).toBeGreaterThan(8);
  });

  for (const c of cases) {
    it(c.name, () => {
      const doc = new DOMParser().parseFromString(c.html, "text/html");
      if (c.expect.ok) {
        const anchor = { elementId: "", exact: c.exact, prefix: c.expect.prefix!, suffix: c.expect.suffix!, start: 0, end: 0 };
        const range = exactRangeFromAnchor(doc, anchor);
        expect(range?.toString().replace(/\s+/g, " ").trim()).toBe(c.exact);
        expect(suggestibleRange(range!)).toBe(true);
      } else {
        // Whatever the server refused, the browser would not apply either.
        const anchor = { elementId: "", exact: c.exact, prefix: c.prefix ?? "", suffix: c.suffix ?? "", start: 0, end: 0 };
        const range = exactRangeFromAnchor(doc, anchor);
        expect(range === null || suggestibleRange(range) !== true).toBe(true);
      }
    });
  }
});
