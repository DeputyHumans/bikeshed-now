// SPDX-License-Identifier: Apache-2.0
// A verification code's hash is kept where no client can read it, never on the account's own record (SPEC §14).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const admin = require('firebase-admin');
const notify = require('../lib/email/notify.js');
const { fakeFirestore, withFakeAdmin, invoke } = require('./fakes.js');
const { verifyEmail } = require('../lib/index.js');

const UID = 'u-claim', OWN = 'claim@example.com', THEIRS = 'invited@example.com';
const hash = (code) => createHash('sha256').update(`${UID}:${code}`).digest('hex');

async function world(initial, fn) {
  const { db, store } = fakeFirestore(initial);
  const sent = [];
  const send = notify.sendVerificationCode;
  notify.sendVerificationCode = async (...args) => { sent.push(args); return { sent: true }; };
  try {
    await withFakeAdmin({ db, idTokens: { token: { uid: UID, email: OWN, email_verified: false } } }, async () => {
      const original = Object.getOwnPropertyDescriptor(admin, 'auth');
      const base = admin.auth();
      Object.defineProperty(admin, 'auth', { configurable: true, value: () => ({ ...base, updateUser: async () => {} }) });
      try { await fn({ store, sent, request: (action, body = {}) => invoke(verifyEmail, { path: `/verify/${action}`, headers: { authorization: 'Bearer token' }, body }) }); }
      finally { Object.defineProperty(admin, 'auth', original); }
    });
  } finally { notify.sendVerificationCode = send; }
}

/** Every field of every record a client may read, flattened, for a search. */
const readable = (store) => [...store.entries()].filter(([path]) => path.startsWith('users/')).map(([, data]) => JSON.stringify(data)).join('\n');

test('asking for a code for someone else\'s address puts nothing a client can read within reach of the code', async () => {
  // The attack this closes: ask for a code for an address you do not own,
  // read its hash from your own account record, try all million codes
  // offline, and complete with the one that matches.
  await world({ [`users/${UID}`]: { uid: UID, email: OWN } }, async ({ request, store, sent }) => {
    assert.equal((await request('start', { email: THEIRS })).status, 200);
    const code = sent[0][1];
    assert.equal(store.get(`verifications/${UID}`).hash, hash(code), 'the challenge is kept, server-side');
    assert.ok(!readable(store).includes(hash(code)), 'and its hash is on no record the account can read');
    assert.deepEqual(store.get(`users/${UID}`), { uid: UID, email: OWN }, 'the account record is untouched until the address is proved');
  });
});

test('completing clears a challenge left on the account record before 0.29.1, and it cannot be completed', async () => {
  const legacy = { hash: hash('123456'), email: THEIRS, expiresAt: Date.now() + 900_000, attempts: 0, sentAt: Date.now() };
  await world({ [`users/${UID}`]: { uid: UID, email: OWN, verification: legacy } }, async ({ request, store, sent }) => {
    assert.equal((await request('complete', { code: '123456' })).status, 409, 'a challenge where codes used to be kept is not one');
    assert.equal((await request('start', { email: OWN })).status, 200);
    assert.equal((await request('complete', { code: sent[0][1] })).status, 200);
    assert.equal(store.get(`users/${UID}`).verification, undefined, 'the old one goes with the new');
    assert.equal(store.has(`verifications/${UID}`), false, 'and the new one is retired');
  });
});
