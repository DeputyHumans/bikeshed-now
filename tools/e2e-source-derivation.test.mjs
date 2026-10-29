// SPDX-License-Identifier: Apache-2.0
// Reject arbitrary source substitutions and retain exact identities when reviewing a diagnostics-only harness derivative (SPEC §12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MINT_DISPATCH_KIND, MINT_DISPATCH_DELTA, DURABLE_RESPONSE_DELTA, DURABLE_RESPONSE_KIND, CONTROLLED_READER_RESPONSE_DELTA, CONTROLLED_READER_RESPONSE_KIND, DONE_RETRY_DELTA, DONE_RETRY_KIND, DRAFT_ADMISSION_DELTA, DRAFT_ADMISSION_KIND, acceptedSourceFiles, reviewedSpecChange, FIRESTORE_BARRIER_DELTA, FIRESTORE_BARRIER_KIND, CONTROLLED_READER_BARRIER_KIND, FIRESTORE_CHANNEL_DELTA, FIRESTORE_CHANNEL_KIND, CONTROLLED_READER_CHANNEL_KIND, FIRESTORE_MAINTENANCE_DELTA as delta, CONTROLLED_READER_DELTA, CONTROLLED_READER_KIND, manifestFingerprint, verifySourceDerivation, assertAcceptedSource } from './e2e-source-derivation.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const KIND = 'firestore-diagnostic-recycle-v1';
function manifest(rows) {
 const files = rows.map(([path, sha256]) => ({path, sha256})).sort((a,b) => a.path < b.path ? -1 : 1);
 return {snapshot:{revision:'a'.repeat(40),version:'0.20.4',files:files.length,fingerprint:hash(files.map(r=>`${r.path}\0${r.sha256}\n`).join(''))},files};
}
function fixture() {
 const product = [['app/src/DocViewer.tsx',hash('unchanged product')],['package-lock.json',hash('unchanged dependencies')]];
 const baseline=manifest([...product,...delta.filter(r=>r[1]!==null).map(r=>[r[0],r[1]])]);
 const candidate=manifest([...product,...delta.filter(r=>r[2]!==null).map(r=>[r[0],r[2]])]);
 return {baseline,candidate,acceptance:baseline.snapshot,actual:candidate.snapshot};
}
test('exact reviewed diagnostics delta preserves the actual derivative fingerprint',()=>{
 const f=fixture(), before=structuredClone(f);
 assert.equal(verifySourceDerivation(f.acceptance,f.actual,f.baseline,f.candidate,KIND).kind,KIND);
 assert.deepEqual(f,before);
 assert.notEqual(f.actual.fingerprint,f.acceptance.fingerprint);
});
test('negative: product, dependency, assertion, trial and arbitrary harness changes cannot borrow old evidence',()=>{
 for(const path of ['app/src/DocViewer.tsx','package-lock.json','e2e/lib/test.mjs','e2e/lib/budget.mjs','e2e/specs/concurrency/c01-typing.spec.mjs','e2e/lib/other.mjs']) {
  const f=fixture(), rows=f.candidate.files.filter(r=>r.path!==path).map(r=>[r.path,r.sha256]);
  const candidate=manifest([...rows,[path,hash('unreviewed bytes')]]);
  assert.throws(()=>verifySourceDerivation(f.acceptance,candidate.snapshot,f.baseline,candidate,KIND),/reviewed diagnostics-only delta/,path);
 }
});
test('negative: removed files, wrong baseline, kind, version, revision and fingerprint are rejected',()=>{
 const f=fixture();
 for(const field of ['revision','version','fingerprint'])assert.throws(()=>verifySourceDerivation({...f.acceptance,[field]:'wrong'},f.actual,f.baseline,f.candidate,KIND),/differs/);
 assert.throws(()=>verifySourceDerivation(f.acceptance,f.actual,f.baseline,f.candidate,'arbitrary'),/unreviewed/);
 const candidate=manifest(f.candidate.files.filter(r=>r.path!=='package-lock.json').map(r=>[r.path,r.sha256]));
 assert.throws(()=>verifySourceDerivation(f.acceptance,candidate.snapshot,f.baseline,candidate,KIND),/reviewed diagnostics-only delta/);
 assert.throws(()=>verifySourceDerivation(f.acceptance,{...f.actual,fingerprint:'0'.repeat(64)},f.baseline,f.candidate,KIND),/candidate fingerprint/);
 for(const field of ['revision','version']){
  const changed=structuredClone(f.candidate);changed.snapshot[field]='other';
  assert.throws(()=>verifySourceDerivation(f.acceptance,changed.snapshot,f.baseline,changed,KIND),/derivative .* differs/);
 }
});
test('negative: incomplete, duplicate, unsorted, escaped or falsified source inventories fail',()=>{
 const f=fixture();
 for(const mutate of [m=>m.files.pop(),m=>m.files.push(m.files[0]),m=>m.files.reverse(),m=>m.files[0].path='../escape',m=>m.files[0].sha256='bad',m=>m.snapshot.files++,m=>m.snapshot.fingerprint='0'.repeat(64)]){
  const m=structuredClone(f.candidate);mutate(m);assert.throws(()=>manifestFingerprint(m));
 }
});
test('malformed inventories cannot become valid by recomputing their digest',()=>{
 const f=fixture();
 for(const mutate of [m=>m.files=[],m=>m.files.push(m.files[0]),m=>m.files.reverse(),m=>m.files[0].path='../escape',m=>m.files[0].sha256='bad']){
  const m=structuredClone(f.candidate);mutate(m);m.snapshot.files=m.files.length;m.snapshot.fingerprint=hash(m.files.map(r=>`${r.path}\0${r.sha256}\n`).join(''));
  assert.throws(()=>manifestFingerprint(m));
 }
});

