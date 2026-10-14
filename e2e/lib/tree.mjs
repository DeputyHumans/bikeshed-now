// SPDX-License-Identifier: Apache-2.0
// The product tree a stack runs: extracted from git, never rsynced, proven free of deployment files (SPEC §12).

/**
 * Why git and never a directory copy.
 *
 * The working directory holds GITIGNORED deployment bindings: a real
 * `.firebaserc`, `config/deploy.json` (the real bucket), `functions/.env` and
 * `app/.env.local` with production values. An rsync of the tree once carried
 * them into a stack and `scripts/publish.mjs` seeded under the real bucket's
 * name. Git cannot carry an ignored file, so:
 *
 *   --tree HEAD | <rev>   `git archive <sha> | tar -x`, both spawned, no shell
 *   --tree worktree       `git ls-files -z -co --exclude-standard`, minus
 *                         deleted files; an UNTRACKED file is allowed only
 *                         under a source root, content/, docs/ or e2e/, so a
 *                         stray credential dropped at the root is refused
 *
 * and after either, the copy is checked for every binding file by name.
 *
 * node_modules are symlinked from the checkout this harness runs in, and only
 * when that checkout's lockfile can satisfy the copy's (see lockParity).
 */

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, rmSync, statSync, symlinkSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { REPO_ROOT, assertPath, assertRunId, ensureDir, stackDir, treeDir as treeDirFor } from "./paths.mjs";

/** Where an untracked file may come from in worktree mode. */
export const UNTRACKED_ALLOWED = [
  "app/src/", "functions/src/", "scripts/", "tools/", "cli/", "config/", "rules-tests/",
  "content/", "docs/", "e2e/",
];

/** Never in a stack copy. `.example` variants are names-only and tracked on purpose. */
export function forbiddenInTree(rel) {
  const base = rel.split("/").pop();
  if (rel === ".firebaserc" || rel === "config/deploy.json" || rel === "DEPLOYMENT.local.md") return true;
  if (rel === ".mcp.json" || rel === ".firebase" || rel.startsWith(".firebase/")) return true;
  if (rel === "functions/.secret.local") return true;
  if (/^service-account.*\.json$/.test(base) || base.endsWith(".serviceaccount.json")) return true;
  const isEnv = base === ".env" || base.startsWith(".env.");
  if (isEnv && base !== ".env.example") {
    if (!rel.includes("/")) return true; // root .env*
    if (rel.startsWith("app/") || rel.startsWith("functions/")) return true;
  }
  if (rel.startsWith("e2e/.out/") || rel === "e2e/.env.prod") return true;
  return false;
}

/** Assert none of the binding files exist in `dir`. */
export function assertNoBindings(dir) {
  const found = [];
  const probe = [
    ".firebaserc", "config/deploy.json", "DEPLOYMENT.local.md", ".mcp.json", ".firebase",
    "functions/.secret.local", "e2e/.env.prod", "e2e/.out",
  ];
  for (const rel of probe) if (existsSync(join(dir, rel))) found.push(rel);
  for (const sub of ["", "app", "functions"]) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") found.push(sub ? `${sub}/${name}` : name);
    }
  }
  if (found.length > 0) {
    throw new Error(`stack tree ${dir} holds deployment files it must never contain: ${found.join(", ")}`);
  }
  return true;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gitZ(args, cwd) {
  return git(args, cwd).split("\0").filter(Boolean);
}

