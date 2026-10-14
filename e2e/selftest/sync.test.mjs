// SPDX-License-Identifier: Apache-2.0
// Self-test: the barriers really overlap requests; the overlap proof and spread verdict catch serial and queued ones (SPEC §12).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { launchChrome } from "../lib/browser.mjs";
import { holdRequests, overlapProof, requireConclusive, spreadVerdict, syncActors, syncHttp, syncPages } from "../lib/sync.mjs";

const hr = () => performance.timeOrigin + performance.now();

/**
 * A server that answers after `delayMs`, recording when each request arrived.
 * Under /slowbody/ it sends the headers and a first chunk after `delayMs` but
 * ends the body only `bodyMs` later, so the browser's socket stays busy well
 * past the first byte. The favicon is answered at once, so it never holds a
 * socket.
 */
async function slowServer(delayMs, bodyMs = 600) {
  const arrivals = [];
  const server = http.createServer((req, res) => {
    const at = hr();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/favicon.ico") return res.writeHead(404).end();
      arrivals.push({ at, url: req.url, method: req.method, body });
      setTimeout(() => {
        res.setHeader("content-type", "text/plain");
        res.setHeader("access-control-allow-origin", "*");
        if (!req.url.startsWith("/slowbody/")) return res.end(`ok ${req.url}`);
        res.write(`ok ${req.url}`);
        setTimeout(() => res.end(), bodyMs);
      }, req.url.startsWith("/warm") ? 0 : delayMs);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, arrivals, close: () => new Promise((r) => server.close(r)) };
}

let srv;
before(async () => {
  srv = await slowServer(150);
});
after(async () => srv?.close());

test("overlapProof: true only when every send precedes every first byte", () => {
  assert.equal(overlapProof([{ sentAt: 1, firstByteAt: 10 }, { sentAt: 3, firstByteAt: 9 }]).ok, true);
  const serial = overlapProof([{ sentAt: 1, firstByteAt: 5 }, { sentAt: 6, firstByteAt: 9 }]);
  assert.equal(serial.ok, false, "NEGATIVE: a request sent after another's answer began is not an overlap");
  assert.equal(serial.marginMs, -1);
  assert.equal(serial.reason, "no-overlap");
  const unmeasured = overlapProof([{ sentAt: 1, firstByteAt: 9 }, { sentAt: 1 }]);
  assert.deepEqual([unmeasured.ok, unmeasured.reason], [false, "unmeasured"], "NEGATIVE: a record without timing proves nothing");
  assert.equal(overlapProof([]).reason, "unmeasured");
});

test("requireConclusive ends a race INCONCLUSIVE on a wide spread or an unproven overlap, and lets a proven one through", () => {
  const ctx = { inconclusive: (reason) => { const e = new Error(reason); e.code = "E2E_INCONCLUSIVE"; throw e; } };
  assert.doesNotThrow(() => requireConclusive(ctx, { spread: spreadVerdict([1, 5]), overlap: overlapProof([{ sentAt: 1, firstByteAt: 9 }]) }));
  assert.throws(() => requireConclusive(ctx, { spread: spreadVerdict([1, 30]) }), /fire spread 29\.0 ms > 15 ms/);
  assert.throws(() => requireConclusive(ctx, { overlap: overlapProof([{ sentAt: 1 }]) }), /overlap proof: unmeasured/);
  assert.throws(() => requireConclusive(ctx, { overlap: overlapProof([{ sentAt: 1, firstByteAt: 5 }, { sentAt: 6, firstByteAt: 9 }]) }), /overlap proof: no-overlap/);
});

test("spreadVerdict: over the limit is INCONCLUSIVE", () => {
  assert.equal(spreadVerdict([100, 104, 112], "http").verdict, "CONCLUSIVE");
  assert.equal(spreadVerdict([100, 116], "http").verdict, "INCONCLUSIVE");
  assert.equal(spreadVerdict([100, 139], "browser").verdict, "CONCLUSIVE");
  assert.equal(spreadVerdict([100, 141], "browser").verdict, "INCONCLUSIVE");
  assert.equal(spreadVerdict([], "http").conclusive, false);
});

test("syncHttp fires N worker threads together: tight spread, server sees them overlap, proof holds", async () => {
  const n = 8;
  const base = srv.arrivals.length;
  const run = await syncHttp(
    Array.from({ length: n }, (_, i) => ({ url: `${srv.url}/race/${i}`, method: "POST", headers: { "content-type": "application/json" }, body: { i }, warm: `${srv.url}/warm/${i}` })),
  );
  assert.equal(run.results.length, n);
  for (const r of run.results) assert.equal(r.status, 200, JSON.stringify(r));
  assert.ok(run.spreadMs < 15, `fire spread ${run.spreadMs.toFixed(2)} ms`);
  assert.equal(run.verdict, "CONCLUSIVE");
  assert.equal(run.overlap.ok, true, JSON.stringify(run.overlap));
  const races = srv.arrivals.slice(base).filter((a) => a.url.startsWith("/race/"));
  assert.equal(races.length, n);
  const arrivalSpread = Math.max(...races.map((a) => a.at)) - Math.min(...races.map((a) => a.at));
  assert.ok(arrivalSpread < 50, `the server saw all ${n} within ${arrivalSpread.toFixed(1)} ms, well inside its 150 ms answer delay`);
  assert.deepEqual(races.map((a) => JSON.parse(a.body).i).sort((a, b) => a - b), [...Array(n).keys()]);
});

test("the barrier holds actors whose preparation ends 0–300 ms apart, and releases them together", async () => {
  const helper = new URL("./helpers/slow-actor.mjs", import.meta.url).href;
  const run = await syncActors(
    [0, 100, 200, 300].map((ms, i) => ({ module: helper, prepare: "prepare", fn: "fire", arg: { i, prepareMs: ms } })),
    { kind: "http" },
  );
  const prepared = run.results.map((r) => r.result.preparedAt);
  assert.ok(Math.max(...prepared) - Math.min(...prepared) >= 250, "the actors really were ready at different times");
  assert.ok(run.spreadMs < 15, `yet they fired within ${run.spreadMs.toFixed(2)} ms of each other`);
  assert.ok(run.results.every((r) => r.firedAt >= Math.max(...prepared)), "nobody fired before the last one was ready");
});

test("NEGATIVE: the same requests sent one after another fail the overlap proof", async () => {
  const rows = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await syncHttp([{ url: `${srv.url}/serial/${i}` }]);
    rows.push(r.results[0]);
  }
  assert.equal(overlapProof(rows).ok, false, JSON.stringify(overlapProof(rows)));
});

