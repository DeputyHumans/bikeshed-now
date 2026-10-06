// SPDX-License-Identifier: Apache-2.0
// A preview runs nothing, keeps its context, and changes nothing (SPEC §6d).

import { fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SlideThumb } from "./SlideThumb";
import { scanSlides, type Slide } from "../viewer/deck";
import { HL_STYLE_ID, OWN_ATTR, PREVIEW_ATTR, REVEAL_ATTR } from "../brand/dom";

const BASE = "/content/doc1/v3/";
const STAGE = { width: 1280, height: 720 };

function deck(head = "") {
  return new DOMParser().parseFromString(
    `<html class="js" dir="rtl" lang="en"><head>${head}</head><body class="theme">
       <main class="deck" id="stage" data-theme="dark">
         <section class="slide"><h2>One</h2><img src="art/one.png"></section>
         <section class="slide"><h2>Two</h2></section>
       </main></body></html>`,
    "text/html",
  );
}

function firstSlide(doc: Document): Slide {
  const scan = scanSlides(doc);
  if (scan.kind !== "slides") throw new Error("fixture is not a deck");
  return scan.slides[0];
}

function thumbFrame(head = "") {
  const { container } = render(
    <SlideThumb slide={firstSlide(deck(head))} baseHref={BASE} stage={STAGE} />,
  );
  return container.querySelector("iframe")!;
}

