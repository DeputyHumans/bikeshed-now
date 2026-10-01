// SPDX-License-Identifier: Apache-2.0
// A busy toast lasts exactly as long as its work, and never swallows the outcome.

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ToastProvider, useToast } from "./Toast";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Render the provider and hand back its API, as any component would see it. */
function mount() {
  let api!: ReturnType<typeof useToast>;
  function Probe() {
    api = useToast();
    return null;
  }
  render(
    <ToastProvider>
      <Probe />
    </ToastProvider>,
  );
  return api;
}

const busyToast = () => document.querySelector(".toast-busy");

describe("toast.during", () => {
  it("shows the message, with a spinner and no dismiss, while the work runs", () => {
    const toast = mount();
    const work = deferred<string>();

    act(() => void toast.during("Duplicating…", work.promise));

    expect(busyToast()?.textContent).toBe("Duplicating…");
    expect(busyToast()?.getAttribute("role")).toBe("status");
    expect(busyToast()?.querySelector(".spinner")).not.toBeNull();
    // Dismissing would hide the work, not stop it.
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("goes when the work succeeds, and hands back its value", async () => {
    const toast = mount();
    const work = deferred<string>();
    let returned: Promise<string> | undefined;

    act(() => {
      returned = toast.during("Renaming…", work.promise);
    });
    await act(async () => work.resolve("copy-1"));

    expect(busyToast()).toBeNull();
    await expect(returned).resolves.toBe("copy-1");
  });

  it("goes when the work fails, and leaves the failure to the caller", async () => {
    // Vitest fails the run on an unhandled rejection, so this also proves the
    // toast's own bookkeeping does not raise one: only the caller's chain
    // below handles the error.
    const toast = mount();
    const work = deferred<string>();
    let caught: Error | undefined;

    act(() => {
      void toast.during("Revoking…", work.promise).catch((e: Error) => {
        caught = e;
      });
    });
    await act(async () => work.reject(new Error("denied")));

    expect(busyToast()).toBeNull();
    expect(caught?.message).toBe("denied");
  });

  it("stays past the four seconds an info toast gets", () => {
    // A slow cold start is exactly the case this exists for.
    vi.useFakeTimers();
    const toast = mount();
    const work = deferred<void>();

    act(() => void toast.during("Deleting the folder…", work.promise));
    act(() => vi.advanceTimersByTime(10_000));

    expect(busyToast()).not.toBeNull();
  });
});
