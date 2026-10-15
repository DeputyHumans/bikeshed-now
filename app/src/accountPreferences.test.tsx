// SPDX-License-Identifier: Apache-2.0
// Account preferences survive reloads and account switches without opting a waiting reader in (SPEC §15, §20).

import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { UserRecord } from "./types";
import { useAccountPreferences } from "./accountPreferences";

const state = vi.hoisted(() => ({
  auth: { user: { uid: "one" } as { uid: string } | null, gate: "ready", emailLower: "one@example.com" },
  receive: null as null | ((record: UserRecord | null) => void),
  fail: null as null | (() => void),
  optOut: vi.fn(async (_value: boolean) => {}),
  seed: vi.fn(async () => {}),
  stop: vi.fn(),
}));
const deployment = { enabled: true, label: "Deployment", footer: "Configured footer" };
vi.mock("./auth", () => ({ useAuth: () => state.auth }));
vi.mock("./analytics", () => ({ setAnalyticsOptOut: state.optOut }));
vi.mock("./config", () => ({ DEPLOYMENT_MARKING: { enabled: true, label: "Deployment", footer: "Configured footer" } }));
vi.mock("./firestore", () => ({
  seedDefaultMarking: state.seed,
  watchUser: (_uid: string, receive: typeof state.receive, fail: typeof state.fail) => {
    state.receive = receive;
    state.fail = fail;
    return state.stop;
  },
}));
beforeEach(() => {
  state.auth = { user: { uid: "one" }, gate: "ready", emailLower: "one@example.com" };
  vi.clearAllMocks();
});

it("restores a saved opt-out before readiness, seeds only an absent default, and follows changes in the same page", () => {
  const { result } = renderHook(useAccountPreferences);
  expect(result.current).toBe(false);
  expect(state.optOut).toHaveBeenLastCalledWith(true);
  act(() => state.receive?.({ analyticsOptOut: true } as UserRecord));
  expect(result.current).toBe(true);
  expect(state.optOut).toHaveBeenLastCalledWith(true);
  expect(state.seed).toHaveBeenCalledWith("one", "one@example.com", deployment);
  state.seed.mockClear();
  act(() => state.receive?.({ analyticsOptOut: false, defaultMarking: { enabled: false, label: "", footer: "" } } as UserRecord));
  expect(state.optOut).toHaveBeenLastCalledWith(false);
  expect(state.seed).not.toHaveBeenCalled();
  act(() => state.fail?.());
  expect(result.current).toBe(false);
  expect(state.optOut).toHaveBeenLastCalledWith(true);
});

it("drops an old account listener and ignores its delayed answers while another account loads", () => {
  const { result, rerender } = renderHook(useAccountPreferences);
  const first = state.receive;
  act(() => first?.({ analyticsOptOut: false } as UserRecord));
  state.auth = { user: { uid: "two" }, gate: "ready", emailLower: "two@example.com" };
  rerender();
  expect(state.stop).toHaveBeenCalledTimes(1);
  expect(result.current).toBe(false);
  act(() => first?.({ analyticsOptOut: false } as UserRecord));
  expect(result.current).toBe(false);
  expect(state.optOut).toHaveBeenLastCalledWith(true);
  act(() => state.receive?.({ analyticsOptOut: true } as UserRecord));
  expect(result.current).toBe(true);
  expect(state.optOut).toHaveBeenLastCalledWith(true);
});

it("allows anonymous consent only after auth resolves, while a missing account record gets its deployment default", () => {
  state.auth = { user: null, gate: "loading", emailLower: "" };
  const { result, rerender } = renderHook(useAccountPreferences);
  expect(result.current).toBe(false);
  state.auth.gate = "signed_out";
  rerender();
  expect(result.current).toBe(true);
  expect(state.optOut).toHaveBeenLastCalledWith(false);
  state.auth = { user: { uid: "new" }, gate: "ready", emailLower: "new@example.com" };
  rerender();
  act(() => state.receive?.(null));
  expect(state.seed).toHaveBeenCalledWith("new", "new@example.com", deployment);
});
