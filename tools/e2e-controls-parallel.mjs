// SPDX-License-Identifier: Apache-2.0
// Run the complete frozen control inventory through at most three ordinary harness workers and verify their aggregate evidence (SPEC §12).

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { listControlSets, readControl } from "../e2e/lib/controls.mjs";
import { snapshotWorktree, importControls } from "./e2e-campaign-evidence.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const need = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (sets) => [...sets].sort();

function localArtifact(root, path) {
  const rel = relative(root, resolve(root, path));
  need(rel.startsWith("e2e/.out/") && !isAbsolute(rel) && !rel.includes("\\"), "control evidence must stay under e2e/.out");
  return rel;
}

/** Each discovered set occurs exactly once; no worker may bypass normal harness admission. */
export function partitionControls(sets, workers = 3) {
  need(Number.isInteger(workers) && workers >= 1 && workers <= 3, "workers must be an integer from 1 to 3");
  need(sets.length > 0 && sets.every((set) => /^controls-[a-z0-9-]+$/.test(set)), "a nonempty control inventory is required");
  need(new Set(sets).size === sets.length, "duplicate discovered control set");
  const groups = Array.from({ length: Math.min(workers, sets.length) }, () => []);
  sorted(sets).forEach((set, i) => groups[i % groups.length].push(set));
  return groups;
}

export function finalControlSummary(log) {
  const start = log.lastIndexOf('\n{\n  "ok":');
  need(start >= 0, "worker produced no final control summary");
  const result = JSON.parse(log.slice(start + 1));
  need(typeof result.ok === "boolean" && typeof result.ledger === "string" && Array.isArray(result.controls), "worker final control summary is malformed");
  return result;
}

/** Validate the original reports through the shared importer, never trust a worker's ok label. */
export function validateControlWorkers(campaign, sets, workers, { root = ROOT, readDefinition = readControl } = {}) {
  let candidate = structuredClone(campaign);
  const problems = [], ledgers = [], passed = new Set(), failed = new Set(), seen = new Set();
  const assigned = workers.flatMap((worker) => worker.sets);
  if (!same(sorted(assigned), sorted(sets))) problems.push("worker partitions omit, duplicate or add a control set");
  for (const worker of workers) {
    try {
      need(worker.finished === true && Number.isInteger(worker.exitCode), "worker did not finish");
      const summary = finalControlSummary(readFileSync(resolve(root, localArtifact(root, worker.log)), "utf8"));
      const path = localArtifact(root, summary.ledger);
      need(!seen.has(path), "duplicate worker ledger"); seen.add(path); ledgers.push(path);
      const ledger = json(resolve(root, path));
      need(ledger.startedAt && ledger.endedAt && Number.isFinite(Date.parse(ledger.endedAt)) && Date.parse(ledger.endedAt) >= Date.parse(ledger.startedAt) && !ledger.interrupted, "control ledger is unfinished");
      need(ledger.commit === campaign.acceptance.revision && ledger.tree === campaign.acceptance.tree, "control ledger differs from the frozen revision/tree");
      need(same(sorted((ledger.controls ?? []).map((row) => row.set)), sorted(worker.sets)), "control ledger differs from its assigned inventory");
      need(same(sorted(summary.controls.map((row) => row.set)), sorted(worker.sets)), "worker summary differs from its assigned inventory");
      const result = importControls(candidate, path, { root, readDefinition });
      candidate = result.candidate;
      for (const set of result.imported) { need(!passed.has(set), "duplicate imported control set"); passed.add(set); }
      for (const row of result.refused) { failed.add(row.set); problems.push(`${row.set}: ${row.reason}`); }
      const allValid = result.refused.length === 0 && result.imported.length === worker.sets.length;
      need(ledger.ok === allValid && summary.ok === allValid, "worker completion labels differ from validated pairs");
      need(worker.exitCode === (allValid ? 0 : 1), "worker exit differs from validated pairs");
    } catch (error) { problems.push(`worker ${worker.id}: ${error.message}`); }
  }
  const expected = new Set(sets);
  for (const set of passed) if (!expected.has(set) || failed.has(set)) passed.delete(set);
  // A duplicate partition cannot provide an exact-once campaign, even if both copies passed.
  if (!same(sorted(assigned), sorted(sets))) passed.clear();
  const fail = sets.filter((set) => failed.has(set) && !passed.has(set)).length;
  return { controlLedgers: ledgers, controlSets: sorted(sets), problems, tests: sets.length, pass: passed.size, fail, skip: 0, todo: 0, inconclusive: sets.length - passed.size - fail };
}

