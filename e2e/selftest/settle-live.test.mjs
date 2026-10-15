// SPDX-License-Identifier: Apache-2.0
// Self-test: settleLive settles only when I1 holds on 3 samples, nothing is dirty or saving, no POST /draft for 3 s and y is stable for 2 s, and a missed deadline is an I1 failure (SPEC §16).

import { test } from "node:test";
import assert from "node:assert/strict";
import { SETTLE, SETTLE_DEADLINES_MS, checkDelayEffect, lastDraftAt, settleDeadlineMs, settleLive } from "../lib/live.mjs";

/** A fake User: its frame body, save state and POST /draft responses are whatever `state` says now. */
function fakeUser(name, state) {
  return {
    name,
    async frame() {
      return { evaluate: async () => state.html[name] ?? state.html.all };
    },
    async saveState() {
      return name in state.save ? state.save[name] : "saved";
    },
    async shareState() {
      return state.share?.[name] ?? "shared";
    },
    get inEdit() {
      return state.inEdit?.[name] ?? true;
    },
    findResponses() {
      return state.drafts[name] ?? [];
    },
  };
}

/** A clock the test drives: every read moves it on by `step` ms. */
function clock(step = 250) {
  let t = 1_700_000_000_000;
  return { now: () => (t += step), peek: () => t };
}

test("the plan's deadlines by N: 15/20/30/60 s; another N takes the next larger", () => {
  assert.deepEqual(SETTLE_DEADLINES_MS, { 2: 15_000, 5: 20_000, 10: 30_000, 20: 60_000 });
  assert.deepEqual([2, 3, 5, 6, 10, 11, 20, 40].map(settleDeadlineMs), [15_000, 20_000, 20_000, 30_000, 30_000, 60_000, 60_000, 60_000]);
  assert.deepEqual(SETTLE, { i1Samples: 3, draftQuietMs: 3_000, yStableMs: 2_000, intervalMs: 250 });
  assert.throws(() => settleDeadlineMs(0), TypeError);
});

test("a quiet, converged session settles after 3 equal samples, a quiet 3 s and a stable 2 s", async () => {
  const c = clock();
  const state = { html: { all: "<p>same</p>" }, save: {}, drafts: { p1: [{ t: c.peek() - 10_000, at: c.peek() - 9_000 }] } };
  const users = [fakeUser("p1", state), fakeUser("p2", state)];
  const r = await settleLive(users, { docId: "d", readY: async () => ({ a: "x" }), now: c.now, intervalMs: 0 });
  assert.equal(r.samples, 3);
  assert.ok(r.ms >= SETTLE.yStableMs, `settled after ${r.ms} ms of test clock (y must be stable 2 s)`);
  assert.equal(r.yEntries, 1);
});

test("NEGATIVE: peers that differ never settle, and the deadline is an I1 failure", async () => {
  const c = clock();
  const state = { html: { p1: "<p>one</p>", p2: "<p>two</p>" }, save: {}, drafts: {} };
  await assert.rejects(
    settleLive([fakeUser("p1", state), fakeUser("p2", state)], { docId: "d", n: 2, readY: async () => null, now: c.now, intervalMs: 0 }),
    (err) => err.code === "ERR_ASSERTION" && /^I1: the live session of 2 peer\(s\) on d did not settle within 15000 ms \(N=2\): peers differ/.test(err.message),
  );
});

test("NEGATIVE: a dirty editor, a recent POST /draft or a changing y each keep it unsettled", async () => {
  const c = clock();
  const dirty = { html: { all: "<p>x</p>" }, save: { p2: "saving" }, drafts: {} };
  await assert.rejects(settleLive([fakeUser("p1", dirty), fakeUser("p2", dirty)], { docId: "d", deadlineMs: 3_000, readY: async () => null, now: c.now, intervalMs: 0 }), /I1: .*still p2 saving/);
  const posting = { html: { all: "<p>x</p>" }, save: {}, drafts: {} };
  const users = [fakeUser("p1", posting), fakeUser("p2", posting)];
  const readY = async () => {
    posting.drafts.p1 = [{ t: c.peek(), at: c.peek() }]; // a save every sample
    return null;
  };
  await assert.rejects(settleLive(users, { docId: "d", deadlineMs: 5_000, readY, now: c.now, intervalMs: 0 }), /I1: .*a POST \/draft \d+ ms before the deadline/);
  let k = 0;
  const quiet = { html: { all: "<p>x</p>" }, save: {}, drafts: {} };
  await assert.rejects(settleLive([fakeUser("p1", quiet), fakeUser("p2", quiet)], { docId: "d", deadlineMs: 5_000, readY: async () => ({ [`e${k++}`]: "u" }), now: c.now, intervalMs: 0 }), /I1: .*status\/d\/y changed \d+ ms before the deadline/);
});

