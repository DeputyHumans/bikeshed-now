// SPDX-License-Identifier: Apache-2.0
// Validate the local E2E campaign ledger and refuse completion without current cases and negative controls (SPEC §12).

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseExpandedCase } from "../e2e/lib/controls.mjs";
import { commandCounts } from "./e2e-campaign-evidence.mjs";
import { verifyLocalLimit } from "./e2e-local-limit.mjs";
import { verifyComposite, COMPOSITE_ITEM } from "./e2e-c14-composite.mjs";
import { verifyCompletedRun } from "./e2e-run-completion.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATES = new Set(["open", "in-progress", "resolved", "historical-closed"]);
const KINDS = new Set(["fixed", "coverage-repair", "intentional", "refuted", "local-limit"]);
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const text = (x) => typeof x === "string" && x.trim().length > 0;
const array = (x) => Array.isArray(x) ? x : [];
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const purePass = (c) => c.status === "pass" && !c.todo && !c.skipReason && !c.inconclusive && !c.notReproduced && !c.error && (!c.outcome || c.outcome === "PASS");
const pureFail = (c) => c.status === "fail" && !c.todo && !c.skipReason && !c.inconclusive && !c.notReproduced && (!c.outcome || c.outcome === "FAIL");
const key = (c) => `${c.id}::${c.n ?? "-"}::${c.trial ?? 1}`;

/** Match the canonical scenario while retaining and validating the artifact's expanded identity. */
function affectedCaseMatches(proof, required) {
  if ((proof.n ?? null) !== (required.n ?? null)) return false;
  const expanded = parseExpandedCase(proof.caseId);
  if (expanded && (expanded.n !== proof.n || (expanded.trial ?? 1) !== (proof.trial ?? 1))) return false;
  return proof.caseId === required.caseId || expanded?.scenario === required.caseId;
}

