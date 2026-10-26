// SPDX-License-Identifier: Apache-2.0
// Collect resumable full-file concurrency measurements on fresh sequential stacks without weakening admission (SPEC §12).

import { assertAcceptedSource } from "./e2e-source-derivation.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, renameSync, rmSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { snapshotWorktree, importRun, importPartitions } from "./e2e-campaign-evidence.mjs";
import { concurrencyInventory, partitionCellDigest, partitionDigest } from "./e2e-partitions.mjs";
import { verifyFinishedRun } from "./e2e-run-completion.mjs";
import { selfTestToolchain } from "../e2e/lib/prerequisites.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const need = (ok, why) => { if (!ok) throw new Error(`partition runner: ${why}`); };
const read = p => JSON.parse(readFileSync(p, "utf8"));
const save = (p, value) => { const temp = `${p}.${randomUUID()}.tmp`; writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); renameSync(temp, p); };
export function planPartitions(campaign, cellId, snapshot, inventory, { root = ROOT } = {}) {
  const cell = campaign.acceptance.requirements.find(r => r.id === cellId);
  need(cell?.suite === "concurrency" && !cell.spec && cell.planTrials, "select a complete natural concurrency cell");
  need(!assertAcceptedSource(campaign, snapshot, { root })?.controlled, "controlled scheduling cannot substitute for natural partitions");
  const tokens = cell.command.split(/\s+/);
  need(tokens.splice(0, 3).join(" ") === "node e2e/run.mjs run", "unexpected matrix command");
  need(!tokens.some(t => /["'`;|&<>$]/.test(t)) && !tokens.some(t => ["--grep", "--trials", "--spec", "--attach", "--keep", "--spec-file", "--target"].includes(t)), "matrix command is filtered or unsafe");
  need(tokens[tokens.indexOf("--tree") + 1] === "worktree", "matrix requires a frozen worktree");
  need(inventory.length > 0 && new Set(inventory.map(x => x.file)).size === inventory.length, "invalid file census");
  return {
    schemaVersion: 1, kind: "concurrency-partitions", cell: cellId,
    source: Object.fromEntries(["revision", "version", "fingerprint"].map(k => [k, snapshot[k]])),
    requirementSha256: partitionCellDigest(cell), inventory,
    jobs: inventory.map(({ file }) => ({ file, args: ["e2e/run.mjs", "run", ...tokens, "--spec", file] })),
  };
}

export async function runPartitions(campaign, cellId, directory, { root = ROOT } = {}) {
  const out = resolve(root, directory), local = relative(root, out);
  need(!isAbsolute(local) && local.startsWith("e2e/.out/"), "output must stay under e2e/.out");
  const toolchain = selfTestToolchain();
  need(toolchain.firebase.version === "15.25.1", "select pinned Firebase CLI 15.25.1");
  const snapshot = () => snapshotWorktree(root);
  const plan = planPartitions(campaign, cellId, snapshot(), concurrencyInventory(root), { root });
  mkdirSync(out, { recursive: true });
  const statePath = resolve(out, "state.json");
  const guard = () => { for (const field of ["revision", "version", "fingerprint"]) need(snapshot()[field] === plan.source[field], `source changed during measurement: ${field}`); };
  let child, signal;
  const lock = resolve(out, "runner.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n", { flag: "wx" });
  const listeners = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(s => [s, () => { signal = s; child?.kill(s); }]));
  for (const [s, fn] of listeners) process.on(s, fn);
  let candidate = structuredClone(campaign);
  try {
    const state = existsSync(statePath) ? read(statePath) : { plan, attempts: [], collected: false, accepted: false };
    assert.deepEqual(state.plan, plan, "partition runner: resume plan/source changed");
    save(statePath, state);
    for (const job of plan.jobs) {
      guard(); need(!signal, "interrupted");
      const previous = state.attempts.filter(a => a.file === job.file).at(-1);
      let row = previous?.collected ? previous : null;
      if (!row) {
        const dir = resolve(out, `attempt-${randomUUID()}`); mkdirSync(dir);
        row = { file: job.file, startedAt: new Date().toISOString(), directory: relative(root, dir), collected: false };
        state.attempts.push(row); save(statePath, state);
        const fd = openSync(resolve(dir, "command.log"), "wx");
        console.log(`start ${cellId} ${job.file}`);
        let result;
        try {
          result = await new Promise((resolveRun, reject) => {
            child = spawn(toolchain.node.executable, [...job.args, "--report-json", resolve(dir, "summary.json")], { cwd: root, env: toolchain.env, stdio: ["ignore", fd, fd] });
            child.once("error", reject);
            child.once("close", (code, stopped) => { child = null; resolveRun({ exit: code, signal: stopped }); });
          });
        } finally { closeSync(fd); }
        Object.assign(row, result, { endedAt: new Date().toISOString() }); save(statePath, state);
        need(!signal && result.signal === null && [0, 3].includes(result.exit), `run failed; inspect ${row.directory}/command.log`);
        const summary = read(resolve(dir, "summary.json"));
        const path = resolve(summary.invocationDir, "results.json");
        row.report = relative(root, path);
        need(row.report.startsWith("e2e/.out/") && !isAbsolute(row.report), "report escaped the checkout");
        row.sha256 = partitionDigest(readFileSync(path));
      }
      const path = resolve(root, row.report), report = read(path);
      need(partitionDigest(readFileSync(path)) === row.sha256, "retained report changed");
      verifyFinishedRun(report, path, { expectedExit: row.exit });
      assert.deepEqual(report.invocation.plan.flatMap(p => p.files), [job.file], "partition runner: file selection differs");
      assert.deepEqual(report.invocation.n, [campaign.acceptance.requirements.find(c => c.id === cellId).n], "partition runner: N differs");
      need(report.invocation.trials === null && !report.invocation.grep, "filtered or authoring result");
      need(report.cases.every(c => ["pass", "skip", "inconclusive"].includes(c.status) && !c.todo && !c.notReproduced && !c.error), "unexpected failed or unjudged outcome");
      row.pending = report.cases.filter(c => c.status === "inconclusive").map(c => ({ id: c.id, n: c.n, trial: c.trial, reason: c.inconclusive }));
      guard();
      candidate = importRun(candidate, row.report, { root }).candidate;
      row.collected = true;
      save(statePath, state); save(resolve(out, "case-evidence.json"), candidate);
      console.log(`collected ${job.file}; unresolved measurements: ${row.pending.length}`);
    }
    guard();
    const reports = plan.jobs.map(job => state.attempts.filter(a => a.file === job.file && a.collected).at(-1));
    const manifest = { ...plan, reports: reports.map(row => ({ artifact: row.report, sha256: row.sha256 })) }; delete manifest.jobs;
    const manifestPath = resolve(out, "manifest.json"); save(manifestPath, manifest);
    state.collected = true;
    if (reports.every(row => row.exit === 0 && row.pending.length === 0)) {
      candidate = importPartitions(candidate, relative(root, manifestPath), { root, inventory: plan.inventory }).candidate;
      state.accepted = true; save(resolve(out, "accepted-campaign.json"), candidate);
    }
    save(statePath, state);
    return state;
  } finally { for (const [s, fn] of listeners) process.off(s, fn); rmSync(lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { campaign: { type: "string" }, cell: { type: "string" }, out: { type: "string" } } });
  need(values.campaign && values.cell && values.out, "--campaign, --cell and --out are required");
  const result = await runPartitions(read(resolve(ROOT, values.campaign)), values.cell, values.out);
  console.log(JSON.stringify({ collected: result.collected, accepted: result.accepted, attempts: result.attempts.length }));
  process.exitCode = result.accepted ? 0 : 3;
}
