// SPDX-License-Identifier: Apache-2.0
// A link out of the document opens beside it instead of replacing it (SPEC §6).

import { afterEach, describe, expect, it, vi } from "vitest";
import { attachOutboundLinks, leavesDocument } from "./outboundLinks";

const DOC = "https://bikeshed.example/content/d1/v2/index.html";
const KEYED = "https://bikeshed.example/content/~tok_123/d1/v2/index.html";

describe("leavesDocument", () => {
  it("is true for another site", () => {
    expect(leavesDocument("https://example.com/report", DOC)).toBe(true);
  });

  it("is true for the deployment's own app, which would load inside the frame", () => {
    expect(leavesDocument("https://bikeshed.example/d/other-doc", DOC)).toBe(true);
  });

  it("is true for another version of the same document", () => {
    expect(leavesDocument("https://bikeshed.example/content/d1/v1/index.html", DOC)).toBe(true);
  });

  it("is false for a passage in the document itself", () => {
    expect(leavesDocument(`${DOC}#rollout-plan`, DOC)).toBe(false);
  });

  it("is false for another file of the same version, which is the bundle's own navigation", () => {
    expect(leavesDocument("https://bikeshed.example/content/d1/v2/appendix.html", DOC)).toBe(false);
    expect(leavesDocument("https://bikeshed.example/content/~tok_123/d1/v2/appendix.html", KEYED)).toBe(
      false,
    );
  });

  it("is false for a draft's own files", () => {
    const draft = "https://bikeshed.example/draft/d1/index.html?r=3";
    expect(leavesDocument("https://bikeshed.example/draft/d1/appendix.html", draft)).toBe(false);
  });

  it("leaves every scheme but http and https to the browser", () => {
    expect(leavesDocument("mailto:ana@example.com", DOC)).toBe(false);
    expect(leavesDocument("javascript:void(0)", DOC)).toBe(false);
  });
});

const frames: HTMLIFrameElement[] = [];

function mountFrame(body: string): Document {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  frames.push(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><body>${body}</body>`);
  doc.close();
  return doc;
}

afterEach(() => {
  frames.splice(0).forEach((f) => f.remove());
});

function click(doc: Document, selector: string): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  doc.querySelector(selector)!.dispatchEvent(event);
  return event;
}

describe("attachOutboundLinks", () => {
  it("opens a link to another site beside the document and keeps the frame where it is", () => {
    // A sandboxed frame cannot open a tab, so a plain link replaced the
    // document inside the viewer, and target="_blank" did nothing at all.
    const doc = mountFrame(`<a id="out" href="https://example.com/x" target="_blank"><b id="in">x</b></a>`);
    const open = vi.fn();
    attachOutboundLinks(doc, open);
    expect(click(doc, "#out").defaultPrevented).toBe(true);
    expect(click(doc, "#in").defaultPrevented).toBe(true);
    expect(open.mock.calls).toEqual([["https://example.com/x"], ["https://example.com/x"]]);
  });

  it("leaves a link within the document alone", () => {
    const doc = mountFrame(`<a id="here" href="#section">here</a>`);
    const open = vi.fn();
    attachOutboundLinks(doc, open);
    expect(click(doc, "#here").defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("stops when detached", () => {
    const doc = mountFrame(`<a id="out" href="https://example.com/x">x</a>`);
    const open = vi.fn();
    attachOutboundLinks(doc, open)();
    expect(click(doc, "#out").defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
