// SPDX-License-Identifier: Apache-2.0
// Self-test: the latency proxy counts what it still holds (queued chunks each way, bytes its address rewriter holds), and drained() resolves only once all of it is delivered, a reset's leftovers included (SPEC §16).

/**
 * Hermetic: sockets on loopback, no browser, no stack. The case this exists
 * for (run 2610131218-fgf7): a window of client→database delay is set back
 * to 0, but the FIFO still holds what pages sent under it (a chunk is due at
 * max(arrival + delay, the last chunk's due)), so those bytes reach the
 * database up to a window AFTER the reset, where a settle cannot see them.
 * Every test reads what the far side actually received at the moment
 * drained() resolved, never the proxy's own word alone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DRAIN_POLL_MS, DRAIN_WAIT_MS, drainState, hostRewriter, rtdbLatency, startProxy } from "../lib/proxy.mjs";
import { startAux } from "../lib/stackaux.mjs";
import { pageStall } from "../lib/test.mjs";
import { REPO_ROOT } from "../lib/paths.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(5);
  }
  return false;
};

/** An upstream that records every byte each connection sends it, with the time it arrived; `greet(socket)` may write to each new connection. */
async function sink({ greet = null } = {}) {
  const got = [];
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (s) => {
    sockets.add(s);
    s.on("data", (c) => got.push({ at: Date.now(), data: c.toString("latin1") }));
    s.on("error", () => undefined);
    s.on("close", () => sockets.delete(s));
    greet?.(s);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    text: () => got.map((g) => g.data).join(""),
    got,
    sockets,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(r));
    },
  };
}

/** A client of `port` that keeps what it receives; write() sends one chunk (no Nagle). */
async function client(port) {
  const s = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  s.setNoDelay(true);
  let got = Buffer.alloc(0);
  s.on("data", (c) => (got = Buffer.concat([got, c])));
  s.on("error", () => undefined);
  await new Promise((r) => s.once("connect", r));
  return { s, write: (x) => s.write(x), received: () => got, close: () => s.destroy() };
}

test("drainState reads the three counters, and refuses stats without them (an older aux process)", () => {
  const full = { queued: { up: 0, down: 0 }, queuedBytes: { up: 0, down: 0 }, held: 0 };
  assert.deepEqual(drainState(full), { empty: true, queued: { up: 0, down: 0 }, queuedBytes: { up: 0, down: 0 }, held: 0 });
  assert.equal(drainState({ ...full, queued: { up: 1, down: 0 }, queuedBytes: { up: 5, down: 0 } }).empty, false);
  assert.equal(drainState({ ...full, queued: { up: 0, down: 2 }, queuedBytes: { up: 0, down: 9 } }).empty, false, "the down direction counts");
  assert.equal(drainState({ ...full, held: 3 }).empty, false, "bytes the rewriter holds count");
  for (const old of [undefined, null, {}, { connections: 3, rewrites: 0 }, { queued: { up: 0, down: 0 } }, { ...full, held: undefined }, { ...full, queued: { up: -1, down: 0 } }, { ...full, queuedBytes: { up: 0.5, down: 0 } }]) {
    assert.equal(drainState(old), null, JSON.stringify(old));
  }
  assert.equal(DRAIN_WAIT_MS, 65_000);
  assert.equal(DRAIN_POLL_MS, 50);
});

