// SPDX-License-Identifier: Apache-2.0
// An agent proposes and never decides; what it proposes lands where a person will find it (SPEC §19, §22).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

const { fakeFirestore } = require("./fakes.js");
const { TOOLS, TOOL_NAMES } = require("../lib/mcp/tools.js");

const tool = (name) => TOOLS.find((t) => t.name === name);

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const VIEWER = { uid: "u-viewer", emailLower: "viewer@example.com" };
const SUGGESTER = { uid: "u-sug", emailLower: "sug@example.com" };

const HTML =
  "<!DOCTYPE html><html><body><section id=\"plan\"><p>We can cut over in a single weekend, " +
  "and yes, a single weekend is enough.</p></section></body></html>";

function world() {
  const { db, store } = fakeFirestore({
    "docs/d1": {
      docId: "d1",
      title: "Migration",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      currentVersion: "v1",
      viewers: [VIEWER.emailLower],
      suggesters: [SUGGESTER.emailLower],
      editors: [],
      approvers: [],
      members: [OWNER.emailLower, VIEWER.emailLower, SUGGESTER.emailLower],
      suggesterMembers: [OWNER.emailLower, SUGGESTER.emailLower],
      editorMembers: [OWNER.emailLower],
      approverMembers: [OWNER.emailLower],
      visibility: "private",
    },
    "docs/d1/versions/v1": { versionId: "v1", entry: "index.html", format: "html" },
  });
  const ctx = (who) => ({
    db,
    caller: { ...who, channel: "mcp", tokenId: "t1" },
    actor: { uid: who.uid, email: who.emailLower, channel: "mcp", tokenId: "t1" },
  });
  const anns = () =>
    [...store.entries()].filter(([p]) => /annotations\/[^/]+$/.test(p)).map(([, d]) => d);
  return { db, store, ctx, anns };
}

/** The current version's bytes, served from a stubbed bucket. */
async function withBucket(fn) {
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

test("no tool decides anything a person decides", () => {
  // An agent proposes; accepting, rejecting and resolving are a person's acts
  // (SPEC §19). Whoever adds a fourteenth tool meets this first.
  for (const name of TOOL_NAMES) {
    assert.doesNotMatch(name, /accept|reject|approve|resolve|decide/);
  }
});

test("suggest_edit demands the document and the passage, and takes an empty replacement as a deletion", () => {
  assert.deepEqual(tool("suggest_edit").inputSchema.required, ["id", "exact"]);
  assert.equal(tool("suggest_edit").inputSchema.properties.replacement.type, "string");
});

test("a suggester's agent proposes an edit, anchored where the browser will find it", async () => {
  const w = world();
  const result = await withBucket(() =>
    tool("suggest_edit").run(w.ctx(SUGGESTER), {
      id: "d1",
      exact: "a single weekend",
      prefix: "cut over in ",
      replacement: "two weekends",
      note: "There is a dual-write period.",
    }),
  );
  assert.equal(result.version, "v1");
  assert.ok(result.threadId);
  const [a] = w.anns();
  assert.deepEqual(a.suggestion, { replacement: "two weekends", state: "pending" });
  assert.equal(a.actor.channel, "mcp", "stamped as the agent that proposed it");
  assert.equal(a.anchor.exact, "a single weekend");
  assert.equal(a.anchor.prefix, "We can cut over in ");
  assert.equal(a.resolved, false);
});

test("a passage that repeats needs words around it, and the refusal says so", async () => {
  const w = world();
  await assert.rejects(
    withBucket(() => tool("suggest_edit").run(w.ctx(SUGGESTER), { id: "d1", exact: "a single weekend", replacement: "x" })),
    /occurs 2 times; add a prefix or suffix/,
  );
});

test("a passage that is not there, or not one paragraph, is refused with what to do instead", async () => {
  const w = world();
  await assert.rejects(
    withBucket(() => tool("suggest_edit").run(w.ctx(SUGGESTER), { id: "d1", exact: "## Plan", replacement: "x" })),
    /not in the current version; quote it as a reader sees it/,
  );
});

test("a replacement is required, and empty is a deletion", async () => {
  const w = world();
  await assert.rejects(
    withBucket(() => tool("suggest_edit").run(w.ctx(SUGGESTER), { id: "d1", exact: "is enough" })),
    /replacement is required/,
  );
  await withBucket(() =>
    tool("suggest_edit").run(w.ctx(SUGGESTER), { id: "d1", exact: "is enough", replacement: "" }),
  );
  assert.equal(w.anns()[0].suggestion.replacement, "");
});

test("a reader's agent may not suggest, and is told so", async () => {
  const w = world();
  await assert.rejects(
    withBucket(() => tool("suggest_edit").run(w.ctx(VIEWER), { id: "d1", exact: "is enough", replacement: "x" })),
    /cannot suggest edits/,
  );
});

test("an update from someone who may only suggest points at suggest_edit", async () => {
  const w = world();
  await assert.rejects(
    tool("update_document").run(w.ctx(SUGGESTER), { id: "d1", content: "<p>new</p>" }),
    /suggest an edit to it with suggest_edit/,
  );
  await assert.rejects(
    tool("update_document").run(w.ctx(VIEWER), { id: "d1", content: "<p>new</p>" }),
    (e) => /cannot edit that document$/.test(e.message),
  );
});

test("get_comments shows a suggestion's change and state, and not the server's restatement of it", async () => {
  const w = world();
  await withBucket(() =>
    tool("suggest_edit").run(w.ctx(SUGGESTER), {
      id: "d1",
      exact: "is enough",
      replacement: "will do",
    }),
  );
  const { threads } = await tool("get_comments").run(w.ctx(OWNER), { id: "d1" });
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].suggestion, { replacement: "will do", state: "pending" });
  assert.deepEqual(threads[0].comments, [], "the generated opener is not repeated to the agent");
});

