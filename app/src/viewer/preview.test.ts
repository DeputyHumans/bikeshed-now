// SPDX-License-Identifier: Apache-2.0
// A preview forces only what the live document says is hiding a slide (SPEC §6d).

import { afterEach, describe, expect, it } from "vitest";

import { PREVIEW_ATTR, REVEAL_ATTR } from "../brand/dom";
import { hasTranslation, scanSlides, type Slide } from "./deck";
import { FINAL_STATE_CSS, previewOverrides, revealHidden, slideStateTokens } from "./preview";

const HIDDEN = {
  display: "none",
  visibility: "hidden",
  opacity: "0",
  transform: "matrix(1, 0, 0, 1, -1200, 0)",
};

describe("hasTranslation", () => {
  it("sees a parked slide, in either notation", () => {
    // A browser resolves to a matrix; jsdom echoes the authored string.
    expect(hasTranslation("matrix(1, 0, 0, 1, -1200, 0)")).toBe(true);
    expect(hasTranslation("translate3d(-150%, 0, 0)")).toBe(true);
    expect(hasTranslation("matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,-900,0,0,1)")).toBe(true);
  });

  it("leaves a scaled or rotated stage alone", () => {
    // Taking a deck's own scale away is the flattening bug in a new costume.
    expect(hasTranslation("matrix(0.5, 0, 0, 0.5, 0, 0)")).toBe(false);
    expect(hasTranslation("none")).toBe(false);
    expect(hasTranslation("")).toBe(false);
  });

  it("reads a sub-pixel offset as rounding, not as a parked slide", () => {
    expect(hasTranslation("matrix(1, 0, 0, 1, 0.5, 0)")).toBe(false);
  });
});

describe("previewOverrides", () => {
  it("forces the slide visible", () => {
    const css = previewOverrides(HIDDEN, "grid");
    expect(css).toContain("visibility:visible!important");
    expect(css).toContain("opacity:1!important");
  });

  it("takes a hidden slide's display from a sibling, not from a guess", () => {
    // The slide's own display is `none`, so it cannot say what it should be.
    // Hardcoding `block` here is what turns a centred cover slide into
    // shrink-wrapped content in the corner.
    expect(previewOverrides(HIDDEN, "grid")).toContain("display:grid!important");
    expect(previewOverrides(HIDDEN, "flex")).toContain("display:flex!important");
  });

  it("falls back to block only when every sibling is hidden too", () => {
    expect(previewOverrides(HIDDEN, null)).toContain("display:block!important");
  });

  it("touches neither display nor transform when neither is hiding anything", () => {
    const css = previewOverrides(
      { display: "grid", visibility: "visible", opacity: "1", transform: "matrix(0.5,0,0,0.5,0,0)" },
      "grid",
    );
    expect(css).not.toContain("display:");
    expect(css).not.toContain("transform:");
  });

  it("never touches the properties that carry the layout", () => {
    // The whole point: `position:absolute; inset:0; display:grid;
    // place-items:center` has to survive intact.
    const css = previewOverrides(HIDDEN, "grid");
    for (const property of ["position", "inset", "margin", "width", "height", "place-items"]) {
      expect(css).not.toContain(`${property}:`);
    }
  });

  it("emits only the layout-neutral pair when nothing could be measured", () => {
    // A DOMParser document has no `defaultView`, so there is nothing to read.
    expect(previewOverrides(null, null)).toBe(
      "[data-bshd-preview][data-bshd-preview][data-bshd-preview]" +
        "{visibility:visible!important;opacity:1!important}",
    );
  });

  it("outweighs a deck that hides its slides with !important", () => {
    // Decks really do write `.deck .slide{visibility:hidden!important}`, which
    // is specificity (0,2,0). An !important tie is broken by specificity, so a
    // single attribute selector loses and the preview renders blank.
    const css = previewOverrides(null, null);
    const selector = css.slice(0, css.indexOf("{"));
    expect(selector.match(/\[data-bshd-preview\]/g)).toHaveLength(3);
  });
});

/** The selector half of each rule in a stylesheet string, rule by rule. */
function selectorsOf(css: string): string[] {
  return css
    .split("}")
    .filter((rule) => rule.includes("{"))
    .map((rule) => rule.slice(0, rule.indexOf("{")));
}

