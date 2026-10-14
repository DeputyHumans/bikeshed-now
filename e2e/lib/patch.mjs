// SPDX-License-Identifier: Apache-2.0
// Moving a stack COPY onto its own ports and mail shim, and applying named patch sets to it (SPEC §12).

/**
 * Every edit here is to the copy under ~/.cache/bikeshed-e2e/stacks/<runId>/
 * and never to a checkout. Each is written to fail loudly rather than to
 * succeed approximately:
 *
 * - firebase.json is parsed and rewritten as JSON, every emulator pinned to the
 *   block, including hub, logging, eventarc, tasks and the Firestore
 *   websocket (which otherwise binds 9150 even with the UI off). Its RTDB
 *   rules are bound to `ns=<projectId>`, the namespace the app and the
 *   functions use, as well as to firebase-tools' default instance
 *   (rtdbRulesConfig); readiness then reads them back (stack.mjs).
 * - app/src/config.ts hard-codes the emulator ports the web SDK dials. The
 *   block is found with an ANCHORED regex that must match exactly once, and
 *   the values it captures must equal the tree's own firebase.json defaults.
 *   If the source changes shape, the stack refuses to build instead of
 *   shipping an app that talks to the user's emulator on the default ports.
 * - functions/.env.local and .secret.local are written fresh. The emulator
 *   loads .env.local last, and the Resend SDK reads RESEND_BASE_URL at import,
 *   so with these every send goes to the shim and nothing to Resend.
 * - Patch sets (e2e/patches/<set>/*.patch: `amplify-<name>` sets that add
 *   pause points and client gates (lib/gates.mjs), and one `controls-<family>`
 *   per oracle family) are checked with `git apply --check` before anything is
 *   applied; one that does not apply is a harness error. An amplify set also
 *   needs its amplify.json (readAmplify).
 * - The gate helpers several amplify sets each add (SHARED_GATE_HELPERS:
 *   functions/src/lib/e2eGate.ts, app/src/e2eGate.ts) go into a tree ONCE.
 *   A set whose patch adds one that an earlier set already put there, the
 *   same file but for its header's second line (which names the set),
 *   applies with that path excluded (`git apply --exclude`), and its result
 *   lists it under `shared`; one whose body differs is a harness error
 *   (E2E_PATCH) before anything of it is applied. So any amplify sets may be
 *   named together, in any order, and each still applies alone.
 * - A gated stack's functions/.env.local also carries E2E_GATE_URL, the gate
 *   service the amplified functions call; no other stack's does.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATCHES_DIR, assertPath } from "./paths.mjs";
import { assertStackPort } from "./ports.mjs";
import { GATE_ENV, isAmplifySet, readAmplify } from "./gates.mjs";

export const PROJECT_ID = "demo-bikeshed";
export const BUCKET = "demo-bikeshed-content";
export const MAIL_FROM = "Bikeshed E2E <noreply@e2e.bikeshed.invalid>";

/** The emulator keys a stack pins, and the block role that supplies each. */
const EMULATOR_ROLES = {
  auth: "auth",
  firestore: "firestore",
  database: "database",
  functions: "functions",
  hosting: "hosting",
  storage: "storage",
  hub: "hub",
  logging: "logging",
  eventarc: "eventarc",
  tasks: "tasks",
};

/**
 * The firebase.json `database` entry a stack copy runs with: the tree's rules
 * bound to every namespace the stack serves.
 *
 * firebase-tools binds a single `{rules}` entry to the instance
 * `<projectId>-default-rtdb`. The app (VITE_FIREBASE_DATABASE_URL) and the
 * functions (FIREBASE_CONFIG, which the emulator derives from a demo project's
 * `https://<projectId>.firebaseio.com`) both use `ns=<projectId>`, which then
 * ran with no rules at all — every read and write allowed — so every RTDB
 * denial a spec asserted was blind. The copy names both instances, the
 * product's namespace first; firebase-tools loads each before the emulator
 * reports ready and fails the start when one does not load.
 *
 *   undefined          → unchanged; no rules, no namespaces (a tree without RTDB rules)
 *   {rules}            → [{instance: <projectId>, rules}, {instance: <projectId>-default-rtdb, rules}]
 *   [{instance, rules}] → unchanged when one entry is <projectId>
 *
 * Anything else throws E2E_RTDB_RULES: a list without the product's
 * namespace, a `target` entry (the copy has no .firebaserc to resolve it), or
 * an entry without a rules file.
 * @returns {{config:any, namespaces:string[], rules:string|null}}
 */
