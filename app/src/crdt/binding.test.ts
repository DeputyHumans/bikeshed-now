// SPDX-License-Identifier: Apache-2.0
// The CRDT binding must not change a document it is only carrying (SPEC §6b).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  COMMENT_TAG,
  fragmentToHtml,
  renderFragment,
  seedFragment,
} from "./binding";
import { HL_CLASS, OWN_ATTR } from "../brand/dom";

/**
 * The contract: whatever goes in comes out, byte for byte, through the WIRE —
 * not merely through the in-memory tree. Encoding and decoding an update is
 * where a lossy attribute or a dropped namespace actually shows up, because
 * that is the path a peer's copy takes.
 */
function parse(html: string): Document {
  return new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${html}</body></html>`,
    "text/html",
  );
}

/** Seed from `html`, ship it over the wire, render it back, return the HTML. */
function roundTrip(html: string): string {
  const doc = parse(html);
  const origin = new Y.Doc();
  seedFragment(origin.getXmlFragment("body"), doc.body);

  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(origin));

  const out = parse("");
  renderFragment(peer.getXmlFragment("body"), out.body);
  return out.body.innerHTML;
}

describe("round-trip fidelity", () => {
  it("preserves an ordinary tree exactly", () => {
    const html = `<section id="s1"><h1>Title</h1><p>Body <em>text</em>.</p></section>`;
    expect(roundTrip(html)).toBe(html);
  });

  it("keeps SVG attribute case, which HTML would destroy", () => {
    // createElement("svg") makes an HTML element, and an HTML element lowercases
    // its attributes: viewBox -> viewbox, and the graphic stops scaling. This is
    // the defect the first version of the binding actually shipped.
    const html =
      `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet">` +
      `<linearGradient id="g" gradientUnits="userSpaceOnUse"></linearGradient></svg>`;
    const out = roundTrip(html);
    expect(out).toBe(html);
    expect(out).toContain("viewBox");
    expect(out).not.toContain("viewbox");
    expect(out).toContain("linearGradient");
  });

  it("puts SVG children in the SVG namespace, not the HTML one", () => {
    const doc = parse(`<svg viewBox="0 0 10 10"><circle cx="5"></circle></svg>`);
    const y = new Y.Doc();
    seedFragment(y.getXmlFragment("body"), doc.body);
    const out = parse("");
    renderFragment(y.getXmlFragment("body"), out.body);
    const circle = out.querySelector("circle")!;
    expect(circle.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });

  it("hands control back to HTML inside foreignObject", () => {
    const doc = parse(`<svg viewBox="0 0 10 10"><foreignObject><div></div></foreignObject></svg>`);
    const y = new Y.Doc();
    seedFragment(y.getXmlFragment("body"), doc.body);
    const out = parse("");
    renderFragment(y.getXmlFragment("body"), out.body);
    expect(out.querySelector("div")!.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
  });

  it("carries a comment through, because a bundle's licence header is one", () => {
    const html = `<!-- SPDX-License-Identifier: Apache-2.0 --><p>x</p>`;
    expect(roundTrip(html)).toBe(html);
  });

  it("does not leak the comment carrier into the rendered document", () => {
    expect(roundTrip(`<!-- c --><p>x</p>`)).not.toContain(COMMENT_TAG);
  });

  it("preserves whitespace exactly, including between blocks", () => {
    const html = `<p>a</p>\n\n  <p>b</p>\n`;
    expect(roundTrip(html)).toBe(html);
  });

  it("preserves a script element's text", () => {
    const html = `<script>if (a < b && c) { go(); }</script>`;
    expect(roundTrip(html)).toBe(html);
  });

  it("preserves <details> and its open state", () => {
    const html = `<details open=""><summary>s</summary><p>body</p></details>`;
    expect(roundTrip(html)).toBe(html);
  });
});

describe("the real sample bundles", () => {
  // The bundles are the fixtures on purpose: they are what the product is FOR,
  // and they carry the inline SVG, the <details> trees and the script that a
  // hand-written case would have to imitate badly.
  const bundles = ["bikeshed-tour", "design-review-shortener"];
  for (const name of bundles) {
    it(`${name} survives the wire byte-identical`, () => {
      const src = readFileSync(
        join(__dirname, "..", "..", "..", "content", name, "bundle", "index.html"),
        "utf8",
      );
      const doc = parse("");
      doc.documentElement.innerHTML = new DOMParser()
        .parseFromString(src, "text/html")
        .documentElement.innerHTML;
      const before = doc.body.innerHTML;
      expect(before.length).toBeGreaterThan(5000);
      expect(roundTrip(before)).toBe(before);
    });
  }
});

