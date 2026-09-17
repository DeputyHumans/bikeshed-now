// SPDX-License-Identifier: Apache-2.0
// Normalizing what execCommand produced (SPEC §6a).

import { describe, expect, it } from "vitest";
import { rewriteLegacyFontTags } from "./EditToolbar";

/**
 * jsdom does not implement execCommand, so the commands themselves are not
 * unit-testable. This is the half that IS: the normalization that turns a
 * <font> element — which every engine still emits — into something a serializer
 * should be asked to round-trip.
 */
function makeDoc(body: string): Document {
  return new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${body}</body></html>`,
    "text/html",
  );
}

describe("rewriteLegacyFontTags", () => {
  it("replaces <font size> with an inline font-size", () => {
    const doc = makeDoc('<p><font size="7">big</font></p>');
    expect(rewriteLegacyFontTags(doc)).toBe(1);
    const span = doc.querySelector("span") as HTMLElement;
    expect(doc.querySelector("font")).toBeNull();
    expect(span.style.fontSize).toBe("2.4em");
    expect(span.textContent).toBe("big");
  });

  it("carries colour and face across", () => {
    const doc = makeDoc('<p><font color="#ff0000" face="Georgia">x</font></p>');
    rewriteLegacyFontTags(doc);
    const span = doc.querySelector("span") as HTMLElement;
    expect(span.style.color).toBeTruthy();
    expect(span.style.fontFamily).toContain("Georgia");
  });

  it("preserves child elements rather than flattening them", () => {
    const doc = makeDoc('<p><font size="4">a <b>bold</b> c</font></p>');
    rewriteLegacyFontTags(doc);
    expect(doc.querySelector("span b")?.textContent).toBe("bold");
  });

  it("ignores an out-of-range size rather than emitting nonsense", () => {
    const doc = makeDoc('<p><font size="99">x</font></p>');
    rewriteLegacyFontTags(doc);
    expect((doc.querySelector("span") as HTMLElement).style.fontSize).toBe("");
  });

  it("handles several at once, and reports the count", () => {
    const doc = makeDoc('<p><font size="1">a</font><font size="2">b</font></p>');
    expect(rewriteLegacyFontTags(doc)).toBe(2);
    expect(doc.querySelectorAll("span")).toHaveLength(2);
  });

  it("is a no-op on a clean document", () => {
    const doc = makeDoc("<p>clean</p>");
    expect(rewriteLegacyFontTags(doc)).toBe(0);
    expect(doc.body.innerHTML).toBe("<p>clean</p>");
  });
});
