// SPDX-License-Identifier: Apache-2.0
// C1, C2, C3, C21: N editors typing at once (disjoint paragraphs, one paragraph, Enter elsewhere, the autosave rate), their race-window, late-save and refused-append variants, and their serial positive controls (SPEC §6a, §6b, §16).

/**
 * Each catalogue scenario is a WORK case, which joins N editors (live.mjs
 * joinShared: all "Shared"), makes them type at once, proves the typing was a
 * race, waits for the plan's settle conditions (settleLive: a missed deadline
 * is an I1 FAILURE) and asserts the invariants no suspect is predicted to
 * break. What a suspect IS predicted to break is a JUDGE case of its own,
 * declared after the work case with the same N and trials: it judges what the
 * work case of the same [N=n] #trial recorded, so each defect's own assertion
 * is the one that fails, and one defect never hides another. A judge whose
 * work case never measured (it did not run, was INCONCLUSIVE, or stopped
 * before its session settled and was read: `stage` is not "measured") is
 * INCONCLUSIVE, never FAIL: the work case carries that outcome itself.
 * work() marks a work case that stopped on anything but an assertion (an
 * INCONCLUSIVE, settleLive's E2E_RTDB_UNAVAILABLE, a page stall, a stack
 * timeout) so its judges say why; every page's console, requests, DOM and
 * screenshot are then kept by the runner, which captures every user on an
 * INCONCLUSIVE as on a FAIL (lib/test.mjs captureUsers).
 *
 *   C1   disjoint-paragraph typing: p_i types TOKENS tokens at the end of
 *        #e2e-i, all at once. Work: race (every typing window overlaps:
 *        sync.mjs overlapProof over the first and last input event), past
 *        the log's compaction, I1 (settleLive), I2 on every peer, I3, I13
 *        (a probe reaches every Shared peer: arrival asserted everywhere, the
 *        2 s bound only on production, the plan's "Latency" rule), and DECOR
 *        plus BODYATTR apart from S3's `spellcheck` on GET /draft.
 *        Judges: I5 (GET /draft's body equals every peer's, read the same
 *        way, and holds every token once: I2 in the draft; whether two saves
 *        raced is recorded, not required: S17 is judged by C1 late save and
 *        C21 draft, which prove their save order), S3 (`spellcheck` added to
 *        the draft's <body> or <html>, and nothing else: BODYATTR's other
 *        attributes are the work case's) and the false conflict banner (S9).
 *   C1 late save (S17, deterministic): p1's first autosave is held in its
 *        browser (User.delayRequests) while p2…pN type in turn, each save
 *        answered 200 and each token at every peer; then p1's save goes and
 *        lands last. Proven or INCONCLUSIVE: the held save was sent before
 *        every later save, answered after all of them, holds none of their
 *        tokens, and the last of them holds every token. Work: I1, I2 live,
 *        compaction, DECOR/BODYATTR. Judge: I5 and I2 in the draft (S17: the
 *        draft is the last save to land, not the last made). Serial control:
 *        the same typing, p1's save not held.
 *   C1 refused append (X-c01-typing-2, the client half of X-c01-typing-1;
 *        needs patch:amplify-c01-append-refused): p1's first live-log append
 *        of a token is refused as the Database refused one in X-c01-typing-1
 *        (proven: the gate held it, the page recorded one refusal), and p1
 *        types on. The session stays under the 64-entry compaction on
 *        purpose: a compaction re-sends p1's whole state, and the question is
 *        whether anything else does. Judge: I1 and I2 on every peer. Control:
 *        the same typing with nothing refused.
 *   C2   same-paragraph typing: every peer types at the end of #e2e-1 at
 *        once. Work: race, compaction, I1, I3. Judge: I2 on every peer (S2,
 *        a remote Text.data patch moves the local caret).
 *   C2 window: the same typing inside the RTDB proxy's window (every
 *        client→database byte held windowMs; live.mjs inputClocks: every
 *        input of every peer inside it, less 300 ms, and each peer's own
 *        document held only its own tokens when read inside it), so every
 *        insert was made before any other could arrive: the CRDT-concurrent
 *        case. Work: I1, compaction, I2, I3 (no suspect predicts these).
 *   C3   Enter elsewhere: p1 presses Enter at the end of #e2e-40 again and
 *        again while p2…pN type into their own paragraphs. Work: race (each
 *        typist saw an Enter land inside its typing window), compaction, I1,
 *        I3 (the sentinel once, and v1's top-level count plus one paragraph
 *        per Enter on every peer). Judge: the typists' tokens, I2 on every
 *        peer (S2b, replaceChildren on <body> collapses the caret).
 *   C3 window: the same Enters and typing inside the proxy's window (the
 *        presser's document held its Enters and no typist's token, each
 *        typist's held v1's count and its own tokens only). Work: I1,
 *        compaction, I2, I3 as C3's.
 *   C21  autosave rate: every peer types one token into its paragraph in
 *        step, then pauses past the 1 s debounce, six times, so N autosaves
 *        land on one document together. Race: two saves from different peers
 *        in flight at once. Work, BEFORE the settle (which would name a
 *        failed save as I1): every POST /draft is answered 200 and no save
 *        state is ever "error"; the p95 < 3 s bound is asserted on production
 *        only (locally the emulator is measured, and recorded). Judge: I5
 *        and I2 in the draft those racing saves left (S17, S30's data-loss
 *        half). controls-c01-save-errors targets its "[N=2]" case.
 *
 * SERIAL POSITIVE CONTROLS: the same operations one after another, which must
 * PASS, so a red concurrent case is not the oracle failing for a harness
 * reason. C1-serial (also C21's): each editor in turn types its tokens and
 * waits for its autosave and for its last token at every peer, then the same
 * reads and every C1 oracle but S3's, every save 200 and never an error; then
 * everyone leaves the editor, every page is opened afresh and the editors
 * take turns (edit, type, autosave, every reader shows it, Done): nobody is
 * shown the conflict banner. C2-serial and C3-serial type one editor after
 * another (C3: the Enters first, and I3's count). C1 late save and C1 refused
 * append have their own (above). C1-serial's "[N=2]" case is the target of
 * controls-c01-draft-stale and controls-c01-conflict-banner (run.mjs
 * controls selects it with --n 2 --trials 1).
 *
 * Every typing session passes the 64-entry compaction of the live log
 * (app/src/crdt/log.ts COMPACT_AFTER): watchLog samples status/{d}/y and
 * sees an entry it saw before disappear; without that the case is
 * INCONCLUSIVE (it did not test what it claims). The refused-append cases
 * are the one exception, said above. A failed sync precondition (no overlap,
 * no Enter inside a typing window, no compaction, a window not held, a save
 * not late, a refusal not made, a peer never Shared) is INCONCLUSIVE, never
 * FAIL.
 *
 * Joining is live.mjs joinShared on every target: one POST /access on a
 * local stack, share() per editor through the operator script elsewhere (no
 * email, so no `effects`); there it ends the case INCONCLUSIVE while S16
 * leaves an editor's RTDB mirror missing. Every read of status/{d}/y (the
 * settle conditions' and watchLog's) goes through rtdbGetPatient, read again
 * on a Database 503. The window cases need a stack built with --rtdb-proxy and
 * the refused-append case one built with --patches amplify-c01-append-refused;
 * without them they are skipped, with that reason.
 *
 * SPEC: §6b "Several people may type into one document at the same time;
 * their edits merge and every copy converges"; §16 "There is no lock, no
 * holder and no hand-off: edits merge, and every copy converges on the same
 * document whatever order the updates arrive in"; §6a "serializeCleanHtml
 * strips every app injection".
 */

import assert, { AssertionError } from "node:assert/strict";
import { createHash } from "node:crypto";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { closeAdmin } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { scanTokens, tokenLog } from "../../lib/tokens.mjs";
import { readFixture } from "../../lib/seed.mjs";
import { bodyAttrDiff, diffFingerprint, fingerprint, parseAndRun } from "../../lib/bytes.mjs";
import { armArrival, idSelector, waitForArrival } from "../../lib/frame.mjs";
import { overlapProof, requireConclusive } from "../../lib/sync.mjs";
import { rtdbLatency } from "../../lib/proxy.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { OWN_MARKER_VALUES, assertInvariant, checkI1, checkI13, checkI2, checkI3, checkI5, readI1, readI3All, readSegments, segmentsOfHtml } from "../../lib/invariants.mjs";
import {
  SETTLE, inputClocks, joinShared, lastDraftAt, probeArrivals, rssFile, rtdbGetPatient, settleDeadlineMs, settleLive, startRssSampler,
} from "../../lib/live.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const FIXTURE = "crdt-paragraphs.html";
const BOTH = ["local", "prod"];
const LOCAL = ["local"];
/** Tokens each editor types per session: 5 × 16 keystrokes, so even one typist passes the 64-entry compaction. */
const TOKENS = 5;
/** Milliseconds between keystrokes: a fast typist. */
const KEY_DELAY_MS = 25;
/** C3: Enter presses, and the gap between them (about the typists' 3 s of typing). */
const ENTERS = 12;
const ENTER_EVERY_MS = 250;
/** C3: an Enter counts as inside a typing window when it lands at least this long before the typist's last keystroke. */
const ENTER_MARGIN_MS = 100;
/** C21: rounds, and the pause after each (past the 1 s autosave debounce). */
const C21_ROUNDS = 6;
const C21_PAUSE_MS = 1_600;
/** C21: the plan's production bound on a save's round trip. */
const AUTOSAVE_P95_MS = 3_000;
/** The race window of C2 window and C3 window: how long the RTDB proxy holds every client→database byte, by N (C3's 12 Enters take 2.75 s). */
const WINDOW_MS = Object.freeze({ 2: 5_000, 5: 6_000, 10: 9_000, 20: 15_000 });
/** Every input event must fall this far inside the window (README "Input clocks"). */
const WINDOW_MARGIN_MS = 300;
/** C1 refused append: the client gate of e2e/patches/amplify-c01-append-refused. */
const REFUSE_GATE = "append-refused";
const REFUSE_PATCH = "patch:amplify-c01-append-refused";
const CASE_MS = 900_000;
const SERIAL_MS = 1_500_000;
const JUDGE_MS = 30_000;
const LIVE = { inconclusiveOnStackTimeout: true, inconclusiveOnPageStall: true };
/** app/src/components/ViewerBanners.tsx: the conflict banner, "<email> saved a change while you were editing." */
const BANNER_SEL = ".viewer-banners .banner";
const CONFLICT_RE = /saved a change while you were editing/;
const BANNER_SERIAL_MSG = 'S9 oracle: nobody is shown "<peer> saved a change while you were editing" while one editor at a time edits';
const GB = 1024 ** 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const paragraph = (i) => `e2e-${i + 1}`;
const windowFor = (n) => WINDOW_MS[n] ?? WINDOW_MS[20];
const firstLine = (err) => String(err?.message ?? err).split("\n")[0].slice(0, 400);

