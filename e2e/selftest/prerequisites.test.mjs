// SPDX-License-Identifier: Apache-2.0
// Self-test: one Firebase installation is selected for stacks and probes, and the runner rejects a non-24 Node override before any tests start (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { firebaseTools, node24, selfTestToolchain } from "../lib/prerequisites.mjs";
import { REPO_ROOT } from "../lib/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const dir = tempDir("e2e-prerequisites-");
function firebaseFixture(name, version) {
  const root = join(dir, name, "firebase-tools");
  const binDir = join(dir, name, "bin");
  mkdirSync(join(root, "lib", "emulator"), { recursive: true });
  mkdirSync(join(root, "lib", "bin"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "firebase-tools", version }));
  writeFileSync(join(root, "lib", "emulator", "functionsEmulator.js"), "");
  const executable = join(root, "lib", "bin", "firebase.js");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const bin = join(binDir, "firebase");
  symlinkSync(executable, bin);
  return { bin, binDir, root: realpathSync(root), executable: realpathSync(executable), version };
}
const older = firebaseFixture("older", "14.7.0");
const newer = firebaseFixture("newer", "15.25.1");

test("Firebase resolves the explicit binary before PATH, recording its real executable, package and version", () => {
  assert.deepEqual(firebaseTools({ env: { PATH: older.binDir, E2E_FIREBASE_BIN: newer.bin } }), { bin: newer.executable, root: newer.root, version: newer.version });
  assert.deepEqual(firebaseTools({ env: { PATH: older.binDir } }), { bin: older.executable, root: older.root, version: older.version });
  assert.equal(firebaseTools({ env: { PATH: "" }, optional: true }), null);
  assert.throws(() => firebaseTools({ env: { PATH: "" } }), /firebase is not on PATH/);
});

test("an invalid explicit Firebase override fails even when another installation is available or the probe is optional", () => {
  const env = { PATH: older.binDir, E2E_FIREBASE_BIN: join(dir, "missing") };
  assert.throws(() => firebaseTools({ env, optional: true }), /Firebase executable .* is not usable/);
  const script = join(dir, "wrapper");
  writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.throws(() => firebaseTools({ env: { ...env, E2E_FIREBASE_BIN: script } }), /not inside an installed firebase-tools package/);
  chmodSync(script, 0o644);
  assert.throws(() => firebaseTools({ env: { ...env, E2E_FIREBASE_BIN: script } }), /is not usable/);
});

test("self-test child uses Node 24 and pins Firebase before changing PATH, so a second installation cannot replace it", () => {
  const node = node24({ bin: dirname(process.execPath) });
  const resolved = selfTestToolchain({ node, env: { PATH: older.binDir, E2E_FIREBASE_BIN: newer.bin, KEEP: "yes" } });
  assert.equal(resolved.node.version, process.version);
  assert.equal(resolved.node.executable, process.execPath);
  assert.equal(resolved.env.E2E_NODE_BIN, dirname(process.execPath));
  assert.equal(resolved.env.KEEP, "yes");
  assert.equal(resolved.env.E2E_FIREBASE_BIN, newer.executable);
  assert.deepEqual(firebaseTools({ env: resolved.env }), resolved.firebase);
  const onPath = selfTestToolchain({ node, env: { PATH: older.binDir } });
  assert.equal(onPath.env.E2E_FIREBASE_BIN, older.executable, "a Node-bin Firebase does not silently replace the original PATH choice");
});

test("NEGATIVE: a non-24 Node override is refused by the library and the self-test entry point before spawning the suite", () => {
  const bin = join(dir, "node22");
  mkdirSync(bin);
  writeFileSync(join(bin, "node"), "#!/bin/sh\nprintf 'v22.20.0\\n'\n", { mode: 0o755 });
  assert.throws(() => node24({ bin }), /requires Node 24.*v22\.20\.0/);
  const child = spawnSync(process.execPath, [join(REPO_ROOT, "e2e", "run.mjs"), "--self-test"], {
    cwd: REPO_ROOT, env: { ...process.env, E2E_NODE_BIN: bin }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(child.status, 2, child.stderr);
  assert.match(child.stderr, /self-test prerequisites: E2E requires Node 24/);
  assert.doesNotMatch(child.stdout + child.stderr, /self-test toolchain:|tests \d+/);
});