test("NEGATIVE: one sample that agrees is not enough; a hash that keeps changing is not settled", async () => {
  const c = clock();
  let n = 0;
  const flapping = { html: {}, save: {}, drafts: {} };
  const users = ["p1", "p2"].map((name) => ({ ...fakeUser(name, flapping), async frame() {
    return { evaluate: async () => `<p>${Math.floor(n++ / 2)}</p>` };
  } }));
  await assert.rejects(settleLive(users, { docId: "d", deadlineMs: 4_000, readY: async () => null, now: c.now, intervalMs: 0 }), /I1: .*(different hashes across 3 samples|peers differ)/);
});

test("lastDraftAt takes the latest start or answer of any peer's POST /draft", () => {
  const u = (rows) => ({ findResponses: () => rows });
  assert.equal(lastDraftAt([u([]), u([])]), null);
  assert.equal(lastDraftAt([u([{ t: 10, at: 50 }]), u([{ t: 70, at: 60 }])]), 70);
});

test("checkDelayEffect: about the delay passes; no growth, or far too much, fails", () => {
  assert.equal(checkDelayEffect({ baselineMs: 3, delayedMs: 305, expectedMs: 300 }).ok, true);
  const none = checkDelayEffect({ baselineMs: 3, delayedMs: 5, expectedMs: 300 });
  assert.equal(none.ok, false);
  assert.match(none.failures[0], /grew by 2 ms, not about the 300 ms delay/);
  assert.match(checkDelayEffect({ baselineMs: 3, delayedMs: 1200, expectedMs: 300 }).failures[0], /more than the 300 ms delay set plus 400 ms/);
});

test("NEGATIVE: a peer whose save failed (save state \"error\") is not settled, and the I1 failure names it", async () => {
  const c = clock();
  const state = { html: { all: "<p>same</p>" }, save: { p2: "error" }, drafts: {} };
  await assert.rejects(
    settleLive([fakeUser("p1", state), fakeUser("p2", state)], { docId: "d", deadlineMs: 5_000, readY: async () => null, now: c.now, intervalMs: 0 }),
    (err) => err.code === "ERR_ASSERTION" && /^I1: /.test(err.message) && /save state "error" on p2/.test(err.message),
  );
});

test("NEGATIVE: equal EMPTY bodies are not a converged session; a baseline length, when given, is the floor", async () => {
  const c = clock();
  const empty = { html: { all: "" }, save: {}, drafts: {} };
  await assert.rejects(
    settleLive([fakeUser("p1", empty), fakeUser("p2", empty)], { docId: "d", deadlineMs: 3_000, readY: async () => null, now: c.now, intervalMs: 0 }),
    (err) => /^I1: /.test(err.message) && /body of p1, p2 is 0 char\(s\), less than 1/.test(err.message),
  );
  const short = { html: { all: "<p>x</p>" }, save: {}, drafts: {} };
  await assert.rejects(
    settleLive([fakeUser("p1", short), fakeUser("p2", short)], { docId: "d", deadlineMs: 3_000, minLength: 100, readY: async () => null, now: c.now, intervalMs: 0 }),
    /I1: .*body of p1, p2 is 8 char\(s\), less than 100/,
  );
  const r = await settleLive([fakeUser("p1", short), fakeUser("p2", short)], { docId: "d", minLength: 8, readY: async () => null, now: c.now, intervalMs: 0 });
  assert.equal(r.samples, 3, "at the floor it settles");
});

test("NEGATIVE: a peer that entered edit and now shows no save state (it left edit mode) is not settled", async () => {
  const c = clock();
  const gone = { html: { all: "<p>x</p>" }, save: { p2: null }, drafts: {} };
  await assert.rejects(
    settleLive([fakeUser("p1", gone), fakeUser("p2", gone)], { docId: "d", deadlineMs: 3_000, readY: async () => null, now: c.now, intervalMs: 0 }),
    /I1: .*p2 entered edit and shows no save state \(it left edit mode\)/,
  );
  // One seen in edit during the wait, then gone: the same, whatever the User records.
  let k = 0;
  const leaving = { html: { all: "<p>x</p>" }, save: {}, drafts: {}, inEdit: { p1: false, p2: false } };
  const users = [fakeUser("p1", leaving), { ...fakeUser("p2", leaving), async saveState() {
    return k++ < 2 ? "saved" : null;
  } }];
  await assert.rejects(settleLive(users, { docId: "d", deadlineMs: 3_000, readY: async () => null, now: c.now, intervalMs: 0 }), /I1: .*p2 entered edit and shows no save state/);
});

test("NEGATIVE: an editor that is not \"Shared\" (joining, or off) is not settled", async () => {
  const c = clock();
  for (const st of ["joining", "off"]) {
    const state = { html: { all: "<p>x</p>" }, save: {}, drafts: {}, share: { p2: st } };
    await assert.rejects(
      settleLive([fakeUser("p1", state), fakeUser("p2", state)], { docId: "d", deadlineMs: 3_000, readY: async () => null, now: c.now, intervalMs: 0 }),
      new RegExp(`I1: .*not "Shared": p2 ${st}`),
    );
  }
});

