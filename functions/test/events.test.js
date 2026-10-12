// SPDX-License-Identifier: Apache-2.0
// A document's change log, and the cursor a watcher reads it with (SPEC §4, §19, ADR 0016).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { Timestamp } = require("firebase-admin/firestore");

const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { TOOLS, TOOL_NAMES } = require("../lib/mcp/tools.js");
const triggers = require("../lib/index.js");
const {
  annotationEvents,
  commentEvents,
  versionEvents,
  encodeCursor,
  decodeCursor,
} = require("../lib/lib/events.js");

const tool = (name) => TOOLS.find((t) => t.name === name);

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const ANA = { uid: "u-ana", emailLower: "ana@example.com" };
const BO = { uid: "u-bo", emailLower: "bo@example.com" };
const VIEWER = { uid: "u-viewer", emailLower: "viewer@example.com" };

const web = (p) => ({ uid: p.uid, email: p.emailLower, channel: "web" });
const agent = (p, tokenId = "t1") => ({ uid: p.uid, email: p.emailLower, channel: "mcp", tokenId });

function world() {
  const { db, store } = fakeFirestore({
    "users/u-owner": { email: OWNER.emailLower },
    "users/u-ana": { email: ANA.emailLower },
    "docs/d1": {
      docId: "d1",
      title: "Memo",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      currentVersion: "v1",
      viewers: [ANA.emailLower, BO.emailLower, VIEWER.emailLower],
      suggesters: [],
      editors: [],
      approvers: [],
      members: [OWNER.emailLower, ANA.emailLower, BO.emailLower, VIEWER.emailLower],
      editorMembers: [OWNER.emailLower],
      approverMembers: [OWNER.emailLower],
      visibility: "private",
    },
    "docs/d1/versions/v1": { versionId: "v1", entry: "index.html", format: "html", publishedByEmail: OWNER.emailLower },
  });
  const ctx = (who, tokenId = "t1") => ({
    db,
    caller: { ...who, channel: "mcp", tokenId },
    actor: agent(who, tokenId),
  });
  const call = (name, who, args, tokenId) =>
    withStorage(() => withFakeAdmin({ db }, () => tool(name).run(ctx(who, tokenId), { id: "d1", ...args })));
  let n = 0;
  /** What a trigger does when Firestore delivers the write: the real built trigger, run once. */
  const deliver = (trigger, params, before, after, id = `ce-${++n}`) =>
    withFakeAdmin({ db }, () =>
      trigger.run({
        id,
        params,
        data:
          trigger === triggers.recordCommentEvent
            ? { data: () => after }
            : { before: { data: () => before }, after: { data: () => after } },
      }),
    );
  const at = Timestamp.now();
  /** A person, in the browser, opens a thread and says something in it. */
  const comment = async (threadId, by, body, { channel = "web", tokenId, generated, docId = "d1" } = {}) => {
    const annPath = `docs/${docId}/versions/v1/annotations/${threadId}`;
    if (!store.has(annPath)) {
      const ann = { resolved: false, anchor: { exact: `the ${threadId} passage` }, authorEmail: by.emailLower, actor: web(by), createdAt: at };
      store.set(annPath, ann);
      await deliver(triggers.recordThreadEvent, { docId, versionId: "v1", annId: threadId }, undefined, ann);
    }
    const id = `c${++n}`;
    const c = {
      commentId: id,
      body,
      authorEmail: by.emailLower,
      actor: { uid: by.uid, email: by.emailLower, channel, ...(tokenId ? { tokenId } : {}) },
      createdAt: Timestamp.now(),
      ...(generated ? { generated: true } : {}),
    };
    store.set(`${annPath}/comments/${id}`, c);
    await deliver(triggers.recordCommentEvent, { docId, versionId: "v1", annId: threadId, commentId: id }, undefined, c);
    return id;
  };
  const events = () => [...store.entries()].filter(([p]) => p.startsWith("docs/d1/events/")).map(([, v]) => v);
  return { db, store, call, deliver, comment, events, ctx };
}

/** Storage in memory for the length of `fn`, for the tools that publish. */
async function withStorage(fn) {
  const objects = new Map();
  const saved = Object.getOwnPropertyDescriptor(admin, "storage");
  const before = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  const object = (name) => ({
    name,
    download: async () => [objects.get(name) ?? Buffer.from("")],
    save: async (data) => void objects.set(name, Buffer.from(data)),
    exists: async () => [objects.has(name)],
  });
  Object.defineProperty(admin, "storage", {
    configurable: true,
    value: () => ({ bucket: () => ({ file: object, getFiles: async () => [[]], deleteFiles: async () => {} }) }),
  });
  try {
    return await fn();
  } finally {
    if (saved) Object.defineProperty(admin, "storage", saved);
    if (before === undefined) delete process.env.BIKESHED_BUCKET;
    else process.env.BIKESHED_BUCKET = before;
  }
}

