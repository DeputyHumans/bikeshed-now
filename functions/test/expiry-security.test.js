// SPDX-License-Identifier: Apache-2.0
// Expiry changes are explicit and frozen documents cannot be renamed or moved (SPEC §17).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');
const { fakeFirestore, withFakeAdmin, invoke } = require('./fakes.js');
const { organize, setVisibility } = require('../lib/index.js');
const owner = 'owner@example.com', editor = 'editor@example.com';
const base = { title: 'Original', ownerEmail: owner, members: [owner, editor], editorMembers: [owner, editor], viewers: [], editors: [editor], suggesters: [], approvers: [], folderId: null, visibility: 'private' };
const sessions = { o: { uid: 'owner', email: owner, email_verified: true }, e: { uid: 'editor', email: editor, email_verified: true } };
const expiredError = 'this document has expired — change or clear its expiry to edit it';

for (const who of ['o', 'e']) for (const op of ['rename', 'move']) {
  test(`expired ${op} by ${who === 'o' ? 'owner' : 'editor'} refuses without a metadata or event write`, async () => {
    const { db, store } = fakeFirestore({ 'docs/d': { ...base, expiresAt: Timestamp.fromMillis(Date.now() - 1000) }, 'folders/f': { ...base, parentId: null } });
    const before = new Map(store);
    await withFakeAdmin({ db, sessions }, async () => {
      const response = await invoke(organize, { headers: { cookie: `__session=${who}` }, body: { kind: 'doc', id: 'd', op, name: 'Changed', targetFolderId: 'f' } });
      assert.equal(response.status, 409);
      assert.equal(response.body.error, expiredError);
    });
    assert.deepEqual(store, before, 'refusal preserves title, folder, membership, and the event log');
  });
}

for (const date of ['future', 'past']) test(`visibility without expiresAt preserves a ${date} expiry without an expiry event`, async () => {
  const at = Date.now() + (date === 'future' ? 100_000 : -100_000);
  const { db, store } = fakeFirestore({ 'docs/d': { ...base, expiresAt: Timestamp.fromMillis(at) } });
  await withFakeAdmin({ db, sessions }, async () => {
    const response = await invoke(setVisibility, { headers: { cookie: '__session=o' }, body: { docId: 'd', visibility: 'private' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.expiresAt, at);
  });
  assert.equal(store.get('docs/d').expiresAt.toMillis(), at);
  assert.equal([...store.entries()].filter(([p, data]) => p.includes('/events/') && data.type === 'doc.expiry').length, 0);
});

test('explicit null clears expiry and allows a rename again', async () => {
  const { db, store } = fakeFirestore({ 'docs/d': { ...base, expiresAt: Timestamp.fromMillis(Date.now() - 1000) } });
  await withFakeAdmin({ db, sessions }, async () => {
    const response = await invoke(setVisibility, { headers: { cookie: '__session=o' }, body: { docId: 'd', visibility: 'private', expiresAt: null } });
    assert.equal(response.status, 200);
    assert.equal(response.body.expiresAt, null);
    const rename = await invoke(organize, { headers: { cookie: '__session=e' }, body: { kind: 'doc', id: 'd', op: 'rename', name: 'Restored' } });
    assert.equal(rename.status, 200);
  });
  assert.equal(store.get('docs/d').title, 'Restored');
  assert.equal([...store.entries()].filter(([p, data]) => p.includes('/events/') && data.type === 'doc.expiry').length, 1);
});
