// SPDX-License-Identifier: Apache-2.0
// What the expiry chip says, and what a tap on it does (SPEC §17).

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ExpiryChip } from "./ExpiryChip";
import { ToastProvider } from "./Toast";
import { expiryExplanation } from "../expiry";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// A whole number of days plus a little, so the seconds the render takes
// cannot round "3 days" down to "2 days".
const IN_3_DAYS = () => Date.now() + 3 * DAY + HOUR;

function renderChip(props: { expiresAt: number | null; onOpen?: () => void }) {
  return render(
    <ToastProvider>
      <ExpiryChip {...props} />
    </ToastProvider>,
  );
}

describe("the expiry chip", () => {
  test("says nothing when the document never expires", () => {
    const { container } = renderChip({ expiresAt: null });
    expect(container.querySelector(".expiry-chip")).toBeNull();
  });

  test("escalates in the last week, and past the date, by wording and by state", () => {
    // Colour is never the only signal: the attribute drives the colour, the
    // label carries the same fact in words.
    const { container, rerender } = renderChip({ expiresAt: IN_3_DAYS() });
    const chip = () => container.querySelector(".expiry-chip") as HTMLElement;
    expect(chip().textContent).toBe("Expires in 3 days");
    expect(chip().hasAttribute("data-soon")).toBe(true);
    expect(chip().hasAttribute("data-expired")).toBe(false);

    rerender(
      <ToastProvider>
        <ExpiryChip expiresAt={Date.now() + 30 * DAY} />
      </ToastProvider>,
    );
    expect(chip().textContent).toMatch(/^Expires /);
    expect(chip().hasAttribute("data-soon")).toBe(false);

    rerender(
      <ToastProvider>
        <ExpiryChip expiresAt={Date.now() - DAY} />
      </ToastProvider>,
    );
    expect(chip().textContent).toBe("Expired");
    expect(chip().hasAttribute("data-expired")).toBe(true);
  });

  test("is a button named by its label, with the explanation on hover", () => {
    // The label is hidden on the narrowest screens; the accessible name is not.
    const at = IN_3_DAYS();
    renderChip({ expiresAt: at });
    const chip = screen.getByRole("button", { name: "Expires in 3 days" });
    expect(chip.getAttribute("title")).toBe(expiryExplanation(at, false));
  });

  test("the owner's tap opens the place the date is changed", () => {
    const at = IN_3_DAYS();
    const onOpen = vi.fn();
    renderChip({ expiresAt: at, onOpen });
    const chip = screen.getByRole("button", { name: "Expires in 3 days" });
    // Handed the dialog, so the explanation is the owner's.
    expect(chip.getAttribute("title")).toBe(expiryExplanation(at, true));
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("anybody else's tap says why, without a hover", () => {
    // Tooltips do not exist on touch, and the one sentence a reader with an
    // empty frame needs is that nothing was deleted and who can restore it.
    const at = Date.now() - DAY;
    renderChip({ expiresAt: at });
    fireEvent.click(screen.getByRole("button", { name: "Expired" }));
    expect(screen.getByRole("status").textContent).toContain(expiryExplanation(at, false));
  });
});
