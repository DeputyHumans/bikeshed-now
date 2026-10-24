// SPDX-License-Identifier: Apache-2.0
// Running the tree's `bikeshed` CLI against the target, with an environment built from nothing (SPEC §12, §19).

/**
 * cli/src/config.mjs falls back to the PRODUCTION origin when neither
 * --origin, BIKESHED_ORIGIN nor a config file names one. So the CLI never
 * inherits this process's environment:
 *
 *   BIKESHED_ORIGIN   always target.origin (refused if it would be unset, or if
 *                     argv carries an --origin that names anything else)
 *   BIKESHED_TOKEN    only when a token is given
 *   BIKESHED_AGENT    bikeshed-e2e/<runId>, so the deployment records the run
 *   HOME, XDG_CONFIG_HOME   inside <runDir>/cli/<home>, so no real config.json
 *                     (and no real token) is ever read or written
 *   PATH              stub `open` and `xdg-open` first — they append each URL
 *                     to <home>/opened.log instead of opening a browser — then
 *                     this Node's bin directory and the system directories
 *   NODE_OPTIONS, E2E_EGRESS_LOG   for a LOCAL target, the egress guard
 *                     (lib/egress.mjs): the stack's own copy
 *                     (<tree>/.e2e/egress-guard.mjs, else this harness's) and
 *                     the stack's logs/egress.jsonl (else <home>/egress.jsonl).
 *                     Loopback passes, so the CLI still reaches the stack; a
 *                     command that builds its URL without BIKESHED_ORIGIN — and
 *                     would reach production — is refused and logged instead.
 *                     `extra` cannot clear either
 *
 * Inherited BIKESHED_*, RESEND_*, FIREBASE_*, *_EMULATOR_HOST and credentials
 * are dropped because nothing is inherited at all.
 *
 * The CLI that runs is the stack TREE's (target.stack.treeDir/cli/src), so a
 * baseline tree runs its own CLI. When the tree's cli/src is byte-identical to
 * this checkout's, the checkout's copy runs instead (same bytes, and stack
 * traces point at files a person can open).
 *
 * Two ways to run it:
 *
 *   runCli(target, args, o)    one command, to its exit: {code, stdout, …, cut}
 *   spawnCli(target, args, o)  a command that runs until stopped (`publish
 *                              --watch`, `update --watch`, `changes --wait`,
 *                              a browser `login`): live stdout and stderr, a
 *                              stop(), its own process group
 *
 * Both refuse the same --origin, ask the same guard and build the same
 * environment. Both say when the stack, not the product, failed the command
 * (`cut`, cliCut): the Hosting emulator answers 504 itself for a function
 * that has not answered within its minute, and the CLI reports that 504 like
 * any other ("error: The server returned 504.", "error: Upload failed
 * (504)."). Pass a result through lib/test.mjs answered() to end a case
 * INCONCLUSIVE on it.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, assertPath } from "./paths.mjs";
import { SYSTEM_PATH } from "./proc.mjs";
import { agentName, redactString } from "./http.mjs";
import { rand4 } from "./accounts.mjs";
import { GUARD_IN_TREE, GUARD_SOURCE, egressEnv } from "./egress.mjs";

function dirHash(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(relative(dir, p)).update("\0").update(readFileSync(p)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}

/** Which CLI entry runs: {entry, source: "tree"|"worktree"}. */
export function cliEntry(target) {
  const treeSrc = target.stack?.treeDir ? join(target.stack.treeDir, "cli", "src") : null;
  const ownSrc = join(REPO_ROOT, "cli", "src");
  if (treeSrc && existsSync(join(treeSrc, "index.mjs"))) {
    if (existsSync(join(ownSrc, "index.mjs")) && dirHash(treeSrc) === dirHash(ownSrc)) {
      return { entry: join(ownSrc, "index.mjs"), source: "worktree" };
    }
    return { entry: join(treeSrc, "index.mjs"), source: "tree" };
  }
  if (target.kind === "local") throw new Error(`the stack tree has no cli/src/index.mjs (${treeSrc})`);
  return { entry: join(ownSrc, "index.mjs"), source: "worktree" };
}

