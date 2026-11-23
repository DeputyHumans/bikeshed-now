// SPDX-License-Identifier: Apache-2.0
// The export stamp has to be unsuppressable, and this is what proves it (SPEC §20).

import { describe, expect, it, vi } from "vitest";
import {
  LOCKED_PROPERTIES,
  PRINT_CEILING_MS,
  PRINT_SLOW_MS,
  activatePrintMarks,
  buildPrintHtml,
  incompletePrintMessage,
  printDoc,
  scrubActiveContent,
  waitForPrintAssets,
} from "./pdf";
import { PRINT_FOOTER_CLASS, PRINT_MARK_CLASS } from "../brand/dom";
import type { Marking } from "../types";

const MARKING: Marking = {
  enabled: true,
  label: "CONFIDENTIAL",
  footer: "© {year} · {title} · {version}",
};

function makeDoc(body: string, head = ""): Document {
  return new DOMParser().parseFromString(
    `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`,
    "text/html",
  );
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * Properties jsdom's CSSOM cannot represent.
 *
 * `zoom` is non-standard, so jsdom drops it — but it is a REAL hiding vector in
 * Blink and WebKit, where `zoom: 0` makes an element vanish. Dropping it from
 * the lock table to make a test pass would trade a real defence for a green
 * tick, so instead the gap is named here. If this list ever grows silently, the
 * assertion below fails and somebody has to look.
 */
const UNREPRESENTABLE_IN_JSDOM = ["zoom"];

describe("jsdom coverage", () => {
  it("names exactly the locked properties this environment cannot check", () => {
    const el = document.createElement("div");
    const dropped = LOCKED_PROPERTIES.filter((property) => {
      el.style.setProperty(property, "1", "important");
      return el.style.getPropertyPriority(property) !== "important";
    });
    expect(dropped).toEqual(UNREPRESENTABLE_IN_JSDOM);
  });
});

describe("the export stamp", () => {
  it("sets EVERY locked property with !important", () => {
    /**
     * This is the assertion that makes the "hostile CSS cannot hide it" claim
     * true rather than merely stated, and it is the one most likely to rot: a
     * property dropped from the lock table would never fail anything else.
     *
     * An important declaration in an element's style attribute outranks any
     * selector-based author !important rule, because the style attribute has
     * the highest specificity there is — and the print frame is sandboxed
     * without allow-scripts, so a document has no JavaScript with which to add
     * inline styles of its own.
     */
    const out = parse(buildPrintHtml(makeDoc("<p>x</p>"), { marking: MARKING }));
    for (const className of [PRINT_MARK_CLASS, PRINT_FOOTER_CLASS]) {
      const el = out.querySelector(`.${className}`) as HTMLElement;
      expect(el, className).not.toBeNull();
      for (const property of LOCKED_PROPERTIES) {
        if (UNREPRESENTABLE_IN_JSDOM.includes(property)) continue;
        expect(
          el.style.getPropertyPriority(property),
          `${className}.${property} must be !important`,
        ).toBe("important");
      }
    }
  });

  it("locks both box-hiding AND text-hiding vectors", () => {
    // The second class is the one people forget: a box that is visible but
    // whose text is not is just as hidden.
    for (const boxVector of ["display", "visibility", "opacity", "transform", "clip-path"]) {
      expect(LOCKED_PROPERTIES).toContain(boxVector);
    }
    for (const textVector of [
      "-webkit-text-fill-color",
      "-webkit-text-stroke",
      "text-indent",
      "text-shadow",
      "letter-spacing",
      "word-spacing",
      "white-space",
      "text-transform",
    ]) {
      expect(LOCKED_PROPERTIES).toContain(textVector);
    }
  });

  it("locks independent transforms, masks, blending and motion paths to their visible values", () => {
    const out = parse(buildPrintHtml(makeDoc("<p>x</p>"), { marking: MARKING }));
    const expected = { rotate: "none", scale: "1", translate: "none", "offset-path": "none", "mask-image": "none", "mix-blend-mode": "normal" };
    for (const className of [PRINT_MARK_CLASS, PRINT_FOOTER_CLASS]) {
      const el = out.querySelector(`.${className}`) as HTMLElement;
      for (const [property, value] of Object.entries(expected)) {
        expect(el.style.getPropertyValue(property), `${className}.${property}`).toBe(value);
        expect(el.style.getPropertyPriority(property), `${className}.${property}`).toBe("important");
      }
    }
  });

  it("repeats on every page, and sits above everything", () => {
    const out = parse(buildPrintHtml(makeDoc("<p>x</p>"), { marking: MARKING }));
    for (const className of [PRINT_MARK_CLASS, PRINT_FOOTER_CLASS]) {
      const el = out.querySelector(`.${className}`) as HTMLElement;
      expect(el.style.getPropertyValue("position")).toBe("fixed");
      expect(Number(el.style.getPropertyValue("z-index"))).toBeGreaterThan(2000000000);
    }
  });

  it("writes the text as textContent, never as markup", () => {
    const hostile: Marking = {
      enabled: true,
      label: "<img src=x onerror=alert(1)>",
      footer: "</div><script>alert(2)</script>",
    };
    const out = parse(buildPrintHtml(makeDoc("<p>x</p>"), { marking: hostile }));
    const el = out.querySelector(`.${PRINT_MARK_CLASS}`) as HTMLElement;
    expect(el.textContent).toBe(hostile.label);
    expect(el.querySelector("img")).toBeNull();
    expect(out.querySelectorAll("script")).toHaveLength(0);
  });

  it("resolves {year} at export time, not at publish time", () => {
    // The design this replaces hardcoded the year, which silently went stale.
    const out = buildPrintHtml(makeDoc("<p>x</p>"), {
      marking: MARKING,
      title: "Memo",
      version: "v3",
    });
    expect(out).toContain(String(new Date().getFullYear()));
    expect(out).toContain("Memo");
    expect(out).toContain("v3");
    expect(out).not.toContain("{year}");
  });

  it("omits the stamp nodes entirely when marking is off", () => {
    const out = parse(buildPrintHtml(makeDoc("<p>x</p>")));
    expect(out.querySelector(`.${PRINT_MARK_CLASS}`)).toBeNull();
    expect(out.querySelector(`.${PRINT_FOOTER_CLASS}`)).toBeNull();
  });
});

describe("inerting the snapshot", () => {
  it("removes scripts even when marking is disabled", () => {
    // Every hardening property is unconditional. Only the stamp depends on
    // whether somebody turned marking on.
    const out = buildPrintHtml(makeDoc("<p>x</p><script>alert(1)</script>"));
    expect(out).not.toContain("alert(1)");
  });

  it("removes inline event handlers", () => {
    const doc = makeDoc('<p onclick="alert(1)" onmouseover="alert(2)">x</p>');
    scrubActiveContent(doc);
    const p = doc.querySelector("p")!;
    expect(p.getAttribute("onclick")).toBeNull();
    expect(p.getAttribute("onmouseover")).toBeNull();
  });

  it("removes javascript: URLs, including the ones a naive check misses", () => {
    const cases = [
      "javascript:alert(1)",
      "  JaVaScRiPt:alert(1)",
      "\tjavascript:alert(1)",
      "java\nscript:alert(1)",
    ];
    for (const href of cases) {
      const doc = makeDoc(`<a href="${href}">x</a>`);
      scrubActiveContent(doc);
      expect(doc.querySelector("a")?.getAttribute("href"), href).toBeNull();
    }
  });

  it("leaves ordinary links and images alone", () => {
    const doc = makeDoc('<a href="https://example.com">x</a><img src="/a.png">');
    scrubActiveContent(doc);
    expect(doc.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("/a.png");
  });

  it("adds a base href so relative assets still resolve", () => {
    const out = parse(
      buildPrintHtml(makeDoc('<img src="a.png">'), { baseHref: "/content/d/v1/" }),
    );
    expect(out.querySelector("base")?.getAttribute("href")).toContain("/content/d/v1/");
  });
});

describe("page geometry", () => {
  // `@page` cascades by order, so a rule of ours appended after the document's
  // styles beat every `@page` the document declared: a deck sized
  // `200mm 120mm; margin: 0` printed each slide across two pages. And once any
  // CSS sets a page margin, Chrome ignores the margin the person chose in the
  // print dialog. The document's own page, or the dialog, decides — never us.
  it("leaves a document's own @page as the only one", () => {
    const out = buildPrintHtml(
      makeDoc("<section>One</section>", "<style>@page { size: 200mm 120mm; margin: 0; }</style>"),
      { marking: MARKING },
    );
    expect(out.match(/@page/g)).toHaveLength(1);
    expect(out).toContain("margin: 0");
  });

  it("adds no @page to a document that declares none", () => {
    const out = buildPrintHtml(makeDoc("<p>x</p>"), { marking: MARKING });
    expect(out).not.toContain("@page");
  });

  it("puts the stamp before the content, so it opens no page of its own", () => {
    // A deck ends its last slide with `page-break-after: always`. Anything
    // after it in the DOM — a fixed box included — makes the browser open a
    // page for it: an eight-slide deck printed nine pages, the last carrying
    // nothing but the stamp. Fixed positioning does not care where in the
    // body the box sits, so it goes first.
    const out = parse(
      buildPrintHtml(makeDoc('<section style="page-break-after: always">last</section>'), {
        marking: MARKING,
      }),
    );
    const children = Array.from(out.body.children);
    expect(children[0].className).toBe(PRINT_MARK_CLASS);
    expect(children[1].className).toBe(PRINT_FOOTER_CLASS);
    expect(children.at(-1)?.tagName).toBe("SECTION");
  });
});


describe("ancestor-independent print marks", () => {
  it("promotes each generated stamp to the top layer without changing authored ancestors", () => {
    const out = parse(buildPrintHtml(makeDoc('<main style="transform:translateY(4px)">authored</main>', '<style>body{transform:translateZ(0)}</style>'), { marking: MARKING }));
    const authored = out.querySelector("main")!.outerHTML;
    const called: string[] = [];
    for (const el of out.querySelectorAll<HTMLElement>(`.${PRINT_MARK_CLASS}, .${PRINT_FOOTER_CLASS}`)) {
      expect(el.getAttribute("popover")).toBe("manual");
      Object.defineProperty(el, "showPopover", { value: () => called.push(el.className) });
    }
    activatePrintMarks(out);
    expect(called).toEqual([PRINT_MARK_CLASS, PRINT_FOOTER_CLASS]);
    expect(out.querySelector("main")!.outerHTML).toBe(authored);
    expect(out.querySelector("style")!.textContent).toBe("body{transform:translateZ(0)}");
  });

  it("refuses a marked print when top-layer isolation is unavailable, while unmarked prints need none", () => {
    const marked = parse(buildPrintHtml(makeDoc("<p>x</p>"), { marking: MARKING }));
    for (const el of marked.querySelectorAll(`.${PRINT_MARK_CLASS}, .${PRINT_FOOTER_CLASS}`)) Object.defineProperty(el, "showPopover", { value: undefined });
    expect(() => activatePrintMarks(marked)).toThrow("cannot safely print export markings");
    expect(() => activatePrintMarks(parse(buildPrintHtml(makeDoc("<p>x</p>"))))).not.toThrow();
  });

  it("keeps the authored page geometry and strips live decoration before stamping", () => {
    const out = parse(buildPrintHtml(makeDoc('<p>A <mark class="bshd-hl" data-bshd-ann="thread">passage</mark></p>', '<style>@page { size: 200mm 120mm; margin: 9mm }</style>'), { marking: MARKING }));
    expect(out.querySelectorAll("style")).toHaveLength(1);
    expect(out.querySelector("style")!.textContent).toBe("@page { size: 200mm 120mm; margin: 9mm }");
    expect(out.querySelector("p")!.innerHTML).toBe("A passage");
  });
});

/**
 * A print frame's document whose loading the test decides: its readyState,
 * its fonts' status and each picture's `complete`, as a browser reports them
 * while the frame is still fetching the files beside the page.
 */
function loadingDoc(pictures: number) {
  const doc = makeDoc(Array.from({ length: pictures }, (_, i) => `<img src="p${i}.svg">`).join(""));
  const state = { ready: "loading" as DocumentReadyState, fonts: "loading" as FontFaceSetLoadStatus, complete: new Array<boolean>(pictures).fill(false) };
  Object.defineProperty(doc, "readyState", { get: () => state.ready });
  Object.defineProperty(doc, "fonts", { value: { get status() { return state.fonts; } } });
  doc.querySelectorAll("img").forEach((img, i) => Object.defineProperty(img, "complete", { get: () => state.complete[i] }));
  return { doc, state };
}

/** Whether a promise has settled, without waiting for it. */
function tracked<T>(p: Promise<T>) {
  const t = { done: false, value: undefined as T | undefined };
  void p.then((v) => {
    t.done = true;
    t.value = v;
  });
  return t;
}

describe("waiting for the snapshot's files", () => {
  // The files beside a page are fetched again by the print frame, and a
  // member's SVGs are never cached (SPEC §17), so on production 223 of them
  // had none loaded at the 250 ms the export used to wait. print() must see
  // the document only once the browser says it has everything.
  // Each condition alone, the other two met: a single walk through all three
  // let any one of them be dropped while a later one still held the wait.
  const ALONE: Array<[string, (state: ReturnType<typeof loadingDoc>["state"]) => void]> = [
    ["the document, before its load event", (st) => (st.ready = "loading")],
    ["one picture", (st) => (st.complete = [true, false])],
    ["a font", (st) => (st.fonts = "loading")],
  ];
  for (const [what, hold] of ALONE) {
    it(`waits while ${what} is still loading, and not after`, async () => {
      vi.useFakeTimers();
      const { doc, state } = loadingDoc(2);
      state.ready = "complete";
      state.fonts = "loaded";
      state.complete = [true, true];
      hold(state);
      const wait = tracked(waitForPrintAssets(doc));
      await vi.advanceTimersByTimeAsync(5000);
      expect(wait.done, what).toBe(false);

      state.ready = "complete";
      state.fonts = "loaded";
      state.complete = [true, true];
      await vi.advanceTimersByTimeAsync(100);
      expect(wait.done).toBe(true);
      expect(wait.value).toEqual({ settled: true, images: 0, other: false });
    });
  }

  it("never answers in the task that wrote the frame, even when there is nothing to fetch", async () => {
    // A print() in the same task as the frame's insertion is one nothing can
    // observe (e2e/lib/browser.mjs, capturePrint), and the one the old fixed
    // wait never made.
    vi.useFakeTimers();
    const { doc, state } = loadingDoc(0);
    state.ready = "complete";
    state.fonts = "loaded";
    const wait = tracked(waitForPrintAssets(doc));
    await Promise.resolve();
    expect(wait.done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(wait.done).toBe(true);
  });

  it("gives up at the ceiling and says how many pictures had not loaded", async () => {
    vi.useFakeTimers();
    const { doc, state } = loadingDoc(3);
    state.ready = "complete";
    state.fonts = "loaded";
    state.complete = [true, false, true];
    const wait = tracked(waitForPrintAssets(doc));
    await vi.advanceTimersByTimeAsync(PRINT_CEILING_MS - 100);
    expect(wait.done, "before the ceiling").toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(wait.done, "at the ceiling").toBe(true);
    expect(wait.value).toEqual({ settled: false, images: 1, other: false });
  });

  it("names a stylesheet or a font still loading at the ceiling as other files", async () => {
    vi.useFakeTimers();
    const { doc, state } = loadingDoc(1);
    state.complete = [true];
    state.fonts = "loaded";
    const wait = tracked(waitForPrintAssets(doc));
    await vi.advanceTimersByTimeAsync(PRINT_CEILING_MS + 100);
    expect(wait.value).toEqual({ settled: false, images: 0, other: true });
  });

  it("says what may be missing from the PDF, in words", () => {
    const seconds = PRINT_CEILING_MS / 1000;
    expect(incompletePrintMessage({ images: 1, other: false })).toBe(`1 picture hadn't loaded after ${seconds} seconds, so the PDF may be missing it.`);
    expect(incompletePrintMessage({ images: 3, other: true })).toBe(`3 pictures hadn't loaded after ${seconds} seconds, so the PDF may be missing them.`);
    expect(incompletePrintMessage({ images: 0, other: true })).toBe(`Some of this document's files hadn't loaded after ${seconds} seconds, so the PDF may be missing them.`);
  });
});

describe("lazy pictures in the snapshot", () => {
  it("fetches every picture and frame at once, since the print frame has no viewport to scroll them into", () => {
    // The frame is 0×0 and hidden: a lazy picture below the fold would never
    // be fetched, and the wait would run to its ceiling for it.
    const out = parse(
      buildPrintHtml(
        makeDoc('<img src="a.svg" loading="lazy" alt="a"><img src="b.png" loading=" LAZY "><iframe src="c.html" loading="lazy"></iframe><img src="d.png">'),
      ),
    );
    expect(out.querySelectorAll('[loading="lazy" i]')).toHaveLength(0);
    expect(Array.from(out.querySelectorAll("img, iframe"), (el) => el.getAttribute("loading"))).toEqual(["eager", "eager", "eager", null]);
    expect(out.querySelector("img")?.getAttribute("alt")).toBe("a");
    expect(out.querySelector("img")?.getAttribute("src")).toBe("a.svg");
  });
});

describe("one print at a time", () => {
  /**
   * Each print frame printDoc appends, with print() recorded and its pictures'
   * `complete` answered by `complete()`. The frame is a realm of its own, so
   * its pictures are stubbed on ITS HTMLImageElement, not on this window's.
   */
  function armFrames(complete: () => boolean) {
    const printed: HTMLIFrameElement[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (!(node instanceof HTMLIFrameElement)) continue;
          const win = node.contentWindow as Window & typeof globalThis;
          Object.defineProperty(win, "print", { value: () => printed.push(node), configurable: true });
          Object.defineProperty(win, "focus", { value: () => undefined, configurable: true });
          Object.defineProperty(win.HTMLImageElement.prototype, "complete", { get: complete, configurable: true });
        }
      }
    });
    observer.observe(document.body, { childList: true });
    return { printed, frames: () => document.querySelectorAll("iframe[sandbox]").length, stop: () => observer.disconnect() };
  }

  it("ignores a second press while the first is being prepared, and prints again after", async () => {
    vi.useFakeTimers();
    let complete = false;
    const arm = armFrames(() => complete);
    const source = makeDoc('<p>x</p><img src="slow.svg">');
    try {
      const first = printDoc(source);
      const second = printDoc(source);
      await vi.advanceTimersByTimeAsync(PRINT_SLOW_MS);
      expect(await second, "the press made while preparing").toBe(false);
      expect(arm.frames()).toBe(1);
      expect(arm.printed).toHaveLength(0);

      complete = true;
      await vi.advanceTimersByTimeAsync(200);
      expect(await first).toBe(true);
      expect(arm.printed).toHaveLength(1);

      const third = printDoc(source);
      await vi.advanceTimersByTimeAsync(200);
      expect(await third, "a press after the first printed").toBe(true);
      expect(arm.printed).toHaveLength(2);
    } finally {
      arm.stop();
      await vi.advanceTimersByTimeAsync(2000);
    }
  });

  it("says it is preparing only once the wait passes a second, for exactly as long as it lasts", async () => {
    vi.useFakeTimers();
    let complete = false;
    const arm = armFrames(() => complete);
    const slow: Promise<void>[] = [];
    try {
      const done = tracked(printDoc(makeDoc('<img src="slow.svg">'), { onSlow: (ready) => slow.push(ready) }));
      await vi.advanceTimersByTimeAsync(PRINT_SLOW_MS - 100);
      expect(slow, "before a second").toHaveLength(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(slow).toHaveLength(1);
      const ready = tracked(slow[0]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ready.done, "still loading").toBe(false);
      complete = true;
      await vi.advanceTimersByTimeAsync(200);
      expect(ready.done).toBe(true);
      expect(done.done).toBe(true);
      expect(arm.printed).toHaveLength(1);
    } finally {
      arm.stop();
      await vi.advanceTimersByTimeAsync(2000);
    }
  });

  it("prints at the ceiling with what has loaded, after saying what has not", async () => {
    vi.useFakeTimers();
    const arm = armFrames(() => false);
    const order: string[] = [];
    try {
      const done = tracked(
        printDoc(makeDoc('<img src="never.svg">'), {
          onIncomplete: (missing) => order.push(`incomplete ${missing.images}`),
        }),
      );
      await vi.advanceTimersByTimeAsync(PRINT_CEILING_MS + 100);
      expect(done.done).toBe(true);
      expect(order).toEqual(["incomplete 1"]);
      expect(arm.printed).toHaveLength(1);
    } finally {
      arm.stop();
      await vi.advanceTimersByTimeAsync(2000);
    }
  });
});
