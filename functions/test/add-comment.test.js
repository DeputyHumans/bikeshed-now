// SPDX-License-Identifier: Apache-2.0
// An agent opens a thread on a passage, where a person will find it (SPEC §19).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

const { fakeFirestore } = require("./fakes.js");
const { TOOLS } = require("../lib/mcp/tools.js");

const tool = (name) => TOOLS.find((t) => t.name === name);

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const VIEWER = { uid: "u-viewer", emailLower: "viewer@example.com" };
const STRANGER = { uid: "u-stranger", emailLower: "stranger@example.com" };

const HTML =
  "<!DOCTYPE html><html><body><section id=\"plan\"><p>We can cut over in a single weekend, " +
  "and yes, a single weekend is enough.</p><p>Payments moves last.</p></section></body></html>";

function world(extra = {}) {
  const { db, store } = fakeFirestore({
    "docs/d1": {
      docId: "d1",
      title: "Migration",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      currentVersion: "v1",
      viewers: [VIEWER.emailLower],
      editors: [],
      approvers: [],
      members: [OWNER.emailLower, VIEWER.emailLower],
      editorMembers: [OWNER.emailLower],
      approverMembers: [OWNER.emailLower],
      visibility: "private",
      ...extra,
    },
    "docs/d1/versions/v1": { versionId: "v1", entry: "index.html", format: "html" },
  });
  const ctx = (who, over = {}) => ({
    db,
    caller: { ...who, channel: "mcp", tokenId: "t1" },
    actor: { uid: who.uid, email: who.emailLower, channel: "mcp", tokenId: "t1" },
    ...over,
  });
  const anns = () =>
    [...store.entries()].filter(([p]) => /annotations\/[^/]+$/.test(p)).map(([, d]) => d);
  const comments = () =>
    [...store.entries()].filter(([p]) => /comments\/[^/]+$/.test(p)).map(([, d]) => d);
  return { db, store, ctx, anns, comments };
}

/** The current version's bytes, served from a stubbed bucket. */
async function withBucket(fn, beforeReturn = async () => {}) {
  const saved = Object.getOwnPropertyDescriptor(admin, "storage");
  const before = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  Object.defineProperty(admin, "storage", {
    configurable: true,
    value: () => ({
      bucket: () => ({
        file: (key) => ({
          download: async () => {
            assert.equal(key, "docs/d1/v1/index.html", "it reads the rendered entry of the current version");
            await beforeReturn();
            return [Buffer.from(HTML)];
          },
        }),
      }),
    }),
  });
  try {
    return await fn();
  } finally {
    if (saved) Object.defineProperty(admin, "storage", saved);
    if (before === undefined) delete process.env.BIKESHED_BUCKET;
    else process.env.BIKESHED_BUCKET = before;
  }
}

test("add_comment demands the document, the passage and what to say", () => {
  assert.deepEqual(tool("add_comment").inputSchema.required, ["id", "exact", "body"]);
});

test("a reader's agent opens a thread, anchored where the browser will find it", async () => {
  const w = world();
  const result = await withBucket(() =>
    tool("add_comment").run(w.ctx(VIEWER), {
      id: "d1",
      exact: "a single weekend",
      prefix: "cut over in ",
      body: "  Which weekend? Payments has not agreed a date.  ",
    }),
  );
  assert.equal(result.version, "v1");
  assert.equal(result.quote, "a single weekend");
  assert.ok(result.threadId);

  const [a] = w.anns();
  assert.equal(a.annId, result.threadId);
  assert.equal(a.anchor.exact, "a single weekend");
  assert.equal(a.anchor.prefix, "We can cut over in ");
  assert.equal(a.anchor.strict, true, "resolved by its quote only, never by its block-local offsets");
  assert.equal(a.resolved, false);
  assert.equal(a.suggestion, undefined, "a comment, not a suggestion");
  assert.equal(a.authorEmail, VIEWER.emailLower);
  assert.equal(a.actor.channel, "mcp", "stamped as the agent that wrote it");

  const [c] = w.comments();
  assert.equal(c.body, "Which weekend? Payments has not agreed a date.");
  assert.equal(c.authorEmail, VIEWER.emailLower);
  assert.equal(c.actor.channel, "mcp");
  assert.equal(c.generated, undefined, "the agent's own words, not the server's");
  assert.equal(c.opensSuggestion, undefined);
});

test("the thread and its first comment land together or not at all", async () => {
  const w = world();
  const failing = {
    ...w.db,
    async runTransaction() {
      throw new Error("unavailable");
    },
  };
  await assert.rejects(
    withBucket(() =>
      tool("add_comment").run(w.ctx(VIEWER, { db: failing }), { id: "d1", exact: "Payments moves last.", body: "Why?" }),
    ),
    /unavailable/,
  );
  assert.equal(w.anns().length, 0, "no highlight that says nothing");
  assert.equal(w.comments().length, 0);
});

test("get_comments returns the new thread with its quote and its words", async () => {
  const w = world();
  await withBucket(() =>
    tool("add_comment").run(w.ctx(VIEWER), { id: "d1", exact: "Payments moves last.", body: "Why last?" }),
  );
  const { threads } = await tool("get_comments").run(w.ctx(OWNER), { id: "d1" });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].quote, "Payments moves last.");
  const [comment] = threads[0].comments;
  assert.deepEqual(
    { author: comment.author, via: comment.via, body: comment.body },
    { author: VIEWER.emailLower, via: "mcp", body: "Why last?" },
  );
  // Each comment says which one it is and when it was written.
  assert.equal(typeof comment.id, "string");
  assert.match(comment.at, /^\d{4}-\d{2}-\d{2}T/);
  // An agent wrote it, so nobody is waiting on an answer from an agent.
  assert.equal(threads[0].awaitingReply, false);
});

