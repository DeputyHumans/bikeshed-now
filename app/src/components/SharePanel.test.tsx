// SPDX-License-Identifier: Apache-2.0
// One dialog decides who has access and who can see it (SPEC §17, §18).

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SharePanel, type ShareTarget } from "./SharePanel";
import { ToastProvider } from "./Toast";
import { endOfDayMs } from "../expiry";
import { shareUrl, type VisibilityState } from "../visibility";
import type { AccessChange, AccessState } from "../access";
import type { Visibility } from "../types";

/**
 * The dialog's job is what it SENDS; the transport is stubbed. `vi.hoisted`
 * because `vi.mock`'s factory is hoisted above every other statement, and a
 * plain const would still be in the temporal dead zone.
 */
const { setAccess, setFolderAccess, setVisibility } = vi.hoisted(() => ({
  setAccess: vi.fn(
    async (_id: string, change: AccessChange): Promise<AccessState> => ({
      viewers: (change.add ?? []).map((a) => a.principal),
      editors: [],
      members: ["owner@example.com", ...(change.add ?? []).map((a) => a.principal)],
    }),
  ),
  setFolderAccess: vi.fn(async (): Promise<AccessState> => ({ viewers: [], editors: [], members: [] })),
  setVisibility: vi.fn(
    async (
      _id: string,
      visibility: Visibility,
      publicEdit: boolean,
      expiresAt: number | null,
    ): Promise<VisibilityState> => ({
      visibility,
      publicEdit,
      linkToken: visibility === "unlisted" ? "tok" : null,
      expiresAt,
    }),
  ),
}));

vi.mock("../access", () => ({ setAccess }));
vi.mock("../folders", () => ({ setFolderAccess }));
vi.mock("../visibility", async () => {
  // `shareUrl` and `visibilityStateOf` stay real; only the network call is stubbed.
  const actual = await vi.importActual<typeof import("../visibility")>("../visibility");
  return { ...actual, setVisibility };
});
const { logEvent } = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock("../analytics", () => ({ logEvent }));

const DAY = 24 * 60 * 60 * 1000;
const FUTURE = Date.now() + 40 * DAY;

const DOC: ShareTarget = {
  kind: "doc",
  id: "d1",
  title: "Quarterly review",
  ownerEmail: "owner@example.com",
  viewers: [],
  editors: [],
  members: ["owner@example.com"],
};

const UNLISTED: VisibilityState = {
  visibility: "unlisted",
  publicEdit: true,
  linkToken: "tok",
  expiresAt: FUTURE,
};

const PRIVATE: VisibilityState = {
  visibility: "private",
  publicEdit: false,
  linkToken: null,
  expiresAt: null,
};

function renderShare(props: Partial<Parameters<typeof SharePanel>[0]> = {}) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <SharePanel
          target={DOC}
          teams={[]}
          isOwner
          onClose={vi.fn()}
          onChanged={vi.fn()}
          {...props}
        />
      </ToastProvider>
    </MemoryRouter>,
  );
}

const writeText = vi.fn();
beforeEach(() => {
  // jsdom has no clipboard; `vi.restoreAllMocks` does not undo a defineProperty.
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  delete (navigator as { clipboard?: unknown }).clipboard;
  vi.clearAllMocks();
});

