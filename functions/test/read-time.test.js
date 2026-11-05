// SPDX-License-Identifier: Apache-2.0
// "Last read" moves when reading happened, and a beat that adds no time is not reading (SPEC §2, §4).

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeFirestore, withFakeAdmin, invoke } = require('./fakes.js');
const { recordView } = require('../lib/index.js');
const { MAX_SESSION_MS } = require('../lib/config.js');

const email = 'reader@example.com';
const sessions = { r: { uid: 'reader', email, email_verified: true } };
const SESSION = '0123456789abcdef0123456789abcdef';
const ROW = 'docs/d/viewers/reader';

/** A reader on a public document, and a way to send the beats a client would. */
function reader() {
  const { db, store } = fakeFirestore({ 'docs/d': {
    ownerEmail: 'owner@example.com', members: ['owner@example.com'], visibility: 'public', currentVersion: 'v1', stats: {},
  } });
  const beat = (ms, { signedIn = true, sessionId = SESSION } = {}) => withFakeAdmin({ db, sessions }, async () => {
    const r = await invoke(recordView, {
      headers: signedIn ? { cookie: '__session=r' } : {},
      body: { docId: 'd', versionId: 'v1', sessionId, ms },
    });
    assert.equal(r.status, 200);
  });
  const shared = () => store.get('docs/d').stats.lastViewedAt;
  const own = () => store.get(ROW)?.lastViewedAt;
  return { store, beat, shared, own };
}

/** The fake's clock is strictly increasing, so an unchanged stamp was not written. */
const same = (a, b) => a.isEqual(b);

test('a session\'s first beat is a read, at zero time', async () => {
  const { beat, shared, own } = reader();
  await beat(0);
  assert.ok(shared(), 'stats.lastViewedAt is stamped');
  assert.ok(own(), 'viewers/{uid}.lastViewedAt is stamped');
});

test('a returning reader\'s next visit is a read, at zero time', async () => {
  // Their row exists by now, so only the new session can say this is a read.
  const { beat, shared, own } = reader();
  await beat(1200);
  const [s, o] = [shared(), own()];
  await beat(0, { sessionId: 'abcdef0123456789abcdef0123456789' });
  assert.ok(!same(shared(), s), 'stats.lastViewedAt moved');
  assert.ok(!same(own(), o), 'viewers/{uid}.lastViewedAt moved');
});

test('a beat that adds no time moves neither time: a background tab is not reading', async () => {
  const { beat, shared, own } = reader();
  await beat(1200);
  const [s, o] = [shared(), own()];

  // What a client from before the fix sends each minute from a hidden tab.
  await beat(1200);
  await beat(1200);
  assert.ok(same(shared(), s), 'stats.lastViewedAt did not move');
  assert.ok(same(own(), o), 'viewers/{uid}.lastViewedAt did not move');

  // A beat delivered late, behind a newer one, says nothing new either.
  await beat(800);
  assert.ok(same(shared(), s), 'a reordered beat moved stats.lastViewedAt');
  assert.ok(same(own(), o), 'a reordered beat moved viewers/{uid}.lastViewedAt');
});

test('a beat that adds time moves both', async () => {
  const { beat, shared, own } = reader();
  await beat(1200);
  const [s, o] = [shared(), own()];
  await beat(1800);
  assert.ok(!same(shared(), s), 'stats.lastViewedAt moved');
  assert.ok(!same(own(), o), 'viewers/{uid}.lastViewedAt moved');
});

test('an anonymous reader\'s empty beat leaves the shared time alone too', async () => {
  const { store, beat, shared } = reader();
  await beat(1200, { signedIn: false });
  const s = shared();
  await beat(1200, { signedIn: false });
  assert.ok(same(shared(), s), 'stats.lastViewedAt did not move');
  assert.equal(store.get(ROW), undefined, 'an anonymous reader still has no row');
});

test('a session past its ceiling still reads: it adds no counted time, but the reader is there', async () => {
  // Eight active hours is reachable in a reference tab left open for weeks, and
  // that tab must not fall out of Recent for good.
  const { store, beat, shared, own } = reader();
  await beat(1200);
  store.get(`docs/d/views/${SESSION}`).ms = MAX_SESSION_MS;
  const [s, o] = [shared(), own()];
  const counted = store.get('docs/d').stats.totalMs;

  await beat(MAX_SESSION_MS + 60_000);
  assert.ok(!same(shared(), s), 'stats.lastViewedAt moved');
  assert.ok(!same(own(), o), 'viewers/{uid}.lastViewedAt moved');
  assert.equal(store.get('docs/d').stats.totalMs, counted, 'and no time past the ceiling was counted');
});

test('a row made by an empty beat still has its time', async () => {
  // Recent orders by this field, so a row without it would never be listed.
  const { store, beat, own } = reader();
  await beat(1200);
  store.delete(ROW);
  await beat(1200);
  assert.ok(own(), 'the new row is stamped');
});
