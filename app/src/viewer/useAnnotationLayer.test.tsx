// SPDX-License-Identifier: Apache-2.0
// Selecting a thread brings its passage into view, and only then (SPEC §6).

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAnnotationLayer } from "./useAnnotationLayer";
import { ANN_ATTR } from "../brand/dom";
import type { Annotation } from "../types";
import type { FrameMode } from "./frameMode";

/**
 * jsdom lays nothing out: `scrollIntoView` is not implemented there at all and
 * every rect is zero (see `test/README.md`). What can be asserted is the CALL —
 * which element, and how — against geometry the test states. Whether the
 * passage then sits where a reader expects is a browser check.
 */

/**
 * A real frame document, not a parsed one: the viewport the hook measures
 * against is the frame's own window, which a `DOMParser` document lacks.
 */
function makeDoc(): Document {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(
    `<!DOCTYPE html><html><body>
     <section id="s1"><p>The first passage of the document.</p></section>
     <section id="s2"><p>A second passage, further down.</p></section></body></html>`,
  );
  doc.close();
  // The frame is its own realm, with its own Element: stubs on the outer
  // prototype never reach it. Every passage starts well below the fold, so a
  // selection has something to do.
  const proto = doc.defaultView!.Element.prototype;
  proto.scrollIntoView = scrollIntoView;
  proto.getBoundingClientRect = () => rectAt(viewHeight(doc) * 3);
  return doc;
}

/** The frame's viewport height, which is what "in view" is measured against. */
function viewHeight(doc: Document): number {
  return doc.defaultView!.innerHeight;
}

function annotation(annId: string, elementId: string, exact: string): Annotation {
  return {
    annId,
    anchor: { elementId, exact, prefix: "", suffix: "", start: 0, end: exact.length },
    authorUid: "u1",
    authorEmail: "ana@example.com",
    actor: { uid: "u1", email: "ana@example.com", channel: "web" },
    color: "#b5257b",
    resolved: false,
    createdAt: null as never,
  };
}

const READING: FrameMode = { kind: "reading", versionId: "v1", draft: false, sandboxed: false };

const scrollIntoView = vi.fn();

/** A rect `top` pixels down the frame's viewport, one line tall. */
function rectAt(top: number): DOMRect {
  return { top, bottom: top + 20, left: 0, right: 100, height: 20, width: 100, x: 0, y: top, toJSON: () => ({}) };
}

afterEach(() => {
  scrollIntoView.mockReset();
  document.body.innerHTML = "";
});

/** The element a scroll call was made on. */
function scrolledTo(): Element | undefined {
  return scrollIntoView.mock.contexts.at(-1) as Element | undefined;
}

interface Props {
  selectedId: string | null;
  annotations: Annotation[];
}

function mount(doc: Document) {
  const annotations = [
    annotation("a1", "s1", "first passage"),
    annotation("a2", "s2", "second passage"),
  ];
  const onSelect = vi.fn();
  const initialProps: Props = { selectedId: null, annotations };
  const hook = renderHook(
    (props: Props) =>
      useAnnotationLayer({
        mode: READING,
        doc,
        epoch: 1,
        annotations: props.annotations,
        selectedId: props.selectedId,
        onSelect,
      }),
    { initialProps },
  );
  return { ...hook, annotations, onSelect };
}

describe("selecting a thread", () => {
  it("brings the passage into view, centred, when a thread is selected", () => {
    const doc = makeDoc();
    const { rerender, annotations } = mount(doc);
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender({ selectedId: "a2", annotations });

    expect(scrolledTo()?.getAttribute(ANN_ATTR)).toBe("a2");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });

  it("does not scroll again when the highlights are redrawn for the same selection", () => {
    // A peer's comment landing redraws every highlight. The reader may have
    // scrolled on since selecting; pulling them back would be a bug.
    const doc = makeDoc();
    const { rerender, annotations } = mount(doc);
    rerender({ selectedId: "a2", annotations });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    rerender({ selectedId: "a2", annotations: [...annotations] });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("scrolls to a passage whose highlight arrives after the selection", () => {
    // Posting a comment selects the new thread before the listener delivers
    // it; the passage is drawn a moment later and is where the reader is
    // looking, but a selection that outruns its highlight must still land.
    const doc = makeDoc();
    const { rerender, annotations } = mount(doc);
    rerender({ selectedId: "a3", annotations });
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender({
      selectedId: "a3",
      annotations: [...annotations, annotation("a3", "s2", "further down")],
    });
    expect(scrolledTo()?.getAttribute(ANN_ATTR)).toBe("a3");
  });

  it("does not move a passage that is already in view", () => {
    // The usual way that happens: the selection came from clicking the
    // highlight, which is under the pointer. Moving it would be the document
    // jumping under a click — and the same holds for a panel click on a
    // passage the reader is looking at.
    const doc = makeDoc();
    const { rerender, annotations, onSelect } = mount(doc);
    const mark = doc.querySelector(`[${ANN_ATTR}="a2"]`)!;
    mark.getBoundingClientRect = () => rectAt(viewHeight(doc) / 2);
    act(() => {
      mark.dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith("a2");

    rerender({ selectedId: "a2", annotations });
    expect(scrollIntoView).not.toHaveBeenCalled();

    // The next selection, below the fold, scrolls as usual.
    rerender({ selectedId: "a1", annotations });
    expect(scrolledTo()?.getAttribute(ANN_ATTR)).toBe("a1");
  });

  it("brings a passage that is only partly in view fully in", () => {
    const doc = makeDoc();
    const { rerender, annotations } = mount(doc);
    doc.querySelector(`[${ANN_ATTR}="a2"]`)!.getBoundingClientRect = () =>
      rectAt(viewHeight(doc) - 10);
    rerender({ selectedId: "a2", annotations });
    expect(scrolledTo()?.getAttribute(ANN_ATTR)).toBe("a2");
  });

  it("scrolls to the same thread again once it has been deselected in between", () => {
    const doc = makeDoc();
    const { rerender, annotations } = mount(doc);
    rerender({ selectedId: "a2", annotations });
    rerender({ selectedId: null, annotations });
    rerender({ selectedId: "a2", annotations });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});

describe("a click that carries a comment intent", () => {
  /** The gesture a reader makes: pointer down, the drag selects, click. */
  function dragSelect(doc: Document, selector: string): void {
    const el = doc.querySelector(selector)!;
    const view = doc.defaultView!;
    act(() => {
      el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = doc.createRange();
      range.selectNodeContents(el);
      const sel = doc.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      el.dispatchEvent(new view.MouseEvent("click", { bubbles: true }));
    });
  }

  function plainClick(doc: Document, selector: string): void {
    const el = doc.querySelector(selector)!;
    const view = doc.defaultView!;
    act(() => {
      el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      doc.getSelection()!.removeAllRanges();
      el.dispatchEvent(new view.MouseEvent("click", { bubbles: true }));
    });
  }

  it("never reaches the document's own click listener when the click made a selection", () => {
    // The deck's own script, which advances on click and would hide the very
    // slide the reader is about to comment on.
    const doc = makeDoc();
    const advance = vi.fn();
    doc.addEventListener("click", advance);
    const { unmount } = mount(doc);

    dragSelect(doc, "#s1 p");
    expect(advance).not.toHaveBeenCalled();

    plainClick(doc, "#s1 p");
    expect(advance).toHaveBeenCalledTimes(1);

    // Gone with the layer: the edit frame gets every click, caret and all.
    unmount();
    dragSelect(doc, "#s1 p");
    expect(advance).toHaveBeenCalledTimes(2);
  });
});