test("up: each chunk is queued from its arrival to its write; after a reset the FIFO still holds the window's bytes, and drained() resolves only once the upstream has every one", async () => {
  const up = await sink();
  const proxy = await startProxy({ upstreamPort: up.port, listenPort: 0, up: 700 });
  const c = await client(proxy.port);
  try {
    const t0 = Date.now();
    for (const x of ["A", "B", "C"]) {
      c.write(x);
      await sleep(30);
    }
    assert.ok(await until(() => proxy.stats.queued.up === 3), `three chunks queued (${JSON.stringify(proxy.stats.queued)})`);
    assert.deepEqual(drainState(proxy.stats), { empty: false, queued: { up: 3, down: 0 }, queuedBytes: { up: 3, down: 0 }, held: 0 });
    proxy.setDelay({ up: 0 }); // the reset
    const resetAt = Date.now();
    c.write("D"); // sent after the reset: it waits behind the window's bytes
    assert.ok(await until(() => proxy.stats.queued.up === 4), `D queued behind them (${JSON.stringify(proxy.stats.queued)})`);
    assert.equal(up.text(), "", "the reset sent nothing early: every byte is still in the proxy, where a settle cannot see it");
    const d = await proxy.drained({ intervalMs: 10 });
    const doneAt = Date.now();
    // drained() means every byte is WRITTEN to the far socket; the far side reads it on its next turn.
    assert.ok(await until(() => up.text() === "ABCD", 50), `every byte, in order, at the upstream within 50 ms of drained() (it has ${JSON.stringify(up.text())})`);
    assert.ok(doneAt >= t0 + 690, `drained() resolved ${doneAt - t0} ms after the first write: not before the first chunk's due time (700 ms)`);
    assert.ok(up.got.every((g) => g.at >= t0 + 690), "the proxy did hold every byte for its delay");
    assert.ok(d.atStart.queued.up === 4 && d.atStart.empty === false, JSON.stringify(d.atStart));
    assert.deepEqual(drainState(d.stats), { empty: true, queued: { up: 0, down: 0 }, queuedBytes: { up: 0, down: 0 }, held: 0 });
    assert.ok(d.polls > 1 && d.ms > 400, `it waited (${d.ms} ms, ${d.polls} polls)`);
    assert.ok(doneAt - resetAt < 1_500, `and resolved soon after they were due (${doneAt - resetAt} ms after the reset)`);
    assert.deepEqual(d.delay, { up: 0, down: 0 });
    d.stats.queued.up = 99;
    assert.equal(proxy.stats.queued.up, 0, "the stats it returns are a copy");
    const again = await proxy.drained();
    assert.equal(again.polls, 1, "an idle proxy is drained at once");
  } finally {
    c.close();
    await proxy.close();
    await up.close();
  }
});

test("down: a queued answer and a frame the address rewriter holds in parts both keep drained() waiting until the client has the whole of it", async () => {
  const HEAD = "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n\r\n";
  const payload = JSON.stringify({ t: "d", d: { r: 1, b: { s: "ok", d: "x".repeat(40) } } });
  const frame = Buffer.concat([Buffer.from([0x81, payload.length]), Buffer.from(payload)]);
  let upstream = null;
  const up = await sink({ greet: (s) => (upstream = s) });
  const proxy = await startProxy({ upstreamPort: up.port, listenPort: 0, down: 300, rewriteHost: true });
  const c = await client(proxy.port);
  try {
    assert.ok(await until(() => upstream !== null));
    // 1. An answer queued down, nothing held: drained() waits for its delay.
    const headAt = Date.now();
    upstream.write(Buffer.from(HEAD, "latin1"));
    assert.ok(await until(() => proxy.stats.queued.down === 1), `the head queued down (${JSON.stringify(drainState(proxy.stats))})`);
    assert.equal(proxy.stats.held, 0);
    assert.equal(c.received().length, 0);
    const h = await proxy.drained({ intervalMs: 10 });
    assert.ok(Date.now() >= headAt + 290, `drained() waited for the head's delay (${Date.now() - headAt} ms)`);
    assert.ok(await until(() => c.received().length === HEAD.length, 50), "the head at the client within 50 ms of drained()");
    assert.equal(h.atStart.queued.down, 1, JSON.stringify(h.atStart));
    // 2. A frame in parts: the rewriter holds it, nothing is queued, and drained() still waits.
    upstream.write(frame.subarray(0, 20));
    assert.ok(await until(() => proxy.stats.held === 20), `20 bytes of the frame held (${JSON.stringify(drainState(proxy.stats))})`);
    let resolved = null;
    const p = proxy.drained({ intervalMs: 10 }).then((d) => (resolved = { at: Date.now(), d }));
    await sleep(150);
    assert.equal(resolved, null, `drained() still waits while the rewriter holds part of a frame (${JSON.stringify(drainState(proxy.stats))})`);
    assert.deepEqual(drainState(proxy.stats), { empty: false, queued: { up: 0, down: 0 }, queuedBytes: { up: 0, down: 0 }, held: 20 });
    const restAt = Date.now();
    upstream.write(frame.subarray(20));
    await p;
    assert.ok(resolved.at >= restAt + 290, `resolved ${resolved.at - restAt} ms after the rest was sent: not before its delay (300 ms)`);
    assert.ok(await until(() => c.received().length === HEAD.length + frame.length, 50), `the whole frame at the client within 50 ms of drained() (it has ${c.received().length} of ${HEAD.length + frame.length} bytes)`);
    assert.deepEqual(resolved.d.atStart, { empty: false, queued: { up: 0, down: 0 }, queuedBytes: { up: 0, down: 0 }, held: 20 });
    assert.equal(proxy.stats.held, 0);
    assert.equal(proxy.stats.upgrades, 1);
  } finally {
    c.close();
    await proxy.close();
    await up.close();
  }
});

