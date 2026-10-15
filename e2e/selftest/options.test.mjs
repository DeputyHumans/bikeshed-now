// SPDX-License-Identifier: Apache-2.0
// Self-test: stack options — email off, allowlisted app variables — become the right files, build env and capabilities; operator scripts get the stack's HOME (SPEC §12).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OUT_DIR } from "../lib/paths.mjs";
import { BLOCK_SIZE, namePorts } from "../lib/ports.mjs";
import { writeFunctionsEnv } from "../lib/patch.mjs";
import { which } from "../lib/proc.mjs";
import { verifyBuild } from "../lib/stack.mjs";
import { LOCAL_CAPABILITIES, localTarget, serializeTarget } from "../lib/target.mjs";
import {
  APP_ENV_ALLOWLIST, capabilitiesFor, dummyMeasurementId, isMeasurementIdShape, normalizeStackOptions,
  parseAppEnvArgs, parseStackOptionArgs, stackOptionArgs, viteEnvFor,
} from "../lib/options.mjs";
import { dummyAdc, operatorEnv } from "../lib/operator.mjs";
import { installEgressGuard } from "../lib/egress.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const PORTS = namePorts(Array.from({ length: BLOCK_SIZE }, (_, i) => 36000 + i));
const OLD_PORTS = Object.fromEntries(Object.entries(PORTS).filter(([k]) => !/^spare\d$/.test(k)));
const M = "VITE_FIREBASE_MEASUREMENT_ID";
const work = tempDir("e2e-options-");
after(() => rmSync(work, { recursive: true, force: true }));

const record = (over = {}) => ({
  runId: "2610101200-opts",
  runDir: join(OUT_DIR, "2610101200-opts"),
  ports: PORTS,
  projectId: "demo-bikeshed",
  webApiKey: "demo-api-key",
  bucket: "demo-bikeshed-content",
  treeDir: join(work, "tree"),
  stackDir: work,
  homeDir: join(work, "home"),
  tmpDir: join(work, "tmp"),
  logs: { emulators: join(work, "emulators.log"), egress: join(work, "egress.jsonl") },
  egress: { file: join(work, "tree", ".e2e", "egress-guard.mjs"), sha256: "x" },
  shim: { failRecipient: true, features: ["fail-recipient"] },
  options: { emailOff: false, appEnv: {} },
  expectVersion: "0.0.0",
  fingerprint: { mode: "rev" },
  createdAt: "now",
  ...over,
});

test("--app-env: only allowlisted keys; the measurement id only as `dummy`, generated in its shape at stack start", () => {
  assert.deepEqual(Object.keys(APP_ENV_ALLOWLIST), [M, "VITE_EXPORT_MARK_ENABLED", "VITE_EXPORT_MARK_LABEL", "VITE_EXPORT_MARK_FOOTER"]);
  assert.deepEqual(parseAppEnvArgs([`${M}=dummy`]), { [M]: "dummy" });
  assert.deepEqual(parseAppEnvArgs([M]), { [M]: "" });
  assert.throws(() => parseAppEnvArgs(["VITE_FIREBASE_API_KEY=x"]), /not allowlisted/);
  assert.throws(() => parseAppEnvArgs([`${M}=dummy`, `${M}=dummy`]), /given twice/);
  assert.throws(() => parseAppEnvArgs(["lower=x"]), /KEY=VALUE/);
  const a = normalizeStackOptions({ appEnv: { [M]: "dummy" } }).appEnv[M];
  const b = normalizeStackOptions({ appEnv: { [M]: "" } }).appEnv[M];
  assert.ok(isMeasurementIdShape(a) && isMeasurementIdShape(b), `${a} ${b}`);
  assert.notEqual(a, b, "a fresh value every time");
  assert.throws(() => normalizeStackOptions({ appEnv: { [M]: dummyMeasurementId() } }), /only `dummy`/, "a real-looking id typed in is refused");
  assert.equal(isMeasurementIdShape("dummy"), false);
  assert.deepEqual(parseStackOptionArgs(stackOptionArgs({ emailOff: true, appEnv: { [M]: "dummy" } })), { emailOff: true, appEnv: { [M]: "dummy" } });
  assert.throws(() => parseStackOptionArgs(["--keep"]), /not a stack option/);
});

