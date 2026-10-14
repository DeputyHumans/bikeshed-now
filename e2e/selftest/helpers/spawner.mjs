// SPDX-License-Identifier: Apache-2.0
// Self-test helper: a process that starts one child in its own group, with or without a stack mark (SPEC §12).

/**
 *   node spawner.mjs <pidfile> <child cwd> [<mark>]
 *
 * The child stays in THIS process's group (not detached) and runs with cwd
 * <child cwd>. With <mark> it carries E2E_STACK_MARK=<mark>; without one it
 * carries none, whatever this process has. The child's pid goes to <pidfile>;
 * then both idle until signalled.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidfile, cwd, mark] = process.argv.slice(2);
const env = { ...process.env };
delete env.E2E_STACK_MARK;
if (mark) env.E2E_STACK_MARK = mark;
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, env, stdio: "ignore" });
writeFileSync(pidfile, String(child.pid));
setInterval(() => {}, 1000);
