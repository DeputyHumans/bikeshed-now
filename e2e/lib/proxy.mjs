// SPDX-License-Identifier: Apache-2.0
// A TCP pass-through proxy with per-direction delay, for injecting RTDB latency into live-editing races (SPEC §16).

/**
 * Raw TCP, so WebSocket traffic (the RTDB transport) passes byte for byte —
 * no HTTP parsing, no upgrade handling. Each direction is a FIFO: a chunk is
 * written at max(arrival + delay, previous chunk's due time), so changing the
 * delay mid-stream never reorders bytes.
 *
 * CLOSING. A half-close travels through the queue: when one side ends, the
 * bytes it sent before still go out at their due time, and only then is the
 * far side ended (both sockets allow half-open, so the other direction keeps
 * flowing until its own end). A socket that errors (a write to a peer that
 * has gone, a refused connect) is destroyed by Node and handled as a close:
 * what the other side sent still drains to it first. Once one side has
 * closed and nothing is queued either way, the other gets max(up, down) +
 * CLOSE_SLACK_MS to close by itself, and then both are destroyed. (A proxy
 * that destroyed both a few ms after either side's close, or at either
 * side's error, dropped the bytes still queued upstream: a peer that wrote
 * and then closed under an up delay lost its last frames, which a real
 * network would have delivered.)
 *
 * THE RTDB SERVER NAMES ITS OWN ADDRESS, in two control messages
 * (`{"t":"c","d":{"t":…}}`): the handshake (`"t":"h"`, `"h":"127.0.0.1:<its
 * port>"`), first on every connection, and a RESET (`"t":"r"`, `"d":
 * "127.0.0.1:<its port>"`), which tells the client which host to dial next.
 * The web SDK (@firebase/database 1.0.8) ignores the handshake's host under
 * connectDatabaseEmulator, as the app connects, but obeys a reset's:
 * repoInfo.internalHost becomes it, and every later connection of the page
 * dials it, past the proxy and its delay. The Database emulator (v4.11.2)
 * sends a reset naming its own `localHostname` AFTER the handshake, on a live
 * connection, whenever a namespace fails ("Namespace failure for <ns>;
 * clearing connections": every client of it is reset) or a client's
 * connection fails to set up; and in place of a handshake for a stale
 * session. Measured on 2026-10-13 (run 2610131148-8csa): an emulator
 * exception in rules evaluation under five editors took the namespace down
 * for 30 s, and all five pages were reset, each dialling the emulator's own
 * port within 0.6 s, which the tripwire failed as 48 breaches.
 *
 * With `rewriteHost`, the proxy rewrites `127.0.0.1:<upstream port>` (or
 * `localhost:<upstream port>`) in EVERY such message of every connection, to
 * its own `…:<listen port>`. The two ports must have as many digits (server
 * frames are unmasked and length-prefixed: a frame must not change length),
 * so startProxy refuses otherwise. The down stream is read as HTTP: a `101`
 * answer's frames are parsed (no deflate is negotiated by the emulator), and
 * each whole unfragmented text frame of up to CONTROL_FRAME_MAX_BYTES that
 * names the address is parsed as JSON: a control message (`"t":"c"`) is
 * rewritten, everything else (data, a log entry that happens to hold the
 * address) is left exactly as the server sent it and counted
 * (`stats.hostsInData`). A small frame is held until it is whole, which a
 * client could not use before anyway; any other frame passes through as it
 * comes. Any answer that is not a `101` (long polling, REST through the
 * proxy) is rewritten as a byte stream, every occurrence, and a tail of a
 * chunk that could be the start of the address waits up to REWRITE_HOLD_MS
 * for the rest. `stats.rewrites` counts every occurrence rewritten,
 * `stats.rewriteKinds` by message: `{handshake, reset, control, stream}`;
 * `stats.upgrades` counts the connections answered `101`, and
 * `stats.compressedFrames` the frames passed unread because they were
 * compressed (RSV1: a rewrite could not see into them). Until 2026-10-13
 * only the FIRST occurrence in each connection's first REWRITE_WINDOW_BYTES
 * was rewritten: the handshake took it, and a later reset went through.
 *
 * WHAT IS STILL IN THE PROXY. A delay set back to 0 does not send at once
 * what was queued under it: the FIFO keeps every chunk until its due time,
 * and a chunk that arrives behind them waits for them. So a page that sent
 * bytes while a window was set (a compaction's append and removal, set off
 * by acks that came back before the reset) has them delivered up to a
 * window after the reset, which nothing outside the proxy can see (a settle
 * once finished 0.8 s before they arrived). `stats.queued` {up, down} counts
 * the chunks queued now, every connection's, `stats.queuedBytes` their
 * bytes, and `stats.held` the bytes the address rewriter holds (a frame in
 * parts, a stream tail). `drained()` (startProxy's, and rtdbLatency(target)'s
 * for the stack's proxy) waits until all three are 0; `drainState(stats)` is
 * that reading.
 *
 * The listening port must be one the caller owns. With a target and no
 * `listenPort`, it is CLAIMED from the stack's spare pool (lib/spare.mjs) and
 * released by close(); a `listenPort` that is in the pool is claimed too, and
 * anything else must be one of the stack's ports; port 0 (ephemeral) is for
 * self-tests. A BROWSER reaches a proxy only when the app bundle points its
 * database at the proxy's port: a stack built with `--rtdb-proxy` runs one
 * such proxy in its aux process (lib/stackaux.mjs) on the block role
 * `rtdbProxy`, with `rewriteHost`, and `rtdbLatency(target)` sets its delay at
 * runtime.
 */

