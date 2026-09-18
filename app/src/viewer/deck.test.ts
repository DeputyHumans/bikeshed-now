// SPDX-License-Identifier: Apache-2.0
// Slide detection against the shapes real decks actually ship (SPEC §6d).

import { describe, expect, it } from "vitest";

import { activeIndex, isPaged, scanSlides, slideTitle, stageSize } from "./deck";

/**
 * Every fixture here is SYNTHESISED to carry one structural pattern found in
 * the wild. None of them contains borrowed content, and that is deliberate:
 * the thing under test is the shape of the markup, so the shape is all a
 * fixture needs to have.
 */
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function titles(doc: Document): string[] {
  const scan = scanSlides(doc);
  return scan.kind === "slides" ? scan.slides.map((s) => s.title) : [];
}

describe("scanSlides", () => {
  it("finds slides that carry no id at all", () => {
    // The single most common shape, and the one `body > section[id]` missed
    // entirely. Note the trailing and doubled spaces in the class attribute:
    // they are copied from real output and are why matching is by token.
    const doc = parse(`<body><main class="deck">
      <section class="slide slide--cover" data-n="1" aria-label="Slide 1"><h1>Opening</h1></section>
      <section class="slide " data-n="2" aria-label="Slide 2"><h2>Middle</h2></section>
      <section class="slide  slide--noted" data-n="3" aria-label="Slide 3"><h2>Closing</h2></section>
    </main></body>`);

    expect(titles(doc)).toEqual(["Opening", "Middle", "Closing"]);
  });

  it("does not let aria-label pass itself off as a title", () => {
    // Negative control for the rule above: strip the headings and the labels
    // are all that is left. "Slide 2" is an index, not a name.
    const doc = parse(`<body><main class="deck">
      <section class="slide" aria-label="Slide 1"><h2>Real heading</h2><p>a</p></section>
      <section class="slide" aria-label="Slide 2"><h2>Another heading</h2><p>b</p></section>
    </main></body>`);

    expect(titles(doc)).toEqual(["Real heading", "Another heading"]);

    // With no heading to fall back on, the id is a better name than the label
    // — and this is the assertion that actually pins the guard, because a
    // fixture with no id agrees with the buggy behaviour by coincidence.
    const labelled = parse(
      `<section id="closing-thoughts" aria-label="Slide 4"><p>no heading</p></section>`,
    ).querySelector("section")!;
    expect(slideTitle(labelled, 3)).toBe("closing thoughts");

    // Only when there is nothing else at all does it number the slide.
    const bare = parse(`<section><p>no heading</p></section>`).querySelector("section")!;
    expect(slideTitle(bare, 3)).toBe("Slide 4");
  });

  it("reaches slides wrapped in foreign content, and scrolls the wrapper", () => {
    const doc = parse(`<body><div>
      <svg data-marpit-svg><foreignObject><section id="1"><h2>One</h2></section></foreignObject></svg>
      <svg data-marpit-svg><foreignObject><section id="2"><h2>Two</h2></section></foreignObject></svg>
    </div></body>`);

    const scan = scanSlides(doc);
    expect(scan.kind).toBe("slides");
    if (scan.kind !== "slides") return;
    expect(scan.slides.map((s) => s.title)).toEqual(["One", "Two"]);
    // The section is six levels down and inside foreign content; scrolling it
    // is unreliable, so `outer` has to be the svg.
    expect(scan.slides[0].el.tagName.toLowerCase()).toBe("section");
    expect(scan.slides[0].outer.tagName.toLowerCase()).toBe("svg");
  });

  it("keeps a cover slide that lacks the data-title its siblings have", () => {
    // Matching `section[data-title]` alone returns 3 of 4 here and renumbers
    // every slide after the cover.
    const doc = parse(`<body><main>
      <section class="section cover" id="s-cover"><h1>Cover</h1></section>
      <section class="section" id="s-one" data-title="01 · First"><h2>h</h2></section>
      <section class="section" id="s-two" data-title="02 · Second"><h2>h</h2></section>
      <section class="section" id="s-three" data-title="03 · Third"><h2>h</h2></section>
    </main></body>`);

    expect(titles(doc)).toEqual(["Cover", "01 · First", "02 · Second", "03 · Third"]);
  });

  it("orders by the document, never by an id that looks like an index", () => {
    // Real ids from a real deck: non-monotonic, and reading an index out of
    // them would scramble the rail.
    const doc = parse(`<body><main>
      <section class="section" id="s-0"><h2>First</h2></section>
      <section class="section" id="s-4"><h2>Second</h2></section>
      <section class="section" id="s-11"><h2>Third</h2></section>
      <section class="section" id="s-2"><h2>Fourth</h2></section>
    </main></body>`);

    expect(titles(doc)).toEqual(["First", "Second", "Third", "Fourth"]);
  });

  it("survives ids that are not valid selectors", () => {
    // `#1` throws in querySelector. Nothing may build a selector from an id.
    const doc = parse(`<body><main>
      <section class="s" id="1"><h2>One</h2></section>
      <section class="s" id="2"><h2>Two</h2></section>
      <section class="s" id="3"><h2>Three</h2></section>
    </main></body>`);

    expect(() => scanSlides(doc)).not.toThrow();
    expect(titles(doc)).toEqual(["One", "Two", "Three"]);
  });

  it("finds the sections of the in-repo tour, which the old selector could not", () => {
    // The tour nests its sections inside `div.deck`, so `body > section[id]`
    // matched zero of them and the rail never appeared for the one sample
    // built to be navigated.
    const doc = parse(`<body>
      <nav id="dot-nav"></nav>
      <div class="deck">
        <section id="s1-what" class="reveal"><h2>What</h2></section>
        <section id="s2-name" class="reveal"><h2>Name</h2></section>
        <section id="s3-loop" class="reveal"><h2>Loop</h2></section>
      </div></body>`);

    expect(doc.querySelectorAll("body > section[id]")).toHaveLength(0);
    expect(titles(doc)).toEqual(["What", "Name", "Loop"]);
  });

  it("says script-required, not none, for a deck that builds itself", () => {
    // The container ships empty and there is no <noscript>. Reporting "not a
    // deck" here is how a reader ends up on a blank page with no explanation.
    const doc = parse(
      `<body><div id="slides-container"></div><script>buildSlides()</script></body>`,
    );

    expect(scanSlides(doc).kind).toBe("script-required");
  });

  it("does not call an empty container script-required when there is no script", () => {
    const doc = parse(`<body><div id="slides-container"></div><p>Nothing here.</p></body>`);

    expect(scanSlides(doc).kind).toBe("none");
  });

  it("ignores a carousel, which is also a sibling run of .slide", () => {
    const doc = parse(`<body><article><h1>A post</h1>
      <div class="carousel">
        <div class="slide"><img src="a.png"></div>
        <div class="slide"><img src="b.png"></div>
        <div class="slide"><img src="c.png"></div>
      </div>
      <p>Body text.</p></article></body>`);

    expect(scanSlides(doc).kind).toBe("none");
  });

  it("ignores prose whose sections are not a sibling run", () => {
    // Three sections sharing a class, each wrapped in its own container. They
    // satisfy every count threshold and fail the only test that matters:
    // slides sit beside each other.
    const doc = parse(`<body><main>
      <div class="row"><section class="part" id="a"><h2>A</h2></section></div>
      <div class="row"><section class="part" id="b"><h2>B</h2></section></div>
      <div class="row"><section class="part" id="c"><h2>C</h2></section></div>
    </main></body>`);

    expect(doc.querySelectorAll("section.part")).toHaveLength(3);
    expect(scanSlides(doc).kind).toBe("none");
  });

  it("returns none for an empty or missing document", () => {
    expect(scanSlides(null).kind).toBe("none");
    expect(scanSlides(parse(`<body><p>Just a paragraph.</p></body>`)).kind).toBe("none");
  });
});

