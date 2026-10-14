// SPDX-License-Identifier: Apache-2.0
// Self-test: holdCalls runs a gated race at a server gate with its INCONCLUSIVE rules in one place, and always releases what it armed (SPEC §12, §16).

/**
 * Against the real gate service (startGateServer) and its real client. Each
 * "call" is a stand-in for a request that reaches a server pause point: it
 * POSTs /gate/<name>/pass the way the patched server helper does (one caller
 * id per request, run 1) and resolves with its own value once the gate lets
 * it go. Variants answer without ever reaching the gate, answer while held,
 * or reject. A ctx stand-in records steps and throws E2E_INCONCLUSIVE as the
 * real one does. What it proves: every call held before the racing action
 * runs, nothing answered meanwhile, one release of exactly those calls,
 * answers in order, a rejection thrown unchanged, another key's callers
 * untouched, and the gate released in every ending.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HOLD_CALLS_GRACE_MS, HOLD_CALLS_WAIT_MS, gateClient, holdCalls, startGateServer } from "../lib/gates.mjs";

const GATE = "selftest-hold";
let server;

before(async () => {
  server = await startGateServer();
});
after(async () => {
  await server.close();
});

/** A case's ctx as far as holdCalls uses it. */
function ctxStub() {
  const steps = [];
  return {
    steps,
    step: (line) => steps.push(line),
    inconclusive(reason) {
      const err = new Error(`INCONCLUSIVE: ${reason}`);
      err.code = "E2E_INCONCLUSIVE";
      err.reason = reason;
      throw err;
    },
  };
}

/** A request that waits at the server pause point `gate` for `key`, then resolves `value` (or rejects `error`). */
async function gatedCall(key, value, { error = null, gate = GATE } = {}) {
  const q = new URLSearchParams({ key, side: "server", caller: randomUUID(), run: "1" });
  const r = await fetch(`${server.url}/gate/${gate}/pass?${q}`, { method: "POST" });
  const body = await r.json();
  if (body.outcome !== "released" && body.outcome !== "passed") throw new Error(`the gate answered ${JSON.stringify(body)}`);
  if (error) throw error;
  return { value, outcome: body.outcome };
}

/** A request that reaches the gate but answers at once, without waiting for it (as if a hold expired, or the call was answered elsewhere). */
function leakyCall(key, value) {
  const q = new URLSearchParams({ key, side: "server", caller: randomUUID(), run: "1" });
  fetch(`${server.url}/gate/${GATE}/pass?${q}`, { method: "POST" }).catch(() => undefined);
  return new Promise((r) => setTimeout(() => r({ value, outcome: "answered-anyway" }), 50));
}

const counts = async (key) => (await gateClient(server.url).counts({ key }))[GATE];

/** What `p` rejects with (it must reject). */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

test("the defaults: a 90 s wait for the holds, 300 ms before checking none answered", () => {
  assert.deepEqual([HOLD_CALLS_WAIT_MS, HOLD_CALLS_GRACE_MS], [90_000, 300]);
});

test("N calls held, the racing action run while every one is held and none answered, one release of exactly N, the answers in order, the gate disarmed", async () => {
  const key = `doc-${randomUUID()}`;
  const g = gateClient(server.url);
  const ctx = ctxStub();
  let seen = null;
  const out = await holdCalls(ctx, g, {
    gate: GATE,
    key,
    send: () => ["a", "b", "c"].map((v) => gatedCall(key, v)),
    whileHeld: async ({ held }) => {
      seen = { held: held.held, now: await counts(key) };
      return "committed";
    },
    graceMs: 50,
    timeoutMs: 5_000,
  });
  assert.deepEqual(out.answers, [{ value: "a", outcome: "released" }, { value: "b", outcome: "released" }, { value: "c", outcome: "released" }]);
  assert.equal(out.during, "committed");
  assert.equal(seen.held, 3, "whileHeld ran once all three were held");
  assert.equal(seen.now.held, 3, "and they were still held while it ran");
  assert.equal(out.release.released.length, 3);
  assert.equal(out.held.callers.length, 3);
  const after = await counts(key);
  assert.deepEqual([after.armed, after.held, after.released], [false, 0, 3], "released once, disarmed");
  assert.equal(ctx.steps.length, 2);
  assert.match(ctx.steps[0], new RegExp(`^all 3 call\\(s\\) are held at ${GATE} for ${key} \\(seq \\d+, \\d+, \\d+\\)$`));
  assert.equal(ctx.steps[1], `one release of ${GATE} let all 3 go together`);
});

