// SPDX-License-Identifier: Apache-2.0
// Self-test: User.capture's waitInTurn waits on a page's chain of requests as it goes, judging each answer, and fails only on a page gone idle (SPEC §12).

/**
 * Hermetic: a local server stands in for the app's review endpoints. POST
 * /suggestion and POST /draft answer after the body's `ms` with its `status`
 * (200 by default); op `hold` answers nothing until the test lets it go, op
 * `partial` sends its headers and part of a body and holds the rest. The
 * page sends a chain as the review bar does, each request once the previous
 * one's body is read, with `gap` ms of its own work before the next. The
 * cut-off is Hosting's 504 after 59 s: no test waits that long, it moves a
 * row's `sentAt` back instead, which is what isHostingCutoff measures from,
 * or, for the default `unansweredMs`, this process's clock on, with a context
 * made here in place of the browser's.
 * Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool, User } from "../lib/browser.mjs";
import { HOSTING_CUTOFF_MS, pageStall, stackDidNotAnswer } from "../lib/test.mjs";

const held = [];
let server;
let target;
before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>app</title><p>app</p>");
        return;
      }
      let b = {};
      try {
        b = JSON.parse(body) ?? {};
      } catch {}
      if (b.op === "hold") return void held.push({ res, partial: false });
      if (b.op === "partial") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"partial": ');
        held.push({ res, partial: true });
        return;
      }
      setTimeout(() => {
        res.writeHead(b.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ op: b.op ?? null, path: req.url }));
      }, b.ms ?? 0);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-in-turn", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});
after(async () => {
  release();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

/** Let every held request finish. */
function release() {
  for (const { res, partial } of held.splice(0)) {
    if (partial) res.end("1}");
    else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"released": true}');
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const label = (r) => (r.op ? `${r.path}:${r.op}` : r.path);

/** In the page, without waiting for it: POST each step in turn, each once the previous answer's body is read, then `gap` ms of the page's own work. */
const chain = (page, steps) =>
  page.evaluate((steps) => {
    window.__chain = (async () => {
      for (const [path, body, gap = 0] of steps) {
        const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        await r.text();
        if (gap) await new Promise((res) => setTimeout(res, gap));
      }
    })().catch(() => {});
  }, steps);

/** `p`'s outcome, {value} or {error}, or {late: true} when it has not settled within `ms`. */
const within = (p, ms) => Promise.race([p.then((value) => ({ value }), (error) => ({ error })), sleep(ms).then(() => ({ late: true }))]);

async function withUser(fn) {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user({ name: "v" });
    await u.goto("/");
    await fn(u);
  } finally {
    release();
    await pool.close();
  }
}

test("waitInTurn: an accept behind a slow claim, a slow POST /draft and the page's own work between them is waited for well past idleMs", async () => {
  await withUser(async (u) => {
    const rows = u.capture({ paths: ["/suggestion", "/draft"] });
    const mark = rows.mark();
    const t0 = performance.now();
    await chain(u.page, [
      ["/suggestion", { op: "claim", ms: 700 }, 250],
      ["/draft", { ms: 700 }, 250],
      ["/suggestion", { op: "accept", ms: 50 }],
    ]);
    // The single deadline waitFor has runs out while the page is still working.
    await assert.rejects(rows.waitFor({ op: "accept" }, { since: mark, timeout: 400 }), /no settled captured request within 400 ms: none matched/);
    const acc = await rows.waitInTurn({ op: "accept" }, { since: mark, idleMs: 400, unansweredMs: 10_000, what: "Accept" });
    const took = performance.now() - t0;
    assert.deepEqual([acc.op, acc.status, acc.state, acc.settled], ["accept", 200, "finished", true], "the accept's row, settled");
    assert.deepEqual(rows.map(label), ["/suggestion:claim", "/draft", "/suggestion:accept"]);
    assert.ok(took >= 1_800, `the chain took its time (${Math.round(took)} ms), far past idleMs`);
    for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].sentAt - rows[i - 1].doneAt >= 150, `${label(rows[i])} came after the page's own ${Math.round(rows[i].sentAt - rows[i - 1].doneAt)} ms of work, with nothing in flight`);
    assert.equal(await rows.waitInTurn({ op: "claim" }, { since: mark }), rows[0], "a row already settled is returned at once: the first match since the mark");
    rows.stop();
  });
});

