// SPDX-License-Identifier: Apache-2.0
// Operator deltas compose, version selection retries, and competing uploads never share bytes (SPEC §9, §13).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { persistOperatorAccess, commitOperatorVersion as runCommit, finishOperatorReplacement, uploadOperatorBundle } from '../scripts/lib/operator-writes.mjs';
const require = createRequire(import.meta.url);
const { fakeFirestore } = require('../functions/test/fakes.js');
const { FieldValue } = createRequire(new URL('../functions/package.json', import.meta.url))('firebase-admin/firestore');
const commitOperatorVersion = (db, ref, input, stamp) => runCommit(db, ref, input, stamp, () => FieldValue.delete());
const owner = 'owner@example.com';
const node = { ownerEmail: owner, viewers: [], editors: [], suggesters: [], approvers: [], members: [owner], editorMembers: [owner], currentVersion: 'v1' };
const input = (hash, prefix) => ({ existed: true, baseVersion: 'v1', ownerEmail: owner, title: 'document', slug: 'd', viewers: [], editors: [], version: { contentHash: hash, storagePrefix: prefix } });

test('an operator restoration mints a new current version despite a matching historical hash', async () => {
  const { db, store } = fakeFirestore({
    'docs/d': { ...node, currentVersion: 'v2' },
    'docs/d/versions/v1': { contentHash: 'old', storagePrefix: 'docs/d/bundles/old' },
    'docs/d/versions/v2': { contentHash: 'new', storagePrefix: 'docs/d/bundles/new' },
  });
  const restored = { ...input('old', 'docs/d/bundles/restored'), baseVersion: 'v2' };
  const result = await commitOperatorVersion(db, db.doc('docs/d'), restored, null);
  assert.equal(result.duplicate, false, 'an operator restoration must not disappear into a historical match');
  assert.equal(result.versionId, 'v3');
  assert.equal(store.get('docs/d').currentVersion, 'v3');
  assert.equal(store.get('docs/d/versions/v3').parentVersion, 'v2');
  assert.equal(store.get('docs/d/versions/v3').contentHash, 'old');
  const again = await commitOperatorVersion(db, db.doc('docs/d'), { ...restored, baseVersion: 'v3' }, null);
  assert.deepEqual(again, { duplicate: true, versionId: 'v3' }, 'current content still deduplicates even when the same hash also exists in history');
});

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

test('operator replacement advances its live epoch, clears the captured draft and repoints public readers atomically', async () => {
  const draft = { storagePrefix: 'docs/d/bundles/captured-draft', baseVersion: 'v1' };
  const { db, store } = fakeFirestore({
    'docs/d': { ...node, visibility: 'public', liveEpoch: 'old-epoch', draft },
    'docs/d/versions/v1': { contentHash: 'old' },
    'public/d': { currentVersion: 'v1', liveEpoch: 'old-epoch', marking: { enabled: true, label: 'Internal', footer: '' } },
  });
  const next = input('new', 'docs/d/bundles/new');
  Object.assign(next.version, { entry: 'index.html', format: 'markdown', sourceEntry: 'index.md', fileCount: 2 });
  const out = await commitOperatorVersion(db, db.doc('docs/d'), next, null);
  const current = store.get('docs/d');
  assert.match(current.liveEpoch, /^[a-f0-9-]{36}$/);
  assert.notEqual(current.liveEpoch, 'old-epoch');
  assert.equal(current.draft, undefined);
  assert.equal(out.retiredEpoch, 'old-epoch');
  assert.equal(out.draftPrefix, 'docs/d/bundles/captured-draft/');
  assert.deepEqual(store.get('public/d'), { currentVersion: 'v2', liveEpoch: current.liveEpoch, title: 'document', slug: 'd', trusted: true, entry: 'index.html', format: 'markdown', sourceEntry: 'index.md', fileCount: 2, publishedAt: null, marking: { enabled: true, label: 'Internal', footer: '' } });
});

test('operator retry captures the epoch and draft of the transaction that actually wins', async () => {
  const { db, store } = fakeFirestore({ 'docs/d': { ...node, liveEpoch: 'before', draft: { storagePrefix: 'docs/d/bundles/before' } }, 'docs/d/versions/v1': { contentHash: 'old' } });
  const transaction = db.runTransaction.bind(db);
  let raced = false;
  db.runTransaction = (fn) => transaction((tx) => fn({ ...tx, get: async (ref) => {
    const snap = await tx.get(ref);
    if (ref.path === 'docs/d' && !raced) {
      raced = true;
      await db.doc('docs/d').update({ liveEpoch: 'racing-save', draft: { storagePrefix: 'docs/d/bundles/racing-draft' } });
    }
    return snap;
  } }));
  const out = await commitOperatorVersion(db, db.doc('docs/d'), input('new', 'docs/d/bundles/new'), null);
  assert.equal(out.retiredEpoch, 'racing-save');
  assert.equal(out.draftPrefix, 'docs/d/bundles/racing-draft/');
  assert.equal(store.get('docs/d').draft, undefined);
});

