// SPDX-License-Identifier: Apache-2.0
// Running any scripts/*.mjs operator command against a local stack: emulator env, the stack's own HOME, a dummy ADC file (SPEC §9, §12).

/**
 *   const r = await runOperator(target, "delete-version.mjs",
 *     ["--doc", id, "--version", "v2", "--repoint", "v1", "--yes", "--account", owner.email, "--project", target.projectId]);
 *   // r: {code, signal, stdout, stderr, ms, script, env: {HOME, GOOGLE_APPLICATION_CREDENTIALS}}
 *
 * The script is the stack TREE's copy (the bytes the stack was built from),
 * run with cwd = the tree, so its REPO_ROOT is the tree — which holds no
 * .firebaserc and no config/deploy.json by construction. Its environment is
 * built from nothing:
 *
 *   PATH, LANG              this Node first, then the system directories
 *   HOME, TMPDIR            the STACK's home and a tmp dir under it — never
 *                           the user's, where gcloud keeps real credentials
 *   emulator hosts          every *_EMULATOR_HOST, GCLOUD_PROJECT (target.mjs
 *                           emulatorEnv), so the Admin SDK talks to this stack
 *   BIKESHED_BUCKET         the stack's bucket
 *   E2E_GATE_URL            the current gated stack only; override refused
 *   GOOGLE_APPLICATION_CREDENTIALS
 *                           <stack HOME>/e2e-operator/adc.json, a DUMMY
 *                           `authorized_user` file. delete-version.mjs refuses
 *                           a real run without the variable even under the
 *                           emulators; against emulators the Admin SDK never
 *                           fetches a token with it. It is deliberately NOT at
 *                           gcloud's default path inside that HOME, so the
 *                           stack's own processes (same HOME) never find it.
 *   NODE_OPTIONS, E2E_EGRESS_LOG
 *                           the egress guard (lib/egress-guard.mjs), logging
 *                           to the stack's egress.jsonl: if a script ever did
 *                           try to fetch a token, it is refused and logged
 *
 * Local stacks only: on production the operator runs scripts with their own
 * ADC (grant.mjs operatorSetAccess does that for set-access).
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertPath } from "./paths.mjs";
import { SYSTEM_PATH } from "./proc.mjs";
import { emulatorEnv, requireCapability } from "./target.mjs";
import { spawnCapture } from "./cli.mjs";
import { describeGuard, egressEnv, GUARD_IN_TREE } from "./egress.mjs";
import { gateUrl } from "./gates.mjs";

const SCRIPT_RE = /^[a-z][a-z0-9-]*\.mjs$/;

/** The stack's HOME (target.stack.homeDir, or <stackDir>/home for an older target). */
export function stackHome(target) {
  if (target.kind !== "local") throw new Error("operator scripts run against a local stack only");
  return assertPath(target.stack.homeDir ?? join(target.stack.stackDir, "home"), "stack HOME");
}

/** Write (once) and return the dummy ADC file under the stack's HOME. */
export function dummyAdc(target) {
  const file = join(stackHome(target), "e2e-operator", "adc.json");
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // A shape google-auth accepts without a network call; every value is a
    // placeholder, and against the emulators no token is ever requested.
    writeFileSync(file, `${JSON.stringify({ type: "authorized_user", client_id: "e2e-dummy-client.invalid", client_secret: "e2e-dummy", refresh_token: "e2e-dummy", quota_project_id: target.projectId }, null, 2)}\n`);
    chmodSync(file, 0o600);
  }
  return file;
}

/**
 * The operator's environment, from nothing (see the header).
 * @param {object} target
 * @param {object} [o]
 * @param {object} [o.extra]   more variables; none may name another emulator host or project
 */
export function operatorEnv(target, { extra = {} } = {}) {
  const home = stackHome(target);
  const tmp = join(home, "e2e-operator", "tmp");
  mkdirSync(tmp, { recursive: true });
  const env = {
    PATH: [dirname(process.execPath), ...SYSTEM_PATH].join(":"),
    HOME: home,
    TMPDIR: tmp,
    LANG: process.env.LANG || "en_US.UTF-8",
    ...emulatorEnv(target),
    BIKESHED_BUCKET: target.bucket,
    ...(target.capabilities?.has?.("gates") ? { E2E_GATE_URL: gateUrl(target) } : {}),
    GOOGLE_APPLICATION_CREDENTIALS: dummyAdc(target),
  };
  const guard = join(target.stack.treeDir, GUARD_IN_TREE);
  if (target.stack.logs?.egress && existsSync(guard)) Object.assign(env, egressEnv({ file: describeGuard(guard).file, log: target.stack.logs.egress }));
  const fixed = emulatorEnv(target);
  for (const [k, v] of Object.entries(extra)) {
    if ((k in fixed || k === "GOOGLE_APPLICATION_CREDENTIALS" || k === "HOME" || k === "E2E_GATE_URL") && v !== env[k]) throw new Error(`operator env: ${k} is the stack's and cannot be overridden`);
    env[k] = String(v);
  }
  return env;
}

/**
 * Run `node <tree>/scripts/<script> …args` against the stack.
 * @param {object} target
 * @param {string} script   a file name under scripts/, e.g. "delete-version.mjs"
 * @param {string[]} [args]
 * @param {object} [o]      {timeoutMs = 120000, input, env (extra variables)}
 * @returns {Promise<{code, signal, stdout, stderr, ms, script, env:{HOME, GOOGLE_APPLICATION_CREDENTIALS}}>}
 */
export async function runOperator(target, script, args = [], { timeoutMs = 120_000, input, env: extra = {} } = {}) {
  requireCapability(target, "local");
  if (!SCRIPT_RE.test(String(script))) throw new Error(`runOperator: ${JSON.stringify(script)} is not a scripts/*.mjs file name`);
  if (!Array.isArray(args)) throw new Error("runOperator: args must be an array");
  const tree = assertPath(target.stack.treeDir, "treeDir");
  const file = join(tree, "scripts", script);
  if (!existsSync(file)) throw new Error(`runOperator: the stack tree has no scripts/${script}`);
  const env = operatorEnv(target, { extra });
  const r = await spawnCapture(process.execPath, [file, ...args.map(String)], { cwd: tree, env, input, timeoutMs });
  return { ...r, script: file, env: { HOME: env.HOME, GOOGLE_APPLICATION_CREDENTIALS: env.GOOGLE_APPLICATION_CREDENTIALS } };
}