// --- What each source records ---------------------------------------------

test("a thread's changes record what they mean, a decision once, a deletion not at all", () => {
  const opened = annotationEvents("v1", "t1", undefined, { actor: web(ANA) });
  assert.deepEqual(opened.map((e) => [e.type, e.actor]), [["thread.opened", { uid: ANA.uid, channel: "web" }]]);
  assert.equal(annotationEvents("v1", "s1", undefined, { actor: web(ANA), suggestion: { state: "pending" } })[0].type, "suggestion.opened");

  const pending = { resolved: false, suggestion: { state: "pending" } };
  const accepted = { resolved: true, suggestion: { state: "accepted", decidedBy: agent(OWNER) } };
  assert.deepEqual(annotationEvents("v1", "s1", pending, accepted).map((e) => e.type), ["suggestion.accepted"], "not also thread.resolved");
  const revised = { resolved: false, suggestion: { state: "pending", revisions: [{ actor: web(ANA) }] } };
  assert.deepEqual(annotationEvents("v1", "s1", pending, revised).map((e) => e.type), ["suggestion.revised"]);

  const resolved = annotationEvents("v1", "t1", { resolved: false }, { resolved: true, resolvedBy: web(BO) });
  assert.deepEqual(resolved.map((e) => [e.type, e.actor.uid]), [["thread.resolved", BO.uid]]);
  assert.equal(annotationEvents("v1", "t1", { resolved: true }, { resolved: false, resolvedBy: web(BO) })[0].type, "thread.reopened");
  assert.deepEqual(annotationEvents("v1", "t1", { resolved: false }, undefined), [], "a deleted thread records nothing");
  assert.deepEqual(annotationEvents("v1", "t1", { resolved: false }, { resolved: false, note: "x" }), []);
});

test("a version and a comment record no email, and a server note records nothing", () => {
  const [published] = versionEvents("v2", undefined, { publishedBy: agent(OWNER) });
  assert.deepEqual(published.actor, { uid: OWNER.uid, channel: "mcp", tokenId: "t1" });
  assert.equal(versionEvents("v1", { versionId: "v1" }, undefined)[0].type, "version.withdrawn");
  assert.deepEqual(commentEvents("v1", "t1", "c1", { generated: true, body: "Accepted." }), []);
  assert.equal(commentEvents("v1", "t1", "c1", { body: "Why?", actor: web(ANA) })[0].type, "comment.added");
});

test("each event trigger retries, and the email trigger does not", () => {
  // A lost event is the one failure the log cannot report; a resent email is
  // worse than a lost one. The emulator retries nothing, so this is asserted
  // from the built functions' own declarations.
  for (const name of ["recordVersionEvent", "recordThreadEvent", "recordCommentEvent"]) {
    assert.equal(triggers[name].__endpoint.eventTrigger.retry, true, name);
  }
  assert.equal(triggers.onCommentCreated.__endpoint.eventTrigger.retry, false);
});

test("each event trigger listens where its records are written, with the names its handler reads", () => {
  // The handlers are driven directly above, so a wrong path would pass them all
  // and record nothing in production.
  const paths = {
    recordVersionEvent: "docs/{docId}/versions/{versionId}",
    recordThreadEvent: "docs/{docId}/versions/{versionId}/annotations/{annId}",
    recordCommentEvent: "docs/{docId}/versions/{versionId}/annotations/{annId}/comments/{commentId}",
  };
  for (const [name, document] of Object.entries(paths)) {
    assert.deepEqual(triggers[name].__endpoint.eventTrigger.eventFilterPathPatterns, { document }, name);
    assert.equal(triggers[name].__endpoint.eventTrigger.eventFilters.database, "(default)", name);
  }
});

