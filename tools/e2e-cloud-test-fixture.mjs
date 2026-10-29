// SPDX-License-Identifier: Apache-2.0
// Synthetic cloud invocation fixtures for evidence-judge negative controls (SPEC §14).

export function fixture(n = 2) {
  const docId = "e2e-doc", uid = "e2e-reader", email = `${uid}@e2e.invalid`;
  const deployment = { projectId: "demo-bikeshed", database: "e2e-test", service: "e2ecomment", revision: "e2ecomment-00001", functionHash: "a".repeat(40) };
  const logs = [], writes = [], messages = [], recipient = { email, emailNotifications: true, emailCooldowns: {}, emailCooldownClaims: {} };
  for (const kind of ["comment", "suggestion"]) {
    const key = kind === "comment" ? docId : `${docId}:suggestions`;
    recipient.emailCooldowns[key] = 10; recipient.emailCooldownClaims[key] = `claim-${kind}`;
    messages.push({ id: kind, to: [email], subject: `author ${kind === "comment" ? "commented on" : "suggested an edit to"} “${docId}”` });
    for (let i = 0; i < n; i++) {
      const invocation = `${kind}-${i}`, path = `docs/${docId}/versions/v1/annotations/${invocation}/comments/opener`;
      writes.push({ path, kind, stored: { authorEmail: "author@e2e.invalid", ...(kind === "suggestion" ? { opensSuggestion: true } : {}) } });
      const add = (payload, phase, at) => logs.push({ insertId: `${invocation}-${payload.marker}-${phase}`, resource: { type: "cloud_run_revision", labels: { project_id: deployment.projectId, service_name: deployment.service, revision_name: deployment.revision } }, labels: { instanceId: "same-instance", execution_id: invocation, "firebase-functions-hash": deployment.functionHash }, jsonPayload: { ...payload, phase, at } });
      const trigger = { marker: "e2e-real-trigger", execution: `trigger-${invocation}`, eventId: invocation, params: { docId }, subject: `documents/${path}` };
      add(trigger, "start", i); add(trigger, "end", 100 + i);
      const call = { marker: "e2e-cooldown-call", execution: `call-${invocation}`, uid, docId, kind };
      add(call, "start", 10 + i); add({ ...call, granted: i === 0 }, "result", 80 + i); add(call, "end", 90 + i);
    }
  }
  return { n, docId, uid, email, deployment, writes, logs, messages, recipient };
}

export function controlledFixture() {
  const x = fixture(), gate = {mode:"controlled",expected:4,uid:x.uid,deadline:100,releaseAt:9,arrivals:{}};
  for (const row of x.logs.filter(r=>r.jsonPayload.marker==="e2e-cooldown-call" && r.jsonPayload.phase==="start")) {
    const p=row.jsonPayload;
    gate.arrivals[p.execution]={uid:x.uid,kind:p.kind,at:2};
    x.logs.push({...row,insertId:row.insertId+"-gate",jsonPayload:{marker:"e2e-cooldown-gate",phase:"released",execution:p.execution,uid:x.uid,docId:x.docId,kind:p.kind,arrivedAt:2,releaseAt:9,at:9}});
  }
  x.controlled={path:`e2eCooldownGates/${x.docId}`,gate};return x;
}

export function mutationFixture() {
  const x=controlledFixture();
  for(const r of x.logs.filter(r=>r.jsonPayload.phase==="result"))r.jsonPayload.granted=true;
  x.messages=x.messages.flatMap(m=>[m,{...m,id:m.id+"-duplicate"}]);return x;
}
