// SPDX-License-Identifier: Apache-2.0
// The explorer: remembered on the account as a column only, a drawer that never is, out of the way while editing (SPEC §13 "The explorer").

import { act, cleanup as cleanupMounted, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { DocMeta, FolderMeta, UserRecord } from "../types";

const state = vi.hoisted(() => ({
  auth: { user: { uid: "u-me" } as { uid: string } | null, emailLower: "me@example.com", gate: "ready" },
  compact: false,
  /** The account's first answer to the tab, and every account the tab asked. */
  record: null as ((record: Partial<UserRecord> | null) => void) | null,
  reads: [] as string[],
  /** Another tab or device changing the account later, reaching the same listener. */
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
  // The view choices take the account's record from its listener's first
  // answer (workspace/prefs.ts); later ones are another tab or device.
  watchUser: (uid: string, onData: (record: Partial<UserRecord> | null) => void) => {
    state.reads.push(uid);
    state.record = onData;
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
  // The hover card's line about the current version (components/UpdatedLine.tsx).
  formatRelative: () => "2 h ago",
  formatTimestamp: () => "23 Nov 2026, 12:00",
}));

import { ExplorerShell, EXPLORER_ID, useExplorer } from "./explorer";
import { EXPLORER_WIDTH, widthBounds } from "./explorerWidth";
import { RESIZE_SETTLE_MS, RESIZE_STEP, RESIZE_STEP_LARGE } from "../components/ExplorerResize";
import { CARD_DELAY_MS, EXPLORER_CARD_ID } from "../components/ExplorerCard";
import { personName } from "../people";
import { cacheKey, forgetViewChoices } from "../workspace/prefs";

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
  // Every test is a new tab in a browser that has never chosen.
  forgetViewChoices();
  window.localStorage.clear();
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

  it("draws the column on the first frame from this browser's copy, before the account answers", async () => {
    window.localStorage.setItem(cacheKey("u-me"), JSON.stringify({ explorerOpen: true }));
    mount();
    expect(state.firstOpen).toBe(true);
    expect(panel()).not.toBeNull();
    // The account is still the one it follows: closed there, closed here.
    await answer({ explorerOpen: false });
    expect(panel()).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(cacheKey("u-me"))!)).toEqual({ explorerOpen: false });
  });

  it("keeps the choice for this account only: another one on the same browser starts from its own", async () => {
    window.localStorage.setItem(cacheKey("u-me"), JSON.stringify({ explorerOpen: true }));
    state.auth = { user: { uid: "u-two" }, emailLower: "two@example.com", gate: "ready" };
    mount();
    expect(state.firstOpen).toBe(false);
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

/** jsdom has no PointerEvent: a MouseEvent carrying a pointer's id and kind is what React reads. */
function withPointerEvents() {
  beforeEach(() => {
    const had = (window as { PointerEvent?: unknown }).PointerEvent;
    class TestPointerEvent extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? "mouse";
      }
    }
    (window as { PointerEvent?: unknown }).PointerEvent = TestPointerEvent;
    onTestFinished(() => {
      (window as { PointerEvent?: unknown }).PointerEvent = had;
    });
  });
}

