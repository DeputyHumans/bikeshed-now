// SPDX-License-Identifier: Apache-2.0
// Decoration must never reach the bytes that get published (SPEC §6a).

import { useRef, useState } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAnnotationLayer } from "./useAnnotationLayer";
import { useInlineEditor } from "./useInlineEditor";
import { useSharedDocument } from "./useSharedDocument";
import { usePeerPresence } from "./usePeerPresence";
import { ANN_ATTR, HL_CLASS, HL_SELECTOR, HL_STYLE_ID, OWN_ATTR } from "../brand/dom";
import type { Annotation } from "../types";
import type { FrameMode } from "./frameMode";

/**
 * Vitest loads `app/.env.local`, so a deployment's Realtime Database config
 * leaks in and `useSharedDocument` opens a real socket from a unit test. Stub
 * the transport rather than assert against whatever env happens to exist: what
 * is under test is the BINDING's effect on the document, which needs no peers.
 */
vi.mock("../crdt/rtdb", () => ({
  rtdbLog: () => null,
  clearLog: async () => {},
}));

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

/**
 * Typed with the real signature, so the assertion on the posted HTML is a
 * checked one rather than a cast.
 *
 * Defined through `vi.hoisted` because `vi.mock`'s factory is hoisted above
 * every other statement in the file — a plain `const` above it is still in the
 * temporal dead zone when the factory runs.
 */
const { saveDraft } = vi.hoisted(() => ({
  saveDraft: vi.fn(async (_docId: string, _baseVersion: string, _html: string) => ({
    baseVersion: "v1",
    entry: "index.html",
    bytes: 0,
    updatedByEmail: "ana@example.com",
  })),
}));

vi.mock("../edit", async () => {
  const actual = await vi.importActual<typeof import("../edit")>("../edit");
  return { ...actual, saveDraft };
});

/**
 * Presence talks to the Realtime Database, which is not the subject here. The
 * OVERLAY is: it is the third class of thing this app puts inside somebody
 * else's document, after highlights and placeholder marks, and the only one
 * that was never in this harness. It is mocked down to a peer who is selecting
 * text, which is all it takes to make the overlay render.
 */
const PEER = {
  uid: "u2",
  email: "bo@example.com",
  name: "Bo",
  color: "#00769b",
  mode: "view" as const,
  focus: { elementId: "s2", exact: "second passage", prefix: "", suffix: "", start: 0, end: 14 },
  viewport: 0,
  composing: null,
  lastChanged: 0,
};

vi.mock("../presence", async () => {
  const actual = await vi.importActual<typeof import("../presence")>("../presence");
  return {
    ...actual,
    joinPresence: () => ({
      setMode: () => {},
      setFocus: () => {},
      setViewport: () => {},
      setComposing: () => {},
      leave: () => {},
    }),
    watchPeers: (_docId: string, _uid: string, cb: (peers: unknown[]) => void) => {
      cb([PEER]);
      return () => {};
    },
  };
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
 * point: effect cleanups run in declaration order before any setup, so every
 * strip has already happened by the time the editor attaches. Reordering these
 * lines is what the test would catch.
 *
 * EVERY hook that puts something in the document has to be here. Presence was
 * not, and that is precisely how the peer overlay reached edit mode in a real
 * browser: the harness mirrored an order it did not contain.
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

  usePeerPresence({
    docId: "d1",
    uid: "u1",
    emailLower: "ana@example.com",
    displayName: "Ana",
    doc,
    epoch: 1,
    mode: mode.kind === "editing" ? "edit" : "view",
    enabled: true,
  });

  // Between the annotation layer and the editor, mirroring DocViewer. This one
  // matters more than the others: it does not merely put something in the
  // document, it COPIES the document to every peer. Decoration that reaches it
  // is not a contaminated save, it is a contaminated document in somebody
  // else's browser.
  useSharedDocument({
    mode,
    doc,
    epoch: 1,
    docId: "d1",
    enabled: true,
  });

  const editor = useInlineEditor({
    mode,
    doc,
    epoch: 1,
    docId: "d1",
    authoredAssets,
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
  if (doc.querySelector(HL_SELECTOR)) found.push("highlight mark");
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
    expect(doc.querySelectorAll(HL_SELECTOR).length).toBeGreaterThan(0);
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

  it("does not tear down the editing host when the parent re-renders", async () => {
    /**
     * The bug this pins reached production: typing in edit mode did nothing.
     *
     * DocViewer passes `onStale` as an inline arrow, so it has a new identity
     * every render. It was a dependency of `flush`, which was a dependency of
     * the editor's setup effect — whose CLEANUP removes `contenteditable`. In
     * edit mode the component re-renders constantly (presence, the edit lock,
     * save state), so the editing host was destroyed and rebuilt faster than
     * anyone could type. `keydown` fired; the browser never completed the
     * insertion, so `beforeinput` never fired at all.
     *
     * The assertion is deliberately about the ATTRIBUTE's continuity rather
     * than about render counts: what broke typing was `contenteditable` going
     * away, so that is what is watched.
     */
    const doc = makeDoc();
    const { rerender } = render(
      <Harness doc={doc} mode={{ kind: "reading", versionId: "v1", draft: false, sandboxed: true }} />,
    );
    act(() => {
      rerender(<Harness doc={doc} mode={{ kind: "editing", baseVersion: "v1" }} />);
    });
    expect(doc.body.getAttribute("contenteditable")).toBe("true");

    let touches = 0;
    /**
     * Count the MUTATION RECORDS, not the attribute's state when the callback
     * runs. Observer callbacks are delivered on a microtask, so a remove
     * immediately followed by a re-add looks like "still there" by then — which
     * is exactly how the first version of this test passed with the bug put
     * back. A settled editor touches this attribute zero times.
     *
     * The harness document comes from DOMParser and has no defaultView; jsdom's
     * global observer works across documents.
     */
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.attributeName === "contenteditable") touches += 1;
      }
    });
    observer.observe(doc.body, { attributes: true, attributeFilter: ["contenteditable"] });

    // Three re-renders in the SAME mode, exactly as a presence heartbeat or a
    // save-state change produces.
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        rerender(<Harness doc={doc} mode={{ kind: "editing", baseVersion: "v1" }} />);
      });
    }
    await act(async () => {
      await Promise.resolve();
    });
    observer.disconnect();

    expect(
      touches,
      "contenteditable was torn down and rebuilt while still editing — a callback prop is a dependency somewhere it must not be",
    ).toBe(0);
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
    const html = saveDraft.mock.calls[0][2];
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
    expect(doc.querySelectorAll(HL_SELECTOR).length).toBeGreaterThan(0);
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
    expect(doc.querySelector(HL_SELECTOR)).toBeNull();
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
