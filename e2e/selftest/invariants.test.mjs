// SPDX-License-Identifier: Apache-2.0
// Self-test: each concurrency invariant's judge (I1–I16) passes what holds and fails what breaks it, with the invariant named in the failure (SPEC §6a, §6b, §16, §22).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INVARIANTS, assertInvariant, checkI1, checkI1Stable, checkI2, checkI3, checkI4, checkI5, checkI6, checkI7, checkI8, checkI9,
  checkI10, checkI11, checkI12, checkI13, checkI14, checkI15, checkI16, expectedMembership, waitI12,
} from "../lib/invariants.mjs";
import { tokenLog } from "../lib/tokens.mjs";

const fails = (r, re) => {
  assert.equal(r.ok, false, `expected ${r.invariant} to fail`);
  assert.throws(() => assertInvariant(r), (err) => err.code === "ERR_ASSERTION" && err.message.startsWith(`${r.invariant}: `) && re.test(err.message));
};
const holds = (r) => {
  assert.equal(r.ok, true, `${r.invariant}: ${r.failures.join("; ")}`);
  assert.equal(assertInvariant(r), r);
};

test("the plan's sixteen invariants are all named", () => {
  assert.deepEqual(Object.keys(INVARIANTS), Array.from({ length: 16 }, (_, i) => `I${i + 1}`));
  assert.throws(() => assertInvariant({ ok: false }), TypeError);
});

test("I1: equal hashes on every peer converge; one peer apart does not; three samples must agree", () => {
  const a = { name: "p1", hash: "aa".repeat(32), length: 10 };
  const b = { name: "p2", hash: "aa".repeat(32), length: 10 };
  holds(checkI1([a, b]));
  fails(checkI1([a, { ...b, hash: "bb".repeat(32) }]), /peers differ: aaaaaaaaaaaa on p1 \(10\) \| bbbbbbbbbbbb on p2/);
  fails(checkI1([a]), /at least two/);
  holds(checkI1Stable([[a, b], [a, b], [a, b]]));
  fails(checkI1Stable([[a, b], [a, b]]), /2 of 3 sample/);
  const c = { ...a, hash: "cc".repeat(32) };
  fails(checkI1Stable([[a, b], [c, { ...b, hash: c.hash }], [a, b]]), /different hashes across 3 samples/);
  fails(checkI1Stable([[a, b], [a, b], [a, { ...b, hash: c.hash }]]), /sample 3: peers differ/);
});

test("I2: every token once, whole, in its target on every peer and in the draft (tokens.mjs)", () => {
  const log = tokenLog("2610130023-l7wb");
  const t1 = log.next("p1", "e2e-1");
  const t2 = log.next("p2", "e2e-2");
  const seg = (a, b) => [{ id: "e2e-1", text: `one ${a}` }, { id: "e2e-2", text: `two ${b}` }];
  holds(checkI2({ peers: { p1: seg(t1, t2), p2: seg(t1, t2) }, draft: seg(t1, t2), typed: log.typed }));
  fails(checkI2({ peers: { p1: seg(t1, t2), p2: seg(t1 + t1, t2) }, typed: log.typed }), /p2: .*duplicated/);
  fails(checkI2({ peers: { p1: seg(t1, t2) }, draft: seg(t1, ""), typed: log.typed }), /draft: .*missing/);
  fails(checkI2({ peers: { p1: seg(t2, t1) }, typed: log.typed }), /outside its target/);
  // inserts applied twice, character by character: the token is not whole anywhere
  const doubled = [...t1].map((ch) => ch + ch).join("");
  fails(checkI2({ peers: { p1: seg(t1, t2), p2: seg(doubled, t2) }, typed: log.typed }), /p2: /);
});

test("I3: the sentinel once and v1's top-level count; a second seed doubles both", () => {
  holds(checkI3({ peers: { p1: { sentinels: 1, children: 41 }, p2: { sentinels: 1, children: 41 } }, baseline: { children: 41 } }));
  fails(checkI3({ peers: { p1: { sentinels: 1, children: 41 }, p2: { sentinels: 2, children: 82 } }, baseline: { children: 41 } }), /p2: the sentinel appears 2 time\(s\).*p2: 82 top-level element/);
  fails(checkI3({ peers: { p1: { sentinels: 1, children: 40 } }, baseline: { children: 41 } }), /40 top-level element\(s\), v1 has 41/);
  assert.throws(() => checkI3({ peers: {}, baseline: {} }), TypeError);
});

