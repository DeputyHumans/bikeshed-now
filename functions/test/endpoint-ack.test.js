// SPDX-License-Identifier: Apache-2.0
// Verification, reading and team endpoints retain one operation through a native lost-commit acknowledgement (SPEC §14, §17, §18).
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const notify = require('../lib/email/notify.js');
const {fakeFirestore, withFakeAdmin, invoke} = require('./fakes.js');
const {loseFirstTransactionAcknowledgement} = require('./transaction-ack.js');
const {verifyEmail, recordView, manageTeamMembers} = require('../lib/index.js');
const {MAX_BEAT_MS} = require('../lib/config.js');
const uid='ack-user', email='ack@example.com', owner='owner@example.com';
const hash=code=>createHash('sha256').update(`${uid}:${code}`).digest('hex');
const challenge=(extra={})=>({hash:hash('123456'),email,expiresAt:Date.now()+900000,sentAt:Date.now(),attempts:0,...extra});
async function verify(initial, action, body, inspect, afterCommit=async()=>{}) {
 const {db,store}=fakeFirestore(initial?{[`verifications/${uid}`]:initial}:{}), sent=[];
 const lost=loseFirstTransactionAcknowledgement(db,{afterCommit:()=>afterCommit(db,store)}), original=notify.sendVerificationCode;
 notify.sendVerificationCode=async(...args)=>{sent.push(args);return {sent:true};};
 try {await withFakeAdmin({db,idTokens:{token:{uid,email,email_verified:false}}},async()=>{
  const response=await invoke(verifyEmail,{path:`/verify/${action}`,headers:{authorization:'Bearer token'},body});
  assert.equal(lost().failures,1,'the native SDK lost one durable acknowledgement');
  assert.ok(lost().callbackCalls>=2,'the native SDK retried its callback');
  await inspect({response,sent,verification:store.get(`verifications/${uid}`)});
 });}finally{notify.sendVerificationCode=original;}
}
test('verification start acknowledges and mails its own reserved challenge once',()=>verify(null,'start',{},({response,sent,verification})=>{
 assert.equal(response.status,200,'ACK verification start: its durable reservation returns200');
 assert.equal(sent.length,1,'ACK verification start: its reserved code is mailed once');
 assert.equal(verification.hash,hash(sent[0][1]),'ACK verification start: mail matches the current challenge');
}));
for(const attempts of [0,4]) test(`one wrong verification request consumes one attempt after acknowledgement loss at ${attempts}`,()=>verify(challenge({attempts}),'complete',{code:'000000'},({response,verification})=>{
 assert.equal(response.status,400,'ACK wrong code: the completed attempt retains its original refusal');
 assert.equal(verification?.attempts,attempts+1,'ACK wrong code: one request spends one guess');
}));
test('a retry never spends a wrong attempt against a replacement challenge',async()=>{
 const replacement=challenge({hash:hash('654321'),attempts:0,sentAt:Date.now()+1});
 await verify(challenge(),'complete',{code:'000000'},({response,verification})=>{
  assert.equal(response.status,409,'ACK replacement: the original checked challenge changed');
  assert.deepEqual(verification,replacement,'ACK replacement: a newer challenge retains its guess budget');
 },db=>db.doc(`verifications/${uid}`).set(replacement));
});
for(const signedIn of [false,true]) test(`a ${signedIn?'member':'public'} reading beat consumes its cap only once after acknowledgement loss`,async()=>{
 const {db,store}=fakeFirestore({'docs/d':{ownerEmail:owner,members:[owner,email],visibility:'public',currentVersion:'v1'}});
 const lost=loseFirstTransactionAcknowledgement(db);
 await withFakeAdmin({db,sessions:{s:{uid,email,email_verified:true}}},async()=>{
  const response=await invoke(recordView,{headers:signedIn?{cookie:'__session=s'}:{},body:{docId:'d',versionId:'v1',sessionId:'ack-read-session',ms:MAX_BEAT_MS*4}});
  assert.equal(response.status,200);
  assert.equal(lost().failures,1);
  assert.equal(response.body.ms,MAX_BEAT_MS,'ACK reading: one request consumes only one beat cap');
  assert.equal(store.get('docs/d').stats.totalMs,MAX_BEAT_MS,'ACK reading: totals count the capped delta once');
  assert.equal(store.get('docs/d').stats.views,1,'ACK reading: one session is one view');
  if(signedIn)assert.equal(store.get(`docs/d/viewers/${uid}`).totalMs,MAX_BEAT_MS,'ACK reading: viewer totals count the capped delta once');
 });
});
test('an administrator removing themselves still acknowledges its committed team change',async()=>{
 const {db,store}=fakeFirestore({'teams/t':{ownerEmail:owner,members:[owner,email],admins:[owner,email]}}),lost=loseFirstTransactionAcknowledgement(db);
 await withFakeAdmin({db,sessions:{s:{uid,email,email_verified:true}}},async()=>{
  const response=await invoke(manageTeamMembers,{headers:{cookie:'__session=s'},body:{teamId:'t',remove:[email]}});
  assert.equal(lost().failures,1);
  assert.equal(response.status,200,'ACK team: self-removal acknowledges the completed authorized change');
  assert.deepEqual(store.get('teams/t').members,[owner]);
  assert.deepEqual(Object.keys(store.get('teams/t').transactionReceipts??{}),[],'ACK team: completed request clears its temporary receipt');
 });
});
test('a team addition sends its invitation after its own acknowledgement was lost',async()=>{
 const {db}=fakeFirestore({'teams/t':{ownerEmail:owner,members:[owner],admins:[owner]}}),lost=loseFirstTransactionAcknowledgement(db),sent=[];
 const original=notify.sendInvitations;notify.sendInvitations=async(_actor,targets)=>{sent.push(...targets.map(t=>t.email));};
 try{await withFakeAdmin({db,sessions:{s:{uid:'owner',email:owner,email_verified:true}}},async()=>{
  const response=await invoke(manageTeamMembers,{headers:{cookie:'__session=s'},body:{teamId:'t',add:[email]}});
  assert.equal(lost().failures,1);assert.equal(response.status,200);
  assert.deepEqual(sent,[email],'ACK team: the winning addition preserves its invitation delta');
 });}finally{notify.sendInvitations=original;}
});
