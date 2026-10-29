// SPDX-License-Identifier: Apache-2.0
// Exercise installed Firebase emulator methods with fake spawning, registry and watchers, without starting a stack (SPEC §12).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const PROBE_STORAGE_HOST = "127.0.0.1:37007";
export const PROBE_PARENT_ENV = Object.freeze({ NODE_OPTIONS: "--require=/probe/egress.cjs", E2E_STORAGE_SHIM_HOST: "127.0.0.1:37008", STORAGE_EMULATOR_HOST: "http://parent.invalid" });

/** Run the actual installed methods; inject I/O at the module boundary, not at the behavior being judged. */
export async function firebaseBehavior(root, { source = readFileSync(join(root, "lib", "emulator", "functionsEmulator.js"), "utf8") } = {}) {
  const file = join(root, "lib", "emulator", "functionsEmulator.js");
  const realRequire = createRequire(file);
  const spawned = [];
  const watched = [];
  const overrides = {
    "cross-spawn": (bin, args, options) => { spawned.push({ bin, args, options }); return { pid: -1 }; },
    chokidar: { watch: (path, options) => { watched.push({ path, options }); return { on() {} }; } },
    "./registry": { EmulatorRegistry: { listRunningWithInfo: () => [{ name: "storage", host: "127.0.0.1", port: 37007 }] } },
  };
  const module = { exports: {} };
  // Evaluating the local installed CommonJS module keeps its Object.assign or
  // spread semantics intact. No constructor, socket, watcher or child is run.
  const load = new Function("require", "module", "exports", "__filename", "__dirname", "process", source);
  load((name) => overrides[name] ?? realRequire(name), module, module.exports, file, dirname(file), { env: { ...PROBE_PARENT_ENV } });
  const proto = module.exports.FunctionsEmulator.prototype;
  const runtime = { bin: process.execPath, functionsDir: root, runtime: "nodejs24", env: {} };
  const context = {
    args: {},
    debugMode: false,
    getUserEnvs: () => ({ STORAGE_EMULATOR_HOST: "http://dotenv.invalid", FIREBASE_STORAGE_EMULATOR_HOST: "dotenv.invalid", FROM_DOTENV: "kept" }),
    getSystemEnvs: () => ({ FUNCTION_TARGET: "probe" }),
    getEmulatorEnvs() { return proto.getEmulatorEnvs.call(this); },
    getFirebaseConfig: () => "{}",
  };
  const runtimeEnv = proto.getRuntimeEnvs.call(context, runtime, {});
  await proto.startNode.call(context, runtime, runtimeEnv);
  await proto.connect.call({
    args: {}, staticBackends: [runtime], watchers: [], watchCleanups: [],
    logger: { logLabeled() {}, log() {} },
    async loadTriggers() {}, async performPostLoadOperations() {},
  });
  return { runtimeEnv, spawned, watched };
}
