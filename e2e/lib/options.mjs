// SPDX-License-Identifier: Apache-2.0
// Stack options some areas need — email off, allowlisted app build variables — and the capabilities a stack advertises (SPEC §12, §14, §15, §20).

/**
 *   node e2e/run.mjs stack up --email-off
 *   node e2e/run.mjs run --app-env VITE_FIREBASE_MEASUREMENT_ID=dummy …
 *
 * --email-off      the product's OWN off switch: RESEND_API_KEY holds a single
 *                  space (Secret Manager refuses an empty payload, so that is
 *                  how a deployment says "email off", and send.ts trims). The
 *                  shim still runs, with its own dummy key, and must then
 *                  receive nothing from the product. The target loses `email`
 *                  and gains `email-off`.
 * --app-env K=V    an app build variable from APP_ENV_ALLOWLIST, on top of
 *                  app/.env.example. VITE_FIREBASE_MEASUREMENT_ID takes only
 *                  `dummy`: a measurement-id-shaped value generated at build
 *                  time, so no tracked file ever holds one. The target gains
 *                  `measurement-id`, and target.options.appEnv carries the
 *                  value. (Under VITE_USE_EMULATORS the app never initializes
 *                  Analytics, whatever the id: SPEC §15 "never under
 *                  emulators" is what such a stack can show.)
 *                  VITE_EXPORT_MARK_ENABLED (1, true or yes; the key alone is
 *                  1), VITE_EXPORT_MARK_LABEL (at most 40 characters) and
 *                  VITE_EXPORT_MARK_FOOTER (at most 300) are the deployment's
 *                  default export marking (SPEC §20), taken as given; the
 *                  first adds `export-mark-default`. Whether their values
 *                  reached the bundle is recorded, not required: whether the
 *                  app uses them is what a case tests.
 *
 * --rtdb-proxy     the app bundle dials the Database emulator through a raw
 *                  TCP proxy on the stack's block (role `rtdbProxy`), run by
 *                  the stack's aux process (lib/stackaux.mjs), whose delay per
 *                  direction a spec sets at runtime (rtdbLatency in
 *                  lib/proxy.mjs). Capability `rtdb-proxy`.
 * --gates          the stack runs the gate service (lib/gates.mjs) in its aux
 *                  process on the role `gate`, and the functions get
 *                  E2E_GATE_URL and the app build VITE_E2E_GATE_URL: what an
 *                  amplify set's pause points and client gates call. Implied
 *                  by any amplify-* patch set. Capability `gates`.
 * --storage-shim   the aux process runs a Storage shim (lib/storage-shim.mjs)
 *                  on the role `storageShim` in front of the Storage
 *                  emulator, and the function workers dial it: it refuses a
 *                  second create-only write or copy (ifGenerationMatch=0
 *                  onto an existing object: 412) under one lock per object,
 *                  as Cloud Storage does. Capability `storage-shim`, and
 *                  through the readiness probe `storage-preconditions`.
 *
 * Options are recorded in stack.json (`options`) and target.json (`options`,
 * plus the capabilities they imply), so a spec declares `needs` instead of
 * asking how its stack was built. Every patch set applied to the tree adds
 * `patch:<set>` (patchCapability), and target.json lists them as `patches`.
 */

import { randomBytes } from "node:crypto";
import { isAmplifySet } from "./gates.mjs";

/** What every local stack can do (target.mjs re-exports this; capabilitiesFor() adjusts it per stack). */
export const LOCAL_CAPABILITIES = Object.freeze([
  "local", "email", "mailpit", "admin-emulator", "oob-codes", "reset", "logs", "patches",
]);

/** The measurement id shape, built from parts so no source line holds one. */
const MEASUREMENT_PREFIX = ["G", ""].join("-");
const MEASUREMENT_RE = new RegExp(`^${MEASUREMENT_PREFIX}[A-Z0-9]{10}$`);
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A fresh, measurement-id-shaped dummy: the prefix and ten random upper-case letters or digits. */
export function dummyMeasurementId() {
  const bytes = randomBytes(10);
  return MEASUREMENT_PREFIX + [...bytes].map((b) => ALNUM[b % ALNUM.length]).join("");
}

export function isMeasurementIdShape(value) {
  return MEASUREMENT_RE.test(String(value ?? ""));
}

/**
 * A deployment marking text (SPEC §20) as the app will read it: config.ts
 * trims it and the server keeps at most `max` UTF-16 units and no control
 * characters (functions/src/lib/marking.ts), so a value that either would
 * change is refused rather than silently differing from target.options.
 */
