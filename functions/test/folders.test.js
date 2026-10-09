// SPDX-License-Identifier: Apache-2.0
// Effective membership: inheritance, team expansion, slugs, doc ids, cycles (SPEC §4, §13, §18).

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeMembership, isValidDocId, recomputeSubtree, slugify, uniqueDocId } = require("../lib/lib/folders.js");
const { fakeFirestore } = require("./fakes.js");
const { computeTeamMembers, referencedTeamIds } = require("../lib/lib/teams.js");
const { emptyGrants } = require("../lib/lib/access.js");

const OWNER = "owner@example.com";

/** A grants record with every role's list present, overriding only what a case names. */
const g = (viewers = [], editors = [], more = {}) => ({ ...emptyGrants(), viewers, editors, ...more });

const LADDER = ["approverMembers", "editorMembers", "suggesterMembers", "members"];

/** approver ⊆ editor ⊆ suggester ⊆ member, the invariant every check relies on. */
function assertLadder(m, label) {
  for (let i = 0; i + 1 < LADDER.length; i++) {
    const outer = new Set(m[LADDER[i + 1]]);
    for (const e of m[LADDER[i]]) {
      assert.ok(outer.has(e), `${label}: ${e} is in ${LADDER[i]} but not ${LADDER[i + 1]}`);
    }
  }
}

test("each role lands on its own rung and every rung below it", () => {
  const m = computeMembership(
    OWNER,
    g(["v@example.com"], ["e@example.com"], {
      suggesters: ["s@example.com"],
      approvers: ["a@example.com"],
    }),
    null,
  );
  assert.deepEqual(m.approverMembers, ["a@example.com", OWNER]);
  assert.deepEqual(m.editorMembers, ["a@example.com", "e@example.com", OWNER]);
  assert.deepEqual(m.suggesterMembers, ["a@example.com", "e@example.com", OWNER, "s@example.com"]);
  assert.deepEqual(m.members, [
    "a@example.com",
    "e@example.com",
    OWNER,
    "s@example.com",
    "v@example.com",
  ]);
});

test("the ladder holds for every mix of grants, parents and teams", () => {
  // Deterministic pseudo-random cases rather than a hand-picked few: the
  // invariant is what the rules and the endpoints lean on, so it is worth
  // checking where nobody thought to look.
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const people = ["a", "b", "c", "d", "team:t"].map((p) => (p.startsWith("team:") ? p : `${p}@example.com`));
  const teams = new Map([["t", ["t1@example.com", "t2@example.com"]]]);
  const pick = () => people.filter(() => rand(3) === 0);
  for (let i = 0; i < 200; i++) {
    const parentShape = rand(3);
    const parent =
      parentShape === 0
        ? null
        : parentShape === 1
          ? computeMembership("p@example.com", g(pick(), pick(), { suggesters: pick(), approvers: pick() }), null, teams)
          : { members: ["p@example.com", "x@example.com"], editorMembers: ["x@example.com"] }; // written before suggesters existed
    const m = computeMembership(
      OWNER,
      g(pick(), pick(), { suggesters: pick(), approvers: pick() }),
      parent,
      teams,
    );
    assertLadder(m, `case ${i}`);
  }
});

test("a parent written before the new sets existed loses nobody it held", () => {
  const legacy = { members: ["p@example.com", "pe@example.com"], editorMembers: ["pe@example.com"] };
  const m = computeMembership(OWNER, g(), legacy);
  assert.ok(m.editorMembers.includes("pe@example.com"));
  assert.ok(m.suggesterMembers.includes("pe@example.com"), "an inherited editor may suggest");
  assert.ok(!m.suggesterMembers.includes("p@example.com"), "an inherited viewer may not");
  assert.deepEqual(m.approverMembers, [OWNER], "nobody inherits approval that never existed");
});

test("the owner is always both a member and an editor", () => {
  const m = computeMembership(OWNER, g([], []), null);
  assert.deepEqual(m.members, [OWNER]);
  assert.deepEqual(m.editorMembers, [OWNER]);
});

test("editors are members; viewers are not editors", () => {
  const m = computeMembership(OWNER, g(["v@example.com"], ["e@example.com"]), null);
  assert.deepEqual(m.members, ["e@example.com", OWNER, "v@example.com"]);
  assert.deepEqual(m.editorMembers, ["e@example.com", OWNER]);
});

test("a parent's members flow down, and its editors flow down as editors", () => {
  const parent = { members: ["p@example.com", "pe@example.com"], editorMembers: ["pe@example.com"] };
  const m = computeMembership(OWNER, g([], []), parent);
  assert.ok(m.members.includes("p@example.com"));
  assert.ok(m.editorMembers.includes("pe@example.com"));
  assert.ok(!m.editorMembers.includes("p@example.com"), "a parent viewer stays a viewer");
});

test("inheritance is additive: a direct grant never drops an inherited one", () => {
  // This is the invariant the original CLI violated. It recomputed members
  // without the parent, so adding one reader silently revoked every
  // folder-inherited reader, and reported success.
  const parent = { members: ["inherited@example.com"], editorMembers: [] };
  const m = computeMembership(OWNER, g(["direct@example.com"], []), parent);
  assert.ok(m.members.includes("inherited@example.com"));
  assert.ok(m.members.includes("direct@example.com"));
});

