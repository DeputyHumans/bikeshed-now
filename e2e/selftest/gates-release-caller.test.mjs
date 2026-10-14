// SPDX-License-Identifier: Apache-2.0
// Self-test: releaseCaller lets one caller go at a gate, its superseded and latest runs together and nobody else's, keeps the gate armed, and an older gate service refuses it instead of releasing by position (SPEC §12, §16).

/**
 * The serial control at a client gate (C4's: joiners let go one at a time)
 * needs "this joiner, every run it has held" in one release. A release by
 * FIFO count cannot say that: a joiner's superseded run may sit ahead of
 * another joiner's binding run, and an entry that expires or hangs up between
 * reading the queue and releasing shifts the count onto the next caller.
 * Every case below drives the real service (startGateServer) with the calls
 * the amplify helpers make (caller id, run number).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGateService, gateClient, startGateServer } from "../lib/gates.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One product call as the client helper makes it; `settled` flips when the service answers. */
function passAs(url, name, key, { caller, run, side = "client" } = {}) {
  const q = new URLSearchParams({ key, side, ...(caller != null ? { caller } : {}), ...(run != null ? { run: String(run) } : {}) });
  const call = { settled: false, outcome: null };
  call.done = fetch(`${url}/gate/${name}/pass?${q}`, { method: "POST" })
    .then((r) => r.json())
    .then((body) => {
      call.settled = true;
      call.outcome = body.outcome;
      call.body = body;
      return body;
    });
  return call;
}

/** Wait until `n` calls are held (every call, not callers), so the FIFO order is the order they were made in. */
async function heldInOrder(g, name, calls, key) {
  for (let i = 0; i < calls.length; i += 1) await g.waitHeld(name, i + 1, { key, timeoutMs: 3_000 });
}

const runsOf = (released) => released.map((r) => `${r.caller}#${r.run}`);

test("releaseCaller lets one joiner go at a time by caller id: its superseded and latest runs together, nobody else's, and the gate stays armed", async () => {
  const s = await startGateServer();
  const g = gateClient(s.url);
  try {
    await g.hold("join", { key: "doc-1" });
    // FIFO: a's first run, b's only run, a's second (binding) run.
    const a1 = passAs(s.url, "join", "doc-1", { caller: "page-a", run: 1 });
    await heldInOrder(g, "join", [a1], "doc-1");
    const b1 = passAs(s.url, "join", "doc-1", { caller: "page-b", run: 1 });
    await g.waitHeld("join", 2, { key: "doc-1", timeoutMs: 3_000 });
    const a2 = passAs(s.url, "join", "doc-1", { caller: "page-a", run: 2 });
    await g.waitHeld("join", 3, { key: "doc-1", timeoutMs: 3_000 });

    // The next caller is the one whose LATEST run has been held longest: page-b (a's run 1 is ahead of it, but superseded).
    const r1 = await g.releaseCaller("join", { key: "doc-1" });
    assert.equal(r1.caller, "page-b", "the first held LATEST run is page-b's");
    assert.deepEqual(runsOf(r1.released), ["page-b#1"], "page-b's run alone: a release by FIFO count up to it would take page-a's run 1 too");
    assert.equal(r1.latest, true);
    assert.deepEqual([r1.held, r1.armed], [2, true], "page-a's two runs still held, the gate still armed");
    assert.equal((await b1.done).outcome, "released");
    await sleep(150);
    assert.deepEqual([a1.settled, a2.settled], [false, false], "nobody else's run went on");

    // Still armed: a joiner arriving now is held, not passed.
    const c1 = passAs(s.url, "join", "doc-1", { caller: "page-c", run: 1 });
    await g.waitHeld("join", 3, { key: "doc-1", timeoutMs: 3_000 });
    assert.equal(c1.settled, false, "a caller arriving after a releaseCaller is held (the gate was not disarmed)");

    // Key omitted: the one key this client armed. Next: page-a (its run 2 arrived before page-c's run 1); both its runs go in one tick.
    const r2 = await g.releaseCaller("join");
    assert.equal(r2.caller, "page-a");
    assert.deepEqual(runsOf(r2.released), ["page-a#1", "page-a#2"], "the superseded run and the latest, FIFO");
    assert.deepEqual(r2.released.map((r) => r.latest), [false, true]);
    const [o1, o2] = await Promise.all([a1.done, a2.done]);
    assert.deepEqual([o1.outcome, o2.outcome], ["released", "released"]);
    assert.equal(o1.releasedAt, o2.releasedAt, "both of page-a's runs went in the same release");
    assert.equal(c1.settled, false);

    const r3 = await g.releaseCaller("join", { caller: "page-c" });
    assert.deepEqual([r3.caller, runsOf(r3.released), r3.held], ["page-c", ["page-c#1"], 0]);
    assert.equal((await c1.done).outcome, "released");

    const r4 = await g.releaseCaller("join");
    assert.deepEqual([r4.caller, r4.released, r4.latest, r4.armed], [null, [], false, true], "nobody held: nothing released, still armed");
    const counts = (await g.counts({ key: "doc-1" })).join;
    assert.deepEqual([counts.held, counts.arrived, counts.released, counts.passed], [0, 4, 4, 0]);
    assert.deepEqual(counts.lastRelease.seqs, [r3.released[0].seq], "lastRelease is the last release that let someone go");
    await g.release("join");
    assert.equal((await g.counts({ key: "doc-1" })).join.armed, false);
  } finally {
    await s.close();
  }
});