function markingText(key, max) {
  return (value) => {
    const v = String(value ?? "");
    if (v === "") throw new Error(`${key} takes a non-empty value (an empty one is the default: leave the key out)`);
    if (v !== v.trim()) throw new Error(`${key}: the app trims its value (config.ts env()), so pass it without leading or trailing whitespace`);
    if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error(`${key}: the server strips control characters (marking.ts clean()), so pass none`);
    if (v.length > max) throw new Error(`${key} is at most ${max} characters (the server's cap, marking.ts), got ${v.length}`);
    return v;
  };
}

/**
 * The app build variables a stack may set, and how each value is checked or
 * made. Add a key here (and to the README) to allow it.
 *
 *   capability  added to the target when the key is set
 *   inBundle    "required" (the default): verifyBuild (stack.mjs) refuses a
 *               build the value never reached, so an option cannot silently
 *               do nothing; "recorded": whether it did is written to the
 *               stack record's build (appEnvInBundle) and nothing more,
 *               because whether the app uses it is what a case tests
 *   resolve     the value as given (or "" for the key alone) → the value the
 *               build gets, or a throw
 */
export const APP_ENV_ALLOWLIST = Object.freeze({
  VITE_FIREBASE_MEASUREMENT_ID: {
    capability: "measurement-id",
    resolve(value) {
      if (value === "dummy" || value === "" || value === undefined) return dummyMeasurementId();
      throw new Error("VITE_FIREBASE_MEASUREMENT_ID takes only `dummy` (a generated value): a real id never goes into a stack");
    },
  },
  VITE_EXPORT_MARK_ENABLED: {
    capability: "export-mark-default",
    inBundle: "recorded",
    resolve(value) {
      if (value === "" || value === undefined) return "1";
      // config.ts flag(): "1", "true" or "yes", trimmed and lower-cased.
      if (/^(?:1|true|yes)$/i.test(String(value))) return String(value);
      throw new Error("VITE_EXPORT_MARK_ENABLED turns the deployment marking on: 1, true or yes (or the key alone); off is the default, so leave it out");
    },
  },
  VITE_EXPORT_MARK_LABEL: { inBundle: "recorded", resolve: markingText("VITE_EXPORT_MARK_LABEL", 40) },
  VITE_EXPORT_MARK_FOOTER: { inBundle: "recorded", resolve: markingText("VITE_EXPORT_MARK_FOOTER", 300) },
});

/** Whether verifyBuild must find this key's value in the bundle ("required", also for a key no rule names) or only records it ("recorded"). */
export function appEnvBundleRule(key) {
  return APP_ENV_ALLOWLIST[key]?.inBundle ?? "required";
}

/** The capability a patch set applied to a stack's tree gives its target. */
export const PATCH_CAPABILITY_PREFIX = "patch:";
const PATCH_SET_RE = /^[a-z0-9][a-z0-9-]*$/;

/** `patch:<set>`, the capability of a stack built with e2e/patches/<set> (`needs: [patchCapability("a19-analytics-live")]`). */
export function patchCapability(set) {
  if (typeof set !== "string" || !PATCH_SET_RE.test(set)) throw new Error(`not a patch set name: ${JSON.stringify(set)}`);
  return `${PATCH_CAPABILITY_PREFIX}${set}`;
}

/** The names of the patch sets a stack record says were applied, in order (`rec.patches`: [{set, applied}]). */
export function patchSetsOf(rec) {
  return (Array.isArray(rec?.patches) ? rec.patches : []).map((p) => p?.set).filter((set) => typeof set === "string" && PATCH_SET_RE.test(set));
}

/** `--app-env K=V` strings → {K: V}; a bare `K` means `K=dummy`-style default (""), resolved later. */
export function parseAppEnvArgs(list = []) {
  const out = {};
  for (const item of list) {
    const m = /^([A-Z][A-Z0-9_]*)(?:=(.*))?$/.exec(String(item));
    if (!m) throw new Error(`--app-env wants KEY=VALUE, not ${JSON.stringify(item)}`);
    if (!APP_ENV_ALLOWLIST[m[1]]) throw new Error(`--app-env ${m[1]} is not allowlisted (allowed: ${Object.keys(APP_ENV_ALLOWLIST).join(", ")})`);
    if (m[1] in out) throw new Error(`--app-env ${m[1]} given twice`);
    out[m[1]] = m[2] ?? "";
  }
  return out;
}