const STUB = `#!/bin/sh
# e2e stub: record the URL instead of opening a browser.
printf '%s\\n' "$@" >> "$E2E_OPENED_LOG"
exit 0
`;

/** A CLI home: <runDir>/cli/<name>, with stub openers. */
export function cliHome(target, name = `home-${process.pid}-${rand4()}`) {
  const home = assertPath(join(target.runDir, "cli", name), "cli home");
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".config"), { recursive: true });
  for (const opener of ["open", "xdg-open"]) {
    const p = join(bin, opener);
    if (!existsSync(p)) {
      writeFileSync(p, STUB);
      chmodSync(p, 0o755);
    }
  }
  return { home, bin, config: join(home, ".config"), opened: join(home, "opened.log") };
}

/**
 * The egress guard's variables for a local target's CLI ({} for any other
 * kind): the stack tree's copy of the guard when it has one, else this
 * harness's (the same file a stack copies), logging to the stack's egress log,
 * else to <home>/egress.jsonl.
 */
export function cliGuardEnv(target, home) {
  if (target?.kind !== "local") return {};
  const inTree = target.stack?.treeDir ? join(target.stack.treeDir, GUARD_IN_TREE) : null;
  const file = inTree && existsSync(inTree) ? inTree : GUARD_SOURCE;
  const log = target.stack?.logs?.egress ?? join(home.home, "egress.jsonl");
  return egressEnv({ file, log });
}

/**
 * The CLI's environment, from nothing. Throws if BIKESHED_ORIGIN would be
 * unset or not an http(s) origin. For a local target it arms the egress guard.
 */
export function cliEnv(target, { token, home, agent = agentName(target), extra = {} } = {}) {
  const origin = target?.origin;
  if (typeof origin !== "string" || !/^https?:\/\/[^/]+$/.test(origin)) {
    throw new Error(`cli: refusing to run without BIKESHED_ORIGIN (target.origin is ${JSON.stringify(origin)}); the CLI would fall back to production`);
  }
  const h = home ?? cliHome(target);
  const env = {
    PATH: [h.bin, dirname(process.execPath), ...SYSTEM_PATH].join(":"),
    HOME: h.home,
    XDG_CONFIG_HOME: h.config,
    LANG: process.env.LANG || "en_US.UTF-8",
    TMPDIR: h.home,
    E2E_OPENED_LOG: h.opened,
    BIKESHED_ORIGIN: origin,
    BIKESHED_AGENT: agent,
    ...(token ? { BIKESHED_TOKEN: token } : {}),
    ...cliGuardEnv(target, h),
  };
  for (const [k, v] of Object.entries(extra)) {
    if (k === "BIKESHED_ORIGIN" && v !== origin) throw new Error("cli: BIKESHED_ORIGIN is always the target's");
    if ((k === "NODE_OPTIONS" || k === "E2E_EGRESS_LOG") && k in env && String(v) !== env[k]) throw new Error(`cli: ${k} carries the egress guard and cannot be overridden`);
    env[k] = String(v);
  }
  return env;
}

/** Spawn and capture: {code, signal, stdout, stderr, ms}. Kills the process group on timeout. */
export function spawnCapture(cmd, args, { cwd, env, input, timeoutMs = 120_000 } = {}) {
  assertPath(cwd, "cwd");
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr, ms: Date.now() - started });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// --- When the stack did not answer the CLI ------------------------------------------

/**
 * Hosting's cut-off for a function that has not answered: lib/test.mjs
 * HOSTING_CUTOFF_MS, the same 59,000 ms (cli.test.mjs pins the two together
 * at the boundary; this module does not import the scenario runner).
 */
const HOSTING_CUTOFF_MS = 59_000;