test("a passage that repeats needs words around it, and the refusal says so", async () => {
  const w = world();
  await assert.rejects(
    withBucket(() => tool("add_comment").run(w.ctx(VIEWER), { id: "d1", exact: "a single weekend", body: "x" })),
    /occurs 2 times; add a prefix or suffix/,
  );
  assert.equal(w.anns().length, 0);
});

test("a passage that is not there, or not one paragraph, is refused with what to do instead", async () => {
  const w = world();
  await assert.rejects(
    withBucket(() => tool("add_comment").run(w.ctx(VIEWER), { id: "d1", exact: "## Plan", body: "x" })),
    /not in the current version; quote it as a reader sees it/,
  );
  await assert.rejects(
    withBucket(() =>
      tool("add_comment").run(w.ctx(VIEWER), { id: "d1", exact: "is enough. Payments moves", body: "x" }),
    ),
    /a comment is anchored to text within one paragraph/,
  );
  assert.equal(w.anns().length, 0);
});

test("an empty comment is refused before anything is read", async () => {
  const w = world();
  await assert.rejects(
    tool("add_comment").run(w.ctx(VIEWER), { id: "d1", exact: "Payments moves last.", body: "   " }),
    /body is empty/,
  );
  assert.equal(w.anns().length, 0);
});

test("a document the caller cannot read answers as one that does not exist", async () => {
  const w = world();
  await assert.rejects(
    tool("add_comment").run(w.ctx(STRANGER), { id: "d1", exact: "Payments moves last.", body: "x" }),
    /no document with id "d1"/,
  );
  assert.equal(w.anns().length, 0);
});

test("an expired document takes no new threads, its owner's included", async () => {
  const w = world({ expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 60_000) });
  await assert.rejects(
    tool("add_comment").run(w.ctx(OWNER), { id: "d1", exact: "Payments moves last.", body: "x" }),
    /has expired/,
  );
  assert.equal(w.anns().length, 0);
});

test("an unlisted document's key lets a stranger's agent comment, and nothing else does", async () => {
  const LINK = "tok_0123456789abcdefghijk";
  const w = world({ visibility: "unlisted", linkToken: LINK });
  await assert.rejects(
    tool("add_comment").run(w.ctx(STRANGER), { id: "d1", exact: "Payments moves last.", body: "x" }),
    /no document with id "d1"/,
  );
  await withBucket(() =>
    tool("add_comment").run(w.ctx(STRANGER), { id: "d1", k: LINK, exact: "Payments moves last.", body: "Why last?" }),
  );
  assert.equal(w.anns().length, 1);
  assert.equal(w.anns()[0].authorEmail, STRANGER.emailLower);
});


test("a comment anchored before publication refuses the newer head without leaving feedback behind", async () => {
  const w = world();
  await assert.rejects(withBucket(
    () => tool("add_comment").run(w.ctx(VIEWER), { id: "d1", exact: "Payments moves last.", body: "Why?" }),
    () => w.db.doc("docs/d1").update({ currentVersion: "v2" }),
  ), /newer version/i);
  assert.equal(w.anns().length, 0);
  assert.equal(w.comments().length, 0);
});

test("comment admission rechecks access and expiry after reading the passage", async () => {
  for (const [who, change, refusal] of [
    [VIEWER, { members: [OWNER.emailLower] }, /no document with id/],
    [VIEWER, { expiresAt: admin.firestore.Timestamp.fromMillis(1) }, /no document with id/],
    [OWNER, { expiresAt: admin.firestore.Timestamp.fromMillis(1) }, /has expired/],
  ]) {
    const w = world();
    await assert.rejects(withBucket(
      () => tool("add_comment").run(w.ctx(who), { id: "d1", exact: "Payments moves last.", body: "Why?" }),
      () => w.db.doc("docs/d1").update(change),
    ), refusal);
    assert.equal(w.anns().length, 0);
    assert.equal(w.comments().length, 0);
  }
});

test("a key rotated or remembered grant withdrawn during passage lookup no longer admits a comment", async () => {
  const k = "tok_0123456789abcdefghijk";
  for (const remembered of [false, true]) {
    const w = world({ visibility: "unlisted", linkToken: k });
    if (remembered) await w.db.doc("docs/d1/linkGrants/u-stranger").set({ token: k });
    await assert.rejects(withBucket(
      () => tool("add_comment").run(w.ctx(STRANGER), { id: "d1", ...(remembered ? {} : { k }), exact: "Payments moves last.", body: "Why?" }),
      () => remembered ? w.db.doc("docs/d1/linkGrants/u-stranger").delete() : w.db.doc("docs/d1").update({ linkToken: "tok_rotated0123456789abcdefghijk" }),
    ), /no document with id/);
    assert.equal(w.anns().length, 0);
    assert.equal(w.comments().length, 0);
  }
});

test("publication between transaction read and commit retries comment admission against the new head", async () => {
  const w = world();
  const run = w.db.runTransaction.bind(w.db); let published = false;
  w.db.runTransaction = (fn) => run(async (tx) => {
    const result = await fn(tx);
    if (!published) { published = true; await w.db.doc("docs/d1").update({ currentVersion: "v2" }); }
    return result;
  });
  await assert.rejects(withBucket(() => tool("add_comment").run(w.ctx(VIEWER), { id: "d1", exact: "Payments moves last.", body: "Why?" })), /newer version/i);
  assert.equal(w.anns().length, 0);
  assert.equal(w.comments().length, 0);
});
