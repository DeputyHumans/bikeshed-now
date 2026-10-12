// SPDX-License-Identifier: Apache-2.0
// A file dragged onto the document is taken in the page, and the document is never touched (SPEC §2).

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useVersionDrop } from "./useVersionDrop";

/** The frame's own document, as the viewer holds it. */
function frameDocument(): Document {
  const doc = document.implementation.createHTMLDocument("Deck");
  doc.body.innerHTML = "<section><h1>Q3</h1><p>Two weekends.</p></section>";
  return doc;
}

/** A drag event as the browser fires it in the frame, which jsdom cannot build. */
function drag(type: string, files: File[] = [], types = files.length ? ["Files"] : ["text/plain"]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types, files, dropEffect: "none" } });
  return event;
}

function Harness(props: { enabled: boolean; doc: Document | null; onFile: (f: File) => void }) {
  const drop = useVersionDrop({ ...props, epoch: 0 });
  return (
    <div data-testid="stage" {...drop.handlers}>
      {drop.over ? <div data-testid="target">Drop to publish it as a new version</div> : null}
    </div>
  );
}

const FILE = new File(["<p>Hi</p>"], "deck.html", { type: "text/html" });

afterEach(() => vi.useRealTimers());

describe("useVersionDrop", () => {
  it("raises the target in the page when a file is dragged into the document, and takes the drop there", () => {
    const doc = frameDocument();
    const onFile = vi.fn();
    const view = render(<Harness enabled doc={doc} onFile={onFile} />);

    const enter = drag("dragenter", [FILE]);
    act(() => void doc.body.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    const target = view.getByTestId("target");

    fireEvent.dragEnter(target, { dataTransfer: { types: ["Files"], files: [FILE] } });
    fireEvent.drop(target, { dataTransfer: { types: ["Files"], files: [FILE] } });
    expect(onFile).toHaveBeenCalledWith(FILE);
    expect(view.queryByTestId("target")).toBeNull();
  });

  it("takes a drop that lands in the document before the target is up, so the browser cannot open the file", () => {
    const doc = frameDocument();
    const onFile = vi.fn();
    render(<Harness enabled doc={doc} onFile={onFile} />);

    const dropped = drag("drop", [FILE]);
    act(() => void doc.body.dispatchEvent(dropped));
    expect(dropped.defaultPrevented).toBe(true);
    expect(onFile).toHaveBeenCalledWith(FILE);
  });

  it("lets the target go when the drag stops moving over the document", () => {
    vi.useFakeTimers();
    const doc = frameDocument();
    const view = render(<Harness enabled doc={doc} onFile={vi.fn()} />);
    act(() => void doc.body.dispatchEvent(drag("dragenter", [FILE])));
    expect(view.queryByTestId("target")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(600));
    expect(view.queryByTestId("target")).toBeNull();
  });

  it("ignores a drag of text, and does nothing at all while switched off", () => {
    const doc = frameDocument();
    const onFile = vi.fn();
    const view = render(<Harness enabled doc={doc} onFile={onFile} />);
    const text = drag("dragenter");
    act(() => void doc.body.dispatchEvent(text));
    expect(text.defaultPrevented).toBe(false);
    expect(view.queryByTestId("target")).toBeNull();

    view.rerender(<Harness enabled={false} doc={doc} onFile={onFile} />);
    const enter = drag("dragenter", [FILE]);
    const dropped = drag("drop", [FILE]);
    act(() => {
      doc.body.dispatchEvent(enter);
      doc.body.dispatchEvent(dropped);
    });
    expect(enter.defaultPrevented).toBe(false);
    expect(dropped.defaultPrevented).toBe(false);
    expect(view.queryByTestId("target")).toBeNull();
    expect(onFile).not.toHaveBeenCalled();
  });

  it("never writes to the document it listens to", async () => {
    // Decoration must never reach serialized bytes (CLAUDE.md, leg 2's list):
    // this hook is outside that list only because it adds nothing at all.
    const doc = frameDocument();
    const before = doc.documentElement.outerHTML;
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });

    const onFile = vi.fn();
    const view = render(<Harness enabled doc={doc} onFile={onFile} />);
    act(() => {
      doc.body.dispatchEvent(drag("dragenter", [FILE]));
      doc.body.dispatchEvent(drag("dragover", [FILE]));
      doc.body.dispatchEvent(drag("drop", [FILE]));
    });
    view.unmount();
    await Promise.resolve();
    observer.disconnect();

    expect(mutations).toEqual([]);
    expect(doc.documentElement.outerHTML).toBe(before);
  });
});
