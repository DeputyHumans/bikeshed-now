// SPDX-License-Identifier: Apache-2.0
// Native transaction acknowledgement loss preserves one suggestion creation and exactly one recorded revision (SPEC §22).
const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore } = require("./fakes.js");
const { loseFirstTransactionAcknowledgement } = require("./transaction-ack.js");
const { createSuggestion, changeSuggestion } = require("../lib/lib/suggestions.js");

const author = { uid: "author", emailLower: "author@example.com" };
const actor = { uid: author.uid, email: author.emailLower, channel: "web" };
const anchor = { exact: "old", elementId: "p", prefix: "", suffix: "", start: 0, end: 3 };
function world() {
  const w = fakeFirestore({ "docs/d": { currentVersion: "v1" } });
  const docRef = w.db.doc("docs/d");
  return { ...w, docRef,
    create: () => createSuggestion({ db: w.db, docRef, versionId: "v1", author, actor, anchor, replacement: "new", note: "opening note", color: "#b5257b" }),
    revise: (annId, extra = {}) => changeSuggestion({ db: w.db, docRef, versionId: "v1", annId, op: "revise", caller: author, actor, maySuggest: true, replacement: "newer", note: "revised note", nowMs: 42, ...extra }),
  };
}
const annPath = id => `docs/d/versions/v1/annotations/${id}`;
const anns = w => [...w.store].filter(([path]) => /^docs\/d\/versions\/v1\/annotations\/[^/]+$/.test(path));

for (const aftermath of ["none", "new-head", "pending-limit"]) test(`a suggestion creation acknowledges its own annotation after native retry, aftermath=${aftermath}`, async () => {
  const w = world();
  if (aftermath === "pending-limit") for (let i = 0; i < 19; i++) await w.db.doc(annPath(`prior${i}`)).set({ authorUid: author.uid, suggestion: { state: "pending" } });
  const count = loseFirstTransactionAcknowledgement(w.db, { afterCommit: async () => {
    if (aftermath === "new-head") await w.docRef.update({ currentVersion: "v2" });
  } });
  let result;
  await assert.doesNotReject(async () => { result = await w.create(); }, "one committed creation is acknowledged after the installed SDK retries");
  assert.equal(typeof result.annId, "string", "own committed annotation succeeds before retry-only head or pending-limit guards");
  assert.equal(anns(w).length, aftermath === "pending-limit" ? 20 : 1);
  const own = w.store.get(annPath(result.annId));
  assert.equal(own.suggestion.replacement, "new");
  const comments = [...w.store].filter(([path]) => path.startsWith(`${annPath(result.annId)}/comments/`));
  assert.equal(comments.length, 1);
  assert.equal(comments[0][1].body, "opening note");
  assert.equal(w.store.get("docs/d").currentVersion, aftermath === "new-head" ? "v2" : "v1");
  assert.deepEqual(count(), { callbackCalls: 2, failures: 1 });
});

for (const aftermath of ["none", "accepted", "later-revision", "revision-limit", "new-head"]) test(`a suggestion revision records exactly one change after native retry, aftermath=${aftermath}`, async () => {
  const w = world(), made = await w.create(), ref = w.db.doc(annPath(made.annId));
  if (aftermath === "revision-limit") await ref.update({ "suggestion.revisions": Array.from({ length: 19 }, (_, i) => ({ replacement: `old-${i}`, actor })) });
  const count = loseFirstTransactionAcknowledgement(w.db, { afterCommit: async () => {
    if (aftermath === "new-head") await w.docRef.update({ currentVersion: "v2" });
    if (aftermath === "accepted") await ref.update({ "suggestion.state": "accepted", resolved: true });
    if (aftermath === "later-revision") {
      const suggestion = w.store.get(annPath(made.annId)).suggestion;
      await ref.update({ "suggestion.replacement": "later", "suggestion.revisions": [...suggestion.revisions, { replacement: "newer", operationId: "another-operation", actor }] });
    }
  } });
  const result = await w.revise(made.annId);
  assert.deepEqual(result, { state: "pending" }, "one committed revision is acknowledged before retry-only state or history-limit guards");
  const suggestion = w.store.get(annPath(made.annId)).suggestion;
  assert.equal(suggestion.revisions.length, aftermath === "revision-limit" ? 20 : aftermath === "later-revision" ? 2 : 1, "native retry adds no duplicate history entry");
  assert.equal(suggestion.replacement, aftermath === "later-revision" ? "later" : "newer", "acknowledgement never overwrites a later revision");
  assert.equal(suggestion.state, aftermath === "accepted" ? "accepted" : "pending", "acknowledgement never reopens a later decision");
  assert.equal(suggestion.revisions[aftermath === "revision-limit" ? 19 : 0].replacement, "new");
  const comments = [...w.store].filter(([path]) => path.startsWith(`${annPath(made.annId)}/comments/`));
  assert.equal(comments.length, 1); assert.equal(comments[0][1].body, "revised note");
  assert.deepEqual(count(), { callbackCalls: 2, failures: 1 });
});

for (const abortCommits of [5, 8]) test(`a suggestion survives ${abortCommits} contended commits and a lost acknowledgement`, async () => {
  const w = world();
  const count = loseFirstTransactionAcknowledgement(w.db, { abortCommits });
  const result = await w.create();
  assert.equal(anns(w).length, 1);
  assert.equal(result.annId, anns(w)[0][1].annId);
  assert.equal([...w.store.keys()].filter(path => path.includes('/comments/')).length, 1);
  assert.deepEqual(count(), { failures: 1, callbackCalls: abortCommits + 2 });
});

test("suggestion contention has a finite retry budget without partial feedback", async () => {
  const w = world();
  const count = loseFirstTransactionAcknowledgement(w.db, { abortCommits: 10 });
  await assert.rejects(w.create(), { code: 10 });
  assert.deepEqual(count(), { failures: 0, callbackCalls: 10 });
  assert.equal(anns(w).length, 0);
  assert.equal([...w.store.keys()].filter(path => path.includes('/comments/')).length, 0);
});
