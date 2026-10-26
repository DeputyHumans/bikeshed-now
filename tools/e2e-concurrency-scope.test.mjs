// SPDX-License-Identifier: Apache-2.0
// Keep the explicit ten-participant release boundary distinct from historical twenty-participant coverage (SPEC §12).
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {concurrencyNs,inConcurrencyScope,deferredConcurrencyItems} from './e2e-concurrency-scope.mjs';
const c=JSON.parse(readFileSync(new URL('../e2e/campaign.json',import.meta.url)));
test('default keeps historical coverage; explicit scope retains two, five and ten only',()=>{
 assert.deepEqual(concurrencyNs({acceptance:{}}),[2,5,10,20]);
 assert.deepEqual(concurrencyNs(c),[2,5,10]);
 for(const n of [null,2,5,10])assert.equal(inConcurrencyScope(c,{n}),true);
 assert.equal(inConcurrencyScope(c,{n:20}),false);
});
test('unknown, lower or undocumented scope is rejected',()=>{
 for(const change of [{maxParticipants:5},{authorization:'implicit'},{reason:''}]){
  const other=structuredClone(c);Object.assign(other.acceptance.concurrencyScope,change);
  assert.throws(()=>concurrencyNs(other),/unreviewed concurrency scope/);
 }
});

test('only the historical twenty-participant emulator finding is deferred; lower counts and product defects cannot be hidden',()=>{
 assert.deepEqual(deferredConcurrencyItems(c),['W2-c18-N20-firestore-oom']);
 for(const mutate of [i=>i.classification='product',i=>i.requiredCases[0].n=10,i=>i.requiredCases=[]]){
  const bad=structuredClone(c);mutate(bad.items.find(i=>i.id==='W2-c18-N20-firestore-oom'));
  assert.throws(()=>deferredConcurrencyItems(bad),/only the original twenty-participant/);
 }
});