export function rtdbRulesConfig(database, projectId = PROJECT_ID) {
  const fail = (why) => {
    const err = new Error(`firebase.json: ${why}; read it and update rtdbRulesConfig in e2e/lib/patch.mjs`);
    err.code = "E2E_RTDB_RULES";
    return err;
  };
  if (database === undefined || database === null) return { config: database, namespaces: [], rules: null };
  if (!Array.isArray(database)) {
    if (typeof database !== "object" || typeof database.rules !== "string" || !database.rules) throw fail("`database` has no rules file");
    const config = [
      { instance: projectId, rules: database.rules },
      { instance: `${projectId}-default-rtdb`, rules: database.rules },
    ];
    return { config, namespaces: config.map((c) => c.instance), rules: database.rules };
  }
  for (const c of database) {
    if (!c || typeof c !== "object" || c.target !== undefined) throw fail("a `database` entry names a deploy target, which a stack copy cannot resolve");
    if (typeof c.instance !== "string" || !c.instance || typeof c.rules !== "string" || !c.rules) throw fail("a `database` entry lacks an instance or a rules file");
  }
  const own = database.find((c) => c.instance === projectId);
  if (!own) throw fail(`the \`database\` list does not bind the namespace ${projectId}, which the app and the functions use`);
  return { config: database, namespaces: database.map((c) => c.instance), rules: own.rules };
}

/**
 * The rules file (relative to the tree) a firebase.json binds to namespace
 * `ns`, or null. For the plain `{rules}` form — a copy made before
 * rtdbRulesConfig, or the checkout's own — it is that file whichever instance
 * firebase-tools bound it to: the rules the tree means, not where they landed.
 */
export function rtdbRulesFile(firebaseJson, ns) {
  const database = firebaseJson?.database;
  if (Array.isArray(database)) return database.find((c) => c?.instance === ns)?.rules ?? null;
  return typeof database?.rules === "string" && database.rules ? database.rules : null;
}

/**
 * Rewrite firebase.json's `emulators` onto the block, and bind the RTDB rules
 * to the namespaces the stack serves (rtdbRulesConfig).
 * @returns {{defaults:{auth:number, firestore:number, database:number}, emulators:object, database:{namespaces:string[], rules:string|null}}}
 */
export function patchFirebaseJson(treeDir, ports, { keepUi = false, projectId = PROJECT_ID } = {}) {
  const file = assertPath(join(treeDir, "firebase.json"), "firebase.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  const database = rtdbRulesConfig(config.database, projectId);
  if (database.config !== undefined && database.config !== null) config.database = database.config;
  const before = config.emulators ?? {};
  const defaults = {
    auth: before.auth?.port,
    firestore: before.firestore?.port,
    database: before.database?.port,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!Number.isInteger(v)) throw new Error(`firebase.json: emulators.${k}.port is missing, cannot check config.ts against it`);
  }
  const emulators = {};
  for (const [key, role] of Object.entries(EMULATOR_ROLES)) {
    emulators[key] = { host: "127.0.0.1", port: assertStackPort(ports[role]) };
  }
  emulators.firestore.websocketPort = assertStackPort(ports.firestoreWs);
  emulators.ui = { enabled: !!keepUi, host: "127.0.0.1", port: assertStackPort(ports.ui) };
  if ("singleProjectMode" in before) emulators.singleProjectMode = before.singleProjectMode;
  config.emulators = emulators;

  // The stamp check is a deploy-time guard against the live origin; a stack
  // never deploys, and it would refuse a 127.0.0.1 origin.
  if (config.hosting && !Array.isArray(config.hosting)) delete config.hosting.predeploy;
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return { defaults, emulators, database: { namespaces: database.namespaces, rules: database.rules } };
}

/**
 * The EMULATOR_PORTS block, anchored at both ends of its lines. Strict on
 * purpose: if this stops matching, update it after reading the new source.
 */
