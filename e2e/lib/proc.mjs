// SPDX-License-Identifier: Apache-2.0
// Child processes for the e2e harness: allowlisted env, tool lookup, detached groups, teardown (SPEC §12).

/**
 * Nothing a stack runs inherits this process's environment.
 *
 * A developer shell here can hold GOOGLE_APPLICATION_CREDENTIALS, a real
 * GCLOUD_PROJECT, FIREBASE_* tokens, BIKESHED_* production values or VITE_*
 * from a sourced app/.env.local. Any one of them would bind a "local" stack to
 * a real backend. So every env is BUILT, from an allowlist, and checked again
 * against a denylist of prefixes before it is used.
 *
 * Processes that must outlive this one (a kept stack) start detached, which on
 * POSIX makes each the leader of a new process group; teardown signals the
 * whole group, so Java emulators and function workers go with their parent.
 *
 * OWNERSHIP IS PROVENANCE, NEVER A PATH. Every process a stack starts carries
 * `E2E_STACK_MARK=<runId>.<16 hex>` in its environment, and every child it
 * spawns inherits it (firebase-tools passes `...process.env` to the Java
 * emulators and the function workers). Teardown signals a process only when
 * the kernel's copy of its LAUNCH environment holds that mark — not when its
 * argv names the tree or its cwd is inside it, which is equally true of
 * another session's `grep -r`, a `tail` on a log, an editor helper or a
 * peer spec running an operator script with cwd = tree. The mark is read from
 * the environment part of `ps -E` only (argv is cut off first), so no
 * command line can forge it.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { assertPath } from "./paths.mjs";
import { isPidAlive } from "./ports.mjs";

/** Keys no spawned process may receive from the parent, whatever asks. */
export const DENY_ENV = [/^GOOGLE_APPLICATION_CREDENTIALS$/, /^GCLOUD_PROJECT$/, /^GOOGLE_CLOUD_PROJECT$/, /^CLOUDSDK_/, /^FIREBASE_/, /^BIKESHED_/, /^RESEND_/, /^VITE_/, /_EMULATOR_HOST$/];

const BASE_KEYS = ["PATH", "HOME", "USER", "LANG", "JAVA_HOME", "TMPDIR"];

/**
 * Build an env from nothing.
 * @param {object} o
 * @param {string[]} o.path          directories, in order; joined into PATH
 * @param {string} o.tmpdir          TMPDIR for the child (stacks get their own)
 * @param {string} [o.home]          HOME (stacks get their own, so no gcloud ADC
 *                                   or firebase login under the real one is found)
 * @param {object} [o.set]           explicit additions; these may use denied
 *                                   prefixes, because the caller wrote them
 * @param {string} [o.javaHome]
 */
export function buildEnv({ path, tmpdir, home = homedir(), set = {}, javaHome = process.env.JAVA_HOME } = {}) {
  if (!Array.isArray(path) || path.length === 0) throw new Error("buildEnv: path is required");
  for (const p of path) assertPath(p, "PATH entry");
  const env = {
    PATH: [...new Set(path)].join(delimiter),
    HOME: assertPath(home, "HOME"),
    USER: process.env.USER || "",
    LANG: process.env.LANG || "en_US.UTF-8",
  };
  if (javaHome) env.JAVA_HOME = javaHome;
  if (tmpdir) env.TMPDIR = assertPath(tmpdir, "TMPDIR");
  for (const k of Object.keys(env)) if (!BASE_KEYS.includes(k)) throw new Error(`buildEnv: unexpected key ${k}`);
  for (const k of Object.keys(env)) if (DENY_ENV.some((re) => re.test(k))) throw new Error(`buildEnv: ${k} is denied`);
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined || v === null) throw new Error(`buildEnv: ${k} has no value`);
    env[k] = String(v);
  }
  return env;
}

/** Strip every denied key from an env that is otherwise inherited (spec processes). */
export function scrubEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (DENY_ENV.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}

