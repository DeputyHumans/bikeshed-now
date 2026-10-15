// SPDX-License-Identifier: Apache-2.0
// Bind a reviewed C14 serialization-safety assessment to all natural and controlled axes without converting a missing natural witness into PASS (SPEC §6a, §19, §22).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseExpandedCase, readControl, findTarget } from "../e2e/lib/controls.mjs";
import { PLAN_TRIALS } from "../e2e/lib/budget.mjs";
import { readResults } from "../e2e/lib/report.mjs";
import { assertPublicationBaseline, assertPublicationPreserved, isPublicationReviewRefusal } from "../e2e/lib/publication-oracles.mjs";
import { assertBrowserFeedback } from "../e2e/lib/feedback-oracles.mjs";
import { verifyFinishedRun } from "./e2e-run-completion.mjs";
import { C15_JUDGE } from "./e2e-local-limit.mjs";

export const COMPOSITE_ID = "c14-natural-and-forced-serialization";
export const COMPOSITE_ITEM = "W2-C14-SYNC-T-judges";
export const C14_FILE = "e2e/specs/concurrency/c13-feedback.spec.mjs";
export const C14_CASES = Object.freeze({
  natural: "C14 SYNC-T: N agents' comments and suggestions (in turn), N threads opened in the browser and the owner's agent's commit_draft fired at one instant; every answer is a thread made on v1, or, once the commit published, on v2 or a refusal for the newer version; each is where it was told, the commit is refused exactly when feedback reached v1 first, and no suggestion is left behind",
  conditional: "C14 judge (SYNC-T, agent comments): when the commit published, no thread an add_comment opened in the race is left unresolved on the version it replaced",
  browser: "C14 judge (SYNC-T, web threads): browser feedback stays on its selected version and passage when publication races it",
  "comment-held": "C14 comment held: N add_comment calls held after reading v1 and finding their passage, while the owner's agent's commit_draft publishes v2, then released; the commit publishes and every call answers",
  "suggestion-held": "C14 suggestion held: N suggest_edit calls held after their pending count, while the owner's agent's commit_draft publishes v2, then released; each is refused for the newer version and none is left pending on v1",
  "commit-held-agent": "C14 commit held: the owner's agent's commit_draft held after its open-thread check and upload while N agents' comments land on v1, then released; its transaction refuses it for the open comments and nothing is left behind",
  "commit-held-web": "C14 commit held, web threads: the owner's agent's commit_draft held after its open-thread check and upload while N threads are opened on v1 in the browser (through the rules), then released; its transaction refuses it for the open threads and nothing is left behind",
});
export const C14_CONTROLS = Object.freeze(["controls-c14-comment-head", "controls-c14-left-behind", "controls-c14-historical-comment", "controls-c14-refusal-draft-metadata", "controls-c14-refusal-draft-bytes", "controls-c14-refusal-version-metadata", "controls-c14-refusal-version-bytes", "controls-c14-refusal-reason", "controls-c14-suggestion-head", "controls-c14-browser-recheck"]);
const NS = [2, 5, 10, 20], FORCED = ["comment-held", "suggestion-held", "commit-held-agent", "commit-held-web"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(`C14 composite: ${message}`); };
const pass = c => c?.status === "pass" && !c.error && !c.todo && !c.inconclusive && !c.notReproduced && !c.skipReason && (!c.outcome || c.outcome === "PASS");
const fail = c => c?.status === "fail" && !c.todo && !c.inconclusive && !c.notReproduced && !c.skipReason && (!c.outcome || c.outcome === "FAIL");
const incomplete = c => c?.status === "inconclusive" && typeof c.inconclusive === "string" && !c.error && !c.todo && !c.notReproduced && !c.skipReason && !c.outcome;
const key = c => `${c.id}::${c.n}::${c.trial}`;
const openRefusal = isPublicationReviewRefusal;
const published = c => c?.status === 200 && c.isError === false && c.json?.versionId === "v2" && c.json.deduped !== true;
const scenario = (c, name) => { const p = parseExpandedCase(c.id); return c.file === C14_FILE && p?.scenario === `${C14_FILE}::${name}` && p.n === c.n && (p.trial ?? 1) === c.trial; };
const observedKey = (path, c) => `${path}::${key(c)}`;
function local(root, path) {
  need(typeof path === "string" && !isAbsolute(path) && !path.includes("\\") && !relative(root, resolve(root, path)).startsWith(".."), "artifact must stay repository-relative");
  return resolve(root, path);
}
const read = (root, ref) => { const bytes = readFileSync(local(root, ref?.artifact)); need(sha(bytes) === ref.sha256, "artifact digest differs"); return bytes; };
const bound = (root, path) => ({ artifact: path, sha256: sha(readFileSync(local(root, path))) });
const scope = campaign => { const item = campaign.items.find(i => i.id === COMPOSITE_ITEM); need(item, "original item is absent"); return { claim: item.claim, baseline: item.baseline, requiredCases: item.requiredCases, originalRequiredCases: item.originalRequiredCases }; };
const requirementHash = campaign => sha(JSON.stringify(campaign.acceptance.requirements.map(({ proofs, ...row }) => row)));
function sourceMatches(campaign, actual, label) { for (const field of ["revision", "version", "fingerprint"]) need(actual?.[field] === campaign.acceptance[field], `${label} ${field} differs from frozen acceptance`); }
function stackMatches(campaign, stack) { sourceMatches(campaign, { revision: stack.fingerprint?.baseSha, version: stack.expectVersion, fingerprint: stack.fingerprint?.sha256 }, "stack"); }
function bindRun(root, axis, path) {
  const report = JSON.parse(readFileSync(local(root, path), "utf8")), dir = dirname(path);
  return { axis, n: report.invocation?.n?.[0], report: bound(root, path), invocation: bound(root, `${dir}/invocation.json`), measurements: bound(root, `${dir}/c13-feedback.jsonl`), stack: bound(root, `e2e/.out/${report.runId}/stack.json`), reporter: readResults(local(root, dir)).files.map(name => bound(root, `${dir}/${name}`)) };
}