describe("FINAL_STATE_CSS", () => {
  it("stops every animation and transition on its last frame", () => {
    // A preview loads once and is never shown the slide being presented, so
    // the frame it should show is the one the deck ends on. A zero-length
    // animation is already finished, and its fill mode then decides what stays.
    const rule = FINAL_STATE_CSS.split("}").find((r) => r.includes("animation-duration"))!;
    expect(rule).toContain("animation-duration:0s!important");
    expect(rule).toContain("animation-delay:0s!important");
    expect(rule).toContain("animation-iteration-count:1!important");
    expect(rule).toContain("transition:none!important");
    // Including the slide's subtree at the same weight as the slide rule, so a
    // deck's own `!important` animation on a (0,2,0) selector cannot outrank it.
    expect(rule).toContain(`[${PREVIEW_ATTR}][${PREVIEW_ATTR}][${PREVIEW_ATTR}] *`);
  });

  it("forces what the reveal pass marked visible, at a weight that wins", () => {
    const reveal = selectorsOf(FINAL_STATE_CSS).find((s) => s.includes(REVEAL_ATTR))!;
    expect(reveal.match(new RegExp(`\\[${REVEAL_ATTR}\\]`, "g"))).toHaveLength(3);
    const rule = FINAL_STATE_CSS.split("}").find((r) => r.includes(REVEAL_ATTR))!;
    expect(rule).toContain("opacity:1!important");
    expect(rule).toContain("visibility:visible!important");
    // Layout-neutral only, like the slide rule: a reveal's offset is a few
    // pixels at thumbnail size, but `transform:none` on a centred element
    // throws it into a corner.
    expect(rule).not.toContain("transform");
  });
});

describe("revealHidden", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // jsdom computes inline styles and inherited visibility, which is all these
  // need; whether the forcing rule then WINS is a browser question, checked in
  // one (docs/development/verification.md).
  function mount(slide: string, outside = "") {
    document.body.innerHTML = `<main><section ${PREVIEW_ATTR}="">${slide}</section>${outside}</main>`;
  }
  const marked = () =>
    Array.from(document.querySelectorAll(`[${REVEAL_ATTR}]`)).map((el) => el.id);

  it("marks content a deck hides until its script shows the slide", () => {
    mount(`<p id="faded" style="opacity:0">a</p><p id="hidden" style="visibility:hidden">b</p>`);
    revealHidden(document);
    expect(marked()).toEqual(["faded", "hidden"]);
  });

  it("leaves alone what the author meant to be partly visible", () => {
    mount(`<p id="dim" style="opacity:0.5">a</p><p id="plain">b</p>`);
    revealHidden(document);
    expect(marked()).toEqual([]);
  });

  it("reveals hidden content nested inside hidden content", () => {
    // Fragments inside a fragment: forcing the outer one visible would leave
    // the inner one exactly as hidden as it was.
    mount(
      `<div id="outer" style="opacity:0"><p id="inner" style="opacity:0">a</p></div>` +
        `<div id="vouter" style="visibility:hidden"><p id="vinner" style="visibility:hidden">b</p></div>`,
    );
    revealHidden(document);
    expect(marked()).toEqual(["outer", "inner", "vouter", "vinner"]);
  });

  it("skips a fixed overlay and everything inside it", () => {
    // A hidden modal or toolbar is the deck's chrome, not the slide's content,
    // and its children inherit its hiding — marking them would float them free.
    mount(
      `<div id="modal" style="position:fixed;visibility:hidden">` +
        `<p id="dialog">x</p><p id="dialog2" style="opacity:0">y</p></div>`,
    );
    revealHidden(document);
    expect(marked()).toEqual([]);
  });

  it("touches nothing outside the previewed slide", () => {
    mount(`<p id="in" style="opacity:0">a</p>`, `<p id="out" style="opacity:0">b</p>`);
    revealHidden(document);
    expect(marked()).toEqual(["in"]);
  });

  it("does nothing in a document with no previewed slide", () => {
    document.body.innerHTML = `<p id="p" style="opacity:0">a</p>`;
    revealHidden(document);
    expect(marked()).toEqual([]);
  });
});

describe("slideStateTokens", () => {
  /** A deck whose slides carry exactly these class lists. */
  function deckOf(classes: string[]): Slide[] {
    const sections = classes
      .map((c, i) => `<section class="${c}"><h2>Slide ${i + 1}</h2></section>`)
      .join("");
    const doc = new DOMParser().parseFromString(
      `<body><main class="deck">${sections}</main></body>`,
      "text/html",
    );
    const scan = scanSlides(doc);
    if (scan.kind !== "slides") throw new Error("fixture is not a deck");
    return scan.slides;
  }

  it("carries the class a deck's script moves onto the slide it shows", () => {
    expect(slideStateTokens(deckOf(["slide active", "slide", "slide"]))).toBe("active");
  });

  it("knows a state class by its suffix, the way frameworks name them", () => {
    // bespoke.js writes `bespoke-active`; plenty of decks write `is-active`.
    expect(
      slideStateTokens(deckOf(["slide is-active", "slide bespoke-active", "slide"])),
    ).toBe("is-active bespoke-active");
  });

  it("never carries a class that is a layout, a theme or the opposite state", () => {
    // Spreading `title-slide` or `dark` would restyle every thumbnail as the
    // slide the reader happens to be on, and `inactive` and `past` are the
    // states a preview is trying to get away from.
    expect(
      slideStateTokens(
        deckOf([
          "slide title-slide inactive",
          "slide bespoke-inactive past dark",
          "slide future cover",
        ]),
      ),
    ).toBe("");
  });

  it("is empty for a deck that keeps no state on its slides", () => {
    expect(slideStateTokens(deckOf(["slide", "slide", "slide"]))).toBe("");
  });
});
