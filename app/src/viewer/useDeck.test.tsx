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
  it("keeps both pages of a two-slide deck reachable, including Home", () => {
    const { doc, sections } = mountDeck('<main><section class="slide"><h2>One</h2></section><section class="slide"><h2>Two</h2></section></main>', 700, 700);
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));
    expect(result.current.slides).toHaveLength(2);
    expect(result.current.paged).toBe(true);
    act(() => result.current.goTo(1));
    expect(sections[1].scrollIntoView).toHaveBeenCalled();
    press(window, "Home");
    expect(sections[0].scrollIntoView).toHaveBeenCalled();
    expect(result.current.current).toBe(0);
  });

  it("tells of every move the reader makes, by the rail or the keys, and not of a follow's", () => {
    // Following a peer is let go by a move of the reader's own; the follow's
    // own moves must not let go of it (SPEC §16).
    const { doc } = mountDeck(DECK, 700, 700);
    const onReaderMove = vi.fn();
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true, onReaderMove }));
    act(() => result.current.goTo(2, { follow: true }));
    expect(onReaderMove).not.toHaveBeenCalled();
    act(() => result.current.goTo(1));
    expect(onReaderMove).toHaveBeenCalledTimes(1);
    press(window, "ArrowRight");
    expect(onReaderMove).toHaveBeenCalledTimes(2);
  });

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

  it("leaves overview keys alone on a document it will not page", () => {
    const { doc } = mountDeck(DECK, 4000, 700);
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    expect(press(doc, "o").defaultPrevented).toBe(false);
    expect(result.current.overviewOpen).toBe(false);
    expect(press(doc, "O").defaultPrevented).toBe(false);
    expect(result.current.overviewOpen).toBe(false);
  });

  it("closes the overview on Escape, and leaves Escape alone when it is shut", () => {
    // The overview binds no Escape of its own (SlideOverview.test pins that),
    // so this is the only thing that closes it from the keyboard.
    const { doc } = mountDeck(DECK);
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));

    press(window, "o");
    expect(result.current.overviewOpen).toBe(true);
    const closing = press(window, "Escape");
    expect(result.current.overviewOpen).toBe(false);
    expect(closing.defaultPrevented).toBe(true);

    // Shut, Escape is somebody else's: presentation mode's fullscreen exit, a
    // menu, a dialog. Taking it here would swallow theirs.
    const passing = press(window, "Escape");
    expect(passing.defaultPrevented).toBe(false);
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
  for (const event of ["transitionend", "transitioncancel", "animationend", "animationcancel"]) {
    it(`tracks the final shown slide on ${event} without another attribute change`, async () => {
      const { doc, sections, show } = mountStackedDeck();
      let painted = 0;
      const computed = vi.spyOn(doc.defaultView!, "getComputedStyle").mockImplementation((el) => ({
        display: "block", visibility: "visible", opacity: sections.indexOf(el as HTMLElement) === painted ? "1" : "0", transform: "none",
      }) as CSSStyleDeclaration);
      const { result, unmount } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));
      show(1);
      await act(async () => {});
      expect(result.current.current).toBe(0); // the outgoing slide still paints
      painted = 1; // computed style changes at completion, without DOM mutation
      act(() => sections[1].dispatchEvent(new doc.defaultView!.Event(event, { bubbles: true })));
      expect(result.current.current).toBe(1);
      unmount();
      computed.mockClear();
      sections[1].dispatchEvent(new doc.defaultView!.Event(event, { bubbles: true }));
      expect(computed).not.toHaveBeenCalled();
    });
  }

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

describe("a deck that fades between its slides", () => {
  /**
   * Like `mountStackedDeck`, but the slide being left stays visible until
   * `settle()`, as a deck that fades keeps it until the fade ends: for that
   * moment two slides are shown, and the first of them is the old one.
   */
  function mountFadingDeck() {
    const { doc, sections } = mountDeck(`<main class="deck">${[1, 2, 3, 4, 5].map((n) => `<section class="slide"><h2>${n}</h2></section>`).join("")}</main>`, 700, 700);
    sections.forEach((el) => {
      el.getBoundingClientRect = () => ({ top: 0, height: 700 }) as DOMRect;
    });
    let at = 0;
    const paint = (visible: number[]) =>
      sections.forEach((el, i) => {
        el.style.visibility = visible.includes(i) ? "visible" : "hidden";
      });
    paint([0]);
    const fading = new Set<number>();
    doc.addEventListener("keydown", (e) => {
      const next = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : null;
      if (next === null) return;
      fading.add(at);
      at = Math.max(0, Math.min(sections.length - 1, next));
      fading.delete(at);
      paint([at, ...fading]);
      e.preventDefault();
    });
    const settle = () => {
      fading.clear();
      paint([at]);
    };
    return { doc, settle, at: () => at };
  }

  it("counts a second move from the slide it is heading to, not the one still fading out", async () => {
    const { doc, settle, at } = mountFadingDeck();
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));
    expect(result.current.paged).toBe(true);
    act(() => result.current.goTo(3));
    expect(at()).toBe(3);
    // Still fading: slides 0, 1 and 2 are shown with 3, and the first shown is 0.
    act(() => result.current.goTo(1));
    expect(at()).toBe(1);
    act(() => settle());
    await act(async () => {});
    expect(result.current.locate()).toBe(1);
  });

  it("reads the frame again once the deck shows one slide, so its own keys are followed", async () => {
    const { doc, settle, at } = mountFadingDeck();
    const { result } = renderHook(() => useDeck({ doc, epoch: 1, keysEnabled: true }));
    act(() => result.current.goTo(2));
    act(() => settle());
    await act(async () => {});
    // The deck's own key, pressed in the frame, and settled.
    act(() => {
      doc.body.dispatchEvent(new (doc.defaultView!.KeyboardEvent)("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    act(() => settle());
    await act(async () => {});
    expect(at()).toBe(3);
    expect(result.current.locate()).toBe(3);
    act(() => result.current.goTo(0));
    expect(at()).toBe(0);
  });
});