// --- what the work cases leave for their judges ---------------------------------------------

/** `${ref}|${n}|${trial}` → the observation a work case recorded. */
const observed = new Map();
const keyOf = (ref, ctx) => `${ref}|${ctx.n}|${ctx.trial}`;

/** A fresh observation for this case, stored at once so a judge sees how far it got. */
function record(ctx, ref) {
  const o = { ref, n: ctx.n, trial: ctx.trial, stage: "started", inconclusive: null, error: null };
  observed.set(keyOf(ref, ctx), o);
  return o;
}

/**
 * The work case's observation of `field`, or INCONCLUSIVE when it was never
 * measured: the work case did not run, was INCONCLUSIVE, or stopped before
 * its session settled and was read (`stage` "measured", set only after the
 * settle and every read).
 */
function observation(ctx, ref, field) {
  const o = observed.get(keyOf(ref, ctx));
  const which = `the ${ref} work case [N=${ctx.n}] #${ctx.trial}`;
  if (!o) ctx.inconclusive(`${which} did not run in this process, so there is nothing to judge`);
  if (o.inconclusive) ctx.inconclusive(`${which} was INCONCLUSIVE: ${o.inconclusive}`);
  if (o.stage !== "measured") ctx.inconclusive(`${which} stopped (${o.stage}${o.error ? `: ${o.error}` : ""}) before its session settled and was read, so there is nothing to judge`);
  if (o[field] == null) ctx.inconclusive(`${which} never measured ${field}`);
  ctx.ev.json(`observed-${field}`, o[field]);
  return o[field];
}

/** End the case INCONCLUSIVE, and tell its judges why. */
function inconclusive(ctx, obs, reason) {
  obs.inconclusive = reason;
  ctx.inconclusive(reason);
}

/**
 * Run a work case's body. On an error before "measured" that is not an
 * assertion (an INCONCLUSIVE, a cut of the stack, a page stall, a harness
 * error), its judges are told why (obs.inconclusive); the error is thrown on,
 * unchanged, for the runner to judge, and the runner keeps every page (it
 * captures every user on an INCONCLUSIVE and on a FAIL). An assertion is the
 * work case's own FAIL; its judges still need "measured".
 */
async function work(ctx, obs, body) {
  try {
    return await body();
  } catch (err) {
    obs.error ??= firstLine(err);
    const assertion = err instanceof AssertionError || err?.code === "ERR_ASSERTION";
    if (!assertion && obs.stage !== "measured") {
      obs.inconclusive ??= err?.code === "E2E_INCONCLUSIVE" ? err.reason : `the work case stopped (${obs.stage}) on ${err?.code ?? err?.name ?? "an error"}: ${obs.error}`;
      ctx.step(`work case stopped (${obs.stage}): ${obs.error}; the runner keeps every page's console in the evidence`);
    }
    throw err;
  }
}

// --- joining -----------------------------------------------------------------------------

/**
 * N editors on a fresh document from the fixture, all "Shared" (or
 * INCONCLUSIVE): live.mjs joinShared, which grants by target (one POST
 * /access locally, share() per editor through the operator script anywhere
 * else) and reads the seed's arrival in status/{d}/y through a 503.
 */
async function join(ctx, n, title) {
  const joined = await joinShared(ctx, { n, fixture: FIXTURE, title });
  ctx.step(`${n} editor(s) joined ${joined.docId} in ${joined.joinMs} ms, granted via ${joined.grantVia}`);
  return joined;
}

/** Sample the stack's and the browsers' memory around a work case; the peak goes to the diagnostics. */
async function withRss(ctx, n, body) {
  const sampler = startRssSampler(ctx.target, { everyMs: 3_000, file: rssFile() });
  try {
    return await body();
  } finally {
    const rss = await sampler.stop();
    const p = rss.peak;
    ctx.ev.json("rss", rss);
    ctx.t.diagnostic(`RSS N=${n}: peak ${(p.totalBytes / GB).toFixed(2)} GB = stack ${(p.stackBytes / GB).toFixed(2)} GB + browsers ${(p.browserBytes / GB).toFixed(2)} GB (${rss.samples.length} samples)`);
  }
}

// --- typing, and proving it was a race --------------------------------------------------------

/** Type `tokens` one after another at the end of #id, as a person does (a real click, then the keys). */
async function typeTokens(u, id, tokens) {
  for (const t of tokens) await u.typeInFrame(idSelector(id), t, { delay: KEY_DELAY_MS, at: "end" });
}

/** Per user, the page-clock recording of save states and input events (User.recordSaveStates) and a capture of every POST /draft. */
async function armSaves(users) {
  return Promise.all(users.map(async (u) => ({ u, rec: await u.recordSaveStates(), cap: u.capture({ paths: ["/draft"], method: "POST" }) })));
}

/** Each armed user's input events since arming: {name, first, last, inputs}. */
async function inputWindows(armed) {
  return Promise.all(armed.map(async ({ u, rec }) => {
    const r = await rec.read();
    const ts = r.inputs.filter(Number.isFinite);
    return { name: u.name, first: ts.length ? Math.min(...ts) : null, last: ts.length ? Math.max(...ts) : null, inputs: ts.length, times: ts };
  }));
}

/** The typing was a race: every window holds input events and all of them overlap at one instant (overlapProof over first and last). */
function typingOverlap(windows) {
  const silent = windows.filter((w) => w.inputs === 0).map((w) => w.name);
  if (silent.length) throw new Error(`typing fired no input event in ${silent.join(", ")}'s document (is the editor open?)`);
  return overlapProof(windows.map((w) => ({ sentAt: w.first, firstByteAt: w.last })));
}

/**
 * Sample status/{d}/y every `everyMs` (as the emulator's admin, or the
 * operator's ADC on production; rtdbGetPatient, so a 503 is read again)
 * until stop(): {samples, max, seen, gone, errors, retries}. `gone` counts
 * entries seen once and later absent: only the product's compaction
 * (crdt/log.ts compact) removes an entry while people type. `retries` counts
 * the 503s read through; `errors` the reads that failed all the same.
 */
function watchLog(t, docId, { everyMs = 400 } = {}) {
  const everSeen = new Set();
  const gone = new Set();
  let samples = 0;
  let max = 0;
  let errors = 0;
  let retries = 0;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const y = await rtdbGetPatient(t, `status/${docId}/y`, { onRetry: () => (retries += 1) });
        const keys = y && typeof y === "object" ? Object.keys(y) : [];
        const now = new Set(keys);
        for (const k of keys) everSeen.add(k);
        for (const k of everSeen) if (!now.has(k)) gone.add(k);
        max = Math.max(max, keys.length);
        samples += 1;
      } catch {
        errors += 1;
      }
      if (!stopped) await sleep(everyMs);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return { samples, max, seen: everSeen.size, gone: gone.size, errors, retries };
    },
  };
}

/**
 * The plan's settle conditions (live.mjs settleLive: a missed deadline is an
 * I1 FAILURE; y is read through a 503, and 503s past 5 s end the case
 * INCONCLUSIVE as the stack not answering), named in a step.
 */
async function settle(ctx, users, docId, n, what = "settled") {
  const s = await settleLive(users, { docId, n });
  ctx.step(`${what} in ${s.ms} ms on ${s.hash.slice(0, 16)} (I1)${s.yRetries ? `; status/{d}/y answered 503 ${s.yRetries} time(s), each read again` : ""}`);
  return s;
}

/** settleLive's own I1 failure (a missed deadline): an AssertionError naming I1, never a cut of the stack. */
const isI1Failure = (err) => (err instanceof AssertionError || err?.code === "ERR_ASSERTION") && /^I1:/.test(String(err.message));

/** INCONCLUSIVE unless the typing passed a compaction of the live log. */
function requireCompaction(ctx, obs, log) {
  obs.compaction = log;
  ctx.step(`the live log: ${log.seen} entr(ies) seen over ${log.samples} samples, at most ${log.max} at once, ${log.gone} compacted away${log.retries ? `; ${log.retries} 503(s) read through` : ""}${log.errors ? `; ${log.errors} read(s) failed` : ""}`);
  if (log.gone === 0) inconclusive(ctx, obs, `the typing never passed the live log's compaction (no entry seen in status/{d}/y ever went away: ${JSON.stringify(log)}), so it did not test convergence across one`);
}

// --- reading what the peers and the draft hold -------------------------------------------------

/** Every peer's segments over the whole body, owned by `ids`: {name: segments}. */
async function segmentsOf(users, ids) {
  const out = {};
  for (const u of users) out[u.name] = await readSegments(u, ids);
  return out;
}

/** Chrome's parser over `html`, then body.innerHTML, hashed: how the draft and every peer's body are read alike. */
async function parsedBodyHash(parser, html) {
  const inner = await parseAndRun(parser, html, (doc) => (doc.body ? doc.body.innerHTML : ""));
  return { hash: sha(inner), length: inner.length };
}

/** Each peer's frame body, serialized and parsed again by the same parser as the draft: {name: hash}. */
async function peerBodyHashes(parser, users) {
  const out = {};
  for (const u of users) {
    const inner = await (await u.frame()).evaluate(() => document.body?.innerHTML ?? "");
    out[u.name] = (await parsedBodyHash(parser, `<!DOCTYPE html><html><head></head><body>${inner}</body></html>`)).hash;
  }
  return out;
}

/** GET /draft/<doc>/ (the entry) as the owner. */
async function readDraft(owner, docId) {
  const r = await owner.http.get(`/draft/${encodeURIComponent(docId)}/`, { expect: 200, timeoutMs: 60_000 });
  return r.text;
}