test("a call that answers without reaching the gate: INCONCLUSIVE naming it, and the held ones released", async () => {
  const key = `doc-${randomUUID()}`;
  const ctx = ctxStub();
  const err = await rejection(holdCalls(ctx, gateClient(server.url), {
    gate: GATE,
    key,
    send: () => [gatedCall(key, "a"), Promise.resolve({ value: "refused early" }), gatedCall(key, "c")],
    timeoutMs: 400,
    graceMs: 0,
  }));
  assert.equal(err.code, "E2E_INCONCLUSIVE");
  assert.match(err.reason, new RegExp(`^the sync precondition did not hold: gate ${GATE}: 2 of 3 caller\\(s\\) held within 400 ms; 1 of the 3 call\\(s\\) \\(#2\\) had already answered, so they never waited at ${GATE}$`));
  const c = await counts(key);
  assert.deepEqual([c.armed, c.held, c.released], [false, 0, 2], "the two held calls were let go in the finally");
});

test("a call that answers while held (all of them seen held): INCONCLUSIVE before the racing action runs", async () => {
  const key = `doc-${randomUUID()}`;
  let raced = false;
  const err = await rejection(holdCalls(ctxStub(), gateClient(server.url), {
    gate: GATE,
    key,
    send: () => [gatedCall(key, "a"), leakyCall(key, "b")],
    whileHeld: () => {
      raced = true;
    },
    timeoutMs: 5_000,
    graceMs: 200,
  }));
  assert.equal(err.code, "E2E_INCONCLUSIVE");
  assert.match(err.reason, new RegExp(`^the sync precondition did not hold: 1 of 2 call\\(s\\) \\(#2\\) answered while ${GATE} should have held them$`));
  assert.equal(raced, false, "the racing action never ran");
  assert.deepEqual([(await counts(key)).armed, (await counts(key)).held], [false, 0]);
});

