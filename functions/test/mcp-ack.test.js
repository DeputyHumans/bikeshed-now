// SPDX-License-Identifier: Apache-2.0
// MCP comments and automated-read counters acknowledge one committed operation across native SDK retries (SPEC §17, §19).
const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore } = require("./fakes.js");
const { loseFirstTransactionAcknowledgement } = require("./transaction-ack.js");
const admin = require("firebase-admin");
const { TOOLS } = require("../lib/mcp/tools.js");
const HTML = '<!doctype html><p id="phrase">Old phrase.</p>';
function world() {
  const w = fakeFirestore({
    "docs/d": { docId: "d", title: "ACK", currentVersion: "v1", ownerUid: "owner", ownerEmail: "owner@example.com", visibility: "private", members: ["owner@example.com", "reader@example.com"], editorMembers: ["owner@example.com"] },
    "docs/d/versions/v1": { versionId: "v1", entry: "index.html", format: "html" },
  });
  const ctx = { db: w.db, caller: { uid: "reader", emailLower: "reader@example.com", channel: "mcp", tokenId: "t" }, actor: { uid: "reader", email: "reader@example.com", channel: "mcp", tokenId: "t" } };
  const call = (name, args = {}) => withStorage(() => TOOLS.find(t => t.name === name).run(ctx, { id: "d", ...args }));
  return { ...w, call, ctx };
}
async function withStorage(fn) {
  const saved = Object.getOwnPropertyDescriptor(admin, "storage"), before = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({ file: key => ({ download: async () => {
    assert.equal(key, "docs/d/v1/index.html"); return [Buffer.from(HTML)];
  } }) }) }) });
  try { return await fn(); }
  finally {
    if (saved) Object.defineProperty(admin, "storage", saved); else delete admin.storage;
    if (before === undefined) delete process.env.BIKESHED_BUCKET; else process.env.BIKESHED_BUCKET = before;
  }
}
const annotations = w => [...w.store].filter(([path]) => /^docs\/d\/versions\/v1\/annotations\/[^/]+$/.test(path));
const comments = w => [...w.store].filter(([path]) => /\/comments\/[^/]+$/.test(path));

for (const aftermath of ["none", "new-head", "revoked"]) test(`MCP add_comment acknowledges its own committed thread after native retry, aftermath=${aftermath}`, async () => {
  const w = world();
  const count = loseFirstTransactionAcknowledgement(w.db, { afterCommit: async () => {
    if (aftermath === "new-head") await w.db.doc("docs/d").update({ currentVersion: "v2" });
    if (aftermath === "revoked") await w.db.doc("docs/d").update({ members: ["owner@example.com"] });
  } });
  let answer;
  await assert.doesNotReject(async () => { answer = await w.call("add_comment", { exact: "Old phrase.", body: "Keep the receipt." }); }, "the original MCP call acknowledges the already committed thread");
  assert.equal(answer.threadId, annotations(w)[0]?.[1].annId);
  assert.equal(answer.version, "v1");
  assert.equal(annotations(w).length, 1, "native retry creates exactly one thread");
  assert.equal(comments(w).length, 1, "native retry creates exactly one opening comment");
  assert.equal(comments(w)[0][1].body, "Keep the receipt.");
  assert.equal(w.store.get("docs/d").currentVersion, aftermath === "new-head" ? "v2" : "v1");
  assert.deepEqual(count(), { failures: 1, callbackCalls: 2 });
});

for (const overlap of [false, true]) test(`MCP automated reads count each request exactly once after native retry, overlap=${overlap}`, async () => {
  const w = world();
  const count = loseFirstTransactionAcknowledgement(w.db, { afterCommit: async () => {
    if (overlap) await w.call("get_document");
  } });
  const answer = await w.call("get_document");
  assert.equal(answer.source, HTML);
  const session = w.store.get("docs/d/views/api-t-v1");
  const expected = overlap ? 2 : 1;
  assert.equal(session.reads, expected, "an acknowledged-lost MCP fetch increments its session once, including an intervening fetch");
  assert.equal(w.store.get("docs/d").stats.apiReads, expected, "an acknowledged-lost MCP fetch increments its aggregate once");
  assert.equal(session.ms, 0);
  assert.equal(session.automated, true);
  assert.equal(w.store.get("docs/d").stats.views, undefined);
  assert.equal(w.store.get("docs/d").stats.totalMs, undefined);
  const first = session.startedAt;
  await w.call("get_document");
  assert.equal(w.store.get("docs/d/views/api-t-v1").reads, expected + 1, "a distinct later fetch still counts");
  assert.equal(w.store.get("docs/d").stats.apiReads, expected + 1);
  assert.ok(w.store.get("docs/d/views/api-t-v1").startedAt.isEqual(first));
  assert.equal(count().failures, 1);
});

for (const removed of ["thread", "comment", "both"]) test(`MCP add_comment preserves a later author deletion of ${removed} through native retry`, async () => {
  const w = world(); let annId, commentId;
  const count = loseFirstTransactionAcknowledgement(w.db, { afterCommit: async () => {
    const [annPath, ann] = annotations(w)[0], [commentPath, comment] = comments(w)[0];
    assert.equal(ann.authorUid, w.ctx.caller.uid);
    assert.equal(comment.authorUid, w.ctx.caller.uid);
    annId = ann.annId; commentId = comment.commentId;
    // These exact author deletes are permitted by the annotation/comment rules.
    if (removed !== "thread") await w.db.doc(commentPath).delete();
    if (removed !== "comment") await w.db.doc(annPath).delete();
  } });
  let answer;
  await assert.doesNotReject(async () => { answer = await w.call("add_comment", { exact: "Old phrase.", body: "Deleted later." }); }, "the original MCP call acknowledges its committed creation even after an author deletes its receipt rows");
  assert.equal(answer.threadId, annId);
  assert.deepEqual(annotations(w).map(([, data]) => data.annId), removed === "comment" ? [annId] : [], "retry does not resurrect a later deleted thread");
  assert.deepEqual(comments(w).map(([, data]) => data.commentId), removed === "thread" ? [commentId] : [], "retry does not resurrect a later deleted comment");
  assert.deepEqual(count(), { failures: 1, callbackCalls: 2 });
  assert.deepEqual(Object.keys(w.store.get("docs/d").transactionReceipts ?? {}), [], "the deleted-feedback call clears its own bounded receipt");
});

for (const abortCommits of [5, 8]) test(`MCP comment survives ${abortCommits} contended commits and a lost acknowledgement`, async () => {
  const w = world();
  const count = loseFirstTransactionAcknowledgement(w.db, { abortCommits });
  const answer = await w.call("add_comment", { exact: "Old phrase.", body: "Concurrent feedback." });
  assert.equal(answer.threadId, annotations(w)[0]?.[1].annId);
  assert.equal(annotations(w).length, 1);
  assert.equal(comments(w).length, 1);
  assert.deepEqual(count(), { failures: 1, callbackCalls: abortCommits + 2 });
});

test("MCP comment contention still has a finite retry budget and leaves no partial feedback", async () => {
  const w = world();
  const count = loseFirstTransactionAcknowledgement(w.db, { abortCommits: 10 });
  await assert.rejects(w.call("add_comment", { exact: "Old phrase.", body: "Concurrent feedback." }), { code: 10 });
  assert.deepEqual(count(), { failures: 0, callbackCalls: 10 });
  assert.equal(annotations(w).length, 0);
  assert.equal(comments(w).length, 0);
});