/** v1's shape as Chrome parses the fixture: {sentinels, children}. */
async function fixtureShape(parser) {
  return parseAndRun(parser, readFixture(FIXTURE, { raw: true }).toString("utf8"), (doc) => ({
    sentinels: doc.querySelectorAll('[id="e2e-sentinel"]').length,
    children: doc.body ? doc.body.children.length : 0,
  }));
}

/** A fingerprint with one root attribute taken out of both <html> and <body>. */
function withoutAttr(fp, name) {
  const drop = (a) => (a ? Object.fromEntries(Object.entries(a).filter(([k]) => k !== name)) : a);
  return { ...fp, bodyAttrs: drop(fp.bodyAttrs), htmlAttrs: drop(fp.htmlAttrs) };
}

/** S3's own symptom: the `spellcheck` attribute of <body> and <html>, in v1 and in the draft (null: absent). */
function spellcheckOf(fp1, fpD) {
  const pick = (a) => (a && Object.prototype.hasOwnProperty.call(a, "spellcheck") ? a.spellcheck : null);
  const body = { v1: pick(fp1.bodyAttrs), draft: pick(fpD.bodyAttrs) };
  const html = { v1: pick(fp1.htmlAttrs), draft: pick(fpD.htmlAttrs) };
  return { equal: body.v1 === body.draft && html.v1 === html.draft, body, html };
}

/**
 * The draft against v1 and the peers: its body hash and every peer's (I5),
 * its segments (I2 in the draft), DECOR, BODYATTR whole and apart from S3's
 * `spellcheck`, and S3's `spellcheck` alone.
 */
async function readDraftAgainstPeers(ctx, { parser, owner, docId, users, ids, typed }) {
  const draftHtml = await readDraft(owner, docId);
  ctx.ev.text("draft.html", draftHtml);
  const peerHashes = await peerBodyHashes(parser, users);
  const draftHash = (await parsedBodyHash(parser, draftHtml)).hash;
  const draftSegs = await segmentsOfHtml(parser, draftHtml, ids);
  const fp1 = await fingerprint(parser, readFixture(FIXTURE, { raw: true }).toString("utf8"));
  const fpD = await fingerprint(parser, draftHtml);
  const decor = diffFingerprint(fp1, fpD, true, { ignoreBodyAttr: true });
  const bodyAttr = bodyAttrDiff(fp1, fpD);
  const beyondS3 = bodyAttrDiff(withoutAttr(fp1, "spellcheck"), withoutAttr(fpD, "spellcheck"));
  const spellcheck = spellcheckOf(fp1, fpD);
  return { draftHash, peerHashes, draftSegs, typed, decoration: decor.decoration, lost: decor.lost, structure: decor.structure, bodyAttr, beyondS3, spellcheck };
}

/** DECOR on the draft, and BODYATTR apart from the known S3 attribute: what no suspect predicts to break. */
function assertCleanDraft(d) {
  assert.deepEqual(d.decoration, [], "DECOR: decoration in the draft");
  assert.deepEqual(d.lost, [], "DECOR: author markers lost from the draft");
  assert.deepEqual(d.structure, [], "DECOR: the draft's structure changed");
  assert.equal(d.beyondS3.equal, true, `BODYATTR differs beyond the known S3 spellcheck: ${JSON.stringify({ body: d.beyondS3.body, html: d.beyondS3.html })}`);
}

/** I5 apart from S3's attribute, then I2 in the draft. */
function assertDraftEqualsPeers(d) {
  assertInvariant(checkI5({ draftHash: d.draftHash, peerHashes: d.peerHashes, decoration: d.decoration, bodyAttr: d.beyondS3 }));
  assertInvariant(checkI2({ peers: {}, draft: d.draftSegs, typed: d.typed }));
}

/** I3 with the top-level count v1's plus `added` (C3: one paragraph per Enter), on every peer: a judge's result. */
function checkShape(shapes, baseline, added = 0) {
  const want = baseline.children + added;
  const failures = [];
  const entries = Object.entries(shapes);
  if (entries.length === 0) failures.push("no peer to look in");
  for (const [name, s] of entries) {
    if (s.sentinels !== 1) failures.push(`${name}: the sentinel appears ${s.sentinels} time(s), not once`);
    if (s.children !== want) failures.push(`${name}: ${s.children} top-level element(s), not v1's ${baseline.children}${added ? ` plus the ${added} paragraph(s) Enter made (${want})` : ""}`);
  }
  return { invariant: "I3", ok: failures.length === 0, failures };
}

/** Stop every armed user's capture (User.capture's stop() is synchronous); in a finally, so a failure never hides the case's own. */
function stopCaptures(armed) {
  for (const { cap } of armed ?? []) {
    try {
      cap.stop();
    } catch {
      /* already stopped, or its page is gone */
    }
  }
}

/** Every POST /draft the armed users sent, settled: [{name, status, sentAt, respondedAt, ms, failure, state, tokens}] (`tokens`: the valid tokens in the html it posted). */
async function savesOf(armed) {
  const rows = [];
  for (const { u, cap } of armed) {
    cap.stop();
    for (const r of cap) {
      const html = typeof r.postJson?.html === "string" ? r.postJson.html : "";
      rows.push({ name: u.name, status: r.status ?? null, sentAt: r.sentAt ?? null, respondedAt: r.respondedAt ?? null, ms: Number.isFinite(r.respondedAt) && Number.isFinite(r.sentAt) ? r.respondedAt - r.sentAt : null, failure: r.failure ?? null, state: r.state, tokens: scanTokens(html).tokens.map((t) => t.token) });
    }
  }
  return rows;
}

/** Every save state each armed user's toolbar showed: {name: ["dirty", "saving", …]}. */
async function saveStatesOf(armed) {
  const out = {};
  for (const { u, rec } of armed) out[u.name] = (await rec.stop()).states.map((s) => s.s);
  return out;
}

/** C21's oracle (locally): every POST /draft answered 200, no save state ever "error". */
function assertSaves(rows, states) {
  const bad = rows.filter((r) => r.status !== 200).map((r) => `${r.name}: ${r.status ?? r.state}${r.failure ? ` (${r.failure})` : ""}`);
  assert.deepEqual(bad, [], "C21: every POST /draft is answered 200");
  const errored = Object.entries(states).filter(([, ss]) => ss.includes("error")).map(([name]) => name);
  assert.deepEqual(errored, [], 'C21: no save state is ever "error"');
}

/**
 * Wait until the saves are over, as settleLive's save conditions are but
 * without judging them: every captured POST /draft settled, nothing "dirty"
 * or "saving", and no POST /draft for SETTLE.draftQuietMs. A save in "error"
 * is over (nothing retries it without new input), so the case can name it
 * itself before the settle names it as I1.
 */
async function savesQuiet(users, armed, n) {
  const timeout = settleDeadlineMs(n) + 30_000;
  await eventually(async () => {
    if (armed.some(({ cap }) => [...cap].some((r) => !r.settled))) return false;
    const states = await Promise.all(users.map((u) => u.saveState()));
    if (states.some((s) => s === "dirty" || s === "saving")) return false;
    const at = lastDraftAt(users);
    return at === null || Date.now() - at >= SETTLE.draftQuietMs;
  }, { timeout, interval: 250, message: `every POST /draft settled, nothing dirty or saving, and no POST /draft for ${SETTLE.draftQuietMs} ms` });
}

/** The banners each watch saw: {name: [{t, text}]}, only users that saw one. */
async function bannerSightings(users, watches) {
  const out = {};
  for (let i = 0; i < users.length; i += 1) {
    const rows = await watches[i].stop().catch(() => []);
    if (rows.length) out[users[i].name] = rows.map((r) => ({ t: r.t, text: String(r.text ?? "").slice(0, 160), visible: r.visible }));
  }
  return out;
}

/** Poll a user's frame until #id holds `text` (a reading frame reloads on a peer's save: an arrival probe would watch the old document). */
async function waitTextIn(u, id, text, timeoutMs) {
  return eventually(async () => {
    try {
      return await (await u.frame()).evaluate(({ sel, text }) => document.querySelector(sel)?.textContent.includes(text) === true, { sel: idSelector(id), text });
    } catch {
      return false;
    }
  }, { timeout: timeoutMs, interval: 200, message: `${u.name}'s frame shows ${text} in #${id}` });
}

/** Type tokens as `from` and wait until the last one is in #id at every other peer (live: an arrival probe). */
async function typeAndArrive(users, from, id, tokens, timeoutMs) {
  const others = users.filter((u) => u !== from);
  const last = tokens.at(-1);
  await Promise.all(others.map((u) => armArrival(u, id, last)));
  await typeTokens(from, id, tokens.slice(0, -1));
  const save = await from.typeAndAutosave(idSelector(id), last, { delay: KEY_DELAY_MS, at: "end", timeout: 60_000 });
  await Promise.all(others.map((u) => waitForArrival(u, last, { timeout: timeoutMs })));
  return save;
}

/** What one user's frame holds now: {children, sentinels, peers: the token owners in its body, tokens}. */
async function frameState(u) {
  const s = await (await u.frame()).evaluate((own) => {
    const mine = new Set(own);
    return {
      children: document.body ? [...document.body.children].filter((el) => !mine.has(el.getAttribute("data-bshd") ?? "")).length : 0,
      sentinels: document.querySelectorAll('[id="e2e-sentinel"]').length,
      text: document.body?.textContent ?? "",
    };
  }, [...OWN_MARKER_VALUES]);
  const tokens = scanTokens(s.text).tokens;
  return { children: s.children, sentinels: s.sentinels, tokens: tokens.map((t) => t.token), owners: [...new Set(tokens.map((t) => t.peer))] };
}

// --- C1 ------------------------------------------------------------------------------------

const C1_NAME = "C1 disjoint-paragraph typing: N editors type tokens into their own paragraphs at once, past the live log's compaction; every peer converges (I1), holds every token once and whole (I2) and the document's shape (I3), a probe reaches every Shared peer (I13), and the draft carries no decoration (DECOR, BODYATTR apart from S3)";

