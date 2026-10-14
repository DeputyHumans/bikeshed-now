// SPDX-License-Identifier: Apache-2.0
// Self-test: a rewriteHost proxy names itself in EVERY control message of every connection (a reset after the handshake included), leaves data as the server sent it, and passes every other byte unchanged however the stream is cut (SPEC §16).

/**
 * Hermetic: a stand-in Database server answers a WebSocket upgrade with 101
 * and then a scripted list of server frames, cut into chunks as the test
 * says, as the emulator's would be, naming its OWN address, 127.0.0.1:<its
 * port>, in a handshake and in a reset. The shape is the one measured on
 * 2026-10-13 (run 2610131148-8csa): a namespace failure resets every live
 * client AFTER its handshake, and the web SDK obeys a reset's host. A client
 * through the proxy reads the raw bytes back, so the test sees exactly what a
 * browser would. No browser, no stack.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { CONTROL_FRAME_MAX_BYTES, REWRITE_HOLD_MS, REWRITE_WINDOW_BYTES, hostRewriter, rtdbLatency, startProxy } from "../lib/proxy.mjs";
import { startAux } from "../lib/stackaux.mjs";
import { REPO_ROOT } from "../lib/paths.mjs";

const HEAD_101 = "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\nsec-websocket-accept: e2e\r\n\r\n";

/** One server→client frame (unmasked unless `mask`), with a 7-, 16- or 64-bit length as its size needs (or `wide` forces 64). */
function wsFrame(payload, { opcode = 1, fin = true, rsv1 = false, mask = false, wide = false } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  let head;
  if (body.length < 126 && !wide) head = Buffer.from([0, body.length]);
  else if (body.length < 65536 && !wide) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(body.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(body.length), 2);
  }
  head[0] = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode;
  if (!mask) return Buffer.concat([head, body]);
  head[1] |= 0x80;
  const key = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([head, key, Buffer.from(body.map((b, i) => b ^ key[i % 4]))]);
}

/** Split `buf` into frames after the 101 head: [{opcode, fin, rsv1, masked, payload}] (masked payloads left masked). */
function parseFrames(buf) {
  const at = buf.indexOf("\r\n\r\n");
  let rest = buf.subarray(at + 4);
  const frames = [];
  while (rest.length) {
    let len = rest[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      len = rest.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      len = Number(rest.readBigUInt64BE(2));
      off = 10;
    }
    const masked = (rest[1] & 0x80) !== 0;
    if (masked) off += 4;
    frames.push({ opcode: rest[0] & 0x0f, fin: (rest[0] & 0x80) !== 0, rsv1: (rest[0] & 0x40) !== 0, masked, payload: rest.subarray(off, off + len) });
    rest = rest.subarray(off + len);
  }
  return frames;
}

const addr = (port) => `127.0.0.1:${port}`;
const handshake = (port) => JSON.stringify({ t: "c", d: { t: "h", d: { ts: 1_791_917_586_000, v: "5", h: addr(port), s: "e2e-session-1" } } });
const reset = (port) => JSON.stringify({ t: "c", d: { t: "r", d: addr(port) } });
const dataMsg = (r, d) => JSON.stringify({ t: "d", d: { r, b: { s: "ok", d } } });

/**
 * A stand-in Database server: after the client's request head it writes
 * `script(port)` (a Buffer: whatever the answer is), cut at `cuts` (offsets,
 * ascending) with `gapMs` between chunks, then ends. Every connection gets
 * the same answer.
 */
async function fakeServer(script, { cuts = [], gapMs = 0 } = {}) {
  const server = net.createServer((sock) => {
    let head = "";
    sock.on("error", () => undefined);
    sock.on("data", async (c) => {
      if (head.includes("\r\n\r\n")) return;
      head += c.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      const all = script(server.address().port);
      const at = [0, ...cuts.filter((x) => x > 0 && x < all.length), all.length];
      for (let i = 0; i + 1 < at.length; i += 1) {
        if (sock.destroyed) return;
        sock.write(all.subarray(at[i], at[i + 1]));
        if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        else await new Promise((r) => setImmediate(r));
      }
      sock.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    }),
  };
}

/** Send a request head to `port` and read every byte back until the far side ends. */
function readAll(port, request = `GET /.ws?v=5&ns=demo-bikeshed HTTP/1.1\r\nHost: ${addr(port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ZTJlZTJlZTJlZTJlZTJlZQ==\r\n\r\n`) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const s = net.connect(port, "127.0.0.1", () => s.write(request));
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`no end within 10 s: ${Buffer.concat(chunks).length} bytes`));
    }, 10_000);
    s.on("data", (c) => chunks.push(c));
    s.on("end", () => {
      clearTimeout(timer);
      s.destroy();
      resolve(Buffer.concat(chunks));
    });
    s.on("error", reject);
  });
}