/**
 * A line the CLI prints for a request that got 504. Every failure is one
 * "error: <message>" line (cli/src/index.mjs fail(), watchFile), and a status
 * is worded "The server returned 504." / "the server returned 504" / "HTTP
 * 504" / "Upload failed (504)." / "… failed (504)" (cli/src/client.mjs) or
 * "<origin> answered 504 when asked how to sign in." (cli/src/login.mjs).
 * The emulator's 504 body is plain text, so client.mjs readError() keeps
 * that wording rather than a body's `error`. Only an "error: " line counts:
 * a title or a path the CLI echoes elsewhere never does.
 */
const CLI_504_LINE_RE = /^error: .*(?:\b(?:returned|answered|HTTP) 504\b|\(504\))/;

/** The first line of `text` that is the CLI reporting a 504, or null. */
function line504(text) {
  for (const line of String(text ?? "").split("\n")) if (CLI_504_LINE_RE.test(line)) return line;
  return null;
}

/** "bikeshed <command>" for argv (its first word, when it is not a flag). */
function commandOf(args) {
  const first = args.length > 0 ? String(args[0]) : "";
  return first && !first.startsWith("-") ? `bikeshed ${first}` : "bikeshed";
}

/**
 * Why a finished CLI run measured nothing, or null: it printed a 504 error
 * line (CLI_504_LINE_RE) and ran HOSTING_CUTOFF_MS or more, so one of its
 * requests was cut off by the Hosting emulator. The CLI does not say how long
 * each request took, so this is the run's whole time: a quicker 504 in a long
 * run counts too (the product itself never answers 504). `r` is runCli's
 * result, or anything with `ms` and `stderr`. The reason is redacted.
 */
export function cliCut(r, what = "bikeshed") {
  if (!r || !Number.isFinite(r.ms) || r.ms < HOSTING_CUTOFF_MS) return null;
  const line = line504(r.stderr);
  if (line === null) return null;
  return redactString(`${what} saw a 504 after ${Math.round(r.ms)} ms, Hosting's cut-off for a function that has not answered (stderr ${JSON.stringify(line.slice(0, 160))})`);
}

// --- Running a command ----------------------------------------------------------------

/** What runCli and spawnCli share: the --origin refusal, the guard, the home, the environment and the entry. */
async function prepare(target, args, o, fn) {
  if (!Array.isArray(args)) throw new Error(`${fn}: args must be an array`);
  const origin = target.origin;
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const value = a === "--origin" ? args[i + 1] : a.startsWith("--origin=") ? a.slice(9) : null;
    if (value !== null && String(value).replace(/\/+$/, "") !== origin) {
      throw new Error(`cli: refusing --origin ${value}: the CLI may only talk to ${origin}`);
    }
  }
  const guard = o.guard ?? (await import("./guard.mjs")).createGuard(target);
  const verdict = await guard.checkCli(args);
  if (!verdict.allow) {
    const err = new Error(`guard refused bikeshed ${args.join(" ")}: ${verdict.reason}`);
    err.code = "E2E_GUARD";
    throw err;
  }
  const home = o.home ?? cliHome(target);
  const env = cliEnv(target, { token: o.token, home, extra: o.env });
  const { entry, source } = cliEntry(target);
  return { home, env, entry, source };
}

function openedIn(home) {
  return existsSync(home.opened) ? readFileSync(home.opened, "utf8").split("\n").filter(Boolean) : [];
}

/**
 * Run `bikeshed <args>` against the target.
 *
 * @param {object} target
 * @param {string[]} args
 * @param {object} [o]
 * @param {string} [o.token]      BIKESHED_TOKEN
 * @param {object} [o.home]       a cliHome() to reuse (keeps config.json across calls)
 * @param {string} [o.cwd]        default: the home directory
 * @param {string} [o.input]      stdin
 * @param {object} [o.env]        extra variables (never BIKESHED_ORIGIN or the guard's)
 * @param {boolean} [o.traceCalls] local-only MCP call boundaries (no arguments, headers or bodies) in result.calls
 * @param {number} [o.timeoutMs]  default 120 s; then the process group is killed
 * @param {object} [o.guard]      default createGuard(target); production refuses per guard.checkCli
 * @returns {Promise<{code, signal, stdout, stderr, json, opened: string[], entry, source, home, ms, cut: string|null}>}
 *   `cut` is cliCut(r, "bikeshed <command>"): why the stack, not the product, failed the run, or null
 */
