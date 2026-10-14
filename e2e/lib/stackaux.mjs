// SPDX-License-Identifier: Apache-2.0
// A stack's aux process: the gate service, the RTDB latency proxy and the Storage shim, on ports of the stack's block, with an HTTP control port (SPEC §4, §12, §16).

/**
 *   node e2e/lib/stackaux.mjs --control <port> [--rtdb-proxy <port> --upstream <port>]
 *                             [--storage-shim <port> --storage-upstream <port>]
 *
 * Started by startStack (lib/stack.mjs) for a stack built with `--gates`
 * (or any amplify-* patch set), `--rtdb-proxy` or `--storage-shim`, never by
 * hand. Detached,
 * in its own process group, carrying the stack's provenance mark, under the
 * egress guard, its output in logs/aux.log. Teardown stops it with the
 * stack; it is one of the stack's essential processes, so a stack whose aux
 * died is failed (stackFailures).
 *
 * The control port (the block role `gate`) serves:
 *   - the gate service (lib/gates.mjs createGateService): what an amplify
 *     set's pause points and client gates call, and what a spec holds and
 *     releases through gates(target);
 *   - GET /latency and POST /latency {up, down}: the RTDB proxy's delay per
 *     direction, in ms, changed at runtime (rtdbLatency(target) in
 *     lib/proxy.mjs); GET /proxy/stats its counters (among them `queued`,
 *     `queuedBytes` and `held`, what rtdbLatency(target).drained() polls);
 *     POST /proxy/drop destroys every connection through it (a reconnect's
 *     lever);
 *   - GET /storage-shim/stats[?since=<seq>]: the Storage shim's counters and
 *     the decisions it kept after that seq (storageShim(target).stats() in
 *     lib/storage-shim.mjs);
 *   - GET /health: {ok, pid, gates, proxy, storageShim}.
 *
 * The RTDB proxy (lib/proxy.mjs startProxy, raw TCP, a FIFO per direction)
 * listens on the block role `rtdbProxy` and forwards to the Database
 * emulator. A stack built with `--rtdb-proxy` bakes that port into the app
 * bundle (EMULATOR_PORTS.database and VITE_FIREBASE_DATABASE_URL, checked by
 * verifyBuild), so every browser's RTDB websocket goes through it, and the
 * proxy rewrites the emulator's address to its own in every control message
 * of every connection (the handshake, and a reset, which the SDK obeys), so a
 * page's reconnects come back through it too (the browser tripwire calls the
 * emulator's own port a breach on such a stack: lib/browser.mjs); the
 * Admin SDK, the functions and rtdbGet/rtdbAs still use the emulator's own
 * port. Delay 0 is the default: a stack with the proxy behaves as one
 * without, until a spec sets a delay.
 *
 * The Storage shim (lib/storage-shim.mjs startStorageShim, HTTP) listens on
 * the block role `storageShim` and forwards to the Storage emulator; the
 * stack's function workers dial it (its preload), and it judges every
 * ifGenerationMatch write and copy under one lock per object, refusing a
 * second create-only one with 412, as Cloud Storage does.
 */

import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createGateService } from "./gates.mjs";
import { startProxy } from "./proxy.mjs";
import { startStorageShim } from "./storage-shim.mjs";

/** The most delay a direction may be given (a minute: more is a stalled stack, not latency). */
export const LATENCY_MAX_MS = 60_000;

const BODY_MAX = 16 * 1024;

function send(res, status, body) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const t = Buffer.concat(chunks).toString("utf8").trim();
        resolve(t ? JSON.parse(t) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** A delay as given to POST /latency: a whole number of ms from 0 to LATENCY_MAX_MS, or undefined (unchanged). */
export function checkDelay(value, what) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > LATENCY_MAX_MS) throw new Error(`${what} is a whole number of ms from 0 to ${LATENCY_MAX_MS}, got ${JSON.stringify(value)}`);
  return value;
}

/**
 * Start the aux services in this process. `proxy` and `storageShim` are
 * each {listenPort, upstreamPort} or null. Resolves {controlPort, proxy,
 * gates, storageShim, close()}.
 */
