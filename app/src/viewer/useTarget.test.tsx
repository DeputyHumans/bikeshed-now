// SPDX-License-Identifier: Apache-2.0
// Selecting a thread brings its passage into view, on whichever slide holds it, and only then (SPEC §6, §6d).

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANN_ATTR } from "../brand/dom";
import type { Annotation } from "../types";
import type { FrameMode } from "./frameMode";
import { useAnnotationLayer } from "./useAnnotationLayer";
import { useDeck } from "./useDeck";
import { useTarget } from "./useTarget";

/**
 * jsdom lays nothing out: `scrollIntoView` is not implemented there at all and
 * every rect is zero (see `test/README.md`). What can be asserted is the CALL —
 * which element, and how — and, on a deck, which slide is SHOWN, against
 * geometry the test states. Whether the passage then sits where a reader
 * expects is a browser check.
 *
 * The three hooks run together, in DocViewer's order: the layer draws the
 * highlights, the deck measures the slides, and the target goes to the passage.
 */

const READING: FrameMode = { kind: "reading", versionId: "v1", draft: false, sandboxed: false };
const scrollIntoView = vi.fn();

afterEach(() => {
  scrollIntoView.mockReset();
  document.body.innerHTML = "";
});

/** A rect `top` pixels down the frame's viewport, one line tall. */
function rectAt(top: number): DOMRect {
  return { top, bottom: top + 20, left: 0, right: 100, height: 20, width: 100, x: 0, y: top, toJSON: () => ({}) };
}

