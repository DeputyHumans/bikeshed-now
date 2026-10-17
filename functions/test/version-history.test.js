// SPDX-License-Identifier: Apache-2.0
// History discovery, archived reads, and stale feedback refusals exercise the agent contract (SPEC §19, §22).
const test = require("node:test");
const originBefore = process.env.BIKESHED_PUBLIC_ORIGIN;
process.env.BIKESHED_PUBLIC_ORIGIN = "https://bikeshed.example";
test.after(() => { if (originBefore === undefined) delete process.env.BIKESHED_PUBLIC_ORIGIN; else process.env.BIKESHED_PUBLIC_ORIGIN = originBefore; });
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { fakeFirestore } = require("./fakes.js");
const { TOOLS } = require("../lib/mcp/tools.js");
const { changeSuggestion, createSuggestion } = require("../lib/lib/suggestions.js");
const { setThreadResolved } = require("../lib/lib/threads.js");
const stamp = admin.firestore.Timestamp.fromMillis(123456);
const caller = { uid: "owner", emailLower: "owner@example.com", channel: "mcp" };
const actor = { uid: caller.uid, email: caller.emailLower, channel: "mcp" };
const run = (w, name, args = {}) => TOOLS.find(t => t.name === name).run({ db: w.db, caller, actor }, { id: "d", ...args });
function world() {
  return fakeFirestore({
    "docs/d": { currentVersion: "v3", ownerUid: caller.uid, ownerEmail: caller.emailLower, visibility: "private" },
    ...Object.fromEntries(["v1", "v2", "v3"].map(version => [`docs/d/versions/${version}`, { entry: "index.html", publishedAt: stamp, format: "html" }])),
    "docs/d/versions/v1/annotations/t": { resolved: false, createdAt: stamp, anchor: { exact: "old passage" }, authorUid: caller.uid, authorEmail: caller.emailLower },
    "docs/d/versions/v1/annotations/t/comments/c": { body: "archived words", createdAt: stamp, authorEmail: caller.emailLower },
  });
}
test("history pages use a stable tie-breaker and reject invalid or withdrawn cursors", async () => {
  const w = world();
  const first = await run(w, "list_versions", { limit: 2, k: "link-key" });
  assert.equal(first.versions[1].url, "https://bikeshed.example/d/d/v2?k=link-key");
  assert.deepEqual(first.versions.map(v => [v.version, v.isCurrent]), [["v3", true], ["v2", false]]);
  assert.equal(first.currentVersion, "v3");
  assert.equal(first.nextCursor, "v2");
  const last = await run(w, "list_versions", { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(last.versions.map(v => v.version), ["v1"]);
  assert.equal(last.nextCursor, null);
  for (const args of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { cursor: "v9" }, { cursor: "../v1" }]) {
    await assert.rejects(run(w, "list_versions", args));
  }
  w.store.set("docs/d", { currentVersion: "v3", ownerEmail: "someone@example.com", visibility: "private" });
  await assert.rejects(run(w, "list_versions"), /no document/i);
});
test("archived feedback stays readable and cannot invite a reply", async () => {
  const result = await run(world(), "get_comments", { version: "v1", includeResolved: true });
  assert.equal(result.currentVersion, "v3");
  assert.equal(result.isCurrent, false);
  assert.equal(result.canComment, false);
  assert.equal(result.threads[0].comments[0].body, "archived words");
  assert.equal(result.threads[0].awaitingReply, false);
  await assert.rejects(run(world(), "get_comments", { version: "missing" }), /no version/);
});
test("historical source has no write capabilities and unavailable bytes fail explicitly", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(admin, "storage");
  let fail = false;
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({ file: () => ({ download: async () => {
    if (fail) throw new Error("missing");
    return [Buffer.from("<p>old source</p>")];
  } }) }) }) });
  try {
    const w = world();
    const result = await run(w, "get_document", { version: "v1" });
    assert.deepEqual([result.version, result.currentVersion, result.isCurrent, result.canEdit, result.canSuggest, result.canComment, result.source],
      ["v1", "v3", false, false, false, false, "<p>old source</p>"]);
    fail = true;
    await assert.rejects(run(w, "get_document", { version: "v1" }), /could not read source/);
    await assert.rejects(run(w, "get_document", { version: "missing" }), /no version/);
  } finally { if (descriptor) Object.defineProperty(admin, "storage", descriptor); else delete admin.storage; }
});
for (const name of ["add_comment", "reply_to_comment", "resolve_thread", "reopen_thread", "suggest_edit", "revise_suggestion", "withdraw_suggestion", "accept_suggestion", "reject_suggestion", "commit_draft"]) {
  test(`${name} rejects an explicit old version without changing either version`, async () => {
    const w = world(); const before = [...w.store];
    await assert.rejects(run(w, name, { version: "v1", baseVersion: "v1", threadId: "t", exact: "old passage", body: "new", replacement: "new" }), /read-only/);
    assert.deepEqual([...w.store], before);
  });
}
test("all suggestion actions and thread transitions refuse a head that advanced before their transaction", async () => {
  for (const op of ["revise", "withdraw", "claim", "release", "accept", "reject"]) {
    const w = world(); const before = [...w.store];
    const result = await changeSuggestion({ db: w.db, docRef: w.db.doc("docs/d"), versionId: "v1", annId: "t", op, caller, actor, maySuggest: true, replacement: "new" });
    assert.equal(result.status, 409, op);
    assert.deepEqual([...w.store], before, op);
  }
  for (const resolved of [true, false]) {
    const w = world(); const before = [...w.store];
    const result = await setThreadResolved({ db: w.db, docRef: w.db.doc("docs/d"), versionId: "v1", annId: "t", resolved, caller, actor });
    assert.equal(result.status, 409);
    assert.deepEqual([...w.store], before);
  }
  const w = world(); const before = [...w.store];
  const result = await createSuggestion({ db: w.db, docRef: w.db.doc("docs/d"), versionId: "v1", anchor: { exact: "old" }, replacement: "new", note: "", author: caller, actor, color: "pink" });
  assert.equal(result.status, 409);
  assert.deepEqual([...w.store], before);
});
test("a reply loaded on the head cannot write after publication wins the race", async () => {
  const w = world(); w.store.get("docs/d").currentVersion = "v1";
  const transact = w.db.runTransaction.bind(w.db);
  w.db.runTransaction = fn => { w.store.get("docs/d").currentVersion = "v3"; return transact(fn); };
  const before = [...w.store.keys()];
  await assert.rejects(run(w, "reply_to_comment", { version: "v1", threadId: "t", body: "late" }), /read-only/);
  assert.deepEqual([...w.store.keys()], before);
});
