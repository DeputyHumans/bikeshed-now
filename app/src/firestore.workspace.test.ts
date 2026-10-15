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
