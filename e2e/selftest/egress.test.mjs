// SPDX-License-Identifier: Apache-2.0
// Self-test: the egress guard refuses every non-loopback connect, lookup and datagram, logs each, lets loopback through, and is inherited (SPEC §12).

/**
 * The child runs with a BACKSTOP preloaded before the guard
 * (helpers/egress-backstop.mjs): whatever the guard lets through lands in the
 * backstop's log and fails there, so this test sends no packet even when the
 * guard is broken — and "the backstop saw nothing" is the proof that the guard
 * refused first.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeGuard, egressEnv, installEgressGuard, readEgress, waitForEgress, GUARD_IN_TREE, GUARD_SOURCE } from "../lib/egress.mjs";
import { isLoopbackHost } from "../lib/egress-guard.mjs";

const BACKSTOP = fileURLToPath(new URL("./helpers/egress-backstop.mjs", import.meta.url));
const CHILD = fileURLToPath(new URL("./helpers/egress-child.mjs", import.meta.url));
let dir;
let result;
let egressLines;
let backstopLines;

before(async () => {
  // Short: the Unix socket path must fit in 104 bytes.
  dir = mkdtempSync(join(tmpdir(), "e2e-egress-"));
  const log = join(dir, "egress.jsonl");
  const backstop = join(dir, "backstop.jsonl");
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    E2E_BACKSTOP_LOG: backstop,
    ...egressEnv({ file: GUARD_SOURCE, log }),
  };
  // --require, not --import: a worker thread runs only --require preloads, and
  // the backstop must sit under the guard in every realm the child creates.
  env.NODE_OPTIONS = `--require=${BACKSTOP} ${env.NODE_OPTIONS}`;
  result = await new Promise((resolveRun, rejectRun) => {
    execFile(process.execPath, [CHILD, join(dir, "u.sock")], { env, timeout: 60_000 }, (err, stdout, stderr) => {
      try {
        resolveRun(JSON.parse(stdout));
      } catch {
        rejectRun(new Error(`child failed: ${err?.message}\n${stderr}\n${stdout}`));
      }
    });
  });
  egressLines = readEgress(log);
  backstopLines = existsSync(backstop) ? readFileSync(backstop, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const refused = (name) => {
  assert.equal(result[name].ok, false, `${name} must fail: ${JSON.stringify(result[name])}`);
  assert.equal(result[name].code, "E2E_EGRESS_REFUSED", `${name}: ${JSON.stringify(result[name])}`);
};
const logged = (kind, host, port = null) => egressLines.find((r) => r.kind === kind && r.host === host && (port === null || r.port === port));

test("isLoopbackHost: loopback, the unspecified address and localhost only", () => {
  for (const h of ["127.0.0.1", "127.9.8.7", "::1", "[::1]", "::ffff:127.0.0.1", "0.0.0.0", "::", "localhost", "LOCALHOST", "", undefined]) assert.equal(isLoopbackHost(h), true, String(h));
  for (const h of ["192.0.2.1", "10.0.0.1", "169.254.169.254", "::ffff:192.0.2.1", "2001:db8::1", "example.invalid", "localhost.", "metadata.google.internal"]) assert.equal(isLoopbackHost(h), false, h);
});

test("nothing got past the guard: the backstop behind it saw no attempt at all", () => {
  assert.deepEqual(backstopLines, [], "every outbound attempt was refused by the guard before the backstop");
});

test("a connect to a non-loopback IP or name is refused before any lookup, and logged with host and port", () => {
  refused("connectIp");
  refused("connectName");
  refused("httpIp");
  assert.ok(logged("connect", "192.0.2.1", 443), JSON.stringify(egressLines));
  assert.ok(logged("connect", "egress-connect.invalid", 443), "a name is refused at connect, not left to the resolver");
  assert.ok(logged("connect", "192.0.2.4", 80));
  assert.equal(logged("dns", "egress-connect.invalid"), undefined, "no lookup was attempted for the refused name");
});

test("https.request with its own lookup (the product's metadata fetch shape) and fetch() are refused; the custom lookup never runs", () => {
  refused("httpsWithLookup");
  assert.equal(result.httpsWithLookup.lookupCalled, false);
  const line = logged("connect", "egress-https.invalid", 443);
  assert.ok(line);
  assert.ok(line.frames.some((f) => f.includes("egress-child.mjs")), `the caller's frame is logged: ${JSON.stringify(line.frames)}`);
  assert.equal(line.pid, result.pid);
  assert.match(line.script, /egress-child\.mjs$/);
  refused("fetch");
  assert.ok(logged("connect", "egress-fetch.invalid", 443));
});

test("lookups of real names and every c-ares query are refused; localhost still resolves", () => {
  for (const n of ["lookup", "lookupPromise", "resolve4", "resolverPromise"]) refused(n);
  for (const h of ["egress-lookup.invalid", "egress-lookup-p.invalid", "egress-cares.invalid", "egress-cares-p.invalid"]) assert.ok(logged("dns", h), h);
  assert.equal(result.lookupLocalhost.ok, true, JSON.stringify(result.lookupLocalhost));
});

test("a datagram to a non-loopback address is refused", () => {
  refused("udp");
  assert.ok(logged("udp", "192.0.2.2", 53));
});

test("loopback TCP, loopback fetch and a Unix socket are untouched", () => {
  for (const n of ["loopbackIp", "loopbackName", "unixSocket"]) assert.equal(result[n].ok, true, `${n}: ${JSON.stringify(result[n])}`);
  assert.deepEqual([result.loopbackFetch.ok, result.loopbackFetch.status, result.loopbackFetch.body], [true, 200, "ok"]);
  assert.equal(egressLines.filter((r) => isLoopbackHost(r.host)).length, 0, "no loopback destination was ever logged");
});

test("a grandchild inherits the guard through NODE_OPTIONS and is refused too, under its own pid", () => {
  assert.equal(result.grandchild.code, "E2E_EGRESS_REFUSED");
  const line = logged("connect", "192.0.2.3", 80);
  assert.ok(line);
  assert.notEqual(line.pid, result.pid);
  assert.equal(line.ppid, result.pid);
});

test("a worker thread arms its own guard: its connect, fetch and lookup are refused and logged under its thread id", () => {
  const w = result.worker;
  assert.equal(w.error, undefined, `the worker ran: ${JSON.stringify(w)}`);
  assert.ok(w.threadId > 0, "it really ran in a worker");
  assert.equal(w.guard, true, "the guard is installed in the worker's own realm");
  for (const n of ["connect", "fetch", "lookup"]) {
    assert.equal(w[n].ok, false, `worker ${n} must fail: ${JSON.stringify(w[n])}`);
    assert.equal(w[n].code, "E2E_EGRESS_REFUSED", `worker ${n}: ${JSON.stringify(w[n])}`);
  }
  const connect = logged("connect", "192.0.2.20", 443);
  assert.ok(connect, JSON.stringify(egressLines));
  assert.equal(connect.pid, result.pid, "same process");
  assert.equal(connect.thread, w.threadId, "logged from the worker's thread");
  assert.ok(logged("connect", "egress-worker-fetch.invalid", 443), "the worker's fetch is refused at connect");
  assert.ok(logged("dns", "egress-worker-lookup.invalid"));
  assert.equal(logged("connect", "192.0.2.1", 443).thread, 0, "the main thread logs thread 0");
});

test("installEgressGuard copies the guard into a tree; egressEnv arms it; waitForEgress finds a line or times out with what it saw", async () => {
  const tree = mkdtempSync(join(tmpdir(), "e2e-egress-tree-"));
  try {
    const g = installEgressGuard(tree);
    assert.equal(g.file, join(tree, GUARD_IN_TREE));
    assert.equal(g.sha256, describeGuard(GUARD_SOURCE).sha256);
    const env = egressEnv({ file: g.file, log: join(tree, "egress.jsonl") });
    assert.equal(env.NODE_OPTIONS, `--require=${g.file}`, "--require: a worker thread runs no --import preload");
    assert.throws(() => egressEnv({ file: "relative.mjs", log: "/x" }));
    assert.throws(() => egressEnv({ file: join(tree, "a b", "egress-guard.mjs"), log: "/x" }), /NODE_OPTIONS/);
    const log = join(tree, "egress.jsonl");
    const t = { runId: "selftest", stack: { logs: { egress: log } } };
    writeFileSync(log, `${JSON.stringify({ kind: "connect", host: "a.invalid", port: 443 })}\n`);
    const since = readFileSync(log).length;
    await assert.rejects(waitForEgress(t, (r) => r.host === "a.invalid", { since, timeout: 300 }), (e) => e.code === "E2E_EGRESS_TIMEOUT");
    setTimeout(() => writeFileSync(log, `${JSON.stringify({ kind: "connect", host: "b.invalid", port: 443 })}\n`, { flag: "a" }), 150);
    assert.equal((await waitForEgress(t, (r) => r.host === "b.invalid", { since, timeout: 3000 })).port, 443);
    assert.throws(() => readEgress({ runId: "old", stack: { logs: {} } }), (e) => e.code === "E2E_CAPABILITY");
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});