/** The preview is a document; query it as one rather than matching strings. */
function preview(head = ""): Document {
  return new DOMParser().parseFromString(thumbFrame(head).srcdoc, "text/html");
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
    expect(preview().querySelector("base")?.getAttribute("href")).toBe(BASE);
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

  it("previews the slide without the reader's highlights or overlays", () => {
    // Dropping the highlight STYLESHEET is not enough: the <mark>s are real
    // elements in the slide, and a <mark> with no author rule is the browser's
    // own yellow. A preview that will be stored as an image and shown to every
    // member must carry no trace of one reader's annotations.
    const doc = new DOMParser().parseFromString(
      `<html><head></head><body><main class="deck">
         <section class="slide" contenteditable="true"><h2>One</h2>
           <p>A <mark class="bshd-hl" data-bshd-ann="a1">commented</mark> passage.</p>
           <div ${OWN_ATTR}="peers"><i>peer cursor</i></div>
           <span ${OWN_ATTR}="whatever">the author's own</span>
         </section>
         <section class="slide"><h2>Two</h2></section>
       </main></body></html>`,
      "text/html",
    );
    const { container } = render(
      <SlideThumb slide={firstSlide(doc)} baseHref={BASE} stage={STAGE} />,
    );
    const html = container.querySelector("iframe")!.srcdoc;
    const out = new DOMParser().parseFromString(html, "text/html");

    expect(out.querySelector("mark")).toBeNull();
    expect(out.querySelector("section.slide p")?.textContent).toBe("A commented passage.");
    expect(html).not.toContain("peer cursor");
    expect(out.querySelector("[contenteditable]")).toBeNull();
    // Stripped by VALUE: an author who happens to use the attribute keeps it.
    expect(out.querySelector(`[${OWN_ATTR}="whatever"]`)?.textContent).toBe("the author's own");
    // And the reader's frame still has its highlight; only the copy lost it.
    expect(doc.querySelector("mark.bshd-hl")).not.toBeNull();
  });

  it("gives the copy the state the deck shows its current slide in", () => {
    // `.slide.active .bar{width:var(--w)}` is a final state no amount of forced
    // visibility reaches; only the deck's own class does. It goes on the copy:
    // writing it on the live slide would restyle the document being read.
    const doc = deck();
    const slide = firstSlide(doc);
    const { container } = render(
      <SlideThumb slide={slide} baseHref={BASE} stage={STAGE} state="active is-shown" />,
    );
    const out = new DOMParser().parseFromString(
      container.querySelector("iframe")!.srcdoc,
      "text/html",
    );

    expect(out.querySelector("section.slide")?.className).toBe("slide active is-shown");
    expect(slide.outer.className).toBe("slide");
  });

  it("forces a hidden slide visible, since a deck hides all but one", () => {
    expect(thumbFrame().srcdoc).toContain("visibility:visible!important");
  });

  // --- The slide keeps the context it was written in -----------------------

  it("keeps the ancestors the document's own stylesheet is written against", () => {
    // A deck whose slides get their width from a container rule renders
    // full-bleed without this, in a box still sized from the correctly-styled
    // frame — which is where the whitespace came from.
    expect(preview().querySelector("main.deck > section.slide")).not.toBeNull();
  });

  it("keeps each ancestor's attributes, not just its tag", () => {
    const main = preview().querySelector("main.deck")!;
    expect(main.getAttribute("id")).toBe("stage");
    expect(main.getAttribute("data-theme")).toBe("dark");
  });

  it("carries html and body attributes beyond class", () => {
    // `dir="rtl"` alone flips a deck's whole layout, and `lang` and a theme
    // attribute are routinely what a stylesheet branches on.
    const doc = preview();
    expect(doc.documentElement.getAttribute("dir")).toBe("rtl");
    expect(doc.documentElement.getAttribute("class")).toBe("js");
    expect(doc.body.getAttribute("class")).toBe("theme");
  });

  it("keeps the slide's own subtree, and only that slide", () => {
    const doc = preview();
    expect(doc.querySelector("section.slide img")?.getAttribute("src")).toBe("art/one.png");
    expect(doc.querySelector("section.slide h2")?.textContent).toBe("One");
    // A deep clone of the ANCESTOR would put every slide in every thumbnail.
    expect(doc.querySelectorAll("section.slide")).toHaveLength(1);
    expect(thumbFrame().srcdoc).not.toContain("Two");
  });

  it("does not flatten the slide's own layout", () => {
    // `position:static` turns `position:absolute; inset:0; display:grid;
    // place-items:center` into shrink-wrapped content in the corner, which is
    // what "totally unaligned" was. `html,body{margin:0}` is still legitimate,
    // so the assertion names the important form specifically.
    const html = thumbFrame().srcdoc;
    expect(html).not.toContain("position:static");
    expect(html).not.toContain("inset:auto");
    expect(html).not.toContain("margin:0!important");
  });

  it("targets the one slide it marked, not every child of body", () => {
    expect(thumbFrame().srcdoc).toContain(`[${PREVIEW_ATTR}]`);
    expect(preview().querySelector("section.slide")?.hasAttribute(PREVIEW_ATTR)).toBe(true);
  });

  // --- And changes nothing about the document being read -------------------

  it("leaves the document it previews untouched", () => {
    // This is the whole argument for PREVIEW_ATTR needing no cleanup path and
    // no place in OWN_MARKERS: it cannot reach a live node. Three ways to break
    // that, all pinned here — marking the live slide, moving a live <style>
    // into the preview instead of cloning it, and mutating the tree in passing.
    const doc = deck(`<style id="author">.slide{color:rebeccapurple}</style>`);
    const slide = firstSlide(doc);
    const before = doc.documentElement.outerHTML;

    render(<SlideThumb slide={slide} baseHref={BASE} stage={STAGE} />);

    expect(slide.outer.hasAttribute(PREVIEW_ATTR)).toBe(false);
    expect(doc.head.querySelector("style#author")).not.toBeNull();
    expect(doc.documentElement.outerHTML).toBe(before);
  });

  it("lays every slide of one deck out at the same size", () => {
    // The stage is decided once for the deck, so the rail cannot go ragged.
    // Note the stubs below: without them this passes with the per-slide
    // measurement put back, because jsdom reports zero for every rect and both
    // slides fall through to the same fallback.
    const doc = deck();
    const scan = scanSlides(doc);
    if (scan.kind !== "slides") throw new Error("fixture is not a deck");
    const [one, two] = scan.slides;
    one.outer.getBoundingClientRect = () => ({ width: 900, height: 200 }) as DOMRect;
    two.outer.getBoundingClientRect = () => ({ width: 400, height: 3000 }) as DOMRect;

    const a = render(<SlideThumb slide={one} baseHref={BASE} stage={STAGE} />);
    const b = render(<SlideThumb slide={two} baseHref={BASE} stage={STAGE} />);
    const frameA = a.container.querySelector("iframe")!;
    const frameB = b.container.querySelector("iframe")!;

    expect(frameA.style.width).toBe(frameB.style.width);
    expect(frameA.style.height).toBe(frameB.style.height);
    expect(frameA.style.width).toBe("1280px");
  });
});

