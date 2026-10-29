// SPDX-License-Identifier: Apache-2.0
// The Target a spec runs against: where it is, what it can do, and nothing secret (SPEC §12).

/**
 * Specs never construct URLs from ports or read stack files. They call
 * loadTarget() and use what it says, so the same spec runs against a local
 * stack or (in a later build) production, and declares what it needs as
 * capabilities rather than by asking which kind of target it is.
 *
 * Target (target.json, in e2e/.out/<runId>/):
 *   kind           "local" | "prod"
 *   runId, runDir
 *   origin         the app, e.g. http://127.0.0.1:<hosting>
 *   projectId      demo-bikeshed locally
 *   webApiKey      the public web key (demo-api-key locally)
 *   authRestBase   Identity Toolkit v1 base, e.g. <auth emulator>/identitytoolkit.googleapis.com/v1
 *   secureTokenBase, authEmulatorUrl
 *   databaseURL    http://127.0.0.1:<db>?ns=demo-bikeshed
 *   firestoreUrl, storageUrl, functionsUrl, hubUrl
 *   bucket         demo-bikeshed-content
 *   capabilities   Set: local, email | email-off, mailpit, admin-emulator, oob-codes,
 *                  reset, logs, patches, and — on a stack this harness version
 *                  built — egress-guard, spare-pool, mail-fail-recipient,
 *                  operator-scripts, rtdb-rules (readiness proved ns=<projectId>
 *                  enforces the tree's RTDB rules), plus measurement-id and
 *                  export-mark-default with those options, and patch:<set> for
 *                  every patch set applied to the tree
 *   options        {emailOff, appEnv, rtdbProxy, gates, storageShim} as the stack was built
 *                  (lib/options.mjs); with gates, rtdbProxy or storageShim, stack.ports has
 *                  `gate` (and `rtdbProxy`, `storageShim`) in place of spare8 (and spare9,
 *                  spare7): the aux process's (lib/stackaux.mjs). storageUrl stays the
 *                  Storage emulator's own port on every stack; the shim is the functions'
 *                  (lib/storage-shim.mjs storageShim(target))
 *   patches        the patch sets applied to the tree, in order (e2e/patches/<set>);
 *                  for a target.json written before this field, loadTarget()
 *                  reads them from the run's stack.json, and null means
 *                  neither says
 *   mail           {mailpitUrl, shimUrl}
 *   stack          {ports, treeDir, stackDir, tmpDir, homeDir,
 *                   logs:{emulators, mailpit, shim, shimJsonl, build, egress}}
 *   expectVersion  the tree's package.json version
 *   fingerprint    how the tree was made (mode, base sha, dirty, sha256)
 *
 * No key, token or password is ever written here.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, assertPath, assertRunId, runDir as runDirFor, ensureDir, OUT_DIR, RUN_ID_RE, within } from "./paths.mjs";
import { assertStackPort, denySet } from "./ports.mjs";
import { scrubEnv } from "./proc.mjs";
import { LOCAL_CAPABILITIES, capabilitiesFor, patchCapability, patchSetsOf } from "./options.mjs";

export const PROD_NOT_IMPLEMENTED = "prod target not implemented in this build";

export { LOCAL_CAPABILITIES };

const SECRET_KEY_RE = /(secret|password|passwd|token|apikey|api_key|credential|privatekey)/i;
/** Public by design: a Firebase web key is inlined in every bundle; the other is a URL. */
const PUBLIC_KEYS = new Set(["webApiKey", "secureTokenBase"]);

/** Build the local Target from a stack record. */
export function localTarget(stack) {
  const p = stack.ports;
  const host = "127.0.0.1";
  const u = (port) => `http://${host}:${assertStackPort(port)}`;
  return {
    kind: "local",
    runId: assertRunId(stack.runId),
    runDir: assertPath(stack.runDir, "runDir"),
    origin: u(p.hosting),
    projectId: stack.projectId,
    webApiKey: stack.webApiKey,
    authEmulatorUrl: u(p.auth),
    authRestBase: `${u(p.auth)}/identitytoolkit.googleapis.com/v1`,
    secureTokenBase: `${u(p.auth)}/securetoken.googleapis.com/v1`,
    databaseURL: `${u(p.database)}?ns=${stack.projectId}`,
    firestoreUrl: u(p.firestore),
    storageUrl: u(p.storage),
    functionsUrl: u(p.functions),
    hubUrl: u(p.hub),
    bucket: stack.bucket,
    capabilities: capabilitiesFor(stack),
    options: { emailOff: !!stack.options?.emailOff, appEnv: { ...(stack.options?.appEnv ?? {}) }, rtdbProxy: !!stack.options?.rtdbProxy, gates: !!stack.options?.gates, storageShim: !!stack.options?.storageShim },
    patches: patchSetsOf(stack),
    mail: { mailpitUrl: u(p.mailpit), shimUrl: u(p.shim) },
    stack: {
      ports: { ...p },
      treeDir: stack.treeDir,
      stackDir: stack.stackDir,
      tmpDir: stack.tmpDir,
      homeDir: stack.homeDir,
      logs: { ...stack.logs },
    },
    expectVersion: stack.expectVersion,
    fingerprint: stack.fingerprint,
    rtdbEngine: stack.rtdbEngine ?? null,
    createdAt: stack.createdAt,
  };
}