scenario(C1_NAME, { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const n = ctx.n;
  const obs = record(ctx, "C1");
  await work(ctx, obs, () => withRss(ctx, n, async () => {
    const { docId, users, owner } = await join(ctx, n, `C1 disjoint N=${n}`);
    obs.stage = "joined";
    const parser = await ctx.users.parser();
    const baseline = await fixtureShape(parser);
    ctx.step(`v1: ${baseline.children} top-level elements, the sentinel ${baseline.sentinels} time(s); every peer watches for the conflict banner`);
    const watches = await Promise.all(users.map((u) => u.watchFor(BANNER_SEL, CONFLICT_RE)));
    const log = tokenLog(ctx.target.runId);
    let armed = null;
    let logWatch = null;
    try {
      const probe = log.next(users[0].name, "e2e-1");
      ctx.step(`I13: ${users[0].name} types the probe ${probe} at the end of #e2e-1; every other peer is watched for it`);
      const { arrivals } = await probeArrivals(users, { from: users[0], id: "e2e-1", text: probe, timeoutMs: settleDeadlineMs(n) });
      const i13 = checkI13({ arrivals });
      obs.i13 = { arrivals, medianMs: i13.medianMs, maxMs: i13.maxMs };
      ctx.t.diagnostic(`I13 N=${n}: median ${i13.medianMs} ms, max ${i13.maxMs} ms, ${arrivals.filter((a) => a.ms == null).length} never`);

      const plan = users.map((u, i) => ({ u, id: paragraph(i), tokens: Array.from({ length: TOKENS }, () => log.next(u.name, paragraph(i))) }));
      armed = await armSaves(users);
      logWatch = watchLog(ctx.target, docId);
      obs.stage = "typing";
      ctx.step(`at once, each of ${n} editors types ${TOKENS} tokens at the end of its own paragraph (#e2e-1…#e2e-${n})`);
      await Promise.all(plan.map(({ u, id, tokens }) => typeTokens(u, id, tokens)));
      const windows = await inputWindows(armed);
      const race = typingOverlap(windows);
      obs.race = { ...race, windows: windows.map(({ times, ...w }) => w) };
      ctx.step(`race: every typing window overlaps (the last to start began ${Math.round(race.marginMs ?? NaN)} ms before the first to finish ended)`);
      if (!race.ok) obs.inconclusive = `the typing windows did not overlap: ${race.reason}`;
      requireConclusive(ctx, { overlap: race });

      obs.stage = "settling";
      await settle(ctx, users, docId, n);
      requireCompaction(ctx, obs, await logWatch.stop());
      logWatch = null;

      obs.stage = "reading";
      const ids = plan.map((p) => p.id);
      const peers = await segmentsOf(users, ids);
      const shapes = await readI3All(users);
      obs.draft = await readDraftAgainstPeers(ctx, { parser, owner, docId, users, ids, typed: log.typed });
      const rows = await savesOf(armed);
      obs.saves = { rows, states: await saveStatesOf(armed), race: savesOverlap(rows) };
      ctx.ev.json("peers", { peers, shapes });
      ctx.ev.json("saves", obs.saves);
      ctx.step(`the draft: ${obs.draft.draftHash.slice(0, 12)}; the peers: ${JSON.stringify(obs.draft.peerHashes).slice(0, 300)}; BODYATTR v1→draft ${JSON.stringify({ body: obs.draft.bodyAttr.body, html: obs.draft.bodyAttr.html })}; ${rows.length} save(s), ${obs.saves.race.ok ? `two from ${obs.saves.race.pair.join(" and ")} in flight at once` : "no two from different peers in flight at once"}`);
      obs.stage = "measured";

      assertInvariant(checkI2({ peers, typed: log.typed }));
      assertInvariant(checkI3({ peers: shapes, baseline }));
      const never = arrivals.filter((a) => a.shared && a.ms == null).map((a) => a.name);
      assert.deepEqual(never, [], `I13: every Shared peer receives the probe (within the ${settleDeadlineMs(n)} ms settle deadline)`);
      if (ctx.target.kind === "prod") assertInvariant(i13);
      assertCleanDraft(obs.draft);
    } finally {
      if (logWatch) await logWatch.stop().catch(() => undefined);
      stopCaptures(armed);
      obs.banner = await bannerSightings(users, watches);
    }
  }));
});

// S17 is not judged here: nothing makes a late save land last. C1 late save
// (deterministic) and C21 draft (a proven save race) judge it.
scenario("C1 draft: after disjoint typing settles, GET /draft's body equals every peer's and holds every typed token once and whole (I5 apart from S3's spellcheck, I2 in the draft)", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: JUDGE_MS }, async (ctx) => {
  const d = observation(ctx, "C1", "draft");
  const saves = observation(ctx, "C1", "saves");
  ctx.step(`the draft ${d.draftHash.slice(0, 12)} against ${Object.keys(d.peerHashes).length} peer(s); ${saves.rows.length} save(s), ${saves.race.ok ? `two raced (${saves.race.pair.join(", ")})` : "none raced"}`);
  assertDraftEqualsPeers(d);
});

scenario("C1 BODYATTR: the draft disjoint typing left carries no spellcheck attribute on <body> or <html> that v1 lacks (I5's BODYATTR, S3's own attribute)", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: JUDGE_MS }, async (ctx) => {
  const d = observation(ctx, "C1", "draft");
  const s = d.spellcheck;
  ctx.step(`spellcheck v1→draft: <body> ${JSON.stringify(s.body.v1)} → ${JSON.stringify(s.body.draft)}, <html> ${JSON.stringify(s.html.v1)} → ${JSON.stringify(s.html.draft)}; every other root attribute is the work case's (BODYATTR apart from S3)`);
  assert.deepEqual({ body: s.body.draft, html: s.html.draft }, { body: s.body.v1, html: s.html.v1 }, `S3 oracle (I5 BODYATTR): the draft's spellcheck attribute is not v1's: ${JSON.stringify(s)}`);
});

scenario('C1 banner: no co-editor is shown "<peer> saved a change while you were editing" while the others type and autosave', { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: JUDGE_MS }, async (ctx) => {
  const seen = observation(ctx, "C1", "banner");
  ctx.step(`conflict banners seen: ${Object.entries(seen).map(([u, rows]) => `${u} ×${rows.length}`).join(", ") || "none"}`);
  assert.deepEqual(seen, {}, 'S9 oracle: no co-editor is shown "<peer> saved a change while you were editing"');
});

scenario("C1 shared save notice: a live co-editor autosave never offers competing copies", { tiers: BOTH, n: [2], timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const { docId, users } = await join(ctx, ctx.n, "C1 shared save notice");
  const watches = await Promise.all(users.map((u) => u.watchFor(BANNER_SEL, CONFLICT_RE)));
  const log = tokenLog(ctx.target.runId);
  await users[0].typeAndAutosave(idSelector("e2e-1"), log.next(users[0].name, "e2e-1"), { delay: KEY_DELAY_MS, timeout: 60_000 });
  await settle(ctx, users, docId, ctx.n);
  assert.deepEqual(await bannerSightings(users, watches), {}, "a live co-editor autosave never offers competing copies");
});

// --- C1-serial (and C21's serial control) ------------------------------------------------------

/**
 * The positive control for C1 and C21. Phase 1: everyone Shared, and each in
 * turn types its tokens, waits for its autosave (200) and for its last token
 * at every peer; then settle and every C1 oracle but S3's. Phase 2: everyone
 * leaves the editor and opens the document afresh (React state, conflict
 * banners included, starts over); then each in turn enters the editor, types
 * a token, autosaves, waits until every reader's frame shows it (so its save
 * reached every page before anyone else edits) and leaves: nobody is shown
 * the conflict banner.
 */
async function c1Serial(ctx, n) {
  const obs = record(ctx, "C1-serial");
  await work(ctx, obs, () => withRss(ctx, n, async () => {
    const { docId, users, owner } = await join(ctx, n, `C1 serial N=${n}`);
    const parser = await ctx.users.parser();
    const baseline = await fixtureShape(parser);
    const log = tokenLog(ctx.target.runId);
    const deadline = settleDeadlineMs(n);
    const plan = users.map((u, i) => ({ u, id: paragraph(i), tokens: Array.from({ length: TOKENS }, () => log.next(u.name, paragraph(i))) }));
    const armed = await armSaves(users);
    let logWatch = watchLog(ctx.target, docId);
    try {
      ctx.step(`phase 1: one editor after another types ${TOKENS} tokens into its own paragraph, waits for its autosave and for its last token at every peer`);
      for (const { u, id, tokens } of plan) await typeAndArrive(users, u, id, tokens, Math.max(deadline, 30_000));
      await settle(ctx, users, docId, n);
      const rows = await savesOf(armed);
      const states = await saveStatesOf(armed);
      ctx.ev.json("saves", { rows, states });
      ctx.step(`${rows.length} POST /draft, statuses ${JSON.stringify([...new Set(rows.map((r) => r.status))])}`);
      assertSaves(rows, states);
      requireCompaction(ctx, obs, await logWatch.stop());
      logWatch = null;
      const ids = plan.map((p) => p.id);
      const peers = await segmentsOf(users, ids);
      const shapes = await readI3All(users);
      const d = await readDraftAgainstPeers(ctx, { parser, owner, docId, users, ids, typed: log.typed });
      ctx.ev.json("draft-vs-peers", { ...d, draftSegs: undefined });
      assertDraftEqualsPeers(d);
      assertInvariant(checkI2({ peers, typed: log.typed }));
      assertInvariant(checkI3({ peers: shapes, baseline }));
      assertCleanDraft(d);

      ctx.step("phase 2: everyone leaves the editor and opens the document afresh; every page watches for the conflict banner");
      await Promise.all(users.map((u) => u.done()));
      for (let i = 0; i < users.length; i += 5) await Promise.all(users.slice(i, i + 5).map((u) => u.open(docId, { timeout: 90_000 })));
      const watches = await Promise.all(users.map((u) => u.watchFor(BANNER_SEL, CONFLICT_RE)));
      let seen = null;
      try {
        for (const [i, u] of users.entries()) {
          const id = paragraph(i);
          const token = log.next(u.name, id);
          await u.enterEdit({ waitShared: true, timeout: 90_000 });
          const save = await u.typeAndAutosave(idSelector(id), token, { delay: KEY_DELAY_MS, at: "end", timeout: 60_000 });
          await Promise.all(users.filter((o) => o !== u).map((o) => waitTextIn(o, id, token, 30_000)));
          await u.done();
          ctx.step(`${u.name} edited alone: ${token} saved (${save.status}) and shown to every reader; Done`);
        }
        await sleep(2_000);
      } finally {
        seen = await bannerSightings(users, watches);
      }
      ctx.step(`conflict banners seen in phase 2: ${Object.entries(seen).map(([u, rows]) => `${u} ×${rows.length}`).join(", ") || "none"}`);
      assert.deepEqual(seen, {}, BANNER_SERIAL_MSG);
    } finally {
      if (logWatch) await logWatch.stop().catch(() => undefined);
      stopCaptures(armed);
    }
  }));
}

