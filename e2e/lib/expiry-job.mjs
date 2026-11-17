// SPDX-License-Identifier: Apache-2.0
// Running the hourly expiry's step for one document or folder against a local stack, which never runs a schedule (SPEC §17, ADR 0029).

/**
 *   const r = await runExpiry(target, "document", docId);
 *   // r: {outcome: "expired" | "trashed" | "skipped", code, stdout, stderr, ms}
 *
 * The Functions emulator loads `applyExpiries` and never runs it, so a spec
 * that needs a passed date to take effect calls what the job calls for each
 * item: `expireDocument` or `expireFolder` (functions/src/lib/expire.ts),
 * from the stack TREE's built functions, the bytes the stack runs, in a child
 * process with the operator scripts' environment (lib/operator.mjs
 * operatorEnv: the emulator hosts, the stack's own HOME, the egress guard).
 * A child, because the tree's firebase-admin is its own module, initialized
 * there with this stack's project and database URL, never this process's.
 *
 * One item, never the sweep: the stack is shared, and `expireDue` would
 * convert every other spec's document whose date has passed.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertPath } from "./paths.mjs";
import { requireCapability } from "./target.mjs";
import { spawnCapture } from "./cli.mjs";
import { operatorEnv } from "./operator.mjs";

const KINDS = new Set(["document", "folder"]);
const OUTCOMES = new Set(["expired", "trashed", "skipped"]);
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** What the child runs: CommonJS, as the tree's functions/lib is. Its arguments are positional, never interpolated. */
const CHILD = `
const [tree, kind, id, projectId, databaseURL] = process.argv.slice(1);
const path = require("node:path");
const admin = require(path.join(tree, "functions", "node_modules", "firebase-admin"));
admin.initializeApp({ projectId, databaseURL });
const job = require(path.join(tree, "functions", "lib", "lib", "expire.js"));
const run = kind === "folder" ? job.expireFolder : job.expireDocument;
run(admin.firestore(), id, Date.now()).then(
  (outcome) => { process.stdout.write(JSON.stringify({ outcome })); process.exit(0); },
  (err) => { process.stderr.write(String(err && err.stack || err)); process.exit(1); },
);
`;

/**
 * Make one document or folder private because its date has passed, as the
 * hourly job would. Throws when the child fails or says something else.
 * @param {object} target  a local target
 * @param {"document"|"folder"} kind
 * @param {string} id
 * @param {{timeoutMs?: number}} [o]
 */
export async function runExpiry(target, kind, id, { timeoutMs = 120_000 } = {}) {
  requireCapability(target, "local");
  if (!KINDS.has(kind)) throw new Error(`runExpiry: kind must be "document" or "folder", not ${JSON.stringify(kind)}`);
  if (!ID_RE.test(String(id))) throw new Error(`runExpiry: ${JSON.stringify(id)} is not an id`);
  const tree = assertPath(target.stack.treeDir, "treeDir");
  const built = join(tree, "functions", "lib", "lib", "expire.js");
  if (!existsSync(built)) throw new Error(`runExpiry: the stack tree has no built ${built}; was it built from a tree with lib/expire.ts?`);
  const env = operatorEnv(target);
  const r = await spawnCapture(process.execPath, ["-e", CHILD, tree, kind, String(id), target.projectId, target.databaseURL], { cwd: tree, env, timeoutMs });
  if (r.code !== 0) throw new Error(`runExpiry: the job's step for ${kind} ${id} exited ${r.code}${r.signal ? ` (${r.signal})` : ""}: ${String(r.stderr).slice(-2000)}`);
  let outcome;
  try {
    ({ outcome } = JSON.parse(String(r.stdout)));
  } catch {
    throw new Error(`runExpiry: the job's step for ${kind} ${id} printed ${JSON.stringify(String(r.stdout).slice(0, 500))}`);
  }
  if (!OUTCOMES.has(outcome)) throw new Error(`runExpiry: unexpected outcome ${JSON.stringify(outcome)}`);
  return { outcome, code: r.code, stdout: r.stdout, stderr: r.stderr, ms: r.ms };
}
