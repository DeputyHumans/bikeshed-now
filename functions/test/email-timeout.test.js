// SPDX-License-Identifier: Apache-2.0
// The installed provider SDK aborts both unanswered requests and incomplete bodies within one send deadline (SPEC §14).

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");

test("a provider's headers and body share a 10 second abort deadline; subsequent sends still work", async () => {
  let arrived;
  let phase = "headers";
  const sockets = new Set();
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (phase === "success") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"sent"}'); return; }
      if (phase === "body") { res.writeHead(200, { "content-type": "application/json" }); res.write('{"id":'); }
      arrived();
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const saved = Object.fromEntries(["RESEND_API_KEY", "RESEND_BASE_URL"].map((key) => [key, process.env[key]]));
  process.env.RESEND_API_KEY = "re_e2e_unit_only";
  process.env.RESEND_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const nativeTimeout = global.setTimeout;
  const nativeFetch = global.fetch;
  const nativeWarn = console.warn;
  let deadline;
  let signal;
  let headersRead;
  const warnings = [];
  // Exercise the real installed SDK and a real HTTP response. Only the product
  // deadline's clock is advanced; no wall-clock performance limit is asserted.
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 10_000) deadline = () => fn(...args);
    return nativeTimeout(fn, ms, ...args);
  };
  global.fetch = async (url, options) => { signal = options?.signal; const response = await nativeFetch(url, options); headersRead?.(); return response; };
  console.warn = (message) => warnings.push(message);
  try {
    const { sendEmail } = require("../lib/email/send.js");
    for (phase of ["headers", "body"]) {
      deadline = undefined;
      let seeRequest;
      const observed = new Promise((resolve) => { seeRequest = resolve; });
      arrived = seeRequest;
      const gotHeaders = new Promise((resolve) => { headersRead = resolve; });
      const pending = sendEmail({ to: "held@example.test", subject: phase, body: null, text: "text" });
      await observed;
      if (phase === "body") await gotHeaders;
      assert.equal(typeof deadline, "function", "the product scheduled its 10000 ms provider deadline");
      assert.ok(signal instanceof AbortSignal, "the installed SDK passed the controller signal to fetch");
      deadline();
      let timer;
      const didNotAbort = new Promise((_, reject) => { timer = nativeTimeout(() => reject(new Error(`provider ${phase} did not abort after its deadline`)), 5000); });
      try { assert.deepEqual(await Promise.race([pending, didNotAbort]), { sent: false, reason: "failed" }); }
      finally { clearTimeout(timer); }
      assert.equal(signal.aborted, true);
      assert.equal(warnings.at(-1), "[email] send failed: provider timed out after 10000 ms");
    }
    phase = "success";
    assert.deepEqual(await sendEmail({ to: "next@example.test", subject: "Next", body: null, text: "text" }), { sent: true });
    assert.equal(signal.aborted, false, "the next send owns a fresh controller");
  } finally {
    global.setTimeout = nativeTimeout; global.fetch = nativeFetch; console.warn = nativeWarn;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