test("I4: a deleted passage and the tokens typed into it are gone everywhere", () => {
  const log = tokenLog("2610130023-l7wb");
  const kept = log.next("p1", "e2e-1");
  const lost = log.next("p2", "e2e-3");
  log.expectAbsent("e2e-3");
  const gone = [{ id: "e2e-1", text: `one ${kept}` }, { id: "e2e-2", text: "two" }];
  holds(checkI4({ peers: { p1: gone, p2: gone }, typed: log.typed, deletedTexts: ["Paragraph 3."] }));
  fails(checkI4({ peers: { p1: gone, p2: [...gone, { id: null, text: lost }] }, typed: log.typed, deletedTexts: ["Paragraph 3."] }), /p2: .*survived/);
  fails(checkI4({ peers: { p1: [...gone, { id: null, text: "Paragraph 3. leftovers" }] }, typed: log.typed, deletedTexts: ["Paragraph 3."] }), /deleted passage "Paragraph 3\." is still there/);
  assert.throws(() => checkI4({ peers: { p1: gone }, typed: [] }), /nothing was deleted/);
});

test("I5: the draft's body is every peer's, DECOR 0, BODYATTR equal", () => {
  const h = "ab".repeat(32);
  holds(checkI5({ draftHash: h, peerHashes: { p1: h, p2: h }, decoration: [], bodyAttr: { equal: true } }));
  fails(checkI5({ draftHash: h, peerHashes: { p1: h, p2: "cd".repeat(32) }, decoration: [], bodyAttr: { equal: true } }), /p2's body cdcdcdcdcdcd is not the draft's/);
  fails(checkI5({ draftHash: h, peerHashes: { p1: h }, decoration: [{ class: "bshd-x" }], bodyAttr: { equal: true } }), /DECOR: 1 decoration/);
  fails(checkI5({ draftHash: h, peerHashes: { p1: h }, decoration: [], bodyAttr: { equal: false, body: { spellcheck: "false" } } }), /BODYATTR/);
});

test("I6: one version per base; two on v1 break it; with `base`, none is a failure too", () => {
  const v1 = { id: "v1", parentVersion: null };
  holds(checkI6([v1, { id: "v2", parentVersion: "v1" }, { id: "v3", parentVersion: "v2" }], { base: "v1" }));
  fails(checkI6([v1, { id: "v2", parentVersion: "v1" }, { id: "v3", parentVersion: "v1" }]), /base v1 has 2 versions \(v2, v3\)/);
  fails(checkI6([v1], { base: "v1" }), /base v1 has no version/);
});

