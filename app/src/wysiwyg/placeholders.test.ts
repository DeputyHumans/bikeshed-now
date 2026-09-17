// SPDX-License-Identifier: Apache-2.0
// Placeholder marking must never become content (SPEC §6a).

import { describe, expect, it } from "vitest";
import { clearGeneratedContainers, markGeneratedContainers } from "./placeholders";
import { EMPTY_ATTR, EDIT_PLACEHOLDERS_ID } from "../brand/dom";
import { serializeCleanHtml } from "../annotation/highlighter";

function makeDoc(body: string): Document {
  return new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${body}</body></html>`,
    "text/html",
  );
}

const SCRIPTED = `
  <div id="chart"></div>
  <div id="untouched">has content</div>
  <div id="empty-but-unreferenced"></div>
  <script>document.getElementById("chart").textContent = "drawn";</script>
`;

describe("markGeneratedContainers", () => {
  it("marks an empty container its own script references by id", () => {
    // "Referenced by id from a script in this document" is the signal that the
    // emptiness is INTENTIONAL. Marking every empty element would outline half
    // a normal document.
    const doc = makeDoc(SCRIPTED);
    expect(markGeneratedContainers(doc)).toBe(1);
    expect(doc.querySelector("#chart")?.getAttribute(EMPTY_ATTR)).toBe("#chart");
  });

  it("leaves an element with content alone", () => {
    const doc = makeDoc(SCRIPTED);
    markGeneratedContainers(doc);
    expect(doc.querySelector("#untouched")?.hasAttribute(EMPTY_ATTR)).toBe(false);
  });

  it("leaves an empty element no script mentions alone", () => {
    const doc = makeDoc(SCRIPTED);
    markGeneratedContainers(doc);
    expect(doc.querySelector("#empty-but-unreferenced")?.hasAttribute(EMPTY_ATTR)).toBe(
      false,
    );
  });

  it("does nothing at all in a document with no scripts", () => {
    const doc = makeDoc('<div id="a"></div>');
    expect(markGeneratedContainers(doc)).toBe(0);
    expect(doc.getElementById(EDIT_PLACEHOLDERS_ID)).toBeNull();
  });

  it("marks by ATTRIBUTE and never inserts a node", () => {
    /**
     * The constraint that makes this safe. An inserted placeholder node would
     * be inside an authored element, and the next save would publish it as the
     * author's own content.
     */
    const doc = makeDoc(SCRIPTED);
    const before = doc.querySelectorAll("*").length;
    markGeneratedContainers(doc);
    const chart = doc.querySelector("#chart")!;
    expect(chart.childNodes).toHaveLength(0);
    // One node added: the injected stylesheet, in the head, marked as ours.
    expect(doc.querySelectorAll("*").length).toBe(before + 1);
    expect(doc.getElementById(EDIT_PLACEHOLDERS_ID)).not.toBeNull();
  });

  it("leaves nothing in the serialized output", () => {
    const doc = makeDoc(SCRIPTED);
    markGeneratedContainers(doc);
    const out = serializeCleanHtml(doc);
    expect(out).not.toContain(EMPTY_ATTR);
    expect(out).not.toContain(EDIT_PLACEHOLDERS_ID);
    expect(out).not.toContain("generated");
    expect(out).toContain('<div id="chart"></div>');
  });

  it("clears cleanly", () => {
    const doc = makeDoc(SCRIPTED);
    markGeneratedContainers(doc);
    clearGeneratedContainers(doc);
    expect(doc.querySelector(`[${EMPTY_ATTR}]`)).toBeNull();
    expect(doc.getElementById(EDIT_PLACEHOLDERS_ID)).toBeNull();
    expect(doc.querySelector("#chart")).not.toBeNull();
  });
});
