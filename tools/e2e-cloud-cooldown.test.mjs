// SPDX-License-Identifier: Apache-2.0
// Cloud cooldown evidence rejects serial calls, incomplete events, duplicate notices and unrelated deployments (SPEC §14).

import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeCloudCooldownTrial } from "./e2e-cloud-cooldown.mjs";

function fixture() {
  const docId = "e2e-doc", uid = "e2e-reader", email = `${uid}@e2e.invalid`;
  const deployment = { projectId: "demo-bikeshed", database: "e2e-test", service: "e2ecomment", revision: "e2ecomment-00001", functionHash: "a".repeat(40) };
  const logs = [], writes = [], messages = [], recipient = { email, emailNotifications: true, emailCooldowns: {}, emailCooldownClaims: {} };
  for (const kind of ["comment", "suggestion"]) {
    const key = kind === "comment" ? docId : `${docId}:suggestions`;
    recipient.emailCooldowns[key] = 10; recipient.emailCooldownClaims[key] = `claim-${kind}`;
    messages.push({ id: kind, to: [email], subject: `author ${kind === "comment" ? "commented on" : "suggested an edit to"} “${docId}”` });
    for (let i = 0; i < 2; i++) {
      const invocation = `${kind}-${i}`, path = `docs/${docId}/versions/v1/annotations/${invocation}/comments/opener`;
      writes.push({ path, kind, stored: { authorEmail: "author@e2e.invalid", ...(kind === "suggestion" ? { opensSuggestion: true } : {}) } });
      const add = (payload, phase, at) => logs.push({ insertId: `${invocation}-${payload.marker}-${phase}`, resource: { type: "cloud_run_revision", labels: { project_id: deployment.projectId, service_name: deployment.service, revision_name: deployment.revision } }, labels: { instanceId: "same-instance", execution_id: invocation, "firebase-functions-hash": deployment.functionHash }, jsonPayload: { ...payload, phase, at } });
      const trigger = { marker: "e2e-real-trigger", execution: `trigger-${invocation}`, eventId: invocation, params: { docId }, subject: `documents/${path}` };
      add(trigger, "start", i); add(trigger, "end", 100 + i);
      const call = { marker: "e2e-cooldown-call", execution: `call-${invocation}`, uid, docId, kind };
      add(call, "start", 10 + i); add({ ...call, granted: i === 0 }, "result", 80 + i); add(call, "end", 90 + i);
    }
  }
  return { n: 2, docId, uid, email, deployment, writes, logs, messages, recipient };
}
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
