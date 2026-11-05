// SPDX-License-Identifier: Apache-2.0
// The workspace never calls itself empty while it is still loading, and says when it is busy (SPEC §5, §13).

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DocMeta, FolderMeta } from "../types";

/**
 * The listeners are captured rather than answered, so each test decides which
 * snapshot has landed — the order is the whole point, since the two arrive
 * independently and either can be first.
 */
const { listeners, createFolder, forkDoc, uploadDoc, reading } = vi.hoisted(() => ({
  listeners: {
    docs: null as ((docs: DocMeta[]) => void) | null,
    folders: null as ((folders: FolderMeta[]) => void) | null,
  },
  createFolder: vi.fn(),
  forkDoc: vi.fn(),
  uploadDoc: vi.fn(async () => ({ docId: "new", title: "From the document", format: "html" })),
  /** Your own reads, as Recent asks for them: docId → last read. */
  reading: vi.fn(async (_uid: string, _max: number) => new Map<string, number>()),
}));

vi.mock("../firebase", () => ({ auth: {}, db: {}, rtdb: null }));
vi.mock("../auth", () => ({
  useAuth: () => ({ user: { uid: "u1" }, emailLower: "me@example.com" }),
}));
vi.mock("../firestore", () => ({
  formatRelative: () => "just now",
  formatTimestamp: () => "29 Oct 2026, 12:00",
  listMyDocs: (_email: string, onData: (docs: DocMeta[]) => void) => {
    listeners.docs = onData;
    return () => {};
  },
  listMyFolders: (_email: string, onData: (folders: FolderMeta[]) => void) => {
    listeners.folders = onData;
    return () => {};
  },
  listMyTeams: () => () => {},
  listMyReading: (uid: string, max: number) => reading(uid, max),
  watchUser: () => () => {},
}));
const { trashItem, restoreItem, inheritedFolderAccess } = vi.hoisted(() => ({
  trashItem: vi.fn(async () => ({ ok: true, batch: "b1" })),
  restoreItem: vi.fn(async () => ({ ok: true })),
  inheritedFolderAccess: vi.fn(async () => ({ grants: [], reach: [] })),
}));
vi.mock("../folders", () => ({
  createFolder,
  trashItem,
  restoreItem,
  inheritedFolderAccess,
  renameItem: vi.fn(),
  moveItem: vi.fn(),
  setFolderAccess: vi.fn(),
}));
vi.mock("../forks", () => ({ forkDoc }));
vi.mock("../upload", async () => ({ ...await vi.importActual<typeof import("../upload")>("../upload"), uploadDoc }));
vi.mock("../analytics", () => ({ logEvent: vi.fn() }));
const { backfill } = vi.hoisted(() => ({ backfill: vi.fn() }));
vi.mock("../hooks/useCoverBackfill", () => ({ useCoverBackfill: backfill }));
vi.mock("./SharedFolder", () => ({ SharedFolder: () => <p>SHARED FOLDER</p> }));

import { DocList } from "./DocList";
import { ToastProvider } from "../components/Toast";