test("a delay still set under steady traffic runs out as E2E_PROXY_DRAIN, the harness's own failure and never a wait the stack ran out of; a dropped connection takes its queue off the counters", async () => {
  const up = await sink();
  const proxy = await startProxy({ upstreamPort: up.port, listenPort: 0, up: 2_000 });
  const c = await client(proxy.port);
  const ticker = setInterval(() => c.write("t"), 20);
  try {
    assert.ok(await until(() => proxy.stats.queued.up > 2));
    const err = await proxy.drained({ timeoutMs: 300, intervalMs: 20 }).then(
      () => assert.fail("drained() resolved while chunks were queued"),
      (e) => e,
    );
    assert.equal(err.code, "E2E_PROXY_DRAIN");
    assert.match(err.message, /^the proxy still held bytes \d+ ms after drained\(\) began \(its limit 300 ms\): up \d+ chunk\(s\) of \d+ B, down 0 chunk\(s\) of 0 B, 0 B held by the address rewriter; its delay is up 2000 ms, down 0 ms \(set it back to 0 first/);
    assert.ok(err.state.queued.up > 0 && err.ms >= 300 && err.polls >= 2, JSON.stringify({ state: err.state, ms: err.ms, polls: err.polls }));
    assert.deepEqual(err.delay, { up: 2_000, down: 0 });
    // A page that lost the emulator just now: pageStall would excuse a WAIT that ran out beside it, never this.
    const lost = { name: "p1", log: { console: [{ t: Date.now(), type: "error", text: "@firebase/firestore: Could not reach Cloud Firestore backend. Backend didn't respond within 10 seconds." }], requests: [], sdkProbes: [] } };
    assert.equal(pageStall(err, { usersSoFar: [lost] }), null, "not judged a wait: the proxy is the harness's");
    clearInterval(ticker);
    assert.ok(proxy.stats.queued.up > 0);
    assert.equal(proxy.dropAll(), 1);
    assert.deepEqual(drainState(proxy.stats), { empty: true, queued: { up: 0, down: 0 }, queuedBytes: { up: 0, down: 0 }, held: 0 }, "the dropped connection's queue is gone from the counters");
    const d = await proxy.drained();
    assert.equal(d.polls, 1);
  } finally {
    clearInterval(ticker);
    c.close();
    await proxy.close();
    await up.close();
  }
});

test("through the aux process: rtdbLatency(target).drained() waits out a reset's leftovers from GET /proxy/stats; an older aux is E2E_PROXY; bad options are TypeErrors before anything is read", async () => {
  const up = await sink();
  const aux = await startAux({ controlPort: 0, proxy: { listenPort: 0, upstreamPort: up.port }, log: () => {} });
  const target = (control, proxyPort) => ({
    kind: "local",
    runId: "selftest-drain",
    projectId: "demo-bikeshed",
    databaseURL: `http://127.0.0.1:${up.port}?ns=demo-bikeshed`,
    capabilities: new Set(["rtdb-proxy"]),
    stack: { ports: { gate: control, rtdbProxy: proxyPort } },
  });
  const c = await client(aux.proxy.port);
  try {
    const lat = rtdbLatency(target(aux.controlPort, aux.proxy.port));
    await lat.set({ up: 600, down: 0 });
    for (const x of ["w1", "w2", "w3"]) {
      c.write(x);
      await sleep(25);
    }
    assert.ok(await until(async () => (await lat.stats()).stats.queued.up === 3), "the aux's stats carry the queue");
    await lat.reset();
    assert.equal(up.text(), "", "nothing delivered at the reset");
    const d = await lat.drained({ intervalMs: 20 });
    assert.equal(up.text(), "w1w2w3", "drained() resolved with the window's bytes delivered");
    assert.equal(d.atStart.queued.up, 3);
    assert.deepEqual(d.delay, { up: 0, down: 0 });
    assert.equal(drainState(d.stats).empty, true);

    // Bad options: refused before any request.
    let calls = 0;
    const counting = rtdbLatency(target(aux.controlPort, aux.proxy.port), { fetchImpl: (...a) => ((calls += 1), fetch(...a)) });
    for (const bad of [{ timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: 600_001 }, { intervalMs: 0 }, { intervalMs: 5_001 }, { timeoutMs: "1000" }, "fast"]) {
      await assert.rejects(counting.drained(bad), TypeError, JSON.stringify(bad));
    }
    assert.equal(calls, 0, "nothing was read for a bad option");

    // An aux started before the counters: its stats lack them.
    const old = createServer((req, res) => {
      calls += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, delay: { up: 0, down: 0 }, stats: { connections: 1, open: 0, bytesUp: 0, bytesDown: 0, maxLagMs: { up: 0, down: 0 }, rewrites: 0, errors: 0 } }));
    });
    await new Promise((r) => old.listen(0, "127.0.0.1", r));
    try {
      const before = calls;
      const err = await rtdbLatency(target(old.address().port, aux.proxy.port)).drained().then(() => null, (e) => e);
      assert.ok(err, "an older aux is never taken as drained");
      assert.equal(err.code, "E2E_PROXY");
      assert.match(err.message, /reports no queue counters .* stop the stack and start it again/);
      assert.equal(calls - before, 1, "one read, then the refusal");
    } finally {
      await new Promise((r) => old.close(r));
    }
  } finally {
    c.close();
    await aux.close();
    await up.close();
  }
});