/** A proxy with rewriteHost in front of `up`, closed by `fn`'s end. */
async function withProxy(up, fn) {
  const proxy = await startProxy({ upstreamPort: up.port, listenPort: 0, rewriteHost: true });
  try {
    return await fn(proxy);
  } finally {
    await proxy.close();
    await up.close();
  }
}

/** A JSON text frame's message. */
const msg = (f) => JSON.parse(f.payload.toString("utf8"));

test("a handshake, data and then a RESET on one connection (a namespace failure): both control messages name the proxy, the data is as the server sent it", { timeout: 20_000 }, async () => {
  const up = await fakeServer((port) => Buffer.concat([
    Buffer.from(HEAD_101, "latin1"),
    wsFrame(handshake(port)),
    wsFrame(dataMsg(1, {})),
    wsFrame(dataMsg(2, { note: addr(port) })), // a value that happens to hold the address: data, never touched
    wsFrame(reset(port)),
  ]));
  await withProxy(up, async (proxy) => {
    const direct = parseFrames(await readAll(up.port));
    assert.equal(msg(direct[3]).d.d, addr(up.port), "the stand-in resets to its OWN address, as the emulator does");
    const via = parseFrames(await readAll(proxy.port));
    assert.equal(via.length, 4);
    assert.equal(msg(via[0]).d.d.h, addr(proxy.port), "the handshake names the proxy");
    assert.equal(msg(via[3]).d.d, addr(proxy.port), "NEGATIVE CONTROL: the reset AFTER the handshake names the proxy too (it went through as the emulator's own address until 2026-10-13)");
    assert.deepEqual(msg(via[0]).d.d.s, "e2e-session-1", "nothing else in the handshake changed");
    assert.ok(via[1].payload.equals(direct[1].payload), "a data message is byte for byte the server's");
    assert.equal(msg(via[2]).d.b.d.note, addr(up.port), "an address INSIDE data is left as the server sent it");
    const st = proxy.stats;
    assert.equal(st.rewrites, 2, JSON.stringify(st));
    assert.deepEqual(st.rewriteKinds, { handshake: 1, reset: 1, control: 0, stream: 0 });
    assert.equal(st.hostsInData, 1, "the data occurrence is counted, not rewritten");
    assert.equal(st.upgrades, 1);
    assert.equal(st.compressedFrames, 0);
  });
});

test("a reset long after the first REWRITE_WINDOW_BYTES of the connection still names the proxy", { timeout: 20_000 }, async () => {
  const filler = Array.from({ length: 12 }, (_, i) => wsFrame(dataMsg(10 + i, { pad: "x".repeat(1000) })));
  const up = await fakeServer((port) => Buffer.concat([Buffer.from(HEAD_101, "latin1"), wsFrame(handshake(port)), ...filler, wsFrame(reset(port))]));
  await withProxy(up, async (proxy) => {
    const raw = await readAll(proxy.port);
    assert.ok(raw.length > 3 * REWRITE_WINDOW_BYTES, `the reset came after ${raw.length} bytes`);
    const via = parseFrames(raw);
    assert.equal(msg(via.at(-1)).d.d, addr(proxy.port));
    assert.deepEqual(proxy.stats.rewriteKinds, { handshake: 1, reset: 1, control: 0, stream: 0 });
  });
});

/** A deterministic PRNG (mulberry32), so a failing cut can be replayed. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every frame shape the parser must step over, in one answer, each naming
 * the address where it can: [frame bytes, rewritten?]. Only the whole,
 * unfragmented, uncompressed, unmasked control messages are rewritten.
 */
