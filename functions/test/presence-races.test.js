// SPDX-License-Identifier: Apache-2.0
// Older mirror and projection writers cannot restore revoked access (SPEC §16, §17).

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { fakeFirestore, withFakeAdmin } = require('./fakes.js');
const { syncPresenceAccess } = require('../lib/lib/presence.js');
const { syncPublicProjection } = require('../lib/lib/publicdoc.js');
const { persistDocMembership } = require('../lib/lib/folders.js');
const owner = 'owner@example.com';
const revoked = 'revoked@example.com';
const key = (s) => s.replaceAll('.', ',');
const gate = () => { let open; const promise = new Promise((resolve) => { open = resolve; }); return { promise, open }; };
const maps = new Map();
let beforeWrite = async () => {};
const rtdb = { ref: (path) => ({
  transaction: async (update) => {
    await beforeWrite(path);
    const value = update(maps.get(path) ?? null);
    if (value !== undefined) maps.set(path, value);
    return { committed: value !== undefined };
  },
  update: async (changes) => { for (const [p, v] of Object.entries(changes)) { await beforeWrite(p); maps.set(p, v); } },
}) };
// One stable handle, as the runtime caches the SDK handle. Each case resets its data.
Object.defineProperty(admin, 'database', { configurable: true, value: () => rtdb });
const doc = { ownerEmail: owner, members: [owner, revoked], editorMembers: [owner, revoked], viewers: [], editors: [revoked], suggesters: [], approvers: [], visibility: 'private' };
const keys = (path) => Object.keys(maps.get(path) ?? {}).filter((k) => !['__revision', '__expiresAt', '__owner'].includes(k)).sort();

test('mirror reads current membership rather than a stale visibility request snapshot', async () => {
  maps.clear(); beforeWrite = async () => {};
  const { db } = fakeFirestore({ 'docs/d': { ...doc, members: [owner], editorMembers: [owner] } });
  await withFakeAdmin({ db }, () => syncPresenceAccess('d', doc.members, doc.editorMembers, true));
  assert.deepEqual(keys('editAccess/d'), [key(owner)]);
  assert.deepEqual(keys('presenceAccess/d'), [key(owner)]);
  assert.match(maps.get('editAccess/d').__revision, /^\d{12}:\d{9}$/);
});

test('an older in-flight mirror cannot reopen a completed revocation', async () => {
  maps.clear();
  const entered = gate(), resume = gate();
  let held = false;
  beforeWrite = async () => { if (!held) { held = true; entered.open(); await resume.promise; } };
  const { db } = fakeFirestore({ 'docs/d': doc });
  await withFakeAdmin({ db }, async () => {
    const old = syncPresenceAccess('d', doc.members, doc.editorMembers);
    await entered.promise;
    await db.doc('docs/d').update({ members: [owner], editorMembers: [owner], editors: [] });
    await syncPresenceAccess('d', [owner], [owner]);
    assert.deepEqual(keys('editAccess/d'), [key(owner)]);
    resume.open(); await old;
    assert.deepEqual(keys('editAccess/d'), [key(owner)]);
    assert.deepEqual(keys('presenceAccess/d'), [key(owner)]);
  });
  beforeWrite = async () => {};
});

test('mirror accepts a legacy node and opens editing only for a public document', async () => {
  maps.clear(); beforeWrite = async () => {};
  maps.set('editAccess/d', { [key(revoked)]: true });
  const { db } = fakeFirestore({ 'docs/d': { ...doc, visibility: 'public', publicEdit: true } });
  await withFakeAdmin({ db }, async () => {
    await syncPresenceAccess('d', [], []);
    assert.deepEqual(keys('editAccess/d'), ['*', key(owner), key(revoked)]);
    await db.doc('docs/d').update({ visibility: 'unlisted' });
    await syncPresenceAccess('d', doc.members, doc.editorMembers, true);
    assert.deepEqual(keys('editAccess/d'), [key(owner), key(revoked)]);
  });
});

/** Hold one actual snapshot, then let a later writer finish before its transaction retries. */
function holdRead(db, path) {
  const entered = gate(), resume = gate();
  let held = false;
  const pause = async (ref, snap) => {
    if (!held && ref.path === path) { held = true; entered.open(); await resume.promise; }
    return snap;
  };
  const wrapRef = (ref) => ({ ...ref, get: async () => pause(ref, await ref.get()) });
  const collection = db.collection.bind(db);
  db.collection = (name) => {
    const value = collection(name);
    return { ...value, doc: (id) => wrapRef(value.doc(id)) };
  };
  const document = db.doc.bind(db);
  db.doc = (id) => wrapRef(document(id));
  const original = db.runTransaction.bind(db);
  db.runTransaction = (fn, opts) => original(async (tx) => {
    const get = tx.get.bind(tx);
    tx.get = async (ref) => pause(ref, await get(ref));
    return fn(tx);
  }, opts);
  return { entered, resume };
}

