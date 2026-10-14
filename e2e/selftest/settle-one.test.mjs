// SPDX-License-Identifier: Apache-2.0
// Self-test: settleLive for one editor judges every settle condition but I1's convergence, with its body's stability in its place (SPEC §16).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SETTLE, settleLive } from "../lib/live.mjs";

/** A fake User whose frame body, save state, share state and POST /draft rows are whatever `state` says when read. */
function fakeUser(name, state) {
  return {
    name,
    async frame() {
      return { evaluate: async () => (typeof state.html === "function" ? state.html() : state.html) };
    },
    async saveState() {
      return typeof state.save === "function" ? state.save() : state.save;
    },
    async shareState() {
      return state.share ?? "shared";
    },
    get inEdit() {
      return state.inEdit ?? true;
    },
    findResponses() {
      return state.drafts ?? [];
    },
  };
}

/** A clock the test drives: every read moves it on by `step` ms. */
function clock(step = 250) {
  let t = 1_700_000_000_000;
  return { now: () => (t += step), peek: () => t };
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

test("one quiet editor settles: the same body on 3 samples, saved, Shared, no POST /draft for 3 s, y stable for 2 s", async () => {
  const c = clock();
  const state = { html: "<p>alone</p>", save: "saved", drafts: [{ t: c.peek() - 10_000, at: c.peek() - 9_000 }] };
  const r = await settleLive([fakeUser("p1", state)], { docId: "d", readY: async () => ({ a: "x" }), now: c.now, intervalMs: 0 });
  assert.equal(r.alone, true);
  assert.equal(r.peers, 1);
  assert.equal(r.samples, SETTLE.i1Samples);
  assert.ok(r.ms >= SETTLE.yStableMs, `settled after ${r.ms} ms of test clock (y must be stable 2 s)`);
  assert.deepEqual(r.saveStates, { p1: "saved" });
  assert.deepEqual(r.shareStates, { p1: "shared" });
  assert.equal(typeof r.hash, "string");
  assert.equal(r.hash.length, 64);
  assert.equal(r.yEntries, 1);
});

test("two or more are judged on I1 as before, and say so: alone false, peers N", async () => {
  const c = clock();
  const state = { html: "<p>same</p>", save: "saved", drafts: [] };
  const r = await settleLive([fakeUser("p1", state), fakeUser("p2", state)], { docId: "d", readY: async () => null, now: c.now, intervalMs: 0 });
  assert.deepEqual([r.alone, r.peers], [false, 2]);
});

test("NEGATIVE: a lone body that keeps changing never settles, and the deadline is an I1 failure naming its stability", async () => {
  const c = clock();
  let k = 0;
  const state = { html: () => `<p>typing ${k++}</p>`, save: "saved", drafts: [] };
  await assert.rejects(
    settleLive([fakeUser("p1", state)], { docId: "d", readY: async () => null, now: c.now, intervalMs: 0 }),
    (err) => err.code === "ERR_ASSERTION" && /^I1: the live session of 1 peer\(s\) on d did not settle within 15000 ms \(N=1; one peer: its body's stability in place of convergence\): its body was not the same on 3 samples in a row: .*still changing/.test(err.message),
  );
});

test("NEGATIVE: every other condition still holds a lone editor back", async () => {
  const quietDrafts = [];
  const cases = [
    ["saving", { save: "saving" }, /still p1 saving/],
    ["dirty", { save: "dirty" }, /still p1 dirty/],
    ["a failed save", { save: "error" }, /save state "error" on p1/],
    ["not Shared", { share: "joining" }, /not "Shared": p1 joining/],
    ["left edit mode", { save: null }, /p1 entered edit and shows no save state/],
    ["an empty body", { html: "" }, /body of p1 is 0 char\(s\), less than 1/],
  ];
  for (const [what, over, re] of cases) {
    const c = clock();
    const state = { html: "<p>alone</p>", save: "saved", drafts: quietDrafts, ...over };
    await assert.rejects(settleLive([fakeUser("p1", state)], { docId: "d", deadlineMs: 3_000, readY: async () => null, now: c.now, intervalMs: 0 }), (err) => /^I1: /.test(err.message) && re.test(err.message), what);
  }
  // A POST /draft that keeps coming, and a live log that keeps growing.
  const c = clock();
  const busy = { html: "<p>alone</p>", save: "saved", get drafts() {
    return [{ t: c.peek(), at: c.peek() }];
  } };
  await assert.rejects(settleLive([fakeUser("p1", busy)], { docId: "d", deadlineMs: 4_000, readY: async () => null, now: c.now, intervalMs: 0 }), /I1: .*a POST \/draft \d+ ms before the deadline/);
  let y = 0;
  const c2 = clock();
  await assert.rejects(settleLive([fakeUser("p1", { html: "<p>alone</p>", save: "saved", drafts: [] })], { docId: "d", deadlineMs: 4_000, readY: async () => ({ [`e${y++}`]: "u" }), now: c2.now, intervalMs: 0 }), /I1: .*status\/d\/y changed \d+ ms before the deadline/);
});

test("a lone body that settles after it stops changing gives that body's hash", async () => {
  const c = clock();
  let k = 0;
  const state = { html: () => (k++ < 4 ? `<p>typing ${k}</p>` : "<p>typed</p>"), save: "saved", drafts: [] };
  const seen = [];
  const r = await settleLive([{ ...fakeUser("p1", state), async frame() {
    const html = typeof state.html === "function" ? state.html() : state.html;
    seen.push(html);
    return { evaluate: async () => html };
  } }], { docId: "d", readY: async () => null, now: c.now, intervalMs: 0 });
  assert.equal(r.alone, true);
  assert.ok(seen.slice(-3).every((h) => h === "<p>typed</p>"), "settled only on 3 equal samples of the final body");
  assert.equal(r.hash, sha("<p>typed</p>"), "the hash is the settled body's (frame.mjs bodyHash: sha256 of body.innerHTML)");
});

test("no user is still a TypeError", async () => {
  await assert.rejects(settleLive([], { docId: "d" }), TypeError);
  await assert.rejects(settleLive(null, { docId: "d" }), TypeError);
  await assert.rejects(settleLive([fakeUser("p1", { html: "x", save: "saved" })], {}), /docId is required/);
});
