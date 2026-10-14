// SPDX-License-Identifier: Apache-2.0
// Self-test: stack trees come from git only, refuse stray untracked files, and never hold bindings (SPEC §12).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_TMP, ensureDir } from "../lib/paths.mjs";
import { assertNoBindings, forbiddenInTree, lockParity, materializeTree, removeTree, treeHash, worktreeFiles } from "../lib/tree.mjs";

let repo;
let scratch;

/** git with the user's global and system config out of the way (signing, hooks). */
const git = (...args) =>
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@e2e.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });

function put(rel, text) {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

before(() => {
  scratch = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-tree-"));
  repo = join(scratch, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  put(".gitignore", ".firebaserc\nconfig/deploy.json\n.env\n.env.*\n!.env.example\nignored/\n");
  put("package.json", "{}\n");
  put("app/src/a.ts", "export const a = 1;\n");
  put("app/.env.example", "VITE_X=1\n");
  put("docs/readme.md", "# docs\n");
  put("gone.txt", "tracked, then deleted\n");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  // The ignored binding files a real checkout has. Git must never carry them.
  put(".firebaserc", '{"projects":{"default":"not-a-demo"}}\n');
  put("config/deploy.json", '{"domain":"x"}\n');
  put(".env", "SECRET=1\n");
  put("ignored/x.txt", "x\n");
});

after(() => rmSync(scratch, { recursive: true, force: true }));

test("--tree HEAD extracts the commit and none of the ignored binding files", async () => {
  const dest = join(scratch, "head");
  const t = await materializeTree({ runId: "selftest-head", tree: "HEAD", repoRoot: repo, dest, linkModules: false });
  assert.equal(readFileSync(join(dest, "app/src/a.ts"), "utf8"), "export const a = 1;\n");
  for (const f of [".firebaserc", "config/deploy.json", ".env", "ignored/x.txt"]) assert.ok(!existsSync(join(dest, f)), `${f} absent`);
  assert.equal(t.fingerprint.mode, "rev");
  assert.match(t.fingerprint.baseSha, /^[0-9a-f]{40}$/);
  assert.equal(t.fingerprint.sha256, treeHash(dest).sha256);
});

test("--tree worktree carries edits and allowed untracked files, drops deleted ones", async () => {
  put("app/src/a.ts", "export const a = 2;\n");
  put("app/src/new.ts", "export const n = 1;\n");
  unlinkSync(join(repo, "gone.txt"));
  try {
    const dest = join(scratch, "wt");
    const t = await materializeTree({ runId: "selftest-wt", tree: "worktree", repoRoot: repo, dest, linkModules: false });
    assert.equal(readFileSync(join(dest, "app/src/a.ts"), "utf8"), "export const a = 2;\n");
    assert.ok(existsSync(join(dest, "app/src/new.ts")));
    assert.ok(!existsSync(join(dest, "gone.txt")));
    assert.ok(!existsSync(join(dest, ".firebaserc")) && !existsSync(join(dest, ".env")));
    assert.equal(t.fingerprint.mode, "worktree");
    assert.equal(t.fingerprint.dirty, true);
  } finally {
    unlinkSync(join(repo, "app/src/new.ts"));
    git("checkout", "-q", "--", "app/src/a.ts", "gone.txt");
  }
});

test("NEGATIVE: --tree worktree refuses an untracked file outside the allowlist, and names it", async () => {
  put("stray-notes.txt", "dropped at the root\n");
  put("functions/lib/leftover.js", "x\n");
  try {
    assert.throws(() => worktreeFiles(repo), (err) => {
      assert.equal(err.code, "E2E_UNTRACKED_REFUSED");
      assert.deepEqual(err.refused.sort(), ["functions/lib/leftover.js", "stray-notes.txt"]);
      assert.match(err.message, /stray-notes\.txt/);
      return true;
    });
    const dest = join(scratch, "refused");
    await assert.rejects(materializeTree({ runId: "selftest-refuse", tree: "worktree", repoRoot: repo, dest, linkModules: false }), /refuses untracked files/);
    assert.ok(!existsSync(join(dest, "stray-notes.txt")));
  } finally {
    unlinkSync(join(repo, "stray-notes.txt"));
    rmSync(join(repo, "functions"), { recursive: true, force: true });
  }
});

test("NEGATIVE: a binding file in the copy fails the tree, whichever way it got there", () => {
  const dest = mkdtempSync(join(scratch, "bind-"));
  mkdirSync(join(dest, "app"));
  mkdirSync(join(dest, "functions"));
  writeFileSync(join(dest, "app", ".env.example"), "VITE_X=1\n");
  writeFileSync(join(dest, "functions", ".env.example"), "X=\n");
  assert.equal(assertNoBindings(dest), true, ".env.example is names-only and allowed");
  for (const rel of [".firebaserc", "config/deploy.json", "functions/.env", "functions/.env.local", "app/.env.local", "app/.env", ".env.production"]) {
    mkdirSync(join(dest, rel, ".."), { recursive: true });
    writeFileSync(join(dest, rel), "x");
    assert.throws(() => assertNoBindings(dest), new RegExp(rel.replace(/\./g, "\\.")), rel);
    unlinkSync(join(dest, rel));
  }
  for (const rel of [".firebaserc", "config/deploy.json", "functions/.env.local", "app/.env", "e2e/.env.prod"]) assert.ok(forbiddenInTree(rel), rel);
  for (const rel of ["app/.env.example", "functions/.env.example", "app/src/config.ts"]) assert.ok(!forbiddenInTree(rel), rel);
});

test("lockfile parity: exact, subset (checkout has more), mismatch", () => {
  const lock = (pkgs) => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "x" }, ...pkgs } });
  const a = { "node_modules/a": { version: "1.0.0", integrity: "sha512-a" } };
  const b = { "node_modules/b": { version: "2.0.0", integrity: "sha512-b" } };
  assert.equal(lockParity(lock(a), lock(a)).mode, "exact");
  assert.equal(lockParity(lock(a), lock({ ...a, ...b })).mode, "subset");
  assert.equal(lockParity(lock({ ...a, ...b }), lock(a)).mode, "mismatch");
  assert.equal(lockParity(lock({ "node_modules/a": { version: "1.0.1", integrity: "sha512-z" } }), lock(a)).mode, "mismatch");
});

test("removeTree deletes node_modules LINKS, never what they point at, and refuses non-stack paths", () => {
  const target = mkdtempSync(join(scratch, "modules-"));
  writeFileSync(join(target, "keep.txt"), "must survive");
  const stack = join(E2E_TMP, "stacks", `selftest-rm-${process.pid}`);
  mkdirSync(join(stack, "tree", "app"), { recursive: true });
  symlinkSync(target, join(stack, "tree", "app", "node_modules"), "dir");
  removeTree(stack);
  assert.ok(!existsSync(stack));
  assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "must survive");
  assert.throws(() => removeTree("/usr/local/should-not"), /not an e2e stack path/);
});
