// SPDX-License-Identifier: Apache-2.0
// The sign-in page returns a reader only to a path on this origin (SPEC §3, §21).

import { describe, expect, it } from "vitest";
import { safeNext } from "./next";

describe("safeNext", () => {
  it("keeps a path on this origin, query and all", () => {
    expect(safeNext("/d/q3-plan/v2?fork=1&k=tok_abc")).toBe("/d/q3-plan/v2?fork=1&k=tok_abc");
    expect(safeNext("/")).toBe("/");
  });

  it.each([
    ["absent", null],
    ["empty", ""],
    ["absolute", "https://evil.example/d/x"],
    ["protocol-relative", "//evil.example/d/x"],
    ["backslash", "/\\evil.example"],
    ["leading backslash", "\\\\evil.example"],
    ["a scheme", "javascript:alert(1)"],
    ["a tab the parser strips", "/\t/evil.example"],
    ["relative", "d/x"],
  ])("sends %s to the workspace", (_name, raw) => {
    expect(safeNext(raw)).toBe("/");
  });
});
