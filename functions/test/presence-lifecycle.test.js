// SPDX-License-Identifier: Apache-2.0
// Agent write guards aggregate people across sessions and distinguish absent from unavailable RTDB (SPEC §16).

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { liveEditing, editorsRefusal } = require('../lib/lib/presence.js');
let peers = {}, access = {}, failRead = false, unconfigured = false;
Object.defineProperty(admin, 'database', { configurable: true, value: () => {
  if (unconfigured) throw new Error('no database URL configured');
  return { ref: (path) => ({
    limitToFirst() { return this; },
    async once() {
      if (failRead) throw new Error('unavailable');
      return { val: () => path.endsWith('/peers') ? peers : path === 'editAccess/d' ? access : null, exists: () => false };
    },
  }) };
} });
test.beforeEach(() => { peers = {}; access = { 'a@example,com': true, 'b@example,com': true }; failRead = false; unconfigured = false; });

test('two editing sessions of one person count once and a reading tab cannot hide them', async () => {
  peers = { a: { uid: 'u', mode: 'edit', email: 'a@example.com' }, b: { uid: 'u', mode: 'view' }, c: { uid: 'u', mode: 'edit', email: 'a@example.com' } };
  assert.deepEqual(await liveEditing('d'), { editors: 1, log: false });
  assert.equal((await editorsRefusal('d', 'published')).refusal.editors, 1);
  delete peers.a;
  assert.equal((await liveEditing('d')).editors, 1);
  delete peers.c;
  assert.deepEqual(await editorsRefusal('d', 'published'), { log: false });
});

test('legacy uid-keyed records and new sessions aggregate into the same person', async () => {
  peers = { u: { mode: 'edit', email: 'a@example.com' }, tab: { uid: 'u', mode: 'edit', email: 'a@example.com' }, v: { mode: 'edit', email: 'b@example.com' } };
  assert.equal((await liveEditing('d')).editors, 2);
});

test('missing database configuration remains optional, but a configured database read failure refuses the write', async () => {
  unconfigured = true;
  assert.equal(await liveEditing('d'), null);
  assert.deepEqual(await editorsRefusal('d', 'published'), { log: false });
  unconfigured = false; failRead = true;
  const result = await editorsRefusal('d', 'published');
  assert.equal(result.refusal.status, 409);
  assert.match(result.refusal.error, /Could not tell whether anybody is editing/);
});

test('a downgrade withdraws the veto from every session, while another current editor still blocks', async () => {
  peers = { a: { uid: 'u', email: 'a@example.com', mode: 'edit' }, b: { uid: 'u', email: 'a@example.com', mode: 'edit' }, c: { uid: 'v', email: 'b@example.com', mode: 'edit' } };
  delete access['a@example,com'];
  assert.equal((await liveEditing('d')).editors, 1);
  delete access['b@example,com'];
  assert.deepEqual(await editorsRefusal('d', 'published'), { log: false });
  access['*'] = true;
  assert.equal((await liveEditing('d')).editors, 2);
});