/** Capture references only; no run, case or original obligation is changed. */
export function captureComposite(campaign, manifest, { root, source, observedAt = new Date().toISOString() }) {
  sourceMatches(campaign, source, "capture");
  const runs = ["natural", "forced"].flatMap(axis => (manifest[axis] ?? []).map(path => bindRun(root, axis, path)));
  const controlLedgers = (manifest.controlLedgers ?? []).map(path => bound(root, path));
  const controls = C14_CONTROLS.map(set => {
    const c = campaign.controls.find(c => c.set === set); need(c, `missing imported control ${set}`);
    const proof = id => { const p = campaign.proofs.find(p => p.id === id); need(p, `missing control proof ${id}`); const report = JSON.parse(readFileSync(local(root, p.artifact), "utf8")); return { id, report: bound(root, p.artifact), stack: bound(root, `e2e/.out/${report.runId}/stack.json`) }; };
    return { set, id: c.id, definition: bound(root, `e2e/patches/${set}/control.json`), red: proof(c.red), green: proof(c.green) };
  });
  const artifact = { schemaVersion: 1, kind: "composite-c14-serialization-safety", id: COMPOSITE_ID, command: "node tools/e2e-campaign-evidence.mjs capture-composite", source, observedAt, original: scope(campaign), requirementsSha256: requirementHash(campaign), runs, controls, controlLedgers };
  verifyCompositeArtifact(campaign, artifact, { root });
  return artifact;
}