/** The production Target is built by a later phase. */
export function prodTarget() {
  throw new Error(PROD_NOT_IMPLEMENTED);
}

function assertNoSecrets(value, path = "target") {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k) && !PUBLIC_KEYS.has(k)) throw new Error(`${path}.${k}: a target never carries secrets`);
      if (typeof v === "string" && /\bre_e2e_[0-9a-f]+/.test(v)) throw new Error(`${path}.${k}: holds the stack's mail key`);
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}

export function serializeTarget(target) {
  const plain = { ...target, capabilities: [...target.capabilities].sort() };
  assertNoSecrets(plain);
  return JSON.stringify(plain, null, 2) + "\n";
}

/** Write <runDir>/target.json and return its path. */
export function writeTarget(target) {
  ensureDir(target.runDir, "runDir");
  const file = join(target.runDir, "target.json");
  writeFileSync(file, serializeTarget(target));
  return file;
}

/**
 * The patch sets a local stack's tree was built with, from its run's
 * stack.json (the record startStack writes): for a target.json written before
 * targets carried `patches`. Null when the record is missing, unreadable or
 * says nothing.
 */
export function recordedPatchSets(runDir) {
  try {
    const rec = JSON.parse(readFileSync(join(assertPath(runDir, "runDir"), "stack.json"), "utf8"));
    return Array.isArray(rec?.patches) ? patchSetsOf(rec) : null;
  } catch {
    return null;
  }
}

/**
 * Load a Target from a target.json path, a run id, or E2E_TARGET.
 * Capabilities come back as a Set; the object is frozen. `patches` is the
 * list target.json holds; a target.json from before that field gets it from
 * the run's stack.json (recordedPatchSets), with a `patch:<set>` capability
 * for each, and null when neither says.
 */
