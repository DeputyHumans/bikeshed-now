// SPDX-License-Identifier: Apache-2.0
// Operator deltas compose, version selection retries, and each file is stored once and never overwritten (SPEC §4, §9, §13).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { persistOperatorAccess, commitOperatorVersion as runCommit, finishOperatorReplacement, storeOperatorFiles } from '../scripts/lib/operator-writes.mjs';
import { sha256Hex } from '../scripts/lib/hash.mjs';
const require = createRequire(import.meta.url);
const { fakeFirestore: createFakeFirestore } = require('../functions/test/fakes.js');
import { FieldValue } from '../scripts/lib/firebase.mjs';
const fakeFirestore = data => createFakeFirestore(data, { FieldValue });
const commitOperatorVersion = (db, ref, input, stamp) => runCommit(db, ref, input, stamp, () => FieldValue.delete());
const owner = 'owner@example.com';
const node = { ownerEmail: owner, viewers: [], editors: [], suggesters: [], approvers: [], members: [owner], editorMembers: [owner], currentVersion: 'v1' };
// A version listing its files (SPEC §4): `hash` is its v2 content hash, and
// `bytesHash` the v1 hash of the same bytes, which a head minted before v2 is
// compared with. `attempt` is how a retried transaction knows its own commit.
const input = (hash, attempt) => ({ existed: true, baseVersion: 'v1', ownerEmail: owner, title: 'document', slug: 'd', viewers: [], editors: [],
  version: { contentHash: hash, hashVersion: 2, layout: 'blobs', files: [], hashes: [], sizes: [], attempt }, bytesHash: `v1:${hash}` });

