// SPDX-License-Identifier: Apache-2.0
// The review pass judges against the draft, and leaves the reader where they are (SPEC §22).

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Annotation } from "../types";
import type { FrameMode } from "./frameMode";
import { useSuggestionReview } from "./useSuggestionReview";

const EDITING: FrameMode = { kind: "editing", baseVersion: "v1" };

function suggestion(annId: string, exact: string, prefix = "", suffix = ""): Annotation {
  return {
    annId,
    anchor: { elementId: "s1", exact, prefix, suffix, start: 0, end: exact.length },
    authorUid: "u1",
    authorEmail: "sug@example.com",
    actor: { uid: "u1", email: "sug@example.com", channel: "web" },
    color: "#b5257b",
    resolved: false,
    createdAt: null as never,
    suggestion: { replacement: "x", state: "pending" },
  };
}

function makeDoc(): Document {
  return new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body><section id="s1"><p>We can cut over in a single weekend.</p></section></body></html>`,
    "text/html",
  );
}

let renders = 0;
let seen: Set<string> = new Set();

/** Hands the hook a NEW array every render, as a careless caller would. */
function Probe({ doc, mode, currentId, tick }: { doc: Document; mode: FrameMode; currentId: string | null; tick: number }) {
  renders += 1;
  const { stale } = useSuggestionReview({
    mode,
    doc,
    epoch: 1,
    active: true,
    pending: [suggestion("a", "a single weekend", "cut over in "), suggestion("b", "words that are gone")],
    currentId,
  });
  seen = stale;
  return <span data-tick={tick} />;
}

afterEach(() => {
  renders = 0;
  vi.restoreAllMocks();
});

describe("useSuggestionReview", () => {
  it("settles, whatever array it is handed each render", () => {
    const doc = makeDoc();
    const { rerender } = render(<Probe doc={doc} mode={EDITING} currentId="a" tick={0} />);
    const settled = renders;
    for (let tick = 1; tick <= 5; tick++) {
      act(() => rerender(<Probe doc={doc} mode={EDITING} currentId="a" tick={tick} />));
    }
    expect(renders - settled).toBe(5); // one per rerender, none of its own
  });

  it("judges staleness against the document on screen", () => {
    render(<Probe doc={makeDoc()} mode={EDITING} currentId="a" tick={0} />);
    expect([...seen]).toEqual(["b"]);
  });

  it("is off outside the editor", () => {
    render(<Probe doc={makeDoc()} mode={{ kind: "reading", versionId: "v1", draft: false, sandboxed: true }} currentId="a" tick={0} />);
    expect(seen.size).toBe(0);
  });

  it("brings the target into view once, not on every re-render", () => {
    const doc = makeDoc();
    const scroll = vi.fn();
    Object.defineProperty(doc.defaultView ? doc.defaultView.HTMLElement.prototype : HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scroll,
    });
    const { rerender } = render(<Probe doc={doc} mode={EDITING} currentId="a" tick={0} />);
    for (let tick = 1; tick <= 3; tick++) {
      act(() => rerender(<Probe doc={doc} mode={EDITING} currentId="a" tick={tick} />));
    }
    expect(scroll).toHaveBeenCalledTimes(1);
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
});
