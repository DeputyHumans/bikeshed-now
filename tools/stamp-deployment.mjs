// SPDX-License-Identifier: Apache-2.0
// Resolve `https://<deployment>` to this deployment's own origin, in app/dist (SPEC §19).

/**
 * Why this exists, and why it writes only to the BUILD OUTPUT.
 *
 * `docs/agents/agent-guide.md` and `skills/<name>/SKILL.md` are copied verbatim
 * into `app/public/` by `tools/build-agents.mjs`, and `check:agents`
 * byte-compares them. Those tracked copies keep the placeholder deliberately:
 * Bikeshed is self-hosted, so a literal host in the tree would be wrong on every
 * deployment but one — the rule `app/src/pages/Landing.tsx` already states for
 * the landing page, which builds every address it prints from
 * `window.location.origin`.
 *
 * A text file served by Hosting has no runtime to do that in, so the
 * substitution happens at build time against `app/dist`, which nobody commits.
 * `app/public` is never a legal target: writing the real host there would put a
 * deployment binding into the tree, and `check-secrets.sh` matches by SHAPE, so
 * a custom domain would sail straight through it.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The token, scheme included.
 *
 * The scheme is part of it because `config/deploy.json` holds a BARE domain
 * while `BIKESHED_PUBLIC_ORIGIN` holds a full origin. Substituting a bare
 * `<deployment>` would emit `https://https://host` for one source; substituting
 * `https://<deployment>` would emit a scheme-less `host/mcp` for the other.
 * `normalizeOrigin` reconciles the two before either reaches this.
 */
export const TOKEN = "https://<deployment>";

/** What a document must not still contain once it has been stamped. */
const BARE_TOKEN = "<deployment>";

/**
 * A deployment origin, or "" when nothing is configured.
 *
 * Throws on a value that is set but unusable rather than passing it through.
 * The whole failure class this guards is silent: a stamped document is still a
 * valid-looking document, and nobody reads `/llms.txt` by eye after a deploy.
 */
export function normalizeOrigin(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return "";

  // The likeliest mistake there is: pasting the placeholder out of the very
  // document being stamped. Diagnosed here, or it surfaces later as the far
  // more confusing "a placeholder survived the stamp".
  if (trimmed.includes("<") || trimmed.includes(">")) {
    throw new Error(`that is the placeholder, not an origin: ${JSON.stringify(value)}`);
  }

  const qualified = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url;
  try {
    url = new URL(qualified);
  } catch {
    throw new Error(`not a usable deployment origin: ${JSON.stringify(value)}`);
  }
  // `url.origin` drops any path, query, fragment or credentials. Demanding that
  // it round-trips is what rejects `https://host/app`, `https://host?x=1` and
  // `https://user:pw@host` — each of which would otherwise be spliced in front
  // of `/d/<id>` and produce an address that resolves somewhere unintended.
  if (url.origin !== qualified) {
    throw new Error(
      `a deployment origin is a scheme and a host, nothing else: ${JSON.stringify(value)}`,
    );
  }
  return url.origin;
}

/** The `domain` of the gitignored deployment file, or "" when there is none. */
function deployDomain(root) {
  const path = join(root, "config", "deploy.json");
  if (!existsSync(path)) return "";
  try {
    return JSON.parse(readFileSync(path, "utf8")).domain ?? "";
  } catch {
    return "";
  }
}

/**
 * Where the origin comes from, in order, and which source supplied it.
 *
 * `config/deploy.json` is the one an operator should fill. The environment
 * variable shares its name with the one the functions read, but `functions/.env`
 * is loaded by the Functions runtime and never by this build — so a deployment
 * configured only there would serve documents that still say `<deployment>`
 * while its email links were correct.
 */
export function resolveOrigin(env = process.env, root = ROOT) {
  const explicit = normalizeOrigin(env.BIKESHED_PUBLIC_ORIGIN);
  if (explicit) return { origin: explicit, source: "BIKESHED_PUBLIC_ORIGIN" };

  const configured = normalizeOrigin(deployDomain(root));
  if (configured) return { origin: configured, source: "config/deploy.json" };

  return { origin: "", source: "" };
}

/**
 * Substitute, and refuse to emit a half-resolved document.
 *
 * `split`/`join` rather than `String.replace`, for the reason
 * `functions/src/lib/shell.ts` gives at length: a replacement STRING expands
 * `$&`, `` $` ``, `$'` and `$1` inside itself, so an origin containing one of
 * those sequences would paste part of the document back into it.
 */
export function stamp(text, origin) {
  if (!origin) return text;
  const stamped = text.split(TOKEN).join(origin);
  if (stamped.includes(BARE_TOKEN)) {
    throw new Error(
      `a \`${BARE_TOKEN}\` placeholder survived the stamp — write it as \`${TOKEN}\`, ` +
        "scheme included, or it ships to agents unresolved",
    );
  }
  return stamped;
}

/**
 * The skill directories, read from disk rather than imported.
 *
 * `tools/build-agents.mjs` exports `readSkills()`, which does this and parses
 * the frontmatter besides — but importing it here would be a trap. Vite bundles
 * `app/vite.config.ts` AND everything it imports with esbuild, injecting a
 * `__vite_injected_original_*` preamble at the head of each file; that pushes
 * `build-agents.mjs`'s `#!/usr/bin/env node` off line 1 and the whole app build
 * dies with `Syntax error "!"`. Eight lines of `readdirSync` is the cheaper
 * side of that trade. The two listings are held in agreement by the test that
 * compares this against what `build-agents.mjs` actually wrote.
 */