test("syncPages fires three pages within the browser limit, and holdRequests releases N held requests together", async () => {
  const { browser } = await launchChrome();
  try {
    const ctx = await browser.newContext();
    const pages = await Promise.all([0, 1, 2].map(() => ctx.newPage()));
    await Promise.all(pages.map((p) => p.goto(`${srv.url}/warm/page`)));
    // Best of three measurements. What this proves is that the barrier CAN
    // fire three pages within the browser limit; one slow measurement on a
    // loaded machine is exactly what a real race reports as INCONCLUSIVE
    // (the pure spreadVerdict test above stays strict). Every attempt must
    // still be correct — each page's own result, and never a fire BEFORE t0,
    // which is what a missing barrier looks like — and at least one attempt
    // must be inside the limit, with every page fired within it of t0. A
    // barrier that is broken or sloppy is over the limit every time.
    const attempts = [];
    for (let k = 0; k < 3; k += 1) {
      const fired = await syncPages(pages, (arg) => `fired ${arg}`, { arg: (i) => i });
      assert.deepEqual(fired.fires.map((f) => f.result), ["fired 0", "fired 1", "fired 2"]);
      assert.ok(fired.fires.every((f) => f.lateMs >= 0), `no page fires before t0: ${JSON.stringify(fired.fires)}`);
      attempts.push(fired);
      if (fired.spreadMs < 40 && fired.fires.every((f) => f.lateMs < 40)) break;
    }
    const best = attempts.find((f) => f.spreadMs < 40 && f.fires.every((x) => x.lateMs < 40));
    assert.ok(best, `no attempt of ${attempts.length} fired within 40 ms: spreads ${attempts.map((f) => f.spreadMs.toFixed(1)).join(", ")} ms; late ${attempts.map((f) => Math.max(...f.fires.map((x) => x.lateMs)).toFixed(1)).join(", ")} ms`);
    assert.equal(best.verdict, "CONCLUSIVE");

    // SYNC-H: three pages each fetch; nothing reaches the server until release.
    const base = srv.arrivals.length;
    const hold = holdRequests(ctx, "**/held/**", 3);
    await hold.installed;
    const fetches = pages.map((p, i) => p.evaluate((u) => fetch(u).then((r) => r.text()), `${srv.url}/held/${i}`));
    const recs = await hold.held;
    assert.equal(recs.length, 3);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(srv.arrivals.slice(base).filter((a) => a.url.startsWith("/held/")).length, 0, "held means held: the server saw nothing yet");
    const released = await hold.release();
    assert.deepEqual((await Promise.all(fetches)).sort(), ["ok /held/0", "ok /held/1", "ok /held/2"]);
    const arrived = srv.arrivals.slice(base).filter((a) => a.url.startsWith("/held/"));
    assert.equal(arrived.length, 3);
    assert.ok(Math.max(...arrived.map((a) => a.at)) - Math.min(...arrived.map((a) => a.at)) < 50, "released together");
    assert.equal(released.overlap.ok, true, JSON.stringify(released));

    // NEGATIVE: one held request answered before the second is released.
    const first = holdRequests(ctx, "**/one/**", 1);
    const second = holdRequests(ctx, "**/two/**", 1);
    await Promise.all([first.installed, second.installed]);
    const f1 = pages[0].evaluate((u) => fetch(u).then((r) => r.text()), `${srv.url}/one/0`);
    const f2 = pages[1].evaluate((u) => fetch(u).then((r) => r.text()), `${srv.url}/two/0`);
    await Promise.all([first.held, second.held]);
    const r1 = await first.release();
    await f1;
    const r2 = await second.release();
    await f2;
    const sequential = overlapProof([...r1.records, ...r2.records]);
    assert.equal(sequential.ok, false, `NEGATIVE: released one after the other's answer is not an overlap: ${JSON.stringify(sequential)}`);
    assert.equal(sequential.reason, "no-overlap");

    // NEGATIVE: waiting for 3 when only 2 come is a timeout, not a silent pass.
    const short = holdRequests(ctx, "**/short/**", 3, { timeoutMs: 800 });
    await short.installed;
    const two = pages.slice(0, 2).map((p, i) => p.evaluate((u) => fetch(u).then((r) => r.text()), `${srv.url}/short/${i}`));
    await assert.rejects(short.held, (e) => e.code === "E2E_SYNC_TIMEOUT" && e.held === 2);
    await short.release();
    await Promise.all(two);
  } finally {
    await browser.close();
  }
});

