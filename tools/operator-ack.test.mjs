// SPDX-License-Identifier: Apache-2.0
// Operator transaction retries preserve the committed retirement receipt and complete only its captured cleanup (SPEC §9, §13).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { commitOperatorVersion, finishOperatorReplacement } from '../scripts/lib/operator-writes.mjs';
import { repointWithdrawal } from '../scripts/lib/withdraw-version.mjs';
const require = createRequire(import.meta.url);
const { fakeFirestore: createFakeFirestore } = require('../functions/test/fakes.js');
const { loseFirstTransactionAcknowledgement } = require('../functions/test/transaction-ack.js');
import { FieldValue } from '../scripts/lib/firebase.mjs';
const fakeFirestore = data => createFakeFirestore(data, { FieldValue });
const remove = () => FieldValue.delete();
const owner = 'owner@example.com';
const node = { ownerEmail: owner, viewers: [], editors: [], suggesters: [], approvers: [], members: [owner], editorMembers: [owner], currentVersion: 'v1', liveEpoch: 'old', draft: { storagePrefix: 'docs/d/bundles/captured', baseVersion: 'v1' } };

for (const advanced of [false, true]) test(`an operator publish retains its successful replacement receipt after lost ACK, newer head=${advanced}`, async () => {
  const { db, store } = fakeFirestore({ 'docs/d': node, 'docs/d/versions/v1': { contentHash: 'old' } });
  const count = loseFirstTransactionAcknowledgement(db, { afterCommit: async () => {
    if (advanced) {
      await db.doc('docs/d/versions/v3').set({ contentHash: 'later', storagePrefix: 'docs/d/bundles/later' });
      await db.doc('docs/d').update({ currentVersion: 'v3', liveEpoch: 'later' });
    }
  } });
  const result = await commitOperatorVersion(db, db.doc('docs/d'), { existed: true, baseVersion: 'v1', ownerEmail: owner, title: 'document', slug: 'd', viewers: [], editors: [], version: { contentHash: 'new', storagePrefix: 'docs/d/bundles/candidate' } }, null, remove);
  assert.equal(result.duplicate, false, 'own committed upload remains a replacement, never a no-op that skips its cleanup');
  assert.equal(result.versionId, 'v2');
  assert.equal(result.retiredEpoch, 'old');
  assert.equal(result.draftPrefix, 'docs/d/bundles/captured/');
  assert.ok(count().callbackCalls >= 2);
  assert.equal(store.get('docs/d').currentVersion, advanced ? 'v3' : 'v2', 'acknowledgement does not repoint a later head');
  const calls = [];
  await finishOperatorReplacement('d', result, {
    mirror: async () => { calls.push('mirror'); },
    database: () => ({ ref: path => ({ remove: async () => { calls.push(path); } }) }),
    bucket: { deleteFiles: async ({ prefix }) => { calls.push(prefix); } },
  });
  assert.deepEqual(calls, ['mirror', 'status/d/y/old', 'docs/d/bundles/captured/'], 'successful replacement still fences and retires exactly its captured history and draft');
});

for (const laterDraft of [false, true]) test(`an operator withdrawal acknowledges its own repoint before retry guards, later draft=${laterDraft}`, async () => {
  const current = { ...node, currentVersion: 'v2', stats: { commits: 2 } };
  const version = { storagePrefix: 'docs/d/bundles/doomed', entry: 'index.html' };
  const { db, store } = fakeFirestore({ 'docs/d': current, 'docs/d/versions/v1': { storagePrefix: 'docs/d/bundles/retained' }, 'docs/d/versions/v2': version });
  const count = loseFirstTransactionAcknowledgement(db, { afterCommit: async () => {
    if (laterDraft) await db.doc('docs/d').update({ draft: { storagePrefix: 'docs/d/bundles/later', baseVersion: 'v1' } });
  } });
  let result;
  await assert.doesNotReject(async () => { result = await repointWithdrawal(db, db.doc('docs/d'), { currentVersion: 'v2', doomed: 'v2', repoint: 'v1', version, draft: current.draft }, remove); }, 'a completed own repoint must not abort its remaining withdrawal work as a competing writer');
  assert.ok(count().callbackCalls >= 2);
  assert.equal(result.retiredEpoch, 'old');
  assert.equal(result.draftPrefix, 'docs/d/bundles/captured/');
  assert.equal(store.get('docs/d').currentVersion, 'v1');
  assert.equal(store.get('docs/d').stats.commits, 1, 'a retried acknowledgement does not decrement stats twice');
  assert.equal(store.get('docs/d').draft?.storagePrefix, laterDraft ? 'docs/d/bundles/later' : undefined);
});

test('an operator withdrawal retains its retirement result after a later publication changes the head and epoch', async () => {
  const current = { ...node, currentVersion: 'v2', stats: { commits: 2 } };
  const version = { storagePrefix: 'docs/d/bundles/doomed', entry: 'index.html' };
  const { db, store } = fakeFirestore({ 'docs/d': current, 'docs/d/versions/v1': { contentHash: 'old', storagePrefix: 'docs/d/bundles/retained' }, 'docs/d/versions/v2': version });
  const count = loseFirstTransactionAcknowledgement(db, { afterCommit: async () => {
    await commitOperatorVersion(db, db.doc('docs/d'), { existed: true, baseVersion: 'v1', ownerEmail: owner, title: 'later', slug: 'd', viewers: [], editors: [], version: { contentHash: 'later', storagePrefix: 'docs/d/bundles/later' } }, null, remove);
  } });
  let result;
  await assert.doesNotReject(async () => { result = await repointWithdrawal(db, db.doc('docs/d'), { currentVersion: 'v2', doomed: 'v2', repoint: 'v1', version, draft: current.draft }, remove); }, 'ACK operator withdrawal: a later publication does not erase the completed retirement result');
  assert.ok(count().callbackCalls >= 3);
  assert.equal(result.retiredEpoch, 'old');
  assert.equal(result.draftPrefix, 'docs/d/bundles/captured/');
  assert.equal(store.get('docs/d').currentVersion, 'v3', 'ACK operator withdrawal: the newer publication remains current');
  // 2, less the withdrawal, plus the later publication, which counts as every
  // publish does. A retried decrement would leave 1.
  assert.equal(store.get('docs/d').stats.commits, 2, 'ACK operator withdrawal: retry does not decrement stats again');
});
