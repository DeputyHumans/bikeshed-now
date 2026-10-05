// SPDX-License-Identifier: Apache-2.0
// Forking from the viewer, across a sign-in, exactly once (SPEC §21).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { forkDoc } = vi.hoisted(() => ({ forkDoc: vi.fn() }));
vi.mock("../forks", () => ({ forkDoc, getLineage: vi.fn() }));

import { ToastProvider } from "../components/Toast";
import { useFork } from "./useFork";

type Props = Parameters<typeof useFork>[1];

function Harness(props: Props) {
  const { fork, forking } = useFork("q3-plan", props);
  const { pathname, search } = useLocation();
  return (
    <>
      <button type="button" onClick={fork} disabled={forking}>
        Fork
      </button>
      {/* Two calls in one tick, before any re-render can disable anything —
          what a menu item and the after-sign-in effect can do together. */}
      <button
        type="button"
        onClick={() => {
          fork();
          fork();
        }}
      >
        Fork twice
      </button>
      <p data-testid="where">{`${pathname}${search}`}</p>
    </>
  );
}

function tree(props: Props) {
  return (
    <ToastProvider>
      <Routes>
        <Route path="*" element={<Harness {...props} />} />
      </Routes>
    </ToastProvider>
  );
}

/**
 * ONE router for the whole sequence, re-rendered with each new reader state.
 * A fresh mount per state would never exercise "signed out, then signed in, on
 * the same page", which is the only order a real reader produces.
 */
function mount(path: string, props: Props) {
  let rerender!: (ui: React.ReactElement) => void;
  act(() => {
    ({ rerender } = render(<MemoryRouter initialEntries={[path]}>{tree(props)}</MemoryRouter>));
  });
  return (next: Props) =>
    act(() => rerender(<MemoryRouter initialEntries={[path]}>{tree(next)}</MemoryRouter>));
}

const where = () => screen.getByTestId("where").textContent;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const MADE = { docId: "q3-plan-x7k2p9", versionId: "v1", title: "Q3 plan" };

beforeEach(() => {
  forkDoc.mockReset();
});

describe("forking from the viewer", () => {
  it("forks the version on screen, once however often it is pressed, and opens the fork", async () => {
    const reply = deferred<typeof MADE>();
    forkDoc.mockReturnValue(reply.promise);
    mount("/d/q3-plan/v2", { versionId: "v2", linkKey: "", uid: "u1", resolvedFor: "u1" });

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    expect(forkDoc).toHaveBeenCalledTimes(1);
    expect(forkDoc).toHaveBeenCalledWith("q3-plan", { versionId: "v2" });

    await act(async () => reply.resolve(MADE));
    expect(where()).toBe("/d/q3-plan-x7k2p9");
  });

  it("forks once when asked twice before the page can react", () => {
    forkDoc.mockReturnValue(new Promise(() => {}));
    mount("/d/q3-plan", { linkKey: "", uid: "u1", resolvedFor: "u1" });
    fireEvent.click(screen.getByRole("button", { name: "Fork twice" }));
    expect(forkDoc).toHaveBeenCalledTimes(1);
  });

  it("sends a signed-out reader to sign in, carrying the fork and the key with them", () => {
    mount("/d/q3-plan/v2?k=KEY", { versionId: "v2", linkKey: "KEY", uid: null, resolvedFor: "" });

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    expect(forkDoc).not.toHaveBeenCalled();
    expect(where()).toBe(`/signup?next=${encodeURIComponent("/d/q3-plan/v2?k=KEY&fork=1")}`);
  });

  it("finishes the fork on return, only once the reader is resolved as their account", async () => {
    const reply = deferred<typeof MADE>();
    forkDoc.mockReturnValue(reply.promise);
    const path = "/d/q3-plan/v2?k=KEY&fork=1";
    const base = { versionId: "v2", linkKey: "KEY" };

    // Back from sign-in, auth still settling: nothing yet.
    const update = mount(path, { ...base, uid: null, resolvedFor: "" });
    expect(forkDoc).not.toHaveBeenCalled();

    // Signed in, but the document is still the anonymous answer. On an
    // unlisted document the grant is recorded by resolving as the account, and
    // the server checks the grant, so forking now would be refused.
    update({ ...base, uid: "u1", resolvedFor: "" });
    expect(forkDoc).not.toHaveBeenCalled();

    update({ ...base, uid: "u1", resolvedFor: "u1" });
    expect(forkDoc).toHaveBeenCalledTimes(1);
    expect(forkDoc).toHaveBeenCalledWith("q3-plan", { versionId: "v2", linkKey: "KEY" });
    // The intent is gone before the answer is, so a reload cannot fork twice.
    expect(where()).toBe("/d/q3-plan/v2?k=KEY");

    update({ ...base, uid: "u1", resolvedFor: "u1" });
    expect(forkDoc).toHaveBeenCalledTimes(1);

    await act(async () => reply.resolve(MADE));
    expect(where()).toBe("/d/q3-plan-x7k2p9");
  });

  it("says so when the fork is refused, and lets the reader try again", async () => {
    forkDoc.mockRejectedValueOnce(new Error("the source has no version v9"));
    mount("/d/q3-plan/v9", { versionId: "v9", linkKey: "", uid: "u1", resolvedFor: "u1" });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Fork" })));

    expect(await screen.findByText("the source has no version v9")).toBeDefined();
    expect((screen.getByRole("button", { name: "Fork" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
