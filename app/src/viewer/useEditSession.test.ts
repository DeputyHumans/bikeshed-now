// SPDX-License-Identifier: Apache-2.0
// An editor captures one checked snapshot and cannot adopt a stale asynchronous session (SPEC §6a, §6b).

import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useEditSession } from "./useEditSession";
const { openDraftSession } = vi.hoisted(() => ({ openDraftSession: vi.fn() }));
vi.mock("../edit", () => ({ openDraftSession }));
const snapshot = (baseVersion = "v1", liveEpoch = "old", draftRevision = "a".repeat(64)) => ({ baseVersion, liveEpoch, draftRevision, entry: "index.html" });
beforeEach(() => openDraftSession.mockReset());

it("retains the opened snapshot until the user explicitly reloads editing", async () => {
  openDraftSession.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot("v2", "new"));
  const view = renderHook(({ id, version }) => useEditSession(id, version), { initialProps: { id: "d", version: "v1" } });
  await act(() => view.result.current.setEditing(true));
  view.rerender({ id: "d", version: "v2" });
  expect(view.result.current.origin).toEqual({ docId: "d", ...snapshot() });
  await act(() => view.result.current.setEditing(true));
  expect(view.result.current.origin).toEqual({ docId: "d", ...snapshot("v2", "new") });
  expect(openDraftSession.mock.calls).toEqual([["d", "v1"], ["d", "v2"]]);
  view.rerender({ id: "other", version: "v1" });
  expect(view.result.current.origin).toBeNull();
});

it("ignores an old session reply after another document opens or editing is cancelled", async () => {
  let resolve!: (value: ReturnType<typeof snapshot>) => void;
  openDraftSession.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const view = renderHook(({ id }) => useEditSession(id, "v1"), { initialProps: { id: "d" } });
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.setEditing(true); });
  view.rerender({ id: "other" });
  await act(async () => { resolve(snapshot()); await pending; });
  expect(view.result.current.origin).toBeNull();
  act(() => { pending = view.result.current.setEditing(true); });
  await act(() => view.result.current.setEditing(false));
  await act(async () => { resolve(snapshot()); await pending; });
  expect(view.result.current.origin).toBeNull();
});

it("shows a refused session without opening an editor and clears it on retry", async () => {
  openDraftSession.mockRejectedValueOnce(new Error("The draft changed. Reload before editing.")).mockResolvedValueOnce(snapshot());
  const view = renderHook(() => useEditSession("d", "v1"));
  await act(() => view.result.current.setEditing(true));
  expect(view.result.current.origin).toBeNull();
  expect(view.result.current.error).toContain("draft changed");
  await act(() => view.result.current.setEditing(true));
  expect(view.result.current.error).toBeNull();
  expect(view.result.current.origin?.draftRevision).toBe("a".repeat(64));
});
