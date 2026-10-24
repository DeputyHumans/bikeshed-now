// SPDX-License-Identifier: Apache-2.0
// Operator grant retries acknowledge their original result without undoing a later membership change (SPEC §13).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { persistOperatorAccess } from '../scripts/lib/operator-writes.mjs';
const require = createRequire(import.meta.url);
const { fakeFirestore: createFakeFirestore } = require('../functions/test/fakes.js');
import { FieldValue } from '../scripts/lib/firebase.mjs';
const fakeFirestore = data => createFakeFirestore(data, { FieldValue });
const { loseFirstTransactionAcknowledgement } = require('../functions/test/transaction-ack.js');
const owner = 'owner@example.com', reader = 'reader@example.com';
const base = { ownerEmail: owner, viewers: [], editors: [], suggesters: [], approvers: [], members: [owner], editorMembers: [owner] };
for (const granting of [false, true]) test(`operator access retry preserves the later opposite delta, original grant=${granting}`, async () => {
  const {db,store}=fakeFirestore({'docs/d': granting ? base : {...base,viewers:[reader],members:[owner,reader]}});
  const change = add => ({add:add?[reader]:[],remove:add?[]:[reader],role:'viewer'});
  const count = loseFirstTransactionAcknowledgement(db,{afterCommit:async()=>{await persistOperatorAccess(db,db.doc('docs/d'),change(!granting),null);}});
  const result = await persistOperatorAccess(db,db.doc('docs/d'),change(granting),null);
  assert.ok(count().callbackCalls >= 3);
  assert.deepEqual(store.get('docs/d').viewers,granting?[]:[reader],'ACK operator access: original retry preserves the later opposite grant');
  assert.deepEqual(result.grants.viewers,granting?[reader]:[],'ACK operator access: original result remains the committed result');
  assert.deepEqual(Object.keys(store.get('docs/d').transactionReceipts??{}),[],'ACK operator access: successful operations remove only their own receipts');
});
test('operator list leaves document and outstanding receipt metadata untouched',async()=>{
 const current={...base,transactionReceipts:{other:{recordedAtMs:1,result:{other:true}}}};
 const {db,store}=fakeFirestore({'docs/d':current});
 await persistOperatorAccess(db,db.doc('docs/d'),{add:[],remove:[],role:'viewer'},null);
 assert.deepEqual(store.get('docs/d'),current);
});
