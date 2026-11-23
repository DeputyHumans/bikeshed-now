// SPDX-License-Identifier: Apache-2.0
// A read document's clicks: a comment intent stays the thread's, and a link out opens beside it (SPEC §6).

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLINK_MS, BLINK_STILL_MS, useAnnotationLayer } from "./useAnnotationLayer";
import { allPainted, installHighlightApi, paintedTexts } from "../test/highlights";
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

describe("hiding comments, and presenting (SPEC §6)", () => {
  interface ShowProps {
    selectedId: string | null;
    shown: boolean;
    blinkSelected: boolean;
  }

  /** A frame with a browser's highlight registry, and the layer drawing two threads in it. */
  function shownMount(initial: ShowProps) {
    const doc = makeDoc();
    const registry = installHighlightApi(doc.defaultView!);
    const annotations = [annotation("a1", "s1", "first passage"), annotation("a2", "s2", "second passage")];
    const hook = renderHook(
      (props: ShowProps) =>
        useAnnotationLayer({
          mode: READING,
          doc,
          epoch: 1,
          annotations,
          selectedId: props.selectedId,
          onSelect: vi.fn(),
          shown: props.shown,
          blinkSelected: props.blinkSelected,
        }),
      { initialProps: initial },
    );
    return { ...hook, registry };
  }

  const HIDDEN = { shown: false, blinkSelected: true };
  const PRESENTING = { shown: false, blinkSelected: false };

  it("paints nothing while hidden, and every thread again when shown", () => {
    const { rerender, registry } = shownMount({ selectedId: null, ...HIDDEN });
    expect(allPainted(registry)).toEqual([]);
    rerender({ selectedId: null, shown: true, blinkSelected: false });
    expect(allPainted(registry)).toEqual(["first passage", "second passage"]);
  });

  it("blinks a thread opened while hidden twice, then leaves nothing marked", () => {
    vi.useFakeTimers();
    const { rerender, registry } = shownMount({ selectedId: null, ...HIDDEN });
    rerender({ selectedId: "a2", ...HIDDEN });
    const seen = [allPainted(registry)];
    for (let i = 0; i < 4; i += 1) {
      act(() => vi.advanceTimersByTime(BLINK_MS));
      seen.push(allPainted(registry));
    }
    expect(seen).toEqual([["second passage"], [], ["second passage"], [], []]);
    act(() => vi.advanceTimersByTime(BLINK_MS * 8));
    expect(allPainted(registry)).toEqual([]);
  });

  it("lights it once, without blinking, under reduced motion", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
    );
    const { rerender, registry } = shownMount({ selectedId: null, ...HIDDEN });
    rerender({ selectedId: "a2", ...HIDDEN });
    act(() => vi.advanceTimersByTime(BLINK_MS));
    expect(allPainted(registry)).toEqual(["second passage"]);
    act(() => vi.advanceTimersByTime(BLINK_STILL_MS));
    expect(allPainted(registry)).toEqual([]);
  });

  it("blinks nothing when the switch goes off with a thread already open, or while presenting", () => {
    vi.useFakeTimers();
    const off = shownMount({ selectedId: "a1", shown: true, blinkSelected: false });
    off.rerender({ selectedId: "a1", ...HIDDEN });
    expect(allPainted(off.registry)).toEqual([]);
    off.unmount();
    const presenting = shownMount({ selectedId: null, ...PRESENTING });
    presenting.rerender({ selectedId: "a2", ...PRESENTING });
    expect(allPainted(presenting.registry)).toEqual([]);
  });

  it("goes off, opens a thread, and comes back on, in one page, as a reader does it", () => {
    vi.useFakeTimers();
    const { rerender, registry } = shownMount({ selectedId: null, shown: true, blinkSelected: false });
    expect(allPainted(registry)).toHaveLength(2);
    rerender({ selectedId: null, ...HIDDEN });
    expect(allPainted(registry)).toEqual([]);
    rerender({ selectedId: "a2", ...HIDDEN });
    expect(allPainted(registry)).toEqual(["second passage"]);
    act(() => vi.advanceTimersByTime(BLINK_MS * 4));
    expect(allPainted(registry)).toEqual([]);
    rerender({ selectedId: "a2", shown: true, blinkSelected: false });
    // Both threads, and the open one painted heavier above them.
    expect(paintedTexts(registry)).toEqual({ "bshd-hl-c0": ["first passage", "second passage"], "bshd-hl-selected": ["second passage"] });
  });
});
