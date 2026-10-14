// SPDX-License-Identifier: Apache-2.0
// Self-test: syncHttp with a target checks every request and warm-up for isolation, asks the guard before any worker exists, and traces each sent hop into the case's sink (SPEC §12).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { LEAK_RE, REDACTED, agentName, pendingRequests, withEvidenceSink } from "../lib/http.mjs";
import { appendLedger } from "../lib/ledger.mjs";
import { syncHttp } from "../lib/sync.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const hr = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BSK = `bsk_${"a".repeat(32)}.${"S".repeat(30)}`;
/** A response header NAME shaped like a credential: redactHeaders redacts values only, so its row can never be written. */
const LEAKY_HEADER = `bsk_${"c".repeat(32)}.leakleakleak`;

/**
 * A server that records every request (arrival time, headers, body) and
 * answers: /warm/* at once; /race/* after 150 ms; /hold/* and /holdwarm/*
 * only when released; /secret/* with a credential in its JSON; /leak/* with a
 * credential-shaped header name; /reset/* by destroying the socket.
 */
async function recordingServer() {
  const arrivals = [];
  const held = [];
  const server = http.createServer((req, res) => {
    const at = hr();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      arrivals.push({ at, url: req.url, method: req.method, headers: req.headers, body });
      const answer = () => {
        if (res.destroyed) return;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, url: req.url }));
      };
      if (req.url.startsWith("/reset/")) return req.socket.destroy();
      if (req.url.startsWith("/hold/") || req.url.startsWith("/holdwarm/")) return held.push({ url: req.url, answer });
      if (req.url.startsWith("/secret/")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ token: "tok-secret-value-123", note: `Bearer ${BSK}` }));
      }
      if (req.url.startsWith("/leak/")) {
        res.setHeader(LEAKY_HEADER, "1");
        return answer();
      }
      setTimeout(answer, req.url.startsWith("/race/") ? 150 : 0);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    arrivals,
    held,
    releaseHeld(prefix) {
      for (let k = held.length - 1; k >= 0; k -= 1) {
        if (held[k].url.startsWith(prefix)) held.splice(k, 1)[0].answer();
      }
    },
    close: () => new Promise((r) => {
      for (const h of held.splice(0)) h.answer();
      server.closeAllConnections?.();
      server.close(r);
    }),
  };
}

let srv;
let other;
before(async () => {
  srv = await recordingServer();
  other = await recordingServer();
});
after(async () => {
  await srv?.close();
  await other?.close();
});

const localTarget = () => Object.freeze({ kind: "local", runId: "2610131200-sync", origin: srv.url, runDir: tempDir("e2e-sync-local-"), stack: { ports: { hosting: srv.port } } });
/** A guard that answers allow and remembers each question, and when it was asked. */
function recordingGuard(answer = () => ({ allow: true, rule: "test" })) {
  const asked = [];
  return { asked, check: async (req) => (asked.push({ ...req, at: hr() }), answer(req)) };
}
const since = (s, n) => s.arrivals.slice(n);
const rowsOf = (lines) => lines.map((l) => JSON.parse(l));