// Its "[N=2]" case is the target of e2e/patches/controls-c01-draft-stale and
// controls-c01-conflict-banner (run.mjs controls passes --n 2 --trials 1).
scenario("C1-serial positive control: the same typing one editor after another passes every C1 oracle but S3's and C21's (every save 200, never an error), and editing one editor at a time shows nobody the conflict banner", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: SERIAL_MS, ...LIVE }, async (ctx) => {
  await c1Serial(ctx, ctx.n);
});

// --- C1 late save (S17, deterministic) -----------------------------------------------------------

/**
 * The late save, proven from the captures (this process's clock for both):
 * p1's held save (its first) was sent before every later peer's save,
 * answered after all of them, and holds none of their tokens; the last of
 * theirs to be answered holds every token typed. {ok, why, held, lastOther}.
 */
function lateSaveProof(rows, early, plan) {
  const why = [];
  const mine = rows.filter((r) => r.name === early.name);
  const others = rows.filter((r) => r.name !== early.name);
  const held = mine[0] ?? null;
  const theirTokens = plan.filter((p) => p.u !== early).flatMap((p) => p.tokens);
  const allTokens = plan.flatMap((p) => p.tokens);
  const lastOther = [...others].filter((r) => Number.isFinite(r.respondedAt)).sort((a, b) => a.respondedAt - b.respondedAt).at(-1) ?? null;
  if (!held) why.push(`${early.name} sent no POST /draft`);
  if (others.length === 0) why.push("no later peer saved");
  if (held && others.length) {
    if (held.status !== 200) why.push(`${early.name}'s held save was answered ${held.status ?? held.state}`);
    const sentBefore = others.filter((r) => !(r.sentAt > held.sentAt));
    if (sentBefore.length) why.push(`${sentBefore.map((r) => r.name).join(", ")} saved before ${early.name}'s held save was sent`);
    const answeredAfter = others.filter((r) => !(r.respondedAt < held.respondedAt));
    if (answeredAfter.length) why.push(`${answeredAfter.map((r) => r.name).join(", ")}'s save was answered after ${early.name}'s held save`);
    const reached = theirTokens.filter((t) => held.tokens.includes(t));
    if (reached.length) why.push(`${early.name}'s held save already holds ${reached.join(", ")}`);
    if (lastOther) {
      const missing = allTokens.filter((t) => !lastOther.tokens.includes(t));
      if (missing.length) why.push(`the last later save (${lastOther.name}) lacks ${missing.join(", ")}`);
    }
  }
  const strip = (r) => (r ? { name: r.name, status: r.status, sentAt: r.sentAt, respondedAt: r.respondedAt, tokens: r.tokens.length } : null);
  return { ok: why.length === 0, why, held: strip(held), lastOther: strip(lastOther), saves: rows.length };
}

/**
 * C1 late save, or its serial control (`hold: false`). Every peer types
 * TOKENS tokens into its own paragraph in turn; p1 first. With `hold`, p1's
 * first POST /draft is held in its own browser until every later peer's save
 * has been answered, and goes last. Then: saves over, the settle (I1), the
 * compaction, I2 on every peer, the draft against the peers. The control
 * asserts I5 and I2 in the draft itself; the late case leaves them to its
 * judge.
 */
async function lateSave(ctx, { hold }) {
  const n = ctx.n;
  const obs = record(ctx, hold ? "C1-late" : "C1-late-serial");
  await work(ctx, obs, () => withRss(ctx, n, async () => {
    const { docId, users, owner } = await join(ctx, n, `C1 late save${hold ? "" : " serial"} N=${n}`);
    const parser = await ctx.users.parser();
    const log = tokenLog(ctx.target.runId);
    const deadline = Math.max(settleDeadlineMs(n), 30_000);
    const plan = users.map((u, i) => ({ u, id: paragraph(i), tokens: Array.from({ length: TOKENS }, () => log.next(u.name, paragraph(i))) }));
    const [first, ...rest] = plan;
    const early = first.u;
    const armed = await armSaves(users);
    let logWatch = watchLog(ctx.target, docId);
    let delay = null;
    let release = () => {};
    try {
      if (hold) {
        const go = new Promise((resolve) => {
          release = resolve;
        });
        delay = await early.delayRequests("/draft", { rules: [() => go] });
        ctx.step(`${early.name} types ${TOKENS} tokens into #${first.id}; its first POST /draft is held in its browser until every later save is answered`);
        const others = users.filter((u) => u !== early);
        await Promise.all(others.map((u) => armArrival(u, first.id, first.tokens.at(-1))));
        await typeTokens(early, first.id, first.tokens);
        await Promise.all(others.map((u) => waitForArrival(u, first.tokens.at(-1), { timeout: deadline })));
        try {
          await eventually(() => delay.seen() >= 1, { timeout: 15_000, interval: 50, message: `${early.name}'s autosave reaches the hold` });
        } catch (err) {
          inconclusive(ctx, obs, `the sync precondition did not hold: ${early.name}'s autosave never reached the hold (${firstLine(err)})`);
        }
      } else {
        ctx.step(`${early.name} types ${TOKENS} tokens into #${first.id}; its autosave goes at once (answered 200) and its last token reaches every peer`);
        await typeAndArrive(users, early, first.id, first.tokens, deadline);
      }
      ctx.step(`then ${rest.map((p) => p.u.name).join(", ")}, one after another, type ${TOKENS} tokens into their own paragraph; each autosave answered 200, each last token at every peer${hold ? `, ${early.name} included` : ""}`);
      for (const p of rest) await typeAndArrive(users, p.u, p.id, p.tokens, deadline);
      if (hold) {
        ctx.step(`every later save answered: ${early.name}'s held save goes now`);
        release();
      }
      await savesQuiet(users, armed, n);
      const rows = await savesOf(armed);
      const states = await saveStatesOf(armed);
      ctx.ev.json("saves", { rows, states, held: delay?.rows ?? null });
      const bad = rows.filter((r) => r.status !== 200).map((r) => `${r.name}: ${r.status ?? r.state}`);
      precondition(bad.length === 0, `every POST /draft of the late-save session is answered 200 (got ${bad.join(", ")})`);
      if (hold) {
        const proof = lateSaveProof(rows, early, plan);
        obs.race = proof;
        ctx.ev.json("late-save", proof);
        ctx.step(proof.ok ? `late: ${early.name}'s save (${proof.held.tokens} token(s), none of the later peers') was sent first and answered last; the last later save held all ${plan.length * TOKENS}` : `late save NOT proven: ${proof.why.join("; ")}`);
        if (!proof.ok) inconclusive(ctx, obs, `the sync precondition did not hold: ${proof.why.join("; ")}`);
      }
      obs.stage = "settling";
      await settle(ctx, users, docId, n);
      requireCompaction(ctx, obs, await logWatch.stop());
      logWatch = null;
      obs.stage = "reading";
      const ids = plan.map((p) => p.id);
      const peers = await segmentsOf(users, ids);
      obs.draft = await readDraftAgainstPeers(ctx, { parser, owner, docId, users, ids, typed: log.typed });
      ctx.ev.json("peers", peers);
      ctx.step(`the draft: ${obs.draft.draftHash.slice(0, 12)}; the peers: ${JSON.stringify(obs.draft.peerHashes).slice(0, 300)}`);
      obs.stage = "measured";
      assertInvariant(checkI2({ peers, typed: log.typed }));
      assertCleanDraft(obs.draft);
      if (!hold) assertDraftEqualsPeers(obs.draft);
    } finally {
      release();
      if (delay) await delay.restore().catch(() => undefined);
      if (logWatch) await logWatch.stop().catch(() => undefined);
      stopCaptures(armed);
    }
  }));
}

scenario("C1 late save: one editor's autosave is held in its browser while the others type and save in turn, then lands last; the live copies still converge (I1) and hold every token (I2), and the draft carries no decoration (DECOR, BODYATTR apart from S3)", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  await lateSave(ctx, { hold: true });
});

scenario("C1 late save draft: after a save sent first lands last, GET /draft's body still equals every peer's and holds every typed token once and whole (I5 apart from S3's spellcheck, I2 in the draft)", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: JUDGE_MS, defect: "S17" }, async (ctx) => {
  const d = observation(ctx, "C1-late", "draft");
  ctx.step(`the draft ${d.draftHash.slice(0, 12)} against ${Object.keys(d.peerHashes).length} peer(s), after ${observed.get(keyOf("C1-late", ctx))?.race?.held?.name ?? "p1"}'s save sent first landed last`);
  assertDraftEqualsPeers(d);
});

scenario("C1 late save serial positive control: the same typing with every autosave landing in the order it was made leaves GET /draft equal to every peer's, every token once and whole in it (I5 apart from S3, I2 in the draft)", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: SERIAL_MS, ...LIVE }, async (ctx) => {
  await lateSave(ctx, { hold: false });
});

// --- C1 refused append (X-c01-typing-2, the client half of X-c01-typing-1) ------------------------

/**
 * C1 refused append, or its control (`refuse: false`). p1 types one token
 * into #e2e-1. With `refuse`, the first append its typing makes is refused
 * (e2e/patches/amplify-c01-append-refused: held at the client gate, then
 * thrown as the Database's refusal, nothing written) and p1 types on. The
 * session is then let settle; a missed deadline is recorded, not thrown (the
 * judge says what it means), and every peer's body hash and segments are
 * read. The log stays far under the 64-entry compaction: one token is 16
 * appends after the seed. The control asserts I1 and I2 itself.
 */
