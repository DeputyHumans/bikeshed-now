// SPDX-License-Identifier: Apache-2.0
// A modal keeps focus when controls change, and restores its opener (SPEC §7).

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

describe("modal focus", () => {
  it("does not trap backwards Tab on a negative-tabindex file input", () => {
    const { getByRole } = render(<Modal title="Upload" onClose={() => {}}><button>Choose file</button><input type="file" tabIndex={-1} /></Modal>);
    const close = getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(getByRole("button", { name: "Choose file" }));
  });

  it("returns focus inside when the focused control becomes disabled, keeping Escape reachable", async () => {
    const close = vi.fn();
    const { getByRole } = render(<Modal title="Share" onClose={close}><button>Add</button></Modal>);
    const add = getByRole("button", { name: "Add" }) as HTMLButtonElement;
    add.focus();
    await act(async () => { add.disabled = true; await Promise.resolve(); });
    expect(document.activeElement).toBe(getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("restores the button that opened it on unmount", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const view = render(<Modal title="Upload" onClose={() => {}}>Content</Modal>);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