import net from "node:net";
import { request as httpRequest } from "node:http";
import { claimSparePort, sparePorts } from "./spare.mjs";

/**
 * The most bytes of a connection's first answer held while its HTTP head is
 * read: a longer head ends the parse, and the rest of that connection is
 * rewritten as a byte stream. (Until 2026-10-13: how far into a connection's
 * down stream its one rewrite was looked for.)
 */
export const REWRITE_WINDOW_BYTES = 4096;
/** How long a chunk's tail that may begin the address waits for the next chunk before it goes on as it is (byte-stream answers only; a WebSocket frame is read by its length). */
export const REWRITE_HOLD_MS = 25;
/** The largest whole text frame read as a possible control message (a handshake is about 150 bytes, a reset about 50); a bigger frame passes through as it comes, unread. */
export const CONTROL_FRAME_MAX_BYTES = 4096;
/** Once one side has closed and both queues are empty, how long (beyond the larger delay) the other side gets to close by itself. */
export const CLOSE_SLACK_MS = 1_000;
/** How long drained() waits by default: the longest delay a direction may be given (lib/stackaux.mjs LATENCY_MAX_MS, a minute) and 5 s. */
export const DRAIN_WAIT_MS = 65_000;
/** How often drained() reads the queues. */
export const DRAIN_POLL_MS = 50;

const EMPTY = Buffer.alloc(0);
const HTTP_PREFIX = Buffer.from("HTTP/", "latin1");
const HEAD_END = Buffer.from("\r\n\r\n", "latin1");

/** Every occurrence of each `from` in `buf`, as [index, pair], in order, none overlapping. */
function occurrences(buf, pairs) {
  const found = [];
  for (const p of pairs) {
    for (let i = buf.indexOf(p.from); i >= 0; i = buf.indexOf(p.from, i + p.from.length)) found.push([i, p]);
  }
  return found;
}

/** Overwrite every occurrence in place (same length); returns how many. */
function replaceIn(buf, pairs) {
  const found = occurrences(buf, pairs);
  for (const [i, p] of found) p.to.copy(buf, i);
  return found.length;
}

/**
 * A server→client WebSocket frame header at the start of `b`: {headerLen,
 * len, fin, rsv1, masked, opcode}, or null while it is incomplete (RFC 6455
 * §5.2: 2 bytes, then a 16- or 64-bit length, then a mask key if masked).
 */
function frameHeader(b) {
  if (b.length < 2) return null;
  let len = b[1] & 0x7f;
  let headerLen = 2;
  if (len === 126) {
    if (b.length < 4) return null;
    len = b.readUInt16BE(2);
    headerLen = 4;
  } else if (len === 127) {
    if (b.length < 10) return null;
    len = Number(b.readBigUInt64BE(2));
    headerLen = 10;
  }
  const masked = (b[1] & 0x80) !== 0;
  if (masked) headerLen += 4;
  if (b.length < headerLen) return null;
  return { headerLen, len, fin: (b[0] & 0x80) !== 0, rsv1: (b[0] & 0x40) !== 0, masked, opcode: b[0] & 0x0f };
}

