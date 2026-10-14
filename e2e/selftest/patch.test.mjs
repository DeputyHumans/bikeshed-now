// SPDX-License-Identifier: Apache-2.0
// Self-test: the copy patches hit exactly their anchors and fail loudly when the source moves; every control set applies (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { E2E_TMP, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { BLOCK_SIZE, namePorts } from "../lib/ports.mjs";
import { materializeTree } from "../lib/tree.mjs";
import {
  EMULATOR_PORTS_RE, applyPatchSet, listPatchSet, parseDotenv, patchAppConfig, patchFirebaseJson, rewriteEmulatorPorts, writeFunctionsEnv,
} from "../lib/patch.mjs";
import { assertTargetDeclared, controlVerdict, greenGroups, grepFor, listControlSets, readControl } from "../lib/controls.mjs";
import { installEgressGuard } from "../lib/egress.mjs";

const PORTS = namePorts(Array.from({ length: BLOCK_SIZE }, (_, i) => 34560 + i));
const realConfig = () => readFileSync(join(REPO_ROOT, "app", "src", "config.ts"), "utf8");
const realDefaults = () => {
  const e = JSON.parse(readFileSync(join(REPO_ROOT, "firebase.json"), "utf8")).emulators;
  return { auth: e.auth.port, firestore: e.firestore.port, database: e.database.port };
};
const scratch = () => mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-patch-"));

test("the anchor matches the checkout's real app/src/config.ts exactly once, with firebase.json's values", () => {
  const text = realConfig();
  const matches = [...text.matchAll(EMULATOR_PORTS_RE)];
  assert.equal(matches.length, 1);
  const out = rewriteEmulatorPorts(text, { defaults: realDefaults(), ports: PORTS });
  assert.match(out, new RegExp(`auth: ${PORTS.auth},\\n  firestore: ${PORTS.firestore},\\n  database: ${PORTS.database},`));
  const block = [...out.matchAll(EMULATOR_PORTS_RE)][0][0];
  for (const old of Object.values(realDefaults())) assert.ok(!block.includes(String(old)), `default ${old} gone from the block`);
  // Only the block changed.
  assert.equal(out.replace(block, "X"), text.replace([...text.matchAll(EMULATOR_PORTS_RE)][0][0], "X"));
});

test("NEGATIVE: a copy whose anchor changed shape fails loudly", () => {
  const text = realConfig();
  const mutations = {
    "renamed const": text.replace("export const EMULATOR_PORTS = {", "export const EMULATOR_PORT_MAP = {"),
    "reindented": text.replace("  auth: ", "    auth: "),
    "extra key": text.replace(/(\n {2}database: \d+,\n)/, "$1  storage: 9199,\n"),
    "duplicated": text + "\n" + [...text.matchAll(EMULATOR_PORTS_RE)][0][0] + "\n",
  };
  for (const [name, mutated] of Object.entries(mutations)) {
    assert.notEqual(mutated, text, `${name} mutated something`);
    assert.throws(() => rewriteEmulatorPorts(mutated, { defaults: realDefaults(), ports: PORTS }), (err) => err.code === "E2E_ANCHOR", name);
  }
});

test("NEGATIVE: config.ts ports that drifted from firebase.json fail loudly", () => {
  const drifted = { ...realDefaults(), firestore: realDefaults().firestore + 1 };
  assert.throws(() => rewriteEmulatorPorts(realConfig(), { defaults: drifted, ports: PORTS }), (err) => err.code === "E2E_ANCHOR_DRIFT");
});

test("NEGATIVE: a default port is never written into the block", () => {
  const bad = { ...PORTS, auth: 9099 };
  assert.throws(() => rewriteEmulatorPorts(realConfig(), { defaults: realDefaults(), ports: bad }), /outside the e2e range|deny list/);
});