function mount(view?: "recent" | "everything" | "shared") {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <DocList view={view} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** The workspace opened on a path, with Everything there to be navigated up to. */
function mountAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Routes>
          <Route path="/folder/:folderId" element={<DocList />} />
          <Route path="/everything" element={<p>EVERYTHING</p>} />
          <Route path="/" element={<p>RECENT</p>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function folderMeta(overrides: Partial<FolderMeta> = {}): FolderMeta {
  return {
    folderId: "plans", name: "Plans", parentId: null, ancestors: [], depth: 0,
    ownerEmail: "me@example.com", members: ["me@example.com"], viewers: [], editors: [],
    ...overrides,
  } as unknown as FolderMeta;
}

const EMPTY = /Nothing here yet/;

beforeEach(() => {
  // The workspace remembers its sort and layout in this browser; each test
  // starts from a browser that has never chosen.
  window.localStorage.clear();
  listeners.docs = null;
  listeners.folders = null;
  createFolder.mockReset();
  forkDoc.mockReset();
  uploadDoc.mockClear();
  trashItem.mockClear();
  restoreItem.mockClear();
  reading.mockReset();
  reading.mockImplementation(async () => new Map<string, number>());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the workspace while it loads", () => {
  it("keeps the skeletons up until folders have arrived too", () => {
    // Documents first, folders still in flight: a workspace holding only
    // folders would otherwise be announced as empty.
    const { container } = mount();

    act(() => listeners.docs!([]));

    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(container.querySelector(".skeleton")).not.toBeNull();

    act(() => listeners.folders!([]));

    expect(screen.queryByText(EMPTY)).not.toBeNull();
    expect(container.querySelector(".skeleton")).toBeNull();
  });
});

describe("creating a folder", () => {
  it("says it is working, and cannot be started twice", async () => {
    vi.stubGlobal("prompt", () => "Plans");
    let finish!: () => void;
    createFolder.mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve({ folderId: "f1", name: "Plans" });
      }),
    );
    mount();
    const button = screen.getByRole("button", { name: "Folder" }) as HTMLButtonElement;

    fireEvent.click(button);
    fireEvent.click(button);

    expect(createFolder).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(true);

    await act(async () => finish());

    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(button.disabled).toBe(false);
  });

  it("does nothing, and shows nothing, when the prompt is cancelled", () => {
    vi.stubGlobal("prompt", () => null);
    mount();
    const button = screen.getByRole("button", { name: "Folder" });

    fireEvent.click(button);

    expect(createFolder).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-busy")).toBe("false");
  });
});

function docMeta(overrides: Partial<DocMeta> = {}): DocMeta {
  return {
    docId: "q3-plan",
    title: "Q3 plan",
    slug: "q3-plan",
    ownerUid: "u-ana",
    ownerEmail: "ana@example.com",
    currentVersion: "v4",
    viewers: ["me@example.com"],
    editors: [],
    members: ["ana@example.com", "me@example.com"],
    createdAt: null as never,
    updatedAt: null as never,
    ...overrides,
  };
}

