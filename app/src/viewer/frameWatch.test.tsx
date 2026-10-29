// SPDX-License-Identifier: Apache-2.0
// A document whose engine delivers the viewer no events still gets its controls, its threads, its links and its autosave (SPEC §6).

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionFab } from "../components/SelectionFab";
import { attachHighlightClick, highlightRange, serializeCleanHtml } from "../annotation/highlighter";
import { attachOutboundLinks, restoreLinks } from "./outboundLinks";
import { LINK_ATTR } from "../brand/dom";
import { SAMPLE_MS, deliversEvents, refusesListeners, watchSelection } from "./frameWatch";
import { useInlineEditor } from "./useInlineEditor";
import type { FrameMode } from "./frameMode";

const { saveDraft } = vi.hoisted(() => ({
  saveDraft: vi.fn(async (_docId: string, _baseVersion: string, _html: string) => ({})),
}));
vi.mock("../edit", async () => {
  const actual = await vi.importActual<typeof import("../edit")>("../edit");
  return { ...actual, saveDraft };
});

/**
 * A frame document, as the viewer gets it: same-origin, with its own window.
 * `deaf` makes it do what WebKit does to a frame sandboxed without
 * `allow-scripts`: every listener the parent adds is accepted and never
 * called. Measured in the system WebKit (Safari 27), where selectionchange,
 * click, input, keydown and a custom event all went unheard.
 */
