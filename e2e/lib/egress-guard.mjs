// SPDX-License-Identifier: Apache-2.0
// The egress guard a stack preloads into every Node process it starts: loopback only, every refusal one JSONL line (SPEC §12).

/**
 * A stack's functions have deliberate outbound paths — the OAuth client
 * metadata fetch (functions/src/oauth/fetch.ts), the Resend SDK if
 * RESEND_BASE_URL were ever lost, google-auth's token refresh — and nothing in
 * a "local" stack may reach the internet. So every Node process the stack
 * starts (the build steps, the mail shim, `firebase emulators:start` and,
 * through the environment it hands down, every function worker it spawns),
 * and the CLI and operator scripts a spec runs against it, runs with
 *
 *   NODE_OPTIONS=--require=<absolute path of this file>   E2E_EGRESS_LOG=<logs>/egress.jsonl
 *
 * `--require` because Node runs `--import` preloads in the main thread only:
 * a worker thread (vite and rollup use them; so do pino transports and
 * piscina) would otherwise run unguarded. A worker inherits NODE_OPTIONS and
 * runs its `--require` preloads, and `require()` loads this ES module (Node
 * 20.19 / 22.12 and later). Each realm is separate — its own net, dns and
 * globalThis — so each installs its own guard.
 *
 * This file, loaded before anything else, refuses at three layers:
 *
 *   connect   net.Socket.prototype.connect — under every TCP client in Node
 *             (net, tls, http, https, http2, fetch/undici, ws). A destination
 *             that is not loopback is refused BEFORE any name is resolved;
 *             a Unix socket or pipe is allowed.
 *   dns       dns.lookup and dns.promises.lookup for any name but `localhost`
 *             or an IP literal, and every c-ares query (resolve*, reverse) —
 *             a query is itself a packet to a resolver. net resolves through
 *             the public dns.lookup, so this layer stands behind `connect`.
 *   udp       dgram send/connect to a non-loopback address.
 *
 * A refusal is an error with code E2E_EGRESS_REFUSED, delivered the way the
 * real failure would be (asynchronously, on the socket or the callback), so
 * the product handles it as it handles a network failure — and one JSON line
 * is appended to $E2E_EGRESS_LOG:
 *
 *   {"t", "kind": "connect"|"dns"|"udp", "host", "port", "pid", "ppid",
 *    "thread": worker threadId (0 = main), "script": process.argv[1],
 *    "frames": [up to 12 non-internal frames]}
 *
 * Loopback is 127.0.0.0/8, ::1, IPv4-mapped 127/8, the unspecified address
 * (0.0.0.0, ::, which connect to this machine) and the name `localhost`.
 *
 * This file is copied into each stack's tree (<tree>/.e2e/egress-guard.mjs)
 * so a stack keeps the guard it was built with; it imports nothing but Node
 * built-ins. A child process or worker is guarded because it inherits
 * NODE_OPTIONS. NOT guarded: a child that clears its environment (or drops
 * NODE_OPTIONS), a worker started with an `env` that lacks it, and every
 * non-Node binary — the Firestore and Database emulators (Java), Mailpit.
 */

import dgram from "node:dgram";
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { threadId } from "node:worker_threads";

export const REFUSED_CODE = "E2E_EGRESS_REFUSED";
const INSTALLED = Symbol.for("bikeshed-e2e.egress-guard");
const MAX_LINES = 1000;

const loopback = new net.BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("0.0.0.0", "ipv4");
loopback.addAddress("::1", "ipv6");
loopback.addAddress("::", "ipv6");
loopback.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

function bare(host) {
  let h = String(host).trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

/** True for a destination on this machine. An empty host means localhost to net. */
export function isLoopbackHost(host) {
  if (host === undefined || host === null || host === "") return true;
  const h = bare(host);
  if (h === "localhost") return true;
  const family = net.isIP(h);
  if (family === 4) return loopback.check(h, "ipv4");
  if (family === 6) return loopback.check(h, "ipv6");
  return false;
}

let lines = 0;
let suppressed = 0;

function frames() {
  // The caller sits below a dozen internal frames (tls, the agent, the
  // request); the default limit of 10 would cut it off.
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const stack = new Error().stack;
  Error.stackTraceLimit = limit;
  return String(stack)
    .split("\n")
    .slice(1)
    .map((l) => l.trim().replace(/^at /, ""))
    .filter((l) => !l.includes("egress-guard.mjs") && !/\(node:|^node:/.test(l))
    .slice(0, 12);
}

function log(record) {
  const file = process.env.E2E_EGRESS_LOG;
  if (lines >= MAX_LINES) {
    suppressed += 1;
    return;
  }
  lines += 1;
  const line = JSON.stringify({ t: new Date().toISOString(), ...record, pid: process.pid, ppid: process.ppid, thread: threadId, script: process.argv[1] ?? null, frames: frames() });
  try {
    if (file) appendFileSync(file, `${line}\n`);
    else process.stderr.write(`[e2e egress guard] ${line}\n`);
  } catch {
    try {
      process.stderr.write(`[e2e egress guard] ${line}\n`);
    } catch {}
  }
}

function refusal(kind, host, port) {
  log({ kind, host: host === undefined ? null : String(host), port: port === undefined || port === null ? null : Number(port) });
  const where = port === undefined || port === null ? String(host) : `${host}:${port}`;
  const err = new Error(`e2e egress guard: refused ${kind} to ${where} — a local stack reaches loopback only`);
  err.code = REFUSED_CODE;
  err.syscall = kind === "dns" ? "getaddrinfo" : kind === "udp" ? "send" : "connect";
  err.hostname = host;
  if (port !== undefined && port !== null) err.port = Number(port);
  return err;
}

/** {host, port} a Socket#connect call is for, or null for a Unix socket, a pipe or an fd. */
function destination(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0]; // net.connect() hands its normalized [options, cb]
  if (a && typeof a === "object") {
    if (a.path !== undefined && a.path !== null) return null;
    if (a.fd !== undefined && a.fd !== null) return null;
    return { host: a.host ?? "localhost", port: a.port };
  }
  if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) {
    return { host: typeof args[1] === "string" ? args[1] : "localhost", port: Number(a) };
  }
  return null; // a string path
}

