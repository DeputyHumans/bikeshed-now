// SPDX-License-Identifier: Apache-2.0
// Cloud cooldown evidence rejects serial calls, incomplete events, duplicate notices and unrelated deployments (SPEC §14).

import { fixture, controlledFixture, mutationFixture } from "./e2e-cloud-test-fixture.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeCloudCooldownTrial, judgeCloudCooldownMutation } from "./e2e-cloud-cooldown.mjs";


test("real trigger intervals and their same-recipient cooldown calls overlap, with one committed notice per kind", () => {
  assert.deepEqual(judgeCloudCooldownTrial(fixture()), { triggers: 4, calls: 4, peakTriggers: 4, peakCalls: { comment: 2, suggestion: 2 }, messages: 2 });
});
test("a provider request may spell its single recipient as a string", () => {
  const x = fixture(); for (const m of x.messages) m.to = x.email;
  assert.equal(judgeCloudCooldownTrial(x).messages, 2);
});
const negative = [
  ["another database", x => { x.deployment.database = "(default)"; }, /isolated/],
  ["another revision", x => { x.logs[0].resource.labels.revision_name = "other"; }, /another deployment/],
  ["another function build", x => { x.logs[0].labels["firebase-functions-hash"] = "b".repeat(40); }, /another deployment/],
  ["missing stored write", x => x.writes.pop(), /missing or duplicate writes/],
  ["missing suggestion marker", x => { delete x.writes[2].stored.opensSuggestion; }, /stored comment/],
  ["duplicate log", x => x.logs.push(x.logs[0]), /duplicate logging/],
  ["unfinished trigger", x => x.logs.splice(1, 1), /unfinished/],
  ["another event document", x => { x.logs[0].jsonPayload.params.docId = "other"; }, /document identity/],
  ["missing cooldown calls", x => { x.logs = x.logs.filter(r => r.jsonPayload.marker !== "e2e-cooldown-call"); }, /missing trigger or cooldown/],
  ["clock skew between instances", x => { for (const r of x.logs) r.labels.instanceId = r.labels.execution_id; }, /did not overlap/],
  ["different recipient", x => { for (const r of x.logs.filter(r => r.jsonPayload.marker === "e2e-cooldown-call")) r.jsonPayload.uid = "other"; }, /another recipient/],
  ["double cooldown grant", x => { for (const r of x.logs.filter(r => r.jsonPayload.phase === "result")) r.jsonPayload.granted = true; }, /granted more or less/],
  ["double mail", x => x.messages.push({ ...x.messages[0], id: "duplicate" }), /exactly one/],
  ["wrong recipient", x => { x.messages[0].to = ["other@e2e.invalid"]; }, /notice recipient/],
  ["missing receipt", x => { x.recipient.emailCooldownClaims = {}; }, /receipt missing/],
  ["notifications disabled", x => { x.recipient.emailNotifications = false; }, /not eligible/],
  ["serial cooldown calls inside overlapping triggers", x => {
    for (const r of x.logs.filter(r => r.jsonPayload.marker === "e2e-cooldown-call")) {
      const second = r.labels.execution_id.endsWith("-1");
      r.jsonPayload.at = { start: second ? 50 : 10, result: second ? 60 : 20, end: second ? 70 : 30 }[r.jsonPayload.phase];
    }
  }, /cooldown calls did not overlap/],
];
for (const [name, mutate, expected] of negative) test(`NEGATIVE: ${name}`, () => { const x = fixture(); mutate(x); assert.throws(() => judgeCloudCooldownTrial(x), expected); });

// Safety failures must never be reported merely as missed timing windows.
test("a serial trigger delivery still exposes duplicate captured notices", () => {
  const x = fixture(), invocations = [...new Set(x.logs.map(r => r.labels.execution_id))];
  for (const r of x.logs) {
    const base = invocations.indexOf(r.labels.execution_id) * 100;
    r.jsonPayload.at = base + (r.jsonPayload.marker === "e2e-real-trigger" ? { start: 0, end: 40 } : { start: 10, result: 20, end: 30 })[r.jsonPayload.phase];
  }
  x.messages.push({ ...x.messages[0], id: "duplicate" });
  assert.throws(() => judgeCloudCooldownTrial(x), /expected exactly one captured message per kind/);
});
test("serial cooldown calls still expose multiple grants before a timing classification", () => {
  const x = fixture();
  for (const r of x.logs.filter(r => r.jsonPayload.marker === "e2e-cooldown-call")) {
    const second = r.labels.execution_id.endsWith("-1");
    r.jsonPayload.at = { start: second ? 50 : 10, result: second ? 60 : 20, end: second ? 70 : 30 }[r.jsonPayload.phase];
    if (r.jsonPayload.phase === "result") r.jsonPayload.granted = true;
  }
  assert.throws(() => judgeCloudCooldownTrial(x), /cooldown granted more or less than once/);
});



test("controlled arrivals prove overlap only after the measured calls leave their gate",()=>{
  assert.equal(judgeCloudCooldownTrial(controlledFixture()).controlled,true);
});
for(const [name,change] of [
  ["unlabelled controlled timing",x=>{delete x.controlled;}],
  ["another gate document",x=>{x.controlled.path="e2eCooldownGates/other";}],
  ["missing arrival",x=>{delete x.controlled.gate.arrivals['call-comment-0'];}],
  ["wrong gate recipient",x=>{x.controlled.gate.uid="other";}],
  ["release before arrivals",x=>{x.controlled.gate.releaseAt=1;}],
  ["expired release",x=>{x.controlled.gate.deadline=8;}],
  ["unbound gate deployment",x=>{const r=x.logs.find(r=>r.jsonPayload.marker==="e2e-cooldown-gate");r.resource={...r.resource,labels:{...r.resource.labels,revision_name:"other"}};}],
  ["held time counted as a call",x=>{x.logs.find(r=>r.jsonPayload.marker==="e2e-cooldown-call"&&r.jsonPayload.phase==="start").jsonPayload.at=0;}],
  ["release log after call start",x=>{x.logs.find(r=>r.jsonPayload.marker==="e2e-cooldown-gate").jsonPayload.at=100;}],
])test(`NEGATIVE: controlled evidence refuses ${name}`,()=>{const x=controlledFixture();change(x);assert.throws(()=>judgeCloudCooldownTrial(x),/controlled/);});



test("the guard-removal control proves duplicate grants and notices under measured controlled overlap",()=>{
  assert.deepEqual(judgeCloudCooldownMutation(mutationFixture()),{calls:4,messages:4,controlled:true});
});
test("a green result and an unrelated notice failure cannot stand in for the red control",()=>{
  assert.throws(()=>judgeCloudCooldownMutation(controlledFixture()),/did not expose duplicate/);
  const x=mutationFixture();x.messages[0].to="other@e2e.invalid";
  assert.throws(()=>judgeCloudCooldownMutation(x),/mutation notice identity/);
});
test("the red control must overlap after release, even though it sends duplicate notices",()=>{
  const x=mutationFixture();
  for(const r of x.logs.filter(r=>r.jsonPayload.marker==="e2e-cooldown-call")) {
    const second=r.labels.execution_id.endsWith("-1");
    r.jsonPayload.at={start:second?50:10,result:second?60:20,end:second?70:30}[r.jsonPayload.phase];
  }
  assert.throws(()=>judgeCloudCooldownMutation(x),/mutation cooldown calls did not overlap/);
});
