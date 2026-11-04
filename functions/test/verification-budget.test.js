// SPDX-License-Identifier: Apache-2.0
// An address is sent a bounded number of verification codes a day, however many accounts ask (SPEC §14).

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const notify = require('../lib/email/notify.js');
const { fakeFirestore, withFakeAdmin, invoke } = require('./fakes.js');
const { verifyEmail } = require('../lib/index.js');

const TARGET = 'invited@example.com';
const ACCOUNTS = Array.from({ length: 8 }, (_, i) => ({ uid: `u-${i}`, email: `throwaway${i}@example.com` }));

async function world(fn) {
  const { db, store } = fakeFirestore({});
  const sent = [];
  const send = notify.sendVerificationCode;
  notify.sendVerificationCode = async (...args) => { sent.push(args); return { sent: true }; };
  const idTokens = Object.fromEntries(ACCOUNTS.map((a) => [`t-${a.uid}`, { uid: a.uid, email: a.email, email_verified: false }]));
  try {
    await withFakeAdmin({ db, idTokens }, async () => {
      const original = Object.getOwnPropertyDescriptor(admin, 'auth');
      const base = admin.auth();
      Object.defineProperty(admin, 'auth', { configurable: true, value: () => ({ ...base, updateUser: async () => {} }) });
      try {
        await fn({
          store,
          sent,
          start: (account, email) => invoke(verifyEmail, { path: '/verify/start', headers: { authorization: `Bearer t-${account.uid}` }, body: { email } }),
        });
      } finally { Object.defineProperty(admin, 'auth', original); }
    });
  } finally { notify.sendVerificationCode = send; }
}

test('many accounts asking for codes to one address share that address\'s daily budget', async () => {
  // Each new code brings five fresh guesses and the resend gap is per
  // account, so without a budget per address, enough throwaway accounts
  // could guess their way into an address with shares waiting for it.
  await world(async ({ start, sent, store }) => {
    for (const account of ACCOUNTS.slice(0, 5)) {
      assert.equal((await start(account, TARGET)).status, 200, `${account.uid} is sent a code`);
    }
    const refused = await start(ACCOUNTS[5], TARGET);
    assert.equal(refused.status, 429, 'the sixth code to the same address in a day is refused');
    assert.match(refused.body.error, /this address today/);
    assert.equal(sent.length, 5, 'and nothing is mailed for it');
    assert.equal(store.has(`verifications/${ACCOUNTS[5].uid}`), false, 'nor is a challenge left to guess at');
    // Another address is not affected.
    assert.equal((await start(ACCOUNTS[6], 'someone.else@example.com')).status, 200);
    // The record names no address.
    const targets = [...store.keys()].filter((k) => k.startsWith('verifyTargets/'));
    assert.equal(targets.length, 2);
    assert.ok(targets.every((k) => !k.includes('@')), 'keyed by a hash');
  });
});

test('the budget is a rolling day: codes sent more than a day ago no longer count', async () => {
  await world(async ({ start, store }) => {
    for (const account of ACCOUNTS.slice(0, 5)) assert.equal((await start(account, TARGET)).status, 200);
    const [key] = [...store.keys()].filter((k) => k.startsWith('verifyTargets/'));
    const day = 24 * 60 * 60 * 1000;
    store.set(key, { sentAt: store.get(key).sentAt.map((t) => t - day - 1) });
    assert.equal((await start(ACCOUNTS[5], TARGET)).status, 200);
    assert.equal(store.get(key).sentAt.length, 1, 'expired entries are dropped when the record is written');
  });
});