test("a guarded syncHttp asks about every warm-up and request before anything is sent, adds the agent headers, and traces one redacted row per hop", async () => {
  const target = localTarget();
  const guard = recordingGuard();
  const lines = [];
  const base = srv.arrivals.length;
  const n = 4;
  const requests = Array.from({ length: n }, (_, i) => ({
    url: `${srv.url}/race/${i}`,
    method: "post",
    headers: { "content-type": "application/json", authorization: `Bearer ${BSK}`, cookie: "__session=SECRETSECRETSECRET1234", ...(i === 3 ? { "User-Agent": "custom-ua" } : {}) },
    body: { i },
    warm: `${srv.url}/warm/${i}`,
  }));
  const run = await syncHttp(requests, { target, guard, evidence: (line) => lines.push(line) });

  assert.equal(run.guarded, true);
  assert.deepEqual(run.results.map((r) => r.status), [200, 200, 200, 200]);
  assert.equal(run.verdict, "CONCLUSIVE", `spread ${run.spreadMs} ms`);
  assert.equal(run.overlap.ok, true, JSON.stringify(run.overlap));

  // The guard was asked about each hop, warm-up first, with what is then sent.
  assert.deepEqual(guard.asked.map((q) => `${q.method} ${new URL(q.url).pathname}`), requests.flatMap((_, i) => [`GET /warm/${i}`, `POST /race/${i}`]));
  for (const q of guard.asked) {
    assert.equal(q.headers["x-bikeshed-agent"], agentName(target), "the guard sees the agent header that is sent");
    assert.equal(q.actor, "sync");
  }
  assert.deepEqual(guard.asked.filter((q) => q.method === "POST").map((q) => q.body), requests.map((r) => r.body));
  const got = since(srv, base);
  assert.equal(got.length, 2 * n, "every warm-up and request arrived");
  const firstArrival = Math.min(...got.map((a) => a.at));
  assert.ok(Math.max(...guard.asked.map((q) => q.at)) < firstArrival, "every question was asked before the first byte went out");

  // The agent headers on every hop; a request's own User-Agent wins, the agent header is still added.
  for (const a of got) {
    assert.equal(a.headers["x-bikeshed-agent"], agentName(target), `${a.url} carries X-Bikeshed-Agent`);
    assert.equal(a.headers["user-agent"], a.url === "/race/3" ? "custom-ua" : agentName(target), `${a.url}'s User-Agent`);
  }
  assert.deepEqual(got.filter((a) => a.method === "POST").map((a) => JSON.parse(a.body).i).sort(), [0, 1, 2, 3]);

  // One row per hop: the warm-up, then the request, for each actor; redacted.
  const rows = rowsOf(lines);
  assert.equal(rows.length, 2 * n, lines.join("\n"));
  for (const line of lines) assert.doesNotMatch(line, LEAK_RE, "no credential shape survives");
  for (let i = 0; i < n; i += 1) {
    const warm = rows.find((r) => r.sync?.i === i && r.sync.warm === true);
    const fired = rows.find((r) => r.sync?.i === i && r.sync.warm === false);
    assert.ok(warm && fired, `actor ${i} has both rows`);
    assert.deepEqual([warm.method, new URL(warm.url).pathname, warm.status, warm.actor], ["GET", `/warm/${i}`, 200, "sync"]);
    assert.deepEqual([fired.method, new URL(fired.url).pathname, fired.status, fired.actor], ["POST", `/race/${i}`, 200, "sync"]);
    assert.ok(Number.isFinite(warm.ms) && Number.isFinite(fired.ms) && fired.ms >= 100, `ms ${warm.ms} / ${fired.ms}`);
    assert.ok(Number.isFinite(Date.parse(fired.t)) && Number.isFinite(fired.sync.sentAt) && Number.isFinite(fired.sync.firstByteAt), "the wire times are in the row");
    assert.equal(fired.reqHeaders.authorization, `Bearer bsk_${"a".repeat(32)}.${REDACTED}`);
    assert.equal(fired.reqHeaders.cookie, `__session=${REDACTED}`);
    assert.deepEqual(JSON.parse(fired.reqBody), { i });
    assert.equal(JSON.parse(fired.resBody).url, `/race/${i}`);
    assert.ok(Date.parse(warm.t) <= Date.parse(fired.t), "the warm-up's row starts first");
  }
});

test("the rows reach the running case's sink, and the warm-ups, then the requests, are pending while they are in flight", async () => {
  const target = localTarget();
  const caseLines = [];
  const caseSink = (line) => caseLines.push(line);
  const n = 2;
  const requests = Array.from({ length: n }, (_, i) => ({ url: `${srv.url}/hold/${i}`, method: "POST", body: "x", warm: `${srv.url}/holdwarm/${i}`, actor: `racer-${i}` }));
  await withEvidenceSink(caseSink, async () => {
    const pending = syncHttp(requests, { target });
    const wait = async (prefix) => {
      for (let k = 0; k < 400 && srv.held.filter((h) => h.url.startsWith(prefix)).length < n; k += 1) await sleep(10);
      assert.equal(srv.held.filter((h) => h.url.startsWith(prefix)).length, n, `${prefix} held at the server`);
    };
    await wait("/holdwarm/");
    assert.deepEqual(pendingRequests(caseSink).map((h) => `${h.actor} ${h.method} ${new URL(h.url).pathname}`).sort(), ["racer-0 GET /holdwarm/0", "racer-1 GET /holdwarm/1"], "the warm-ups are in flight");
    srv.releaseHeld("/holdwarm/");
    await wait("/hold/");
    assert.deepEqual(pendingRequests(caseSink).map((h) => `${h.actor} ${h.method} ${new URL(h.url).pathname}`).sort(), ["racer-0 POST /hold/0", "racer-1 POST /hold/1"], "the requests are in flight, the warm-ups no longer");
    srv.releaseHeld("/hold/");
    const run = await pending;
    assert.deepEqual(run.results.map((r) => r.status), [200, 200]);
  });
  assert.deepEqual(pendingRequests(caseSink), [], "nothing is pending once answered");
  const rows = rowsOf(caseLines);
  assert.deepEqual(rows.map((r) => `${r.actor} ${r.method} ${new URL(r.url).pathname} ${r.status}`), ["racer-0 GET /holdwarm/0 200", "racer-0 POST /hold/0 200", "racer-1 GET /holdwarm/1 200", "racer-1 POST /hold/1 200"]);
});

