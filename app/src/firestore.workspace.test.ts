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

it("leaves what is in the Trash out of the workspace, folders included, and lists it apart", async () => {
  const { listMyFolders, listMyTrash } = await import("./firestore");
  const at = (ms: number) => ({ toMillis: () => ms });
  const live = { id: "live", data: () => ({ title: "Live", trashed: null }) };
  const gone = { id: "gone", data: () => ({ title: "Gone", trashed: { batch: "b1", at: at(1) } }) };
  const later = { id: "later", data: () => ({ title: "Later", trashed: { batch: "b2", at: at(2) } }) };
  const deliverTo = (i: number) => calls.snapshot.mock.calls[i].find((arg: unknown) => typeof arg === "function") as (value: unknown) => void;

  calls.snapshot.mockClear();
  const docs: unknown[] = [], folders: unknown[] = [], trash: unknown[] = [];
  listMyDocs("me@example.com", (d) => docs.push(d));
  listMyFolders("me@example.com", (f) => folders.push(f));
  listMyTrash("me@example.com", (t) => trash.push(t));
  deliverTo(0)({ metadata: { fromCache: false }, docs: [live, gone] });
  deliverTo(1)({ metadata: { fromCache: false }, docs: [{ id: "f", data: () => ({ name: "F", trashed: { batch: "b1" } }) }, { id: "g", data: () => ({ name: "G" }) }] });
  deliverTo(2)({ docs: [live, gone, later] });
  expect(trash).toEqual([]); // not until both of its queries have answered
  deliverTo(3)({ docs: [{ id: "f", data: () => ({ name: "F", trashed: { batch: "b1" } }) }] });
  expect({
    docs: (docs.at(-1) as { docId: string }[]).map((d) => d.docId),
    folders: (folders.at(-1) as { folderId: string }[]).map((f) => f.folderId),
    trash: trash.map((t) => ({ docs: (t as { docs: { docId: string }[] }).docs.map((d) => d.docId), folders: (t as { folders: { folderId: string }[] }).folders.map((f) => f.folderId) })),
  }).toEqual({ docs: ["live"], folders: ["g"], trash: [{ docs: ["later", "gone"], folders: ["f"] }] });
});
