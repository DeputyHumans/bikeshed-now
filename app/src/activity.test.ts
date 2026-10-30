// SPDX-License-Identifier: Apache-2.0
// Each Activity row in words, and what acted named for what it was (SPEC §17, ADR 0023).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeActivity, subjectOf, type ActivityItem } from "./activity";
import { isAutomated, viaOf } from "./provenance";

const row = (over: Partial<ActivityItem>): ActivityItem => ({ id: "x", type: "read", at: "2026-10-29T12:00:00.000Z", ...over });

describe("what acted", () => {
  it("is the label stored with the action, and nothing for a person in the browser", () => {
    expect(viaOf({ channel: "cli", via: "CLI on mbp" })).toBe("CLI on mbp");
    expect(viaOf({ channel: "app", via: "“Claude” (connected app)" })).toBe("“Claude” (connected app)");
    expect(viaOf({ channel: "web" })).toBeNull();
    expect(viaOf(undefined)).toBeNull();
    expect(isAutomated({ channel: "web" })).toBe(false);
  });

  it("falls back to plain words for a record written before labels were stored", () => {
    expect(viaOf({ channel: "mcp" })).toBe("MCP");
    expect(viaOf({ channel: "cli" })).toBe("the command line");
    expect(viaOf({ channel: "operator" })).toBe("an operator script");
  });

  it("names every record exactly as the server does (via-vectors.json)", () => {
    const file = join(__dirname, "..", "..", "functions", "test", "fixtures", "via-vectors.json");
    const { cases } = JSON.parse(readFileSync(file, "utf8")) as { cases: Array<{ name: string; actor: { channel?: string; via?: string } | null; via: string | null }> };
    expect(cases.length).toBeGreaterThan(5);
    for (const c of cases) expect(viaOf(c.actor), c.name).toBe(c.via);
  });
});

describe("each row in words", () => {
  it("says how a version arrived, not just that one did", () => {
    expect(describeActivity(row({ type: "version.published", origin: "upload" }))).toBe("uploaded a version");
    expect(describeActivity(row({ type: "version.published", origin: "edit" }))).toBe("published a version from the editor");
    expect(describeActivity(row({ type: "version.published", origin: "fork" }))).toBe("made this document, as a fork");
  });

  it("names nobody for a fork, and an operator for a withdrawal", () => {
    expect(subjectOf(row({ type: "fork.created", by: "someone@example.com" }))).toBe("Someone");
    expect(subjectOf(row({ type: "version.withdrawn", channel: "operator" }))).toBe("An operator");
    expect(subjectOf(row({ type: "version.withdrawn" })), "a withdrawal from before its actor was stored").toBe("An operator");
  });

  it("shows an account that moved address as moving, not as granting itself access", () => {
    const moved = row({ type: "access.changed", by: "new@example.com", added: ["new@example.com"], removed: ["old@example.com"], reason: "address-moved" });
    expect(`${subjectOf(moved)} ${describeActivity(moved)}`).toBe("old@example.com moved to new@example.com");
    const granted = row({ type: "access.changed", by: "own@example.com", added: ["a@example.com"], removed: ["b@example.com"] });
    expect(describeActivity(granted)).toBe("gave a@example.com access and removed b@example.com");
  });

  it("counts an agent's repeated reads, and says who read without an account", () => {
    expect(describeActivity(row({ type: "read", automated: true, reads: 3 }))).toBe("read it 3 times");
    expect(subjectOf(row({ type: "read", by: null }))).toBe("Somebody without an account");
  });

  it("quotes what a thread or suggestion is about, briefly", () => {
    const long = "word ".repeat(40);
    expect(describeActivity(row({ type: "thread.opened", quote: long })).length).toBeLessThan(80);
    expect(describeActivity(row({ type: "suggestion.opened", quote: "old", replacement: "new" }))).toBe("suggested replacing “old” with “new”");
  });
});