/** What a text frame's payload is, when it names the address: "handshake" | "reset" | "control" (an RTDB control message, `t: "c"`), else null (data, or not JSON). */
function controlKind(payload) {
  let m;
  try {
    m = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || m.t !== "c") return null;
  const t = m.d && typeof m.d === "object" ? m.d.t : undefined;
  return t === "h" ? "handshake" : t === "r" ? "reset" : "control";
}

/**
 * The down-stream filter of a `rewriteHost` proxy (see THE RTDB SERVER NAMES
 * ITS OWN ADDRESS in the header). `pairs` [{from, to}] are same-length
 * Buffers; `emit(buf)` takes the bytes out, in order. `count(what, n)` hears
 * each occurrence rewritten ("handshake", "reset", "control", "stream"), left
 * in data ("data"), each frame passed unread because compressed
 * ("compressed"), and each `101` answer ("upgrade").
 *
 * Modes: "start" until 5 bytes tell an HTTP answer ("HTTP/") from anything
 * else; "head" while the head is read (held: a client cannot use part of
 * one); then "ws" after a `101`, else "stream". In "ws", frames are read by
 * their length: a whole, unfragmented, uncompressed, unmasked text frame of
 * up to `frameMax` bytes is held until whole and rewritten only when it is a
 * control message; every other frame goes on as it comes. In "stream", every
 * occurrence is rewritten, and a tail that may begin one waits `holdMs`.
 * Once a frame is whole nothing of it is held: a `101` connection needs no
 * timer. Returns {push(chunk), flush() (the source ended: what is held goes
 * on as it is), stop(), held (a getter: the bytes it holds now, not yet
 * emitted)}. Exported for its self-test
 * (selftest/proxy-rewrite-all.test.mjs) and any other proxy of the
 * Database's wire.
 */