test('derivative references require unique reviewed fingerprint, exact manifests and contained regular files',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'source-derivation-')));mkdirSync(join(root,'e2e/.out'),{recursive:true});
 try {
  const f=fixture(), bind=(name,value)=>{const artifact=`e2e/.out/${name}.json`,bytes=JSON.stringify(value);writeFileSync(join(root,artifact),bytes);return {artifact,sha256:hash(bytes)};};
  const entry={kind:KIND,fingerprint:f.actual.fingerprint,baseline:bind('baseline',f.baseline),candidate:bind('candidate',f.candidate)};
  const campaign={acceptance:{...f.acceptance,sourceDerivations:[entry]}};
  assert.equal(assertAcceptedSource(campaign,f.actual,{root}).kind,KIND);
  assert.equal(assertAcceptedSource(campaign,f.acceptance,{root}),null);
  symlinkSync(join(root,entry.candidate.artifact),join(root,'e2e/.out/link.json'));
  const linked=structuredClone(entry);linked.candidate.artifact='e2e/.out/link.json';
  assert.throws(()=>assertAcceptedSource({acceptance:{...f.acceptance,sourceDerivations:[linked]}},f.actual,{root}),/regular contained/);
  for(const entries of [[],[entry,entry]]) assert.throws(()=>assertAcceptedSource({acceptance:{...f.acceptance,sourceDerivations:entries}},f.actual,{root}),/unique reviewed/);
  for(const mutate of [e=>e.candidate.sha256='0'.repeat(64),e=>e.candidate.artifact='../outside',e=>e.kind='unreviewed']){
   const bad=structuredClone(entry);mutate(bad);assert.throws(()=>assertAcceptedSource({acceptance:{...f.acceptance,sourceDerivations:[bad]}},f.actual,{root}));
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});


test('controlled reader scheduling is explicitly labelled and cannot masquerade as diagnostics-only source',()=>{
 const f=fixture(), [path,before,after]=CONTROLLED_READER_DELTA;
 const baseline=manifest([...f.baseline.files.map(r=>[r.path,r.sha256]),[path,before]]);
 const candidate=manifest([...f.candidate.files.map(r=>[r.path,r.sha256]),[path,after]]);
 const result=verifySourceDerivation(baseline.snapshot,candidate.snapshot,baseline,candidate,CONTROLLED_READER_KIND);
 assert.equal(result.controlled,true);assert.equal(result.kind,CONTROLLED_READER_KIND);
 assert.throws(()=>verifySourceDerivation(baseline.snapshot,candidate.snapshot,baseline,candidate,KIND),/reviewed diagnostics-only delta/);
 const altered=manifest(candidate.files.map(r=>[r.path,r.path===path?hash('weakened assertion'):r.sha256]));
 assert.throws(()=>verifySourceDerivation(baseline.snapshot,altered.snapshot,baseline,altered,CONTROLLED_READER_KIND),/reviewed diagnostics-only delta/);
});


