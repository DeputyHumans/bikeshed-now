// SPDX-License-Identifier: Apache-2.0
// Self-test: typed tokens are short, typeable and checksummed, and the I2/I4 analysis flags every defect class (SPEC §16).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE,
  OPEN,
  RUN_CHARS,
  TYPING_ALPHABET,
  analyseTokens,
  collectSegments,
  isToken,
  makeToken,
  parseToken,
  runPart,
  scanTokens,
  tokenLog,
} from "../lib/tokens.mjs";

const RUN = "2610101911-3x33";
const ZWSP = String.fromCharCode(0x200b);
const tok = (peer, seq, run = RUN) => makeToken(run, peer, seq);
const a1 = tok("a", 1);
const a2 = tok("a", 2);
const b1 = tok("b", 1);
const b2 = tok("b", 2);
/** a1, a2 typed into #p1; b1, b2 into #p2. */
const TYPED = [
  { token: a1, target: "p1" },
  { token: a2, target: "p1" },
  { token: b1, target: "p2" },
  { token: b2, target: "p2" },
];
const statusOf = (r, token) => r.tokens.find((t) => t.token === token).status;
const entryOf = (r, token) => r.tokens.find((t) => t.token === token);

/** A deterministic PRNG, so the sampled checks never flake. */
function prng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 2 ** 32;
  };
}

// --- generation -------------------------------------------------------------

test("a token is ⟦r<run>-<peer>-<seq><check>⟧, one UTF-16 unit per character, and every interior character is on the US layout", () => {
  assert.match(a1, /^⟦r3x33-a-001[a-z0-9]{2}⟧$/);
  for (const t of [a1, tok("p7", 17), tok("p20", 999), tok("zz99", 1000)]) {
    assert.equal(t.length, [...t].length, `${t} has no surrogate pairs`);
    assert.equal(t[0], OPEN);
    assert.equal(t.at(-1), CLOSE);
    for (const c of t.slice(1, -1)) assert.ok(TYPING_ALPHABET.includes(c), `${JSON.stringify(c)} in ${t} is typed by a real key event`);
  }
  assert.equal(OPEN.charCodeAt(0), 0x27e6);
  assert.equal(CLOSE.charCodeAt(0), 0x27e7);
  assert.equal(a1.length, 15, "15 keystrokes with a one-character peer");
  assert.equal(tok("p7", 1).length, 16);
  assert.equal(tok("p20", 1).length, 17);
});

test("tokens are deterministic and distinct across runs, peers and sequence numbers", () => {
  assert.equal(tok("a", 1), a1);
  const all = new Set();
  for (const run of ["aaaa", "aaab", RUN]) for (let p = 1; p <= 20; p += 1) for (let s = 1; s <= 100; s += 1) all.add(tok(`p${p}`, s, run));
  assert.equal(all.size, 3 * 20 * 100);
});

test("the run part is the run id's last four alphanumerics, the same from a runId or its runTag", () => {
  assert.equal(RUN_CHARS, 4);
  assert.equal(runPart(RUN), "3x33");
  assert.equal(runPart("113x33"), "3x33");
  assert.equal(runPart("AB-12"), "ab12");
  assert.equal(runPart("x9"), "x9");
  assert.equal(makeToken(RUN, "a", 1), makeToken("113x33", "a", 1));
  assert.throws(() => runPart("--"), /no \[a-z0-9\]/);
  assert.throws(() => makeToken(RUN, "A", 1), /peer/);
  assert.throws(() => makeToken(RUN, "abcde", 1), /peer/);
  assert.throws(() => makeToken(RUN, "a-b", 1), /peer/);
  assert.throws(() => makeToken(RUN, "a", -1), /seq/);
  assert.throws(() => makeToken(RUN, "a", 1.5), /seq/);
});

