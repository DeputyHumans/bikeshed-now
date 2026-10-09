// SPDX-License-Identifier: Apache-2.0
// POST /suggestion, driven end to end: who may do what, and what it leaves (SPEC §22).

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeFirestore, withFakeAdmin, fakeToken, invoke } = require("./fakes.js");
const { manageSuggestion } = require("../lib/index.js");
const { pendingSuggestions } = require("../lib/lib/review.js");
const { SUGGESTION_LIMITS, SUGGESTION_COLOR } = require("../lib/lib/suggestions.js");

const OWNER = { uid: "u-owner", email: "owner@example.com" };
const VIEWER = { uid: "u-viewer", email: "viewer@example.com" };
const SUGGESTER = { uid: "u-sug", email: "sug@example.com" };
const EDITOR = { uid: "u-ed", email: "ed@example.com" };
const APPROVER = { uid: "u-appr", email: "appr@example.com" };
const STRANGER = { uid: "u-stranger", email: "stranger@example.com" };
const PEOPLE = [OWNER, VIEWER, SUGGESTER, EDITOR, APPROVER, STRANGER];

const ANCHOR = { elementId: "s1", exact: "a single weekend", prefix: "cut over in ", suffix: ".", start: 12, end: 28 };

function docRecord(overrides = {}) {
  const e = (...ps) => ps.map((p) => p.email);
  return {
    docId: "d1",
    title: "Migration",
    ownerUid: OWNER.uid,
    ownerEmail: OWNER.email,
    currentVersion: "v1",
    viewers: e(VIEWER),
    suggesters: e(SUGGESTER),
    editors: e(EDITOR),
    approvers: e(APPROVER),
    members: e(OWNER, VIEWER, SUGGESTER, EDITOR, APPROVER),
    suggesterMembers: e(OWNER, SUGGESTER, EDITOR, APPROVER),
    editorMembers: e(OWNER, EDITOR, APPROVER),
    approverMembers: e(OWNER, APPROVER),
    visibility: "private",
    ...overrides,
  };
}

/** A fresh world: the document, its version, a session per person, two tokens. */
function world(overrides = {}) {
  const sugToken = fakeToken({ uid: SUGGESTER.uid, email: SUGGESTER.email, channel: "mcp" });
  const apprToken = fakeToken({ uid: APPROVER.uid, email: APPROVER.email, channel: "mcp" });
  const { db, store } = fakeFirestore({
    "docs/d1": docRecord(overrides),
    "docs/d1/versions/v1": { versionId: "v1" },
    [sugToken.path]: sugToken.record,
    [apprToken.path]: apprToken.record,
  });
  const sessions = Object.fromEntries(
    PEOPLE.map((p) => [`s-${p.uid}`, { uid: p.uid, email: p.email, email_verified: true }]),
  );
  const as = (p) => ({ cookie: `__session=s-${p.uid}` });
  const call = (headers, body) =>
    withFakeAdmin({ db, sessions }, () =>
      invoke(manageSuggestion, { headers, body: { docId: "d1", versionId: "v1", ...body } }),
    );
  const ann = (annId) => store.get(`docs/d1/versions/v1/annotations/${annId}`);
  const comments = (annId) =>
    [...store.entries()]
      .filter(([p]) => p.startsWith(`docs/d1/versions/v1/annotations/${annId}/comments/`))
      .map(([, d]) => d);
  return {
    db,
    store,
    as,
    call,
    ann,
    comments,
    bearer: { suggester: { authorization: `Bearer ${sugToken.bearer}` }, approver: { authorization: `Bearer ${apprToken.bearer}` } },
  };
}

const create = (w, who, extra = {}) =>
  w.call(who, { op: "create", anchor: ANCHOR, replacement: "two weekends", ...extra });

/** A pending suggestion by SUGGESTER, and its id. */
async function suggested(w) {
  const r = await create(w, w.as(SUGGESTER));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.annId;
}

/** The approver's editing session has saved a draft of v1. */
const withDraft = (w) => w.store.set("docs/d1", { ...w.store.get("docs/d1"), draft: { baseVersion: "v1", entry: "index.html" } });

