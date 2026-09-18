// SPDX-License-Identifier: Apache-2.0
// A preview runs nothing, and resolves its assets where the document does (SPEC §6d).

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SlideThumb } from "./SlideThumb";
import { scanSlides } from "../viewer/deck";
import { HL_STYLE_ID, OWN_ATTR } from "../brand/dom";

const BASE = "/content/doc1/v3/";

function firstSlide(head: string) {
  const doc = new DOMParser().parseFromString(
    `<html><head>${head}</head><body><main class="deck">
       <section class="slide"><h2>One</h2><img src="art/one.png"></section>
       <section class="slide"><h2>Two</h2></section>
     </main></body></html>`,
    "text/html",
  );
  const scan = scanSlides(doc);
  if (scan.kind !== "slides") throw new Error("fixture is not a deck");
  return scan.slides[0];
}

function thumbFrame(head = "") {
  const { container } = render(
    <SlideThumb slide={firstSlide(head)} baseHref={BASE} thumbWidth={132} />,
  );
  return container.querySelector("iframe")!;
}

describe("SlideThumb", () => {
  it("never runs the document's scripts, however trusted it is", () => {
    // A thumbnail is not worth executing anybody's code, so this does not
    // depend on the trust state at all.
    const frame = thumbFrame();
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
  });

  it("resolves assets against the content proxy, not the app origin", () => {
    // Without a <base>, `art/one.png` is fetched from the app origin and every
    // image in every preview 404s.
    expect(thumbFrame().srcdoc).toContain(`<base href="${BASE}">`);
  });

  it("carries the document's own styles but not ours", () => {
    const frame = thumbFrame(
      `<style id="author">.slide{color:rebeccapurple}</style>` +
        `<style id="${HL_STYLE_ID}" ${OWN_ATTR}="hl-style">.bshd-hl{background:gold}</style>`,
    );

    expect(frame.srcdoc).toContain("rebeccapurple");
    // A reader's highlights bleeding into every thumbnail is the bug this
    // filter exists for.
    expect(frame.srcdoc).not.toContain("gold");
    expect(frame.srcdoc).not.toContain(HL_STYLE_ID);
  });

  it("is inert to the pointer and invisible to the reading order", () => {
    // The wrapping button takes the click and carries the accessible name; the
    // preview must not be a second tab stop announcing the same thing twice.
    const frame = thumbFrame();
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.tabIndex).toBe(-1);
    expect(frame.className).toBe("slide-thumb-frame");
  });

  it("forces a hidden slide visible, since a deck hides all but one", () => {
    expect(thumbFrame().srcdoc).toContain("visibility:visible!important");
  });
});
