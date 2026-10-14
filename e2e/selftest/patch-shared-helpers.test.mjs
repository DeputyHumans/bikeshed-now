// SPDX-License-Identifier: Apache-2.0
// Self-test: the gate helpers several amplify sets each add go into a stack tree once, so any amplify sets apply together, and each still applies alone (SPEC §12).

/**
 * amplify-mint-join, amplify-c10-accept and amplify-c13-feedback each add
 * functions/src/lib/e2eGate.ts, so that each applies alone. Named together,
 * the second set's `git apply` found the file there and refused ("already
 * exists in working directory"): C10's accepts could never run beside the
 * mint and join gates on one stack. applyPatchSet now excludes a shared gate
 * helper (SHARED_GATE_HELPERS) that an earlier set already put in the tree,
 * when the two copies are the same file but for the header's second line
 * (which names the set), and refuses one whose body differs. These cases
 * drive it on scratch sets and on the committed ones, staged on HEAD as
 * startStack stages a gated, proxied copy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { E2E_TMP, PATCHES_DIR, ensureDir } from "../lib/paths.mjs";
import { BLOCK_SIZE, namePorts } from "../lib/ports.mjs";
import { materializeTree } from "../lib/tree.mjs";
import { SHARED_GATE_HELPERS, applyPatchSet, helperBody, patchAppConfig, patchFirebaseJson, patchNewFiles, writeFunctionsEnv } from "../lib/patch.mjs";
import { listAmplifySets, readAmplify } from "../lib/gates.mjs";
import { patchSetsOf } from "../lib/options.mjs";
import { installEgressGuard } from "../lib/egress.mjs";
import { withAuxPorts } from "../lib/stack.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const SERVER = "functions/src/lib/e2eGate.ts";
const CLIENT = "app/src/e2eGate.ts";
/**
 * Pairs that do not apply together for a reason other than a shared helper:
 * both add their pause point and their `import { e2eGate } from "./e2eGate"`
 * at the same place in functions/src/lib/draft.ts. Each must still fail on a
 * file that is not a shared helper, so a regression here cannot hide.
 */
const KNOWN_CONFLICTS = Object.freeze([["amplify-c13-feedback", "amplify-mint-join", "functions/src/lib/draft.ts"]]);

/** git apply in `dir`, which is no repository (as the stack's own gitApply). */
function gitApply(dir, args) {
  return execFileSync("git", ["apply", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CEILING_DIRECTORIES: dirname(dir) } });
}