export async function runCli(target, args, o = {}) {
  const { home, env, entry, source } = await prepare(target, args, o, "runCli");
  let traceFile;
  if (o.traceCalls !== undefined && typeof o.traceCalls !== "boolean") throw new TypeError("runCli: traceCalls is a boolean");
  if (o.traceCalls) {
    if (target.kind !== "local") throw new Error("runCli: call traces are local only");
    traceFile = join(home.home, `calls-${rand4()}.jsonl`);
    writeFileSync(traceFile, "");
    env.E2E_CLI_CALL_TRACE = traceFile;
    env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${fileURLToPath(new URL("./cli-call-trace.mjs", import.meta.url))}`].filter(Boolean).join(" ");
  }
  const r = await spawnCapture(process.execPath, [entry, ...args], { cwd: o.cwd ?? home.home, env, input: o.input, timeoutMs: o.timeoutMs });
  let json;
  if (args.includes("--json")) {
    try {
      json = JSON.parse(r.stdout);
    } catch {}
  }
  const calls = traceFile ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { ...r, json, calls, opened: openedIn(home), entry, source, home, cut: cliCut(r, commandOf(args)) };
}

/** The longest a spawned CLI lives by default, whatever its case does. */
const SPAWN_MAX_MS = 300_000;
/** How much later than its maxMs the CLI's own lifeline acts, so the parent's stop is the one that fires while the parent lives. */
const LIFELINE_SLACK_MS = 5_000;
const LIFELINE = fileURLToPath(new URL("./cli-lifeline.mjs", import.meta.url));

/** Process groups of the CLIs spawnCli started and that have not closed: SIGKILLed if this process exits first. */
const liveGroups = new Set();
let exitHooked = false;

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start `bikeshed <args>` and return at once: for a command that runs until
 * stopped (`publish --watch`, `update --watch`, `changes --wait`, a browser
 * `login`). Same --origin refusal, guard, environment and entry as runCli.
 * stdin is closed.
 *
 * The CLI leads its own process group, and stop() signals only that group.
 * It is SIGKILLed after `maxMs` and when this process exits; and because a
 * process killed by a signal runs no exit hook, the CLI also carries a
 * lifeline (cli-lifeline.mjs, preloaded after the egress guard) that ends
 * its group once this process is gone or a little past `maxMs`.
 *
 * Times are this process's performance.now(), as User.capture rows are.
 * `cut` reads every stderr line as it arrived: a 504 error line that came
 * HOSTING_CUTOFF_MS or more after the latest mark at or before it is the
 * stack's cut-off. The spawn is the first mark ("the start"); mark(what) each
 * thing the case does that sets the CLI working (a save it will republish, a
 * change it waits for), so a 504 is timed from its own cause.
 *
 * @param {object} target
 * @param {string[]} args
 * @param {object} [o]   token, home, cwd, env, guard as runCli; and
 * @param {number} [o.maxMs]  default 300,000
 * @returns {Promise<{pid, entry, source, home, startedAt, stdout, stderr, stderrAt: {t, text}[], stderrLines: {t, text}[],
 *   marks: {t, what}[], mark(what): {t, what}, cut: string|null, opened: string[],
 *   exited: null|{code, signal, stdout, stderr, ms, stopped: "stop"|"max"|null}, done: Promise<exited>,
 *   stop({signal = "SIGTERM", graceMs = 5000}): Promise<exited>}>}
 *   stdout, stderr, cut, opened and exited are read live.
 */
export async function spawnCli(target, args, o = {}) {
  const maxMs = o.maxMs ?? SPAWN_MAX_MS;
  if (typeof maxMs !== "number" || !Number.isFinite(maxMs) || maxMs <= 0) throw new TypeError(`spawnCli: maxMs is a positive number of ms, got ${JSON.stringify(maxMs) ?? String(maxMs)}`);
  const { home, env, entry, source } = await prepare(target, args, o, "spawnCli");
  const what = commandOf(args);
  const cwd = assertPath(o.cwd ?? home.home, "cwd");
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require=${LIFELINE}`].filter(Boolean).join(" ");
  env.E2E_CLI_PARENT_PID = String(process.pid);
  env.E2E_CLI_DEADLINE = String(Date.now() + maxMs + LIFELINE_SLACK_MS);

  const startedAt = performance.now();
  const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const pid = child.pid;
  let stdout = "";
  let stderr = "";
  const stderrAt = [];
  const stderrLines = [];
  let partial = "";
  let partialAt = null;
  const marks = [{ t: startedAt, what: "the start" }];
  let exited = null;
  let stopped = null;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => {
    const t = performance.now();
    stderr += c;
    stderrAt.push({ t, text: c });
    const parts = (partial + c).split("\n");
    partial = parts.pop();
    partialAt = partial ? t : null;
    for (const text of parts) stderrLines.push({ t, text });
  });

  if (pid !== undefined) {
    liveGroups.add(pid);
    if (!exitHooked) {
      exitHooked = true;
      process.on("exit", () => {
        for (const g of liveGroups) signalGroup(g, "SIGKILL");
      });
    }
  }
  const cap = setTimeout(() => {
    if (exited) return;
    stopped ??= "max";
    signalGroup(pid, "SIGKILL");
  }, maxMs);
  cap.unref();

  const done = new Promise((resolveDone) => {
    const finish = (code, signal, error) => {
      if (exited) return;
      clearTimeout(cap);
      liveGroups.delete(pid);
      if (partial) stderrLines.push({ t: partialAt ?? performance.now(), text: partial });
      partial = "";
      exited = { code, signal, stdout, stderr, ms: Math.round(performance.now() - startedAt), stopped, ...(error ? { error: String(error?.message ?? error) } : {}) };
      resolveDone(exited);
    };
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (e) => finish(null, null, e));
  });

  let stopping = null;
  return {
    pid,
    entry,
    source,
    home,
    startedAt,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    stderrAt,
    stderrLines,
    marks,
    /** Note that the case just set the CLI working: a 504 after it is timed from here. */
    mark(cause) {
      const m = { t: performance.now(), what: String(cause) };
      marks.push(m);
      return m;
    },
    /** Why the stack, not the product, failed this CLI so far, or null. */
    get cut() {
      const lines = partial ? [...stderrLines, { t: partialAt, text: partial }] : stderrLines;
      for (const line of lines) {
        if (!CLI_504_LINE_RE.test(line.text)) continue;
        let cause = marks[0];
        for (const m of marks) if (m.t <= line.t && m.t >= cause.t) cause = m;
        const ms = line.t - cause.t;
        if (ms >= HOSTING_CUTOFF_MS) {
          return redactString(`${what} saw a 504 ${Math.round(ms)} ms after ${cause.what}, Hosting's cut-off for a function that has not answered (stderr ${JSON.stringify(line.text.slice(0, 160))})`);
        }
      }
      return null;
    },
    get opened() {
      return openedIn(home);
    },
    get exited() {
      return exited;
    },
    done,
    /** Signal the CLI's group (SIGTERM), then SIGKILL it after graceMs; resolves when it has closed. Again: the same promise. */
    stop({ signal = "SIGTERM", graceMs = 5_000 } = {}) {
      if (exited) return done;
      if (stopping) return stopping;
      stopped ??= "stop";
      signalGroup(pid, signal);
      const kill = setTimeout(() => {
        if (!exited) signalGroup(pid, "SIGKILL");
      }, graceMs);
      kill.unref();
      stopping = done.finally(() => clearTimeout(kill));
      return stopping;
    },
  };
}
