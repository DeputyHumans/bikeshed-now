// SPDX-License-Identifier: Apache-2.0
// Self-test helper: print a Functions-emulator run's lines as firebase-tools does, through its own RuntimeWorker and the CLI's console logger (SPEC §12).

/**
 *   node fn-runs-writer.mjs <script.json>
 *
 * Its stdout is what `firebase emulators:start` prints about runs: the
 * test sends it to a file, as the stack sends the CLI's to emulators.log.
 * Each run is a firebase-tools RuntimeWorker (lib/emulator/
 * functionsRuntimeWorker.js, the package found from E2E_FIREBASE_BIN or
 * `firebase` on PATH) with a stand-in runtime whose socket is a loopback
 * server here, so `Beginning execution of`, `Finished … in …ms`, `Request to
 * function failed` and the timeout's line are the emulator's own code
 * printing through its own logger (IS_FIREBASE_CLI, useConsoleLoggers, as
 * bin/cli.js sets it up; FORCE_COLOR and DEBUG act as they do there). A
 * function's console line goes through the worker's own log handler.
 *
 * The script is a JSON list of steps, run in order:
 *   {op: "begin", id, trigger, timeoutSeconds?}  a new worker for `trigger`
 *        ("<region>-<name>") is handed the run `id` (RuntimeWorker.request)
 *   {op: "arrived", id}   wait until the run's request reached the socket
 *   {op: "answer", id}    the socket answers it 200
 *   {op: "drop", id}      the socket is destroyed before any answer
 *   {op: "ended", id}     wait until the worker is done with it
 *   {op: "console", id, text}  the run's function logs `text` (USER)
 * Prints `mode real` on stderr first and `done` last. With no firebase-tools
 * installed it prints `no firebase-tools` on stderr and exits 3.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";

const [scriptFile] = process.argv.slice(2);

function firebaseToolsRoot() {
  const onPath = (process.env.PATH ?? "").split(":").map((d) => join(d, "firebase")).find((p) => existsSync(p));
  const bin = process.env.E2E_FIREBASE_BIN || onPath;
  if (!bin) return null;
  let dir = dirname(realpathSync(bin));
  while (dir !== dirname(dir) && !existsSync(join(dir, "lib", "emulator", "functionsRuntimeWorker.js"))) dir = dirname(dir);
  return existsSync(join(dir, "lib", "emulator", "functionsRuntimeWorker.js")) ? dir : null;
}

const root = firebaseToolsRoot();
if (!root) {
  process.stderr.write("no firebase-tools\n");
  process.exit(3);
}
process.env.IS_FIREBASE_CLI = "true";
const req = createRequire(join(root, "lib", "logger.js"));
req(join(root, "lib", "logger.js")).useConsoleLoggers();
const { RuntimeWorker } = req(join(root, "lib", "emulator", "functionsRuntimeWorker.js"));
const { EmulatorLog } = req(join(root, "lib", "emulator", "types.js"));
process.stderr.write("mode real\n");

const sockets = new Map();
const arrivals = new Map();
const server = createServer((rq, rs) => {
  const id = decodeURIComponent(rq.url.split("/").pop());
  sockets.set(id, { rq, rs });
  arrivals.get(id)?.resolve();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const runs = new Map();
function begin({ id, trigger, timeoutSeconds }) {
  const proc = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill() {} });
  const runtime = { process: proc, events: new EventEmitter(), conn: { httpReqOpts: () => ({ host: "127.0.0.1", port }) } };
  const worker = new RuntimeWorker(trigger, runtime, undefined, timeoutSeconds);
  worker.readyForWork();
  let resolve;
  arrivals.set(id, { promise: new Promise((r) => (resolve = r)), resolve: () => resolve() });
  const resp = Object.assign(new Writable({ write: (c, e, cb) => cb() }), { writeHead() {} });
  const done = worker.request({ method: "POST", path: `/run/${encodeURIComponent(id)}`, headers: { "content-type": "application/json" } }, resp, "{}");
  runs.set(id, { runtime, done });
}

const run = (id) => {
  const r = runs.get(id);
  if (!r) throw new Error(`no run ${id}`);
  return r;
};
for (const step of JSON.parse(readFileSync(scriptFile, "utf8"))) {
  if (step.op === "begin") begin(step);
  else if (step.op === "arrived") await arrivals.get(step.id).promise;
  else if (step.op === "answer") sockets.get(step.id).rs.end("{}");
  else if (step.op === "drop") sockets.get(step.id).rq.socket.destroy();
  else if (step.op === "ended") await run(step.id).done;
  else if (step.op === "console") run(step.id).runtime.events.emit("log", new EmulatorLog("USER", "function-log", step.text));
  else throw new Error(`unknown step ${JSON.stringify(step)}`);
}
await new Promise((r) => server.close(r));
process.stderr.write("done\n");
