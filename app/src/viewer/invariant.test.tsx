// SPDX-License-Identifier: Apache-2.0
// Decoration must never reach the bytes that get published (SPEC §6a).

import { useRef, useState } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAnnotationLayer } from "./useAnnotationLayer";
import { useInlineEditor } from "./useInlineEditor";
import { ANN_ATTR, HL_CLASS, HL_STYLE_ID, OWN_ATTR } from "../brand/dom";
import type { Annotation } from "../types";
import type { FrameMode } from "./frameMode";

/**
 * THE test this whole decomposition exists to make possible.
 *
 * The iframe does NOT always remount when edit mode starts: for a document that
 * was already sandboxed, the `src` and the sandbox attribute are both
 * unchanged, so React reuses the element and the editor attaches to the EXACT
 * Document the annotation layer just decorated. Every defence against that is a
 * comment except this one.
 *
 * So the harness below deliberately keeps ONE Document object across the mode
 * change — the hard path — and asserts that what would be published carries
 * nothing this app injected.
 */

const saveDraft = vi.fn(async () => ({
  baseVersion: "v1",
  entry: "index.html",
  bytes: 0,
  updatedByEmail: "ana@example.com",
}));

vi.mock("../edit", async () => {
  const actual = await vi.importActual<typeof import("../edit")>("../edit");
  return { ...actual, saveDraft: (...args: unknown[]) => saveDraft(...(args as [])) };
});

function makeDoc(): Document {
  return new DOMParser().parseFromString(
    `<!DOCTYPE html><html><head><style>body{margin:0}</style></head>
     <body><section id="s1"><p>The first passage of the document.</p></section>
     <section id="s2"><p>A second passage, further down.</p></section></body></html>`,
    "text/html",
  );
}

function annotation(annId: string, elementId: string, exact: string): Annotation {
  return {
    annId,
    anchor: { elementId, exact, prefix: "", suffix: "", start: 0, end: exact.length },
    authorUid: "u1",
    authorEmail: "ana@example.com",
    actor: { uid: "u1", email: "ana@example.com", channel: "web" },
    color: "#b5257b",
    resolved: false,
    createdAt: null as never,
  };
}

const ANNOTATIONS = [
  annotation("a1", "s1", "first passage"),
  annotation("a2", "s2", "second passage"),
];

/**
 * A minimal stand-in for the viewer.
 *
 * The hook DECLARATION ORDER here mirrors DocViewer exactly, and that is the
 * point: effect cleanups run in declaration order before any setup, so the
 * annotation layer's strip has already happened by the time the editor
 * attaches. Reordering these two lines is what the test would catch.
 */
function Harness({ doc, mode }: { doc: Document; mode: FrameMode }) {
  const [selected] = useState<string | null>(null);
  const authoredAssets = useRef<Map<string, number> | null>(null);

  useAnnotationLayer({
    mode,
    doc,
    epoch: 1,
    annotations: ANNOTATIONS,
    selectedId: selected,
    onSelect: () => {},
  });

  const editor = useInlineEditor({
    mode,
    doc,
    epoch: 1,
    docId: "d1",
    authoredAssets,
    observing: false,
    onStale: () => {},
  });

  return (
    <button type="button" onClick={() => void editor.flushNow()}>
      flush
    </button>
  );
}

function decorationIn(doc: Document): string[] {
  const found: string[] = [];
  if (doc.querySelector(`mark.${HL_CLASS}`)) found.push("highlight mark");
  if (doc.getElementById(HL_STYLE_ID)) found.push("highlight stylesheet");
  for (const el of Array.from(doc.querySelectorAll(`[${OWN_ATTR}]`))) {
    found.push(`injected ${el.getAttribute(OWN_ATTR)}`);
  }
  return found;
}

describe("the decoration invariant", () => {
  beforeEach(() => {
    saveDraft.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws highlights while reading", () => {
    const doc = makeDoc();
    render(
      <Harness
        doc={doc}
        mode={{ kind: "reading", versionId: "v1", draft: false, sandboxed: true }}
      />,
    );
    expect(doc.querySelectorAll(`mark.${HL_CLASS}`).length).toBeGreaterThan(0);
    expect(doc.getElementById(HL_STYLE_ID)).not.toBeNull();
  });

  it("leaves NOTHING behind when edit mode starts on the SAME document", () => {
    const doc = makeDoc();
    const { rerender } = render(
      <Harness
        doc={doc}
        mode={{ kind: "reading", versionId: "v1", draft: false, sandboxed: true }}
      />,
    );
    expect(decorationIn(doc).length).toBeGreaterThan(0);

    // The hard path: the same Document object, no remount, no reload.
    act(() => {
      rerender(<Harness doc={doc} mode={{ kind: "editing", baseVersion: "v1" }} />);
    });

    expect(decorationIn(doc)).toEqual([]);
    expect(doc.body.getAttribute("contenteditable")).toBe("true");
  });

  it("publishes bytes that carry no trace of this app", async () => {
    vi.useFakeTimers();
    const doc = makeDoc();
    const { rerender, getByText } = render(
      <Harness
        doc={doc}
        mode={{ kind: "reading", versionId: "v1", draft: false, sandboxed: true }}
      />,
    );
    act(() => {
      rerender(<Harness doc={doc} mode={{ kind: "editing", baseVersion: "v1" }} />);
    });

    await act(async () => {
      getByText("flush").click();
      await vi.runAllTimersAsync();
    });

    expect(saveDraft).toHaveBeenCalled();
    const html = saveDraft.mock.calls[0][2] as unknown as string;
    for (const artifact of [HL_CLASS, HL_STYLE_ID, ANN_ATTR, OWN_ATTR, "contenteditable"]) {
      expect(html, `the draft payload contains ${artifact}`).not.toContain(artifact);
    }
    // And the author's own content is all still there.
    expect(html).toContain("The first passage of the document.");
    expect(html).toContain('<section id="s2">');
    expect(html).toContain("body{margin:0}");
  });

  it("restores highlights when editing stops", () => {
    const doc = makeDoc();
    const { rerender } = render(
      <Harness
        doc={doc}
        mode={{ kind: "reading", versionId: "v1", draft: false, sandboxed: true }}
      />,
    );
    act(() => {
      rerender(<Harness doc={doc} mode={{ kind: "editing", baseVersion: "v1" }} />);
    });
    act(() => {
      rerender(
        <Harness
          doc={doc}
          mode={{ kind: "reading", versionId: "v1", draft: true, sandboxed: true }}
        />,
      );
    });
    expect(doc.querySelectorAll(`mark.${HL_CLASS}`).length).toBeGreaterThan(0);
    expect(doc.body.getAttribute("contenteditable")).toBeNull();
  });

  it("never has both layers active at once", () => {
    /**
     * Leg 1 of the four defences: both hooks derive `enabled` from the SAME
     * tagged union, so they cannot both be on. That is strictly stronger than
     * three independent `if (editing) return` guards, which drift apart one
     * commit at a time.
     */
    const doc = makeDoc();
    const { rerender } = render(
      <Harness doc={doc} mode={{ kind: "editing", baseVersion: "v1" }} />,
    );
    expect(doc.querySelector(`mark.${HL_CLASS}`)).toBeNull();
    act(() => {
      rerender(
        <Harness
          doc={doc}
          mode={{ kind: "reading", versionId: "v1", draft: false, sandboxed: true }}
        />,
      );
    });
    expect(doc.body.getAttribute("contenteditable")).toBeNull();
  });
});