test('operator duplicate leaves the live epoch and draft unchanged', async () => {
  const current = { ...node, liveEpoch: 'untouched', draft: { storagePrefix: 'docs/d/bundles/retained' } };
  const { db, store } = fakeFirestore({ 'docs/d': current, 'docs/d/versions/v1': { contentHash: 'same' } });
  const before = structuredClone(store.get('docs/d'));
  const out = await commitOperatorVersion(db, db.doc('docs/d'), input('same', 'docs/d/bundles/unused'), null);
  assert.equal(out.duplicate, true);
  assert.deepEqual(store.get('docs/d'), before);
  assert.equal(out.retiredEpoch, undefined);
});

test('operator replacement refuses a missing public projection before changing the document', async () => {
  const { db, store } = fakeFirestore({ 'docs/d': { ...node, visibility: 'public' }, 'docs/d/versions/v1': { contentHash: 'old' } });
  const before = structuredClone(store);
  await assert.rejects(commitOperatorVersion(db, db.doc('docs/d'), input('new', 'docs/d/bundles/new'), null), /public projection.*missing/);
  assert.deepEqual(store, before);
});

function retirementWorld(logs) {
  const calls = [];
  const values = structuredClone(logs);
  const database = () => ({ ref: (path) => ({
    remove: async () => { calls.push(['remove', path]); delete values[path.split('/').pop()]; },
    once: async () => ({ val: () => structuredClone(values) }),
    update: async (patch) => { calls.push(['legacy', patch]); for (const key of Object.keys(patch)) delete values[key]; },
  }) });
  return { calls, values, database };
}

test('operator cleanup waits for the new fence and keeps a newer log and draft', async () => {
  const world = retirementWorld({ old: { a: 'old-update' }, newer: { b: 'new-update' } });
  const objects = new Set(['docs/d/bundles/old-draft/index.html', 'docs/d/bundles/new-draft/index.html']);
  let release;
  const fence = new Promise((resolve) => { release = resolve; });
  const cleanup = finishOperatorReplacement('d', { retiredEpoch: 'old', draftPrefix: 'docs/d/bundles/old-draft/' }, {
    mirror: async () => { world.calls.push(['mirror']); await fence; },
    database: world.database,
    bucket: { deleteFiles: async ({prefix}) => { world.calls.push(['bytes', prefix]); for (const name of objects) if (name.startsWith(prefix)) objects.delete(name); } },
  });
  await Promise.resolve();
  assert.deepEqual(world.calls, [['mirror']]);
  release();
  await cleanup;
  assert.deepEqual(world.calls, [['mirror'], ['remove', 'status/d/y/old'], ['bytes', 'docs/d/bundles/old-draft/']]);
  assert.deepEqual(world.values, { newer: { b: 'new-update' } });
  assert.deepEqual([...objects], ['docs/d/bundles/new-draft/index.html']);
});

test('operator recovery removes captured legacy strings while preserving epoch maps', async () => {
  const world = retirementWorld({ initial: { old: 'old-update' }, _seed: 'legacy-seed', pushKey: 'legacy-delta', newEpoch: { fresh: 'new-update' } });
  await finishOperatorReplacement('d', { retiredEpoch: 'initial', draftPrefix: null }, { mirror: async () => {}, database: world.database });
  assert.deepEqual(world.values, { newEpoch: { fresh: 'new-update' } });
  assert.deepEqual(world.calls, [['remove', 'status/d/y/initial'], ['legacy', { _seed: null, pushKey: null }]]);
});

test('operator cleanup does not run for a duplicate and stops if the fence fails', async () => {
  const world = retirementWorld({ old: { a: 'keep' } });
  const options = { mirror: async () => { throw new Error('fence unavailable'); }, database: world.database, bucket: { deleteFiles: async () => { throw new Error('must not reach bytes'); } } };
  await finishOperatorReplacement('d', { duplicate: true }, options);
  await assert.rejects(finishOperatorReplacement('d', { retiredEpoch: 'old', draftPrefix: 'docs/d/bundles/keep/' }, options), /fence unavailable/);
  assert.deepEqual(world.calls, []);
  assert.deepEqual(world.values, { old: { a: 'keep' } });
});

test('operator replacement refuses draft cleanup that would delete retained version bytes', async () => {
  const prefix = 'docs/d/bundles/shared';
  const { db, store } = fakeFirestore({ 'docs/d': { ...node, draft: { storagePrefix: prefix } }, 'docs/d/versions/v1': { contentHash: 'old', storagePrefix: prefix } });
  const before = structuredClone(store);
  await assert.rejects(commitOperatorVersion(db, db.doc('docs/d'), input('new', 'docs/d/bundles/new'), null), /draft bytes.*referenced/);
  assert.deepEqual(store, before);
});
