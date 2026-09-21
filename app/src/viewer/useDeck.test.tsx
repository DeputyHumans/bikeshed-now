// SPDX-License-Identifier: Apache-2.0
// Deck keys reach the frame, and stop where they should (SPEC §6d).

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDeck } from "./useDeck";

/**
 * A real same-origin iframe rather than a `DOMParser` document, because the
 * whole point of these tests is the frame boundary: a parsed document has no
 * `defaultView`, so it cannot show that measurement reads the frame's viewport
 * or that a key pressed inside the frame is heard at all.
 *
 * jsdom has no layout, so every rect is stubbed. Per `src/test/README.md` the
 * assertion is that the right call happened, never what it looked like.
 */
const frames: HTMLIFrameElement[] = [];

function mountDeck(body: string, slideHeight = 600, viewport = 700) {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  frames.push(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><body>${body}</body>`);
  doc.close();

  Object.defineProperty(doc.defaultView!, "innerHeight", {
    value: viewport,
    configurable: true,
  });
  Object.defineProperty(doc.defaultView!, "innerWidth", {
    value: 1200,
    configurable: true,
  });

  const sections = Array.from(doc.querySelectorAll<HTMLElement>("section"));
  sections.forEach((el, i) => {
    el.getBoundingClientRect = () =>
      ({ top: i * slideHeight - slideHeight, height: slideHeight }) as DOMRect;
    el.scrollIntoView = vi.fn();
  });
  return { doc, sections };
}

afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
});

const DECK = `<main class="deck">
  <section class="slide"><h2>One</h2></section>
  <section class="slide"><h2>Two</h2></section>
  <section class="slide"><h2>Three</h2></section>
</main>`;

function key(doc: Document, k: string, init: KeyboardEventInit = {}) {
  return new (doc.defaultView ?? window).KeyboardEvent("keydown", {
    key: k,
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

function press(target: Document | Window, k: string, init: KeyboardEventInit = {}) {
  const doc = "createEvent" in target ? target : target.document;
  const event = key(doc, k, init);
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/**
 * A deck that runs its own JavaScript: every slide in the same viewport-sized
 * box, one of them shown, and a keydown listener that moves the showing —
 * registered on the frame's document before the hook mounts, the way a deck's
 * own script is. Hiding is by inline `visibility`, which is what jsdom's
 * `getComputedStyle` can report. No `<script>` runs; the listener stands in.
 */
function mountStackedDeck(consumesKeys = true) {
  const { doc, sections } = mountDeck(DECK, 700, 700);
  sections.forEach((el, i) => {
    el.getBoundingClientRect = () => ({ top: 0, height: 700 }) as DOMRect;
    el.style.visibility = i === 0 ? "visible" : "hidden";
  });
  let at = 0;
  const show = (n: number) => {
    at = Math.max(0, Math.min(sections.length - 1, n));
    sections.forEach((el, i) => {
      el.style.visibility = i === at ? "visible" : "hidden";
    });
  };
  const heard: string[] = [];
  doc.addEventListener("keydown", (e) => {
    heard.push(e.key);
    if (!consumesKeys) return;
    if (e.key === "ArrowRight") show(at + 1);
    else if (e.key === "ArrowLeft") show(at - 1);
    else return;
    e.preventDefault();
  });
  const showing = () => sections.findIndex((el) => el.style.visibility === "visible");
  return { doc, sections, heard, show, showing };
}

describe("useDeck", () => {
  it("hears a key pressed inside the frame, where the reader's focus is", () => {
    const { doc, sections } = mountDeck(DECK);
    renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    press(doc, "ArrowRight");

    // Slide 2 is the one at top 0 given the stubbed rects, so "next" is slide 3.
    expect(sections[2].scrollIntoView).toHaveBeenCalled();
  });

  it("also hears a key pressed in the parent, where focus starts", () => {
    const { doc, sections } = mountDeck(DECK);
    renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    press(window, "ArrowLeft");

    expect(sections[0].scrollIntoView).toHaveBeenCalled();
  });

  it("leaves the keys alone when the document's own script already used them", () => {
    const { doc, sections } = mountDeck(DECK);
    renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    // A trusted deck runs its own navigation and calls preventDefault. Paging
    // on top of that advances two slides for one keypress.
    doc.addEventListener("keydown", (e) => e.preventDefault(), { capture: true });
    press(doc, "ArrowRight");

    expect(sections[2].scrollIntoView).not.toHaveBeenCalled();
  });

  it("ignores a shortcut and a keystroke aimed at an input", () => {
    const { doc, sections } = mountDeck(
      `${DECK}<label>Filter <input id="f"></label>`,
    );
    renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    press(doc, "ArrowRight", { metaKey: true });
    expect(sections[2].scrollIntoView).not.toHaveBeenCalled();

    const input = doc.querySelector("input")!;
    act(() => {
      input.dispatchEvent(key(doc, "ArrowRight"));
    });
    expect(sections[2].scrollIntoView).not.toHaveBeenCalled();
  });


  it("does not take the arrow keys on sections taller than the viewport", () => {
    // The control that matters: paging a long-form document would leave the
    // reader unable to scroll within a section at all.
    const { doc, sections } = mountDeck(DECK, 4000, 700);
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    expect(result.current.paged).toBe(false);
    press(doc, "ArrowRight");
    expect(sections[2].scrollIntoView).not.toHaveBeenCalled();
  });

  it("still opens the overview on a document it will not page", () => {
    const { doc } = mountDeck(DECK, 4000, 700);
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    press(doc, "o");
    expect(result.current.overviewOpen).toBe(true);
    press(doc, "o");
    expect(result.current.overviewOpen).toBe(false);
  });

  it("binds nothing while a dialog or the editor owns the keyboard", () => {
    const { doc, sections } = mountDeck(DECK);
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: false }));

    press(doc, "ArrowRight");
    press(doc, "o");

    expect(sections[2].scrollIntoView).not.toHaveBeenCalled();
    expect(result.current.overviewOpen).toBe(false);
  });

  it("reports the slides it found, and nothing for prose", () => {
    const deck = mountDeck(DECK);
    const { result } = renderHook(() =>
      useDeck({ doc: deck.doc, epoch: 1, keysEnabled: true }),
    );
    expect(result.current.slides.map((s) => s.title)).toEqual(["One", "Two", "Three"]);
    expect(result.current.paged).toBe(true);

    const prose = mountDeck(`<article><h1>A post</h1><p>Body.</p></article>`);
    const plain = renderHook(() =>
      useDeck({ doc: prose.doc, epoch: 1, keysEnabled: true }),
    );
    expect(plain.result.current.slides).toEqual([]);
    expect(plain.result.current.paged).toBe(false);
  });
});

describe("what counts as a deck", () => {
  it("lays previews out at the frame's own viewport", () => {
    const { doc } = mountDeck(DECK);
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    expect(result.current.stage).toEqual({ width: 1200, height: 700 });
  });

  /**
   * The rail renders only when `paged` is true, and rendering it NARROWS the
   * frame — which fires this very resize event, reflows the guest, and can push
   * its slides past the height `isPaged` accepts. Let a resize revise the
   * answer and the rail unmounts, the frame widens, the answer flips back, and
   * the viewer oscillates forever, for decks near the threshold only.
   */
  it("does not change its mind about being a deck when the frame resizes", () => {
    const { doc, sections } = mountDeck(DECK);
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));
    expect(result.current.paged).toBe(true);

    // The guest reflows: every slide is now far taller than the viewport, which
    // is exactly what opening a 168px rail can do to a deck near the threshold.
    for (const el of sections) {
      el.getBoundingClientRect = () => ({ top: 0, height: 4000 }) as DOMRect;
    }
    act(() => {
      doc.defaultView!.dispatchEvent(new Event("resize"));
    });

    expect(result.current.paged).toBe(true);
  });

  it("still tracks the reader's position across that same resize", () => {
    // The latch is on `paged` and `stage` only. Position is a live reading and
    // has to stay one, or the rail stops following the document.
    const { doc, sections } = mountDeck(DECK);
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));
    expect(result.current.current).toBe(1);

    sections.forEach((el, i) => {
      el.getBoundingClientRect = () => ({ top: i * 600 - 1200, height: 600 }) as DOMRect;
    });
    act(() => {
      doc.defaultView!.dispatchEvent(new Event("resize"));
    });

    expect(result.current.current).toBe(2);
  });
});

/**
 * The reported bug: a trusted deck that stacks its slides and shows one at a
 * time. `scrollIntoView` on a box that is already at the top scrolls nothing,
 * so the rail, the overview and the parent's arrow keys were all dead on it.
 */
describe("a deck that drives itself", () => {
  it("is recognised as stacked, and still paged", () => {
    const { doc } = mountStackedDeck();
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    expect(result.current.paged).toBe(true);
    expect(result.current.current).toBe(0);
  });

  it("reaches a slide with the arrow keys the deck answers to, not by scrolling", () => {
    const { doc, sections, heard, showing } = mountStackedDeck();
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    act(() => {
      result.current.goTo(2);
    });

    expect(heard).toEqual(["ArrowRight", "ArrowRight"]);
    expect(showing()).toBe(2);
    expect(result.current.current).toBe(2);
    for (const el of sections) expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it("walks back from wherever the deck actually is, not from where it last sent it", () => {
    const { doc, heard, show, showing } = mountStackedDeck();
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    // The reader moved the deck with its own controls; the hook did not do it.
    show(2);
    act(() => {
      result.current.goTo(0);
    });

    expect(heard).toEqual(["ArrowLeft", "ArrowLeft"]);
    expect(showing()).toBe(0);
  });

  it("follows the reader's own moves inside the frame", async () => {
    const { doc, showing } = mountStackedDeck();
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));
    expect(result.current.current).toBe(0);

    // A real keypress in the frame: the deck takes it, the hook yields — and
    // must still notice that the deck moved, because nothing scrolled.
    press(doc, "ArrowRight");
    expect(showing()).toBe(1);
    await act(async () => {});

    expect(result.current.current).toBe(1);
  });

  it("moves the deck from the parent's arrow keys too", () => {
    const { doc, heard, showing } = mountStackedDeck();
    renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    // Focus is in the rail, so the deck's own listener never hears this one.
    press(window, "ArrowRight");

    expect(heard).toEqual(["ArrowRight"]);
    expect(showing()).toBe(1);
  });

  it("falls back to scrolling, once, when the deck takes no arrow keys", () => {
    // A stacked deck driven by clicks alone. The synthetic key reaches the
    // hook's own listener on the frame document, and without a guard that is
    // goTo → key → goTo → key until the stack overflows.
    const { doc, sections, heard } = mountStackedDeck(false);
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    act(() => {
      result.current.goTo(2);
    });

    expect(heard).toEqual(["ArrowRight"]);
    expect(sections[2].scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("never sends a key into a deck that scrolls", () => {
    const { doc, sections } = mountDeck(DECK);
    const heard: string[] = [];
    doc.addEventListener("keydown", (e) => heard.push(e.key));
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    act(() => {
      result.current.goTo(2);
    });

    expect(heard).toEqual([]);
    expect(sections[2].scrollIntoView).toHaveBeenCalled();
  });
});