test('a public projection writer retries instead of restoring a private document', async () => {
  const { db, store } = fakeFirestore({ 'docs/d': { ...doc, visibility: 'public' } });
  const { entered, resume } = holdRead(db, 'docs/d');
  const old = syncPublicProjection(db, 'd');
  await entered.promise;
  await db.doc('docs/d').update({ visibility: 'private' });
  await syncPublicProjection(db, 'd');
  assert.equal(store.has('public/d'), false);
  resume.open(); await old;
  assert.equal(store.has('public/d'), false);
});

test('membership recomputation retries when a referenced team loses a member', async () => {
  maps.clear(); beforeWrite = async () => {};
  const { db, store } = fakeFirestore({
    'docs/d': { ...doc, editors: ['team:t'] },
    'teams/t': { members: [owner, revoked] },
  });
  const { entered, resume } = holdRead(db, 'teams/t');
  await withFakeAdmin({ db }, async () => {
    const old = persistDocMembership(db, db.doc('docs/d'));
    await entered.promise;
    await db.doc('teams/t').update({ members: [owner] });
    await persistDocMembership(db, db.doc('docs/d'));
    resume.open(); await old;
  });
  assert.deepEqual(store.get('docs/d').members, [owner]);
  assert.deepEqual(keys('editAccess/d'), [key(owner)]);
});

for (const dependency of ['parent', 'grants']) {
  test(`membership recomputation retries when current ${dependency} changes`, async () => {
    maps.clear(); beforeWrite = async () => {};
    const { db, store } = fakeFirestore({
      'docs/d': { ...doc, folderId: 'f', editors: [], members: [owner, revoked] },
      'folders/f': { members: [owner, revoked], editorMembers: [owner, revoked] },
    });
    const { entered, resume } = holdRead(db, dependency === 'parent' ? 'folders/f' : 'docs/d');
    await withFakeAdmin({ db }, async () => {
      const old = persistDocMembership(db, db.doc('docs/d'));
      await entered.promise;
      if (dependency === 'parent') await db.doc('folders/f').update({ members: [owner], editorMembers: [owner] });
      else await db.doc('docs/d').update({ viewers: ['new@example.com'] });
      await persistDocMembership(db, db.doc('docs/d'));
      resume.open(); await old;
    });
    assert.deepEqual(store.get('docs/d').members, dependency === 'parent' ? [owner] : ['new@example.com', owner, revoked]);
  });
}

test('operator mirror twin reads current data and rejects an older writer', async () => {
  maps.clear();
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const source = readFileSync(join(__dirname, '../../scripts/lib/presence.mjs'), 'utf8')
    .replace(/import \{[^}]+\} from "\.\/firebase\.mjs";/, '')
    .replaceAll('export ', '');
  const { db } = fakeFirestore({ 'docs/d': { ...doc, visibility: 'public', publicEdit: true } });
  const sync = new Function('getDb', 'getRtdb', `${source}\nreturn syncPresenceAccess;`)(() => db, () => rtdb);
  const entered = gate(), resume = gate();
  let held = false;
  beforeWrite = async () => { if (!held) { held = true; entered.open(); await resume.promise; } };
  const old = sync('d', [], []);
  await entered.promise;
  await db.doc('docs/d').update({ members: [owner], editorMembers: [owner], visibility: 'unlisted' });
  await sync('d', doc.members, doc.editorMembers);
  assert.deepEqual(keys('editAccess/d'), [key(owner)]);
  resume.open(); await old;
  assert.deepEqual(keys('editAccess/d'), [key(owner)]);
  assert.deepEqual(keys('presenceAccess/d'), [key(owner)]);
  assert.match(maps.get('editAccess/d').__revision, /^\d{12}:\d{9}$/);
  beforeWrite = async () => {};
  await db.doc('docs/d').update({ visibility: 'public' });
  await sync('d', [], []);
  assert.deepEqual(keys('editAccess/d'), ['*', key(owner)]);
});

for (const runtime of ['functions', 'operator']) test(`${runtime} mirror carries current expiry and owner through expiry changes`, async () => {
  maps.clear(); beforeWrite = async () => {};
  const { Timestamp } = require('firebase-admin/firestore');
  const expiry = Date.now() + 60000;
  const { db } = fakeFirestore({ 'docs/d': { ...doc, expiresAt: Timestamp.fromMillis(expiry) } });
  let sync = () => syncPresenceAccess('d', [], []);
  if (runtime === 'operator') {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../scripts/lib/presence.mjs'), 'utf8')
      .replace(/import \{[^}]+\} from "\.\/firebase\.mjs";/, '').replaceAll('export ', '');
    const operator = new Function('getDb', 'getRtdb', `${source}\nreturn syncPresenceAccess;`)(() => db, () => rtdb);
    sync = () => operator('d', [], []);
  }
  await withFakeAdmin({ db }, async () => {
    await sync();
    for (const path of ['presenceAccess/d', 'editAccess/d']) {
      assert.equal(maps.get(path).__expiresAt, expiry);
      assert.equal(maps.get(path).__owner, owner);
    }
    await db.doc('docs/d').update({ expiresAt: null });
    await sync();
    assert.equal(maps.get('editAccess/d').__expiresAt, 0, 'clearing expiry restores a deadline-free mirror');
  });
});
