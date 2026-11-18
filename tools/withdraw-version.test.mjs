// SPDX-License-Identifier: Apache-2.0
// A withdrawal repoints the public view atomically and cleans only its captured immutable bytes (SPEC §9, §17).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { withdrawalPrefix, repointWithdrawal as runRepoint } from '../scripts/lib/withdraw-version.mjs';
const require = createRequire(import.meta.url);
const { fakeFirestore: createFakeFirestore } = require('../functions/test/fakes.js');
// Drive the fake with the same SDK sentinels as the actual operator helper.
import { FieldValue } from '../scripts/lib/firebase.mjs';
const fakeFirestore = data => createFakeFirestore(data, { FieldValue });
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

// A version that lists its files owns no prefix (SPEC §4, ADR 0035).
const hex = (c) => c.repeat(64);
const listed = (files, attempt) => ({ entry: 'index.html', format: 'html', layout: 'blobs', attempt,
  files: files.map(([rel]) => rel), hashes: files.map(([, h]) => h), sizes: files.map(() => 1), publishedAt: null });
test('withdrawing a version that lists its files marks and returns only the files no other version names', async () => {
  const kept = listed([['img/chart.png', hex('a')], ['index.html', hex('b')]], 'one');
  const doomed = listed([['img/chart.png', hex('a')], ['index.html', hex('c')], ['secret.png', hex('d')]], 'two');
  const { db, store } = fakeFirestore({
    'docs/d': { currentVersion: 'v2', visibility: 'private', stats: { commits: 2 } },
    'docs/d/versions/v1': kept,
    'docs/d/versions/v2': doomed,
  });
  assert.equal(withdrawalPrefix('d', 'v2', doomed), null, 'it owns no prefix to delete');
  const result = await repointWithdrawal(db, db.doc('docs/d'), { currentVersion: 'v2', doomed: 'v2', repoint: 'v1', draft: null, version: doomed, keepStats: false });
  assert.deepEqual(result.blobs.sort(), [`docs/d/blobs/${hex('c')}`, `docs/d/blobs/${hex('d')}`]);
  const mark = store.get('docs/d').withdrawing;
  assert.deepEqual(mark.hashes.sort(), [hex('c'), hex('d')], 'the chart v1 shares is never marked');
  assert.ok(mark.until > Date.now() && mark.until <= Date.now() + 60 * 60 * 1000, 'the mark lapses within the hour');
  assert.equal(store.get('docs/d').currentVersion, 'v1');
});
test('a version published before the repoint keeps every file it names', async () => {
  const doomed = listed([['index.html', hex('c')]], 'two');
  const { db } = fakeFirestore({
    'docs/d': { currentVersion: 'v2', visibility: 'private', stats: { commits: 3 } },
    'docs/d/versions/v1': listed([['index.html', hex('b')]], 'one'),
    'docs/d/versions/v2': doomed,
    // Published while the operator read the plan: it names the doomed version's page.
    'docs/d/versions/v3': listed([['index.html', hex('c')]], 'three'),
  });
  const result = await repointWithdrawal(db, db.doc('docs/d'), { currentVersion: 'v2', doomed: 'v2', repoint: 'v1', draft: null, version: doomed, keepStats: false });
  assert.deepEqual(result.blobs, []);
});
test('a withdrawal refuses a version replaced by another attempt since the plan was read', async () => {
  const { db } = fakeFirestore({
    'docs/d': { currentVersion: 'v2', visibility: 'private', stats: { commits: 2 } },
    'docs/d/versions/v1': listed([['index.html', hex('b')]], 'one'),
    'docs/d/versions/v2': listed([['index.html', hex('e')]], 'reminted'),
  });
  await assert.rejects(
    repointWithdrawal(db, db.doc('docs/d'), { currentVersion: 'v2', doomed: 'v2', repoint: 'v1', draft: null, version: listed([['index.html', hex('c')]], 'two'), keepStats: false }),
    /version bytes changed/,
  );
});