/**
 * Normalize what startStack() was given: {emailOff, appEnv, rtdbProxy,
 * gates, storageShim} with every app value resolved (a `dummy` becomes the
 * generated value). Idempotent on its own output only for keys whose
 * resolver accepts it — so resolve ONCE, at stack start. `gates` here is what
 * was ASKED for; startStack adds it for an amplify set (stackGates).
 */
export function normalizeStackOptions({ emailOff = false, appEnv = {}, rtdbProxy = false, gates = false, storageShim = false } = {}) {
  const resolved = {};
  for (const [k, v] of Object.entries(appEnv ?? {})) {
    const rule = APP_ENV_ALLOWLIST[k];
    if (!rule) throw new Error(`app env ${k} is not allowlisted (allowed: ${Object.keys(APP_ENV_ALLOWLIST).join(", ")})`);
    resolved[k] = rule.resolve(v);
    if (/[\n\r"]/.test(resolved[k])) throw new Error(`app env ${k}: the value cannot be passed to the build`);
  }
  return { emailOff: !!emailOff, appEnv: resolved, rtdbProxy: !!rtdbProxy, gates: !!gates, storageShim: !!storageShim };
}

/** Whether a stack with these options and patch sets runs the gate service: asked for, or implied by an amplify-* set. */
export function stackGates({ gates = false, patchSets = [] } = {}) {
  return !!gates || (patchSets ?? []).some((s) => isAmplifySet(s));
}

/** The CLI arguments that rebuild a stack with these (unresolved) options, for controls and reruns. */
export function stackOptionArgs({ emailOff = false, appEnv = {}, rtdbProxy = false, gates = false, storageShim = false, patches = [] } = {}) {
  return [
    ...(emailOff ? ["--email-off"] : []),
    ...Object.entries(appEnv ?? {}).flatMap(([k, v]) => ["--app-env", v === "" ? k : `${k}=${v}`]),
    ...(rtdbProxy ? ["--rtdb-proxy"] : []),
    ...(gates ? ["--gates"] : []),
    ...(storageShim ? ["--storage-shim"] : []),
    ...(patches ?? []).flatMap((p) => ["--patches", p]),
  ];
}

/**
 * Parse the stack-option arguments that `run`, `stack up` and a control.json
 * accept: --email-off, --app-env KEY=VALUE, --rtdb-proxy, --gates,
 * --storage-shim, and `--patches <set>` for an amplify set or one of the
 * named capability-only sets below. Both control sides get that setup;
 * arbitrary product patches and other controls remain refused here. Returns {emailOff, appEnv}, plus `rtdbProxy: true`,
 * `gates: true`, `storageShim: true` and `patches: [sets]` only when given
 * (so a list without them parses as it always did).
 */
export const CONTROL_CAPABILITY_PATCHES = Object.freeze(["a12-projection-unavailable", "a19-analytics-live", "a20-cli-bad-skill-name", "a20-cli-uppercase-skill", "a20-cli-underscore-skill", "a20-cli-no-retry-delay"]);

export function parseStackOptionArgs(args = []) {
  const out = { emailOff: false, appEnv: [], rtdbProxy: false, gates: false, storageShim: false, patches: [] };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--email-off") out.emailOff = true;
    else if (args[i] === "--app-env" && i + 1 < args.length) out.appEnv.push(args[++i]);
    else if (String(args[i]).startsWith("--app-env=")) out.appEnv.push(String(args[i]).slice("--app-env=".length));
    else if (args[i] === "--rtdb-proxy") out.rtdbProxy = true;
    else if (args[i] === "--gates") out.gates = true;
    else if (args[i] === "--storage-shim") out.storageShim = true;
    else if (args[i] === "--patches" && i + 1 < args.length && (isAmplifySet(args[i + 1]) || CONTROL_CAPABILITY_PATCHES.includes(args[i + 1]))) out.patches.push(args[++i]);
    else if (args[i] === "--patches") throw new Error(`not a stack option: --patches ${args[i + 1] ?? ""} (only an amplify-* or allowlisted capability set may be named here)`);
    else throw new Error(`not a stack option: ${args[i]} (allowed: --email-off, --app-env KEY=VALUE, --rtdb-proxy, --gates, --storage-shim, --patches amplify-<name>)`);
  }
  const parsed = { emailOff: out.emailOff, appEnv: parseAppEnvArgs(out.appEnv) };
  if (out.rtdbProxy) parsed.rtdbProxy = true;
  if (out.gates) parsed.gates = true;
  if (out.storageShim) parsed.storageShim = true;
  if (out.patches.length) parsed.patches = out.patches;
  return parsed;
}

/**
 * The VITE_* environment of the app build: app/.env.example's VITE_ values,
 * the database URL moved onto the stack, the origin, then the allowlisted
 * overrides.
 */
export function viteEnvFor(example, { databasePort, projectId, origin, appEnv = {}, gateUrl = null }) {
  const env = {};
  for (const [k, v] of Object.entries(example ?? {})) if (k.startsWith("VITE_")) env[k] = v;
  if (env.VITE_FIREBASE_PROJECT_ID !== projectId) throw new Error(`app/.env.example project is ${env.VITE_FIREBASE_PROJECT_ID}, not ${projectId}`);
  env.VITE_FIREBASE_DATABASE_URL = `http://127.0.0.1:${databasePort}?ns=${projectId}`;
  env.BIKESHED_PUBLIC_ORIGIN = origin;
  for (const [k, v] of Object.entries(appEnv)) {
    if (!APP_ENV_ALLOWLIST[k]) throw new Error(`app env ${k} is not allowlisted`);
    env[k] = v;
  }
  // Only a gated stack's build has it: a client gate without it fails closed (lib/gates.mjs).
  if (gateUrl != null) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(gateUrl)) throw new Error(`the gate URL must be http://127.0.0.1:<port>, got ${JSON.stringify(gateUrl)}`);
    env.VITE_E2E_GATE_URL = gateUrl;
  }
  return env;
}

