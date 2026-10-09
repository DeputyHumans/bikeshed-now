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
import type { InheritedGrant, TeamMeta, Visibility } from "../types";

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

const { inheritedAccess, inheritedFolderAccess } = vi.hoisted(() => ({
  inheritedAccess: vi.fn(async (_id: string): Promise<InheritedGrant[]> => []),
  inheritedFolderAccess: vi.fn(async (_id: string): Promise<InheritedGrant[]> => []),
}));

vi.mock("../access", () => ({ setAccess, inheritedAccess }));
vi.mock("../folders", () => ({ setFolderAccess, inheritedFolderAccess }));
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

  test("all four roles are offered, and the hint says what the chosen one adds", () => {
    renderShare({ visibility: PRIVATE });
    const level = screen.getByRole("combobox", { name: "Access level" }) as HTMLSelectElement;
    expect([...level.options].map((o) => o.textContent)).toEqual([
      "Can read",
      "Can suggest",
      "Can edit",
      "Can approve",
    ]);
    const hint = document.getElementById(level.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toMatch(/^Can read:/);
    fireEvent.change(level, { target: { value: "approver" } });
    expect(hint?.textContent).toMatch(/^Can approve: .*accepts or rejects/);
  });

  test("a grant goes out with the role chosen for it", async () => {
    renderShare({ visibility: PRIVATE });
    fireEvent.change(screen.getByRole("combobox", { name: "Access level" }), {
      target: { value: "suggester" },
    });
    const input = document.querySelector("#share-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "s@example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(setAccess).toHaveBeenCalledWith("d1", {
        add: [{ principal: "s@example.com", role: "suggester" }],
      }),
    );
  });

  test("everyone already granted is listed under their own role, highest first", () => {
    renderShare({
      visibility: PRIVATE,
      target: {
        ...DOC,
        viewers: ["v@example.com"],
        suggesters: ["s@example.com"],
        editors: ["e@example.com"],
        approvers: ["a@example.com"],
      },
    });
    const rows = screen.getAllByRole("combobox", { name: /^Access for / }) as HTMLSelectElement[];
    expect(rows.map((r) => [r.getAttribute("aria-label") ?? r.id, r.value])).toEqual([
      ["role-a@example.com", "approver"],
      ["role-e@example.com", "editor"],
      ["role-s@example.com", "suggester"],
      ["role-v@example.com", "viewer"],
    ]);
  });

  test("a record from before the new roles opens with nobody in them", () => {
    // `suggesters` and `approvers` are absent, as on every older record.
    renderShare({ visibility: PRIVATE, target: { ...DOC, viewers: ["v@example.com"] } });
    const rows = screen.getAllByRole("combobox", { name: /^Access for / }) as HTMLSelectElement[];
    expect(rows.map((r) => r.value)).toEqual(["viewer"]);
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

describe("access that comes through a folder", () => {
  // Timestamps are never read by the dialog.
  const PLATFORM = {
    teamId: "platform",
    name: "Platform",
    slug: "platform",
    ownerEmail: "owner@example.com",
    admins: [],
    members: ["owner@example.com", "bo@example.com"],
  } as unknown as TeamMeta;
  const THROUGH: InheritedGrant[] = [
    { folderId: "reviews", path: "Engineering/Reviews", principal: "cy@example.com", role: "viewer" },
    { folderId: "eng", path: "Engineering", principal: "team:platform", role: "editor" },
  ];

  test("each inherited grant is listed after the direct ones, tagged with its folder, and cannot be changed here", async () => {
    inheritedAccess.mockResolvedValueOnce(THROUGH);
    renderShare({ visibility: PRIVATE, teams: [PLATFORM], target: { ...DOC, viewers: ["ana@example.com"] } });

    const cy = (await screen.findByText("via Engineering/Reviews")).closest("li") as HTMLElement;
    expect(cy.textContent).toContain("cy@example.com");
    expect(cy.textContent).toContain("Can read");
    const team = screen.getByText("via Engineering").closest("li") as HTMLElement;
    expect(team.textContent).toContain("Platform");
    expect(team.textContent).toContain("Can edit");
    expect(inheritedAccess).toHaveBeenCalledWith("d1");

    // Changed on the folder, so nothing here offers to change it.
    expect(screen.queryByRole("combobox", { name: "Access for cy@example.com" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove cy@example.com" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Platform" })).toBeNull();

    // The direct grant is still the editable row, and it comes first.
    const ana = screen.getByRole("combobox", { name: "Access for ana@example.com" });
    expect(ana.compareDocumentPosition(cy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("somebody granted directly and through a folder is listed twice, so removing one is not mistaken for both", async () => {
    inheritedAccess.mockResolvedValueOnce([
      { folderId: "eng", path: "Engineering", principal: "cy@example.com", role: "editor" },
    ]);
    renderShare({ visibility: PRIVATE, target: { ...DOC, viewers: ["cy@example.com"] } });
    const inherited = (await screen.findByText("via Engineering")).closest("li") as HTMLElement;
    expect(inherited.textContent).toContain("cy@example.com");
    expect(screen.getByRole("combobox", { name: "Access for cy@example.com" })).toBeTruthy();
    expect(screen.getAllByText("cy@example.com")).toHaveLength(2);
  });

  test("a grant on a folder the owner cannot open says so rather than naming it", async () => {
    inheritedAccess.mockResolvedValueOnce([
      { folderId: "top", path: "…", principal: "dee@example.com", role: "viewer" },
    ]);
    renderShare({ visibility: PRIVATE });
    const row = (await screen.findByText("via a folder you cannot open")).closest("li") as HTMLElement;
    expect(row.textContent).toContain("dee@example.com");
  });

  test("a failed read leaves the direct grants working, and says what is missing", async () => {
    inheritedAccess.mockRejectedValueOnce(new Error("offline"));
    renderShare({ visibility: PRIVATE, target: { ...DOC, viewers: ["ana@example.com"] } });
    expect(await screen.findByText(/could not load who has access through its folders/i)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Access for ana@example.com" })).toBeTruthy();
  });

  test("a folder asks what the folders above it give, and a document does not", async () => {
    inheritedFolderAccess.mockResolvedValueOnce([
      { folderId: "eng", path: "Engineering", principal: "ana@example.com", role: "viewer" },
    ]);
    renderShare({ target: { ...DOC, kind: "folder", id: "f1" } });
    expect(await screen.findByText("via Engineering")).toBeTruthy();
    expect(inheritedFolderAccess).toHaveBeenCalledWith("f1");
    expect(inheritedAccess).not.toHaveBeenCalled();
  });

  test("somebody who is not the owner sees no list, so nothing is asked", () => {
    renderShare({ isOwner: false, visibility: PRIVATE });
    expect(inheritedAccess).not.toHaveBeenCalled();
    expect(inheritedFolderAccess).not.toHaveBeenCalled();
  });
});
