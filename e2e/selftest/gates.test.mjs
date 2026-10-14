// SPDX-License-Identifier: Apache-2.0
// Self-test: the gate service holds its callers until released (together, FIFO, by key), expires and aborts them, and the amplify set's own helpers fail closed without their gate URL (SPEC §12).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PATCHES_DIR } from "../lib/paths.mjs";
import {
  GATE_ENV, VITE_GATE_ENV, amplifyClientGates, gateClient, gates, isAmplifySet, listAmplifySets, readAmplify, requireHeld, startGateServer,
} from "../lib/gates.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const work = tempDir("e2e-gates-");
after(() => rmSync(work, { recursive: true, force: true }));

/** One product call: POST /gate/<name>/pass, resolving {status, body, at} when the service answers. */
async function pass(url, name, key, side = "server") {
  const r = await fetch(`${url}/gate/${name}/pass?key=${encodeURIComponent(key)}&side=${side}`, { method: "POST" });
  return { status: r.status, body: await r.json(), at: Date.now() };
}

/**
 * The oracle: gate `name` at `url` holds both callers until it is released,
 * then lets both go together. Throws, naming what did not hold, otherwise.
 */
async function holdsTwoAndReleasesTogether(url, name = "together") {
  const g = gateClient(url);
  await g.hold(name, { key: "doc-1" });
  const settled = [];
  const calls = [pass(url, name, "doc-1"), pass(url, name, "doc-1")].map((p) => p.then((r) => (settled.push(r), r)));
  await g.waitHeld(name, 2, { timeoutMs: 5_000 });
  await new Promise((r) => setTimeout(r, 300));
  if (settled.length !== 0) throw new Error(`the gate did not hold: ${settled.length} caller(s) answered before the release (${JSON.stringify(settled.map((s) => s.body.outcome))})`);
  const released = await g.release(name);
  const done = await Promise.all(calls);
  if (released.released.length !== 2) throw new Error(`release let ${released.released.length} go, not 2`);
  for (const d of done) if (d.body.outcome !== "released") throw new Error(`a caller's outcome is ${d.body.outcome}, not released`);
  const spread = Math.max(...done.map((d) => d.at)) - Math.min(...done.map((d) => d.at));
  if (spread > 100) throw new Error(`the two callers went on ${spread} ms apart, not together`);
  if (done[0].body.releasedAt !== done[1].body.releasedAt) throw new Error("the two were released by different releases");
  return { spread, done };
}

test("a gate holds 2 callers and releases them together", async () => {
  const s = await startGateServer();
  try {
    const r = await holdsTwoAndReleasesTogether(s.url);
    assert.ok(r.spread <= 100, `spread ${r.spread} ms`);
    const counts = await gateClient(s.url).counts();
    assert.deepEqual({ ...counts.together, lastRelease: undefined }, { armed: false, key: null, held: 0, arrived: 2, passed: 0, released: 2, expired: 0, aborted: 0, lastRelease: undefined });
    // Disarmed by the full release: a third caller passes at once.
    const third = await pass(s.url, "together", "doc-1");
    assert.equal(third.body.outcome, "passed");
  } finally {
    await s.close();
  }
});