/** Find an executable on this process's PATH. */
export function which(name, pathVar = process.env.PATH || "") {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

export function requireTool(name, envOverride, env = process.env) {
  const fromEnv = envOverride ? env[envOverride] : undefined;
  const p = fromEnv || which(name, env.PATH ?? "");
  if (!p) throw new Error(`${name} is not on PATH${envOverride ? ` (or set ${envOverride})` : ""}`);
  return assertPath(p, name);
}

function semverKey(name) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The Node 24 bin directory the stack runs under (functions declare nodejs24).
 * E2E_NODE_BIN (a bin dir, or a node binary) wins; then the newest
 * ~/.nvm/versions/node/v24.*; else refuse.
 */
export function resolveNodeBin() {
  const override = process.env.E2E_NODE_BIN;
  if (override) {
    const dir = override.endsWith("/node") ? dirname(override) : override;
    assertPath(dir, "E2E_NODE_BIN");
    if (!existsSync(join(dir, "node"))) throw new Error(`E2E_NODE_BIN: no node in ${dir}`);
    return dir;
  }
  const root = join(homedir(), ".nvm", "versions", "node");
  let best = null;
  try {
    for (const name of readdirSync(root)) {
      const key = semverKey(name);
      if (!key || key[0] !== 24) continue;
      if (!best || key[1] > best.key[1] || (key[1] === best.key[1] && key[2] > best.key[2])) best = { name, key };
    }
  } catch {}
  if (!best) throw new Error("no Node 24 under ~/.nvm/versions/node; install it or set E2E_NODE_BIN");
  return join(root, best.name, "bin");
}

export function nodeVersion(binDir) {
  return execFileSync(join(binDir, "node"), ["--version"], { encoding: "utf8" }).trim();
}

/** System directories every child may need (sh, tar, ps, git). */
export const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * Run to completion, capturing output and appending it to `logFile`.
 * Rejects on a non-zero exit with the tail of the output. An aborted `signal`
 * SIGTERMs the child at once (and the stack's mark sweep catches anything it
 * started).
 */
export function run(cmd, args, { cwd, env, logFile, timeoutMs = 10 * 60_000, input, signal = null } = {}) {
  assertPath(cwd, "cwd");
  return new Promise((resolveRun, rejectRun) => {
    if (signal?.aborted) return rejectRun(signal.reason ?? new Error("aborted"));
    const log = logFile ? createWriteStream(logFile, { flags: "a" }) : null;
    log?.write(`\n$ ${cmd} ${args.join(" ")}\n  (cwd ${cwd})\n`);
    const child = spawn(cmd, args, { cwd, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let out = "";
    const take = (chunk) => {
      const s = chunk.toString();
      out += s;
      if (out.length > 2_000_000) out = out.slice(-1_000_000);
      log?.write(s);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    if (input !== undefined) child.stdin.end(input);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      log?.end();
      rejectRun(err);
    });
    child.on("close", (code, sig) => {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      log?.end();
      if (code === 0) resolveRun({ code, out });
      else {
        const err = new Error(`${cmd} ${args.join(" ")} exited ${code ?? sig}${signal?.aborted ? " (aborted)" : ""}\n${out.slice(-4000)}`);
        err.code = code;
        err.out = out;
        rejectRun(err);
      }
    });
  });
}

/**
 * Start a process that outlives this one, as the leader of its own group,
 * with stdout and stderr appended to `logFile`.
 * @returns {{pid:number, pgid:number, cmd:string, args:string[], logFile:string}}
 */
export function spawnDetached(cmd, args, { cwd, env, logFile }) {
  assertPath(cwd, "cwd");
  assertPath(logFile, "logFile");
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    if (!child.pid) throw new Error(`could not start ${cmd}`);
    child.unref();
    return { pid: child.pid, pgid: child.pid, cmd, args, logFile, startedAt: new Date().toISOString() };
  } finally {
    closeSync(fd);
  }
}

/** The command line of a pid, or null when it is gone. */
export function commandLine(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** The working directory of a pid, or null. */
export function processCwd(pid) {
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const line = out.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

/** Every process: pid, ppid, pgid, command. */
export function processTable() {
  let text;
  try {
    text = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] });
  }
  return out;
}