describe("decoration never reaches the shared document", () => {
  it("drops an own-marked node whole", () => {
    const html = `<p>keep</p><style ${OWN_ATTR}="hl-style">.x{}</style>`;
    expect(roundTrip(html)).toBe(`<p>keep</p>`);
  });

  it("unwraps a highlight and keeps the text it wrapped", () => {
    const html = `<p>a <mark class="${HL_CLASS}" data-bshd-ann="x">b</mark> c</p>`;
    expect(roundTrip(html)).toBe(`<p>a b c</p>`);
  });

  it("unwraps a highlight inside SVG text, which is a tspan rather than a mark", () => {
    const html = `<svg><text>a <tspan class="${HL_CLASS}" data-bshd-ann="x">b</tspan> c</text></svg>`;
    expect(roundTrip(html)).toBe(`<svg><text>a b c</text></svg>`);
  });

  it("keeps a stranger's data-bshd node, because it is not ours", () => {
    // Removing by PREFIX rather than by value is silent data loss in somebody
    // else's document. The value check is the whole defence.
    const html = `<p ${OWN_ATTR}="something-else">theirs</p>`;
    expect(roundTrip(html)).toBe(html);
  });

  it("removes contenteditable but keeps the node, exactly as the serializer does", () => {
    // The attribute is ours; the element is the author's. Dropping the element
    // would delete their content because we borrowed it as an editing host.
    expect(roundTrip(`<div contenteditable="true"><p>x</p></div>`)).toBe(
      `<div><p>x</p></div>`,
    );
  });

  it("removes the generated-container marker, which is an attribute not a node", () => {
    expect(roundTrip(`<div id="chart" data-bshd-empty="">x</div>`)).toBe(
      `<div id="chart">x</div>`,
    );
  });
});

describe("seeding", () => {
  it("refuses to seed a fragment that already has content", () => {
    const y = new Y.Doc();
    const f = y.getXmlFragment("body");
    expect(seedFragment(f, parse(`<p>first</p>`).body)).toBe(true);
    // Whoever arrives second syncs from the peers; seeding again would publish
    // a second copy of the whole document into everyone's editor.
    expect(seedFragment(f, parse(`<p>second</p>`).body)).toBe(false);
    expect(fragmentToHtml(f, parse(""))).toBe(`<p>first</p>`);
  });
});

describe("concurrent editing", () => {
  const seeded = () => {
    const base = new Y.Doc();
    seedFragment(
      base.getXmlFragment("body"),
      parse(`<section id="s1"><p id="p1">The quick brown fox.</p><p id="p2">Second.</p></section>`).body,
    );
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(base));
    return [a, b] as const;
  };
  const para = (d: Y.Doc, id: string) =>
    (d.getXmlFragment("body").get(0) as Y.XmlElement)
      .toArray()
      .find((e) => e instanceof Y.XmlElement && e.getAttribute("id") === id) as Y.XmlElement;
  const sync = (a: Y.Doc, b: Y.Doc) => {
    const ua = Y.encodeStateAsUpdate(a);
    const ub = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, ub);
    Y.applyUpdate(b, ua);
  };

  it("keeps BOTH edits when two people type into the same paragraph offline", () => {
    const [a, b] = seeded();
    (para(a, "p1").get(0) as Y.XmlText).insert(4, "very ");
    (para(b, "p1").get(0) as Y.XmlText).insert(0, ">> ");
    sync(a, b);
    const ta = (para(a, "p1").get(0) as Y.XmlText).toString();
    const tb = (para(b, "p1").get(0) as Y.XmlText).toString();
    expect(ta).toBe(tb);
    expect(ta).toContain("very ");
    expect(ta).toContain(">> ");
  });

  it("converges when one deletes a paragraph while the other types into it", () => {
    const [a, b] = seeded();
    const section = (d: Y.Doc) => d.getXmlFragment("body").get(0) as Y.XmlElement;
    const at = section(a)
      .toArray()
      .findIndex((e) => e instanceof Y.XmlElement && e.getAttribute("id") === "p2");
    section(a).delete(at, 1);
    (para(b, "p2").get(0) as Y.XmlText).insert(0, "EDITED ");
    sync(a, b);
    expect(fragmentToHtml(a.getXmlFragment("body"), parse(""))).toBe(
      fragmentToHtml(b.getXmlFragment("body"), parse("")),
    );
  });

  it("is order-independent: applying updates the other way round agrees", () => {
    const [a, b] = seeded();
    (para(a, "p1").get(0) as Y.XmlText).insert(0, "A");
    (para(b, "p2").get(0) as Y.XmlText).insert(0, "B");
    const ua = Y.encodeStateAsUpdate(a);
    const ub = Y.encodeStateAsUpdate(b);
    const one = new Y.Doc();
    Y.applyUpdate(one, ua);
    Y.applyUpdate(one, ub);
    const other = new Y.Doc();
    Y.applyUpdate(other, ub);
    Y.applyUpdate(other, ua);
    expect(fragmentToHtml(one.getXmlFragment("body"), parse(""))).toBe(
      fragmentToHtml(other.getXmlFragment("body"), parse("")),
    );
  });
});