test("a redelivered event is recorded once, and reported once, even with a poll between", async () => {
  const w = world();
  const { cursor } = await w.call("get_changes", OWNER, { since: "all" });
  const c = { body: "Why last?", authorEmail: ANA.emailLower, actor: web(ANA), createdAt: Timestamp.now() };
  w.store.set("docs/d1/versions/v1/annotations/t1", { resolved: false, anchor: { exact: "x" }, createdAt: Timestamp.now() });
  w.store.set("docs/d1/versions/v1/annotations/t1/comments/c1", c);
  const params = { docId: "d1", versionId: "v1", annId: "t1", commentId: "c1" };
  await w.deliver(triggers.recordCommentEvent, params, undefined, c, "same-cloudevent");
  const first = await w.call("get_changes", OWNER, { since: cursor });
  await w.deliver(triggers.recordCommentEvent, params, undefined, c, "same-cloudevent");
  const second = await w.call("get_changes", OWNER, { since: first.cursor });
  assert.equal(w.events().length, 1);
  assert.deepEqual(first.events.map((e) => e.type), ["comment.added"]);
  assert.deepEqual(second.events, [], "an overwrite would have moved it past the cursor and reported it again");
});

// --- get_changes -------------------------------------------------------------

test("the real sequence: a person's comment, a resolve, a withdrawal; never the agent's own reply", async () => {
  const w = world();
  const { cursor } = await w.call("get_document", OWNER, {});
  // The owner, in the browser, under the same email as the agent's token.
  await w.comment("t1", OWNER, "This assumes no dual-write period.");
  // The agent answers.
  await w.comment("t1", OWNER, "It does now.", { channel: "mcp", tokenId: "t1" });
  // Somebody else resolves it in the browser.
  const before = w.store.get("docs/d1/versions/v1/annotations/t1");
  const after = { ...before, resolved: true, resolvedBy: web(BO) };
  w.store.set("docs/d1/versions/v1/annotations/t1", after);
  await w.deliver(triggers.recordThreadEvent, { docId: "d1", versionId: "v1", annId: "t1" }, before, after);
  // An operator withdraws an old version.
  await w.deliver(triggers.recordVersionEvent, { docId: "d1", versionId: "v0" }, { versionId: "v0" }, undefined);

  const got = await w.call("get_changes", OWNER, { since: cursor });
  assert.deepEqual(
    got.events.map((e) => [e.type, e.by ?? null]),
    [
      ["thread.opened", OWNER.emailLower],
      ["comment.added", OWNER.emailLower],
      ["thread.resolved", BO.emailLower],
      ["version.withdrawn", null],
    ],
  );
  assert.equal(got.events[1].body, "This assumes no dual-write period.");
  assert.equal(got.events[1].quote, "the t1 passage");
});

test("a browser comment signed with the agent's token is still reported", async () => {
  // The rules pin a browser write's channel to web but, before 0.11.3, not its
  // token; "mine" therefore needs an agent channel as well as the token.
  const w = world();
  const { cursor } = await w.call("get_document", OWNER, {});
  await w.comment("t1", ANA, "Signed as the agent.", { channel: "web", tokenId: "t1" });
  const got = await w.call("get_changes", OWNER, { since: cursor });
  assert.ok(got.events.some((e) => e.type === "comment.added" && e.body === "Signed as the agent."));
});

test("a cursor from the publish catches a comment made before the first poll", async () => {
  const w = world();
  const published = await w.call("publish_document", OWNER, { title: "Plan", content: "# Plan\n\nTwo weekends.", id: "plan" });
  assert.ok(published.cursor, "publishing hands back the cursor to start from");
  await w.comment("t1", OWNER, "Seen in seconds.", { docId: "plan" });
  const from = await w.call("get_changes", OWNER, { id: "plan", since: published.cursor });
  assert.ok(from.events.some((e) => e.body === "Seen in seconds."));
  // Taking the starting point at the first poll instead loses it.
  const { cursor: atFirstPoll } = await w.call("get_document", OWNER, { id: "plan" }, "t-late");
  const late = await w.call("get_changes", OWNER, { id: "plan", since: atFirstPoll }, "t-late");
  assert.ok(!late.events.some((e) => e.body === "Seen in seconds."));
});

test("only a poll moves a cursor: a write or a read in between never skips what came first", async () => {
  const w = world();
  const first = await w.call("get_changes", OWNER, { since: "all" });
  await w.comment("t1", ANA, "Answered between the poll and the update.");
  // The agent reads the document before publishing, as it is told to.
  const read = await w.call("get_document", OWNER, {});
  assert.ok(read.cursor);
  const fromHeld = await w.call("get_changes", OWNER, { since: first.cursor });
  assert.ok(fromHeld.events.some((e) => e.body === "Answered between the poll and the update."));
  // And "last" was not moved by the read either.
  const w2 = world();
  await w2.call("get_changes", OWNER, { since: "all" });
  await w2.comment("t1", ANA, "Also between.");
  await w2.call("get_document", OWNER, {});
  const fromLast = await w2.call("get_changes", OWNER, { since: "last" });
  assert.ok(fromLast.events.some((e) => e.body === "Also between."), "get_document must not overwrite a saved cursor");
});

