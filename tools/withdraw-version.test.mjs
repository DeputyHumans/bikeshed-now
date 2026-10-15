// SPDX-License-Identifier: Apache-2.0
// A withdrawal repoints the public view atomically and cleans only its captured immutable bytes (SPEC §9, §17).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { withdrawalPrefix, repointWithdrawal as runRepoint } from '../scripts/lib/withdraw-version.mjs';
const require = createRequire(import.meta.url);
const { fakeFirestore } = require('../functions/test/fakes.js');
// The fake and operator use separate SDK installations; give the fake its own sentinels.
const { FieldValue } = createRequire(new URL('../functions/package.json', import.meta.url))('firebase-admin/firestore');
const repointWithdrawal = (db, ref, value) => runRepoint(db, ref, value, () => FieldValue.delete());
const oldPrefix = 'docs/d/bundles/old-version';
const draft = { baseVersion: 'v2', entry: 'index.html', storagePrefix: 'docs/d/bundles/old-draft' };
const plan = { currentVersion: 'v2', doomed: 'v2', repoint: 'v1', publishedAt: null, draft, version: { storagePrefix: oldPrefix }, keepStats: false };
function world(extra = {}) {
  return fakeFirestore({
    'docs/d': { currentVersion: 'v2', visibility: 'public', draft, stats: { commits: 1 }, thumb: { versionId: 'v2' } },
    'docs/d/versions/v1': { entry: 'notes.html', format: 'markdown', publishedAt: null },
    'docs/d/versions/v2': plan.version,
    'public/d': { currentVersion: 'v2', entry: 'index.html', format: 'html', title: 'Shared', visibility: 'public' },
    ...extra,
  });
}
test('withdrawal selects version and draft metadata prefixes, with legacy fallback', () => {
  assert.equal(withdrawalPrefix('d','v2',plan.version), `${oldPrefix}/`);
  assert.equal(withdrawalPrefix('d','draft',draft), 'docs/d/bundles/old-draft/');
  assert.equal(withdrawalPrefix('d','v1',{}), 'docs/d/v1/');
  assert.equal(withdrawalPrefix('d','draft',{}), 'docs/d/draft/');
});
test('withdrawal refuses prefixes outside a single document-owned bundle', () => {
  for (const storagePrefix of ['docs/other/v2', 'docs/d', 'docs/d/bundles', 'docs/d/../other', 'docs/d/bundles/x/../y', '/docs/d/v2']) {
    assert.throws(() => withdrawalPrefix('d','v2',{storagePrefix}), /invalid.*prefix/, storagePrefix);
  }
});
test('repoint updates the existing public projection in the same transaction', async () => {
  const {db,store}=world();
  await repointWithdrawal(db,db.doc('docs/d'),plan);
  assert.equal(store.get('docs/d').currentVersion,'v1');
  assert.deepEqual(store.get('public/d'), { currentVersion:'v1',liveEpoch:store.get('docs/d').liveEpoch,entry:'notes.html',format:'markdown',sourceEntry:null,fileCount:1,title:'Shared',visibility:'public',publishedAt:null });
  assert.equal(store.get('docs/d').draft,undefined);
  assert.equal(store.get('docs/d').thumb,undefined);
});
for (const change of ['draft','version','repoint']) test(`withdrawal refuses a changed ${change} before any write`, async () => {
  const {db,store}=world();
  if (change==='draft') await db.doc('docs/d').update({draft:{...draft,storagePrefix:'docs/d/bundles/new-draft'}});
  if (change==='version') await db.doc('docs/d/versions/v2').update({storagePrefix:'docs/d/bundles/replaced-version'});
  if (change==='repoint') await db.doc('docs/d/versions/v1').delete();
  const before=new Map(store);
  await assert.rejects(repointWithdrawal(db,db.doc('docs/d'),plan), /changed|disappeared/);
  assert.deepEqual(store,before);
});
test('a private document loses a stale public projection during withdrawal', async () => {
  const {db,store}=world();await db.doc('docs/d').update({visibility:'private'});
  await repointWithdrawal(db,db.doc('docs/d'),plan);
  assert.equal(store.has('public/d'),false);
});
test('an absent public projection refuses without destructive changes', async () => {
  const {db,store}=world();await db.doc('public/d').delete();const before=new Map(store);
  await assert.rejects(repointWithdrawal(db,db.doc('docs/d'),plan), /public projection.*missing/);
  assert.deepEqual(store,before);
});

test('withdrawal advances the epoch in both views and captures only the retired session', async () => {
  const { db, store } = world();
  await db.doc('docs/d').update({ liveEpoch: 'withdrawn-session' });
  const out = await repointWithdrawal(db, db.doc('docs/d'), plan);
  assert.match(store.get('docs/d').liveEpoch, /^[a-f0-9-]{36}$/);
  assert.equal(store.get('public/d').liveEpoch, store.get('docs/d').liveEpoch);
  assert.equal(out.retiredEpoch, 'withdrawn-session');
  assert.equal(out.draftPrefix, 'docs/d/bundles/old-draft/');
  assert.equal(store.get('public/d').sourceEntry, null);
  assert.equal(store.get('public/d').fileCount, 1);
});