test("a grant on a folder reaches a document two folders down, at its role", async () => {
  /**
   * Every case above is one parent step of the arithmetic. This is the walk:
   * a team granted on the top folder must arrive on a document filed in a
   * subfolder of a subfolder, on every rung its role reaches and none above.
   */
  // Each record starts as it stood before the grant: the owner on every rung.
  const before = Object.fromEntries(LADDER.map((k) => [k, [OWNER]]));
  const owned = (extra) => ({ ownerUid: "u-owner", ownerEmail: OWNER, ...emptyGrants(), ...before, ...extra });
  const { db, store } = fakeFirestore({
    "folders/top": owned({ parentId: null, ancestors: [], editors: ["team:crew"] }),
    "folders/mid": owned({ parentId: "top", ancestors: ["top"] }),
    "folders/leaf": owned({ parentId: "mid", ancestors: ["top", "mid"], viewers: ["leaf@example.com"] }),
    "docs/d1": owned({ folderId: "leaf" }),
    "teams/crew": { name: "Crew", ownerEmail: OWNER, members: [OWNER, "crew@example.com"] },
  });

  await recomputeSubtree(db, "top");

  const doc = store.get("docs/d1");
  assert.ok(doc.editorMembers.includes("crew@example.com"), "the team's editor grant reaches the document");
  assert.ok(doc.members.includes("crew@example.com"));
  assert.ok(!doc.approverMembers.includes("crew@example.com"), "and no higher than it was granted");
  assert.ok(doc.members.includes("leaf@example.com"), "the leaf's own grant still holds");
  assertLadder(doc, "d1");
  assert.ok(store.get("folders/mid").editorMembers.includes("crew@example.com"), "the folder between holds it too");
});

test("emails are lowercased and de-duplicated, and output is sorted", () => {
  const m = computeMembership("Owner@Example.com", g(["A@Example.com", "a@example.com"], []), null);
  assert.deepEqual(m.members, ["a@example.com", "owner@example.com"]);
});

test("a team grant expands to its members", () => {
  const teams = new Map([["design", ["bo@example.com", "cy@example.com"]]]);
  const m = computeMembership(OWNER, g(["team:design"], []), null, teams);
  assert.deepEqual(m.members, ["bo@example.com", "cy@example.com", OWNER]);
  assert.deepEqual(m.editorMembers, [OWNER], "a team VIEWER grant does not grant editing");
});

test("a team granted as editor expands into editorMembers", () => {
  const teams = new Map([["design", ["bo@example.com"]]]);
  const m = computeMembership(OWNER, g([], ["team:design"]), null, teams);
  assert.deepEqual(m.editorMembers, ["bo@example.com", OWNER]);
});

test("a grant naming an unknown team expands to nothing, so it denies", () => {
  // A deleted team must not leave stale access behind. Expanding to nothing is
  // the safe direction; throwing would leave membership unrecomputed and still
  // granting.
  const m = computeMembership(OWNER, g(["team:deleted"], []), null, new Map());
  assert.deepEqual(m.members, [OWNER]);
});

test("team expansion never leaks a team id into the flat member array", () => {
  // `members` is simultaneously the read gate and the query key, and the
  // Firestore list rule is only provable because it is a flat array of emails.
  const teams = new Map([["design", ["bo@example.com"]]]);
  const m = computeMembership(OWNER, g(["team:design"], []), null, teams);
  assert.ok(m.members.every((e) => !e.startsWith("team:")));
});

test("teams and people compose side by side", () => {
  const teams = new Map([["design", ["bo@example.com"]]]);
  const m = computeMembership(OWNER, g(["ana@example.com", "team:design"], []), null, teams);
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

test("a chosen doc id is slugify's own output space, and nothing wider", () => {
  for (const ok of ["01-platform", "a", "q3-acquisition-memo", "x".repeat(60)]) {
    assert.ok(isValidDocId(ok), ok);
  }
  // Each of these would need escaping somewhere a docId goes: a Realtime
  // Database key, an unencoded /d/ link, a quoted download filename.
  for (const bad of ["", "A", "01-Platform", "a--b", "-a", "a-", "a.b", "a_b", "__x__", "a/b", "a b", "x".repeat(61)]) {
    assert.ok(!isValidDocId(bad), JSON.stringify(bad));
  }
});

test("every valid doc id is a fixed point of slugify", () => {
  // uniqueDocId slugifies what it is given; a valid chosen id must come out
  // unchanged, or a publisher would get an id they did not ask for.
  for (const id of ["01-platform", "a", "x".repeat(60), "a1-b2-c3"]) {
    assert.equal(slugify(id), id);
  }
});

/** Firestore reduced to the one call uniqueDocId makes: does docs/{id} exist. */
function docsHolding(taken) {
  const asked = [];
  return {
    asked,
    collection: (name) => {
      assert.equal(name, "docs");
      return {
        doc: (id) => ({
          get: async () => {
            asked.push(id);
            return { exists: taken.has(id) };
          },
        }),
      };
    },
  };
}

test("a free id is used as asked", async () => {
  assert.equal(await uniqueDocId(docsHolding(new Set()), "01-platform"), "01-platform");
});

test("a taken id gets a random suffix, not a count", async () => {
  /**
   * A count told the publisher how many documents already held the name, and
   * made the next one guessable. The suffix is six characters from the id
   * alphabet, so the result is itself a valid id.
   */
  const db = docsHolding(new Set(["01-platform", "01-platform-2"]));
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const id = await uniqueDocId(db, "01-platform");
    assert.match(id, /^01-platform-[a-z0-9]{6}$/);
    seen.add(id);
  }
  assert.ok(seen.size > 15, "the suffix must vary between calls");
});

test("skipWanted never returns the bare id, even when no record holds it", async () => {
  // The caller has just been refused by Storage at that id: bytes are there
  // that no record accounts for yet.
  const id = await uniqueDocId(docsHolding(new Set()), "01-platform", true);
  assert.match(id, /^01-platform-[a-z0-9]{6}$/);
});

test("allocation gives up rather than loop when every candidate is taken", async () => {
  const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true }) }) }) };
  await assert.rejects(uniqueDocId(db, "01-platform"), /could not allocate a document id/);
});