describe("the column's width", () => {
  withPointerEvents();

  const shell = () => document.querySelector<HTMLElement>(".viewer-shell")!;
  const drawn = () => shell().style.getPropertyValue("--explorer-width");
  const edge = () => screen.getByRole("separator", { name: "Resize the document list" });
  const widthWrites = () => state.save.mock.calls.map(([, , fields]) => fields).filter((f) => f.view?.explorerWidth !== undefined);
  const max = () => widthBounds(window.innerWidth).max;

  async function openColumn(record: Partial<UserRecord> = { explorerOpen: true }) {
    mount();
    await answer(record);
    expect(panel()).not.toBeNull();
  }

  it("is a separator on the column's edge that says how wide it is, and where it may go", async () => {
    await openColumn();
    expect(edge().getAttribute("aria-orientation")).toBe("vertical");
    expect(edge().getAttribute("aria-controls")).toBe(EXPLORER_ID);
    expect(edge().getAttribute("aria-valuenow")).toBe(String(EXPLORER_WIDTH.initial));
    expect(edge().getAttribute("aria-valuemin")).toBe(String(EXPLORER_WIDTH.min));
    expect(edge().getAttribute("aria-valuemax")).toBe(String(max()));
    expect(drawn()).toBe(`${EXPLORER_WIDTH.initial}px`);
  });

  it("starts at the width the account keeps, and reads one it does not understand as the default", async () => {
    await openColumn({ explorerOpen: true, view: { explorerWidth: 320 } });
    expect(drawn()).toBe("320px");
    forgetViewChoices();
    window.localStorage.clear();
    cleanupMounted();
    await openColumn({ explorerOpen: true, view: { explorerWidth: 9999 } });
    expect(drawn()).toBe(`${EXPLORER_WIDTH.initial}px`);
  });

  it("follows a drag, and keeps the width once, when the pointer comes up", async () => {
    await openColumn();
    fireEvent.pointerDown(edge(), { pointerId: 3, button: 0, clientX: 260 });
    expect(shell().hasAttribute("data-resizing")).toBe(true);
    fireEvent.pointerMove(edge(), { pointerId: 3, clientX: 300 });
    fireEvent.pointerMove(edge(), { pointerId: 3, clientX: 330 });
    expect(drawn()).toBe("330px");
    expect(edge().getAttribute("aria-valuenow")).toBe("330");
    expect(widthWrites()).toEqual([]);
    await act(async () => fireEvent.pointerUp(edge(), { pointerId: 3, clientX: 330 }));
    expect(shell().hasAttribute("data-resizing")).toBe(false);
    expect(widthWrites()).toEqual([{ view: { explorerWidth: 330 } }]);
    expect(drawn()).toBe("330px");
  });

  it("never drags past its bounds", async () => {
    await openColumn();
    fireEvent.pointerDown(edge(), { pointerId: 1, button: 0, clientX: 260 });
    fireEvent.pointerMove(edge(), { pointerId: 1, clientX: 5000 });
    expect(drawn()).toBe(`${max()}px`);
    fireEvent.pointerMove(edge(), { pointerId: 1, clientX: -5000 });
    expect(drawn()).toBe(`${EXPLORER_WIDTH.min}px`);
    await act(async () => fireEvent.pointerUp(edge(), { pointerId: 1 }));
    expect(widthWrites()).toEqual([{ view: { explorerWidth: EXPLORER_WIDTH.min } }]);
  });

  it("moves with the arrow keys, Home and End, and keeps the width once the keys pause", async () => {
    vi.useFakeTimers();
    await openColumn();
    fireEvent.keyDown(edge(), { key: "ArrowRight" });
    fireEvent.keyDown(edge(), { key: "ArrowRight", shiftKey: true });
    expect(drawn()).toBe(`${EXPLORER_WIDTH.initial + RESIZE_STEP + RESIZE_STEP_LARGE}px`);
    expect(widthWrites()).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESIZE_SETTLE_MS);
    });
    expect(widthWrites()).toEqual([{ view: { explorerWidth: EXPLORER_WIDTH.initial + RESIZE_STEP + RESIZE_STEP_LARGE } }]);
    fireEvent.keyDown(edge(), { key: "Home" });
    expect(drawn()).toBe(`${EXPLORER_WIDTH.min}px`);
    fireEvent.keyDown(edge(), { key: "End" });
    expect(drawn()).toBe(`${max()}px`);
    fireEvent.keyDown(edge(), { key: "ArrowLeft" });
    expect(drawn()).toBe(`${max() - RESIZE_STEP}px`);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESIZE_SETTLE_MS);
    });
    expect(widthWrites().at(-1)).toEqual({ view: { explorerWidth: max() - RESIZE_STEP } });
    expect(widthWrites()).toHaveLength(2);
  });

  it("goes back to where it starts on Enter or a double click", async () => {
    await openColumn({ explorerOpen: true, view: { explorerWidth: 400 } });
    await act(async () => fireEvent.keyDown(edge(), { key: "Enter" }));
    expect(drawn()).toBe(`${EXPLORER_WIDTH.initial}px`);
    fireEvent.pointerDown(edge(), { pointerId: 2, button: 0, clientX: 260 });
    fireEvent.pointerMove(edge(), { pointerId: 2, clientX: 340 });
    await act(async () => fireEvent.pointerUp(edge(), { pointerId: 2 }));
    expect(drawn()).toBe("340px");
    await act(async () => fireEvent.doubleClick(edge()));
    expect(drawn()).toBe(`${EXPLORER_WIDTH.initial}px`);
    expect(widthWrites().at(-1)).toEqual({ view: { explorerWidth: EXPLORER_WIDTH.initial } });
  });

  it("is not on a drawer, whose width is its own", async () => {
    state.compact = true;
    mount();
    fireEvent.click(toggle());
    expect(panel()?.getAttribute("data-drawer")).toBe("open");
    expect(screen.queryByRole("separator")).toBeNull();
    expect(drawn()).toBe("");
  });

  it("leaves the page selectable and the frame reachable when the column goes mid-drag, and when it comes back", async () => {
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
    const { rerender } = mount();
    await answer({ explorerOpen: true });
    fireEvent.pointerDown(edge(), { pointerId: 4, button: 0, clientX: 260 });
    expect(shell().hasAttribute("data-resizing")).toBe(true);
    // The reader starts to edit: the explorer steps aside with the drag still held.
    rerender(tree(true));
    expect(panel()).toBeNull();
    expect(shell().hasAttribute("data-resizing")).toBe(false);
    // And stops: the column is back, with no drag left behind on it.
    rerender(tree(false));
    expect(panel()).not.toBeNull();
    expect(shell().hasAttribute("data-resizing")).toBe(false);
  });
});

