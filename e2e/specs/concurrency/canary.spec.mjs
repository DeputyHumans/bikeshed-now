// SPDX-License-Identifier: Apache-2.0
// Concurrency canary: N editors joined live converge on a probe at 2–20 peers, the RTDB proxy's delay shows, gates hold and release, and the invariant canaries the negative controls target (SPEC §6a, §6b, §16).

/**
 *   scale    N = 2, 5, 10, 20 editors (ceil(N/5) Chromes × 5 contexts, signed
 *            in five at a time) join one document as "Shared"; one probe
 *            keystroke reaches every peer, the session settles within the
 *            plan's deadline (I1), the probe is once and whole everywhere
 *            (I2) and nothing was seeded twice (I3). The stack's and the
 *            browsers' resident memory is sampled throughout; the peak goes
 *            to the case's diagnostics and <invocation>/rss.jsonl. Arrival
 *            times (I13) are recorded, never asserted: local N=20 measures
 *            the emulator (the plan's "Latency" rule).
 *   proxy    on a --rtdb-proxy stack: two editors converge with no delay;
 *            every connection is dropped and both pages reconnect through
 *            the proxy (never the emulator's own port); a 300 ms delay then
 *            shows in the REST round trip through the proxy and in the
 *            keystroke's arrival at the other peer.
 *   gates    on an amplify-mint-join stack: the mint pause point holds two
 *            commits and releases them together; the join gate holds two
 *            joiners (two callers, each by the run that binds:
 *            requireJoinersHeld) after log.ready() and releases them
 *            together.
 *   I2 I3 I6 I12   one canary per invariant whose negative control is in
 *            e2e/patches/controls-<family>/ (the case names are theirs).
 *
 * A failed sync precondition (a peer never "Shared", a gate that never held
 * its callers, a presence that never showed) is INCONCLUSIVE, never FAIL.
 */

import { readLiveLogs } from "../../lib/live-log.mjs";
import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { publish, readFixture } from "../../lib/seed.mjs";
import { share } from "../../lib/grant.mjs";
import { closeAdmin, rtdbGet } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { tokenLog } from "../../lib/tokens.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { rtdbLatency } from "../../lib/proxy.mjs";
import {
  assertInvariant, checkI13, checkI2, checkI3, checkI6, readI3, readI3All, readSegments, readVersions, waitI12,
} from "../../lib/invariants.mjs";
import { checkDelayEffect, joinShared, probeArrivals, requireJoinersHeld, rssFile, rtdbDelayEffect, settleDeadlineMs, settleLive, startRssSampler, typeProbe } from "../../lib/live.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const FIXTURE = "crdt-paragraphs.html";
const GB = 1024 ** 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/** The fixture's v1 shape, read by Chrome: {sentinels, children}. */
async function baselineI3(ctx) {
  const parser = await ctx.users.parser();
  await parser.setContent(readFixture(FIXTURE, { raw: true }).toString("utf8"));
  return readI3(parser);
}

/** Every peer's segments over the whole body: {name: segments}. */
async function segmentsOf(users, ids) {
  const out = {};
  for (const u of users) out[u.name] = await readSegments(u, ids);
  return out;
}

// --- scale ------------------------------------------------------------------------

