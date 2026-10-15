// SPDX-License-Identifier: Apache-2.0
// Operator deltas compose, version selection retries, and competing uploads never share bytes (SPEC §9, §13).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { persistOperatorAccess, commitOperatorVersion, uploadOperatorBundle } from '../scripts/lib/operator-writes.mjs';
const require = createRequire(import.meta.url);
const { fakeFirestore } = require('../functions/test/fakes.js');
const owner = 'owner@example.com';
const node = { ownerEmail: owner, viewers: [], editors: [], suggesters: [], approvers: [], members: [owner], editorMembers: [owner], currentVersion: 'v1' };
const input = (hash, prefix) => ({ existed: true, baseVersion: 'v1', ownerEmail: owner, title: 'document', slug: 'd', viewers: [], editors: [], version: { contentHash: hash, storagePrefix: prefix } });

test('operator access deltas compose and preserve inherited and team membership', async () => {
  const { db, store } = fakeFirestore({
    'docs/d': { ...node, folderId: 'f' },
    'folders/f': { members: ['folder@example.com'], editorMembers: [] },
    'teams/t': { members: ['team@example.com'] },
  });
  await Promise.all(['a@example.com', 'team:t'].map((email) => persistOperatorAccess(db, db.doc('docs/d'), { add: [email], remove: [], role: 'viewer' }, null)));
  assert.deepEqual(store.get('docs/d').viewers, ['a@example.com', 'team:t']);
  assert.deepEqual(store.get('docs/d').members, ['a@example.com', 'folder@example.com', owner, 'team@example.com']);
  await persistOperatorAccess(db, db.doc('docs/d'), { add: [], remove: ['a@example.com', owner], role: 'viewer' }, null);
  assert.deepEqual(store.get('docs/d').members, ['folder@example.com', owner, 'team@example.com']);
});

test('competing operator uploads own different immutable objects', async () => {
  const objects = new Map();
  const bucket = { file: (path) => ({ save: async (bytes, options) => {
    if (options.preconditionOpts?.ifGenerationMatch === 0 && objects.has(path)) throw new Error('precondition failed');
    objects.set(path, Buffer.from(bytes));
  } }) };
  const prefixes = await Promise.all(['first', 'second'].map((body) => uploadOperatorBundle(bucket, 'd', [{ rel: 'index.html', data: Buffer.from(body) }])));
  assert.notEqual(prefixes[0], prefixes[1]);
  assert.equal(objects.get(`${prefixes[0]}/index.html`).toString(), 'first');
  assert.equal(objects.get(`${prefixes[1]}/index.html`).toString(), 'second');
});

test('competing operator publishes cannot replace a winner or advance from its stale base', async () => {
  const { db, store } = fakeFirestore({ 'docs/d': node, 'docs/d/versions/v1': { contentHash: 'old' } });
  const results = await Promise.allSettled(['one', 'two'].map((hash) => commitOperatorVersion(db, db.doc('docs/d'), input(hash, `docs/d/bundles/${hash}`), null)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /advanced while uploading/);
  assert.equal(store.get('docs/d').currentVersion, 'v2');
  assert.equal([...store.keys()].filter((p) => p.startsWith('docs/d/versions/')).length, 2);
  const winner = store.get('docs/d/versions/v2');
  assert.equal(winner.storagePrefix, `docs/d/bundles/${winner.contentHash}`);
});

test('duplicate operator uploads resolve to one version and preserve concurrent sharing', async () => {
  const { db, store } = fakeFirestore({ 'docs/d': node, 'docs/d/versions/v1': { contentHash: 'old' } });
  const [one, two] = await Promise.all([
    commitOperatorVersion(db, db.doc('docs/d'), input('same', 'docs/d/bundles/one'), null),
    commitOperatorVersion(db, db.doc('docs/d'), input('same', 'docs/d/bundles/two'), null),
    persistOperatorAccess(db, db.doc('docs/d'), { add: ['new@example.com'], remove: [], role: 'editor' }, null),
  ]);
  assert.equal(one.versionId, two.versionId);
  assert.deepEqual([one.duplicate, two.duplicate].sort(), [false, true]);
  assert.deepEqual(store.get('docs/d').editorMembers, ['new@example.com', owner]);
  assert.equal(store.get('docs/d/versions/v2').parentVersion, 'v1');
});

test('operator uploads refuse an existing object instead of overwriting it', async () => {
  let bytes = Buffer.from('winner');
  const bucket = { file: () => ({ save: async (incoming, options) => {
    if (options.preconditionOpts?.ifGenerationMatch === 0) throw new Error('precondition failed');
    bytes = incoming;
  } }) };
  await assert.rejects(uploadOperatorBundle(bucket, 'd', [{ rel: 'index.html', data: Buffer.from('loser') }]), /precondition failed/);
  assert.equal(bytes.toString(), 'winner');
});
