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
const { listeners, createFolder } = vi.hoisted(() => ({
  listeners: {
    docs: null as ((docs: DocMeta[]) => void) | null,
    folders: null as ((folders: FolderMeta[]) => void) | null,
  },
  createFolder: vi.fn(),
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
  duplicateDoc: vi.fn(),
  renameItem: vi.fn(),
  moveItem: vi.fn(),
  setFolderAccess: vi.fn(),
}));
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