export function hostRewriter(pairs, emit, { holdMs = REWRITE_HOLD_MS, headMax = REWRITE_WINDOW_BYTES, frameMax = CONTROL_FRAME_MAX_BYTES, count = () => {} } = {}) {
  const longest = Math.max(...pairs.map((p) => p.from.length));
  let mode = "start";
  let pending = EMPTY; // bytes not yet emitted: the start or head so far, a partial frame (header, or a small frame), or a held stream tail
  let passLeft = 0; // payload bytes of the current pass-through frame still to come ("ws")
  let timer = null;

  /** The length of the longest tail of `buf` that is a proper prefix of some `from`. */
  const prefixTail = (buf) => {
    for (let k = Math.min(buf.length, longest - 1); k > 0; k -= 1) {
      const tail = buf.subarray(buf.length - k);
      if (pairs.some((p) => k < p.from.length && p.from.subarray(0, k).equals(tail))) return k;
    }
    return 0;
  };
  const disarm = () => {
    clearTimeout(timer);
    timer = null;
  };
  /** Emit what is held as it is; a start that never became a head is a stream from then on. */
  const release = () => {
    disarm();
    if (mode === "start") mode = "stream";
    if (pending.length) {
      const h = pending;
      pending = EMPTY;
      emit(h);
    }
  };
  const holdAWhile = () => {
    disarm();
    timer = setTimeout(release, holdMs);
  };

  const streamPush = (chunk) => {
    let buf = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk); // a copy: rewritten in place
    pending = EMPTY;
    const n = replaceIn(buf, pairs);
    if (n) count("stream", n);
    const k = prefixTail(buf);
    if (k > 0) {
      pending = buf.subarray(buf.length - k);
      buf = buf.subarray(0, buf.length - k);
      holdAWhile();
    }
    if (buf.length) emit(buf);
  };

  const wsPush = (chunk) => {
    const out = [];
    let buf = chunk;
    while (buf.length) {
      if (passLeft > 0) {
        const take = Math.min(passLeft, buf.length);
        out.push(buf.subarray(0, take));
        passLeft -= take;
        buf = buf.subarray(take);
        continue;
      }
      pending = pending.length ? Buffer.concat([pending, buf]) : buf;
      buf = EMPTY;
      const h = frameHeader(pending);
      if (!h) break; // a header in parts: wait for the rest
      if (h.opcode === 1 && h.fin && !h.rsv1 && !h.masked && h.len <= frameMax) {
        const total = h.headerLen + h.len;
        if (pending.length < total) break; // a small text frame in parts: wait for the whole of it
        const whole = Buffer.from(pending.subarray(0, total)); // a copy: rewritten in place
        buf = pending.subarray(total);
        pending = EMPTY;
        const payload = whole.subarray(h.headerLen);
        const n = occurrences(payload, pairs).length;
        if (n) {
          const kind = controlKind(payload);
          if (kind) count(kind, replaceIn(payload, pairs));
          else count("data", n);
        }
        out.push(whole);
      } else {
        if (h.rsv1) count("compressed", 1);
        const take = Math.min(pending.length - h.headerLen, h.len);
        out.push(pending.subarray(0, h.headerLen + take));
        passLeft = h.len - take;
        buf = pending.subarray(h.headerLen + take);
        pending = EMPTY;
      }
    }
    if (out.length) emit(out.length === 1 ? out[0] : Buffer.concat(out));
  };

  const headPush = (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const end = pending.indexOf(HEAD_END);
    if (end < 0) {
      if (pending.length > headMax) {
        mode = "stream";
        const b = pending;
        pending = EMPTY;
        streamPush(b);
      }
      return;
    }
    const head = Buffer.from(pending.subarray(0, end + HEAD_END.length));
    const rest = pending.subarray(end + HEAD_END.length);
    pending = EMPTY;
    const upgraded = /^HTTP\/1\.[01] 101[ \r]/.test(head.toString("latin1", 0, Math.min(head.length, 16)));
    const n = replaceIn(head, pairs); // a Location naming the upstream, should one ever come
    if (n) count("stream", n);
    emit(head);
    if (upgraded) count("upgrade", 1);
    mode = upgraded ? "ws" : "stream";
    if (rest.length) push(rest);
  };

  const startPush = (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    if (pending.length < HTTP_PREFIX.length && HTTP_PREFIX.subarray(0, pending.length).equals(pending)) {
      holdAWhile(); // may still be "HTTP/"; a stream if nothing more comes
      return;
    }
    disarm();
    mode = pending.subarray(0, HTTP_PREFIX.length).equals(HTTP_PREFIX) ? "head" : "stream";
    const b = pending;
    pending = EMPTY;
    push(b);
  };

  function push(chunk) {
    if (mode === "ws") return wsPush(chunk);
    if (mode === "stream") {
      disarm();
      return streamPush(chunk);
    }
    if (mode === "head") return headPush(chunk);
    return startPush(chunk);
  }

  return {
    push,
    /** The source ended: whatever is held goes on as it is. */
    flush: release,
    stop() {
      disarm();
      pending = EMPTY;
    },
    /** How many bytes it holds now, not yet emitted: a start or head being read, a small frame in parts, a stream tail (startProxy's `stats.held`, which drained() waits out). */
    get held() {
      return pending.length;
    },
  };
}

const isCount = (v) => Number.isInteger(v) && v >= 0;

/**
 * What a proxy's `stats` say is still in it: {empty, queued: {up, down}
 * (chunks), queuedBytes: {up, down}, held (bytes the address rewriter
 * holds)}; `empty` when all of them are 0. null for stats without these
 * counters (an aux process started before 2026-10-13's drain change), or
 * with one that is not a whole number of 0 or more.
 */