/** Every live pid in a process group. */
export function groupMembers(pgid) {
  return processTable().filter((p) => p.pgid === pgid).map(({ pid, command }) => ({ pid, command }));
}

/** All descendants of a pid, however they set their group. */
export function descendants(rootPid, table = processTable()) {
  const out = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const p of table) {
      if (p.ppid === parent && !out.some((o) => o.pid === p.pid)) {
        out.push(p);
        queue.push(p.pid);
      }
    }
  }
  return out;
}

/** The environment key that marks a process as a stack's. */
export const STACK_MARK_KEY = "E2E_STACK_MARK";

/** A fresh mark for a stack: its run id and 64 random bits. */
export function newStackMark(runId) {
  if (!/^[a-z0-9][a-z0-9-]{3,39}$/.test(String(runId))) throw new Error(`newStackMark: bad run id ${runId}`);
  return `${runId}.${randomBytes(8).toString("hex")}`;
}

const MARK_RE = /^[a-z0-9][a-z0-9-]{3,39}\.[0-9a-f]{16}$/;

function assertMark(mark) {
  if (typeof mark !== "string" || !MARK_RE.test(mark)) throw new Error(`not a stack mark: ${JSON.stringify(mark)}`);
  return mark;
}

function psRows(args) {
  let text = "";
  try {
    text = execFileSync("ps", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    text = err.stdout?.toString() ?? "";
  }
  const rows = new Map();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+) (.*)$/.exec(line);
    if (m) rows.set(Number(m[1]), m[2]);
  }
  return rows;
}

/**
 * pid → the LAUNCH environment of each process this user may read, as one
 * string of space-separated KEY=VALUE entries (argv excluded). A process whose
 * environment cannot be read (another user's, a platform binary on macOS)
 * maps to "" — and so is never anybody's.
 * @param {number[]} [pids]  only these (default: every process)
 */
export function environments(pids = null) {
  const out = new Map();
  if (process.platform === "linux") {
    const list = pids ?? readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number);
    for (const pid of list) {
      try {
        out.set(pid, readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").filter(Boolean).join(" "));
      } catch {}
    }
    return out;
  }
  const sel = pids ? ["-p", pids.join(",")] : ["-A"];
  if (pids && pids.length === 0) return out;
  // Two snapshots: argv alone, and argv followed by the environment. The env
  // part is what follows the argv prefix; a pid whose two rows disagree (it
  // exec'd, or was replaced, between them) is left out.
  const plain = psRows([...sel, "-ww", "-o", "pid=,command="]);
  const withEnv = psRows([...sel, "-E", "-ww", "-o", "pid=,command="]);
  for (const [pid, both] of withEnv) {
    const argv = plain.get(pid);
    if (argv === undefined || !both.startsWith(argv)) continue;
    out.set(pid, both.slice(argv.length));
  }
  return out;
}

function envHasMark(env, mark) {
  const needle = ` ${STACK_MARK_KEY}=${mark}`;
  const s = ` ${env ?? ""} `;
  return s.includes(`${needle} `);
}

/** The pids (of `pids`, or of every process) whose launch environment carries `mark`. */
export function markedPids(mark, pids = null) {
  assertMark(mark);
  const out = new Set();
  for (const [pid, env] of environments(pids)) if (envHasMark(env, mark)) out.add(pid);
  return out;
}

/** True when this pid's launch environment carries the stack's mark. */
export function hasMark(pid, mark) {
  return markedPids(mark, [pid]).has(pid);
}

