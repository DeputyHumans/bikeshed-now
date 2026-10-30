// SPDX-License-Identifier: Apache-2.0
// The Trash page: this account's trashed items, where each came from, and Restore (SPEC §4).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocMeta, FolderMeta } from "../types";

const listeners = vi.hoisted(() => ({
  trash: null as ((t: { docs: DocMeta[]; folders: FolderMeta[] }) => void) | null,
  folders: null as ((f: FolderMeta[]) => void) | null,
}));
const { restoreItem } = vi.hoisted(() => ({ restoreItem: vi.fn(async () => ({ ok: true })) }));
vi.mock("../auth", () => ({ useAuth: () => ({ emailLower: "me@example.com" }) }));
vi.mock("../firestore", () => ({
  listMyTrash: (_e: string, on: typeof listeners.trash) => { listeners.trash = on; return () => {}; },
  listMyFolders: (_e: string, on: typeof listeners.folders) => { listeners.folders = on; return () => {}; },
  formatRelative: () => "2h ago",
  formatTimestamp: () => "Oct 30, 2026, 9:00 AM",
}));
vi.mock("../folders", () => ({ restoreItem }));
vi.mock("../components/FolderTree", () => ({ FolderTree: () => <nav aria-label="Folders" /> }));

import { Trash } from "./Trash";
import { ToastProvider } from "../components/Toast";

const mark = (ms: number, along?: { folderId: string; name: string }) => ({ at: { toMillis: () => ms } as never, by: "u-me", batch: `b${ms}`, ...(along ? { with: along } : {}) });

function mount() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <Trash />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  restoreItem.mockClear();
  listeners.trash = null;
  listeners.folders = null;
});

describe("the Trash page", () => {
  it("lists folders and documents together, newest first, each saying where it came from, and a document opens", () => {
    mount();
    act(() => listeners.folders!([{ folderId: "plans", name: "Plans" } as FolderMeta]));
    act(() =>
      listeners.trash!({
        folders: [{ folderId: "q3", name: "Q3", parentId: null, trashed: mark(2) } as unknown as FolderMeta],
        docs: [
          { docId: "memo", title: "Memo", folderId: "plans", trashed: mark(3) } as unknown as DocMeta,
          { docId: "notes", title: "Notes", folderId: "q3", trashed: mark(2, { folderId: "q3", name: "Q3" }) } as unknown as DocMeta,
        ],
      }),
    );
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toEqual([
      expect.stringContaining("MemoDocument · from “Plans”"),
      expect.stringContaining("Q3Folder, with everything in it"),
      expect.stringContaining("NotesDocument · with the folder “Q3”"),
    ]);
    expect(screen.getByRole("link", { name: "Memo" }).getAttribute("href")).toBe("/d/memo");
    expect(screen.queryByRole("link", { name: "Q3" })).toBeNull();
  });

  it("restores the item a row names, with its kind", async () => {
    mount();
    act(() => listeners.folders!([]));
    act(() => listeners.trash!({ folders: [{ folderId: "q3", name: "Q3", trashed: mark(2) } as unknown as FolderMeta], docs: [] }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Restore" })));
    expect(restoreItem).toHaveBeenCalledWith("folder", "q3");
    expect(await screen.findByText("“Q3” is back where it was, with its sharing.")).toBeTruthy();
  });

  it("says when it is empty, and never that anything in it will be deleted", () => {
    mount();
    act(() => listeners.folders!([]));
    act(() => listeners.trash!({ folders: [], docs: [] }));
    expect(screen.getByText("Your Trash is empty.")).toBeTruthy();
    expect(document.body.textContent).toContain("Nothing here is deleted.");
    expect(document.body.textContent).not.toMatch(/30 days|forever|permanently/);
  });
});