test("waitInTurn: a page that, with nothing in flight, sends nothing more fails 'within idleMs ms', a wait pageStall reads", async () => {
  await withUser(async (u) => {
    const rows = u.capture({ paths: ["/suggestion", "/draft"] });
    const mark = rows.mark();
    await chain(u.page, [["/suggestion", { op: "claim", ms: 100 }]]);
    await rows.waitFor({ op: "claim" }, { settled: false, timeout: 10_000 }); // sent: a slow machine is not the page idling
    const t0 = performance.now();
    const out = await within(rows.waitInTurn({ op: "accept" }, { since: mark, idleMs: 400, unansweredMs: 10_000, what: "Accept" }), 8_000);
    const took = performance.now() - t0;
    assert.ok(out.error, `it failed (${JSON.stringify(out)})`);
    const err = out.error;
    assert.equal(err.message, "v: Accept: the page sent nothing more within 400 ms, with none of its requests in flight (captured since 0: POST /suggestion:claim 200)");
    assert.ok(took >= 400 && took < 3_000, `it waited idleMs after the claim's answer, and no longer (${Math.round(took)} ms)`);
    assert.equal(err.code, undefined, "a page gone idle is no cut-off");
    assert.equal(stackDidNotAnswer(err), null, "and not the stack failing to answer");
    const cut = { name: "w", responses: [{ method: "POST", path: "/draft", status: 504, ms: 60_004, at: Date.now() - 1_000 }], log: { console: [], sdkProbes: [] } };
    assert.match(pageStall(err, { usersSoFar: [u, cut] }) ?? "", /a page's request got Hosting's cut-off 504 \(w: POST \/draft 504 after 60004 ms\), in the 10 s before a wait ran out/, "pageStall reads it as a wait of 400 ms");
    assert.equal(pageStall(err, { usersSoFar: [u] }), null, "and finds nothing to excuse it without a stall");
  });
});

test("waitInTurn: a response the page never finishes reading does not hold the wait open; a matched row that never settles says so", async () => {
  await withUser(async (u) => {
    const rows = u.capture({ paths: "/suggestion" });
    await chain(u.page, [["/suggestion", { op: "partial" }]]);
    await rows.waitFor({ op: "partial" }, { settled: false, timeout: 10_000 });
    const out = await within(rows.waitInTurn({ op: "partial" }, { idleMs: 400, unansweredMs: 10_000 }), 8_000);
    assert.ok(out.error, `it failed (${JSON.stringify(out)})`);
    assert.equal(out.error.message, "v: waitInTurn: #0 matched but had not settled (answered), and nothing changed within 400 ms, with none of its requests in flight (captured since 0: POST /suggestion:partial 200)");
    const open = await rows.waitInTurn({ op: "partial" }, { settled: false });
    assert.deepEqual([open.state, open.settled], ["answered", false], "settled: false takes it as it is");
  });
});