function mixedScript(port, proxyPort) {
  const a = addr(port);
  const swap = (s) => s.split(a).join(addr(proxyPort));
  const big = dataMsg(30, { blob: "y".repeat(CONTROL_FRAME_MAX_BYTES), host: a }); // over the read limit: passes unread
  const parts = [
    [handshake(port), {}, true],
    [dataMsg(20, { host: a }), {}, false],
    [JSON.stringify({ t: "c", d: { t: "s", d: `shutting down ${a}` } }), {}, true], // another control message
    [big, {}, false],
    [dataMsg(31, { small: true }), { wide: true }, false], // a 64-bit length for a short frame
    ["ping", { opcode: 9 }, false],
    [`{"t":"c","d":{"t":"r","d":"${a}"`, { fin: false }, false], // a fragmented message: never read as a whole
    ["}}", { opcode: 0 }, false],
    [reset(port), { rsv1: true }, false], // compressed (as deflate would mark it): unread
    [reset(port), { mask: true }, false], // masked (no server should): unread
    ["not json " + a, {}, false],
    [reset(port), {}, true],
  ];
  const sent = Buffer.concat([Buffer.from(HEAD_101, "latin1"), ...parts.map(([p, o]) => wsFrame(p, o))]);
  const expected = Buffer.concat([Buffer.from(HEAD_101, "latin1"), ...parts.map(([p, o, rw]) => wsFrame(rw ? swap(p) : p, o))]);
  return { sent, expected };
}

/** Ports here are ephemeral (49152–65535 on macOS, 32768–60999 on Linux): five digits, so an answer's length does not depend on which. */
const SAMPLE_PORT = 54321;

/** The pairs startProxy gives hostRewriter, from `up` to `proxy`. */
const pairsFor = (up, proxy) => ["127.0.0.1", "localhost"].map((h) => ({ from: Buffer.from(`${h}:${up}`, "latin1"), to: Buffer.from(`${h}:${proxy}`, "latin1") }));

/** Cut offsets into `length` bytes: "whole", "bytes" (every byte its own chunk), or a seed for random cuts 1–40 bytes apart. */
function cutsFor(plan, length) {
  const cuts = [];
  if (plan === "bytes") for (let i = 1; i < length; i += 1) cuts.push(i);
  else if (typeof plan === "number") {
    const rnd = prng(plan);
    for (let at = 1 + Math.floor(rnd() * 40); at < length; at += 1 + Math.floor(rnd() * 40)) cuts.push(at);
  }
  return cuts;
}

/** Push `buf` through a fresh hostRewriter in the chunks `cuts` gives; resolves what came out SYNCHRONOUSLY after the last push, and the counts. */
function filterInChunks(buf, cuts, pairs) {
  const out = [];
  const counts = {};
  const rw = hostRewriter(pairs, (b) => out.push(Buffer.from(b)), { count: (what, n) => (counts[what] = (counts[what] ?? 0) + n) });
  const at = [0, ...cuts, buf.length];
  for (let i = 0; i + 1 < at.length; i += 1) rw.push(buf.subarray(at[i], at[i + 1]));
  const now = Buffer.concat(out);
  rw.stop();
  return { now, counts };
}

test("the frame reader, cut anywhere (every byte its own chunk, 20 random cuttings): the same bytes, exactly the control messages rewritten, and nothing held once a frame is whole", () => {
  const { sent, expected } = mixedScript(SAMPLE_PORT, SAMPLE_PORT + 1);
  const pairs = pairsFor(SAMPLE_PORT, SAMPLE_PORT + 1);
  for (const plan of ["whole", "bytes", ...Array.from({ length: 20 }, (_, i) => i + 1)]) {
    const { now, counts } = filterInChunks(sent, cutsFor(plan, sent.length), pairs);
    assert.ok(now.equals(expected), `plan ${plan}: ${now.length} of ${expected.length} bytes out at once; first difference at ${[...now].findIndex((x, i) => x !== expected[i])}`);
    assert.deepEqual(counts, { upgrade: 1, handshake: 1, data: 2, control: 1, compressed: 1, reset: 1 }, `plan ${plan}`);
  }
});

