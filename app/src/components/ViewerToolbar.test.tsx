// SPDX-License-Identifier: Apache-2.0
// The expiry sits on the toolbar, beside the version (SPEC §7, §17).

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import { ViewerToolbar } from "./ViewerToolbar";
import { ToastProvider } from "./Toast";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function renderToolbar(props: {
  expiresAt: number | null;
  onExpiry?: () => void;
  onToggleComments?: () => void;
  expiryOf?: "document" | "folder-link";
}) {
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

describe("forking from the toolbar", () => {
  function mountWith(props: Partial<Parameters<typeof ViewerToolbar>[0]>) {
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

  test("a reader gets Fork in the slot an owner's Share takes, never both", () => {
    // The bar overflowed at 400px once already; Fork must not add a button to
    // anybody's toolbar, only fill the one an owner has and a reader does not.
    const onFork = vi.fn();
    const reader = mountWith({ canShare: false, onFork });
    const fork = screen.getByRole("button", { name: "Fork" });
    expect(fork.getAttribute("title")).toMatch(/author sees that it was forked/);
    fireEvent.click(fork);
    expect(onFork).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    reader.unmount();

    mountWith({ canShare: true, onFork });
    expect(screen.getByRole("button", { name: "Share" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
  });

  test("the fork chip says what it is in words, the change included", () => {
    const onOpenForks = vi.fn();
    mountWith({
      forked: true,
      forkCount: 2,
      lineage: {
        forked: true,
        ancestors: [{ docId: "q3", title: "Q3 plan", versionId: "v2", changed: true }],
        hiddenAncestor: false,
      },
      onOpenForks,
    });
    const chip = screen.getByRole("button", {
      name: "Forked from Q3 plan. The original has changed since. Forked 2 times",
    });
    expect(chip.hasAttribute("data-changed")).toBe(true);
    expect(chip.textContent).toBe("Fork · 2");
    fireEvent.click(chip);
    expect(onOpenForks).toHaveBeenCalledTimes(1);
  });

  test("a document that is neither a fork nor forked has no chip", () => {
    const { container } = mountWith({ forked: false, forkCount: 0, onOpenForks: () => {} });
    expect(container.querySelector(".fork-chip")).toBeNull();
  });
});

describe("a reader who came through a folder's link", () => {
  test("is offered no comments, and told when their link ends rather than that the document expires", () => {
    renderToolbar({ expiresAt: Date.now() + 3 * DAY, expiryOf: "folder-link", onToggleComments: undefined });
    expect(screen.queryByRole("button", { name: /comments/i })).toBeNull();
    const chip = screen.getByRole("button", { name: /sharing ends/i });
    expect(chip.getAttribute("title")).toMatch(/through a shared folder/);
  });
});