async function refusedAppend(ctx, { refuse }) {
  const n = ctx.n;
  const obs = record(ctx, refuse ? "C1-refused" : "C1-refused-control");
  await work(ctx, obs, () => withRss(ctx, n, async () => {
    const { docId, users } = await join(ctx, n, `C1 refused append${refuse ? "" : " control"} N=${n}`);
    const typist = users[0];
    const id = paragraph(0);
    const log = tokenLog(ctx.target.runId);
    const tokens = [log.next(typist.name, id)];
    const g = refuse ? gates(ctx.target) : null;
    try {
      if (refuse) {
        await g.hold(REFUSE_GATE, { key: docId });
        await typist.page.evaluate(() => {
          window.__e2eRefuseAppends = 1;
        });
        ctx.step(`${typist.name}'s next live-log append will be refused (the gate ${REFUSE_GATE} holds it first); ${typist.name} types ${tokens[0]} at the end of #${id}`);
      } else {
        ctx.step(`${typist.name} types ${tokens[0]} at the end of #${id}; nothing is refused`);
      }
      const typing = typeTokens(typist, id, tokens);
      if (refuse) {
        await requireHeld(ctx, g, REFUSE_GATE, 1, { key: docId, timeoutMs: 20_000 });
        await g.release(REFUSE_GATE, { key: docId, disarm: true });
      }
      await typing;
      if (refuse) {
        let state = null;
        try {
          state = await eventually(async () => {
            const s = await typist.page.evaluate(() => ({ refused: window.__e2eRefusedAppends ?? [], left: window.__e2eRefuseAppends ?? null }));
            return s.refused.length >= 1 ? s : false;
          }, { timeout: 10_000, interval: 100, message: `${typist.name}'s page records the refusal` });
        } catch (err) {
          inconclusive(ctx, obs, `the sync precondition did not hold: no refusal was recorded on ${typist.name}'s page (${firstLine(err)})`);
        }
        const uncaught = typist.log.errors.filter((e) => /refused on purpose/.test(String(e.message))).map((e) => e.message.slice(0, 200));
        obs.refusal = { refused: state.refused, left: state.left, uncaught };
        ctx.ev.json("refusal", obs.refusal);
        ctx.step(`refused: ${state.refused.length} append(s) of ${state.refused.map((r) => r.bytes).join(", ")} base64 char(s); ${uncaught.length} uncaught page error(s) name it (nothing in the page handled the refusal)`);
        if (state.refused.length !== 1 || state.left !== 0) inconclusive(ctx, obs, `the sync precondition did not hold: ${state.refused.length} append(s) refused, ${state.left} still asked for; exactly one was meant`);
      }
      obs.stage = "settling";
      let settleError = null;
      try {
        await settle(ctx, users, docId, n);
      } catch (err) {
        if (!refuse || !isI1Failure(err)) throw err;
        settleError = firstLine(err);
        ctx.step(`did not settle: ${settleError}`);
      }
      const y = await rtdbGetPatient(ctx.target, `status/${docId}/y`);
      obs.stage = "reading";
      const samples = await readI1(users);
      const peers = await segmentsOf(users, [id]);
      const holds = Object.fromEntries(await Promise.all(users.map(async (u) => [u.name, (await frameState(u)).tokens])));
      obs.live = { samples, peers, typed: log.typed, settleError, yEntries: y && typeof y === "object" ? Object.keys(y).length : 0, holds };
      ctx.ev.json("live", obs.live);
      ctx.step(`each peer's body: ${samples.map((s) => `${s.name} ${String(s.hash).slice(0, 12)} (${s.length})`).join(", ")}; the token on ${Object.entries(holds).filter(([, t]) => t.includes(tokens[0])).map(([name]) => name).join(", ") || "nobody"}; status/{d}/y holds ${obs.live.yEntries} entr(ies)`);
      obs.stage = "measured";
      if (!refuse) {
        assertInvariant(checkI1(samples));
        assertInvariant(checkI2({ peers, typed: log.typed }));
      }
    } finally {
      if (g) await g.release(REFUSE_GATE, { key: docId, disarm: true }).catch(() => undefined);
    }
  }));
}

scenario("C1 refused append: one editor's live-log append is refused as the Database refused one in X-c01-typing-1, and it types on; the session is let settle and every peer is read", { tiers: LOCAL, needs: [REFUSE_PATCH], n: [2, 5, 10, 20], timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  await refusedAppend(ctx, { refuse: true });
});

// X-c01-typing-2: app/src/crdt/log.ts:108-113 sends each update once
// (`void log.append(...).then(...)`, no catch), so a refused append is
// neither sent again nor reported; every later update of that editor depends
// on it and waits in each peer's Y.Doc, unapplied, until the editor's next
// compaction (seen.size >= COMPACT_AFTER, log.ts:74, 125) appends its whole
// state.
scenario("C1 refused append converges: after one editor's live-log append was refused, every peer still converges (I1) and holds the token it typed once and whole (I2)", { tiers: LOCAL, needs: [REFUSE_PATCH], n: [2, 5, 10, 20], timeoutMs: JUDGE_MS, defect: "X-c01-typing-2" }, async (ctx) => {
  const live = observation(ctx, "C1-refused", "live");
  ctx.step(`settle: ${live.settleError ?? "settled"}; status/{d}/y ${live.yEntries} entr(ies), under the 64-entry compaction`);
  const i1 = checkI1(live.samples);
  const i2 = checkI2({ peers: live.peers, typed: live.typed });
  if (!i1.ok) assertInvariant({ ...i1, failures: [...i1.failures, ...(i2.ok ? [] : i2.failures.map((f) => `I2: ${f}`))] });
  assertInvariant(i2);
});

scenario("C1 refused append positive control: the same typing with no append refused converges (I1) and every peer holds the token once and whole (I2)", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  await refusedAppend(ctx, { refuse: false });
});

// --- C2 ------------------------------------------------------------------------------------

scenario("C2 same-paragraph typing: N editors type tokens at the end of one paragraph at once, past the live log's compaction; every peer converges (I1) and the document keeps its shape (I3)", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const n = ctx.n;
  const obs = record(ctx, "C2");
  await work(ctx, obs, () => withRss(ctx, n, async () => {
    const { docId, users } = await join(ctx, n, `C2 same paragraph N=${n}`);
    const parser = await ctx.users.parser();
    const baseline = await fixtureShape(parser);
    const log = tokenLog(ctx.target.runId);
    const plan = users.map((u) => ({ u, tokens: Array.from({ length: TOKENS }, () => log.next(u.name, "e2e-1")) }));
    const armed = await armSaves(users);
    let logWatch = watchLog(ctx.target, docId);
    try {
      ctx.step(`at once, each of ${n} editors types ${TOKENS} tokens at the end of #e2e-1`);
      await Promise.all(plan.map(({ u, tokens }) => typeTokens(u, "e2e-1", tokens)));
      const windows = await inputWindows(armed);
      const race = typingOverlap(windows);
      obs.race = { ...race, windows: windows.map(({ times, ...w }) => w) };
      ctx.step(`race: every typing window overlaps (margin ${Math.round(race.marginMs ?? NaN)} ms)`);
      if (!race.ok) obs.inconclusive = `the typing windows did not overlap: ${race.reason}`;
      requireConclusive(ctx, { overlap: race });
      obs.stage = "settling";
      await settle(ctx, users, docId, n);
      requireCompaction(ctx, obs, await logWatch.stop());
      logWatch = null;
      obs.stage = "reading";
      const peers = await segmentsOf(users, ["e2e-1"]);
      const shapes = await readI3All(users);
      obs.tokens = { peers, typed: log.typed };
      ctx.ev.json("peers", { peers, shapes });
      obs.stage = "measured";
      assertInvariant(checkI3({ peers: shapes, baseline }));
      assertInvariant(checkI2({ peers, typed: log.typed }));
    } finally {
      if (logWatch) await logWatch.stop().catch(() => undefined);
      stopCaptures(armed);
    }
  }));
});

scenario("C2 tokens: after same-paragraph typing, every token is once and whole inside #e2e-1 on every peer (I2)", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: JUDGE_MS }, async (ctx) => {
  const t = observation(ctx, "C2", "tokens");
  assertInvariant(checkI2({ peers: t.peers, typed: t.typed }));
});

scenario("C2-serial positive control: the same tokens typed into one paragraph one editor after another are once and whole on every peer (I1, I2, I3)", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: SERIAL_MS, ...LIVE }, async (ctx) => {
  const n = ctx.n;
  const obs = record(ctx, "C2-serial");
  await work(ctx, obs, () => withRss(ctx, n, async () => {
    const { docId, users } = await join(ctx, n, `C2 serial N=${n}`);
    const parser = await ctx.users.parser();
    const baseline = await fixtureShape(parser);
    const log = tokenLog(ctx.target.runId);
    let logWatch = watchLog(ctx.target, docId);
    try {
      ctx.step(`one editor after another types ${TOKENS} tokens at the end of #e2e-1 and waits for its last token at every peer`);
      for (const u of users) await typeAndArrive(users, u, "e2e-1", Array.from({ length: TOKENS }, () => log.next(u.name, "e2e-1")), Math.max(settleDeadlineMs(n), 30_000));
      await settle(ctx, users, docId, n);
      requireCompaction(ctx, obs, await logWatch.stop());
      logWatch = null;
      const peers = await segmentsOf(users, ["e2e-1"]);
      ctx.ev.json("peers", peers);
      assertInvariant(checkI2({ peers, typed: log.typed }));
      assertInvariant(checkI3({ peers: await readI3All(users), baseline }));
    } finally {
      if (logWatch) await logWatch.stop().catch(() => undefined);
    }
  }));
});

// --- the RTDB proxy's window (C2 window, C3 window) ---------------------------------------------

/**
 * Join N editors on a stack whose browsers dial RTDB through the proxy, every
 * connection through it (a stack fact: a FAIL when not), the delay 0.
 */
async function joinThroughProxy(ctx, title) {
  const lat = rtdbLatency(ctx.target);
  await lat.reset();
  const joined = await join(ctx, ctx.n, title);
  const conn = (await lat.stats()).stats.connections;
  precondition(conn >= ctx.n, `every browser's RTDB connection goes through the proxy (it carried ${conn} for ${ctx.n} peers)`);
  return { ...joined, lat };
}

/**
 * Hold every client→database byte for the window while `act` runs every
 * peer's edits, then judge the race (inputClocks: no problem, every input
 * inside the window less WINDOW_MARGIN_MS; `check(states)` over what each peer
 * held when read inside the window, its own reasons why not) and wait the
 * window out. INCONCLUSIVE when the race did not hold. The delay is reset in
 * a finally, then the proxy is drained (rtdbLatency drained(): nothing queued
 * either way) before anyone settles. Resolves the proof, with the drain.
 */
