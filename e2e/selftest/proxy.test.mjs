// SPDX-License-Identifier: Apache-2.0
// Self-test: the latency proxy delays each direction as configured, keeps byte order, and refuses a port it does not own (SPEC §16).

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startProxy } from "../lib/proxy.mjs";

/** An echo server that stamps when each chunk arrived. */
async function echo() {
  const seen = [];
  const server = net.createServer((s) => s.on("data", (c) => {
    seen.push({ at: Date.now(), data: c.toString() });
    s.write(c);
  }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

function roundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const s = net.connect(port, "127.0.0.1", () => s.write(payload));
    let got = "";
    s.on("data", (c) => {
      got += c.toString();
      if (got.length >= payload.length) {
        s.end();
        resolve({ ms: Date.now() - t0, got, t0 });
      }
    });
    s.on("error", reject);
  });
}

test("delays upstream and downstream by the configured amounts", async () => {
  const up = await echo();
  const proxy = await startProxy({ upstreamPort: up.port, listenPort: 0, up: 120, down: 80 });
  try {
    const r = await roundTrip(proxy.port, "hello");
    assert.equal(r.got, "hello");
    assert.ok(up.seen[0].at - r.t0 >= 110, `upstream saw it after ${up.seen[0].at - r.t0} ms (want ≥ 120 − jitter)`);
    assert.ok(r.ms >= 190, `round trip ${r.ms} ms (want ≥ 200 − jitter)`);
    proxy.setDelay({ up: 0, down: 0 });
    const fast = await roundTrip(proxy.port, "again");
    assert.ok(fast.ms < 100, `NEGATIVE: with the delay removed the round trip is ${fast.ms} ms`);
    assert.equal(proxy.stats.connections, 2);
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("keeps byte order when the delay shrinks mid-stream", async () => {
  const up = await echo();
  const proxy = await startProxy({ upstreamPort: up.port, listenPort: 0, up: 200 });
  try {
    const order = await new Promise((resolve, reject) => {
      const s = net.connect(proxy.port, "127.0.0.1", () => {
        s.write("A");
        setTimeout(() => {
          proxy.setDelay({ up: 0 });
          s.write("B");
        }, 20);
      });
      let got = "";
      s.on("data", (c) => {
        got += c.toString();
        if (got.length >= 2) {
          s.end();
          resolve(got);
        }
      });
      s.on("error", reject);
    });
    assert.equal(order, "AB", "B was sent with no delay but must not overtake A");
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("NEGATIVE: with a target, a port outside the stack's block is refused", async () => {
  const target = { runId: "selftest-x", stack: { ports: { spare: 36655, database: 36644 } } };
  await assert.rejects(startProxy({ upstreamPort: 36644, target, listenPort: 9000 }), /not one of stack selftest-x's/);
});

// --- closing under delay ----------------------------------------------------------------

/** An upstream that keeps everything a connection sent until that connection ends or closes, half-open allowed; `reply` is written back after the client's end. */
async function collector({ reply = null } = {}) {
  const conns = [];
  const waiting = [];
  const server = net.createServer({ allowHalfOpen: true }, (s) => {
    const c = { data: "", ended: false, closed: false, endedAt: null };
    conns.push(c);
    s.on("data", (d) => (c.data += d.toString()));
    s.on("end", () => {
      c.ended = true;
      c.endedAt = Date.now();
      if (reply != null) s.end(reply);
      else s.end();
    });
    s.on("error", () => undefined);
    s.on("close", () => {
      c.closed = true;
      waiting.shift()?.(c);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    /** The next connection, once it has closed. */
    next: () => new Promise((r) => waiting.push(r)),
    close: () => new Promise((r) => server.close(r)),
  };
}

const until = async (fn, ms = 3_000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
};

test("a client that writes and then ends under an up delay: every byte reaches upstream, then its half-close", { timeout: 20_000 }, async () => {
  const up = await collector();
  const proxy = await startProxy({ upstreamPort: up.port, listenPort: 0, up: 300 });
  try {
    const conn = up.next();
    const t0 = Date.now();
    const s = net.connect(proxy.port, "127.0.0.1", () => {
      s.write("hello, ");
      s.end("world");
    });
    s.on("error", () => undefined);
    s.resume();
    const c = await conn;
    assert.equal(c.data, "hello, world", "the bytes queued when the client ended still reach upstream");
    assert.equal(c.ended, true, "and then the half-close (FIN), not a reset");
    assert.ok(c.endedAt - t0 >= 280, `upstream saw the end after ${c.endedAt - t0} ms: after the queued bytes, never before`);
    assert.ok(await until(() => proxy.stats.open === 0), `the connection is gone from the proxy (open ${proxy.stats.open})`);
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("an upstream that writes and then ends under a down delay: every byte reaches the client", { timeout: 20_000 }, async () => {
  const server = net.createServer((s) => s.end("from upstream"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const proxy = await startProxy({ upstreamPort: server.address().port, listenPort: 0, down: 300 });
  try {
    const got = await new Promise((resolve, reject) => {
      const s = net.connect(proxy.port, "127.0.0.1");
      let data = "";
      s.on("data", (d) => (data += d.toString()));
      s.on("end", () => resolve(data));
      s.on("error", reject);
    });
    assert.equal(got, "from upstream");
  } finally {
    await proxy.close();
    await new Promise((r) => server.close(r));
  }
});

test("a half-close travels: the client ends its side and still gets the upstream's answer", { timeout: 20_000 }, async () => {
  const up = await collector({ reply: "pong" });
  try {
    for (const delay of [{ up: 0, down: 0 }, { up: 150, down: 150 }]) {
      const proxy = await startProxy({ upstreamPort: up.port, listenPort: 0, ...delay });
      try {
        const conn = up.next();
        const got = await new Promise((resolve, reject) => {
          const s = net.connect(proxy.port, "127.0.0.1", () => s.end("ping"));
          let data = "";
          s.on("data", (d) => (data += d.toString()));
          s.on("end", () => resolve(data));
          s.on("error", reject);
          setTimeout(() => resolve(`${data} (no end within 3 s)`), 3_000).unref();
        });
        assert.equal(got, "pong", `the answer to a half-closed client arrives (delay ${JSON.stringify(delay)})`);
        assert.equal((await conn).data, "ping");
      } finally {
        await proxy.close();
      }
    }
  } finally {
    await up.close();
  }
});

// --- the handshake rewrite's edges -------------------------------------------------------

test("rewriteHost never stalls a message that only ENDS like the start of the address: the held tail goes on within REWRITE_HOLD_MS", { timeout: 20_000 }, async () => {
  // A keep-alive answer whose body is "12" (a prefix of "127.0.0.1:"): nothing else follows it.
  const server = net.createServer((s) => {
    s.on("data", () => s.write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n12"));
    s.on("error", () => undefined);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const proxy = await startProxy({ upstreamPort: server.address().port, listenPort: 0, rewriteHost: true });
  try {
    const t0 = Date.now();
    const got = await new Promise((resolve, reject) => {
      const s = net.connect(proxy.port, "127.0.0.1", () => s.write("GET /x.json HTTP/1.1\r\nhost: x\r\n\r\n"));
      let data = "";
      s.on("data", (d) => {
        data += d.toString();
        if (data.endsWith("\r\n\r\n12")) {
          s.destroy();
          resolve(data);
        }
      });
      s.on("error", reject);
      setTimeout(() => resolve(`${data} (incomplete after 2 s)`), 2_000).unref();
    });
    assert.ok(got.endsWith("\r\n\r\n12"), JSON.stringify(got));
    assert.ok(Date.now() - t0 < 500, `the held "12" arrived after ${Date.now() - t0} ms`);
    assert.equal(proxy.stats.rewrites, 0, "nothing was rewritten");
  } finally {
    await proxy.close();
    await new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    });
  }
});

test("NEGATIVE: rewriteHost refuses ports of different widths (a server frame must keep its length), and frees its port", async () => {
  // 1234 is never dialled: the check is made before any connection.
  await assert.rejects(startProxy({ upstreamPort: 1234, listenPort: 0, rewriteHost: true }), /as many digits/);
});

test("a client that writes and then vanishes (an abrupt close, so the proxy's next write to it fails) still gets its queued bytes to upstream", { timeout: 20_000 }, async () => {
  // The upstream talks all the time, so the proxy writes to the gone client and gets EPIPE/ECONNRESET.
  const conns = [];
  const closed = [];
  const server = net.createServer({ allowHalfOpen: true }, (s) => {
    const c = { data: "" };
    conns.push(c);
    const talk = setInterval(() => !s.destroyed && s.write("tick"), 5);
    s.on("data", (d) => (c.data += d.toString()));
    s.on("end", () => s.end());
    s.on("error", () => undefined);
    s.on("close", () => {
      clearInterval(talk);
      closed.shift()?.(c);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const proxy = await startProxy({ upstreamPort: server.address().port, listenPort: 0, up: 300 });
  try {
    const conn = new Promise((r) => closed.push(r));
    const s = net.connect(proxy.port, "127.0.0.1", () => {
      s.write("last words", () => setTimeout(() => s.destroy(), 30));
    });
    s.on("error", () => undefined);
    const c = await conn;
    assert.equal(c.data, "last words", "what the client sent before it vanished reaches upstream");
    assert.ok(await until(() => proxy.stats.open === 0), `the connection is gone from the proxy (open ${proxy.stats.open})`);
  } finally {
    await proxy.close();
    await new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    });
  }
});
