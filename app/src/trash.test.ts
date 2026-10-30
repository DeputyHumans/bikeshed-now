// SPDX-License-Identifier: Apache-2.0
// What the app counts as in the Trash, and how a Trash row says where an item came from (SPEC §4).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isTrashed, trashedFrom } from "./trash";
import type { DocMeta } from "./types";

describe("isTrashed", () => {
  it("decides every record as the server and the scripts do (trash-vectors.json)", () => {
    const file = join(__dirname, "..", "..", "functions", "test", "fixtures", "trash-vectors.json");
    const { cases } = JSON.parse(readFileSync(file, "utf8")) as { cases: { record: { trashed?: unknown } | null; trashed: boolean }[] };
    expect(cases.map((c) => isTrashed(c.record as Pick<DocMeta, "trashed">))).toEqual(cases.map((c) => c.trashed));
  });
});

describe("trashedFrom", () => {
  const names = (id: string) => ({ plans: "Plans" })[id] ?? null;
  it("names the folder an item went with, before the one it was in", () => {
    expect(trashedFrom({ trashed: { at: null, by: "u", batch: "b", with: { folderId: "q3", name: "Q3" } }, folderId: "plans" }, names)).toBe("with the folder “Q3”");
  });
  it("names the folder it was in while that is still in the workspace, and says nothing otherwise", () => {
    expect([
      trashedFrom({ trashed: { at: null, by: "u", batch: "b" }, folderId: "plans" }, names),
      trashedFrom({ trashed: { at: null, by: "u", batch: "b" }, parentId: "plans" }, names),
      trashedFrom({ trashed: { at: null, by: "u", batch: "b" }, folderId: "gone" }, names),
      trashedFrom({ trashed: { at: null, by: "u", batch: "b" }, folderId: null }, names),
    ]).toEqual(["from “Plans”", "from “Plans”", null, null]);
  });
});