test("isolation: a request or a warm-up off the stack's ports throws E2E_ISOLATION before the guard is asked, and nothing at all is sent", async () => {
  const target = localTarget();
  for (const bad of [
    [{ url: `${srv.url}/race/a`, warm: `${srv.url}/warm/a` }, { url: `${other.url}/race/b` }],
    [{ url: `${srv.url}/race/a` }, { url: `${srv.url}/race/b`, warm: `${other.url}/warm/b` }],
  ]) {
    const guard = recordingGuard();
    const base = [srv.arrivals.length, other.arrivals.length];
    await assert.rejects(syncHttp(bad, { target, guard, evidence: false }), (e) => e.code === "E2E_ISOLATION");
    assert.equal(guard.asked.length, 0, "the guard was never asked");
    await sleep(50);
    assert.deepEqual([srv.arrivals.length, other.arrivals.length], base, "nothing was sent anywhere");
  }
  const base = other.arrivals.length;
  const run = await syncHttp([{ url: `${other.url}/race/c` }], { target, evidence: false, allowPorts: [other.port] });
  assert.equal(run.results[0].status, 200, "an explicitly allowed port goes");
  assert.equal(other.arrivals.length, base + 1);
});

test("production: the real guard refuses an email route, a document the run does not own and a refused warm-up, with nothing sent; the run's own document goes", async () => {
  const prod = Object.freeze({ kind: "prod", runId: "selftest-sync", origin: srv.url, runDir: tempDir("e2e-sync-prod-") });
  appendLedger(prod, { kind: "doc", docId: "ours" });
  const tool = (id, n) => ({ url: `${srv.url}/mcp`, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name: "update_document", arguments: { id, content: "<p>x</p>", baseVersion: "v1" } } }), warm: `${srv.url}/warm/p${n}` });
  const cases = [
    { what: "POST /access", requests: [tool("ours", 1), { url: `${srv.url}/access`, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ docId: "ours", email: "x@example.com" }) }], rule: "access" },
    { what: "update_document on another's document", requests: [tool("ours", 1), tool("not-ours", 2)], rule: "ledger" },
    { what: "a warm-up on /verify", requests: [tool("ours", 1), { ...tool("ours", 2), warm: `${srv.url}/verify/code` }], rule: "verify" },
  ];
  for (const c of cases) {
    const lines = [];
    const base = srv.arrivals.length;
    await assert.rejects(syncHttp(c.requests, { target: prod, evidence: (l) => lines.push(l) }), (e) => e.code === "E2E_GUARD" && e.rule === c.rule && /nothing was sent/.test(e.message), c.what);
    await sleep(50);
    assert.equal(srv.arrivals.length, base, `${c.what}: nothing was sent, not even the allowed requests' warm-ups`);
    const rows = rowsOf(lines);
    assert.equal(rows.length, 1, `${c.what}: one row, the refusal`);
    assert.deepEqual([rows[0].guard?.refused, rows[0].guard?.rule], [true, c.rule]);
  }
  const lines = [];
  const base = srv.arrivals.length;
  const run = await syncHttp([tool("ours", 1), tool("ours", 2)], { target: prod, evidence: (l) => lines.push(l) });
  assert.deepEqual(run.results.map((r) => r.status), [200, 200], "the run's own document is updated");
  assert.equal(srv.arrivals.length, base + 4);
  assert.equal(rowsOf(lines).length, 4);
});

test("unguarded (no target): a request or a warm-up that is not loopback is refused before anything is sent; loopback goes exactly as before", async () => {
  const base = srv.arrivals.length;
  for (const bad of [
    [{ url: `${srv.url}/race/u` }, { url: `http://0.0.0.0:${srv.port}/race/v` }],
    [{ url: `${srv.url}/race/u`, warm: `http://127.0.0.2:${srv.port}/warm/v` }],
  ]) {
    await assert.rejects(syncHttp(bad), (e) => e.code === "E2E_GUARD" && e.rule === "sync-unguarded" && /nothing was sent/.test(e.message));
  }
  await sleep(50);
  assert.equal(srv.arrivals.length, base, "nothing was sent");
  const run = await syncHttp([{ url: `${srv.url}/race/old`, method: "POST", headers: { "content-type": "application/json" }, body: { i: 1 }, warm: `${srv.url}/warm/old` }]);
  assert.deepEqual(Object.keys(run).sort(), ["conclusive", "limit", "overlap", "releasedAt", "results", "spreadMs", "verdict"], "the result's keys are the old ones");
  assert.deepEqual(Object.keys(run.results[0]).sort(), ["body", "endAt", "firedAt", "firstByteAt", "headers", "i", "method", "sentAt", "startAt", "status", "url"]);
  const got = since(srv, base);
  assert.deepEqual(got.map((a) => a.url), ["/warm/old", "/race/old"]);
  assert.ok(got.every((a) => a.headers["x-bikeshed-agent"] === undefined), "no header is added to an unguarded run");
});