/** git archive <sha> | tar -x -C dest, both spawned without a shell. */
function extractRev(repoRoot, sha, dest) {
  return new Promise((resolveExtract, rejectExtract) => {
    const archive = spawn("git", ["archive", "--format=tar", sha], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const untar = spawn("tar", ["-x", "-f", "-", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
    let errText = "";
    archive.stderr.on("data", (d) => (errText += d));
    untar.stderr.on("data", (d) => (errText += d));
    archive.stdout.pipe(untar.stdin);
    let pending = 2;
    let failed = null;
    const done = (who) => (code, signal) => {
      if (code !== 0) failed = failed || `${who} exited ${code ?? signal}`;
      if (--pending === 0) {
        if (failed) rejectExtract(new Error(`${failed}: ${errText.trim()}`));
        else resolveExtract();
      }
    };
    archive.on("close", done("git archive"));
    untar.on("close", done("tar"));
    archive.on("error", rejectExtract);
    untar.on("error", rejectExtract);
  });
}

/**
 * The file list for worktree mode, or a refusal naming the untracked files
 * that are outside the allowlist.
 */
export function worktreeFiles(repoRoot = REPO_ROOT) {
  const listed = gitZ(["ls-files", "-z", "-co", "--exclude-standard"], repoRoot);
  const deleted = new Set(gitZ(["ls-files", "-z", "-d"], repoRoot));
  const untracked = gitZ(["ls-files", "-z", "-o", "--exclude-standard"], repoRoot);
  const refused = untracked.filter((p) => !UNTRACKED_ALLOWED.some((root) => p.startsWith(root)));
  if (refused.length > 0) {
    const err = new Error(
      `--tree worktree refuses untracked files outside ${UNTRACKED_ALLOWED.join(" ")}:\n  ${refused.join("\n  ")}\n` +
        "commit them, move them, or run --tree HEAD",
    );
    err.code = "E2E_UNTRACKED_REFUSED";
    err.refused = refused;
    throw err;
  }
  const forbidden = listed.filter((p) => forbiddenInTree(p));
  if (forbidden.length > 0) {
    throw new Error(`--tree worktree would copy deployment files: ${forbidden.join(", ")}`);
  }
  return { files: [...new Set(listed)].filter((p) => !deleted.has(p)).sort(), untracked };
}

function copyFiles(repoRoot, files, dest) {
  for (const rel of files) {
    const from = join(repoRoot, rel);
    const to = join(dest, rel);
    let st;
    try {
      st = lstatSync(from);
    } catch (err) {
      if (err.code === "ENOENT") continue; // deleted between listing and copy
      throw err;
    }
    mkdirSync(dirname(to), { recursive: true });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (st.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, st.mode & 0o777);
    }
  }
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** sha256 over sorted (path, sha256(content)), skipping node_modules. */
export function treeHash(dir) {
  const entries = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p).split(sep).join("/");
      if (name === "node_modules") continue;
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isSymbolicLink()) entries.push([rel, `link:${readlinkSync(p)}`]);
      else if (st.isFile()) entries.push([rel, sha256(readFileSync(p))]);
    }
  };
  walk(dir);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = createHash("sha256");
  for (const [rel, digest] of entries) h.update(`${rel}\0${digest}\n`);
  return { sha256: h.digest("hex"), files: entries.length };
}

/**
 * Whether `installedLock` (the checkout's) satisfies `copyLock` (the tree's).
 * `exact`  byte-identical;
 * `subset` every package the copy pins is installed at the same version,
 *          resolved URL and integrity (the checkout may have more, e.g. a
 *          devDependency added since the rev);
 * `mismatch` otherwise, with the first differences.
 */
export function lockParity(copyLockText, installedLockText) {
  if (sha256(copyLockText) === sha256(installedLockText)) return { mode: "exact", diffs: [] };
  let copy, installed;
  try {
    copy = JSON.parse(copyLockText).packages ?? {};
    installed = JSON.parse(installedLockText).packages ?? {};
  } catch {
    return { mode: "mismatch", diffs: ["unparsable lockfile"] };
  }
  const diffs = [];
  for (const [key, want] of Object.entries(copy)) {
    if (key === "") continue; // the root project itself
    const have = installed[key];
    if (!have) diffs.push(`${key}: not installed`);
    else if (have.version !== want.version || (want.integrity && have.integrity !== want.integrity) || (want.resolved && have.resolved !== want.resolved)) {
      diffs.push(`${key}: ${have.version} installed, ${want.version} pinned`);
    }
    if (diffs.length >= 10) break;
  }
  return { mode: diffs.length === 0 ? "subset" : "mismatch", diffs };
}

export const NODE_MODULE_DIRS = ["", "app", "functions"];