export function drainState(stats) {
  const q = stats?.queued;
  const b = stats?.queuedBytes;
  const held = stats?.held;
  if (!q || typeof q !== "object" || !b || typeof b !== "object") return null;
  if (![q.up, q.down, b.up, b.down, held].every(isCount)) return null;
  return { empty: q.up === 0 && q.down === 0 && held === 0, queued: { up: q.up, down: q.down }, queuedBytes: { up: b.up, down: b.down }, held };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read `read()` → {delay, stats} every `intervalMs` until drainState(stats)
 * is empty: {ms, polls, atStart (the first reading's drainState), delay,
 * stats}. Running out is E2E_PROXY_DRAIN (worded as the harness's own
 * failure, not as a wait the stack ran out of: the proxy is the harness's);
 * stats without the counters are E2E_PROXY.
 */
async function waitDrained(read, what, options) {
  const o = options ?? {};
  if (typeof o !== "object") throw new TypeError(`drained: the options are an object, got ${JSON.stringify(o)}`);
  const { timeoutMs = DRAIN_WAIT_MS, intervalMs = DRAIN_POLL_MS } = o;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new TypeError(`drained: timeoutMs is a whole number of ms from 1 to 600000, got ${JSON.stringify(timeoutMs) ?? String(timeoutMs)}`);
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 5_000) throw new TypeError(`drained: intervalMs is a whole number of ms from 1 to 5000, got ${JSON.stringify(intervalMs) ?? String(intervalMs)}`);
  const t0 = Date.now();
  let polls = 0;
  let atStart = null;
  for (;;) {
    const r = await read();
    polls += 1;
    const s = drainState(r?.stats);
    if (!s) throw latencyError("E2E_PROXY", `${what} reports no queue counters (stats.queued, queuedBytes, held), so drained() cannot tell what it still holds: its process predates them (lib/proxy.mjs, 2026-10-13); stop the stack and start it again`);
    atStart ??= s;
    const ms = Date.now() - t0;
    if (s.empty) return { ms, polls, atStart, delay: r.delay ?? null, stats: r.stats };
    if (ms >= timeoutMs) {
      const d = r.delay ? `; its delay is up ${r.delay.up} ms, down ${r.delay.down} ms${r.delay.up || r.delay.down ? " (set it back to 0 first: under a delay, steady traffic never leaves the queues empty)" : ""}` : "";
      const err = latencyError("E2E_PROXY_DRAIN", `${what} still held bytes ${ms} ms after drained() began (its limit ${timeoutMs} ms): up ${s.queued.up} chunk(s) of ${s.queuedBytes.up} B, down ${s.queued.down} chunk(s) of ${s.queuedBytes.down} B, ${s.held} B held by the address rewriter${d}`);
      Object.assign(err, { state: s, atStart, delay: r.delay ?? null, polls, ms });
      throw err;
    }
    await sleep(Math.min(intervalMs, timeoutMs - ms));
  }
}

/**
 * Start a proxy. Returns {port, host, url, claim, stats, setDelay({up, down}),
 * drained({timeoutMs, intervalMs}), dropAll(), close()}. `up` delays client→upstream bytes, `down`
 * upstream→client. `rewriteHost` swaps the upstream's address for the
 * proxy's in every control message (handshake, reset) of every connection,
 * and everywhere in an answer that is not a `101` (see the header).
 * `stats`: {connections, open, bytesUp, bytesDown, maxLagMs: {up, down},
 * rewrites, errors, upgrades, rewriteKinds: {handshake, reset, control,
 * stream}, hostsInData, compressedFrames, queued: {up, down}, queuedBytes:
 * {up, down}, held}. `rewrites` counts every swap (the sum of
 * `rewriteKinds`); `hostsInData` the occurrences left as they were in data;
 * the keys after `errors` are new on 2026-10-13. `queued` is the chunks
 * queued now, by direction, every connection's; `queuedBytes` their bytes;
 * `held` the bytes the address rewriters hold now (WHAT IS STILL IN THE
 * PROXY, in the header). `drained({timeoutMs = DRAIN_WAIT_MS, intervalMs =
 * DRAIN_POLL_MS})` → {ms, polls, atStart, delay, stats} resolves once all
 * three are 0 (rtdbLatency(target).drained, in this process).
 */
export async function startProxy({
  upstreamHost = "127.0.0.1",
  upstreamPort,
  listenHost = "127.0.0.1",
  listenPort = null,
  target = null,
  up = 0,
  down = 0,
  rewriteHost = false,
} = {}) {
  if (!Number.isInteger(upstreamPort)) throw new Error("startProxy: upstreamPort is required");
  let port = listenPort;
  let claim = null;
  if (target) {
    const own = Object.values(target.stack?.ports ?? {}).map(Number);
    if (port != null && !own.includes(Number(port))) throw new Error(`startProxy: port ${port} is not one of stack ${target.runId}'s`);
    if (port == null || sparePorts(target).includes(Number(port))) {
      claim = await claimSparePort(target, { purpose: "proxy", ...(port != null ? { port: Number(port) } : {}) });
      port = claim.port;
    }
  }
  port ??= 0;
  const delay = { up, down };
  const stats = {
    connections: 0,
    open: 0,
    bytesUp: 0,
    bytesDown: 0,
    maxLagMs: { up: 0, down: 0 },
    rewrites: 0,
    errors: 0,
    upgrades: 0,
    rewriteKinds: { handshake: 0, reset: 0, control: 0, stream: 0 },
    hostsInData: 0,
    compressedFrames: 0,
    queued: { up: 0, down: 0 },
    queuedBytes: { up: 0, down: 0 },
    held: 0,
  };
  /** hostRewriter's counts, into `stats`. */
  const count = (what, n) => {
    if (what === "data") stats.hostsInData += n;
    else if (what === "compressed") stats.compressedFrames += n;
    else if (what === "upgrade") stats.upgrades += n;
    else {
      stats.rewrites += n;
      stats.rewriteKinds[what] += n;
    }
  };
  const conns = new Set();
  let pairs = null; // set once the listening port is known

  // One FIFO queue and ONE timer per direction. A timer per chunk is not
  // enough: two timers due in the same millisecond but created with
  // different durations may fire in either order, which reordered bytes
  // (seen as a 1-in-7 failure of the order self-test).
  // stats.queued/queuedBytes count a chunk from its enqueue to its write (or
  // its connection's end); stats.held follows each rewriter's `held` after
  // every push, emit, flush and stop.
  const pipe = (from, to, dir, { rewrite = null, onDrained }) => {
    const queue = [];
    let due = 0;
    let ended = false;
    let timer = null;
    let stopped = false;
    let heldNow = 0; // this pipe's share of stats.held
    let rw = null;
    const syncHeld = () => {
      const h = rw && !stopped ? rw.held : 0;
      stats.held += h - heldNow;
      heldNow = h;
    };
    const pump = () => {
      timer = null;
      const t = Date.now();
      while (queue.length && queue[0].due <= t) {
        const { chunk } = queue.shift();
        stats.queued[dir] -= 1;
        stats.queuedBytes[dir] -= chunk.length;
        if (!to.destroyed && !to.writableEnded) to.write(chunk);
      }
      if (queue.length) {
        timer = setTimeout(pump, queue[0].due - t);
        return;
      }
      // Everything the source sent is out: pass its half-close on.
      if (ended && !to.destroyed && !to.writableEnded) to.end();
      onDrained();
    };
    const enqueue = (chunk) => {
      if (stopped) return; // the connection is gone: nothing more goes out
      const arrival = Date.now();
      due = Math.max(arrival + delay[dir], due);
      stats.maxLagMs[dir] = Math.max(stats.maxLagMs[dir], due - arrival);
      queue.push({ due, chunk });
      stats.queued[dir] += 1;
      stats.queuedBytes[dir] += chunk.length;
      syncHeld();
      if (!timer) pump();
    };
    rw = rewrite ? hostRewriter(rewrite, enqueue, { count }) : null;
    from.on("data", (chunk) => {
      stats[dir === "up" ? "bytesUp" : "bytesDown"] += chunk.length;
      if (rw) {
        rw.push(chunk);
        syncHeld();
      } else enqueue(chunk);
    });
    const sourceEnded = () => {
      if (ended) return;
      rw?.flush();
      syncHeld();
      ended = true;
      if (!timer) pump();
    };
    from.on("end", sourceEnded);
    return {
      /** The source closed (with or without a FIN): what it sent still goes out, then the far side's end. */
      sourceGone: sourceEnded,
      get idle() {
        return queue.length === 0;
      },
      stop() {
        clearTimeout(timer);
        timer = null;
        for (const { chunk } of queue) {
          stats.queued[dir] -= 1;
          stats.queuedBytes[dir] -= chunk.length;
        }
        queue.length = 0;
        rw?.stop();
        stopped = true;
        syncHeld();
      },
    };
  };

  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    stats.connections += 1;
    stats.open += 1;
    const upstream = net.connect({ port: upstreamPort, host: upstreamHost, allowHalfOpen: true });
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    let gone = false;
    let reaper = null;
    const conn = { client, upstream, done: null };
    conns.add(conn);
    const done = () => {
      if (gone) return;
      gone = true;
      clearTimeout(reaper);
      conns.delete(conn);
      stats.open -= 1;
      upPipe.stop();
      downPipe.stop();
      client.destroy();
      upstream.destroy();
    };
    conn.done = done;
    const settle = () => {
      if (gone) return;
      if (client.destroyed && upstream.destroyed) return done();
      // One side has closed: once nothing is queued either way, the other
      // gets the larger delay plus slack to close by itself.
      if ((client.destroyed || upstream.destroyed) && upPipe.idle && downPipe.idle) {
        clearTimeout(reaper);
        reaper = setTimeout(done, Math.max(delay.up, delay.down) + CLOSE_SLACK_MS);
      }
    };
    const upPipe = pipe(client, upstream, "up", { onDrained: settle });
    const downPipe = pipe(upstream, client, "down", { rewrite: pairs, onDrained: settle });
    // An error is that socket's own failure (a write to a peer that has gone,
    // a refused connect): Node destroys it, and its 'close' below then lets
    // what the OTHER side sent drain to it first, as TCP would have.
    const failed = () => (stats.errors += 1);
    client.on("error", failed);
    upstream.on("error", failed);
    client.on("close", () => {
      upPipe.sourceGone();
      settle();
    });
    upstream.on("close", () => {
      downPipe.sourceGone();
      settle();
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, listenHost, resolve);
    });
  } catch (err) {
    claim?.release();
    throw err;
  }
  const bound = server.address().port;
  if (rewriteHost) {
    pairs = [];
    for (const host of ["127.0.0.1", "localhost"]) {
      const from = `${host}:${upstreamPort}`;
      const to = `${host}:${bound}`;
      if (from.length !== to.length) {
        await new Promise((r) => server.close(() => r()));
        claim?.release();
        throw new Error(`startProxy: rewriteHost needs the upstream port ${upstreamPort} and the proxy's ${bound} to have as many digits (a server frame must keep its length)`);
      }
      pairs.push({ from: Buffer.from(from, "latin1"), to: Buffer.from(to, "latin1") });
    }
  }
  return {
    host: listenHost,
    port: bound,
    claim,
    url: `${listenHost}:${bound}`,
    stats,
    setDelay({ up: u = delay.up, down: d = delay.down } = {}) {
      delay.up = u;
      delay.down = d;
    },
    /** Resolve once nothing is queued either way and no rewriter holds a byte: {ms, polls, atStart, delay, stats} (copies). Running out of timeoutMs is E2E_PROXY_DRAIN. */
    drained: (options) => waitDrained(async () => ({ delay: { ...delay }, stats: JSON.parse(JSON.stringify(stats)) }), "the proxy", options),
    /** Destroy every open connection at once, both sides, as a network failure would (a reconnect test's lever). Returns how many. */
    dropAll() {
      const all = [...conns];
      for (const c of all) c.done();
      return all.length;
    },
    /** Stop, drop every connection, and release the spare-port claim. */
    close: () =>
      new Promise((resolve) => {
        for (const c of [...conns]) c.done();
        server.close(() => resolve());
      }).finally(() => claim?.release()),
  };
}

