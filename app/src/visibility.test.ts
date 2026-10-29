// SPDX-License-Identifier: Apache-2.0
// Reading a document's visibility triple off its record (SPEC §17).

import { describe, expect, test } from "vitest";
import { folderShareUrl, folderVisibilityStateOf, liveReach, visibilityStateOf } from "./visibility";

describe("the visibility state of a record", () => {
  test("a record that says nothing is private, closed, unlinked and permanent", () => {
    // Every field is optional on the record because most documents never set
    // any of them — and the server writes the whole triple back on every
    // change, so what is read here is what would be sent.
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