function snapshots(row) {
  assertPublicationBaseline(row.before);
  need(row.after && row.after.liveEpoch && Array.isArray(row.after.versions), "after snapshot is incomplete");
  for (const snapshot of [row.before, row.after]) {
    const lists = [...snapshot.versions.map(v => v.objects), snapshot.draftObjects];
    for (const objects of lists) need(Array.isArray(objects) && new Set(objects.map(o => o.key)).size === objects.length && objects.every(o => typeof o.key === "string" && o.key.startsWith(`docs/${row.docId}/`) && Number.isSafeInteger(o.size) && o.size >= 0 && /^[a-f0-9]{64}$/.test(o.sha256)), "snapshot object inventory is incomplete or ambiguous");
  }
  if (row.outcome === "refused") assertPublicationPreserved(row.before, row.after);
  else {
    need(row.after.currentVersion === "v2" && row.after.draft === null && row.after.draftObjects.length === 0, "publication did not install v2 and consume the draft");
    assert.deepEqual(row.after.versions.map(v => v.id), ["v1", "v2"], "C14 composite: actual v2 inventory is absent");
    assert.deepEqual(row.after.versions[0], row.before.versions[0], "C14 composite: publication changed v1");
    const v2 = row.after.versions[1]; need(v2.metadata?.entry && v2.objects.some(o => o.key.endsWith(`/${v2.metadata.entry}`)), "published version has no entry bytes");
  }
}
function measurement(row, n, kind) {
  need(row.schemaVersion === 1 && row.judged === true && row.kind === kind && typeof row.docId === "string" && row.docId, "missing judged measurement");
  const won = row.outcome === "published";
  need(won ? published(row.commit) : row.outcome === "refused" && openRefusal(row.commit), "generic error or unproved publication is not safe serialization");
  snapshots(row);
  const state = row.state, answers = row.answers;
  need(state?.current === (won ? "v2" : "v1") && Array.isArray(state.threads) && Array.isArray(answers) && answers.length === (kind === "natural" ? 2 * n : n), "feedback measurement count or current version differs");
  assert.deepEqual(state.versions, row.after.versions.map(v => v.id), "C14 composite: feedback and snapshot version inventories differ");
  need(state.hasDraft === !!row.after.draft, "feedback and snapshot draft presence differs");
  need(new Set(answers.map(a => a.who)).size === answers.length && answers.every(a => typeof a.who === "string" && a.status === 200 && typeof a.isError === "boolean"), "feedback answers omit a caller or carry a transport failure");
  const web = answers.filter(a => a.what === "web thread"), comments = answers.filter(a => a.what === "add_comment"), suggestions = answers.filter(a => a.what === "suggest_edit");
  need(kind === "natural" ? web.length === n && comments.length === Math.ceil(n / 2) && suggestions.length === Math.floor(n / 2) : kind === "commit-held-web" ? web.length === n : kind === "suggestion-held" ? suggestions.length === n : comments.length === n, "feedback request kinds differ from the required mixed burst or held leg");
  need(new Set(state.threads.map(t => t.annId)).size === state.threads.length, "duplicate stored thread identities");
  for (const answer of answers) {
    if (!answer.isError) {
      const thread = state.threads.find(t => t.annId === answer.json?.threadId);
      need(thread && thread.version === answer.json.version, "feedback was not stored where its response said");
      need(won || answer.json.version === "v1", "a refused publication invented a newer feedback version");
    } else need(won && answer.what !== "web thread" && /newer version/i.test(answer.text), "feedback refusal is unrelated to a published newer version");
  }
  need(!state.threads.some(t => t.open && t.version !== state.current && (t.kind === "suggestion" || t.channel === "mcp")), "open current-only feedback was left behind");
  if (kind === "natural" || kind === "commit-held-web") assertBrowserFeedback(state, answers);
  if (kind === "natural") {
    need(row.race?.kind === "sync-t" && Number.isFinite(row.race.spreadMs) && row.race.spreadMs >= 0 && row.race.spreadMs <= 15 && Number.isFinite(row.race.overlapMarginMs) && row.race.overlapMarginMs > 0, "natural requests did not actually overlap");
    need(won || state.threads.some(t => t.version === "v1" && t.open), "review refusal had no open feedback");
  } else {
    const gate = kind === "comment-held" ? "comment-before-write" : kind === "suggestion-held" ? "suggest-after-count" : "commit-before-tx", count = kind.startsWith("commit-held") ? 1 : n;
    need(row.race?.kind === "gate" && row.race.gate === gate && row.race.held === count && row.race.released === count, "wrong gate or incomplete hold/release receipt");
    if (kind.startsWith("commit-held")) need(!won && /^Resolve all comments before publishing a new version\.$/.test(row.commit.text) && answers.every(a => !a.isError && a.json.version === "v1"), "transaction recheck was not exercised after all threads landed");
    else need(won && row.commit.currentWhileHeld === "v2", "v2 was not observed while feedback remained held");
    if (kind === "suggestion-held") need(answers.every(a => a.isError && /^This document has a newer version\. Reload, then suggest the edit on it\.$/.test(a.text)), "stale suggestions did not all refuse");
  }
}

