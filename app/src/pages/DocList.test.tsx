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