test("since is required, and a cursor is bound to its document", async () => {
  const w = world();
  for (const bad of ["", "not-a-cursor", encodeCursor({ docId: "other", at: null, id: null }),
    Buffer.from(JSON.stringify({ v: 9, d: "d1" })).toString("base64url")]) {
    await assert.rejects(w.call("get_changes", OWNER, { since: bad }), /since: .*"last" or "all"/);
  }
  assert.deepEqual(decodeCursor(encodeCursor({ docId: "d1", at: null, id: null }), "d1"), { docId: "d1", at: null, id: null });
});

test("every response carries a cursor, and 101 events arrive as 100 then 1", async () => {
  const w = world();
  const empty = await w.call("get_changes", OWNER, { since: "all" });
  const again = await w.call("get_changes", OWNER, { since: empty.cursor });
  assert.deepEqual([again.events, again.cursor], [[], empty.cursor], "a quiet poll hands back the same cursor");
  for (let i = 0; i < 101; i++) await w.comment("t1", ANA, `n${i}`);
  // 101 comments and the thread's opening: 102 events.
  const p1 = await w.call("get_changes", OWNER, { since: empty.cursor });
  assert.equal(p1.events.length, 100);
  assert.equal(p1.more, true);
  const p2 = await w.call("get_changes", OWNER, { since: p1.cursor });
  assert.equal(p2.more, false);
  const bodies = [...p1.events, ...p2.events].filter((e) => e.type === "comment.added").map((e) => e.body);
  assert.deepEqual(bodies, Array.from({ length: 101 }, (_, i) => `n${i}`), "nothing repeated or skipped");
});

test('"last" is kept per credential, answers from the start when empty, and a quiet poll writes nothing', async () => {
  const w = world();
  const fresh = await w.call("get_changes", OWNER, { since: "last" }, "t9");
  assert.equal(fresh.resumedFrom, "start");
  await w.comment("t1", ANA, "One.");
  await w.call("get_changes", OWNER, { since: "last" }, "tA");
  const other = await w.call("get_changes", OWNER, { since: "last" }, "tB");
  assert.ok(other.events.some((e) => e.body === "One."), "token B has its own cursor, untouched by A's poll");
  const path = "users/u-owner/cursors/tA~d1";
  const before = w.store.get(path).updatedAt;
  await w.call("get_changes", OWNER, { since: "last" }, "tA");
  assert.equal(w.store.get(path).updatedAt, before, "a quiet poll writes nothing");
});

test("a reader sees no editor or owner event, and no draft", async () => {
  const w = world();
  const { cursor } = await w.call("get_document", OWNER, {});
  w.store.set("docs/d1/events/e-acl", { at: Timestamp.now(), type: "access.changed", audience: "editors", data: { added: ["x@example.com"], removed: [] } });
  w.store.set("docs/d1/events/e-vis", { at: Timestamp.now(), type: "doc.visibility", audience: "editors", data: { from: "private", to: "unlisted" } });
  w.store.set("docs/d1/events/e-fork", { at: Timestamp.now(), type: "fork.created", audience: "owner" });
  w.store.set("docs/d1", { ...w.store.get("docs/d1"), draft: { updatedByEmail: OWNER.emailLower } });
  const reader = await w.call("get_changes", VIEWER, { since: cursor }, "tv");
  assert.deepEqual(reader.events, []);
  assert.equal("draft" in reader.state, false);
  const owner = await w.call("get_changes", OWNER, { since: cursor });
  assert.deepEqual(owner.events.map((e) => e.type).sort(), ["access.changed", "doc.visibility", "fork.created"]);
  const fork = owner.events.find((e) => e.type === "fork.created");
  assert.match(fork.at, /^\d{4}-\d{2}-\d{2}$/, "a fork is dated to the day, no closer");
  assert.equal(owner.state.draft.exists, true);
});

test("needsReply names a thread a person spoke last in, and not one an agent or a note ended", async () => {
  const w = world();
  const { cursor } = await w.call("get_document", OWNER, {});
  await w.comment("asked", ANA, "Why?");
  await w.comment("answered", ANA, "Why?");
  await w.comment("answered", OWNER, "Because.", { channel: "mcp", tokenId: "t2" });
  const got = await w.call("get_changes", OWNER, { since: cursor });
  assert.deepEqual(got.needsReply, ["asked"]);
});

