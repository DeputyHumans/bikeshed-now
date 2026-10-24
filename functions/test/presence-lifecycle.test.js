// SPDX-License-Identifier: Apache-2.0
// Agent write guards aggregate people across sessions and distinguish absent from unavailable RTDB (SPEC §16).

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { liveEditing, editorsRefusal, clearEditLog } = require('../lib/lib/presence.js');
let logs = {}, removed = [], patched = [], reads = [];
let peers = {}, access = {}, failRead = false, unconfigured = false;
Object.defineProperty(admin, 'database', { configurable: true, value: () => {
  if (unconfigured) throw new Error('no database URL configured');
  return { ref: (path) => ({
    limitToFirst() { return this; },
    async remove() { removed.push(path); delete logs[path]; },
    async update(patch) { patched.push({ path, patch }); },
    async once() {
      reads.push(path);
      if (failRead) throw new Error('unavailable');
      return { val: () => path.endsWith('/peers') ? peers : path === 'editAccess/d' ? access : logs[path] ?? null, exists: () => logs[path] != null };
    },
  }) };
} });
test.beforeEach(() => { logs = {}; removed = []; patched = []; reads = []; peers = {}; access = { 'a@example,com': true, 'b@example,com': true }; failRead = false; unconfigured = false; });

test('two editing sessions of one person count once and a reading tab cannot hide them', async () => {
  peers = { a: { uid: 'u', mode: 'edit', email: 'a@example.com' }, b: { uid: 'u', mode: 'view' }, c: { uid: 'u', mode: 'edit', email: 'a@example.com' } };
  assert.deepEqual(await liveEditing('d'), { editors: 1, log: false, liveEpoch: 'initial' });
  assert.equal((await editorsRefusal('d', 'published')).refusal.editors, 1);
  delete peers.a;
  assert.equal((await liveEditing('d')).editors, 1);
  delete peers.c;
  assert.deepEqual(await editorsRefusal('d', 'published'), { log: false, liveEpoch: 'initial' });
});

test('legacy uid-keyed records and new sessions aggregate into the same person', async () => {
  peers = { u: { mode: 'edit', email: 'a@example.com' }, tab: { uid: 'u', mode: 'edit', email: 'a@example.com' }, v: { mode: 'edit', email: 'b@example.com' } };
  assert.equal((await liveEditing('d')).editors, 2);
});

test('missing database configuration remains optional, but a configured database read failure refuses the write', async () => {
  unconfigured = true;
  assert.equal(await liveEditing('d'), null);
  assert.deepEqual(await editorsRefusal('d', 'published'), { log: false, liveEpoch: 'initial' });
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
  assert.deepEqual(await editorsRefusal('d', 'published'), { log: false, liveEpoch: 'initial' });
  access['*'] = true;
  assert.equal((await liveEditing('d')).editors, 2);
});

test('the current epoch alone counts editor vetoes even when old sessions remain', async () => {
  access.__liveEpoch = 'current';
  peers = { old: { uid: 'u', email: 'a@example.com', mode: 'edit' }, fresh: { uid: 'v', email: 'b@example.com', liveEpoch: 'current', mode: 'edit' } };
  assert.deepEqual(await liveEditing('d'), { editors: 1, log: false, liveEpoch: 'current' });
});

test('retirement removes only the captured epoch, retaining every newer log', async () => {
  logs['status/d/y'] = { old: { seed: 'old bytes' }, fresh: { seed: 'new bytes' } };
  await clearEditLog('d', 'old');
  assert.deepEqual(removed, ['status/d/y/old']);
  assert.deepEqual(patched, []);
  assert.deepEqual(reads, []);
});
test('initial retirement captures only legacy flat entries and preserves nested epoch maps', async () => {
  logs['status/d/y'] = { flat: 'legacy bytes', fresh: { seed: 'new bytes' } };
  await clearEditLog('d', 'initial');
  assert.deepEqual(removed, ['status/d/y/initial']);
  assert.deepEqual(patched, [{ path: 'status/d/y', patch: { flat: null } }]);
});
test('log-presence guards inspect the current epoch even if retired bytes remain', async () => {
  access.__liveEpoch = 'fresh';
  logs['status/d/y/old'] = { seed: 'old' };
  assert.deepEqual(await liveEditing('d'), { editors: 0, log: false, liveEpoch: 'fresh' });
  logs['status/d/y/fresh'] = { seed: 'new' };
  assert.deepEqual(await liveEditing('d'), { editors: 0, log: true, liveEpoch: 'fresh' });
  assert.ok(reads.includes('status/d/y/fresh'));
  assert.ok(!reads.includes('status/d/y'));
});
