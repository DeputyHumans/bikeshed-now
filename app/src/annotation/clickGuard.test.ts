// SPDX-License-Identifier: Apache-2.0
// A click that made a text selection never reaches the document's own scripts (SPEC §6).

import { afterEach, describe, expect, it, vi } from "vitest";
import { attachSelectionGuard } from "./clickGuard";

/**
 * A real same-origin iframe, not a `DOMParser` document: the guard sits on the
 * frame's window, which a parsed document does not have, and the deck stand-in
 * below listens on the frame's own document the way a deck's script does.
 *
 * jsdom performs no selection of its own, so each test states the selection at
 * the two moments the guard reads it: when the pointer goes down and when the
 * click arrives. The sequences are the ones measured in Chrome: a drag
 * changes the selection between the two; a click that merely dismisses one
 * collapses it before `click`; a selection stranded on a hidden slide is the
 * same object at both.
 */
const frames: HTMLIFrameElement[] = [];

function mountFrame(body: string): Document {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  frames.push(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><body>${body}</body>`);
  doc.close();
  return doc;
}

afterEach(() => {
  frames.splice(0).forEach((f) => f.remove());
});

function select(doc: Document, selector: string): void {
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector(selector)!);
  const sel = doc.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

function pointerDown(target: Element): void {
  target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

function click(target: Element): Event {
  const view = target.ownerDocument.defaultView!;
  const e = new view.MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

/** The gesture a reader makes: pointer down, the selection changes, click. */
function dragSelect(doc: Document, selector: string): Event {
  const el = doc.querySelector(selector)!;
  pointerDown(el);
  select(doc, selector);
  return click(el);
}

describe("attachSelectionGuard", () => {
  it("lets a click with nothing selected through to the document's own listener", () => {
    const doc = mountFrame("<section><p>alpha</p></section>");
    const advance = vi.fn();
    doc.addEventListener("click", advance);
    attachSelectionGuard(doc);

    const p = doc.querySelector("p")!;
    pointerDown(p);
    click(p);
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it("stops the click that made a selection, without touching its default action", () => {
    const doc = mountFrame("<section><p>alpha</p></section>");
    const advance = vi.fn();
    doc.addEventListener("click", advance);
    attachSelectionGuard(doc);

    const e = dragSelect(doc, "p");
    expect(advance).not.toHaveBeenCalled();
    // Propagation only: a link still navigates, a summary still toggles.
    expect(e.defaultPrevented).toBe(false);
  });

  it("lets a click through when the selection was already there when the pointer went down", () => {
    // A selection stranded on a slide the keys moved off: the browser never
    // collapses it, because it cannot hit-test hidden text. Without this the
    // reader can no longer click through the deck at all.
    const doc = mountFrame("<section><p>alpha</p></section><section><p>beta</p></section>");
    const advance = vi.fn();
    doc.addEventListener("click", advance);
    attachSelectionGuard(doc);

    select(doc, "p");
    const other = doc.querySelectorAll("p")[1];
    pointerDown(other);
    click(other);
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it("stops a click that extended a selection that was already there", () => {
    // Shift-click. The selection differs from the one at pointer-down, which
    // is the whole test: it is what THIS gesture did that decides.
    const doc = mountFrame("<section><p>alpha</p><p>beta</p></section>");
    const advance = vi.fn();
    doc.addEventListener("click", advance);
    attachSelectionGuard(doc);

    select(doc, "p:first-child");
    const last = doc.querySelector("p:last-child")!;
    pointerDown(last);
    doc.getSelection()!.extend(last.firstChild!, 4);
    click(last);
    expect(advance).not.toHaveBeenCalled();
  });

  it("does not stop a click nobody's pointer made", () => {
    // Keyboard activation and the document's own synthetic clicks arrive
    // without a pointer-down. Neither is the reader selecting text.
    const doc = mountFrame("<section><p>alpha</p></section>");
    const advance = vi.fn();
    doc.addEventListener("click", advance);
    attachSelectionGuard(doc);

    select(doc, "p");
    click(doc.querySelector("p")!);
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it("wins over a capture-phase listener the deck registered first", () => {
    // Registration order decides between listeners on ONE node. The guard
    // sits on the window, above the document, so it runs before anything the
    // deck attached to its document in either phase, whenever it attached it.
    const doc = mountFrame("<section><p>alpha</p></section>");
    const advance = vi.fn();
    doc.addEventListener("click", advance, true);
    attachSelectionGuard(doc);

    dragSelect(doc, "p");
    expect(advance).not.toHaveBeenCalled();
  });

  it("detaches cleanly", () => {
    const doc = mountFrame("<section><p>alpha</p></section>");
    const advance = vi.fn();
    doc.addEventListener("click", advance);
    const detach = attachSelectionGuard(doc);

    detach();
    dragSelect(doc, "p");
    expect(advance).toHaveBeenCalledTimes(1);
  });
});