function install() {
  // --- connect -------------------------------------------------------------
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const dest = destination(args);
    if (dest && !isLoopbackHost(dest.host)) {
      const err = refusal("connect", dest.host, dest.port);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return connect.apply(this, args);
  };

  // --- dns -----------------------------------------------------------------
  const allowName = (hostname) => isLoopbackHost(hostname) || net.isIP(bare(hostname ?? "")) !== 0;
  const lookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname, options, callback) {
    const cb = typeof options === "function" ? options : callback;
    if (!allowName(hostname)) {
      const err = refusal("dns", hostname);
      if (typeof cb === "function") process.nextTick(() => cb(err));
      return {};
    }
    return lookup.apply(this, arguments);
  };
  const plookup = dns.promises.lookup;
  dns.promises.lookup = function guardedPromisesLookup(hostname, ...rest) {
    if (!allowName(hostname)) return Promise.reject(refusal("dns", hostname));
    return plookup.call(this, hostname, ...rest);
  };
  // c-ares: always a query to a nameserver, never answered from the hosts file.
  const QUERY = /^(resolve|reverse)/;
  const wrapCallback = (holder) => {
    for (const name of Object.getOwnPropertyNames(holder)) {
      if (!QUERY.test(name) || typeof holder[name] !== "function") continue;
      holder[name] = function guardedQuery(...args) {
        const cb = args.findLast?.((a) => typeof a === "function") ?? [...args].reverse().find((a) => typeof a === "function");
        const err = refusal("dns", args[0]);
        if (cb) process.nextTick(() => cb(err));
        return {};
      };
    }
  };
  const wrapPromise = (holder) => {
    for (const name of Object.getOwnPropertyNames(holder)) {
      if (!QUERY.test(name) || typeof holder[name] !== "function") continue;
      holder[name] = function guardedPromiseQuery(host) {
        return Promise.reject(refusal("dns", host));
      };
    }
  };
  wrapCallback(dns);
  wrapCallback(dns.Resolver.prototype);
  wrapPromise(dns.promises);
  wrapPromise(dns.promises.Resolver.prototype);

  // --- udp -----------------------------------------------------------------
  const send = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function guardedSend(msg, ...rest) {
    // send(msg[, offset, length], port[, address][, cb]); a connected socket gives no port.
    const nums = rest.filter((a) => typeof a === "number");
    const port = rest.length >= 3 && typeof rest[0] === "number" && typeof rest[1] === "number" && typeof rest[2] === "number" ? rest[2] : nums[0];
    const address = rest.find((a) => typeof a === "string");
    if (port !== undefined && address !== undefined && !isLoopbackHost(address)) {
      const err = refusal("udp", address, port);
      const cb = rest.find((a) => typeof a === "function");
      process.nextTick(() => (cb ? cb(err) : this.emit("error", err)));
      return;
    }
    return send.call(this, msg, ...rest);
  };
  const uconnect = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function guardedUdpConnect(port, address, cb) {
    if (typeof address === "string" && !isLoopbackHost(address)) {
      const err = refusal("udp", address, port);
      const done = typeof cb === "function" ? cb : null;
      process.nextTick(() => (done ? done(err) : this.emit("error", err)));
      return;
    }
    return uconnect.apply(this, arguments);
  };

  syncBuiltinESMExports();
  process.once("exit", () => {
    if (suppressed > 0) {
      lines = 0;
      log({ kind: "suppressed", host: null, port: null, count: suppressed });
    }
  });
}

if (!globalThis[INSTALLED]) {
  globalThis[INSTALLED] = { refusedCode: REFUSED_CODE, installedAt: Date.now() };
  install();
}