// --- the stack's own RTDB proxy (--rtdb-proxy) --------------------------------

function latencyError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** One GET over a FRESH connection to 127.0.0.1:port; resolves the ms to the whole answer. */
function timedGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers, agent: false, timeout: 30_000 }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`GET :${port}${path} timed out`)));
    req.on("error", reject);
    req.end();
  });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/**
 * The RTDB latency proxy of a stack built with `--rtdb-proxy` (capability
 * `rtdb-proxy`): every browser's RTDB websocket goes through it, so a delay
 * set here is latency every peer sees, from the next byte on (a FIFO per
 * direction: nothing is reordered when the delay changes).
 *
 *   const lat = rtdbLatency(ctx.target);
 *   await lat.set({ up: 300, down: 0 });   // client→database bytes 300 ms late
 *   try { … } finally { await lat.reset(); }
 *
 * {port, controlUrl, set({up, down}) → {up, down}, get() → {up, down},
 * reset(), drop() → number, stats() → {delay, stats}, drained({timeoutMs,
 * intervalMs}) → {ms, polls, atStart, delay, stats}, roundTrip({via,
 * samples}) → {ms, samples}}. `drained()` waits until nothing is queued in
 * the proxy either way (after reset(): see WHAT IS STILL IN THE PROXY in the
 * header). `drop()` destroys every connection through the
 * proxy, as a network failure would: each page reconnects, through the proxy
 * again, which `stats().stats.connections` counts; `stats().stats.rewriteKinds`
 * counts the handshakes and resets rewritten to name the proxy (put it in a
 * case's evidence beside `connections` and `upgrades`). `roundTrip` times a REST read of the database root (shallow, as
 * the emulator's admin) over a fresh connection, through the proxy (`via:
 * "proxy"`, the default) or straight to the emulator (`via: "direct"`), and
 * gives the median: through the proxy it grows by about up + down. The stack
 * is shared state: set the delay back in a `finally`.
 */
