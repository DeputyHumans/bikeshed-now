// SPDX-License-Identifier: Apache-2.0
// A peer publish never silently moves an open editor to a different document history (SPEC §6a, §6b).

import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useEditSession } from "./useEditSession";

it("retains the opened version and epoch until the user explicitly reloads editing", () => {
  const view = renderHook(({ id, version, epoch }) => useEditSession(id, version, epoch), {
    initialProps: { id: "d", version: "v1", epoch: "old" },
  });
  expect(view.result.current.origin).toBeNull();
  act(() => view.result.current.setEditing(true));
  view.rerender({ id: "d", version: "v2", epoch: "new" });
  expect(view.result.current.origin).toEqual({ docId: "d", baseVersion: "v1", liveEpoch: "old" });
  act(() => view.result.current.setEditing(true));
  expect(view.result.current.origin).toEqual({ docId: "d", baseVersion: "v2", liveEpoch: "new" });
  view.rerender({ id: "other", version: "v1", epoch: "initial" });
  expect(view.result.current.origin).toBeNull();
  view.rerender({ id: "d", version: "v2", epoch: "new" });
  expect(view.result.current.origin).toBeNull();
  view.rerender({ id: "other", version: "v1", epoch: "initial" });
  act(() => view.result.current.setEditing(true));
  expect(view.result.current.origin?.docId).toBe("other");
  act(() => view.result.current.setEditing(false));
  expect(view.result.current.origin).toBeNull();
});
