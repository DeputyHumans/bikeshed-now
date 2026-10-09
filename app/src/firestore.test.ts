// SPDX-License-Identifier: Apache-2.0
// What the app writes as feedback is exactly what the rules let a browser write (SPEC §6, §17).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rules accept an annotation or a comment only with EXACTLY the fields
 * listed in the template's `isExactly([...])`, stamped with the server's clock.
 * Every other test here mocks Firestore, so a field added to one of these
 * writers would pass them all and then be refused for every comment anybody
 * makes in production. This holds the two lists together.
 */

const SERVER_TIME = { __sentinel: "serverTimestamp" };

vi.mock("./firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", async (original) => ({
  ...(await original<typeof import("firebase/firestore")>()),
  collection: vi.fn(() => ({})),
  doc: vi.fn(() => ({ id: "generated-id" })),
  serverTimestamp: vi.fn(() => SERVER_TIME),
  setDoc: vi.fn(async () => undefined),
  updateDoc: vi.fn(async () => undefined),
}));

const { setDoc, updateDoc } = await import("firebase/firestore");
const { addComment, createAnnotation, setResolved } = await import("./firestore");

const RULES = readFileSync(
  join(__dirname, "..", "..", "config", "templates", "firestore.rules.tmpl"),
  "utf8",
);

/** The `isExactly([...])` list inside the named match block. */
function exactKeys(match: string): string[] {
  const start = RULES.indexOf(match);
  expect(start, `no ${match} in the rules template`).toBeGreaterThan(-1);
  const list = RULES.slice(start).match(/isExactly\(\[([^\]]+)\]\)/);
  expect(list, `no isExactly([...]) after ${match}`).not.toBeNull();
  return [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

function written(): Record<string, unknown> {
  const calls = vi.mocked(setDoc).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][1] as Record<string, unknown>;
}

describe("feedback the app writes", () => {
  beforeEach(() => {
    vi.mocked(setDoc).mockClear();
    vi.mocked(updateDoc).mockClear();
  });

  it("an annotation has exactly the rules' fields, open, on the server's clock", async () => {
    const anchor = { elementId: "s1", exact: "x", prefix: "", suffix: "", start: 0, end: 1 };
    await createAnnotation("doc", "v1", anchor, "u1", "Ana@Example.com");
    const record = written();
    expect(Object.keys(record).sort()).toEqual(exactKeys("match /annotations/{annId}"));
    expect(record.resolved).toBe(false);
    expect(record.createdAt).toBe(SERVER_TIME);
    expect(Object.keys(record.actor as object).sort()).toEqual(["channel", "email", "uid"]);
  });

  it("a comment has exactly the rules' fields, on the server's clock", async () => {
    await addComment("doc", "v1", "a1", "Agreed.", "u1", "ana@example.com");
    const record = written();
    expect(Object.keys(record).sort()).toEqual(exactKeys("match /comments/{commentId}"));
    expect(record.createdAt).toBe(SERVER_TIME);
    expect(Object.keys(record.actor as object).sort()).toEqual(["channel", "email", "uid"]);
  });

  it("a resolve changes `resolved` and nothing else", async () => {
    await setResolved("doc", "v1", "a1", true);
    expect(vi.mocked(updateDoc).mock.calls[0][1]).toEqual({ resolved: true });
  });
});
