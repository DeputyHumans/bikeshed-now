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

test("no decision comes from a token, not even an approver's", async () => {
  const w = world();
  const annId = await suggested(w);
  withDraft(w);
  for (const op of ["claim", "accept", "reject", "revise", "withdraw"]) {
    const r = await w.call(op === "revise" || op === "withdraw" ? w.bearer.suggester : w.bearer.approver, {
      op,
      annId,
      replacement: "x",
    });
    assert.equal(r.status, 403, op);
    assert.match(r.body.error, /by a person, in the app/);
  }
  assert.equal(w.ann(annId).suggestion.state, "pending");
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

test("a note the author wrote stays theirs until they send a new one", async () => {
  const w = world();
  const r = await create(w, w.as(SUGGESTER), { note: "Dual-write." });
  await w.call(w.as(SUGGESTER), { op: "revise", annId: r.body.annId, replacement: "a fortnight" });
  assert.equal(w.comments(r.body.annId)[0].body, "Dual-write.");
  await w.call(w.as(SUGGESTER), { op: "revise", annId: r.body.annId, replacement: "a month", note: "Longer." });
  assert.equal(w.comments(r.body.annId)[0].body, "Longer.");
});

test("its author withdraws a pending suggestion, and the whole thread goes with it", async () => {
  const w = world();
  const annId = await suggested(w);
  assert.equal((await w.call(w.as(OWNER), { op: "withdraw", annId })).status, 403, "only its author");
  assert.deepEqual((await w.call(w.as(SUGGESTER), { op: "withdraw", annId })).body, { state: "withdrawn" });
  assert.equal(w.ann(annId), undefined);
  assert.deepEqual(w.comments(annId), []);

  const decided = await suggested(w);
  await w.call(w.as(OWNER), { op: "reject", annId: decided });
  assert.equal((await w.call(w.as(SUGGESTER), { op: "withdraw", annId: decided })).status, 409, "a decision stands");
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