async function inWindow(ctx, obs, { users, lat, act, check }) {
  const windowMs = windowFor(ctx.n);
  const clocks = await inputClocks(users);
  const proof = { windowMs };
  try {
    await lat.set({ up: windowMs, down: 0 });
    const set = await lat.get();
    precondition(set.up === windowMs, `the proxy holds client→database bytes ${windowMs} ms (it says ${JSON.stringify(set)})`);
    await act();
    const states = {};
    for (const u of users) states[u.name] = await frameState(u);
    const readAt = Date.now();
    const clock = await clocks.read();
    Object.assign(proof, { inputs: clock.inputs, first: clock.first, last: clock.last, spanMs: clock.spanMs, problems: clock.problems, states, readAt });
    const why = [...clock.problems];
    if (!(clock.spanMs < windowMs - WINDOW_MARGIN_MS)) why.push(`the edits spanned ${clock.spanMs} ms, not inside the ${windowMs} ms window less ${WINDOW_MARGIN_MS} ms`);
    if (Number.isFinite(clock.first) && readAt < clock.first + windowMs) why.push(...check(states));
    else proof.stateCheck = "read after the window: not judged";
    proof.ok = why.length === 0;
    proof.why = why;
    obs.race = proof;
    ctx.ev.json("window-race", proof);
    ctx.step(`race: ${clock.inputs.map((x) => `${x.name} ${x.n} input(s)`).join(", ")}; span ${clock.spanMs} ms of a ${windowMs} ms window${why.length ? `; NOT PROVEN: ${why.join("; ")}` : "; proven: every edit was made before any could reach another peer"}`);
    if (why.length) inconclusive(ctx, obs, `the race did not hold: ${why.join("; ")}`);
    await sleep(Math.max(0, clock.last + windowMs + 500 - Date.now()));
  } finally {
    await lat.reset().catch(() => undefined);
  }
  // The proxy is a FIFO (lib/proxy.mjs: a chunk is due at max(arrival + delay,
  // the last chunk's due)): what a page sent as its acks came back before the
  // reset, its compaction's append and removal above all, is still queued for
  // up to a window, and settleLive cannot see bytes queued in the proxy (at
  // N=5 it once settled 0.8 s before they arrived, run 2610131218-fgf7).
  // drained() waits until nothing is queued either way and no byte is held by
  // the address rewriter; running out is E2E_PROXY_DRAIN, the harness's own.
  const drain = await lat.drained();
  proof.drain = { ms: drain.ms, polls: drain.polls, atStart: drain.atStart };
  ctx.ev.json("proxy-drain", drain);
  const q = drain.atStart;
  ctx.step(`the window is over and the delay is gone; the proxy drained in ${drain.ms} ms (${drain.polls} poll(s)); at the reset's first reading it still held up ${q.queued.up} chunk(s) of ${q.queuedBytes.up} B, down ${q.queued.down} chunk(s) of ${q.queuedBytes.down} B, ${q.held} B in the rewriter`);
  return proof;
}

scenario("C2 window: N editors type tokens at the end of one paragraph inside the RTDB proxy's window, so every insert is made before any other reaches it; every peer converges (I1), holds every token once and whole (I2) and keeps the document's shape (I3)", { tiers: LOCAL, needs: ["rtdb-proxy"], n: [2, 5, 10, 20], timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const n = ctx.n;
  const obs = record(ctx, "C2-window");
  await work(ctx, obs, () => withRss(ctx, n, async () => {
    const { docId, users, lat } = await joinThroughProxy(ctx, `C2 window N=${n}`);
    const parser = await ctx.users.parser();
    const baseline = await fixtureShape(parser);
    const log = tokenLog(ctx.target.runId);
    const plan = users.map((u) => ({ u, tokens: Array.from({ length: TOKENS }, () => log.next(u.name, "e2e-1")) }));
    let logWatch = watchLog(ctx.target, docId);
    try {
      ctx.step(`window ${windowFor(n)} ms: each of ${n} editors types ${TOKENS} tokens at the end of #e2e-1, at once`);
      await inWindow(ctx, obs, {
        users,
        lat,
        act: () => Promise.all(plan.map(({ u, tokens }) => typeTokens(u, "e2e-1", tokens))),
        check: (states) => plan.flatMap(({ u, tokens }) => {
          const s = states[u.name];
          const out = [];
          if (s.owners.some((o) => o !== u.name)) out.push(`${u.name} already held a token of ${s.owners.filter((o) => o !== u.name).join(", ")}: another edit had reached it`);
          const missing = tokens.filter((t) => !s.tokens.includes(t));
          if (missing.length) out.push(`${u.name}'s own ${missing.join(", ")} not whole in its document after typing`);
          return out;
        }),
      });
      obs.stage = "settling";
      await settle(ctx, users, docId, n);
      requireCompaction(ctx, obs, await logWatch.stop());
      logWatch = null;
      obs.stage = "reading";
      const peers = await segmentsOf(users, ["e2e-1"]);
      const shapes = await readI3All(users);
      ctx.ev.json("peers", { peers, shapes });
      obs.stage = "measured";
      assertInvariant(checkI2({ peers, typed: log.typed }));
      assertInvariant(checkI3({ peers: shapes, baseline }));
    } finally {
      if (logWatch) await logWatch.stop().catch(() => undefined);
    }
  }));
});

// --- C3 ------------------------------------------------------------------------------------

/** Press Enter `count` times at the end of #id, `everyMs` apart: each one a new paragraph under <body>. */
async function pressEnters(u, id, { count = ENTERS, everyMs = ENTER_EVERY_MS } = {}) {
  await u.typeInFrame(idSelector(id), "", { at: "end" });
  for (let i = 0; i < count; i += 1) {
    await u.page.keyboard.press("Enter");
    if (i < count - 1) await sleep(everyMs);
  }
}

scenario("C3 Enter elsewhere: one editor presses Enter at the end of the document again and again while the others type tokens into their own paragraphs; every peer converges (I1) and keeps the document's shape: the sentinel once, v1's top-level elements plus one per Enter (I3)", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const n = ctx.n;
  const obs = record(ctx, "C3");
  await work(ctx, obs, () => withRss(ctx, n, async () => {
    const { docId, users } = await join(ctx, n, `C3 Enter N=${n}`);
    const parser = await ctx.users.parser();
    const baseline = await fixtureShape(parser);
    const [presser, ...typists] = users;
    const log = tokenLog(ctx.target.runId);
    const plan = typists.map((u, i) => ({ u, id: paragraph(i + 1), tokens: Array.from({ length: TOKENS }, () => log.next(u.name, paragraph(i + 1))) }));
    const armed = await armSaves(users);
    let logWatch = watchLog(ctx.target, docId);
    try {
      ctx.step(`at once: ${presser.name} presses Enter ${ENTERS} times at the end of #e2e-40, ${ENTER_EVERY_MS} ms apart; ${typists.map((u) => u.name).join(", ")} each type ${TOKENS} tokens into their own paragraph`);
      await Promise.all([pressEnters(presser, "e2e-40"), ...plan.map(({ u, id, tokens }) => typeTokens(u, id, tokens))]);
      const windows = await inputWindows(armed);
      const silent = windows.filter((w) => w.inputs === 0).map((w) => w.name);
      if (silent.length) throw new Error(`typing or Enter fired no input event in ${silent.join(", ")}'s document (is the editor open?)`);
      const enters = windows[0].times;
      const inside = windows.slice(1).map((w) => ({ name: w.name, first: w.first, last: w.last, enters: enters.filter((t) => t > w.first && t < w.last - ENTER_MARGIN_MS).length }));
      obs.race = { enters: enters.length, typists: inside };
      ctx.step(`race: Enters inside each typing window: ${inside.map((x) => `${x.name} ${x.enters}`).join(", ")} (of ${enters.length})`);
      const missed = inside.filter((x) => !(x.enters >= 1)).map((x) => x.name);
      if (enters.length === 0 || missed.length) inconclusive(ctx, obs, `the sync precondition did not hold: no Enter landed inside the typing window of ${missed.join(", ") || "anyone"} (${enters.length} Enter input event(s))`);
      obs.stage = "settling";
      await settle(ctx, users, docId, n);
      requireCompaction(ctx, obs, await logWatch.stop());
      logWatch = null;
      obs.stage = "reading";
      const ids = plan.map((p) => p.id);
      const peers = await segmentsOf(users, ids);
      const shapes = await readI3All(users);
      obs.tokens = { peers, typed: log.typed };
      ctx.ev.json("peers", { peers, shapes });
      ctx.step(`shapes: ${Object.entries(shapes).map(([name, s]) => `${name} ${s.children} top-level, sentinel ×${s.sentinels}`).join(", ")} (v1 ${baseline.children}, +${ENTERS} Enters)`);
      obs.stage = "measured";
      assertInvariant(checkShape(shapes, baseline, ENTERS));
    } finally {
      if (logWatch) await logWatch.stop().catch(() => undefined);
      stopCaptures(armed);
    }
  }));
});

scenario("C3 tokens: every typist's tokens are once and whole inside its own paragraph on every peer, though Enter was pressed elsewhere as it typed (I2)", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: JUDGE_MS }, async (ctx) => {
  const t = observation(ctx, "C3", "tokens");
  assertInvariant(checkI2({ peers: t.peers, typed: t.typed }));
});

scenario("C3-serial positive control: the same Enters pressed first, then the same tokens typed one editor after another, leave every token once and whole on every peer (I1, I2) and the document's shape: the sentinel once, v1's top-level elements plus one per Enter (I3)", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: SERIAL_MS, ...LIVE }, async (ctx) => {
  const n = ctx.n;
  const obs = record(ctx, "C3-serial");
  await work(ctx, obs, () => withRss(ctx, n, async () => {
    const { docId, users } = await join(ctx, n, `C3 serial N=${n}`);
    const parser = await ctx.users.parser();
    const baseline = await fixtureShape(parser);
    const [presser, ...typists] = users;
    const log = tokenLog(ctx.target.runId);
    let logWatch = watchLog(ctx.target, docId);
    try {
      ctx.step(`${presser.name} presses Enter ${ENTERS} times at the end of #e2e-40; the session settles`);
      await pressEnters(presser, "e2e-40");
      await settle(ctx, users, docId, n, "the Enters settled");
      ctx.step(`then ${typists.map((u) => u.name).join(", ")}, one after another, type ${TOKENS} tokens into their own paragraph and wait for the last at every peer`);
      for (const [i, u] of typists.entries()) await typeAndArrive(users, u, paragraph(i + 1), Array.from({ length: TOKENS }, () => log.next(u.name, paragraph(i + 1))), Math.max(settleDeadlineMs(n), 30_000));
      await settle(ctx, users, docId, n);
      requireCompaction(ctx, obs, await logWatch.stop());
      logWatch = null;
      const peers = await segmentsOf(users, typists.map((_, i) => paragraph(i + 1)));
      const shapes = await readI3All(users);
      ctx.ev.json("peers", { peers, shapes });
      ctx.step(`shapes: ${Object.entries(shapes).map(([name, s]) => `${name} ${s.children} top-level, sentinel ×${s.sentinels}`).join(", ")} (v1 ${baseline.children}, +${ENTERS} Enters)`);
      assertInvariant(checkI2({ peers, typed: log.typed }));
      assertInvariant(checkShape(shapes, baseline, ENTERS));
    } finally {
      if (logWatch) await logWatch.stop().catch(() => undefined);
    }
  }));
});

