// SPDX-License-Identifier: Apache-2.0
// Keep bounded emulator handshake inspection available across real browser navigation, including secondary tabs (SPEC §12).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { preserveFirestoreResponses } from "../lib/firestore-channels.mjs";

const local = { kind: "local", projectId: "demo-bikeshed", firestoreUrl: "http://127.0.0.1:38001" };
test("response retention is bounded and waits for inspector setup", async () => {
  let release, finished = false;
  const calls = [], page = {};
  const context = { newCDPSession: async p => {
    assert.ok(p === page);
    return { send: async (...args) => { calls.push(args); await new Promise(r => { release = r; }); } };
  } };
  const pending = preserveFirestoreResponses(local, context, page).then(() => { finished = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(finished, false, "navigation must wait for response retention setup");
  assert.deepEqual(calls, [["Network.enable", {
    maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 65536, enableDurableMessages: true,
  }]]);
  release(); await pending;
  assert.equal(finished, true);
});

test("response retention never attaches to remote or non-demo targets", async () => {
  let calls = 0;
  const context = { newCDPSession: async () => { calls++; throw Error("unexpected inspector attachment"); } };
  for (const target of [null, { ...local, kind: "prod" }, { ...local, projectId: "another-project" },
    { ...local, firestoreUrl: "https://127.0.0.1:38001" }, { ...local, firestoreUrl: "http://remote.example:38001" }]) {
    await preserveFirestoreResponses(target, context, {});
  }
  assert.equal(calls, 0);
});

for (const tab of [false, true]) test(`finite handshake survives navigation in a ${tab ? "secondary tab" : "primary page"}`, { timeout: 120_000 }, async () => {
  const text = JSON.stringify([[0, ["c", "session==", "", 8, 12, 30000]]]);
  const handshake = `${text.length}\n${text}`;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const listen = req.url.startsWith("/finite-handshake");
      res.writeHead(200, { "content-type": listen ? "text/plain" : "text/html", "cache-control": "no-store" });
      res.end(listen ? handshake : "<!doctype html><title>navigation probe</title>");
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const target = { ...local, runId: `response-retention-${tab}`, origin, firestoreUrl: origin,
    stack: { ports: { hosting: server.address().port, firestore: server.address().port } }, capabilities: new Set(["local"]) };
  const previous = process.env.E2E_RTDB_COVERAGE_RECYCLE;
  process.env.E2E_RTDB_COVERAGE_RECYCLE = "1";
  const pool = new BrowserPool({ target });
  try {
    const first = await pool.user({ name: "reader" });
    const actor = tab ? await first.newTab() : first;
    const page = actor.page;
    await page.goto(origin);
    const response = page.waitForResponse(r => r.url().includes("/finite-handshake"));
    // A neutral path prevents the ordinary Listen observer from pre-reading
    // and caching the body; the inspector must first read it after navigation.
    await page.evaluate(async () => { await (await fetch("/finite-handshake")).text(); });
    const captured = await response;
    await page.goto(`${origin}/next`);
    assert.equal(await captured.text(), handshake, "navigation must not destroy the captured finite handshake body");
  } finally {
    await pool.close();
    if (previous === undefined) delete process.env.E2E_RTDB_COVERAGE_RECYCLE; else process.env.E2E_RTDB_COVERAGE_RECYCLE = previous;
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
});
