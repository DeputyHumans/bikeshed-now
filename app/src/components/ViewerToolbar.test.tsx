// SPDX-License-Identifier: Apache-2.0
// The expiry sits on the toolbar, beside the version (SPEC §7, §17).

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import { ViewerToolbar } from "./ViewerToolbar";
import { ToastProvider } from "./Toast";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function renderToolbar(props: { expiresAt: number | null; onExpiry?: () => void }) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ViewerToolbar
          title="Quarterly review"
          folderId={null}
          folders={[]}
          versionLabel="v4"
          peers={[]}
          following={null}
          onToggleFollow={() => {}}
          commentsOpen={false}
          onToggleComments={() => {}}
          canEdit={false}
          editing={false}
          onToggleEdit={() => {}}
          canShare={false}
          onShare={() => {}}
          offerTrust={false}
          onOpenTrust={() => {}}
          hasSlides={false}
          railOpen={false}
          onToggleRail={() => {}}
          onOverview={() => {}}
          onPresent={() => {}}
          menuEntries={[]}
          pane="doc"
          onPane={() => {}}
          singleColumn={false}
          {...props}
        />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("the expiry on the toolbar", () => {
  test("is the chip right after the version, not a row of its own", () => {
    // It used to be a banner above the document, for every future date —
    // eleven months of a row the frame could have had.
    const { container } = renderToolbar({ expiresAt: Date.now() + 3 * DAY + HOUR });
    const version = container.querySelector(".chip.mono") as HTMLElement;
    expect(version.textContent).toBe("v4");
    const next = version.nextElementSibling as HTMLElement;
    expect(next.classList.contains("expiry-chip")).toBe(true);
    expect(next.textContent).toBe("Expires in 3 days");
  });

  test("is absent when the document never expires", () => {
    const { container } = renderToolbar({ expiresAt: null });
    expect(container.querySelector(".expiry-chip")).toBeNull();
  });

  test("hands the owner's tap to whoever changes the date", () => {
    const onExpiry = vi.fn();
    renderToolbar({ expiresAt: Date.now() + 3 * DAY + HOUR, onExpiry });
    fireEvent.click(screen.getByRole("button", { name: "Expires in 3 days" }));
    expect(onExpiry).toHaveBeenCalledTimes(1);
  });
});
