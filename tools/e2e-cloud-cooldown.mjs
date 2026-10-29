// SPDX-License-Identifier: Apache-2.0
// Judge real automatic trigger and cooldown overlap from retained Cloud Logging rows and isolated fixture state (SPEC §14).

import assert from "node:assert/strict";

const need = (ok, why) => { if (!ok) throw new Error(`cloud cooldown: ${why}`); };
const text = x => typeof x === "string" && x.length > 0;
function intervals(rows, marker, phases, deployment) {
  const grouped = new Map();
  for (const row of rows.filter(r => r.jsonPayload?.marker === marker)) {
    const p = row.jsonPayload, labels = row.resource?.labels;
    need(row.resource?.type === "cloud_run_revision" && labels?.project_id === deployment.projectId && labels.service_name === deployment.service && labels.revision_name === deployment.revision && row.labels?.["firebase-functions-hash"] === deployment.functionHash, "log belongs to another deployment");
    need(text(row.insertId) && text(row.labels?.instanceId) && text(row.labels?.execution_id) && text(p.execution) && Number.isFinite(p.at), "log lacks execution identity or time");
    need(phases.includes(p.phase), "unexpected execution phase");
    const group = grouped.get(p.execution) ?? { instance: row.labels.instanceId, invocation: row.labels.execution_id, phases: {} };
    need(group.instance === row.labels.instanceId && group.invocation === row.labels.execution_id && !group.phases[p.phase], "duplicate phase or changing execution identity");
    group.phases[p.phase] = p;
    grouped.set(p.execution, group);
  }
  return [...grouped.values()].map(g => {
    need(phases.every(p => g.phases[p]), "unfinished execution");
    const { start, end, result } = g.phases;
    need(start.at <= end.at && (!result || start.at <= result.at && result.at <= end.at), "execution time is reversed");
    const identity = p => Object.fromEntries(Object.entries(p).filter(([k]) => !["phase", "at", "granted"].includes(k)));
    for (const p of Object.values(g.phases)) assert.deepEqual(identity(p), identity(start), "cloud cooldown: execution payload changed");
    return { ...g, start, end, result };
  });
}
function peak(rows) {
  // Compare clocks only within the same running instance. Equal endpoints do
  // not overlap; different machines' wall clocks cannot establish a race.
  return Math.max(0, ...rows.map(r => rows.filter(s => s.instance === r.instance && s.start.at <= r.start.at && r.start.at < s.end.at).length));
}

/** A controlled wait is outside the measured call; every release is tied to its real invocation. */
function verifyControlledTrial(trial, calls) {
  const { controlled, logs, deployment, docId, uid, n } = trial;
  const rows = logs.filter(r => r.jsonPayload?.marker === "e2e-cooldown-gate");
  if (!controlled) { need(rows.length === 0, "controlled invocation lacks gate evidence"); return; }
  const gate = controlled.gate;
  need(controlled.path === `e2eCooldownGates/${docId}` && gate?.mode === "controlled" && gate.uid === uid && gate.expected === 2 * n, "controlled gate identity differs");
  need(Number.isFinite(gate.releaseAt) && Number.isFinite(gate.deadline) && gate.releaseAt < gate.deadline, "controlled release is absent or expired");
  need(calls.length === 2 * n && rows.length === calls.length && Object.keys(gate.arrivals ?? {}).length === calls.length, "controlled arrival/release census differs");
  for (const c of calls) {
    const arrival = gate.arrivals[c.start.execution], matches = rows.filter(r => r.jsonPayload.execution === c.start.execution);
    need(arrival?.uid === uid && arrival.kind === c.start.kind && Number.isFinite(arrival.at) && arrival.at < gate.releaseAt && matches.length === 1, "controlled arrival does not own one release");
    const row = matches[0], p = row.jsonPayload, labels = row.resource?.labels;
    need(row.resource?.type === "cloud_run_revision" && labels?.project_id === deployment.projectId && labels.service_name === deployment.service && labels.revision_name === deployment.revision && row.labels?.["firebase-functions-hash"] === deployment.functionHash && row.labels.instanceId === c.instance && row.labels.execution_id === c.invocation, "controlled release belongs to another runtime");
    need(p.phase === "released" && p.docId === docId && p.uid === uid && p.kind === c.start.kind && p.arrivedAt === arrival.at && p.releaseAt === gate.releaseAt && Number.isFinite(p.at) && gate.releaseAt <= p.at && p.at <= c.start.at, "controlled wait overlaps the measured call or its identity differs");
  }
}

