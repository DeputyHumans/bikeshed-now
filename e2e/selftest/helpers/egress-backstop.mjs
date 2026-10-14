// SPDX-License-Identifier: Apache-2.0
// Self-test helper: a backstop loaded BEFORE the egress guard, so a broken guard still sends no packet — it records instead (SPEC §12).

/**
 * Preloaded first (NODE_OPTIONS="--require=<this> --require=<guard>", so it
 * sits under the guard in worker threads too), it
 * replaces the very functions the guard wraps with ones that never touch the
 * network: a non-loopback connect, a lookup of a real name, any c-ares query
 * and a non-loopback datagram are appended to $E2E_BACKSTOP_LOG and failed
 * with code BACKSTOP. With the guard working, nothing ever reaches this file:
 * the guard refuses first. With the guard broken (a mutation, a negative
 * control), the self-test sees lines here instead of an outbound packet.
 */

import dgram from "node:dgram";
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const local = (h) => h == null || h === "" || /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|0\.0\.0\.0|::)$/i.test(String(h));
const record = (kind, host, port) => {
  appendFileSync(process.env.E2E_BACKSTOP_LOG, `${JSON.stringify({ kind, host, port: port ?? null, pid: process.pid })}\n`);
  return Object.assign(new Error(`backstop: ${kind} to ${host}`), { code: "BACKSTOP" });
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function backstopConnect(...args) {
  let a = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host = null;
  let port = null;
  if (a && typeof a === "object" && a.path == null && a.fd == null) [host, port] = [a.host ?? "localhost", a.port];
  else if (typeof a === "number" || /^\d+$/.test(String(a))) [host, port] = [typeof args[1] === "string" ? args[1] : "localhost", Number(a)];
  if (host !== null && !local(host)) {
    const err = record("connect", host, port);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function backstopLookup(h, o, cb) {
  if (!local(h) && net.isIP(String(h)) === 0) {
    const err = record("dns", h);
    process.nextTick(() => (typeof o === "function" ? o : cb)(err));
    return {};
  }
  return lookup.apply(this, arguments);
};
const plookup = dns.promises.lookup;
dns.promises.lookup = (h, ...rest) => (!local(h) && net.isIP(String(h)) === 0 ? Promise.reject(record("dns", h)) : plookup(h, ...rest));
for (const holder of [dns, dns.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(holder)) {
    if (!/^(resolve|reverse)/.test(name) || typeof holder[name] !== "function") continue;
    holder[name] = function backstopQuery(...args) {
      const err = record("dns", args[0]);
      const cb = [...args].reverse().find((x) => typeof x === "function");
      if (cb) process.nextTick(() => cb(err));
      return {};
    };
  }
}
for (const holder of [dns.promises, dns.promises.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(holder)) {
    if (!/^(resolve|reverse)/.test(name) || typeof holder[name] !== "function") continue;
    holder[name] = (h) => Promise.reject(record("dns", h));
  }
}
const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function backstopSend(msg, ...rest) {
  const address = rest.find((x) => typeof x === "string");
  if (address !== undefined && !local(address)) {
    const err = record("udp", address, rest.find((x) => typeof x === "number"));
    const cb = rest.find((x) => typeof x === "function");
    process.nextTick(() => (cb ? cb(err) : this.emit("error", err)));
    return;
  }
  return send.call(this, msg, ...rest);
};
syncBuiltinESMExports();
