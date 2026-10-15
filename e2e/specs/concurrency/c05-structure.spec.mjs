// SPDX-License-Identifier: Apache-2.0
// Concurrency C5 and C7: a paragraph or passage deleted while others type into it is gone everywhere, and a ~300 KB document joined in turn stays one shared document (SPEC §6b, §16).

/**
 * C5  DELETION WINS (SPEC §6b: "Deletion beats concurrent typing: if one
 *     person removes a passage while another edits it, the passage goes";
 *     ADR 0010: "If one person deletes a paragraph while another types into
 *     it, the paragraph goes"; the plan's I4: "a deleted passage and the
 *     tokens typed into it are gone everywhere").
 *     N editors are "Shared" on crdt-paragraphs. The stack's RTDB proxy holds
 *     every client→database byte for a window (3/4/6/10 s at N = 2/5/10/20),
 *     so nobody sees anybody's edit inside it. In that window p1 deletes
 *     #e2e-10 (a selection from the end of #e2e-9 to the end of #e2e-10,
 *     then Backspace: the element itself leaves the DOM) and types a survivor
 *     token into #e2e-20, while p2…pN each type two tokens at the end of
 *     #e2e-10 (and p2 a survivor into #e2e-30).
 *     The race is PROVEN, never assumed, or the case is INCONCLUSIVE: p1
 *     deleted v1's own paragraph (no typed token had reached it), each typist
 *     still had #e2e-10 with exactly its own tokens after typing (the deletion
 *     had not reached it), and every input event of every peer fell inside
 *     one window (live.mjs inputClocks: no silent peer, no replaced frame,
 *     span < window − 300 ms), so no edit could have reached any peer before
 *     every edit was made.
 *     Then the delay goes, the session settles (I1, the plan's conditions),
 *     and:
 *       C5 (live)   I4 on every peer: #e2e-10's text and every token typed
 *                   into it are gone, the survivors are once and whole, and
 *                   the deletion took exactly #e2e-10 (no element with that
 *                   id, #e2e-9 and #e2e-11 as v1 has them, one top-level
 *                   element fewer than v1, the sentinel once).
 *       C5 (draft)  the session settled, every editor presses Done, and once
 *                   nobody is in the editor the owner's agent calls
 *                   commit_draft (SPEC §16: it "drops a log nobody is
 *                   using"). The same I4 over GET /draft, over what each
 *                   editor then reads (an editor reads the draft, SPEC §6a)
 *                   and over the version commit_draft mints: the durable
 *                   copies. Known defect X-c05-structure-1: nothing saves a
 *                   remote merge, so the draft is the last save to land,
 *                   made before the merge, and commit_draft publishes it and
 *                   drops the log that held the deletion.
 *       C5 serial control   the same edits one after another: the typing
 *                   first, the deletion once every token has reached p1, so
 *                   p1's paragraph holds them all. I4 must hold on every peer,
 *                   and after Done in the draft, every reader and the version
 *                   commit_draft mints: the oracles fail only for a race.
 *     controls-c05-i4-deletion targets C5 (live) [N=2].
 *
 *     A PASSAGE, NOT AN ELEMENT. Deleting #e2e-10 whole is the one shape
 *     whose outcome Yjs fixes by type deletion (content inserted into a
 *     deleted Y.XmlElement goes with it). A deletion inside a paragraph is a
 *     Y.XmlText range delete (sync.ts onMutations, characterData), and a
 *     concurrent insert inside a deleted range is a new item Yjs keeps. Two
 *     race variants, each with the same proof (inputClocks, the deleter
 *     selected v1's passage, each typist saw only its own tokens) and a
 *     serial control:
 *       C5 passage  p1 selects "saffron … pepper " inside #e2e-10
 *                   (mid-sentence to mid-sentence) and presses Backspace,
 *                   while p2…pN each type two tokens at a caret inside that
 *                   run (after "saffron", "lantern", "harbor" or "ochre").
 *       C5 across   p1 selects from the middle of #e2e-9 ("fennel glacier
 *                   …") to the middle of #e2e-11 ("… basil pepper ") and
 *                   presses Backspace (Chrome merges the rest of #e2e-11
 *                   into #e2e-9), while p2…pN each type a token in the
 *                   deleted tail of #e2e-9, in #e2e-10 and in the deleted
 *                   head of #e2e-11.
 *       C5 edge     p1 selects "russet zephyr. " in #e2e-10 and presses
 *                   Backspace, while p2…pN each type two tokens at a caret
 *                   just before "russet": OUTSIDE the passage, at its start.
 *                   The words go; every token stays, once and whole (I4's
 *                   passage half, I2's tokens).
 *     The carets of "passage" and "across" sit before a space, which no
 *     token holds, so they show only what a range deletion does to typing
 *     inside it; "edge" is the one whose caret is before a letter a token
 *     types (see PASSAGES).
 *     I4 over every peer: every token typed inside the passage gone, the
 *     passage's text gone, the paragraph(s) left exactly as v1's with the
 *     passage cut out (tokens aside), the neighbours untouched, the
 *     sentinel once. The tokens typed into a text range that is deleted
 *     survive, converged, on every peer (both variants; in "across" only the
 *     ones in #e2e-9's deleted tail: #e2e-10 and #e2e-11 leave as elements).
 *     That is a SPEC question, X-c05-structure-2 (class Q: ADR 0010 says
 *     "paragraph", SPEC §6b "passage"), never a P; both races carry it.
 *     X-c05-structure-3 (seen first by chance, when a run id put an "l" in
 *     the tokens typed before "lantern"): the old sync.ts recorded a typed character
 *     that equals the one after the caret one place to the right (its diff
 *     takes the longest common prefix), so the CRDT swaps the two; a
 *     concurrent deletion of the old text then takes the original letter
 *     from inside the new token and leaves the typed one where the deleted
 *     words were. The edge race guards the beforeinput-range repair. From N=3 the typists at that
 *     one caret also nest each other's tokens with no deletion at all (seen
 *     at N=5 when the edge serial control still let them type at once), so
 *     every serial control types one typist at a time, each once the one
 *     before it has reached every peer, and only then deletes.
 *     Needs a stack built with --rtdb-proxy (capability rtdb-proxy); without
 *     it the C5 cases are skipped, with that reason.
 *
 * C7 proves the ~300 KB fixture (473,536 base64 seed characters) joins,
 * converges and saves under the bounded 2 MiB transport. Staggered and serial
 * joins cover existing-state adoption. The not-silent cases inspect rejected
 * initialization without waiting for an editable body that must stay disabled.
 * A document above the supported seed bound explains recovery and cannot edit.
 * A merged snapshot above the bound skips compaction while keeping every seed
 * and delta available to late joiners. Controls restore the old 200k rule,
 * mislabel rejected initialization Shared, hide the size limit, and drop deltas.
 *
 * Positive controls run 2/1/1/1 trials at N = 2/5/10/20 rather than the
 * plan's 10/5/3/3: they show the oracle passes without the race, which needs
 * no statistics. A failed sync precondition (a peer never "Shared", the race
 * not proven) is INCONCLUSIVE, never FAIL. Every case joins through
 * live.mjs joinShared, whose only email is its local POST /access (on any
 * other target it grants through the operator script, with no email, and
 * ends the case INCONCLUSIVE while suspect S16 leaves the RTDB mirror
 * unwritten), so no case declares an email effect.
 */

import { readLiveLogsPatient } from "../../lib/live-log.mjs";
import { presenceModes } from "../../lib/presence.mjs";
import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { readFixture } from "../../lib/seed.mjs";
import { closeAdmin, readDoc, readObject } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { measure } from "../../lib/evidence.mjs";
import { mintToken } from "../../lib/session.mjs";
import { tokenLog } from "../../lib/tokens.mjs";
import { rtdbLatency } from "../../lib/proxy.mjs";
import { DOC_FRAME, armArrival, frameText, idSelector, placeCaret, setSelectionBetween, waitForArrival } from "../../lib/frame.mjs";
import {
  OWN_MARKER_VALUES, SENTINEL_ID, assertInvariant, checkI13, checkI2, checkI3, checkI4, readI3, readI3All, readSegments, segmentsOfHtml,
} from "../../lib/invariants.mjs";
import {
  SETTLE, inputClocks, joinShared, lastDraftAt, probeArrivals, rssFile, rtdbGetPatient, settleDeadlineMs, settleLive, startRssSampler, typeProbe,
} from "../../lib/live.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GB = 1024 ** 3;
const ON_STACK = { inconclusiveOnPageStall: true };

// --- C5 -------------------------------------------------------------------------------

const FIXTURE = "crdt-paragraphs.html";
const PREV = "e2e-9";
const DEL = "e2e-10";
const NEXT = "e2e-11";
const SURV_DELETER = "e2e-20";
const SURV_TYPIST = "e2e-30";
const C5_IDS = [PREV, DEL, NEXT, SURV_DELETER, SURV_TYPIST];
/** The race window: how long the RTDB proxy holds every client→database byte, by N. */
const WINDOW_MS = Object.freeze({ 2: 3_000, 5: 4_000, 10: 6_000, 20: 10_000 });
/** Every input event must fall this far inside the window. */
const WINDOW_MARGIN_MS = 300;
const C5_TIMEOUT_MS = 600_000;

const sel = (id) => idSelector(id);
const windowFor = (n) => WINDOW_MS[n] ?? WINDOW_MS[20];

/** v1's shape and the texts of the paragraphs C5 reads, as Chrome parses the fixture. */
async function c5Baseline(ctx) {
  const parser = await ctx.users.parser();
  await parser.setContent(readFixture(FIXTURE, { raw: true }).toString("utf8"));
  const shape = await readI3(parser);
  const texts = await parser.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.textContent ?? null])), C5_IDS);
  return { shape, texts };
}

/** In a page or frame: the body's top-level element count, the sentinel count, and each C5 id's count and text. */
function shapeInPage({ ids, own, sentinel, html = null }) {
  const doc = html == null ? document : new DOMParser().parseFromString(html, "text/html");
  const mine = new Set(own);
  const body = doc.body;
  if (!body) return { children: 0, sentinels: 0, count: {}, texts: {} };
  return {
    children: [...body.children].filter((el) => !mine.has(el.getAttribute("data-bshd") ?? "")).length,
    sentinels: doc.querySelectorAll(`[id="${sentinel}"]`).length,
    count: Object.fromEntries(ids.map((id) => [id, doc.querySelectorAll(`[id="${id}"]`).length])),
    texts: Object.fromEntries(ids.map((id) => [id, doc.getElementById(id)?.textContent ?? null])),
  };
}

const SHAPE_ARG = { ids: C5_IDS, own: [...OWN_MARKER_VALUES], sentinel: SENTINEL_ID };

async function c5Shape(u) {
  return (await u.frame()).evaluate(shapeInPage, SHAPE_ARG);
}

async function c5ShapeOfHtml(page, html) {
  return page.evaluate(shapeInPage, { ...SHAPE_ARG, html });
}

/**
 * Delete #DEL the way a person does: a selection from the end of #PREV's text
 * to the end of #DEL's, then a real Backspace. The frame must already have
 * focus (a real click before the race). Resolves {selected: the text the
 * selection held in #DEL, at, mutations: what the Backspace did to the DOM}.
 * Nothing here writes to the document but the keystroke; the recorder is a
 * MutationObserver of the frame's own realm (a cross-realm one sees nothing).
 */
