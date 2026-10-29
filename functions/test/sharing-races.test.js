// SPDX-License-Identifier: Apache-2.0
// Concurrent sharing deltas preserve grants and current effective access (SPEC §4, §13, §18).

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeFirestore, withFakeAdmin, invoke } = require('./fakes.js');
const { setAccess, setFolderAccess, manageTeamMembers } = require('../lib/index.js');
const owner = 'owner@example.com';
const a = 'a@example.com';
const b = 'b@example.com';
const grants = { viewers: [], suggesters: [], editors: [], approvers: [] };
const base = { ownerEmail: owner, ...grants, members: [owner], editorMembers: [owner], suggesterMembers: [owner], approverMembers: [owner] };
const sessions = { s: { uid: 'owner', email: owner, email_verified: true } };
const headers = { cookie: '__session=s' };
const add = (principal) => [{ principal, role: 'viewer' }];
const notify = require('../lib/email/notify.js');
let sent = [];
notify.sendInvitations = async (_actor, recipients) => { sent.push(...recipients.map((r) => r.email)); };

for (const kind of ['document', 'folder', 'team']) {
  test(`concurrent ${kind} deltas preserve both successful additions`, async () => {
    sent = [];
    const { db, store } = fakeFirestore({
      'docs/d': { ...base, folderId: kind === 'folder' ? 'f' : null, viewers: kind === 'team' ? ['team:t'] : [] },
      'folders/f': { ...base, parentId: null, ancestors: [] },
      'teams/t': { ownerEmail: owner, members: [owner], admins: [owner] },
    });
    const handler = kind === 'document' ? setAccess : kind === 'folder' ? setFolderAccess : manageTeamMembers;
    const body = (email) => kind === 'document' ? { docId: 'd', add: add(email) } : kind === 'folder' ? { folderId: 'f', add: add(email) } : { teamId: 't', add: [email] };
    await withFakeAdmin({ db, sessions }, async () => {
      const responses = await Promise.all([a, b].map((email) => invoke(handler, { headers, body: body(email) })));
      assert.deepEqual(responses.map((r) => r.status), [200, 200]);
    });
    const path = kind === 'document' ? 'docs/d' : kind === 'folder' ? 'folders/f' : 'teams/t';
    assert.deepEqual(store.get(path).members, [a, b, owner]);
    assert.deepEqual(store.get('docs/d').members, [a, b, owner]);
    assert.deepEqual(sent.sort(), [a, b], 'each newly granted person receives one invitation');
  });
}

test('removing a team administrator removes their management authority', async () => {
  const { db, store } = fakeFirestore({ 'teams/t': { ownerEmail: owner, members: [owner, a], admins: [owner, a] } });
  await withFakeAdmin({ db, sessions }, async () => {
    const response = await invoke(manageTeamMembers, { headers, body: { teamId: 't', remove: [a] } });
    assert.equal(response.status, 200);
  });
  assert.deepEqual(store.get('teams/t').admins, [owner]);
});

test('a direct grant does not invite someone who already inherited folder access', async () => {
  sent = [];
  const { db } = fakeFirestore({
    'docs/d': { ...base, folderId: 'f' },
    'folders/f': { ...base, members: [a, owner], viewers: [a], parentId: null },
  });
  await withFakeAdmin({ db, sessions }, async () => {
    const result = await invoke(setAccess, { headers, body: { docId: 'd', add: add(b) } });
    assert.equal(result.status, 200);
  });
  assert.deepEqual(sent, [b]);
});
