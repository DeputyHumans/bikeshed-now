// SPDX-License-Identifier: Apache-2.0
// Public and unlock projections preserve fork identity without exposing its parent (SPEC §21).

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeFirestore, withFakeAdmin, invoke } = require('./fakes.js');
const { syncPublicProjection } = require('../lib/lib/publicdoc.js');
const { unlockDoc } = require('../lib/index.js');

test('public and unlisted fork projections carry only the forked boolean', async () => {
  const meta = { title: 'Fork', ownerUid: 'owner', ownerEmail: 'owner@example.com', members: ['owner@example.com'], visibility: 'public', currentVersion: 'v1', forked: true };
  const { db, store } = fakeFirestore({ 'docs/f': meta, 'docs/f/versions/v1': { entry: 'index.html' }, 'forks/f': { parentId: 'secret-parent', parentVersion: 'v2' } });
  await syncPublicProjection(db, 'f');
  assert.equal(store.get('public/f').forked, true, 'public fork flag');
  assert.ok(!JSON.stringify(store.get('public/f')).includes('secret-parent'), 'public projection hides parent');
  store.set('docs/f', { ...meta, visibility: 'unlisted', linkToken: 'a-long-link-token-0123456789' });
  const answer = await withFakeAdmin({ db }, () => invoke(unlockDoc, { body: { docId: 'f', k: 'a-long-link-token-0123456789' } }));
  assert.equal(answer.status, 200);
  assert.equal(answer.body.forked, true, 'unlock fork flag');
  assert.ok(!JSON.stringify(answer.body).includes('secret-parent'), 'unlock hides parent');
});
