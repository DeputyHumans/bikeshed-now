// SPDX-License-Identifier: Apache-2.0
// An empty offline cache is not evidence that a workspace has no shared documents (SPEC §5, §14).

import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("./firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", async (original) => ({
  ...(await original<typeof import("firebase/firestore")>()),
  collection: vi.fn(() => ({})), query: vi.fn(() => ({})),
  where: vi.fn(), orderBy: vi.fn(), onSnapshot: calls.snapshot,
}));
import { listMyDocs } from "./firestore";

it("waits past an empty cached result and observes the metadata-only server confirmation", () => {
  const seen: unknown[] = [];
  calls.snapshot.mockClear();
  listMyDocs("reader@example.com", (docs) => seen.push(docs));
  const args = calls.snapshot.mock.calls[0];
  const deliver = args.find((arg: unknown) => typeof arg === "function") as (value: unknown) => void;
  deliver({ metadata: { fromCache: true }, docs: [] });
  expect(seen).toEqual([]);
  expect(args[1]).toEqual({ includeMetadataChanges: true });
  deliver({ metadata: { fromCache: false }, docs: [] });
  expect(seen).toEqual([[]]);
});

it("can show cached documents while waiting and applies a server-side revocation", () => {
  const seen: unknown[] = [];
  calls.snapshot.mockClear();
  listMyDocs("reader@example.com", (docs) => seen.push(docs));
  const deliver = calls.snapshot.mock.calls[0].find((arg: unknown) => typeof arg === "function") as (value: unknown) => void;
  deliver({ metadata: { fromCache: true }, docs: [{ id: "shared", data: () => ({ title: "Shared" }) }] });
  expect(seen).toEqual([[{ docId: "shared", title: "Shared" }]]);
  deliver({ metadata: { fromCache: false }, docs: [] });
  expect(seen.at(-1)).toEqual([]);
});

it("leaves what is in the Trash out of the workspace, folders included, and delivers it to whoever asks for the Trash", async () => {
  const { listMyFolders } = await import("./firestore");
  const live = { id: "live", data: () => ({ title: "Live", trashed: null }) };
  const gone = { id: "gone", data: () => ({ title: "Gone", trashed: { batch: "b1" } }) };
  const folderLive = { id: "g", data: () => ({ name: "G" }) };
  const folderGone = { id: "f", data: () => ({ name: "F", trashed: { batch: "b1" } }) };
  const deliverTo = (i: number) => calls.snapshot.mock.calls[i].find((arg: unknown) => typeof arg === "function") as (value: unknown) => void;
  const ids = (list: unknown) => (list as { docId?: string; folderId?: string }[]).map((x) => x.docId ?? x.folderId);

  calls.snapshot.mockClear();
  const seen: Record<string, unknown[]> = { docs: [], trash: [], folders: [], all: [] };
  listMyDocs("me@example.com", (d) => seen.docs.push(d));
  listMyDocs("me@example.com", (d) => seen.trash.push(d), undefined, "trash");
  listMyFolders("me@example.com", (f) => seen.folders.push(f));
  listMyFolders("me@example.com", (f) => seen.all.push(f), undefined, "all");
  deliverTo(0)({ metadata: { fromCache: false }, docs: [live, gone] });
  deliverTo(1)({ metadata: { fromCache: true }, docs: [] });
  deliverTo(1)({ metadata: { fromCache: false }, docs: [live, gone] });
  deliverTo(2)({ docs: [folderGone, folderLive] });
  deliverTo(3)({ docs: [folderGone, folderLive] });
  expect({
    docs: ids(seen.docs.at(-1)),
    trash: seen.trash.map(ids),
    folders: ids(seen.folders.at(-1)),
    all: ids(seen.all.at(-1)),
  }).toEqual({ docs: ["live"], trash: [["gone"]], folders: ["g"], all: ["f", "g"] });
});