describe("who can see it, inside the share dialog", () => {
  test("a document gets the three levels and the date, under the people", () => {
    renderShare({ visibility: UNLISTED });
    expect(screen.getByRole("heading", { name: "Who can see it" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(document.querySelector("#expires-on")).toBeTruthy();
    // People first: the add field precedes the levels in the document.
    const input = document.querySelector("#share-input") as HTMLElement;
    const radio = screen.getAllByRole("radio")[0];
    expect(input.compareDocumentPosition(radio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("a folder never gets them, whatever it is handed", () => {
    // Folders have no visibility and no expiry: the section is a document's.
    renderShare({ target: { ...DOC, kind: "folder" }, visibility: UNLISTED });
    expect(screen.queryByRole("radio")).toBeNull();
    expect(document.querySelector("#expires-on")).toBeNull();
  });

  test("changing the level sends the whole triple, with the date untouched", async () => {
    // The server writes visibility, open editing and expiry together, so a call
    // that left one out would clear it — ticking a box must not remove a date
    // somebody set last week.
    renderShare({ visibility: UNLISTED });
    fireEvent.click(screen.getByRole("radio", { name: /public/i }));
    await waitFor(() => expect(setVisibility).toHaveBeenCalledTimes(1));
    expect(setVisibility).toHaveBeenCalledWith("d1", "public", true, FUTURE);
  });

  test("open editing rides along the same way", async () => {
    renderShare({ visibility: UNLISTED });
    fireEvent.click(screen.getByRole("checkbox", { name: /let anyone with an account edit/i }));
    await waitFor(() => expect(setVisibility).toHaveBeenCalledTimes(1));
    expect(setVisibility).toHaveBeenCalledWith("d1", "unlisted", false, FUTURE);
  });

  test("a date is sent as the end of that day, and clearing it sends null", async () => {
    renderShare({ visibility: UNLISTED });
    const date = document.querySelector("#expires-on") as HTMLInputElement;
    fireEvent.change(date, { target: { value: "2031-03-04" } });
    await waitFor(() => expect(setVisibility).toHaveBeenCalledTimes(1));
    expect(setVisibility).toHaveBeenLastCalledWith("d1", "unlisted", true, endOfDayMs("2031-03-04"));

    // Emptying the field by hand is one way to clear it — and a half-typed
    // date is not a date yet, so it must not be sent as one.
    fireEvent.change(date, { target: { value: "" } });
    await waitFor(() => expect(setVisibility).toHaveBeenCalledTimes(2));
    expect(setVisibility).toHaveBeenLastCalledWith("d1", "unlisted", true, null);

    // The button is the other.
    fireEvent.change(date, { target: { value: "2031-03-05" } });
    await waitFor(() => expect(setVisibility).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(setVisibility).toHaveBeenCalledTimes(4));
    expect(setVisibility).toHaveBeenLastCalledWith("d1", "unlisted", true, null);
  });

  test("copies the link with its token, and says so", () => {
    renderShare({ visibility: UNLISTED });
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith(shareUrl("d1", UNLISTED));
    expect(writeText.mock.calls[0][0]).toContain("?k=tok");
    expect(screen.getByRole("status").textContent).toContain("Link copied");
  });

  test("a private document still has the date, and nothing that only a link needs", () => {
    // Expiry applies at every level: a private document shared with six
    // reviewers is exactly the kind that should stop being readable after
    // the review.
    renderShare({ visibility: PRIVATE });
    expect(document.querySelector("#expires-on")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByLabelText("Share link")).toBeNull();
    expect(screen.queryByText(/takes up to five minutes/i)).toBeNull();
  });

  test("the count of people widens to whoever else the level lets in", async () => {
    // "3 people have access" is only the whole truth of a private document.
    const { unmount } = renderShare({ visibility: PRIVATE });
    expect(screen.getByText(/1 person has access/)).toBeTruthy();

    // And it follows a change made in the dialog, not only the state it opened with.
    fireEvent.click(screen.getByRole("radio", { name: /anyone with the link/i }));
    await waitFor(() =>
      expect(screen.getByText(/1 person, and anyone with the link/)).toBeTruthy(),
    );
    unmount();

    renderShare({ visibility: { ...PRIVATE, visibility: "public" } });
    expect(screen.getByText(/1 person, and anyone$/)).toBeTruthy();
  });
});

describe("the people, as before", () => {
  test("an address is granted on Enter, and the grant is counted", async () => {
    renderShare({ visibility: PRIVATE });
    const input = document.querySelector("#share-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Reviewer@Example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(setAccess).toHaveBeenCalledTimes(1));
    expect(setAccess).toHaveBeenCalledWith("d1", {
      add: [{ principal: "reviewer@example.com", role: "viewer" }],
    });
    expect(logEvent).toHaveBeenCalledWith({
      name: "share_grant",
      params: { role: "viewer", principal: "person" },
    });
  });

  test("somebody who is not the owner is told who is, and offered nothing else", () => {
    renderShare({ isOwner: false, visibility: UNLISTED });
    expect(screen.getByText(/Only owner@example.com can change who has access/)).toBeTruthy();
    expect(document.querySelector("#share-input")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    // The count stays the whole truth even for somebody who cannot change it.
    expect(screen.getByText(/1 person, and anyone with the link/)).toBeTruthy();
  });
});