export const EMULATOR_PORTS_RE =
  /^export const EMULATOR_PORTS = \{\n {2}auth: (\d+),\n {2}firestore: (\d+),\n {2}database: (\d+),\n\} as const;$/gm;

/**
 * Replace the ports in app/src/config.ts (or in `text`, for self-tests).
 * @returns {string} the new text
 */
export function rewriteEmulatorPorts(text, { defaults, ports }) {
  const matches = [...text.matchAll(EMULATOR_PORTS_RE)];
  if (matches.length !== 1) {
    const err = new Error(
      `app/src/config.ts: the EMULATOR_PORTS anchor matched ${matches.length} times, expected exactly 1 — ` +
        "the source changed shape; update EMULATOR_PORTS_RE in e2e/lib/patch.mjs after reading it",
    );
    err.code = "E2E_ANCHOR";
    throw err;
  }
  const [, auth, firestore, database] = matches[0].map((v, i) => (i === 0 ? v : Number(v)));
  const captured = { auth, firestore, database };
  for (const k of Object.keys(captured)) {
    if (captured[k] !== defaults[k]) {
      const err = new Error(
        `app/src/config.ts: EMULATOR_PORTS.${k} is ${captured[k]} but the tree's firebase.json says ${defaults[k]} — ` +
          "the two copies drifted, so patching one would hide that",
      );
      err.code = "E2E_ANCHOR_DRIFT";
      throw err;
    }
  }
  const replacement =
    `export const EMULATOR_PORTS = {\n  auth: ${assertStackPort(ports.auth)},\n  firestore: ${assertStackPort(ports.firestore)},\n` +
    `  database: ${assertStackPort(ports.database)},\n} as const;`;
  const out = text.slice(0, matches[0].index) + replacement + text.slice(matches[0].index + matches[0][0].length);
  if ([...out.matchAll(EMULATOR_PORTS_RE)].length !== 1) throw new Error("app/src/config.ts: rewrite did not leave exactly one block");
  return out;
}

export function patchAppConfig(treeDir, ports, defaults) {
  const file = assertPath(join(treeDir, "app", "src", "config.ts"), "config.ts");
  const text = readFileSync(file, "utf8");
  writeFileSync(file, rewriteEmulatorPorts(text, { defaults, ports }));
  return { file };
}

function envLine(key, value) {
  if (/[\n"]/.test(value)) throw new Error(`${key}: value cannot be written to a dotenv file`);
  return `${key}="${value}"\n`;
}

/**
 * functions/.env.local and functions/.secret.local for the copy.
 *
 * `apiKey` is the stack's dummy Resend key, which the shim expects. With
 * `emailOff`, .secret.local holds RESEND_API_KEY=" " instead — the product's
 * own off switch (a whitespace payload; send.ts trims it to nothing and skips
 * the send) — while the shim keeps `apiKey`, so it can still be exercised
 * directly. firebase-tools' dotenv parser keeps a quoted space, and a
 * non-empty value also stops the emulator from asking Secret Manager for one.
 *
 * `gateUrl` (a gated stack only: http://127.0.0.1:<gate>) adds E2E_GATE_URL,
 * which an amplify set's server pause points read; without it they fail
 * closed.
 * @returns {{origin:string, shim:string, apiKey:string, emailOff:boolean, gateUrl:string|null}}
 */
export function writeFunctionsEnv(treeDir, ports, { mailFrom = MAIL_FROM, apiKey = `re_e2e_${randomBytes(12).toString("hex")}`, emailOff = false, gateUrl = null } = {}) {
  const dir = assertPath(join(treeDir, "functions"), "functions dir");
  if (!existsSync(join(dir, "package.json"))) throw new Error(`${dir} is not the functions package`);
  const origin = `http://127.0.0.1:${assertStackPort(ports.hosting)}`;
  const shim = `http://127.0.0.1:${assertStackPort(ports.shim)}`;
  const env =
    "# Written by e2e/lib/patch.mjs into a stack copy; never into a checkout.\n" +
    envLine("BIKESHED_PUBLIC_ORIGIN", origin) +
    envLine("BIKESHED_BUCKET", BUCKET) +
    envLine("RESEND_BASE_URL", shim) +
    envLine("BIKESHED_MAIL_FROM", mailFrom);
  let gate = null;
  if (gateUrl != null) {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(String(gateUrl));
    if (!m) throw new Error(`the gate URL must be http://127.0.0.1:<port>, got ${JSON.stringify(gateUrl)}`);
    gate = `http://127.0.0.1:${assertStackPort(Number(m[1]))}`;
  }
  writeFileSync(join(dir, ".env.local"), env + (gate ? envLine(GATE_ENV, gate) : ""));
  if (!/^re_e2e_[0-9a-f]+$/.test(apiKey)) throw new Error("the stack's Resend key must be a dummy re_e2e_… value");
  writeFileSync(join(dir, ".secret.local"), emailOff ? `RESEND_API_KEY=" "\n` : `RESEND_API_KEY=${apiKey}\n`);
  return { origin, shim, apiKey, emailOff: !!emailOff, gateUrl: gate };
}

/** Parse a dotenv file the simple way app/.env.example is written. */
export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) throw new Error(`unparsable dotenv line: ${raw}`);
    let v = m[2];
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** The patch files of a named set, sorted; a missing set is an error. */
export function listPatchSet(set, root = PATCHES_DIR) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(set)) throw new Error(`bad patch set name ${JSON.stringify(set)}`);
  const dir = join(root, set);
  if (!existsSync(dir)) throw new Error(`no patch set ${set} (looked in ${dir})`);
  return readdirSync(dir).filter((n) => n.endsWith(".patch")).sort().map((n) => join(dir, n));
}

