// SPDX-License-Identifier: Apache-2.0
// A preview forces only what the live document says is hiding a slide (SPEC §6d).

import { describe, expect, it } from "vitest";

import { hasTranslation } from "./deck";
import { previewOverrides } from "./preview";

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