test("viteEnvFor: .env.example's VITE_ values, the database moved onto the stack, then the allowlisted overrides", () => {
  const example = { VITE_USE_EMULATORS: "1", VITE_FIREBASE_PROJECT_ID: "demo-bikeshed", VITE_FIREBASE_DATABASE_URL: "x", [M]: "", OTHER: "dropped" };
  const id = dummyMeasurementId();
  const env = viteEnvFor(example, { databasePort: 36005, projectId: "demo-bikeshed", origin: "http://127.0.0.1:36007", appEnv: { [M]: id } });
  assert.equal(env.VITE_FIREBASE_DATABASE_URL, "http://127.0.0.1:36005?ns=demo-bikeshed");
  assert.equal(env.BIKESHED_PUBLIC_ORIGIN, "http://127.0.0.1:36007");
  assert.equal(env[M], id);
  assert.equal(env.VITE_USE_EMULATORS, "1");
  assert.equal(env.OTHER, undefined);
  assert.equal(viteEnvFor(example, { databasePort: 1, projectId: "demo-bikeshed", origin: "o" })[M], "", "without the option the example's empty value stays");
  assert.throws(() => viteEnvFor({ ...example, VITE_FIREBASE_PROJECT_ID: "not-demo" }, { databasePort: 1, projectId: "demo-bikeshed", origin: "o" }), /not demo-bikeshed/);
  assert.throws(() => viteEnvFor(example, { databasePort: 1, projectId: "demo-bikeshed", origin: "o", appEnv: { VITE_X: "1" } }), /not allowlisted/);
});

test("capabilities follow the record: email off swaps email for email-off; options and harness features add theirs; an old record gets only the base", () => {
  const caps = (over) => [...capabilitiesFor(record(over))].sort();
  assert.deepEqual(caps({}), [...LOCAL_CAPABILITIES, "egress-guard", "mail-fail-recipient", "operator-scripts", "spare-pool"].sort());
  assert.ok(caps({ shim: { failRecipient: true, features: ["hold-recipient"] } }).includes("mail-hold-recipient"));
  assert.ok(!caps({}).includes("mail-hold-recipient"), "older shims do not claim hold support");
  const off = caps({ options: { emailOff: true, appEnv: {} } });
  assert.ok(off.includes("email-off") && !off.includes("email"));
  assert.ok(caps({ options: { emailOff: false, appEnv: { [M]: dummyMeasurementId() } } }).includes("measurement-id"));
  const old = caps({ ports: OLD_PORTS, egress: undefined, shim: undefined, options: undefined, homeDir: undefined, logs: { emulators: "x" } });
  assert.deepEqual(old, [...LOCAL_CAPABILITIES].sort(), "a 16-port record from an older harness: base set only");
});

test("localTarget carries options, the stack HOME and the capabilities; it still serializes without any secret", () => {
  const t = localTarget(record({ options: { emailOff: true, appEnv: { [M]: dummyMeasurementId() } } }));
  assert.equal(t.options.emailOff, true);
  assert.ok(isMeasurementIdShape(t.options.appEnv[M]));
  assert.equal(t.stack.homeDir, join(work, "home"));
  assert.equal(t.stack.logs.egress, join(work, "egress.jsonl"));
  assert.ok(t.capabilities.has("email-off") && !t.capabilities.has("email") && t.capabilities.has("measurement-id"));
  const json = JSON.parse(serializeTarget(t));
  assert.ok(json.capabilities.includes("email-off"));
});

