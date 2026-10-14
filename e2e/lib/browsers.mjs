// SPDX-License-Identifier: Apache-2.0
// Every Chrome the harness launches carries a mark naming its run, so one whose run is gone can be found and stopped (SPEC §12).

/**
 * launchChrome (browser.mjs) starts Chrome with one extra switch, which
 * Chrome ignores:
 *
 *   --e2e-browser-mark=<runPid>.<runStartSec>.<launcherPid>.<launcherStartSec>.<8 hex>
 *
 * where the RUN is the `node e2e/run.mjs run` that started the spec process
 * (run.mjs passes itself to specs as E2E_RUN_OWNER=<pid>.<startSec>), or the
 * launching process itself outside a run (a self-test), and the LAUNCHER is
 * the process that called Playwright. A pid is reused; a pid with its start
 * second is not, so "gone" means the pid is dead or is now somebody else.
 *
 * It is a switch, not an environment variable as a stack's mark is, because
 * macOS does not show Chrome's environment: `ps -E` prints nothing past its
 * argv (measured with Chrome 155, whatever Playwright's `env` held). So a
 * process is a marked Chrome only when its command line starts with a Chrome
 * executable (CHROME_EXE) and holds the switch as a whole word: another
 * session's `grep -- --e2e-browser-mark=…` or `pgrep -f …` names the switch
 * but is not a Chrome, and is never signalled. Playwright starts Chrome as a
 * process-group leader; its helpers (renderers, GPU) are in that group and
 * go with it.
 *
 * Playwright already closes its browsers when the launcher exits, is
 * interrupted (SIGINT: closes, then exits 130) or is terminated (SIGTERM,
 * SIGHUP: closes), and Chrome itself exits within seconds when the launcher
 * is killed outright (its DevTools pipe closes; measured). What none of that
 * covers is a run that is gone while its spec processes are not: `node
 * --test` runs in a process group of its own, so a run killed outright leaves
 * them, and their browsers, behind. reapBrowsers() stops every marked Chrome
 * whose run or launcher is gone: SIGTERM to its group, then SIGKILL, the
 * leader's command line re-read before each signal. `reap`, `run` and
 * `stack up` call it.
 */

import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { groupMembers, identityAlive, processStartSecs, processTable, selfIdentity } from "./proc.mjs";

export const BROWSER_MARK_SWITCH = "--e2e-browser-mark";
export const BROWSER_MARK_RE = /^\d+\.\d+\.\d+\.\d+\.[0-9a-f]{8}$/;
export const RUN_OWNER_ENV = "E2E_RUN_OWNER";
/** The executables a marked Chrome may be: Chrome's channels, Chromium, the headless shell. */
export const CHROME_EXE = /^(Google Chrome(?: for Testing| Beta| Dev| Canary)?|Chromium|chrome|chromium|chrome-headless-shell|headless_shell)$/;

/** `<pid>.<startSec>` for E2E_RUN_OWNER. */
export function runOwnerValue(identity = selfIdentity()) {
  return `${identity.pid}.${identity.startSec}`;
}

function parseIdentity(text) {
  const m = /^(\d+)\.(\d+)$/.exec(String(text ?? ""));
  return m ? { pid: Number(m[1]), startSec: Number(m[2]) } : null;
}

let mine = null;

/** This process's browser mark (one per process: every Chrome it launches carries the same). */
export function browserMark(env = process.env) {
  if (mine) return mine;
  const self = selfIdentity();
  const run = parseIdentity(env[RUN_OWNER_ENV]) ?? self;
  mine = `${run.pid}.${run.startSec}.${self.pid}.${self.startSec}.${randomBytes(4).toString("hex")}`;
  return mine;
}

/** The switches launchChrome adds: the mark. */
export function browserArgs(env = process.env) {
  return [`${BROWSER_MARK_SWITCH}=${browserMark(env)}`];
}

/** A mark's parts: {run: {pid, startSec}, launcher: {pid, startSec}}, or null. */
export function parseBrowserMark(mark) {
  if (!BROWSER_MARK_RE.test(String(mark ?? ""))) return null;
  const [rp, rs, lp, ls] = String(mark).split(".").map(Number);
  return { run: { pid: rp, startSec: rs }, launcher: { pid: lp, startSec: ls } };
}

/**
 * The mark of a process from its command line, or null: only a Chrome
 * executable (the path before its first switch) holding the switch as a
 * whole word counts.
 */
