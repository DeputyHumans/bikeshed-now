// SPDX-License-Identifier: Apache-2.0
// On a phone the bars leave on the way down and return on the way up, and a reader can always get them back (SPEC §6, §7).

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_MS } from "./frameWatch";
import { CHROME_AT_REST, movesWithHeight, nextChrome, useChromeAutoHide, type ChromeScroll } from "./useChromeAutoHide";

/**
 * A document in a frame that grows when the bars leave, which is what makes this
 * hard: `scrollY` is clamped by the frame's own resize. Traces rather than single
 * states, because every bug here is a sequence. A reader at the bottom of a document
 * sees flicker only over several steps, never in one.
 */
function reader({ height = 4000, viewH = 600, chromeH = 105 } = {}) {
  let state: ChromeScroll = { ...CHROME_AT_REST, viewH };
  let y = 0;
  const flips: { at: number; to: boolean }[] = [];
  const frameH = () => (state.hidden ? viewH + chromeH : viewH);
  const step = (frozen = false) => {
    const was = state.hidden;
    state = nextChrome(state, { y, maxY: height - frameH(), viewH: frameH(), chromeH, frozen });
    if (state.hidden !== was) flips.push({ at: y, to: state.hidden });
    // The browser clamps the scroll once the frame has its new height.
    y = Math.min(y, Math.max(height - frameH(), 0));
  };
  return {
    flips,
    hidden: () => state.hidden,
    y: () => y,
    to(next: number, { frozen = false } = {}) {
      y = next;
      step(frozen);
    },
    /** The rest of a sampled second: nobody moved, and it must stay that way. */
    idle(steps = 8) {
      for (let i = 0; i < steps; i++) step();
    },
  };
}

describe("nextChrome", () => {
  it("leaves after 48 px down, returns after 24 px up, and leaves again", () => {
    const r = reader();
    r.to(30);
    expect(r.hidden()).toBe(false);
    r.to(60);
    expect(r.hidden()).toBe(true);
    r.idle();
    r.to(1000);
    r.to(980);
    expect(r.hidden()).toBe(true);
    r.to(970);
    expect(r.hidden()).toBe(false);
    r.idle();
    r.to(900);
    r.to(940);
    expect(r.hidden()).toBe(false);
    r.to(950);
    expect(r.hidden()).toBe(true);
    expect(r.flips.map((f) => f.to)).toEqual([true, false, true]);
  });

  it("does not flicker at the bottom, where hiding clamps the scroll back up", () => {
    const r = reader();
    r.to(3400); // the very end, with the bars up: 4000 - 600
    expect(r.hidden()).toBe(true);
    expect(r.y()).toBe(3295); // the frame grew, so the end moved up by the bars
    r.idle(20);
    r.to(3295);
    r.idle(20);
    expect(r.flips).toEqual([{ at: 3400, to: true }]);
  });

  it("flips once for a whole flick, however large each 150 ms sample is", () => {
    const r = reader();
    for (const y of [137, 307, 436, 541, 609, 660, 700, 730, 750]) r.to(y);
    expect(r.flips).toEqual([{ at: 137, to: true }]);
  });

  it("takes rubber-banding out at both ends", () => {
    const r = reader();
    r.to(-80);
    r.to(-20);
    r.to(0);
    expect(r.hidden()).toBe(false);
    r.to(3295);
    r.idle();
    expect(r.hidden()).toBe(true);
    // Past the end and back: a bounce, not a scroll up.
    r.to(3360);
    r.to(3320);
    r.to(3295);
    r.idle();
    expect(r.hidden()).toBe(true);
    expect(r.flips).toHaveLength(1);
  });

  it("never hides on a document too short to scroll them back", () => {
    const r = reader({ height: 700 });
    r.to(100);
    r.idle();
    r.to(60);
    r.to(100);
    expect(r.flips).toEqual([]);
  });

  it("hides on a document just long enough to bring them back", () => {
    const r = reader({ height: 600 + 105 + 48 });
    r.to(153);
    expect(r.hidden()).toBe(true);
    r.idle();
    r.to(10);
    expect(r.hidden()).toBe(false);
  });

  it("always shows them at the top, however it got there", () => {
    const r = reader();
    r.to(500);
    r.idle();
    expect(r.hidden()).toBe(true);
    r.to(8);
    expect(r.hidden()).toBe(false);
  });

  it("shows them at the top even when the last stretch was too short to count as a scroll up", () => {
    // Otherwise a reader who thawed just below the top would be stuck there with no
    // bars and no scrolling left to bring them back with.
    const r = reader();
    r.to(500);
    r.idle();
    r.to(15, { frozen: true });
    expect(r.hidden()).toBe(true);
    r.to(5);
    expect(r.hidden()).toBe(false);
  });

  it("moves in neither direction while frozen, and counts from there afterwards", () => {
    const r = reader();
    r.to(500);
    r.idle();
    r.to(100, { frozen: true });
    r.to(40, { frozen: true });
    expect(r.hidden()).toBe(true);
    expect(r.flips).toHaveLength(1);
    // Thawed at 40, it takes a real scroll up from there to bring them back.
    r.to(30);
    expect(r.hidden()).toBe(true);
    r.to(8);
    expect(r.hidden()).toBe(false);
  });

  it("does not hide because it stayed frozen on the way down", () => {
    const r = reader();
    r.to(200, { frozen: true });
    r.to(400, { frozen: true });
    expect(r.hidden()).toBe(false);
    r.to(420);
    expect(r.hidden()).toBe(false);
    r.to(450);
    expect(r.hidden()).toBe(true);
  });
});