/** Every live process carrying the mark: [{pid, ppid, pgid, command}]. */
export function markedProcesses(mark, table = processTable()) {
  const marked = markedPids(mark);
  return table.filter((p) => marked.has(p.pid));
}

/**
 * pid → the value of `key` in each process's launch environment, for every
 * process (or `pids`) that has it. One `environments()` scan, so a caller
 * that checks many marks (stack status, the stack-slot count) reads the
 * process table once.
 * @returns {Map<number, string>}
 */
export function envValues(key, pids = null, envs = null) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(String(key))) throw new Error(`envValues: not an environment key: ${JSON.stringify(key)}`);
  const out = new Map();
  const re = new RegExp(`(?:^| )${key}=(\\S+)(?= |$)`);
  for (const [pid, env] of envs ?? environments(pids)) {
    const m = re.exec(env ?? "");
    if (m) out.set(pid, m[1]);
  }
  return out;
}

/**
 * pid → the second the process started (epoch seconds), from `ps -o lstart`.
 * A pid is reused after its process ends, so an owner is a pid AND its start:
 * the same pid with another start time is somebody else.
 * @param {number[]} pids
 * @returns {Map<number, number>}
 */
export function processStartSecs(pids) {
  const out = new Map();
  const list = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (list.length === 0) return out;
  let text = "";
  try {
    text = execFileSync("ps", ["-o", "pid=,lstart=", "-p", list.join(",")], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    text = err.stdout?.toString() ?? "";
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const ms = Date.parse(m[2]);
    if (Number.isFinite(ms)) out.set(Number(m[1]), Math.floor(ms / 1000));
  }
  return out;
}

/** This process as an owner: {pid, startSec}. */
export function selfIdentity() {
  return { pid: process.pid, startSec: Math.floor((Date.now() - process.uptime() * 1000) / 1000) };
}

/**
 * Whether an identity {pid, startSec} is still that process: the pid is
 * alive and started within `slackSec` of the recorded second (ps reports
 * whole seconds; this process's own figure comes from its uptime).
 */
export function identityAlive(identity, { starts = null, slackSec = 2 } = {}) {
  const pid = identity?.pid;
  if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) return false;
  if (!Number.isFinite(identity.startSec)) return false;
  const started = (starts ?? processStartSecs([pid])).get(pid);
  return Number.isFinite(started) && Math.abs(started - identity.startSec) <= slackSec;
}

/** pid → resident set size in bytes, for every process (or `pids`). */
export function rssBytes(pids = null) {
  const out = new Map();
  let text = "";
  try {
    text = execFileSync("ps", [...(pids ? ["-p", pids.join(",")] : ["-A"]), "-o", "pid=,rss="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    text = err.stdout?.toString() ?? "";
  }
  if (pids && pids.length === 0) return out;
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), Number(m[2]) * 1024);
  }
  return out;
}

/** pid → cwd for every process this user can see, in one lsof call. */
export function cwdTable() {
  const map = new Map();
  let out = "";
  try {
    out = execFileSync("lsof", ["-nP", "-d", "cwd", "-Fpn"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    out = err.stdout?.toString() ?? "";
  }
  let pid = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) map.set(pid, line.slice(1));
  }
  return map;
}

/**
 * Every process (except this one) whose argv names `root` or whose cwd is
 * inside it. NOT a proof of ownership — teardown uses it only to REPORT the
 * processes it found near a tree and left alone because they carry no mark.
 */
export function processesUnder(root) {
  const cwds = cwdTable();
  return processTable().filter((p) => {
    if (p.pid === process.pid) return false;
    if (p.command.includes(root)) return true;
    const cwd = cwds.get(p.pid);
    return !!cwd && (cwd === root || cwd.startsWith(root + "/"));
  });
}

