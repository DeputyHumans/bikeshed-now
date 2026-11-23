// SPDX-License-Identifier: Apache-2.0
// Selecting a thread brings its passage into view, on whichever slide holds it, and only then (SPEC §6, §6d).

import { renderHook } from "@testing-library/react";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANN_ATTR } from "../brand/dom";
import type { Peer } from "../presence";
import type { Annotation } from "../types";
import type { FrameMode } from "./frameMode";
import { useAnnotationLayer } from "./useAnnotationLayer";
import { useDeck } from "./useDeck";
import { useTarget, type TargetNotice, type ThreadsState } from "./useTarget";

/**
 * jsdom lays nothing out: `scrollIntoView` is not implemented there at all and
 * every rect is zero (see `test/README.md`). What can be asserted is the CALL —
 * which element, and how — and, on a deck, which slide is SHOWN, against
 * geometry the test states. Whether the passage then sits where a reader
 * expects is a browser check.
 *
 * The three hooks run together, in DocViewer's order: the layer draws the
 * highlights, the deck measures the slides, and the target goes to the passage.
 */

const READING: FrameMode = { kind: "reading", versionId: "v1", draft: false, sandboxed: false };
const scrollIntoView = vi.fn();

beforeEach(() => {
  // The address is the test window's own, so each case starts on a clean one.
  window.history.replaceState(null, "", "/d/deck");
});
afterEach(() => {
  scrollIntoView.mockReset();
  document.body.innerHTML = "";
});

/** A rect `top` pixels down the frame's viewport, one line tall. */
function rectAt(top: number): DOMRect {
  return { top, bottom: top + 20, left: 0, right: 100, height: 20, width: 100, x: 0, y: top, toJSON: () => ({}) };
}

function frameDoc(body: string, viewport = 700): Document {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!DOCTYPE html><html><body>${body}</body></html>`);
  doc.close();
  Object.defineProperty(doc.defaultView!, "innerHeight", { value: viewport, configurable: true });
  Object.defineProperty(doc.defaultView!, "innerWidth", { value: 1200, configurable: true });
  // The frame is its own realm, with its own Element: stubs on the outer
  // prototype never reach it.
  doc.defaultView!.Element.prototype.scrollIntoView = scrollIntoView;
  return doc;
}

function annotation(annId: string, elementId: string, exact: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    annId,
    anchor: { elementId, exact, prefix: "", suffix: "", start: 0, end: exact.length },
    authorUid: "u1",
    authorEmail: "ana@example.com",
    actor: { uid: "u1", email: "ana@example.com", channel: "web" },
    color: "#b5257b",
    resolved: false,
    createdAt: null as never,
    ...extra,
  };
}

interface Props {
  selectedId: string | null;
  annotations: Annotation[];
  frameShown?: boolean;
  follow?: Peer | null;
  shareSlide?: (slide: number | null) => void;
  onReaderMove?: () => void;
  doc?: Document;
  epoch?: number;
  hash?: string;
  threads?: ThreadsState;
  onThread?: (threadId: string) => void;
  onNotice?: (notice: TargetNotice) => void;
}

function mount(doc: Document, initialProps: Props) {
  return renderHook(
    (props: Props) => {
      const frame = props.doc ?? doc;
      const epoch = props.epoch ?? 1;
      useAnnotationLayer({
        mode: READING,
        doc: frame,
        epoch,
        annotations: props.annotations,
        selectedId: props.selectedId,
        onSelect: vi.fn(),
      });
      const deck = useDeck({ doc: frame, epoch, keysEnabled: false, onReaderMove: props.onReaderMove });
      useTarget({
        mode: READING,
        doc: frame,
        epoch,
        deck,
        annotations: props.annotations,
        selectedId: props.selectedId,
        frameShown: props.frameShown,
        follow: props.follow,
        shareSlide: props.shareSlide,
        hash: props.hash,
        threads: props.threads,
        onThread: props.onThread,
        onNotice: props.onNotice,
      });
      return deck;
    },
    { initialProps },
  );
}

/** The element whose text holds a section's passage. */
function holding(doc: Document, sectionId: string): HTMLElement {
  return doc.querySelector<HTMLElement>(`#${sectionId} p`)!;
}