export function loadTarget(ref = process.env.E2E_TARGET) {
  if (!ref) throw new Error("no target: set E2E_TARGET (run.mjs does) or pass a target.json path or run id");
  const file = RUN_ID_RE.test(ref) && !ref.includes("/") ? join(runDirFor(ref), "target.json") : ref;
  assertPath(file, "E2E_TARGET");
  if (!existsSync(file)) throw new Error(`no target at ${file}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (raw.kind === "prod") throw new Error(PROD_NOT_IMPLEMENTED);
  if (raw.kind !== "local") throw new Error(`unknown target kind ${raw.kind}`);
  const capabilities = new Set(raw.capabilities ?? []);
  let patches = Array.isArray(raw.patches) ? raw.patches.map(String) : null;
  if (!Array.isArray(raw.patches) && raw.runDir) {
    patches = recordedPatchSets(raw.runDir);
    for (const set of patches ?? []) capabilities.add(patchCapability(set));
  }
  const target = { ...raw, patches: patches ? Object.freeze(patches) : null, capabilities };
  return Object.freeze(target);
}

const CONST_NAME_RE = /^[A-Za-z_$][\w$]*$/;
/** A literal a constant may be: a number, a boolean, or a quoted string with no escape or substitution. */
const CONST_LITERAL_RE = /^(?:(-?(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?))|"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`\\$\n]*)`|(true|false))(?:\s+as\s+const)?\s*;?\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/;
/**
 * `{product: true}`: decimal integer literals joined by `*` on one line, and
 * nothing else, then what CONST_LITERAL_RE allows after a value (`as const`,
 * a semicolon, a comment). A factor has `_` only between two digits and no
 * leading zero (a legacy octal in sloppy JavaScript).
 */
const CONST_PRODUCT_RE = /^((?:0|[1-9](?:_?\d)*)(?:[ \t]*\*[ \t]*(?:0|[1-9](?:_?\d)*))*)(?:\s+as\s+const)?\s*;?\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/;
/**
 * The same two with the `;` REQUIRED, for a value alone on the line after
 * `=`: without it the line after could continue the expression.
 */
function requireSemicolon(re) {
  const OPTIONAL = String.raw`\s*;?\s*`;
  if (re.source.split(OPTIONAL).length !== 2) throw new Error("treeConstant: a value pattern lost its optional semicolon");
  return new RegExp(re.source.replace(OPTIONAL, String.raw`\s*;\s*`), re.flags);
}
const CONST_LITERAL_ENDED_RE = requireSemicolon(CONST_LITERAL_RE);
const CONST_PRODUCT_ENDED_RE = requireSemicolon(CONST_PRODUCT_RE);

/**
 * A top-level `[export] const NAME = <literal>;` from a source file of the
 * tree the target runs, as a string: read from the stack's tree
 * (target.stack.treeDir) when the target has one, from this checkout
 * otherwise. A tree that lacks the file is an error, never a fall-back to
 * this checkout, whose value need not be the one the stack was built with.
 *
 * Numbers come back in decimal ("3", "60000" for 60_000), strings without
 * their quotes, booleans as "true" or "false". Anything else — an
 * expression, an escape, a template with a substitution, a declaration that
 * is indented, or the name declared twice — throws.
 *
 * The value may stand alone on the line after the `=`, as a formatter wraps
 * a long literal (`export const SUGGESTED_FOOTER =\n  "…";`): nothing after
 * the `=`, then ONE indented line holding the whole value and its `;`. That
 * line is read exactly as a value on the declaration's own line would be. A
 * value that goes on past it, a following line without its `;` (the next one
 * could continue the expression), a blank or unindented line, or the end of
 * the file throws.
 *
 * With `{product: true}` the value must instead be an INTEGER PRODUCT:
 * decimal integer literals (`_` separators allowed) joined by `*`, one factor
 * alone included, as `5 * 60 * 1000` or `5 * 60_000`. It comes back as a
 * decimal string ("300000"). A name, a parenthesis, any other operator, a
 * sign, a fraction, an exponent, a hex literal, a string or a boolean throws,
 * and so does a product past Number.MAX_SAFE_INTEGER. Without the option an
 * integer product throws, as any expression does.
 *
 *   treeConstant(target, "functions/src/lib/thumbs.ts", "THUMB_REVISION")  // "3"
 *   treeConstant(target, "functions/src/config.ts", "MAX_BEAT_MS", { product: true })  // "300000"
 */
export function treeConstant(target, rel, name, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new Error(`treeConstant: options are an object, {product}, got ${JSON.stringify(options)}`);
  const { product = false, ...unknown } = options;
  if (Object.keys(unknown).length > 0) throw new Error(`treeConstant: unknown option(s) ${Object.keys(unknown).join(", ")} (the one option is {product})`);
  if (typeof product !== "boolean") throw new Error(`treeConstant: product is true or false, got ${JSON.stringify(product)}`);
  if (typeof name !== "string" || !CONST_NAME_RE.test(name)) throw new Error(`treeConstant: not an identifier: ${JSON.stringify(name)}`);
  if (typeof rel !== "string" || rel.length === 0 || rel.startsWith("/")) throw new Error(`treeConstant: want a path relative to the tree, got ${JSON.stringify(rel)}`);
  const tree = target?.stack?.treeDir;
  const root = tree ? assertPath(tree, "treeDir") : REPO_ROOT;
  const where = tree ? `the stack's tree (${root})` : "this checkout";
  const file = within(root, rel);
  if (!existsSync(file)) throw new Error(`treeConstant: ${rel} is not in ${where}`);
  // [ \t], never \s: a declaration must not run onto the next line.
  const decl = new RegExp(`^(?:export[ \\t]+)?const[ \\t]+${name.replace(/\$/g, "\\$")}(?:[ \\t]*:[ \\t]*[^=\\n]+?)?[ \\t]*=[ \\t]*(.*)$`, "gm");
  const src = readFileSync(file, "utf8");
  const found = [...src.matchAll(decl)];
  if (found.length === 0) throw new Error(`treeConstant: no top-level const ${name} in ${rel} (${where})`);
  if (found.length > 1) throw new Error(`treeConstant: const ${name} is declared ${found.length} times in ${rel} (${where})`);
  let text = found[0][1].trim();
  // A value alone on the next line must end with its ";" (requireSemicolon).
  const wrapped = text === "";
  if (wrapped) text = valueOnNextLine(src, found[0], { name, rel });
  const literalRe = wrapped ? CONST_LITERAL_ENDED_RE : CONST_LITERAL_RE;
  const productRe = wrapped ? CONST_PRODUCT_ENDED_RE : CONST_PRODUCT_RE;
  const unended = (re, what) => {
    if (wrapped && re.test(text)) throw new Error(`treeConstant: ${name} in ${rel} is not ${what}: its value on the next line does not end with ";", so the line after could continue it: ${text.slice(0, 80)}`);
  };
  if (product) {
    const p = productRe.exec(text);
    if (!p) unended(CONST_PRODUCT_RE, "an integer product");
    if (!p) throw new Error(`treeConstant: ${name} in ${rel} is not an integer product (decimal integer literals joined by *): ${text.slice(0, 80)}`);
    // BigInt, so a product past 2^53 is refused rather than rounded.
    const value = p[1].split("*").reduce((acc, f) => acc * BigInt(f.trim().replace(/_/g, "")), 1n);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`treeConstant: ${name} in ${rel} is ${value}, past Number.MAX_SAFE_INTEGER: ${text.slice(0, 80)}`);
    return value.toString();
  }
  const m = literalRe.exec(text);
  if (!m) {
    unended(CONST_LITERAL_RE, "a plain literal");
    const hint = productRe.test(text) ? " (an integer product: pass {product: true})" : "";
    throw new Error(`treeConstant: ${name} in ${rel} is not a plain literal: ${text.slice(0, 80)}${hint}`);
  }
  if (m[1] !== undefined) {
    const n = Number(m[1].replace(/_/g, ""));
    if (!Number.isFinite(n)) throw new Error(`treeConstant: ${name} in ${rel} is not a finite number: ${m[1]}`);
    return String(n);
  }
  return m[2] ?? m[3] ?? m[4] ?? m[5];
}

