// SPDX-License-Identifier: Apache-2.0
// Inherited grants traverse nearest to farthest while paths retain root-first ancestry (SPEC §13).

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeFirestore } = require('./fakes.js');
const { inheritedGrants } = require('../lib/lib/audience.js');
const caller = { uid: 'owner', emailLower: 'owner@example.com' };

test('three-level inheritance lists the leaf, middle, root, highest role first within each', async () => {
  const folders = {};
  for (const [id, ancestors, name] of [['root', [], 'Root'], ['middle', ['root'], 'Middle'], ['leaf', ['root', 'middle'], 'Leaf']]) {
    folders[`folders/${id}`] = { name, ancestors, ownerUid: caller.uid, ownerEmail: caller.emailLower, members: [caller.emailLower], viewers: [`${id}-view@example.com`], approvers: [`${id}-approve@example.com`] };
  }
  const { db } = fakeFirestore(folders);
  const got = await inheritedGrants(db, caller, 'leaf');
  assert.deepEqual(got.map((g) => [g.folderId, g.path, g.principal, g.role]), [
    ['leaf','Root/Middle/Leaf','leaf-approve@example.com','approver'], ['leaf','Root/Middle/Leaf','leaf-view@example.com','viewer'],
    ['middle','Root/Middle','middle-approve@example.com','approver'], ['middle','Root/Middle','middle-view@example.com','viewer'],
    ['root','Root','root-approve@example.com','approver'], ['root','Root','root-view@example.com','viewer'],
  ]);
});
