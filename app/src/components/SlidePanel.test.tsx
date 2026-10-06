// SPDX-License-Identifier: Apache-2.0
// The rail lists a deck's slides, follows the reader, and reorders it (SPEC §6d).

import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SlidePanel } from "./SlidePanel";
import { scanSlides, type Slide } from "../viewer/deck";

const STAGE = { width: 1280, height: 720 };
const BASE = "/content/doc1/v3/";

/**
 * jsdom implements neither of these, and both are load-bearing here: the rail
 * follows the reader with `scrollIntoView`, and every preview waits on an
 * `IntersectionObserver` before it mounts. Per `src/test/README.md` the
 * assertion is that the right call happened, never what it looked like.
 */
const scrollIntoView = vi.fn();
beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});

function slides(count = 3): Slide[] {
  const sections = Array.from(
    { length: count },
    (_, i) => `<section class="slide"><h2>Slide ${i + 1} title</h2></section>`,
  ).join("");
  const doc = new DOMParser().parseFromString(
    `<body><main class="deck">${sections}</main></body>`,
    "text/html",
  );
  const scan = scanSlides(doc);
  if (scan.kind !== "slides") throw new Error("fixture is not a deck");
  return scan.slides;
}

function panel(props: Partial<Parameters<typeof SlidePanel>[0]> = {}) {
  return render(
    <SlidePanel
      slides={props.slides ?? slides()}
      current={props.current ?? 0}
      editable={props.editable ?? false}
      baseHref={BASE}
      stage={STAGE}
      onGoTo={props.onGoTo ?? vi.fn()}
      onChanged={props.onChanged ?? vi.fn()}
      images={props.images}
    />,
  );
}

describe("SlidePanel", () => {
  it("previews every slide in the state the deck shows its current one in", () => {
    // Only the slide on screen carries the deck's `active`, so a preview that
    // copied each slide as it stands would leave every other one unrevealed.
    const doc = new DOMParser().parseFromString(
      `<body><main class="deck">
         <section class="slide active"><h2>One</h2></section>
         <section class="slide"><h2>Two</h2></section>
         <section class="slide"><h2>Three</h2></section>
       </main></body>`,
      "text/html",
    );
    const scan = scanSlides(doc);
    if (scan.kind !== "slides") throw new Error("fixture is not a deck");
    const { container } = panel({ slides: scan.slides });

    const classes = Array.from(container.querySelectorAll("iframe")).map(
      (frame) =>
        new DOMParser().parseFromString(frame.srcdoc, "text/html").querySelector("section")
          ?.className,
    );
    expect(classes).toEqual(["slide active", "slide active", "slide active"]);
  });

  it("lists every slide, numbered and named", () => {
    const { container } = panel();
    const thumbs = container.querySelectorAll(".slide-thumb");
    expect(thumbs).toHaveLength(3);
    expect(thumbs[1].getAttribute("aria-label")).toBe("Slide 2: Slide 2 title");
  });

  it("says nothing about a document with one section", () => {
    // Two is the floor: a rail with a single entry navigates nowhere. Sliced
    // rather than parsed, because detection needs siblings to find a deck at
    // all — one section is never a deck to begin with.
    const { container } = panel({ slides: slides().slice(0, 1) });
    expect(container.querySelector(".slide-rail")).toBeNull();
  });

  it("marks where the reader is", () => {
    const { container } = panel({ current: 2 });
    const marked = container.querySelectorAll('[aria-current="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0].getAttribute("aria-label")).toBe("Slide 3: Slide 3 title");
  });

  it("follows the reader down a deck taller than the rail", () => {
    // Without this the highlight walks off the bottom and stays there, so the
    // rail shows slide one while the document shows slide thirty.
    const { rerender } = panel({ current: 0 });
    scrollIntoView.mockClear();
    const list = slides();
    rerender(
      <SlidePanel
        slides={list}
        current={2}
        editable={false}
        baseHref={BASE}
        stage={STAGE}
        onGoTo={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(scrollIntoView).toHaveBeenCalled();
    // `nearest` is the point: it is a no-op when the thumb is already visible,
    // so clicking a thumb never yanks the rail out from under the pointer.
    expect(scrollIntoView.mock.calls[0][0]).toMatchObject({ block: "nearest" });
  });

  it("jumps when a thumb is clicked", () => {
    const onGoTo = vi.fn();
    const { container } = panel({ onGoTo });
    fireEvent.click(container.querySelectorAll(".slide-thumb")[2]);
    expect(onGoTo).toHaveBeenCalledWith(2);
  });

  it("offers structural edits only while editing", () => {
    expect(panel({ editable: false }).container.querySelector(".slide-thumb-actions")).toBeNull();
    expect(panel({ editable: true }).container.querySelector(".slide-thumb-actions")).not.toBeNull();
  });

  it("shows where a dragged slide will land", () => {
    // The rail has styled `[data-drop-target]` since it was written, but
    // nothing ever set it: you could pick a slide up and get no indication of
    // where it would go.
    const { container } = panel({ editable: true });
    const thumbs = container.querySelectorAll(".slide-thumb");
    fireEvent.dragStart(thumbs[0]);
    fireEvent.dragEnter(thumbs[2]);

    expect(thumbs[2].getAttribute("data-drop-target")).toBe("true");
    // Never the slide being dragged: it is not a destination.
    expect(thumbs[0].getAttribute("data-drop-target")).toBeNull();

    fireEvent.dragLeave(thumbs[2]);
    expect(thumbs[2].getAttribute("data-drop-target")).toBeNull();
  });

  it("reorders the document itself, not a model of it", () => {
    // Every operation is a plain DOM edit through the same autosave path as
    // typing, which is what keeps a deck and a prose document the same thing.
    const list = slides();
    const onChanged = vi.fn();
    const parent = list[0].outer.parentElement!;
    const { container } = panel({ slides: list, editable: true, onChanged });

    const thumbs = container.querySelectorAll(".slide-thumb");
    fireEvent.dragStart(thumbs[0]);
    fireEvent.drop(thumbs[2]);

    expect(Array.from(parent.children).indexOf(list[0].outer)).toBe(2);
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("SlidePanel with a stored rail", () => {
  it("shows each slide its own stored image", () => {
    const images = ["/thumb/d/v1/k/s0.jpg", "/thumb/d/v1/k/s1.jpg", "/thumb/d/v1/k/s2.jpg"];
    const { container } = panel({ slides: slides(3), images });
    const srcs = Array.from(container.querySelectorAll("img.slide-thumb-image")).map((img) =>
      img.getAttribute("src"),
    );
    expect(srcs).toEqual(images);
    expect(container.querySelector("iframe")).toBeNull();
  });
});
