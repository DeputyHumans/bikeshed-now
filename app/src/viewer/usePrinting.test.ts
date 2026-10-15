// SPDX-License-Identifier: Apache-2.0
// The print shortcut is the export, and File → Print gets the whole frame (SPEC §20).

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePrinting } from "./usePrinting";

/**
 * A real same-origin iframe, as in useDeck's tests: the case that matters is
 * a key pressed with focus INSIDE the frame, which a parsed document cannot
 * stand in for — it has no window to press keys in.
 */
const frames: HTMLIFrameElement[] = [];

function mountFrame(scrollHeight = 4200) {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  frames.push(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write("<!doctype html><body><p>hello</p></body>");
  doc.close();
  Object.defineProperty(doc.documentElement, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  return { frame, doc };
}

afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
});

function press(target: Window | Document, key: string, init: KeyboardEventInit = {}) {
  const view = target instanceof Window ? target : (target.defaultView ?? window);
  const e = new (view as typeof window).KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(e);
  return e;
}

function mount(doc: Document | null, enabled = true) {
  const onPrint = vi.fn();
  const hook = renderHook(() => usePrinting({ doc, epoch: 1, enabled, onPrint }));
  return { onPrint, ...hook };
}

describe("the print shortcut", () => {
  it("routes Cmd+P to the export and keeps the browser's dialog closed", () => {
    const { doc } = mountFrame();
    const { onPrint } = mount(doc);

    const e = press(window, "p", { metaKey: true });

    expect(onPrint).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("takes Ctrl+P and Cmd+Shift+P the same way", () => {
    const { doc } = mountFrame();
    const { onPrint } = mount(doc);

    press(window, "p", { ctrlKey: true });
    // Chrome's "print using the system dialog" — prints the page just as wrongly.
    press(window, "P", { metaKey: true, shiftKey: true });

    expect(onPrint).toHaveBeenCalledTimes(2);
  });

  it("hears the shortcut pressed inside the frame", () => {
    // The reader's focus is usually in the document. A parent-only listener
    // is silently dead the moment somebody clicks it.
    const { doc } = mountFrame();
    const { onPrint } = mount(doc);

    const e = press(doc, "p", { metaKey: true });

    expect(onPrint).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("leaves a plain p, and everything else, to whoever wants it", () => {
    const { doc } = mountFrame();
    const { onPrint } = mount(doc);

    press(window, "p");
    press(window, "p", { altKey: true, metaKey: true });
    press(window, "o", { metaKey: true });

    expect(onPrint).not.toHaveBeenCalled();
  });

  it("stands down while editing or while a dialog is open", () => {
    const { doc } = mountFrame();
    const { onPrint } = mount(doc, false);

    const e = press(window, "p", { metaKey: true });

    expect(onPrint).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("gives the document's own script first refusal", () => {
    // The document's script has run long before this hook attaches, so on
    // the frame it is the earlier listener — registration order decides.
    const { doc } = mountFrame();
    doc.addEventListener("keydown", (e) => e.preventDefault());
    const { onPrint } = mount(doc);

    press(doc, "p", { metaKey: true });

    expect(onPrint).not.toHaveBeenCalled();
  });
});

describe("File → Print", () => {
  it("opens the frame to its full height for the print, and closes it after", () => {
    const { frame, doc } = mountFrame(4200);
    mount(doc);

    const before = { frames: document.querySelectorAll("iframe").length, html: doc.body.innerHTML };
    window.dispatchEvent(new Event("beforeprint"));
    expect(frame.style.height).toBe("4200px");
    expect({ frames: document.querySelectorAll("iframe").length, html: doc.body.innerHTML }).toEqual(before);

    window.dispatchEvent(new Event("afterprint"));
    expect(frame.style.height).toBe("");
  });

  it("puts the reader back where they were", () => {
    // A frame with no overflow forgets its scroll position; printing and
    // cancelling must not cost the reader their place.
    const { doc } = mountFrame();
    mount(doc);
    // jsdom has no scrollingElement and its scrollTop is a stub that stays
    // 0; the hook falls back to the root, so give that one a memory.
    let position = 0;
    Object.defineProperty(doc.documentElement, "scrollTop", {
      get: () => position,
      set: (v: number) => { position = v; },
      configurable: true,
    });
    position = 1234;
    window.dispatchEvent(new Event("beforeprint"));
    position = 0;

    window.dispatchEvent(new Event("afterprint"));

    expect(position).toBe(1234);
  });

  it("keeps the first position if beforeprint fires twice before afterprint", () => {
    // Once the frame is open there is no overflow and the position reads 0;
    // a second beforeprint must not overwrite what the first remembered.
    const { doc } = mountFrame();
    mount(doc);
    let position = 0;
    Object.defineProperty(doc.documentElement, "scrollTop", {
      get: () => position,
      set: (v: number) => { position = v; },
      configurable: true,
    });
    position = 1234;
    window.dispatchEvent(new Event("beforeprint"));
    position = 0;
    window.dispatchEvent(new Event("beforeprint"));

    window.dispatchEvent(new Event("afterprint"));

    expect(position).toBe(1234);
  });

  it("does nothing without a frame", () => {
    mount(null);
    expect(() => {
      window.dispatchEvent(new Event("beforeprint"));
      window.dispatchEvent(new Event("afterprint"));
    }).not.toThrow();
  });
});
