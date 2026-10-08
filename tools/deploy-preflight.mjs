// SPDX-License-Identifier: Apache-2.0
// Refuses a CI deploy whose build was configured for another project, the emulators, or no address (SPEC §12).

/**
 * `deploy.yml` writes this deployment's configuration from repository secrets,
 * builds, and then runs this — BEFORE it authenticates, so a refusal here
 * cannot leave anything half-deployed. Every check is something that would
 * otherwise surface only after functions and rules had already gone out:
 *
 *   - a bundle built from an emulator config, or for a different project than
 *     the one the deploy targets. Vite inlines the config, so the deploy itself
 *     would succeed and every visitor would talk to the wrong backend;
 *   - no public origin, which leaves `/llms.txt` naming a placeholder and gives
 *     the post-deploy smoke test nothing to check;
 *   - functions told a different origin than the one the build was stamped
 *     with, or none. `docShell` fetches the app shell from
 *     BIKESHED_PUBLIC_ORIGIN and fails closed on anything that is not the app,
 *     so every `/d/**` page would answer 503;
 *   - an `app/dist` that was never stamped, or whose skill archives are
 *     missing or older than the stamp. The hosting `predeploy` hook refuses
 *     both too, but only at the hosting step — after functions and rules are
 *     already live.
 *
 * Refusals never quote the values they compared. The binding stays out of the
 * tree, and out of the build log as well.
 *
 *   node tools/deploy-preflight.mjs --project <id>
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkDist, normalizeOrigin } from "./stamp-deployment.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `KEY=value` lines, close enough to dotenv for the keys checked here:
 * comments, blank lines, an `export ` prefix and one layer of matching quotes.
 */
export function parseEnv(text) {
  const vars = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    vars[line.slice(0, eq).trim()] = value;
  }
  return vars;
}

/** The same reading `app/src/config.ts` gives a boolean flag. */
function flag(value) {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Every reason this build must not go to `project`, or `[]` when there is none.
 *
 * `appEnv` and `functionsEnv` are the texts of `app/.env.local` and
 * `functions/.env`; `dist`, `env` and `root` are what `checkDist` resolves the
 * origin and the stamp against.
 */
export function refusals({ project, appEnv, functionsEnv, dist, env = process.env, root = ROOT }) {
  const out = [];
  const target = (project ?? "").trim();

  if (target === "") {
    out.push("no target project: the deploy has no project id to compare against");
  } else if (target.startsWith("demo-")) {
    out.push("the target is a demo- project id, which is emulator-only");
  }

  if (!appEnv || appEnv.trim() === "") {
    out.push("app/.env.local is missing or empty, so the bundle has no Firebase config");
  } else {
    const vars = parseEnv(appEnv);
    if (flag(vars.VITE_USE_EMULATORS)) {
      out.push("app/.env.local sets VITE_USE_EMULATORS, so the bundle would talk to localhost");
    }
    if (target !== "" && (vars.VITE_FIREBASE_PROJECT_ID ?? "").trim() !== target) {
      out.push("app/.env.local names a different Firebase project than the deploy targets");
    }
  }

  const { origin, unstamped, archives } = checkDist(dist, env, root);
  if (!origin) {
    out.push("no public origin: set `domain` in config/deploy.json");
  } else if (unstamped.length > 0) {
    out.push(`${unstamped.join(", ")} still name <deployment>: rebuild before deploying`);
  }
  // A separate refusal, because it is a separate fault: the downloads are
  // missing or were packed from text the stamp has since rewritten. A dist that
  // was never stamped at all gets the one line above, not both — its archives
  // are being compared against a SKILL.md that is itself wrong, and the remedy
  // for the two is the same rebuild.
  if (archives.length > 0 && unstamped.length === 0) {
    out.push(
      `${archives.join(", ")} missing, unreadable, or not holding the SKILL.md served ` +
        "beside it: rebuild before deploying",
    );
  }

  if (origin) {
    let functionsOrigin = "";
    try {
      functionsOrigin = normalizeOrigin(parseEnv(functionsEnv ?? "").BIKESHED_PUBLIC_ORIGIN);
    } catch {
      // Unusable is handled exactly like absent, below.
    }
    if (functionsOrigin !== origin) {
      out.push(
        "functions/.env does not set BIKESHED_PUBLIC_ORIGIN to the origin the build was " +
          "stamped with, so docShell would answer 503 on every /d/** page",
      );
    }
  }

  return out;
}

const RUN_DIRECTLY = process.argv[1] === fileURLToPath(import.meta.url);

function run() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--project");
  const project = at >= 0 ? args[at + 1] : "";
  const read = (...parts) => {
    const path = join(ROOT, ...parts);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };

  const problems = refusals({
    project,
    appEnv: read("app", ".env.local"),
    functionsEnv: read("functions", ".env"),
    dist: join(ROOT, "app", "dist"),
  });
  if (problems.length > 0) {
    for (const p of problems) console.error(`preflight: ${p}`);
    process.exit(1);
  }
  console.log("preflight: the build matches the target project and is stamped");
}

if (RUN_DIRECTLY) run();
