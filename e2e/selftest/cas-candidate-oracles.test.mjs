// SPDX-License-Identifier: Apache-2.0
// Directional fixtures for every response, pointer, frontier, preserved-byte and cleanup CAS assertion (SPEC §12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCasWinner, assertCasCandidateOutcome } from "../lib/cas-candidate-oracles.mjs";
const version = id => ({ id, metadata:{entry:"index.html",storagePrefix:`docs/d/bundles/${id}`},objects:[{key:`docs/d/bundles/${id}/index.html`,size:4,sha256:"a".repeat(64)}] });
const fixture = reused => {
  const original={currentVersion:"v1",liveEpoch:{present:true,value:"initial"},draft:{storagePrefix:"docs/d/bundles/initial",causal:{vector:{101:1}}},draftObjects:[{key:"docs/d/bundles/initial/index.html",size:3,sha256:"b".repeat(64)}],versions:[version("v1")]};
  const winner=structuredClone(original);
  if(reused){winner.draft={storagePrefix:"docs/d/bundles/new",causal:{vector:{101:3}}};winner.draftObjects=[{key:"docs/d/bundles/new/index.html",size:3,sha256:"c".repeat(64)}];}
  else {winner.currentVersion="v2";winner.draft=null;winner.draftObjects=[];winner.liveEpoch.value="new";winner.versions.push(version("v2"));}
  return {reused,original,winner,expectedPrefix:"docs/d/bundles/new",expectedVector:{101:3},published:"v2",response:reused?{status:200,json:{draft:{storagePrefix:"docs/d/bundles/new"}}}:{status:409,json:{error:"This document has a newer version. Reload before editing.",currentVersion:"v2"}},final:structuredClone(winner),discarded:[],unreachable:[]};
};
for(const reused of [true,false])test(`CAS ${reused?"reuse":"refusal"} complete correct outcome passes`,()=>{
  const x=fixture(reused);assertCasWinner({...x,response:{status:200}});assertCasCandidateOutcome(x);
});
const variants=[
 ["winner-status",true,"winner","the newer causal save succeeds",x=>x.response.status=409],
 ["winner-prefix",true,"winner","the actual newer candidate is the selected draft",x=>x.winner.draft.storagePrefix="wrong"],
 ["winner-frontier",true,"winner","the selected draft has the newer causal frontier",x=>x.winner.draft.causal.vector={101:2}],
 ["winner-history",true,"winner","the newer save preserves every historical version's metadata and bytes",x=>x.winner.versions[0].objects[0].sha256="d".repeat(64)],
 ["publication-answer",false,"winner","the real agent publication wins while the old snapshot is held",x=>x.published="v1"],
 ["publication-head",false,"winner","the selected head advances before the CAS resumes",x=>x.winner.currentVersion="v1"],
 ["publication-draft",false,"winner","publication retires the previously selected draft",x=>x.winner.draft=x.original.draft],
 ["publication-history",false,"winner","publication preserves the historical version's metadata and bytes",x=>x.winner.versions[0].metadata.entry="lost.html"],
 ["publication-bytes",false,"winner","the winning version has actual stored bytes",x=>x.winner.versions[1].objects=[]],
 ["reuse-answer",true,"outcome","the older causal history acknowledges the newer draft",x=>x.response.status=409],
 ["reuse-pointer",true,"outcome","acknowledgement returns the existing newer draft pointer",x=>x.response.json.draft.storagePrefix="wrong"],
 ["refusal-status",false,"outcome","the old base is refused",x=>x.response.status=200],
 ["refusal-reason",false,"outcome","refusal names the documented changed-version reason",x=>x.response.json.error="other conflict"],
 ["refusal-head",false,"outcome","refusal identifies the current head",x=>x.response.json.currentVersion="v1"],
 ["loser-preservation",true,"outcome","the losing request preserves exact current/draft/version metadata and byte digests",x=>x.final.draftObjects[0].sha256="f".repeat(64)],
 ["loser-candidate",true,"outcome","the discarded upload remains unreferenced but present",x=>x.discarded=["docs/d/bundles/rejected/index.html"]],
 ["loser-other-objects",true,"outcome","no unreachable attempt objects remain after the completed race",x=>x.unreachable=["docs/d/bundles/rejected/asset.png"]],
];
for(const [name,reused,which,message,mutate]of variants)test(`CAS oracle rejects ${name}`,()=>{
  const x=fixture(reused);if(which==="winner")x.response={status:200};mutate(x);
  assert.throws(()=>which==="winner"?assertCasWinner(x):assertCasCandidateOutcome(x),error=>error.code==="ERR_ASSERTION" && error.message.includes(message),name+": intended assertion rejects the isolated invalid observation");
});