function frameDoc(html: string, { deaf = false } = {}): Document {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!DOCTYPE html><html><body>${html}</body></html>`);
  doc.close();
  // jsdom measures nothing; a selection needs a size to be offered anything.
  // The frame's own Range, which is not the parent's.
  Object.defineProperty((frame.contentWindow as unknown as typeof globalThis).Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 100, left: 100, width: 80, height: 20, bottom: 120, right: 180, x: 100, y: 100 }),
  });
  if (deaf) {
    const never = () => {};
    Object.defineProperty(doc, "addEventListener", { configurable: true, value: never });
    Object.defineProperty(doc.defaultView!, "addEventListener", { configurable: true, value: never });
  }
  return doc;
}

function select(doc: Document, selector: string, from: number, to: number) {
  const node = doc.querySelector(selector)!.firstChild!;
  const range = doc.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const sel = doc.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 100, left: 100, width: 80, height: 20, bottom: 120, right: 180, x: 100, y: 100 }),
  });
});
afterEach(() => {
  // Unmount first: a portal in <body> must be React's to remove.
  cleanup();
  vi.useRealTimers();
  delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  document.body.innerHTML = "";
});

describe("knowing whether a document delivers events", () => {
  it("asks the document itself, once", () => {
    expect(deliversEvents(frameDoc("<p>x</p>"))).toBe(true);
    const deaf = frameDoc("<p>x</p>", { deaf: true });
    expect(deliversEvents(deaf)).toBe(false);
    expect(refusesListeners(deaf)).toBe(true);
    expect(refusesListeners(null)).toBe(false);
  });

  it("samples what it cannot hear, and calls back only on a change", () => {
    const doc = frameDoc(`<p id="p">We can cut over in a single weekend.</p>`, { deaf: true });
    const seen = vi.fn();
    const stop = watchSelection(doc, seen);
    vi.advanceTimersByTime(SAMPLE_MS * 3);
    expect(seen).not.toHaveBeenCalled();
    select(doc, "#p", 0, 6);
    vi.advanceTimersByTime(SAMPLE_MS);
    expect(seen).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SAMPLE_MS * 3);
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("the selection controls", () => {
  function mountFab(doc: Document) {
    const onComment = vi.fn();
    render(<SelectionFab doc={doc} epoch={1} enabled onComment={onComment} />, {
      container: document.body.appendChild(document.createElement("div")),
    });
    return onComment;
  }

  it("appear over a selection in a document that delivers no events", () => {
    // In WebKit this was the bug: no selectionchange ever arrived, so on an
    // iPhone the reader selected text and was offered nothing at all.
    const doc = frameDoc(`<p id="p">We can cut over in a single weekend.</p>`, { deaf: true });
    const onComment = mountFab(doc);
    expect(screen.queryByRole("button", { name: /Comment/ })).toBeNull();
    act(() => {
      select(doc, "#p", 7, 14);
      vi.advanceTimersByTime(SAMPLE_MS);
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: /Comment/ }));
    expect(onComment).toHaveBeenCalledTimes(1);
  });

  it("dock at the bottom of the screen on a touch screen, clear of the phone's own menu", () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("pointer: coarse"),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    try {
      const doc = frameDoc(`<p id="p">We can cut over in a single weekend.</p>`);
      mountFab(doc);
      act(() => {
        select(doc, "#p", 7, 14);
        doc.dispatchEvent(new Event("selectionchange"));
      });
      const bar = document.querySelector(".selection-dock");
      expect(bar).not.toBeNull();
      // In <body>, not over the selection: nothing positions it there.
      expect(bar!.parentElement).toBe(document.body);
      expect((bar as HTMLElement).style.top).toBe("");
    } finally {
      matchMedia.mockRestore();
    }
  });
});

describe("a highlight, tapped where no click arrives", () => {
  it("is focusable, never in the tab order, and opens its thread when it takes focus", () => {
    const doc = frameDoc(`<p id="p">We can cut over in a single weekend.</p>`, { deaf: true });
    const range = doc.createRange();
    range.setStart(doc.querySelector("#p")!.firstChild!, 7);
    range.setEnd(doc.querySelector("#p")!.firstChild!, 14);
    highlightRange(doc, range, "ann-1", { authorEmail: "a@example.com" });
    const text = doc.body.textContent;
    const opened = vi.fn();
    const detach = attachHighlightClick(doc, opened);
    const mark = doc.querySelector("mark")!;
    expect(mark.getAttribute("tabindex")).toBe("-1");
    // A tap focuses it; that is all WebKit lets the viewer see.
    mark.focus();
    vi.advanceTimersByTime(SAMPLE_MS);
    expect(opened).toHaveBeenCalledWith("ann-1");
    expect(doc.activeElement).not.toBe(mark);
    // The text the anchors are measured against has not moved.
    expect(doc.body.textContent).toBe(text);
    detach();
    expect(mark.hasAttribute("tabindex")).toBe(false);
  });
});

describe("a link that leaves the document, where no click arrives", () => {
  const HTML = `<a id="out" href="https://example.com/x" target="_self" rel="author">out</a>
    <a id="bare" href="https://example.com/y">bare</a>
    <a id="in" href="#s2">in</a>
    <a id="theirs" href="https://example.com/z" ${LINK_ATTR}="their own value">theirs</a>`;

  it("opens beside the document by its own target, and the author's values come back", () => {
    const doc = frameDoc(HTML, { deaf: true });
    const open = vi.fn();
    const detach = attachOutboundLinks(doc, open);
    const out = doc.getElementById("out")!;
    const bare = doc.getElementById("bare")!;
    expect([out.getAttribute("target"), out.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
    expect([bare.getAttribute("target"), bare.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
    // A link within the document scrolls as it always did.
    expect(doc.getElementById("in")!.hasAttribute("target")).toBe(false);

    // What a save writes is the author's markup, whatever the viewer did to it.
    const saved = serializeCleanHtml(doc);
    expect(saved).toContain(`<a id="out" href="https://example.com/x" target="_self" rel="author">`);
    expect(saved).toContain(`<a id="bare" href="https://example.com/y">`);
    // By value: an author's own attribute of that name is theirs, untouched.
    expect(saved).toContain(`${LINK_ATTR}="their own value"`);

    detach();
    expect([out.getAttribute("target"), out.getAttribute("rel")]).toEqual(["_self", "author"]);
    expect([bare.hasAttribute("target"), bare.hasAttribute("rel"), bare.hasAttribute(LINK_ATTR)]).toEqual([false, false, false]);
    expect(open).not.toHaveBeenCalled();
  });

  it("leaves a document that delivers clicks to the click handler, unchanged", () => {
    const doc = frameDoc(HTML);
    attachOutboundLinks(doc, vi.fn());
    expect(doc.getElementById("bare")!.hasAttribute("target")).toBe(false);
    restoreLinks(doc);
    expect(doc.getElementById("theirs")!.getAttribute(LINK_ATTR)).toBe("their own value");
  });
});

describe("autosave, where no input event arrives", () => {
  const EDITING: FrameMode = { kind: "editing", baseVersion: "v1" };

  function editor(doc: Document, sharedBound = false) {
    return renderHook(
      (props: { sharedBound: boolean }) =>
        useInlineEditor({
          mode: EDITING,
          doc,
          epoch: 1,
          docId: "d1",
          authoredAssets: { current: null },
          onStale: () => {},
          sharedBound: props.sharedBound,
        }),
      { initialProps: { sharedBound } },
    );
  }

  beforeEach(() => {
    saveDraft.mockReset();
    saveDraft.mockResolvedValue({});
  });

  it("sees typing in the document, and saves it", async () => {
    const doc = frameDoc(`<p id="p">The text.</p>`, { deaf: true });
    const view = editor(doc);
    await act(async () => {
      doc.getElementById("p")!.firstChild!.textContent = "The text, edited.";
      await Promise.resolve();
    });
    expect(view.result.current.saveState).toBe("dirty");
    await act(() => vi.runAllTimersAsync());
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it("takes what the shared binding says while it is bound, so a peer's edit saves nothing here", async () => {
    const doc = frameDoc(`<p id="p">The text.</p>`, { deaf: true });
    const view = editor(doc, true);
    await act(async () => {
      // A peer's keystroke, applied to this host by the binding.
      doc.getElementById("p")!.firstChild!.textContent = "The text, from a peer.";
      await Promise.resolve();
    });
    await act(() => vi.runAllTimersAsync());
    expect(saveDraft).not.toHaveBeenCalled();
    // This person's own edit, reported by the binding.
    act(() => view.result.current.markChanged());
    await act(() => vi.runAllTimersAsync());
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it("is not fooled by its own decoration", async () => {
    const doc = frameDoc(`<p id="p">The text.</p>`, { deaf: true });
    editor(doc);
    await act(async () => {
      const layer = doc.createElement("div");
      layer.setAttribute("data-bshd", "peers");
      doc.body.appendChild(layer);
      const label = doc.createTextNode("Ann");
      layer.appendChild(doc.createElement("span")).appendChild(label);
      await Promise.resolve();
      // A peer's name changing inside the overlay is text, but not the author's.
      label.data = "Ann B.";
      layer.setAttribute("data-peer-count", "2");
      await Promise.resolve();
    });
    await act(() => vi.runAllTimersAsync());
    expect(saveDraft).not.toHaveBeenCalled();
  });
});