test("parseToken round-trips, and rejects a wrong checksum or a non-canonical sequence", () => {
  assert.deepEqual(parseToken(tok("p7", 17)), { token: tok("p7", 17), run: "3x33", peer: "p7", seq: 17, check: tok("p7", 17).slice(-3, -1), valid: true });
  assert.equal(isToken(a1), true);
  const other = a1.slice(-3, -1) === "00" ? "01" : "00";
  assert.equal(parseToken(`${a1.slice(0, -3)}${other}${CLOSE}`).valid, false, "a wrong checksum is shaped right but invalid");
  // seq 1 written as 0001 with whatever checksum 0001 would get is still not canonical.
  const body = "r3x33-a-0001";
  const forged = scanTokens(`${OPEN}${body}zz${CLOSE}`).invalid;
  assert.equal(forged.length, 1);
  assert.equal(parseToken("hello"), null);
  assert.equal(parseToken(a1.slice(0, -1)), null);
  assert.equal(isToken(`${a1}x`), false);
});

test("NEGATIVE: the checksum catches single-character corruptions — every one in the checksum, all but a sliver in the body", (t) => {
  const rnd = prng(42);
  const alphabet = TYPING_ALPHABET;
  let mutants = 0;
  let passed = 0;
  for (let n = 0; n < 150; n += 1) {
    const t = tok(`p${1 + Math.floor(rnd() * 20)}`, 1 + Math.floor(rnd() * 500));
    const inner = t.slice(1, -1);
    const variants = new Set();
    for (let i = 0; i < inner.length; i += 1) {
      for (const c of alphabet) if (c !== inner[i]) variants.add(inner.slice(0, i) + c + inner.slice(i + 1));
      variants.add(inner.slice(0, i) + inner.slice(i + 1));
      variants.add(inner.slice(0, i) + inner[i] + inner.slice(i));
      if (i + 1 < inner.length && inner[i] !== inner[i + 1]) variants.add(inner.slice(0, i) + inner[i + 1] + inner[i] + inner.slice(i + 2));
    }
    for (const v of variants) {
      mutants += 1;
      if (isToken(`${OPEN}${v}${CLOSE}`)) passed += 1;
    }
    for (let i = inner.length - 2; i < inner.length; i += 1) {
      for (const c of alphabet) {
        if (c === inner[i]) continue;
        assert.equal(isToken(`${OPEN}${inner.slice(0, i) + c + inner.slice(i + 1)}${CLOSE}`), false, `checksum char ${i} of ${t} changed to ${c}`);
      }
    }
  }
  t.diagnostic(`${passed} of ${mutants} corrupted tokens validated`);
  assert.ok(mutants > 50_000, `sampled ${mutants}`);
  assert.ok(passed / mutants < 0.002, `${passed} of ${mutants} corrupted tokens still validated`);
});

test("tokenLog numbers each peer's tokens from 1, records the target, and marks a deleted target's tokens absent", () => {
  const log = tokenLog(RUN);
  assert.equal(log.run, "3x33");
  const x1 = log.next("a", "p1");
  const y1 = log.next("b", "p1");
  const x2 = log.next("a", "p2");
  assert.deepEqual([x1, y1, x2], [a1, b1, a2]);
  assert.deepEqual(log.typed.map((e) => [e.peer, e.seq, e.target, e.expect]), [["a", 1, "p1", "present"], ["b", 1, "p1", "present"], ["a", 2, "p2", "present"]]);
  assert.equal(log.expectAbsent("p1"), 2);
  assert.deepEqual(log.typed.map((e) => e.expect), ["absent", "absent", "present"]);
  log.typed[0].expect = "present";
  assert.equal(log.typed[0].expect, "absent", "typed is a copy");
});

test("scanTokens counts valid tokens, invalid spans and brackets", () => {
  const r = scanTokens(`x${a1}y${a1.slice(0, 5)}${CLOSE}z${b2}${OPEN}`);
  assert.deepEqual(r.tokens.map((t) => [t.token, t.peer, t.seq]), [[a1, "a", 1], [b2, "b", 2]]);
  assert.equal(r.invalid.length, 1);
  assert.deepEqual(r.brackets, { open: 4, close: 3 });
});

// --- analysis: positives ----------------------------------------------------

