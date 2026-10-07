// SPDX-License-Identifier: Apache-2.0
// What the interface reads off a record before offering anything (SPEC §13).

import { describe, expect, test } from "vitest";
import { grantsOf, isDocEditor, offersSuggest, ROLES } from "./roles";

describe("grantsOf", () => {
  test("reads every role's list, and an absent or malformed one as empty", () => {
    expect(grantsOf({ viewers: ["v@example.com"], editors: "nope", approvers: [3, "a@example.com"] })).toEqual({
      viewers: ["v@example.com"],
      suggesters: [],
      editors: [],
      approvers: ["a@example.com"],
    });
    expect(grantsOf(null)).toEqual({ viewers: [], suggesters: [], editors: [], approvers: [] });
  });

  test("the ladder is lowest first, as the server's is", () => {
    expect(ROLES).toEqual(["viewer", "suggester", "editor", "approver"]);
  });
});

describe("isDocEditor", () => {
  const record = {
    ownerEmail: "owner@example.com",
    editors: ["e@example.com"],
    approvers: ["a@example.com"],
    suggesters: ["s@example.com"],
    editorMembers: ["owner@example.com", "e@example.com", "inherited@example.com"],
  };

  test("an approver edits, through the direct list as well as the effective set", () => {
    expect(isDocEditor(record, "a@example.com")).toBe(true);
    expect(isDocEditor(record, "inherited@example.com")).toBe(true);
    expect(isDocEditor(record, "owner@example.com")).toBe(true);
  });

  test("a suggester does not edit, and nobody does when there is no address", () => {
    expect(isDocEditor(record, "s@example.com")).toBe(false);
    expect(isDocEditor(record, "")).toBe(false);
    expect(isDocEditor(null, "owner@example.com")).toBe(false);
  });
});

describe("offersSuggest", () => {
  const ON_HEAD = {
    signedIn: true,
    maySuggest: true,
    mode: { kind: "reading", versionId: "v2", draft: false, sandboxed: true } as const,
    shownVersion: "v2",
    headVersion: "v2",
    expired: false,
  };

  test("is offered to an editor reading the draft, so editing stays a choice", () => {
    expect(offersSuggest({ ...ON_HEAD, mode: { ...ON_HEAD.mode, draft: true } })).toBe(true);
  });

  test("is offered on the published head", () => {
    expect(offersSuggest(ON_HEAD)).toBe(true);
  });

  test("is not offered on an older version, which no suggestion is recorded against", () => {
    expect(offersSuggest({ ...ON_HEAD, shownVersion: "v1" })).toBe(false);
  });

  test("is not offered in the editor, or before the head is known", () => {
    expect(offersSuggest({ ...ON_HEAD, mode: { kind: "editing", baseVersion: "v2" } })).toBe(false);
    expect(offersSuggest({ ...ON_HEAD, shownVersion: "", headVersion: "" })).toBe(false);
  });

  test("is not offered once expired, signed out, or to a reader who may not suggest", () => {
    expect(offersSuggest({ ...ON_HEAD, expired: true })).toBe(false);
    expect(offersSuggest({ ...ON_HEAD, signedIn: false })).toBe(false);
    expect(offersSuggest({ ...ON_HEAD, maySuggest: false })).toBe(false);
  });
});