/** All positive N/trials are mandatory; control axes remain exactly their declared catalog targets. */
export function verifyCompositeArtifact(campaign, artifact, { root }) {
  need(artifact?.schemaVersion === 1 && artifact.kind === "composite-c14-serialization-safety" && artifact.id === COMPOSITE_ID && artifact.command === "node tools/e2e-campaign-evidence.mjs capture-composite", "unsupported adjudication artifact");
  sourceMatches(campaign, artifact.source, "artifact");
  need(campaign.items.find(i => i.id === COMPOSITE_ITEM)?.state === "in-progress", "original item must remain in-progress, never resolved by the composite");
  assert.deepEqual(artifact.original, scope(campaign), "C14 composite: original observation or requirement changed");
  const required = ["conditional", "browser"].flatMap(kind => NS.map(n => ({ caseId: `${C14_FILE}::${C14_CASES[kind]}`, n })));
  assert.deepEqual(artifact.original.requiredCases, required, "C14 composite: every original conditional N requirement must remain");
  need(artifact.requirementsSha256 === requirementHash(campaign), "acceptance requirements changed");
  const expected = ["natural", "forced"].flatMap(axis => NS.map(n => `${axis}:${n}`));
  assert.deepEqual(artifact.runs.map(r => `${r.axis}:${r.n}`).sort(), expected.sort(), "C14 composite: all four natural and forced N cells are required exactly once");
  const observations = [], axes = [], documents = new Set();
  for (const ref of artifact.runs) {
    const report = JSON.parse(read(root, ref.report)), stack = JSON.parse(read(root, ref.stack)), dir = dirname(ref.report.artifact), inv = report.invocation;
    const done = JSON.parse(read(root, ref.invocation));
    need(ref.invocation.artifact === `${dir}/invocation.json` && ref.measurements.artifact === `${dir}/c13-feedback.jsonl` && ref.stack.artifact === `e2e/.out/${report.runId}/stack.json`, "run artifact belongs to another invocation");
    need(!dir.includes("/scratch/") && inv?.suite === "concurrency" && !inv.grep && inv.trials === null && JSON.stringify(inv.n) === JSON.stringify([ref.n]), "authoring, scratch, filtered or wrong-axis run");
    need(ref.axis === "natural" ? inv.spec?.length === 0 : inv.plan?.length === 1 && JSON.stringify(inv.plan[0].files) === JSON.stringify([C14_FILE]), "wrong natural/forced selection");
    stackMatches(campaign, stack);
    assert.deepEqual((stack.patches ?? []).map(p => p.set ?? p), ref.axis === "natural" ? [] : ["amplify-c08-mint-races", "amplify-c13-feedback"], "C14 composite: wrong positive patch configuration");
    for (const cap of ["local", ...(ref.axis === "forced" ? ["gates", "patch:amplify-c13-feedback"] : [])]) need(inv.capabilities?.includes(cap), `missing ${cap} capability`);
    const rawFiles = readResults(local(root, dir)).files.map(name => `${dir}/${name}`).sort();
    assert.deepEqual(ref.reporter.map(r => r.artifact).sort(), rawFiles, "C14 composite: final reporter inventory differs");
    ref.reporter.forEach(r => read(root, r));
    const hasInc = report.cases.some(incomplete);
    verifyFinishedRun(report, local(root, ref.report.artifact), { expectedExit: hasInc ? 3 : 0 });
    need(Number.isFinite(Date.parse(artifact.observedAt)) && Date.parse(artifact.observedAt) >= Date.parse(done.endedAt), "capture predates completed run");
    const rows = read(root, ref.measurements).toString().trim().split("\n").map(line => JSON.parse(line));
    const relevant = rows.filter(r => r.ref === "C14 composite");
    need(relevant.every(r => r.n === ref.n && Number.isInteger(r.trial) && r.trial >= 1 && r.trial <= PLAN_TRIALS[ref.n]), "measurement carries an extra N or trial");
    const selected = new Set();
    for (let trial = 1; trial <= PLAN_TRIALS[ref.n]; trial++) {
      const get = kind => { const found = report.cases.filter(c => c.n === ref.n && c.trial === trial && scenario(c, C14_CASES[kind])); need(found.length === 1, `missing/duplicate ${kind} N=${ref.n} trial=${trial}`); return found[0]; };
      const work = get("natural"), judge = get("conditional"); need(pass(work) && pass(get("browser")), "ordinary natural/browser assertions did not pass");
      const attempts = relevant.filter(r => r.kind === "natural" && r.n === ref.n && r.trial === trial && r.case === work.name);
      need(attempts.length >= 1 && attempts.length <= 3 && attempts.every((r, i) => r.attempt === i + 1), "natural attempts are missing or out of order");
      for (const [i, row] of attempts.entries()) { measurement(row, ref.n, "natural"); need(i === attempts.length - 1 || row.outcome === "refused", "retry hid an already achieved natural window"); selected.add(row); }
      const last = attempts.at(-1), won = last.outcome === "published";
      if (won) need(pass(judge), "observed natural publication judge did not pass");
      else {
        need(attempts.length === 3 && incomplete(judge) && judge.inconclusive === `the commit was refused (${String(last.commit.text).slice(0, 120)}): feedback reached v1 first, so no version replaced v1 in this race and nothing could be left behind on it`, "unrelated incomplete result or missing bounded attempts");
        observations.push(observedKey(ref.report.artifact, judge));
      }
      const summary = rows.filter(r => r.ref === "C14 SYNC-T" && r.n === ref.n && r.trial === trial && r.case === work.name && r.naturalAttempts);
      need(summary.length === attempts.length, "per-attempt diagnostics do not match retained measured attempts");
      for (const [prefix, entry] of summary.entries()) {
        const expected = attempts.slice(0, prefix + 1).map((row, i) => ({ attempt: i + 1, outcome: row.outcome === "published" ? "achieved" : "window-missed", diagnostic: { state: row.state, answers: row.answers, commit: row.commit, published: row.outcome === "published" } }));
        assert.deepEqual(entry.naturalAttempts, expected, "C14 composite: cumulative attempt diagnostics differ from measured outcome");
      }
      const bursts = rows.filter(r => r.ref === "request burst" && r.n === ref.n && r.trial === trial && r.case === work.name && r.label === "feedback and commit");
      need(bursts.length === attempts.length, "natural request timing rows are missing");
      for (const [i, burst] of bursts.entries()) {
        const timing = burst.timing;
        need(Array.isArray(timing) && timing.length === 2 * ref.n + 1 && new Set(timing.map(r => r.i)).size === timing.length && timing.every(r => !r.error && r.status !== 504 && [r.firedAt, r.sentAt, r.firstByteAt, r.endAt].every(Number.isFinite) && r.firedAt <= r.sentAt && r.sentAt <= r.firstByteAt && r.firstByteAt <= r.endAt), "natural request timing inventory is incomplete");
        const spread = Math.max(...timing.map(r => r.firedAt)) - Math.min(...timing.map(r => r.firedAt));
        const margin = Math.min(...timing.map(r => r.firstByteAt)) - Math.max(...timing.map(r => r.sentAt));
        need(burst.overlap?.ok === true && spread <= 15 && margin > 0 && Math.round(spread * 100) / 100 === attempts[i].race.spreadMs && Math.round(margin * 10) / 10 === attempts[i].race.overlapMarginMs, "natural timing does not prove the measured simultaneous overlap");
        const row = attempts[i];
        assert.deepEqual(timing.map(({ who, what, status }) => ({ who, what, status })), [...row.answers, row.commit].map(({ who, what, status }) => ({ who, what, status })), "C14 composite: measured timing belongs to different requests");
        assert.deepEqual(summary.at(-1).naturalAttempts[i].diagnostic, { state: row.state, answers: row.answers, commit: row.commit, published: row.outcome === "published" }, "C14 composite: retained attempt diagnostics differ from measured outcome");
      }
      axes.push({ axis: ref.axis, n: ref.n, trial, naturalPublisherFirstObserved: won, attempts: attempts.length });
      if (ref.axis === "forced") for (const kind of FORCED) { const c = get(kind); need(pass(c), `forced ${kind} did not pass`); const measured = relevant.filter(r => r.kind === kind && r.n === ref.n && r.trial === trial && r.case === c.name); need(measured.length === 1, `forced ${kind} observation absent or duplicate`); measurement(measured[0], ref.n, kind); selected.add(measured[0]); }
    }
    need(selected.size === relevant.length, "unaccounted composite measurement rows");
    for (const row of selected) { need(!documents.has(row.docId), "an attempt reused a fixture document"); documents.add(row.docId); }
    for (const c of report.cases) need(pass(c) || c.status === "skip" && !c.todo && !c.inconclusive && !c.notReproduced || observations.includes(observedKey(ref.report.artifact, c)) || incomplete(c) && scenario(c, C15_JUDGE), "unrelated failed or incomplete case cannot be adjudicated");
  }
  verifyControls(campaign, artifact, root);
  need(observations.length > 0, "no missing natural witness needs this adjudication");
  return { observations, axes, unresolvedNaturalWitness: { id: COMPOSITE_ID, item: COMPOSITE_ITEM, reason: "Natural publication-first reachability/frequency remains unobserved for the listed axes; controlled serialization safety does not establish that witness.", observations } };
}

