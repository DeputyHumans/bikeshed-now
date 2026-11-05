// SPDX-License-Identifier: Apache-2.0
// Decides whether a push to main changes anything production serves (SPEC §12).

/**
 * `deploy.yml` runs this beside CI and deploys only when it says so. CI runs
 * either way: the secret scan and the guards that read the spec cover documents
 * too, so a path filter on the workflow would let a leak through unscanned.
 *
 * The comparison is with the last commit that actually deployed, not with the
 * previous push. Runs queue and a burst collapses to the newest, so a push can
 * replace a pending run it never saw; a failed run or a paused one leaves code
 * behind in the same way. Compared with the previous push, a documentation
 * commit on top of any of those would read as nothing to ship, and the code
 * under it would stay out of production with a green run to show for it.
 *
 * Every doubt resolves towards deploying, because an unnecessary deploy is
 * harmless and a skipped one is silent. A path not named below deploys, so a new
 * directory cannot be left out by default, and any failure to decide deploys.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The job in deploy.yml whose success means production holds that commit. */
export const DEPLOY_JOB = "deploy production";

/**
 * Paths production never serves.
 *
 * `docs/agents/agent-guide.md` and `claude-plugin/` do reach readers, but as the
 * copies under `app/public/`, which are not listed and which `check:agents` keeps in
 * step. `content/` reaches production through `bikeshed update`, and `cli/`
 * through `npm publish`.
 */
export const NOT_DEPLOYED = [
  /^[^/]+\.md$/,
  /^docs\//,
  /^claude-plugin\//,
  /^\.claude-plugin\//,
  /^content\//,
  /^cli\//,
  /^e2e\//,
  /^rules-tests\//,
  /^\.github\/ISSUE_TEMPLATE\//,
  /^\.github\/PULL_REQUEST_TEMPLATE\.md$/,
];

export const isServed = (path) => !NOT_DEPLOYED.some((pattern) => pattern.test(path));

/** The newest run's commit whose deploy job succeeded, or null. Runs arrive newest first. */
export async function lastDeployedCommit(runs, jobsOf) {
  for (const run of runs) {
    const jobs = await jobsOf(run);
    if (jobs.some((job) => job.name === DEPLOY_JOB && job.conclusion === "success")) return run.head_sha;
  }
  return null;
}

export async function decide({ event, head, listRuns, jobsOf, isAncestor, changedPaths }) {
  if (event !== "push") return { deploy: true, why: `a ${event} run always deploys` };
  const base = await lastDeployedCommit(await listRuns(), jobsOf);
  if (!base) return { deploy: true, why: "no earlier deploy was found to compare with" };
  if (!isAncestor(base, head)) return { deploy: true, why: `${base} is not an ancestor of ${head}` };
  const paths = changedPaths(base, head);
  const served = paths.filter(isServed);
  if (served.length) return { deploy: true, why: `${served.length} of ${paths.length} paths changed since ${base} are served, the first is ${served[0]}` };
  return { deploy: false, why: `none of the ${paths.length} paths changed since ${base} are served` };
}

/**
 * Both sides of a rename count, so `--no-renames`: moving a function's source
 * into `docs/` would otherwise list only the destination, and read as a
 * documentation change that removed nothing from production.
 */
export function changedPaths(base, head, cwd = process.cwd()) {
  const out = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, head], { cwd, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

export function isAncestor(base, head, cwd = process.cwd()) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", base, head], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function github(path) {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${api}/repos/${process.env.GITHUB_REPOSITORY}/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
  return response.json();
}

async function main() {
  let outcome;
  try {
    outcome = await decide({
      event: process.env.GITHUB_EVENT_NAME,
      head: process.env.GITHUB_SHA,
      listRuns: async () => (await github("actions/workflows/deploy.yml/runs?branch=main&per_page=50")).workflow_runs,
      jobsOf: async (run) => (await github(`actions/runs/${run.id}/jobs?per_page=100`)).jobs,
      isAncestor,
      changedPaths,
    });
  } catch (error) {
    console.log(`::warning::could not decide, so deploying: ${error.message}`);
    outcome = { deploy: true, why: "the decision failed" };
  }
  console.log(`${outcome.deploy ? "deploy" : "no deploy"}: ${outcome.why}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${outcome.deploy}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
