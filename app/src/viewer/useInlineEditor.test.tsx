// SPDX-License-Identifier: Apache-2.0
// When leaving the editor saves a draft, and when a commit does (SPEC §6a).

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { bindSync } from "../crdt/sync";
import { EMPTY_ATTR } from "../brand/dom";
import type { FrameMode } from "./frameMode";
import { useInlineEditor } from "./useInlineEditor";

const { saveDraft } = vi.hoisted(() => ({
  saveDraft: vi.fn(async (_docId: string, _baseVersion: string, _html: string) => ({})),
}));

vi.mock("../edit", async () => {
  const actual = await vi.importActual<typeof import("../edit")>("../edit");
  return { ...actual, saveDraft };
});

const EDITING: FrameMode = { kind: "editing", baseVersion: "v1" };

function setup(html = "<!DOCTYPE html><html><body><p>The text.</p></body></html>") {
  const doc = new DOMParser().parseFromString(
    html,
    "text/html",
  );
  const view = renderHook(() =>
    useInlineEditor({
      mode: EDITING,
      doc,
      epoch: 1,
      docId: "d1",
      authoredAssets: { current: null },
      onStale: () => {},
    }),
  );
  const type = () => doc.dispatchEvent(new Event("input", { bubbles: true }));
  return { view, type, doc };
}

describe("saving on the way out of the editor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    saveDraft.mockReset();
    saveDraft.mockResolvedValue({});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves nothing when nothing was typed, so opening the editor makes no draft", async () => {
    const { view } = setup();
    await act(() => view.result.current.flushUnsaved());
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("saves an edit the autosave has not taken yet", async () => {
    const { view, type } = setup();
    act(type);
    await act(() => view.result.current.flushUnsaved());
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it("saves nothing more once the autosave has taken the edit", async () => {
    const { view, type } = setup();
    act(type);
    await act(() => vi.runAllTimersAsync());
    expect(saveDraft).toHaveBeenCalledTimes(1);
    await act(() => view.result.current.flushUnsaved());
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it("tries a failed save again on the way out", async () => {
    const { view, type } = setup();
    saveDraft.mockRejectedValueOnce(new Error("offline"));
    act(type);
    await act(() => view.result.current.flushNow());
    expect(view.result.current.saveFailed()).toBe(true);
    await act(() => view.result.current.flushUnsaved());
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(view.result.current.saveFailed()).toBe(false);
  });

  it("an edit made while a save is in flight is still unsaved", async () => {
    const { view, type } = setup();
    let release: () => void = () => {};
    saveDraft.mockImplementationOnce(() => new Promise((r) => (release = () => r({}))));
    act(type);
    let first: Promise<unknown> = Promise.resolve();
    act(() => {
      first = view.result.current.flushNow();
    });
    act(type);
    release();
    await act(() => first);
    await act(() => view.result.current.flushUnsaved());
    expect(saveDraft).toHaveBeenCalledTimes(2);
  });

  it("says whether the save a commit waits on went through", async () => {
    // The commit asked saveFailed() BEFORE this save and never after it, so a
    // save failing here published the previous draft and toasted "Published".
    const { view } = setup();
    saveDraft.mockRejectedValueOnce(new Error("offline"));
    let saved: boolean | undefined;
    await act(async () => {
      saved = await view.result.current.flushNow();
    });
    expect(saved).toBe(false);
    await act(async () => {
      saved = await view.result.current.flushNow();
    });
    expect(saved).toBe(true);
  });

  it("a commit saves first whether or not anything changed, because it publishes the draft", async () => {
    const { view } = setup();
    await act(() => view.result.current.flushNow());
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });
});


describe("authored attributes and editor decoration", () => {
  beforeEach(() => {
    saveDraft.mockReset();
    saveDraft.mockResolvedValue({});
  });

  it.each([
    [null, null],
    ["false", "false"],
    ["plaintext-only", ""],
    ["true", "true"],
  ])("restores authored body attributes %s / %s on save and exit", async (contenteditable, spellcheck) => {
    const attrs = Object.entries({ contenteditable, spellcheck })
      .filter(([, value]) => value !== null)
      .map(([name, value]) => ` ${name}="${value}"`).join("");
    const { view, doc } = setup(`<!DOCTYPE html><html spellcheck="false"><body${attrs}><p contenteditable="false" spellcheck="false">The text.</p></body></html>`);
    expect(doc.body.getAttribute("contenteditable")).toBe("true");
    expect(doc.body.getAttribute("spellcheck")).toBe("true");
    doc.querySelector("p")!.firstChild!.nodeValue = "The edited text.";
    await act(() => view.result.current.flushNow());
    const saved = new DOMParser().parseFromString(saveDraft.mock.calls[0][2], "text/html");
    expect(saved.body.getAttribute("contenteditable")).toBe(contenteditable);
    expect(saved.body.getAttribute("spellcheck")).toBe(spellcheck);
    expect(saved.documentElement.getAttribute("spellcheck")).toBe("false");
    expect(saved.querySelector("p")!.outerHTML).toBe('<p contenteditable="false" spellcheck="false">The edited text.</p>');
    expect(doc.body.getAttribute("contenteditable")).toBe("true");
    expect(doc.body.getAttribute("spellcheck")).toBe("true");
    view.unmount();
    expect(doc.body.getAttribute("contenteditable")).toBe(contenteditable);
    expect(doc.body.getAttribute("spellcheck")).toBe(spellcheck);
  });

  it("re-marks a shared body adopted after edit entry without putting markers on the wire or in a save", async () => {
    const html = '<div id="chart"></div><script>document.getElementById("chart").textContent = "drawn";</script>';
    const shared = new Y.Doc();
    const source = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const seed = bindSync(shared.getXmlFragment("body"), source.body);
    const { view, doc } = setup(`<body>${html}</body>`);
    expect(doc.querySelector("#chart")?.getAttribute(EMPTY_ATTR)).toBe("#chart");
    const adopted = bindSync(shared.getXmlFragment("body"), doc.body);
    // The remote wire is clean; a later join replaces the locally marked nodes.
    expect(doc.querySelector("#chart")?.hasAttribute(EMPTY_ATTR)).toBe(false);
    await act(async () => { await Promise.resolve(); });
    expect(doc.querySelector("#chart")?.getAttribute(EMPTY_ATTR)).toBe("#chart");
    expect(adopted.html()).not.toContain(EMPTY_ATTR);
    await act(() => view.result.current.flushNow());
    expect(saveDraft.mock.calls[0][2]).not.toContain(EMPTY_ATTR);
    // Editing a generated container removes the now-misleading empty hint too.
    doc.querySelector("#chart")!.textContent = "Authored text";
    await act(async () => { await Promise.resolve(); });
    expect(doc.querySelector("#chart")?.hasAttribute(EMPTY_ATTR)).toBe(false);
    expect(adopted.html()).toContain("Authored text");
    expect(adopted.html()).not.toContain(EMPTY_ATTR);
    adopted.destroy();
    seed.destroy();
    shared.destroy();
    view.unmount();
  });
});
