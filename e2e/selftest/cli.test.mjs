// SPDX-License-Identifier: Apache-2.0
// Self-test: the CLI wrapper builds its env from nothing, forces the target's origin, and stubs the browser (SPEC §12, §19).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../lib/paths.mjs";
import { cliEntry, cliEnv, cliHome, runCli, spawnCapture } from "../lib/cli.mjs";
import { SYSTEM_PATH } from "../lib/proc.mjs";
import { fileURLToPath } from "node:url";
import { GUARD_IN_TREE, GUARD_SOURCE, egressEnv, installEgressGuard, readEgress } from "../lib/egress.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const BACKSTOP = fileURLToPath(new URL("./helpers/egress-backstop.mjs", import.meta.url));

const runDir = tempDir("e2e-cli-");
const TARGET = Object.freeze({ kind: "local", runId: "2610101200-clit", origin: "http://127.0.0.1:39001", runDir, stack: { treeDir: REPO_ROOT, ports: { hosting: 39001 } } });
const allow = { checkCli: async () => ({ allow: true }) };
const CLI_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "cli", "package.json"), "utf8")).version;

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

test("cliEnv: built from nothing — the target's origin, the run's agent, a private HOME, no inherited bindings", () => {
  const saved = { ...process.env };
  process.env.BIKESHED_ORIGIN = "https://inherited.invalid";
  process.env.BIKESHED_TOKEN = "bsk_inherited";
  process.env.GOOGLE_APPLICATION_CREDENTIALS = "/nowhere.json";
  try {
    const home = cliHome(TARGET, "env-test");
    const env = cliEnv(TARGET, { home });
    assert.deepEqual(Object.keys(env).sort(), ["BIKESHED_AGENT", "BIKESHED_ORIGIN", "E2E_EGRESS_LOG", "E2E_OPENED_LOG", "HOME", "LANG", "NODE_OPTIONS", "PATH", "TMPDIR", "XDG_CONFIG_HOME"]);
    assert.equal(env.BIKESHED_ORIGIN, TARGET.origin);
    assert.equal(env.BIKESHED_AGENT, "bikeshed-e2e/2610101200-clit");
    assert.ok(env.HOME.startsWith(runDir) && env.XDG_CONFIG_HOME.startsWith(env.HOME));
    assert.ok(env.PATH.startsWith(home.bin), "the stub openers come first on PATH");
    assert.equal(cliEnv(TARGET, { home, token: "bsk_given" }).BIKESHED_TOKEN, "bsk_given");
    assert.throws(() => cliEnv(TARGET, { home, extra: { BIKESHED_ORIGIN: "https://elsewhere.invalid" } }));
  } finally {
    for (const k of ["BIKESHED_ORIGIN", "BIKESHED_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS"]) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("cliEnv arms the egress guard for a local target: the stack's copy and log, else the harness's guard and a log in the CLI home; never for another kind; not overridable", () => {
  const home = cliHome(TARGET, "guard-env");
  // The self-test target's tree (this checkout) holds no stack copy, and its stack names no log.
  const bare = cliEnv(TARGET, { home });
  assert.equal(bare.NODE_OPTIONS, `--require=${GUARD_SOURCE}`, "--require, so the CLI's worker threads are guarded too");
  assert.equal(bare.E2E_EGRESS_LOG, join(home.home, "egress.jsonl"));
  const tree = tempDir("e2e-cli-guard-tree-");
  const g = installEgressGuard(tree);
  const log = join(runDir, "logs-guard-env", "egress.jsonl");
  const stacked = cliEnv({ ...TARGET, stack: { treeDir: tree, logs: { egress: log } } }, { home });
  assert.equal(stacked.NODE_OPTIONS, `--require=${join(tree, GUARD_IN_TREE)}`, "the guard the stack was built with");
  assert.equal(g.file, join(tree, GUARD_IN_TREE));
  assert.equal(stacked.E2E_EGRESS_LOG, log, "refusals land in the stack's egress log");
  for (const k of ["NODE_OPTIONS", "E2E_EGRESS_LOG"]) {
    assert.throws(() => cliEnv(TARGET, { home, extra: { [k]: "" } }), /egress guard/, `${k} cannot be cleared through extra`);
  }
  const other = cliEnv({ ...TARGET, kind: "prod" }, { home });
  assert.equal(other.NODE_OPTIONS, undefined, "a deployment target is not local, and its CLI is not guarded");
});

/** A stand-in tree CLI: `probe` reports whether the guard is armed; `reach` builds its URL without BIKESHED_ORIGIN, as a CLI defect would. */
const FAKE_CLI = `// a stand-in for a tree's CLI (cli.test.mjs)
import net from "node:net";
const [cmd] = process.argv.slice(2);
const armed = () => Boolean(globalThis[Symbol.for("bikeshed-e2e.egress-guard")]);
const out = { guard: armed(), origin: process.env.BIKESHED_ORIGIN ?? null };
if (cmd === "reach") {
  out.connect = await new Promise((res) => {
    const s = net.connect(443, "192.0.2.30");
    s.once("connect", () => { s.destroy(); res("connected"); });
    s.once("error", (e) => res(e.code ?? String(e)));
  });
  out.fetch = await fetch("https://cli-egress-fetch.invalid/api/documents").then((r) => String(r.status), (e) => e?.cause?.code ?? e?.code ?? String(e));
}
process.stdout.write(JSON.stringify(out));
`;

function fakeTreeTarget(label) {
  const tree = tempDir(`e2e-cli-fake-${label}-`);
  mkdirSync(join(tree, "cli", "src"), { recursive: true });
  writeFileSync(join(tree, "cli", "src", "index.mjs"), FAKE_CLI);
  installEgressGuard(tree);
  mkdirSync(join(tree, "logs"));
  const log = join(tree, "logs", "egress.jsonl");
  return { ...TARGET, stack: { treeDir: tree, ports: TARGET.stack.ports, logs: { egress: log } } };
}

test("runCli: the CLI child runs under the egress guard", async () => {
  const t = fakeTreeTarget("probe");
  const r = await runCli(t, ["probe"], { guard: allow });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.source, "tree");
  assert.deepEqual(JSON.parse(r.stdout), { guard: true, origin: TARGET.origin });
});

test("a CLI command that ignores BIKESHED_ORIGIN is refused at connect and logged in the stack's egress log (a backstop under the guard proves nothing got past)", async () => {
  // The CLI's environment exactly as runCli builds it, plus a backstop
  // preloaded BEFORE the guard: whatever the guard lets through lands in the
  // backstop's log and fails there, so no packet leaves even when the guard
  // is missing.
  const t = fakeTreeTarget("reach");
  const home = cliHome(t, "reach");
  const env = cliEnv(t, { home });
  const backstop = join(home.home, "backstop.jsonl");
  env.NODE_OPTIONS = `--require=${BACKSTOP} ${env.NODE_OPTIONS ?? ""}`.trim();
  env.E2E_BACKSTOP_LOG = backstop;
  const r = await spawnCapture(process.execPath, [cliEntry(t).entry, "reach"], { cwd: home.home, env });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(existsSync(backstop) ? readFileSync(backstop, "utf8") : "", "", "nothing reached the backstop: the guard refused first");
  assert.deepEqual([out.guard, out.connect, out.fetch], [true, "E2E_EGRESS_REFUSED", "E2E_EGRESS_REFUSED"]);
  const lines = readEgress(t.stack.logs.egress);
  assert.ok(lines.some((l) => l.kind === "connect" && l.host === "192.0.2.30" && l.port === 443), JSON.stringify(lines));
  assert.ok(lines.some((l) => l.kind === "connect" && l.host === "cli-egress-fetch.invalid" && l.port === 443), JSON.stringify(lines));
});

test("cliEnv refuses to run when BIKESHED_ORIGIN would be unset", () => {
  for (const origin of [undefined, "", "not a url", "https://x.invalid/path"]) {
    assert.throws(() => cliEnv({ ...TARGET, origin }), /refusing to run without BIKESHED_ORIGIN/, String(origin));
  }
});

test("the hazard is real: with no BIKESHED_ORIGIN the CLI's config resolves a production origin (why the wrapper refuses) — read in a scrubbed child, no command run", async () => {
  // cli/src/config.mjs is imported in a child whose env is built here from
  // nothing (a private HOME, no BIKESHED_*), and only resolveAuth() is called:
  // no command runs, so nothing can be sent anywhere. The egress guard is
  // preloaded anyway, and its log must stay empty.
  const home = tempDir("e2e-cli-hazard-");
  const log = join(home, "egress.jsonl");
  const config = pathToFileURL(join(REPO_ROOT, "cli", "src", "config.mjs")).href;
  const probe = "const m = await import(process.argv[1]); process.stdout.write(JSON.stringify(m.resolveAuth()));";
  const base = { PATH: [dirname(process.execPath), ...SYSTEM_PATH].join(":"), HOME: home, XDG_CONFIG_HOME: join(home, ".config"), LANG: "en_US.UTF-8", ...egressEnv({ file: GUARD_SOURCE, log }) };
  const bare = await spawnCapture(process.execPath, ["--input-type=module", "-e", probe, config], { cwd: home, env: base });
  assert.equal(bare.code, 0, bare.stderr);
  const resolved = JSON.parse(bare.stdout);
  assert.match(resolved.origin, /^https:\/\/[^/]+$/, "the fallback is a real https origin");
  assert.ok(!/127\.0\.0\.1|localhost/.test(resolved.origin), "it does not find the stack by itself");
  assert.equal(resolved.token, "");
  // The wrapper's environment is what fixes it.
  const wrapped = await spawnCapture(process.execPath, ["--input-type=module", "-e", probe, config], { cwd: home, env: { ...base, BIKESHED_ORIGIN: cliEnv(TARGET, { home: cliHome(TARGET, "hazard") }).BIKESHED_ORIGIN } });
  assert.equal(JSON.parse(wrapped.stdout).origin, TARGET.origin);
  assert.equal(existsSync(log) ? readFileSync(log, "utf8") : "", "", "nothing tried to reach out");
});

test("runCli: the tree's CLI runs with the target origin, and `open` reaches the stub, not a browser", async () => {
  const home = cliHome(TARGET, "open-test");
  const r = await runCli(TARGET, ["open", "some-doc"], { home, guard: allow });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${TARGET.origin}/d/some-doc`);
  assert.equal(r.source, "worktree", "identical tree → this checkout's copy");
  const opened = await waitFor(() => existsSync(home.opened) && readFileSync(home.opened, "utf8").trim());
  assert.equal(opened, `${TARGET.origin}/d/some-doc`);
  const v = await runCli(TARGET, ["--version"], { home, guard: allow });
  assert.match(v.stdout, new RegExp(CLI_VERSION.replace(/\./g, "\\.")));
});

test("runCli refuses an --origin that is not the target's, before spawning anything", async () => {
  await assert.rejects(runCli(TARGET, ["list", "--origin", "https://elsewhere.invalid"], { guard: allow }), /refusing --origin/);
  await assert.rejects(runCli(TARGET, ["list", "--origin=https://elsewhere.invalid"], { guard: allow }), /refusing --origin/);
  await assert.doesNotReject(runCli(TARGET, ["open", "y", "--origin", `${TARGET.origin}/`], { guard: allow }));
});

test("cliEntry: a tree whose cli/src differs runs its own copy; a tree with none is refused", () => {
  assert.equal(cliEntry(TARGET).source, "worktree");
  const other = tempDir("e2e-tree-");
  mkdirSync(join(other, "cli", "src"), { recursive: true });
  writeFileSync(join(other, "cli", "src", "index.mjs"), "// a different CLI\n");
  assert.deepEqual(cliEntry({ ...TARGET, stack: { treeDir: other } }), { entry: join(other, "cli", "src", "index.mjs"), source: "tree" });
  const empty = tempDir("e2e-tree-");
  assert.throws(() => cliEntry({ ...TARGET, stack: { treeDir: empty } }), /no cli\/src\/index\.mjs/);
});