/** --validate checks structure only; the default also reads evidence and gates completion. */
export function checkCampaign(campaign, { root = ROOT, validateOnly = false } = {}) {
  const errors = [];
  const pending = [];
  const unresolvedDeploymentWitnesses = [];
  const unresolvedNaturalWitnesses = [];
  const localAdjudications = new Set();
  const need = (ok, why) => { if (!ok) errors.push(why); return ok; };
  const index = (rows, label) => {
    const map = new Map();
    for (const row of array(rows)) {
      if (!need(row && text(row.id), `${label}: missing id`)) continue;
      need(!map.has(row.id), `${label}: duplicate ${row.id}`);
      map.set(row.id, row);
    }
    return map;
  };
  const artifact = (p) => {
    if (!text(p) || isAbsolute(p) || p.includes("\\") || relative(root, resolve(root, p)).startsWith("..")) throw new Error("evidence path must stay relative to the repository");
    return resolve(root, p);
  };
  need(campaign?.schemaVersion === 1, "schemaVersion must be 1");
  need(campaign?.scope === "local-only", "campaign scope must be local-only");
  const sources = index(campaign?.sources, "sources");
  for (const s of sources.values()) need(HASH.test(s.sha256), `source ${s.id}: missing digest`);
  const coverage = campaign?.coverage ?? {};
  const observations = index(coverage.observations, "observations");
  const coverageItems = index(coverage.items, "coverage items");
  need(observations.size === 239, "retain all 239 baseline coverage observations");
  need(coverageItems.size === 234, "retain all 234 canonical baseline coverage items");
  const bySource = new Map();
  for (const o of observations.values()) {
    need(sources.has(o.source) && text(o.unit) && text(o.ref) && text(o.kind) && text(o.detail), `observation ${o.id}: missing source or content`);
    bySource.set(o.source, (bySource.get(o.source) ?? 0) + 1);
  }
  for (const [name, n] of [["deep-critic-gaps.json", 205], ["critic-r1-gaps.json", 13], ["critic-r2-gaps.json", 21]]) need(bySource.get(name) === n, `${name}: expected ${n} observations`);
  const linked = new Set();
  for (const item of coverageItems.values()) {
    need(array(item.observations).length > 0, `${item.id}: observation references required`);
    for (const id of array(item.observations)) { need(observations.has(id), `${item.id}: unknown observation ${id}`); linked.add(id); }
  }
  need(linked.size === observations.size, "every raw observation must remain linked to a canonical item");
  need(array(coverage.overlaps).length === 5, "retain the five overlapping round-two observations");
  for (const overlap of array(coverage.overlaps)) {
    need(!coverageItems.has(overlap.observation) && observations.has(overlap.observation), `invalid overlap ${overlap.observation}`);
    for (const id of array(overlap.canonical)) need(coverageItems.get(id)?.observations?.includes(overlap.observation), `overlap ${overlap.observation} is not linked from ${id}`);
  }
  need([...coverageItems.values()].filter((i) => i.historicalResolution).length === 61, "retain the 61 historical coverage resolutions");
  const items = index(campaign?.items, "product/report items");
  const groups = index(campaign?.groups, "groups");
  const grouped = [...items.values()].filter((i) => i.track === "grouped");
  const reported = [...items.values()].filter((i) => i.track === "reported");
  need(groups.size === 22 && grouped.length === 61 && reported.length === 38 && items.size === 99, "retain 61 suspects in 22 groups and 38 reported items");
  const members = [...groups.values()].flatMap((g) => array(g.suspects));
  need(members.length === 61 && new Set(members).size === 61, "group membership must cover 61 distinct suspects");
  for (const i of grouped) need(groups.get(i.group)?.suspects?.includes(i.id), `${i.id}: missing group membership`);
  const discoveries = index(campaign?.discoveries, "discoveries");
  const proofs = index(campaign?.proofs, "proofs");
  const controls = index(campaign?.controls, "controls");
  const acceptance = campaign?.acceptance ?? {};
  const requirements = index(acceptance.requirements, "requirements");
  const matrixIds = ["verify", "rules", "selftest", "controls", "smoke", "smoke-capabilities", "functional", "account-measurement", "account-live-consent", "account-default-mark", "cli-bad-skill", "cli-uppercase-skill", "cli-underscore-skill", "cli-interval-floor", "email-off", "concurrency-thumb-authority-n2", "postcommit-projection-failure", "native-ack-endpoints", "native-ack-operators", ...["natural", "c01", "c04", "c08", "c10", "c12", "c13", "c16", "c17"].flatMap((v) => [2, 5, 10, 20].map((n) => `concurrency-${v}-n${n}`))];
  for (const id of matrixIds) need(requirements.has(id), `retain matrix requirement ${id}`);
  for (const id of ["coverage-new-version-dialog", "coverage-new-version-drop"]) need(discoveries.has(id), `retain later discovery ${id}`);
  const all = [...coverageItems.values(), ...items.values(), ...discoveries.values()];
  for (const item of all) {
    need(STATES.has(item.state), `${item.id}: unknown state ${item.state}`);
    if (item.state === "historical-closed") {
      need(coverageItems.has(item.id) && sources.has(item.historicalResolution?.source), `${item.id}: historical closure needs its imported source`);
      continue;
    }
    if (item.state !== "resolved") { pending.push(`${item.id}: ${item.state}`); continue; }
    const r = item.resolution;
    need(r && KINDS.has(r.kind) && text(r.reason) && text(r.spec), `${item.id}: resolution needs kind, reason and SPEC citation`);
    need(array(r?.proofs).length > 0, `${item.id}: resolution needs positive proof`);
    for (const id of array(r?.proofs)) {
      const p = proofs.get(id);
      need(p?.outcome === "PASS", `${item.id}: ${id} must be an actual PASS`);
      if (items.has(item.id) && r?.kind === "fixed") need(p?.kind === "e2e-case", `${item.id}: product fixes need E2E case evidence`);
    }
    if (["fixed", "coverage-repair"].includes(r?.kind)) need(array(r.controls).length > 0, `${item.id}: new assertions need negative controls`);
    for (const id of array(r?.controls)) need(controls.has(id), `${item.id}: unknown control ${id}`);
  }
  for (const p of proofs.values()) {
    need(["e2e-case", "e2e-run", "command"].includes(p.kind) && (["PASS", "FAIL"].includes(p.outcome) || p.kind === "e2e-run" && ["LOCAL-LIMIT", "COMPOSITE-SAFETY"].includes(p.outcome)), `${p.id}: unsupported proof kind/outcome`);
    need(SHA.test(p.revision) && text(p.version) && text(p.artifact), `${p.id}: revision, version and artifact required`);
    if (p.kind.startsWith("e2e")) need(text(p.runId) && text(p.invocation), `${p.id}: run and invocation required`);
    if (p.kind === "e2e-case") need(text(p.caseId), `${p.id}: exact case id required`);
    if (p.kind === "command") need(text(p.command) && HASH.test(p.logSha256), `${p.id}: command and log digest required`);
  }
  for (const c of controls.values()) {
    need(text(c.mutation), `${c.id}: mutation description required`);
    need(proofs.get(c.red)?.outcome === "FAIL" && proofs.get(c.green)?.outcome === "PASS", `${c.id}: requires a real red FAIL and restored green PASS`);
    need(text(c.assertion), `${c.id}: name the assertion the mutation must fail`);
    need(c.red !== c.green, `${c.id}: red and green must be distinct`);
  }
  for (const r of requirements.values()) {
    need(["e2e-run", "command"].includes(r.kind) && text(r.command), `${r.id}: matrix kind and executable command required`);
    if (array(r.proofs).length === 0) pending.push(`matrix:${r.id}: no evidence`);
    for (const id of array(r.proofs)) need(proofs.get(id)?.kind === r.kind && (proofs.get(id)?.outcome === "PASS" || r.kind === "e2e-run" && ["LOCAL-LIMIT", "COMPOSITE-SAFETY"].includes(proofs.get(id)?.outcome)), `matrix:${r.id}: ${id} is not a matching PASS or qualified local assessment`);
  }
  if (!validateOnly) {
    if (!SHA.test(acceptance.revision) || !text(acceptance.version)) pending.push("acceptance: pin the exact tested revision and version");
    const loaded = new Map();
    for (const p of proofs.values()) {
      try {
        need(p.revision === acceptance.revision && p.version === acceptance.version, `${p.id}: evidence differs from the acceptance revision/version`);
        if (acceptance.fingerprint) need(p.fingerprint === acceptance.fingerprint, `${p.id}: evidence differs from the frozen source fingerprint`);
        const path = artifact(p.artifact);
        if (p.kind === "command") {
          const report = readJson(path);
          need(report.command === p.command && report.revision === p.revision && report.version === p.version && report.outcome === p.outcome, `${p.id}: command report metadata differs`);
          const log = readFileSync(artifact(report.log));
          need(createHash("sha256").update(log).digest("hex") === p.logSha256, `${p.id}: command log digest differs`);
          if (acceptance.fingerprint) need(report.fingerprint === acceptance.fingerprint, `${p.id}: command source fingerprint differs`);
          if (Array.isArray(report.controlSets)) {
            need(new Set(report.controlSets).size === report.controlSets.length && report.tests === report.controlSets.length, `${p.id}: control command counts differ from distinct completed sets`);
            const ledgerPaths = report.controlLedgers ?? (report.controlLedger ? [report.controlLedger] : []), recorded = [];
            need(Array.isArray(ledgerPaths) && ledgerPaths.length > 0, `${p.id}: control command requires its actual runner ledgers`);
            for (const path of array(ledgerPaths)) {
              const ledger = readJson(artifact(path));
              need(ledger.ok === true && text(ledger.endedAt) && !ledger.interrupted && ledger.commit === acceptance.revision && ledger.tree === acceptance.tree, `${p.id}: control runner ledger is incomplete or uses another snapshot`);
              for (const row of array(ledger.controls)) {
                recorded.push(row.set);
                const control = [...controls.values()].find((c) => c.set === row.set), red = proofs.get(control?.red), green = proofs.get(control?.green);
                const greens = array(ledger.green).filter((g) => array(g.sets).includes(row.set));
                const invocationDir = (path) => artifact(isAbsolute(path) ? relative(root, path) : path);
                need(row.ok === true && control && red?.kind === "e2e-case" && green?.kind === "e2e-case" && greens.length === 1 && invocationDir(row.red?.invocationDir) === dirname(artifact(red.artifact)) && invocationDir(greens[0].invocationDir) === dirname(artifact(green.artifact)), `${p.id}: runner ledger does not establish the recorded pair for ${row.set}`);
              }
            }
            need(recorded.length === new Set(recorded).size && JSON.stringify(recorded.sort()) === JSON.stringify([...report.controlSets].sort()), `${p.id}: control sets differ from actual runner ledgers`);
            for (const set of report.controlSets) need([...controls.values()].some((c) => c.set === set), `${p.id}: control command names an unproved set ${set}`);
          } else {
            const counts = commandCounts(log.toString("utf8"));
            for (const k of ["tests", "fail", "skip", "todo", "inconclusive"]) need(counts[k] === report[k], `${p.id}: ${k} count differs from the captured log`);
          }
          need(report.tests > 0 && report.skip === 0 && report.todo === 0 && report.inconclusive === 0, `${p.id}: command report has no tests or incomplete outcomes`);
          need(p.outcome === "PASS" ? report.exitCode === 0 && report.fail === 0 : report.exitCode !== 0 && report.fail > 0, `${p.id}: command exit/counts do not establish ${p.outcome}`);
          loaded.set(p.id, { report, text: log.toString("utf8") });
          continue;
        }
        const report = readJson(path);
        const stack = readJson(artifact(`e2e/.out/${p.runId}/stack.json`));
        need(report.runId === p.runId && report.invocation?.id === p.invocation, `${p.id}: run/invocation differs from report`);
        need(stack.fingerprint?.baseSha === p.revision && stack.expectVersion === p.version, `${p.id}: stack revision/version differs`);
        if (acceptance.fingerprint) need(stack.fingerprint?.sha256 === acceptance.fingerprint, `${p.id}: stack differs from the frozen source fingerprint`);
        need(!stack.fingerprint?.dirty || (HASH.test(p.fingerprint) && p.fingerprint === stack.fingerprint.sha256), `${p.id}: dirty stack needs its exact fingerprint`);
        need(Array.isArray(report.malformed) && report.malformed.length === 0, `${p.id}: malformed result records`);
        const patches = array(stack.patches).map((entry) => entry.set ?? entry);
        if (["PASS", "LOCAL-LIMIT", "COMPOSITE-SAFETY"].includes(p.outcome)) need(patches.every((name) => typeof name === "string" && (name.startsWith("amplify-") || ["a12-projection-unavailable", "a19-analytics-live", "a20-cli-bad-skill-name", "a20-cli-uppercase-skill", "a20-cli-underscore-skill", "a20-cli-no-retry-delay"].includes(name))), `${p.id}: positive evidence contains a product mutant/fix patch`);
        const cases = array(report.cases);
        need(cases.length > 0, `${p.id}: report contains no cases`);
        if (p.kind === "e2e-case") {
          const found = cases.filter((c) => c.id === p.caseId && (c.n ?? null) === (p.n ?? null) && (c.trial ?? 1) === (p.trial ?? 1));
          need(found.length === 1 && (p.outcome === "PASS" ? purePass(found[0]) : pureFail(found[0])), `${p.id}: selected case is not an unqualified ${p.outcome}`);
        }
        const limit = p.outcome === "LOCAL-LIMIT" || p.localLimit ? verifyLocalLimit(campaign, p, { report, stack }, { root }) : null;
        if (p.kind === "e2e-run" && p.outcome === "PASS") verifyCompletedRun(report, path);
        const composite = p.outcome === "COMPOSITE-SAFETY" ? verifyComposite(campaign, p, { report, stack }, { root }) : null;
        if (composite) {
          if (!localAdjudications.has(COMPOSITE_ITEM)) unresolvedNaturalWitnesses.push({ proof: p.id, ...composite.unresolvedNaturalWitness, axes: composite.axes });
          localAdjudications.add(COMPOSITE_ITEM);
        }
        if (limit) unresolvedDeploymentWitnesses.push({ proof: p.id, ...limit.unresolvedDeploymentWitness });
        loaded.set(p.id, { report, stack, limit, composite, selected: p.kind === "e2e-case" ? cases.find((c) => c.id === p.caseId && (c.n ?? null) === (p.n ?? null) && (c.trial ?? 1) === (p.trial ?? 1)) : null, text: JSON.stringify(report) });
      } catch (e) { errors.push(`${p.id}: cannot verify evidence: ${e.message}`); }
    }
    for (const c of controls.values()) {
      const red = loaded.get(c.red);
      const rp = proofs.get(c.red), gp = proofs.get(c.green);
      if (rp?.kind === "command" && gp?.kind === "command") {
        // Command controls carry the actual diagnostic and its log location;
        // no stack or product mutation is invented for a local harness test.
        const at = red?.report?.assertionEvidence;
        const lines = red?.text?.split("\n") ?? [];
        need(Number.isInteger(at?.startLine) && Number.isInteger(at?.endLine) && at.startLine > 0 && at.endLine >= at.startLine && at.endLine <= lines.length, `${c.id}: command control needs exact diagnostic line bounds`);
        const diagnostic = lines.slice((at?.startLine ?? 1) - 1, at?.endLine ?? 0).filter((line) => !/^\s*(?:# Subtest:|(?:not )?ok \d+|[✖✔])/.test(line)).join("\n");
        need(diagnostic.includes(c.assertion) && /(?:ERR_ASSERTION|AssertionError|failureType: 'testCodeFailure')/.test(diagnostic), `${c.id}: command diagnostic does not name the intended assertion`);
      } else {
        need(rp?.kind === "e2e-case" && gp?.kind === "e2e-case" && rp.caseId === gp.caseId && (rp.n ?? null) === (gp.n ?? null) && (rp.trial ?? 1) === (gp.trial ?? 1), `${c.id}: red and green must select the same exact case`);
        const message = typeof red?.selected?.error === "string" ? red.selected.error : red?.selected?.error?.message;
        need(typeof message === "string" && message.includes(c.assertion), `${c.id}: selected red case does not name the intended assertion`);
        need(text(c.set) && array(red?.stack?.patches).some((p) => (p.set ?? p) === c.set), `${c.id}: named mutation is missing from the red stack`);
      }
    }
    for (const item of items.values()) if (item.state === "resolved" && item.resolution?.kind === "fixed") {
      const witnessed = array(item.resolution.proofs).flatMap((id) => {
        const p = proofs.get(id);
        return p?.kind === "e2e-case" ? [p] : [];
      });
      for (const c of array(item.requiredCases)) need(witnessed.some((w) => affectedCaseMatches(w, c)), `${item.id}: missing affected case ${c.caseId} [N=${c.n ?? "-"}]`);
    }
    const passedKeys = new Set([...loaded.values()].flatMap((x) => array(x.report?.cases).filter(purePass).map(key)));
    const exclusions = array(acceptance.exclusions);
    for (const r of requirements.values()) for (const id of array(r.proofs)) {
      const got = loaded.get(id);
      if (!got) continue;
      if (r.kind === "command") {
        need(got.report.command === r.command || r.id === "controls" && got.report.controlSets?.length > 0, `matrix:${r.id}: wrong command`);
        continue;
      }
      const { report, stack } = got;
      need(report.invocation?.suite === r.suite, `matrix:${r.id}: wrong suite`);
      need(!report.invocation?.grep, `matrix:${r.id}: a full matrix cell may not use --grep`);
      if (r.spec) need(array(report.cases).some((c) => basename(c.file ?? "") === r.spec), `matrix:${r.id}: required spec was not executed`);
      else need(array(report.invocation?.spec).length === 0 && !report.invocation?.grep, `matrix:${r.id}: full suite may not be filtered`);
      if (r.n) need(report.invocation?.n?.length === 1 && report.invocation.n[0] === r.n && array(report.cases).some((c) => c.n === r.n), `matrix:${r.id}: N=${r.n} was not executed`);
      if (r.planTrials) need(report.invocation?.trials === null, `matrix:${r.id}: use plan-default trial counts`);
      for (const cap of array(r.capabilities)) need(report.invocation?.capabilities?.includes(cap), `matrix:${r.id}: missing capability ${cap}`);
      if (r.options?.patches) need(JSON.stringify(array(stack.patches).map((p) => p.set ?? p).sort()) === JSON.stringify([...r.options.patches].sort()), `matrix:${r.id}: patch set differs`);
      for (const k of array(r.options?.appEnvPresent)) need(text(stack.options?.appEnv?.[k]), `matrix:${r.id}: ${k} was not set`);
      if (r.options?.emailOff) need(stack.options?.emailOff === true, `matrix:${r.id}: email-off was not built`);
      for (const [k, v] of Object.entries(r.options?.appEnv ?? {})) need(stack.options?.appEnv?.[k] === v, `matrix:${r.id}: ${k} differs`);
      for (const c of array(report.cases)) {
        if (purePass(c)) continue;
        if (got.limit?.observations.includes(key(c)) || got.composite?.observations.includes(key(c))) continue;
        const skipped = c.status === "skip" && !c.todo && !c.inconclusive && !c.notReproduced;
        const exclusion = exclusions.find((e) => e.caseId === c.id && text(e.reason) && all.some((i) => i.id === e.item && i.state === "resolved" && i.resolution?.kind === "local-limit"));
        need(skipped && (passedKeys.has(key(c)) || exclusion), `matrix:${r.id}: ${c.id} [N=${c.n ?? "-"}, trial=${c.trial ?? 1}] is incomplete (${c.status}${c.todo ? ", TODO" : ""})`);
      }
    }
    const controlCell = requirements.get("controls");
    if (array(controlCell?.controlSets).length) {
      const recorded = array(controlCell.proofs).flatMap((id) => array(loaded.get(id)?.report?.controlSets));
      need(recorded.length === new Set(recorded).size, "matrix:controls: duplicate control sets across command reports");
      need(JSON.stringify([...recorded].sort()) === JSON.stringify([...controlCell.controlSets].sort()), "matrix:controls: completed sets differ from the frozen control inventory");
    }
  }
  const localPending = pending.filter(p => ![...localAdjudications].some(id => p === `${id}: in-progress`));
  const localComplete = !validateOnly && errors.length === 0 && localPending.length === 0;
  return { valid: errors.length === 0, complete: localComplete && pending.length === 0 && unresolvedDeploymentWitnesses.length === 0 && unresolvedNaturalWitnesses.length === 0, localComplete, unresolvedDeploymentWitnesses, unresolvedNaturalWitnesses, localAdjudications: [...localAdjudications], localPending, errors, pending, counts: { coverage: coverageItems.size, coverageOpen: [...coverageItems.values()].filter((i) => ["open", "in-progress"].includes(i.state)).length, historicalClosed: [...coverageItems.values()].filter((i) => i.state === "historical-closed").length, suspects: grouped.length, reported: reported.length, discoveries: discoveries.size, matrix: requirements.size } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const allowed = new Set(["--validate", "--json", "--local-only"]);
  const files = args.filter((a) => !a.startsWith("--"));
  if (args.some((a) => a.startsWith("--") && !allowed.has(a)) || files.length > 1) {
    console.error("usage: node tools/check-e2e-campaign.mjs [--validate] [--local-only] [--json] [ledger.json]");
    process.exitCode = 2;
  } else {
    try {
      const result = checkCampaign(readJson(resolve(files[0] ?? "e2e/campaign.json")), { validateOnly: args.includes("--validate") });
      if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`campaign: ${result.valid ? "valid ledger" : "invalid ledger"}; ${result.complete ? "COMPLETE" : "NOT COMPLETE"}`);
        console.log(JSON.stringify(result.counts));
        console.log(`${result.errors.length} evidence/schema errors; ${result.pending.length} unresolved obligations`);
        if (result.unresolvedDeploymentWitnesses.length) console.log(`Local acceptance ${result.localComplete ? "complete" : "incomplete"}; ${result.unresolvedDeploymentWitnesses.length} deployment-bound concurrency witness(es) remain unresolved. No case outcome was changed.`);
        if (result.unresolvedNaturalWitnesses.length) console.log(`Local acceptance ${result.localComplete ? "complete" : "incomplete"}; C14 composite safety leaves the original natural publication-first observation unresolved. Raw INCONCLUSIVE outcomes and the original item remain unchanged.`);
        for (const error of result.errors) console.error(`- ${error}`);
        if (args.includes("--validate")) console.log("Structural validation only; this does not establish completion.");
      }
      process.exitCode = result.valid ? (args.includes("--validate") || (args.includes("--local-only") ? result.localComplete : result.complete) ? 0 : 1) : 2;
    } catch (e) { console.error(`campaign: ${e.message}`); process.exitCode = 2; }
  }
}