/** The element a scroll call was made on. */
function scrolledTo(): Element | undefined {
  return scrollIntoView.mock.contexts.at(-1) as Element | undefined;
}

describe("selecting a thread in a document without pages", () => {
  /** Two sections, every passage well below the fold, so a selection has something to do. */
  function prose(): Document {
    const doc = frameDoc(
      `<section id="s1"><p>The first passage of the document.</p></section>
       <section id="s2"><p>A second passage, further down.</p></section>`,
    );
    doc.defaultView!.Element.prototype.getBoundingClientRect = () => rectAt(doc.defaultView!.innerHeight * 3);
    return doc;
  }
  const threads = () => [annotation("a1", "s1", "first passage"), annotation("a2", "s2", "second passage")];

  it("brings the passage into view, centred, when a thread is selected", () => {
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender({ selectedId: "a2", annotations });

    // The element holding the passage: a painted highlight is no element of its own.
    expect(scrolledTo()).toBe(holding(doc, "s2"));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });

  it("does not scroll again when the highlights are redrawn for the same selection", () => {
    // A peer's comment landing redraws every highlight. The reader may have
    // scrolled on since selecting; pulling them back would be a bug.
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    rerender({ selectedId: "a2", annotations });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    rerender({ selectedId: "a2", annotations: [...annotations] });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("scrolls to a passage whose highlight arrives after the selection", () => {
    // Posting a comment selects the new thread before the listener delivers
    // it; the passage is drawn a moment later and is where the reader is
    // looking, but a selection that outruns its highlight must still land.
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    rerender({ selectedId: "a3", annotations });
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender({ selectedId: "a3", annotations: [...annotations, annotation("a3", "s2", "further down")] });
    expect(scrolledTo()).toBe(holding(doc, "s2"));
  });

  it("waits for a hidden frame to come back, rather than using the jump up on nothing", () => {
    // In one column the comments pane hides the frame, whose box then measures zero,
    // so every passage looks in view. The reader tapped a thread and then Document,
    // and landed nowhere near it.
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    rerender({ selectedId: "a2", annotations, frameShown: false });
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender({ selectedId: "a2", annotations, frameShown: true });
    expect(scrolledTo()).toBe(holding(doc, "s2"));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("does not move a passage that is already in view", () => {
    // The usual way that happens: the selection came from clicking the
    // highlight, which is under the pointer. Moving it would be the document
    // jumping under a click — and the same holds for a panel click on a
    // passage the reader is looking at.
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    holding(doc, "s2").getBoundingClientRect = () => rectAt(doc.defaultView!.innerHeight / 2);
    rerender({ selectedId: "a2", annotations });
    expect(scrollIntoView).not.toHaveBeenCalled();

    // The next selection, below the fold, scrolls as usual.
    rerender({ selectedId: "a1", annotations });
    expect(scrolledTo()).toBe(holding(doc, "s1"));
  });

  it("brings a passage that is only partly in view fully in", () => {
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    holding(doc, "s2").getBoundingClientRect = () => rectAt(doc.defaultView!.innerHeight - 10);
    rerender({ selectedId: "a2", annotations });
    expect(scrolledTo()).toBe(holding(doc, "s2"));
  });

  it("scrolls to the same thread again once it has been deselected in between", () => {
    const doc = prose();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    rerender({ selectedId: "a2", annotations });
    rerender({ selectedId: null, annotations });
    rerender({ selectedId: "a2", annotations });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("takes the reader to a resolved thread's passage, which is not drawn", () => {
    const doc = prose();
    const annotations = [...threads(), annotation("r1", "s2", "further down", { resolved: true })];
    const { rerender } = mount(doc, { selectedId: null, annotations });
    expect(doc.querySelector(`[${ANN_ATTR}="r1"]`)).toBeNull();

    rerender({ selectedId: "r1", annotations });
    expect(scrolledTo()?.textContent).toContain("further down");
    expect(doc.querySelector(`[${ANN_ATTR}="r1"]`)).toBeNull();
  });
});

describe("selecting a thread on a deck that stacks its slides", () => {
  /**
   * A deck that runs its own JavaScript: every slide in the same
   * viewport-sized box, one of them shown, and a keydown listener that moves
   * the showing, the way the deck's own script does. A passage on a hidden
   * slide still has a box inside the viewport, which is exactly what fooled
   * "is it in view" into doing nothing.
   */
  function stacked() {
    const doc = frameDoc(
      [1, 2, 3, 4]
        .map((n) => `<section class="slide" id="s${n}"><h2>Slide ${n}</h2><p>Words on slide number ${n}.</p></section>`)
        .join(""),
    );
    doc.defaultView!.Element.prototype.getBoundingClientRect = () => rectAt(120);
    const sections = Array.from(doc.querySelectorAll<HTMLElement>("section"));
    let at = 0;
    const show = (n: number) => {
      at = Math.max(0, Math.min(sections.length - 1, n));
      sections.forEach((el, i) => {
        el.style.visibility = i === at ? "visible" : "hidden";
      });
    };
    sections.forEach((el) => {
      el.getBoundingClientRect = () => ({ top: 0, bottom: 700, height: 700, left: 0, right: 1200, width: 1200, x: 0, y: 0, toJSON: () => ({}) });
    });
    show(0);
    doc.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") show(at + 1);
      else if (e.key === "ArrowLeft") show(at - 1);
      else return;
      e.preventDefault();
    });
    const showing = () => sections.findIndex((el) => el.style.visibility === "visible");
    return { doc, show, showing };
  }
  const threads = () => [
    annotation("on1", "s1", "slide number 1"),
    annotation("on3", "s3", "slide number 3"),
  ];

  it("shows the slide that holds the passage, through the deck's own keys, and scrolls nothing", () => {
    const { doc, showing } = stacked();
    const annotations = threads();
    const { rerender, result } = mount(doc, { selectedId: null, annotations });
    expect(result.current.paged).toBe(true);
    expect(showing()).toBe(0);

    rerender({ selectedId: "on3", annotations });
    expect(showing()).toBe(2);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("goes back to an earlier slide the same way", () => {
    const { doc, show, showing } = stacked();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    // The deck's own keys moved it, and the rail has not heard yet.
    show(3);
    rerender({ selectedId: "on1", annotations });
    expect(showing()).toBe(0);
  });

  it("leaves the deck where it is for a passage on the slide being shown", () => {
    const { doc, showing } = stacked();
    const annotations = threads();
    const { rerender } = mount(doc, { selectedId: null, annotations });
    rerender({ selectedId: "on1", annotations });
    expect(showing()).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("waits for the deck to measure this document before landing a thread selected as it opens", () => {
    // A link, or a comment posted before the frame reloaded, can select a
    // thread before the deck knows it has pages. Landing then would treat the
    // deck as prose and use the jump up on a scroll that shows nothing.
    const { doc, showing } = stacked();
    mount(doc, { selectedId: "on3", annotations: threads() });
    expect(showing()).toBe(2);
  });

  it("takes the reader to the slide of a resolved thread, without drawing it", () => {
    const { doc, showing } = stacked();
    const annotations = [...threads(), annotation("done", "s4", "slide number 4", { resolved: true })];
    const { rerender } = mount(doc, { selectedId: null, annotations });
    rerender({ selectedId: "done", annotations });
    expect(showing()).toBe(3);
    expect(doc.querySelector(`[${ANN_ATTR}="done"]`)).toBeNull();
  });
});

/** A peer's record as `watchPeers` gives it. */
function peer(extra: Partial<Peer>): Peer {
  return { uid: "lead", email: "lead@example.com", name: "Lead", mode: "view", lastChanged: 1, color: "#00769b", ...extra };
}

describe("following a peer", () => {
  function stackedDeck() {
    const doc = frameDoc(
      [1, 2, 3, 4].map((n) => `<section class="slide" id="s${n}"><h2>Slide ${n}</h2></section>`).join(""),
    );
    const sections = Array.from(doc.querySelectorAll<HTMLElement>("section"));
    let at = 0;
    const show = (n: number) => {
      at = Math.max(0, Math.min(sections.length - 1, n));
      sections.forEach((el, i) => (el.style.visibility = i === at ? "visible" : "hidden"));
    };
    doc.defaultView!.Element.prototype.getBoundingClientRect = () =>
      ({ top: 0, bottom: 700, height: 700, left: 0, right: 1200, width: 1200 }) as DOMRect;
    show(0);
    doc.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") show(at + 1);
      else if (e.key === "ArrowLeft") show(at - 1);
      else return;
      e.preventDefault();
    });
    return { doc, showing: () => sections.findIndex((el) => el.style.visibility === "visible") };
  }

  /** A document of three sections whose tops are stated, scrolled by `scrollTo`. */
  function prose() {
    const doc = frameDoc(`<h2 id="one">One</h2><p>…</p><h2 id="two">Two</h2><p>…</p><h2 id="three">Three</h2>`);
    const view = doc.defaultView!;
    let y = 0;
    Object.defineProperty(view, "scrollY", { get: () => y, configurable: true });
    Object.defineProperty(doc.documentElement, "scrollHeight", { value: 5000, configurable: true });
    const tops: Record<string, number> = { one: 0, two: 3000, three: 3600 };
    view.Element.prototype.getBoundingClientRect = function (this: Element) {
      const top = tops[this.id] ?? 0;
      return { top: top - y, bottom: top - y + 40, height: 40, width: 600, left: 0, right: 600 } as DOMRect;
    };
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      y = options.top ?? y;
    });
    view.scrollTo = scrollTo as unknown as typeof view.scrollTo;
    return { doc, scrollTo, where: () => y };
  }

  it("shows the leader's slide on a deck that stacks its slides, which no scroll could", () => {
    const { doc, showing } = stackedDeck();
    const { rerender } = mount(doc, { selectedId: null, annotations: [], follow: peer({ slide: 2, viewport: 0 }) });
    expect(showing()).toBe(2);
    rerender({ selectedId: null, annotations: [], follow: peer({ slide: 3, viewport: 0 }) });
    expect(showing()).toBe(3);
  });

  it("goes to the slide holding the leader's place when their record carries no slide", () => {
    // A leader whose own viewer did not page the deck shares a place in the
    // text, and no scroll moves a deck that stacks its slides.
    const { doc, showing } = stackedDeck();
    const onNotice = vi.fn();
    const { rerender } = mount(doc, { selectedId: null, annotations: [], follow: peer({ place: { a: "s3", at: 0 }, viewport: 0 }), onNotice });
    expect(showing()).toBe(2);
    // Before the first id, the place names only the one below it.
    rerender({ selectedId: null, annotations: [], follow: peer({ place: { b: "s4", at: 0.3 }, viewport: 0 }), onNotice });
    expect(showing()).toBe(3);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("says once that the leader's tab shares no slide, and leaves the deck where it is", () => {
    // A tab on an app from before slides were shared sends a fraction only,
    // which on a deck that stacks its slides is always the top.
    const { doc, showing } = stackedDeck();
    const onNotice = vi.fn();
    const { rerender } = mount(doc, { selectedId: null, annotations: [], follow: peer({ viewport: 0 }), onNotice });
    expect(showing()).toBe(0);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenLastCalledWith("follow-unshared");
    rerender({ selectedId: null, annotations: [], follow: peer({ viewport: 0.4, lastChanged: 2 }), onNotice });
    expect(onNotice).toHaveBeenCalledTimes(1);
    // Letting go and following again is a new follow, and is told again.
    rerender({ selectedId: null, annotations: [], follow: null, onNotice });
    rerender({ selectedId: null, annotations: [], follow: peer({ viewport: 0 }), onNotice });
    expect(onNotice).toHaveBeenCalledTimes(2);
  });

  it("takes a follower whose deck is not paged to the leader's slide, before their place", () => {
    // The same deck laid out taller than the screen, as on a short window
    // with scripts off: not paged here, while the leader's is.
    const doc = frameDoc(
      [1, 2, 3, 4].map((n) => `<section class="slide" id="s${n}"><h2>Slide ${n}</h2></section>`).join(""),
    );
    const tops: Record<string, number> = { s1: 0, s2: 2000, s3: 4000, s4: 6000 };
    doc.defaultView!.Element.prototype.getBoundingClientRect = function (this: Element) {
      const top = tops[this.id] ?? 0;
      return { top, bottom: top + 2000, height: 2000, width: 1200, left: 0, right: 1200 } as DOMRect;
    };
    doc.defaultView!.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    const onNotice = vi.fn();
    mount(doc, { selectedId: null, annotations: [], follow: peer({ slide: 2, place: { a: "s1", at: 0.9 }, viewport: 0.1 }), onNotice });
    expect(scrolledTo()).toBe(doc.getElementById("s3"));
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("does not count its own move as the reader's, which would let go of the follow", () => {
    const { doc, showing } = stackedDeck();
    const onReaderMove = vi.fn();
    mount(doc, { selectedId: null, annotations: [], follow: peer({ slide: 2 }), onReaderMove });
    expect(showing()).toBe(2);
    expect(onReaderMove).not.toHaveBeenCalled();
  });

  it("goes to the leader's place in the text, between the ids either side of the top of their screen", () => {
    const { doc, where } = prose();
    mount(doc, { selectedId: null, annotations: [], follow: peer({ place: { a: "two", b: "three", at: 0.5 }, viewport: 0.1 }) });
    expect(where()).toBe(3300);
  });

  it("falls back to the fraction when the place names an id this document lacks", () => {
    const { doc, where } = prose();
    mount(doc, { selectedId: null, annotations: [], follow: peer({ place: { a: "gone", at: 0.5 }, viewport: 0.5 }) });
    expect(where()).toBe((5000 - 700) * 0.5);
  });

  it("moves the reader only when where the leader is changes, not on every presence update", () => {
    // Another person's cursor moving rewrites the peer list. A follower who has
    // just scrolled away, before the release lands, must not be pulled back.
    const { doc, scrollTo } = prose();
    const place = { a: "two", b: "three", at: 0.5 };
    const { rerender } = mount(doc, { selectedId: null, annotations: [], follow: peer({ place, viewport: 0.1 }) });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    rerender({ selectedId: null, annotations: [], follow: peer({ place: { ...place }, viewport: 0.1, lastChanged: 2 }) });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    rerender({ selectedId: null, annotations: [], follow: peer({ place: { ...place, at: 0.75 }, viewport: 0.1 }) });
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it("shares this reader's slide on a paged deck, and none on a document without pages", () => {
    const deck = stackedDeck();
    const onDeck = vi.fn();
    mount(deck.doc, { selectedId: null, annotations: [], shareSlide: onDeck });
    expect(onDeck).toHaveBeenLastCalledWith(0);

    const onProse = vi.fn();
    mount(prose().doc, { selectedId: null, annotations: [], shareSlide: onProse });
    expect(onProse).toHaveBeenLastCalledWith(null);
    expect(onProse).not.toHaveBeenCalledWith(0);
  });
});

describe("arriving at a link", () => {
  /** A stacked deck of five: two with ids, one with an id inside it, two plain. */
  function deck() {
    const doc = frameDoc(
      `<section class="slide" id="cover"><h2>Cover</h2><p>Opening words.</p></section>
       <section class="slide" id="agenda"><h2>Agenda</h2><p>Words on the agenda.</p></section>
       <section class="slide"><h2>Plain</h2><p>Words on a plain slide.</p></section>
       <section class="slide"><h2>Inner</h2><p id="claim">The claim itself.</p></section>
       <section class="slide"><h2>Last</h2><p>Closing words.</p></section>`,
    );
    const sections = Array.from(doc.querySelectorAll<HTMLElement>("section"));
    let at = 0;
    const show = (n: number) => {
      at = Math.max(0, Math.min(sections.length - 1, n));
      sections.forEach((el, i) => (el.style.visibility = i === at ? "visible" : "hidden"));
    };
    doc.defaultView!.Element.prototype.getBoundingClientRect = () =>
      ({ top: 0, bottom: 700, height: 700, left: 0, right: 1200, width: 1200 }) as DOMRect;
    show(0);
    doc.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") show(at + 1);
      else if (e.key === "ArrowLeft") show(at - 1);
      else return;
      e.preventDefault();
    });
    return { doc, show, showing: () => sections.findIndex((el) => el.style.visibility === "visible") };
  }
  const ready: ThreadsState = { ready: true };
  const plainThread = () => [annotation("t3", "", "Words on a plain slide")];

  it("shows the slide a number names, without a history entry", () => {
    const { doc, showing } = deck();
    const length = window.history.length;
    mount(doc, { selectedId: null, annotations: [], hash: "#slide=3" });
    expect(showing()).toBe(2);
    expect(window.history.length).toBe(length);
  });

  it("shows the slide an id names, and the slide holding an element an id names, with that element at the top", () => {
    const first = deck();
    mount(first.doc, { selectedId: null, annotations: [], hash: "#agenda" });
    expect(first.showing()).toBe(1);
    expect(scrollIntoView).not.toHaveBeenCalled();

    const second = deck();
    mount(second.doc, { selectedId: null, annotations: [], hash: "#claim" });
    expect(second.showing()).toBe(3);
    expect(scrolledTo()?.id).toBe("claim");
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "start", behavior: "auto" });
  });

  it("puts a section of a document without pages at the top, at once", () => {
    const doc = frameDoc(`<section id="s1"><p>One.</p></section><section id="s2"><p>Two.</p></section>`);
    mount(doc, { selectedId: null, annotations: [], hash: "#s2" });
    expect(scrolledTo()?.id).toBe("s2");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
  });

  it("opens the deck as usual for a slide or an id it does not have", () => {
    const { doc, showing } = deck();
    const notice = vi.fn();
    mount(doc, { selectedId: null, annotations: [], hash: "#slide=9", onNotice: notice });
    expect(showing()).toBe(0);
    const other = deck();
    mount(other.doc, { selectedId: null, annotations: [], hash: "#nowhere", onNotice: notice });
    expect(other.showing()).toBe(0);
    expect(notice).not.toHaveBeenCalled();
  });

  it("opens a thread a link names once the threads have landed, and its slide follows from selecting it", () => {
    const { doc, showing } = deck();
    const onThread = vi.fn();
    const annotations = plainThread();
    const { rerender } = mount(doc, { selectedId: null, annotations: [], hash: "#comment=t3", threads: { ready: false }, onThread });
    expect(onThread).not.toHaveBeenCalled();
    rerender({ selectedId: null, annotations, hash: "#comment=t3", threads: ready, onThread });
    expect(onThread).toHaveBeenCalledWith("t3");
    rerender({ selectedId: "t3", annotations, hash: "#comment=t3", threads: ready, onThread });
    expect(showing()).toBe(2);
    expect(onThread).toHaveBeenCalledTimes(1);
  });

  it("says so when the thread is not on this version, and why when the reader cannot see threads", () => {
    const missing = vi.fn();
    mount(deck().doc, { selectedId: null, annotations: plainThread(), hash: "#comment=gone", threads: ready, onNotice: missing });
    expect(missing).toHaveBeenCalledWith("comment-missing");

    const refused = vi.fn();
    const onThread = vi.fn();
    mount(deck().doc, { selectedId: null, annotations: [], hash: "#comment=t3", threads: { ready: true, refused: "comment-sign-in" }, onNotice: refused, onThread });
    expect(refused).toHaveBeenCalledWith("comment-sign-in");
    expect(onThread).not.toHaveBeenCalled();
  });

  it("lands once: a redraw or new threads after it never pull back a reader who moved on", () => {
    const { doc, show, showing } = deck();
    const annotations = plainThread();
    const { rerender } = mount(doc, { selectedId: null, annotations, hash: "#slide=3", threads: ready });
    expect(showing()).toBe(2);
    show(0);
    rerender({ selectedId: null, annotations: [...annotations], hash: "#slide=3", threads: { ...ready } });
    expect(showing()).toBe(0);
  });

  it("lands again when the router moves to another address in the same document", () => {
    const { doc, showing } = deck();
    const { rerender } = mount(doc, { selectedId: null, annotations: [], hash: "#slide=2" });
    expect(showing()).toBe(1);
    rerender({ selectedId: null, annotations: [], hash: "#slide=5" });
    expect(showing()).toBe(4);
  });
});

describe("the address on a paged deck", () => {
  function deck(withIds = true) {
    const doc = frameDoc(
      [1, 2, 3, 4].map((n) => `<section class="slide"${withIds && n !== 3 ? ` id="s${n}"` : ""}><h2>Slide ${n}</h2><p>Words on slide number ${n}.</p></section>`).join(""),
    );
    const sections = Array.from(doc.querySelectorAll<HTMLElement>("section"));
    let at = 0;
    const show = (n: number) => {
      at = Math.max(0, Math.min(sections.length - 1, n));
      sections.forEach((el, i) => (el.style.visibility = i === at ? "visible" : "hidden"));
    };
    doc.defaultView!.Element.prototype.getBoundingClientRect = () =>
      ({ top: 0, bottom: 700, height: 700, left: 0, right: 1200, width: 1200 }) as DOMRect;
    show(0);
    doc.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") show(at + 1);
      else if (e.key === "ArrowLeft") show(at - 1);
      else return;
      e.preventDefault();
    });
    return { doc, show, showing: () => sections.findIndex((el) => el.style.visibility === "visible") };
  }

  it("follows the slide by replacing the address, keeping the router's state, by the slide's id or else its number", () => {
    window.history.replaceState({ usr: null, key: "k7", idx: 3 }, "", "/d/deck?k=key");
    const length = window.history.length;
    const { doc } = deck();
    const { result } = mount(doc, { selectedId: null, annotations: [] });
    expect(window.location.hash).toBe("");
    act(() => result.current.goTo(1));
    expect(window.location.hash).toBe("#s2");
    act(() => result.current.goTo(2));
    expect(window.location.hash).toBe("#slide=3");
    expect(window.location.pathname + window.location.search).toBe("/d/deck?k=key");
    expect(window.history.state).toEqual({ usr: null, key: "k7", idx: 3 });
    expect(window.history.length).toBe(length);
  });

  it("keeps a link's own target while it names the slide on screen, and follows once the reader moves on", () => {
    window.history.replaceState(null, "", "/d/deck/v2#comment=t2");
    const { doc, showing } = deck();
    const annotations = [annotation("t2", "s2", "slide number 2")];
    const onThread = vi.fn();
    const { result, rerender } = mount(doc, { selectedId: null, annotations, hash: "#comment=t2", threads: { ready: true }, onThread });
    rerender({ selectedId: "t2", annotations, hash: "#comment=t2", threads: { ready: true }, onThread });
    expect(showing()).toBe(1);
    expect(window.location.hash).toBe("#comment=t2");
    act(() => result.current.goTo(3));
    expect(window.location.hash).toBe("#s4");
  });

  it("never touches the address of a document without pages", () => {
    window.history.replaceState(null, "", "/d/plan#s2");
    const doc = frameDoc(`<section id="s1"><p>One.</p></section><section id="s2"><p>Two.</p></section>`);
    doc.defaultView!.Element.prototype.getBoundingClientRect = () => rectAt(100);
    mount(doc, { selectedId: null, annotations: [], hash: "#s2" });
    expect(window.location.hash).toBe("#s2");
  });

  it("returns a deck whose frame loaded again to the slide in the address", () => {
    const first = deck();
    const { result, rerender } = mount(first.doc, { selectedId: null, annotations: [] });
    act(() => result.current.goTo(2));
    expect(window.location.hash).toBe("#slide=3");

    // A peer's draft reloads the frame: a new document, on its first slide.
    const again = deck();
    rerender({ selectedId: null, annotations: [], doc: again.doc, epoch: 2 });
    expect(again.showing()).toBe(2);
    expect(window.location.hash).toBe("#slide=3");
  });
});
