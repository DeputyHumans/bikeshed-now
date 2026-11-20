// SPDX-License-Identifier: Apache-2.0
// The explorer: remembered on the account as a column only, a drawer that never is, out of the way while editing (SPEC §13 "The explorer").

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocMeta, FolderMeta, UserRecord } from "../types";

const state = vi.hoisted(() => ({
  auth: { user: { uid: "u-me" } as { uid: string } | null, emailLower: "me@example.com", gate: "ready" },
  compact: false,
  record: null as ((record: Partial<UserRecord> | null) => void) | null,
  docs: null as ((docs: DocMeta[]) => void) | null,
  folders: null as ((folders: FolderMeta[]) => void) | null,
  save: vi.fn(async (_uid: string, _email: string, _fields: Partial<UserRecord>) => {}),
  reading: vi.fn(async (_uid: string, _max: number) => new Map<string, number>()),
  subscriptions: 0,
}));

vi.mock("../firebase", () => ({ auth: {}, db: {}, rtdb: null }));
vi.mock("../auth", () => ({ useAuth: () => state.auth }));
vi.mock("../hooks/useMediaQuery", async () => ({
  ...(await vi.importActual<typeof import("../hooks/useMediaQuery")>("../hooks/useMediaQuery")),
  useIsCompactToolbar: () => state.compact,
}));
vi.mock("../firestore", () => ({
  watchUser: (_uid: string, onData: (record: Partial<UserRecord> | null) => void) => {
    state.record = onData;
    return () => {};
  },
  saveUserProfile: (uid: string, email: string, fields: Partial<UserRecord>) => state.save(uid, email, fields),
  listMyDocs: (_email: string, onData: (docs: DocMeta[]) => void) => {
    state.subscriptions += 1;
    state.docs = onData;
    return () => {};
  },
  listMyFolders: (_email: string, onData: (folders: FolderMeta[]) => void) => {
    state.folders = onData;
    return () => {};
  },
  listMyReading: (uid: string, max: number) => state.reading(uid, max),
}));

import { ExplorerShell, EXPLORER_ID, useExplorer } from "./explorer";

function docMeta(overrides: Partial<DocMeta>): DocMeta {
  return {
    docId: "d",
    title: "A document",
    slug: "a-document",
    ownerUid: "u-me",
    ownerEmail: "me@example.com",
    currentVersion: "v1",
    viewers: [],
    editors: [],
    members: ["me@example.com"],
    createdAt: null as never,
    updatedAt: null as never,
    ...overrides,
  };
}

function folder(folderId: string, name: string, parentId: string | null = null): FolderMeta {
  return {
    folderId,
    name,
    parentId,
    ancestors: parentId ? [parentId] : [],
    ownerEmail: "me@example.com",
  } as unknown as FolderMeta;
}

/** The toolbar's toggle, as the viewer would draw it, and the viewer's word that it is editing. */
function Viewer({ editing = false }: { editing?: boolean }) {
  const explorer = useExplorer();
  const { setSuppressed } = explorer;
  useEffect(() => setSuppressed(editing), [setSuppressed, editing]);
  const navigate = useNavigate();
  return (
    <div className="viewer">
      {explorer.available ? (
        <button type="button" aria-controls={EXPLORER_ID} aria-expanded={explorer.open} onClick={explorer.toggle}>
          Your documents
        </button>
      ) : (
        <p>No toggle</p>
      )}
      <button type="button" onClick={() => navigate("/d/other")}>Elsewhere</button>
    </div>
  );
}