test("a comment its author deleted drops out of the feed", async () => {
  const w = world();
  const { cursor } = await w.call("get_document", OWNER, {});
  const id = await w.comment("t1", ANA, "Never mind.");
  w.store.delete(`docs/d1/versions/v1/annotations/t1/comments/${id}`);
  const got = await w.call("get_changes", OWNER, { since: cursor });
  assert.ok(!got.events.some((e) => e.type === "comment.added"));
});

test("the endpoints that change the record write their event with the change", async () => {
  const w = world();
  const { cursor } = await w.call("get_document", OWNER, {});
  await w.call("rename_document", OWNER, { title: "Cut-over plan" });
  w.store.set("folders/f1", { name: "Reviews", ownerUid: OWNER.uid, ownerEmail: OWNER.emailLower, ancestors: [], members: [OWNER.emailLower], editorMembers: [OWNER.emailLower], viewers: [], editors: [], suggesters: [], approvers: [] });
  await w.call("move_document", OWNER, { folder: "f1" });
  const sessions = { s: { uid: OWNER.uid, email: OWNER.emailLower, email_verified: true } };
  const post = (fn, body) => withFakeAdmin({ db: w.db, sessions }, () => invoke(fn, { headers: { cookie: "__session=s" }, body }));
  assert.equal((await post(triggers.trustDoc, { docId: "d1", trusted: true })).status, 200);
  assert.equal((await post(triggers.setVisibility, { docId: "d1", visibility: "unlisted", expiresAt: Date.now() + 86_400_000 })).status, 200);
  const got = await w.call("get_changes", OWNER, { since: cursor }, "t-other");
  assert.deepEqual(got.events.map((e) => e.type), ["doc.renamed", "doc.moved", "doc.trust", "doc.visibility", "doc.expiry"]);
  assert.deepEqual([got.events[0].from, got.events[0].to], ["Memo", "Cut-over plan"]);
  assert.deepEqual(got.events[1].to, { id: "f1", path: "Reviews" });
  assert.ok(!JSON.stringify(got.events).includes("linkToken"), "the link's key is never logged");
});

test("every way to change a document records an event, or says why it need not", () => {
  // A path that changes a document without logging it is invisible to every
  // watcher. A new endpoint or tool fails here until somebody decides.
  const EXEMPT = {
    // Endpoints
    session: "signs in", appConfig: "reads", createDoc: "a new version: recordVersionEvent", createFolder: "a folder, no document",
    setFolderAccess: "a cascade; get_changes reports state.readers", setMarking: "export marking, not who reads",
    manageTeam: "a cascade", manageTeamMembers: "a cascade", manageTokens: "credentials", recordView: "statistics",
    unlockDoc: "a reader's own grant", saveDraft: "state.draft", commitVersion: "a new version: recordVersionEvent",
    manageSuggestion: "the thread: recordThreadEvent", saveThumbs: "thumbnails", mcp: "per tool, below",
    oauth: "credentials", oauthConsent: "credentials", sitemap: "reads", verifyEmail: "an account",
    downloadBundle: "reads", getDraft: "reads", contentProxy: "reads", docShell: "reads",
    // Tools
    list_documents: "reads", get_document: "reads", get_lineage: "reads", list_folders: "reads", get_folder: "reads",
    get_comments: "reads", get_changes: "reads", create_folder: "a folder, no document",
    publish_document: "recordVersionEvent", update_document: "recordVersionEvent", commit_draft: "recordVersionEvent",
    suggest_edit: "recordThreadEvent", revise_suggestion: "recordThreadEvent", withdraw_suggestion: "recordThreadEvent",
    accept_suggestion: "recordThreadEvent", reject_suggestion: "recordThreadEvent", resolve_thread: "recordThreadEvent",
    reopen_thread: "recordThreadEvent", add_comment: "recordCommentEvent", reply_to_comment: "recordCommentEvent",
  };
  const RECORDS = { setAccess: "access.changed", organize: "doc.renamed, doc.moved", forkDoc: "fork.created", trustDoc: "doc.trust",
    setVisibility: "doc.visibility, doc.expiry", fork_document: "fork.created", move_document: "doc.moved", rename_document: "doc.renamed" };
  return import("../../scripts/lib/endpoints.mjs").then(({ ENDPOINTS: rows }) => {
    for (const name of [...new Set(rows.map((r) => r.fn)), ...TOOL_NAMES]) {
      assert.ok(name in EXEMPT || name in RECORDS, `${name} changes documents? Record an event, or list it as exempt with a reason`);
    }
  });
});
