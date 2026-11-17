// SPDX-License-Identifier: Apache-2.0
// Reading a document's visibility triple off its record (SPEC §17).

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  folderShareUrl,
  folderVisibilityStateOf,
  liveReach,
  setFolderVisibility,
  setVisibility,
  visibilityStateOf,
} from "./visibility";

const { post } = vi.hoisted(() => ({ post: vi.fn(async () => ({ visibility: "public", linkToken: null, expiresAt: null })) }));
vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), post }));
afterEach(() => post.mockClear());

describe("what a visibility change sends", () => {
  // The server keeps a date the body does not name and refuses one in the
  // past (SPEC §2), so a date goes only when it is the thing being changed.
  test("a document's level goes without a date key, and with open editing", async () => {
    await setVisibility("d1", "public", true);
    const body = (post.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(body).toEqual({ docId: "d1", visibility: "public", publicEdit: true });
    expect(Object.hasOwn(body, "expiresAt")).toBe(false);
  });

  test("a document's date goes when it is given, and null clears it", async () => {
    await setVisibility("d1", "unlisted", false, 1_900_000_000_000);
    await setVisibility("d1", "unlisted", false, null);
    expect((post.mock.calls[0] as unknown[])[1]).toEqual({ docId: "d1", visibility: "unlisted", publicEdit: false, expiresAt: 1_900_000_000_000 });
    expect((post.mock.calls[1] as unknown[])[1]).toEqual({ docId: "d1", visibility: "unlisted", publicEdit: false, expiresAt: null });
  });

  test("a folder's level goes without a date key", async () => {
    await setFolderVisibility("f1", "unlisted");
    const body = (post.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(body).toEqual({ folderId: "f1", visibility: "unlisted" });
    await setFolderVisibility("f1", "unlisted", null);
    expect((post.mock.calls[1] as unknown[])[1]).toEqual({ folderId: "f1", visibility: "unlisted", expiresAt: null });
  });
});

describe("the visibility state of a record", () => {
  test("a record that says nothing is private, closed, unlinked and permanent", () => {
    // Every field is optional on the record because most documents never set
    // any of them, and what is read here is what the dialog starts from.
    expect(visibilityStateOf({})).toEqual({
      visibility: "private",
      publicEdit: false,
      linkToken: null,
      expiresAt: null,
    });
  });

  test("carries each field through, with the expiry as milliseconds", () => {
    expect(
      visibilityStateOf({
        visibility: "unlisted",
        publicEdit: true,
        linkToken: "tok",
        expiresAt: { toMillis: () => 1700000000000 } as never,
      }),
    ).toEqual({
      visibility: "unlisted",
      publicEdit: true,
      linkToken: "tok",
      expiresAt: 1700000000000,
    });
  });
});

describe("a folder's level and its reach", () => {
  test("a folder's state never carries open editing, and its link is its page", () => {
    const state = folderVisibilityStateOf({ visibility: "unlisted", linkToken: "ftok" });
    expect(state).toEqual({ visibility: "unlisted", publicEdit: false, linkToken: "ftok", expiresAt: null });
    expect(folderShareUrl("f1", state)).toBe(`${window.location.origin}/folder/f1?k=ftok`);
    expect(folderShareUrl("f1", { ...state, visibility: "public" })).toBe(`${window.location.origin}/folder/f1`);
  });

  test("the reach that counts is the furthest one that has not ended", () => {
    const NOW = 1_800_000_000_000;
    expect(liveReach(undefined, NOW)).toBeNull();
    expect(liveReach({ reach: [] }, NOW)).toBeNull();
    expect(liveReach({ reach: [{ folderId: "a", visibility: "unlisted", keyHash: "h", expiresAt: null }] }, NOW)).toBe("unlisted");
    expect(
      liveReach({
        reach: [
          { folderId: "a", visibility: "unlisted", keyHash: "h", expiresAt: null },
          { folderId: "b", visibility: "public", expiresAt: NOW + 1 },
        ],
      }, NOW),
    ).toBe("public");
    expect(liveReach({ reach: [{ folderId: "b", visibility: "public", expiresAt: NOW }] }, NOW)).toBeNull();
  });
});
