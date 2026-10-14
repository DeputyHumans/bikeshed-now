// SPDX-License-Identifier: Apache-2.0
// Self-test: spawnCli runs a long-lived CLI with live output, its own process group, a stop, a maximum, a lifeline, and a `cut` timed from its marks (SPEC §12, §19).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliEnv, cliHome, spawnCli } from "../lib/cli.mjs";
import { GUARD_IN_TREE, installEgressGuard } from "../lib/egress.mjs";
import { HOSTING_CUTOFF_MS, answered, stackDidNotAnswer } from "../lib/test.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const allow = { checkCli: async () => ({ allow: true }) };
const LIFELINE = fileURLToPath(new URL("../lib/cli-lifeline.mjs", import.meta.url));
const CLI_LIB = new URL("../lib/cli.mjs", import.meta.url).href;

/**
 * A stand-in tree CLI. `serve` prints one JSON line about itself, then runs
 * until stopped, doing what each new line of cmd.txt (in its cwd) says:
 * out:<text> / err:<text> / errpart:<text> (no newline) / spawn (a sleeping
 * grandchild in its group) / ignore-term / exit:<n>.
 */
const FAKE_CLI = `// a stand-in for a tree's CLI (cli-spawn.test.mjs)
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const [cmd] = process.argv.slice(2);
if (cmd === "serve") {
  const env = {};
  for (const k of ["NODE_OPTIONS", "E2E_CLI_PARENT_PID", "E2E_CLI_DEADLINE", "BIKESHED_ORIGIN", "BIKESHED_TOKEN"]) env[k] = process.env[k] ?? null;
  console.log(JSON.stringify({ ready: process.pid, ppid: process.ppid, guard: Boolean(globalThis[Symbol.for("bikeshed-e2e.egress-guard")]), env, keys: Object.keys(process.env).sort() }));
  let seen = 0;
  setInterval(() => {
    if (!existsSync("cmd.txt")) return;
    const lines = readFileSync("cmd.txt", "utf8").split("\\n").filter(Boolean);
    for (const line of lines.slice(seen)) {
      const at = line.indexOf(":");
      const op = at < 0 ? line : line.slice(0, at);
      const text = at < 0 ? "" : line.slice(at + 1);
      if (op === "out") process.stdout.write(text + "\\n");
      else if (op === "err") process.stderr.write(text + "\\n");
      else if (op === "errpart") process.stderr.write(text);
      else if (op === "spawn") { const c = spawn("/bin/sleep", ["60"], { stdio: "ignore" }); process.stdout.write(JSON.stringify({ child: c.pid }) + "\\n"); }
      else if (op === "ignore-term") { process.on("SIGTERM", () => {}); process.stdout.write("ignoring SIGTERM\\n"); }
      else if (op === "exit") process.exit(Number(text));
    }
    seen = lines.length;
  }, 15);
}
`;

/**
 * A spec process that starts a CLI with spawnCli, has it start a grandchild,
 * prints both pids, then exits ("exit") or waits to be killed ("hold").
 */
const HOLDER = `// a spec process for cli-spawn.test.mjs
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const [libUrl, targetJson, mode] = process.argv.slice(2);
const { spawnCli } = await import(libUrl);
const target = JSON.parse(targetJson);
const w = await spawnCli(target, ["serve"], { guard: { checkCli: async () => ({ allow: true }) }, maxMs: 120000 });
const until = async (fn) => { for (let i = 0; i < 1000 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); return fn(); };
await until(() => w.stdout.includes('"ready"'));
appendFileSync(join(w.home.home, "cmd.txt"), "spawn\\n");
const child = await until(() => /"child":(\\d+)/.exec(w.stdout)?.[1]);
process.stdout.write(JSON.stringify({ cli: w.pid, child: Number(child) }) + "\\n");
if (mode === "exit") process.exit(0);
setInterval(() => {}, 1000);
`;

function fakeTarget() {
  const runDir = tempDir("e2e-clispawn-run-");
  const tree = tempDir("e2e-clispawn-tree-");
  mkdirSync(join(tree, "cli", "src"), { recursive: true });
  writeFileSync(join(tree, "cli", "src", "index.mjs"), FAKE_CLI);
  installEgressGuard(tree);
  mkdirSync(join(tree, "logs"));
  return { kind: "local", runId: "2610121200-cspn", origin: "http://127.0.0.1:39021", runDir, stack: { treeDir: tree, ports: { hosting: 39021 }, logs: { egress: join(tree, "logs", "egress.jsonl") } } };
}

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const killGroup = (pgid) => {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {}
};
const killPid = (pid) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
};