describe("a document's way to the Trash", () => {
  it("is its owner's, one click with no question, and Undo brings it back", async () => {
    mount();
    act(() => listeners.folders!([]));
    act(() => listeners.docs!([docMeta({ ownerEmail: "me@example.com", ownerUid: "u-me" })]));
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Move to Trash" })));
    expect(trashItem).toHaveBeenCalledWith("doc", "q3-plan");
    expect(await screen.findByText("“Q3 plan” is in the Trash.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    expect(restoreItem).toHaveBeenCalledWith("doc", "q3-plan");
  });

  it("is offered to nobody else, disabled with the owner's name", () => {
    mount();
    act(() => listeners.folders!([]));
    act(() => listeners.docs!([docMeta()]));
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    const item = screen.getByRole("menuitem", { name: "Move to Trash" }) as HTMLButtonElement;
    expect([item.disabled, item.title]).toEqual([true, "Only ana@example.com can move this to the Trash."]);
  });

  it("Move… is the owner's too, because moving a document changes who can read it", () => {
    mount();
    act(() => listeners.folders!([]));
    act(() => listeners.docs!([docMeta()]));
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    const item = screen.getByRole("menuitem", { name: "Move…" }) as HTMLButtonElement;
    expect([item.disabled, item.title]).toEqual([true, "Only ana@example.com can move this: moving it changes who can read it."]);
  });
});

describe("forking from the workspace", () => {
  it("is one click, into the folder being looked at", async () => {
    forkDoc.mockResolvedValue({ docId: "q3-plan-x7k2p9", versionId: "v1", title: "Q3 plan" });
    mount();
    act(() => listeners.folders!([]));
    act(() => listeners.docs!([docMeta()]));

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.queryByRole("menuitem", { name: "Duplicate" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Fork" })));

    expect(forkDoc).toHaveBeenCalledTimes(1);
    expect(forkDoc).toHaveBeenCalledWith("q3-plan", { folderId: null });
  });

  it("marks a fork, and counts the forks of an original", () => {
    mount();
    act(() => listeners.folders!([]));
    act(() =>
      listeners.docs!([
        docMeta({ docId: "fork", forked: true }),
        docMeta({ docId: "original", stats: { forks: 3 } as DocMeta["stats"] }),
        docMeta({ docId: "plain" }),
      ]),
    );

    expect(screen.getAllByTitle("Forked from another document")).toHaveLength(1);
    expect(screen.getByTitle("Forked 3 times").textContent).toContain("3");
  });
});

describe("each document's cover", () => {
  const KEY = "0123456789abcdef";
  const PAST = Date.now() - 60_000;
  const cards = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>(".doc-card")).filter((card) =>
      card.querySelector('a.doc-card-title[href^="/d/"]'),
    );
  const coverOf = (card: HTMLElement) => card.querySelector<HTMLImageElement>(".doc-card-thumb img");

  it("shows the stored image of whichever version it was captured from", () => {
    // The head moves on before an editor captures it again; the old cover is a
    // better picture of the document than none.
    const { container } = mount();
    act(() => listeners.folders!([]));
    act(() =>
      listeners.docs!([docMeta({ currentVersion: "v4", thumb: { versionId: "v3", cover: KEY } })]),
    );

    const img = coverOf(cards(container)[0])!;
    expect(img.getAttribute("src")).toBe(`/thumb/q3-plan/v3/${KEY}/cover.jpg`);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("alt")).toBe("");
  });

  it("opens the document, without being a second stop for the keyboard or a screen reader", () => {
    const { container } = mount();
    act(() => listeners.folders!([]));
    act(() => listeners.docs!([docMeta({ thumb: { versionId: "v4", cover: KEY } })]));

    const link = cards(container)[0].querySelector<HTMLAnchorElement>("a.doc-card-thumb")!;
    expect(link.getAttribute("href")).toBe("/d/q3-plan");
    expect(link.tabIndex).toBe(-1);
    expect(link.getAttribute("aria-hidden")).toBe("true");
  });

  it("stands a plain placeholder in for a document nobody has captured yet", () => {
    const { container } = mount();
    act(() => listeners.folders!([]));
    act(() => listeners.docs!([docMeta()]));

    const card = cards(container)[0];
    expect(card.querySelector(".doc-card-thumb")).not.toBeNull();
    expect(coverOf(card)).toBeNull();
  });

  it("shows an expired document's cover to its owner, and to nobody else", () => {
    // Expired is visible only to the owner (SPEC §17). The server refuses
    // everyone else; the card must not even ask.
    const { container } = mount();
    act(() => listeners.folders!([]));
    act(() =>
      listeners.docs!([
        docMeta({ docId: "theirs", title: "Theirs", expiresAt: PAST, thumb: { versionId: "v4", cover: KEY } }),
        docMeta({
          docId: "mine",
          title: "Mine",
          ownerEmail: "me@example.com",
          expiresAt: PAST,
          thumb: { versionId: "v4", cover: KEY },
        }),
      ]),
    );

    const card = (title: string) =>
      cards(container).find((c) => c.querySelector(".doc-card-title")?.textContent === title)!;
    expect(coverOf(card("Theirs"))).toBeNull();
    expect(coverOf(card("Mine"))?.getAttribute("src")).toBe(`/thumb/mine/v4/${KEY}/cover.jpg`);
  });

  it("keeps folders in a grid of their own, above the documents", () => {
    // A folder card has no cover. Sharing a row with documents that do, it
    // would stretch to their height and stand mostly empty.
    const { container } = mount();
    act(() =>
      listeners.folders!([
        { folderId: "f1", name: "Plans", ownerEmail: "me@example.com", members: ["me@example.com"] } as never,
      ]),
    );
    act(() => listeners.docs!([docMeta({ folderId: null })]));

    const grids = Array.from(container.querySelectorAll(".doc-grid"));
    expect(grids).toHaveLength(2);
    expect(grids[0].querySelector(".doc-card-thumb")).toBeNull();
    expect(grids[0].textContent).toContain("Plans");
    expect(grids[1].querySelector(".doc-card-thumb")).not.toBeNull();
  });
});

describe("filling in missing covers", () => {
  it("hands the documents on screen, and who is looking, to the backfill", () => {
    // Only the cards this view shows: a folder's documents, not the whole
    // workspace, and the account whose edit rights decide what may be stored.
    mount();
    act(() => listeners.folders!([]));
    act(() =>
      listeners.docs!([docMeta({ docId: "here", folderId: null }), docMeta({ docId: "elsewhere", folderId: "f9" })]),
    );

    const [docs, email] = backfill.mock.calls[backfill.mock.calls.length - 1];
    expect((docs as DocMeta[]).map((d) => d.docId)).toEqual(["here"]);
    expect(email).toBe("me@example.com");
  });
});

describe("uploading a new version from the workspace", () => {
  it("is offered to an editor, and opens on the version current now", async () => {
    mount();
    act(() => listeners.folders!([]));
    act(() => listeners.docs!([docMeta({ editors: ["me@example.com"], editorMembers: ["me@example.com"] })]));

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Upload a new version…" })));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("next version of Q3 plan, after v4");
    // The list is live: somebody publishing while the dialog is open shows.
    act(() =>
      listeners.docs!([docMeta({ editors: ["me@example.com"], editorMembers: ["me@example.com"], currentVersion: "v5" })]),
    );
    expect(screen.getByRole("status").textContent).toContain("v5 was published while this was open");
  });

  it("is not offered to somebody who may only read it", () => {
    mount();
    act(() => listeners.folders!([]));
    act(() => listeners.docs!([docMeta()]));

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.queryByRole("menuitem", { name: "Upload a new version…" })).toBeNull();
  });
});


describe("dropping a new document", () => {
  it("leaves title and address absent so document metadata controls both", async () => {
    const { container } = mount();
    act(() => { listeners.docs!([]); listeners.folders!([]); });
    const file = new File(["<title>Quarterly review</title>"], "q3.html", { type: "text/html" });
    fireEvent.drop(container.querySelector(".workspace-main")!, { dataTransfer: { types: ["Files"], files: [file] } });
    await waitFor(() => expect(uploadDoc).toHaveBeenCalledTimes(1));
    const [actual, options] = uploadDoc.mock.calls[0] as unknown as [File, { title?: string; id?: string; folderId?: string }];
    expect(actual).toBe(file);
    expect(options.title).toBeUndefined();
    expect(options.id).toBeUndefined();
    expect(options.folderId).toBeNull();
  });
});

describe("a folder this account is not a member of", () => {
  it("is handed to the shared-folder page once its folders have arrived, and never before", () => {
    // Before the folders land, every folder looks foreign; deciding then would
    // send a member to the stranger's page for one frame.
    mountAt("/folder/theirs?k=key");
    expect(screen.queryByText("SHARED FOLDER")).toBeNull();
    act(() => listeners.docs?.([]));
    act(() => listeners.folders?.([]));
    expect(screen.getByText("SHARED FOLDER")).toBeTruthy();
  });

  it("is the workspace for a member, whatever key the URL carries", () => {
    mountAt("/folder/mine?k=key");
    act(() => listeners.docs?.([]));
    act(() =>
      listeners.folders?.([folderMeta({ folderId: "mine", name: "Mine" })]),
    );
    expect(screen.queryByText("SHARED FOLDER")).toBeNull();
  });
});

describe("the open folder's own actions", () => {
  function openFolder(folders: FolderMeta[]) {
    const view = mountAt("/folder/plans");
    act(() => listeners.docs?.([]));
    act(() => listeners.folders?.(folders));
    return view;
  }

  it("lets its owner share it from inside, without going up a level to its card", async () => {
    openFolder([folderMeta()]);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("offers everything the card's menu does except Open, and Share only once", () => {
    openFolder([folderMeta()]);
    fireEvent.click(screen.getByRole("button", { name: "Folder actions" }));
    const items = screen.getAllByRole("menuitem").map((b) => b.textContent);
    expect(items).toEqual(["Rename…", "Move…", "Move to Trash"]);
  });

  it("gives somebody else's folder no Share button, and says in the menu who can", () => {
    openFolder([folderMeta({ ownerEmail: "dana@example.com", members: ["dana@example.com", "me@example.com"] })]);
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Folder actions" }));
    const share = screen.getByRole("menuitem", { name: "Share…" }) as HTMLButtonElement;
    expect(share.disabled).toBe(true);
    expect(share.title).toBe("Only dana@example.com can change sharing.");
    // Moving it is sharing everything in it with its new parent's readers.
    const move = screen.getByRole("menuitem", { name: "Move…" }) as HTMLButtonElement;
    expect([move.disabled, move.title]).toEqual([true, "Only dana@example.com can move this folder: moving it changes who can read everything in it."]);
  });

  it("goes up a level when the folder being looked at goes to the Trash, rather than stay on one only its owner can see", () => {
    vi.stubGlobal("confirm", () => true);
    openFolder([folderMeta()]);
    fireEvent.click(screen.getByRole("button", { name: "Folder actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    expect(trashItem).toHaveBeenCalledWith("folder", "plans");
    expect(screen.getByText("EVERYTHING")).toBeTruthy();
  });

  it("asks before a folder goes, because it takes other people's documents, and does nothing when told no", () => {
    let asked = "";
    vi.stubGlobal("confirm", (message: string) => {
      asked = message;
      return false;
    });
    openFolder([folderMeta()]);
    fireEvent.click(screen.getByRole("button", { name: "Folder actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    expect({ asked, called: trashItem.mock.calls.length }).toEqual({
      asked: "Move “Plans” and everything in it to the Trash? Anything in it that other people own goes too, and each of them can restore their own.",
      called: 0,
    });
  });

  it("is not shown on the workspace's top level, which is no folder at all", () => {
    mount();
    act(() => listeners.docs?.([]));
    act(() => listeners.folders?.([folderMeta()]));
    expect(screen.queryByRole("button", { name: "Folder actions" })).toBeNull();
  });
});

describe("each card's length and last update", () => {
  it("says how long it is, when its content last changed, and what changed it when that was not a person", () => {
    mount();
    act(() =>
      listeners.docs?.([
        docMeta({ docId: "by-cli", title: "By the CLI", currentVersion: "v3", latest: { version: "v3", at: null, byEmail: "ana@example.com", channel: "cli", via: "CLI on mbp", origin: "upload", words: 2380 } } as Partial<DocMeta>),
        docMeta({ docId: "by-hand", title: "By hand", currentVersion: "v1", latest: { version: "v1", at: null, byEmail: "ana@example.com", channel: "web", origin: "edit", words: 40 } } as Partial<DocMeta>),
        docMeta({ docId: "older", title: "Not summarized yet", updatedAt: { toMillis: () => 1, toDate: () => new Date(1) } as never }),
      ]),
    );
    act(() => listeners.folders?.([]));
    const card = (title: string) => screen.getByText(title).closest(".doc-card") as HTMLElement;
    expect(card("By the CLI").querySelector(".doc-card-meta")?.textContent).toContain("10 min read");
    expect(card("By the CLI").querySelector(".badge-automated")?.textContent).toBe("agent");
    expect(card("By the CLI").querySelector(".badge-automated")?.getAttribute("title")).toContain("CLI on mbp");
    expect(card("By the CLI").querySelector(".doc-card-meta")?.textContent).not.toContain("CLI on mbp");
    expect(card("By hand").querySelector(".doc-card-meta")?.textContent).toContain("1 min read");
    expect(card("By hand").querySelector(".badge-automated")).toBeNull();
    const older = card("Not summarized yet").querySelector(".doc-card-meta")?.textContent ?? "";
    expect(older).toContain("Updated just now");
    expect(older).not.toContain("min read");
  });
});


describe("the list layout", () => {
  const rows = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>('[role="rowgroup"]:not(.doc-table-head) [role="row"]'));
  const cell = (row: HTMLElement, col: string) => row.querySelector<HTMLElement>(`[data-col="${col}"]`)?.textContent ?? null;
  const land = (docs: DocMeta[], folders: FolderMeta[] = []) => {
    act(() => listeners.folders!(folders));
    act(() => listeners.docs!(docs));
  };

  it("starts as the grid, and once chosen is still the list after leaving and coming back", () => {
    // Opening a document unmounts the workspace; coming back mounts it again,
    // in the same page. That sequence is the one a person performs.
    const first = mount();
    land([docMeta()]);
    expect(first.container.querySelector(".doc-grid")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Grid" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("table", { name: "Documents" })).toBeTruthy();
    expect(first.container.querySelector(".doc-grid")).toBeNull();
    first.unmount();

    const again = mount();
    land([docMeta()]);
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    expect(rows(again.container)).toHaveLength(1);
  });

  it("gives each document its owner, its reads and its menu, and each folder its people", () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    land(
      [
        docMeta({ docId: "mine", title: "Mine", ownerEmail: "me@example.com", stats: { views: 7 } as never }),
        docMeta({ docId: "theirs", title: "Theirs" }),
      ],
      [folderMeta()],
    );
    const [folderRow, mineRow, theirsRow] = rows(container);
    expect(folderRow.getAttribute("data-kind")).toBe("folder");
    expect(cell(folderRow, "people")).toBe("1 person");
    expect(cell(mineRow, "owner")).toBe("You");
    expect(cell(mineRow, "reads")).toBe("7");
    expect(cell(theirsRow, "owner")).toBe("ana@example.com");
    expect(cell(theirsRow, "reads")).toBe("0");
    expect(mineRow.querySelector('a.doc-row-title')?.getAttribute("href")).toBe("/d/mine");
    const thumb = mineRow.querySelector<HTMLAnchorElement>("a.doc-row-thumb")!;
    expect(thumb.tabIndex).toBe(-1);
    expect(thumb.getAttribute("aria-hidden")).toBe("true");
    expect(mineRow.querySelector('button[aria-label="Actions"]')).not.toBeNull();
  });

  it("says where each one is filed once a search reaches into every folder, a folder it cannot open included", () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    land(
      [
        docMeta({ docId: "top", title: "Plan at the top", folderId: null }),
        docMeta({ docId: "filed", title: "Plan filed", folderId: "plans" }),
        docMeta({ docId: "hidden", title: "Plan in someone else's folder", folderId: "not-mine" }),
      ],
      [folderMeta()],
    );
    expect(screen.queryByRole("columnheader", { name: "Folder" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "plan" } });
    expect(screen.getByRole("columnheader", { name: "Folder" })).toBeTruthy();
    const where = Object.fromEntries(
      rows(container)
        .filter((r) => r.getAttribute("data-kind") !== "folder")
        .map((r) => [r.querySelector(".doc-row-title")!.textContent, cell(r, "location")]),
    );
    expect(where).toEqual({
      "Plan at the top": "Everything",
      "Plan filed": "Plans",
      "Plan in someone else's folder": "A folder you can't open",
    });
  });

  it("shows the same place on a card while a search is on, and none without one", () => {
    const { container } = mount();
    land([docMeta({ docId: "filed", title: "Plan filed", folderId: "plans" })], [folderMeta()]);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "plan" } });
    const card = screen.getByText("Plan filed").closest(".doc-card") as HTMLElement;
    expect(card.querySelector(".doc-card-location")?.textContent).toBe("Plans");
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } });
    expect(container.querySelector(".doc-card-location")).toBeNull();
  });

  it("sorts from a column header, says which sort is on, and remembers it", () => {
    const first = mount();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    land([
      docMeta({ docId: "b", title: "Bravo" }),
      docMeta({ docId: "a", title: "alpha" }),
    ]);
    const sort = () => (screen.getByLabelText("Sort") as HTMLSelectElement).value;
    expect(sort()).toBe("recent");
    expect(screen.getByRole("columnheader", { name: /Updated/ }).getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(screen.getByRole("button", { name: /^Name/ }));
    expect(sort()).toBe("name");
    expect(screen.getByRole("columnheader", { name: /Name/ }).getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getByRole("columnheader", { name: /Updated/ }).getAttribute("aria-sort")).toBeNull();
    expect(rows(first.container).map((r) => r.querySelector(".doc-row-title")!.textContent)).toEqual(["alpha", "Bravo"]);
    first.unmount();

    mount();
    land([docMeta()]);
    expect(sort()).toBe("name");
  });

  it("files a document dropped on a folder's row into that folder", async () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    land([], [folderMeta()]);
    const file = new File(["<title>Q4</title>"], "q4.html", { type: "text/html" });
    fireEvent.drop(rows(container)[0], { dataTransfer: { types: ["Files"], files: [file] } });
    await waitFor(() => expect(uploadDoc).toHaveBeenCalledTimes(1));
    const [, options] = uploadDoc.mock.calls[0] as unknown as [File, { folderId?: string | null }];
    expect(options.folderId).toBe("plans");
  });

  it("still switches, for this visit, in a browser that blocks storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    mount();
    land([docMeta()]);
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("table", { name: "Documents" })).toBeTruthy();
    vi.restoreAllMocks();
  });
});

