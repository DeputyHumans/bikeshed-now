// SPDX-License-Identifier: Apache-2.0
// Verification limits apply to concurrent requests, and delayed completion cannot erase a newer challenge (SPEC §14).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const admin = require('firebase-admin');
const notify = require('../lib/email/notify.js');
const { fakeFirestore, withFakeAdmin, invoke } = require('./fakes.js');
const { verifyEmail } = require('../lib/index.js');
const UID = 'u-verify', EMAIL = 'verify@example.com', CODE = '123456';
const hash = (code) => createHash('sha256').update(`${UID}:${code}`).digest('hex');
const challenge = (extra = {}) => ({ hash: hash(CODE), email: EMAIL, expiresAt: Date.now() + 900_000, attempts: 0, sentAt: Date.now(), ...extra });
async function world(initial, fn, updateUser = async () => {}) {
  const { db, store } = fakeFirestore(initial ? { [`users/${UID}`]: { uid: UID, verification: initial } } : {});
  const sent = [], updated = [];
  const send = notify.sendVerificationCode;
  notify.sendVerificationCode = async (...args) => { sent.push(args); return { sent: true }; };
  try {
    await withFakeAdmin({ db, idTokens: { token: { uid: UID, email: EMAIL, email_verified: false } } }, async () => {
      const original = Object.getOwnPropertyDescriptor(admin, 'auth');
      const base = admin.auth();
      Object.defineProperty(admin, 'auth', { configurable: true, value: () => ({ ...base, updateUser: async (...args) => { updated.push(args); await updateUser({ db, store }, ...args); } }) });
      try { await fn({ db, store, sent, updated, request: (action, body = {}) => invoke(verifyEmail, { path: `/verify/${action}`, headers: { authorization: 'Bearer token' }, body }) }); }
      finally { Object.defineProperty(admin, 'auth', original); }
    });
  } finally { notify.sendVerificationCode = send; }
}

test('twenty concurrent wrong codes spend at most the five guesses and cannot verify after lockout', async () => {
  await world(challenge(), async ({ request, store, updated }) => {
    const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => request('complete', { code: String(200000 + i) })));
    assert.equal(replies.filter((r) => r.status === 400).length, 5);
    assert.ok(replies.some((r) => r.status === 429));
    assert.ok(replies.every((r) => [400, 409, 429].includes(r.status)));
    assert.equal(store.get(`users/${UID}`).verification, undefined);
    const correct = await request('complete', { code: CODE });
    assert.equal(correct.status, 409);
    assert.deepEqual(updated, []);
  });
});
test('twenty simultaneous resend requests reserve exactly one challenge and mail only its code', async () => {
  await world(null, async ({ request, store, sent }) => {
    const replies = await Promise.all(Array.from({ length: 20 }, () => request('start')));
    assert.equal(replies.filter((r) => r.status === 200).length, 1);
    assert.equal(replies.filter((r) => r.status === 429).length, 19);
    assert.equal(sent.length, 1);
    const verification = store.get(`users/${UID}`).verification;
    assert.equal(verification.hash, hash(sent[0][1]));
    assert.equal(verification.email, sent[0][0]);
    assert.equal(verification.attempts, 0);
    const done = await request('complete', { code: sent[0][1] });
    assert.equal(done.status, 200);
    assert.equal(store.get(`users/${UID}`).verification, undefined);
  });
});
test('an old challenge at the resend boundary still permits exactly one replacement', async () => {
  await world(challenge({ sentAt: Date.now() - 61_000 }), async ({ request, sent, store }) => {
    const replies = await Promise.all(Array.from({ length: 10 }, () => request('start')));
    assert.equal(replies.filter((r) => r.status === 200).length, 1);
    assert.equal(sent.length, 1);
    assert.equal(store.get(`users/${UID}`).verification.hash, hash(sent[0][1]));
  });
});
test('a delayed successful completion never deletes a newer challenge reserved while Auth was updating', async () => {
  const fresh = challenge({ hash: hash('654321'), email: 'new@example.com' });
  await world(challenge(), async ({ request, store }) => {
    const reply = await request('complete', { code: CODE });
    assert.equal(reply.status, 200);
    assert.deepEqual(store.get(`users/${UID}`).verification, fresh);
  }, async ({ db }) => { await db.doc(`users/${UID}`).update({ verification: fresh }); });
});

test('the sixth attempt is refused even with the right code, and cannot update Auth', async () => {
  await world(challenge(), async ({ request, store, updated }) => {
    for (let i = 0; i < 5; i++) assert.equal((await request('complete', { code: '000000' })).status, 400);
    assert.equal(store.get(`users/${UID}`).verification.attempts, 5);
    const sixth = await request('complete', { code: CODE });
    assert.equal(sixth.status, 429);
    assert.equal(store.get(`users/${UID}`).verification, undefined);
    assert.deepEqual(updated, []);
  });
});
test('an expired correct code is retired without verifying Auth', async () => {
  await world(challenge({ expiresAt: Date.now() - 1 }), async ({ request, store, updated }) => {
    const reply = await request('complete', { code: CODE });
    assert.equal(reply.status, 409);
    assert.equal(reply.body.error, 'that code has expired');
    assert.equal(store.get(`users/${UID}`).verification, undefined);
    assert.deepEqual(updated, []);
  });
});
test('an Auth failure preserves the checked challenge so its correct code can retry', async () => {
  const initial = challenge();
  let first = true;
  await world(initial, async ({ request, store, updated }) => {
    await assert.rejects(request('complete', { code: CODE }), /Auth unavailable/);
    assert.deepEqual(store.get(`users/${UID}`).verification, initial);
    assert.equal((await request('complete', { code: CODE })).status, 200);
    assert.equal(store.get(`users/${UID}`).verification, undefined);
    assert.deepEqual(updated[1], [UID, { email: EMAIL, emailVerified: true }]);
  }, async () => { if (first) { first = false; throw new Error('Auth unavailable'); } });
});
test('a recent challenge refuses resend without changing its attempts, address, or code', async () => {
  const initial = challenge({ attempts: 4 });
  await world(initial, async ({ request, store, sent }) => {
    assert.equal((await request('start', { email: 'other@example.com' })).status, 429);
    assert.deepEqual(store.get(`users/${UID}`).verification, initial);
    assert.deepEqual(sent, []);
  });
});