test('idle channel cleanup v2 preserves v1 evidence and requires its own exact source profile',()=>{
 for(const controlled of [false,true]) {
  const changes=[...FIRESTORE_CHANNEL_DELTA,...(controlled?[CONTROLLED_READER_DELTA]:[])];
  const baseline=manifest(changes.filter(r=>r[1]!==null).map(r=>[r[0],r[1]]));
  const candidate=manifest(changes.map(r=>[r[0],r[2]]));
  const kind=controlled?CONTROLLED_READER_CHANNEL_KIND:FIRESTORE_CHANNEL_KIND;
  const result=verifySourceDerivation(baseline.snapshot,candidate.snapshot,baseline,candidate,kind);
  assert.equal(result.controlled,controlled); assert.equal(result.kind,kind);
  assert.throws(()=>verifySourceDerivation(baseline.snapshot,candidate.snapshot,baseline,candidate,controlled?CONTROLLED_READER_KIND:KIND),/reviewed diagnostics-only delta/);
  for(const [path] of changes){
   const altered=manifest(candidate.files.map(r=>[r.path,r.path===path?hash('unreviewed bytes'):r.sha256]));
   assert.throws(()=>verifySourceDerivation(baseline.snapshot,altered.snapshot,baseline,altered,kind),/reviewed diagnostics-only delta/,path);
  }
 }
 const f=fixture();assert.equal(verifySourceDerivation(f.acceptance,f.actual,f.baseline,f.candidate,KIND).controlled,false);
});

test('idle removal barrier v3 preserves earlier evidence and requires its own exact source profile',()=>{
 for(const controlled of [false,true]) {
  const changes=[...FIRESTORE_BARRIER_DELTA,...(controlled?[CONTROLLED_READER_DELTA]:[])];
  const baseline=manifest(changes.filter(r=>r[1]!==null).map(r=>[r[0],r[1]]));
  const candidate=manifest(changes.map(r=>[r[0],r[2]]));
  const kind=controlled?CONTROLLED_READER_BARRIER_KIND:FIRESTORE_BARRIER_KIND;
  const result=verifySourceDerivation(baseline.snapshot,candidate.snapshot,baseline,candidate,kind);
  assert.equal(result.controlled,controlled); assert.equal(result.kind,kind);
  assert.throws(()=>verifySourceDerivation(baseline.snapshot,candidate.snapshot,baseline,candidate,controlled?CONTROLLED_READER_CHANNEL_KIND:FIRESTORE_CHANNEL_KIND),/reviewed diagnostics-only delta/);
  for(const [path] of changes){
   const altered=manifest(candidate.files.map(r=>[r.path,r.path===path?hash('unreviewed bytes'):r.sha256]));
   assert.throws(()=>verifySourceDerivation(baseline.snapshot,altered.snapshot,baseline,altered,kind),/reviewed diagnostics-only delta/,path);
  }
 }
 const f=fixture();assert.equal(verifySourceDerivation(f.acceptance,f.actual,f.baseline,f.candidate,KIND).controlled,false);
});


test('draft admission recovery requires its exact reviewed bytes and is not controlled timing', () => {
 const baseline=manifest(DRAFT_ADMISSION_DELTA.filter(r=>r[1]!==null).map(r=>[r[0],r[1]]));
 const candidate=manifest(DRAFT_ADMISSION_DELTA.map(r=>[r[0],r[2]]));
 const result=verifySourceDerivation(baseline.snapshot,candidate.snapshot,baseline,candidate,DRAFT_ADMISSION_KIND);
 assert.equal(result.controlled,false);assert.equal(result.kind,DRAFT_ADMISSION_KIND);
 assert.throws(()=>verifySourceDerivation(baseline.snapshot,candidate.snapshot,baseline,candidate,FIRESTORE_BARRIER_KIND),/reviewed diagnostics-only delta/);
 for(const [path] of DRAFT_ADMISSION_DELTA){
  const altered=manifest(candidate.files.map(r=>[r.path,r.path===path?hash('unreviewed bytes'):r.sha256]));
  assert.throws(()=>verifySourceDerivation(baseline.snapshot,altered.snapshot,baseline,altered,DRAFT_ADMISSION_KIND),/reviewed diagnostics-only delta/,path);
 }
});