test("a 101 head and frames that share a chunk, a head in pieces, and a frame header in pieces are all read", () => {
  const pairs = pairsFor(SAMPLE_PORT, SAMPLE_PORT + 1);
  const big = wsFrame(dataMsg(1, { pad: "z".repeat(70_000) }), {}); // a 64-bit length
  const sent = Buffer.concat([Buffer.from(HEAD_101, "latin1"), big, wsFrame(reset(SAMPLE_PORT))]);
  const want = Buffer.concat([Buffer.from(HEAD_101, "latin1"), big, wsFrame(reset(SAMPLE_PORT + 1))]);
  const h = HEAD_101.length;
  for (const cuts of [[], [3], [h - 2, h + 1, h + 5], [h + 9, h + 10 + 30_000], [want.length - 3]]) {
    const { now, counts } = filterInChunks(sent, cuts, pairs);
    assert.ok(now.equals(want), `cuts ${JSON.stringify(cuts)}: ${now.length} of ${want.length}`);
    assert.deepEqual(counts, { upgrade: 1, reset: 1 }, `cuts ${JSON.stringify(cuts)}`);
  }
});

test("a byte stream (no 101) holds only a tail that may begin the address, and lets it go within REWRITE_HOLD_MS or at the end", async () => {
  const pairs = pairsFor(SAMPLE_PORT, SAMPLE_PORT + 1);
  const out = [];
  const rw = hostRewriter(pairs, (b) => out.push(Buffer.from(b)), { count: () => {} });
  rw.push(Buffer.from("HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\nhello 127.0", "latin1"));
  assert.ok(Buffer.concat(out).toString("latin1").endsWith("hello "), "the tail that may begin the address waits");
  await new Promise((r) => setTimeout(r, REWRITE_HOLD_MS + 40));
  assert.ok(Buffer.concat(out).toString("latin1").endsWith("hello 127.0"), "and goes on by itself within REWRITE_HOLD_MS");
  const rw2 = hostRewriter(pairs, (b) => out.push(Buffer.from(b)), { count: () => {} });
  out.length = 0;
  rw2.push(Buffer.from("HTT", "latin1"));
  assert.equal(out.length, 0, "three bytes that may begin an HTTP answer wait");
  rw2.flush();
  assert.equal(Buffer.concat(out).toString("latin1"), "HTT", "and flush (the source ended) lets them go");
  rw2.stop();
});


test("through a real proxy, the mixed answer cut at random with gaps: the same bytes, the same counts", { timeout: 60_000 }, async () => {
  const length = mixedScript(SAMPLE_PORT, SAMPLE_PORT).sent.length;
  for (const seed of [7, 8]) {
    let proxyPort = SAMPLE_PORT;
    const up = await fakeServer((port) => mixedScript(port, proxyPort).sent, { cuts: cutsFor(seed, length).filter((_, i) => i % 4 === 0), gapMs: 1 });
    await withProxy(up, async (proxy) => {
      proxyPort = proxy.port;
      const { expected } = mixedScript(up.port, proxy.port);
      const got = await readAll(proxy.port);
      assert.ok(got.equals(expected), `seed ${seed}: first difference at ${[...got].findIndex((x, i) => x !== expected[i])} (${got.length} vs ${expected.length})`);
      assert.deepEqual(proxy.stats.rewriteKinds, { handshake: 1, reset: 1, control: 1, stream: 0 });
      assert.deepEqual([proxy.stats.hostsInData, proxy.stats.compressedFrames, proxy.stats.upgrades], [2, 1, 1]);
    });
  }
});

