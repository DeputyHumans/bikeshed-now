// SPDX-License-Identifier: Apache-2.0
// A read document's clicks: a comment intent stays the thread's, and a link out opens beside it (SPEC §6).

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAnnotationLayer } from "./useAnnotationLayer";
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

describe("a link out of the document", () => {
  function clickOut(doc: Document): MouseEvent {
    const event = new (doc.defaultView!.MouseEvent)("click", { bubbles: true, cancelable: true });
    act(() => {
      doc.querySelector("#out")!.dispatchEvent(event);
    });
    return event;
  }

  it("opens beside the viewer while reading, so the document stays where it is", () => {
    const doc = makeDoc();
    doc.body.insertAdjacentHTML("beforeend", `<a id="out" href="https://example.com/x">out</a>`);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      const { unmount } = mount(doc);
      expect(clickOut(doc).defaultPrevented).toBe(true);
      expect(open).toHaveBeenCalledWith("https://example.com/x", "_blank", "noopener,noreferrer");
      unmount();
      expect(clickOut(doc).defaultPrevented).toBe(false);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  it("is left alone while editing, where a click places the caret", () => {
    const doc = makeDoc();
    doc.body.insertAdjacentHTML("beforeend", `<a id="out" href="https://example.com/x">out</a>`);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      renderHook(() =>
        useAnnotationLayer({
          mode: { kind: "editing", baseVersion: "v1" },
          doc,
          epoch: 1,
          annotations: [],
          selectedId: null,
          onSelect: vi.fn(),
        }),
      );
      expect(clickOut(doc).defaultPrevented).toBe(false);
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });
});