describe("the card for a name that does not fit", () => {
  withPointerEvents();

  const NOW = Date.now();
  const card = () => document.getElementById(EXPLORER_CARD_ID);
  const link = (name: string) => within(panel()!).getAllByRole("link", { name })[0];
  /** The row's name drawn wider than its box, as an ellipsis draws it. */
  const cutOff = (el: HTMLElement) => {
    const name = el.querySelector(".folder-name")!;
    Object.defineProperty(name, "scrollWidth", { configurable: true, value: 300 });
    Object.defineProperty(name, "clientWidth", { configurable: true, value: 120 });
  };

  async function openWith(docs: DocMeta[], folders: FolderMeta[] = FOLDERS) {
    vi.useFakeTimers();
    mount();
    await answer({ explorerOpen: true });
    act(() => {
      state.folders!(folders);
      state.docs!(docs);
    });
  }
  const rest = (ms = CARD_DELAY_MS) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

  const LONG = "Launch plan for the second half, with every market and its owner named";
  const filed = (over: Partial<DocMeta> = {}) =>
    docMeta({
      docId: "here",
      title: LONG,
      folderId: "f-inner",
      thumb: { versionId: "v1", cover: "k1" } as DocMeta["thumb"],
      stats: { views: 12 } as DocMeta["stats"],
      latest: { version: "v1", at: NOW - 7_200_000, words: 1200 } as unknown as DocMeta["latest"],
      currentVersion: "v1",
      ...over,
    });

  it("opens a moment after a pointer rests on a row whose name is cut off, with all a card says", async () => {
    await openWith([filed()]);
    const row = link(LONG);
    cutOff(row);
    fireEvent.pointerEnter(row, { pointerType: "mouse" });
    await rest(CARD_DELAY_MS - 50);
    expect(card()).toBeNull();
    await rest(50);
    const c = card()!;
    expect(c.getAttribute("role")).toBe("tooltip");
    expect(row.getAttribute("aria-describedby")).toBe(EXPLORER_CARD_ID);
    // No native tooltip on the row as well, to cover this one.
    expect(row.hasAttribute("title")).toBe(false);
    expect(c.querySelector(".explorer-card-title")?.textContent).toBe(LONG);
    expect(c.querySelector("img")?.getAttribute("src")).toContain("/thumb/here/v1/k1/cover.jpg");
    const text = c.textContent ?? "";
    expect(text).toContain("You");
    expect(text).toContain("Projects / Launch");
    expect(text).toContain("Private");
    // The workspace card's words, kept apart as it keeps them: "6 min read · Updated 2 h ago".
    expect(text).toMatch(/\d+ min read·Updated 2 h ago/);
    expect(text).toContain("Read 12 times");
  });

  it("names another owner, the folder's reach and an unreadable folder as the workspace does", async () => {
    const reaching = { ...folder("f-pub", "Press"), reach: [{ visibility: "public", expiresAt: null }] } as unknown as FolderMeta;
    await openWith(
      [
        filed({ docId: "a", title: `${LONG} A`, ownerUid: "u-ana", ownerEmail: "ana@example.com", folderId: "f-pub" }),
        filed({ docId: "b", title: `${LONG} B`, ownerUid: "u-ana", ownerEmail: "ana@example.com", folderId: "f-unseen", visibility: "unlisted" }),
      ],
      [reaching],
    );
    fireEvent.click(within(panel()!).getByRole("button", { name: "Press" }));
    cutOff(link(`${LONG} A`));
    fireEvent.pointerEnter(link(`${LONG} A`));
    await rest();
    expect(card()!.textContent).toContain(personName({ uid: "u-ana", email: "ana@example.com" }));
    expect(card()!.textContent).toContain("Press");
    expect(card()!.textContent).toContain("Public");
    expect(card()!.textContent).not.toContain("You");
    fireEvent.pointerLeave(link(`${LONG} A`));
    await rest(500);
    cutOff(link(`${LONG} B`));
    fireEvent.pointerEnter(link(`${LONG} B`));
    await rest();
    expect(card()!.textContent).toContain("A folder you can't open");
    expect(card()!.textContent).toContain("Link");
  });

  it("says when an agent published the current version, as a word and not a button", async () => {
    await openWith([filed({ latest: { version: "v1", at: NOW - 60_000, words: 300, channel: "mcp", via: "claude" } as unknown as DocMeta["latest"] })]);
    cutOff(link(LONG));
    fireEvent.pointerEnter(link(LONG));
    await rest();
    expect(card()!.querySelector(".badge-automated")?.textContent).toBe("agent");
    // A tooltip holds nothing that takes a focus or a click.
    expect(card()!.querySelectorAll("button, a, input, [tabindex]")).toHaveLength(0);
  });

  it("shows no cover for somebody else's document once it has expired", async () => {
    await openWith([filed({ ownerUid: "u-ana", ownerEmail: "ana@example.com", expiresAt: NOW - 1000 as never })]);
    cutOff(link(LONG));
    fireEvent.pointerEnter(link(LONG));
    await rest();
    expect(card()).not.toBeNull();
    expect(card()!.querySelector("img")).toBeNull();
  });

  it("does not open for a name that fits, nor for a touch", async () => {
    await openWith([filed({ title: "Short" }), filed({ docId: "t", title: LONG, folderId: null })]);
    fireEvent.pointerEnter(link("Short"));
    await rest(2000);
    expect(card()).toBeNull();
    cutOff(link(LONG));
    fireEvent.pointerEnter(link(LONG), { pointerType: "touch" });
    await rest(2000);
    expect(card()).toBeNull();
  });

  it("opens at once on keyboard focus, and goes on blur", async () => {
    await openWith([filed()]);
    cutOff(link(LONG));
    act(() => link(LONG).focus());
    expect(card()).not.toBeNull();
    act(() => link(LONG).blur());
    await rest(500);
    expect(card()).toBeNull();
    expect(link(LONG).hasAttribute("aria-describedby")).toBe(false);
  });

  it("lets the pointer cross onto it, and goes once the pointer leaves both", async () => {
    await openWith([filed()]);
    cutOff(link(LONG));
    fireEvent.pointerEnter(link(LONG));
    await rest();
    fireEvent.pointerLeave(link(LONG));
    fireEvent.pointerEnter(card()!);
    await rest(1000);
    expect(card()).not.toBeNull();
    fireEvent.pointerLeave(card()!);
    expect(card()).toBeNull();
  });

  it("goes on Escape wherever the focus is, and a drawer it came from stays open", async () => {
    vi.useFakeTimers();
    state.compact = true;
    mount();
    fireEvent.click(toggle());
    act(() => {
      state.folders!(FOLDERS);
      state.docs!([filed()]);
    });
    cutOff(link(LONG));
    fireEvent.pointerEnter(link(LONG));
    await rest();
    expect(card()).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(card()).toBeNull();
    expect(panel()).not.toBeNull();
    // With no card up, Escape is the drawer's again.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(panel()).toBeNull();
  });

  it("goes when the list scrolls or another document opens", async () => {
    await openWith([filed(), docMeta({ docId: "other", title: "Elsewhere doc", folderId: "f-away" })]);
    cutOff(link(LONG));
    fireEvent.pointerEnter(link(LONG));
    await rest();
    fireEvent.scroll(panel()!.querySelector(".explorer-lists")!);
    expect(card()).toBeNull();
    fireEvent.pointerEnter(link(LONG));
    await rest();
    expect(card()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(card()).toBeNull();
  });
});
