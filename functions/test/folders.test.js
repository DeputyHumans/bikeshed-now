// SPDX-License-Identifier: Apache-2.0
// Effective membership: inheritance, team expansion, slugs, cycles (SPEC §13, §18).

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeMembership, slugify } = require("../lib/lib/folders.js");
const { computeTeamMembers, referencedTeamIds } = require("../lib/lib/teams.js");

const OWNER = "owner@example.com";

test("the owner is always both a member and an editor", () => {
  const m = computeMembership(OWNER, [], [], null);
  assert.deepEqual(m.members, [OWNER]);
  assert.deepEqual(m.editorMembers, [OWNER]);
});

test("editors are members; viewers are not editors", () => {
  const m = computeMembership(OWNER, ["v@example.com"], ["e@example.com"], null);
  assert.deepEqual(m.members, ["e@example.com", OWNER, "v@example.com"]);
  assert.deepEqual(m.editorMembers, ["e@example.com", OWNER]);
});

test("a parent's members flow down, and its editors flow down as editors", () => {
  const parent = { members: ["p@example.com", "pe@example.com"], editorMembers: ["pe@example.com"] };
  const m = computeMembership(OWNER, [], [], parent);
  assert.ok(m.members.includes("p@example.com"));
  assert.ok(m.editorMembers.includes("pe@example.com"));
  assert.ok(!m.editorMembers.includes("p@example.com"), "a parent viewer stays a viewer");
});

test("inheritance is additive: a direct grant never drops an inherited one", () => {
  // This is the invariant the original CLI violated. It recomputed members
  // without the parent, so adding one reader silently revoked every
  // folder-inherited reader, and reported success.
  const parent = { members: ["inherited@example.com"], editorMembers: [] };
  const m = computeMembership(OWNER, ["direct@example.com"], [], parent);
  assert.ok(m.members.includes("inherited@example.com"));
  assert.ok(m.members.includes("direct@example.com"));
});

test("emails are lowercased and de-duplicated, and output is sorted", () => {
  const m = computeMembership("Owner@Example.com", ["A@Example.com", "a@example.com"], [], null);
  assert.deepEqual(m.members, ["a@example.com", "owner@example.com"]);
});

test("a team grant expands to its members", () => {
  const teams = new Map([["design", ["bo@example.com", "cy@example.com"]]]);
  const m = computeMembership(OWNER, ["team:design"], [], null, teams);
  assert.deepEqual(m.members, ["bo@example.com", "cy@example.com", OWNER]);
  assert.deepEqual(m.editorMembers, [OWNER], "a team VIEWER grant does not grant editing");
});

test("a team granted as editor expands into editorMembers", () => {
  const teams = new Map([["design", ["bo@example.com"]]]);
  const m = computeMembership(OWNER, [], ["team:design"], null, teams);
  assert.deepEqual(m.editorMembers, ["bo@example.com", OWNER]);
});

test("a grant naming an unknown team expands to nothing, so it denies", () => {
  // A deleted team must not leave stale access behind. Expanding to nothing is
  // the safe direction; throwing would leave membership unrecomputed and still
  // granting.
  const m = computeMembership(OWNER, ["team:deleted"], [], null, new Map());
  assert.deepEqual(m.members, [OWNER]);
});

test("team expansion never leaks a team id into the flat member array", () => {
  // `members` is simultaneously the read gate and the query key, and the
  // Firestore list rule is only provable because it is a flat array of emails.
  const teams = new Map([["design", ["bo@example.com"]]]);
  const m = computeMembership(OWNER, ["team:design"], [], null, teams);
  assert.ok(m.members.every((e) => !e.startsWith("team:")));
});

test("teams and people compose side by side", () => {
  const teams = new Map([["design", ["bo@example.com"]]]);
  const m = computeMembership(OWNER, ["ana@example.com", "team:design"], [], null, teams);
  assert.deepEqual(m.members, ["ana@example.com", "bo@example.com", OWNER]);
});

test("referenced team ids are collected across every grant list", () => {
  assert.deepEqual(
    referencedTeamIds(["team:a", "x@example.com"], ["team:b", "team:a"]).sort(),
    ["a", "b"],
  );
  assert.deepEqual(referencedTeamIds(["x@example.com"]), []);
});

test("a team's own member set always contains its owner", () => {
  assert.deepEqual(computeTeamMembers("Owner@Example.com", ["b@example.com"]), [
    "b@example.com",
    "owner@example.com",
  ]);
  assert.deepEqual(computeTeamMembers(OWNER, []), [OWNER]);
});

test("slugs are URL-safe, bounded, and never empty", () => {
  assert.equal(slugify("Q3 Acquisition Memo"), "q3-acquisition-memo");
  assert.equal(slugify("  Trailing --- dashes  "), "trailing-dashes");
  assert.equal(slugify("!!!"), "untitled");
  assert.equal(slugify(""), "untitled");
  assert.ok(slugify("x".repeat(200)).length <= 60);
  assert.match(slugify("Ünïcödé Ttitle"), /^[a-z0-9-]+$/);
});
