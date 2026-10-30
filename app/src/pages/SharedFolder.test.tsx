// SPDX-License-Identifier: Apache-2.0
// A folder opened by its link: read-only, every way out keyed, every refusal alike (SPEC §17).

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { FolderUnlock, SharedFolder as Listing } from "../visibility";

const { unlockFolder } = vi.hoisted(() => ({
  unlockFolder: vi.fn(async (_id: string, _k: string | null): Promise<FolderUnlock> => null),
}));
vi.mock("../visibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../visibility")>()),
  unlockFolder,
}));
vi.mock("../firebase", () => ({ auth: {}, db: {}, rtdb: null }));
vi.mock("../firestore", () => ({ formatRelative: () => "2d ago", formatTimestamp: () => "27 Oct 2026, 12:00" }));
vi.mock("../auth", () => ({
  useAuth: () => ({ gate: "signed_out", user: null, emailLower: "", signOut: vi.fn() }),
}));

import { SharedFolder } from "./SharedFolder";
import { ToastProvider } from "../components/Toast";

function mountAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Routes>
          <Route path="/folder/:folderId" element={<SharedFolder />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const LISTING: Listing = {
    folderId: "sub",
    name: "Q3 reviews",
    visibility: "unlisted",
    expiresAt: null,
    path: [
      { folderId: "top", name: "Planning" },
      { folderId: "sub", name: "Q3 reviews" },
    ],
    folders: [{ folderId: "deep", name: "Drafts" }],
    documents: [
      { docId: "memo", title: "Cutover memo", currentVersion: "v2", updatedAt: 1, cover: { versionId: "v2", key: "0123456789abcdef" } },
      { docId: "plan", title: "Plan", currentVersion: "v1", updatedAt: 2, cover: null },
    ],
    truncated: false,
};
const OPEN: FolderUnlock = { open: LISTING };

beforeEach(() => {
  unlockFolder.mockReset();
});

describe("a folder opened by its link", () => {
  test("asks with the key from the URL, and every way out carries it", async () => {
    unlockFolder.mockResolvedValueOnce(OPEN);
    mountAt("/folder/sub?k=fkey");
    expect(await screen.findByRole("heading", { name: /Q3 reviews/ })).toBeTruthy();
    expect(unlockFolder).toHaveBeenCalledWith("sub", "fkey");

    expect(screen.getByRole("link", { name: "Planning" }).getAttribute("href")).toBe("/folder/top?k=fkey");
    expect(screen.getByRole("link", { name: /Drafts/ }).getAttribute("href")).toBe("/folder/deep?k=fkey");
    expect(screen.getByRole("link", { name: "Cutover memo" }).getAttribute("href")).toBe("/d/memo?k=fkey");
    const cover = document.querySelector("img") as HTMLImageElement;
    expect(cover.getAttribute("src")).toBe("/thumb/~fkey/memo/v2/0123456789abcdef/cover.jpg");
  });

  test("offers nothing to change, and says what reading it does not include", async () => {
    unlockFolder.mockResolvedValueOnce(OPEN);
    mountAt("/folder/sub?k=fkey");
    await screen.findByRole("heading", { name: /Q3 reviews/ });
    expect(screen.queryByRole("button", { name: /actions/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /upload/i })).toBeNull();
    expect(screen.getByText(/commenting and editing need the owner to share it with you by name/i)).toBeTruthy();
  });

  test("a public folder needs no key, and its links carry none", async () => {
    unlockFolder.mockResolvedValueOnce({ open: { ...LISTING, visibility: "public" } });
    mountAt("/folder/sub");
    await screen.findByRole("heading", { name: /Q3 reviews/ });
    expect(unlockFolder).toHaveBeenCalledWith("sub", null);
    expect(screen.getByRole("link", { name: "Cutover memo" }).getAttribute("href")).toBe("/d/memo");
  });

  test("an ended link says so and lists nothing", async () => {
    unlockFolder.mockResolvedValueOnce({ ended: { folderId: "sub", name: "Q3 reviews", expiresAt: 1 } });
    mountAt("/folder/sub?k=fkey");
    expect(await screen.findByRole("heading", { name: /stopped working/i })).toBeTruthy();
    expect(screen.getByText(/nothing has been deleted/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Cutover memo" })).toBeNull();
  });

  test("absent, private and a wrong key are the same Not here", async () => {
    unlockFolder.mockResolvedValueOnce(null);
    mountAt("/folder/sub?k=wrong");
    expect(await screen.findByRole("heading", { name: "Not here" })).toBeTruthy();
    expect(screen.getByText(/this folder does not exist, or you do not have access to it/i)).toBeTruthy();
  });
});