test('baseline inventory references cannot substitute a different well-formed manifest', () => {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'source-inventory-')));mkdirSync(join(root,'e2e/.out'),{recursive:true});
 try {
  const f=fixture(),bind=(name,value)=>{const artifact=`e2e/.out/${name}.json`,bytes=JSON.stringify(value);writeFileSync(join(root,artifact),bytes);return {artifact,sha256:hash(bytes)};};
  const entry={kind:KIND,fingerprint:f.actual.fingerprint,baseline:bind('baseline',f.baseline),candidate:bind('candidate',f.candidate)};
  const campaign={acceptance:{...f.acceptance,sourceDerivations:[entry]}};
  assert.deepEqual([...acceptedSourceFiles(campaign,f.acceptance,{root})],f.baseline.files.map(r=>[r.path,r.sha256]));
  assert.deepEqual([...acceptedSourceFiles(campaign,f.actual,{root})],f.candidate.files.map(r=>[r.path,r.sha256]));
  entry.baseline=entry.candidate;
  assert.throws(()=>acceptedSourceFiles(campaign,f.acceptance,{root}),/source inventory fingerprint differs/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('delayed Done retry cannot admit any other source change or rewrite previous evidence', () => {
 const baseline=manifest(DONE_RETRY_DELTA.filter(r=>r[1]!==null).map(r=>[r[0],r[1]]));
 const candidate=manifest(DONE_RETRY_DELTA.map(r=>[r[0],r[2]]));
 assert.equal(verifySourceDerivation(baseline.snapshot,candidate.snapshot,baseline,candidate,DONE_RETRY_KIND).controlled,false);
 assert.throws(()=>verifySourceDerivation(baseline.snapshot,candidate.snapshot,baseline,candidate,DRAFT_ADMISSION_KIND),/reviewed diagnostics-only delta/);
 for(const [path] of DONE_RETRY_DELTA){
  const altered=manifest(candidate.files.map(r=>[r.path,r.path===path?hash('unreviewed bytes'):r.sha256]));
  assert.throws(()=>verifySourceDerivation(baseline.snapshot,altered.snapshot,baseline,altered,DONE_RETRY_KIND),/reviewed diagnostics-only delta/,path);
 }
});

for (const controlled of [false, true]) test(`durable response inspection preserves exact source boundaries and controlled classification (${controlled})`, () => {
 const kind = controlled ? CONTROLLED_READER_RESPONSE_KIND : DURABLE_RESPONSE_KIND;
 const changes = [...(controlled ? CONTROLLED_READER_RESPONSE_DELTA : DURABLE_RESPONSE_DELTA), ...(controlled ? [CONTROLLED_READER_DELTA] : [])];
 const baseline = manifest(changes.filter(r => r[1] !== null).map(r => [r[0], r[1]]));
 const candidate = manifest(changes.map(r => [r[0], r[2]]));
 assert.equal(verifySourceDerivation(baseline.snapshot, candidate.snapshot, baseline, candidate, kind).controlled, controlled);
 assert.throws(() => verifySourceDerivation(baseline.snapshot, candidate.snapshot, baseline, candidate, controlled ? DURABLE_RESPONSE_KIND : CONTROLLED_READER_RESPONSE_KIND), /reviewed diagnostics-only delta/);
 for (const [path] of changes) {
  const altered = manifest(candidate.files.map(r => [r.path, r.path === path ? hash('unreviewed bytes') : r.sha256]));
  assert.throws(() => verifySourceDerivation(baseline.snapshot, altered.snapshot, baseline, altered, kind), /reviewed diagnostics-only delta/, path);
 }
});

 test('mint dispatch repair requires exact reviewed source and preserves prior fingerprints', () => {
 const baseline=manifest(MINT_DISPATCH_DELTA.filter(r=>r[1]!==null).map(r=>[r[0],r[1]]));
 const candidate=manifest(MINT_DISPATCH_DELTA.map(r=>[r[0],r[2]]));
 assert.equal(verifySourceDerivation(baseline.snapshot,candidate.snapshot,baseline,candidate,MINT_DISPATCH_KIND).controlled,false);
 assert.throws(()=>verifySourceDerivation(baseline.snapshot,candidate.snapshot,baseline,candidate,DURABLE_RESPONSE_KIND),/reviewed diagnostics-only delta/);
 for(const [path] of MINT_DISPATCH_DELTA){
  const altered=manifest(candidate.files.map(r=>[r.path,r.path===path?hash('unreviewed bytes'):r.sha256]));
  assert.throws(()=>verifySourceDerivation(baseline.snapshot,altered.snapshot,baseline,altered,MINT_DISPATCH_KIND),/reviewed diagnostics-only delta/);
 }
});