function spawnWorker({ root, args, id, log, append, children }) {
  return new Promise((resolveWorker) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    const capture = (stream) => (chunk) => { appendFileSync(resolve(root, log), chunk); append(`[worker ${id} ${stream}]\n`); append(chunk); };
    child.stdout.on("data", capture("stdout")); child.stderr.on("data", capture("stderr"));
    child.once("error", (error) => { append(`[worker ${id} spawn error] ${error.message}\n`); });
    child.once("close", (code, signal) => { children.delete(child); resolveWorker({ exitCode: code ?? (signal ? 130 : 1), signal, finished: true }); });
  });
}

/** Source-only tests can inject trivial workers; the CLI always launches the existing controls command. */
export async function runParallelControls(campaign, directory, {
  root = ROOT, workers = 3, command, discover = listControlSets, snapshot = snapshotWorktree,
  runWorker = spawnWorker, readDefinition = readControl,
} = {}) {
  const before = snapshot(root), acceptance = campaign.acceptance;
  need(acceptance.tree === "worktree", "parallel controls require a prepared frozen worktree");
  for (const key of ["revision", "version", "fingerprint"]) need(before[key] === acceptance[key], `source differs from the frozen ${key}`);
  const sets = sorted(discover()), partitions = partitionControls(sets, workers);
  const cell = acceptance.requirements.find((row) => row.id === "controls");
  need(cell?.kind === "command" && same(sorted(cell.controlSets ?? []), sets), "discovered controls differ from the prepared complete inventory");
  const dir = localArtifact(root, directory);
  // Exclusive creation avoids overwriting evidence on a repeated invocation.
  mkdirSync(resolve(root, "e2e/.out"), { recursive: true }); mkdirSync(resolve(root, dir));
  const log = `${dir}/command.log`, startedAt = new Date().toISOString(), children = new Set();
  const append = (chunk) => appendFileSync(resolve(root, log), chunk);
  const actualCommand = command ?? `node tools/e2e-controls-parallel.mjs --workers ${workers} --out ${dir}`;
  append(`${actualCommand}\n${JSON.stringify({ startedAt, ...before, controlSets: sets, workers: partitions.length })}\n`);
  let interrupted = null;
  const stop = (signal) => { interrupted ??= signal; for (const child of children) child.kill(signal); };
  const onInt = () => stop("SIGINT"), onTerm = () => stop("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  let records;
  try {
    records = await Promise.all(partitions.map(async (assigned, index) => {
      const id = index + 1, args = ["e2e/run.mjs", "controls", ...assigned, "--tree", "worktree"], workerLog = `${dir}/worker-${id}.log`;
      writeFileSync(resolve(root, workerLog), ""); append(`[worker ${id} command] ${JSON.stringify([process.execPath, ...args])}\n`);
      try { return { id, sets: assigned, args, log: workerLog, ...await runWorker({ root, args, id, log: workerLog, append, children }) }; }
      catch (error) { append(`[worker ${id} error] ${error.message}\n`); return { id, sets: assigned, args, log: workerLog, exitCode: 1, finished: false, error: error.message }; }
    }));
  } finally { process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); }
  const counts = validateControlWorkers(campaign, sets, records, { root, readDefinition });
  try {
    need(same(before, snapshot(root)), "source changed while parallel controls ran");
    need(same(sets, sorted(discover())), "control inventory changed while parallel controls ran");
  } catch (error) { counts.problems.push(error.message); }
  if (interrupted) counts.problems.push(`interrupted by ${interrupted}`);
  const ok = counts.problems.length === 0 && counts.pass === sets.length && records.every((row) => row.exitCode === 0);
  const exitCode = interrupted ? 130 : ok ? 0 : 1;
  append(`${JSON.stringify({ outcome: ok ? "PASS" : "FAIL", exitCode, ...counts })}\n`);
  const report = { command: actualCommand, ...before, startedAt, endedAt: new Date().toISOString(), outcome: ok ? "PASS" : "FAIL", exitCode, ...counts, workers: records, log, logSha256: hash(readFileSync(resolve(root, log))) };
  writeFileSync(resolve(root, dir, "command.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { campaign: { type: "string" }, out: { type: "string" }, workers: { type: "string", default: "3" } } });
    need(values.campaign && values.out, "--campaign <prepared proposal> and --out <new e2e/.out directory> are required");
    const report = await runParallelControls(json(resolve(ROOT, values.campaign)), values.out, { workers: Number(values.workers), command: [process.execPath, ...process.argv.slice(1)].map((arg) => JSON.stringify(arg)).join(" ") });
    process.stdout.write(JSON.stringify({ outcome: report.outcome, tests: report.tests, pass: report.pass, fail: report.fail, inconclusive: report.inconclusive, artifact: `${values.out}/command.json`, controlLedgers: report.controlLedgers }) + "\n");
    process.exitCode = report.exitCode;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