function skillNames(root) {
  try {
    return readdirSync(join(root, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The documents a deployment serves that name it.
 *
 * Derived rather than listed, so a skill that is added or renamed cannot
 * quietly stop being stamped — the failure would be one skill telling an agent
 * to publish to `<deployment>` while the rest named the host.
 */
export function servedDocuments(root = ROOT) {
  return [
    "llms.txt",
    // Generated from the frontmatter, and served. No description carries an
    // address today; one that gained a placeholder would otherwise ship raw.
    "skills/index.json",
    ...skillNames(root).map((name) => `skills/${name}/SKILL.md`),
  ];
}

/** Refuse anything but a build output, so the tree can never be the target. */
function assertBuildOutput(distDir) {
  if (basename(distDir) !== "dist") {
    throw new Error(`refusing to stamp outside a build output: ${distDir}`);
  }
}

/**
 * Rewrite every served document in place. Returns what changed, for the caller
 * to report — a stamp nobody can see happen is one nobody notices failing.
 */
export function stampDist(distDir, origin) {
  assertBuildOutput(distDir);
  const files = [];
  let total = 0;

  for (const rel of servedDocuments()) {
    const path = join(distDir, rel);
    if (!existsSync(path)) {
      throw new Error(`${rel} is missing from ${distDir} — the build did not copy app/public`);
    }
    const text = readFileSync(path, "utf8");
    const count = text.split(TOKEN).length - 1;
    const stamped = stamp(text, origin);
    if (stamped !== text) writeFileSync(path, stamped);
    files.push({ path: rel, count });
    total += count;
  }

  return { files, total };
}

/**
 * The deploy gate. There is no `hosting.predeploy` that rebuilds — the
 * documented deploy is `npm --prefix app run build && firebase deploy --only
 * hosting`, two commands somebody types — so this asserts that what is about to
 * be uploaded was in fact stamped.
 *
 * Silent when nothing is configured: a deployment with no custom domain serves
 * the placeholder on purpose, and refusing to deploy it would be wrong.
 */
export function checkDist(distDir, env = process.env, root = ROOT) {
  const { origin, source } = resolveOrigin(env, root);
  if (!origin) {
    return { ok: true, origin, source, unstamped: [] };
  }
  assertBuildOutput(distDir);
  const unstamped = [];
  for (const rel of servedDocuments()) {
    const path = join(distDir, rel);
    if (!existsSync(path) || readFileSync(path, "utf8").includes(BARE_TOKEN)) {
      unstamped.push(rel);
    }
  }
  return { ok: unstamped.length === 0, origin, source, unstamped };
}

/**
 * The Vite plugin, so no path to `app/dist` can skip the stamp.
 *
 *   apply: "build"  — `resolveConfig` drops a plugin whose `apply` is not the
 *     current command, so this never enters the pipeline under `vite dev` or
 *     under Vitest, both of which resolve as "serve". Without it, Vite 5's dev
 *     plugin container would run the hook on every dev-server shutdown and
 *     every test teardown, against an `app/dist` that need not exist.
 *
 *   writeBundle  — rather than `closeBundle`, which Vite calls from a `finally`
 *     and therefore ALSO after a build that threw: that would stamp a
 *     half-written output and report success. `writeBundle` runs only after a
 *     successful write, and still after `prepareOutDir` has emptied `outDir`
 *     and copied `app/public` into it.
 *
 *   outDir from the resolved config, not the string "app/dist", so
 *   `vite build --outDir` stamps the tree it actually wrote.
 */
export function deploymentStamp({ env, root, log = console } = {}) {
  let outDir = null;
  return {
    name: "bikeshed-stamp-deployment",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      if (outDir === null) throw new Error("stamp: configResolved never ran");
      const { origin, source } = resolveOrigin(env ?? process.env, root ?? ROOT);
      if (!origin) {
        log.warn(
          "stamp: no deployment origin — /llms.txt and /skills/** keep saying " +
            '<deployment> (set "domain" in config/deploy.json, or export ' +
            "BIKESHED_PUBLIC_ORIGIN before building)",
        );
        return;
      }
      const { files, total } = stampDist(outDir, origin);
      log.log(
        `stamp: ${total} address(es) in ${files.length} served files now say ${origin} (${source})`,
      );
    },
  };
}

/** Everything below runs only when this file is a COMMAND. */
const RUN_DIRECTLY = process.argv[1] === fileURLToPath(import.meta.url);

function run() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const distDir = args.find((a) => !a.startsWith("--")) ?? join(ROOT, "app", "dist");

  if (check) {
    const { ok, origin, source, unstamped } = checkDist(distDir);
    if (!origin) {
      console.log("stamp: no deployment origin configured — nothing to check");
      return;
    }
    if (!ok) {
      console.error(
        `stamp: ${unstamped.join(", ")} still name <deployment>, but ${source} says ${origin}.\n` +
          "run `npm --prefix app run build` before deploying hosting.",
      );
      process.exit(1);
    }
    console.log(`stamp: ${distDir} names ${origin}`);
    return;
  }

  const { origin, source } = resolveOrigin();
  if (!origin) {
    console.log(
      "stamp: no deployment origin (set `domain` in config/deploy.json) — " +
        "the served instructions will keep saying <deployment>",
    );
    return;
  }
  const { total } = stampDist(distDir, origin);
  console.log(`stamp: ${total} address(es) now say ${origin}, from ${source}`);
}

if (RUN_DIRECTLY) run();