test("a call that answers during the racing action: INCONCLUSIVE, before the release", async () => {
  const key = `doc-${randomUUID()}`;
  const g = gateClient(server.url);
  let early = null;
  const err = await rejection(holdCalls(ctxStub(), g, {
    gate: GATE,
    key,
    send: () => {
      early = gatedCall(key, "b");
      return [gatedCall(key, "a"), early];
    },
    whileHeld: async ({ held }) => {
      // Let one held caller go by hand, as a hold that expired would.
      await g.release(GATE, { key, count: 1, disarm: false });
      await early.catch(() => undefined);
      return held;
    },
    timeoutMs: 5_000,
    graceMs: 0,
  }));
  assert.equal(err.code, "E2E_INCONCLUSIVE");
  assert.match(err.reason, /^the sync precondition did not hold: 1 of 2 held call\(s\) \(#\d\) answered before the release, while selftest-hold should still have held them$/);
  assert.deepEqual([(await counts(key)).armed, (await counts(key)).held], [false, 0]);
});

test("another caller of the same key held too: the release lets N+1 go, which is INCONCLUSIVE", async () => {
  const key = `doc-${randomUUID()}`;
  const g = gateClient(server.url);
  let stray = null;
  const err = await rejection(holdCalls(ctxStub(), g, {
    gate: GATE,
    key,
    send: () => {
      stray = gatedCall(key, "a trigger's call"); // not one of the race's calls
      return [gatedCall(key, "a"), gatedCall(key, "b")];
    },
    whileHeld: async () => {
      await g.waitHeld(GATE, 3, { key, timeoutMs: 5_000 });
    },
    timeoutMs: 5_000,
    graceMs: 0,
  }));
  await stray;
  assert.equal(err.code, "E2E_INCONCLUSIVE");
  assert.match(err.reason, new RegExp(`^the sync precondition did not hold: the release of ${GATE} for ${key} let 3 held call\\(s\\) go, not the 2 sent$`));
});

test("whileHeld throws: its error, and the held calls are released and the gate disarmed", async () => {
  const key = `doc-${randomUUID()}`;
  const boom = new Error("the commit failed");
  const calls = [];
  const err = await rejection(holdCalls(ctxStub(), gateClient(server.url), {
    gate: GATE,
    key,
    send: () => {
      calls.push(gatedCall(key, "a"), gatedCall(key, "b"));
      return calls;
    },
    whileHeld: () => {
      throw boom;
    },
    timeoutMs: 5_000,
    graceMs: 0,
  }));
  assert.ok(err === boom);
  const answers = await Promise.all(calls);
  assert.deepEqual(answers.map((a) => a.outcome), ["released", "released"], "nobody was left waiting for the hold to expire");
  assert.equal((await counts(key)).armed, false);
});

test("a call that rejects: thrown after the release, unchanged, once every call has settled", async () => {
  const key = `doc-${randomUUID()}`;
  const cut = Object.assign(new Error("POST /mcp answered 504 after 60005 ms"), { code: "E2E_STACK_CUTOFF", stackCut: "…" });
  let other = null;
  const err = await rejection(holdCalls(ctxStub(), gateClient(server.url), {
    gate: GATE,
    key,
    send: () => {
      other = gatedCall(key, "b");
      return [gatedCall(key, "a", { error: cut }), other];
    },
    timeoutMs: 5_000,
    graceMs: 0,
  }));
  assert.ok(err === cut, "the call's own error object");
  assert.deepEqual(await other, { value: "b", outcome: "released" });
});

test("another key's held caller is never touched: armed for this key only, released for this key only", async () => {
  const key = `doc-${randomUUID()}`;
  const otherKey = `doc-${randomUUID()}`;
  const owner = gateClient(server.url);
  await owner.hold(GATE, { key: otherKey });
  const theirs = gatedCall(otherKey, "theirs");
  try {
    await owner.waitHeld(GATE, 1, { key: otherKey, timeoutMs: 5_000 });
    const out = await holdCalls(ctxStub(), gateClient(server.url), { gate: GATE, key, send: () => [gatedCall(key, "mine")], timeoutMs: 5_000, graceMs: 0 });
    assert.deepEqual(out.answers, [{ value: "mine", outcome: "released" }]);
    const c = await counts(otherKey);
    assert.deepEqual([c.armed, c.held], [true, 1], "the other case's caller is still held, its gate still armed");
  } finally {
    await owner.release(GATE, { key: otherKey });
  }
  assert.deepEqual(await theirs, { value: "theirs", outcome: "released" });
});

test("TypeErrors before anything is armed; a client gate is refused; a send that returns no promises is refused after releasing", async () => {
  const g = gateClient(server.url);
  const key = `doc-${randomUUID()}`;
  const send = () => [Promise.resolve(1)];
  const bad = [
    [{}, g, { gate: GATE, key, send }, /ctx is a case's ctx/],
    [ctxStub(), {}, { gate: GATE, key, send }, /g is a gate client/],
    [ctxStub(), g, { gate: "Not A Gate", key, send }, /a gate name matches/],
    [ctxStub(), g, { gate: GATE, send }, /key is the race's own key/],
    [ctxStub(), g, { gate: GATE, key: "", send }, /key is the race's own key/],
    [ctxStub(), g, { gate: GATE, key, send: [] }, /send is a function/],
    [ctxStub(), g, { gate: GATE, key, send, whileHeld: "commit" }, /whileHeld is a function or null/],
    [ctxStub(), g, { gate: GATE, key, send, timeoutMs: 0 }, /timeoutMs is a positive number/],
    [ctxStub(), g, { gate: GATE, key, send, graceMs: -1 }, /graceMs is a number of ms, 0 or more/],
    [ctxStub(), g, { gate: GATE, key, send, ttlMs: 0 }, /ttlMs is a positive number/],
    [ctxStub(), g, { gate: "join-before-bind", key, send }, /join-before-bind is a client gate/],
  ];
  for (const [ctx, client, o, re] of bad) {
    const err = await rejection(holdCalls(ctx, client, o));
    assert.ok(err instanceof TypeError, String(err));
    assert.match(err.message, re);
  }
  const before = await counts(key);
  assert.deepEqual([before.armed, before.lastRelease], [false, null], `nothing was armed (or released) for ${key}`);
  const err = await rejection(holdCalls(ctxStub(), g, { gate: GATE, key, send: () => "sent" }));
  assert.ok(err instanceof TypeError);
  assert.match(err.message, /send\(\) returns a non-empty array of promises/);
  const c = await counts(key);
  assert.equal(c.armed, false, "armed, then released again in the finally");
  assert.ok(c.lastRelease !== null, "the finally's release happened");
});
