// SPDX-License-Identifier: Apache-2.0
// Reading a document's visibility triple off its record (SPEC §17).

import { describe, expect, test } from "vitest";
import { visibilityStateOf } from "./visibility";

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