async function deleteParagraph(u) {
  const key = `__e2eC5Mut${Math.random().toString(36).slice(2)}`;
  const selected = await u.page.evaluate(({ sel, key, prev, del }) => {
    const f = document.querySelector(sel);
    const doc = f?.contentDocument;
    if (!doc) return { error: "no document frame" };
    const lastText = (el) => {
      let t = null;
      const w = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) t = n;
      return t;
    };
    const a = doc.getElementById(prev);
    const b = doc.getElementById(del);
    if (!a || !b) return { error: `no #${a ? del : prev} in the frame` };
    const ta = lastText(a);
    const tb = lastText(b);
    if (!ta || !tb) return { error: "an end of the selection has no text" };
    const label = (n) => (n.nodeType === 1 ? `${n.localName}${n.id ? `#${n.id}` : ""}` : n.nodeType === 3 ? `text(${JSON.stringify(n.data.slice(0, 24))}${n.data.length > 24 ? "…" : ""})` : `node${n.nodeType}`);
    const recs = [];
    const mo = new f.contentWindow.MutationObserver((rs) => {
      for (const r of rs) recs.push({ type: r.type, target: label(r.target), added: [...r.addedNodes].map(label), removed: [...r.removedNodes].map(label), attr: r.attributeName ?? undefined });
    });
    mo.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true });
    window[key] = { mo, recs };
    const r = doc.createRange();
    r.setStart(ta, ta.data.length);
    r.setEnd(tb, tb.data.length);
    const s = doc.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return { text: b.textContent, at: Date.now() };
  }, { sel: DOC_FRAME, key, prev: PREV, del: DEL });
  if (selected.error) throw new Error(`${u.name}: cannot select #${DEL} to delete it: ${selected.error}`);
  await u.page.keyboard.press("Backspace");
  const mutations = await u.page.evaluate((key) => {
    const s = window[key];
    if (!s) return null;
    s.recs.push(...s.mo.takeRecords().map((r) => ({ type: r.type, late: true })));
    s.mo.disconnect();
    delete window[key];
    return s.recs;
  }, key);
  return { selected: selected.text, at: selected.at, mutations };
}

/**
 * C5's I4, one result: tokens.mjs's I4 over the given segments (every token
 * typed into #DEL gone, every survivor once and whole, #DEL's v1 text gone),
 * plus what the deletion must have taken and left: no element with #DEL's
 * id, #PREV and #NEXT as v1 has them, one top-level element fewer than v1,
 * the sentinel once. `where` is {name: {segments, shape}}.
 */
function c5I4(where, { base, typed }) {
  const segments = Object.fromEntries(Object.entries(where).map(([name, w]) => [name, w.segments]));
  const r = checkI4({ peers: segments, typed, deletedTexts: [base.texts[DEL]] });
  const failures = [...r.failures];
  for (const [name, { shape }] of Object.entries(where)) {
    if (shape.count[DEL] !== 0) failures.push(`${name}: #${DEL} is still there (${shape.count[DEL]}×): ${JSON.stringify(String(shape.texts[DEL]).slice(0, 80))}`);
    for (const id of [PREV, NEXT]) {
      if (shape.count[id] !== 1 || shape.texts[id] !== base.texts[id]) failures.push(`${name}: #${id} is not v1's (${shape.count[id]}×): ${JSON.stringify(String(shape.texts[id]).slice(0, 80))}`);
    }
    if (shape.children !== base.shape.children - 1) failures.push(`${name}: ${shape.children} top-level element(s); v1 has ${base.shape.children}, less the deleted one: ${base.shape.children - 1}`);
    if (shape.sentinels !== 1) failures.push(`${name}: the sentinel appears ${shape.sentinels} time(s)`);
  }
  return { invariant: "I4", ok: failures.length === 0, failures };
}

/**
 * C5's edits on a fresh live session, in a window the proxy opens: the race
 * (serial: false) or the same edits one after another (serial: true).
 * Resolves {docId, users, owner, base, log, proof} once the window has
 * passed and the delay is gone: the session is left to settle (c5Settle).
 */