test("email off writes the product's own off switch — RESEND_API_KEY=\" \" — which firebase-tools' parser reads as one space; the shim keeps its key", () => {
  const tree = join(work, "fn-tree");
  mkdirSync(join(tree, "functions"), { recursive: true });
  writeFileSync(join(tree, "functions", "package.json"), "{}");
  const off = writeFunctionsEnv(tree, PORTS, { emailOff: true });
  const secret = readFileSync(join(tree, "functions", ".secret.local"), "utf8");
  assert.equal(secret, 'RESEND_API_KEY=" "\n');
  assert.match(off.apiKey, /^re_e2e_[0-9a-f]+$/, "the shim still gets a dummy key");
  assert.equal(off.emailOff, true);
  // The emulator's own dotenv parser, from the installed firebase-tools.
  const bin = which("firebase");
  const envJs = bin ? join(dirname(realpathSync(bin)), "..", "functions", "env.js") : null;
  assert.ok(envJs && existsSync(envJs), "firebase-tools, a prerequisite of every stack, is on PATH");
  const { parseStrict } = createRequire(import.meta.url)(envJs);
  assert.deepEqual(parseStrict(secret), { RESEND_API_KEY: " " }, "a single space: truthy to the emulator (no Secret Manager lookup), empty to send.ts after its trim");
  const on = writeFunctionsEnv(tree, PORTS);
  assert.equal(readFileSync(join(tree, "functions", ".secret.local"), "utf8"), `RESEND_API_KEY=${on.apiKey}\n`);
});

test("operatorEnv: the stack's HOME (never the user's), its emulators, a dummy ADC outside gcloud's default path, the egress guard", () => {
  const rec = record();
  mkdirSync(join(rec.treeDir, "scripts"), { recursive: true });
  installEgressGuard(rec.treeDir);
  const t = localTarget(rec);
  const env = operatorEnv(t);
  assert.equal(env.HOME, t.stack.homeDir);
  assert.notEqual(env.HOME, homedir());
  assert.equal(env.FIRESTORE_EMULATOR_HOST, `127.0.0.1:${PORTS.firestore}`);
  assert.equal(env.GCLOUD_PROJECT, "demo-bikeshed");
  assert.equal(env.BIKESHED_BUCKET, "demo-bikeshed-content");
  const adc = JSON.parse(readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  assert.equal(adc.type, "authorized_user");
  assert.ok(env.GOOGLE_APPLICATION_CREDENTIALS.startsWith(`${t.stack.homeDir}/`));
  assert.ok(!env.GOOGLE_APPLICATION_CREDENTIALS.includes(join(".config", "gcloud")), "not where the stack's own processes would find it");
  assert.equal(statSync(env.GOOGLE_APPLICATION_CREDENTIALS).mode & 0o777, 0o600);
  assert.equal(dummyAdc(t), env.GOOGLE_APPLICATION_CREDENTIALS, "written once");
  assert.match(env.NODE_OPTIONS, /^--require=\/.*\/\.e2e\/egress-guard\.mjs$/, "--require, so worker threads are guarded too");
  assert.equal(env.E2E_EGRESS_LOG, t.stack.logs.egress);
  for (const k of Object.keys(env)) assert.ok(!/^(BIKESHED_ORIGIN|BIKESHED_TOKEN|RESEND_|VITE_)/.test(k), `${k} must not be there`);
  assert.throws(() => operatorEnv(t, { extra: { HOME: "/elsewhere" } }), /cannot be overridden/);
  assert.throws(() => operatorEnv({ ...t, kind: "prod" }), /local stack only/);
});

test("verifyBuild refuses a build an --app-env value never reached", () => {
  const tree = join(work, "build-tree");
  mkdirSync(join(tree, "app", "dist", "assets"), { recursive: true });
  const origin = `http://127.0.0.1:${PORTS.hosting}`;
  writeFileSync(join(tree, "app", "dist", "llms.txt"), `served at ${origin}\n`);
  writeFileSync(join(tree, "app", "dist", "index.html"), "<!doctype html>");
  const id = dummyMeasurementId();
  const bundle = `const p="demo-bikeshed";const d="127.0.0.1:${PORTS.database}?ns=demo-bikeshed";const e={auth:${PORTS.auth},firestore:${PORTS.firestore},database:${PORTS.database}};`;
  writeFileSync(join(tree, "app", "dist", "assets", "index.js"), bundle);
  assert.throws(() => verifyBuild(tree, origin, PORTS, { appEnv: { [M]: id } }), /does not contain the value given for VITE_FIREBASE_MEASUREMENT_ID/);
  writeFileSync(join(tree, "app", "dist", "assets", "index.js"), `${bundle}const m="${id}";`);
  assert.deepEqual(verifyBuild(tree, origin, PORTS, { appEnv: { [M]: id } }).appEnv, [M]);
});