test("a Buffer body is sent as its bytes, guarded or not (a Buffer reaches a worker as a plain Uint8Array)", async () => {
  const text = "héllo ✓ bytes";
  const base = srv.arrivals.length;
  await syncHttp([{ url: `${srv.url}/race/buf`, method: "POST", headers: { "content-type": "text/plain" }, body: Buffer.from(text) }]);
  const guard = recordingGuard();
  const lines = [];
  await syncHttp([{ url: `${srv.url}/race/buf2`, method: "POST", headers: { "content-type": "text/plain" }, body: Buffer.from(text) }], { target: localTarget(), guard, evidence: (l) => lines.push(l) });
  assert.deepEqual(since(srv, base).map((a) => a.body), [text, text]);
  assert.equal(Buffer.from(guard.asked[0].body).toString("utf8"), text, "the guard saw those bytes");
  assert.equal(rowsOf(lines)[0].reqBody, text);
});

test("credentials in an answer are redacted in its row; a row that cannot be redacted is withheld, the others written, and E2E_REDACTION thrown", async () => {
  const target = localTarget();
  const lines = [];
  await syncHttp([{ url: `${srv.url}/secret/1` }], { target, evidence: (l) => lines.push(l) });
  const [row] = rowsOf(lines);
  assert.equal(JSON.parse(row.resBody).token, REDACTED);
  assert.doesNotMatch(lines[0], LEAK_RE);
  lines.length = 0;
  await assert.rejects(syncHttp([{ url: `${srv.url}/race/l0`, warm: `${srv.url}/warm/l0` }, { url: `${srv.url}/leak/l1` }], { target, evidence: (l) => lines.push(l) }), (e) => e.code === "E2E_REDACTION");
  assert.deepEqual(rowsOf(lines).map((r) => new URL(r.url).pathname), ["/warm/l0", "/race/l0"], "every other row is written");
  for (const l of lines) assert.doesNotMatch(l, LEAK_RE);
});

test("a hop that fails on the wire is traced with its error: a warm-up's (its actor never fires), a request's", async () => {
  const target = localTarget();
  const lines = [];
  const base = srv.arrivals.length;
  const run = await syncHttp([{ url: `${srv.url}/race/f0`, warm: `${srv.url}/reset/w` }, { url: `${srv.url}/reset/f1` }], { target, evidence: (l) => lines.push(l) });
  assert.match(run.results[0].error, /^prepare failed: /);
  assert.equal(typeof run.results[1].error, "string");
  assert.ok(!since(srv, base).some((a) => a.url === "/race/f0"), "the actor whose warm-up failed never sent its request");
  const rows = rowsOf(lines);
  assert.deepEqual(rows.map((r) => `${r.method} ${new URL(r.url).pathname} ${r.sync.warm} ${typeof r.error}`), ["GET /reset/w true string", "GET /reset/f1 false string"]);
});

test("mistakes are TypeErrors, before anything is sent", async () => {
  const target = localTarget();
  const base = srv.arrivals.length;
  const r = [{ url: `${srv.url}/race/t` }];
  await assert.rejects(syncHttp(r, { target, guard: false }), TypeError, "the guard cannot be turned off for a target");
  await assert.rejects(syncHttp(r, { target, guard: {} }), TypeError);
  await assert.rejects(syncHttp(r, { target, evidence: 42 }), TypeError);
  await assert.rejects(syncHttp(r, { target, actor: "" }), TypeError);
  await assert.rejects(syncHttp(r, { target, allowPorts: ["x"] }), TypeError);
  await assert.rejects(syncHttp(r, { target: { kind: "local" } }), TypeError);
  await assert.rejects(syncHttp([{ method: "GET" }], { target }), TypeError);
  for (const k of ["guard", "evidence", "actor", "allowPorts"]) {
    await assert.rejects(syncHttp(r, { [k]: k === "allowPorts" ? [1] : k === "guard" ? true : k === "evidence" ? false : "a" }), (e) => e instanceof TypeError && /need/.test(e.message), `${k} without a target`);
  }
  await assert.rejects(syncHttp("nope"), TypeError);
  await sleep(30);
  assert.equal(srv.arrivals.length, base, "nothing was sent");
});
