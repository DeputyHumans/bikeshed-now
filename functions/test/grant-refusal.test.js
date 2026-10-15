// SPDX-License-Identifier: Apache-2.0
// Stored link proof selects refusal status without granting owner or thumbnail authority (SPEC §1.4, §13, §17).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');
const { fakeFirestore, withFakeAdmin, invoke } = require('./fakes.js');
const { setAccess, setVisibility, trustDoc, setMarking, saveThumbs } = require('../lib/index.js');
const { THUMB_REVISION } = require('../lib/lib/thumbs.js');
const owner = 'owner@example.com', reader = 'reader@example.com';
const key = 'abcdefghijklmnopqrstuv';
const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x0b,0x08,0x00,0x10,0x00,0x10,0x01,0x01,0x11,0x00,0xff,0xd9]);
const operations = [
  ['POST /access', setAccess, { body: { docId: 'd', remove: ['other@example.com'] } }],
  ['GET /access', setAccess, { method: 'GET', query: { docId: 'd' } }],
  ['POST /visibility', setVisibility, { body: { docId: 'd', visibility: 'private' } }],
  ['POST /trust', trustDoc, { body: { docId: 'd', trusted: true } }],
  ['POST /marking', setMarking, { body: { docId: 'd', marking: { enabled: false } } }],
  ['POST /thumb', saveThumbs, { query: { doc: 'd', v: 'v1', kind: 'cover', sizes: String(jpeg.length), r: String(THUMB_REVISION) }, rawBody: jpeg }],
];
const variants = [
  ['current grant', {}, { token: key }, 403],
  ['current open-edit grant', { publicEdit: true }, { token: key }, 403],
  ['rotated grant', { linkToken: 'zyxwvutsrqponmlkjihgfe' }, { token: key }, 404],
  ['current grant after expiry', { expiresAt: Timestamp.fromMillis(1) }, { token: key }, 403],
  ['private document', { visibility: 'private' }, { token: key }, 404],
  ['missing grant', {}, null, 404],
];
for (const [label, patch, grant, expected] of variants) for (const [operation, handler, request] of operations) {
  test(`${operation}: ${label} receives ${expected} and cannot mutate the document`, async () => {
    const { db, store } = fakeFirestore({
      'docs/d': { ownerUid: 'owner', ownerEmail: owner, members: [owner], editorMembers: [owner], visibility: 'unlisted', linkToken: key, currentVersion: 'v1', ...patch },
      ...(grant ? { 'docs/d/linkGrants/reader': { uid: 'reader', ...grant } } : {}),
    });
    const before = new Map(store);
    await withFakeAdmin({ db, sessions: { s: { uid: 'reader', email: reader, email_verified: true } } }, async () => {
      const response = await invoke(handler, { ...request, headers: { cookie: '__session=s' } });
      assert.equal(response.status, expected, 'only current ACL proof changes the refusal status');
      assert.equal(response.body, undefined, 'a refusal exposes no document metadata');
    });
    assert.deepEqual(store, before, 'refusal performs no data, membership, event or grant write');
  });
}