export function rtdbLatency(target, { fetchImpl = fetch } = {}) {
  if (target?.kind !== "local") throw latencyError("E2E_CAPABILITY", "the RTDB proxy exists only on a local stack");
  if (!target.capabilities?.has?.("rtdb-proxy")) throw latencyError("E2E_CAPABILITY", `stack ${target.runId} has no RTDB proxy (build it with --rtdb-proxy)`);
  const ports = target.stack?.ports ?? {};
  const port = ports.rtdbProxy;
  const control = ports.gate;
  if (!Number.isInteger(port) || !Number.isInteger(control)) throw latencyError("E2E_CAPABILITY", `stack ${target.runId}: no rtdbProxy or gate port in its block`);
  const controlUrl = `http://127.0.0.1:${control}`;
  const call = async (method, path, body) => {
    const r = await fetchImpl(`${controlUrl}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (r.status !== 200) throw latencyError("E2E_PROXY", `RTDB proxy control ${method} ${path}: ${r.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  const ns = new URL(target.databaseURL).searchParams.get("ns") ?? target.projectId;
  const set = async ({ up, down } = {}) => {
    const r = await call("POST", "/latency", { ...(up !== undefined ? { up } : {}), ...(down !== undefined ? { down } : {}) });
    return { up: r.up, down: r.down };
  };
  return {
    port,
    controlUrl,
    set,
    async get() {
      const r = await call("GET", "/latency");
      return { up: r.up, down: r.down };
    },
    reset: () => set({ up: 0, down: 0 }),
    /** Destroy every connection through the proxy at once (each page's RTDB SDK reconnects); resolves how many. */
    async drop() {
      return (await call("POST", "/proxy/drop")).dropped;
    },
    async stats() {
      const r = await call("GET", "/proxy/stats");
      return { delay: r.delay, stats: r.stats };
    },
    /**
     * Resolve once the stack's proxy holds nothing: no chunk queued either
     * way, on any connection, and no byte held by its address rewriter
     * (drainState). {ms, polls, atStart, delay, stats}: `atStart` is the
     * first reading (what was still queued), `stats` the last. Call it after
     * reset(): bytes a page sent under a window are delivered up to a window
     * later, and a settle cannot see them in the proxy. Running out of
     * `timeoutMs` (DRAIN_WAIT_MS, 65 s) is E2E_PROXY_DRAIN (with `state`,
     * `atStart`, `delay`, `polls`, `ms`); an aux process older than the
     * counters is E2E_PROXY (restart the stack).
     */
    drained(options) {
      return waitDrained(async () => {
        const r = await call("GET", "/proxy/stats");
        return { delay: r.delay, stats: r.stats };
      }, "the stack's RTDB proxy", options);
    },
    async roundTrip({ via = "proxy", samples = 3 } = {}) {
      if (via !== "proxy" && via !== "direct") throw new TypeError(`roundTrip via is "proxy" or "direct", got ${JSON.stringify(via)}`);
      const p = via === "proxy" ? port : Number(new URL(target.databaseURL).port);
      const out = [];
      for (let i = 0; i < samples; i += 1) {
        const r = await timedGet(p, `/.json?ns=${encodeURIComponent(ns)}&shallow=true`, { authorization: "Bearer owner" });
        if (r.status !== 200) throw latencyError("E2E_PROXY", `RTDB read via ${via} answered ${r.status}`);
        out.push(r.ms);
      }
      return { ms: median(out), samples: out };
    },
  };
}
