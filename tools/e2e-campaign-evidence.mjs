// SPDX-License-Identifier: Apache-2.0
// Prepare frozen local campaign commands and import exact evidence into reviewable proposals without resolving findings (SPEC §12).

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, lstatSync, readlinkSync } from "node:fs";
import { resolve, relative, dirname, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { worktreeFiles } from "../e2e/lib/tree.mjs";
import { listControlSets, readControl, assertTargetDeclared, greenGroups, findTarget, declaresName } from "../e2e/lib/controls.mjs";
import { probeInstalledTriggerQueue } from "./probe-e2e-trigger-queue.mjs";
import { localLimitReference, verifyLocalLimit } from "./e2e-local-limit.mjs";
import { verifyCompletedRun } from "./e2e-run-completion.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const hash = (s) => createHash("sha256").update(s).digest("hex");
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const need = (ok, message) => { if (!ok) throw new Error(message); };
const pass = (c) => c?.status === "pass" && !c.todo && !c.skipReason && !c.inconclusive && !c.notReproduced && !c.error && (!c.outcome || c.outcome === "PASS");
const fail = (c) => c?.status === "fail" && !c.todo && !c.skipReason && !c.inconclusive && !c.notReproduced && (!c.outcome || c.outcome === "FAIL");
const message = (c) => typeof c?.error === "string" ? c.error : c?.error?.message ?? "";
const key = (c) => `${c.id}::${c.n ?? "-"}::${c.trial ?? 1}`;
const positivePatch = (name) => name.startsWith("amplify-") || ["a19-analytics-live", "a20-cli-bad-skill-name", "a20-cli-uppercase-skill", "a20-cli-underscore-skill", "a20-cli-no-retry-delay"].includes(name);

function localPath(root, path) {
  const rel = relative(root, resolve(root, path));
  need(rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes("\\"), "artifact must stay inside the repository");
  return rel;
}
function writeProposal(root, path, value) {
  const rel = localPath(root, path);
  need(rel.startsWith("e2e/.out/"), "proposals belong under e2e/.out; canonical ledger writes are deliberate");
  mkdirSync(dirname(resolve(root, rel)), { recursive: true });
  writeFileSync(resolve(root, rel), JSON.stringify(value, null, 2) + "\n");
}
function upsert(rows, row) {
  const old = rows.find((x) => x.id === row.id);
  need(!old || JSON.stringify(old) === JSON.stringify(row), `conflicting evidence id ${row.id}`);
  if (!old) rows.push(row);
}

/** Same sorted path/content digest as materializeTree, without starting or copying a stack. */
export function snapshotWorktree(root = ROOT) {
  const { files } = worktreeFiles(root);
  const h = createHash("sha256");
  for (const rel of files) {
    const path = resolve(root, rel), stat = lstatSync(path);
    const digest = stat.isSymbolicLink() ? `link:${readlinkSync(path)}` : hash(readFileSync(path));
    h.update(`${rel}\0${digest}\n`);
  }
  return { revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), version: json(resolve(root, "package.json")).version, fingerprint: h.digest("hex"), files: files.length };
}
export function withTree(command, tree) {
  need(tree === "worktree" || /^[a-f0-9]{40}$/.test(tree), "tree must be worktree or an exact commit");
  if (!/(?:e2e\/run\.mjs|test:e2e --) (?:run|controls)\b/.test(command)) return command;
  return / --tree \S+/.test(command) ? command.replace(/ --tree \S+/, ` --tree ${tree}`) : `${command} --tree ${tree}`;
}
export function prepareCampaign(campaign, snapshot, { tree = "worktree", controls = [] } = {}) {
  need(tree === "worktree", "prepared campaigns use a frozen worktree");
  const candidate = structuredClone(campaign);
  need(candidate.proofs.every((p) => p.revision === snapshot.revision && p.version === snapshot.version), "existing proofs use another acceptance snapshot; retain them separately before preparing a new proposal");
  candidate.acceptance = { ...candidate.acceptance, ...snapshot, tree };
  for (const cell of candidate.acceptance.requirements) cell.command = withTree(cell.command, tree);
  const controlCell = candidate.acceptance.requirements.find((r) => r.id === "controls");
  controlCell.controlSets = controls.map((c) => c.set).sort();
  const batches = greenGroups(controls).flatMap((group) => {
    const rows = [];
    for (let start = 0; start < group.controls.length; start += 20) {
      const sets = group.controls.slice(start, start + 20).map((c) => c.set);
      rows.push({ sets, command: `node e2e/run.mjs controls ${sets.join(" ")} --tree ${tree}` });
    }
    return rows;
  });
  return { candidate, plan: { snapshot, tree, mode: "prepare-only", policy: "Run cells sequentially; obey the existing stack cap and admission locks. Import candidate evidence outside tracked source until the frozen campaign finishes. No finding is resolved by this helper.", matrix: candidate.acceptance.requirements.map(({ proofs, ...r }) => r), controlBatches: batches, groups: candidate.groups.map((g) => ({ id: g.id, suspects: g.suspects, unresolved: g.suspects.filter((id) => candidate.items.find((i) => i.id === id)?.state !== "resolved") })) } };
}
function loadReport(campaign, artifact, root) {
  const rel = localPath(root, artifact), report = json(resolve(root, rel));
  need(report.invocation?.id && report.runId && Array.isArray(report.cases) && report.cases.length && report.malformed?.length === 0, "not a complete single-invocation result artifact");
  const stack = json(resolve(root, `e2e/.out/${report.runId}/stack.json`));
  const a = campaign.acceptance;
  need(stack.fingerprint?.baseSha === a.revision && stack.expectVersion === a.version, "run differs from the acceptance revision/version");
  if (a.fingerprint) need(stack.fingerprint?.sha256 === a.fingerprint, "run differs from the frozen source fingerprint");
  return { rel, report, stack };
}
function caseProof(campaign, loaded, c, outcome) {
  const { report, stack, rel } = loaded;
  need(outcome === "PASS" ? pass(c) : fail(c), "case is not an unqualified outcome");
  if (outcome === "PASS") need((stack.patches ?? []).every((p) => positivePatch(p.set ?? p)), "a product mutant cannot provide positive evidence");
  return { id: `case-${hash(`${rel}\0${key(c)}\0${outcome}`).slice(0, 24)}`, kind: "e2e-case", revision: campaign.acceptance.revision, version: campaign.acceptance.version, fingerprint: stack.fingerprint.sha256, artifact: rel, runId: report.runId, invocation: report.invocation.id, caseId: c.id, n: c.n ?? null, trial: c.trial ?? 1, outcome };
}
export function importRun(campaign, artifact, { root = ROOT, cellId = null, localLimitArtifact = null } = {}) {
  const candidate = structuredClone(campaign), loaded = loadReport(candidate, artifact, root);
  for (const c of loaded.report.cases) if (pass(c) || fail(c)) upsert(candidate.proofs, caseProof(candidate, loaded, c, pass(c) ? "PASS" : "FAIL"));
  const unfinished = loaded.report.cases.filter((c) => !pass(c) && !(c.status === "skip" && !c.todo && !c.inconclusive && !c.notReproduced));
  if (cellId) {
    const cell = candidate.acceptance.requirements.find((r) => r.id === cellId);
    need(cell?.kind === "e2e-run" && loaded.report.invocation.suite === cell.suite, "wrong matrix cell or suite");
    const inv = loaded.report.invocation;
    need(!inv.grep, "a matrix cell cannot use grep");
    need(cell.spec ? loaded.report.cases.some((c) => basename(c.file ?? "") === cell.spec) : !inv.spec?.length, "matrix spec selection differs");
    if (cell.n) need(inv.n?.length === 1 && inv.n[0] === cell.n && loaded.report.cases.some((c) => c.n === cell.n), "matrix N differs");
    if (cell.planTrials) need(inv.trials === null, "matrix requires plan-default trials");
    need((cell.capabilities ?? []).every((c) => inv.capabilities?.includes(c)), "matrix capabilities differ");
    if (cell.options?.patches) need(JSON.stringify((loaded.stack.patches ?? []).map((p) => p.set ?? p).sort()) === JSON.stringify(cell.options.patches.toSorted()), "matrix patch set differs");
    if (cell.options?.emailOff) need(loaded.stack.options?.emailOff === true, "matrix email-off option differs");
    for (const [k, v] of Object.entries(cell.options?.appEnv ?? {})) need(loaded.stack.options?.appEnv?.[k] === v, `matrix ${k} differs`);
    for (const k of cell.options?.appEnvPresent ?? []) need(loaded.stack.options?.appEnv?.[k], `matrix ${k} absent`);
    const p = { id: `run-${loaded.report.runId}-${loaded.report.invocation.id}`, kind: "e2e-run", revision: candidate.acceptance.revision, version: candidate.acceptance.version, fingerprint: loaded.stack.fingerprint.sha256, artifact: loaded.rel, runId: loaded.report.runId, invocation: loaded.report.invocation.id, outcome: "PASS" };
    let limited = [];
    if (unfinished.length && localLimitArtifact) {
      p.outcome = "LOCAL-LIMIT";
      p.localLimit = localLimitReference(root, localPath(root, localLimitArtifact), loaded.rel);
      limited = verifyLocalLimit(candidate, p, loaded, { root }).observations;
      p.localLimit.observations = limited;
    }
    need(unfinished.every(c => limited.includes(key(c))) && loaded.report.cases.some(pass), "matrix run has failed or unjudged cases");
    if (p.outcome === "PASS") verifyCompletedRun(loaded.report, resolve(root, loaded.rel));
    upsert(candidate.proofs, p); cell.proofs = [...new Set([...cell.proofs, p.id])];
  }
  return { candidate, importedCases: loaded.report.cases.filter((c) => pass(c) || fail(c)).length, unfinished: unfinished.map((c) => ({ id: c.id, status: c.status })) };
}

