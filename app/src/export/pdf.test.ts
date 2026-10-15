// SPDX-License-Identifier: Apache-2.0
// The export stamp has to be unsuppressable, and this is what proves it (SPEC §20).

import { describe, expect, it } from "vitest";
import { LOCKED_PROPERTIES, buildPrintHtml, scrubActiveContent } from "./pdf";
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
    const expected = { scale: "1", translate: "none", "offset-path": "none", "mask-image": "none", "mix-blend-mode": "normal" };
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
    const el = out.querySelector(`.${PRINT_MARK_CLASS}`) as HTMLElement;
    expect(el.style.getPropertyValue("position")).toBe("fixed");
    expect(Number(el.style.getPropertyValue("z-index"))).toBeGreaterThan(2000000000);
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
