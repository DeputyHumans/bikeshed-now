// SPDX-License-Identifier: Apache-2.0
// Self-test: the deployment's default export marking as stack options — VITE_EXPORT_MARK_ENABLED, _LABEL, _FOOTER — checked as the app and server read them, given to the build, and recorded rather than required in the bundle (SPEC §12, §20).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BLOCK_SIZE, namePorts } from "../lib/ports.mjs";
import { verifyBuild } from "../lib/stack.mjs";
import {
  appEnvBundleRule, capabilitiesFor, dummyMeasurementId, normalizeStackOptions, parseAppEnvArgs, parseStackOptionArgs,
  stackOptionArgs, viteEnvFor,
} from "../lib/options.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const PORTS = namePorts(Array.from({ length: BLOCK_SIZE }, (_, i) => 36200 + i));
const EN = "VITE_EXPORT_MARK_ENABLED";
const LABEL = "VITE_EXPORT_MARK_LABEL";
const FOOTER = "VITE_EXPORT_MARK_FOOTER";
const M = "VITE_FIREBASE_MEASUREMENT_ID";
const work = tempDir("e2e-mark-");
after(() => rmSync(work, { recursive: true, force: true }));

test("--app-env VITE_EXPORT_MARK_*: parsed, resolved as given (ENABLED alone is 1), and round-tripped for controls and reruns", () => {
  const args = ["--app-env", EN, "--app-env", `${LABEL}=E2E DEPLOYMENT MARK`, "--app-env", `${FOOTER}=Deployment footer {title} {version}`];
  const parsed = parseStackOptionArgs(args);
  assert.deepEqual(parsed, { emailOff: false, appEnv: { [EN]: "", [LABEL]: "E2E DEPLOYMENT MARK", [FOOTER]: "Deployment footer {title} {version}" } });
  assert.deepEqual(parseStackOptionArgs(stackOptionArgs(parsed)), parsed);
  const { appEnv } = normalizeStackOptions(parsed);
  assert.deepEqual(appEnv, { [EN]: "1", [LABEL]: "E2E DEPLOYMENT MARK", [FOOTER]: "Deployment footer {title} {version}" });
  assert.deepEqual(normalizeStackOptions({ appEnv: appEnv }).appEnv, appEnv, "resolving again changes nothing");
  for (const on of ["1", "true", "yes", "TRUE", "Yes"]) assert.equal(normalizeStackOptions({ appEnv: { [EN]: on } }).appEnv[EN], on, on);
  assert.equal(normalizeStackOptions({ appEnv: { [LABEL]: "L".repeat(40), [FOOTER]: "F".repeat(300) } }).appEnv[LABEL].length, 40, "the caps themselves are allowed");
  const env = viteEnvFor({ VITE_FIREBASE_PROJECT_ID: "demo-bikeshed", [EN]: "", [LABEL]: "", [FOOTER]: "" }, { databasePort: 1, projectId: "demo-bikeshed", origin: "o", appEnv });
  assert.deepEqual([env[EN], env[LABEL], env[FOOTER]], ["1", "E2E DEPLOYMENT MARK", "Deployment footer {title} {version}"], "the build gets them over .env.example's empty values");
});

test("NEGATIVE: a value the app or the server would change, or one that turns the marking off, is refused", () => {
  const refuse = (appEnv, re, why) => assert.throws(() => normalizeStackOptions({ appEnv }), re, why);
  refuse({ [EN]: "0" }, /turns the deployment marking on: 1, true or yes/, "off is the default, not an option");
  refuse({ [EN]: "on" }, /1, true or yes/, "config.ts flag() reads `on` as off");
  refuse({ [LABEL]: "" }, /takes a non-empty value/);
  refuse({ [LABEL]: " padded" }, /without leading or trailing whitespace/);
  refuse({ [FOOTER]: "trailing " }, /without leading or trailing whitespace/);
  refuse({ [LABEL]: "tab\there" }, /control characters/);
  refuse({ [LABEL]: "L".repeat(41) }, /at most 40 characters .*got 41/);
  refuse({ [FOOTER]: "F".repeat(301) }, /at most 300 characters .*got 301/);
  refuse({ [LABEL]: 'say "hi"' }, /cannot be passed to the build/);
  assert.throws(() => parseAppEnvArgs(["VITE_EXPORT_MARK=1"]), /not allowlisted/);
});

test("capabilities: VITE_EXPORT_MARK_ENABLED adds export-mark-default; a label or footer alone adds nothing", () => {
  const caps = (appEnv) => [...capabilitiesFor({ options: { emailOff: false, appEnv } })].filter((c) => !["local", "email", "mailpit", "admin-emulator", "oob-codes", "reset", "logs", "patches"].includes(c));
  assert.deepEqual(caps({ [EN]: "1", [LABEL]: "x", [FOOTER]: "y" }), ["export-mark-default"]);
  assert.deepEqual(caps({ [LABEL]: "x", [FOOTER]: "y" }), []);
  assert.deepEqual(caps({ [M]: dummyMeasurementId(), [EN]: "1" }).sort(), ["export-mark-default", "measurement-id"]);
});

test("verifyBuild: a marking value the bundle lacks is recorded, not refused; a measurement id it lacks still fails the build", () => {
  assert.deepEqual([appEnvBundleRule(M), appEnvBundleRule(EN), appEnvBundleRule(LABEL), appEnvBundleRule(FOOTER), appEnvBundleRule("VITE_UNKNOWN")], ["required", "recorded", "recorded", "recorded", "required"]);
  const tree = join(work, "build-tree");
  mkdirSync(join(tree, "app", "dist", "assets"), { recursive: true });
  const origin = `http://127.0.0.1:${PORTS.hosting}`;
  writeFileSync(join(tree, "app", "dist", "llms.txt"), `served at ${origin}\n`);
  writeFileSync(join(tree, "app", "dist", "index.html"), "<!doctype html>");
  const bundle = `const p="demo-bikeshed";const d="127.0.0.1:${PORTS.database}?ns=demo-bikeshed";const e={auth:${PORTS.auth},firestore:${PORTS.firestore},database:${PORTS.database}};`;
  const mark = { [EN]: "1", [LABEL]: "E2E DEPLOYMENT MARK", [FOOTER]: "Deployment footer {title}" };
  writeFileSync(join(tree, "app", "dist", "assets", "index.js"), bundle);
  const shaken = verifyBuild(tree, origin, PORTS, { appEnv: mark });
  assert.deepEqual(shaken.appEnvInBundle, { [EN]: true, [LABEL]: false, [FOOTER]: false }, "tree-shaken: recorded, and the stack still builds");
  writeFileSync(join(tree, "app", "dist", "assets", "index.js"), `${bundle}const env={${LABEL}:"${mark[LABEL]}",${FOOTER}:"${mark[FOOTER]}"};`);
  assert.deepEqual(verifyBuild(tree, origin, PORTS, { appEnv: mark }).appEnvInBundle, { [EN]: true, [LABEL]: true, [FOOTER]: true });
  const id = dummyMeasurementId();
  assert.throws(() => verifyBuild(tree, origin, PORTS, { appEnv: { ...mark, [M]: id } }), /does not contain the value given for VITE_FIREBASE_MEASUREMENT_ID/, "NEGATIVE: the measurement id is still required");
});