test("I7: REHASH equals the record, and the stored bytes are the winner's", () => {
  const [a, b] = ["aa".repeat(32), "bb".repeat(32)];
  holds(checkI7({ rehash: a, recordHash: a, storedSha: b, winnerSha: b }));
  fails(checkI7({ rehash: a, recordHash: b, storedSha: b, winnerSha: b }), /REHASH aaaaaaaaaaaa is not the record's/);
  fails(checkI7({ rehash: a, recordHash: a, storedSha: a, winnerSha: b }), /stored bytes aaaaaaaaaaaa are not the winner's/);
});

test("I8: every accepted replacement exactly once in the draft", () => {
  holds(checkI8({ draftText: "a ALPHA b BETA", accepted: [{ annId: "x", replacement: "ALPHA" }, { annId: "y", replacement: "BETA" }] }));
  fails(checkI8({ draftText: "a ALPHA b", accepted: [{ annId: "y", replacement: "BETA" }] }), /y: its replacement is in the draft 0 time/);
  fails(checkI8({ draftText: "ALPHA ALPHA", accepted: [{ annId: "x", replacement: "ALPHA" }] }), /2 time/);
});

test("I9: one insertion and one note per suggestion; losers 409 claimedBy", () => {
  holds(checkI9({ suggestions: [{ annId: "s", insertions: 1, notes: 1 }], losers: [{ status: 409, json: { claimedBy: "e@x" } }] }));
  fails(checkI9({ suggestions: [{ annId: "s", insertions: 2, notes: 1 }] }), /s: 2 insertion/);
  fails(checkI9({ suggestions: [{ annId: "s", insertions: 1, notes: 0 }] }), /0 decision note/);
  fails(checkI9({ suggestions: [], losers: [{ status: 200, json: { ok: true } }] }), /loser 1: answered 200/);
});

test("I10: notes equal real flips, and the final state follows their parity", () => {
  holds(checkI10({ flips: 3, notes: 3, initial: false, final: true }));
  fails(checkI10({ flips: 3, notes: 4, initial: false, final: true }), /4 note\(s\) for 3 real flip/);
  fails(checkI10({ flips: 2, notes: 2, initial: false, final: true }), /final state true, but 2 flip\(s\) from false make false/);
});

test("I11: at most one email per (to, doc, kind) per 30 min, exactly one where eligible", () => {
  const m = (to, at, kind = "comment") => ({ to, docId: "d", kind, at });
  holds(checkI11({ messages: [m("o@x", 0), m("o@x", 31 * 60_000), m("o@x", 10, "suggestion")], eligible: [{ to: "o@x", docId: "d", kind: "suggestion" }] }));
  fails(checkI11({ messages: [m("o@x", 0), m("O@x", 5_000)] }), /o@x · d · comment: 2 message\(s\), two of them 5 s apart/);
  fails(checkI11({ messages: [], eligible: [{ to: "o@x", docId: "d", kind: "comment" }] }), /eligible, and sent 0 time/);
});

test("I12: no peer left; waitI12 polls up to its bound", async () => {
  holds(checkI12(null));
  holds(checkI12({}));
  fails(checkI12({ uidA: {}, uidB: {} }, { docId: "d1", waitedMs: 5000 }), /status\/d1\/peers still holds 2 peer\(s\) 5000 ms after everyone left: uidA, uidB/);
  let reads = 0;
  const emptying = await waitI12(null, "d1", { timeoutMs: 2_000, intervalMs: 10, read: async () => (++reads < 3 ? { u: {} } : null) });
  holds(emptying);
  const stuck = await waitI12(null, "d1", { timeoutMs: 100, intervalMs: 10, read: async () => ({ ghost: {} }) });
  fails(stuck, /still holds 1 peer\(s\) \d+ ms after everyone left: ghost/);
});

test("I13: every Shared peer gets the probe within 2 s", () => {
  holds(checkI13({ arrivals: [{ name: "p2", shared: true, ms: 120 }, { name: "p3", shared: true, ms: 1900 }] }));
  fails(checkI13({ arrivals: [{ name: "p2", shared: true, ms: 2400 }] }), /p2: the probe arrived after 2400 ms/);
  fails(checkI13({ arrivals: [{ name: "p2", shared: true, ms: null }] }), /p2: the probe never arrived/);
  holds(checkI13({ arrivals: [{ name: "p2", shared: true, ms: 10 }, { name: "p9", shared: false, ms: null }] }));
});

test("I14: the mirror is the membership, and a revoked write is denied", () => {
  const members = ["o@x.io", "e@x.io", "v@x.io"];
  const editors = ["o@x.io", "e@x.io"];
  const presence = { "o@x,io": true, "e@x,io": true, "v@x,io": true };
  const edit = { "o@x,io": true, "e@x,io": true };
  holds(checkI14({ members, editorMembers: editors, presenceAccess: presence, editAccess: { ...edit, "*": true }, revokedWrites: [{ email: "r@x.io", verdict: "DENY" }] }));
  fails(checkI14({ members, editorMembers: editors, presenceAccess: presence, editAccess: { ...edit, "r@x,io": true } }), /editAccess has extra r@x,io/);
  fails(checkI14({ members, editorMembers: editors, presenceAccess: { "o@x,io": true }, editAccess: edit }), /presenceAccess lacks e@x,io, v@x,io/);
  fails(checkI14({ members, editorMembers: editors, presenceAccess: presence, editAccess: edit, revokedWrites: [{ email: "r@x.io", verdict: "ALLOW" }] }), /r@x\.io was revoked, and a y write answered ALLOW/);
  holds(checkI14({ members, editorMembers: editors, presenceAccess: { ...presence, __revision: "000000000001:000000002" }, editAccess: edit }));
  fails(checkI14({ members, editorMembers: editors, presenceAccess: { ...presence, __revision: true }, editAccess: edit }), /invalid revision fence/);
  fails(checkI14({ members, editorMembers: editors, presenceAccess: { ...presence, unknown: true }, editAccess: edit }), /extra unknown/);
  fails(checkI14({ members, editorMembers: editors, presenceAccess: presence, editAccess: { ...edit, "o@x,io": false } }), /not a true access grant/);
});

test("I15: each event once, the counts as caused", () => {
  const ev = [{ id: "1", kind: "comment.added" }, { id: "2", kind: "comment.added" }, { id: "3", kind: "thread.opened" }];
  holds(checkI15({ events: ev, expected: { "comment.added": 2, "thread.opened": 1 } }));
  fails(checkI15({ events: [...ev, ev[0]], expected: { "comment.added": 2, "thread.opened": 1 } }), /1 event\(s\) reported more than once: 1 ×2/);
  fails(checkI15({ events: ev, expected: { "comment.added": 3, "thread.opened": 1 } }), /comment\.added: 2 event\(s\), 3 caused/);
});

test("I16: members equal computeMembership; grantees 200, removed 404", async () => {
  const grants = { viewers: ["v@x.io"], suggesters: [], editors: ["e@x.io"], approvers: [] };
  const computed = await expectedMembership("o@x.io", grants);
  assert.deepEqual(computed.members, ["e@x.io", "o@x.io", "v@x.io"]);
  holds(checkI16({ stored: computed, computed, access: [{ email: "e@x.io", status: 200, expect: 200 }, { email: "gone@x.io", status: 404, expect: 404 }] }));
  fails(checkI16({ stored: { ...computed, members: ["e@x.io", "o@x.io"] }, computed }), /members: lacks v@x\.io/);
  fails(checkI16({ stored: computed, computed, access: [{ email: "gone@x.io", status: 200, expect: 404 }] }), /gone@x\.io: 200, expected 404/);
});