export function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether a whole process group is the stack's, so that signalling -pgid can
 * reach nothing else:
 *   - the leader (pid === pgid) is alive and carries the mark; or
 *   - the leader is gone and a remaining member carries the mark. A pgid is
 *     not reused while members remain, and setpgid cannot move a process into
 *     a group of another session, so every member descends from that leader.
 * @returns {{owned:boolean, reason:string, members:{pid:number, command:string}[]}}
 */
export function groupOwnership(pgid, mark) {
  const members = groupMembers(pgid);
  if (members.length === 0) return { owned: false, reason: "no members", members };
  const marked = markedPids(mark, members.map((m) => m.pid));
  const leader = members.find((m) => m.pid === pgid);
  if (leader) {
    return marked.has(leader.pid)
      ? { owned: true, reason: "leader carries the mark", members }
      : { owned: false, reason: `leader ${pgid} carries no mark (${leader.command.slice(0, 120)})`, members };
  }
  return members.some((m) => marked.has(m.pid))
    ? { owned: true, reason: "leaderless; a member carries the mark", members }
    : { owned: false, reason: "leaderless; no member carries the mark", members };
}

async function waitGone(pgid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!groupAlive(pgid)) return true;
    await sleep(200);
  }
  return !groupAlive(pgid);
}

/**
 * SIGINT the group, wait `graceMs`, then SIGTERM, then SIGKILL — only while
 * groupOwnership() says the group is the stack's (checked before EVERY
 * signal, so a pgid that died and was reused in between is never signalled).
 */
export async function killGroup(pgid, { mark, graceMs = 30_000, termMs = 10_000 } = {}) {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal pgid ${pgid}`);
  assertMark(mark);
  const self = processTable().find((p) => p.pid === process.pid);
  if (pgid === process.pid || pgid === self?.pgid) throw new Error(`refusing to signal this process's own group ${pgid}`);
  const sent = [];
  if (!groupAlive(pgid)) return { pgid, sent, gone: true, skipped: "not running" };
  for (const [signal, wait] of [["SIGINT", graceMs], ["SIGTERM", termMs], ["SIGKILL", 5000]]) {
    const own = groupOwnership(pgid, mark);
    if (!own.owned) {
      if (!groupAlive(pgid)) return { pgid, sent, gone: true };
      return { pgid, sent, gone: false, skipped: `not the stack's: ${own.reason}` };
    }
    try {
      process.kill(-pgid, signal);
      sent.push(signal);
    } catch (err) {
      if (err.code === "ESRCH") return { pgid, sent, gone: true };
      throw err;
    }
    if (await waitGone(pgid, wait)) return { pgid, sent, gone: true };
  }
  return { pgid, sent, gone: !groupAlive(pgid) };
}

/**
 * Signal individual pids (never their group): SIGINT, SIGTERM, SIGKILL, each
 * only to the pids that are still alive AND still carry the mark.
 * @returns {{pid:number, sent:string[], gone:boolean}[]}
 */
export async function killMarkedPids(pids, { mark, graceMs = 10_000, termMs = 5_000 } = {}) {
  assertMark(mark);
  const state = new Map(pids.filter((p) => Number.isInteger(p) && p > 1 && p !== process.pid).map((p) => [p, []]));
  for (const [signal, wait] of [["SIGINT", graceMs], ["SIGTERM", termMs], ["SIGKILL", 3000]]) {
    const alive = [...state.keys()].filter((p) => isPidAlive(p));
    if (alive.length === 0) break;
    const ours = markedPids(mark, alive);
    for (const pid of alive) {
      if (!ours.has(pid)) continue;
      try {
        process.kill(pid, signal);
        state.get(pid).push(signal);
      } catch {}
    }
    const end = Date.now() + wait;
    while (Date.now() < end && [...ours].some((p) => isPidAlive(p))) await sleep(100);
  }
  return [...state].map(([pid, sent]) => ({ pid, sent, gone: !isPidAlive(pid) || !hasMark(pid, mark) }));
}

export { isPidAlive };
