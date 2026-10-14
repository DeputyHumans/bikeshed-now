// SPDX-License-Identifier: Apache-2.0
// Self-test helper: every way a Node process might reach out, attempted under the egress guard, with the outcome of each as JSON (SPEC §12).

/**
 *   NODE_OPTIONS="--require=<backstop> --require=<guard>" node egress-child.mjs <unix socket path>
 *
 * Destinations are documentation addresses (RFC 5737) and `.invalid` names
 * (RFC 2606); with the backstop loaded first, none of them is ever really
 * dialled even if the guard is broken. The loopback attempts go to servers
 * this process starts itself. A grandchild, spawned with the inherited
 * environment, proves that the guard is handed down; a worker thread, which
 * does not run --import preloads, proves it is armed in every realm (both
 * preloads are --require, so the backstop is under the worker's guard too).
 */

import { spawn } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Worker } from "node:worker_threads";

const [socketPath] = process.argv.slice(2);
const out = {};
const outcome = (p) => p.then((v) => ({ ok: true, ...(v ?? {}) }), (e) => ({ ok: false, code: e?.cause?.code ?? e?.code ?? null, message: String(e?.message ?? e) }));
const sock = (make) =>
  new Promise((res, rej) => {
    const s = make();
    s.once("connect", () => {
      s.destroy();
      res();
    });
    s.once("error", rej);
  });

out.connectIp = await outcome(sock(() => net.connect(443, "192.0.2.1")));
out.connectName = await outcome(sock(() => net.connect({ host: "egress-connect.invalid", port: 443 })));
let lookupCalled = false;
out.httpsWithLookup = await outcome(
  new Promise((res, rej) => {
    const req = https.request({ protocol: "https:", hostname: "egress-https.invalid", port: 443, path: "/client.json", method: "GET", lookup: (h, o, cb) => { lookupCalled = true; cb(new Error("the custom lookup ran")); } }, () => res());
    req.on("error", rej);
    req.end();
  }),
);
out.httpsWithLookup.lookupCalled = lookupCalled;
out.httpIp = await outcome(new Promise((res, rej) => http.get("http://192.0.2.4/x", () => res()).on("error", rej)));
out.fetch = await outcome(fetch("https://egress-fetch.invalid/x").then((r) => ({ status: r.status })));
out.lookup = await outcome(new Promise((res, rej) => dns.lookup("egress-lookup.invalid", (e) => (e ? rej(e) : res()))));
out.lookupPromise = await outcome(dns.promises.lookup("egress-lookup-p.invalid"));
out.resolve4 = await outcome(new Promise((res, rej) => dns.resolve4("egress-cares.invalid", (e) => (e ? rej(e) : res()))));
out.resolverPromise = await outcome(new dns.promises.Resolver().resolveTxt("egress-cares-p.invalid"));
out.udp = await outcome(
  new Promise((res, rej) => {
    const u = dgram.createSocket("udp4");
    u.send(Buffer.from("x"), 53, "192.0.2.2", (e) => {
      u.close();
      e ? rej(e) : res();
    });
  }),
);

// Loopback and a Unix socket must still work.
const server = net.createServer((s) => s.end());
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
out.loopbackIp = await outcome(sock(() => net.connect(port, "127.0.0.1")));
out.loopbackName = await outcome(sock(() => net.connect({ host: "localhost", port, family: 4 })));
const httpServer = http.createServer((req, res) => res.end("ok"));
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
out.loopbackFetch = await outcome(fetch(`http://127.0.0.1:${httpServer.address().port}/`).then(async (r) => ({ status: r.status, body: await r.text() })));
const unix = net.createServer((s) => s.end());
await new Promise((r) => unix.listen(socketPath, r));
out.unixSocket = await outcome(sock(() => net.connect(socketPath)));
out.lookupLocalhost = await outcome(dns.promises.lookup("localhost").then((a) => ({ address: a.address })));
server.close();
httpServer.close();
unix.close();

// The guard is inherited: a grandchild with this environment is refused too.
out.grandchild = await new Promise((res) => {
  const c = spawn(process.execPath, ["-e", "require('net').connect(80,'192.0.2.3').on('error',(e)=>{process.stdout.write(String(e.code));})"], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });
  let s = "";
  c.stdout.on("data", (d) => (s += d));
  c.on("close", () => res({ code: s, pid: c.pid }));
});
// A worker thread is its own realm: it must arm its own guard, and refuse there too.
const WORKER = `
const { parentPort, threadId } = require("node:worker_threads");
const net = require("node:net");
const dns = require("node:dns");
const outcome = (p) => p.then((v) => ({ ok: true, ...(v ?? {}) }), (e) => ({ ok: false, code: e?.cause?.code ?? e?.code ?? null, message: String(e?.message ?? e) }));
(async () => {
  const r = { threadId, guard: Boolean(globalThis[Symbol.for("bikeshed-e2e.egress-guard")]) };
  r.connect = await outcome(new Promise((res, rej) => {
    const s = net.connect(443, "192.0.2.20");
    s.once("connect", () => { s.destroy(); res(); });
    s.once("error", rej);
  }));
  r.fetch = await outcome(fetch("https://egress-worker-fetch.invalid/x").then((x) => ({ status: x.status })));
  r.lookup = await outcome(dns.promises.lookup("egress-worker-lookup.invalid"));
  parentPort.postMessage(r);
})();
`;
out.worker = await new Promise((res) => {
  const w = new Worker(WORKER, { eval: true });
  w.once("message", (m) => {
    res(m);
    w.terminate();
  });
  w.once("error", (e) => res({ error: String(e?.message ?? e) }));
});
out.pid = process.pid;
process.stdout.write(JSON.stringify(out));
