// SPDX-License-Identifier: Apache-2.0
// Sharing revocation updates direct and inherited access without revealing whether a denied document exists (SPEC §13, §17, §18).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeFirestore, withFakeAdmin, invoke } = require('./fakes.js');
const { contentProxy, setAccess, setFolderAccess, manageTeamMembers, setVisibility } = require('../lib/index.js');
const owner = 'owner@example.com', reader = 'reader@example.com', other = 'other@example.com';
const base = { ownerUid: 'o', ownerEmail: owner, visibility: 'private', folderId: null, viewers: [], suggesters: [], editors: [], approvers: [], members: [owner], editorMembers: [owner], suggesterMembers: [owner], approverMembers: [owner] };
const sessions = { o: { uid: 'o', email: owner, email_verified: true }, r: { uid: 'r', email: reader, email_verified: true } };
const headers = { cookie: '__session=o' };
require('../lib/email/notify.js').sendInvitations = async () => {};

test('removing a viewer returns the absent id response, including body and cache headers', async () => {
  const { db } = fakeFirestore({ 'docs/d': { ...base, viewers: [reader], members: [owner, reader] } });
  await withFakeAdmin({ db, sessions }, async () => {
    assert.equal((await invoke(setAccess, { headers, body: { docId: 'd', remove: [reader] } })).status, 200);
    const removed = await invoke(contentProxy, { method: 'GET', path: '/content/d/v1/', headers: { cookie: '__session=r' } });
    const absent = await invoke(contentProxy, { method: 'GET', path: '/content/absent/v1/' });
    assert.equal(removed.status, 404);
    assert.deepEqual(removed, absent, 'removed and absent responses are byte/header equivalent');
    assert.equal(removed.headers['cache-control'], 'private, no-store');
  });
});

test('team removal re-fans the direct document grant independently of a folder grant', async () => {
  const { db, store } = fakeFirestore({
    'teams/t': { ownerEmail: owner, members: [owner, reader, other], admins: [owner] },
    'docs/direct': { ...base, viewers: ['team:t'], members: [owner, reader, other] },
    'folders/f': { ...base, parentId: null, ancestors: [], viewers: ['team:t'], members: [owner, reader, other] },
    'docs/filed': { ...base, folderId: 'f', members: [owner, reader, other] },
  });
  await withFakeAdmin({ db, sessions }, async () => {
    assert.equal((await invoke(manageTeamMembers, { headers, body: { teamId: 't', remove: [reader] } })).status, 200);
  });
  assert.deepEqual(store.get('docs/direct').members, [other, owner], 'direct document loses the removed team member');
  assert.deepEqual(store.get('docs/filed').members, [other, owner], 'filed document also loses the removed team member');
});

test('a folder grant followed by removal reaches every descendant document', async () => {
  const { db, store } = fakeFirestore({
    'folders/a': { ...base, parentId: null, ancestors: [] },
    'folders/b': { ...base, parentId: 'a', ancestors: ['a'] },
    'folders/c': { ...base, parentId: 'b', ancestors: ['a', 'b'] },
    'docs/d': { ...base, folderId: 'c' },
  });
  await withFakeAdmin({ db, sessions }, async () => {
    assert.equal((await invoke(setFolderAccess, { headers, body: { folderId: 'a', add: [{ principal: reader, role: 'editor' }] } })).status, 200);
    assert.ok(store.get('docs/d').editorMembers.includes(reader), 'positive grant reaches the leaf');
    assert.equal((await invoke(setFolderAccess, { headers, body: { folderId: 'a', remove: [reader] } })).status, 200);
    assert.deepEqual(store.get('docs/d').members, [owner], 'the removal reaches the leaf too');
    assert.deepEqual(store.get('docs/d').editorMembers, [owner]);
  });
});

test('making an open-edit document private clears the stored open-edit flag even when the request sends true', async () => {
  const { db, store } = fakeFirestore({ 'docs/d': { ...base, visibility: 'unlisted', publicEdit: true, linkToken: 'x'.repeat(22) } });
  await withFakeAdmin({ db, sessions }, async () => {
    const response = await invoke(setVisibility, { headers, body: { docId: 'd', visibility: 'private', publicEdit: true } });
    assert.equal(response.status, 200);
    assert.equal(store.get('docs/d').publicEdit, false);
  });
});
