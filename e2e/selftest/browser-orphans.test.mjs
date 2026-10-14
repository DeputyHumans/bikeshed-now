// SPDX-License-Identifier: Apache-2.0
// Self-test: every Chrome the harness launches carries a mark naming its run, reap stops one whose run is gone, and a pool closes its browsers whatever happens (SPEC §12).

/**
 * Real Chrome, held by helper processes (helpers/chrome-holder.mjs) that
 * stand for spec processes, under a stand-in for the `run` (a sleeper whose
 * identity goes to them as E2E_RUN_OWNER, as run.mjs's does). Needs Chrome.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BrowserPool } from "../lib/browser.mjs";
import { BROWSER_MARK_SWITCH, RUN_OWNER_ENV, browserMark, markOfCommand, markedBrowsers, parseBrowserMark, reapBrowsers, runOwnerValue } from "../lib/browsers.mjs";
import { isPidAlive, processStartSecs, processTable } from "../lib/proc.mjs";

const HOLDER = fileURLToPath(new URL("./helpers/chrome-holder.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = [];

after(() => {
  for (const p of started) {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
});

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`not within ${ms} ms: ${what}`);
}

/** A stand-in for `node e2e/run.mjs run`: alive until killed. */
async function fakeRun() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  started.push(child);
  await sleep(300);
  return { child, owner: runOwnerValue({ pid: child.pid, startSec: processStartSecs([child.pid]).get(child.pid) }) };
}

/** A holder in `mode` under `run`; resolves {child, pid, mark} once its Chrome is up. */
function holder(mode, run = null) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (run) env[RUN_OWNER_ENV] = run.owner;
    else delete env[RUN_OWNER_ENV];
    const child = spawn(process.execPath, [HOLDER, mode], { env, stdio: ["ignore", "pipe", "pipe"] });
    started.push(child);
    let out = "";
    const t = setTimeout(() => reject(new Error(`holder ${mode} not ready: ${out}`)), 60_000);
    const take = (d) => {
      out += d;
      const m = /ready (\d+) (\S+)/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve({ child, pid: Number(m[1]), mark: m[2] });
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", (d) => (out += d));
  });
}

/** Each Chrome case is bounded, so a browser that will not start cannot hang the self-test run. */
const T = { timeout: 90_000 };
const withMark = (mark) => markedBrowsers().filter((p) => p.mark === mark);
const MARK = "123.1791870000.456.1791870001.0a1b2c3d";

test("a marked Chrome is a Chrome executable holding the switch as a whole word; a command that only names it is not", () => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.equal(markOfCommand(`${chrome} --disable-gpu ${BROWSER_MARK_SWITCH}=${MARK} --remote-debugging-pipe`), MARK);
  assert.equal(markOfCommand(`/x/Chromium.app/Contents/MacOS/Chromium ${BROWSER_MARK_SWITCH}=${MARK}`), MARK);
  assert.equal(markOfCommand(`grep -- ${BROWSER_MARK_SWITCH}=${MARK}`), null, "another session's grep");
  assert.equal(markOfCommand(`pgrep -f ${BROWSER_MARK_SWITCH}=${MARK}`), null);
  assert.equal(markOfCommand(`/usr/bin/tail -f /x/chrome ${BROWSER_MARK_SWITCH}=${MARK}`), null);
  assert.equal(markOfCommand(`${chrome} ${BROWSER_MARK_SWITCH}=${MARK}x`), null, "not a whole word");
  assert.equal(markOfCommand(`${chrome} --type=renderer`), null, "a helper carries no switch");
});

