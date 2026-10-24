// SPDX-License-Identifier: Apache-2.0
// Reading identities stay in editor-gated records, including legacy cleanup (SPEC §4, §17).

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeFirestore, withFakeAdmin, invoke } = require('./fakes.js');
const { recordView } = require('../lib/index.js');
const email = 'reader@example.com';
const sessions = { r: { uid: 'reader', email, email_verified: true } };

for (const legacy of [false, true]) for (const signedIn of [false, true]) {
  test(`${signedIn ? 'member' : 'anonymous'} beat ${legacy ? 'removes a legacy identity' : 'never adds an identity'} to shared stats`, async () => {
    const { db, store } = fakeFirestore({ 'docs/d': {
      ownerEmail: email, members: [email], visibility: 'public', currentVersion: 'v1',
      stats: { commits: 4, lastEditedByEmail: 'author@example.com', ...(legacy ? { lastViewedByEmail: 'old-reader@example.com' } : {}) },
    } });
    await withFakeAdmin({ db, sessions }, async () => {
      const r = await invoke(recordView, { headers: signedIn ? { cookie: '__session=r' } : {}, body: { docId: 'd', versionId: 'v1', sessionId: '0123456789abcdef0123456789abcdef', ms: 1200 } });
      assert.equal(r.status, 200);
    });
    const stats = store.get('docs/d').stats;
    assert.equal(Object.hasOwn(stats, 'lastViewedByEmail'), false, 'shared stats contain no last reader identity');
    assert.equal(stats.views, 1);
    assert.equal(stats.totalMs, 1200);
    assert.equal(stats.commits, 4, 'unrelated publication stats survive');
    assert.equal(stats.lastEditedByEmail, 'author@example.com');
    const session = store.get('docs/d/views/0123456789abcdef0123456789abcdef');
    assert.equal(session.email, signedIn ? email : null, 'editor-gated history keeps its identity');
  });
}
