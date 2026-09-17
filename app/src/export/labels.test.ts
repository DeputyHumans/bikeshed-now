// SPDX-License-Identifier: Apache-2.0
// Marking is data, bounded at the edges (SPEC §20).

import { describe, expect, it } from "vitest";
import {
  MARKING_OFF,
  MAX_FOOTER,
  MAX_LABEL,
  clampMarking,
  markingIsVisible,
} from "./labels";
import { resolveFooter } from "../marking";

describe("clampMarking", () => {
  it("collapses a disabled marking to the canonical off value", () => {
    expect(clampMarking({ enabled: false, label: "X", footer: "Y" })).toEqual(MARKING_OFF);
  });

  it("trims and caps both fields", () => {
    const out = clampMarking({
      enabled: true,
      label: `  ${"x".repeat(100)}  `,
      footer: "y".repeat(500),
    });
    expect(out.label).toHaveLength(MAX_LABEL);
    expect(out.footer).toHaveLength(MAX_FOOTER);
  });
});

describe("markingIsVisible", () => {
  it("is false when enabled but empty", () => {
    // An enabled marking with nothing in it should render nothing, rather than
    // an empty stamped box.
    expect(markingIsVisible({ enabled: true, label: "", footer: "" })).toBe(false);
  });

  it("is true when either field has content", () => {
    expect(markingIsVisible({ enabled: true, label: "C", footer: "" })).toBe(true);
    expect(markingIsVisible({ enabled: true, label: "", footer: "f" })).toBe(true);
  });

  it("is false when disabled, whatever the fields say", () => {
    expect(markingIsVisible({ enabled: false, label: "C", footer: "f" })).toBe(false);
  });
});

describe("resolveFooter", () => {
  const context = { title: "Q3 Memo", version: "v3", user: "ana@example.com" };

  it("substitutes every supported placeholder", () => {
    const out = resolveFooter("{title} · {version} · {user} · {year}", context);
    expect(out).toContain("Q3 Memo");
    expect(out).toContain("v3");
    expect(out).toContain("ana@example.com");
    expect(out).toContain(String(new Date().getFullYear()));
  });

  it("substitutes EVERY occurrence, not just the first", () => {
    expect(resolveFooter("{version} {version}", context)).toBe("v3 v3");
  });

  it("leaves an unknown placeholder alone rather than blanking it", () => {
    // Blanking it would make a typo look like a bug in the document.
    expect(resolveFooter("{nonsense}", context)).toBe("{nonsense}");
  });

  it("resolves {date} to something a person can read", () => {
    expect(resolveFooter("{date}", context)).not.toContain("{date}");
  });
});