test("waitInTurn: a request with no answer for unansweredMs is the stack not answering, E2E_STACK_CUTOFF, however long the page has been idle otherwise", async () => {
  await withUser(async (u) => {
    const rows = u.capture({ paths: "/suggestion" });
    const mark = rows.mark();
    await chain(u.page, [["/suggestion", { op: "hold" }], ["/suggestion", { op: "accept" }]]);
    await rows.waitFor({ op: "hold" }, { settled: false, timeout: 10_000 });
    const t0 = performance.now();
    const out = await within(rows.waitInTurn({ op: "accept" }, { since: mark, idleMs: 300, unansweredMs: 900, what: "Accept" }), 8_000);
    const took = performance.now() - t0;
    assert.ok(out.error, `it failed (${JSON.stringify(out)})`);
    const err = out.error;
    assert.equal(err.code, "E2E_STACK_CUTOFF", `${err.message}`);
    assert.match(err.message, /^v's page's POST \/suggestion:hold \(#0, Accept\) got no answer in \d+ ms \(\d+ ms of them in this wait, which began after it was sent\), the wait's unansweredMs of 900 ms$/);
    assert.equal(err.stackCut, err.message);
    assert.equal(err.response, null, "nothing answered");
    assert.ok(took >= 850, `not before unansweredMs: the request in flight held the idle check off (${Math.round(took)} ms)`);
    assert.equal(stackDidNotAnswer(err), err.message, "the case's stack judge reads it");
  });
});

/**
 * A context the capture listens on, with requests made here: `send(op)` emits
 * a POST /suggestion and returns it, `answer(req, status)` its response.
 */
function fakeContext() {
  const on = new Map();
  const emit = (ev, x) => (on.get(ev) ?? []).forEach((fn) => fn(x));
  return {
    on: (ev, fn) => on.set(ev, [...(on.get(ev) ?? []), fn]),
    off: (ev, fn) => on.set(ev, (on.get(ev) ?? []).filter((f) => f !== fn)),
    send(op) {
      const body = JSON.stringify({ op });
      const req = { method: () => "POST", url: () => "http://127.0.0.1:9/suggestion", postData: () => body, resourceType: () => "fetch", failure: () => null };
      emit("request", req);
      return req;
    },
    answer(req, status = 200) {
      emit("response", { request: () => req, status: () => status });
    },
  };
}

test("waitInTurn: unansweredMs is Hosting's cut-off and 16 s by default, counted from the later of the send and the wait's start", async () => {
  assert.equal(HOSTING_CUTOFF_MS + 16_000, 75_000);
  // This process's clock, moved on by hand: capture rows and waitInTurn both read performance.now().
  const real = performance.now.bind(performance);
  let skew = 0;
  performance.now = () => real() + skew;
  try {
    const context = fakeContext();
    const rows = User.prototype.capture.call({ name: "v", context }, { paths: "/suggestion" });
    context.send("held"); // as a request the case holds: sent long before the wait
    skew += 80_000;
    const p = rows.waitInTurn({ op: "accept" }, { idleMs: 50, what: "Accept" });
    assert.deepEqual(await within(p, 300), { late: true }, "sent 80 s ago, but the wait has just begun: not yet the stack's");
    skew += 74_000;
    assert.deepEqual(await within(p, 300), { late: true }, "74 s into the wait: not yet");
    skew += 2_000;
    const out = await within(p, 2_000);
    assert.ok(out.error, `it failed (${JSON.stringify(out)})`);
    assert.equal(out.error.code, "E2E_STACK_CUTOFF");
    assert.match(out.error.stackCut, new RegExp(`^v's page's POST /suggestion:held \\(#0, Accept\\) got no answer in 156\\d{3} ms \\(76\\d{3} ms of them in this wait, which began after it was sent\\), past Hosting's own cut-off of ${HOSTING_CUTOFF_MS} ms: the stack did not answer it$`));

    const ctx2 = fakeContext();
    const rows2 = User.prototype.capture.call({ name: "v", context: ctx2 }, { paths: "/suggestion" });
    const p2 = rows2.waitInTurn({ op: "accept" }, { idleMs: 50, what: "Accept" });
    const claim = ctx2.send("claim"); // sent during the wait
    skew += 74_000;
    assert.deepEqual(await within(p2, 300), { late: true }, "74 s after its send: not yet");
    ctx2.answer(claim, 200);
    ctx2.send("accept");
    skew += 76_000;
    const out2 = await within(p2, 2_000);
    assert.ok(out2.error, `it failed (${JSON.stringify(out2)})`);
    assert.match(out2.error.stackCut, new RegExp(`^v's page's POST /suggestion:accept \\(#1, Accept\\) got no answer in 76\\d{3} ms, past Hosting's own cut-off of ${HOSTING_CUTOFF_MS} ms: the stack did not answer it$`));
    assert.equal(rows2[0].status, 200, "the claim's answer was taken, and held the wait no longer");
  } finally {
    delete performance.now;
  }
});

test("waitInTurn: Hosting's cut-off 504 to any request of the chain ends it E2E_STACK_CUTOFF; a quicker 504 is an answer, returned to judge", async () => {
  await withUser(async (u) => {
    const rows = u.capture({ paths: "/suggestion" });
    const mark = rows.mark();
    await chain(u.page, [["/suggestion", { op: "claim", ms: 600, status: 504 }], ["/suggestion", { op: "accept" }]]);
    const claim = await rows.waitInTurn({ op: "claim" }, { since: mark, settled: false });
    claim.sentAt -= 60_000; // its 504 will have taken Hosting's minute
    const out = await within(rows.waitInTurn({ op: "accept" }, { since: mark, idleMs: 5_000, what: "Accept" }), 8_000);
    assert.ok(out.error, `it failed (${JSON.stringify(out)})`);
    assert.equal(out.error.code, "E2E_STACK_CUTOFF");
    assert.match(out.error.stackCut, /^v's page's POST \/suggestion:claim \(Accept\) answered 504 after 60\d{3} ms, Hosting's cut-off for a function that has not answered$/);
    assert.equal(out.error.response, claim, "the cut-off row");
    assert.ok(rows.some((r) => r.op === "accept"), "the page went on to its accept, and the claim's cut-off still ended the wait");

    const m2 = rows.mark();
    await chain(u.page, [["/suggestion", { op: "claim", ms: 50, status: 504 }], ["/suggestion", { op: "accept" }]]);
    const acc = await rows.waitInTurn({ op: "accept" }, { since: m2, idleMs: 2_000 });
    assert.equal(acc.status, 200, "a quick 504 on the way is an answer");
    const quick = await rows.waitInTurn({ op: "claim" }, { since: m2 });
    assert.deepEqual([quick.status, quick.settled], [504, true], "and is returned when it is the row asked for");
  });
});

test("waitInTurn: a request in flight as it starts is the page's, holding the wait; settled: false takes the row as it is sent", async () => {
  await withUser(async (u) => {
    const rows = u.capture({ paths: "/suggestion" });
    await chain(u.page, [["/suggestion", { op: "hold" }], ["/suggestion", { op: "accept", ms: 1_500 }]]);
    await rows.waitInTurn({ op: "hold" }, { settled: false });
    const mark = rows.mark();
    setTimeout(release, 900);
    const t0 = performance.now();
    const acc = await rows.waitInTurn({ op: "accept" }, { since: mark, settled: false, idleMs: 300, unansweredMs: 10_000 });
    const took = performance.now() - t0;
    assert.ok(took >= 850, `the hold sent before the mark held the wait until it was let go (${Math.round(took)} ms)`);
    assert.equal(acc.settled, false, "taken as it was sent, before its answer");
    assert.equal(acc.seq, mark);
    const done = await rows.waitInTurn({ op: "accept" }, { since: mark, idleMs: 300, unansweredMs: 10_000 });
    assert.deepEqual([done, done.state, done.status], [acc, "finished", 200], "the same row, settled");
  });
});

test("waitInTurn: every argument is checked before anything waits, and it has no timeout of its own", async () => {
  const rows = User.prototype.capture.call({ name: "f", context: { on() {}, off() {} } }, { paths: "/x" });
  assert.throws(() => rows.waitInTurn(42), /^Error: f: capture predicate is a function, a path, a RegExp or \{method, path, op, status\}, got number$/);
  assert.throws(() => rows.waitInTurn("/x", null), /^Error: f: capture waitInTurn options are \{since, settled, unansweredMs, idleMs, what\}, got null$/);
  assert.throws(() => rows.waitInTurn("/x", { timeout: 5_000 }), /^Error: f: capture waitInTurn has no option "timeout" \(it takes since, settled, unansweredMs, idleMs, what; it has no deadline of its own/);
  assert.throws(() => rows.waitInTurn("/x", { since: -1 }), /^Error: f: capture waitInTurn since is a mark\(\) \(a seq\), got -1$/);
  assert.throws(() => rows.waitInTurn("/x", { settled: "yes" }), /^Error: f: capture waitInTurn settled is true .* got "yes"$/);
  for (const v of [0, -5, Number.POSITIVE_INFINITY, "30000", null]) {
    assert.throws(() => rows.waitInTurn("/x", { idleMs: v }), /^Error: f: capture waitInTurn idleMs is how long a page with none of its requests in flight may change nothing, a positive number of ms, got /, `idleMs ${String(v)}`);
    assert.throws(() => rows.waitInTurn("/x", { unansweredMs: v }), /^Error: f: capture waitInTurn unansweredMs is how long a request may go unanswered .* a positive number of ms, got /, `unansweredMs ${String(v)}`);
  }
  assert.throws(() => rows.waitInTurn("/x", { what: "" }), /^Error: f: capture waitInTurn what is a non-empty string naming the wait, got ""$/);
  const t0 = performance.now();
  await assert.rejects(rows.waitInTurn("/x", { idleMs: 100 }), (e) => e.message === "f: waitInTurn: the page sent nothing more within 100 ms, with none of its requests in flight (captured since 0: none)");
  assert.ok(performance.now() - t0 >= 100);
});