function frameDoc(body: string, viewport = 700): Document {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!DOCTYPE html><html><body>${body}</body></html>`);
  doc.close();
  Object.defineProperty(doc.defaultView!, "innerHeight", { value: viewport, configurable: true });
  Object.defineProperty(doc.defaultView!, "innerWidth", { value: 1200, configurable: true });
  // The frame is its own realm, with its own Element: stubs on the outer
  // prototype never reach it.
  doc.defaultView!.Element.prototype.scrollIntoView = scrollIntoView;
  return doc;
}

function annotation(annId: string, elementId: string, exact: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    annId,
    anchor: { elementId, exact, prefix: "", suffix: "", start: 0, end: exact.length },
    authorUid: "u1",
    authorEmail: "ana@example.com",
    actor: { uid: "u1", email: "ana@example.com", channel: "web" },
    color: "#b5257b",
    resolved: false,
    createdAt: null as never,
    ...extra,
  };
}

interface Props {
  selectedId: string | null;
  annotations: Annotation[];
  frameShown?: boolean;
}

function mount(doc: Document, initialProps: Props) {
  return renderHook(
    (props: Props) => {
      useAnnotationLayer({
        mode: READING,
        doc,
        epoch: 1,
        annotations: props.annotations,
        selectedId: props.selectedId,
        onSelect: vi.fn(),
      });
      const deck = useDeck({ doc, epoch: 1, keysEnabled: false });
      useTarget({
        mode: READING,
        doc,
        epoch: 1,
        deck,
        annotations: props.annotations,
        selectedId: props.selectedId,
        frameShown: props.frameShown,
      });
      return deck;
    },
    { initialProps },
  );
}

/** The element a scroll call was made on. */
function scrolledTo(): Element | undefined {
  return scrollIntoView.mock.contexts.at(-1) as Element | undefined;
}

describe("selecting a thread in a document without pages", () => {
  /** Two sections, every passage well below the fold, so a selection has something to do. */
  function prose(): Document {
    const doc = frameDoc(
      `<section id="s1"><p>The first passage of the document.</p></section>
       <section id="s2"><p>A second passage, further down.</p></section>`,
    );
    doc.defaultView!.Element.prototype.getBoundingClientRect = () => rectAt(doc.defaultView!.innerHeight * 3);
    return doc;
  }
  const threads = () => [annotation("a1", "s1", "first passage"), annotation("a2", "s2", "second passage")];

  it("brings the passage into view, centred, when a thread is selected", () => {
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender({ selectedId: "a2", annotations });

    expect(scrolledTo()?.getAttribute(ANN_ATTR)).toBe("a2");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });

  it("does not scroll again when the highlights are redrawn for the same selection", () => {
    // A peer's comment landing redraws every highlight. The reader may have
    // scrolled on since selecting; pulling them back would be a bug.
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    rerender({ selectedId: "a2", annotations });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    rerender({ selectedId: "a2", annotations: [...annotations] });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("scrolls to a passage whose highlight arrives after the selection", () => {
    // Posting a comment selects the new thread before the listener delivers
    // it; the passage is drawn a moment later and is where the reader is
    // looking, but a selection that outruns its highlight must still land.
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    rerender({ selectedId: "a3", annotations });
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender({ selectedId: "a3", annotations: [...annotations, annotation("a3", "s2", "further down")] });
    expect(scrolledTo()?.getAttribute(ANN_ATTR)).toBe("a3");
  });

  it("waits for a hidden frame to come back, rather than using the jump up on nothing", () => {
    // In one column the comments pane hides the frame, whose box then measures zero,
    // so every passage looks in view. The reader tapped a thread and then Document,
    // and landed nowhere near it.
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    rerender({ selectedId: "a2", annotations, frameShown: false });
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender({ selectedId: "a2", annotations, frameShown: true });
    expect(scrolledTo()?.getAttribute(ANN_ATTR)).toBe("a2");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("does not move a passage that is already in view", () => {
    // The usual way that happens: the selection came from clicking the
    // highlight, which is under the pointer. Moving it would be the document
    // jumping under a click — and the same holds for a panel click on a
    // passage the reader is looking at.
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    doc.querySelector(`[${ANN_ATTR}="a2"]`)!.getBoundingClientRect = () => rectAt(doc.defaultView!.innerHeight / 2);
    rerender({ selectedId: "a2", annotations });
    expect(scrollIntoView).not.toHaveBeenCalled();

    // The next selection, below the fold, scrolls as usual.
    rerender({ selectedId: "a1", annotations });
    expect(scrolledTo()?.getAttribute(ANN_ATTR)).toBe("a1");
  });

  it("brings a passage that is only partly in view fully in", () => {
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    doc.querySelector(`[${ANN_ATTR}="a2"]`)!.getBoundingClientRect = () => rectAt(doc.defaultView!.innerHeight - 10);
    rerender({ selectedId: "a2", annotations });
    expect(scrolledTo()?.getAttribute(ANN_ATTR)).toBe("a2");
  });

  it("scrolls to the same thread again once it has been deselected in between", () => {
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    rerender({ selectedId: "a2", annotations });
    rerender({ selectedId: null, annotations });
    rerender({ selectedId: "a2", annotations });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("takes the reader to a resolved thread's passage, which is not drawn", () => {
    const doc = prose();
    const annotations = [...threads(), annotation("r1", "s2", "further down", { resolved: true })];
    const { rerender } = mount(doc, { selectedId: null, annotations });
    expect(doc.querySelector(`[${ANN_ATTR}="r1"]`)).toBeNull();

    rerender({ selectedId: "r1", annotations });
    expect(scrolledTo()?.textContent).toContain("further down");
    expect(doc.querySelector(`[${ANN_ATTR}="r1"]`)).toBeNull();
  });
});

describe("selecting a thread on a deck that stacks its slides", () => {
  /**
   * A deck that runs its own JavaScript: every slide in the same
   * viewport-sized box, one of them shown, and a keydown listener that moves
   * the showing, the way the deck's own script does. A passage on a hidden
   * slide still has a box inside the viewport, which is exactly what fooled
   * "is it in view" into doing nothing.
   */
  function stacked() {
    const doc = frameDoc(
      [1, 2, 3, 4]
        .map((n) => `<section class="slide" id="s${n}"><h2>Slide ${n}</h2><p>Words on slide number ${n}.</p></section>`)
        .join(""),
    );
    doc.defaultView!.Element.prototype.getBoundingClientRect = () => rectAt(120);
    const sections = Array.from(doc.querySelectorAll<HTMLElement>("section"));
    let at = 0;
    const show = (n: number) => {
      at = Math.max(0, Math.min(sections.length - 1, n));
      sections.forEach((el, i) => {
        el.style.visibility = i === at ? "visible" : "hidden";
      });
    };
    sections.forEach((el) => {
      el.getBoundingClientRect = () => ({ top: 0, bottom: 700, height: 700, left: 0, right: 1200, width: 1200, x: 0, y: 0, toJSON: () => ({}) });
    });
    show(0);
    doc.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") show(at + 1);
      else if (e.key === "ArrowLeft") show(at - 1);
      else return;
      e.preventDefault();
    });
    const showing = () => sections.findIndex((el) => el.style.visibility === "visible");
    return { doc, show, showing };
  }
  const threads = () => [
    annotation("on1", "s1", "slide number 1"),
    annotation("on3", "s3", "slide number 3"),
  ];

  it("shows the slide that holds the passage, through the deck's own keys, and scrolls nothing", () => {
    const { doc, showing } = stacked();
    const annotations = threads();
    const { rerender, result } = mount(doc, { selectedId: null, annotations });
    expect(result.current.paged).toBe(true);
    expect(showing()).toBe(0);

    rerender({ selectedId: "on3", annotations });
    expect(showing()).toBe(2);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("goes back to an earlier slide the same way", () => {
    const { doc, show, showing } = stacked();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    // The deck's own keys moved it, and the rail has not heard yet.
    show(3);
    rerender({ selectedId: "on1", annotations });
    expect(showing()).toBe(0);
  });

  it("leaves the deck where it is for a passage on the slide being shown", () => {
    const { doc, showing } = stacked();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    rerender({ selectedId: "on1", annotations });
    expect(showing()).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("waits for the deck to measure this document before landing a thread selected as it opens", () => {
    // A link, or a comment posted before the frame reloaded, can select a
    // thread before the deck knows it has pages. Landing then would treat the
    // deck as prose and use the jump up on a scroll that shows nothing.
    const { doc, showing } = stacked();
    mount(doc, { selectedId: "on3", annotations: threads() });
    expect(showing()).toBe(2);
  });

  it("takes the reader to the slide of a resolved thread, without drawing it", () => {
    const { doc, showing } = stacked();
    const annotations = [...threads(), annotation("done", "s4", "slide number 4", { resolved: true })];
    const { rerender } = mount(doc, { selectedId: null, annotations });
    rerender({ selectedId: "done", annotations });
    expect(showing()).toBe(3);
    expect(doc.querySelector(`[${ANN_ATTR}="done"]`)).toBeNull();
  });
});