test("every token once, whole, in its target: ok, with each peer's tokens in typed order", () => {
  const r = analyseTokens({ targets: { p1: `Hello.${a1}${a2}`, p2: `World.${b1}${b2}` }, typed: TYPED });
  assert.equal(r.ok, true, r.failures.join("\n"));
  assert.deepEqual(r.tokens.map((t) => t.status), ["ok", "ok", "ok", "ok"]);
  assert.deepEqual(r.targets.p1.sequence, [a1, a2]);
  assert.deepEqual(r.targets.p1.peers.a, { order: [1, 2], typed: [1, 2], inOrder: true, complete: true, runs: 1 });
  assert.deepEqual(r.targets.p2.peers.b, { order: [1, 2], typed: [1, 2], inOrder: true, complete: true, runs: 1 });
  assert.deepEqual(entryOf(r, a2).count, { target: 1, elsewhere: 0 });
  assert.equal(entryOf(r, a2).where[0].at, 6 + a1.length);
});

test("two peers' whole tokens interleaved token by token in one paragraph are fine; the order and the runs say how", () => {
  const typed = [a1, a2, b1, b2].map((token) => ({ token, target: "p1" }));
  const r = analyseTokens({ segments: [{ id: "p1", text: `Same.${a1}${b1}${a2}${b2}` }], typed });
  assert.equal(r.ok, true, r.failures.join("\n"));
  assert.equal(r.targets.p1.peers.a.runs, 2);
  assert.equal(r.targets.p1.peers.a.inOrder, true);
});

test("the whole body as one text: targets are ignored and only once-and-whole counts", () => {
  assert.equal(analyseTokens({ text: `${b1}x${a1}${a2}${b2}`, flat: true, typed: TYPED }).ok, true);
});

// --- analysis: each defect class must be flagged -----------------------------