test("NEGATIVE: a request the browser queued behind six busy sockets is sent late, and the proof says so", async () => {
  // Chrome opens at most 6 HTTP/1.1 connections per host. Seven requests
  // released together: six go out at once, the seventh waits until one of
  // their slow bodies ends — long after the first bytes came back. Measured
  // at route.continue() (the old way) all seven "were sent" before any first
  // byte and the proof passed; measured on the browser's wire it must fail.
  const { browser } = await launchChrome();
  try {
    const ctx = await browser.newContext();
    const pages = await Promise.all([...Array(7)].map(() => ctx.newPage()));
    await Promise.all(pages.map((p) => p.goto(`${srv.url}/warm/q`)));
    const base = srv.arrivals.length;
    const hold = holdRequests(ctx, "**/slowbody/**", 7);
    await hold.installed;
    const fetches = pages.map((p, i) => p.evaluate((u) => fetch(u).then((r) => r.text()), `${srv.url}/slowbody/${i}`));
    await hold.held;
    const released = await hold.release();
    await Promise.all(fetches);
    const arrived = srv.arrivals.slice(base).filter((a) => a.url.startsWith("/slowbody/")).map((a) => a.at).sort((a, b) => a - b);
    assert.equal(arrived.length, 7);
    assert.ok(arrived[6] - arrived[0] > 300, `the server saw the seventh ${(arrived[6] - arrived[0]).toFixed(0)} ms after the first: it really was queued`);
    for (const r of released.records) assert.ok(Number.isFinite(r.sentAt) && Number.isFinite(r.firstByteAt), `measured: ${JSON.stringify(r)}`);
    assert.equal(released.overlap.ok, false, `queued means not overlapped: ${JSON.stringify(released.overlap)}`);
    assert.equal(released.overlap.reason, "no-overlap");
    const latest = Math.max(...released.records.map((r) => r.sentAt));
    const earliestRelease = Math.min(...released.records.map((r) => r.releasedAt));
    assert.ok(latest - earliestRelease > 300, `the late send is on the browser's clock (${(latest - earliestRelease).toFixed(0)} ms after release), not the release time`);
  } finally {
    await browser.close();
  }
});
