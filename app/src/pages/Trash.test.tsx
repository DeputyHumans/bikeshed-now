// SPDX-License-Identifier: Apache-2.0
// The Trash page: this account's trashed items, where each came from, Restore, and Delete forever where email is on (SPEC §4).

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocMeta, FolderMeta } from "../types";

const listeners = vi.hoisted(() => ({
  docs: null as ((d: DocMeta[]) => void) | null,
  folders: null as ((f: FolderMeta[]) => void) | null,
  asked: [] as string[],
}));
const { restoreItem } = vi.hoisted(() => ({ restoreItem: vi.fn(async () => ({ ok: true })) }));
const api = vi.hoisted(() => ({
  available: false,
  get: vi.fn(async (path: string) => (path === "/purge" ? { available: api.available, retentionDays: 30 } : {})),
  post: vi.fn(async (_path: string, body: { op: string }): Promise<unknown> =>
    body.op === "code"
      ? { sentTo: "m•••@example.com", expiresInMinutes: 10, summary: { kind: "document", title: "Memo", versions: 3 } }
      : { documents: 1, folders: 0 },
  ),
}));
vi.mock("../api", () => ({ get: api.get, post: api.post }));
vi.mock("../auth", () => ({ useAuth: () => ({ emailLower: "me@example.com" }) }));
vi.mock("../firestore", () => ({
  listMyDocs: (_e: string, on: typeof listeners.docs, _err: unknown, which: string) => { listeners.docs = on; listeners.asked.push(`docs:${which}`); return () => {}; },
  listMyFolders: (_e: string, on: typeof listeners.folders, _err: unknown, which: string) => { listeners.folders = on; listeners.asked.push(`folders:${which}`); return () => {}; },
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
  api.available = false;
  api.get.mockClear();
  api.post.mockReset();
  listeners.docs = null;
  listeners.folders = null;
  listeners.asked = [];
});

/** The two listings the page asks for: the Trash's documents, and every folder, trashed or not. */
function deliver({ docs = [] as DocMeta[], folders = [] as FolderMeta[] }) {
  act(() => listeners.folders!(folders));
  act(() => listeners.docs!(docs));
}

describe("the Trash page", () => {
  it("lists folders and documents together, newest first, each saying where it came from, and a document opens", () => {
    mount();
    deliver({
      folders: [{ folderId: "plans", name: "Plans" } as FolderMeta, { folderId: "q3", name: "Q3", parentId: null, trashed: mark(2) } as unknown as FolderMeta],
      docs: [
        { docId: "memo", title: "Memo", folderId: "plans", trashed: mark(3) } as unknown as DocMeta,
        { docId: "notes", title: "Notes", folderId: "q3", trashed: mark(2, { folderId: "q3", name: "Q3" }) } as unknown as DocMeta,
      ],
    });
    expect(listeners.asked).toEqual(["docs:trash", "folders:all"]);
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
    deliver({ folders: [{ folderId: "q3", name: "Q3", trashed: mark(2) } as unknown as FolderMeta] });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Restore" })));
    expect(restoreItem).toHaveBeenCalledWith("folder", "q3");
    expect(await screen.findByText("“Q3” is back where it was, with its sharing.")).toBeTruthy();
  });

  it("says when it is empty, and that it empties itself", async () => {
    mount();
    deliver({});
    await act(async () => {});
    expect(screen.getByText("Your Trash is empty.")).toBeTruthy();
    expect(document.body.textContent).toContain("Anything still here 30 days after it arrived is deleted forever.");
    expect(screen.queryByRole("button", { name: "Empty trash" })).toBeNull();
  });

  it("where email is off, says each row's day and offers no way to delete it sooner", async () => {
    mount();
    deliver({ docs: [{ docId: "memo", title: "Memo", trashed: mark(Date.UTC(2026, 9, 30, 12)) } as unknown as DocMeta] });
    await act(async () => {});
    expect(api.get).toHaveBeenCalledWith("/purge", {});
    expect(screen.getByRole("listitem").textContent).toMatch(/deleted forever on Nov 29, 2026/);
    expect(document.body.textContent).not.toContain("or sooner");
    expect(screen.queryByRole("button", { name: "Delete forever" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Empty trash" })).toBeNull();
  });

  it("where email is on, deletes a row forever only with the code that was emailed for it", async () => {
    api.available = true;
    mount();
    deliver({ docs: [{ docId: "memo", title: "Memo", trashed: mark(Date.UTC(2026, 9, 30, 12)) } as unknown as DocMeta] });
    await act(async () => {});
    expect(document.body.textContent).toContain("or sooner if you delete it yourself");
    expect(screen.getByRole("button", { name: "Empty trash" })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete forever" })));
    expect(screen.getByRole("dialog").textContent).toContain("“Memo” will be deleted for good");
    expect(api.post).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Email me a code" })));
    expect(api.post).toHaveBeenCalledWith("/purge", { op: "code", target: { kind: "document", id: "memo" } });
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("“Memo” and all 3 of its versions, with their comments, will be deleted for good. This can't be undone.");
    expect(dialog.textContent).toContain("we sent to m•••@example.com. It expires in 10 minutes.");
    const confirm = within(dialog).getByRole("button", { name: "Delete forever" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: /Send another code in \d+ s/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/six-digit code/), { target: { value: "12 34-56" } });
    await act(async () => fireEvent.click(confirm));
    expect(api.post).toHaveBeenLastCalledWith("/purge", { op: "confirm", target: { kind: "document", id: "memo" }, code: "123456" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Deleted forever.")).toBeTruthy();
  });

  it("keeps the dialog open and says why when the code is refused", async () => {
    api.available = true;
    api.post.mockImplementation(async (_p: string, body: { op: string }) => {
      if (body.op === "code") return { sentTo: "m•••@example.com", expiresInMinutes: 10, summary: { kind: "all", documents: 2, folders: 1 } };
      throw new Error("that code is not right");
    });
    mount();
    deliver({ docs: [{ docId: "memo", title: "Memo", trashed: mark(1) } as unknown as DocMeta] });
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Empty trash" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Email me a code" })));
    expect(screen.getByRole("dialog").textContent).toContain("Everything in your Trash, 2 documents and 1 folder, will be deleted for good.");
    fireEvent.change(screen.getByLabelText(/six-digit code/), { target: { value: "000000" } });
    await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete forever" })));
    expect(screen.getByRole("alert").textContent).toBe("that code is not right");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