describe("SlideThumb while its preview loads", () => {
  // jsdom applies no stylesheet, so the hiding is asserted in its two halves:
  // the markup the selector needs, and the rule itself.
  const SLIDES_CSS = readFileSync(join(__dirname, "../styles/slides.css"), "utf8");

  it("shows a skeleton until the preview has loaded, and not after", () => {
    const frame = thumbFrame();
    const skeleton = frame.nextElementSibling;

    expect(skeleton?.classList.contains("slide-thumb-skeleton")).toBe(true);
    expect(frame.hasAttribute("data-painted")).toBe(false);

    fireEvent.load(frame);

    expect(frame.hasAttribute("data-painted")).toBe(true);
    expect(SLIDES_CSS).toMatch(
      /\.slide-thumb-frame\[data-painted\]\s*\+\s*\.slide-thumb-skeleton\s*\{\s*display:\s*none;/,
    );
  });

  it("reveals what the loaded preview still hides before it is shown", () => {
    // jsdom never loads `srcDoc`, so the frame's document is written here to
    // stand in for the preview that would have loaded.
    const frame = thumbFrame();
    const loaded = frame.contentDocument!;
    loaded.body.innerHTML = `<section ${PREVIEW_ATTR}=""><p id="waiting" style="opacity:0">x</p></section>`;

    fireEvent.load(frame);

    expect(loaded.getElementById("waiting")?.hasAttribute(REVEAL_ATTR)).toBe(true);
    expect(frame.hasAttribute("data-painted")).toBe(true);
  });

  it("reveals inside the preview, never inside the document being read", () => {
    // The live deck has to be in a document with a window, or a reveal aimed at
    // it would find no computed style and silently do nothing — and this test
    // would pass with exactly that bug in place.
    const host = document.createElement("div");
    host.innerHTML = `<main class="deck">
        <section class="slide"><h2>One</h2><p style="opacity:0">waits for its slide</p></section>
        <section class="slide"><h2>Two</h2></section>
      </main>`;
    document.body.appendChild(host);
    try {
      const before = host.innerHTML;
      const { container } = render(
        <SlideThumb slide={firstSlide(document)} baseHref={BASE} stage={STAGE} />,
      );
      fireEvent.load(container.querySelector("iframe")!);

      expect(host.innerHTML).toBe(before);
      expect(document.querySelector(`[${REVEAL_ATTR}]`)).toBeNull();
    } finally {
      host.remove();
    }
  });

  it("keeps the mark through an edit, so typing does not flash it back", () => {
    const doc = deck();
    const { container, rerender } = render(
      <SlideThumb slide={firstSlide(doc)} baseHref={BASE} stage={STAGE} />,
    );
    const frame = container.querySelector("iframe")!;
    fireEvent.load(frame);

    doc.querySelector("h2")!.textContent = "One, edited";
    rerender(<SlideThumb slide={firstSlide(doc)} baseHref={BASE} stage={STAGE} />);

    expect(container.querySelector("iframe")).toBe(frame);
    expect(frame.hasAttribute("data-painted")).toBe(true);
  });
});