// --- Creating --------------------------------------------------------------

test("a suggester's suggestion is a pending annotation with an opening comment, and nothing answers cacheably", async () => {
  const w = world();
  const r = await create(w, w.as(SUGGESTER));
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "private, no-store");
  const a = w.ann(r.body.annId);
  assert.deepEqual(a.suggestion, { replacement: "two weekends", state: "pending" });
  assert.equal(a.resolved, false, "pending is an open thread, which is what the publish gate counts");
  assert.equal(a.color, SUGGESTION_COLOR);
  assert.deepEqual(a.anchor, ANCHOR);
  assert.equal(a.actor.channel, "web");
  const [opener] = w.comments(r.body.annId);
  assert.equal(opener.opensSuggestion, true);
  assert.equal(opener.generated, true);
  assert.equal(opener.body, "Suggested replacing “a single weekend” with “two weekends”.");
});

test("a note becomes the opening comment, in the author's own words", async () => {
  const w = world();
  const r = await create(w, w.as(SUGGESTER), { note: "  There is a dual-write fortnight.  " });
  const [opener] = w.comments(r.body.annId);
  assert.equal(opener.body, "There is a dual-write fortnight.");
  assert.equal(opener.generated, undefined);
});

test("an empty replacement suggests deleting the text", async () => {
  const w = world();
  const r = await create(w, w.as(SUGGESTER), { replacement: "" });
  assert.equal(r.status, 200);
  assert.equal(w.comments(r.body.annId)[0].body, "Suggested deleting “a single weekend”.");
});

test("who may suggest: suggesters and up; a reader is refused, and a stranger told nothing", async () => {
  const w = world();
  for (const p of [SUGGESTER, EDITOR, APPROVER, OWNER]) {
    assert.equal((await create(w, w.as(p))).status, 200, p.email);
  }
  const viewer = await create(w, w.as(VIEWER));
  assert.equal(viewer.status, 403);
  assert.equal((await create(w, w.as(STRANGER))).status, 404);
  assert.equal((await create(w, {})).status, 401);
});

test("only POST is answered", async () => {
  const w = world();
  const r = await withFakeAdmin({ db: w.db }, () => invoke(manageSuggestion, { method: "GET" }));
  assert.equal(r.status, 405);
  assert.equal(r.headers["cache-control"], "private, no-store");
});

test("a suggestion is made on the current version, and a frozen document takes none", async () => {
  const w = world({ currentVersion: "v2" });
  const r = await create(w, w.as(SUGGESTER));
  assert.equal(r.status, 409);
  assert.equal(r.body.currentVersion, "v2");
  const expired = world({ expiresAt: Date.now() - 1000 });
  assert.equal((await create(expired, expired.as(OWNER))).status, 409);
});

