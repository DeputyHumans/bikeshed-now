// SPDX-License-Identifier: Apache-2.0
// The deploy decision: documents stop after CI, and code can never be stranded behind them (SPEC §12).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEPLOY_JOB, changedPaths, decide, isAncestor, isServed, lastDeployedCommit } from "./deploy-needed.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("what production serves deploys, and so does anything nobody has classified", () => {
  for (const path of [
    "app/public/llms.txt",
    "app/public/skills/bs-publish/SKILL.md",
    "claude-plugin/.claude-plugin/plugin.json",
    "claude-plugin/.claude-plugin/icon.png",
    "app/src/test/README.md",
    "functions/src/index.ts",
    "functions/test/skills.test.js",
    "config/access-policy.json",
    "scripts/lib/endpoints.mjs",
    "tools/stamp-deployment.mjs",
    "firebase.json",
    "firestore.rules",
    "package.json",
    ".github/workflows/deploy.yml",
    "a-directory-added-next-year/file.ts",
  ]) {
    assert.equal(isServed(path), true, path);
  }
});

test("what production never serves does not deploy", () => {
  for (const path of [
    "README.md",
    "CHANGELOG.md",
    "AGENTS.md",
    "docs/architecture/spec.md",
    "docs/agents/agent-guide.md",
    "claude-plugin/README.md",
    "claude-plugin/skills/bs-publish/SKILL.md",
    ".claude-plugin/marketplace.json",
    "content/docs/bundle/index.html",
    "cli/src/index.mjs",
    "e2e/README.md",
    "rules-tests/firestore.test.mjs",
    ".github/ISSUE_TEMPLATE/bug.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
  ]) {
    assert.equal(isServed(path), false, path);
  }
});

const run = (id, head_sha) => ({ id, head_sha });
const job = (name, conclusion) => ({ name, conclusion });

/** A workflow's history, newest first: [commit, conclusion of its deploy job]. */
function history(...entries) {
  const runs = entries.map(([sha], i) => run(i, sha));
  const jobsOf = async ({ id }) => [job("ci / guards", "success"), job(DEPLOY_JOB, entries[id][1])];
  return { listRuns: async () => runs, jobsOf };
}

const git = (changed) => ({ isAncestor: () => true, changedPaths: () => changed });

test("a documentation push after a deploy stops after CI", async () => {
  const { deploy } = await decide({ event: "push", head: "c", ...history(["b", "success"]), ...git(["docs/x.md", "README.md"]) });
  assert.equal(deploy, false);
});

test("one served path among the documents deploys", async () => {
  const { deploy, why } = await decide({ event: "push", head: "c", ...history(["b", "success"]), ...git(["docs/x.md", "app/public/llms.txt"]) });
  assert.equal(deploy, true);
  assert.match(why, /app\/public\/llms\.txt/);
});

test("the comparison starts at the last deploy, past every run that did not deploy", async () => {
  // A skipped run (documents), a failed run (code that never shipped) and a
  // cancelled one (a pending run a newer push replaced). Comparing with the
  // previous push would call this documentation and strand all of it.
  const seen = [];
  const { deploy } = await decide({
    event: "push",
    head: "f",
    ...history(["e", "skipped"], ["d", "failure"], ["c", "cancelled"], ["b", null], ["a", "success"]),
    isAncestor: () => true,
    changedPaths: (base, head) => {
      seen.push(base, head);
      return ["functions/src/index.ts", "docs/x.md"];
    },
  });
  assert.deepEqual(seen, ["a", "f"]);
  assert.equal(deploy, true);
});

test("a run whose report failed still counts: it is the deploy job that says what production holds", async () => {
  const jobsOf = async () => [job(DEPLOY_JOB, "success"), job("report production outcome", "failure")];
  assert.equal(await lastDeployedCommit([run(1, "a")], jobsOf), "a");
});

test("every doubt deploys", async () => {
  const documents = git(["docs/x.md"]);
  assert.equal((await decide({ event: "workflow_dispatch", head: "c", ...history(["b", "success"]), ...documents })).deploy, true, "a manual run");
  assert.equal((await decide({ event: "push", head: "c", ...history(["b", "skipped"]), ...documents })).deploy, true, "no deploy on record");
  assert.equal((await decide({ event: "push", head: "c", listRuns: async () => [], jobsOf: async () => [], ...documents })).deploy, true, "no runs at all");
  assert.equal(
    (await decide({ event: "push", head: "c", ...history(["b", "success"]), ...documents, isAncestor: () => false })).deploy,
    true,
    "history rewritten under the last deploy",
  );
});

test("nothing changed since the last deploy needs no deploy", async () => {
  assert.equal((await decide({ event: "push", head: "b", ...history(["b", "success"]), ...git([]) })).deploy, false);
});

test("a source moved into docs/ counts as a change to what is served, and ancestry is real git", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-needed-"));
  const sh = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    sh("init", "-q");
    sh("config", "user.email", "t@example.test");
    sh("config", "user.name", "t");
    mkdirSync(join(dir, "functions"));
    writeFileSync(join(dir, "functions", "a.ts"), "export const answer = 42;\n".repeat(20));
    sh("add", ".");
    sh("commit", "-qm", "one");
    const base = sh("rev-parse", "HEAD");
    mkdirSync(join(dir, "docs"));
    renameSync(join(dir, "functions", "a.ts"), join(dir, "docs", "a.ts"));
    sh("add", "-A");
    sh("commit", "-qm", "two");
    const head = sh("rev-parse", "HEAD");
    assert.deepEqual(changedPaths(base, head, dir).sort(), ["docs/a.ts", "functions/a.ts"]);
    assert.equal(isAncestor(base, head, dir), true);
    assert.equal(isAncestor(head, base, dir), false);
    assert.equal(isAncestor("0".repeat(40), head, dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One job's text from deploy.yml: from its key to the next two-space key. */
function jobBlock(key) {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "deploy.yml"), "utf8");
  const start = workflow.indexOf(`\n  ${key}:\n`);
  assert.ok(start >= 0, `deploy.yml has no ${key} job`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 2);
}

test("deploy.yml acts on the decision, and can make it", () => {
  // A workflow cannot run here, so the wiring is asserted structurally.
  const production = jobBlock("production");
  assert.match(production, new RegExp(`name: ${DEPLOY_JOB}\\n`), "the job the lookup searches for was renamed");
  assert.match(production, /needs: \[ci, changes\]/);
  assert.match(production, /if: [^\n]*needs\.changes\.outputs\.deploy == 'true'/);

  const changes = jobBlock("changes");
  assert.match(changes, /fetch-depth: 0/, "a shallow clone has no last deploy to compare with");
  assert.match(changes, /actions: read/, "the lookup reads past runs");
  assert.match(changes, /deploy: \$\{\{ steps\.decide\.outputs\.deploy \}\}/);
  assert.match(changes, /id: decide/);
  assert.match(changes, /run: node tools\/deploy-needed\.mjs/);
});

test("a push that deploys nothing reports nothing", () => {
  // scripts/ops.mjs logs every result except success as deployment_failed, and
  // that event raises an alert, so reporting a skipped deploy would page the
  // operator for every documentation commit.
  assert.match(jobBlock("report"), /if: [^\n]*needs\.changes\.outputs\.deploy != 'false'/);
});