/** A frame document whose engine, like WebKit's on a sandboxed frame, calls no listener. */
function deafFrame() {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write("<!DOCTYPE html><html><body><p>The passage.</p></body></html>");
  doc.close();
  const view = doc.defaultView!;
  const never = () => {};
  Object.defineProperty(doc, "addEventListener", { configurable: true, value: never });
  Object.defineProperty(view, "addEventListener", { configurable: true, value: never });
  const page = { y: 0, viewH: 600, height: 4000 };
  Object.defineProperty(view, "scrollY", { configurable: true, get: () => page.y });
  Object.defineProperty(view, "innerHeight", { configurable: true, get: () => page.viewH });
  Object.defineProperty(doc.documentElement, "scrollHeight", { configurable: true, get: () => page.height });
  return { doc, page };
}

describe("useChromeAutoHide", () => {
  let viewer: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    viewer = document.createElement("div");
    viewer.className = "viewer";
    const bars = document.createElement("div");
    bars.className = "viewer-toolbar";
    Object.defineProperty(bars, "offsetHeight", { configurable: true, value: 105 });
    viewer.append(bars);
    document.body.append(viewer);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const mount = (over: Partial<Parameters<typeof useChromeAutoHide>[0]> & { doc: Document }) =>
    renderHook((props: Parameters<typeof useChromeAutoHide>[0]) => useChromeAutoHide(props), {
      initialProps: { enabled: true, epoch: 1, revealKey: "", frozen: () => false, ...over },
    });
  /** Past the quiet second after a page opens, whose scrolling is not the reader's. */
  const settle = () => act(() => void vi.advanceTimersByTime(1100));
  const sample = () => act(() => void vi.advanceTimersByTime(SAMPLE_MS + 1));

  it("works from the sampled scroll on an engine that calls no listener", () => {
    const { doc, page } = deafFrame();
    const { result } = mount({ doc });
    settle();
    expect(result.current).toBe(false);
    page.y = 400;
    sample();
    expect(result.current).toBe(true);
    page.y = 370;
    sample();
    expect(result.current).toBe(false);
  });

  it("takes the first second's scrolling for the page's own: a restore is not a reader", () => {
    const { doc, page } = deafFrame();
    const { result } = mount({ doc });
    page.y = 2000;
    sample();
    expect(result.current).toBe(false);
  });

  it("does nothing while off, which is also the kill switch", () => {
    const { doc, page } = deafFrame();
    const { result } = mount({ doc, enabled: false });
    settle();
    page.y = 900;
    sample();
    expect(result.current).toBe(false);
  });

  it("brings them back as soon as it is turned off", () => {
    const { doc, page } = deafFrame();
    const { result, rerender } = mount({ doc });
    settle();
    page.y = 900;
    sample();
    expect(result.current).toBe(true);
    rerender({ doc, enabled: false, epoch: 1, revealKey: "", frozen: () => false });
    expect(result.current).toBe(false);
  });

  it("brings them back once when there is something new to say, then carries on", () => {
    const { doc, page } = deafFrame();
    const { result, rerender } = mount({ doc });
    settle();
    page.y = 900;
    sample();
    expect(result.current).toBe(true);
    rerender({ doc, enabled: true, epoch: 1, revealKey: "new-version", frozen: () => false });
    expect(result.current).toBe(false);
    settle();
    page.y = 1400;
    sample();
    expect(result.current).toBe(true);
  });

  it("holds still while the reader is selecting", () => {
    const { doc, page } = deafFrame();
    let selecting = false;
    const { result } = mount({ doc, frozen: () => selecting });
    settle();
    selecting = true;
    page.y = 900;
    sample();
    expect(result.current).toBe(false);
  });

  it("turns itself off for a document whose content moves with the frame's height", () => {
    const { doc, page } = deafFrame();
    // Sections sized in vh: four screens of them above the reader's place.
    Object.defineProperty(doc.documentElement, "scrollHeight", {
      configurable: true,
      get: () => (viewer.hasAttribute("data-chrome") ? page.height + 424 : page.height),
    });
    const { result } = mount({ doc });
    expect(viewer.hasAttribute("data-chrome")).toBe(false); // the trial leaves nothing behind
    settle();
    page.y = 900;
    sample();
    expect(result.current).toBe(false);
  });

  it("writes nothing to the document, which is published as it stands", () => {
    const { doc, page } = deafFrame();
    const before = doc.documentElement.outerHTML;
    const records: MutationRecord[] = [];
    const observer = new (doc.defaultView as unknown as typeof globalThis).MutationObserver((r) => records.push(...r));
    observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
    mount({ doc });
    settle();
    page.y = 900;
    sample();
    page.y = 800;
    sample();
    expect(records.concat(observer.takeRecords())).toEqual([]);
    expect(doc.documentElement.outerHTML).toBe(before);
  });
});

describe("movesWithHeight", () => {
  const viewer = document.createElement("div");
  const docOf = (grows: number) =>
    ({
      documentElement: {
        get scrollHeight() {
          return viewer.hasAttribute("data-chrome") ? 4000 + grows : 4000;
        },
      },
    }) as unknown as Document;

  it("lets an ordinary document through", () => {
    expect(movesWithHeight(docOf(0), viewer, 105)).toBe(false);
  });

  it("lets one hero screen through, which moves by exactly the bars and looks like nothing", () => {
    expect(movesWithHeight(docOf(106), viewer, 105)).toBe(false);
  });

  it("stops a document made of screen-sized sections, which would jump", () => {
    expect(movesWithHeight(docOf(424), viewer, 105)).toBe(true);
  });

  it("leaves no trace of having tried", () => {
    movesWithHeight(docOf(424), viewer, 105);
    expect(viewer.hasAttribute("data-chrome")).toBe(false);
  });
});
