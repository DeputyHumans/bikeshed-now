// SPDX-License-Identifier: Apache-2.0
// Self-test: User.log.wsFrames keeps every websocket frame a user's pages send and receive, from the context's creation, bounded and counted (SPEC §12, §16).

/**
 * Hermetic: a local server stands in for the database. It serves a page whose
 * FIRST script opens a websocket and sends before any test code runs, and it
 * answers websockets itself (a minimal RFC 6455 server, no dependency): every
 * text message comes back as `echo:<text>`, `bin` is answered with a binary
 * message, `empty` with an empty one, and `flood:<n>` with n messages. Needs
 * Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { BrowserPool, WS_FRAMES_MAX, WS_FRAMES_MAX_CHARS } from "../lib/browser.mjs";

const PAGE = `<!doctype html><html><body><script>
  // The page's first script: a socket that talks before anyone could attach a listener to it.
  window.open1 = (name) => new Promise((resolve) => {
    const ws = new WebSocket("ws://" + location.host + "/ws/" + name);
    ws.onopen = () => resolve(ws);
  });
  window.first = open1("first").then((ws) => { ws.send("hello"); window.ws = ws; return ws; });
  window.got = [];
  window.first.then((ws) => { ws.onmessage = (m) => got.push(typeof m.data === "string" ? m.data : "<blob>"); });
  window.until = (n) => new Promise((resolve) => { const t = setInterval(() => { if (got.length >= n) { clearInterval(t); resolve(got.length); } }, 10); });
</script></body></html>`;

function encode(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) head = Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]);
  else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** One frame from the front of `buf` (client frames are masked), or null when it is not all there yet. */
function parse(buf) {
  if (buf.length < 2) return null;
  let len = buf[1] & 127;
  let at = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    at = 10;
  }
  const masked = (buf[1] & 128) !== 0;
  const mask = masked ? buf.subarray(at, at + 4) : null;
  if (masked) at += 4;
  if (buf.length < at + len) return null;
  const payload = Buffer.from(buf.subarray(at, at + len));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
  return { fin: (buf[0] & 128) !== 0, opcode: buf[0] & 15, payload, size: at + len };
}

let server;
let target;
const sockets = new Set();

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    let message = [];
    let opcode = 0;
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (let f = parse(buf); f; f = parse(buf)) {
        buf = buf.subarray(f.size);
        if (f.opcode === 8) return void socket.end(encode(8, Buffer.alloc(0)));
        if (f.opcode === 9) continue;
        if (f.opcode !== 0) opcode = f.opcode;
        message.push(f.payload);
        if (!f.fin) continue; // the browser fragments a long message: answer the whole one
        const data = Buffer.concat(message);
        message = [];
        if (opcode !== 1) continue;
        const text = data.toString("utf8");
        if (text === "bin") socket.write(encode(2, Buffer.from("binary-é", "utf8")));
        else if (text === "empty") socket.write(encode(1, Buffer.alloc(0)));
        else if (text.startsWith("flood:")) {
          const n = Number(text.slice(6));
          for (let i = 0; i < n; i += 1) socket.write(encode(1, Buffer.from(`f${i}`)));
        } else socket.write(encode(1, Buffer.from(`echo:${text}`, "utf8")));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-wsframes", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

after(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
});