test("get_comments shows what a suggestion said before it was changed, by channel and never by token", async () => {
  const w = world();
  const { changeSuggestion } = require("../lib/lib/suggestions.js");
  const { threadId } = await withBucket(() =>
    tool("suggest_edit").run(w.ctx(SUGGESTER), { id: "d1", exact: "is enough", replacement: "will do" }),
  );
  const changed = await changeSuggestion({
    db: w.db,
    docRef: w.db.collection("docs").doc("d1"),
    versionId: "v1",
    annId: threadId,
    op: "revise",
    caller: { uid: SUGGESTER.uid, emailLower: SUGGESTER.emailLower },
    actor: w.ctx(SUGGESTER).actor,
    replacement: "should do",
  });
  assert.deepEqual(changed, { state: "pending" });

  const { threads } = await tool("get_comments").run(w.ctx(OWNER), { id: "d1" });
  const { suggestion } = threads[0];
  assert.equal(suggestion.replacement, "should do");
  assert.equal(suggestion.revisions.length, 1);
  const [earlier] = suggestion.revisions;
  assert.equal(earlier.replacement, "will do");
  assert.equal(earlier.via, "mcp");
  assert.match(earlier.at, /^\d{4}-\d{2}-\d{2}T/, "an ISO time an agent can read");
  assert.doesNotMatch(JSON.stringify(threads), /t1|tokenId/, "which token did it is not an agent's business");
});

test("get_comments reads an earlier version's threads when asked, and only a version that exists", async () => {
  const w = world();
  const at = admin.firestore.Timestamp.fromMillis(Date.parse("2026-10-01T09:00:00Z"));
  w.store.set("docs/d1", { ...w.store.get("docs/d1"), currentVersion: "v2" });
  w.store.set("docs/d1/versions/v2", { versionId: "v2", entry: "index.html", format: "html" });
  w.store.set("docs/d1/versions/v1/annotations/old", {
    annId: "old",
    anchor: { exact: "a single weekend" },
    resolved: true,
    suggestion: { replacement: "two weekends", state: "accepted" },
  });
  w.store.set("docs/d1/versions/v1/annotations/old/comments/c1", {
    commentId: "c1", body: "Accepted.", authorEmail: OWNER.emailLower, generated: true, createdAt: at,
  });
  w.store.set("docs/d1/versions/v2/annotations/new", { annId: "new", anchor: { exact: "is enough" }, resolved: false });

  const current = await tool("get_comments").run(w.ctx(OWNER), { id: "d1" });
  assert.equal(current.version, "v2");
  assert.deepEqual(current.threads.map((t) => t.threadId), ["new"], "the current version by default");

  const earlier = await tool("get_comments").run(w.ctx(OWNER), { id: "d1", version: "v1", includeResolved: true });
  assert.equal(earlier.version, "v1");
  assert.deepEqual(earlier.threads.map((t) => t.threadId), ["old"]);
  assert.deepEqual(earlier.threads[0].suggestion, { replacement: "two weekends", state: "accepted" });
  assert.equal(earlier.threads[0].comments[0].body, "Accepted.");

  for (const version of ["v9", "v1/annotations/old", ".."]) {
    await assert.rejects(tool("get_comments").run(w.ctx(OWNER), { id: "d1", version }), {
      message: `no version "${version}"`,
    });
  }
  // Access is the document's, whichever version is asked for.
  await assert.rejects(
    tool("get_comments").run(w.ctx({ uid: "u-x", emailLower: "x@example.com" }), { id: "d1", version: "v1" }),
    /no document with id "d1"/,
  );
});