test("hostRewriter's held getter: a frame in parts, a stream tail held a while", async () => {
  const pairs = [{ from: Buffer.from("127.0.0.1:41234"), to: Buffer.from("127.0.0.1:41299") }];
  const out = [];
  const rw = hostRewriter(pairs, (b) => out.push(Buffer.from(b)), { holdMs: 30 });
  assert.equal(rw.held, 0);
  rw.push(Buffer.from("HTTP/1.1 101 Switching Protocols\r\n"));
  assert.ok(rw.held > 0, "a head being read is held");
  rw.push(Buffer.from("\r\n"));
  assert.equal(rw.held, 0);
  const text = Buffer.from(JSON.stringify({ t: "c", d: { t: "r", d: "127.0.0.1:41234" } }));
  const frame = Buffer.concat([Buffer.from([0x81, text.length]), text]);
  rw.push(frame.subarray(0, 10));
  assert.equal(rw.held, 10);
  rw.push(frame.subarray(10));
  assert.equal(rw.held, 0);
  assert.ok(Buffer.concat(out).includes("127.0.0.1:41299"));
  const s = hostRewriter(pairs, (b) => out.push(Buffer.from(b)), { holdMs: 30 });
  s.push(Buffer.from("plain bytes then 127.0.0"));
  assert.equal(s.held, "127.0.0".length, "a tail that may begin the address is held");
  await sleep(60);
  assert.equal(s.held, 0, "and let go after holdMs");
  s.stop();
});

test("README states drained(), drainState and E2E_PROXY_DRAIN", () => {
  const readme = readFileSync(join(REPO_ROOT, "e2e", "README.md"), "utf8");
  for (const s of ["drained({timeoutMs =", "`drainState(stats)`", "`E2E_PROXY_DRAIN`", "**What a window leaves queued.**", "`DRAIN_WAIT_MS`"]) {
    assert.ok(readme.includes(s), `README lacks ${s}`);
  }
});