test("every Chrome launched for a spec carries the mark, naming its run and the process that launched it; reap leaves a live run's alone", T, async () => {
  const run = await fakeRun();
  const h = await holder("launch", run);
  const procs = withMark(h.mark);
  assert.ok(procs.some((p) => p.pid === p.pgid && / Google Chrome|chrom/i.test(p.command)), `the Chrome main process, a group leader, carries the mark: ${JSON.stringify(procs.map((p) => p.command.slice(0, 80)))}`);
  const parts = parseBrowserMark(h.mark);
  assert.deepEqual([parts.run.pid, parts.launcher.pid], [run.child.pid, h.pid]);
  assert.ok(procs.every((p) => p.runAlive && p.launcherAlive && !p.orphan));
  await reapBrowsers({ graceMs: 1000, termMs: 1000 });
  assert.ok(withMark(h.mark).length > 0, "reap left a live run's Chrome alone");
  h.child.kill("SIGKILL");
  await until(() => withMark(h.mark).length === 0, 15_000, "Chrome went with its launcher");
});

test("a Chrome whose run is gone is stopped by reap, and only it", T, async () => {
  const run = await fakeRun();
  const live = await fakeRun();
  const orphaned = await holder("launch", run);
  const kept = await holder("launch", live);
  run.child.kill("SIGKILL");
  await until(() => withMark(orphaned.mark).every((p) => p.orphan), 5_000, "its run is gone");
  assert.ok(isPidAlive(orphaned.pid), "the spec process is still there (it is in a group of its own), and so is its Chrome");
  const r = await reapBrowsers({ graceMs: 2000, termMs: 2000 });
  assert.ok(r.stopped.some((s) => s.mark === orphaned.mark && s.gone), JSON.stringify(r));
  assert.equal(withMark(orphaned.mark).length, 0, "nothing carrying the orphan's mark is left");
  assert.ok(withMark(kept.mark).length > 0, "the other run's Chrome was not touched");
  kept.child.kill("SIGKILL");
  live.child.kill("SIGKILL");
  await until(async () => (await reapBrowsers({ graceMs: 1000, termMs: 1000 }), withMark(kept.mark).length === 0), 15_000, "the other Chrome gone with its launcher");
});

test("NEGATIVE: a Chrome launched without the mark cannot be found, so reap cannot stop it even with its run gone", T, async () => {
  const run = await fakeRun();
  const h = await holder("plain", run);
  const chrome = processTable().filter((p) => p.ppid === h.pid);
  assert.ok(chrome.length > 0, "the holder has a Chrome");
  run.child.kill("SIGKILL");
  await reapBrowsers({ graceMs: 1000, termMs: 1000 });
  assert.ok(chrome.some((p) => isPidAlive(p.pid)), "the unmarked Chrome survived reap");
  assert.equal(markedBrowsers().filter((p) => chrome.some((c) => c.pid === p.pid)).length, 0);
  h.child.kill("SIGKILL");
  // This test's own Chrome, by the pids it saw: closed with its launcher, or stopped here.
  try {
    await until(() => chrome.every((p) => !isPidAlive(p.pid)), 10_000, "the unmarked Chrome exits with its launcher");
  } finally {
    for (const p of chrome) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {}
    }
  }
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  test(`${sig} to a spec process closes its pool's Chrome`, T, async () => {
    const run = await fakeRun();
    const h = await holder("pool", run);
    assert.ok(withMark(h.mark).length > 0);
    h.child.kill(sig);
    await until(() => withMark(h.mark).length === 0, 20_000, `Chrome closed after ${sig}`);
    run.child.kill("SIGKILL");
  });
}

test("pool.close() closes every browser even when closing a user throws", T, async () => {
  const target = { kind: "local", runId: "selftest-close", origin: "http://127.0.0.1:9", projectId: "demo-bikeshed", capabilities: new Set(["local"]), stack: { ports: { hosting: 9 } } };
  const pool = new BrowserPool({ target, usersPerBrowser: 1 });
  try {
    const [a] = await pool.many(2);
    a.close = async () => {
      throw new Error("a context that will not close");
    };
    const mine = () => withMark(browserMark()).filter((p) => p.pid === p.pgid);
    assert.equal(mine().length, 2, "two Chrome processes, one per user");
    await pool.close();
    await until(() => mine().length === 0, 15_000, "every browser closed");
  } finally {
    await pool.close(); // a no-op once closed; closes them if an assertion above failed first
  }
});