/** Capture an actual pinned probe after the matrix runs, bound to unchanged frozen source. */
export async function captureLocalLimit(campaign, out, { root = ROOT, probe = probeInstalledTriggerQueue, snapshot = snapshotWorktree } = {}) {
  const before = snapshot(root);
  for (const k of ["revision", "version", "fingerprint"]) need(before[k] === campaign.acceptance[k], `local-limit source ${k} differs from frozen acceptance`);
  const result = await probe();
  need(JSON.stringify(snapshot(root)) === JSON.stringify(before), "source changed while capturing local limit");
  const report = { ...result, source: before, command: "node tools/e2e-campaign-evidence.mjs capture-local-limit" };
  writeProposal(root, out, report);
  return report;
}
export function importControls(campaign, ledgerPath, { root = ROOT, readDefinition = readControl } = {}) {
  const candidate = structuredClone(campaign), ledger = json(resolve(root, localPath(root, ledgerPath))), imported = [], refused = [];
  const seen = new Set();
  for (const row of ledger.controls ?? []) {
    try {
      need(!seen.has(row.set), "duplicate control set in this ledger"); seen.add(row.set);
      need(row.ok === true, "runner did not establish a valid pair");
      const def = readDefinition(row.set); def.selection ??= assertTargetDeclared(def);
      const greenRows = (ledger.green ?? []).filter((g) => g.sets?.includes(row.set));
      need(greenRows.length === 1, "ambiguous or missing green invocation");
      const red = loadReport(candidate, resolve(root, row.red.invocationDir, "results.json"), root), green = loadReport(candidate, resolve(root, greenRows[0].invocationDir, "results.json"), root);
      const rc = findTarget(red.report.cases, def), gc = findTarget(green.report.cases, def);
      need(fail(rc) && pass(gc) && key(rc) === key(gc), "the exact target must fail red and pass green");
      need((red.stack.patches ?? []).some((p) => (p.set ?? p) === row.set), "red stack lacks the named mutation");
      const matched = new RegExp(def.expect.message).exec(message(rc));
      need(matched?.[0], "the selected failure does not name the intended assertion");
      const rp = caseProof(candidate, red, rc, "FAIL"), gp = caseProof(candidate, green, gc, "PASS");
      upsert(candidate.proofs, rp); upsert(candidate.proofs, gp);
      upsert(candidate.controls, { id: row.set, set: row.set, mutation: def.what, assertion: matched[0], red: rp.id, green: gp.id });
      imported.push(row.set);
    } catch (error) { refused.push({ set: row.set, reason: error.message }); }
  }
  return { candidate, imported, refused };
}