/** A creation patch for `path` with `content`, as `git diff` writes one. */
function creation(path, content) {
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n${content.endsWith("\n") ? "" : "\\ No newline at end of file\n"}`;
}

const helper = (set, body = "export async function e2eGate(name: string, key: string): Promise<void> {\n  await fetch(`gate/${name}/${key}`);\n}\n") =>
  `// SPDX-License-Identifier: Apache-2.0\n// e2e only, applied to a stack copy by e2e/patches/${set}: a server pause point (SPEC §12).\n\n${body}`;

/** A scratch tree (src/a.ts) and a patch root with the given sets: {set: {"10-x.patch": text}}. */
function scratchSets(sets) {
  const dir = tempDir("e2e-shared-helpers-");
  const tree = join(dir, "tree");
  mkdirSync(join(tree, "src"), { recursive: true });
  mkdirSync(join(tree, "functions", "src", "lib"), { recursive: true });
  writeFileSync(join(tree, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  const root = join(dir, "patches");
  for (const [set, files] of Object.entries(sets)) {
    mkdirSync(join(root, set), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, set, name), text);
  }
  return { tree, root };
}

const editA = (from, to) => `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n export const a = 1;\n-export const b = ${from};\n+export const b = ${to};\n export const c = 3;\n`;

test("patchNewFiles reads what each committed amplify patch creates exactly as git apply writes it", () => {
  let files = 0;
  for (const set of listAmplifySets()) {
    for (const p of readAmplify(set).patches) {
      const file = join(PATCHES_DIR, set, p);
      for (const { path, content } of patchNewFiles(readFileSync(file, "utf8"))) {
        const dir = tempDir("e2e-newfiles-");
        gitApply(dir, [`--include=${path}`, file]);
        assert.equal(content, readFileSync(join(dir, path), "utf8"), `${set}/${p}: ${path}`);
        files += 1;
      }
    }
  }
  assert.ok(files >= 7, `${files} created file(s) read`);
  // The shapes git writes beside them: no newline at the end, a one-line hunk, timestamps, a change (not a creation).
  const odd = [
    creation("x/no-eol.ts", "one\ntwo"),
    "--- /dev/null\t2026-10-13 00:00:00\n+++ b/x/one.ts\t2026-10-13 00:00:00\n@@ -0,0 +1 @@\n+single\n",
    editA(2, 5),
  ].join("");
  assert.deepEqual(patchNewFiles(odd), [{ path: "x/no-eol.ts", content: "one\ntwo" }, { path: "x/one.ts", content: "single\n" }]);
  const dir = tempDir("e2e-newfiles-odd-");
  writeFileSync(join(dir, "odd.patch"), creation("x/no-eol.ts", "one\ntwo"));
  gitApply(dir, ["odd.patch"]);
  assert.equal(readFileSync(join(dir, "x", "no-eol.ts"), "utf8"), "one\ntwo", "git agrees about the missing newline");
  assert.throws(() => patchNewFiles("--- /dev/null\n+++ b/x.ts\n@@ -0,0 +1,3 @@\n+a\n"), /promises 3 added line\(s\) and has 1/);
  assert.throws(() => patchNewFiles("--- /dev/null\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n+a\n"), /not @@ -0,0 \+1,N @@/);
  assert.throws(() => patchNewFiles(Buffer.from("x")), TypeError);
});

test("the committed copies of the server helper are one helper: the same body, each header naming its own set", () => {
  const copies = [];
  for (const set of listAmplifySets()) {
    for (const p of readAmplify(set).patches) {
      for (const f of patchNewFiles(readFileSync(join(PATCHES_DIR, set, p), "utf8"))) if (SHARED_GATE_HELPERS.includes(f.path)) copies.push({ set, ...f });
    }
  }
  const server = copies.filter((c) => c.path === SERVER);
  assert.deepEqual(server.map((c) => c.set).sort(), ["amplify-c10-accept", "amplify-c13-feedback", "amplify-mint-join"]);
  assert.equal(new Set(server.map((c) => helperBody(c.content))).size, 1, "one body: else a stack naming two of them is refused (make them the same, or give one its own file)");
  for (const c of server) assert.match(c.content.split("\n")[1], new RegExp(`e2e/patches/${c.set}:`), `${c.set}'s header names it`);
  assert.equal(new Set(server.map((c) => c.content)).size, 3, "the bytes differ (the header), so a byte comparison would refuse every pair");
  assert.deepEqual(copies.filter((c) => c.path === CLIENT).map((c) => c.set), ["amplify-mint-join"]);
  assert.equal(helperBody("// SPDX-License-Identifier: Apache-2.0\n// owns X\n\ncode\n"), "// SPDX-License-Identifier: Apache-2.0\n\ncode\n");
  assert.equal(helperBody("// not a header\n// line two\ncode\n"), "// not a header\n// line two\ncode\n", "no SPDX first line: the whole text");
});

test("two sets that each add the helper apply together in either order: the tree keeps the first copy, the second lists it as shared, and its own other files still apply", () => {
  for (const order of [["amplify-x", "amplify-y"], ["amplify-y", "amplify-x"]]) {
    const { tree, root } = scratchSets({
      "amplify-x": { "10-helper.patch": creation(SERVER, helper("amplify-x")) },
      "amplify-y": { "10-helper.patch": `${creation(SERVER, helper("amplify-y"))}${creation("functions/src/lib/yOnly.ts", "export const y = 1;\n")}`, "20-edit.patch": editA(2, 7) },
    });
    for (const set of ["amplify-x", "amplify-y"]) writeFileSync(join(root, set, "amplify.json"), JSON.stringify({ what: "w", gates: [{ name: `g-${set.slice(-1)}`, side: "server", where: "w" }] }));
    const [first, second] = order;
    const r1 = applyPatchSet(tree, first, { root });
    const r2 = applyPatchSet(tree, second, { root });
    assert.deepEqual(Object.keys(r1), ["set", "applied"], "the first set: the old result exactly");
    assert.equal(readFileSync(join(tree, SERVER), "utf8"), helper(first), "the tree keeps the first set's copy, byte for byte");
    assert.deepEqual(r2.shared, [{ file: join(root, second, "10-helper.patch"), path: SERVER, from: first }]);
    assert.equal(r2.applied.length, second === "amplify-y" ? 2 : 1, "a patch whose helper was shared is still listed as applied");
    assert.equal(existsSync(join(tree, "functions/src/lib/yOnly.ts")), true, "the rest of a patch that shares a helper applies");
    assert.match(readFileSync(join(tree, "src", "a.ts"), "utf8"), /b = 7;/);
  }
});

test("a helper whose body differs is refused, E2E_PATCH naming the path and the set already in, before anything of the second set is applied", () => {
  const { tree, root } = scratchSets({
    "amplify-x": { "10-helper.patch": creation(SERVER, helper("amplify-x")) },
    "amplify-z": { "05-edit.patch": editA(2, 9), "10-helper.patch": creation(SERVER, helper("amplify-z", "export async function e2eGate(): Promise<void> {}\n")) },
  });
  for (const set of ["amplify-x", "amplify-z"]) writeFileSync(join(root, set, "amplify.json"), JSON.stringify({ what: "w", gates: [{ name: "g", side: "server", where: "w" }] }));
  applyPatchSet(tree, "amplify-x", { root });
  assert.throws(() => applyPatchSet(tree, "amplify-z", { root }), (e) => e.code === "E2E_PATCH" && e.message.includes(`adds ${SERVER}, which the set amplify-x already put in the stack tree with a different body`));
  assert.match(readFileSync(join(tree, "src", "a.ts"), "utf8"), /b = 2;/, "the set's earlier patch was not applied either");
  assert.equal(readFileSync(join(tree, SERVER), "utf8"), helper("amplify-x"));
});

test("only the shared gate helpers are shared: any other file a set adds that the tree already holds is refused by git apply, as before", () => {
  const same = "export const same = 1;\n";
  const { tree, root } = scratchSets({ "set-a": { "10-new.patch": creation("src/new.ts", same) }, "set-b": { "10-new.patch": creation("src/new.ts", same) } });
  applyPatchSet(tree, "set-a", { root });
  assert.throws(() => applyPatchSet(tree, "set-b", { root }), (e) => e.code === "E2E_PATCH" && /does not apply to the stack tree/.test(e.message) && /already exists/.test(e.message));
});

test("one set alone: the old result exactly (no `shared`), its own copy of the helper; a stack record with `shared` still names its sets", () => {
  const { tree, root } = scratchSets({ "amplify-x": { "10-helper.patch": creation(SERVER, helper("amplify-x")), "20-edit.patch": editA(2, 3) } });
  writeFileSync(join(root, "amplify-x", "amplify.json"), JSON.stringify({ what: "w", gates: [{ name: "g", side: "server", where: "w" }] }));
  const r = applyPatchSet(tree, "amplify-x", { root });
  assert.deepEqual(Object.keys(r), ["set", "applied"]);
  assert.deepEqual(r.applied.map((a) => a.file), [join(root, "amplify-x", "10-helper.patch"), join(root, "amplify-x", "20-edit.patch")]);
  assert.equal(readFileSync(join(tree, SERVER), "utf8"), helper("amplify-x"));
  const rec = { patches: [r, { set: "amplify-y", applied: [], shared: [{ file: "/p/10.patch", path: SERVER, from: "amplify-x" }] }] };
  assert.deepEqual(patchSetsOf(rec), ["amplify-x", "amplify-y"], "options.mjs patchSetsOf (capabilities patch:<set>) reads a record with `shared`");
});

test("the committed amplify sets on HEAD, staged as startStack stages a gated, proxied copy: every pair applies in either order (bar the known draft.ts conflict), each with every gate of both sets called", async () => {
  const work = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-shared-helpers-"));
  try {
    const base = join(work, "base");
    const { treeDir } = await materializeTree({ runId: "selftest-shared-helpers", tree: "HEAD", dest: base, linkModules: false });
    const ports = withAuxPorts(namePorts(Array.from({ length: BLOCK_SIZE }, (_, i) => 34880 + i)), { gates: true, rtdbProxy: true });
    const fb = patchFirebaseJson(treeDir, ports);
    patchAppConfig(treeDir, { ...ports, database: ports.rtdbProxy }, fb.defaults);
    writeFunctionsEnv(treeDir, ports, { gateUrl: `http://127.0.0.1:${ports.gate}` });
    installEgressGuard(treeDir);
    const sets = listAmplifySets();
    assert.ok(sets.length >= 3 && sets.includes("amplify-c10-accept") && sets.includes("amplify-mint-join"), sets.join(", "));
    const known = (a, b) => KNOWN_CONFLICTS.find(([x, y]) => (x === a && y === b) || (x === b && y === a));
    const outcomes = [];
    for (const a of sets) {
      for (const b of sets) {
        if (a === b) continue;
        const tree = join(work, "pair");
        rmSync(tree, { recursive: true, force: true });
        cpSync(treeDir, tree, { recursive: true });
        let err = null;
        let results = [];
        try {
          results = [applyPatchSet(tree, a), applyPatchSet(tree, b)];
        } catch (e) {
          err = e;
        }
        const k = known(a, b);
        if (k) {
          // Allowed to fail, but never on a helper: only on the file the two pause points share.
          if (err) assert.ok(err.code === "E2E_PATCH" && err.message.includes(k[2]) && !SHARED_GATE_HELPERS.some((h) => err.message.includes(`${h}: already exists`)), `${a} + ${b}: ${err.message}`);
          outcomes.push(`${a} + ${b}: ${err ? "known conflict" : "applies"}`);
          continue;
        }
        assert.equal(err, null, `${a} + ${b}: ${err?.message}`);
        for (const set of [a, b]) {
          for (const g of readAmplify(set).gates) {
            const file = g.where.split(/[\s:]/)[0];
            assert.match(readFileSync(join(tree, file), "utf8"), new RegExp(`\\be2e\\w*Gate\\("${g.name}"`), `${a} + ${b}: ${set}'s ${g.side} gate ${g.name} in ${file}`);
          }
        }
        const shared = results[1].shared ?? [];
        for (const s of shared) assert.equal(s.from, a, `${a} + ${b}: ${s.path} is ${a}'s copy`);
        outcomes.push(`${a} + ${b}: applies${shared.length ? ` (shares ${shared.map((s) => s.path).join(", ")})` : ""}`);
      }
    }
    for (const pair of [["amplify-mint-join", "amplify-c10-accept"], ["amplify-c10-accept", "amplify-mint-join"], ["amplify-c10-accept", "amplify-c13-feedback"], ["amplify-c13-feedback", "amplify-c10-accept"]]) {
      assert.ok(outcomes.includes(`${pair[0]} + ${pair[1]}: applies (shares ${SERVER})`), `${pair.join(" + ")} shares the server helper: ${outcomes.join("; ")}`);
    }
    // Every set but the known conflict's one side, all on one stack.
    const all = sets.filter((s) => s !== "amplify-c13-feedback");
    const tree = join(work, "all");
    cpSync(treeDir, tree, { recursive: true });
    const rs = all.map((s) => applyPatchSet(tree, s));
    for (const set of all) for (const g of readAmplify(set).gates) assert.match(readFileSync(join(tree, g.where.split(/[\s:]/)[0]), "utf8"), new RegExp(`\\be2e\\w*Gate\\("${g.name}"`), `all: ${set} ${g.name}`);
    assert.deepEqual(rs.flatMap((r) => r.shared ?? []).map((s) => s.path), [SERVER], `all ${all.length}: the server helper shared once (${all.join(", ")})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("README names the rule (a set may be named beside any other; a differing helper is refused)", () => {
  const readme = readFileSync(join(PATCHES_DIR, "..", "README.md"), "utf8");
  assert.ok(/SHARED_GATE_HELPERS/.test(readme), "the README names SHARED_GATE_HELPERS");
  assert.ok(!/a second set that needs them\s+adds them itself, or is applied after it/.test(readme), "the old advice, which no longer holds, is gone");
});