export function judgeCloudCooldownTrial(trial) {
  const { n, docId, uid, email, writes, logs, messages, deployment, recipient } = trial;
  need(Number.isInteger(n) && n >= 2 && /^e2e-/.test(docId) && /^e2e-/.test(uid) && email === `${uid}@e2e.invalid`, "fixture boundary or participant count differs");
  need(text(deployment?.projectId) && deployment.service?.startsWith("e2e") && deployment.revision?.startsWith(`${deployment.service}-`) && deployment.database?.startsWith("e2e-") && /^[a-f0-9]{40}$/.test(deployment.functionHash), "deployment is not an isolated test service/database");
  need(Array.isArray(writes) && writes.length === 2 * n && new Set(writes.map(w => w.path)).size === writes.length, "missing or duplicate writes");
  for (const kind of ["comment", "suggestion"]) need(writes.filter(w => w.kind === kind).length === n, "wrong notice-kind census");
  need(writes.every(w => w.path.startsWith(`docs/${docId}/versions/v1/annotations/`) && w.path.endsWith("/comments/opener") && w.stored?.authorEmail?.endsWith("@e2e.invalid") && (w.stored.opensSuggestion === true) === (w.kind === "suggestion")), "stored comment differs from fixture");
  need(Array.isArray(logs) && new Set(logs.map(r => r.insertId)).size === logs.length, "duplicate logging records");
  const triggers = intervals(logs, "e2e-real-trigger", ["start", "end"], deployment);
  const calls = intervals(logs, "e2e-cooldown-call", ["start", "result", "end"], deployment);
  need(triggers.length >= writes.length && calls.length === triggers.length, "missing trigger or cooldown executions");
  need(new Set(triggers.map(t => t.invocation)).size === triggers.length && new Set(calls.map(c => c.invocation)).size === calls.length, "duplicate runtime invocation");
  const subjects = new Set(triggers.map(t => t.start.subject));
  assert.deepEqual([...subjects].sort(), writes.map(w => `documents/${w.path}`).sort(), "cloud cooldown: delivered event census differs");
  for (const t of triggers) {
    need(text(t.start.eventId) && t.start.params?.docId === docId, "automatic event lacks its document identity");
    const matches = calls.filter(c => c.invocation === t.invocation && c.instance === t.instance);
    need(matches.length === 1, "trigger does not own exactly one cooldown call");
    const c = matches[0], write = writes.find(w => `documents/${w.path}` === t.start.subject);
    need(c.start.docId === docId && c.start.uid === uid && c.start.kind === write.kind && typeof c.result.granted === "boolean" && t.start.at <= c.start.at && c.end.at <= t.end.at, "cooldown belongs to another recipient, kind or trigger interval");
  }
  need(recipient?.email === email && recipient.emailNotifications !== false, "recipient was not eligible");
  need(Array.isArray(messages) && messages.length === 2 && new Set(messages.map(m => m.id)).size === 2, "expected exactly one captured message per kind");
  const peaks = {};
  for (const kind of ["comment", "suggestion"]) {
    const same = calls.filter(c => c.start.kind === kind);
    peaks[kind] = peak(same);
    need(same.filter(c => c.result.granted).length === 1, `${kind} cooldown granted more or less than once`);
    const key = kind === "comment" ? docId : `${docId}:suggestions`;
    need(Number.isFinite(recipient.emailCooldowns?.[key]) && text(recipient.emailCooldownClaims?.[key]), "committed cooldown receipt missing");
    const selected = messages.filter(m => typeof m.subject === "string" && m.subject.includes(kind === "comment" ? " commented on “" : " suggested an edit to “"));
    const to = selected.length === 1 && (typeof selected[0].to === "string" ? [selected[0].to] : selected[0].to);
    need(selected.length === 1 && selected[0].subject.endsWith(`“${docId}”`) && JSON.stringify(to) === JSON.stringify([email]), "notice recipient, kind or document differs");
  }
  verifyControlledTrial(trial, calls);
  // Check safety before timing: a missed race must not hide a real failure.
  need(peak(triggers) >= 2, "automatic triggers did not overlap");
  for (const kind of ["comment", "suggestion"]) need(peaks[kind] >= 2, `${kind} cooldown calls did not overlap on one instance`);
  return { triggers: triggers.length, calls: calls.length, peakTriggers: peak(triggers), peakCalls: peaks, messages: messages.length, ...(trial.controlled ? { controlled: true } : {}) };
}


/** The known guard-removal control must fail for duplicate notices, with actual post-gate overlap. */
export function judgeCloudCooldownMutation(trial) {
  let failure;
  try { judgeCloudCooldownTrial(trial); } catch (error) { failure = error.message; }
  need(failure === "cloud cooldown: expected exactly one captured message per kind", "mutation did not expose duplicate notices at the intended assertion");
  const calls = intervals(trial.logs, "e2e-cooldown-call", ["start", "result", "end"], trial.deployment);
  need(trial.controlled && calls.length === 2 * trial.n && calls.every(c => c.result.granted) && trial.messages.length === 2 * trial.n, "mutation did not grant and send every contending call");
  verifyControlledTrial(trial, calls);
  for (const kind of ["comment", "suggestion"]) {
    need(peak(calls.filter(c => c.start.kind === kind)) >= 2, "mutation cooldown calls did not overlap");
    const notices = trial.messages.filter(m => m.subject?.includes(kind === "comment" ? " commented on “" : " suggested an edit to “"));
    need(notices.length === trial.n && notices.every(m => m.subject.endsWith(`“${trial.docId}”`) && JSON.stringify(typeof m.to === "string" ? [m.to] : m.to) === JSON.stringify([trial.email])), "mutation notice identity or kind differs");
  }
  return { calls: calls.length, messages: trial.messages.length, controlled: true };
}