function verifyControls(campaign, artifact, root) {
  assert.deepEqual(artifact.controls.map(c => c.set).sort(), [...C14_CONTROLS].sort(), "C14 composite: exact directional controls are required");
  const ledgers = artifact.controlLedgers.map(ref => JSON.parse(read(root, ref)));
  for (const ledger of ledgers) need(ledger.ok === true && Number.isFinite(Date.parse(ledger.endedAt)) && Date.parse(artifact.observedAt) >= Date.parse(ledger.endedAt) && !ledger.interrupted && ledger.commit === campaign.acceptance.revision, "control ledger is unfinished or uses another source");
  for (const ref of artifact.controls) {
    const control = campaign.controls.find(c => c.id === ref.id && c.set === ref.set); need(control, "control mapping is absent");
    need(ref.definition.artifact === `e2e/patches/${ref.set}/control.json`, "control definition path differs"); read(root, ref.definition);
    const definition = readControl(ref.set, resolve(root, "e2e/patches"));
    const selected = {};
    for (const color of ["red", "green"]) {
      const p = campaign.proofs.find(p => p.id === ref[color].id); need(p?.kind === "e2e-case" && p.id === control[color] && p.artifact === ref[color].report.artifact, "control proof identity differs");
      sourceMatches(campaign, p, "control proof");
      const report = JSON.parse(read(root, ref[color].report)), stack = JSON.parse(read(root, ref[color].stack)); stackMatches(campaign, stack);
      need(ref[color].stack.artifact === `e2e/.out/${report.runId}/stack.json` && report.runId === p.runId && report.invocation.id === p.invocation, "control run identity differs");
      need(report.malformed?.length === 0, "malformed control report");
      const c = findTarget(report.cases, definition); need(c && c.id === `${c.file}::${c.name}` && report.cases.filter(r => key(r) === key(c)).length === 1 && p.caseId === c.id && p.n === c.n && p.trial === c.trial, "control does not target its catalog case and axis");
      need(color === "red" ? p.outcome === "FAIL" && fail(c) && (stack.patches ?? []).some(s => (s.set ?? s) === ref.set) : p.outcome === "PASS" && pass(c) && (stack.patches ?? []).every(s => (s.set ?? s).startsWith("amplify-")), "control lacks intended red or clean green");
      selected[color] = c;
    }
    need(key(selected.red) === key(selected.green), "control pair has different cases or axes");
    const message = typeof selected.red.error === "string" ? selected.red.error : selected.red.error?.message;
    need(typeof message === "string" && new RegExp(definition.expect.message).test(message) && message.includes(control.assertion), "red did not fail the intended assertion");
    const entries = ledgers.flatMap(ledger => ledger.controls.filter(r => r.set === ref.set).map(row => ({ ledger, row })));
    need(entries.length === 1 && entries[0].row.ok === true, "control is missing, duplicated or invalid in actual ledgers");
    const { ledger, row } = entries[0], greens = ledger.green.filter(g => g.sets.includes(ref.set));
    const absolute = path => resolve(root, path);
    need(greens.length === 1 && absolute(row.red.invocationDir) === dirname(local(root, ref.red.report.artifact)) && absolute(greens[0].invocationDir) === dirname(local(root, ref.green.report.artifact)), "control ledger does not bind the recorded pair");
  }
}

export function compositeReference(root, artifact, reportPath) { return { id: COMPOSITE_ID, ...bound(root, artifact), report: reportPath }; }
export function verifyComposite(campaign, proof, loaded, { root }) {
  need(proof.kind === "e2e-run" && proof.outcome === "COMPOSITE-SAFETY" && proof.composite?.id === COMPOSITE_ID && proof.composite.report === proof.artifact, "only the named run-level assessment is supported");
  const artifact = JSON.parse(read(root, proof.composite)), result = verifyCompositeArtifact(campaign, artifact, { root });
  const ref = artifact.runs.find(r => r.report.artifact === proof.artifact); need(ref, "proof is not one of the adjudicated runs");
  assert.deepEqual(JSON.parse(read(root, ref.report)), loaded.report, "C14 composite: supplied report differs");
  assert.deepEqual(JSON.parse(read(root, ref.stack)), loaded.stack, "C14 composite: supplied stack differs");
  return { ...result, observations: loaded.report.cases.filter(c => result.observations.includes(observedKey(proof.artifact, c))).map(key) };
}