scenario('canary: N editors sign in in batches of 5, join one document as "Shared", and converge on a probe keystroke', {
  tiers: ["local"],
  n: [2, 5, 10, 20],
  trials: 1,
  timeoutMs: 900_000,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  const n = ctx.n;
  const sampler = startRssSampler(ctx.target, { everyMs: 3_000, file: rssFile() });
  let rss = null;
  try {
    const baseline = await baselineI3(ctx);
    ctx.step(`v1: ${baseline.children} top-level elements, the sentinel ${baseline.sentinels} time(s)`);
    const { docId, users, joinMs } = await joinShared(ctx, { n, fixture: FIXTURE, title: `Canary N=${n}` });
    ctx.step(`${n} editor(s) Shared on ${docId} after ${Math.round(joinMs / 1000)} s`);
    const log = tokenLog(ctx.target.runId);
    const probe = log.next("p1", "e2e-1");
    const deadline = settleDeadlineMs(n);
    ctx.step(`the owner types the probe ${probe} at the end of #e2e-1; every other peer is watched for it`);
    const { arrivals } = await probeArrivals(users, { from: users[0], id: "e2e-1", text: probe, timeoutMs: deadline });
    const i13 = checkI13({ arrivals });
    ctx.step(`probe arrival (I13, recorded, not asserted): median ${i13.medianMs} ms, max ${i13.maxMs} ms${i13.ok ? "" : `; ${i13.failures.join("; ")}`}`);
    ctx.t.diagnostic(`I13 N=${n}: median ${i13.medianMs} ms, max ${i13.maxMs} ms, ${arrivals.filter((a) => a.ms == null).length} never`);
    ctx.ev.json("arrivals", arrivals);
    const settled = await settleLive(users, { docId, n });
    ctx.step(`settled in ${settled.ms} ms on ${settled.hash.slice(0, 16)} (deadline ${deadline} ms)`);
    assertInvariant(checkI2({ peers: await segmentsOf(users, ["e2e-1"]), typed: log.typed }));
    assertInvariant(checkI3({ peers: await readI3All(users), baseline }));
  } finally {
    rss = await sampler.stop();
    ctx.ev.json("rss", rss);
    const p = rss.peak;
    const line = `RSS N=${n}: peak ${(p.totalBytes / GB).toFixed(2)} GB = stack ${(p.stackBytes / GB).toFixed(2)} GB + browsers ${(p.browserBytes / GB).toFixed(2)} GB (${rss.samples.length} samples)`;
    ctx.step(line);
    ctx.t.diagnostic(line);
    if (rss.peakBy) ctx.t.diagnostic(`RSS N=${n} stack at its peak: ${Object.entries(rss.peakBy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / GB).toFixed(2)} GB`).join(", ")}`);
  }
});

// --- the RTDB proxy -----------------------------------------------------------------

scenario("canary: through the stack's RTDB proxy two editors converge with no delay, reconnect through it after a drop, and a 300 ms delay shows in the round trip and in a keystroke's arrival", {
  tiers: ["local"],
  needs: ["rtdb-proxy"],
  timeoutMs: 360_000,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  const lat = rtdbLatency(ctx.target);
  await lat.reset();
  try {
    const { docId, users } = await joinShared(ctx, { n: 2, fixture: FIXTURE, title: "Canary RTDB proxy" });
    const before = await lat.stats();
    precondition(before.stats.connections >= 2, `the browsers' RTDB connections go through the proxy (it carried ${before.stats.connections})`);
    const log = tokenLog(ctx.target.runId);
    const probeSet = async (k) => {
      const ms = [];
      for (let i = 0; i < k; i += 1) {
        const { arrivals } = await probeArrivals(users, { from: users[0], id: "e2e-1", text: log.next("p1", "e2e-1"), timeoutMs: 15_000 });
        ms.push(arrivals[0].ms);
      }
      return ms;
    };
    ctx.step("no delay: three probes from p1 to p2, then the session settles (I1)");
    const fast = await probeSet(3);
    precondition(fast.every((x) => x != null), `every probe arrived with no delay (${JSON.stringify(fast)})`);
    await settleLive(users, { docId, n: 2 });
    ctx.step("drop every connection through the proxy: both pages reconnect, and THROUGH THE PROXY again (its handshake names the proxy, not the emulator)");
    const pre = (await lat.stats()).stats;
    const dropped = await lat.drop();
    assert.ok(dropped >= 2, `the drop took the browsers' connections (${dropped})`);
    const back = await eventually(async () => {
      const st = (await lat.stats()).stats;
      const shared = await Promise.all(users.map((u) => u.shareState()));
      return st.connections >= pre.connections + 2 && shared.every((x) => x === "shared") ? st : false;
    }, { timeout: 60_000, interval: 500, message: "both pages back through the proxy and Shared" }).catch(() => null);
    const bypass = ctx.users.breaches().filter((b) => /bypassed the RTDB proxy/.test(b.reason));
    assert.deepEqual(bypass.map((b) => `${b.user} ${b.url}`), [], "no page reconnected to the emulator's own port");
    if (!back) ctx.inconclusive("the sync precondition did not hold: the pages did not come back through the proxy as Shared within 60 s of the drop");
    ctx.step(`reconnected: ${back.connections - pre.connections} new connection(s) through the proxy, ${back.rewrites - pre.rewrites} handshake(s) rewritten`);
    assert.ok(back.rewrites >= pre.rewrites + 2, `each reconnect's handshake was rewritten (${pre.rewrites} → ${back.rewrites})`);
    ctx.step("the REST round trip through the proxy, with up = 300 ms and without");
    const rest = await rtdbDelayEffect(lat, { up: 300, down: 0 });
    ctx.step(`REST: ${Math.round(rest.baselineMs)} ms → ${Math.round(rest.delayedMs)} ms (+${Math.round(rest.growthMs)})`);
    assert.equal(rest.ok, true, rest.failures.join("; "));
    ctx.step("up = 300 ms: three more probes from p1 to p2");
    await lat.set({ up: 300, down: 0 });
    const slow = await probeSet(3);
    const effect = checkDelayEffect({ baselineMs: median(fast), delayedMs: median(slow) ?? Infinity, expectedMs: 300, slackMs: 1500 });
    ctx.step(`keystroke arrival: median ${median(fast)} ms → ${median(slow)} ms (+${Math.round(effect.growthMs)})`);
    ctx.t.diagnostic(`RTDB proxy: REST +${Math.round(rest.growthMs)} ms, keystroke +${Math.round(effect.growthMs)} ms at up=300`);
    assert.equal(effect.ok, true, effect.failures.join("; "));
    await settleLive(users, { docId, n: 2 });
    assertInvariant(checkI2({ peers: await segmentsOf(users, ["e2e-1"]), typed: log.typed }));
  } finally {
    await lat.reset().catch(() => undefined);
  }
});