describe("the sort that reads the record's last read", () => {
  it("says it means anyone's read, not yours", () => {
    mount();
    const labels = Array.from((screen.getByLabelText("Sort") as HTMLSelectElement).options).map((o) => o.textContent);
    expect(labels).toEqual(["Recently updated", "Name", "Most read", "Last read by anyone"]);
  });
});

describe("Recent", () => {
  const HOUR = 3_600_000;
  const ts = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) }) as never;
  /** A document whose current version was published `ago` ms before now, by `by`. */
  const published = (docId: string, ago: number, by = "ana@example.com", overrides: Partial<DocMeta> = {}) =>
    docMeta({
      docId,
      title: docId,
      currentVersion: "v2",
      latest: { version: "v2", at: ts(Date.now() - ago), byEmail: by, channel: "web", origin: "upload" },
      ...overrides,
    } as Partial<DocMeta>);
  const titles = (container: HTMLElement) =>
    Array.from(container.querySelectorAll(".doc-row-title, .doc-card-title")).map((e) => e.textContent);
  /** A quick filter, found in its own group: the rail has a Shared with me too. */
  const filter = (name: string) => within(screen.getByRole("group", { name: "Show only" })).getByRole("button", { name });
  const land = async (docs: DocMeta[], folders: FolderMeta[] = []) => {
    act(() => listeners.folders!(folders));
    act(() => listeners.docs!(docs));
    await act(async () => {});
  };

  it("lists what you read and what got a new version, newest first, as rows, each saying why it is there", async () => {
    reading.mockImplementation(async () => new Map([["read-it", Date.now() - HOUR]]));
    const { container } = mount("recent");
    await land([published("read-it", 5 * 24 * HOUR), published("changed", 2 * HOUR), published("quiet", 40 * 24 * HOUR)]);
    expect(reading).toHaveBeenCalledWith("u1", 100);
    expect(screen.getByRole("heading", { level: 1, name: "Recent" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Documents" })).toBeTruthy();
    expect(titles(container)).toEqual(["read-it", "changed"]);
    const why = (title: string) =>
      (screen.getByText(title).closest('[role="row"]') as HTMLElement).querySelector('[data-col="why"]')?.textContent;
    expect(why("read-it")).toBe("You read it just now");
    expect(why("changed")).toBe("New version just now by ana@example.com");
  });

  it("marks what someone else published after you read it, and not what you published yourself", async () => {
    reading.mockImplementation(
      async () =>
        new Map([
          ["theirs", Date.now() - 3 * HOUR],
          ["mine", Date.now() - 3 * HOUR],
        ]),
    );
    mount("recent");
    await land([published("theirs", HOUR), published("mine", HOUR, "me@example.com")]);
    const row = (title: string) => screen.getByText(title).closest('[role="row"]') as HTMLElement;
    expect(row("theirs").textContent).toContain("New since you read it");
    expect(row("mine").textContent).not.toContain("New since you read it");
    expect(row("mine").textContent).toContain("by you");
  });

  it("narrows with filters that combine, and keeps them for the next visit", async () => {
    reading.mockImplementation(async () => new Map([["read-mine", Date.now() - HOUR], ["read-theirs", Date.now() - 2.5 * HOUR]]));
    const docs = [
      published("read-mine", 2 * HOUR, "me@example.com", { ownerEmail: "me@example.com" }),
      published("read-theirs", 3 * HOUR),
      published("unread-theirs", 5 * HOUR),
    ];
    const first = mount("recent");
    await land(docs);
    expect(titles(first.container)).toEqual(["read-mine", "read-theirs", "unread-theirs"]);
    fireEvent.click(filter("Opened by me"));
    expect(titles(first.container)).toEqual(["read-mine", "read-theirs"]);
    fireEvent.click(filter("Shared with me"));
    expect(titles(first.container)).toEqual(["read-theirs"]);
    fireEvent.click(filter("New since I read"));
    expect(titles(first.container)).toEqual([]);
    expect(screen.getByText("Nothing matches these filters.")).toBeTruthy();
    fireEvent.click(filter("New since I read"));
    first.unmount();

    const again = mount("recent");
    await land(docs);
    expect(filter("Opened by me").getAttribute("aria-pressed")).toBe("true");
    expect(filter("Shared with me").getAttribute("aria-pressed")).toBe("true");
    expect(titles(again.container)).toEqual(["read-theirs"]);
    fireEvent.click(filter("New since I read"));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(titles(again.container)).toEqual(["read-mine", "read-theirs", "unread-theirs"]);
    expect(["Opened by me", "Shared with me", "New since I read"].map((n) => filter(n).getAttribute("aria-pressed"))).toEqual(["false", "false", "false"]);
  });

  it("lists new versions alone, and says why, when your reads cannot be fetched", async () => {
    // The index still building after a deploy looks exactly like this.
    reading.mockImplementation(async () => {
      throw new Error("FAILED_PRECONDITION: The query requires an index.");
    });
    const { container } = mount("recent");
    await land([published("changed", 2 * HOUR), published("quiet", 40 * 24 * HOUR)]);
    expect(titles(container)).toEqual(["changed"]);
    expect(screen.getByText(/reading history isn't available just now, so this shows new versions only/)).toBeTruthy();
    expect((filter("Opened by me") as HTMLButtonElement).disabled).toBe(true);
    expect((filter("New since I read") as HTMLButtonElement).disabled).toBe(true);
    expect((filter("Shared with me") as HTMLButtonElement).disabled).toBe(false);
  });

  it("never calls itself empty before your reads have answered", async () => {
    let answer: (reads: Map<string, number>) => void = () => {};
    reading.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { container } = mount("recent");
    await land([]);
    expect(screen.queryByText("Nothing in the last 30 days")).toBeNull();
    expect(container.querySelector(".doc-row-skeleton")).not.toBeNull();
    await act(async () => answer(new Map()));
    expect(screen.getByText("Nothing in the last 30 days")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Everything" }).getAttribute("href")).toBe("/everything");
  });

  it("has no sort and no new folder, until a search, which reaches every document and is sorted as anywhere else", async () => {
    mount("recent");
    await land([published("a plan", 2 * HOUR), published("an old plan", 60 * 24 * HOUR)]);
    expect(screen.queryByLabelText("Sort")).toBeNull();
    expect(screen.queryByRole("button", { name: /Folder$/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "plan" } });
    expect(screen.getByLabelText("Sort")).toBeTruthy();
    expect(screen.getAllByText(/plan$/).map((e) => e.textContent)).toEqual(["a plan", "an old plan"]);
  });

  it("marks Recent in the rail, and only Recent", async () => {
    mount("recent");
    await land([]);
    const rail = screen.getByRole("navigation", { name: "Folders" });
    const current = Array.from(rail.querySelectorAll('[aria-current="page"]')).map((e) => e.textContent);
    expect(current).toEqual(["Recent"]);
  });
});

describe("Shared with me", () => {
  it("lists every document somebody else owns, from every folder, one whose folder you cannot open included, and no folders", () => {
    const { container } = mount("shared");
    act(() => listeners.folders!([folderMeta()]));
    act(() =>
      listeners.docs!([
        docMeta({ docId: "mine", title: "Mine", ownerEmail: "me@example.com" }),
        docMeta({ docId: "filed", title: "Filed", folderId: "plans" }),
        docMeta({ docId: "orphan", title: "Orphan", folderId: "not-mine" }),
      ]),
    );
    expect(screen.getByRole("heading", { level: 1, name: "Shared with me" })).toBeTruthy();
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="rowgroup"]:not(.doc-table-head) [role="row"]'));
    expect(rows.map((r) => [r.querySelector(".doc-row-title")?.textContent, r.querySelector('[data-col="location"]')?.textContent])).toEqual([
      ["Filed", "Plans"],
      ["Orphan", "A folder you can't open"],
    ]);
    expect(container.querySelector('[data-kind="folder"]')).toBeNull();
    const rail = screen.getByRole("navigation", { name: "Folders" });
    expect(Array.from(rail.querySelectorAll('[aria-current="page"]')).map((e) => e.textContent)).toEqual(["Shared with me"]);
  });

  it("says so when nothing is shared yet, rather than offering to upload", () => {
    mount("shared");
    act(() => listeners.folders!([]));
    act(() => listeners.docs!([docMeta({ ownerEmail: "me@example.com" })]));
    expect(screen.getByText("Nothing shared with you yet")).toBeTruthy();
  });

  it("keeps its own layout, apart from the folders' grid", () => {
    const first = mount("shared");
    act(() => listeners.folders!([]));
    act(() => listeners.docs!([docMeta()]));
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    first.unmount();
    mount("everything");
    act(() => listeners.folders!([]));
    act(() => listeners.docs!([docMeta()]));
    expect(screen.getByRole("button", { name: "Grid" }).getAttribute("aria-pressed")).toBe("true");
  });
});