function mount({ editing = false, at = "/d/here" }: { editing?: boolean; at?: string } = {}) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route
          path="/d/:docId"
          element={
            <ExplorerShell>
              <Viewer editing={editing} />
            </ExplorerShell>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const toggle = () => screen.getByRole("button", { name: "Your documents" });
const panel = () => document.getElementById(EXPLORER_ID);

beforeEach(() => {
  state.auth = { user: { uid: "u-me" }, emailLower: "me@example.com", gate: "ready" };
  state.compact = false;
  state.record = null;
  state.docs = null;
  state.folders = null;
  state.subscriptions = 0;
  state.save.mockReset();
  state.save.mockImplementation(async () => {});
  state.reading.mockReset();
  state.reading.mockImplementation(async () => new Map());
});

describe("the explorer's toggle", () => {
  it("is not offered to a reader who is not signed in", () => {
    state.auth = { user: null, emailLower: "", gate: "signed_out" };
    mount();
    expect(screen.getByText("No toggle")).toBeTruthy();
    expect(panel()).toBeNull();
  });

  it("is closed until the account says otherwise, and opens from there on a new device", () => {
    mount();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();
    act(() => state.record!({ explorerOpen: true }));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(panel()).not.toBeNull();
    // Opened by the account, not by a click: focus is left where it was.
    expect(document.activeElement).toBe(document.body);
  });

  it("writes open and closed to the account where it is a column", () => {
    mount();
    act(() => state.record!({}));
    fireEvent.click(toggle());
    expect(state.save).toHaveBeenLastCalledWith("u-me", "me@example.com", { explorerOpen: true });
    expect(panel()).not.toBeNull();
    // Somebody opened it to look for something: the filter has the focus.
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Filter your documents by title" }));
    fireEvent.click(toggle());
    expect(state.save).toHaveBeenLastCalledWith("u-me", "me@example.com", { explorerOpen: false });
    expect(panel()).toBeNull();
  });

  it("puts the column back when the account refuses the write", async () => {
    state.save.mockImplementation(async () => {
      throw new Error("refused");
    });
    mount();
    act(() => state.record!({}));
    await act(async () => fireEvent.click(toggle()));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the drawer, at 1100px and below", () => {
  it("starts closed whatever the account remembers, and never writes to it", () => {
    state.compact = true;
    mount();
    act(() => state.record!({ explorerOpen: true }));
    expect(panel()).toBeNull();
    fireEvent.click(toggle());
    expect(panel()?.getAttribute("data-drawer")).toBe("open");
    fireEvent.click(toggle());
    expect(panel()).toBeNull();
    expect(state.save).not.toHaveBeenCalled();
  });

  it("closes on Escape and on the scrim, and gives focus back to the toggle", () => {
    state.compact = true;
    mount();
    fireEvent.click(toggle());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(toggle());
    fireEvent.click(toggle());
    fireEvent.click(screen.getAllByRole("button", { name: "Close the document list" })[0]);
    expect(panel()).toBeNull();
  });

  it("closes once the reader has gone where they opened it to go", () => {
    state.compact = true;
    mount();
    fireEvent.click(toggle());
    expect(panel()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(panel()).toBeNull();
  });
});

describe("while the reader edits", () => {
  it("steps aside, toggle and all, and comes back as it was", () => {
    const { rerender } = mount();
    act(() => state.record!({ explorerOpen: true }));
    expect(panel()).not.toBeNull();
    const tree = (editing: boolean) => (
      <MemoryRouter initialEntries={["/d/here"]}>
        <Routes>
          <Route
            path="/d/:docId"
            element={
              <ExplorerShell>
                <Viewer editing={editing} />
              </ExplorerShell>
            }
          />
        </Routes>
      </MemoryRouter>
    );
    rerender(tree(true));
    expect(screen.getByText("No toggle")).toBeTruthy();
    expect(panel()).toBeNull();
    rerender(tree(false));
    expect(panel()).not.toBeNull();
    // Coming back is not somebody opening it: no focus taken.
    expect(document.activeElement).toBe(document.body);
  });
});

describe("what it lists", () => {
  function open(docs: DocMeta[], folders: FolderMeta[] = []) {
    mount();
    act(() => state.record!({ explorerOpen: true }));
    act(() => {
      state.folders!(folders);
      state.docs!(docs);
    });
    return panel()!;
  }

  it("the folders with their documents, opened down to the one being read, which is marked", () => {
    const nav = open(
      [
        docMeta({ docId: "here", title: "Launch plan", folderId: "f-inner" }),
        docMeta({ docId: "next", title: "Budget", folderId: "f-inner" }),
        docMeta({ docId: "top", title: "Roadmap", folderId: null }),
        docMeta({ docId: "aside", title: "Notes", folderId: "f-other" }),
      ],
      [folder("f-outer", "Projects"), folder("f-inner", "Launch", "f-outer"), folder("f-other", "Archive")],
    );
    const here = within(nav).getByRole("link", { name: "Launch plan" });
    expect(here.getAttribute("aria-current")).toBe("page");
    expect(here.getAttribute("href")).toBe("/d/here");
    expect(within(nav).getByRole("link", { name: "Budget" }).getAttribute("aria-current")).toBeNull();
    expect(within(nav).getByRole("button", { name: "Projects" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(nav).getByRole("button", { name: "Launch" }).getAttribute("aria-expanded")).toBe("true");
    // A folder the open document is not in stays shut until asked.
    expect(within(nav).getByRole("button", { name: "Archive" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(nav).queryByRole("link", { name: "Notes" })).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: "Archive" }));
    expect(within(nav).getByRole("link", { name: "Notes" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Roadmap" })).toBeTruthy();
  });

  it("a document in a folder you cannot open at the top, rather than nowhere", () => {
    const nav = open([docMeta({ docId: "theirs", title: "Their memo", folderId: "f-unseen", ownerEmail: "ana@example.com" })]);
    const tree = nav.querySelectorAll(".explorer-lists > ul.folder-tree:not(.folder-tree-head) a");
    expect([...tree].map((a) => a.textContent)).toEqual(["Their memo"]);
  });

  it("Shared with me: what other people own", () => {
    const nav = open([
      docMeta({ docId: "mine", title: "Mine" }),
      docMeta({ docId: "theirs", title: "Theirs", ownerEmail: "ana@example.com" }),
    ]);
    fireEvent.click(within(nav).getByRole("button", { name: "Shared with me" }));
    const shared = within(nav).getByRole("button", { name: "Shared with me" }).closest("li")!;
    expect(within(shared).getAllByRole("link").map((a) => a.textContent)).toEqual(["Theirs"]);
  });

  it("Recent: what you read in the last 30 days, newest first", async () => {
    const now = Date.now();
    state.reading.mockImplementation(async () => new Map([["old", now - 5_000], ["new", now - 1_000]]));
    const nav = open([
      docMeta({ docId: "old", title: "Read first" }),
      docMeta({ docId: "new", title: "Read last" }),
      docMeta({ docId: "never", title: "Never read" }),
    ]);
    await act(async () => {});
    const recent = within(nav).getByRole("button", { name: "Recent" }).closest("li")!;
    expect(within(recent).getAllByRole("link").map((a) => a.textContent)).toEqual(["Read last", "Read first"]);
    expect(state.reading).toHaveBeenCalledWith("u-me", 100);
  });

  it("a filter by title across every folder, and says when nothing matches", () => {
    const nav = open(
      [docMeta({ docId: "a", title: "Budget 2027", folderId: "f" }), docMeta({ docId: "b", title: "Roadmap" })],
      [folder("f", "Finance")],
    );
    const filter = within(nav).getByRole("searchbox", { name: "Filter your documents by title" });
    fireEvent.change(filter, { target: { value: "budget" } });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Budget 2027"]);
    fireEvent.change(filter, { target: { value: "zebra" } });
    expect(within(nav).queryAllByRole("link")).toEqual([]);
    expect(within(nav).getByText("No document has that in its title.")).toBeTruthy();
  });

  it("is subscribed to once, and not again for every document opened from it", () => {
    open([docMeta({ docId: "here", title: "Here" }), docMeta({ docId: "other", title: "Other" })]);
    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(state.subscriptions).toBe(1);
  });
});