describe("scanSlides across realms", () => {
  /**
   * The document being scanned comes from the iframe, so its elements are
   * built by another realm's constructors and `instanceof HTMLElement` is
   * false for every one of them. Worse, nothing guarantees the constructor is
   * a global at all — run this module where it is not and an `instanceof`
   * throws outright, which is how this was found: scanning two real decks
   * outside a browser raised "HTMLElement is not defined".
   *
   * Removing the global is the only construction that reproduces it here.
   * A `DOMParser` fixture and a jsdom iframe both share this realm's
   * constructors, so neither one can.
   */
  it("leans on no constructor the document's realm might not have", () => {
    const doc = parse(`<body><main>
      <section class="section cover" id="s-cover"><h1>Cover</h1></section>
      <section class="section" id="s-one" data-title="01 · First"><h2>heading</h2></section>
      <section class="section" id="s-two" data-title="02 · Second"><h2>heading</h2></section>
    </main></body>`);

    const realm = globalThis as { HTMLElement?: unknown };
    const saved = realm.HTMLElement;
    delete realm.HTMLElement;
    try {
      expect(() => scanSlides(doc)).not.toThrow();
      expect(titles(doc)).toEqual(["Cover", "01 · First", "02 · Second"]);
    } finally {
      realm.HTMLElement = saved;
    }
  });
});