/**
 * `export const NAME =` with nothing after it: the value is the next line,
 * which must be indented (treeConstant then requires it to end the
 * declaration with its `;`, so that no further line can belong to it).
 */
function valueOnNextLine(src, match, { name, rel }) {
  const rest = src.slice(match.index + match[0].length);
  const next = /^\r?\n[ \t]+(\S[^\r\n]*)/.exec(rest);
  if (!next) throw new Error(`treeConstant: ${name} in ${rel} has nothing after "=", and the next line is not an indented value`);
  return next[1].trim();
}

/** Throw unless the target has every named capability. */
export function requireCapability(target, ...names) {
  const missing = names.filter((n) => !target.capabilities.has(n));
  if (missing.length > 0) {
    const err = new Error(`target ${target.kind} lacks ${missing.join(", ")}`);
    err.code = "E2E_CAPABILITY";
    throw err;
  }
}

/**
 * Emulator host env for a LOCAL target: what the Admin SDK and scripts/ need.
 * Given only to spawned spec processes, never to the stack itself.
 */
export function emulatorEnv(target) {
  if (target.kind !== "local") throw new Error("emulator env exists only for a local target");
  const p = target.stack.ports;
  const h = (port) => `127.0.0.1:${assertStackPort(port)}`;
  return {
    FIRESTORE_EMULATOR_HOST: h(p.firestore),
    FIREBASE_AUTH_EMULATOR_HOST: h(p.auth),
    FIREBASE_DATABASE_EMULATOR_HOST: h(p.database),
    FIREBASE_STORAGE_EMULATOR_HOST: h(p.storage),
    STORAGE_EMULATOR_HOST: `http://${h(p.storage)}`,
    FIREBASE_EMULATOR_HUB: h(p.hub),
    GCLOUD_PROJECT: target.projectId,
    GOOGLE_CLOUD_PROJECT: target.projectId,
  };
}

/** The env a spec process runs with: the caller's minus every binding, plus the target. */
export function specEnv(target, targetFile, base = process.env) {
  const env = scrubEnv(base);
  env.E2E_TARGET = assertPath(targetFile, "target file");
  env.E2E_RUN_ID = target.runId;
  if (target.kind === "local") Object.assign(env, emulatorEnv(target));
  return env;
}

/** Refuse anything but this stack's own ports — reset helpers call this first. */
export function assertTargetPort(target, port) {
  assertStackPort(port, denySet());
  if (!Object.values(target.stack?.ports ?? {}).includes(port)) {
    throw new Error(`port ${port} is not one of run ${target.runId}'s ports`);
  }
  return port;
}

/**
 * Clear emulator data on THIS stack only. Never on a default port, never on
 * another stack's, never on prod.
 */
export async function resetLocal(target, { firestore = true, auth = true, database = true } = {}) {
  if (target.kind !== "local" || !target.capabilities.has("reset")) throw new Error("reset is local-only");
  const p = target.stack.ports;
  const done = [];
  const call = async (port, method, path, body) => {
    assertTargetPort(target, port);
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body,
    });
    if (!r.ok) throw new Error(`${method} ${path} on ${port}: ${r.status} ${await r.text()}`);
    done.push(`${method} :${port}${path.split("?")[0]}`);
  };
  if (firestore) await call(p.firestore, "DELETE", `/emulator/v1/projects/${target.projectId}/databases/(default)/documents`);
  if (auth) await call(p.auth, "DELETE", `/emulator/v1/projects/${target.projectId}/accounts`);
  if (database) await call(p.database, "PUT", `/.json?ns=${target.projectId}`, "null");
  return done;
}

export { OUT_DIR };