// --- gates --------------------------------------------------------------------------

/** An owner and an editor with sessions, on a fresh document from the fixture. */
async function ownerAndEditor(ctx, title) {
  const [ownerAcct, editorAcct] = await cast(ctx.target, ["owner", "editor"], { http: ctx.http({ actor: "harness" }) });
  const owner = await openSession(ctx.target, ownerAcct, { timeoutMs: 120_000 });
  const up = await publish(owner.http, { fixture: FIXTURE, title, name: "gated", timeoutMs: 120_000 });
  await share(ctx.target, { owner, doc: up.docId, account: editorAcct, role: "editor", timeoutMs: 120_000 });
  const editor = await openSession(ctx.target, editorAcct, { timeoutMs: 120_000 });
  return { owner, editor, docId: up.docId };
}

/** The fixture with `marker` in its first paragraph: a draft's full HTML. */
function draftHtml(marker) {
  return readFixture(FIXTURE, { raw: true }).toString("utf8").replace("Paragraph 1.", `Paragraph 1. ${marker}`);
}

scenario("canary: gates: the mint pause point holds two commits until they are released together, and the join gate holds two joiners after the log is read", {
  tiers: ["local"],
  needs: ["gates", "patch:amplify-mint-join"],
  timeoutMs: 360_000,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const { owner, editor, docId } = await ownerAndEditor(ctx, "Canary gates");
  const d = await owner.http.postJson("/draft", { docId, baseVersion: "v1", html: draftHtml("gated-commit") }, { timeoutMs: 60_000 });
  assert.equal(d.status, 200, `POST /draft: ${d.status} ${JSON.stringify(d.json)}`);
  try {
    ctx.step(`hold mint-after-upload for ${docId}; owner and editor each POST /commit on v1`);
    await g.hold("mint-after-upload", { key: docId });
    const answered = [];
    const commit = (who, s) => s.http.postJson("/commit", { docId, baseVersion: "v1" }, { timeoutMs: 90_000 }).then((r) => (answered.push(who), r));
    const calls = [commit("owner", owner), commit("editor", editor)];
    const held = await requireHeld(ctx, g, "mint-after-upload", 2, { key: docId, timeoutMs: 60_000 });
    ctx.step(`both commits are held between upload and transaction (seq ${held.callers.map((c) => c.seq).join(", ")})`);
    await sleep(500);
    assert.deepEqual(answered, [], "no commit answered while the pause point held it");
    const rel = await g.release("mint-after-upload");
    assert.equal(rel.released.length, 2, "one release let both go");
    const [a, b] = await Promise.all(calls);
    ctx.step(`answers: ${a.status} ${JSON.stringify(a.json)}; ${b.status} ${JSON.stringify(b.json)}`);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], "one commit mints, the other is refused");
    assertInvariant(checkI6(await readVersions(ctx.target, docId), { base: "v1" }));
    const counts = (await g.counts({ key: docId }))["mint-after-upload"];
    assert.equal(counts.released, 2, "this document's two commits, and nothing of another case's");
  } finally {
    await g.release("mint-after-upload").catch(() => undefined);
  }

  ctx.step("the join gate: two editors open a fresh document; join-before-bind is held for it");
  const { docId: liveDoc, users } = await joinShared(ctx, { n: 2, fixture: FIXTURE, title: "Canary join gate", enter: false });
  try {
    await g.hold("join-before-bind", { key: liveDoc });
    const joinedBy = [];
    const entering = users.map((u) => u.enterEdit({ waitShared: true, timeout: 120_000 }).then((r) => (joinedBy.push(u.name), r)));
    // Two CALLERS (two pages), each held by the run that binds: every run of
    // the join effect calls the gate, and the editable draft frame's load
    // re-runs it, so one joiner held twice is not two joiners and a joiner's
    // first held run is not the one that binds (requireJoinersHeld).
    const { held } = await requireJoinersHeld(ctx, g, users, { key: liveDoc, timeoutMs: 90_000 });
    ctx.step(`both joiners are held after log.ready(), before bindSync, by the runs that bind: ${held.distinctCallers.length} callers (${held.callers.map((c) => `seq ${c.seq} ${c.caller.slice(0, 8)} run ${c.run}${c.latest ? "" : " (superseded)"}`).join(", ")})`);
    ctx.ev.json("join-gate-held", held.callers);
    await sleep(1_000);
    const states = await Promise.all(users.map((u) => u.shareState()));
    assert.deepEqual(joinedBy, [], `neither reached "Shared" while held (share states ${JSON.stringify(states)})`);
    assert.ok(states.every((s) => s !== "shared"), `neither shows "Shared" while held: ${JSON.stringify(states)}`);
    const rel = await g.release("join-before-bind");
    const releasedCallers = new Set(rel.released.map((r) => r.caller));
    assert.ok(held.distinctCallers.every((c) => releasedCallers.has(c)), `one release let both joiners go (${rel.released.length} held run(s) of ${releasedCallers.size} caller(s))`);
    ctx.step(`one release let ${rel.released.length} held join run(s) of ${releasedCallers.size} caller(s) go at once`);
    const joined = await Promise.all(entering);
    assert.deepEqual(joined.map((j) => j.share), ["shared", "shared"]);
    // Both saw an empty log and both seed (S1, C4's subject): recorded, not judged here.
    const shapes = await readI3All(users);
    ctx.step(`after the simultaneous join: ${JSON.stringify(shapes)} (S1 is C4's to judge)`);
    ctx.ev.json("join-gate-shapes", shapes);
  } finally {
    await g.release("join-before-bind").catch(() => undefined);
  }
});

