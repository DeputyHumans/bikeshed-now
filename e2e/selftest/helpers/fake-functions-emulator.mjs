// SPDX-License-Identifier: Apache-2.0
// Self-test helper: a stand-in for the Functions emulator's worker pool behind the Emulator Hub, whose PUT /functions/enableBackgroundTriggers reloads the triggers, logs the reload line and ends its idle workers (SPEC §12).

/**
 *   node fake-functions-emulator.mjs <config.json>
 *
 * config: {logFile, infoFile, mark, workers: [{entryPoint, busyMs}], reloadMs, status}
 *
 * It spawns one worker per entry of `workers` (`node -e … functionsEmulatorRuntime`,
 * env E2E_STACK_MARK=<mark> and FUNCTION_TARGET=<entryPoint>, as
 * firebase-tools' startNode does) and listens on 127.0.0.1:0 as the hub,
 * writing {port, workers: [{pid, entryPoint, busyMs}]} to `infoFile`. A PUT
 * /functions/enableBackgroundTriggers is a reload, as hub.js → reloadTriggers →
 * loadTriggers → RuntimeWorkerPool.refresh: after `reloadMs` (the rediscovery)
 * it appends "✔  functions: Loaded functions definitions from source: …" to
 * `logFile`, ends every worker with busyMs 0 at once (IDLE → killed) and every
 * other one busyMs later (BUSY → FINISHING → killed after its request), then
 * answers `status` (200 {"enabled":true}). Anything else is 404. Every reload
 * is counted in the info file's `reloads`. SIGTERM ends it and its workers.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const children = cfg.workers.map((w) => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, E2E_STACK_MARK: cfg.mark, FUNCTION_TARGET: w.entryPoint };
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", "functionsEmulatorRuntime"], { env, stdio: "ignore" });
  return { child, ...w };
});
let reloads = 0;
const info = (port) => writeFileSync(cfg.infoFile, JSON.stringify({ port, reloads, workers: children.map((c) => ({ pid: c.child.pid, entryPoint: c.entryPoint, busyMs: c.busyMs })) }));

const end = () => {
  for (const c of children) {
    try {
      c.child.kill("SIGKILL");
    } catch {}
  }
  process.exit(0);
};
process.on("SIGTERM", end);
process.on("SIGINT", end);

const server = http.createServer((req, res) => {
  if (req.method !== "PUT" || req.url !== "/functions/enableBackgroundTriggers") {
    res.writeHead(404);
    return res.end("not found");
  }
  setTimeout(() => {
    reloads += 1;
    appendFileSync(cfg.logFile, `✔  functions: Loaded functions definitions from source: ${[...new Set(cfg.workers.map((w) => w.entryPoint))].join(", ")}. (reload ${reloads})\n`);
    for (const c of children) {
      if (c.child.exitCode !== null || c.child.signalCode !== null) continue;
      if (!c.busyMs) c.child.kill("SIGTERM");
      else setTimeout(() => c.child.kill("SIGTERM"), c.busyMs);
    }
    info(server.address().port);
    const status = cfg.status ?? 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 200 ? '{"enabled":true}' : '{"error":"no"}');
  }, cfg.reloadMs ?? 100);
});
server.listen(0, "127.0.0.1", () => info(server.address().port));
