// SPDX-License-Identifier: Apache-2.0
// The ESM and CommonJS membership implementations must agree (SPEC §13).

const test = require("node:test");
const assert = require("node:assert/strict");

const cjs = require("../lib/lib/folders.js");

/**
 * `scripts/` is ESM and `functions/` is CommonJS, so `computeMembership` exists
 * twice on purpose. Duplication is allowed here — a shared build artifact is
 * more machinery and one more thing to be stale — but only because this test
 * holds the two in agreement.
 *
 * The defect this prevents is not hypothetical. In the design being rebuilt,
 * the script had its own arithmetic, which omitted the parent folder, so
 * granting one person access silently revoked every inherited reader.
 */
const CASES = [
  {
    name: "owner only",
    owner: "owner@example.com",
    viewers: [],
    editors: [],
    parent: null,
    teams: {},
  },
  {
    name: "direct grants",
    owner: "owner@example.com",
    viewers: ["v@example.com"],
    editors: ["e@example.com"],
    parent: null,
    teams: {},
  },
  {
    name: "inherited from a folder",
    owner: "owner@example.com",
    viewers: ["v@example.com"],
    editors: [],
    parent: { members: ["p@example.com"], editorMembers: ["pe@example.com"] },
    teams: {},
  },
  {
    name: "team expansion",
    owner: "owner@example.com",
    viewers: ["team:design", "ana@example.com"],
    editors: ["team:leads"],
    parent: null,
    teams: { design: ["bo@example.com", "cy@example.com"], leads: ["di@example.com"] },
  },
  {
    name: "unknown team",
    owner: "owner@example.com",
    viewers: ["team:gone"],
    editors: [],
    parent: null,
    teams: {},
  },
  {
    name: "mixed case and duplicates",
    owner: "Owner@Example.com",
    viewers: ["A@Example.com", "a@example.com", "b@example.com"],
    editors: ["A@Example.com"],
    parent: { members: ["Owner@Example.com"], editorMembers: [] },
    teams: {},
  },
  {
    name: "suggesters and approvers, direct and by team",
    owner: "owner@example.com",
    viewers: ["v@example.com"],
    suggesters: ["s@example.com", "team:design"],
    editors: ["e@example.com"],
    approvers: ["a@example.com", "team:leads"],
    parent: null,
    teams: { design: ["bo@example.com"], leads: ["di@example.com"] },
  },
  {
    name: "an approver inherited from a folder",
    owner: "owner@example.com",
    viewers: [],
    editors: [],
    parent: {
      members: ["pa@example.com", "ps@example.com"],
      suggesterMembers: ["pa@example.com", "ps@example.com"],
      editorMembers: ["pa@example.com"],
      approverMembers: ["pa@example.com"],
    },
    teams: {},
  },
  {
    name: "a parent written before suggesters existed",
    owner: "owner@example.com",
    viewers: [],
    suggesters: ["s@example.com"],
    editors: [],
    parent: { members: ["p@example.com", "pe@example.com"], editorMembers: ["pe@example.com"] },
    teams: {},
  },
  {
    name: "everything at once",
    owner: "owner@example.com",
    viewers: ["team:design", "v@example.com"],
    editors: ["team:leads", "e@example.com"],
    parent: { members: ["p@example.com"], editorMembers: ["pe@example.com"] },
    teams: { design: ["bo@example.com"], leads: ["di@example.com"] },
  },
  {
    name: "everything at once, in the Trash",
    owner: "Owner@example.com",
    viewers: ["team:design", "v@example.com"],
    suggesters: ["s@example.com"],
    editors: ["team:leads", "e@example.com"],
    approvers: ["a@example.com"],
    parent: { members: ["p@example.com"], editorMembers: ["pe@example.com"] },
    teams: { design: ["bo@example.com"], leads: ["di@example.com"] },
    trashed: true,
  },
];

/** A case's grants with every role's list present, as both twins require. */
function grantsFor(c) {
  const { emptyGrants } = require("../lib/lib/access.js");
  const grants = emptyGrants();
  for (const list of Object.keys(grants)) if (c[list]) grants[list] = c[list];
  return grants;
}