function gitApply(treeDir, args) {
  // Ceiling at the tree's parent so git never adopts an enclosing repository.
  return execFileSync("git", ["apply", ...args], {
    cwd: treeDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CEILING_DIRECTORIES: dirname(treeDir) },
  });
}

/**
 * The gate helpers more than one amplify set adds, as paths in the tree: the
 * server helper (amplify-mint-join, amplify-c10-accept, amplify-c13-feedback)
 * and the client helper (amplify-mint-join). Each set carries its own copy so
 * that it applies alone; applyPatchSet puts each into a tree once.
 */
export const SHARED_GATE_HELPERS = Object.freeze(["functions/src/lib/e2eGate.ts", "app/src/e2eGate.ts"]);

/**
 * The files a patch CREATES, as git would write them: [{path, content}], in
 * the patch's order. A creation is a `--- /dev/null` line followed by `+++
 * b/<path>` (a timestamp after a tab is ignored), whose hunks are all
 * `@@ -0,0 +1[,N] @@` with N `+` lines (a `\ No newline at end of file` after
 * the last drops its newline). Every other section (a change, a deletion, a
 * rename) is not listed. A creation whose hunk is not that shape throws.
 */
export function patchNewFiles(text) {
  if (typeof text !== "string") throw new TypeError("patchNewFiles: give the patch's text");
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^--- \/dev\/null(?:\t.*)?$/.test(lines[i])) continue;
    const plus = /^\+\+\+ (?:b\/)?([^\t]+)(?:\t.*)?$/.exec(lines[i + 1] ?? "");
    if (!plus || plus[1] === "/dev/null") continue;
    const path = plus[1];
    const body = [];
    let noNewline = false;
    let j = i + 2;
    while (j < lines.length) {
      const h = /^@@ -0,0 \+1(?:,(\d+))? @@/.exec(lines[j]);
      if (!h) {
        if (lines[j].startsWith("@@")) throw new Error(`patchNewFiles: ${path} is created by a hunk that is not @@ -0,0 +1,N @@: ${lines[j]}`);
        break;
      }
      const count = h[1] === undefined ? 1 : Number(h[1]);
      j += 1;
      for (let k = 0; k < count; k += 1, j += 1) {
        if (j >= lines.length || !lines[j].startsWith("+")) throw new Error(`patchNewFiles: ${path}'s hunk promises ${count} added line(s) and has ${k}`);
        body.push(lines[j].slice(1));
      }
      if (lines[j] === "\\ No newline at end of file") {
        noNewline = true;
        j += 1;
      }
    }
    out.push({ path, content: body.length === 0 ? "" : `${body.join("\n")}${noNewline ? "" : "\n"}` });
    i = j - 1;
  }
  return out;
}