async function c5Session(ctx, { n = ctx.n, title, serial }) {
  const lat = rtdbLatency(ctx.target);
  await lat.reset();
  const base = await c5Baseline(ctx);
  precondition(base.shape.sentinels === 1 && base.texts[DEL] && base.texts[PREV] && base.texts[NEXT], "the fixture has its sentinel once and the paragraphs C5 reads");
  const { docId, users, owner } = await joinShared(ctx, { n, fixture: FIXTURE, title });
  const conn = (await lat.stats()).stats.connections;
  precondition(conn >= n, `every browser's RTDB connection goes through the proxy (it carried ${conn} for ${n} peers)`);

  const log = tokenLog(ctx.target.runId);
  const [deleter, ...typists] = users;
  const plan = typists.map((u, i) => ({ u, tokens: [log.next(u.name, DEL), log.next(u.name, DEL)], survivor: i === 0 ? log.next(u.name, SURV_TYPIST) : null }));
  const deleterSurvivor = log.next(deleter.name, SURV_DELETER);
  const windowMs = windowFor(n);

  ctx.step(`${deleter.name} clicks at the end of #${PREV} (the frame has focus); every page records its input events`);
  await deleter.clickInFrame(sel(PREV), { where: "end" });
  const clocks = await inputClocks(users);
  const typeAll = async (p) => {
    for (const t of p.tokens) await p.u.typeInFrame(sel(DEL), t);
    const after = await c5Shape(p.u);
    if (p.survivor) await p.u.typeInFrame(sel(SURV_TYPIST), p.survivor);
    return { name: p.u.name, after, own: base.texts[DEL] + p.tokens.join("") };
  };
  const proof = { windowMs, serial };
  try {
    await lat.set({ up: windowMs, down: 0 });
    const set = await lat.get();
    precondition(set.up === windowMs, `the proxy holds client→database bytes ${windowMs} ms (it says ${JSON.stringify(set)})`);
    if (!serial) {
      ctx.step(`window ${windowMs} ms: ${deleter.name} deletes #${DEL} and types a survivor into #${SURV_DELETER}; at the same time ${typists.map((u) => u.name).join(", ")} each type two tokens at the end of #${DEL}${typists.length ? ` (${typists[0].name} then a survivor into #${SURV_TYPIST})` : ""}`);
      const [del, ...typed] = await Promise.all([
        (async () => {
          const d = await deleteParagraph(deleter);
          const afterDelete = await c5Shape(deleter);
          await deleter.typeInFrame(sel(SURV_DELETER), deleterSurvivor);
          return { ...d, after: afterDelete };
        })(),
        ...plan.map(typeAll),
      ]);
      const clock = await clocks.read();
      Object.assign(proof, { deletion: { selected: del.selected, after: del.after, mutations: del.mutations }, typists: typed, inputs: clock.inputs, spanMs: clock.spanMs, inputProblems: clock.problems });
      ctx.ev.json("c5-race", proof);
      ctx.step(`the Backspace's mutations on ${deleter.name}: ${JSON.stringify(del.mutations).slice(0, 600)}`);
      // The deletion is the harness's own step: it must have removed exactly #DEL.
      precondition(del.after.count[DEL] === 0 && del.after.texts[PREV] === base.texts[PREV] && del.after.texts[NEXT] === base.texts[NEXT] && del.after.children === base.shape.children - 1,
        `${deleter.name}'s Backspace removed exactly #${DEL} (after it: ${JSON.stringify(del.after)})`);
      // inputClocks' problems: a silent peer, a frame replaced after arming, a lost recorder.
      const why = [...clock.problems];
      if (del.selected !== base.texts[DEL]) why.push(`${deleter.name} deleted ${JSON.stringify(del.selected.slice(-60))}, not v1's paragraph: a typed token had reached it`);
      for (const t of typed) {
        if (t.after.count[DEL] !== 1 || t.after.texts[DEL] !== t.own) why.push(`${t.name}'s #${DEL} after its typing was ${JSON.stringify(String(t.after.texts[DEL]).slice(-60))} (×${t.after.count[DEL]}), not v1's text and its own two tokens: another edit had reached it`);
      }
      if (!(clock.spanMs < windowMs - WINDOW_MARGIN_MS)) why.push(`the edits spanned ${clock.spanMs} ms, not inside the ${windowMs} ms window less ${WINDOW_MARGIN_MS} ms`);
      ctx.step(`race: ${clock.inputs.map((x) => `${x.name} ${x.n} input(s)`).join(", ")}; span ${clock.spanMs} ms of a ${windowMs} ms window${why.length ? `; NOT PROVEN: ${why.join("; ")}` : "; proven: nobody saw another's edit before every edit was made"}`);
      measure(ctx, "c05-structure", { scenario: "C5 paragraph race", windowMs, spanMs: clock.spanMs, inputs: clock.inputs.map((x) => ({ name: x.name, n: x.n })), proven: why.length === 0, why });
      if (why.length) ctx.inconclusive(`the race did not hold: ${why.join("; ")}`);
      await sleep(Math.max(0, clock.last + windowMs + 500 - Date.now()));
    } else {
      ctx.step(`serial, window ${windowMs} ms: ${typists.map((u) => u.name).join(", ")} type their tokens into #${DEL} first; ${deleter.name} deletes it once every one has reached it`);
      const typedTokens = plan.flatMap((p) => p.tokens);
      await Promise.all(typedTokens.map((t) => armArrival(deleter, DEL, t)));
      if (plan[0]?.survivor) await armArrival(deleter, SURV_TYPIST, plan[0].survivor);
      const typed = await Promise.all(plan.map(typeAll));
      try {
        await Promise.all([...typedTokens, ...(plan[0]?.survivor ? [plan[0].survivor] : [])].map((t) => waitForArrival(deleter, t, { timeout: windowMs + 30_000 })));
      } catch (err) {
        ctx.inconclusive(`the serial order did not hold: a typed token never reached ${deleter.name} (${err.message})`);
      }
      // The typists' own autosaves are over before the deletion, so the deleter's is the last.
      await eventually(async () => {
        const st = await Promise.all(typists.map((u) => u.saveState()));
        return st.every((s) => s !== "dirty" && s !== "saving");
      }, { timeout: 30_000, interval: 200, message: "the typists' autosaves finished" });
      const del = await deleteParagraph(deleter);
      const afterDelete = await c5Shape(deleter);
      await deleter.typeInFrame(sel(SURV_DELETER), deleterSurvivor);
      const clock = await clocks.read();
      Object.assign(proof, { deletion: { selected: del.selected, after: afterDelete, mutations: del.mutations }, typists: typed, inputs: clock.inputs, inputProblems: clock.problems });
      ctx.ev.json("c5-serial", proof);
      precondition(afterDelete.count[DEL] === 0 && afterDelete.texts[PREV] === base.texts[PREV] && afterDelete.texts[NEXT] === base.texts[NEXT] && afterDelete.children === base.shape.children - 1,
        `${deleter.name}'s Backspace removed exactly #${DEL} (after it: ${JSON.stringify(afterDelete)})`);
      const missing = typedTokens.filter((t) => !del.selected.includes(t));
      if (missing.length) ctx.inconclusive(`the serial order did not hold: ${deleter.name} deleted #${DEL} without ${missing.join(", ")}`);
      // Nothing follows the deletion but the deleter's own survivor, so there is
      // no order left to keep: the window is waited out, and the settle and the
      // oracles say whether the deletion went everywhere.
      ctx.step(`${deleter.name} deleted #${DEL} holding every typed token; the window is waited out`);
      await sleep(Math.max(0, (clock.last ?? Date.now()) + windowMs + 500 - Date.now()));
    }
  } finally {
    await lat.reset().catch(() => undefined);
  }
  ctx.step("the delay is gone");
  return { docId, users, owner, base, log, proof, n };
}

/**
 * Let the session settle (I1, the plan's conditions) and hold on to a
 * failure: I4 is judged first, so a deletion that did not win is named as
 * such even when the copies also diverged; the settle failure is thrown
 * after it (as canary I3 does).
 */
async function c5Settle(ctx, s) {
  try {
    const settled = await settleLive(s.users, { docId: s.docId, n: s.n });
    ctx.step(`settled in ${settled.ms} ms on ${settled.hash.slice(0, 16)}`);
    return { settled, error: null };
  } catch (err) {
    ctx.step(`did not settle: ${String(err?.message ?? err).slice(0, 400)}`);
    return { settled: null, error: err };
  }
}

/** C5 (live): I4 on every peer, then the settle's own failure, if any. */
async function c5JudgeLive(ctx, s) {
  const { error } = await c5Settle(ctx, s);
  s.log.expectAbsent(DEL);
  const peers = await c5Peers(s.users);
  ctx.ev.json("c5-peers", shapesOf(peers));
  assertInvariant(c5I4(peers, { base: s.base, typed: s.log.typed }));
  if (error) throw error;
}

/** {name: {segments, shape}} for every peer. */
async function c5Peers(users) {
  const out = {};
  for (const u of users) out[u.name] = { segments: await readSegments(u, C5_IDS), shape: await c5Shape(u) };
  return out;
}

/** {draft: {segments, shape}} from GET /draft, parsed by Chrome. */
async function c5Draft(ctx, s) {
  const r = await s.owner.http.get(`/draft/${encodeURIComponent(s.docId)}/index.html`, { timeoutMs: 60_000 });
  precondition(r.status === 200, `GET /draft answered ${r.status}`);
  const parser = await ctx.users.parser();
  return { draft: { segments: await segmentsOfHtml(parser, r.text, C5_IDS), shape: await c5ShapeOfHtml(parser, r.text) } };
}

/**
 * Every editor presses Done, as people do when they have finished; whatever
 * leaving saves is let land (no POST /draft for SETTLE.draftQuietMs); each is
 * then reading the document, which for an editor is the draft (SPEC §6a).
 * Resolves {name (reading frame): {segments, shape}} plus the draft's.
 */
async function c5AfterDone(ctx, s) {
  ctx.step("every editor presses Done; whatever leaving saves is let land");
  for (const u of s.users) await u.done();
  await eventually(() => {
    const at = lastDraftAt(s.users);
    return at === null || Date.now() - at >= SETTLE.draftQuietMs;
  }, { timeout: 30_000, interval: 250, message: `no POST /draft for ${SETTLE.draftQuietMs} ms after everyone left` });
  await Promise.all(s.users.map((u) => u.waitForFrame({ editable: false, timeout: 45_000 })));
  const out = {};
  for (const u of s.users) out[`${u.name} (reading)`] = { segments: await readSegments(u, C5_IDS), shape: await c5Shape(u) };
  return { ...out, ...(await c5Draft(ctx, s)) };
}

/** The shapes of a c5Peers / c5AfterDone result, for the evidence. */
const shapesOf = (where) => Object.fromEntries(Object.entries(where).map(([k, v]) => [k, v.shape]));

/** An agent's tool call: a write on a shared emulator can take a while. */
const AGENT_MS = 120_000;
/** How long presence may take to show nobody in the editor after everyone pressed Done. */
const PRESENCE_MS = 10_000;

/** status/{d}/peers as {uid: mode} (rtdbGetPatient: a Database 503 is read again). */
async function peerModes(t, docId) {
  const peers = (await rtdbGetPatient(t, `status/${docId}/peers`)) ?? {};
  return presenceModes(peers);
}

/** A version's stored entry, through the Admin SDK (no read is recorded). */
async function versionHtml(t, docId, versionId) {
  const rec = await readDoc(t, `docs/${docId}/versions/${versionId}`);
  const buf = await readObject(t, `docs/${docId}/${versionId}/${rec?.entry ?? "index.html"}`);
  return buf ? buf.toString("utf8") : null;
}

/**
 * Once everyone has pressed Done and presence shows nobody in the editor,
 * the owner's agent (a personal MCP token) calls commit_draft, which
 * publishes the draft and drops the live log (SPEC §16, §22). Resolves
 * {where: {"version v2": {segments, shape}}, commit, yAfter}. Somebody
 * still in the editor (presence, or the refusal) is a failed sync
 * precondition: INCONCLUSIVE.
 */
async function c5Commit(ctx, s) {
  const deadline = Date.now() + PRESENCE_MS;
  let modes = await peerModes(ctx.target, s.docId);
  while (Object.values(modes).includes("edit") && Date.now() < deadline) {
    await sleep(200);
    modes = await peerModes(ctx.target, s.docId);
  }
  if (Object.values(modes).includes("edit")) ctx.inconclusive(`the sync precondition did not hold: ${PRESENCE_MS} ms after everyone pressed Done, status/${s.docId}/peers still has somebody in the editor (${JSON.stringify(modes)})`);
  const { token } = await mintToken(s.owner, { name: `e2e c05 agent ${ctx.n}`, channel: "mcp" });
  const agent = ctx.mcp({ token, actor: "agent", timeoutMs: AGENT_MS });
  await agent.initialize();
  const out = await agent.call("commit_draft", { id: s.docId });
  ctx.step(`nobody in the editor (${JSON.stringify(modes)}); the owner's agent calls commit_draft: ${out.isError ? `refused: ${String(out.text).slice(0, 300)}` : JSON.stringify(out.json)}`);
  if (out.isError && /open in the editor/i.test(String(out.text))) ctx.inconclusive(`the sync precondition did not hold: commit_draft was refused because somebody is in the editor: ${String(out.text).slice(0, 300)}`);
  precondition(!out.isError && out.json?.versionId === "v2" && out.json?.deduped === false, `the agent's commit_draft publishes v2 from the draft (it answered ${JSON.stringify(out.isError ? out.text : out.json).slice(0, 300)})`);
  const y = await readLiveLogsPatient(ctx.target, s.docId);
  const yAfter = y && typeof y === "object" ? Object.keys(y).length : 0;
  const html = await versionHtml(ctx.target, s.docId, "v2");
  precondition(typeof html === "string" && html.length > 0, "v2's stored entry is readable");
  ctx.ev.text("v2.html", html);
  const parser = await ctx.users.parser();
  return {
    where: { "version v2": { segments: await segmentsOfHtml(parser, html, C5_IDS), shape: await c5ShapeOfHtml(parser, html) } },
    commit: out.json,
    yAfter,
  };
}

// controls-c05-i4-deletion targets this scenario's "[N=2]" case (its runs pass --n 2 --trials 1).
scenario("C5 delete a paragraph while N−1 type into it: deletion wins, so the paragraph and every token typed into it are gone on every peer (I4), and the session converges (I1)", {
  tiers: ["local", "prod"],
  needs: ["rtdb-proxy"],
  n: [2, 5, 10, 20],
  timeoutMs: C5_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  const s = await c5Session(ctx, { title: `C5 live N=${ctx.n}`, serial: false });
  await c5JudgeLive(ctx, s);
});

// X-c05-structure-1: the autosave runs only on a local `input` event
// (useInlineEditor.ts onInput), and a remote merge (sync.ts applyRemote) fires
// none, so nobody saves the merged document. The draft keeps the last save
// to land, made before the merge: the deleted paragraph with its tokens, and
// without the deleter's own later edit. Done saves only an unsaved local
// edit (useInlineEditor.ts flushUnsaved; SPEC §6a: "Leaving edit mode saves
// only an edit the autosave has not yet taken"), so leaving does not fix it,
// each editor then reads that draft, and the agent's commit_draft publishes
// it and drops the live log, the one place the merged document was left.
scenario("C5 delete a paragraph while N−1 type into it: once everyone has left the editor, the saved draft, what each of them then reads, and the version an agent's commit_draft then publishes have lost the paragraph and every token typed into it too (I4)", {
  tiers: ["local", "prod"],
  needs: ["rtdb-proxy"],
  defect: "X-c05-structure-1",
  n: [2, 5, 10, 20],
  timeoutMs: C5_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  const s = await c5Session(ctx, { title: `C5 draft N=${ctx.n}`, serial: false });
  // The live outcome is C5 (live)'s to judge; here a settled session is where the draft is read.
  const { error } = await c5Settle(ctx, s);
  precondition(!error, `the live session settles before its draft is judged (C5 live judges that): ${error?.message}`);
  s.log.expectAbsent(DEL);
  const live = shapesOf(await c5Peers(s.users));
  const settledDraft = shapesOf(await c5Draft(ctx, s));
  const after = await c5AfterDone(ctx, s);
  const saves = s.users.map((u) => ({ name: u.name, posts: u.findResponses({ method: "POST", path: "/draft" }).map((r) => ({ status: r.status, t: r.t, at: r.at, hasDeleted: String(r.postJson?.html ?? "").includes(`id="${DEL}"`) })) }));
  // The harm the defect rests on: what the agent publishes from that draft, and the log it drops.
  const minted = await c5Commit(ctx, s);
  ctx.ev.json("c5-draft", { live, settledDraft, afterDone: shapesOf(after), version: shapesOf(minted.where), commit: minted.commit, yEntriesAfterCommit: minted.yAfter, saves });
  ctx.step(`settled, every peer: ${Object.entries(live).map(([k, v]) => `${k} #${DEL} ×${v.count[DEL]}`).join(", ")}; the draft then: #${DEL} ×${settledDraft.draft.count[DEL]}; after Done: ${Object.entries(after).map(([k, v]) => `${k} #${DEL} ×${v.shape.count[DEL]}`).join(", ")}; v2 from commit_draft: #${DEL} ×${minted.where["version v2"].shape.count[DEL]}, status/${s.docId}/y then ${minted.yAfter} entr(ies); POST /draft: ${saves.map((x) => `${x.name} ${x.posts.map((p) => `${p.status}${p.hasDeleted ? " with" : " without"} #${DEL}`).join(", ")}`).join("; ")}`);
  // The version first: an AssertionError message is cut at 4,000 characters, and the version is the harm.
  assertInvariant(c5I4({ ...minted.where, ...after }, { base: s.base, typed: s.log.typed }));
});

scenario("C5 serial control: the same typing into the paragraph, then its deletion once every token has reached the deleter: the paragraph and its tokens are gone on every peer, and once everyone has left, in the draft, what each then reads and the version commit_draft publishes (I4)", {
  tiers: ["local", "prod"],
  needs: ["rtdb-proxy"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 },
  timeoutMs: C5_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  const s = await c5Session(ctx, { title: `C5 serial N=${ctx.n}`, serial: true });
  const { error } = await c5Settle(ctx, s);
  s.log.expectAbsent(DEL);
  const peers = await c5Peers(s.users);
  assertInvariant(c5I4(peers, { base: s.base, typed: s.log.typed }));
  if (error) throw error;
  const after = await c5AfterDone(ctx, s);
  const minted = await c5Commit(ctx, s);
  ctx.ev.json("c5-serial-after-done", { ...shapesOf(after), ...shapesOf(minted.where), commit: minted.commit, yEntriesAfterCommit: minted.yAfter });
  assertInvariant(c5I4({ ...after, ...minted.where }, { base: s.base, typed: s.log.typed }));
});

// --- C5: a passage, not an element ---------------------------------------------------

/**
 * The passage variants. `from`/`to` are the selection's ends as frame.mjs
 * setSelectionBetween takes them (the first character of `from.exact` to the
 * last of `to.exact`, each once in its element); `between` the elements
 * wholly inside it; `points` where typists put their caret: right after
 * (`side: "after"`) or before a `word` that is once in its element;
 * `perTypist` "one" (typist k types TOKENS_AT_POINT tokens at points[k mod
 * the count]) or "all" (one token at every point); `unchanged` neighbours
 * that must stay exactly v1's; `ids` every element read.
 *
 * In "inside" and "across" every caret is just before a SPACE, which no token
 * holds. They isolate text-range deletion from equal-adjacent-character
 * identity (X-c05-structure-3, judged by "edge") and show what deleting
 * observed characters does to unseen concurrent typing inside the range
 * (X-c05-structure-2). "edge" puts the caret just before "russet": every
 * token's second character is "r", so every token meets that diff, and the
 * deletion takes the words AFTER the caret, so the tokens are typed outside
 * the passage and must stay (`edge: true`).
 */
const PASSAGES = Object.freeze({
  inside: Object.freeze({
    key: "inside",
    what: "a passage inside #e2e-10, from \"saffron\" to \"pepper \"",
    from: { id: "e2e-10", exact: "saffron" },
    to: { id: "e2e-10", exact: "pepper " },
    between: [],
    points: [{ id: "e2e-10", word: "saffron", side: "after" }, { id: "e2e-10", word: "lantern", side: "after" }, { id: "e2e-10", word: "harbor", side: "after" }, { id: "e2e-10", word: "ochre", side: "after" }],
    perTypist: "one",
    edge: false,
    unchanged: ["e2e-9", "e2e-11"],
    ids: ["e2e-9", "e2e-10", "e2e-11", SURV_DELETER, SURV_TYPIST],
  }),
  across: Object.freeze({
    key: "across",
    what: "a passage from the middle of #e2e-9 (\"fennel glacier\") to the middle of #e2e-11 (\"basil pepper \")",
    from: { id: "e2e-9", exact: "fennel glacier" },
    to: { id: "e2e-11", exact: "basil pepper " },
    between: ["e2e-10"],
    points: [{ id: "e2e-9", word: "glacier", side: "after" }, { id: "e2e-10", word: "lantern", side: "after" }, { id: "e2e-11", word: "kestrel", side: "after" }],
    perTypist: "all",
    edge: false,
    unchanged: ["e2e-8", "e2e-12"],
    ids: ["e2e-8", "e2e-9", "e2e-10", "e2e-11", "e2e-12", SURV_DELETER, SURV_TYPIST],
  }),
  edge: Object.freeze({
    key: "edge",
    what: "the words \"russet zephyr. \" in #e2e-10, right after the typists' caret",
    from: { id: "e2e-10", exact: "russet zephyr. " },
    to: { id: "e2e-10", exact: "russet zephyr. " },
    between: [],
    points: [{ id: "e2e-10", word: "russet", side: "before" }],
    perTypist: "one",
    edge: true,
    unchanged: ["e2e-9", "e2e-11"],
    ids: ["e2e-9", "e2e-10", "e2e-11", SURV_DELETER, SURV_TYPIST],
  }),
});
/** Where a point's caret goes in `text` (the word's start, or its end with side "after"). */
const pointOffset = (text, p) => text.indexOf(p.word) + (p.side === "after" ? p.word.length : 0);
const TOKENS_AT_POINT = 2;
const TOKEN_SPAN_RE = /⟦[^⟦⟧]{0,48}⟧/g;
/** A paragraph's text with every token-shaped span taken out, and U+00A0 read as a space (the I4 token analysis judges the tokens). */
const withoutTokens = (t) => String(t ?? "").replace(TOKEN_SPAN_RE, "").replace(/ /g, " ");
const once = (text, word) => text.indexOf(word) >= 0 && text.indexOf(word) === text.lastIndexOf(word);

/**
 * v1 as Chrome parses it, and what the variant's deletion must leave: the
 * passage's Range text (`selected`), the paragraph left (`kept`: {id: text}),
 * the elements it removes (`gone`), the texts it removes (`deleted`), each
 * point's offset, and the top-level element count after it. Every anchor is
 * checked against v1 first (once in its element, every point strictly inside
 * the passage): a fixture that drifted fails here, before anyone joins.
 */
async function passageBaseline(ctx, v) {
  const parser = await ctx.users.parser();
  await parser.setContent(readFixture(FIXTURE, { raw: true }).toString("utf8"));
  const shape = await readI3(parser);
  const texts = await parser.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.textContent ?? null])), v.ids);
  const t = (id) => {
    if (typeof texts[id] !== "string") throw new Error(`C5 ${v.key}: the fixture has no #${id}`);
    return texts[id];
  };
  for (const end of [v.from, v.to]) if (!once(t(end.id), end.exact)) throw new Error(`C5 ${v.key}: "${end.exact}" is not once in #${end.id} of the fixture`);
  const start = t(v.from.id).indexOf(v.from.exact);
  const end = t(v.to.id).indexOf(v.to.exact) + v.to.exact.length;
  const same = v.from.id === v.to.id;
  const kept = { [v.from.id]: same ? t(v.from.id).slice(0, start) + t(v.from.id).slice(end) : t(v.from.id).slice(0, start) + t(v.to.id).slice(end) };
  const deleted = same ? [t(v.from.id).slice(start, end)] : [t(v.from.id).slice(start), ...v.between.map(t), t(v.to.id).slice(0, end)];
  const gone = same ? [] : [...v.between, v.to.id];
  const points = v.points.map((p) => {
    if (!once(t(p.id), p.word)) throw new Error(`C5 ${v.key}: "${p.word}" is not once in #${p.id} of the fixture`);
    const at = pointOffset(t(p.id), p);
    const inside = p.id === v.from.id && p.id === v.to.id ? at > start && at < end : p.id === v.from.id ? at > start : p.id === v.to.id ? at < end : v.between.includes(p.id);
    const atEdge = p.id === v.from.id && at === start;
    if (v.edge ? !atEdge : !inside) throw new Error(`C5 ${v.key}: the caret ${p.side} "${p.word}" in #${p.id} is not ${v.edge ? "at the passage's start" : "inside the passage"}`);
    if (!v.edge && /[^\s]/.test(t(p.id).charAt(at))) throw new Error(`C5 ${v.key}: the caret ${p.side} "${p.word}" in #${p.id} is not before a space`);
    return { ...p, at };
  });
  const keptText = Object.values(kept).join(" ");
  for (const d of deleted) if (!d || keptText.includes(d)) throw new Error(`C5 ${v.key}: the deleted text ${JSON.stringify(d)} is empty or also in what is kept`);
  const selected = await setSelectionBetween(parser, { sel: sel(v.from.id), exact: v.from.exact }, { sel: sel(v.to.id), exact: v.to.exact });
  return { shape, texts, kept, deleted, gone, points, selected, children: shape.children - gone.length };
}