/** Poll until `fn()` is truthy. */
async function until(fn, what, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("every frame from the page's first script on, both ways, in order; a binary frame as UTF-8; another user's frames are not this user's", async () => {
  const pool = new BrowserPool({ target });
  try {
    const [a, b] = await pool.many(2);
    assert.deepEqual(a.log.wsFrames, { sent: [], received: [], total: { sent: 0, received: 0 }, dropped: { sent: 0, received: 0 } }, "empty, and plain data");
    await a.goto("/");
    await b.goto("/");
    await a.page.evaluate(async () => {
      const ws = await first;
      ws.send("two");
      ws.send("bin");
      ws.send(new Uint8Array([104, 105])); // "hi" as a binary frame
      ws.send("empty");
      const other = await open1("second");
      other.send("on the second socket");
      await until(4);
    });
    await until(() => a.log.wsFrames.received.length >= 4, "four answers");
    const f = a.log.wsFrames;
    assert.deepEqual(f.sent, ["hello", "two", "bin", "hi", "empty", "on the second socket"], "the page's first send, made before any test code ran, is there: captured from the context's creation");
    const second = "echo:on the second socket";
    assert.ok(f.received.includes(second), "the second socket's answer");
    assert.deepEqual(f.received.filter((x) => x !== second), ["echo:hello", "echo:two", "binary-é"], "a binary answer as UTF-8; the empty answer is not reported (measured), though the page got it");
    assert.deepEqual(await a.page.evaluate(() => got), ["echo:hello", "echo:two", "<blob>", ""], "the page itself did receive the empty message");
    assert.deepEqual([f.total, f.dropped], [{ sent: 6, received: 4 }, { sent: 0, received: 0 }]);
    assert.deepEqual(JSON.parse(JSON.stringify(f)), { sent: f.sent, received: f.received, total: f.total, dropped: f.dropped }, "push is not serialised");
    assert.deepEqual(a.log.websockets.map((w) => new URL(w.url).pathname), ["/ws/first", "/ws/second"]);
    await until(() => b.log.wsFrames.received.length >= 1, "b's greeting answered");
    assert.deepEqual([b.log.wsFrames.sent, b.log.wsFrames.received], [["hello"], ["echo:hello"]], "NEGATIVE: b's log holds only b's own frames");
    pool.assertIsolation();
  } finally {
    await pool.close();
  }
});

test("a long message is one frame here, however the browser fragments it on the wire", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    const long = `L${"x".repeat(300_000)}`;
    await u.page.evaluate(async (text) => {
      (await first).send(text);
      await until(2);
    }, long);
    await until(() => u.log.wsFrames.received.length >= 2, "the long echo");
    assert.deepEqual(u.log.wsFrames.sent.map((s) => s.length), [5, long.length]);
    assert.equal(u.log.wsFrames.sent[1], long);
    assert.equal(u.log.wsFrames.received[1], `echo:${long}`, "the server saw the whole message (it reassembles fragments) and so does the log");
  } finally {
    await pool.close();
  }
});

test("bounded: past WS_FRAMES_MAX frames or WS_FRAMES_MAX_CHARS characters the oldest go, counted in dropped; the newest frame always stays", async () => {
  assert.deepEqual([WS_FRAMES_MAX, WS_FRAMES_MAX_CHARS], [5000, 8 * 1024 * 1024]);
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    const n = WS_FRAMES_MAX + 7;
    await u.page.evaluate(async (count) => {
      (await first).send(`flood:${count}`);
      await until(1 + count);
    }, n);
    const f = u.log.wsFrames;
    await until(() => f.total.received >= n + 1, `${n + 1} frames received`, 30_000);
    assert.equal(f.total.received, n + 1);
    assert.equal(f.received.length, WS_FRAMES_MAX);
    assert.equal(f.dropped.received, 8, "the greeting's echo and the first seven of the flood");
    assert.deepEqual([f.received[0], f.received.at(-1)], ["f7", `f${n - 1}`], "the oldest went, in order");
    assert.deepEqual([f.total.sent, f.dropped.sent, f.sent.length], [2, 0, 2], "each direction on its own");

    // Characters: 1,500,000 each, so at most five fit in 8 MiB.
    const size = 1_500_000;
    await u.page.evaluate(async ({ size }) => {
      const ws = await first;
      for (let i = 0; i < 7; i += 1) ws.send(`${i}`.padEnd(size, "c"));
    }, { size });
    await until(() => f.total.sent >= 9, "seven big frames sent");
    assert.equal(f.sent.length, Math.floor(WS_FRAMES_MAX_CHARS / size), "five big frames fit");
    assert.equal(f.dropped.sent, 9 - 5, "the two small ones and the first two big ones went");
    assert.deepEqual(f.sent.map((s) => [s[0], s.length]), [2, 3, 4, 5, 6].map((i) => [`${i}`, size]));

    // One frame larger than the bound alone is kept: the newest always stays.
    const huge = WS_FRAMES_MAX_CHARS + 10;
    await u.page.evaluate(async (len) => (await first).send("H".padEnd(len, "h")), huge);
    await until(() => f.total.sent >= 10, "the huge frame sent");
    assert.deepEqual(f.sent.map((s) => s.length), [huge]);
    assert.equal(f.dropped.sent, 9);
  } finally {
    await pool.close();
  }
});
