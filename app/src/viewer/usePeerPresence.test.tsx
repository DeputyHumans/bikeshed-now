// SPDX-License-Identifier: Apache-2.0
// A reader's place is shared from the moment the document opens, so following them starts where they are (SPEC §16).

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewReading } from "../presence";
import { usePeerPresence } from "./usePeerPresence";

type Handle = Record<"setMode" | "setFocus" | "setView" | "setSlide" | "setComposing" | "leave", ReturnType<typeof vi.fn>>;
const handles = vi.hoisted(() => [] as Handle[]);

vi.mock("../presence", async () => {
  const actual = await vi.importActual<typeof import("../presence")>("../presence");
  return {
    ...actual,
    joinPresence: vi.fn(() => {
      const h: Handle = { setMode: vi.fn(), setFocus: vi.fn(), setView: vi.fn(), setSlide: vi.fn(), setComposing: vi.fn(), leave: vi.fn() };
      handles.push(h);
      return h;
    }),
    watchPeers: () => () => {},
  };
});

/** A frame document of three sections, scrolled nowhere: the reader has not moved. */
function frameDoc(): Document {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html><body><h2 id="one">One</h2><p>Words.</p><h2 id="two">Two</h2><p>Words.</p></body></html>`);
  doc.close();
  return doc;
}

beforeEach(() => {
  handles.length = 0;
});
afterEach(() => {
  document.body.innerHTML = "";
});

function mount(doc: Document | null, liveEpoch = "a") {
  return renderHook(
    (props: { doc: Document | null; liveEpoch: string }) =>
      usePeerPresence({
        docId: "d1",
        uid: "u1",
        emailLower: "me@example.com",
        displayName: "Me",
        doc: props.doc,
        epoch: 1,
        mode: "view",
        enabled: true,
        liveEpoch: props.liveEpoch,
      }),
    { initialProps: { doc, liveEpoch } },
  );
}

/** What the last view sent by `h` reads. */
function lastView(h: Handle): ViewReading {
  const read = h.setView.mock.calls.at(-1)?.[0] as (() => ViewReading) | undefined;
  expect(read, "a view was sent").toBeTypeOf("function");
  return read!();
}

describe("where a reader is, for whoever follows them", () => {
  it("is shared as soon as the document opens, before the reader scrolls at all", () => {
    // Presence joins first; the frame's document loads after.
    const { rerender } = mount(null);
    expect(handles[0].setView).not.toHaveBeenCalled();
    rerender({ doc: frameDoc(), liveEpoch: "a" });
    expect(handles).toHaveLength(1);
    expect(lastView(handles[0]).viewport).toBe(0);
  });

  it("is shared again, with the slide, when the record is made again for a new live session", () => {
    const doc = frameDoc();
    const { result, rerender } = mount(doc, "a");
    act(() => result.current.setSlide(3));
    expect(handles[0].setSlide).toHaveBeenLastCalledWith(3);

    // Somebody published: the live session moves on and the record is made anew.
    rerender({ doc, liveEpoch: "b" });
    expect(handles).toHaveLength(2);
    expect(handles[0].leave).toHaveBeenCalled();
    expect(handles[1].setSlide).toHaveBeenCalledWith(3);
    expect(lastView(handles[1]).viewport).toBe(0);
  });

  it("sends no view before there is a document to read one from", () => {
    mount(null);
    expect(handles).toHaveLength(1);
    expect(handles[0].setView).not.toHaveBeenCalled();
  });
});