test('an operator restoration mints a new current version despite a matching historical hash', async () => {
  const { db, store } = fakeFirestore({
    'docs/d': { ...node, currentVersion: 'v2' },
    'docs/d/versions/v1': { contentHash: 'old', storagePrefix: 'docs/d/bundles/old' },
    'docs/d/versions/v2': { contentHash: 'new', storagePrefix: 'docs/d/bundles/new' },
  });
  const restored = { ...input('old', 'restored'), baseVersion: 'v2' };
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

test('operator uploads store each file once, by its bytes, whoever else is storing it', async () => {
  const objects = new Map();
  const bucket = { file: (path) => ({ save: async (bytes, options) => {
    if (options.preconditionOpts?.ifGenerationMatch === 0 && objects.has(path)) throw Object.assign(new Error('precondition failed'), { code: 412 });
    objects.set(path, Buffer.from(bytes));
  } }) };
  const written = await Promise.all(['first', 'second', 'first'].map((body) => storeOperatorFiles(bucket, 'd', [{ rel: 'index.html', data: Buffer.from(body) }])));
  assert.deepEqual([...objects.keys()].sort(), [`docs/d/blobs/${sha256Hex(Buffer.from('first'))}`, `docs/d/blobs/${sha256Hex(Buffer.from('second'))}`].sort());
  assert.equal(written.reduce((n, w) => n + w, 0), 2, 'the second store of the same bytes finds them there');
  const twice = await storeOperatorFiles(bucket, 'd', [{ rel: 'a.png', data: Buffer.from('same') }, { rel: 'b.png', data: Buffer.from('same') }]);
  assert.equal(twice, 1, 'one file at two paths is stored once');
});

test('competing operator publishes cannot replace a winner or advance from its stale base', async () => {
  const { db, store } = fakeFirestore({ 'docs/d': node, 'docs/d/versions/v1': { contentHash: 'old' } });
  const results = await Promise.allSettled(['one', 'two'].map((hash) => commitOperatorVersion(db, db.doc('docs/d'), input(hash, hash), null)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /advanced while uploading/);
  assert.equal(store.get('docs/d').currentVersion, 'v2');
  assert.equal([...store.keys()].filter((p) => p.startsWith('docs/d/versions/')).length, 2);
  const winner = store.get('docs/d/versions/v2');
  assert.equal(winner.attempt, winner.contentHash, 'the winner is one attempt whole, not a mix of two');
});

test('duplicate operator uploads resolve to one version and preserve concurrent sharing', async () => {
  const { db, store } = fakeFirestore({ 'docs/d': node, 'docs/d/versions/v1': { contentHash: 'old' } });
  const [one, two] = await Promise.all([
    commitOperatorVersion(db, db.doc('docs/d'), input('same', 'one'), null),
    commitOperatorVersion(db, db.doc('docs/d'), input('same', 'two'), null),
    persistOperatorAccess(db, db.doc('docs/d'), { add: ['new@example.com'], remove: [], role: 'editor' }, null),
  ]);
  assert.equal(one.versionId, two.versionId);
  assert.deepEqual([one.duplicate, two.duplicate].sort(), [false, true]);
  assert.deepEqual(store.get('docs/d').editorMembers, ['new@example.com', owner]);
  assert.equal(store.get('docs/d/versions/v2').parentVersion, 'v1');
});

test('operator uploads never overwrite a stored object, and fail on any other refusal', async () => {
  let bytes = Buffer.from('winner');
  const there = { file: () => ({ save: async (incoming, options) => {
    if (options.preconditionOpts?.ifGenerationMatch === 0) throw Object.assign(new Error('precondition failed'), { code: 412 });
    bytes = incoming;
  } }) };
  assert.equal(await storeOperatorFiles(there, 'd', [{ rel: 'index.html', data: Buffer.from('winner') }]), 0, 'already stored is success');
  assert.equal(bytes.toString(), 'winner');
  const quota = { file: () => ({ save: async () => { throw Object.assign(new Error('quota'), { code: 429 }); } }) };
  await assert.rejects(storeOperatorFiles(quota, 'd', [{ rel: 'index.html', data: Buffer.from('x') }]), /quota/);
});

test('operator replacement advances its live epoch, clears the captured draft and repoints public readers atomically', async () => {
  const draft = { storagePrefix: 'docs/d/bundles/captured-draft', baseVersion: 'v1' };
  const { db, store } = fakeFirestore({
    'docs/d': { ...node, visibility: 'public', liveEpoch: 'old-epoch', draft },
    'docs/d/versions/v1': { contentHash: 'old' },
    'public/d': { currentVersion: 'v1', liveEpoch: 'old-epoch', marking: { enabled: true, label: 'Internal', footer: '' } },
  });
  const next = input('new', 'new');
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
  const out = await commitOperatorVersion(db, db.doc('docs/d'), input('new', 'new'), null);
  assert.equal(out.retiredEpoch, 'racing-save');
  assert.equal(out.draftPrefix, 'docs/d/bundles/racing-draft/');
  assert.equal(store.get('docs/d').draft, undefined);
});

test('operator duplicate leaves the live epoch and draft unchanged', async () => {
  const current = { ...node, liveEpoch: 'untouched', draft: { storagePrefix: 'docs/d/bundles/retained' } };
  // A head from before v2 is compared with the v1 hash of the operator's bytes.
  const { db, store } = fakeFirestore({ 'docs/d': current, 'docs/d/versions/v1': { contentHash: 'v1:same' } });
  const before = structuredClone(store.get('docs/d'));
  const out = await commitOperatorVersion(db, db.doc('docs/d'), input('same', 'unused'), null);
  assert.equal(out.duplicate, true);
  assert.deepEqual(store.get('docs/d'), before);
  assert.equal(out.retiredEpoch, undefined);
});

test('operator replacement refuses a missing public projection before changing the document', async () => {
  const { db, store } = fakeFirestore({ 'docs/d': { ...node, visibility: 'public' }, 'docs/d/versions/v1': { contentHash: 'old' } });
  const before = structuredClone(store);
  await assert.rejects(commitOperatorVersion(db, db.doc('docs/d'), input('new', 'new'), null), /public projection.*missing/);
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
  await assert.rejects(commitOperatorVersion(db, db.doc('docs/d'), input('new', 'new'), null), /draft bytes.*referenced/);
  assert.deepEqual(store, before);
});
