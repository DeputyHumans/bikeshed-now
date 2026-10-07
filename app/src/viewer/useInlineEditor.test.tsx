// SPDX-License-Identifier: Apache-2.0
// When leaving the editor saves a draft, and when a commit does (SPEC §6a).

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function setup() {
  const doc = new DOMParser().parseFromString(
    "<!DOCTYPE html><html><body><p>The text.</p></body></html>",
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
  return { view, type };
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
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = view.result.current.flushNow();
    });
    act(type);
    release();
    await act(() => first);
    await act(() => view.result.current.flushUnsaved());
    expect(saveDraft).toHaveBeenCalledTimes(2);
  });

  it("a commit saves first whether or not anything changed, because it publishes the draft", async () => {
    const { view } = setup();
    await act(() => view.result.current.flushNow());
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });
});