// --- the invariant canaries the negative controls target ------------------------------

scenario("canary I2: two editors type tokens into their own paragraphs, and every token is once and whole on both peers", {
  tiers: ["local"],
  timeoutMs: 300_000,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  const { docId, users } = await joinShared(ctx, { n: 2, fixture: FIXTURE, title: "Canary I2" });
  const log = tokenLog(ctx.target.runId);
  const plan = users.map((u, i) => ({ u, id: `e2e-${i + 1}`, tokens: [1, 2, 3].map(() => log.next(u.name, `e2e-${i + 1}`)) }));
  ctx.step(`at the same time, each types three tokens at the end of its own paragraph: ${plan.map((p) => `${p.u.name} → #${p.id}`).join(", ")}`);
  await Promise.all(plan.map(async ({ u, id, tokens }) => {
    for (const t of tokens) await typeProbe(u, `[id="${id}"]`, t, { delay: 20 });
  }));
  let last = null;
  try {
    await eventually(async () => {
      last = checkI2({ peers: await segmentsOf(users, ["e2e-1", "e2e-2"]), typed: log.typed });
      return last.ok;
    }, { timeout: settleDeadlineMs(2), interval: 250, message: "I2 on both peers" });
  } catch (err) {
    if (last && !last.ok) assertInvariant(last);
    throw err;
  }
  const settled = await settleLive(users, { docId, n: 2 });
  ctx.step(`I2 holds on both peers; settled in ${settled.ms} ms`);
});

scenario("canary I3: an editor who joins after another has seeded adopts the live document: the sentinel once, the top-level count unchanged", {
  tiers: ["local"],
  timeoutMs: 300_000,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  const { docId, users } = await joinShared(ctx, { n: 2, fixture: FIXTURE, title: "Canary I3", enter: false });
  const baseline = await readI3(await users[0].frame());
  ctx.step(`v1 in the reading frame: ${baseline.children} top-level elements, the sentinel ${baseline.sentinels} time(s)`);
  precondition(baseline.sentinels === 1, "the fixture has its sentinel once");
  ctx.step("p1 enters edit alone and seeds the live log");
  await users[0].enterEdit({ waitShared: true, timeout: 90_000 });
  const entries = await eventually(async () => {
    const y = await readLiveLogs(ctx.target, docId);
    return y && Object.keys(y).length > 0 ? Object.keys(y).length : false;
  }, { timeout: 30_000, message: "p1's seed in the live log" }).catch(() => ctx.inconclusive("the sync precondition did not hold: p1's seed never reached the live log"));
  ctx.step(`the live log holds ${entries} entr(ies); p2 joins it`);
  await users[1].enterEdit({ waitShared: true, timeout: 90_000 });
  let settleErr = null;
  try {
    await settleLive(users, { docId, n: 2 });
  } catch (err) {
    settleErr = err;
  }
  assertInvariant(checkI3({ peers: await readI3All(users), baseline }));
  if (settleErr) throw settleErr;
});

scenario("canary I6: a commit paused before choosing its version id while another publishes on the same base mints nothing, so v1 has one version", {
  tiers: ["local"],
  needs: ["gates", "patch:amplify-mint-join"],
  timeoutMs: 300_000,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const { owner, editor, docId } = await ownerAndEditor(ctx, "Canary I6");
  try {
    await g.hold("mint-before-id", { key: docId });
    ctx.step("the owner saves a draft on v1 and commits it: held before it picks a version id");
    assert.equal((await owner.http.postJson("/draft", { docId, baseVersion: "v1", html: draftHtml("owner-draft") }, { timeoutMs: 60_000 })).status, 200);
    const first = owner.http.postJson("/commit", { docId, baseVersion: "v1" }, { timeoutMs: 120_000 });
    await requireHeld(ctx, g, "mint-before-id", 1, { key: docId, timeoutMs: 60_000 });
    ctx.step("the editor saves another draft on v1 and commits it: held too, past the endpoint's base check");
    assert.equal((await editor.http.postJson("/draft", { docId, baseVersion: "v1", html: draftHtml("editor-draft") }, { timeoutMs: 60_000 })).status, 200);
    const second = editor.http.postJson("/commit", { docId, baseVersion: "v1" }, { timeoutMs: 120_000 });
    await requireHeld(ctx, g, "mint-before-id", 2, { key: docId, timeoutMs: 60_000 });
    ctx.step("release the owner's commit alone, and let it publish");
    await g.release("mint-before-id", { count: 1 });
    const a = await first;
    assert.equal(a.status, 200, `the first commit: ${a.status} ${JSON.stringify(a.json)}`);
    ctx.step(`the owner published ${a.json?.versionId}; release the editor's commit, whose base is no longer current`);
    await g.release("mint-before-id");
    const b = await second;
    ctx.step(`the editor's commit answered ${b.status} ${JSON.stringify(b.json)}`);
    assertInvariant(checkI6(await readVersions(ctx.target, docId), { base: "v1" }));
    assert.equal(b.status, 409, `the stale commit is refused: ${JSON.stringify(b.json)}`);
  } finally {
    await g.release("mint-before-id").catch(() => undefined);
  }
});

/** Leave the document the way a reader does: the app's own home link, a navigation inside the app (the connection stays). */
async function leaveInApp(u) {
  const home = u.page.getByRole("link", { name: "Bikeshed home" });
  if (await home.isVisible().catch(() => false)) {
    await home.click();
  } else {
    await u.page.evaluate(() => {
      history.pushState({}, "", "/");
      dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    });
  }
  await u.page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 });
}

scenario("canary I12: when both editors leave the document in the app, status/{d}/peers is empty within 5 s", {
  tiers: ["local"],
  timeoutMs: 300_000,
  inconclusiveOnPageStall: true,
}, async (ctx) => {
  const { docId, users, accounts } = await joinShared(ctx, { n: 2, fixture: FIXTURE, title: "Canary I12", enter: false });
  const uids = accounts.map((a) => a.uid).sort();
  await eventually(async () => {
    const peers = (await rtdbGet(ctx.target, `status/${docId}/peers`)) ?? {};
    return uids.every((u) => u in peers);
  }, { timeout: 30_000, message: "both readers present" }).catch(() => ctx.inconclusive("the sync precondition did not hold: both readers never showed in status/{d}/peers"));
  ctx.step("both readers are present; both leave through the app's home link");
  await Promise.all(users.map(leaveInApp));
  const since = Date.now();
  const r = await waitI12(ctx.target, docId, { since });
  ctx.step(r.ok ? `status/${docId}/peers emptied ${r.ms} ms after both left` : r.failures.join("; "));
  assertInvariant(r);
});