scenario("C3 window: one editor presses Enter at the end of the document again and again while the others type into their own paragraphs, all inside the RTDB proxy's window, so no edit reaches anyone before every edit is made; every peer converges (I1), holds every token once and whole (I2) and keeps the shape: the sentinel once, v1's top-level elements plus one per Enter (I3)", { tiers: LOCAL, needs: ["rtdb-proxy"], n: [2, 5, 10, 20], timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const n = ctx.n;
  const obs = record(ctx, "C3-window");
  await work(ctx, obs, () => withRss(ctx, n, async () => {
    const { docId, users, lat } = await joinThroughProxy(ctx, `C3 window N=${n}`);
    const parser = await ctx.users.parser();
    const baseline = await fixtureShape(parser);
    const [presser, ...typists] = users;
    const log = tokenLog(ctx.target.runId);
    const plan = typists.map((u, i) => ({ u, id: paragraph(i + 1), tokens: Array.from({ length: TOKENS }, () => log.next(u.name, paragraph(i + 1))) }));
    let logWatch = watchLog(ctx.target, docId);
    try {
      ctx.step(`window ${windowFor(n)} ms: ${presser.name} presses Enter ${ENTERS} times at the end of #e2e-40, ${ENTER_EVERY_MS} ms apart; at the same time ${typists.map((u) => u.name).join(", ")} each type ${TOKENS} tokens into their own paragraph`);
      await inWindow(ctx, obs, {
        users,
        lat,
        act: () => Promise.all([pressEnters(presser, "e2e-40"), ...plan.map(({ u, id, tokens }) => typeTokens(u, id, tokens))]),
        check: (states) => {
          const out = [];
          const p = states[presser.name];
          if (p.children !== baseline.children + ENTERS) out.push(`${presser.name} held ${p.children} top-level element(s) after its Enters, not v1's ${baseline.children} plus ${ENTERS}`);
          if (p.tokens.length) out.push(`${presser.name} already held ${p.tokens.length} typed token(s): another edit had reached it`);
          for (const { u, tokens } of plan) {
            const s = states[u.name];
            if (s.children !== baseline.children) out.push(`${u.name} held ${s.children} top-level element(s) after typing, not v1's ${baseline.children}: an Enter had reached it`);
            if (s.owners.some((o) => o !== u.name)) out.push(`${u.name} already held a token of ${s.owners.filter((o) => o !== u.name).join(", ")}`);
            const missing = tokens.filter((t) => !s.tokens.includes(t));
            if (missing.length) out.push(`${u.name}'s own ${missing.join(", ")} not whole in its document after typing`);
          }
          return out;
        },
      });
      obs.stage = "settling";
      await settle(ctx, users, docId, n);
      requireCompaction(ctx, obs, await logWatch.stop());
      logWatch = null;
      obs.stage = "reading";
      const peers = await segmentsOf(users, plan.map((p) => p.id));
      const shapes = await readI3All(users);
      ctx.ev.json("peers", { peers, shapes });
      ctx.step(`shapes: ${Object.entries(shapes).map(([name, s]) => `${name} ${s.children} top-level, sentinel ×${s.sentinels}`).join(", ")} (v1 ${baseline.children}, +${ENTERS} Enters)`);
      obs.stage = "measured";
      assertInvariant(checkI2({ peers, typed: log.typed }));
      assertInvariant(checkShape(shapes, baseline, ENTERS));
    } finally {
      if (logWatch) await logWatch.stop().catch(() => undefined);
    }
  }));
});

// --- C21 -----------------------------------------------------------------------------------

/** Two saves from different peers in flight at one instant, as overlapProof judges a pair: {ok, pair, …} or {ok: false}. */
function savesOverlap(rows) {
  const done = rows.filter((r) => Number.isFinite(r.sentAt) && Number.isFinite(r.respondedAt));
  let best = null;
  for (let i = 0; i < done.length; i += 1) {
    for (let j = i + 1; j < done.length; j += 1) {
      if (done[i].name === done[j].name) continue;
      const p = overlapProof([{ sentAt: done[i].sentAt, firstByteAt: done[i].respondedAt }, { sentAt: done[j].sentAt, firstByteAt: done[j].respondedAt }]);
      if (p.ok && (!best || p.marginMs > best.marginMs)) best = { ...p, pair: [done[i].name, done[j].name] };
    }
  }
  return best ?? { ok: false, n: done.length, reason: "no-overlap", detail: `no two of ${done.length} answered saves from different peers were in flight at once` };
}

function percentile(xs, p) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

// Its "[N=2]" case is the target of e2e/patches/controls-c01-save-errors.
// The name is a literal (C21_ROUNDS is 6) so that run.mjs controls finds it in the source.
scenario('C21 autosave rate: N editors type a token each in step and pause past the debounce, 6 times, so their autosaves land on one document together; no save state is ever "error" and every POST /draft is answered 200 (p95 under 3 s asserted on production only)', { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: CASE_MS, ...LIVE }, async (ctx) => {
  const n = ctx.n;
  const obs = record(ctx, "C21");
  await work(ctx, obs, () => withRss(ctx, n, async () => {
    const { docId, users, owner } = await join(ctx, n, `C21 autosave N=${n}`);
    const parser = await ctx.users.parser();
    const log = tokenLog(ctx.target.runId);
    const armed = await armSaves(users);
    let logWatch = watchLog(ctx.target, docId);
    try {
      ctx.step(`${C21_ROUNDS} rounds: each of ${n} editors types one token at the end of its own paragraph, all at once, then everyone pauses ${C21_PAUSE_MS} ms (the debounce is 1 s)`);
      const t0 = Date.now();
      for (let r = 0; r < C21_ROUNDS; r += 1) {
        await Promise.all(users.map((u, i) => typeTokens(u, paragraph(i), [log.next(u.name, paragraph(i))])));
        await sleep(C21_PAUSE_MS);
      }
      obs.stage = "saving";
      await savesQuiet(users, armed, n);
      const rows = await savesOf(armed);
      const states = await saveStatesOf(armed);
      const spanS = (Date.now() - t0) / 1000;
      const ms = rows.map((r) => r.ms);
      const p95 = percentile(ms, 95);
      obs.saves = { rows, states, p95 };
      ctx.ev.json("saves", { rows, states });
      const perPeer = Object.fromEntries(users.map((u) => [u.name, rows.filter((r) => r.name === u.name).length]));
      ctx.step(`${rows.length} POST /draft in ${spanS.toFixed(1)} s (${(rows.length / spanS).toFixed(2)}/s on one document); per peer ${JSON.stringify(perPeer)}; statuses ${JSON.stringify([...new Set(rows.map((r) => r.status))])}; round trip median ${Math.round(percentile(ms, 50))} ms, p95 ${Math.round(p95)} ms, max ${Math.round(percentile(ms, 100))} ms`);
      ctx.t.diagnostic(`C21 N=${n}: ${rows.length} saves, ${(rows.length / spanS).toFixed(2)}/s, p95 ${Math.round(p95)} ms (asserted < ${AUTOSAVE_P95_MS} ms on production only)`);
      const race = savesOverlap(rows);
      obs.race = race;
      ctx.step(race.ok ? `race: saves of ${race.pair.join(" and ")} were in flight at once (margin ${Math.round(race.marginMs)} ms)` : `race: ${race.detail}`);
      if (!race.ok) obs.inconclusive = `no two saves from different peers overlapped: ${race.detail}`;
      requireConclusive(ctx, { overlap: race });
      const silent = Object.entries(perPeer).filter(([, c]) => c === 0).map(([name]) => name);
      assert.deepEqual(silent, [], "C21: every editor autosaved at least once");
      // Before the settle: a failed save leaves "error", which settleLive would name as I1.
      assertSaves(rows, states);
      if (ctx.target.kind === "prod") assert.ok(p95 !== null && p95 < AUTOSAVE_P95_MS, `C21: the p95 of a save's round trip is ${p95} ms, not under ${AUTOSAVE_P95_MS} ms`);
      obs.stage = "settling";
      await settle(ctx, users, docId, n);
      requireCompaction(ctx, obs, await logWatch.stop());
      logWatch = null;
      obs.stage = "reading";
      const ids = users.map((_, i) => paragraph(i));
      obs.draft = await readDraftAgainstPeers(ctx, { parser, owner, docId, users, ids, typed: log.typed });
      ctx.step(`the draft: ${obs.draft.draftHash.slice(0, 12)}; the peers: ${JSON.stringify(obs.draft.peerHashes).slice(0, 300)}`);
      obs.stage = "measured";
    } finally {
      if (logWatch) await logWatch.stop().catch(() => undefined);
      stopCaptures(armed);
    }
  }));
});

scenario("C21 draft: after N editors' autosaves raced onto one document (two in flight at once, proven), GET /draft's body equals every peer's and holds every token once and whole (I5 apart from S3's spellcheck, I2 in the draft)", { tiers: BOTH, n: [2, 5, 10, 20], timeoutMs: JUDGE_MS }, async (ctx) => {
  const d = observation(ctx, "C21", "draft");
  const race = observation(ctx, "C21", "race");
  if (!race.ok) ctx.inconclusive(`no two saves from different peers were in flight at once: ${race.detail}`);
  ctx.step(`the draft ${d.draftHash.slice(0, 12)} against ${Object.keys(d.peerHashes).length} peer(s), after saves of ${race.pair.join(" and ")} raced`);
  assertDraftEqualsPeers(d);
});
