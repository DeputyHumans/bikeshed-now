// SPDX-License-Identifier: Apache-2.0
// Shared golden behavior keeps operator and Functions retry receipts bounded, independent and expiry-safe (SPEC §9, §17).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as operator from '../scripts/lib/transaction-receipts.mjs';
import { FieldValue as OperatorFieldValue } from '../scripts/lib/firebase.mjs';
const require = createRequire(import.meta.url);
const functions = require('../functions/lib/lib/transaction-receipts.js');
const { fakeFirestore } = require('../functions/test/fakes.js');
const { FieldValue: FunctionsFieldValue } = createRequire(new URL('../functions/package.json', import.meta.url))('firebase-admin/firestore');
const snapshot = data => ({data:()=>data});
for (const [name, helper, FieldValue] of [['operator',operator,OperatorFieldValue],['functions',functions,FunctionsFieldValue]]) {
 test(`${name} receipt has an opaque unique immutable identity`,()=>{
  const one=helper.freshReceiptId(),two=helper.freshReceiptId();
  assert.match(one.id,/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.notEqual(one.id,two.id);assert.ok(Object.isFrozen(one));assert.ok(Math.abs(one.startedAtMs-Date.now())<1000);
 });
 test(`${name} receipt exact five-minute deadline refuses new writes but preserves a recorded result`,()=>{
  const token={id:'mine',startedAtMs:0};
  assert.deepEqual(helper.readReceipt(snapshot({}),token,299_999),{found:false});
  assert.throws(()=>helper.readReceipt(snapshot({}),token,300_000),/too long to confirm/);
  assert.deepEqual(helper.readReceipt(snapshot({transactionReceipts:{mine:{recordedAtMs:1,result:{done:true}}}}),token,900_000),{found:true,result:{done:true}});
  assert.throws(()=>helper.readReceipt(snapshot({transactionReceipts:{other:{recordedAtMs:1,result:{done:true}}}}),token,900_000),/too long to confirm/);
  let writes=0;assert.throws(()=>helper.recordReceipt({set(){writes++;}},{},snapshot({}),token,true,300_000),/too long to confirm/);assert.equal(writes,0);
 });
 test(`${name} receipt prunes at ten minutes, preserves other operations and cleans only its marker`,async()=>{
  const w=fakeFirestore({'docs/d':{keep:'bytes',transactionReceipts:{old:{recordedAtMs:0,result:'old'},recent:{recordedAtMs:1,result:'recent'}}}},{FieldValue});
  const ref=w.db.doc('docs/d'),token={id:'mine',startedAtMs:600_000};
  await w.db.runTransaction(async tx=>helper.recordReceipt(tx,ref,await tx.get(ref),token,{done:true},600_000));
  assert.deepEqual(w.store.get('docs/d'),{keep:'bytes',transactionReceipts:{recent:{recordedAtMs:1,result:'recent'},mine:{recordedAtMs:600_000,result:{done:true}}}});
  await ref.update({'transactionReceipts.later':{recordedAtMs:600_001,result:'later'}});
  await helper.clearReceipt(ref,token);
  assert.deepEqual(w.store.get('docs/d'),{keep:'bytes',transactionReceipts:{recent:{recordedAtMs:1,result:'recent'},later:{recordedAtMs:600_001,result:'later'}}});
 });
 test(`${name} receipt cleanup failure retains durable success`,async()=>{
  const token={id:'mine',startedAtMs:0};
  await assert.doesNotReject(helper.clearReceipt({update:async()=>{throw new Error('unavailable');}},token));
  assert.deepEqual(helper.readReceipt(snapshot({transactionReceipts:{mine:{recordedAtMs:1,result:false}}}),token,999_999),{found:true,result:false});
 });
}
