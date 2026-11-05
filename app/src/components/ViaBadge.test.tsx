// SPDX-License-Identifier: Apache-2.0
// The agent badge says one word, keeps what acted behind it, and gives it up to a tap as well as a hover (SPEC §17).

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { viaOf } from "../provenance";
import { ToastProvider } from "./Toast";
import { ViaBadge } from "./ViaBadge";

function mount(via: string | null, onParentClick = () => {}) {
  return render(
    <ToastProvider>
      <div onClick={onParentClick}>
        <ViaBadge via={via} title={`Published through ${via}, not by a person in the browser`} />
      </div>
    </ToastProvider>,
  );
}

describe("the agent badge", () => {
  it("says agent, with the glyph hidden from assistive tech, and not what acted", () => {
    const { container } = mount("CLI on prometheus");
    const chip = screen.getByRole("button", { name: "agent" });
    expect(chip.textContent).toBe("agent");
    expect(container.textContent).not.toContain("prometheus");
    expect(chip.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("has exactly what acted in its title, and as its description to assistive tech", () => {
    mount("“Claude” (connected app)");
    const chip = screen.getByRole("button", { name: "agent", description: "Published through “Claude” (connected app), not by a person in the browser" });
    expect(chip.getAttribute("title")).toBe("Published through “Claude” (connected app), not by a person in the browser");
  });

  it("says the same of a record from before the words were stored", () => {
    mount(viaOf({ channel: "mcp" }));
    expect(screen.getByRole("button", { name: "agent" }).getAttribute("title")).toBe("Published through MCP, not by a person in the browser");
  });

  it("is nothing at all for a person in the browser", () => {
    const { container } = mount(viaOf({ channel: "web" }));
    expect(container.querySelector(".badge-automated")).toBeNull();
  });

  it("gives the same words to a tap or Enter, which hover cannot reach, and takes no click from what it sits in", () => {
    const onParentClick = vi.fn();
    mount("CLI on prometheus", onParentClick);
    expect(screen.queryByText("Published through CLI on prometheus, not by a person in the browser")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "agent" }));
    expect(screen.getByText("Published through CLI on prometheus, not by a person in the browser")).toBeTruthy();
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