test("an answer that is not a 101 (long polling, keep-alive): every occurrence in every answer is rewritten, also cut inside the address", { timeout: 20_000 }, async () => {
  const lp = (seq, m) => {
    const body = `pRTLPCB(${seq},[${m}]);`;
    return `HTTP/1.1 200 OK\r\ncontent-type: application/javascript\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  };
  const answer = (port) => Buffer.from(lp(0, handshake(port)) + lp(1, reset(port)), "latin1");
  const cutAt = answer(SAMPLE_PORT).lastIndexOf(Buffer.from(addr(SAMPLE_PORT))) + 5; // inside the second address
  const up = await fakeServer(answer, { cuts: [cutAt], gapMs: 5 });
  await withProxy(up, async (proxy) => {
    const got = (await readAll(proxy.port, "GET /.lp?start=t&ser=1&cb=1&v=5&ns=demo-bikeshed HTTP/1.1\r\nHost: x\r\n\r\n")).toString("latin1");
    assert.equal(got.split(addr(up.port)).length - 1, 0, `no answer names the server: ${got}`);
    assert.equal(got.split(addr(proxy.port)).length - 1, 2, "both name the proxy");
    assert.equal(got.length, answer(up.port).length);
    assert.deepEqual(proxy.stats.rewriteKinds, { handshake: 0, reset: 0, control: 0, stream: 2 });
    assert.equal(proxy.stats.upgrades, 0);
  });
});

test("the aux process's GET /proxy/stats and rtdbLatency(target).stats() carry the new counters", { timeout: 20_000 }, async () => {
  const up = await fakeServer((port) => Buffer.concat([Buffer.from(HEAD_101, "latin1"), wsFrame(handshake(port)), wsFrame(reset(port))]));
  const aux = await startAux({ controlPort: 0, proxy: { listenPort: 0, upstreamPort: up.port }, log: () => {} });
  try {
    const via = parseFrames(await readAll(aux.proxy.port));
    assert.equal(msg(via[1]).d.d, addr(aux.proxy.port));
    const target = {
      kind: "local",
      runId: "selftest-rewrite",
      capabilities: new Set(["rtdb-proxy"]),
      stack: { ports: { rtdbProxy: aux.proxy.port, gate: aux.controlPort } },
      databaseURL: `http://${addr(up.port)}?ns=demo-bikeshed`,
      projectId: "demo-bikeshed",
    };
    const { stats } = await rtdbLatency(target).stats();
    assert.deepEqual(
      { connections: stats.connections, upgrades: stats.upgrades, rewrites: stats.rewrites, kinds: stats.rewriteKinds, data: stats.hostsInData, compressed: stats.compressedFrames },
      { connections: 1, upgrades: 1, rewrites: 2, kinds: { handshake: 1, reset: 1, control: 0, stream: 0 }, data: 0, compressed: 0 },
    );
  } finally {
    await aux.close();
    await up.close();
  }
});

// Why the reset is the one that matters: the SDK the app bundles ignores the handshake's host under connectDatabaseEmulator, and obeys a reset's.
const SDK = join(REPO_ROOT, "app", "node_modules", "@firebase", "database", "dist", "index.esm2017.js");
test("pinned: the app dials the emulator through connectDatabaseEmulator, and its SDK ignores a handshake's host there but takes a reset's", { skip: !existsSync(SDK) && "app/node_modules is not installed" }, () => {
  const app = readFileSync(join(REPO_ROOT, "app", "src", "firebase.ts"), "utf8");
  assert.match(app, /connectDatabaseEmulator\(rtdb, "127\.0\.0\.1", EMULATOR_PORTS\.database\)/);
  const sdk = readFileSync(SDK, "utf8");
  assert.match(sdk, /if \(this\.repoInfo_\.isUsingEmulator\) \{[^}]*handshakePayload\.h = this\.repoInfo_\.host;/, "the handshake's h is replaced by the configured host");
  assert.match(sdk, /onReset_\(host\) \{\s*this\.log_\([^)]*\);\s*this\.repoInfo_\.host = host;/, "a reset's host becomes the host every later connection dials");
  assert.match(sdk, /set host\(newHost\) \{\s*if \(newHost !== this\.internalHost\) \{\s*this\.internalHost = newHost;/);
  assert.match(sdk, /\(repoInfo\.secure \? 'wss:\/\/' : 'ws:\/\/'\) \+ repoInfo\.internalHost \+ '\/\.ws\?'/, "and the WebSocket URL is built from internalHost");
});

test("README states the rewrite of every control message, the new counters and hostRewriter", () => {
  const readme = readFileSync(join(REPO_ROOT, "e2e", "README.md"), "utf8");
  for (const s of ["in EVERY control message of", "`rewriteKinds: {handshake, reset, control, stream}`", "`hostRewriter(pairs, emit, {holdMs = REWRITE_HOLD_MS,", "`CONTROL_FRAME_MAX_BYTES`", "Namespace failure"]) {
    assert.ok(readme.includes(s), `README lacks ${s}`);
  }
});