/** Symlink node_modules per dir after the parity check, or npm ci with --install. */
async function linkNodeModules(repoRoot, dest, { install, npmCi }) {
  const result = {};
  for (const sub of NODE_MODULE_DIRS) {
    const copyLock = join(dest, sub, "package-lock.json");
    const haveLock = join(repoRoot, sub, "package-lock.json");
    const haveModules = join(repoRoot, sub, "node_modules");
    const key = sub || ".";
    if (!existsSync(copyLock)) {
      result[key] = { mode: "no-lockfile" };
      continue;
    }
    const parity = existsSync(haveLock) && existsSync(haveModules)
      ? lockParity(readFileSync(copyLock, "utf8"), readFileSync(haveLock, "utf8"))
      : { mode: "mismatch", diffs: ["checkout has no installed node_modules"] };
    if (parity.mode !== "mismatch" && !install) {
      symlinkSync(haveModules, join(dest, sub, "node_modules"), "dir");
      result[key] = { mode: parity.mode, linked: haveModules };
      continue;
    }
    if (!install) {
      const err = new Error(
        `${key}/package-lock.json in the tree does not match the installed one (${parity.diffs.join("; ")}); rerun with --install`,
      );
      err.code = "E2E_LOCK_MISMATCH";
      throw err;
    }
    await npmCi(join(dest, sub));
    result[key] = { mode: "installed", parity: parity.mode };
  }
  return result;
}

/**
 * Materialize the product tree for a stack.
 * @param {object} o
 * @param {string} o.runId
 * @param {string} [o.tree="HEAD"]   "HEAD" | <rev> | "worktree"
 * @param {boolean} [o.install]      npm ci in the copy instead of symlinking
 * @param {string} [o.repoRoot]      the checkout to read (tests pass a fixture repo)
 * @param {string} [o.dest]          defaults to ~/.cache/bikeshed-e2e/stacks/<runId>/tree
 * @param {boolean} [o.linkModules=true]
 * @param {(dir:string)=>Promise<void>} [o.npmCi]
 * @returns {Promise<{treeDir:string, fingerprint:object, nodeModules:object}>}
 */
export async function materializeTree({ runId, tree = "HEAD", install = false, repoRoot = REPO_ROOT, dest, linkModules = true, npmCi } = {}) {
  assertRunId(runId);
  assertPath(repoRoot, "repoRoot");
  const out = dest ? assertPath(dest, "dest") : treeDirFor(runId);
  if (existsSync(out)) throw new Error(`${out} already exists; refusing to reuse a tree`);
  if (!dest) ensureDir(stackDir(runId), "stackDir");
  mkdirSync(out, { recursive: true });

  const baseSha = git(["rev-parse", "HEAD"], repoRoot).trim();
  const dirty = git(["status", "--porcelain", "--untracked-files=normal"], repoRoot).trim().length > 0;
  let fingerprint;
  try {
    if (tree === "worktree") {
      const { files, untracked } = worktreeFiles(repoRoot);
      copyFiles(repoRoot, files, out);
      fingerprint = { mode: "worktree", rev: "worktree", baseSha, dirty, untracked: untracked.length };
    } else {
      const sha = git(["rev-parse", "--verify", `${tree}^{commit}`], repoRoot).trim();
      await extractRev(repoRoot, sha, out);
      fingerprint = { mode: "rev", rev: tree, baseSha: sha, dirty: false };
    }
    assertNoBindings(out);
    const hash = treeHash(out);
    fingerprint.sha256 = hash.sha256;
    fingerprint.files = hash.files;
    const nodeModules = linkModules
      ? await linkNodeModules(repoRoot, out, { install, npmCi: npmCi ?? (() => Promise.reject(new Error("no npm ci runner"))) })
      : {};
    return { treeDir: out, fingerprint, nodeModules };
  } catch (err) {
    err.treeDir = out;
    throw err;
  }
}

/** Delete a materialized tree; refuses anything outside a stacks dir. */
export function removeTree(dir) {
  assertPath(dir, "tree");
  if (!dir.includes(`${sep}bikeshed-e2e${sep}`)) throw new Error(`refusing to delete ${dir}: not an e2e stack path`);
  // node_modules are symlinks into the checkout: rmSync removes the link, not the target.
  rmSync(dir, { recursive: true, force: true });
}

export function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
