// SPDX-License-Identifier: Apache-2.0
// The expiry sits on the toolbar, beside the version (SPEC §7, §17).

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { phoneActions, ViewerToolbar } from "./ViewerToolbar";
import { ToastProvider } from "./Toast";

const auth = vi.hoisted(() => ({ user: { uid: "u" }, emailLower: "someone@example.com", gate: "ready", signOut: async () => {} }));
vi.mock("../auth", () => ({ useAuth: () => auth }));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function renderToolbar(props: Partial<Parameters<typeof ViewerToolbar>[0]> = {}) {
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
  test("a reader gets Fork in the slot an owner's Share takes, never both", () => {
    // The bar overflowed at 400px once already; Fork must not add a button to
    // anybody's toolbar, only fill the one an owner has and a reader does not.
    const onFork = vi.fn();
    const reader = renderToolbar({ canShare: false, onFork });
    const fork = screen.getByRole("button", { name: "Fork" });
    expect(fork.getAttribute("title")).toMatch(/author sees that it was forked/);
    fireEvent.click(fork);
    expect(onFork).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    reader.unmount();

    renderToolbar({ canShare: true, onFork });
    expect(screen.getByRole("button", { name: "Share" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
  });

  test("the fork chip says what it is in words, the change included", () => {
    const onOpenForks = vi.fn();
    renderToolbar({
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
    const { container } = renderToolbar({ forked: false, forkCount: 0, onOpenForks: () => {} });
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

describe("printing from the toolbar", () => {
  test("is a button of its own, just before the More menu, that says it saves a PDF too", () => {
    // It lived under More → Download, where somebody who wanted a PDF had to
    // open a menu to find out it was there at all.
    const onPrint = vi.fn();
    renderToolbar({ onPrint });
    const print = screen.getByRole("button", { name: "Print" });
    expect(print.getAttribute("title")).toBe("Print or save as PDF");
    expect(print.nextElementSibling?.getAttribute("aria-label")).toBe("More actions");
    fireEvent.click(print);
    expect(onPrint).toHaveBeenCalledTimes(1);
  });

  test("is not on the bar when the viewer has left it to the menu, as it does on a phone", () => {
    renderToolbar();
    expect(screen.queryByRole("button", { name: "Print" })).toBeNull();
  });
});

describe("the version chip", () => {
  test("opens the document's details when the viewer offers them", () => {
    const onDetails = vi.fn();
    renderToolbar({ versionLabel: "v7 · 6 min", onDetails });
    const chip = screen.getByRole("button", { name: "v7 · 6 min" });
    expect(chip.getAttribute("title")).toMatch(/Details/);
    fireEvent.click(chip);
    expect(onDetails).toHaveBeenCalledTimes(1);
  });

  test("is a label and nothing more when there is nothing to open", () => {
    const { container } = renderToolbar();
    expect(container.querySelector(".chip.mono")?.tagName).toBe("SPAN");
  });
});


describe("the trail back out of a document", () => {
  test("goes to Everything for somebody signed in, and to the front page for somebody who is not", () => {
    // Signed out there is no workspace: /everything would ask them to sign up.
    const signedIn = renderToolbar();
    expect(screen.getByRole("link", { name: "Everything" }).getAttribute("href")).toBe("/everything");
    signedIn.unmount();
    renderToolbar({ signedIn: false });
    expect(screen.getByRole("link", { name: "Everything" }).getAttribute("href")).toBe("/");
  });
});

describe("phoneActions", () => {
  const base = { canEdit: true, canShare: true, canFork: true, hasSlides: false };
  test.each([
    // A document: Present is the rarest thing to do on a phone, so it gives first.
    [4, base, ["edit", "share", "present"], []],
    [3, base, ["edit", "share"], ["present"]],
    // A reader forks where an owner shares, so no reader's row is wider.
    [4, { ...base, canShare: false }, ["edit", "fork", "present"], []],
    [4, { ...base, canShare: false, canEdit: false }, ["fork", "present"], []],
    [3, { ...base, canShare: false, canEdit: false }, ["fork", "present"], []],
    // Nothing to offer but presenting.
    [3, { canEdit: false, canShare: false, canFork: false, hasSlides: false }, ["present"], []],
    // A deck: moving between slides and presenting them is what it is for.
    [4, { ...base, hasSlides: true }, ["slides", "present", "share"], ["edit"]],
    [3, { ...base, hasSlides: true }, ["slides", "present"], ["share", "edit"]],
    [4, { ...base, hasSlides: true, canShare: false, canEdit: false }, ["slides", "present", "fork"], []],
    // On its side a phone has room for all of it.
    [6, { ...base, hasSlides: true }, ["slides", "present", "share", "edit"], []],
  ])("%i slots, %j", (slots, flags, row, menu) => {
    expect(phoneActions({ slots: slots as number, ...(flags as typeof base) })).toEqual({ row, menu });
  });
});

describe("on a phone", () => {
  const phone = (width: number) =>
    vi.stubGlobal("matchMedia", (query: string) => {
      const max = query.match(/^\(max-width: (\d+)px\)/);
      const min = query.match(/^\(min-width: (\d+)px\)/);
      return {
        matches: max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    });
  afterEach(() => vi.unstubAllGlobals());

  const owner = {
    canEdit: true,
    canShare: true,
    onFork: () => {},
    onOpenForks: () => {},
    singleColumn: true,
    signedIn: true,
    versionLabel: "v3 · 4 min",
  };
  const openMore = () => fireEvent.click(screen.getByRole("button", { name: "More actions" }));

  test("the first row is the way home, the title and one menu, with no version chip", () => {
    phone(402);
    const { container } = renderToolbar(owner);
    expect(screen.getByRole("link", { name: "Bikeshed home" })).toBeTruthy();
    expect(screen.getByText("Quarterly review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Menu" })).toBeTruthy();
    expect(container.querySelector(".version-chip")).toBeNull();
  });

  test("the version moves to the menu, and so does a date with time left in it", () => {
    phone(402);
    renderToolbar({ ...owner, expiresAt: Date.now() + 60 * DAY });
    expect(screen.queryByRole("button", { name: /^Expires/ })).toBeNull();
    openMore();
    expect(screen.getByText("v3 · 4 min").className).toBe("menu-label");
    expect(screen.getByRole("menuitem", { name: /^Expires/ })).toBeTruthy();
  });

  test("a date in its last week stays in view, and is not listed twice", () => {
    phone(402);
    renderToolbar({ ...owner, expiresAt: Date.now() + 3 * DAY });
    expect(screen.getByRole("button", { name: /^Expires/ })).toBeTruthy();
    openMore();
    expect(screen.queryByRole("menuitem", { name: /^Expires/ })).toBeNull();
  });

  test("at 320 px Present waits in the menu; at 360 px it has a slot", () => {
    phone(320);
    const { unmount } = renderToolbar(owner);
    expect(screen.queryByRole("button", { name: "Present" })).toBeNull();
    openMore();
    expect(screen.getByRole("menuitem", { name: "Present" })).toBeTruthy();
    unmount();

    phone(360);
    renderToolbar(owner);
    expect(screen.getByRole("button", { name: "Present" })).toBeTruthy();
    openMore();
    expect(screen.queryByRole("menuitem", { name: "Present" })).toBeNull();
  });

  test("the trust offer is left to the banner, which says it in words", () => {
    phone(402);
    renderToolbar({ ...owner, offerTrust: true });
    expect(screen.queryByRole("button", { name: "Scripts blocked" })).toBeNull();
  });

  test("a deck lists All slides and whatever had no slot", () => {
    phone(402);
    renderToolbar({ ...owner, hasSlides: true });
    expect(screen.getByRole("button", { name: "Slides" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Present" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    openMore();
    expect(screen.getByRole("menuitem", { name: "All slides" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeTruthy();
  });

  test("the folder holding the document is one tap into the first row's menu", () => {
    phone(402);
    const folders = [{ folderId: "f1", name: "Board papers", ancestors: [] }] as never;
    renderToolbar({ ...owner, folderId: "f1", folders });
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByRole("menuitem", { name: "Everything" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Board papers" })).toBeTruthy();
  });

  test("beyond a phone the toolbar is as it was", () => {
    phone(768);
    const { container } = renderToolbar({ ...owner, onDetails: () => {} });
    expect(container.querySelector(".version-chip")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Bikeshed home" })).toBeNull();
  });
});
