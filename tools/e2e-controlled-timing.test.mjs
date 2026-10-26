// SPDX-License-Identifier: Apache-2.0
// Reject incomplete controlled witnesses, arbitrary inconclusives and ineffective controls without relabelling natural observations (SPEC §12).
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {FIRESTORE_MAINTENANCE_DELTA,CONTROLLED_READER_DELTA,CONTROLLED_READER_KIND} from './e2e-source-derivation.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {attachRtdbFixture} from './e2e-rtdb-test-fixture.mjs';
import {captureTiming,verifyTimingArtifact,missingTiming,C10_FILE,C22_FILE,TIMING_CONTROLS} from './e2e-controlled-timing.mjs';
const source={revision:'a'.repeat(40),version:'0.20.4',fingerprint:'f'.repeat(64)};
const write=(root,p,v)=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),typeof v==='string'?v:JSON.stringify(v));};
const naturalReason=`race not achieved: no two pages' accept saves each lacked the other's replacement (attempt3-p1#0 holds [1,1]), so this trial can neither show S17 nor count as "not reproduced"`;
function row(prefix,trial,status='pass',reason=null,file=C10_FILE){const name=`${prefix} synthetic fixture [N=2] #${trial}`;return {id:`${file}::${name}`,name,file,n:2,trial,status,at:'2026-10-15T01:00:30.000Z',...(reason?{inconclusive:reason}:{})};}
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'controlled-timing-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const campaign={acceptance:{...source},proofs:[],controls:[]};
 const path='e2e/.out/natural/invocations/i/results.json',dir=dirname(path);
 const cases=[];
 for(let trial=1;trial<=10;trial++){
  for(const prefix of ['C10b approvers press Accept','C10b slow link:','C10b judge (slow link):','C10b held save:','C10b judge (held save):'])cases.push(row(prefix,trial));
  cases.push(row('C10b judge (SYNC-T):',trial,trial===1?'inconclusive':'pass',trial===1?naturalReason:null));
 }
 const invocation={id:'i',runId:'natural',suite:'concurrency',spec:[C10_FILE],grep:null,n:[2],trials:null,capabilities:['storage-preconditions','rtdb-proxy'],plan:[{tier:'concurrency',files:[C10_FILE]}],startedAt:'2026-10-15T01:00:00Z'};
 const report={runId:'natural',invocation,malformed:[],mergedAt:'2026-10-15T01:01:00Z',cases};
 const done={...invocation,endedAt:'2026-10-15T01:01:01Z',exit:3,interrupted:null,stackDown:null};
 const stack=patches=>({runId:'natural',fingerprint:{baseSha:source.revision,sha256:source.fingerprint,dirty:true},expectVersion:source.version,patches});
 write(root,path,report);write(root,`${dir}/invocation.json`,done);write(root,'e2e/.out/natural/stack.json',stack([]));
 write(root,`${dir}/c10-accepts.jsonl`,'{"syntheticFixture":true}\n');
 const prepared=attachRtdbFixture(root,{campaign,rel:path});Object.assign(report,prepared.report);Object.assign(done,prepared.done);
 const save=()=>{write(root,path,report);write(root,`${dir}/invocation.json`,done);write(root,`${dir}/results-final.jsonl`,report.cases.map(c=>JSON.stringify(c)).join('\n')+'\n');};save();
 const ledger={ok:true,endedAt:'2026-10-15T02:00:01Z',commit:source.revision,controls:[],green:[]};
 for(const set of TIMING_CONTROLS.c10){
  const c=row(`Synthetic ${set}`,1);c.name=c.name.replace(' #1','');c.id=`${c.file}::${c.name}`;
  write(root,`e2e/patches/${set}/control.json`,{oracle:'synthetic fixture',what:set,target:{spec:C10_FILE,suite:'concurrency',case:c.name},stack:[],expect:{message:`^intended ${set}$`}});write(root,`e2e/patches/${set}/mutant.patch`,'synthetic fixture\n');
  const control={id:set,set,assertion:`intended ${set}`};
  for(const color of ['red','green']){
   const id=`${set}-${color}`,p=`e2e/.out/${id}/invocations/i/results.json`;
   write(root,p,{runId:id,invocation:{id:'i'},malformed:[],cases:[{...c,...(color==='red'?{status:'fail',error:{message:control.assertion}}:{})}]});write(root,`e2e/.out/${id}/stack.json`,stack(color==='red'?[set]:[]));
   attachRtdbFixture(root,{campaign,rel:p});campaign.proofs.push({...source,id,kind:'e2e-case',outcome:color==='red'?'FAIL':'PASS',artifact:p,runId:id,invocation:'i',caseId:c.id,n:2,trial:1});control[color]=id;
  }
  campaign.controls.push(control);ledger.controls.push({set,ok:true,red:{invocationDir:`e2e/.out/${set}-red/invocations/i`}});ledger.green.push({sets:[set],invocationDir:`e2e/.out/${set}-green/invocations/i`});
 }
 write(root,'e2e/.out/ledger.json',ledger);
 const capture=()=>captureTiming(campaign,{area:'c10',natural:path,controlLedgers:['e2e/.out/ledger.json']},{root,source});
 return {root,campaign,report,done,save,capture,ledger};
}
test('complete slow-link and held-save witnesses qualify safety while natural timing remains inconclusive',t=>{
 const f=fixture(t),artifact=f.capture(),result=verifyTimingArtifact(f.campaign,artifact,{root:f.root});
 assert.equal(result.observations.length,1);assert.equal(result.unresolvedNaturalWitness.n,2);
 assert.equal(f.report.cases.filter(c=>c.status==='inconclusive').length,1);
});
for(const [name,mutate,expected] of [
 ['missing controlled trial',f=>f.report.cases.splice(1,1),/every default trial/],
 ['skipped controlled judge',f=>{f.report.cases[2].status='skip';f.report.cases[2].skipReason='not exercised';},/controlled witness did not pass/],
 ['failed controlled judge',f=>{f.report.cases[2].status='fail';f.report.cases[2].error={message:'lost data'};},/unrelated failure/],
 ['gap from another participant count',f=>{const c=f.report.cases[5];c.n=5;c.id=c.id.replace('[N=2]','[N=5]');c.name=c.name.replace('[N=2]','[N=5]');},/unrelated failure/],
 ['unrelated inconclusive',f=>{f.report.cases[5].inconclusive='browser crashed';},/unrelated failure/],
 ['filtered invocation',f=>{f.report.invocation.grep=f.done.grep='one';},/filtered/],
 ['trial override',f=>{f.report.invocation.trials=f.done.trials=1;},/non-plan/],
 ['missing completion',f=>{delete f.done.endedAt;},/end is absent/],
 ['interrupted invocation',f=>{f.done.interrupted='SIGINT';},/did not finish/],
 ['missing capability',f=>{f.report.invocation.capabilities=f.done.capabilities=[];},/capabilities missing/],
 ['wrong file selection',f=>{f.report.invocation.spec=f.done.spec=[];},/complete file/],
 ['no missing natural window',f=>{f.report.cases[5].status='pass';delete f.report.cases[5].inconclusive;},/unrelated failure/],
 ['missing actual control',f=>f.campaign.controls.pop(),/missing control/],
 ['invalid control ledger',f=>{f.ledger.ok=false;write(f.root,'e2e/.out/ledger.json',f.ledger);},/ledger is unfinished/],
])test(`negative: ${name} cannot qualify timing`,t=>{const f=fixture(t);mutate(f);f.save();assert.throws(f.capture,expected);});
test('only named reader windows with exact case, N and trial identities are eligible',()=>{
 for(const prefix of ['C22 reader under a typing storm:','C22 place:','C22 reply:','C22 held loads:','C22 held loads place:','C22 held loads reply:','C22 suggesting:','C22 suggesting held:']){
  const reason=prefix.includes('suggesting')?"the storm did not reach the reader while it wrote its suggestion: 0 of the typists' 4 save(s) answered while it typed (want 2 or more)":"the storm did not reach the reader while it typed: 1 of its 1 frame reload(s) fell inside its typing window (want 2 or more)";
  const c=row(prefix,1,'inconclusive',reason,C22_FILE);assert.equal(missingTiming(c),true,prefix);
  for(const change of [{status:'fail'},{error:'lost data'},{todo:'bug'},{n:5},{trial:2},{file:C10_FILE},{inconclusive:'the browser crashed'},{inconclusive:reason.replace('want 2','want 1')}])assert.equal(missingTiming({...c,...change}),false,JSON.stringify(change));
 }
});


