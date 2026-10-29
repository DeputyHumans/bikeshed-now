// SPDX-License-Identifier: Apache-2.0
// Qualify only named missing browser timing windows using full controlled runs and actual regression controls, retaining natural inconclusives (SPEC §6a, §12).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve, relative, isAbsolute } from 'node:path';
import { parseExpandedCase } from '../e2e/lib/controls.mjs';
import { PLAN_TRIALS } from '../e2e/lib/budget.mjs';
import { verifyFinishedRun } from './e2e-run-completion.mjs';
import { assertAcceptedSource, stackSource, CONTROLLED_READER_KIND, CONTROLLED_READER_CHANNEL_KIND, CONTROLLED_READER_BARRIER_KIND, CONTROLLED_READER_RESPONSE_KIND } from './e2e-source-derivation.mjs';
import { verifyCompositeControls } from './e2e-c14-composite.mjs';
import { createRtdbAttestationCache, verifyRtdbRunAttestation, assertRtdbAttestationCacheUnchanged } from './e2e-rtdb-attestation.mjs';
export const TIMING_ID = 'controlled-browser-timing-safety-v1';
export const C10_FILE = 'e2e/specs/concurrency/c10-accepts.spec.mjs';
export const C22_FILE = 'e2e/specs/concurrency/c18-scale-ui.spec.mjs';
export const TIMING_CONTROLS = Object.freeze({
  c10: ['controls-c10-i8-in-place','controls-c10-i8-unwritten'],
  c22: ['controls-c22-reader-place','controls-c22-reader-selection','controls-c22-suggest-reload'],
});
const need=(ok,why)=>{if(!ok)throw new Error(`controlled timing: ${why}`);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const key=c=>`${c.id}::${c.n ?? '-'}::${c.trial ?? 1}`;
const pass=c=>c.status==='pass'&&!c.error&&!c.todo&&!c.inconclusive&&!c.notReproduced&&!c.skipReason&&(!c.outcome||c.outcome==='PASS');
const skip=c=>c.status==='skip'&&!c.error&&!c.todo&&!c.inconclusive&&!c.notReproduced;
const incomplete=c=>c.status==='inconclusive'&&typeof c.inconclusive==='string'&&!c.error&&!c.todo&&!c.notReproduced&&!c.skipReason&&!c.outcome;
function local(root,path){need(typeof path==='string'&&!isAbsolute(path)&&!path.includes('\\')&&!relative(root,resolve(root,path)).startsWith('..'),'artifact must stay repository-relative');return resolve(root,path);}
function bound(root,path){return {artifact:path,sha256:hash(readFileSync(local(root,path)))};}
function read(root,ref){const bytes=readFileSync(local(root,ref?.artifact));need(hash(bytes)===ref.sha256,'artifact digest differs');return JSON.parse(bytes);}
const name=c=>parseExpandedCase(c.id)?.scenario?.split('::').slice(1).join('::');
const c10Judge='C10b judge (SYNC-T):';
const c22Prefixes=['C22 reader under a typing storm:','C22 place:','C22 reply:','C22 held loads:','C22 held loads place:','C22 held loads reply:','C22 suggesting:','C22 suggesting held:'];
export function missingTiming(c){
 if(!incomplete(c))return false;
 const parsed=parseExpandedCase(c.id);if(!parsed||parsed.n!==c.n||(parsed.trial??1)!==c.trial)return false;
 if(c.file===C10_FILE&&name(c)?.startsWith(c10Judge))return /^race not achieved: no two pages' accept saves each lacked the other's replacement \(.+\), so this trial can neither show S17 nor count as "not reproduced"$/.test(c.inconclusive);
 if(c.file!==C22_FILE||!c22Prefixes.some(p=>name(c)?.startsWith(p)))return false;
 const reason=c.inconclusive.replace(`the C22 work case [N=${c.n}] #${c.trial} was INCONCLUSIVE: `,'').replace(`the C22 held work case [N=${c.n}] #${c.trial} was INCONCLUSIVE: `,'');
 return /^the storm did not reach the reader while it (?:typed: [01] of its \d+ frame reload\(s\) fell inside its typing window \(want 2 or more\)|wrote its suggestion: [01] of the typists' \d+ save\(s\) answered while it typed \(want 2 or more\))$/.test(reason);
}
function bindRun(root,path){const report=JSON.parse(readFileSync(local(root,path)));return {report:bound(root,path),stack:bound(root,`e2e/.out/${report.runId}/stack.json`),measurements:bound(root,`${dirname(path)}/${report.invocation.plan[0].files[0]===C10_FILE?'c10-accepts':'c22-storm'}.jsonl`)};}
function fullRun(campaign,ref,{root,runtimeCache,controlled=false}){
 const report=read(root,ref.report),stack=read(root,ref.stack),inv=report.invocation;
 const source=assertAcceptedSource(campaign,stackSource(stack),{root});
 need(ref.stack.artifact===`e2e/.out/${report.runId}/stack.json`&&stack.runId===report.runId,'run identity differs');
 need(report.malformed?.length===0&&inv.suite==='concurrency'&&inv.grep===null&&inv.trials===null&&inv.n?.length===1&&PLAN_TRIALS[inv.n[0]],'filtered or non-plan run');
 need(inv.plan?.length===1&&inv.plan[0].files.length===1&&inv.spec?.length===1,'one complete file required');
 const file=inv.plan[0].files[0];
 need(inv.spec[0]===file || inv.spec[0]===basename(file),'one complete file required');need([C10_FILE,C22_FILE].includes(file)&&report.cases.every(c=>c.file===file),'unrelated file');
 const patches=(stack.patches??[]).map(p=>p.set??p);
 need(patches.length===0 || (!controlled && file===C10_FILE && patches.length===1 && patches[0]==='amplify-c10-accept'),'timing qualification permits only the reviewed C10 pause points or an unmutated product');
 need(['storage-preconditions','rtdb-proxy'].every(cap=>inv.capabilities.includes(cap)),'timing capabilities missing');
 need(controlled?file===C22_FILE&&[CONTROLLED_READER_KIND,CONTROLLED_READER_CHANNEL_KIND,CONTROLLED_READER_BARRIER_KIND,CONTROLLED_READER_RESPONSE_KIND].includes(source?.kind):!source?.controlled,'natural and controlled sources were interchanged');
 verifyFinishedRun(report,local(root,ref.report.artifact),{expectedExit:controlled?0:3});
 verifyRtdbRunAttestation(campaign,{report,stack,rel:ref.report.artifact},{root,cache:runtimeCache});
 // Bind every original measurement byte; passing timing judges remain responsible
 // for interpreting the schedule. No rewritten or synthesized measurement is accepted.
 const measurementBytes=readFileSync(local(root,ref.measurements.artifact));need(hash(measurementBytes)===ref.measurements.sha256&&measurementBytes.length>0,'measurement archive missing or changed');
 need(ref.measurements.artifact===`${dirname(ref.report.artifact)}/${file===C10_FILE?'c10-accepts':'c22-storm'}.jsonl`,'measurement path differs');
 return {report,stack,n:inv.n[0],file};
}
function allTrials(report,n,prefix){
 const rows=report.cases.filter(c=>c.n===n&&name(c)?.startsWith(prefix));
 assert.deepEqual(rows.map(c=>c.trial).sort((a,b)=>a-b),Array.from({length:PLAN_TRIALS[n]},(_,i)=>i+1),'controlled timing: every default trial must be present exactly once');
 need(rows.every(pass),`controlled witness did not pass: ${prefix}`);return rows;
}
export function verifyTimingArtifact(campaign,artifact,{root,runtimeCache}={}){
 const owned=!runtimeCache,cache=runtimeCache??createRtdbAttestationCache();
 need(artifact?.schemaVersion===1&&artifact.kind===TIMING_ID&&['c10','c22'].includes(artifact.area),'unknown timing qualification');
 assertAcceptedSource(campaign,artifact.source,{root});
 const natural=fullRun(campaign,artifact.natural,{root,runtimeCache:cache});
 need(natural.file===(artifact.area==='c10'?C10_FILE:C22_FILE),'area differs from natural file');
 const inc=natural.report.cases.filter(c=>!pass(c)&&!skip(c));
 need(inc.length>0&&inc.every(c=>c.n===natural.n&&missingTiming(c)),'unrelated failure or inconclusive cannot be qualified');
 if(artifact.area==='c10'){
  need(!artifact.controlled,'C10 slow-link witnesses must come from the same full file');
  for(const prefix of ['C10b approvers press Accept','C10b slow link:','C10b judge (slow link):','C10b held save:','C10b judge (held save):'])allTrials(natural.report,natural.n,prefix);
 }else{
  const controlled=fullRun(campaign,artifact.controlled,{root,runtimeCache:cache,controlled:true});
  need(controlled.n===natural.n,'controlled participant count differs');
  assert.deepEqual(controlled.stack.options,natural.stack.options,'controlled timing: runtime options differ');
  assert.deepEqual(controlled.report.cases.map(key).sort(),natural.report.cases.map(key).sort(),'controlled timing: complete file census differs');
  need(controlled.report.cases.every(c=>pass(c)||skip(c)),'controlled run has incomplete outcomes');
  for(const c of natural.report.cases){const counterpart=controlled.report.cases.find(p=>key(p)===key(c));need(skip(c)?skip(counterpart):pass(counterpart),'controlled run skipped an active natural case or changed its skip eligibility');}
  for(const prefix of c22Prefixes)allTrials(controlled.report,controlled.n,prefix);
  for(const c of inc)need(controlled.report.cases.some(p=>key(p)===key(c)&&pass(p)),'missing exact controlled counterpart');
 }
 verifyCompositeControls(campaign,artifact,root,cache,TIMING_CONTROLS[artifact.area]);
 if(owned)assertRtdbAttestationCacheUnchanged(cache);
 return {observations:inc.map(key),unresolvedNaturalWitness:{id:TIMING_ID,area:artifact.area,n:natural.n,reason:'The original natural timing windows remain inconclusive. Controlled safety witnesses do not establish their natural frequency.',observations:inc.map(key)}};
}
export function captureTiming(campaign,{area,natural,controlled=null,controlLedgers},{root,source}){
 const controls=TIMING_CONTROLS[area].map(set=>{
  const c=campaign.controls.find(c=>c.set===set);need(c,`missing control ${set}`);
  const proof=id=>{const p=campaign.proofs.find(p=>p.id===id);need(p,'missing control proof');return {id,report:bound(root,p.artifact),stack:bound(root,`e2e/.out/${p.runId}/stack.json`)};};
  return {set,id:c.id,definition:bound(root,`e2e/patches/${set}/control.json`),red:proof(c.red),green:proof(c.green)};
 });
 const artifact={schemaVersion:1,kind:TIMING_ID,area,source,observedAt:new Date().toISOString(),natural:bindRun(root,natural),...(controlled?{controlled:bindRun(root,controlled)}:{}),controls,controlLedgers:controlLedgers.map(p=>bound(root,p))};
 verifyTimingArtifact(campaign,artifact,{root});return artifact;
}
export function timingReference(root,artifact,report){return {id:TIMING_ID,...bound(root,artifact),report};}
export function verifyTiming(campaign,proof,loaded,{root,runtimeCache}={}){
 need(proof.kind==='e2e-run'&&proof.outcome==='COMPOSITE-SAFETY'&&proof.timing?.id===TIMING_ID&&proof.timing.report===proof.artifact,'only named run-level timing qualification is supported');
 const artifact=read(root,proof.timing);need(artifact.natural.report.artifact===proof.artifact,'qualification names another natural report');
 assert.deepEqual(read(root,artifact.natural.report),loaded.report,'controlled timing: supplied report differs');
 assert.deepEqual(read(root,artifact.natural.stack),loaded.stack,'controlled timing: supplied stack differs');
 return verifyTimingArtifact(campaign,artifact,{root,runtimeCache});
}