test("NEGATIVE: a token that is not there at all is missing", () => {
  const r = analyseTokens({ targets: { p1: `Hello.${a1}`, p2: `${b1}${b2}` }, typed: TYPED });
  assert.equal(r.ok, false);
  assert.equal(statusOf(r, a2), "missing");
  assert.match(r.failures.join("\n"), /⟦r3x33-a-002..⟧ \(peer a, in #p1\): missing/);
});

test("NEGATIVE: a token whole twice is duplicated, whether both are in its target or one is elsewhere", () => {
  const twice = analyseTokens({ targets: { p1: `${a1}${a2}${a1}`, p2: `${b1}${b2}` }, typed: TYPED });
  assert.equal(statusOf(twice, a1), "duplicated");
  assert.deepEqual(entryOf(twice, a1).count, { target: 2, elsewhere: 0 });
  const spread = analyseTokens({ targets: { p1: `${a1}${a2}`, p2: `${b1}${a1}${b2}` }, typed: TYPED });
  assert.equal(statusOf(spread, a1), "duplicated");
  assert.deepEqual(entryOf(spread, a1).count, { target: 1, elsewhere: 1 });
  assert.equal(spread.ok, false);
});

test("NEGATIVE: a token once and again in part is duplicated (partially); a doubled head nobody can own is a stray", () => {
  const tail = analyseTokens({ targets: { p1: `${a1}${a1.slice(-4)}${a2}`, p2: `${b1}${b2}` }, typed: TYPED });
  assert.equal(statusOf(tail, a1), "duplicated");
  assert.deepEqual(entryOf(tail, a1).fragments.map((f) => [f.text, f.partial]), [[a1.slice(-4), true]]);
  const head = analyseTokens({ targets: { p1: `${a1.slice(0, 4)}${a1}${a2}`, p2: `${b1}${b2}` }, typed: TYPED });
  assert.equal(head.ok, false);
  assert.deepEqual(head.tokens.map((t) => t.status), ["ok", "ok", "ok", "ok"]);
  assert.deepEqual(head.strays.map((s) => [s.text, s.segment, s.at, s.resemblesCount]), [[a1.slice(0, 4), "p1", 0, 4]]);
});

test("NEGATIVE: a token whole once but not in its target is outside — in another target or in no target", () => {
  const other = analyseTokens({ targets: { p1: `${a1}${b1}${a2}`, p2: `${b2}` }, typed: TYPED });
  assert.equal(statusOf(other, b1), "outside");
  assert.equal(entryOf(other, b1).where[0].segment, "p1");
  const none = analyseTokens({ segments: [{ id: "p1", text: `${a1}` }, { id: null, where: "p", text: `Other.${a2}` }, { id: "p2", text: `${b1}${b2}` }], typed: TYPED });
  assert.equal(statusOf(none, a2), "outside");
  assert.match(none.failures.join("\n"), /outside its target: whole in p at 6/);
});

test("NEGATIVE: a token cut by another peer's whole token is split; the intruder is named and itself judged", () => {
  const cut = `Hello.${a1.slice(0, 9)}${b1}${a1.slice(9)}${a2}`;
  const r = analyseTokens({ targets: { p1: cut, p2: b2 }, typed: TYPED });
  assert.equal(statusOf(r, a1), "split");
  const e = entryOf(r, a1);
  assert.deepEqual(e.pieces.map((p) => p.text), [a1.slice(0, 9), a1.slice(9)]);
  assert.deepEqual(e.between.map((b) => [b.text, b.tokens]), [[b1, [b1]]]);
  assert.equal(e.tangled, false);
  assert.equal(statusOf(r, b1), "outside");
  assert.equal(statusOf(r, a2), "ok");
});

test("NEGATIVE: two tokens interleaved character by character are both split, and twenty of them are all split, none lost", () => {
  let il = "";
  for (let i = 0; i < a1.length; i += 1) il += a1[i] + b1[i];
  const typed = [a1, b1].map((token) => ({ token, target: "p1" }));
  const r = analyseTokens({ targets: { p1: `x${il}` }, typed });
  assert.deepEqual(r.tokens.map((t) => t.status), ["split", "split"]);
  assert.ok(entryOf(r, a1).pieces.length > 5);

  const log = tokenLog(RUN);
  const toks = Array.from({ length: 20 }, (_, p) => log.next(`p${p + 1}`, "p1"));
  let mix = "";
  for (let i = 0; i < 17; i += 1) for (const t of toks) if (i < t.length) mix += t[i];
  const r20 = analyseTokens({ targets: { p1: mix }, typed: log.typed });
  assert.equal(r20.counts.split, 20, JSON.stringify(r20.counts));
  assert.equal(r20.ok, false);
});

test("NEGATIVE: a token across an element boundary (a paragraph split by Enter, both halves keeping the id) is split", () => {
  const r = analyseTokens({ segments: [{ id: "p1", text: `Hello.${a1.slice(0, 6)}` }, { id: "p1", text: `${a1.slice(6)}${a2}` }, { id: "p2", text: `${b1}${b2}` }], typed: TYPED });
  assert.equal(statusOf(r, a1), "split");
  assert.deepEqual(entryOf(r, a1).between.map((b) => [b.text, b.crossesElement]), [["", true]]);
  assert.match(r.failures.join("\n"), /element boundary/);
});

test("NEGATIVE: a zero-width space inside a token splits it, and the message spells the invisible character", () => {
  const r = analyseTokens({ targets: { p1: `${a1.slice(0, 7)}${ZWSP}${a1.slice(7)}${a2}`, p2: `${b1}${b2}` }, typed: TYPED });
  assert.equal(statusOf(r, a1), "split");
  assert.equal(entryOf(r, a1).between[0].text, ZWSP);
  assert.ok(r.failures.join("\n").includes("\\u200b"), r.failures.join("\n"));
});

test("NEGATIVE: truncated, a character lost, both brackets lost — each is garbled, with the fragment found", () => {
  const cases = [
    [`Hello.${a1.slice(0, 11)}`, a1.slice(0, 11)],
    [`Hello.${a1.slice(0, 8)}${a1.slice(9)}`, a1.slice(0, 8) + a1.slice(9)],
    [`Hello. ${a1.slice(1, -1)} end`, a1.slice(1, -1)],
  ];
  for (const [p1, fragment] of cases) {
    const r = analyseTokens({ targets: { p1: `${p1}${a2}`, p2: `${b1}${b2}` }, typed: TYPED });
    assert.equal(statusOf(r, a1), "garbled", p1);
    assert.deepEqual(entryOf(r, a1).fragments.map((f) => f.text), [fragment], p1);
    assert.equal(r.ok, false);
  }
});

test("NEGATIVE: a doubled character is caught: the token reads as split around the extra character", () => {
  const r = analyseTokens({ targets: { p1: `${a1.slice(0, 8)}${a1[7]}${a1.slice(8)}${a2}`, p2: `${b1}${b2}` }, typed: TYPED });
  assert.equal(statusOf(r, a1), "split");
  assert.deepEqual(entryOf(r, a1).between.map((b) => b.text), [a1[7]]);
});

test("NEGATIVE: a split token never borrows characters from a whole neighbour", () => {
  // a1 lost "001" and b1 (whole) sits between its halves: b1 holds a "-001", but it is b1's.
  const p1 = `${a1.slice(0, 9)}${b1}${a1.slice(12)}${a2}`;
  const r = analyseTokens({ targets: { p1, p2: b2 }, typed: TYPED });
  assert.equal(statusOf(r, b1), "outside");
  assert.equal(statusOf(r, a1), "garbled", JSON.stringify(entryOf(r, a1)));
  assert.deepEqual(entryOf(r, a1).fragments.map((f) => f.text), [a1.slice(0, 9), a1.slice(12)]);
});

test("NEGATIVE: a valid token nobody typed is foreign (another run's too) unless allowed; a lone bracket is a stray", () => {
  const stranger = tok("a", 1, "zzzz");
  const r = analyseTokens({ targets: { p1: `${a1}${a2}${stranger}`, p2: `${b1}${b2}` }, typed: TYPED });
  assert.equal(r.ok, false);
  assert.deepEqual(r.foreign.map((f) => [f.token, f.run, f.segment]), [[stranger, "zzzz", "p1"]]);
  assert.equal(analyseTokens({ targets: { p1: `${a1}${a2}${stranger}`, p2: `${b1}${b2}` }, typed: TYPED }, { allowForeign: true }).ok, true);
  const lone = analyseTokens({ targets: { p1: `${a1}${CLOSE}${a2}`, p2: `${b1}${b2}` }, typed: TYPED });
  assert.equal(lone.ok, false);
  assert.deepEqual(lone.strays.map((s) => [s.text, s.at]), [[CLOSE, a1.length]]);
});

test("I4: tokens typed into a deleted passage are gone, or survived — whole, split or as a fragment anywhere", () => {
  const typed = TYPED.map((t) => (t.target === "p2" ? { ...t, expect: "absent" } : t));
  const base = [{ id: "p1", text: `Hello.${a1}${a2}` }];
  const gone = analyseTokens({ segments: [...base, { id: null, where: "p", text: "Other." }], typed });
  assert.equal(gone.ok, true, gone.failures.join("\n"));
  assert.deepEqual([statusOf(gone, b1), statusOf(gone, b2)], ["gone", "gone"]);
  assert.deepEqual(gone.targets.p2.present, false);

  const whole = analyseTokens({ segments: [...base, { id: null, where: "p", text: `Other.${b1}` }], typed });
  assert.equal(statusOf(whole, b1), "survived");
  const frag = analyseTokens({ segments: [...base, { id: null, where: "p", text: `Other.${b1.slice(9)}` }], typed });
  assert.equal(statusOf(frag, b1), "survived");
  assert.equal(statusOf(frag, b2), "gone");
  assert.match(frag.failures.join("\n"), /deleted with #p2\): survived: fragments/);
  const split = analyseTokens({ segments: [...base, { id: null, where: "p", text: `${b1.slice(0, 5)}` }, { id: null, where: "p", text: `${b1.slice(5)}.` }], typed });
  assert.equal(statusOf(split, b1), "survived");
  assert.ok(entryOf(split, b1).pieces);
});

test("NEGATIVE: a peer's tokens out of typed order show inOrder false, and fail only with requireOrder", () => {
  const input = { targets: { p1: `${a2}${a1}`, p2: `${b1}${b2}` }, typed: TYPED };
  const r = analyseTokens(input);
  assert.deepEqual(r.targets.p1.peers.a, { order: [2, 1], typed: [1, 2], inOrder: false, complete: false, runs: 1 });
  assert.equal(r.ok, true);
  const strict = analyseTokens(input, { requireOrder: true });
  assert.equal(strict.ok, false);
  assert.match(strict.failures.join("\n"), /peer a in #p1: tokens out of order, found 2,1 typed 1,2/);
});

test("NEGATIVE: flat text cannot see an element boundary — {text} is refused without flat: true, and a flat result says splitDetection is false", () => {
  // Enter split #p1 and Chrome gave both halves the id: textContent joins them back together.
  const halves = [{ id: "p1", text: `Hello.${a1.slice(0, 6)}` }, { id: "p1", text: `${a1.slice(6)}${a2}` }, { id: "p2", text: `${b1}${b2}` }];
  const seg = analyseTokens({ segments: halves, typed: TYPED });
  assert.deepEqual([statusOf(seg, a1), seg.splitDetection], ["split", true], "segments see the boundary");
  const joined = halves.map((h) => h.text).join("");
  assert.throws(() => analyseTokens({ text: joined, typed: TYPED }), /collectSegments.*flat: true/s);
  assert.throws(() => analyseTokens({ text: halves[0].text + halves[1].text, id: "p1", typed: TYPED }), /collectSegments.*flat: true/s);
  const flat = analyseTokens({ text: joined, flat: true, typed: TYPED });
  assert.equal(statusOf(flat, a1), "ok", "the blindness is real: the same token reads ok");
  assert.equal(flat.splitDetection, false);
  assert.match(entryOf(flat, a1).detail, /flat text: a split across an element boundary would not show/);
  const targets = analyseTokens({ targets: { p1: halves[0].text + halves[1].text, p2: halves[2].text }, typed: TYPED });
  assert.deepEqual([statusOf(targets, a1), targets.splitDetection], ["ok", false], "{targets} is flat within each target, and says so");
  assert.match(entryOf(targets, a1).detail, /would not show/);
});

test("NEGATIVE I4: a partial scope cannot show a deleted passage's token is gone — it is inconclusive and fails ok; the whole body tells gone from survived", () => {
  const c1 = tok("c", 1);
  const typed = [...TYPED, { token: c1, target: "p3", expect: "absent" }];
  // #p3 was deleted, but c1 survived in an element that is not among the targets.
  const body = [{ id: "p1", text: `Hello.${a1}${a2}` }, { id: "p2", text: `${b1}${b2}` }, { id: null, where: "p", text: `Moved.${c1}` }];
  const partial = analyseTokens({ targets: { p1: body[0].text, p2: body[1].text }, typed });
  assert.equal(statusOf(partial, c1), "inconclusive", "not gone: the elements given cannot show that");
  assert.equal(partial.ok, false);
  assert.equal(partial.counts.inconclusive, 1);
  assert.equal(partial.counts.gone, 0);
  assert.match(partial.failures.join("\n"), /deleted with #p3\): inconclusive: .*whole body/);
  const whole = analyseTokens({ segments: body, typed });
  assert.equal(statusOf(whole, c1), "survived", "the whole body finds it");
  const cleared = analyseTokens({ segments: [body[0], body[1], { id: null, where: "p", text: "Moved." }], typed });
  assert.deepEqual([statusOf(cleared, c1), cleared.ok], ["gone", true], "gone only from the whole body");
  const one = analyseTokens({ text: body[0].text, id: "p1", flat: true, typed: [TYPED[0], TYPED[1], { token: c1, target: "p3", expect: "absent" }] });
  assert.equal(statusOf(one, c1), "inconclusive", "one element is a partial scope too");
  const seen = analyseTokens({ targets: { p1: `${body[0].text}${c1}`, p2: body[1].text }, typed });
  assert.equal(statusOf(seen, c1), "survived", "a trace inside a partial scope still fails as survived");
});

test("some elements given: a token typed into one not given is unseen, not missing; in the whole body a deleted target's token is missing", () => {
  const some = analyseTokens({ targets: { p1: `x${a1}${a2}` }, typed: TYPED });
  assert.equal(some.ok, true, some.failures.join("\n"));
  assert.deepEqual([statusOf(some, b1), some.counts.unseen], ["unseen", 2]);
  const one = analyseTokens({ text: `x${a1}${a2}${b1}`, id: "p1", flat: true, typed: TYPED });
  assert.equal(statusOf(one, b1), "outside");
  const body = analyseTokens({ segments: [{ id: "p1", text: `x${a1}${a2}` }], typed: TYPED });
  assert.equal(statusOf(body, b1), "missing");
  assert.match(body.failures.join("\n"), /missing, and the text has no #p2/);
});

test("typed lists are checked: an invalid or repeated token is a harness bug, thrown", () => {
  assert.throws(() => analyseTokens({ text: "", flat: true, typed: [{ token: "⟦nope⟧" }] }), /not a valid token/);
  assert.throws(() => analyseTokens({ text: "", flat: true, typed: [a1, a1] }), /listed twice/);
  assert.throws(() => analyseTokens({ typed: [] }), /segments/);
});

// --- collectSegments, on a minimal DOM ---------------------------------------

function el(tag, id, ...kids) {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), id: id ?? "", firstChild: null, nextSibling: null, kids: [] };
  let prev = null;
  for (const k of kids) {
    const c = typeof k === "string" ? { nodeType: 3, nodeValue: k, nextSibling: null } : k;
    if (prev) prev.nextSibling = c;
    else node.firstChild = c;
    prev = c;
    node.kids.push(c);
  }
  return node;
}
const comment = (v) => ({ nodeType: 8, nodeValue: v, nextSibling: null });
const textContent = (n) => (n.nodeType === 3 ? n.nodeValue : n.nodeType === 1 ? n.kids.map(textContent).join("") : "");

test("collectSegments: one segment per target and block, new ones at <br> and at a second element with the same id; joined, they are textContent", () => {
  const body = el("body", "",
    el("h1", "", "Title"),
    el("p", "e2e-1", "One ", el("b", "", "bold"), " end"),
    el("p", "e2e-2", "Two", el("br", ""), "after"),
    el("p", "e2e-3", "Thr"),
    el("p", "e2e-3", "ee"),
    comment("not text"),
    el("div", "", "loose ", el("span", "e2e-4", "in"), " out"),
    el("hr", ""),
    "tail",
  );
  const segs = collectSegments({ ids: ["e2e-1", "e2e-2", "e2e-3", "e2e-4"], root: body });
  assert.deepEqual(segs.map((s) => [s.id, s.where, s.text]), [
    [null, "h1", "Title"],
    ["e2e-1", "p#e2e-1", "One bold end"],
    ["e2e-2", "p#e2e-2", "Two"],
    ["e2e-2", "p#e2e-2", "after"],
    ["e2e-3", "p#e2e-3", "Thr"],
    ["e2e-3", "p#e2e-3", "ee"],
    [null, "div", "loose "],
    ["e2e-4", "span#e2e-4", "in"],
    [null, "div", " out"],
    [null, "body", "tail"],
  ]);
  assert.equal(segs.map((s) => s.text).join(""), textContent(body));
});

test("collectSegments feeds the analysis: a token Enter cut in two is split, a whole one is ok", () => {
  const body = el("body", "", el("p", "p1", `Hi ${a1.slice(0, 5)}`), el("p", "p1", `${a1.slice(5)}${a2}`), el("p", "p2", `${b1}${b2}`));
  const r = analyseTokens({ segments: collectSegments({ ids: ["p1", "p2"], root: body }), typed: TYPED });
  assert.deepEqual(r.tokens.map((t) => t.status), ["split", "ok", "ok", "ok"]);
});

// --- scale --------------------------------------------------------------------

test("twenty peers, 600 tokens, a third of them broken, in 600 KB of prose: analysed in well under the settle budget", () => {
  const log = tokenLog(RUN);
  let para = "Lorem ipsum dolor sit amet. ";
  for (let round = 0; round < 30; round += 1) {
    for (let p = 1; p <= 20; p += 1) {
      const t = log.next(`p${p}`, "e2e-1");
      para += (round * 20 + p) % 3 === 0 ? t.slice(0, 7 + (round % 6)) : t;
    }
  }
  const prose = "The quick brown fox jumps over the lazy dog, again and again. ".repeat(5000);
  const t0 = performance.now();
  const r = analyseTokens({ segments: [{ id: null, text: prose }, { id: "e2e-1", text: para }, { id: null, text: prose }], typed: log.typed });
  const ms = performance.now() - t0;
  assert.equal(r.counts.ok, 400);
  assert.equal(r.counts.ok + r.counts.missing + r.counts.garbled, 600);
  assert.equal(r.counts.split, 0, "no reassembly invented from prose");
  assert.ok(ms < 5000, `${Math.round(ms)} ms`);
});