export async function startAux({ controlPort, host = "127.0.0.1", proxy = null, storageShim = null, log = (o) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`) } = {}) {
  if (!Number.isInteger(controlPort) || controlPort < 0) throw new Error("startAux: controlPort is a port number");
  const gates = createGateService({ log: (e) => log({ kind: "gate", ...e }) });
  // rewriteHost: every control message (the handshake, a reset) names the proxy, so a page's later connections come back through it (lib/proxy.mjs).
  const tcp = proxy ? await startProxy({ upstreamPort: proxy.upstreamPort, listenPort: proxy.listenPort, listenHost: host, up: 0, down: 0, rewriteHost: true }) : null;
  let shim = null;
  try {
    shim = storageShim ? await startStorageShim({ listenPort: storageShim.listenPort, host, upstreamPort: storageShim.upstreamPort, log: (e) => log(e) }) : null;
  } catch (err) {
    await tcp?.close();
    throw err;
  }
  const delay = { up: 0, down: 0 };
  const server = createServer((req, res) => {
    if (gates.handle(req, res)) return;
    const path = (req.url ?? "").split("?")[0];
    if (path === "/health" && req.method === "GET") {
      send(res, 200, { ok: true, pid: process.pid, gates: true, proxy: tcp ? { port: tcp.port, upstream: proxy.upstreamPort, delay: { ...delay } } : null, storageShim: shim ? { port: shim.port, upstream: shim.upstream.port } : null });
      return;
    }
    if (path === "/storage-shim/stats" && req.method === "GET") {
      if (!shim) return send(res, 404, { error: "this stack has no Storage shim (--storage-shim)" });
      const since = new URL(req.url ?? "/", "http://aux.invalid").searchParams.get("since") ?? "0";
      if (!/^\d{1,15}$/.test(since)) return send(res, 400, { error: `since is a decision's seq (a whole number), got ${JSON.stringify(since)}` });
      send(res, 200, { ok: true, port: shim.port, upstream: shim.upstream.port, stats: shim.stats, decisions: shim.decisions({ since: Number(since) }) });
      return;
    }
    if (path === "/latency" && req.method === "GET") {
      if (!tcp) return send(res, 404, { error: "this stack has no RTDB proxy (--rtdb-proxy)" });
      send(res, 200, { ok: true, ...delay });
      return;
    }
    if (path === "/latency" && req.method === "POST") {
      if (!tcp) return send(res, 404, { error: "this stack has no RTDB proxy (--rtdb-proxy)" });
      readJson(req)
        .then((body) => {
          const up = checkDelay(body.up, "up");
          const down = checkDelay(body.down, "down");
          if (up !== undefined) delay.up = up;
          if (down !== undefined) delay.down = down;
          tcp.setDelay({ ...delay });
          log({ kind: "latency", ...delay });
          send(res, 200, { ok: true, ...delay });
        })
        .catch((err) => send(res, 400, { error: err.message }));
      return;
    }
    if (path === "/proxy/drop" && req.method === "POST") {
      if (!tcp) return send(res, 404, { error: "this stack has no RTDB proxy (--rtdb-proxy)" });
      req.resume();
      const dropped = tcp.dropAll();
      log({ kind: "proxy-drop", dropped });
      send(res, 200, { ok: true, dropped });
      return;
    }
    if (path === "/proxy/stats" && req.method === "GET") {
      if (!tcp) return send(res, 404, { error: "this stack has no RTDB proxy (--rtdb-proxy)" });
      send(res, 200, { ok: true, delay: { ...delay }, stats: tcp.stats });
      return;
    }
    send(res, 404, { error: "no such route" });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(controlPort, host, resolve);
    });
  } catch (err) {
    await tcp?.close();
    await shim?.close();
    throw err;
  }
  const bound = server.address().port;
  log({ kind: "ready", control: bound, proxy: tcp ? { port: tcp.port, upstream: proxy.upstreamPort } : null, storageShim: shim ? { port: shim.port, upstream: shim.upstream.port } : null });
  return {
    controlPort: bound,
    proxy: tcp,
    gates,
    storageShim: shim,
    close: async () => {
      gates.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      await tcp?.close();
      await shim?.close();
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      control: { type: "string" },
      "rtdb-proxy": { type: "string" },
      upstream: { type: "string" },
      "storage-shim": { type: "string" },
      "storage-upstream": { type: "string" },
    },
  });
  const port = (v, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--${what} wants a port, got ${JSON.stringify(v)}`);
    return n;
  };
  const controlPort = port(values.control, "control");
  const proxy = values["rtdb-proxy"] ? { listenPort: port(values["rtdb-proxy"], "rtdb-proxy"), upstreamPort: port(values.upstream, "upstream") } : null;
  const storageShim = values["storage-shim"] ? { listenPort: port(values["storage-shim"], "storage-shim"), upstreamPort: port(values["storage-upstream"], "storage-upstream") } : null;
  const aux = await startAux({ controlPort, proxy, storageShim });
  const stop = async (sig) => {
    process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), kind: "stop", signal: sig })}\n`);
    await aux.close().catch(() => undefined);
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => void stop(sig));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`stackaux: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
