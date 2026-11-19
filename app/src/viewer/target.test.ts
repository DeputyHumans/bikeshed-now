// SPDX-License-Identifier: Apache-2.0
// The part of a document's address after `#`: read, written, and built into a link (SPEC §6e).

import { describe, expect, it } from "vitest";
import { scanSlides } from "./deck";
import {
  formatTarget,
  keyQuery,
  linkableId,
  parseTarget,
  slideOfTarget,
  slideTarget,
  targetForNode,
  targetUrl,
} from "./target";

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("parseTarget", () => {
  it("reads an id, a slide number and a comment thread, with or without the #", () => {
    expect(parseTarget("#pricing")).toEqual({ kind: "id", id: "pricing" });
    expect(parseTarget("pricing")).toEqual({ kind: "id", id: "pricing" });
    expect(parseTarget("#slide=5")).toEqual({ kind: "slide", n: 5 });
    expect(parseTarget("#comment=Ab3xYz")).toEqual({ kind: "comment", id: "Ab3xYz" });
  });

  it("decodes what a link percent-encoded, and keeps an id that is a bare numeral as an id", () => {
    expect(parseTarget("#caf%C3%A9")).toEqual({ kind: "id", id: "café" });
    expect(parseTarget("#3")).toEqual({ kind: "id", id: "3" });
  });

  it("lets the reserved forms win, and reads a malformed one as nothing rather than as an id", () => {
    for (const hash of ["#slide=0", "#slide=-2", "#slide=1.5", "#slide=abc", "#slide=", "#slide=10000", "#comment=", "#comment=a/b", "#comment=a%20b"]) {
      expect(parseTarget(hash), hash).toBeNull();
    }
  });

  it("is nothing for an empty address, whitespace, or an encoding that does not decode", () => {
    expect(parseTarget("")).toBeNull();
    expect(parseTarget("#")).toBeNull();
    expect(parseTarget("#a%20b")).toBeNull();
    expect(parseTarget("#%E0%A4%A")).toBeNull();
  });
});

describe("formatTarget", () => {
  it("writes what parseTarget reads back", () => {
    for (const target of [
      { kind: "id", id: "mission" },
      { kind: "id", id: "café" },
      { kind: "id", id: "a#b?c" },
      { kind: "slide", n: 12 },
      { kind: "comment", id: "Ab3xYz" },
    ] as const) {
      expect(parseTarget(formatTarget(target))).toEqual(target);
    }
  });

  it("never links by an id spelled like a reserved form, which would read back as something else", () => {
    expect(linkableId("slide=5")).toBe(false);
    expect(linkableId("comment=x")).toBe(false);
    expect(linkableId("")).toBe(false);
    expect(linkableId("intro")).toBe(true);
  });
});

describe("targetUrl", () => {
  const here = { origin: "https://bikeshed.example", pathname: "/d/plan", search: "?k=s3cr%2Fet&utm=x" };

  it("builds on the reader's own path and key, and nothing else of the query", () => {
    expect(keyQuery(here.search)).toBe("?k=s3cr%2Fet");
    expect(targetUrl(here, { kind: "id", id: "pricing" })).toBe("https://bikeshed.example/d/plan?k=s3cr%2Fet#pricing");
    expect(targetUrl({ ...here, pathname: "/d/plan/v3", search: "" }, { kind: "slide", n: 2 })).toBe("https://bikeshed.example/d/plan/v3#slide=2");
  });

  it("puts a comment thread on the path of the version it is on, whatever the reader's path", () => {
    expect(targetUrl(here, { kind: "comment", id: "t1" }, { docId: "plan", versionId: "v7" })).toBe(
      "https://bikeshed.example/d/plan/v7?k=s3cr%2Fet#comment=t1",
    );
  });

  it("adds no key the reader's address did not carry", () => {
    expect(targetUrl({ ...here, search: "" }, { kind: "comment", id: "t1" }, { docId: "plan", versionId: "v7" })).toBe(
      "https://bikeshed.example/d/plan/v7#comment=t1",
    );
  });
});

describe("what a slide or a passage links to", () => {
  const DECK = `<main id="deck">
    <section class="slide" id="cover"><h2>Cover</h2><p>Opening words.</p></section>
    <section class="slide"><h2>Plain</h2><p id="claim">A claim, <em>stated</em>.</p><p>No id here.</p></section>
    <section class="slide" id="slide=3"><h2>Odd id</h2></section>
  </main>`;

  function deck() {
    const doc = parse(DECK);
    const scan = scanSlides(doc);
    return { doc, slides: scan.kind === "slides" ? scan.slides : [] };
  }

  it("links a slide by its own id, else by its number", () => {
    const { slides } = deck();
    expect(slideTarget(slides[0])).toEqual({ kind: "id", id: "cover" });
    expect(slideTarget(slides[1])).toEqual({ kind: "slide", n: 2 });
    expect(slideTarget(slides[2])).toEqual({ kind: "slide", n: 3 });
  });

  it("links a passage to the nearest id around it inside its slide, else to the slide, never to the deck around it", () => {
    const { doc, slides } = deck();
    expect(targetForNode(doc.querySelector("em")!.firstChild, slides, true)).toEqual({ kind: "id", id: "claim" });
    expect(targetForNode(doc.querySelectorAll("section")[1].querySelectorAll("p")[1].firstChild, slides, true)).toEqual({ kind: "slide", n: 2 });
    expect(targetForNode(doc.querySelector("#cover p")!.firstChild, slides, true)).toEqual({ kind: "id", id: "cover" });
  });

  it("links prose to the nearest id around it, passing over our own nodes and a repeated id, and offers nothing without one", () => {
    const doc = parse(`<article id="essay"><p id="dup">First</p><p id="dup">Second <b>bold</b></p></article>
      <div data-bshd="peers"><span id="mine">ours</span></div><p>Loose words.</p>`);
    expect(targetForNode(doc.querySelectorAll("p")[1].querySelector("b")!.firstChild, [], false)).toEqual({ kind: "id", id: "essay" });
    expect(targetForNode(doc.querySelector("#mine")!.firstChild, [], false)).toBeNull();
    expect(targetForNode(doc.querySelectorAll("p")[2].firstChild, [], false)).toBeNull();
  });

  it("finds which slide a target is on", () => {
    const { doc, slides } = deck();
    const passage = (id: string) => (id === "t-on-2" ? doc.querySelector("em") : null);
    expect(slideOfTarget(doc, { kind: "slide", n: 3 }, slides, passage)).toBe(2);
    expect(slideOfTarget(doc, { kind: "slide", n: 4 }, slides, passage)).toBe(-1);
    expect(slideOfTarget(doc, { kind: "id", id: "claim" }, slides, passage)).toBe(1);
    expect(slideOfTarget(doc, { kind: "id", id: "deck" }, slides, passage)).toBe(-1);
    expect(slideOfTarget(doc, { kind: "comment", id: "t-on-2" }, slides, passage)).toBe(1);
    expect(slideOfTarget(doc, { kind: "comment", id: "gone" }, slides, passage)).toBe(-1);
    expect(slideOfTarget(doc, null, slides, passage)).toBe(-1);
  });
});