/**
 * A gate helper's body: its text without the second line when the first is
 * the SPDX line (the second is the header's own line, which names the set
 * that adds it). Two sets' copies of one helper are the same helper exactly
 * when their bodies are equal.
 */
export function helperBody(text) {
  const lines = String(text).split("\n");
  if (lines.length < 2 || !lines[0].startsWith("// SPDX-License-Identifier:")) return String(text);
  return [lines[0], ...lines.slice(2)].join("\n");
}

/**
 * The shared gate helpers a patch file would add that the tree already
 * holds: [{path, from}] (from: the set the tree's copy names on its second
 * line, or null). A helper whose body differs from the tree's throws
 * E2E_PATCH; nothing else is looked at, so any other file that already
 * exists is left to `git apply --check`, which refuses it as before.
 */
function sharedHelpersOf(treeDir, file, set) {
  const out = [];
  for (const { path, content } of patchNewFiles(readFileSync(file, "utf8"))) {
    if (!SHARED_GATE_HELPERS.includes(path)) continue;
    const there = join(treeDir, path);
    if (!existsSync(there)) continue;
    const have = readFileSync(there, "utf8");
    const from = /e2e\/patches\/([a-z0-9][a-z0-9-]*)/.exec(have.split("\n")[1] ?? "")?.[1] ?? null;
    if (helperBody(have) !== helperBody(content)) {
      const e = new Error(
        `harness error: patch ${file} (set ${set}) adds ${path}, which ${from ? `the set ${from}` : "an earlier patch"} already put in the stack tree with a different body: ` +
          "two amplify sets share a gate helper only when their copies are the same file but for the header's second line. " +
          "Make them the same, or give this set a helper of its own (as amplify-c08-mint-races does with e2eRaceGate.ts)",
      );
      e.code = "E2E_PATCH";
      throw e;
    }
    out.push({ path, from });
  }
  return out;
}

/**
 * Apply each patch of a set to the copy: all checked first, then applied.
 * A shared gate helper (SHARED_GATE_HELPERS) that an earlier set already put
 * in the tree, with the same body, is excluded from this set's patch
 * (`git apply --exclude=<path>`, in the check and in the apply); one with
 * another body is E2E_PATCH before anything is applied. A patch whose every
 * file is so excluded is checked and applied as nothing.
 * @returns {{set:string, applied:{file:string, sha256:string}[], shared?:{file:string, path:string, from:string|null}[]}}
 *   `shared` only when a helper was excluded: the patch, the helper's path,
 *   and the set whose copy the tree keeps.
 */
export function applyPatchSet(treeDir, set, { root = PATCHES_DIR } = {}) {
  assertPath(treeDir, "treeDir");
  // An amplify set without a valid amplify.json is refused before anything is applied.
  if (isAmplifySet(set)) readAmplify(set, root);
  const files = listPatchSet(set, root);
  // Decided against the tree as the earlier sets left it, before this set touches it.
  const plan = files.map((f) => ({ file: f, shared: sharedHelpersOf(treeDir, f, set) }));
  const excludes = (p) => p.shared.map((s) => `--exclude=${s.path}`);
  for (const p of plan) {
    try {
      gitApply(treeDir, ["--check", ...excludes(p), p.file]);
    } catch (err) {
      const e = new Error(`harness error: patch ${p.file} does not apply to the stack tree\n${err.stderr || err.message}`);
      e.code = "E2E_PATCH";
      throw e;
    }
  }
  const applied = [];
  const shared = [];
  for (const p of plan) {
    gitApply(treeDir, [...excludes(p), p.file]);
    applied.push({ file: p.file, sha256: createHash("sha256").update(readFileSync(p.file)).digest("hex") });
    for (const s of p.shared) shared.push({ file: p.file, path: s.path, from: s.from });
  }
  return shared.length > 0 ? { set, applied, shared } : { set, applied };
}

// There is deliberately no revertPatchSet: a stack's copy is BUILT once, so
// reverting a patch in place afterwards changes nothing that runs. A control
// (lib/controls.mjs) builds a fresh stack with its set; the clean side is
// another stack built without it.