export function markOfCommand(command) {
  const s = String(command ?? "");
  const cut = s.indexOf(" -");
  const exe = cut < 0 ? s : s.slice(0, cut);
  if (!exe.startsWith("/") || !CHROME_EXE.test(basename(exe))) return null;
  const m = new RegExp(`(?:^| )${BROWSER_MARK_SWITCH}=(\\S+)(?= |$)`).exec(s);
  return m && BROWSER_MARK_RE.test(m[1]) ? m[1] : null;
}

/**
 * Every live marked Chrome process (the group leaders; their helpers carry
 * no switch), with whether its run and its launcher are alive:
 * [{pid, ppid, pgid, command, mark, runAlive, launcherAlive, orphan}].
 */
export function markedBrowsers({ table = processTable() } = {}) {
  const found = table.map((p) => ({ ...p, mark: markOfCommand(p.command) })).filter((p) => p.mark);
  if (found.length === 0) return [];
  const parsed = new Map([...new Set(found.map((p) => p.mark))].map((m) => [m, parseBrowserMark(m)]));
  const starts = processStartSecs([...parsed.values()].flatMap((p) => [p.run.pid, p.launcher.pid]));
  const alive = new Map([...parsed].map(([m, p]) => [m, { runAlive: identityAlive(p.run, { starts }), launcherAlive: identityAlive(p.launcher, { starts }) }]));
  return found.map((p) => ({ ...p, ...alive.get(p.mark), orphan: !alive.get(p.mark).runAlive || !alive.get(p.mark).launcherAlive }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const groupAlive = (pgid) => groupMembers(pgid).length > 0;

/**
 * SIGTERM a marked Chrome's group, wait `graceMs`, then SIGKILL — each only
 * while the group's leader still holds `mark` (or, the leader gone, while
 * members of the group it led remain: a group id is not reused while it has
 * members, and nothing else can join it).
 * @returns {{pgid:number, sent:string[], gone:boolean, skipped?:string}}
 */
export async function killBrowserGroup(pgid, mark, { graceMs = 5_000, termMs = 5_000 } = {}) {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal pgid ${pgid}`);
  if (!BROWSER_MARK_RE.test(String(mark))) throw new Error(`not a browser mark: ${JSON.stringify(mark)}`);
  const sent = [];
  for (const [signal, wait] of [["SIGTERM", graceMs], ["SIGKILL", termMs]]) {
    const members = groupMembers(pgid);
    if (members.length === 0) return { pgid, sent, gone: true };
    const leader = members.find((m) => m.pid === pgid);
    if (leader && markOfCommand(leader.command) !== mark) return { pgid, sent, gone: false, skipped: `the leader does not hold the mark: ${leader.command.slice(0, 120)}` };
    if (pgid === process.pid) return { pgid, sent, gone: false, skipped: "this process's own group" };
    try {
      process.kill(-pgid, signal);
      sent.push(signal);
    } catch (err) {
      if (err.code === "ESRCH") return { pgid, sent, gone: true };
      throw err;
    }
    const end = Date.now() + wait;
    while (Date.now() < end && groupAlive(pgid)) await sleep(100);
    if (!groupAlive(pgid)) return { pgid, sent, gone: true };
  }
  return { pgid, sent, gone: !groupAlive(pgid) };
}

/**
 * Stop every marked Chrome whose run or launcher is gone (see the header).
 * @returns {Promise<{stopped:{mark:string, pgid:number, gone:boolean, sent:string[], skipped?:string}[], live:number}>}
 */
export async function reapBrowsers({ log = null, graceMs = 5_000, termMs = 5_000 } = {}) {
  const all = markedBrowsers();
  const orphans = all.filter((p) => p.orphan && p.pid === p.pgid);
  const stopped = [];
  for (const p of orphans) {
    const r = await killBrowserGroup(p.pgid, p.mark, { graceMs, termMs });
    stopped.push({ mark: p.mark, ...r });
    log?.(`stopped an orphaned Chrome, group ${p.pgid} (mark ${p.mark}: ${!p.runAlive ? "its run" : "its launcher"} is gone): ${r.gone ? "gone" : "STILL RUNNING"}${r.sent.length ? ` after ${r.sent.join(" → ")}` : ""}${r.skipped ? ` (${r.skipped})` : ""}`);
  }
  return { stopped, live: all.length - orphans.length };
}
