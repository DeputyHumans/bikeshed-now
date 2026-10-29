// SPDX-License-Identifier: Apache-2.0
// When leaving the editor saves a draft, and when a commit does (SPEC §6a).

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { bindSync } from "../crdt/sync";
import { EMPTY_ATTR } from "../brand/dom";
import { ConflictError } from "../api";
import { StaleVersionError } from "../edit";
import type { FrameMode } from "./frameMode";
import { useInlineEditor } from "./useInlineEditor";

const { saveDraft } = vi.hoisted(() => ({
  saveDraft: vi.fn(async (_docId: string, _baseVersion: string, _html: string, _options?: unknown) => ({})),
}));

vi.mock("../edit", async () => {
  const actual = await vi.importActual<typeof import("../edit")>("../edit");
  return { ...actual, saveDraft };
});

const EDITING: FrameMode = { kind: "editing", baseVersion: "v1" };

function setup(html = "<!DOCTYPE html><html><body><p>The text.</p></body></html>", options: Partial<Parameters<typeof useInlineEditor>[0]> = {}) {
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
      ...options,
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

  it("Done starts the durable save immediately and waits for shared delivery before leaving", async () => {
    let release!: () => void;
    const flushShared = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const { view, type, doc } = setup(undefined, { flushShared });
    act(type);
    let settled = false;
    let done!: Promise<boolean>;
    act(() => { done = view.result.current.flushUnsaved().then((value) => { settled = true; return value; }); });
    expect(saveDraft).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); });
    expect(settled, "Done must retain the editor until live updates are acknowledged").toBe(false);
    expect(doc.body.getAttribute("contenteditable")).toBe("true");
    release();
    await act(async () => { expect(await done).toBe(true); });
  });

  it("a delivery failure retains the editor and a later Done retries sharing without losing saved text", async () => {
    const flushShared = vi.fn().mockRejectedValueOnce(new Error("Live sharing was not acknowledged")).mockResolvedValue(undefined);
    const { view, type, doc } = setup(undefined, { flushShared });
    doc.querySelector("p")!.textContent = "Keep this text";
    act(type);
    await act(async () => { expect(await view.result.current.flushUnsaved()).toBe(false); });
    expect(doc.body.textContent).toContain("Keep this text");
    expect(doc.body.getAttribute("contenteditable")).toBe("true");
    expect(view.result.current.saveError).toMatch(/not acknowledged/);
    await act(async () => { expect(await view.result.current.flushUnsaved()).toBe(true); });
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(flushShared).toHaveBeenCalledTimes(2);
    expect(view.result.current.saveError).toBeNull();
  });

  it("Done has a bounded outcome while remote edits keep the ordered save drain busy", async () => {
    const releases: (() => void)[] = [];
    saveDraft.mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve({})); }));
    const { view, type, doc } = setup();
    act(type);
    let result: boolean | undefined;
    let done!: Promise<boolean>;
    act(() => { done = view.result.current.flushUnsaved().then((value) => { result = value; return value; }); });
    try {
      for (let i = 0; i < 10; i += 1) {
        act(() => { doc.querySelector("p")!.textContent += ` remote-${i}`; view.result.current.markChanged(); });
        await act(() => vi.advanceTimersByTimeAsync(3_000));
        if (i < 9) await act(async () => { releases.at(-1)!(); await Promise.resolve(); });
      }
      expect(result, "Done must finish with a retryable refusal despite continuous remote input").toBe(false);
      expect(view.result.current.saveError).toMatch(/still being saved/);
      expect(doc.body.textContent).toContain("remote-9");
      expect(doc.body.getAttribute("contenteditable")).toBe("true");
    } finally {
      saveDraft.mockResolvedValue({});
      await act(async () => { releases.at(-1)!(); await done; });
    }
    await act(async () => { expect(await view.result.current.flushUnsaved()).toBe(true); });
    expect(saveDraft.mock.calls.at(-1)![2]).toContain("remote-9");
    view.unmount();
  });

  it("an old Done deadline cannot change the replacement editing session", async () => {
    let release!: () => void;
    saveDraft.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({}); }));
    const assets = { current: null };
    const first = new DOMParser().parseFromString("<p>Old session</p>", "text/html");
    const replacement = new DOMParser().parseFromString("<p>Replacement session</p>", "text/html");
    const view = renderHook(({ doc, epoch }) => useInlineEditor({ mode: EDITING, doc, epoch, docId: "d1", authoredAssets: assets, onStale: () => {} }),
      { initialProps: { doc: first, epoch: 1 } });
    act(() => first.dispatchEvent(new Event("input", { bubbles: true })));
    let oldDone!: Promise<boolean>;
    act(() => { oldDone = view.result.current.flushUnsaved(); });
    view.rerender({ doc: replacement, epoch: 2 });
    await act(async () => { expect(await view.result.current.flushUnsaved()).toBe(true); });
    expect(view.result.current.saveState).toBe("saved");
    try {
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(view.result.current.saveState, "an expired old Done must not overwrite the replacement session").toBe("saved");
      expect(view.result.current.saveError).toBeNull();
      expect(replacement.body.textContent).toBe("Replacement session");
      expect(await oldDone).toBe(false);
    } finally { release(); await act(() => oldDone); view.unmount(); }
  });

  it("a remote edit during delivery is saved before Done leaves", async () => {
    let release!: () => void;
    const flushShared = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(undefined);
    const { view, type, doc } = setup(undefined, { flushShared });
    act(type);
    let done!: Promise<boolean>;
    act(() => { done = view.result.current.flushUnsaved(); });
    await act(async () => { await Promise.resolve(); });
    expect(flushShared).toHaveBeenCalledTimes(1);
    act(() => { doc.querySelector("p")!.textContent += " remote"; view.result.current.markChanged(); });
    release();
    await act(async () => { expect(await done).toBe(true); });
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(saveDraft.mock.calls.at(-1)?.[2]).toContain("remote");
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

  it("coalesces Done with the pending debounce while the request is held", async () => {
    const { view, type } = setup();
    let release: () => void = () => {};
    saveDraft.mockImplementationOnce(() => new Promise((r) => { release = () => r({}); }));
    act(type);
    let done: Promise<unknown>;
    act(() => { done = view.result.current.flushUnsaved(); });
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(saveDraft).toHaveBeenCalledTimes(1);
    release();
    await act(() => done!);
    await act(() => vi.runAllTimersAsync());
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it("Done waits for an autosave already in flight, including a failed result", async () => {
    const { view, type } = setup();
    let reject: (e: Error) => void = () => {};
    saveDraft.mockImplementationOnce(() => new Promise((_r, no) => { reject = no; }));
    act(type);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    let settled = false;
    let done: Promise<unknown>;
    act(() => { done = view.result.current.flushUnsaved().then((result) => { settled = true; return result; }); });
    await act(async () => { await Promise.resolve(); });
    expect(settled).toBe(false);
    reject(new Error("offline"));
    let result: unknown;
    await act(async () => { result = await done!; });
    expect(result).toBe(false);
    expect(view.result.current.saveFailed()).toBe(true);
  });

  it("serializes overlapping flushes and drains edits made while the first snapshot saves", async () => {
    const { view, type, doc } = setup();
    const releases: (() => void)[] = [];
    saveDraft.mockImplementation(() => new Promise((r) => { releases.push(() => r({})); }));
    doc.querySelector("p")!.textContent = "First snapshot";
    act(type);
    let first: Promise<unknown>, second: Promise<unknown>;
    act(() => { first = view.result.current.flushNow(); });
    doc.querySelector("p")!.textContent = "Later snapshot";
    act(type);
    act(() => { second = view.result.current.flushNow(); });
    expect(saveDraft).toHaveBeenCalledTimes(1);
    await act(async () => { releases[0](); await Promise.resolve(); });
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(saveDraft.mock.calls[1][2]).toContain("Later snapshot");
    expect(view.result.current.saveState).toBe("saving");
    releases[1]();
    await act(async () => { expect(await first!).toBe(true); expect(await second!).toBe(true); });
    await act(() => vi.runAllTimersAsync());
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(view.result.current.saveState).toBe("saved");
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

it("blocks input and saving until the initial shared document has been adopted, preserving authored attributes", async () => {
  const doc = new DOMParser().parseFromString('<body contenteditable="plaintext-only"><p contenteditable="true">Draft</p></body>', "text/html");
  const view = renderHook(({ ready }) => useInlineEditor({ mode: EDITING, doc, epoch: 1, docId: "d1", ready, authoredAssets: { current: null }, onStale: () => {} }), { initialProps: { ready: false } });
  try {
    expect(doc.body.getAttribute("contenteditable")).toBe("false");
    const early = new Event("beforeinput", { bubbles: true, cancelable: true });
    doc.querySelector("p")!.dispatchEvent(early);
    expect(early.defaultPrevented).toBe(true);
    let result: unknown;
    await act(async () => { result = await view.result.current.flushNow(); });
    expect(result).toBe(false);
    view.rerender({ ready: true });
    expect(doc.body.getAttribute("contenteditable")).toBe("true");
    const input = new Event("beforeinput", { bubbles: true, cancelable: true });
    doc.querySelector("p")!.dispatchEvent(input);
    expect(input.defaultPrevented).toBe(false);
  } finally { view.unmount(); }
  expect(doc.body.getAttribute("contenteditable")).toBe("plaintext-only");
});


it("autosaves remote merged edits without a local input event, but not initial adoption", async () => {
  saveDraft.mockReset();
  saveDraft.mockResolvedValue({});
  const shared = new Y.Doc();
  const source = new DOMParser().parseFromString("<body><p>Seed</p></body>", "text/html");
  const seed = bindSync(shared.getXmlFragment("body"), source.body);
  const { view, doc } = setup();
  const binding = bindSync(shared.getXmlFragment("body"), doc.body, () => view.result.current.markChanged());
  try {
    await act(() => view.result.current.flushUnsaved());
    expect(saveDraft).not.toHaveBeenCalled();
    act(() => { ((shared.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(4, " merged remotely"); });
    await act(() => view.result.current.flushUnsaved());
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft.mock.calls[0][2]).toContain("Seed merged remotely");
  } finally { binding.destroy(); seed.destroy(); view.unmount(); shared.destroy(); }
});

it("flushes the shared history before serializing matching bytes and sends the captured live epoch", async () => {
  saveDraft.mockReset();
  saveDraft.mockResolvedValue({});
  const stamp = { generation: "a".repeat(64), vector: { 1: 3 }, deletes: {} };
  let target: Document;
  const { view, doc } = setup(undefined, {
    mode: { kind: "editing", baseVersion: "v1", liveEpoch: "session-1" },
    causalStamp: () => { target.querySelector("p")!.textContent = "Flushed shared bytes"; return stamp; },
  });
  target = doc;
  try {
    await act(() => view.result.current.flushNow());
    expect(saveDraft.mock.calls[0][2]).toContain("Flushed shared bytes");
    expect(saveDraft.mock.calls[0][3]).toEqual({ liveEpoch: "session-1", causal: stamp });
  } finally { view.unmount(); }
});

it("advances a solo writer's accepted revision and epoch before saving the next edit", async () => {
  saveDraft.mockReset();
  saveDraft.mockResolvedValueOnce({ draftRevision: "b".repeat(64), liveEpoch: "second" }).mockResolvedValueOnce({});
  const { view, doc } = setup(undefined, { mode: { kind: "editing", baseVersion: "v1", liveEpoch: "first", draftRevision: "a".repeat(64) } });
  try {
    await act(() => view.result.current.flushNow());
    doc.querySelector("p")!.textContent = "Another edit";
    await act(() => view.result.current.flushNow());
    expect(saveDraft.mock.calls[0][3]).toEqual({ liveEpoch: "first", draftRevision: "a".repeat(64) });
    expect(saveDraft.mock.calls[1][3]).toEqual({ liveEpoch: "second", draftRevision: "b".repeat(64) });
  } finally { view.unmount(); }
});

it("keeps refused local edits and requests explicit reload after an unclocked conflict", async () => {
  saveDraft.mockReset();
  saveDraft.mockRejectedValue(new ConflictError("Someone saved a newer draft. Reload.", { draftChanged: true, reloadRequired: true }));
  const { view, doc, type } = setup();
  try {
    doc.querySelector("p")!.textContent = "My unsaved change";
    act(type);
    await act(() => view.result.current.flushUnsaved());
    expect(view.result.current.reloadRequired).toBe(true);
    expect(view.result.current.saveState).toBe("error");
    expect(doc.querySelector("p")!.textContent).toBe("My unsaved change");
    expect(view.result.current.saveFailed()).toBe(true);
  } finally { view.unmount(); }
});

it("does not request reload for a causal save waiting for other live edits to merge", async () => {
  saveDraft.mockReset();
  saveDraft.mockRejectedValue(new ConflictError("Other edits are still arriving. Keep this editor open.", { draftChanged: true }));
  const { view } = setup();
  try {
    await act(() => view.result.current.flushNow());
    expect(view.result.current.reloadRequired).toBe(false);
    expect(view.result.current.saveError).toContain("Keep this editor open");
  } finally { view.unmount(); }
});


it("keeps local edits and offers explicit reload after another editor publishes", async () => {
  saveDraft.mockReset();
  saveDraft.mockRejectedValue(new StaleVersionError("v2"));
  const onStale = vi.fn();
  const { view, doc, type } = setup(undefined, { onStale });
  try {
    doc.querySelector("p")!.textContent = "My late local change";
    act(type);
    await act(() => view.result.current.flushUnsaved());
    expect(view.result.current.reloadRequired).toBe(true);
    expect(view.result.current.saveState).toBe("error");
    expect(doc.querySelector("p")!.textContent).toBe("My late local change");
    expect(view.result.current.saveFailed()).toBe(true);
    expect(onStale).toHaveBeenCalledWith("v2");
  } finally { view.unmount(); }
});