test("firebase.json is rewritten as JSON: every emulator pinned, UI off, predeploy gone", () => {
  const dir = scratch();
  try {
    copyFileSync(join(REPO_ROOT, "firebase.json"), join(dir, "firebase.json"));
    const before = JSON.parse(readFileSync(join(dir, "firebase.json"), "utf8"));
    const { defaults } = patchFirebaseJson(dir, PORTS);
    assert.deepEqual(defaults, realDefaults());
    const after = JSON.parse(readFileSync(join(dir, "firebase.json"), "utf8"));
    for (const k of ["auth", "firestore", "database", "functions", "hosting", "storage", "hub", "logging", "eventarc", "tasks"]) {
      assert.equal(after.emulators[k].port, PORTS[k], k);
      assert.equal(after.emulators[k].host, "127.0.0.1", k);
    }
    assert.equal(after.emulators.firestore.websocketPort, PORTS.firestoreWs);
    assert.equal(after.emulators.ui.enabled, false);
    assert.equal(after.hosting.predeploy, undefined);
    assert.deepEqual(after.hosting.rewrites, before.hosting.rewrites, "rewrites untouched");
    const all = JSON.stringify(after.emulators).match(/\d{4,5}/g).map(Number);
    for (const p of all) assert.ok(p >= 30000 && p <= 39999, `${p} in range`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("functions env points the SDK at the shim with a dummy key", () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, "functions"));
    writeFileSync(join(dir, "functions", "package.json"), "{}");
    const r = writeFunctionsEnv(dir, PORTS);
    const env = parseDotenv(readFileSync(join(dir, "functions", ".env.local"), "utf8"));
    assert.equal(env.RESEND_BASE_URL, `http://127.0.0.1:${PORTS.shim}`);
    assert.equal(env.BIKESHED_PUBLIC_ORIGIN, `http://127.0.0.1:${PORTS.hosting}`);
    assert.equal(env.BIKESHED_BUCKET, "demo-bikeshed-content");
    assert.match(env.BIKESHED_MAIL_FROM, /@[a-z0-9.-]+\.invalid>$/);
    assert.match(readFileSync(join(dir, "functions", ".secret.local"), "utf8"), /^RESEND_API_KEY=re_e2e_[0-9a-f]{24}\n$/);
    assert.match(r.apiKey, /^re_e2e_/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makePatchFixture() {
  const dir = scratch();
  const tree = join(dir, "tree");
  mkdirSync(join(tree, "src"), { recursive: true });
  writeFileSync(join(tree, "src", "a.txt"), "one\ntwo\nthree\n");
  const root = join(dir, "patches");
  for (const set of ["good", "bad", "empty"]) mkdirSync(join(root, set), { recursive: true });
  const good = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
  writeFileSync(join(root, "good", "01-two.patch"), good);
  writeFileSync(join(root, "bad", "01-two.patch"), good);
  writeFileSync(join(root, "bad", "02-missing.patch"), "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,3 +1,3 @@\n one\n-zwei\n+ZWEI\n three\n");
  return { dir, tree, root };
}

test("a patch set is checked, then applied, to the copy only", () => {
  const { dir, tree, root } = makePatchFixture();
  try {
    const r = applyPatchSet(tree, "good", { root });
    assert.equal(r.applied.length, 1);
    assert.equal(readFileSync(join(tree, "src", "a.txt"), "utf8"), "one\nTWO\nthree\n");
    assert.deepEqual(applyPatchSet(tree, "empty", { root }).applied, []);
    assert.throws(() => listPatchSet("nope", root), /no patch set nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NEGATIVE: a set with one patch that does not apply is a harness error and applies nothing", () => {
  const { dir, tree, root } = makePatchFixture();
  try {
    assert.throws(() => applyPatchSet(tree, "bad", { root }), (err) => err.code === "E2E_PATCH" && /02-missing\.patch/.test(err.message));
    assert.equal(readFileSync(join(tree, "src", "a.txt"), "utf8"), "one\ntwo\nthree\n", "the good patch in the set was not applied either");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every committed patch set applies to HEAD, each on its own fresh copy", async () => {
  const sets = readdirSync(join(REPO_ROOT, "e2e", "patches")).filter((n) => statSync(join(REPO_ROOT, "e2e", "patches", n)).isDirectory()).sort();
  assert.ok(sets.includes("amplify"), sets.join(", "));
  let applied = 0;
  for (const set of sets) {
    const files = listPatchSet(set);
    if (files.length === 0) continue;
    const dir = scratch();
    try {
      const { treeDir } = await materializeTree({ runId: "selftest-patchsets", tree: "HEAD", dest: join(dir, "tree"), linkModules: false });
      // What startStack stages into a tree before any patch set, in its order: a
      // control may patch any of it (controls-a03-nosniff patches the rewritten
      // firebase.json, whose lines are not the checkout's).
      const ports = namePorts(Array.from({ length: BLOCK_SIZE }, (_, i) => 30000 + i));
      const fb = patchFirebaseJson(treeDir, ports);
      patchAppConfig(treeDir, ports, fb.defaults);
      writeFunctionsEnv(treeDir, ports);
      installEgressGuard(treeDir);
      const r = applyPatchSet(treeDir, set);
      applied += r.applied.length;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.ok(applied >= listControlSets().length, `${applied} patch(es) applied`);
});

test("one control set per oracle family, each with a valid control.json whose target case is declared", () => {
  const sets = listControlSets();
  const families = ["controls-annotations", "controls-bodyattr", "controls-cli-list", "controls-decor", "controls-egress", "controls-email-off", "controls-i1-applyremote", "controls-mail-dup", "controls-mcp-tools", "controls-rehash"];
  for (const f of families) assert.ok(sets.includes(f), `${f} is committed (have ${sets.join(", ")})`);
  for (const set of sets) {
    const c = readControl(set);
    assert.ok(c.patches.length >= 1, `${set} has a patch`);
    assertTargetDeclared(c);
  }
  assert.ok(!existsSync(join(REPO_ROOT, "e2e", "patches", "controls")), "no catch-all controls set: one family per set");
});

test("controlVerdict: ok only for red-with-the-message plus green", () => {
  const c = { set: "controls-x", expect: { message: "DECOR: decoration" } };
  const fail = (message) => ({ status: "fail", error: { message } });
  assert.equal(controlVerdict(c, { red: fail("DECOR: decoration in v2"), green: { status: "pass" } }).ok, true);
  assert.match(controlVerdict(c, { red: { status: "pass" }, green: { status: "pass" } }).problems[0], /the oracle did not see the bug/, "NEGATIVE: a control that stays green");
  assert.match(controlVerdict(c, { red: fail("timeout"), green: { status: "pass" } }).problems[0], /not with/, "NEGATIVE: red for another reason");
  assert.match(controlVerdict(c, { red: fail("DECOR: decoration"), green: { status: "fail", error: { message: "x" } } }).problems[0], /green/, "NEGATIVE: the clean side is red too");
  assert.equal(controlVerdict(c, { red: null, green: null }).problems.length, 2);
  assert.equal(grepFor(["a (b)", "c.d"]), "^(?:a \\(b\\)|c\\.d)$");
});

test("a control may name its suite and stack options; bad ones are refused; the clean side groups by them", () => {
  const root = mkdtempSync(join(tmpdir(), "e2e-controls-"));
  try {
    const make = (set, extra) => {
      mkdirSync(join(root, set));
      writeFileSync(join(root, set, "10-x.patch"), "");
      writeFileSync(join(root, set, "control.json"), JSON.stringify({ oracle: "X", what: "w", target: { spec: "e2e/specs/smoke/x.spec.mjs", case: "c" }, expect: { message: "m" }, ...extra }));
    };
    make("controls-a", {});
    make("controls-b", { target: { spec: "e2e/specs/smoke/x.spec.mjs", case: "c", suite: "smoke" } });
    make("controls-c", { target: { spec: "e2e/specs/smoke/x.spec.mjs", case: "d", suite: "smoke" }, stack: ["--email-off"] });
    make("controls-d", { target: { spec: "e2e/specs/smoke/x.spec.mjs", case: "e", suite: "smoke" } });
    make("controls-bad-suite", { target: { spec: "s", case: "c", suite: "nightly" } });
    make("controls-bad-stack", { stack: ["--patches", "x"] });
    const [a, b, c, d] = ["controls-a", "controls-b", "controls-c", "controls-d"].map((s) => readControl(s, root));
    assert.deepEqual([a.target.suite, a.stack], ["functional", []], "defaults: the functional suite, no stack options");
    assert.deepEqual([c.target.suite, c.stack], ["smoke", ["--email-off"]]);
    assert.throws(() => readControl("controls-bad-suite", root), /target\.suite must be one of/);
    assert.throws(() => readControl("controls-bad-stack", root), /not a stack option/);
    const groups = greenGroups([a, b, c, d]);
    assert.deepEqual(groups.map((g) => [g.suite, g.stack, g.controls.map((x) => x.set)]), [
      ["functional", [], ["controls-a"]],
      ["smoke", [], ["controls-b", "controls-d"]],
      ["smoke", ["--email-off"], ["controls-c"]],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