function readerFixture(t){
 const f=fixture(t), hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 const manifest=column=>{const files=[...FIRESTORE_MAINTENANCE_DELTA,CONTROLLED_READER_DELTA].filter(row=>row[column]!==null).map(row=>({path:row[0],sha256:row[column]})).sort((a,b)=>a.path<b.path?-1:1);return {snapshot:{...source,files:files.length,fingerprint:hash(files.map(r=>`${r.path}\0${r.sha256}\n`).join(''))},files};};
 const baseline=manifest(1),candidate=manifest(2);
 const bind=(p,v)=>{write(f.root,p,v);return {artifact:p,sha256:hash(readFileSync(join(f.root,p)))};};
 f.campaign.acceptance={...f.campaign.acceptance,...baseline.snapshot,sourceDerivations:[{kind:CONTROLLED_READER_KIND,fingerprint:candidate.snapshot.fingerprint,baseline:bind('e2e/.out/baseline.json',baseline),candidate:bind('e2e/.out/candidate.json',candidate)}]};
 const prefixes=['C22 reader under a typing storm:','C22 place:','C22 reply:','C22 held loads:','C22 held loads place:','C22 held loads reply:','C22 suggesting:','C22 suggesting held:'];
 const cases=[];for(let trial=1;trial<=10;trial++)for(const prefix of prefixes)cases.push(row(prefix,trial,trial===1?'inconclusive':'pass',trial===1?(prefix.includes('suggesting')?"the storm did not reach the reader while it wrote its suggestion: 0 of the typists' 4 save(s) answered while it typed (want 2 or more)":"the storm did not reach the reader while it typed: 1 of its 1 frame reload(s) fell inside its typing window (want 2 or more)"):null,C22_FILE));
 cases.push(row('C23 unrelated layout assertion:',1,'pass',null,C22_FILE));
 const reports=[];
 for(const controlled of [false,true]){
  const runId=controlled?'reader-controlled':'reader-natural',path=`e2e/.out/${runId}/invocations/i/results.json`,dir=dirname(path);
  const report={...structuredClone(f.report),runId,cases:structuredClone(cases)};Object.assign(report.invocation,{runId,spec:[C22_FILE],plan:[{tier:'concurrency',files:[C22_FILE]}]});
  if(controlled)for(const c of report.cases){c.status='pass';delete c.inconclusive;}
  const done={...report.invocation,endedAt:'2026-10-15T01:01:01Z',exit:controlled?0:3,interrupted:null,stackDown:null};
  const selected=controlled?candidate.snapshot:baseline.snapshot;
  write(f.root,path,report);write(f.root,`${dir}/invocation.json`,done);write(f.root,`e2e/.out/${runId}/stack.json`,{fingerprint:{baseSha:selected.revision,sha256:selected.fingerprint},expectVersion:selected.version,patches:[]});write(f.root,`${dir}/c22-storm.jsonl`,'{"syntheticFixture":true}\n');
  const prepared=attachRtdbFixture(f.root,{campaign:{acceptance:{...f.campaign.acceptance,...selected}},rel:path});reports.push({path,report:prepared.report,done:prepared.done});
 }
 // Independent synthetic controls exercise the same catalog binding rules as C10.
 f.campaign.controls=[];f.campaign.proofs=[];const ledger={ok:true,endedAt:'2026-10-15T02:00:01Z',commit:source.revision,controls:[],green:[]};
 for(const set of TIMING_CONTROLS.c22){
  const c=row(`Synthetic ${set}`,1,'pass',null,C22_FILE);c.name=c.name.replace(' #1','');c.id=`${c.file}::${c.name}`;
  write(f.root,`e2e/patches/${set}/control.json`,{oracle:'synthetic fixture',what:set,target:{spec:C22_FILE,suite:'concurrency',case:c.name},stack:[],expect:{message:`^intended ${set}$`}});write(f.root,`e2e/patches/${set}/mutant.patch`,'synthetic fixture\n');
  const control={id:set,set,assertion:`intended ${set}`};
  for(const color of ['red','green']){
   const id=`${set}-${color}`,path=`e2e/.out/${id}/invocations/i/results.json`;
   write(f.root,path,{runId:id,invocation:{id:'i'},malformed:[],cases:[{...c,...(color==='red'?{status:'fail',error:{message:control.assertion}}:{})}]});write(f.root,`e2e/.out/${id}/stack.json`,{fingerprint:{baseSha:source.revision,sha256:baseline.snapshot.fingerprint},expectVersion:source.version,patches:color==='red'?[set]:[]});attachRtdbFixture(f.root,{campaign:f.campaign,rel:path});
   f.campaign.proofs.push({...baseline.snapshot,id,kind:'e2e-case',outcome:color==='red'?'FAIL':'PASS',artifact:path,runId:id,invocation:'i',caseId:c.id,n:2,trial:1});control[color]=id;
  }
  f.campaign.controls.push(control);ledger.controls.push({set,ok:true,red:{invocationDir:`e2e/.out/${set}-red/invocations/i`}});ledger.green.push({sets:[set],invocationDir:`e2e/.out/${set}-green/invocations/i`});
 }
 write(f.root,'e2e/.out/reader-ledger.json',ledger);
 const save=()=>{for(const r of reports){write(f.root,r.path,r.report);write(f.root,`${dirname(r.path)}/invocation.json`,r.done);write(f.root,`${dirname(r.path)}/results-final.jsonl`,r.report.cases.map(c=>JSON.stringify(c)).join('\n')+'\n');}};save();
 const manifestArgs={area:'c22',natural:reports[0].path,controlled:reports[1].path,controlLedgers:['e2e/.out/reader-ledger.json']};
 return {...f,reports,save,manifestArgs,capture:()=>captureTiming(f.campaign,manifestArgs,{root:f.root,source:baseline.snapshot})};
}
test('a complete controlled reader file qualifies exact natural gaps while retaining both source fingerprints',t=>{
 const f=readerFixture(t),artifact=f.capture(),result=verifyTimingArtifact(f.campaign,artifact,{root:f.root});
 assert.equal(result.observations.length,8);assert.equal(f.reports[0].report.cases.filter(c=>c.status==='inconclusive').length,8);
 assert.notEqual(JSON.parse(readFileSync(join(f.root,'e2e/.out/reader-natural/stack.json'))).fingerprint.sha256,JSON.parse(readFileSync(join(f.root,'e2e/.out/reader-controlled/stack.json'))).fingerprint.sha256);
});
for(const [name,mutate,message] of [
 ['missing counterpart',f=>f.reports[1].report.cases.pop(),/census differs/],
 ['controlled inconclusive',f=>{f.reports[1].report.cases[0].status='inconclusive';f.reports[1].report.cases[0].inconclusive='no overlap';},/incomplete outcomes/],
 ['skipped active case',f=>{f.reports[1].report.cases.at(-1).status='skip';f.reports[1].report.cases.at(-1).skipReason='not exercised';},/skipped an active natural case/],
 ['changed runtime options',f=>{const path='e2e/.out/reader-controlled/stack.json',stack=JSON.parse(readFileSync(join(f.root,path)));stack.options={emailOff:true};write(f.root,path,stack);},/runtime options differ/],
 ['controlled failure',f=>{f.reports[1].report.cases.at(-1).status='fail';f.reports[1].report.cases.at(-1).error={message:'lost unrelated layout state'};},/incomplete outcomes/],
 ['controlled filter',f=>{f.reports[1].report.invocation.grep=f.reports[1].done.grep='one';},/filtered/],
 ['wrong source label',f=>{f.campaign.acceptance.sourceDerivations[0].kind='firestore-diagnostic-recycle-v1';},/reviewed diagnostics-only delta/],
 ['swapped natural and controlled reports',f=>{[f.manifestArgs.natural,f.manifestArgs.controlled]=[f.manifestArgs.controlled,f.manifestArgs.natural];},/interchanged/],
 ['different participant count',f=>{f.reports[1].report.invocation.n=f.reports[1].done.n=[5];},/participant count differs/],
])test(`negative: reader ${name} cannot qualify natural timing`,t=>{const f=readerFixture(t);mutate(f);f.save();assert.throws(f.capture,message);});
