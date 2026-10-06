// SPDX-License-Identifier: Apache-2.0
// Every slide at once, as a way of getting to one of them (SPEC §6d).

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SlideOverview } from "./SlideOverview";
import { scanSlides, type Slide } from "../viewer/deck";

const STAGE = { width: 1280, height: 720 };
const BASE = "/content/doc1/v3/";

function slides(count = 4): Slide[] {
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

function overview(props: Partial<Parameters<typeof SlideOverview>[0]> = {}) {
  return render(
    <SlideOverview
      slides={props.slides ?? slides()}
      current={props.current ?? 0}
      baseHref={BASE}
      stage={STAGE}
      onGoTo={props.onGoTo ?? vi.fn()}
      onClose={props.onClose ?? vi.fn()}
      images={props.images}
    />,
  );
}

describe("SlideOverview", () => {
  it("previews every slide in the state the deck shows its current one in", () => {
    const doc = new DOMParser().parseFromString(
      `<body><main class="deck">
         <section class="slide"><h2>One</h2></section>
         <section class="slide is-active"><h2>Two</h2></section>
       </main></body>`,
      "text/html",
    );
    const scan = scanSlides(doc);
    if (scan.kind !== "slides") throw new Error("fixture is not a deck");
    const { container } = overview({ slides: scan.slides });

    const classes = Array.from(container.querySelectorAll("iframe")).map(
      (frame) =>
        new DOMParser().parseFromString(frame.srcdoc, "text/html").querySelector("section")
          ?.className,
    );
    expect(classes).toEqual(["slide is-active", "slide is-active"]);
  });

  it("shows one card per slide, and says how many", () => {
    const { container, getByText } = overview();
    expect(container.querySelectorAll(".slide-overview-item")).toHaveLength(4);
    expect(getByText("4 slides")).toBeTruthy();
  });

  it("is a modal dialog with a name", () => {
    const dialog = overview().container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("All slides");
  });

  it("jumps and closes on one click", () => {
    const onGoTo = vi.fn();
    const onClose = vi.fn();
    const { container } = overview({ onGoTo, onClose });
    fireEvent.click(container.querySelectorAll(".slide-overview-item")[2]);
    expect(onGoTo).toHaveBeenCalledWith(2);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on the backdrop but not on a card", () => {
    const onClose = vi.fn();
    const { container } = overview({ onClose });
    fireEvent.click(container.querySelector(".slide-overview-grid")!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".slide-overview")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape to useDeck", () => {
    // Four things in this app already arm a document-level Escape with no focus
    // gate. A fifth here would dismiss two surfaces with one key, so the hook
    // owns it and closes the overview before presentation mode sees it.
    const onClose = vi.fn();
    overview({ onClose });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("takes focus to where the reader already is", () => {
    const { container } = overview({ current: 2 });
    const marked = container.querySelector('[aria-current="true"]')!;
    expect(document.activeElement).toBe(marked);
  });
});

describe("SlideOverview with a stored rail", () => {
  it("shows each slide its own stored image", () => {
    const images = ["/thumb/d/v1/k/s0.jpg", "/thumb/d/v1/k/s1.jpg", "/thumb/d/v1/k/s2.jpg"];
    const { container } = overview({ slides: slides(3), images });
    const srcs = Array.from(container.querySelectorAll("img.slide-thumb-image")).map((img) =>
      img.getAttribute("src"),
    );
    expect(srcs).toEqual(images);
    expect(container.querySelector("iframe")).toBeNull();
  });
});