test("an explicit caller goes even when another is ahead of it; a caller whose latest run went on is never chosen as next, and names only its stale runs", async () => {
  const s = await startGateServer();
  const g = gateClient(s.url);
  try {
    await g.hold("join", { key: "doc-1" });
    const x1 = passAs(s.url, "join", "doc-1", { caller: "page-x", run: 1 });
    await g.waitHeld("join", 1, { key: "doc-1", timeoutMs: 3_000 });
    const y1 = passAs(s.url, "join", "doc-1", { caller: "page-y", run: 1 });
    await g.waitHeld("join", 2, { key: "doc-1", timeoutMs: 3_000 });
    const ry = await g.releaseCaller("join", { caller: "page-y" });
    assert.deepEqual(runsOf(ry.released), ["page-y#1"], "the named caller, though page-x is ahead");
    assert.equal((await y1.done).outcome, "released");

    // Disarm without letting anyone go: page-x's run 2 passes, so its held run 1 is stale.
    await g.release("join", { count: 0, disarm: true });
    const x2 = passAs(s.url, "join", "doc-1", { caller: "page-x", run: 2 });
    assert.equal((await x2.done).outcome, "passed");
    await g.hold("join", { key: "doc-1" });
    const anon = passAs(s.url, "join", "doc-1", {});
    await g.waitHeld("join", 2, { key: "doc-1", timeoutMs: 3_000 });

    const next = await g.releaseCaller("join", { key: "doc-1" });
    assert.deepEqual([next.caller, next.released], [null, []], "no caller's LATEST run is held: a stale run and a call with no caller id are never next");
    await sleep(100);
    assert.deepEqual([x1.settled, anon.settled], [false, false]);

    const rx = await g.releaseCaller("join", { caller: "page-x" });
    assert.deepEqual([runsOf(rx.released), rx.latest], [["page-x#1"], false], "named, its stale run goes, and the result says it was not its latest");
    assert.equal((await x1.done).outcome, "released");

    const rest = await g.release("join");
    assert.equal(rest.released.length, 1, "the anonymous call is left for a plain release");
    await anon.done;
  } finally {
    await s.close();
  }
});

test("releaseCaller keeps to its key: another document's joiner is never next, and a client that armed two keys must name one", async () => {
  const s = await startGateServer();
  const a = gateClient(s.url);
  const other = gateClient(s.url);
  try {
    await a.hold("join", { key: "doc-a" });
    await other.hold("join", { key: "doc-b" });
    const pb = passAs(s.url, "join", "doc-b", { caller: "page-b", run: 1 });
    await other.waitHeld("join", 1, { key: "doc-b", timeoutMs: 3_000 });
    const pa = passAs(s.url, "join", "doc-a", { caller: "page-a", run: 1 });
    await a.waitHeld("join", 1, { key: "doc-a", timeoutMs: 3_000 });
    const ra = await a.releaseCaller("join");
    assert.deepEqual([ra.key, ra.caller, runsOf(ra.released)], ["doc-a", "page-a", ["page-a#1"]], "a's own key, though doc-b's joiner was held first");
    assert.equal((await pa.done).outcome, "released");
    await sleep(100);
    assert.equal(pb.settled, false, "doc-b's joiner still held");
    await a.hold("join", { key: "doc-c" });
    await assert.rejects(a.releaseCaller("join"), (err) => err instanceof TypeError && /armed join for 2 keys; name the key/.test(err.message));
    const rb = await a.releaseCaller("join", { key: "doc-b" });
    assert.deepEqual([rb.caller, runsOf(rb.released)], ["page-b", ["page-b#1"]]);
    assert.equal((await pb.done).outcome, "released");
    await assert.rejects(a.releaseCaller("join", { caller: "" }), TypeError);
    await assert.rejects(a.releaseCaller("join", { key: "doc-a", disarm: "yes" }), TypeError);
    await assert.rejects(a.releaseCaller("Not A Name"), TypeError);
    const bad = await fetch(`${s.url}/gate/join/release-caller`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caller: 7 }) });
    assert.equal(bad.status, 400, "the service refuses a caller that is not an id");
    await a.release("join");
    await other.release("join");
  } finally {
    await s.close();
  }
});

/**
 * A gate service as an aux process started before release-caller existed:
 * the real service, except that route answers what its fall-through did
 * (`405 POST release-caller is not a gate operation`).
 */
async function olderService() {
  const service = createGateService();
  const server = createServer((req, res) => {
    if (req.method === "POST" && /^\/gate\/[^/]+\/release-caller(\?|$)/.test(req.url)) {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ error: "POST release-caller is not a gate operation" }));
      return;
    }
    if (!service.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => {
      service.close();
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

test("an aux process older than release-caller: releaseCaller throws E2E_GATE (restart the stack) and releases nobody, never falling back to a FIFO release", async () => {
  const s = await olderService();
  const g = gateClient(s.url);
  try {
    await g.hold("join", { key: "doc-1" });
    const calls = [passAs(s.url, "join", "doc-1", { caller: "page-a", run: 1 }), passAs(s.url, "join", "doc-1", { caller: "page-b", run: 1 })];
    await g.waitHeld("join", 2, { key: "doc-1", distinct: "caller", timeoutMs: 3_000 });
    await assert.rejects(g.releaseCaller("join"), (err) => err.code === "E2E_GATE" && err.status === 405 && /predates release-caller\): stop the stack and start it again/.test(err.message));
    await sleep(100);
    assert.deepEqual(calls.map((c) => c.settled), [false, false], "nobody was let go");
    const c = (await g.counts({ key: "doc-1" })).join;
    assert.deepEqual([c.held, c.released, c.armed], [2, 0, true]);
    await g.release("join");
    await Promise.all(calls.map((x) => x.done));
  } finally {
    await s.close();
  }
});