test("a replacement is text on one line, and different from what it replaces", async () => {
  const w = world();
  for (const bad of ["two\nweekends", "two\tweekends", "two‮weekends", "a single weekend"]) {
    assert.equal((await create(w, w.as(SUGGESTER), { replacement: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await w.call(w.as(SUGGESTER), { op: "create", anchor: ANCHOR })).status, 400, "no replacement at all");
  assert.equal((await create(w, w.as(SUGGESTER), { anchor: { ...ANCHOR, exact: "" } })).status, 400);
});

test("an agent proposes through its person's role, stamped as the agent", async () => {
  const w = world();
  const r = await create(w, w.bearer.suggester);
  assert.equal(r.status, 200);
  assert.equal(w.ann(r.body.annId).actor.channel, "mcp");
});

test("one author may have twenty pending on a version, and no more", async () => {
  const w = world();
  for (let i = 0; i < SUGGESTION_LIMITS.pendingPerAuthor; i++) {
    assert.equal((await create(w, w.as(SUGGESTER), { replacement: `option ${i}` })).status, 200);
  }
  const over = await create(w, w.as(SUGGESTER), { replacement: "one more" });
  assert.equal(over.status, 409);
  assert.match(over.body.error, /withdraw one/);
  assert.equal((await create(w, w.as(EDITOR))).status, 200, "the cap is per author");
});

// --- Deciding --------------------------------------------------------------

test("a suggestion is never written on a version that is no longer current", async () => {
  // The endpoint checks the version before it writes; a publish landing in
  // between would leave the suggestion on a version nobody reads.
  const { createSuggestion } = require("../lib/lib/suggestions.js");
  const w = world();
  w.store.set("docs/d1", { ...w.store.get("docs/d1"), currentVersion: "v2" });
  const r = await createSuggestion({
    db: w.db,
    docRef: w.db.collection("docs").doc("d1"),
    versionId: "v1",
    anchor: ANCHOR,
    replacement: "two weekends",
    note: "",
    author: { uid: SUGGESTER.uid, emailLower: SUGGESTER.email },
    actor: { uid: SUGGESTER.uid, email: SUGGESTER.email, channel: "web" },
    color: SUGGESTION_COLOR,
  });
  assert.equal(r.status, 409);
  assert.equal(await pendingSuggestions(w.db.collection("docs").doc("d1"), "v1"), 0);
});

test("a quote of nothing but whitespace is refused", async () => {
  const w = world();
  const r = await create(w, w.as(SUGGESTER), { anchor: { ...ANCHOR, exact: " \n\t " } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /exact/);
});

test("no decision comes from a token through this endpoint, not even an approver's", async () => {
  // Here an accept records what the approver's browser applied, which a token
  // cannot have done; an agent decides through its tools (ADR 0015).
  const w = world();
  const annId = await suggested(w);
  withDraft(w);
  for (const op of ["claim", "accept", "reject"]) {
    const r = await w.call(w.bearer.approver, { op, annId });
    assert.equal(r.status, 403, op);
    assert.match(r.body.error, /decided in the app/);
  }
  const a = w.ann(annId);
  assert.equal(a.suggestion.state, "pending");
  assert.equal(a.suggestion.claim, undefined, "not even held");
});

test("an agent changes or takes back its person's own suggestion, and nobody else's", async () => {
  const w = world();
  const theirs = await suggested(w); // made by SUGGESTER in the app
  const others = (await create(w, w.as(APPROVER))).body.annId;

  // Its person's own, though made in the browser: the token acts for them.
  const revised = await w.call(w.bearer.suggester, { op: "revise", annId: theirs, replacement: "a fortnight" });
  assert.deepEqual(revised.body, { state: "pending" });
  const after = w.ann(theirs).suggestion;
  assert.equal(after.replacement, "a fortnight");
  assert.equal(after.revisions[0].replacement, "two weekends", "the earlier text is kept");
  assert.equal(after.revisions[0].actor.channel, "mcp", "and says it was changed through a token");

  // Somebody else's, even an approver's token cannot touch: it is not theirs.
  for (const op of ["revise", "withdraw"]) {
    const r = await w.call(w.bearer.suggester, { op, annId: others, replacement: "x" });
    assert.equal(r.status, 403, op);
  }

  const withdrawn = await w.call(w.bearer.suggester, { op: "withdraw", annId: theirs });
  assert.deepEqual(withdrawn.body, { state: "withdrawn" });
  const closed = w.ann(theirs);
  assert.equal(closed.resolved, true);
  assert.equal(closed.suggestion.decidedBy.channel, "mcp");
  assert.equal(w.ann(others).suggestion.state, "pending");
});

test("an editor edits, but does not decide", async () => {
  const w = world();
  const annId = await suggested(w);
  withDraft(w);
  for (const op of ["claim", "accept", "reject"]) {
    assert.equal((await w.call(w.as(EDITOR), { op, annId })).status, 403, op);
  }
});

test("accepting records a decision the approver's own session has already applied", async () => {
  const w = world();
  const annId = await suggested(w);
  const noDraft = await w.call(w.as(APPROVER), { op: "accept", annId });
  assert.equal(noDraft.status, 409, "nothing applied yet: there is no draft for it to be in");
  assert.equal(w.ann(annId).suggestion.state, "pending");

  assert.equal((await w.call(w.as(APPROVER), { op: "claim", annId })).status, 200);
  withDraft(w);
  const r = await w.call(w.as(APPROVER), { op: "accept", annId });
  assert.deepEqual(r.body, { state: "accepted" });
  const a = w.ann(annId);
  assert.equal(a.suggestion.state, "accepted");
  assert.equal(a.resolved, true);
  assert.equal(a.suggestion.claim, undefined, "the claim goes with the decision");
  assert.equal(a.suggestion.decidedBy.email, APPROVER.email);
  assert.ok(w.comments(annId).some((c) => c.body === "Accepted." && c.generated === true));

  // A retry after a dropped response is a success, not a conflict.
  assert.deepEqual((await w.call(w.as(APPROVER), { op: "accept", annId })).body, { state: "accepted" });
  assert.equal((await w.call(w.as(OWNER), { op: "reject", annId })).status, 409);
});

test("rejecting says why in the thread, which is how the suggester hears", async () => {
  const w = world();
  const annId = await suggested(w);
  const r = await w.call(w.as(OWNER), { op: "reject", annId, reason: "  Keep the weekend.  " });
  assert.deepEqual(r.body, { state: "rejected" });
  assert.equal(w.ann(annId).resolved, true);
  assert.ok(w.comments(annId).some((c) => c.body === "Rejected: Keep the weekend."));
  assert.equal((await w.call(w.as(OWNER), { op: "reject", annId })).status, 200, "idempotent");
});

test("a claim keeps a second approver off until it lapses, so a change is applied once", async () => {
  const w = world();
  const annId = await suggested(w);
  withDraft(w);
  assert.equal((await w.call(w.as(APPROVER), { op: "claim", annId })).status, 200);
  for (const op of ["claim", "accept", "reject"]) {
    const r = await w.call(w.as(OWNER), { op, annId });
    assert.equal(r.status, 409, op);
    assert.equal(r.body.claimedBy, APPROVER.email);
  }
  assert.equal((await w.call(w.as(SUGGESTER), { op: "withdraw", annId })).status, 409, "nor withdrawn under it");

  // Lapsed: anyone may take it.
  const a = w.ann(annId);
  a.suggestion.claim.until = require("firebase-admin").firestore.Timestamp.fromMillis(Date.now() - 1);
  assert.equal((await w.call(w.as(OWNER), { op: "claim", annId })).status, 200);
});

test("a claim or an accept for a replacement its author has since changed is refused", async () => {
  // The approver applies the replacement on their screen. A revision landing
  // first meant the old text went into the draft and was recorded as accepted.
  const w = world();
  const annId = await suggested(w);
  assert.equal((await w.call(w.as(SUGGESTER), { op: "revise", annId, replacement: "a fortnight" })).status, 200);
  const stale = await w.call(w.as(APPROVER), { op: "claim", annId, replacement: "two weekends" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.changed, true);
  assert.equal(w.ann(annId).suggestion.claim, undefined, "nothing claimed on a mistaken reading");
  assert.equal((await w.call(w.as(APPROVER), { op: "claim", annId, replacement: "a fortnight" })).status, 200);

  // The claim lapses while the approver works, and the author revises again.
  w.ann(annId).suggestion.claim.until = require("firebase-admin").firestore.Timestamp.fromMillis(Date.now() - 1);
  assert.equal((await w.call(w.as(SUGGESTER), { op: "revise", annId, replacement: "three weeks" })).status, 200);
  withDraft(w);
  const late = await w.call(w.as(APPROVER), { op: "accept", annId, replacement: "a fortnight" });
  assert.equal(late.status, 409, "what is in the draft is not what would be recorded");
  assert.equal(w.ann(annId).suggestion.state, "pending");
  assert.equal((await w.call(w.as(APPROVER), { op: "accept", annId, replacement: "three weeks" })).status, 200);
});

test("an approver lets go of their own claim when the change could not be made, and only their own", async () => {
  const w = world();
  const annId = await suggested(w);
  assert.equal((await w.call(w.as(APPROVER), { op: "claim", annId })).status, 200);
  const other = await w.call(w.as(OWNER), { op: "release", annId });
  assert.equal(other.status, 409, "nobody lets go of somebody else's claim");
  assert.ok(w.ann(annId).suggestion.claim);
  assert.equal((await w.call(w.as(APPROVER), { op: "release", annId })).status, 200);
  assert.equal(w.ann(annId).suggestion.claim, undefined);
  // Free at once: no two-minute wait for the next approver, or for the author.
  assert.equal((await w.call(w.as(SUGGESTER), { op: "withdraw", annId })).status, 200);
  assert.equal((await w.call(w.as(APPROVER), { op: "release", annId })).status, 200, "harmless once decided");
  assert.equal((await w.call(w.bearer.approver, { op: "release", annId })).status, 403, "a person's step, in the app");
});

test("claiming and accepting are refused once the version has moved on", async () => {
  const w = world();
  const annId = await suggested(w);
  w.store.set("docs/d1", { ...w.store.get("docs/d1"), currentVersion: "v2" });
  assert.equal((await w.call(w.as(APPROVER), { op: "claim", annId })).status, 409);
  assert.equal((await w.call(w.as(APPROVER), { op: "accept", annId })).status, 409);
});

// --- The author's own ------------------------------------------------------

test("its author may change a pending suggestion, and the generated opener follows", async () => {
  const w = world();
  const annId = await suggested(w);
  assert.equal((await w.call(w.as(EDITOR), { op: "revise", annId, replacement: "x" })).status, 403);
  const r = await w.call(w.as(SUGGESTER), { op: "revise", annId, replacement: "a fortnight" });
  assert.equal(r.status, 200);
  assert.equal(w.ann(annId).suggestion.replacement, "a fortnight");
  assert.equal(w.comments(annId)[0].body, "Suggested replacing “a single weekend” with “a fortnight”.");
  assert.equal((await w.call(w.as(SUGGESTER), { op: "revise", annId, replacement: "a\nb" })).status, 400);
});

test("an author who may no longer suggest can take a suggestion back, not rewrite it", async () => {
  // Revise needed only read access and authorship, so a suggester demoted to
  // viewer could still change the text an approver is about to apply.
  const w = world();
  const annId = await suggested(w);
  const doc = w.store.get("docs/d1");
  w.store.set("docs/d1", {
    ...doc,
    suggesters: [],
    viewers: [...doc.viewers, SUGGESTER.email],
    suggesterMembers: doc.suggesterMembers.filter((e) => e !== SUGGESTER.email),
  });
  const r = await w.call(w.as(SUGGESTER), { op: "revise", annId, replacement: "a fortnight" });
  assert.equal(r.status, 403);
  assert.equal(w.ann(annId).suggestion.replacement, "two weekends");
  assert.equal((await w.call(w.as(SUGGESTER), { op: "withdraw", annId })).status, 200);
});

test("a note the author wrote stays theirs until they send a new one", async () => {
  const w = world();
  const r = await create(w, w.as(SUGGESTER), { note: "Dual-write." });
  await w.call(w.as(SUGGESTER), { op: "revise", annId: r.body.annId, replacement: "a fortnight" });
  assert.equal(w.comments(r.body.annId)[0].body, "Dual-write.");
  await w.call(w.as(SUGGESTER), { op: "revise", annId: r.body.annId, replacement: "a month", note: "Longer." });
  assert.equal(w.comments(r.body.annId)[0].body, "Longer.");
});

test("its author withdraws a pending suggestion, and the thread stays to say so", async () => {
  const w = world();
  const ref = w.db.collection("docs").doc("d1");
  const annId = await suggested(w);
  await w.call(w.as(OWNER), { op: "create", anchor: ANCHOR, replacement: "x" }); // somebody else's, untouched
  assert.equal((await w.call(w.as(OWNER), { op: "withdraw", annId })).status, 403, "only its author");
  assert.deepEqual((await w.call(w.as(SUGGESTER), { op: "withdraw", annId })).body, { state: "withdrawn" });

  const a = w.ann(annId);
  assert.ok(a, "kept, not deleted: what was proposed and taken back is part of the record");
  assert.equal(a.suggestion.state, "withdrawn");
  assert.equal(a.suggestion.replacement, "two weekends", "what was proposed is still there");
  assert.equal(a.resolved, true, "closed, or it would hold back every new version with nobody able to clear it");
  assert.equal(a.suggestion.decidedBy.email, SUGGESTER.email);
  assert.ok(a.suggestion.decidedAt, "when");
  assert.equal(a.suggestion.claim, undefined);
  const bodies = w.comments(annId).map((c) => c.body);
  assert.equal(bodies[0], "Suggested replacing “a single weekend” with “two weekends”.", "the opener survives");
  assert.ok(w.comments(annId).some((c) => c.body === "Withdrawn." && c.generated === true));
  assert.equal(await pendingSuggestions(ref, "v1"), 1, "only the owner's own suggestion still holds the gate");

  // A retry after a dropped response is a success; nothing else reopens it.
  assert.deepEqual((await w.call(w.as(SUGGESTER), { op: "withdraw", annId })).body, { state: "withdrawn" });
  assert.equal(w.comments(annId).filter((c) => c.body === "Withdrawn.").length, 1, "said once");
  withDraft(w);
  for (const [who, op] of [[SUGGESTER, "revise"], [APPROVER, "claim"], [APPROVER, "accept"], [APPROVER, "reject"]]) {
    const r = await w.call(w.as(who), { op, annId, replacement: "y" });
    assert.equal(r.status, 409, op);
    assert.match(r.body.error, /already been withdrawn/);
  }

  const decided = await suggested(w);
  await w.call(w.as(OWNER), { op: "reject", annId: decided });
  assert.equal((await w.call(w.as(SUGGESTER), { op: "withdraw", annId: decided })).status, 409, "a decision stands");
});

test("suggested, changed twice, withdrawn: every earlier form is kept, oldest first", async () => {
  const w = world();
  const r = await create(w, w.as(SUGGESTER), { note: "Dual-write." });
  const annId = r.body.annId;
  const revise = (extra) => w.call(w.as(SUGGESTER), { op: "revise", annId, ...extra });

  assert.equal((await revise({ replacement: "a fortnight" })).status, 200);
  assert.equal((await revise({ replacement: "a month", note: "Longer." })).status, 200);
  const changed = w.ann(annId).suggestion;
  assert.equal(changed.replacement, "a month");
  assert.deepEqual(
    changed.revisions.map(({ replacement, note }) => ({ replacement, note })),
    [
      { replacement: "two weekends", note: undefined },
      { replacement: "a fortnight", note: "Dual-write." },
    ],
    "each entry holds what its change replaced; the note only when a new one replaced the author's",
  );
  for (const entry of changed.revisions) {
    assert.equal(typeof entry.at.toMillis(), "number", "a real timestamp, not a server sentinel in an array");
    assert.equal(entry.actor.channel, "web");
  }
  assert.equal(w.comments(annId)[0].body, "Longer.", "the opener still says the current note");

  assert.equal((await w.call(w.as(SUGGESTER), { op: "withdraw", annId })).status, 200);
  const closed = w.ann(annId).suggestion;
  assert.equal(closed.state, "withdrawn");
  assert.equal(closed.revisions.length, 2, "withdrawing keeps the history too");
});

test("a suggestion may be changed twenty times, and then must be suggested afresh", async () => {
  const w = world();
  const annId = await suggested(w);
  for (let i = 0; i < SUGGESTION_LIMITS.revisions; i++) {
    const r = await w.call(w.as(SUGGESTER), { op: "revise", annId, replacement: `option ${i}` });
    assert.equal(r.status, 200, `revision ${i}`);
  }
  const over = await w.call(w.as(SUGGESTER), { op: "revise", annId, replacement: "one more" });
  assert.equal(over.status, 409);
  assert.match(over.body.error, /Withdraw it and suggest it again/);
  const a = w.ann(annId);
  assert.equal(a.suggestion.replacement, `option ${SUGGESTION_LIMITS.revisions - 1}`, "the refused change changed nothing");
  assert.equal(a.suggestion.revisions.length, SUGGESTION_LIMITS.revisions);
});

test("an unknown op, or no such suggestion, is said plainly", async () => {
  const w = world();
  assert.equal((await w.call(w.as(OWNER), { op: "approve" })).status, 400);
  assert.equal((await w.call(w.as(OWNER), { op: "reject", annId: "nope" })).status, 404);
  assert.equal((await w.call(w.as(OWNER), { op: "reject" })).status, 400);
});

// --- The sequence a real document goes through -----------------------------

test("suggested, held, decided, released: the order a real review takes", async () => {
  const w = world();
  const ref = w.db.collection("docs").doc("d1");
  const annId = await suggested(w);
  assert.equal(await pendingSuggestions(ref, "v1"), 1, "the publish gate now holds");

  assert.equal((await w.call(w.as(EDITOR), { op: "accept", annId })).status, 403, "an editor cannot clear it");
  assert.equal((await w.call(w.as(APPROVER), { op: "claim", annId })).status, 200);
  withDraft(w); // the approver's session applied it and saved
  assert.equal((await w.call(w.as(APPROVER), { op: "accept", annId })).status, 200);

  assert.equal(await pendingSuggestions(ref, "v1"), 0, "and the gate lets the next version through");
});

// --- Who is told -----------------------------------------------------------

/**
 * Run the real comment trigger and return who it addressed. With no email key
 * configured, `sendEmail` logs each message it skips, which is exactly the
 * list of recipients and subjects without sending anything.
 */
async function addressed(w, annId, comment) {
  const { onCommentCreated } = require("../lib/index.js");
  const lines = [];
  const info = console.info;
  console.info = (line) => lines.push(String(line));
  try {
    await withFakeAdmin({ db: w.db }, () =>
      onCommentCreated.run({
        data: { data: () => comment },
        params: { docId: "d1", versionId: "v1", annId, commentId: comment.commentId },
      }),
    );
  } finally {
    console.info = info;
  }
  return lines
    .map((l) => /^\[email\] skipped "(.*)" to (\S+):/.exec(l))
    .filter(Boolean)
    .map(([, subject, to]) => ({ subject, to }))
    .sort((a, b) => a.to.localeCompare(b.to));
}

function withAccounts(w) {
  for (const p of PEOPLE) w.store.set(`users/${p.uid}`, { uid: p.uid, email: p.email });
}

test("a new suggestion is addressed to the owner and every approver, who alone can clear it", async () => {
  const w = world();
  withAccounts(w);
  const annId = await suggested(w);
  const sent = await addressed(w, annId, w.comments(annId)[0]);
  assert.deepEqual(
    sent.map((m) => m.to),
    [APPROVER.email, OWNER.email],
    "not the editor, who cannot decide it, and not its author",
  );
  assert.equal(sent[0].subject, `${SUGGESTER.email} suggested an edit to “Migration”`);
});

test("a comment in an ordinary thread still goes where it always did", async () => {
  const w = world();
  withAccounts(w);
  w.store.set("docs/d1/versions/v1/annotations/plain", { annId: "plain", anchor: ANCHOR, resolved: false });
  const reply = { commentId: "r1", body: "Hm.", authorEmail: EDITOR.email, actor: { channel: "web" } };
  w.store.set("docs/d1/versions/v1/annotations/plain/comments/r1", reply);
  const sent = await addressed(w, "plain", reply);
  assert.deepEqual(sent.map((m) => m.to), [OWNER.email], "the approver is not added to a plain thread");
  assert.match(sent[0].subject, /commented on/);
});

test("a suggestion is drawn in the annotation colour the app defines", () => {
  // Two packages cannot share the constant, so the server's copy is held to
  // the app's token here rather than trusted to stay in step.
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const tokens = readFileSync(join(__dirname, "..", "..", "app", "src", "brand", "tokens.ts"), "utf8");
  assert.match(tokens, new RegExp(`annotation: "${SUGGESTION_COLOR}"`));
});