test("a peer that never entered edit is judged on its body only: no save state and no share state is not a failure", async () => {
  const c = clock();
  const readers = { html: { all: "<p>x</p>" }, save: { p1: null, p2: null }, drafts: {}, share: { p1: "off", p2: "off" }, inEdit: { p1: false, p2: false } };
  const r = await settleLive([fakeUser("p1", readers), fakeUser("p2", readers)], { docId: "d", readY: async () => null, now: c.now, intervalMs: 0 });
  assert.deepEqual(r.saveStates, { p1: null, p2: null });
});

test("reader sampling changes only the compared bodies, retaining the 15 s deadline and quiet gates", async () => {
  const c = clock();
  const state = { html: { p1: "authored plus peer A", p2: "authored plus peer B" }, save: { p1: null, p2: null }, inEdit: { p1: false, p2: false }, drafts: {} };
  const users = [fakeUser("p1", state), fakeUser("p2", state)];
  const readBodies = async (given) => {
    assert.deepEqual(given, users);
    return given.map((u) => ({ name: u.name, hash: "same-authored-body", length: 7 }));
  };
  const r = await settleLive(users, { docId: "d", readBodies, readY: async () => null, now: c.now, intervalMs: 0 });
  assert.equal(r.hash, "same-authored-body");
  assert.equal(r.samples, 3);
  assert.ok(r.ms >= SETTLE.yStableMs);
  let revision = 0;
  await assert.rejects(settleLive(users, { docId: "d", readBodies, readY: async () => ({ [revision++]: "changed" }), now: clock().now, intervalMs: 0 }), /within 15000 ms .*status\/d\/y changed/);
  const posting = clock();
  await assert.rejects(settleLive(users, { docId: "d", readBodies, readY: async () => { state.drafts.p1 = [{ t: posting.peek(), at: posting.peek() }]; return null; }, now: posting.now, intervalMs: 0 }), /within 15000 ms .*a POST \/draft/);
});

// --- the join gate's precondition --------------------------------------------------------

test("requireJoinersHeld waits for the run that binds: a joiner's effect runs again when its draft frame loads, and only that run counts", { timeout: 20_000 }, async () => {
  const { startGateServer, gateClient, requireHeld } = await import("../lib/gates.mjs");
  const live = await import("../lib/live.mjs");
  assert.equal(typeof live.requireJoinersHeld, "function", "live.mjs has the joiners' precondition");
  const s = await startGateServer();
  const g = gateClient(s.url);
  const ctx = { inconclusive: (reason) => { throw Object.assign(new Error(`INCONCLUSIVE: ${reason}`), { code: "E2E_INCONCLUSIVE" }); } };
  const pass = (caller, run) => fetch(`${s.url}/gate/join-before-bind/pass?key=doc-1&side=client&caller=${caller}&run=${run}`, { method: "POST" });
  // A joiner: its first run calls the gate at once; its draft frame loads later, re-running the effect (run 2) just before the frame is editable.
  const joiner = (name) => {
    let loaded;
    const frameReady = new Promise((r) => (loaded = r));
    return {
      name,
      calls: [pass(name, 1)],
      async waitForFrame({ match, editable }) {
        assert.ok(match.test("/draft/doc-1/index.html") && editable === true, "it waits for the editable draft frame");
        await frameReady;
      },
      load() {
        this.calls.push(pass(name, 2));
        setTimeout(loaded, 50);
      },
    };
  };
  try {
    await g.hold("join-before-bind", { key: "doc-1" });
    const users = [joiner("page-a"), joiner("page-b")];
    // NEGATIVE: the distinct wait alone is met by the first runs, before either frame has loaded.
    const early = await requireHeld(ctx, g, "join-before-bind", 2, { key: "doc-1", timeoutMs: 2_000 });
    assert.deepEqual(early.callers.map((c) => c.run), [1, 1], "requireHeld alone resolves on the runs that will not bind");
    let done = null;
    const waiting = live.requireJoinersHeld(ctx, g, users, { key: "doc-1", timeoutMs: 5_000 }).then((r) => (done = r));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(done, null, "not before the draft frames load");
    users[0].load();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(done, null, "not while one joiner's frame is still loading");
    users[1].load();
    const r = await waiting;
    assert.deepEqual(r.held.callers.filter((c) => c.latest).map((c) => [c.caller, c.run]).sort(), [["page-a", 2], ["page-b", 2]], "each joiner's run 2, the one that binds, is held");
    await g.release("join-before-bind");
    await Promise.all(users.flatMap((u) => u.calls));
  } finally {
    await s.close();
  }
});