/**
 * The capabilities of a local stack, from its record: the base set, adjusted
 * by its options and by what its harness version built (an old record lacks
 * the newer ones, so a spec that needs them is skipped there, not broken).
 */
export function capabilitiesFor(rec) {
  const caps = new Set(LOCAL_CAPABILITIES);
  const opts = rec?.options ?? {};
  if (opts.emailOff) {
    caps.delete("email");
    caps.add("email-off");
  }
  for (const k of Object.keys(opts.appEnv ?? {})) if (APP_ENV_ALLOWLIST[k]?.capability) caps.add(APP_ENV_ALLOWLIST[k].capability);
  if (rec?.logs?.egress && rec?.egress) caps.add("egress-guard");
  const spares = Object.keys(rec?.ports ?? {}).filter((r) => /^spare\d*$/.test(r)).length;
  if (spares >= 2) caps.add("spare-pool");
  if (rec?.shim?.failRecipient) caps.add("mail-fail-recipient");
  if (rec?.shim?.features?.includes("hold-recipient")) caps.add("mail-hold-recipient");
  if (rec?.homeDir) caps.add("operator-scripts");
  // Readiness proved ns=<projectId> enforces the tree's RTDB rules (stack.mjs checkRtdbRules).
  if (rec?.rtdbRules?.equal === true && rec.rtdbRules.anonymousStatus === 401) caps.add("rtdb-rules");
  // Readiness proved Storage refuses a second create-only write and copy (ifGenerationMatch=0), as the
  // product's CREATE_ONLY needs (stack.mjs waitReady, lib/storage-preconditions.mjs). Only `true` counts:
  // false (accepted, as the emulator of firebase-tools 15.25.1 does) and null (could not tell) do not.
  if (rec?.storagePreconditions?.honoured === true) caps.add("storage-preconditions");
  // JVM heap caps, capped debug logs, an owner, a lease and a watchdog (stack.mjs MEMORY).
  if (rec?.jvm?.heapMb && rec?.debugLogs && rec?.owner && (rec?.processes ?? []).some((p) => p.name === "watchdog")) caps.add("resource-caps");
  // The aux process (lib/stackaux.mjs), checked at readiness: the gate service, and the RTDB proxy the bundle dials.
  const aux = (rec?.processes ?? []).some((p) => p.name === "aux");
  if (aux && rec?.aux?.gates === true && Number.isInteger(rec?.ports?.gate)) caps.add("gates");
  if (aux && rec?.aux?.proxy && Number.isInteger(rec?.ports?.rtdbProxy) && rec?.build?.databasePort === rec.ports.rtdbProxy) caps.add("rtdb-proxy");
  // The Storage shim (lib/storage-shim.mjs): the aux serves it on its block role, and readiness
  // proved the function workers dial it (stack.mjs waitReady, rec.storageShim.redirect).
  if (aux && Number.isInteger(rec?.ports?.storageShim) && rec?.aux?.storageShim === rec.ports.storageShim && rec?.storageShim?.redirect?.ok === true) caps.add("storage-shim");
  for (const set of patchSetsOf(rec)) caps.add(patchCapability(set));
  return caps;
}
