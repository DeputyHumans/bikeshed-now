// SPDX-License-Identifier: Apache-2.0
// Where the CLI keeps its credential, and how it finds the deployment (SPEC §19).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The token file.
 *
 * Under XDG_CONFIG_HOME when set, so it lands where the rest of a person's
 * tooling lives, and mode 0600 because it holds a credential that can do
 * everything its owner can do. Never in the project directory: a token in a
 * repository is a token in somebody's next commit.
 */
function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "bikeshed") : join(homedir(), ".config", "bikeshed");
}

export const CONFIG_PATH = join(configDir(), "config.json");

export function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function writeConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  // Created owner-only, so the token is never readable under the umask in the
  // moment before chmod. The chmod still narrows a file an older version made.
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Best effort: some filesystems (and Windows) do not support it. The token
    // is still no more exposed than any other file in a home directory.
  }
}

/**
 * Resolve the deployment and the token.
 *
 * Environment first, so a CI job can supply both without writing a file, and so
 * a token can be scoped to one shell rather than to the whole machine.
 */
export function resolveAuth(flags = {}) {
  const config = readConfig();
  const origin = (
    flags.origin ||
    process.env.BIKESHED_ORIGIN ||
    config.origin ||
    "https://bikeshed.now"
  ).replace(/\/+$/, "");
  const token = flags.token || process.env.BIKESHED_TOKEN || config.token || "";
  return { origin, token };
}