/** In a page or frame: the shape shapeInPage reads, for `ids`. */
async function shapeAt(u, ids) {
  return (await u.frame()).evaluate(shapeInPage, { ...SHAPE_ARG, ids });
}

/**
 * Delete the passage the way a person does: a selection from `from` to `to`
 * (setSelectionBetween: no mouse; the frame already has focus from a real
 * click before the race), then a real Backspace. Resolves {selected: the
 * Range's text, at, mutations: what the Backspace did to the DOM}, recorded
 * by a MutationObserver of the frame's own realm.
 */
async function deletePassage(u, v) {
  const frame = await u.frame();
  const key = `__e2eC5Mut${Math.random().toString(36).slice(2)}`;
  // Armed from the top page with the frame's own constructor, as sync.ts binds
  // its observer: the edit frame runs no script of its own.
  const armed = await u.page.evaluate(({ sel, key }) => {
    const f = document.querySelector(sel);
    const doc = f?.contentDocument;
    if (!doc?.body) return false;
    const label = (n) => (n.nodeType === 1 ? `${n.localName}${n.id ? `#${n.id}` : ""}` : n.nodeType === 3 ? `text(${JSON.stringify(n.data.slice(0, 24))}${n.data.length > 24 ? "…" : ""})` : `node${n.nodeType}`);
    const recs = [];
    const mo = new f.contentWindow.MutationObserver((rs) => {
      for (const r of rs) recs.push({ type: r.type, target: label(r.target), added: [...r.addedNodes].map(label), removed: [...r.removedNodes].map(label) });
    });
    mo.observe(doc.body, { subtree: true, childList: true, characterData: true });
    window[key] = { mo, recs };
    return true;
  }, { sel: DOC_FRAME, key });
  if (!armed) throw new Error(`${u.name}: no document frame to delete ${v.what} in`);
  const collect = () => u.page.evaluate((key) => {
    const s = window[key];
    if (!s) return null;
    s.recs.push(...s.mo.takeRecords().map((r) => ({ type: r.type, late: true })));
    s.mo.disconnect();
    delete window[key];
    return s.recs;
  }, key);
  let selected;
  try {
    selected = await setSelectionBetween(frame, { sel: sel(v.from.id), exact: v.from.exact }, { sel: sel(v.to.id), exact: v.to.exact });
  } catch (err) {
    await collect().catch(() => undefined);
    throw new Error(`${u.name}: cannot select ${v.what} to delete it: ${err.message}`);
  }
  const at = Date.now();
  await u.page.keyboard.press("Backspace");
  return { selected, at, mutations: await collect() };
}

/** Put `u`'s caret before or after the point's word in #id (once there), with no click: the frame has focus already. */
async function caretAt(u, p) {
  const frame = await u.frame();
  const text = await frame.evaluate((id) => document.getElementById(id)?.textContent ?? null, p.id);
  if (typeof text !== "string" || !once(text, p.word)) throw new Error(`${u.name}: "${p.word}" is not once in #${p.id} (${JSON.stringify(String(text).slice(0, 120))})`);
  await placeCaret(frame, sel(p.id), pointOffset(text, p));
}

/**
 * C5's I4 for a passage, one result: tokens.mjs's I4 over the segments
 * (observed tokens and tokens in removed parents gone; unseen tokens in
 * surviving parents, survivor tokens and edge tokens once and whole inside
 * their paragraph; the passage's observed text gone), plus what deletion took and
 * left: the paragraph kept is v1's with the passage cut out (tokens aside:
 * the token analysis judges them), the elements it removed absent, the
 * neighbours exactly v1's, the top-level count v1's less what it removed,
 * the sentinel once.
 */
function c5PassageI4(where, { v, base, typed }) {
  const segments = Object.fromEntries(Object.entries(where).map(([name, w]) => [name, w.segments]));
  const r = checkI4({ peers: segments, typed, deletedTexts: base.deleted });
  const failures = [...r.failures];
  for (const [name, { shape }] of Object.entries(where)) {
    for (const [id, text] of Object.entries(base.kept)) {
      if (shape.count[id] !== 1 || withoutTokens(shape.texts[id]) !== text) failures.push(`${name}: #${id} is not v1's with the passage cut out (${shape.count[id]}×, tokens aside): ${JSON.stringify(withoutTokens(shape.texts[id]).slice(0, 160))}, want ${JSON.stringify(text.slice(0, 160))}`);
    }
    // Known text around the cut stays in place; retained concurrent tokens
    // belong at that cut, never elsewhere in the surviving paragraph.
    for (const id of new Set(typed.filter((token) => token.expect !== "absent" && Object.hasOwn(base.kept, token.target)).map((token) => token.target))) {
      const cut = base.texts[id].indexOf(v.from.exact);
      const before = base.kept[id].slice(0, cut);
      const after = base.kept[id].slice(cut);
      const actual = String(shape.texts[id] ?? "").replace(/ /g, " ");
      if (!actual.startsWith(before) || !actual.endsWith(after)) failures.push(`${name}: retained insertions in #${id} moved outside the deleted range's cut`);
    }
    for (const id of base.gone) if (shape.count[id] !== 0) failures.push(`${name}: #${id} is still there (${shape.count[id]}×): ${JSON.stringify(String(shape.texts[id]).slice(0, 80))}`);
    for (const id of v.unchanged) if (shape.count[id] !== 1 || shape.texts[id] !== base.texts[id]) failures.push(`${name}: #${id} is not v1's (${shape.count[id]}×): ${JSON.stringify(String(shape.texts[id]).slice(0, 80))}`);
    if (shape.children !== base.children) failures.push(`${name}: ${shape.children} top-level element(s); v1 has ${base.shape.children}, less the ${base.gone.length} removed: ${base.children}`);
    if (shape.sentinels !== 1) failures.push(`${name}: the sentinel appears ${shape.sentinels} time(s)`);
  }
  return { invariant: "I4", ok: failures.length === 0, failures };
}

/** The deleter's own frame right after its Backspace: exactly the passage gone (the harness's own step). */
function passageDeletedExactly(after, { v, base }) {
  const why = [];
  for (const [id, text] of Object.entries(base.kept)) if (after.count[id] !== 1 || withoutTokens(after.texts[id]) !== text) why.push(`#${id} ${JSON.stringify(String(after.texts[id]).slice(0, 160))} (×${after.count[id]}), want ${JSON.stringify(text.slice(0, 160))}`);
  for (const id of base.gone) if (after.count[id] !== 0) why.push(`#${id} still there`);
  for (const id of v.unchanged) if (after.texts[id] !== base.texts[id]) why.push(`#${id} changed`);
  if (after.children !== base.children) why.push(`${after.children} top-level element(s), want ${base.children}`);
  return why;
}

/**
 * A passage variant's edits on a fresh live session, under the proxy's
 * window: the race (serial: false) or the same edits one after another
 * (serial: true: every token typed, and arrived at the deleter, before it
 * selects the passage, which then holds them all). Resolves {docId, users,
 * owner, base, log, proof, n} once the window has passed and the delay is
 * gone.
 */
async function c5PassageSession(ctx, { v, serial, title, n = ctx.n }) {
  const lat = rtdbLatency(ctx.target);
  await lat.reset();
  const base = await passageBaseline(ctx, v);
  precondition(base.shape.sentinels === 1, "the fixture has its sentinel once");
  const { docId, users, owner } = await joinShared(ctx, { n, fixture: FIXTURE, title });
  const conn = (await lat.stats()).stats.connections;
  precondition(conn >= n, `every browser's RTDB connection goes through the proxy (it carried ${conn} for ${n} peers)`);

  const log = tokenLog(ctx.target.runId);
  const [deleter, ...typists] = users;
  const plan = typists.map((u, i) => {
    const pts = v.perTypist === "one" ? [base.points[i % base.points.length]] : base.points;
    const per = v.perTypist === "one" ? TOKENS_AT_POINT : 1;
    return { u, at: pts.map((p) => ({ ...p, tokens: Array.from({ length: per }, () => log.next(u.name, p.id)) })), survivor: i === 0 ? log.next(u.name, SURV_TYPIST) : null };
  });
  const deleterSurvivor = log.next(deleter.name, SURV_DELETER);
  const windowMs = windowFor(n);
  /** What a typist's own frame must read after its typing, when nothing of anyone else's has reached it. */
  const ownTexts = (p) => {
    const out = {};
    for (const a of p.at) {
      const t = out[a.id] ?? base.texts[a.id];
      const i = pointOffset(t, a);
      out[a.id] = t.slice(0, i) + a.tokens.join("") + t.slice(i);
    }
    return out;
  };

  ctx.step(`${deleter.name} clicks at the end of #${v.from.id}; ${typists.map((p) => p.name).join(", ")} each click at the end of the paragraph it first types into (the frames have focus); every page records its input events`);
  await deleter.clickInFrame(sel(v.from.id), { where: "end" });
  for (const p of plan) await p.u.clickInFrame(sel(p.at[0].id), { where: "end" });
  const clocks = await inputClocks(users);
  const typeAll = async (p) => {
    for (const a of p.at) {
      await caretAt(p.u, a);
      for (const t of a.tokens) await p.u.page.keyboard.type(t);
    }
    const after = await shapeAt(p.u, v.ids);
    if (p.survivor) await p.u.typeInFrame(sel(SURV_TYPIST), p.survivor);
    return { name: p.u.name, after, own: ownTexts(p) };
  };
  const where = plan.map((p) => `${p.u.name} ${p.at.map((a) => `${a.tokens.length} ${a.side} "${a.word}" in #${a.id}`).join(", ")}`).join("; ");
  const proof = { variant: v.key, windowMs, serial };
  try {
    await lat.set({ up: windowMs, down: 0 });
    const set = await lat.get();
    precondition(set.up === windowMs, `the proxy holds client→database bytes ${windowMs} ms (it says ${JSON.stringify(set)})`);
    if (!serial) {
      ctx.step(`window ${windowMs} ms: ${deleter.name} deletes ${v.what} and types a survivor into #${SURV_DELETER}; at the same time ${where}${typists.length ? ` (${typists[0].name} then a survivor into #${SURV_TYPIST})` : ""}`);
      const [del, ...typed] = await Promise.all([
        (async () => {
          const d = await deletePassage(deleter, v);
          const after = await shapeAt(deleter, v.ids);
          await deleter.typeInFrame(sel(SURV_DELETER), deleterSurvivor);
          return { ...d, after };
        })(),
        ...plan.map(typeAll),
      ]);
      const clock = await clocks.read();
      Object.assign(proof, { deletion: { selected: del.selected, after: del.after, mutations: del.mutations }, typists: typed, inputs: clock.inputs, spanMs: clock.spanMs, inputProblems: clock.problems });
      ctx.ev.json(`c5-${v.key}-race`, proof);
      ctx.step(`the Backspace's mutations on ${deleter.name}: ${JSON.stringify(del.mutations).slice(0, 600)}`);
      // The deletion is the harness's own step: it must have removed exactly the passage.
      const wrong = passageDeletedExactly(del.after, { v, base });
      precondition(wrong.length === 0, `${deleter.name}'s Backspace removed exactly ${v.what}: ${wrong.join("; ")}`);
      const why = [...clock.problems];
      if (del.selected !== base.selected) why.push(`${deleter.name} deleted ${JSON.stringify(del.selected.slice(0, 80))}…, not v1's passage: a typed token had reached it`);
      for (const [id, text] of Object.entries(base.kept)) if (del.after.texts[id] !== text) why.push(`${deleter.name}'s #${id} right after its Backspace was ${JSON.stringify(String(del.after.texts[id]).slice(0, 80))}…, not v1's with the passage cut out: a typed token had reached it`);
      for (const t of typed) {
        for (const [id, text] of Object.entries(t.own)) {
          if (t.after.count[id] !== 1 || t.after.texts[id] !== text) why.push(`${t.name}'s #${id} after its typing was ${JSON.stringify(String(t.after.texts[id]).slice(0, 80))}… (×${t.after.count[id]}), not v1's text with its own tokens: another edit had reached it`);
        }
      }
      if (!(clock.spanMs < windowMs - WINDOW_MARGIN_MS)) why.push(`the edits spanned ${clock.spanMs} ms, not inside the ${windowMs} ms window less ${WINDOW_MARGIN_MS} ms`);
      ctx.step(`race: ${clock.inputs.map((x) => `${x.name} ${x.n} input(s)`).join(", ")}; span ${clock.spanMs} ms of a ${windowMs} ms window${why.length ? `; NOT PROVEN: ${why.join("; ")}` : "; proven: nobody saw another's edit before every edit was made"}`);
      measure(ctx, "c05-structure", { scenario: `C5 ${v.key} race`, windowMs, spanMs: clock.spanMs, inputs: clock.inputs.map((x) => ({ name: x.name, n: x.n })), proven: why.length === 0, why });
      if (why.length) ctx.inconclusive(`the race did not hold: ${why.join("; ")}`);
      await sleep(Math.max(0, clock.last + windowMs + 500 - Date.now()));
    } else {
      // One typist at a time, each once the one before it has reached every
      // peer: typists racing each other at one caret are a race too (at
      // "edge", X-c05-structure-3 nests their tokens with no deletion at all).
      ctx.step(`serial, window ${windowMs} ms: one typist at a time, each once the previous one's tokens have reached every peer: ${where}; then ${deleter.name} deletes ${v.what}`);
      const typedTokens = plan.flatMap((p) => p.at.flatMap((a) => a.tokens.map((token) => ({ id: a.id, token }))));
      const typed = [];
      for (const p of plan) {
        const mine = [...p.at.flatMap((a) => a.tokens.map((token) => ({ id: a.id, token }))), ...(p.survivor ? [{ id: SURV_TYPIST, token: p.survivor }] : [])];
        const others = users.filter((u) => u !== p.u);
        for (const o of others) for (const t of mine) await armArrival(o, t.id, t.token);
        typed.push(await typeAll(p));
        try {
          await Promise.all(others.flatMap((o) => mine.map((t) => waitForArrival(o, t.token, { timeout: windowMs + 30_000 }))));
        } catch (err) {
          ctx.inconclusive(`the serial order did not hold: a token ${p.u.name} typed never reached every peer (${err.message})`);
        }
      }
      const del = await deletePassage(deleter, v);
      const after = await shapeAt(deleter, v.ids);
      await deleter.typeInFrame(sel(SURV_DELETER), deleterSurvivor);
      const clock = await clocks.read();
      Object.assign(proof, { deletion: { selected: del.selected, after, mutations: del.mutations }, typists: typed, inputs: clock.inputs, inputProblems: clock.problems });
      ctx.ev.json(`c5-${v.key}-serial`, proof);
      const wrong = passageDeletedExactly(after, { v, base });
      precondition(wrong.length === 0, `${deleter.name}'s Backspace removed exactly ${v.what}: ${wrong.join("; ")}`);
      const missing = v.edge ? [] : typedTokens.filter((t) => !del.selected.includes(t.token)).map((t) => t.token);
      if (missing.length) ctx.inconclusive(`the serial order did not hold: ${deleter.name} deleted the passage without ${missing.join(", ")}`);
      ctx.step(`${deleter.name} deleted the passage ${v.edge ? "after every typed token had reached it" : "holding every typed token"}; the window is waited out`);
      await sleep(Math.max(0, (clock.last ?? Date.now()) + windowMs + 500 - Date.now()));
    }
  } finally {
    await lat.reset().catch(() => undefined);
  }
  ctx.step("the delay is gone");
  return { docId, users, owner, base, log, proof, n, serial };
}

/** A passage variant judged live: I4 on every peer, then the settle's own failure, if any. */
async function c5PassageJudge(ctx, s, v) {
  const { error } = await c5Settle(ctx, s);
  if (!v.edge) for (const id of new Set(v.points.map((p) => p.id))) {
    // Observed text is removed; unseen insertions survive in a retained parent.
    // Removing the parent itself also removes its unseen descendants.
    if (s.serial || s.base.gone.includes(id)) s.log.expectAbsent(id);
  }
  const peers = {};
  for (const u of s.users) peers[u.name] = { segments: await readSegments(u, v.ids), shape: await shapeAt(u, v.ids) };
  ctx.ev.json(`c5-${v.key}-peers`, shapesOf(peers));
  assertInvariant(c5PassageI4(peers, { v, base: s.base, typed: s.log.typed }));
  if (error) throw error;
}

// X-c05-structure-2, intentional text-range semantics: delete known character
// identities, preserve unseen concurrent inserts in a surviving parent. The
// serial control still deletes tokens the deleter already observed. Whole
// parent deletion removes its descendants, including concurrent inserts.
scenario("C5 delete a passage inside a paragraph while N−1 type inside it: observed text is deleted and unseen insertions survive once at the cut on every peer (I4), and the session converges (I1)", {
  tiers: ["local", "prod"],
  needs: ["rtdb-proxy"],
  n: [2, 5, 10, 20],
  timeoutMs: C5_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  const v = PASSAGES.inside;
  await c5PassageJudge(ctx, await c5PassageSession(ctx, { v, title: `C5 passage N=${ctx.n}`, serial: false }), v);
});

scenario("C5 passage serial control: the same typing inside the passage, then its deletion once every token has reached the deleter: the passage and its tokens are gone on every peer (I4)", {
  tiers: ["local", "prod"],
  needs: ["rtdb-proxy"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 },
  timeoutMs: C5_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  const v = PASSAGES.inside;
  await c5PassageJudge(ctx, await c5PassageSession(ctx, { v, title: `C5 passage serial N=${ctx.n}`, serial: true }), v);
});

// X-c05-structure-2 again: #e2e-10 (removed whole) and the head of #e2e-11
// (Chrome removes the element and moves its tail into #e2e-9) take their
// tokens with them; the token typed into the deleted tail of #e2e-9, a text
// range in the element that stays, survives.
scenario("C5 delete a passage across three paragraphs while N−1 type inside it: observed text and removed parents are gone, unseen insertions survive only in the retained parent (I4), and the session converges (I1)", {
  tiers: ["local", "prod"],
  needs: ["rtdb-proxy"],
  n: [2, 5, 10, 20],
  timeoutMs: C5_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  const v = PASSAGES.across;
  await c5PassageJudge(ctx, await c5PassageSession(ctx, { v, title: `C5 across N=${ctx.n}`, serial: false }), v);
});

scenario("C5 across serial control: the same typing inside the three paragraphs, then the deletion from the middle of the first to the middle of the third once every token has reached the deleter: the passage and its tokens are gone on every peer (I4)", {
  tiers: ["local", "prod"],
  needs: ["rtdb-proxy"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 },
  timeoutMs: C5_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  const v = PASSAGES.across;
  await c5PassageJudge(ctx, await c5PassageSession(ctx, { v, title: `C5 across serial N=${ctx.n}`, serial: true }), v);
});

// X-c05-structure-3 regression: every token's "r", typed just before "russet", was
// recorded after russet's own "r" (sync.ts onMutations: the longest common
// prefix runs across the equal letter), so the CRDT holds russet's "r" inside
// the token and the token's "r" at the head of "russet". p1's deletion takes
// russet's "r" by identity, from inside the token, and leaves the token's own
// "r" where "russet zephyr. " was: a token short of a letter, and a stray "r"
// glued to "Umber". The serial control passes: once the token has reached
// p1, its deletion is by position in a text that already holds the token.
scenario("C5 delete the words right after a caret while N−1 type at it: the words go and every token typed at the caret stays once and whole on every peer (I4), and the session converges (I1)", {
  tiers: ["local", "prod"],
  needs: ["rtdb-proxy"],
  n: [2, 5, 10, 20],
  timeoutMs: C5_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  const v = PASSAGES.edge;
  await c5PassageJudge(ctx, await c5PassageSession(ctx, { v, title: `C5 edge N=${ctx.n}`, serial: false }), v);
});

scenario("C5 edge serial control: the same typing at the caret, then the deletion of the words after it once every token has reached the deleter: the words go and every token stays once and whole on every peer (I4)", {
  tiers: ["local", "prod"],
  needs: ["rtdb-proxy"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 },
  timeoutMs: C5_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  const v = PASSAGES.edge;
  await c5PassageJudge(ctx, await c5PassageSession(ctx, { v, title: `C5 edge serial N=${ctx.n}`, serial: true }), v);
});

// --- C7 -------------------------------------------------------------------------------

const LARGE = "large-doc.html";
/** database.rules.json status/$docId/y/$entry: `newData.val().length <= 2097152`. */
const LOG_ENTRY_MAX = 2 * 1024 * 1024;
const STAGGER_MS = 1_500;
const SMALL_SECTIONS = 10;
const C7_TIMEOUT_MS = 900_000;
/**
 * Peer i's own paragraph: the first paragraph of sections 1–10, then the
 * second, and so on (each section has 15), so at every N up to 150 it is
 * inside the size control's cut. The same as `large-<i+1>-1` for N <= 10.
 */
const ownParagraph = (i) => `large-${(i % SMALL_SECTIONS) + 1}-${Math.floor(i / SMALL_SECTIONS) + 1}`;

/** Every peer's own paragraph (and any other id named) is in `body`: a cut that lost one fails here, before anyone joins. */
function requireIds(body, n, extra = []) {
  const ids = [...Array.from({ length: n }, (_, i) => ownParagraph(i)), ...extra];
  const lost = ids.filter((id) => !body.includes(`id="${id}"`));
  precondition(lost.length === 0, `the document has every paragraph this case types into (missing: ${lost.join(", ")})`);
}

/** The large fixture cut after its first `k` sections: deterministic, every id kept as it was. */
function largeCut(k) {
  const full = readFixture(LARGE);
  const cut = full.replace(new RegExp(`<section id="large-${k + 1}">[\\s\\S]*</section>\\n`), "");
  if (cut === full || !cut.includes(`<section id="large-${k}">`) || cut.includes(`id="large-${k + 1}"`)) throw new Error(`largeCut(${k}): the fixture does not have the shape this cut expects`);
  return cut;
}

/** v1's I3 shape of `html`, as Chrome parses it. */
async function shapeOf(ctx, html) {
  const parser = await ctx.users.parser();
  await parser.setContent(html);
  return readI3(parser);
}

/** Enter edit until "Shared"; a peer that never gets there is a failed sync precondition. */
async function enterShared(ctx, u, { timeout = 90_000 } = {}) {
  try {
    return await u.enterEdit({ waitShared: true, timeout });
  } catch (err) {
    const state = await u.shareState().catch(() => "unknown");
    if (state !== "shared" && /share-state|within|Timeout/i.test(String(err?.message))) {
      ctx.inconclusive(`the sync precondition did not hold: ${u.name} never showed "Shared" within ${timeout} ms (share state ${JSON.stringify(state)})`);
    }
    throw err;
  }
}

/** What the live log holds: entries, the longest, and how many are over the rule's limit. */
async function liveLog(ctx, docId) {
  const y = (await readLiveLogsPatient(ctx.target, docId)) ?? {};
  const lengths = Object.values(y).map((v) => (typeof v === "string" ? v.length : 0));
  return { entries: lengths.length, longest: lengths.length ? Math.max(...lengths) : 0, total: lengths.reduce((a, b) => a + b, 0), overLimit: lengths.filter((l) => l > LOG_ENTRY_MAX).length };
}

/**
 * Enter edit and wait only until joining ends ("Shared", or anything but
 * "Joining…"): where a peer that drops to editing alone is the product's
 * answer (S10's Tier 1), not a failed sync precondition. A join that never
 * ends is INCONCLUSIVE.
 */
async function enterJoined(ctx, u, { timeout = 90_000 } = {}) {
  await u.page.locator('.viewer-toolbar [aria-label="Edit"]').first().click();
  u.inEdit = true;
  await u.waitForFrame({ timeout, match: /\/draft\// });
  return eventually(async () => {
    const share = await u.shareState();
    const frame = await u.frame();
    const editable = await frame.evaluate(() => document.body.getAttribute("contenteditable") === "true");
    const error = (await u.page.locator('[role="alert"]').allTextContents()).join(" ");
    return share !== "joining" && (editable || error) ? { share, editable, error } : false;
  }, { timeout, interval: 100, message: `${u.name} joins or shows an explicit editing refusal` });
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What the live log refused of one page's writes, from its console: the
 * database SDK's "set|update at /status/<d>/y… failed: permission_denied"
 * warning, which it logs for every refused write whether or not the app
 * handles the refusal (so it still counts after a fix that catches it), and
 * the uncaught PERMISSION_DENIED page errors (today: an append from
 * log.ts onUpdate, which has no rejection handler; a refused compaction is
 * caught and logs only the warning). {refused, uncaught, first}.
 */
function refusedLiveWrites(u, docId) {
  const re = new RegExp(`(?:set|update|transaction) at /status/${escapeRe(docId)}/y\\S* failed: permission_denied`);
  const lines = (u.log?.console ?? []).filter((c) => re.test(String(c.text)));
  const uncaught = (u.log?.errors ?? []).filter((e) => /PERMISSION_DENIED/.test(String(e.message))).length;
  return { refused: lines.length, uncaught, first: lines.length ? String(lines[0].text).slice(0, 200) : null };
}

/** Wait until every page's refused-write count has been still for `quietMs` (at most `maxMs`). */
async function refusalsStill(users, docId, { quietMs = 3_000, maxMs = 30_000 } = {}) {
  const t0 = Date.now();
  let last = null;
  let since = t0;
  for (;;) {
    const now = users.map((u) => refusedLiveWrites(u, docId).refused).join(",");
    if (now !== last) {
      last = now;
      since = Date.now();
    }
    if (Date.now() - since >= quietMs || Date.now() - t0 >= maxMs) return Date.now() - t0;
    await sleep(250);
  }
}

/**
 * S10's Tier-1 property, "not silent": no peer shows "Shared" while the live
 * log refuses its writes. `peers` {name: {share, refused, uncaught}};
 * resolves the failures (empty: it holds). A peer with no refused write is
 * not judged, so a document no rule refuses passes as it should.
 */
function checkNotSilent(peers) {
  const failures = [];
  for (const [name, p] of Object.entries(peers)) {
    if (p.share === "shared" && p.refused > 0) failures.push(`${name} shows "Shared" while the live log refused ${p.refused} of its write(s) (${p.uncaught} uncaught PERMISSION_DENIED): ${JSON.stringify(p.first)}`);
  }
  return failures;
}

/** Each page's console lines and errors that name a refused database write. */
function deniedLines(users) {
  const out = {};
  for (const u of users) {
    const lines = [...(u.log?.console ?? []).map((c) => c.text), ...(u.log?.errors ?? []).map((e) => e.message)].filter((t) => /permission[_ ]denied/i.test(String(t)));
    if (lines.length) out[u.name] = { count: lines.length, first: String(lines[0]).slice(0, 300) };
  }
  return out;
}

/** Every peer's segments over the whole body: {name: segments}. */
async function segmentsOf(users, ids) {
  const out = {};
  for (const u of users) out[u.name] = await readSegments(u, ids);
  return out;
}

/** Run `fn` with the stack's and this process's Chromes' RSS sampled; the peak goes to diagnostics. */
async function withRss(ctx, fn) {
  const sampler = startRssSampler(ctx.target, { everyMs: 3_000, file: rssFile() });
  try {
    return await fn();
  } finally {
    const rss = await sampler.stop();
    ctx.ev.json("rss", rss);
    const p = rss.peak;
    const line = `RSS N=${ctx.n}: peak ${(p.totalBytes / GB).toFixed(2)} GB = stack ${(p.stackBytes / GB).toFixed(2)} GB + browsers ${(p.browserBytes / GB).toFixed(2)} GB (${rss.samples.length} samples)`;
    ctx.step(line);
    ctx.t.diagnostic(line);
  }
}

/**
 * C7's staggered joins and its oracles, on `body`. The editors enter edit one
 * at a time, STAGGER_MS apart, each typing a token into its own paragraph as
 * it arrives; then (with `probes`) p1 and pN each type a probe.
 * `requireShared: false` enters with enterJoined (see there) in place of
 * enterShared.
 */
async function c7Staggered(ctx, { n = ctx.n, body, title, probes = true, requireShared = true }) {
  requireIds(body, n);
  const baseline = await shapeOf(ctx, body);
  precondition(baseline.sentinels === 1, "the document has its sentinel once");
  // Start in reading mode so a rejected seed can be judged directly.
  const { docId, users, owner } = await joinShared(ctx, { n, body, title, enter: false });
  const log = tokenLog(ctx.target.runId);
  const ids = users.map((_, i) => ownParagraph(i));
  const joins = [];
  ctx.step(`the editors enter edit one at a time, ${STAGGER_MS} ms apart${requireShared ? "" : " (each until joining ends, Shared or not)"}, each typing a token into its own paragraph as it arrives`);
  for (let i = 0; i < n; i += 1) {
    const u = users[i];
    const t0 = Date.now();
    const entered = await enterJoined(ctx, u);
    if (requireShared || probes) assert.ok(entered.share === "shared" && entered.editable, `C7 live editing refused: ${u.name} ${entered.share}: ${entered.error}`);
    const text = await frameText(await u.frame());
    const earlier = log.typed.map((t) => t.token);
    const seen = earlier.filter((t) => text.includes(t));
    if (entered.editable) {
      const tok = log.next(u.name, ownParagraph(i));
      await typeProbe(u, sel(ownParagraph(i)), tok);
    }
    joins.push({ name: u.name, joinMs: Date.now() - t0, share: entered?.share ?? null, sawEarlier: `${seen.length}/${earlier.length}`, y: await liveLog(ctx, docId) });
    if (i < n - 1) await sleep(STAGGER_MS);
  }
  ctx.ev.json("c7-joins", joins);
  ctx.step(`joined: ${joins.map((j) => `${j.name} (${j.share}) saw ${j.sawEarlier} earlier token(s), log ${j.y.entries} entr(ies) longest ${j.y.longest}`).join("; ")}`);
  if (!probes) return { docId, users, owner, log, ids, baseline, live: null, y: await liveLog(ctx, docId), denied: deniedLines(users), n };

  const deadline = settleDeadlineMs(n);
  ctx.step(`probes: p1 types one into #${ids[0]}, then ${users[n - 1].name} one into #${ids[n - 1]}; every other peer is watched for each (up to ${deadline} ms, the settle deadline)`);
  const fromFirst = await probeArrivals(users, { from: users[0], id: ids[0], text: log.next(users[0].name, ids[0]), timeoutMs: deadline });
  const fromLast = await probeArrivals(users, { from: users[n - 1], id: ids[n - 1], text: log.next(users[n - 1].name, ids[n - 1]), timeoutMs: deadline });
  const arrivals = [
    ...fromFirst.arrivals.map((a) => ({ ...a, name: `${a.name} (probe from ${users[0].name})` })),
    ...fromLast.arrivals.map((a) => ({ ...a, name: `${a.name} (probe from ${users[n - 1].name})` })),
  ];
  const y = await liveLog(ctx, docId);
  const denied = deniedLines(users);
  ctx.ev.json("c7-mechanism", { liveLog: y, denied, arrivals, ruleLimit: LOG_ENTRY_MAX });
  ctx.step(`status/${docId}/y: ${y.entries} entr(ies), the longest ${y.longest} characters (the rule allows ${LOG_ENTRY_MAX}); permission_denied in ${Object.keys(denied).length} page(s)${Object.keys(denied).length ? `: ${Object.entries(denied).map(([k, v]) => `${k} ×${v.count}`).join(", ")}` : ""}`);
  const live = checkI13({ arrivals, limitMs: deadline });
  ctx.step(`arrivals: ${arrivals.map((a) => `${a.name} ${a.shared ? "Shared" : "not Shared"} ${a.ms == null ? "never" : `${a.ms} ms`}`).join("; ")}`);
  return { docId, users, owner, log, ids, baseline, live, y, denied, n };
}

/** C7's oracles, in order: probe liveness on every Shared peer, I1, I2 on every peer and the draft, I3. */
async function c7Judge(ctx, s) {
  assertInvariant(s.live);
  const settled = await settleLive(s.users, { docId: s.docId, n: s.n });
  ctx.step(`settled in ${settled.ms} ms on ${settled.hash.slice(0, 16)}`);
  const r = await s.owner.http.get(`/draft/${encodeURIComponent(s.docId)}/index.html`, { timeoutMs: 60_000 });
  precondition(r.status === 200, `GET /draft answered ${r.status}`);
  const draft = await segmentsOfHtml(await ctx.users.parser(), r.text, s.ids);
  assertInvariant(checkI2({ peers: await segmentsOf(s.users, s.ids), draft, typed: s.log.typed }));
  assertInvariant(checkI3({ peers: await readI3All(s.users), baseline: s.baseline }));
}

// S10 regression: the measured large seed must be supported and converge.
scenario("C7 a ~300 KB document with staggered joins: every peer shown as Shared receives the others' keystrokes, and every copy converges with every token once (no silent divergence over the live log's 2MiB bound)", {
  tiers: ["local", "prod"],
  n: [2, 5, 10, 20],
  timeoutMs: C7_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  await withRss(ctx, async () => {
    const s = await c7Staggered(ctx, { body: readFixture(LARGE), title: `C7 large N=${ctx.n}`, requireShared: false });
    await c7Judge(ctx, s);
  });
});

/**
 * "C7 not silent" and its size control: the staggered joins with no probes,
 * then every page's refused writes left to arrive (still for 3 s), then each
 * peer's share state against what the live log refused of its writes.
 */
async function c7NotSilent(ctx, { body, title }) {
  const s = await c7Staggered(ctx, { body, title, probes: false, requireShared: false });
  const waited = await refusalsStill(s.users, s.docId);
  const peers = {};
  for (const u of s.users) peers[u.name] = { share: await u.shareState(), ...refusedLiveWrites(u, s.docId) };
  const y = await liveLog(ctx, s.docId);
  ctx.ev.json("c7-not-silent", { peers, liveLog: y, waitedMs: waited, ruleLimit: LOG_ENTRY_MAX });
  ctx.step(`after the refusals were still (${waited} ms): ${Object.entries(peers).map(([k, p]) => `${k} ${p.share}, ${p.refused} refused write(s), ${p.uncaught} uncaught`).join("; ")}; status/${s.docId}/y ${y.entries} entr(ies), the longest ${y.longest}`);
  const failures = checkNotSilent(peers);
  measure(ctx, "c05-structure", { scenario: `C7 not silent (${title.replace(/ N=\d+$/, "")})`, peers: Object.fromEntries(Object.entries(peers).map(([k, p]) => [k, { share: p.share, refused: p.refused, uncaught: p.uncaught }])), entries: y.entries, longest: y.longest, failures: failures.length });
  assert.deepEqual(failures, [], `C7 not silent: ${failures.join("; ")}`);
}

// A rejected initial seed must never claim Shared or enable a solo editor.
scenario("C7 not silent: on the ~300 KB document joined in turn, no peer shows Shared while the live log refuses its writes", {
  tiers: ["local", "prod"],
  n: [2, 5, 10, 20],
  timeoutMs: C7_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  await withRss(ctx, () => c7NotSilent(ctx, { body: readFixture(LARGE), title: `C7 not silent N=${ctx.n}` }));
});

// controls-c07-not-silent targets this scenario's "[N=2]" case (its runs pass --n 2 --trials 1).
scenario("C7 not-silent size control: the same staggered joins on the document's first 10 sections (a seed under the 2MiB bound): no peer shows Shared while the live log refuses its writes", {
  tiers: ["local", "prod"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 },
  timeoutMs: C7_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  await withRss(ctx, () => c7NotSilent(ctx, { body: largeCut(SMALL_SECTIONS), title: `C7 not-silent size control N=${ctx.n}` }));
});

// controls-c07-seed-refused targets this scenario's "[N=2]" case (its runs pass --n 2 --trials 1).
scenario("C7 size control: the same staggered joins on the document's first 10 sections (a seed under the 2MiB bound) converge, every token once on every peer and in the draft", {
  tiers: ["local", "prod"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 },
  timeoutMs: C7_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  await withRss(ctx, async () => {
    const s = await c7Staggered(ctx, { body: largeCut(SMALL_SECTIONS), title: `C7 size control N=${ctx.n}` });
    await c7Judge(ctx, s);
  });
});

scenario("C7 serial control: the same ~300 KB document edited by one editor at a time: each sees every earlier token, and every reader and the draft hold them all once (I2)", {
  tiers: ["local", "prod"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 },
  timeoutMs: C7_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  await withRss(ctx, async () => {
    const n = ctx.n;
    const body = readFixture(LARGE);
    requireIds(body, n);
    const baseline = await shapeOf(ctx, body);
    const { docId, users, owner } = await joinShared(ctx, { n, body, title: `C7 serial N=${n}`, enter: false });
    const log = tokenLog(ctx.target.runId);
    const ids = users.map((_, i) => ownParagraph(i));
    const seen = [];
    ctx.step("one editor at a time: enter edit, check every earlier token is there, type a token into its own paragraph, wait for its autosave, Done");
    for (let i = 0; i < n; i += 1) {
      const u = users[i];
      await enterShared(ctx, u);
      const text = await frameText(await u.frame());
      seen.push({ name: u.name, missing: log.typed.map((t) => t.token).filter((t) => !text.includes(t)) });
      const save = await u.typeAndAutosave(sel(ownParagraph(i)), log.next(u.name, ownParagraph(i)));
      precondition(save.status === 200, `${u.name}'s autosave answered ${save.status}`);
      await u.done();
    }
    ctx.ev.json("c7-serial", { seen, liveLog: await liveLog(ctx, docId) });
    ctx.step(`every editor in turn: ${seen.map((x) => `${x.name} missed ${x.missing.length}`).join(", ")}; everyone opens the document again`);
    for (let i = 0; i < users.length; i += 5) await Promise.all(users.slice(i, i + 5).map((u) => u.open(docId, { timeout: 90_000 })));
    assert.deepEqual(seen.filter((x) => x.missing.length), [], "every editor, on entering, saw every token typed before it");
    const r = await owner.http.get(`/draft/${encodeURIComponent(docId)}/index.html`, { timeoutMs: 60_000 });
    precondition(r.status === 200, `GET /draft answered ${r.status}`);
    const draft = await segmentsOfHtml(await ctx.users.parser(), r.text, ids);
    assertInvariant(checkI2({ peers: await segmentsOf(users, ids), draft, typed: log.typed }));
    assertInvariant(checkI3({ peers: await readI3All(users), baseline }));
  });
});

// --- C7: S10's compaction half --------------------------------------------------------

/** The first 16 sections: a seed of about 189k characters, under the rule (measured live and required). */
const COMPACTION_SECTIONS = 16;
/** Where the paste goes: a paragraph no peer types into at any N (peers use sections 1–10). */
const FILLER_PARAGRAPH = `large-${COMPACTION_SECTIONS}-15`;
/** Bytes pasted beyond what takes the merged state to the rule's limit. */
const FILLER_MARGIN_BYTES = 3_000;
/** Tokens the early editors type in turn: about 17 keystrokes, so 17 log entries, each. */
const COMPACTION_TOKENS = 6;
/** log.ts COMPACT_AFTER: past this many entries every local append is followed by a compaction. */
const COMPACT_AFTER = 64;

/** `fill0 fill1 …`, at least `chars` long: plain words a paste can carry, none of them in the fixture. */
function fillerText(chars) {
  const words = [];
  let len = 0;
  for (let i = 0; len < chars; i += 1) {
    const w = `fill${i.toString(36)}`;
    words.push(w);
    len += w.length + 1;
  }
  return words.join(" ");
}

/** How many times `filler` is in #FILLER_PARAGRAPH on every peer and in the draft (U+00A0 read as a space). */
async function fillerCounts(users, parser, draftHtml, filler) {
  const count = (t) => {
    const s = String(t ?? "").replace(/ /g, " ");
    let k = 0;
    for (let i = s.indexOf(filler); i >= 0; i = s.indexOf(filler, i + 1)) k += 1;
    return k;
  };
  const out = {};
  for (const u of users) out[u.name] = count(await (await u.frame()).evaluate((id) => document.getElementById(id)?.textContent ?? null, FILLER_PARAGRAPH));
  out.draft = count(await parser.evaluate(({ html, id }) => new DOMParser().parseFromString(html, "text/html").getElementById(id)?.textContent ?? null, { html: draftHtml, id: FILLER_PARAGRAPH }));
  return out;
}

scenario("C7 compaction over the 2MiB bound: a seed under the bound whose merged state passes it after typing: skipped compactions lose nothing, and every peer, late joiners included, converges with every token once (I1, I2, I3)", {
  tiers: ["local", "prod"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 },
  timeoutMs: C7_TIMEOUT_MS,
  ...ON_STACK,
}, async (ctx) => {
  await withRss(ctx, async () => {
    const n = ctx.n;
    const body = largeCut(COMPACTION_SECTIONS);
    requireIds(body, n, [FILLER_PARAGRAPH]);
    const baseline = await shapeOf(ctx, body);
    precondition(baseline.sentinels === 1, "the document has its sentinel once");
    const { docId, users, owner } = await joinShared(ctx, { n, body, title: `C7 compaction N=${n}`, enter: false });
    const log = tokenLog(ctx.target.runId);
    const ids = users.map((_, i) => ownParagraph(i));
    const early = users.slice(0, n >= 3 ? 2 : 1);
    const late = users.slice(early.length);
    const lat = ctx.target.capabilities?.has?.("rtdb-proxy") ? rtdbLatency(ctx.target) : null;

    ctx.step(`${early.map((u) => u.name).join(" and ")} enter edit; ${early[0].name}'s seed must be in the live log, under the rule`);
    for (const u of early) await enterShared(ctx, u);
    let seeded = null;
    try {
      await eventually(async () => {
        seeded = await liveLog(ctx, docId);
        return seeded.longest >= 10_000;
      }, { timeout: 30_000, interval: 500, message: "a seed in status/{d}/y" });
    } catch {
      /* judged below */
    }
    precondition(seeded && seeded.longest >= 10_000 && seeded.longest < LOG_ENTRY_MAX, `${early[0].name}'s seed of the first ${COMPACTION_SECTIONS} sections is in the live log, under the rule's ${LOG_ENTRY_MAX} characters (the log: ${JSON.stringify(seeded)}): a cut whose seed is over it is S10's seed half, not this case`);
    const seed = seeded.longest;
    const filler = fillerText(Math.ceil(((LOG_ENTRY_MAX - seed) * 3) / 4) + FILLER_MARGIN_BYTES);

    ctx.step(`seed ${seed} characters; ${early[0].name} pastes a ${filler.length}-character passage at the end of #${FILLER_PARAGRAPH} (one input event, as a paste is), so the merged state passes ${LOG_ENTRY_MAX} while every entry stays under it`);
    const before = await liveLog(ctx, docId);
    await early[0].clickInFrame(sel(FILLER_PARAGRAPH), { where: "end" });
    await placeCaret(await early[0].frame(), sel(FILLER_PARAGRAPH), "end");
    await early[0].page.keyboard.insertText(filler);
    let pasted = before;
    try {
      await eventually(async () => {
        pasted = await liveLog(ctx, docId);
        return pasted.total >= before.total + filler.length;
      }, { timeout: 30_000, interval: 500, message: "the paste's entry in status/{d}/y" });
    } catch {
      /* recorded; the oracles judge whether the paste reached everyone */
    }
    const bytesBefore = lat ? (await lat.stats()).stats.bytesUp : null;

    ctx.step(`${early.map((u) => u.name).join(" and ")} type ${COMPACTION_TOKENS} tokens in turn into their own paragraphs (about ${COMPACTION_TOKENS * 17} keystrokes, one log entry each): past ${COMPACT_AFTER} entries every compaction is the whole document, over the rule`);
    for (let k = 0; k < COMPACTION_TOKENS; k += 1) {
      const u = early[k % early.length];
      const i = users.indexOf(u);
      await typeProbe(u, sel(ids[i]), log.next(u.name, ids[i]));
    }
    const stillMs = await refusalsStill(users, docId);
    const typedLog = await liveLog(ctx, docId);
    const refusedAfterTyping = Object.fromEntries(users.map((u) => [u.name, refusedLiveWrites(u, docId)]));
    const bytesUp = lat ? (await lat.stats()).stats.bytesUp - bytesBefore : null;
    const totalRefused = Object.values(refusedAfterTyping).reduce((a, r) => a + r.refused, 0);
    ctx.step(`after the typing (refusals still after ${stillMs} ms): status/${docId}/y ${typedLog.entries} entr(ies), the longest ${typedLog.longest}, ${typedLog.total} characters; refused writes ${Object.entries(refusedAfterTyping).map(([k, r]) => `${k} ×${r.refused} (uncaught ${r.uncaught})`).join(", ")}${bytesUp == null ? "" : `; ${bytesUp} bytes client→database during the typing`}`);
    assert.ok(typedLog.total > LOG_ENTRY_MAX && typedLog.entries >= COMPACT_AFTER, `C7 compaction: the oversized merged state retains its seed and deltas (${JSON.stringify(typedLog)})`);

    ctx.step(`${late.map((u) => u.name).join(", ")} join late, one at a time, ${STAGGER_MS} ms apart: each enters edit after the skipped compactions and types a token into its own paragraph`);
    const joins = [];
    for (const u of late) {
      await enterShared(ctx, u);
      const text = (await frameText(await u.frame())).replace(/ /g, " ");
      joins.push({ name: u.name, missed: log.typed.map((t) => t.token).filter((t) => !text.includes(t)), paste: text.includes(filler) });
      const i = users.indexOf(u);
      await typeProbe(u, sel(ids[i]), log.next(u.name, ids[i]));
      if (u !== late.at(-1)) await sleep(STAGGER_MS);
    }
    await refusalsStill(users, docId);
    const refused = Object.fromEntries(users.map((u) => [u.name, refusedLiveWrites(u, docId)]));
    const finalLog = await liveLog(ctx, docId);
    measure(ctx, "c05-structure", { scenario: "C7 compaction", seed, filler: filler.length, refusedAfterTyping: totalRefused, refused: Object.fromEntries(Object.entries(refused).map(([k, x]) => [k, { refused: x.refused, uncaught: x.uncaught }])), bytesUpDuringTyping: bytesUp, entries: finalLog.entries, longest: finalLog.longest });
    ctx.ev.json("c7-compaction", { seed, filler: filler.length, before, pasted, typedLog, finalLog, refusedAfterTyping, refused, bytesUpDuringTyping: bytesUp, joins, ruleLimit: LOG_ENTRY_MAX, compactAfter: COMPACT_AFTER });
    ctx.step(`late joins: ${joins.map((j) => `${j.name} missed ${j.missed.length} earlier token(s), ${j.paste ? "with" : "WITHOUT"} the paste`).join("; ") || "none"}; refused compactions in all: ${Object.entries(refused).map(([k, r]) => `${k} ×${r.refused}`).join(", ")}; status/${docId}/y ${finalLog.entries} entr(ies), the longest ${finalLog.longest}`);

    const settled = await settleLive(users, { docId, n });
    ctx.step(`settled in ${settled.ms} ms on ${settled.hash.slice(0, 16)}`);
    const r = await owner.http.get(`/draft/${encodeURIComponent(docId)}/index.html`, { timeoutMs: 60_000 });
    precondition(r.status === 200, `GET /draft answered ${r.status}`);
    const parser = await ctx.users.parser();
    const draft = await segmentsOfHtml(parser, r.text, ids);
    assertInvariant(checkI2({ peers: await segmentsOf(users, ids), draft, typed: log.typed }));
    assertInvariant(checkI3({ peers: await readI3All(users), baseline }));
    const counts = await fillerCounts(users, parser, r.text, filler);
    assert.deepEqual(Object.entries(counts).filter(([, c]) => c !== 1), [], `C7 compaction: the pasted passage is once in #${FILLER_PARAGRAPH} on every peer and in the draft (${JSON.stringify(counts)})`);
  });
});

scenario("C7 unsupported size: an encoded seed above 2MiB keeps editing disabled and explains recovery", {
  tiers: ["local", "prod"], n: [2], trials: 1, timeoutMs: C7_TIMEOUT_MS, ...ON_STACK,
}, async (ctx) => {
  const body = `<!doctype html><html><body><p id="large-unsupported">${"large document ".repeat(150_000)}</p></body></html>`;
  const { docId, users } = await joinShared(ctx, { n: ctx.n, body, title: "C7 unsupported size", enter: false });
  for (const u of users) {
    const entered = await enterJoined(ctx, u);
    assert.equal(entered.editable, false, `C7 unsupported size: ${u.name} must remain unbound`);
    assert.equal(entered.share, "off", `C7 unsupported size: ${u.name} must not claim sharing`);
    assert.match(entered.error, /too large.*2 MiB.*upload/, `C7 unsupported size: ${u.name} needs an actionable size limit`);
  }
  assert.equal((await liveLog(ctx, docId)).entries, 0, "C7 unsupported size: no seed is written for an unsupported document");
});
