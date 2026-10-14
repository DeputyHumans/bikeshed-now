// SPDX-License-Identifier: Apache-2.0
// Preloaded into a CLI that lib/cli.mjs spawnCli() started: it ends that CLI's own process group once the process that started it is gone, or past its deadline (SPEC §12, §19).

/**
 * spawnCli() starts the CLI detached, in a process group of its own, so that
 * stop() can signal it and whatever it started without touching anything
 * else. The price is that nothing else stops it: a spec process killed by a
 * signal (node --test's file timeout, run.mjs's teardown) runs no 'exit'
 * hook, and `publish --watch` never exits by itself. So the CLI carries this
 * lifeline, through NODE_OPTIONS after the egress guard (`--require`, which
 * loads this ES module as it loads lib/egress-guard.mjs: no top-level await):
 *
 *   E2E_CLI_PARENT_PID   the spec process; when the CLI's parent is no
 *                        longer that process (it died, and the CLI was
 *                        reparented), the lifeline ends the group
 *   E2E_CLI_DEADLINE     epoch ms past which it ends the group whatever
 *                        happens (a little after spawnCli's own maxMs, so the
 *                        parent's stop is the one that normally fires)
 *
 * It acts only in the process the spec started: a process whose parent is
 * not E2E_CLI_PARENT_PID at preload (a child of the CLI that inherited
 * NODE_OPTIONS) is left alone, unless its parent is already init, which is
 * an orphan from the start. It signals -process.pid, the group this process
 * leads, which exists only because spawnCli made it the leader; if there is
 * no such group, it ends this process alone. Never another group. It holds
 * the event loop open for nothing (the timer is unref'd), prints nothing,
 * and is inert in a worker thread.
 */

import { isMainThread } from "node:worker_threads";

const parent = Number(process.env.E2E_CLI_PARENT_PID);
const deadline = Number(process.env.E2E_CLI_DEADLINE);

function end() {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    /* not a group leader: this process alone */
  }
  process.kill(process.pid, "SIGKILL");
}

if (isMainThread && Number.isInteger(parent) && parent > 1) {
  if (process.ppid === 1) end();
  else if (process.ppid === parent) {
    const timer = setInterval(() => {
      if (process.ppid !== parent || (Number.isFinite(deadline) && Date.now() >= deadline)) end();
    }, 250);
    timer.unref();
  }
}