test("NEGATIVE control: a gate that does not hold goes red", async () => {
  // A service that answers every call at once, whatever was armed: a gate that does not hold.
  const leaky = createServer((req, res) => {
    const path = req.url.split("?")[0];
    res.setHeader("content-type", "application/json");
    if (path.endsWith("/hold")) return res.end(JSON.stringify({ ok: true }));
    if (path.endsWith("/pass")) return res.end(JSON.stringify({ outcome: "passed", heldMs: 0 }));
    if (path.endsWith("/held")) return res.end(JSON.stringify({ ok: true, held: 2, callers: [] }));
    if (path.endsWith("/release")) return res.end(JSON.stringify({ ok: true, released: [] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => leaky.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(holdsTwoAndReleasesTogether(`http://127.0.0.1:${leaky.address().port}`), /the gate did not hold: 2 caller\(s\) answered before the release/);
  } finally {
    await new Promise((r) => leaky.close(r));
  }
});

test("a hold is per key: another document's caller passes; a partial release is FIFO and keeps the gate armed", async () => {
  const s = await startGateServer();
  const g = gateClient(s.url);
  try {
    await g.hold("keyed", { key: "a" });
    const other = await pass(s.url, "keyed", "b");
    assert.equal(other.body.outcome, "passed", "a caller with another key is not held");
    const first = pass(s.url, "keyed", "a");
    await g.waitHeld("keyed", 1);
    const second = pass(s.url, "keyed", "a");
    const held = await g.waitHeld("keyed", 2);
    assert.equal(held.held, 2);
    const r1 = await g.release("keyed", { count: 1 });
    assert.equal(r1.released.length, 1);
    assert.equal(r1.armed, true, "a partial release keeps the gate armed");
    assert.equal((await first).body.seq, r1.released[0].seq, "the first to arrive is the first released");
    const third = pass(s.url, "keyed", "a");
    await g.waitHeld("keyed", 2);
    const rest = await g.release("keyed");
    assert.equal(rest.released.length, 2);
    assert.deepEqual([(await second).body.outcome, (await third).body.outcome], ["released", "released"]);
  } finally {
    await s.close();
  }
});

test("a held caller goes on by itself after its ttl; a caller that hangs up is dropped; releaseAll lets everything go", async () => {
  const s = await startGateServer();
  const g = gateClient(s.url);
  try {
    await g.hold("ttl", { ttlMs: 200 });
    const t0 = Date.now();
    const r = await pass(s.url, "ttl", "x");
    assert.equal(r.body.outcome, "expired");
    assert.ok(Date.now() - t0 >= 180, "held about its ttl");
    await g.hold("hangup");
    const ac = new AbortController();
    const gone = fetch(`${s.url}/gate/hangup/pass?key=x`, { method: "POST", signal: ac.signal }).catch((e) => e.name);
    await g.waitHeld("hangup", 1);
    ac.abort();
    assert.equal(await gone, "AbortError");
    await new Promise((res) => setTimeout(res, 100));
    const c = await g.counts();
    assert.deepEqual([c.hangup.held, c.hangup.aborted], [0, 1], "the hung-up caller is no longer held");
    await g.hold("all");
    const waiting = pass(s.url, "all", "x");
    await g.waitHeld("all", 1);
    assert.equal(await g.releaseAll(), 1);
    assert.equal((await waiting).body.outcome, "released");
  } finally {
    await s.close();
  }
});

test("a gate that never holds its callers is a timeout, and requireHeld turns it into INCONCLUSIVE", async () => {
  const s = await startGateServer();
  const g = gateClient(s.url);
  try {
    await g.hold("never");
    await assert.rejects(g.waitHeld("never", 1, { timeoutMs: 200 }), (err) => err.code === "E2E_GATE_TIMEOUT" && err.held === 0);
    const ctx = { inconclusive: (reason) => { throw Object.assign(new Error(`INCONCLUSIVE: ${reason}`), { code: "E2E_INCONCLUSIVE" }); } };
    await assert.rejects(requireHeld(ctx, g, "never", 1, { timeoutMs: 200 }), (err) => err.code === "E2E_INCONCLUSIVE" && /0 of 1 caller\(s\) held/.test(err.message));
    await assert.rejects(g.hold("Bad Name"), TypeError);
  } finally {
    await s.close();
  }
});

test("gates(target) needs the gates capability and the stack's gate port", () => {
  assert.throws(() => gates({ kind: "local", runId: "x", capabilities: new Set(), stack: { ports: {} } }), /lacks the gates capability/);
  assert.throws(() => gates({ kind: "local", runId: "x", capabilities: new Set(["gates"]), stack: { ports: {} } }), /no gate service/);
  assert.equal(gates({ kind: "local", runId: "x", capabilities: new Set(["gates"]), stack: { ports: { gate: 36022 } } }).url, "http://127.0.0.1:36022");
});

test("the committed amplify set: valid amplify.json, a server pause point between upload and transaction, a client gate", () => {
  assert.ok(listAmplifySets().includes("amplify-mint-join"), listAmplifySets().join(", "));
  assert.equal(isAmplifySet("amplify"), false, "the bare directory is not an amplify set");
  const a = readAmplify("amplify-mint-join");
  assert.deepEqual(a.gates.map((x) => [x.name, x.side]), [["mint-before-id", "server"], ["mint-after-upload", "server"], ["join-before-bind", "client"]]);
  assert.deepEqual(amplifyClientGates(["controls-x", "amplify-mint-join"]).map((x) => x.name), ["join-before-bind"]);
  // Every gate the metadata names is called by the patches, and nothing else is.
  const patches = a.patches.map((p) => readFileSync(join(PATCHES_DIR, "amplify-mint-join", p), "utf8")).join("\n");
  const called = [...patches.matchAll(/^\+\s*await e2eGate\("([a-z0-9-]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(called.sort(), a.gates.map((x) => x.name).sort());
  const root = join(work, "bad-amplify");
  mkdirSync(join(root, "amplify-bad"), { recursive: true });
  writeFileSync(join(root, "amplify-bad", "10.patch"), "");
  writeFileSync(join(root, "amplify-bad", "amplify.json"), JSON.stringify({ what: "w", gates: [{ name: "x", side: "middle", where: "w" }] }));
  assert.throws(() => readAmplify("amplify-bad", root), /side is server or client/);
});

/** The new files an amplify patch adds, from its `+` lines. */
function addedFiles(patchText) {
  const out = {};
  let cur = null;
  for (const line of patchText.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) {
      cur = m[1];
      out[cur] = [];
      continue;
    }
    if (cur && line.startsWith("+")) out[cur].push(line.slice(1));
    if (line.startsWith("--- ")) cur = null;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, `${v.join("\n")}\n`]));
}

test("FAIL CLOSED: the amplify set's server and client helpers throw without their gate URL, and honour a gate with it", async () => {
  const files = addedFiles(readFileSync(join(PATCHES_DIR, "amplify-mint-join", "10-gate-helpers.patch"), "utf8"));
  assert.deepEqual(Object.keys(files).sort(), ["app/src/e2eGate.ts", "functions/src/lib/e2eGate.ts"]);
  // Node strips the types (process.features.typescript); .mts makes each an ES module.
  const server = join(work, "server-gate.mts");
  const client = join(work, "client-gate.mts");
  writeFileSync(server, files["functions/src/lib/e2eGate.ts"]);
  writeFileSync(client, files["app/src/e2eGate.ts"]);
  const { e2eGate: serverGate } = await import(pathToFileURL(server).href);
  const { e2eGate: clientGate } = await import(pathToFileURL(client).href);
  const saved = process.env[GATE_ENV];
  delete process.env[GATE_ENV];
  try {
    await assert.rejects(serverGate("mint-after-upload", "doc-1"), new RegExp(`${GATE_ENV} is not set on this patched stack`), "the server pause point without its env");
    await assert.rejects(clientGate("join-before-bind", "doc-1"), new RegExp(`${VITE_GATE_ENV} was not built into this patched app`), "the client gate without its build variable");
    // A gate service that answers but not 200: still closed.
    const broken = createServer((_req, res) => {
      res.statusCode = 500;
      res.end("down");
    });
    await new Promise((r) => broken.listen(0, "127.0.0.1", r));
    process.env[GATE_ENV] = `http://127.0.0.1:${broken.address().port}`;
    await assert.rejects(serverGate("mint-after-upload", "doc-1"), /the gate service answered 500/);
    await new Promise((r) => broken.close(r));
    // With the service: held until released.
    const s = await startGateServer();
    try {
      process.env[GATE_ENV] = s.url;
      const g = gateClient(s.url);
      await g.hold("mint-after-upload", { key: "doc-1" });
      let done = false;
      const call = serverGate("mint-after-upload", "doc-1").then(() => (done = true));
      await g.waitHeld("mint-after-upload", 1);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(done, false, "the pause point waits while the gate is held");
      await g.release("mint-after-upload");
      await call;
      assert.equal(done, true);
    } finally {
      await s.close();
    }
  } finally {
    if (saved === undefined) delete process.env[GATE_ENV];
    else process.env[GATE_ENV] = saved;
  }
});

// --- caller identity and per-key arming ----------------------------------------------

/** One product call as a patched helper makes it, with its caller identity: POST /gate/<name>/pass?key=&side=&caller=&run=. */
async function passAs(url, name, key, { caller, run, side = "client" } = {}) {
  const q = new URLSearchParams({ key, side, ...(caller != null ? { caller } : {}), ...(run != null ? { run: String(run) } : {}) });
  const r = await fetch(`${url}/gate/${name}/pass?${q}`, { method: "POST" });
  return { status: r.status, body: await r.json(), at: Date.now() };
}

test("callers are told apart: one joiner held twice (its effect re-ran) is ONE caller, so waitHeld {distinct: \"caller\"} waits for a second", async () => {
  const s = await startGateServer();
  const g = gateClient(s.url);
  try {
    await g.hold("join", { key: "doc-1" });
    const a1 = passAs(s.url, "join", "doc-1", { caller: "page-a", run: 1 });
    await g.waitHeld("join", 1, { key: "doc-1" });
    const a2 = passAs(s.url, "join", "doc-1", { caller: "page-a", run: 2 });
    const plain = await g.waitHeld("join", 2, { key: "doc-1", timeoutMs: 2_000 });
    assert.equal(plain.held, 2, "two held calls");
    assert.deepEqual(plain.callers.map((c) => [c.caller, c.run]), [["page-a", 1], ["page-a", 2]], "each held call says whose it is and which run");
    // The precondition "two joiners held" is NOT met by one joiner held twice.
    await assert.rejects(
      g.waitHeld("join", 2, { key: "doc-1", distinct: "caller", timeoutMs: 300 }),
      (err) => err.code === "E2E_GATE_TIMEOUT" && err.held === 1 && /1 of 2 distinct caller\(s\) held/.test(err.message),
    );
    const b1 = passAs(s.url, "join", "doc-1", { caller: "page-b", run: 1 });
    const both = await g.waitHeld("join", 2, { key: "doc-1", distinct: "caller", timeoutMs: 2_000 });
    assert.deepEqual([...both.distinctCallers].sort(), ["page-a", "page-b"]);
    assert.deepEqual(both.callers.filter((c) => c.latest).map((c) => [c.caller, c.run]).sort(), [["page-a", 2], ["page-b", 1]], "each caller's latest run is the one counted");
    const rel = await g.release("join");
    assert.equal(rel.released.length, 3);
    assert.deepEqual([...new Set(rel.released.map((r) => r.caller))].sort(), ["page-a", "page-b"]);
    assert.deepEqual((await Promise.all([a1, a2, b1])).map((r) => r.body.outcome), ["released", "released", "released"]);
  } finally {
    await s.close();
  }
});

test("a caller counts only while its LATEST run is held: a stale held run, or a call with no caller id, is not a distinct caller", async () => {
  const s = await startGateServer();
  const g = gateClient(s.url);
  try {
    await g.hold("join", { key: "doc-1" });
    const a1 = passAs(s.url, "join", "doc-1", { caller: "page-a", run: 1 });
    const b1 = passAs(s.url, "join", "doc-1", { caller: "page-b", run: 1 });
    await g.waitHeld("join", 2, { key: "doc-1", distinct: "caller", timeoutMs: 2_000 });
    // Disarm without letting anyone go: page-a's next run passes, so its held run 1 is stale.
    await g.release("join", { count: 0, disarm: true });
    assert.equal((await passAs(s.url, "join", "doc-1", { caller: "page-a", run: 2 })).body.outcome, "passed");
    const anon = passAs(s.url, "join", "doc-1", { caller: null });
    await g.hold("join", { key: "doc-1" });
    const anon2 = passAs(s.url, "join", "doc-1", { caller: null });
    await g.waitHeld("join", 3, { key: "doc-1", timeoutMs: 2_000 });
    await assert.rejects(g.waitHeld("join", 2, { key: "doc-1", distinct: "caller", timeoutMs: 300 }), (err) => err.code === "E2E_GATE_TIMEOUT" && err.held === 1, "only page-b's latest run is held");
    await g.release("join");
    await Promise.all([a1, b1, anon, anon2]);
    await assert.rejects(g.waitHeld("join", 1, { distinct: "everyone" }), TypeError);
  } finally {
    await s.close();
  }
});

test("requireHeld waits for distinct callers at a CLIENT gate (amplify.json side), and counts calls at a server pause point", async () => {
  const s = await startGateServer();
  const g = gateClient(s.url);
  const ctx = { inconclusive: (reason) => { throw Object.assign(new Error(`INCONCLUSIVE: ${reason}`), { code: "E2E_INCONCLUSIVE" }); } };
  try {
    await g.hold("join-before-bind", { key: "doc-1" });
    const runs = [1, 2].map((run) => passAs(s.url, "join-before-bind", "doc-1", { caller: "page-a", run }));
    await g.waitHeld("join-before-bind", 2, { key: "doc-1" });
    await assert.rejects(requireHeld(ctx, g, "join-before-bind", 2, { key: "doc-1", timeoutMs: 300 }), (err) => err.code === "E2E_INCONCLUSIVE" && /1 of 2 distinct caller\(s\) held/.test(err.message), "one joiner held twice is not two joiners");
    await g.release("join-before-bind");
    await Promise.all(runs);
    await g.hold("mint-after-upload", { key: "doc-1" });
    const calls = [1, 2].map((i) => passAs(s.url, "mint-after-upload", "doc-1", { caller: `req-${i}`, run: 1, side: "server" }));
    const held = await requireHeld(ctx, g, "mint-after-upload", 2, { key: "doc-1", timeoutMs: 2_000 });
    assert.equal(held.held, 2);
    await g.release("mint-after-upload");
    await Promise.all(calls);
  } finally {
    await s.close();
  }
});

test("arming is per (name, key): a second document's arming leaves the first armed, and a release takes only the key its client armed", async () => {
  const s = await startGateServer();
  const a = gateClient(s.url);
  const b = gateClient(s.url);
  try {
    await a.hold("two", { key: "doc-a" });
    await b.hold("two", { key: "doc-b" });
    const fromA = pass(s.url, "two", "doc-a");
    const fromB = pass(s.url, "two", "doc-b");
    await a.waitHeld("two", 1, { key: "doc-a", timeoutMs: 1_000 });
    await b.waitHeld("two", 1, { key: "doc-b", timeoutMs: 1_000 });
    const relA = await a.release("two");
    assert.deepEqual(relA.released.map((r) => r.key), ["doc-a"], "a's release lets only doc-a's caller go");
    assert.equal(relA.armed, false, "doc-a is disarmed");
    assert.equal((await fromA).body.outcome, "released");
    const cb = (await b.counts({ key: "doc-b" })).two;
    assert.deepEqual([cb.armed, cb.key, cb.held, cb.arrived, cb.released], [true, "doc-b", 1, 1, 0], "doc-b is still armed and its caller still held");
    const ca = (await a.counts({ key: "doc-a" })).two;
    assert.deepEqual([ca.armed, ca.held, ca.arrived, ca.released], [false, 0, 1, 1]);
    assert.equal((await pass(s.url, "two", "doc-a")).body.outcome, "passed", "doc-a's next caller passes");
    const all = (await a.counts()).two;
    assert.deepEqual([all.armed, all.held, all.arrived, all.released, all.passed], [true, 1, 3, 1, 1], "the totals are every key's");
    const relB = await b.release("two");
    assert.deepEqual(relB.released.map((r) => r.key), ["doc-b"]);
    assert.equal((await fromB).body.outcome, "released");
  } finally {
    await s.close();
  }
});

test("an every-key arming that would overlap another key's is refused 409, either way round; an explicit key releases only that key", async () => {
  const s = await startGateServer();
  const a = gateClient(s.url);
  const b = gateClient(s.url);
  try {
    await a.hold("over", { key: "doc-a" });
    await assert.rejects(b.hold("over"), (err) => err.code === "E2E_GATE" && err.status === 409 && /armed for key "doc-a"/.test(err.message));
    await a.hold("over", { key: "doc-a", ttlMs: 5_000 }); // the same key again: a refresh, not a conflict
    await a.release("over");
    await b.hold("over");
    await assert.rejects(a.hold("over", { key: "doc-a" }), (err) => err.code === "E2E_GATE" && err.status === 409 && /armed for every key/.test(err.message));
    const x = pass(s.url, "over", "doc-x");
    const y = pass(s.url, "over", "doc-y");
    await b.waitHeld("over", 2, { timeoutMs: 1_000 });
    const onlyX = await b.release("over", { key: "doc-x" });
    assert.deepEqual(onlyX.released.map((r) => r.key), ["doc-x"]);
    assert.equal((await x).body.outcome, "released");
    const rest = await b.release("over");
    assert.deepEqual(rest.released.map((r) => r.key), ["doc-y"]);
    assert.equal((await y).body.outcome, "released");
    assert.equal((await b.counts()).over.armed, false);
  } finally {
    await s.close();
  }
});

test("the amplify set's helpers say who calls: the client helper one id per page and a run per call, the server helper one id per request", async () => {
  const files = addedFiles(readFileSync(join(PATCHES_DIR, "amplify-mint-join", "10-gate-helpers.patch"), "utf8"));
  const pageA = join(work, "client-gate-page-a.mts");
  const pageB = join(work, "client-gate-page-b.mts");
  const server = join(work, "server-gate-ids.mts");
  writeFileSync(pageA, files["app/src/e2eGate.ts"]);
  writeFileSync(pageB, files["app/src/e2eGate.ts"]);
  writeFileSync(server, files["functions/src/lib/e2eGate.ts"]);
  const s = await startGateServer();
  const g = gateClient(s.url);
  const saved = { gate: process.env[GATE_ENV] };
  try {
    // import.meta.env is Vite's; in Node the helper reads it as undefined, so give the module one.
    const withEnv = (file) => writeFileSync(file, readFileSync(file, "utf8").replace("import.meta.env as", `({ VITE_E2E_GATE_URL: ${JSON.stringify(s.url)} }) as`));
    withEnv(pageA);
    withEnv(pageB);
    const { e2eGate: gateA } = await import(pathToFileURL(pageA).href);
    const { e2eGate: gateB } = await import(pathToFileURL(pageB).href);
    process.env[GATE_ENV] = s.url;
    const { e2eGate: serverGate } = await import(pathToFileURL(server).href);
    await g.hold("join-before-bind", { key: "doc-1" });
    const calls = [gateA("join-before-bind", "doc-1")];
    await g.waitHeld("join-before-bind", 1, { key: "doc-1" });
    calls.push(gateA("join-before-bind", "doc-1"));
    await g.waitHeld("join-before-bind", 2, { key: "doc-1" });
    calls.push(gateB("join-before-bind", "doc-1"));
    const held = await g.waitHeld("join-before-bind", 3, { key: "doc-1" });
    const [x, y, z] = held.callers;
    assert.ok(typeof x.caller === "string" && x.caller.length >= 8, `a caller id: ${JSON.stringify(x.caller)}`);
    assert.deepEqual([y.caller, y.run, x.run], [x.caller, 2, 1], "one page: one id, a run per call");
    assert.notEqual(z.caller, x.caller, "another page: another id");
    assert.deepEqual([x.side, z.side], ["client", "client"]);
    await g.release("join-before-bind");
    await Promise.all(calls);
    await g.hold("mint-after-upload", { key: "doc-1" });
    const reqs = [serverGate("mint-after-upload", "doc-1"), serverGate("mint-after-upload", "doc-1")];
    const sh = await g.waitHeld("mint-after-upload", 2, { key: "doc-1", distinct: "caller", timeoutMs: 2_000 });
    assert.equal(new Set(sh.callers.map((c) => c.caller)).size, 2, "one id per request");
    assert.deepEqual(sh.callers.map((c) => c.side), ["server", "server"]);
    await g.release("mint-after-upload");
    await Promise.all(reqs);
  } finally {
    if (saved.gate === undefined) delete process.env[GATE_ENV];
    else process.env[GATE_ENV] = saved.gate;
    await s.close();
  }
});
