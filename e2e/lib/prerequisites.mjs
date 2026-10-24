// SPDX-License-Identifier: Apache-2.0
// Resolve the Node and Firebase executables once for stacks and harness self-tests, and report the versions actually selected (SPEC §12).

import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { nodeVersion, requireTool, resolveNodeBin, which } from "./proc.mjs";

/** Firebase on PATH or its explicit override; only an absent optional installation may be skipped. */
export function firebaseTools({ env = process.env, optional = false } = {}) {
  if (optional && !env.E2E_FIREBASE_BIN && !which("firebase", env.PATH ?? "")) return null;
  const selected = requireTool("firebase", "E2E_FIREBASE_BIN", env);
  let bin;
  try {
    accessSync(selected, constants.X_OK);
    bin = realpathSync(selected);
  } catch (err) {
    throw new Error(`Firebase executable ${selected} is not usable: ${err.message}`);
  }
  for (let root = dirname(bin); ; root = dirname(root)) {
    const file = join(root, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (pkg.name === "firebase-tools") {
        if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(pkg.version ?? "") || !existsSync(join(root, "lib", "emulator", "functionsEmulator.js"))) {
          throw new Error(`Firebase executable ${selected} has an incomplete firebase-tools package at ${root}`);
        }
        return { bin, root, version: pkg.version };
      }
    }
    if (root === dirname(root)) break;
  }
  throw new Error(`Firebase executable ${selected} is not inside an installed firebase-tools package`);
}

/** Both the harness tests and the Functions emulator run on Node 24, including an explicit override. */
export function node24({ bin = resolveNodeBin() } = {}) {
  const version = nodeVersion(bin);
  if (!/^v24\.\d+\.\d+$/.test(version)) throw new Error(`E2E requires Node 24, but ${join(bin, "node")} is ${version}; set E2E_NODE_BIN to a Node 24 bin directory`);
  return { bin, executable: join(bin, "node"), version };
}

/** Pin child probes to the exact Firebase installation resolved before Node's PATH is prepended. */
export function selfTestToolchain({ env = process.env, node = node24(), firebase = firebaseTools({ env }) } = {}) {
  return {
    node,
    firebase,
    env: {
      ...env,
      PATH: [node.bin, env.PATH ?? ""].filter(Boolean).join(delimiter),
      E2E_NODE_BIN: node.bin,
      ...(firebase ? { E2E_FIREBASE_BIN: firebase.bin } : {}),
    },
  };
}