test("both implementations agree across the fixture table", async () => {
  const esm = await import("../../scripts/lib/membership.mjs");
  for (const c of CASES) {
    const teams = new Map(Object.entries(c.teams));
    const fromCjs = cjs.computeMembership(c.owner, grantsFor(c), c.parent, teams, c.trashed === true);
    const fromEsm = esm.computeMembership(c.owner, grantsFor(c), c.parent, teams, c.trashed === true);
    assert.deepEqual(fromEsm, fromCjs, c.name);
  }
});

// Pinned, not only compared: two twins that drifted together would still agree.
test("in the Trash, both give the owner alone in every set, whatever the grants and the parent", async () => {
  const esm = await import("../../scripts/lib/membership.mjs");
  const c = CASES.find((x) => x.trashed);
  const alone = ["owner@example.com"];
  const want = { members: alone, suggesterMembers: alone, editorMembers: alone, approverMembers: alone };
  const teams = new Map(Object.entries(c.teams));
  assert.deepEqual(cjs.computeMembership(c.owner, grantsFor(c), c.parent, teams, true), want);
  assert.deepEqual(esm.computeMembership(c.owner, grantsFor(c), c.parent, teams, true), want);
});

test("both decide what is in the Trash identically: a map, and nothing else", async () => {
  const esm = await import("../../scripts/lib/membership.mjs");
  const acl = require("../lib/lib/acl.js");
  const records = [{}, { trashed: null }, { trashed: { batch: "b" } }, { trashed: {} }, { trashed: "yes" }, { trashed: true }, { trashed: [] }, null, undefined];
  const want = [false, false, true, true, false, false, false, false, false];
  assert.deepEqual(records.map((r) => acl.isTrashed(r)), want);
  assert.deepEqual(records.map((r) => esm.isTrashed(r)), want);
});

test("both implementations name the same roles and grant lists", async () => {
  const esm = await import("../../scripts/lib/membership.mjs");
  const { ROLES, GRANT_LIST } = require("../lib/lib/access.js");
  assert.deepEqual(esm.ROLES, [...ROLES]);
  assert.deepEqual(esm.GRANT_LIST, GRANT_LIST);
});

test("both implementations read grants and membership off a record identically", async () => {
  const esm = await import("../../scripts/lib/membership.mjs");
  const { grantsOf } = require("../lib/lib/access.js");
  const records = [
    {},
    { viewers: ["a@example.com", 7, null], editors: "not a list" },
    { viewers: ["team:x"], editors: ["e@example.com"], members: ["m@example.com"] },
  ];
  for (const r of records) {
    assert.deepEqual(esm.grantsOf(r), grantsOf(r), JSON.stringify(r));
    assert.deepEqual(esm.membershipOf(r), cjs.membershipOf(r), JSON.stringify(r));
  }
});

test("the ESM twin refuses a grants record that is missing a role's list", async () => {
  // The TypeScript twin cannot be called with one; a script can. Accepting it
  // would write that role's people out of every derived set.
  const esm = await import("../../scripts/lib/membership.mjs");
  for (const list of Object.keys(esm.grantsOf({}))) {
    const grants = esm.grantsOf({});
    delete grants[list];
    assert.throws(() => esm.computeMembership("owner@example.com", grants), new RegExp(list));
  }
});

test("both implementations normalize emails identically", async () => {
  const esm = await import("../../scripts/lib/membership.mjs");
  const { normalizeEmail } = require("../lib/lib/access.js");
  for (const raw of ["  A@Example.com ", "b@example.com", "", "  "]) {
    assert.equal(esm.normalizeEmail(raw), normalizeEmail(raw), JSON.stringify(raw));
  }
});

test("both implementations parse a team reference identically", async () => {
  const esm = await import("../../scripts/lib/membership.mjs");
  const { isTeamRef, teamIdOf } = require("../lib/lib/access.js");
  for (const raw of ["team:abc", "team:", "a@example.com", "teams:abc"]) {
    assert.equal(esm.isTeamRef(raw), isTeamRef(raw), raw);
    assert.equal(esm.teamIdOf(raw), teamIdOf(raw), raw);
  }
});
