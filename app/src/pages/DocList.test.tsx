// SPDX-License-Identifier: Apache-2.0
// The workspace never calls itself empty while it is still loading, and says when it is busy (SPEC §5, §13).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DocMeta, FolderMeta } from "../types";

/**
 * The listeners are captured rather than answered, so each test decides which
 * snapshot has landed — the order is the whole point, since the two arrive
 * independently and either can be first.
 */
const { listeners, createFolder, forkDoc } = vi.hoisted(() => ({
  listeners: {
    docs: null as ((docs: DocMeta[]) => void) | null,
    folders: null as ((folders: FolderMeta[]) => void) | null,
  },
  createFolder: vi.fn(),
  forkDoc: vi.fn(),
}));

vi.mock("../firebase", () => ({ auth: {}, db: {}, rtdb: null }));
vi.mock("../auth", () => ({
  useAuth: () => ({ user: { uid: "u1" }, emailLower: "me@example.com" }),
}));
vi.mock("../firestore", () => ({
  formatRelative: () => "just now",
  listMyDocs: (_email: string, onData: (docs: DocMeta[]) => void) => {
    listeners.docs = onData;
    return () => {};
  },
  listMyFolders: (_email: string, onData: (folders: FolderMeta[]) => void) => {
    listeners.folders = onData;
    return () => {};
  },
  listMyTeams: () => () => {},
  watchUser: () => () => {},
}));
vi.mock("../folders", () => ({
  createFolder,
  deleteFolder: vi.fn(),
  renameItem: vi.fn(),
  moveItem: vi.fn(),
  setFolderAccess: vi.fn(),
}));
vi.mock("../forks", () => ({ forkDoc }));
vi.mock("../analytics", () => ({ logEvent: vi.fn() }));
const { backfill } = vi.hoisted(() => ({ backfill: vi.fn() }));
vi.mock("../hooks/useCoverBackfill", () => ({ useCoverBackfill: backfill }));

import { DocList } from "./DocList";
import { ToastProvider } from "../components/Toast";

function mount() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <DocList />
      </ToastProvider>
    </MemoryRouter>,
  );
}

const EMPTY = /Nothing here yet/;

beforeEach(() => {
  listeners.docs = null;
  listeners.folders = null;
  createFolder.mockReset();
  forkDoc.mockReset();
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