/** Read the test runners' final counters, never case-title substrings. */
export function commandCounts(log) {
  const clean = log.replace(/\x1b\[[0-9;]*m/g, "");
  const result = { tests: 0, pass: 0, fail: 0, skip: 0, todo: 0, inconclusive: 0 };
  for (const line of clean.split("\n")) {
    const n = /^(?:#|ℹ) (tests|pass|fail|skipped|todo|cancelled) (\d+)\s*$/.exec(line);
    if (n) { const k = { skipped: "skip", cancelled: "inconclusive" }[n[1]] ?? n[1]; result[k] += Number(n[2]); continue; }
    const v = /^\s*Tests\s+(.+?)\s+\((\d+)\)\s*$/.exec(line);
    if (v) { result.tests += Number(v[2]); for (const [, number, status] of v[1].matchAll(/(\d+) (passed|failed|skipped|todo)/g)) result[{ passed: "pass", failed: "fail", skipped: "skip", todo: "todo" }[status]] += Number(number); }
  }
  need(result.tests > 0 && result.tests === result.pass + result.fail + result.skip + result.todo + result.inconclusive, "test counters are missing or inconsistent");
  return result;
}
export function inventoryWitnesses(campaign, { root = ROOT, reports = [] } = {}) {
  const observed = reports.flatMap((p) => json(resolve(root, localPath(root, p))).cases ?? []), rows = [];
  for (const item of campaign.items) for (const w of item.requiredCases ?? []) {
    const split = w.caseId.indexOf("::"), file = w.caseId.slice(0, split), name = w.caseId.slice(split + 2);
    let declared = false; try { declared = declaresName(readFileSync(resolve(root, file), "utf8"), name); } catch { /* missing witnesses are reported below */ }
    const current = observed.filter((c) => c.id === w.caseId && (c.n ?? null) === (w.n ?? null));
    const prefix = /^(?:A\d+\.\d+[a-z]?|C\d+[a-z]?)/.exec(name)?.[0];
    const candidates = declared ? [] : [...new Set(observed.filter((c) => c.file === file && prefix && (c.name ?? c.id.split("::")[1])?.startsWith(prefix)).map((c) => c.id))];
    rows.push({ item: item.id, originalCaseId: w.caseId, n: w.n ?? null, declared, observed: current.map((c) => ({ id: c.id, n: c.n ?? null, trial: c.trial ?? 1, status: c.status })), candidates, disposition: declared ? "declared; fresh exact-snapshot proof required" : "review rename or missing witness; no automatic alias" });
  }
  return rows;
}

/** Explicit invocation only; prepare/import never runs a command. */
export async function captureCommand(campaign, cellId, directory, { root = ROOT, sets = [] } = {}) {
  const cell = campaign.acceptance.requirements.find((r) => r.id === cellId);
  need(cell?.kind === "command", "capture requires a command matrix cell");
  const before = snapshotWorktree(root), a = campaign.acceptance;
  need(before.revision === a.revision && before.version === a.version && before.fingerprint === a.fingerprint, "source is not the prepared frozen worktree");
  const command = cellId === "controls" && sets.length ? `node e2e/run.mjs controls ${sets.join(" ")} --tree ${a.tree}` : cell.command;
  need(sets.every((s) => /^controls-[a-z0-9-]+$/.test(s) && cell.controlSets.includes(s)), "unknown control set");
  const dir = localPath(root, directory); need(dir.startsWith("e2e/.out/"), "capture output must be ignored campaign evidence"); mkdirSync(resolve(root, dir), { recursive: true });
  const chunks = [];
  const exitCode = await new Promise((done, reject) => { const child = spawn("/bin/sh", ["-c", command], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] }); for (const stream of [child.stdout, child.stderr]) stream.on("data", (b) => { chunks.push(b); process.stdout.write(b); }); child.on("error", reject); child.on("close", (code) => done(code ?? 128)); });
  const log = Buffer.concat(chunks), logPath = `${dir}/command.log`; writeFileSync(resolve(root, logPath), log);
  const after = snapshotWorktree(root); need(JSON.stringify(before) === JSON.stringify(after), "source changed while the command ran; captured log is retained without a proof");
  let counts, controlSets, controlLedger;
  if (cellId === "controls") {
    const hit = [...log.toString("utf8").matchAll(/"ledger":\s*("(?:[^"\\]|\\.)*")/g)].at(-1);
    need(hit, "controls command produced no final ledger reference"); controlLedger = localPath(root, JSON.parse(hit[1]));
    const result = importControls(campaign, controlLedger, { root }); controlSets = result.imported;
    const total = json(resolve(root, controlLedger)).controls.length;
    counts = { tests: total, pass: controlSets.length, fail: total - controlSets.length, skip: 0, todo: 0, inconclusive: 0 };
    need(total > 0, "control ledger is empty");
  } else counts = commandCounts(log.toString("utf8"));
  const outcome = exitCode === 0 && counts.fail === 0 && counts.skip === 0 && counts.todo === 0 && counts.inconclusive === 0 ? "PASS" : "FAIL";
  const report = { command, ...before, outcome, exitCode, ...counts, log: logPath, logSha256: hash(log), ...(controlSets ? { controlSets, controlLedger } : {}) };
  writeProposal(root, `${dir}/command.json`, report); return report;
}
export function importCommand(campaign, artifact, { root = ROOT, cellId } = {}) {
  let candidate = structuredClone(campaign); const rel = localPath(root, artifact), report = json(resolve(root, rel)), a = candidate.acceptance;
  need(report.revision === a.revision && report.version === a.version && report.fingerprint === a.fingerprint, "command differs from the frozen acceptance source");
  need(hash(readFileSync(resolve(root, localPath(root, report.log)))) === report.logSha256, "command log digest differs");
  const cell = candidate.acceptance.requirements.find((r) => r.id === cellId);
  need(cell?.kind === "command" && (report.command === cell.command || cellId === "controls" && (report.command.startsWith("node e2e/run.mjs controls ") || report.controlLedgers?.length > 0)), "command does not match this matrix cell");
  need(report.outcome === "PASS" && report.exitCode === 0 && report.tests > 0 && report.fail === 0 && report.skip === 0 && report.todo === 0 && report.inconclusive === 0, "command is not a complete pass");
  const ledgers = report.controlLedgers ?? (report.controlLedger ? [report.controlLedger] : []);
  if (ledgers.length) {
    const imported = [];
    for (const ledger of ledgers) { const result = importControls(candidate, ledger, { root }); need(!result.refused.length, "control command ledger contains an invalid pair"); candidate = result.candidate; imported.push(...result.imported); }
    need(new Set(imported).size === imported.length && JSON.stringify(imported.sort()) === JSON.stringify(report.controlSets.toSorted()) && report.tests === imported.length, "control command ledger differs");
  } else {
    const counts = commandCounts(readFileSync(resolve(root, report.log), "utf8"));
    for (const k of ["tests", "fail", "skip", "todo", "inconclusive"]) need(counts[k] === report[k], `command ${k} count differs from its captured log`);
  }
  const p = { id: `command-${hash(rel).slice(0, 24)}`, kind: "command", revision: report.revision, version: report.version, fingerprint: report.fingerprint, artifact: rel, outcome: "PASS", command: report.command, logSha256: report.logSha256 };
  upsert(candidate.proofs, p); const target = candidate.acceptance.requirements.find((r) => r.id === cellId); target.proofs = [...new Set([...target.proofs, p.id])]; return { candidate };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { campaign: { type: "string", default: "e2e/campaign.json" }, out: { type: "string" }, tree: { type: "string", default: "worktree" }, cell: { type: "string" }, artifact: { type: "string" }, "local-limit": { type: "string" }, sets: { type: "string" }, report: { type: "string", multiple: true, default: [] } } });
  const [command] = positionals, c = json(resolve(ROOT, values.campaign)); need(values.out, "--out under e2e/.out is required");
  if (command === "plan") {
    const controls = listControlSets().map((set) => { const c = readControl(set); c.selection = assertTargetDeclared(c); return c; });
    const prepared = prepareCampaign(c, snapshotWorktree(), { tree: values.tree, controls });
    prepared.plan.witnesses = inventoryWitnesses(c, { reports: values.report });
    writeProposal(ROOT, values.out, prepared.plan); writeProposal(ROOT, values.out.replace(/\.json$/, "") + "-campaign.json", prepared.candidate);
  } else if (command === "capture") await captureCommand(c, values.cell, values.out, { sets: values.sets?.split(",").filter(Boolean) ?? [] });
  else if (command === "capture-local-limit") await captureLocalLimit(c, values.out);
  else {
    need(values.artifact, "--artifact is required");
    const result = command === "import-run" ? importRun(c, values.artifact, { cellId: values.cell, localLimitArtifact: values["local-limit"] }) : command === "import-controls" ? importControls(c, values.artifact) : command === "import-command" ? importCommand(c, values.artifact, { cellId: values.cell }) : null;
    need(result, "expected plan, capture, capture-local-limit, import-run, import-controls or import-command"); writeProposal(ROOT, values.out, result.candidate);
    process.stdout.write(JSON.stringify({ imported: result.imported ?? result.importedCases ?? null, refused: result.refused ?? [], unfinished: result.unfinished ?? [] }) + "\n");
  }
}