describe("activeIndex", () => {
  it("picks the slide nearest the top edge, above or below it", () => {
    expect(activeIndex([-900, -40, 820, 1680])).toBe(1);
    expect(activeIndex([0, 800])).toBe(0);
    expect(activeIndex([-1200, -1100, -12])).toBe(2);
  });

  it("is 0 when there is nothing to choose between", () => {
    expect(activeIndex([])).toBe(0);
  });
});

describe("isPaged", () => {
  it("pages a deck whose slides are about one viewport tall", () => {
    expect(isPaged([800, 800, 800, 800], 800)).toBe(true);
    // Slightly over the viewport still counts: a deck sized in vh lands a few
    // pixels out once a scrollbar appears.
    expect(isPaged([860, 860], 800)).toBe(true);
  });

  it("does not hijack the arrow keys on long-form sections", () => {
    // The negative control that matters: paging here would trap the reader
    // inside a section they can no longer scroll through.
    expect(isPaged([4200, 3800, 5100], 800)).toBe(false);
  });

  it("does not page a document of short sections either", () => {
    // Prose with a sidebar nav is also a sibling run of sections, and its
    // sections FIT the viewport — which is why fitting cannot be the test.
    expect(isPaged([180, 240, 320, 150, 400], 800)).toBe(false);
  });

  it("wants most slides slide-shaped, not just some", () => {
    expect(isPaged([800, 800, 780, 90, 120], 800)).toBe(false);
    expect(isPaged([800, 800, 780, 810, 120], 800)).toBe(true);
  });

  it("refuses to decide without a measurement", () => {
    // jsdom has no layout, and a zero viewport must not read as "everything
    // fits" — which is what a naive `h <= viewport` comparison would do.
    expect(isPaged([0, 0, 0], 0)).toBe(false);
    expect(isPaged([800, 800], 0)).toBe(false);
    expect(isPaged([800], 800)).toBe(false);
  });
});

describe("stageSize", () => {
  it("lays every preview out at the reader's own viewport", () => {
    // Not the median rect, and the reason is media queries rather than
    // arithmetic: a deck that re-flows at a breakpoint has to be previewed at
    // the width the reader is reading it at, or the preview is of a different
    // layout. Uniformity then comes for free.
    const rects = [
      { width: 800, height: 500 },
      { width: 800, height: 520 },
      { width: 800, height: 9000 },
    ];
    expect(stageSize({ width: 1400, height: 800 }, rects)).toEqual({
      width: 1400,
      height: 800,
    });
  });

  it("falls back to a real slide's shape before the view reports a size", () => {
    // Median by height, keeping that slide's own width: independent medians
    // can combine into a shape no slide in the document actually has.
    const rects = [
      { width: 900, height: 200 },
      { width: 400, height: 500 },
      { width: 800, height: 9000 },
    ];
    expect(stageSize({ width: 0, height: 0 }, rects)).toEqual({
      width: 400,
      height: 500,
    });
  });

  it("is total: nothing measurable still yields a usable stage", () => {
    // Negative space for a division: a zero width here makes every thumbnail's
    // scale Infinity, and the rail renders nothing at all.
    for (const stage of [
      stageSize({ width: 0, height: 0 }, []),
      stageSize({ width: 0, height: 0 }, [{ width: 0, height: 0 }]),
    ]) {
      expect(stage.width).toBeGreaterThan(0);
      expect(stage.height).toBeGreaterThan(0);
    }
  });
});
