// SPDX-License-Identifier: Apache-2.0
// The explorer: remembered on the account as a column only, a drawer that never is, out of the way while editing (SPEC §13 "The explorer").

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { DocMeta, FolderMeta, UserRecord } from "../types";

const state = vi.hoisted(() => ({
  auth: { user: { uid: "u-me" } as { uid: string } | null, emailLower: "me@example.com", gate: "ready" },
  compact: false,
  /** The account's answer to the tab's one read, and the reads it was asked for. */
  record: null as ((record: Partial<UserRecord> | null) => void) | null,
  reads: [] as string[],
  /** Another tab or device changing the account, reaching any live listener on it. */
  snapshot: null as ((record: Partial<UserRecord> | null) => void) | null,
  /** Whether the viewer saw the explorer open on its very first render. */
  firstOpen: undefined as boolean | undefined,
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
  readUser: (uid: string) => {
    state.reads.push(uid);
    return new Promise<Partial<UserRecord> | null>((resolve) => {
      state.record = resolve;
    });
  },
  watchUser: (_uid: string, onData: (record: Partial<UserRecord> | null) => void) => {
    state.snapshot = onData;
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

import { ExplorerShell, EXPLORER_ID, forgetTabChoice, useExplorer } from "./explorer";

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
  if (state.firstOpen === undefined) state.firstOpen = explorer.open;
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
  state.firstOpen = undefined;
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
/** The account answers the tab's one read. */
const answer = (record: Partial<UserRecord> | null) =>
  act(async () => {
    state.record!(record);
  });
const panel = () => document.getElementById(EXPLORER_ID);

/** The open document is in Launch, inside Projects; Archive and Elsewhere's folder are beside them. */
const FOLDERS = [
  folder("f-outer", "Projects"),
  folder("f-inner", "Launch", "f-outer"),
  folder("f-other", "Archive"),
  folder("f-away", "Away"),
];
const DOCS = [
  docMeta({ docId: "here", title: "Launch plan", folderId: "f-inner" }),
  docMeta({ docId: "aside", title: "Notes", folderId: "f-other" }),
  docMeta({ docId: "other", title: "Elsewhere doc", folderId: "f-away" }),
];

/** The names of every section and folder drawn open, alphabetically. */
function expandedIn(nav: HTMLElement) {
  return [...nav.querySelectorAll('button[aria-expanded="true"]')].map((b) => b.textContent ?? "").sort();
}

beforeEach(() => {
  state.auth = { user: { uid: "u-me" }, emailLower: "me@example.com", gate: "ready" };
  state.compact = false;
  state.record = null;
  state.reads = [];
  state.snapshot = null;
  forgetTabChoice();
  state.docs = null;
  state.folders = null;
  state.subscriptions = 0;
  state.save.mockReset();
  state.save.mockImplementation(async () => {});
  state.reading.mockReset();
  state.reading.mockImplementation(async () => new Map());
});

describe("the explorer's toggle", () => {
  it("is not offered to a reader who is not signed in", async () => {
    state.auth = { user: null, emailLower: "", gate: "signed_out" };
    mount();
    expect(screen.getByText("No toggle")).toBeTruthy();
    expect(panel()).toBeNull();
  });

  it("is closed until the account says otherwise, and opens from there on a new device", async () => {
    mount();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();
    await answer({ explorerOpen: true });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(panel()).not.toBeNull();
    // Opened by the account, not by a click: focus is left where it was.
    expect(document.activeElement).toBe(document.body);
  });

  it("writes open and closed to the account where it is a column", async () => {
    mount();
    await answer({});
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
    await answer({});
    await act(async () => fireEvent.click(toggle()));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the drawer, at 1100px and below", () => {
  it("starts closed whatever the account remembers, and never writes to it", async () => {
    state.compact = true;
    mount();
    await answer({ explorerOpen: true });
    expect(panel()).toBeNull();
    fireEvent.click(toggle());
    expect(panel()?.getAttribute("data-drawer")).toBe("open");
    fireEvent.click(toggle());
    expect(panel()).toBeNull();
    expect(state.save).not.toHaveBeenCalled();
  });

  it("closes on Escape and on the scrim, and gives focus back to the toggle", async () => {
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

  it("closes once the reader has gone where they opened it to go", async () => {
    state.compact = true;
    mount();
    fireEvent.click(toggle());
    expect(panel()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(panel()).toBeNull();
  });
});

describe("while the reader edits", () => {
  it("steps aside, toggle and all, and comes back as it was", async () => {
    const { rerender } = mount();
    await answer({ explorerOpen: true });
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
    act(() => {
      state.folders!(FOLDERS);
      state.docs!(DOCS);
    });
    fireEvent.click(within(panel()!).getByRole("button", { name: "Archive" }));
    rerender(tree(true));
    expect(screen.getByText("No toggle")).toBeTruthy();
    expect(panel()).toBeNull();
    rerender(tree(false));
    expect(panel()).not.toBeNull();
    // Coming back is not somebody opening it: no focus taken, and what was open still is.
    expect(document.activeElement).toBe(document.body);
    expect(expandedIn(panel()!)).toEqual(["Archive", "Launch", "Projects"]);
  });
});

describe("what it lists", () => {
  async function open(docs: DocMeta[], folders: FolderMeta[] = []) {
    mount();
    await answer({ explorerOpen: true });
    act(() => {
      state.folders!(folders);
      state.docs!(docs);
    });
    return panel()!;
  }

  it("the folders with their documents, opened down to the one being read, which is marked", async () => {
    const nav = await open(
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
    // A folder the open document is not in stays shut until asked, and so do Recent and Shared with me.
    expect(within(nav).getByRole("button", { name: "Archive" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(nav).getByRole("button", { name: "Recent" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(nav).getByRole("button", { name: "Shared with me" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(nav).queryByRole("link", { name: "Notes" })).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: "Archive" }));
    expect(within(nav).getByRole("link", { name: "Notes" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Roadmap" })).toBeTruthy();
  });

  it("a document in a folder you cannot open at the top, rather than nowhere", async () => {
    const nav = await open([docMeta({ docId: "theirs", title: "Their memo", folderId: "f-unseen", ownerEmail: "ana@example.com" })]);
    const tree = nav.querySelectorAll(".explorer-lists > ul.folder-tree:not(.folder-tree-head) a");
    expect([...tree].map((a) => a.textContent)).toEqual(["Their memo"]);
  });

  it("Shared with me: what other people own", async () => {
    const nav = await open([
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
    const nav = await open([
      docMeta({ docId: "old", title: "Read first" }),
      docMeta({ docId: "new", title: "Read last" }),
      docMeta({ docId: "never", title: "Never read" }),
    ]);
    await act(async () => {});
    fireEvent.click(within(nav).getByRole("button", { name: "Recent" }));
    const recent = within(nav).getByRole("button", { name: "Recent" }).closest("li")!;
    expect(within(recent).getAllByRole("link").map((a) => a.textContent)).toEqual(["Read last", "Read first"]);
    expect(state.reading).toHaveBeenCalledWith("u-me", 100);
  });

  it("a filter by title across every folder, and says when nothing matches", async () => {
    const nav = await open(
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

  it("is subscribed to once, and not again for every document opened from it", async () => {
    await open([docMeta({ docId: "here", title: "Here" }), docMeta({ docId: "other", title: "Other" })]);
    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(state.subscriptions).toBe(1);
  });
});

describe("each opening starts from the open document", () => {
  const land = () =>
    act(() => {
      state.folders!(FOLDERS);
      state.docs!(DOCS);
    });

  it("as a column: Recent and folders opened by hand are shut again, the way down to it is open", async () => {
    mount();
    await answer({});
    fireEvent.click(toggle());
    land();
    expect(expandedIn(panel()!)).toEqual(["Launch", "Projects"]);
    fireEvent.click(within(panel()!).getByRole("button", { name: "Recent" }));
    fireEvent.click(within(panel()!).getByRole("button", { name: "Archive" }));
    fireEvent.click(within(panel()!).getByRole("button", { name: "Launch" }));
    expect(expandedIn(panel()!)).toEqual(["Archive", "Projects", "Recent"]);
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(expandedIn(panel()!)).toEqual(["Launch", "Projects"]);
  });

  it("as a drawer: the same every time it opens", async () => {
    state.compact = true;
    mount();
    fireEvent.click(toggle());
    land();
    fireEvent.click(within(panel()!).getByRole("button", { name: "Recent" }));
    fireEvent.click(within(panel()!).getByRole("button", { name: "Archive" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Close the document list" })[0]);
    fireEvent.click(toggle());
    expect(expandedIn(panel()!)).toEqual(["Launch", "Projects"]);
  });

  it("switching documents while it stays open keeps what was opened and opens the way to the new one", async () => {
    mount();
    await answer({ explorerOpen: true });
    land();
    fireEvent.click(within(panel()!).getByRole("button", { name: "Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(expandedIn(panel()!)).toEqual(["Archive", "Away", "Launch", "Projects"]);
    expect(within(panel()!).getByRole("link", { name: "Elsewhere doc" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps a filter typed before it was shut", async () => {
    mount();
    await answer({ explorerOpen: true });
    land();
    const filter = () => screen.getByRole("searchbox", { name: "Filter your documents by title" }) as HTMLInputElement;
    fireEvent.change(filter(), { target: { value: "notes" } });
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(filter().value).toBe("notes");
    expect(within(panel()!).getAllByRole("link").map((a) => a.textContent)).toEqual(["Notes"]);
    fireEvent.change(filter(), { target: { value: "" } });
    expect(expandedIn(panel()!)).toEqual(["Launch", "Projects"]);
  });

  /** jsdom has no scrollIntoView: record what would have been brought into view. */
  function watchScrolls() {
    const scrolled: Element[] = [];
    const had = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    onTestFinished(() => {
      if (had) Object.defineProperty(Element.prototype, "scrollIntoView", had);
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    });
    return scrolled;
  }

  it("brings a document two folders down into view the first time the lists land", async () => {
    const scrolled = watchScrolls();
    mount();
    await answer({ explorerOpen: true });
    land();
    expect(scrolled.map((el) => el.textContent)).toEqual(["Launch plan"]);
  });

  it("brings the open document into view where it is in the tree, not at the top of Recent", async () => {
    const scrolled = watchScrolls();
    const now = Date.now();
    state.reading.mockImplementation(async () => new Map([["here", now - 2_000], ["other", now - 1_000]]));
    mount();
    await answer({ explorerOpen: true });
    land();
    await act(async () => {});
    fireEvent.click(within(panel()!).getByRole("button", { name: "Recent" }));
    scrolled.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    await act(async () => {});
    // Recent lists it first, above the tree.
    expect(within(panel()!).getAllByRole("link", { name: "Elsewhere doc" })).toHaveLength(2);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0].closest(".explorer-tree")).not.toBeNull();
    expect(scrolled[0].textContent).toBe("Elsewhere doc");
  });
});

describe("each tab keeps its own, read from the account once", () => {
  it("a change on the account from another tab or device leaves a page already open alone", async () => {
    mount();
    await answer({ explorerOpen: false });
    act(() => state.snapshot?.({ explorerOpen: true }));
    expect(panel()).toBeNull();
    expect(state.reads).toEqual(["u-me"]);
  });

  it("leaving the viewer and coming back keeps the tab's own choice, without asking the account again", async () => {
    const first = mount();
    await answer({ explorerOpen: true });
    fireEvent.click(toggle());
    first.unmount();
    const second = mount();
    expect(panel()).toBeNull();
    fireEvent.click(toggle());
    second.unmount();
    mount();
    // Open from the first render: no closed frame before it.
    expect(state.firstOpen).toBe(true);
    expect(panel()).not.toBeNull();
    expect(state.reads).toEqual(["u-me"]);
  });

  it("a press of the toggle before the account answers stands", async () => {
    mount();
    fireEvent.click(toggle());
    await answer({ explorerOpen: false });
    expect(panel()).not.toBeNull();
  });

  it("somebody else signing in on the tab reads their own account", async () => {
    const first = mount();
    await answer({ explorerOpen: true });
    first.unmount();
    state.auth = { user: { uid: "u-two" }, emailLower: "two@example.com", gate: "ready" };
    mount();
    expect(state.reads).toEqual(["u-me", "u-two"]);
    await answer({});
    expect(panel()).toBeNull();
  });

  it("a refused write is undone in what the tab remembers too", async () => {
    state.save.mockImplementation(async () => {
      throw new Error("refused");
    });
    const first = mount();
    await answer({});
    await act(async () => fireEvent.click(toggle()));
    first.unmount();
    mount();
    expect(panel()).toBeNull();
    expect(state.reads).toEqual(["u-me"]);
  });
});
