// SPDX-License-Identifier: Apache-2.0
// Content commits recheck expiry, current access, and a revocable link grant (SPEC §8, §17).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');
const { fakeFirestore } = require('./fakes.js');
const { assertWriteAuthority, WriteAuthorityError } = require('../lib/lib/writeAuthority.js');
const caller = { uid: 'u-editor', emailLower: 'editor@example.com' };
const base = { ownerEmail: 'owner@example.com', editorMembers: [caller.emailLower], visibility: 'private' };
async function write(db, options) {
  return db.runTransaction(async (tx) => {
    const ref = db.doc('docs/d');
    const data = (await tx.get(ref)).data();
    await assertWriteAuthority(tx, ref, data, caller, options);
    tx.update(ref, { written: true });
  });
}

test('expired editor and owner commits are distinct 409 expiry refusals without writes', async () => {
  for (const ownerEmail of [base.ownerEmail, caller.emailLower]) {
    const { db, store } = fakeFirestore({ 'docs/d': { ...base, ownerEmail, expiresAt: Timestamp.fromMillis(Date.now() - 1) } });
    await assert.rejects(write(db), (e) => e instanceof WriteAuthorityError && e.status === 409 && e.detail.expired === true && !('currentVersion' in e.detail));
    assert.equal(store.get('docs/d').written, undefined);
  }
});

test('a revoked editor cannot commit but a current editor and public open editor can', async () => {
  for (const patch of [{}, { editorMembers: [], visibility: 'public', publicEdit: true }]) {
    const { db, store } = fakeFirestore({ 'docs/d': { ...base, ...patch } });
    await write(db); assert.equal(store.get('docs/d').written, true);
  }
  const { db, store } = fakeFirestore({ 'docs/d': { ...base, editorMembers: [] } });
  await assert.rejects(write(db), (e) => e instanceof WriteAuthorityError && e.status === 403);
  assert.equal(store.get('docs/d').written, undefined);
});

test('an unlisted open editor needs the current stored link grant', async () => {
  for (const token of ['current-link-token-long-enough', 'rotated-link-token-long-enough', null]) {
    const { db, store } = fakeFirestore({ 'docs/d': { ...base, editorMembers: [], visibility: 'unlisted', publicEdit: true, linkToken: 'current-link-token-long-enough' }, ...(token ? { 'docs/d/linkGrants/u-editor': { token } } : {}) });
    if (token === 'current-link-token-long-enough') await write(db);
    else await assert.rejects(write(db), (e) => e.status === 403);
    assert.equal(store.get('docs/d').written, token === 'current-link-token-long-enough' ? true : undefined);
  }
});

test('deleting the link grant during a transaction retries and refuses the commit', async () => {
  const { db, store } = fakeFirestore({ 'docs/d': { ...base, editorMembers: [], visibility: 'unlisted', publicEdit: true, linkToken: 'current-link-token-long-enough' }, 'docs/d/linkGrants/u-editor': { token: 'current-link-token-long-enough' } });
  const original = db.runTransaction.bind(db);
  let removed = false;
  db.runTransaction = (fn) => original(async (tx) => {
    const get = tx.get.bind(tx);
    tx.get = async (ref) => {
      const snap = await get(ref);
      if (!removed && ref.path.includes('/linkGrants/')) {
        removed = true;
        await db.doc(ref.path).delete();
      }
      return snap;
    };
    return fn(tx);
  });
  await assert.rejects(write(db), (e) => e.status === 403);
  assert.equal(store.get('docs/d').written, undefined);
});

test('an unlisted nonmember without an Auth uid is refused without a malformed grant read', async () => {
  const { db } = fakeFirestore();
  await assert.rejects(assertWriteAuthority({ get: async () => { throw new Error('must not read an empty uid'); } }, db.doc('docs/d'), { visibility: 'unlisted', publicEdit: true }, { uid: '', emailLower: 'operator@example.com' }), (e) => e.status === 403);
});

test('a presented key is checked against the current token without requiring a remembered grant', async () => {
  for (const k of ['current-link-token-long-enough', 'rotated-link-token-long-enough', undefined]) {
    const { db, store } = fakeFirestore({ 'docs/d': { ...base, editorMembers: [], visibility: 'unlisted', publicEdit: true, linkToken: 'current-link-token-long-enough' } });
    if (k === 'current-link-token-long-enough') await write(db, { k });
    else await assert.rejects(write(db, { k }), (e) => e.status === 403);
    assert.equal(store.get('docs/d').written, k === 'current-link-token-long-enough' ? true : undefined);
    assert.equal(store.has('docs/d/linkGrants/u-editor'), false);
  }
});

test('bundle replacement authority cannot fall back to public open editing', async () => {
  const { db, store } = fakeFirestore({ 'docs/d': { ...base, editorMembers: [], visibility: 'public', publicEdit: true } });
  await assert.rejects(write(db, { editorsOnly: true }), (e) => e.status === 403);
  assert.equal(store.get('docs/d').written, undefined);
});

test('a presented key rotated before a transaction retry refuses the eventual write', async () => {
  const { db, store } = fakeFirestore({ 'docs/d': { ...base, editorMembers: [], visibility: 'unlisted', publicEdit: true, linkToken: 'current-link-token-long-enough' } });
  const original = db.runTransaction.bind(db); let rotated = false;
  db.runTransaction = (fn) => original(async (tx) => {
    const result = await fn(tx);
    if (!rotated) { rotated = true; await db.doc('docs/d').update({ linkToken: 'next-link-token-long-enough' }); }
    return result;
  });
  await assert.rejects(write(db, { k: 'current-link-token-long-enough' }), (e) => e.status === 403);
  assert.equal(store.get('docs/d').written, undefined);
});