async function until(fn, ms = 5_000, what = "a condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const say = (w, line) => appendFileSync(join(w.home.home, "cmd.txt"), `${line}\n`);
const readyOf = (w) => JSON.parse(w.stdout.split("\n").find((l) => l.includes('"ready"')));

test("spawnCli: returns at once with live stdout and timestamped stderr; same environment as runCli plus the lifeline after the guard", async () => {
  const target = fakeTarget();
  const home = cliHome(target, "live");
  const t0 = performance.now();
  const w = await spawnCli(target, ["serve"], { guard: allow, home, token: "bsk_given" });
  try {
    assert.equal(w.exited, null, "it is still running when spawnCli resolves");
    assert.equal(w.source, "tree");
    assert.ok(w.startedAt >= t0 && w.startedAt <= performance.now());
    await until(() => w.stdout.includes('"ready"'), 5_000, "the ready line");
    const ready = readyOf(w);
    assert.equal(ready.ready, w.pid);
    assert.equal(ready.ppid, process.pid, "this process is its parent");
    assert.equal(ready.guard, true, "the egress guard is armed");
    const base = cliEnv(target, { home, token: "bsk_given" });
    // macOS adds __CF_USER_TEXT_ENCODING to every process's environment itself.
    const keys = ready.keys.filter((k) => k !== "__CF_USER_TEXT_ENCODING");
    assert.deepEqual(keys, [...Object.keys(base), "E2E_CLI_DEADLINE", "E2E_CLI_PARENT_PID"].sort(), "runCli's environment, plus the lifeline's two");
    assert.equal(ready.env.NODE_OPTIONS, `${base.NODE_OPTIONS} --require=${LIFELINE}`, "the guard first, then the lifeline");
    assert.equal(base.NODE_OPTIONS, `--require=${join(target.stack.treeDir, GUARD_IN_TREE)}`);
    assert.equal(ready.env.E2E_CLI_PARENT_PID, String(process.pid));
    assert.ok(Number(ready.env.E2E_CLI_DEADLINE) > Date.now() + 290_000, "the lifeline's deadline is past the default maxMs");
    assert.deepEqual([ready.env.BIKESHED_ORIGIN, ready.env.BIKESHED_TOKEN], [target.origin, "bsk_given"]);

    say(w, "out:first");
    await until(() => w.stdout.includes("first\n"), 5_000, "live stdout");
    const before = performance.now();
    say(w, "err:a note");
    await until(() => w.stderrLines.length === 1, 5_000, "a stderr line");
    assert.deepEqual(w.stderrLines.map((l) => l.text), ["a note"]);
    assert.equal(w.stderr, "a note\n");
    assert.ok(w.stderrAt.length >= 1 && w.stderrAt[0].t >= before && w.stderrAt.at(-1).t <= performance.now(), "chunks carry this process's performance.now()");
    assert.equal(w.stderrAt.map((c) => c.text).join(""), w.stderr);
    assert.equal(w.cut, null);
  } finally {
    await w.stop();
  }
  assert.equal(w.exited.signal, "SIGTERM");
  assert.equal(w.exited.stopped, "stop");
  assert.equal(await w.stop(), w.exited, "stopping again resolves the same exit");
});

test("spawnCli refuses what runCli refuses, before spawning: another --origin, a guard's no, args that are not a list, a bad maxMs", async () => {
  const target = fakeTarget();
  await assert.rejects(spawnCli(target, ["serve", "--origin", "https://elsewhere.invalid"], { guard: allow }), /refusing --origin https:\/\/elsewhere\.invalid/);
  await assert.rejects(spawnCli(target, ["serve", "--origin=https://elsewhere.invalid"], { guard: allow }), /refusing --origin/);
  await assert.rejects(spawnCli(target, ["serve"], { guard: { checkCli: async () => ({ allow: false, reason: "not on this tier" }) } }), (e) => e.code === "E2E_GUARD" && /guard refused bikeshed serve: not on this tier/.test(e.message));
  await assert.rejects(spawnCli(target, "serve", { guard: allow }), /spawnCli: args must be an array/);
  for (const maxMs of [0, -1, Number.NaN, Infinity, "300000"]) await assert.rejects(spawnCli(target, ["serve"], { guard: allow, maxMs }), (e) => e instanceof TypeError && /maxMs is a positive number/.test(e.message), String(maxMs));
  const w = await spawnCli(target, ["serve", "--origin", `${target.origin}/`], { guard: allow });
  await w.stop();
});

test("stop() ends the CLI's whole group, its grandchild included; a CLI that ignores SIGTERM is SIGKILLed after graceMs", async () => {
  const target = fakeTarget();
  const w = await spawnCli(target, ["serve"], { guard: allow });
  let child = null;
  try {
    await until(() => w.stdout.includes('"ready"'), 5_000, "the ready line");
    say(w, "spawn");
    child = Number(await until(() => /"child":(\d+)/.exec(w.stdout)?.[1], 5_000, "the grandchild"));
    assert.ok(alive(child));
    const exited = await w.stop();
    assert.equal(exited.signal, "SIGTERM");
    await until(() => !alive(child), 3_000, "the grandchild to go with its group");
  } finally {
    killPid(child);
    killGroup(w.pid);
  }

  const stubborn = await spawnCli(target, ["serve"], { guard: allow });
  try {
    await until(() => stubborn.stdout.includes('"ready"'), 5_000, "the ready line");
    say(stubborn, "ignore-term");
    await until(() => stubborn.stdout.includes("ignoring SIGTERM"), 5_000, "the CLI to ignore SIGTERM");
    const t = performance.now();
    const exited = await Promise.race([stubborn.stop({ graceMs: 300 }), new Promise((r) => setTimeout(() => r(null), 5_000))]);
    assert.ok(exited, "stop() resolved within 5 s of a 300 ms grace");
    assert.equal(exited.signal, "SIGKILL", "SIGTERM was ignored, so SIGKILL");
    assert.ok(performance.now() - t >= 250, "not before graceMs");
  } finally {
    killGroup(stubborn.pid);
  }
});

test("maxMs: the CLI is SIGKILLed when its maximum runs out, and says so", async () => {
  const target = fakeTarget();
  const w = await spawnCli(target, ["serve"], { guard: allow, maxMs: 400 });
  try {
    const exited = await Promise.race([w.done, new Promise((r) => setTimeout(() => r(null), 5_000))]);
    assert.ok(exited, "it was ended within 5 s of a 400 ms maximum");
    assert.equal(exited.signal, "SIGKILL");
    assert.equal(exited.stopped, "max");
    assert.ok(exited.ms >= 350, `it ran ${exited.ms} ms`);
  } finally {
    killGroup(w.pid);
  }
});

test("cut: a 504 error line HOSTING_CUTOFF_MS after the latest mark is the stack's; one soon after a later mark is an answer; lines are read whole across chunks", async () => {
  const target = fakeTarget();
  const realNow = performance.now;
  let skew = 0;
  performance.now = () => realNow.call(performance) + skew;
  const handles = [];
  try {
    const start = await spawnCli(target, ["serve"], { guard: allow, home: cliHome(target, "cut-start") });
    const marked = await spawnCli(target, ["serve"], { guard: allow, home: cliHome(target, "cut-marked") });
    const other = await spawnCli(target, ["serve"], { guard: allow, home: cliHome(target, "cut-other") });
    const split = await spawnCli(target, ["serve"], { guard: allow, home: cliHome(target, "cut-split") });
    handles.push(start, marked, other, split);
    for (const w of handles) await until(() => w.stdout.includes('"ready"'), 5_000, "the ready line");
    assert.deepEqual(start.marks.map((m) => m.what), ["the start"]);
    assert.equal(start.marks[0].t, start.startedAt);

    skew = HOSTING_CUTOFF_MS + 1_000; // the minute passes for all four
    const save = marked.mark("the save of revision 2");
    assert.deepEqual(marked.marks.at(-1), save);
    assert.ok(save.t - marked.startedAt >= HOSTING_CUTOFF_MS);

    say(start, "err:error: The server returned 504.");
    say(marked, "err:error: The server returned 504.");
    say(other, "err:Published “HTTP 504 explained” at x");
    say(split, "errpart:error: Upload fai");
    await until(() => split.stderrAt.length === 1, 5_000, "the first half of a line");
    say(split, "err:led (504).");
    for (const w of handles) await until(() => w.stderr.endsWith("\n"), 5_000, "each line");
    assert.ok(split.stderrAt.length >= 2, `the split line came in ${split.stderrAt.length} chunk(s)`);

    assert.match(start.cut, /^bikeshed serve saw a 504 6\d{4} ms after the start, Hosting's cut-off for a function that has not answered \(stderr "error: The server returned 504\."\)$/);
    assert.equal(marked.cut, null, "the 504 came soon after the save that caused it");
    assert.equal(other.cut, null, "not an error: line");
    assert.match(split.cut, /^bikeshed serve saw a 504 \d+ ms after the start, .*\(stderr "error: Upload failed \(504\)\."\)$/, "the line, whole");

    let err = null;
    try {
      answered(start, "publish --watch");
    } catch (e) {
      err = e;
    }
    assert.equal(err?.code, "E2E_STACK_CUTOFF");
    assert.equal(stackDidNotAnswer(err), `publish --watch: ${start.cut}`);
    assert.deepEqual(err.cli, { code: null, signal: null, ms: null }, "a running CLI has no exit yet");
    assert.equal(answered(marked), marked);
  } finally {
    performance.now = realNow;
    for (const w of handles) await w.stop().catch(() => undefined);
    for (const w of handles) killGroup(w.pid);
  }
});

async function runHolder(mode) {
  const target = fakeTarget();
  const dir = tempDir("e2e-clispawn-holder-");
  const file = join(dir, "holder.mjs");
  writeFileSync(file, HOLDER);
  const holder = spawn(process.execPath, [file, CLI_LIB, JSON.stringify(target), mode], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  holder.stdout.on("data", (c) => (out += c));
  holder.stderr.on("data", (c) => (err += c));
  const gone = new Promise((r) => holder.on("close", r));
  const line = await until(() => out.split("\n").find((l) => l.includes('"cli"')), 10_000, `the holder's pids (stderr ${err})`).catch((e) => {
    holder.kill("SIGKILL");
    throw e;
  });
  return { holder, gone, ...JSON.parse(line) };
}

test("the CLI's group goes when the process that started it exits", async () => {
  const { holder, gone, cli, child } = await runHolder("exit");
  try {
    await gone;
    assert.notEqual(holder.exitCode, null);
    await until(() => !alive(cli) && !alive(child), 3_000, "the CLI and its grandchild to go");
  } finally {
    killGroup(cli);
    killPid(child);
  }
});

test("the CLI's group goes when the process that started it is SIGKILLed (no exit hook runs): the lifeline", async () => {
  const { holder, gone, cli, child } = await runHolder("hold");
  try {
    assert.ok(alive(cli) && alive(child));
    holder.kill("SIGKILL");
    await gone;
    await until(() => !alive(cli) && !alive(child), 3_000, "the CLI and its grandchild to go");
  } finally {
    killGroup(cli);
    killPid(child);
  }
});

/** A bare Node process under the lifeline: detached, so it leads its own group as spawnCli's CLI does. */
function underLifeline(env) {
  const p = spawn(process.execPath, ["--require", LIFELINE, "-e", "setInterval(() => {}, 1000)"], { env: { PATH: process.env.PATH, ...env }, stdio: "ignore", detached: true });
  const closed = new Promise((r) => p.on("close", (code, signal) => r({ code, signal })));
  return { p, closed };
}
const within = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]);

test("the lifeline: ends its process at the deadline; inert past it in a process another started, and while its parent lives", async () => {
  const late = underLifeline({ E2E_CLI_PARENT_PID: String(process.pid), E2E_CLI_DEADLINE: String(Date.now() + 300) });
  const notOurs = underLifeline({ E2E_CLI_PARENT_PID: String(process.pid + 100_000), E2E_CLI_DEADLINE: String(Date.now() + 300) });
  const living = underLifeline({ E2E_CLI_PARENT_PID: String(process.pid), E2E_CLI_DEADLINE: String(Date.now() + 600_000) });
  try {
    assert.deepEqual(await within(late.closed, 3_000), { code: null, signal: "SIGKILL" }, "past its deadline it ends itself");
    assert.equal(await within(notOurs.closed, 1_000), null, "a process whose parent is not E2E_CLI_PARENT_PID is left alone");
    assert.equal(await within(living.closed, 300), null, "its parent lives and its deadline is far");
  } finally {
    for (const { p } of [late, notOurs, living]) killGroup(p.pid);
  }
});
