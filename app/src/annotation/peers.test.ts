// SPDX-License-Identifier: Apache-2.0
// A follower lands in the same words on a screen of another width: the reading place between two ids (SPEC §16).

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { readingPlace, scrollFraction, scrollToFraction, scrollToPlace } from "./peers";

/**
 * jsdom lays nothing out, so each layout is STATED: where every element with
 * an id starts in the document, how tall the document is, and how far the
 * window has scrolled. A rect is then that start minus the scroll, as a
 * browser reports it. What is asserted is where `scrollTo` was asked to go.
 */
interface Layout {
  /** Document top of each id, in px. */
  tops: Record<string, number>;
  height: number;
  viewport: number;
}

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
});

function page(body: string, layout: Layout) {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  frames.push(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html><body>${body}</body></html>`);
  doc.close();
  const view = doc.defaultView!;
  let y = 0;
  Object.defineProperty(view, "scrollY", { get: () => y, configurable: true });
  Object.defineProperty(view, "innerHeight", { value: layout.viewport, configurable: true });
  Object.defineProperty(doc.documentElement, "scrollHeight", { value: layout.height, configurable: true });
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    y = options.top ?? y;
  });
  view.scrollTo = scrollTo as unknown as typeof view.scrollTo;
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[id]"))) {
    const top = layout.tops[el.id];
    el.getBoundingClientRect = () =>
      (top === undefined
        ? { top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0 }
        : { top: top - y, bottom: top - y + 40, height: 40, width: 600, left: 0, right: 600 }) as DOMRect;
  }
  return { doc, scrollTo, at: (to: number) => (y = to), where: () => y };
}

const BODY = `<h2 id="one">One</h2><p>…</p><h2 id="two">Two</h2><p>…</p><h2 id="three">Three</h2><p>…</p><h2 id="four">Four</h2><p>…</p>`;

/** A laptop: four sections of a thousand pixels. */
const WIDE: Layout = { tops: { one: 200, two: 1000, three: 2000, four: 3000 }, height: 4000, viewport: 800 };
/**
 * A phone: the same text, but the first section's wide table wraps into three
 * thousand pixels and the rest barely grow. The page is not a scaled copy, so
 * a fraction of it is somewhere else.
 */
const NARROW: Layout = { tops: { one: 200, two: 3000, three: 3600, four: 4200 }, height: 5000, viewport: 800 };

describe("readingPlace", () => {
  it("names the ids either side of the top of the screen and how far between them it is", () => {
    const leader = page(BODY, WIDE);
    leader.at(1500);
    expect(readingPlace(leader.doc)).toEqual({ a: "two", b: "three", at: 0.5 });
  });

  it("counts a heading scrolled exactly to the top as above it", () => {
    const leader = page(BODY, WIDE);
    leader.at(1000);
    expect(readingPlace(leader.doc)).toEqual({ a: "two", b: "three", at: 0 });
  });

  it("uses the start of the document before the first id, and its end after the last", () => {
    const leader = page(BODY, WIDE);
    leader.at(100);
    expect(readingPlace(leader.doc)).toEqual({ b: "one", at: 0.5 });
    leader.at(3200);
    expect(readingPlace(leader.doc)).toEqual({ a: "four", at: 1 });
  });

  it("leaves out what a follower could not find by it, or whose top moves with the scroll", () => {
    const body = `<h2 id="one">One</h2>
      <nav style="position: sticky"><a id="toc-two">Two</a></nav>
      <header id="bar" style="position: fixed">Bar</header>
      <div data-bshd="peers"><span id="caret">ours</span></div>
      <p id="empty"></p>
      <h2 id="two">Two</h2><h2 id="two">Two again</h2>`;
    const leader = page(body, {
      tops: { one: 0, "toc-two": 1600, bar: 1505, caret: 1550, two: 2000 },
      height: 4000,
      viewport: 800,
    });
    leader.at(1500);
    expect(readingPlace(leader.doc)).toEqual({ a: "one", b: "two", at: 0.75 });
  });

  it("on a deck that stacks its slides, names the slide on screen rather than the last one", () => {
    // Every slide shares one box, and a hidden one still has it: by geometry
    // alone the last slide's ids are the ones "at the top of the screen".
    const ids = ["s1", "s2", "s3", "s4"];
    const tops = Object.fromEntries(ids.flatMap((id) => [[id, 0], [`h-${id}`, 40]]));
    for (const hide of ["visibility: hidden", "opacity: 0"]) {
      const body = ids
        .map((id) => `<section id="${id}" style="${id === "s3" ? "" : hide}"><h2 id="h-${id}">Slide</h2></section>`)
        .join("");
      const leader = page(body, { tops, height: 800, viewport: 800 });
      expect(readingPlace(leader.doc), hide).toEqual({ a: "s3", b: "h-s3", at: 0 });
    }
  });

  it("is null for a document with no ids, which leaves the fraction", () => {
    const leader = page(`<h2>One</h2><p>Words.</p>`, { tops: {}, height: 4000, viewport: 800 });
    leader.at(900);
    expect(readingPlace(leader.doc)).toBeNull();
  });
});

describe("following on a screen of another width", () => {
  it("lands in the same stretch of words, where the fraction lands in another section", () => {
    const leader = page(BODY, WIDE);
    leader.at(1500);
    const follower = page(BODY, NARROW);

    expect(scrollToPlace(follower.doc, readingPlace(leader.doc)!)).toBe(true);
    expect(follower.where()).toBe(3300);
    expect(follower.where()).toBeGreaterThanOrEqual(NARROW.tops.two);
    expect(follower.where()).toBeLessThan(NARROW.tops.three);

    // What following did before: the fraction, which puts a phone in section one.
    scrollToFraction(follower.doc, scrollFraction(leader.doc));
    expect(follower.where()).toBeLessThan(NARROW.tops.two);
  });

  it("refuses, scrolling nothing, when an id it names is not in this document", () => {
    const follower = page(BODY, NARROW);
    follower.at(400);
    expect(scrollToPlace(follower.doc, { a: "gone", b: "three", at: 0.5 })).toBe(false);
    expect(follower.scrollTo).not.toHaveBeenCalled();
  });

  it("never scrolls past either end", () => {
    // The last heading sits lower than the window can scroll to.
    const follower = page(BODY, { ...NARROW, tops: { ...NARROW.tops, four: 4800 } });
    expect(scrollToPlace(follower.doc, { a: "four", at: 0.5 })).toBe(true);
    expect(follower.where()).toBe(NARROW.height - NARROW.viewport);
    expect(scrollToPlace(follower.doc, { b: "one", at: 0 })).toBe(true);
    expect(follower.where()).toBe(0);
  });
});

describe("a peer's selection on a deck that stacks its slides", () => {
  /**
   * Four slides in one box, one shown, as a stacked deck lays them out. jsdom
   * computes the inline `visibility` and `opacity` the slides are hidden with;
   * it lays nothing out, so every passage gets one stated rect — the same one,
   * which is exactly what a stacked deck gives a browser too.
   */
  function deck(hide = "visibility: hidden") {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    frames.push(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(
      `<!doctype html><html><body>${["s1", "s2", "s3", "s4"]
        .map((id) => `<section id="${id}" style="${id === "s1" ? "" : hide}"><p id="p-${id}">Words on ${id}</p></section>`)
        .join("")}</body></html>`,
    );
    doc.close();
    const view = doc.defaultView!;
    const proto = view.Range.prototype as unknown as { getClientRects?: () => DOMRect[] };
    proto.getClientRects = () => [new DOMRect(10, 10, 40, 16)];
    // Frames run when the test says so, and are counted.
    const queue: FrameRequestCallback[] = [];
    const requested = vi.fn((cb: FrameRequestCallback) => queue.push(cb));
    view.requestAnimationFrame = requested as unknown as typeof view.requestAnimationFrame;
    view.cancelAnimationFrame = () => {};
    const flush = async () => {
      // A MutationObserver reports in a microtask; the frame it asks for runs here.
      await Promise.resolve();
      for (const cb of queue.splice(0)) cb(0);
    };
    const show = (id: string) => {
      for (const el of Array.from(doc.querySelectorAll("section"))) el.setAttribute("style", el.id === id ? "" : hide);
    };
    const carets = () => doc.querySelectorAll(".bshd-peer-caret").length;
    return { doc, flush, show, carets, requested };
  }

  const on = (id: string) => ({
    uid: "u1", email: "dana.kim@example.com", name: "Dana K", mode: "view" as const, lastChanged: 0, color: "#7c3aed",
    focus: { elementId: `p-${id}`, exact: "Words", prefix: "", suffix: ` on ${id}`, start: 0, end: 5 },
  });

  it("draws it only on the slide it is on, never over the slide shown", async () => {
    for (const hide of ["visibility: hidden", "opacity: 0"]) {
      const { doc, flush, carets } = deck(hide);
      const { createPeerOverlay } = await import("./peers");
      const overlay = createPeerOverlay(doc);
      overlay.render([on("s3")]);
      await flush();
      expect(carets(), `${hide}: a selection on a hidden slide`).toBe(0);
      overlay.render([on("s1")]);
      await flush();
      expect(carets(), `${hide}: a selection on the slide shown`).toBe(1);
      overlay.destroy();
    }
  });

  it("shows and hides it as the deck changes slide, with nothing else changing", async () => {
    const { doc, flush, show, carets } = deck();
    const { createPeerOverlay } = await import("./peers");
    const overlay = createPeerOverlay(doc);
    overlay.render([on("s3")]);
    await flush();
    expect(carets()).toBe(0);
    // The deck moves by changing an attribute: no scroll, no resize, no presence update.
    show("s3");
    await flush();
    expect(carets()).toBe(1);
    show("s2");
    await flush();
    expect(carets()).toBe(0);
    overlay.destroy();
  });

  it("does not schedule itself again by drawing", async () => {
    const { doc, flush, carets, requested } = deck();
    const { createPeerOverlay } = await import("./peers");
    const overlay = createPeerOverlay(doc);
    overlay.render([on("s1")]);
    await flush();
    expect(carets()).toBe(1);
    const asked = requested.mock.calls.length;
    await flush();
    await flush();
    expect(requested.mock.calls.length).toBe(asked);
    overlay.destroy();
    // Destroyed, it hears the deck no more.
    doc.getElementById("s2")!.setAttribute("style", "");
    await flush();
    expect(requested.mock.calls.length).toBe(asked);
  });
});

describe("a peer's caret label", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is their short name, as the presence bar draws it, never the whole name or the address", async () => {
    const { createPeerOverlay } = await import("./peers");
    const doc = document.implementation.createHTMLDocument("peers");
    doc.body.innerHTML = '<p id="p1">Hello there, world</p>';
    // jsdom lays nothing out: one rect where a browser would draw the selection.
    const proto = Range.prototype as unknown as { getClientRects?: () => DOMRect[] };
    const had = proto.getClientRects;
    proto.getClientRects = () => [new DOMRect(10, 10, 40, 16)];
    onTestFinished(() => {
      proto.getClientRects = had;
    });
    Object.defineProperty(doc, "defaultView", { value: { scrollX: 0, scrollY: 0, requestAnimationFrame: (cb: FrameRequestCallback) => (cb(0), 1), cancelAnimationFrame: () => {} } });
    const overlay = createPeerOverlay(doc);
    const focus = { elementId: "p1", exact: "there", prefix: "Hello ", suffix: ", world", start: 6, end: 11 };
    const base = { mode: "view" as const, lastChanged: 0, color: "#7c3aed", focus };
    overlay.render([
      { ...base, uid: "u1", email: "dana.kim@example.com", name: "Dana Kimberly-Smith" },
      { ...base, uid: "u2", email: "bo.chen@example.com", name: "bo.chen@example.com" },
    ]);
    const labels = [...doc.querySelectorAll(".bshd-peer-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Dana K", "Bo C"]);
    overlay.destroy();
  });
});
