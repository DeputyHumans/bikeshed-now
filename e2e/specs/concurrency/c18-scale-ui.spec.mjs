// SPDX-License-Identifier: Apache-2.0
// C18, C22, C23: presence at scale on a 400 px phone, a reader of the draft under a typing storm, an unlisted link holder among co-editors, and their serial positive controls (SPEC §6a, §16, §17).

/**
 * Each catalogue scenario is a WORK case, which joins N people to one
 * document, makes the scenario happen, proves it happened (a failed sync
 * precondition is INCONCLUSIVE, never FAIL), waits for the plan's settle
 * conditions (settleLive: a missed deadline is an I1 FAILURE) and asserts
 * what no suspect is predicted to break. What a suspect IS predicted to
 * break is a JUDGE case of its own, declared after the work case with the
 * same N and trials: it judges what the work case of the same [N=n] #trial
 * recorded, so each suspect's own assertion is the one that fails, and one
 * never hides another. A judge whose work case never measured is
 * INCONCLUSIVE (the work case carries that outcome itself).
 *
 *   C18  presence at scale. N people in one document, the last of them on
 *        a 400×800 touch phone (lib/browser.mjs device); the first
 *        ceil((N−1)/2) edit (the owner alone first, and seeds), the rest and
 *        the phone read. Presence chips live in the VIEWER toolbar, which an
 *        editor's EditToolbar replaces (DocViewer.tsx: `editingNow ?
 *        <EditToolbar …> : … <ViewerToolbar peers=…>`), so the observers are
 *        the readers. Work: every reader shows N−1 chips, one per OTHER
 *        person (presence.ts watchPeers leaves out the viewer's own uid),
 *        each in that person's mode: an editor's `data-mode="edit"`, the
 *        square rotated dot and the "Editing" icon, a reader's round dot
 *        (SPEC §16 spec.md:1480-1481 "presence chips encode mode by dot
 *        shape"); the count and the mode are two assertions ("C18:" and
 *        "C18 mode:"); and every one of the phone's chips is RENDERED and
 *        REACHABLE: a visible, non-zero box that a person can bring on
 *        screen by swiping the bar (scrollIntoView, then inside the viewport
 *        and the bar and topmost at its centre), or one an overflow summary
 *        ("+k") counts ("C18 chips:"). The editors settle (I1). Whether an
 *        editor shows a presence bar is recorded, not judged. Judges, on the
 *        phone at 400 px, each INCONCLUSIVE unless the phone showed its N−1
 *        chips in its DOM and every one rendered and reachable (a toolbar
 *        that fits because the chips are gone proves nothing): (page) the
 *        page never scrolls sideways, A24.1's rule
 *        (docs/architecture/overview.md:139 "The web app is responsive to
 *        400px"); (toolbar) the viewer toolbar fits the screen: at rest its
 *        primary actions (the Document/Comments pane toggle and Edit) lie
 *        wholly inside the viewport and the bar, and the bar is no wider
 *        than itself (suspect S29: PresenceBar has no overflow handling;
 *        viewer.css's 400 px tier wraps `.viewer-toolbar-actions` "so no
 *        future action can reintroduce the overflow", but the presence bar
 *        is a sibling it does not cover).
 *   C22  a reader under a typing storm. N−1 editors type tokens in rounds,
 *        each round past the 1 s autosave debounce, staggered, so a POST
 *        /draft lands every ~2/(N−1) s; the Nth member, an editor READING
 *        the head (so its frame shows the draft: frameMode.ts readsDraft,
 *        SPEC §6a spec.md:751-755), has scrolled to #e2e-8, opened a thread
 *        on "Paragraph 10." and is typing a reply in its reply box while the
 *        storm runs. Every peer save reloads the reader's frame
 *        (useLiveSync.ts:59-61). Race proof: at least 2 of the reader's frame
 *        reloads fall inside its own typing window, else INCONCLUSIVE. Work:
 *        the typists settle (I1) with every token once (I2), and the
 *        reader's frame catches up with every token. Judges: (place) the
 *        reader's place is kept: the frame's scrollY and #e2e-10's top are
 *        where they were (useDocFrame.ts:109-117 captures scrollY at each
 *        reload and restores it on load); its message says how many reloads
 *        were abandoned and overlapped, and names S28 only when one was
 *        abandoned (S28's traced mechanism needs overlapping loads); (reply)
 *        the reply box holds every key the reader typed, and keeps the focus.
 *   C22 held loads: the same, with each of the reader's frame loads (GET
 *        /draft/<doc>/…) held 2.5 s on its way to the stack
 *        (User.delayRequests, SYNC-H), so a peer save lands while the
 *        previous reload is still loading. Race proof: a reload began while
 *        the previous one was still held, else INCONCLUSIVE. The same judges;
 *        the place one is suspect S28's.
 *   C22 suggesting: the reader, instead of a reply, has selected "Paragraph
 *        10." and pressed Suggest edit (SPEC §22 spec.md:2577-2581: an
 *        editor reading the draft is offered it), and types into the
 *        suggestion form while the storm runs; it presses Escape (SPEC §22
 *        "Escape cancels") while the storm still runs. The product holds
 *        peer reloads while the form is open and makes the one it owes once
 *        it closes (DocViewer.tsx:357 `hold: suggesting !== null ||
 *        commenting`; useLiveSync.ts:17-21 "not while the reader is writing a
 *        suggestion: a reload throws the open form and the selection away",
 *        :60 and :74-78). Race proof: at least 2 of the typists' POST /draft
 *        answered 200 while the reader typed into the form, else
 *        INCONCLUSIVE. Work (no suspect predicts these break; the hold is
 *        the product's own): no reload of the reader's frame while the form
 *        was open, and the form still open with every key, its quote and the
 *        focus; the frame's selection still the passage; once it closes, the
 *        frame catches up with every token. C22 suggesting held: the same,
 *        with the reader's frame loads held 2.5 s, so the reload owed at the
 *        close is still loading when the next peer save lands; race proof:
 *        such an overlap, else INCONCLUSIVE; the same work assertions.
 *   C22 selection: the reader has selected "Paragraph 10." and does
 *        nothing else (the selection toolbar, Comment and Suggest edit,
 *        showing) while the storm runs. Race proof: a reload of its frame
 *        while it held the selection, else INCONCLUSIVE. Work: the typists
 *        settle and the reader catches up. Judge (selection kept): the
 *        frame still holds the selection and the toolbar still shows:
 *        suspect S28's selection half. Every reload remounts the frame
 *        (frameMode.ts:60-67 puts the reload epoch in the iframe's key,
 *        useDocFrame.ts:148-151 drops the document), and nothing restores a
 *        selection, so one save is enough: no overlap is needed.
 *   C23  an unlisted open-editing link holder among N−1 co-editors. The
 *        members edit live ("Shared"); the link holder opens the link with
 *        its key and presses Edit. Work: it is NOT shown "Shared", or it is
 *        genuinely merged: a member's probe reaches it, and its own token
 *        reaches every member, each within I13's 2 s of the last keystroke
 *        (checkI13, PROBE_ARRIVAL_MS, measured as A11.8 measures it; the
 *        wait runs to the settle deadline so a late arrival is told from a
 *        missing one) (SPEC §16 spec.md:1567-1571 "An unlisted one never
 *        does … its link holders edit through /draft instead … and are not
 *        merged live with the members", §16 spec.md:1583 "live co-editing
 *        through an unlisted link" is not built, §17 spec.md:1717-1718); a
 *        link holder not merged live sends its edit through POST /draft: a
 *        save CARRYING its token answers 200 (SPEC §16); and GET /draft, as
 *        the owner, holds that token before any member types (else
 *        INCONCLUSIVE: nothing of its was there to replace); the members
 *        settle (I1). Suspect S24, refuted at 2 peers by A11.8
 *        (DocViewer.tsx:308 shareLive excludes a non-member of an unlisted
 *        document), judged here at N. Judge (told): S24's harm, "silent
 *        last-writer-wins", by the path that remains: the members type
 *        after the link holder saved, a member's autosave (recorded: the
 *        first member POST /draft 200 after the link holder's) replaces the
 *        draft it saved (their live log never held its edit), and its edit
 *        must then still be in the draft, or the link holder must have been
 *        told (the conflict banner useLiveSync.ts:54-58 offers an editor:
 *        "the choice is offered"). A link holder has no `docs/{id}`
 *        (firestore.rules:147 `allow get: if isMember(...)`), so
 *        useLiveSync.ts:44 returns before any banner: X-c18-scale-ui-1.
 *        CLASS Q, weighed against SPEC §16 spec.md:1542-1544 ("Anyone who
 *        may edit a document may edit it at any time … edits merge, and
 *        every copy converges on the same document whatever order the
 *        updates arrive in"): the link holder may edit, its edit does not
 *        merge, and its copy never converges, so read alone that sentence
 *        makes this a P. But the same section carves link holders out of the
 *        merge by name (spec.md:1570-1571 "edit through /draft instead … and
 *        are not merged live with the members"), lists "live co-editing
 *        through an unlisted link" as deliberately not built (spec.md:1583),
 *        and ADR 0012:54-56 calls /draft "the documented fallback when there
 *        is no Realtime Database", which is whole-document last-writer-wins.
 *        Whether that carve-out waives "every copy converges" for a link
 *        holder (loss under last-writer-wins is then the intended outcome,
 *        and only the missing notice is in question) or only the LIVE
 *        channel (the loss is then a P against 1543-1544, and "told" would
 *        not be enough) is a SPEC question the code cannot answer: Q. The
 *        judge asserts the weaker reading (kept, or told), so it is red
 *        under both; a P reading would also need "kept".
 *   All C23 cases need `rtdb-rules` on a local stack: a stack attached from
 *        before the RTDB binding runs the live log's rules OPEN (S31), where
 *        an S24-patched link holder would be merged through open rules and
 *        C23 would pass for the wrong reason. Production's rules are its own.
 *
 * SERIAL POSITIVE CONTROLS (the same operations one after another, which
 * must PASS, so a red case is not the oracle failing for a harness reason):
 *   C18-serial  the phone opens the document first, with nobody else in
 *               it: its toolbar fits at 400 px with no chip (the toolbar
 *               oracle passes where nothing pushes it); then the others open
 *               it one after another, the editors among them entering edit,
 *               and after each every reader present shows one chip per other
 *               person, in that person's mode, and every chip on the phone
 *               is rendered and reachable. The phone's toolbar is measured
 *               after each arrival and recorded (rows in
 *               <invocation>/c18-bar.jsonl), never asserted past no chip.
 *   C22-serial  the same hold on the reader's frame loads, the same reply
 *               box, the same typists, but one save at a time: each typist
 *               types and autosaves only once the reader's previous reload
 *               has loaded and shows the token, and the reader types a piece
 *               of its reply between saves. The place and the reply are kept
 *               (the target of e2e/patches/controls-c22-reader-place).
 *   C22 selection-serial  the same world and typists, one save at a time,
 *               each waiting for the reader's reload; the reader selects the
 *               passage after the last one, and holds it through a quiet
 *               spell: kept, toolbar shown. The selection loss needs no
 *               race (one reload is enough), so the only serial order that
 *               passes is saves first, then the selection: this control
 *               shows the selection oracle reads a kept selection as kept;
 *               C22 suggesting shows it green THROUGH a storm, on the hold
 *               path.
 *   C23-serial  a MEMBER takes the link holder's place, joining after the
 *               others: it is "Shared", a member's probe reaches it and its
 *               token reaches every member within I13's 2 s (the oracle sees
 *               a merged peer), and its edit is in the draft the members
 *               settle on (the told judge's oracle passes for a merged peer).
 *   C23 told-serial  the same unlisted world: the members type, settle and
 *               stop; then the link holder enters the editor, types and
 *               autosaves LAST. Its edit is in the draft (kept), so the told
 *               judge's oracle passes on a link holder's own POST /draft
 *               path.
 *
 * Negative controls: e2e/patches/controls-c18-presence-chips (PresenceBar
 * drops a peer: "C18:" red), e2e/patches/controls-c18-dot-shape (the dot
 * shapes swapped: "C18 mode:" red at N=2 on an editor's chip, at N=5 on a
 * reader's), e2e/patches/controls-c22-reader-place (a reload no longer
 * captures the reader's scroll: the C22-serial place oracle red) and
 * e2e/patches/controls-c22-suggest-reload (useLiveSync is never told to
 * hold: "C22 suggesting:" red). Run with existing sets: controls-a24-overflow
 * (the page wider than a phone: the C18 page judge red) and
 * controls-a11-unlisted-live (the link holder joins the live log it may
 * not read: C23 red with its S24 message). The I13 bound, the reply box,
 * the catch-up and the chips' rendering are controlled by spec mutants
 * (README: Adding a negative control), recorded in the unit's ledger.
 *
 * Only e2e/lib/ talks to the stack.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { publish } from "../../lib/seed.mjs";
import { setVisibility } from "../../lib/grant.mjs";
import { closeAdmin } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { tokenLog } from "../../lib/tokens.mjs";
import { measure } from "../../lib/evidence.mjs";
import { idSelector } from "../../lib/frame.mjs";
import { signInMany } from "../../lib/browser.mjs";
import { PROBE_ARRIVAL_MS, assertInvariant, checkI13, checkI2, readSegments } from "../../lib/invariants.mjs";
import {
  addMember, grantEditors, joinGrantVia, joinShared, probeArrivals, rssFile, rtdbGetPatient, settleDeadlineMs, settleLive, startRssSampler,
} from "../../lib/live.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const FIXTURE = "crdt-paragraphs.html";
const BOTH = ["local", "prod"];
const N_ALL = [2, 5, 10, 20];
/**
 * C23's rules precondition: on a local stack, the capability readiness
 * grants once ns=<projectId> reads back the tree's RTDB rules and refuses an
 * anonymous read (a stack built before that binding runs the rules open:
 * S31). Production's deployed rules are the product's own (A11.8's note).
 */
const RTDB_RULES = target?.kind === "prod" ? [] : ["rtdb-rules"];
/** A24.1's phone: 400×800 CSS px, touch (Playwright hasTouch + isMobile: `(pointer: coarse)`). */
const PHONE = Object.freeze({ width: 400, height: 800, touch: true });
const CASE_MS = 900_000;
const SERIAL_MS = 1_500_000;
const JUDGE_MS = 30_000;
const LIVE = Object.freeze({ inconclusiveOnStackTimeout: true, inconclusiveOnPageStall: true });
const GB = 1024 ** 3;

/** C22: where the reader sits, the passage it comments on, and what it types into its reply box. */
const READER_TOP = "e2e-8";
const READER_MARK = "e2e-10";
const QUOTE = "Paragraph 10.";
const REPLY_HEAD = "C22 reply, typed before the storm; ";
const REPLY_TAIL = "and this part while the others type 0123456789";
/** C22 suggesting: what the reader types after the form's prefilled quote, before and during the storm (one line: Enter submits). */
const SUGGEST_HEAD = " (C22: typed before the storm;";
const SUGGEST_TAIL = " typed while others save 01234)";
/** Milliseconds between the reader's keys while the storm runs (REPLY_TAIL × this ≈ the storm). */
const REPLY_GAP_MS = 300;
/** C22: rounds per typist, the pause after each (past the 1 s debounce: one save per round), and the typing speed. */
const ROUNDS = 6;
/** C22 suggesting: rounds per typist, so the storm runs on well past the reader's Escape and the reload owed at the close meets later saves. */
const SUGGEST_ROUNDS = 9;
const PAUSE_MS = 1_600;
const KEY_DELAY_MS = 20;
/** C22: one typist's round, about: a 17-key token at KEY_DELAY_MS, a click, the pause. */
const ROUND_MS = 2_000;
/** C22 held loads: how long each of the reader's frame loads is held on its way to the stack. */
const HOLD_MS = 2_500;
/** C22: how far the reader's place may move, in CSS px (a restored scrollTo is exact; layout above it does not change). */
const PLACE_SLACK_PX = 4;
/** C22 selection-serial: how long the reader holds its selection with nobody typing. */
const QUIET_MS = 5_000;
/** C22: the typists' paragraphs, all below the reader's viewport, so their growth never moves what the reader sees. */
const typistParagraph = (i) => `e2e-${21 + i}`;
/** C22: where the first typist saves the token that makes a draft before the reader opens the document. */
const PRIMER_PARAGRAPH = "e2e-40";
/** C23: the link holder's paragraph and the members' probe paragraph. */
const LINK_PARAGRAPH = "e2e-30";
const PROBE_PARAGRAPH = "e2e-31";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sorted = (xs) => [...xs].sort();

// --- what the work cases leave for their judges ---------------------------------------------

/** `${ref}|${n}|${trial}` → the observation a work case recorded. */
const observed = new Map();
const keyOf = (ref, ctx) => `${ref}|${ctx.n}|${ctx.trial}`;

/** A fresh observation for this case, stored at once so a judge sees how far it got. */
function record(ctx, ref) {
  const o = { ref, n: ctx.n, trial: ctx.trial, stage: "started", inconclusive: null };
  observed.set(keyOf(ref, ctx), o);
  return o;
}

/** The work case's observation of `field`, or INCONCLUSIVE when it was never measured. */
function observation(ctx, ref, field) {
  const o = observed.get(keyOf(ref, ctx));
  if (!o) ctx.inconclusive(`the ${ref} work case [N=${ctx.n}] #${ctx.trial} did not run in this process, so there is nothing to judge`);
  if (o.inconclusive) ctx.inconclusive(`the ${ref} work case [N=${ctx.n}] #${ctx.trial} was INCONCLUSIVE: ${o.inconclusive}`);
  if (o[field] == null) ctx.inconclusive(`the ${ref} work case [N=${ctx.n}] #${ctx.trial} stopped (${o.stage}) before it measured ${field}`);
  ctx.ev.json(`observed-${field}`, o[field]);
  return o[field];
}

/** End the case INCONCLUSIVE, and tell its judges why. */
function inconclusive(ctx, obs, reason) {
  if (obs) obs.inconclusive = reason;
  ctx.inconclusive(reason);
}

// --- into the editor --------------------------------------------------------------------------
//
// One more person (C18's phone, C22's reader, C23's link holder and its
// serial control's late member) joins through lib/live.mjs addMember: its own
// account, its own grant or none (role null: the link and its key), its own
// device, signed in through the UI and left reading; on the operator path a
// grant whose RTDB mirror reads back wrong (S16) ends the case INCONCLUSIVE
// before any browser. Its judges then end INCONCLUSIVE through observation().

/** Into the editor until "Shared", or INCONCLUSIVE: the live session is this case's precondition. */
async function enterShared(ctx, obs, u, { timeout = 90_000 } = {}) {
  try {
    const { share } = await u.enterEdit({ waitShared: true, timeout });
    return share;
  } catch (err) {
    const state = await u.shareState().catch(() => "unknown");
    if (state !== "shared" && /share-state|within|Timeout/i.test(String(err?.message))) {
      inconclusive(ctx, obs, `the sync precondition did not hold: ${u.name} never showed "Shared" within ${timeout} ms (share state ${JSON.stringify(state)})`);
    }
    throw err;
  }
}

/** The live log holds the first editor's seed, or INCONCLUSIVE. */
async function waitSeed(ctx, obs, docId, who, { timeout = 90_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const y = await rtdbGetPatient(ctx.target, `status/${docId}/y`);
    if (y && typeof y === "object" && Object.keys(y).length > 0) return Object.keys(y).length;
    if (Date.now() >= deadline) inconclusive(ctx, obs, `the sync precondition did not hold: ${who}'s seed never reached status/${docId}/y within ${timeout} ms`);
    await sleep(200);
  }
}

// --- C18: presence chips and the 400 px toolbar ------------------------------------------------

/** The presence chips a page shows: name, data-mode, the dot's shape, the Editing icon. */
function chipsInPage() {
  return [...document.querySelectorAll(".presence-bar .presence-chip")].map((b) => {
    const dot = b.querySelector(".presence-dot");
    const cs = dot ? getComputedStyle(dot) : null;
    return {
      name: (b.querySelector(".presence-name")?.textContent ?? "").trim().toLowerCase(),
      mode: dot?.getAttribute("data-mode") ?? null,
      dotRadius: cs?.borderTopLeftRadius ?? null,
      dotRotated: cs ? cs.transform !== "none" : null,
      editingIcon: Boolean(b.querySelector('[aria-label="Editing"]')),
    };
  });
}

/**
 * What is wrong with one reader's chips, given `want` = [{email, mode}] for
 * every OTHER person present (empty: right), as {kind, text}: kind "count"
 * when the chips are not one per other person, "mode" when a chip does not
 * show its person's mode. Mode is the dot's SHAPE (SPEC §16): editing is
 * the square, rotated (`border-radius: 2px`, a transform) with the Editing
 * icon; reading is the round dot, unrotated, no icon.
 */
function chipProblems(name, chips, want) {
  const out = [];
  const names = sorted(chips.map((c) => c.name));
  const wanted = sorted(want.map((w) => w.email));
  if (JSON.stringify(names) !== JSON.stringify(wanted)) {
    out.push({ kind: "count", text: `${name} shows ${chips.length} chip(s) [${names.join(", ")}], want ${want.length}: [${wanted.join(", ")}]` });
  }
  const modeOf = new Map(want.map((w) => [w.email, w.mode]));
  for (const c of chips) {
    const mode = modeOf.get(c.name);
    if (!mode) continue;
    const bad = [];
    if (c.mode !== mode) bad.push(`data-mode ${JSON.stringify(c.mode)}, want ${JSON.stringify(mode)}`);
    const square = c.dotRadius === "2px" && c.dotRotated === true;
    if (mode === "edit" ? !square : square || c.dotRotated !== false) bad.push(`dot radius ${c.dotRadius}, rotated ${c.dotRotated} (want the ${mode === "edit" ? "square, rotated" : "round, unrotated"} dot)`);
    if (c.editingIcon !== (mode === "edit")) bad.push(mode === "edit" ? "no Editing icon" : "an Editing icon on a reader");
    if (bad.length) out.push({ kind: "mode", text: `${name}'s chip for ${c.name} (${mode === "edit" ? "editing" : "reading"}): ${bad.join(", ")}` });
  }
  return out;
}

/** The texts of one kind of chip problem across readings. */
const problemsOf = (readings, kind) => readings.flatMap((r) => r.problems.filter((p) => p.kind === kind).map((p) => p.text));

/**
 * Every observer shows one chip per other person in `people` ([{user,
 * email, mode}]), each in that person's mode, within `timeout`; resolves
 * {ok, readings} with the last reading either way.
 */
async function waitChips(observers, people, { timeout }) {
  let last = null;
  const read = async () => {
    const all = await Promise.all(observers.map((u) => u.page.evaluate(chipsInPage)));
    last = observers.map((u, i) => ({ name: u.name, chips: all[i], problems: chipProblems(u.name, all[i], people.filter((p) => p.user !== u).map(({ email, mode }) => ({ email, mode }))) }));
    return last.every((x) => x.problems.length === 0);
  };
  const ok = await eventually(read, { timeout, interval: 250, message: "every reader shows one chip per other person, in their mode" }).then(() => true, () => false);
  return { ok, readings: last };
}

/** The chip oracle, as two assertions: one chip per other person ("C18:"), then each in its person's mode ("C18 mode:"). */
function assertChips(readings, { n, who }) {
  const count = problemsOf(readings, "count");
  assert.deepEqual(count, [], `${who}: every reader shows N−1 = ${n - 1} chip(s), one per other person, each in that person's mode (SPEC §16): ${count.join("; ")}`);
  const mode = problemsOf(readings, "mode");
  assert.deepEqual(mode, [], `${who} mode: every chip shows its person's mode by its dot's shape and the Editing icon (SPEC §16 spec.md:1480-1481): ${mode.join("; ")}`);
}

/** How many presence bars a page shows (an editor's EditToolbar replaces the viewer toolbar, and its presence bar with it). */
const presenceBars = (u) => u.page.evaluate(() => document.querySelectorAll(".presence-bar").length);

/** C18's split of N people: the first ceil((N−1)/2) desktop users edit; the other desktop users and the phone read. */
const editorsOf = (n) => Math.ceil((n - 1) / 2);

/**
 * The phone's page and its viewer toolbar at rest (the bar scrolled back to
 * its start): sideways scroll (A24.1's measure), the bar's own width, and
 * where its primary actions and its chips lie. Then, for each chip (and any
 * overflow summary, "+k"), whether a person can get it on screen: visible
 * (checkVisibility, opacity and CSS), a non-zero box, and once scrolled into
 * view as a swipe of the bar would (scrollIntoView, instant), inside the
 * viewport and the bar and topmost at its centre. Every scroll is put back.
 */
function barInPage() {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const vh = window.innerHeight;
  const beforeX = window.scrollX;
  const beforeY = window.scrollY;
  window.scrollTo(100000, beforeY);
  const scrolledX = window.scrollX;
  window.scrollTo(beforeX, beforeY);
  const bar = document.querySelector(".viewer-toolbar");
  if (!bar) return { error: "no .viewer-toolbar on the page" };
  bar.scrollLeft = 0;
  const clip = bar.getBoundingClientRect();
  const box = (r) => [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
  const place = (el, label, c = clip) => {
    const r = el.getBoundingClientRect();
    const inViewport = r.width > 0 && r.height > 0 && r.left >= -0.5 && r.top >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5;
    const inBar = r.left >= c.left - 0.5 && r.right <= c.right + 0.5;
    const hit = inViewport ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    const onTop = Boolean(hit && (hit === el || el.contains(hit)));
    return { label, box: box(r), inViewport, inBar, onTop };
  };
  const primary = [];
  for (const b of document.querySelectorAll(".viewer-toolbar-actions .pane-toggle button")) primary.push(place(b, `pane toggle "${b.textContent.trim()}"`));
  for (const b of document.querySelectorAll('.viewer-toolbar-actions button[aria-label="Stop editing"], .viewer-toolbar-actions button[aria-label="Edit"]')) primary.push(place(b, `button "${b.getAttribute("aria-label")}"`));
  const presence = document.querySelector(".presence-bar");
  const actions = document.querySelector(".viewer-toolbar-actions");
  const nameOf = (c) => (c.querySelector(".presence-name")?.textContent ?? "").trim();
  const chipEls = [...document.querySelectorAll(".presence-bar .presence-chip")];
  const chips = chipEls.map((c) => place(c, nameOf(c)));
  // An overflow summary a fix might add in place of chips: "+3", or an aria-label "3 more".
  const summaryEls = presence
    ? [...presence.querySelectorAll(":scope > :not(.presence-chip)")].map((el) => {
      const text = (el.textContent ?? "").trim();
      const m = /^\+\s*(\d+)\b/.exec(text) ?? /(\d+)\s+more\b/i.exec(el.getAttribute("aria-label") ?? "");
      return m ? { el, text, count: Number(m[1]) } : null;
    }).filter(Boolean)
    : [];
  const visibleCss = (el) => (typeof el.checkVisibility === "function" ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true);
  const reach = (el, label) => {
    const visible = visibleCss(el);
    const r0 = el.getBoundingClientRect();
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const p = place(el, label, bar.getBoundingClientRect());
    return { label, visible, rendered: r0.width > 0 && r0.height > 0, reachable: visible && p.inViewport && p.inBar && p.onTop, box: p.box };
  };
  const reachRows = chipEls.map((c) => reach(c, nameOf(c)));
  const summaries = summaryEls.map((s) => ({ ...reach(s.el, s.text), count: s.count }));
  bar.scrollLeft = 0;
  window.scrollTo(beforeX, beforeY);
  return {
    vw,
    vh,
    coarse: matchMedia("(pointer: coarse)").matches,
    page: { clientWidth: vw, scrollWidth: Math.max(de.scrollWidth, document.body.scrollWidth), scrolledX },
    bar: { box: box(clip), scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth },
    presence: presence ? { box: box(presence.getBoundingClientRect()), scrollWidth: presence.scrollWidth } : null,
    actions: actions ? { box: box(actions.getBoundingClientRect()) } : null,
    primary,
    chips: { total: chips.length, inBar: chips.filter((c) => c.inBar && c.inViewport).length, rows: chips, reach: reachRows, summaries },
  };
}

/**
 * The rendering judgement on a bar reading: [] when every chip in the
 * phone's DOM is rendered and reachable, or an overflow summary that is
 * itself reachable counts the ones that are not.
 */
function chipRenderProblems(m) {
  const reach = m.chips.reach ?? [];
  const unreachable = reach.filter((c) => !c.reachable);
  const summarized = (m.chips.summaries ?? []).filter((s) => s.reachable).reduce((a, s) => a + s.count, 0);
  if (unreachable.length === 0 || summarized >= unreachable.length) return [];
  return [
    `${unreachable.length} of the phone's ${m.chips.total} chip(s) cannot be brought on screen${summarized ? `, and an overflow summary counts only ${summarized}` : ", and no overflow summary counts them"}: ${unreachable.map((c) => `${c.label} (visible ${c.visible}, box ${JSON.stringify(c.box)}, ${c.rendered ? "a box" : "no box"})`).join("; ")}`,
  ];
}

/** The judges' precondition: the phone showed its N−1 chips, every one rendered and reachable, else INCONCLUSIVE. */
function requireChipsShown(ctx, m) {
  if (m.chips.total !== ctx.n - 1) ctx.inconclusive(`the phone showed ${m.chips.total} chip(s) in its DOM, not N−1 = ${ctx.n - 1}, so how its page and toolbar hold them says nothing (the C18 work case judges the chips)`);
  const hidden = chipRenderProblems(m);
  if (hidden.length) ctx.inconclusive(`the phone did not show its N−1 chips, so a page or toolbar that fits proves nothing (the C18 work case judges the rendering): ${hidden.join("; ")}`);
}

/** The page judgement on a bar reading: [] when the page does not scroll sideways (A24.1). */
function pageSideways(m) {
  return m.page.scrollWidth > m.page.clientWidth || m.page.scrolledX !== 0
    ? [`the page scrolls sideways at ${m.vw} px: scrollWidth ${m.page.scrollWidth} > ${m.page.clientWidth}, scrollX after scrollTo(100000) ${m.page.scrolledX}`]
    : [];
}

/** The bar judgement: [] when the toolbar fits and its primary actions are on screen at rest. */
function barProblems(m) {
  const out = [];
  if (m.bar.scrollWidth > m.bar.clientWidth + 1) out.push(`the viewer toolbar runs ${m.bar.scrollWidth - m.bar.clientWidth} px past the screen (scrollWidth ${m.bar.scrollWidth} > ${m.bar.clientWidth}; the presence bar alone is ${m.presence?.scrollWidth ?? 0} px wide)`);
  for (const p of m.primary) {
    if (!(p.inViewport && p.inBar && p.onTop)) out.push(`${p.label} is off screen at rest: box ${JSON.stringify(p.box)}, inside the viewport ${p.inViewport}, inside the bar ${p.inBar}, topmost at its centre ${p.onTop}`);
  }
  return out;
}

/** Read the phone's bar; the reading is a precondition of the judgement (a phone, both primary actions found). */
async function readBar(phone) {
  const m = await phone.page.evaluate(barInPage);
  precondition(!m.error, `the phone's viewer toolbar is on the page: ${m.error ?? ""}`);
  precondition(m.coarse === true && m.vw === PHONE.width, `the phone is a ${PHONE.width} px coarse-pointer page (vw ${m.vw}, coarse ${m.coarse})`);
  precondition(m.primary.length >= 3, `the phone's toolbar has its pane toggle and its edit button (${m.primary.map((p) => p.label).join(", ") || "none"})`);
  return m;
}

/** A c18-bar.jsonl row from a bar reading. */
const barRow = (m) => ({
  chips: m.chips.total,
  chipsInBar: m.chips.inBar,
  chipsReachable: (m.chips.reach ?? []).filter((c) => c.reachable).length,
  barScrollWidth: m.bar.scrollWidth,
  barClientWidth: m.bar.clientWidth,
  presenceWidth: m.presence?.scrollWidth ?? 0,
  pageScrollWidth: m.page.scrollWidth,
  page: pageSideways(m).length === 0,
  bar: barProblems(m).length === 0,
});

scenario("C18 presence at scale: N people in one document, about half of them editing, the rest reading, the last on a 400 px phone; every reader shows N−1 presence chips, one per other person, each in that person's mode (editing: the square dot and the Editing icon; reading: the round dot), and the editors settle (I1)", {
  tiers: BOTH,
  n: N_ALL,
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const n = ctx.n;
  const obs = record(ctx, "C18");
  const sampler = startRssSampler(ctx.target, { everyMs: 3_000, file: rssFile() });
  try {
    const { docId, owner, users: desk, accounts } = await joinShared(ctx, { n: n - 1, title: `C18 N=${n}`, enter: false });
    ctx.step(`${desk.length} desktop member(s) reading ${docId}; p${n} opens it on a ${PHONE.width}×${PHONE.height} touch phone`);
    const phone = await addMember(ctx, { owner, docId, name: `p${n}`, role: "editor", device: PHONE });
    const e = editorsOf(n);
    const editors = desk.slice(0, e);
    const readers = [...desk.slice(e), phone.user];
    ctx.step(`${editors.map((u) => u.name).join(", ")} enter edit (${editors[0].name} alone first, and seeds); ${readers.map((u) => u.name).join(", ")} stay reading`);
    await enterShared(ctx, obs, editors[0]);
    await waitSeed(ctx, obs, docId, editors[0].name);
    for (let i = 1; i < editors.length; i += 5) await Promise.all(editors.slice(i, i + 5).map((u) => enterShared(ctx, obs, u)));
    const people = [
      ...desk.map((u, i) => ({ user: u, email: accounts[i].email.toLowerCase(), mode: i < e ? "edit" : "view" })),
      { user: phone.user, email: phone.account.email.toLowerCase(), mode: "view" },
    ];
    obs.stage = "joined";

    ctx.step(`every reader shows ${n - 1} chip(s), one per other person: ${e} editing, ${n - 1 - e} reading`);
    const chips = await waitChips(readers, people, { timeout: settleDeadlineMs(n) });
    ctx.ev.json("chips", chips.readings);
    obs.chips = chips.readings.map((r) => ({ name: r.name, count: r.chips.length, problems: r.problems }));
    const editorBars = await Promise.all(editors.map(presenceBars));
    obs.editorBars = editorBars;
    ctx.step(`while they edit, ${editorBars.filter((b) => b > 0).length} of ${editors.length} editor(s) show a presence bar (EditToolbar replaces the viewer toolbar; recorded)`);
    const settled = await settleLive(editors, { docId, n });
    ctx.step(`the editors settled in ${settled.ms} ms`);

    ctx.step(`the phone at ${PHONE.width} px with its ${n - 1} chip(s): its page and its toolbar at rest, and whether each chip can be brought on screen`);
    const m = await readBar(phone.user);
    obs.bar = m;
    obs.stage = "measured";
    measure(ctx, "c18-bar", { kind: "work", ...barRow(m) });
    ctx.step(`phone: page ${m.page.scrollWidth}/${m.page.clientWidth}, bar ${m.bar.scrollWidth}/${m.bar.clientWidth}, presence bar ${m.presence?.scrollWidth ?? 0} px, ${m.chips.inBar} of ${m.chips.total} chip(s) on screen at rest, ${barRow(m).chipsReachable} reachable; ${m.primary.map((p) => `${p.label} ${p.inViewport && p.inBar && p.onTop ? "on screen" : "OFF screen"}`).join(", ")}`);

    assertChips(chips.readings, { n, who: "C18" });
    const hidden = chipRenderProblems(m);
    assert.deepEqual(hidden, [], `C18 chips: every one of the phone's N−1 = ${n - 1} chip(s) is rendered and can be brought on screen (or an overflow summary counts it): ${hidden.join("; ")}`);
  } finally {
    const rss = await sampler.stop();
    const p = rss.peak;
    const line = `RSS N=${n}: peak ${(p.totalBytes / GB).toFixed(2)} GB = stack ${(p.stackBytes / GB).toFixed(2)} GB + browsers ${(p.browserBytes / GB).toFixed(2)} GB (${rss.samples.length} samples)`;
    ctx.step(line);
    ctx.t.diagnostic(line);
  }
});

scenario("C18 page at 400 px: with N−1 presence chips the phone's page never scrolls sideways (A24.1's rule)", { tiers: BOTH, n: N_ALL, timeoutMs: JUDGE_MS }, async (ctx) => {
  const m = observation(ctx, "C18", "bar");
  requireChipsShown(ctx, m);
  assert.deepEqual(pageSideways(m), [], `C18 page: with ${m.chips.total} chip(s) the phone's page scrolls sideways at ${m.vw} px: ${pageSideways(m).join("; ")}`);
});

/**
 * One judge, declared per N because the known defect depends on N: S29
 * needs two chips or more. At 400 px the bar has room for ONE chip beside
 * the version chip and the wrapped actions. Measured (C18-serial's rows,
 * <invocation>/c18-bar.jsonl, the same on every run): a chip is 132 px; the
 * bar's scrollWidth is 400 with 0 or 1 chip, 510 with 2, 640 with 3 and 771
 * with 4, when the pane toggle and Edit sit at x 596–754 of a 400 px screen.
 * So N=2 (one chip) must pass, and from N=5 (four chips) on the presence bar
 * pushes the actions off. Each is INCONCLUSIVE unless the phone showed its
 * N−1 chips, rendered and reachable: an S29 "fix" that hides the presence
 * bar at 400 px leaves it INCONCLUSIVE (and fails the C18 work case's
 * "C18 chips:" assertion), never green.
 */
const C18_TOOLBAR = "C18 toolbar at 400 px: with N−1 presence chips the phone's viewer toolbar fits the screen, and at rest its pane toggle and Edit lie wholly inside the viewport and the bar";
async function judgeToolbar(ctx) {
  const m = observation(ctx, "C18", "bar");
  requireChipsShown(ctx, m);
  assert.deepEqual(barProblems(m), [], `S29: with ${m.chips.total} presence chip(s) the phone's toolbar does not fit at ${m.vw} px: ${barProblems(m).join("; ")}`);
}
scenario(C18_TOOLBAR, { tiers: BOTH, n: [2], timeoutMs: JUDGE_MS }, judgeToolbar);
scenario(C18_TOOLBAR, { tiers: BOTH, n: [5, 10, 20], timeoutMs: JUDGE_MS, defect: "S29" }, judgeToolbar);

scenario("C18-serial positive control: the phone opens the document alone and its toolbar fits at 400 px with no chip; then the others open it one after another, the editors among them entering edit, and after each every reader present shows one chip per other person, in that person's mode", {
  tiers: BOTH,
  n: N_ALL,
  timeoutMs: SERIAL_MS,
  ...LIVE,
}, async (ctx) => {
  const n = ctx.n;
  const obs = record(ctx, "C18-serial");
  ctx.step(`cast an owner and ${n - 1} editor(s); the owner publishes ${FIXTURE} and shares it for editing`);
  const names = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const accounts = await cast(ctx.target, names.map((p, i) => (i === 0 ? "owner" : `editor-${p}`)), { http: ctx.http({ actor: "harness" }) });
  const owner = await openSession(ctx.target, accounts[0], { timeoutMs: 120_000 });
  const up = await publish(owner.http, { fixture: FIXTURE, title: `C18 serial N=${n}`, name: "live", timeoutMs: 120_000 });
  const docId = up.docId;
  if (n > 1) {
    const via = joinGrantVia(ctx.target);
    const granted = await grantEditors(ctx.target, { owner, doc: docId, accounts: accounts.slice(1), role: "editor", via, timeoutMs: 120_000 });
    if (via === "operator" && granted.missing.length > 0) inconclusive(ctx, obs, `the sync precondition did not hold: the RTDB mirror of ${granted.missing.map((m) => m.email).join(", ")} is missing (suspect S16)`);
  }
  // The phone is the last account, as in C18, and the first to open the document.
  const phone = await ctx.users.user({ name: names[n - 1], device: PHONE, consent: "denied" });
  const desk = await ctx.users.many(n - 1, { batch: 5, names: names.slice(0, n - 1), consent: "denied" });
  ctx.step("everyone signs in; nobody but the phone opens the document yet");
  await signInMany([...desk, phone], accounts, { batch: 5 });
  const e = editorsOf(n);
  const personOf = (u) => {
    const i = desk.indexOf(u);
    return { user: u, email: accounts[i < 0 ? n - 1 : i].email.toLowerCase(), mode: i >= 0 && i < e ? "edit" : "view" };
  };

  ctx.step(`${phone.name} opens ${docId} alone and stays reading`);
  await phone.open(docId);
  const alone = await readBar(phone);
  ctx.ev.json("bar-alone", alone);
  measure(ctx, "c18-bar", { kind: "serial", ...barRow(alone) });
  ctx.step(`alone: page ${alone.page.scrollWidth}/${alone.page.clientWidth}, bar ${alone.bar.scrollWidth}/${alone.bar.clientWidth}, ${alone.chips.total} chip(s); ${alone.primary.map((p) => `${p.label} ${p.inViewport && p.inBar && p.onTop ? "on screen" : "OFF screen"}`).join(", ")}`);
  assert.equal(alone.chips.total, 0, "C18-serial: the phone alone shows no chip");
  assert.deepEqual([...pageSideways(alone), ...barProblems(alone)], [], "C18-serial: with no chip the phone's page and toolbar fit at 400 px");

  const present = [phone];
  const editing = [];
  for (const [i, u] of desk.entries()) {
    const edits = i < e;
    ctx.step(`${u.name} opens the document${edits ? " and enters edit" : " and reads"}`);
    await u.open(docId);
    if (edits) {
      await enterShared(ctx, obs, u);
      if (editing.length === 0) await waitSeed(ctx, obs, docId, u.name);
      editing.push(u);
    }
    present.push(u);
    const observers = present.filter((x) => !editing.includes(x));
    const chips = await waitChips(observers, present.map(personOf), { timeout: settleDeadlineMs(n) });
    const m = await readBar(phone);
    measure(ctx, "c18-bar", { kind: "serial", ...barRow(m) });
    ctx.step(`${present.length} present (${editing.length} editing): chips ${chips.ok ? "right" : "WRONG"}; phone bar ${m.bar.scrollWidth}/${m.bar.clientWidth} with ${m.chips.total} chip(s), ${barRow(m).chipsReachable} reachable (recorded)`);
    assertChips(chips.readings, { n, who: `C18-serial (${present.length} present)` });
    const hidden = chipRenderProblems(m);
    assert.deepEqual(hidden, [], `C18-serial chips: with ${present.length} people present every chip on the phone can be brought on screen: ${hidden.join("; ")}`);
  }
  if (editing.length) {
    const settled = await settleLive(editing, { docId, n });
    ctx.step(`the editors settled in ${settled.ms} ms`);
  }
});

// --- C22: a reader of the draft under a typing storm ----------------------------------------------

/** The reader's frame: its scroll, where the commented passage sits, and the document it shows. */
async function frameView(u) {
  const f = await u.frame();
  return f.evaluate(({ mark }) => {
    const el = document.getElementById(mark);
    return {
      scrollY: Math.round(scrollY),
      markTop: el ? Math.round(el.getBoundingClientRect().top) : null,
      maxScroll: Math.round(document.documentElement.scrollHeight - innerHeight),
      path: location.pathname,
    };
  }, { mark: READER_MARK });
}

/** The reader's reply box in its thread on QUOTE: value and focus. */
async function replyBox(u) {
  const box = u.thread(QUOTE).locator('textarea[placeholder="Reply"]').first();
  const [value, focused] = await Promise.all([box.inputValue(), box.evaluate((el) => el === document.activeElement)]);
  return { value, focused };
}

/** The reader's selection in its frame (trimmed text, ranges), and whether the selection toolbar (Comment, Suggest edit) shows. */
async function selectionState(u) {
  const f = await u.frame();
  const sel = await f.evaluate(() => {
    const s = document.getSelection();
    return { text: (s?.toString() ?? "").trim(), ranges: s?.rangeCount ?? 0, collapsed: s ? s.isCollapsed : null };
  });
  const toolbar = await u.page.locator(".selection-fab").first().isVisible().catch(() => false);
  return { ...sel, toolbar };
}

/**
 * The part every C22 world shares: N−1 typists in the editor (joinShared,
 * p1 the owner) and the Nth member, an editor, reading the head once a
 * draft exists: its frame shows the draft. Resolves {docId, owner, typists,
 * reader, log, primer}.
 */
async function draftReader(ctx, { title }) {
  const n = ctx.n;
  const { docId, owner, users: typists } = await joinShared(ctx, { n: n - 1, title });
  const log = tokenLog(ctx.target.runId);
  ctx.step(`${typists[0].name} saves a first token, so a draft exists before the reader opens the document`);
  const primer = log.next(typists[0].name, PRIMER_PARAGRAPH);
  const saved = await typists[0].typeAndAutosave(idSelector(PRIMER_PARAGRAPH), primer, { timeout: 60_000 });
  precondition(saved.status === 200, `the first draft save answered ${saved.status}`);
  ctx.step(`p${n}, an editor, opens the document and stays reading: its frame shows the draft`);
  const { user: reader } = await addMember(ctx, { owner, docId, name: `p${n}`, role: "editor" });
  await reader.waitForFrame({ match: /\/draft\//, timeout: 60_000 });
  return { docId, owner, typists, reader, log, primer };
}

/** The reader scrolls READER_TOP to the top of its frame; resolves its place once the frame holds still there. */
async function scrollToReaderTop(ctx, reader) {
  ctx.step(`the reader scrolls ${READER_TOP} to the top of its frame`);
  await (await reader.frame()).evaluate((id) => {
    const el = document.getElementById(id);
    window.scrollTo(0, Math.round(el.getBoundingClientRect().top + window.scrollY - 8));
  }, READER_TOP);
  return holdStill(reader);
}

/** The reader's place once its frame holds still (two readings 600 ms apart agree), scrolled and with the commented passage in view. */
async function holdStill(reader) {
  const place = await eventually(async () => {
    const a = await frameView(reader);
    await sleep(600);
    const b = await frameView(reader);
    return a.scrollY === b.scrollY && a.markTop === b.markTop && a.scrollY > 0 ? b : false;
  }, { timeout: 15_000, interval: 100, message: "the reader's frame holds still where it scrolled to" });
  precondition(place.markTop != null && place.markTop > 0 && place.markTop < 600, `the commented passage is in the reader's view: ${JSON.stringify(place)}`);
  return place;
}

/**
 * C22's world: the draft reader opens a thread on QUOTE, scrolls #e2e-8 to
 * the top and types REPLY_HEAD into the thread's reply box, which keeps the
 * focus. Resolves {docId, typists, reader, log, place, primer}.
 */
async function readerWorld(ctx, { title }) {
  const w = await draftReader(ctx, { title });
  const { reader } = w;
  ctx.step(`the reader opens a thread on "${QUOTE}"`);
  await reader.selectText(idSelector(READER_MARK), QUOTE);
  await reader.comment("C22: a thread whose reply box the reader writes in");
  const place = await scrollToReaderTop(ctx, reader);
  const box = reader.thread(QUOTE).locator('textarea[placeholder="Reply"]').first();
  await box.click();
  await reader.page.keyboard.type(REPLY_HEAD, { delay: 10 });
  const ready = await replyBox(reader);
  precondition(ready.value === REPLY_HEAD && ready.focused, `the reader's reply box holds its first words and the focus: ${JSON.stringify(ready)}`);
  const settledPlace = await frameView(reader);
  precondition(settledPlace.scrollY === place.scrollY, `the reader's frame did not move while it started its reply (${place.scrollY} → ${settledPlace.scrollY})`);
  ctx.step(`the reader sits at scrollY ${place.scrollY}, #${READER_MARK} ${place.markTop} px from the top, with "${REPLY_HEAD}" in its reply box`);
  return { ...w, place };
}

/**
 * C22 suggesting's and C22 selection's world: the draft reader scrolls
 * #e2e-8 to the top and selects QUOTE (the selection toolbar shows); with
 * `form`, it presses Suggest edit and types SUGGEST_HEAD after the quote
 * the field is prefilled with, the field keeping the focus. Resolves
 * {docId, typists, reader, log, place, primer, selection, form}.
 */
async function selectionWorld(ctx, { title, form }) {
  const w = await draftReader(ctx, { title });
  const { reader } = w;
  await scrollToReaderTop(ctx, reader);
  ctx.step(`the reader selects "${QUOTE}" in #${READER_MARK}${form ? " and presses Suggest edit" : " and does nothing else"}`);
  const sel = await reader.selectText(idSelector(READER_MARK), QUOTE);
  precondition(sel.text === QUOTE, `the reader selected "${QUOTE}" (${sel.via}: ${JSON.stringify(sel.text)})`);
  let opened = null;
  if (form) {
    await reader.pressSuggest({ refused: false });
    opened = await eventually(async () => {
      const s = await reader.suggestState();
      return s.open && s.focused ? s : false;
    }, { timeout: 10_000, interval: 100, message: "the suggestion form opens with the focus in its field" });
    precondition(opened.value === QUOTE && opened.quote?.trim() === QUOTE, `the suggestion form opens on "${QUOTE}", its field prefilled with it: ${JSON.stringify(opened)}`);
    await reader.page.keyboard.type(SUGGEST_HEAD, { delay: 10 });
    opened = await reader.suggestState();
    precondition(opened.open && opened.focused && opened.value === QUOTE + SUGGEST_HEAD, `the reader's suggestion field holds its first words and the focus: ${JSON.stringify(opened)}`);
  }
  const place = await holdStill(reader);
  const selection = await selectionState(reader);
  // The selection lives in the frame's own document, so the form's field taking the focus in the page leaves it in place.
  precondition(selection.text === QUOTE && selection.ranges === 1, `the reader's frame holds its selection of "${QUOTE}" before the storm: ${JSON.stringify(selection)}`);
  if (!form) precondition(selection.toolbar, `the selection toolbar (Comment, Suggest edit) shows for the reader's selection: ${JSON.stringify(selection)}`);
  ctx.step(`the reader sits at scrollY ${place.scrollY}, #${READER_MARK} ${place.markTop} px from the top, "${QUOTE}" selected${form ? `, "${opened.value}" in its suggestion form` : ", the selection toolbar showing"}`);
  return { ...w, place, selection, form: opened };
}

/** The reader types `text` one key at a time, `gapMs` apart; resolves each key's Date.now(). */
async function typeSlowly(page, text, gapMs) {
  const at = [];
  for (const ch of text) {
    await page.keyboard.type(ch);
    at.push(Date.now());
    await sleep(gapMs);
  }
  return at;
}

/** Every typist types `rounds` tokens into its own paragraph, one per round, each followed by the pause that makes a save; staggered so the saves spread. */
async function storm(typists, log, { rounds = ROUNDS } = {}) {
  const staggerMs = Math.floor(ROUND_MS / typists.length);
  await Promise.all(typists.map(async (u, i) => {
    await sleep(i * staggerMs);
    for (let r = 0; r < rounds; r += 1) {
      await u.typeInFrame(idSelector(typistParagraph(i)), log.next(u.name, typistParagraph(i)), { delay: KEY_DELAY_MS });
      await sleep(PAUSE_MS);
    }
  }));
}

/**
 * The typists settle (I1), every token is once in its paragraph on every
 * typist (I2), and the reader's frame shows every token (asserted as
 * `${who}: …`).
 */
async function afterStorm(ctx, { docId, typists, reader, log }, { who = "C22" } = {}) {
  const settled = await settleLive(typists, { docId, n: ctx.n });
  ctx.step(`the typists settled in ${settled.ms} ms`);
  const ids = [...typists.map((_, i) => typistParagraph(i)), PRIMER_PARAGRAPH];
  const peers = {};
  for (const u of typists) peers[u.name] = await readSegments(u, ids);
  assertInvariant(checkI2({ peers, typed: log.typed }));
  const tokens = log.typed.map((e) => e.token);
  let missing = tokens;
  const caught = await eventually(async () => {
    const text = await (await reader.frame()).evaluate(() => document.body?.textContent ?? "");
    missing = tokens.filter((t) => !text.includes(t));
    return missing.length === 0 ? true : false;
  }, { timeout: settleDeadlineMs(ctx.n) + 30_000, interval: 250, message: "the reader's frame shows every token" }).then(() => true, () => false);
  assert.ok(caught, `${who}: the reader's frame catches up with the draft: every token typed is in it (useLiveSync.ts: a reader of the draft sees each peer save); missing ${missing.length} of ${tokens.length}: ${missing.slice(0, 6).join(" ")}`);
  // The restore runs in a frame after the load (useDocFrame.ts:137-139): give the last reload time to land.
  await sleep(1_500);
}

/** Rows of the reader's frame loads of the draft (watchFrameLoads), plain. */
const draftLoads = (loads) => loads.summary().filter((l) => l.kind === "draft");

/** The reader's frame loads of `docId`'s draft, as a path pattern for delayRequests. */
const draftPath = (docId) => new RegExp(`^/draft/${docId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`);

/** Held loads whose holds overlapped: one reached the route before the previous one was let go (a reload begun while the previous was still loading). */
function heldOverlaps(hold) {
  const heldRows = hold ? hold.rows.filter((r) => r.heldAt != null) : [];
  const overlaps = heldRows.filter((r, i) => i > 0 && heldRows[i - 1].releasedAt != null && r.heldAt < heldRows[i - 1].releasedAt).length;
  return { held: heldRows.length, overlaps };
}

/** The C22 work case, natural or with the reader's frame loads held. */
async function c22Work(ctx, { held }) {
  const ref = held ? "C22 held" : "C22";
  const obs = record(ctx, ref);
  const w = await readerWorld(ctx, { title: `${ref} N=${ctx.n}` });
  const { docId, typists, reader, log, place } = w;
  obs.stage = "world";
  const loads = reader.watchFrameLoads(docId);
  const hold = held ? await reader.delayRequests(draftPath(docId), { method: "GET", rules: Array.from({ length: 500 }, () => HOLD_MS) }) : null;
  let keys = [];
  try {
    ctx.step(`the storm: ${typists.length} typist(s) × ${ROUNDS} round(s), a save each round, staggered; the reader types the rest of its reply meanwhile${held ? `; each of its frame loads held ${HOLD_MS} ms` : ""}`);
    [keys] = await Promise.all([typeSlowly(reader.page, REPLY_TAIL, REPLY_GAP_MS), storm(typists, log)]);
    if (hold) {
      // Let every held load go on; the reader then catches up with the last save at full speed.
      await hold.restore();
    }
    await afterStorm(ctx, w);
  } finally {
    if (hold) await hold.restore().catch(() => undefined);
    await loads.stop();
  }
  const view = await frameView(reader);
  const reply = await replyBox(reader);
  const rows = draftLoads(loads);
  const [first, last] = [keys[0], keys[keys.length - 1]];
  const inWindow = rows.filter((r) => r.t >= first && r.t <= last);
  const abandoned = rows.filter((r) => !r.committed);
  // A reload that began while the previous load was still held: two held loads whose hold intervals overlap.
  const { held: heldCount, overlaps } = heldOverlaps(hold);
  obs.storm = { loads: rows.length, inWindow: inWindow.length, abandoned: abandoned.length, overlaps, held: heldCount, keys: keys.length };
  ctx.ev.json("loads", rows);
  measure(ctx, "c22-storm", { kind: held ? "held" : "natural", ...obs.storm, scrollBefore: place.scrollY, scrollAfter: view.scrollY, markBefore: place.markTop, markAfter: view.markTop, replyKept: reply.value === REPLY_HEAD + REPLY_TAIL, focused: reply.focused });
  ctx.step(`reader: ${rows.length} draft load(s), ${inWindow.length} inside its typing window, ${abandoned.length} abandoned before committing${held ? `, ${overlaps} begun while the previous was held` : ""}; scrollY ${place.scrollY} → ${view.scrollY}, #${READER_MARK} ${place.markTop} → ${view.markTop}; reply ${reply.value === REPLY_HEAD + REPLY_TAIL ? "whole" : `"${reply.value}"`}, focused ${reply.focused}`);
  if (inWindow.length < 2) inconclusive(ctx, obs, `the storm did not reach the reader while it typed: ${inWindow.length} of its ${rows.length} frame reload(s) fell inside its typing window (want 2 or more)`);
  if (held && overlaps < 1 && abandoned.length < 1) inconclusive(ctx, obs, `the race did not hold: no reload of the reader's frame began while the previous load was still held (${heldCount} held load(s), none overlapping, none abandoned)`);
  obs.place = { before: place, after: view, storm: obs.storm };
  obs.reply = { want: REPLY_HEAD + REPLY_TAIL, ...reply };
  obs.stage = "measured";
}

/** The place judgement: [] when the reader's frame is where it was. */
function placeProblems({ before, after: now }) {
  const out = [];
  if (Math.abs(now.scrollY - before.scrollY) > PLACE_SLACK_PX) out.push(`scrollY ${before.scrollY} → ${now.scrollY}`);
  if (now.markTop == null || Math.abs(now.markTop - before.markTop) > PLACE_SLACK_PX) out.push(`#${READER_MARK}'s top ${before.markTop} → ${now.markTop} px`);
  return out;
}

/**
 * The words a moved place is reported in: how many of the reader's reloads
 * were abandoned and overlapped, and S28 named only when a reload was
 * abandoned (its traced mechanism: a reload begun while the previous one
 * was loading captures the new, still-blank frame's scroll).
 */
function placeCause(storm) {
  if (!storm) return "";
  const counts = `${storm.abandoned} of the reader's ${storm.loads} reload(s) abandoned before committing, ${storm.overlaps} begun while the previous was held`;
  return storm.abandoned > 0
    ? `${counts}: S28's traced mechanism (a reload begun while the previous one was loading)`
    : `${counts}: no reload overlapped another, so this is not S28's traced mechanism; read the evidence`;
}

/** The reply judgement: [] when every key is in the box and it keeps the focus. */
function replyProblems(r) {
  const out = [];
  if (r.value !== r.want) out.push(`the reply box holds ${JSON.stringify(r.value)}, want ${JSON.stringify(r.want)}`);
  if (!r.focused) out.push("the reply box lost the focus");
  return out;
}

scenario("C22 reader under a typing storm: N−1 editors type and autosave in staggered rounds while an editor reading the draft holds its place and types a reply; the typists settle (I1, I2) and the reader's frame catches up with every token", {
  tiers: BOTH,
  n: N_ALL,
  timeoutMs: CASE_MS,
  ...LIVE,
}, (ctx) => c22Work(ctx, { held: false }));

scenario("C22 place: the reader's frame keeps its place through the storm (scrollY and the commented passage where they were)", { tiers: BOTH, n: N_ALL, timeoutMs: JUDGE_MS }, async (ctx) => {
  const p = observation(ctx, "C22", "place");
  const moved = placeProblems(p);
  assert.deepEqual(moved, [], `C22 place: a peer's save reloaded the reader's frame and its place moved (${moved.join(", ")}); ${placeCause(p.storm)}`);
});

scenario("C22 reply: the reader's half-written reply keeps every key it typed through the storm, and the focus", { tiers: BOTH, n: N_ALL, timeoutMs: JUDGE_MS }, async (ctx) => {
  const r = observation(ctx, "C22", "reply");
  assert.deepEqual(replyProblems(r), [], `C22 reply: the storm cost the reader keys of its reply, or its focus: ${replyProblems(r).join("; ")}`);
});

scenario("C22 held loads: the same storm with each of the reader's frame loads held 2.5 s, so a peer's save lands while the previous reload is still loading; the typists settle (I1, I2) and the reader catches up", {
  tiers: BOTH,
  n: N_ALL,
  timeoutMs: CASE_MS,
  ...LIVE,
}, (ctx) => c22Work(ctx, { held: true }));

scenario("C22 held loads place: the reader's frame keeps its place though reloads overlapped", { tiers: BOTH, n: N_ALL, timeoutMs: JUDGE_MS, defect: "S28" }, async (ctx) => {
  const p = observation(ctx, "C22 held", "place");
  const moved = placeProblems(p);
  assert.deepEqual(moved, [], `S28: a reload that began while the previous one was loading lost the reader's place (${moved.join(", ")}); ${placeCause(p.storm)}`);
});

scenario("C22 held loads reply: the reader's reply keeps every key and the focus though reloads overlapped", { tiers: BOTH, n: N_ALL, timeoutMs: JUDGE_MS }, async (ctx) => {
  const r = observation(ctx, "C22 held", "reply");
  assert.deepEqual(replyProblems(r), [], `C22 held reply: the storm cost the reader keys of its reply, or its focus: ${replyProblems(r).join("; ")}`);
});

scenario("C22-serial positive control: the same held frame loads, reply box and typists, one save at a time: each typist saves once the reader's previous reload shows the last token, and the reader types a piece of its reply between saves; its place and its reply are kept", {
  tiers: BOTH,
  n: N_ALL,
  timeoutMs: SERIAL_MS,
  ...LIVE,
}, async (ctx) => {
  record(ctx, "C22-serial");
  const w = await readerWorld(ctx, { title: `C22 serial N=${ctx.n}` });
  const { docId, typists, reader, log, place } = w;
  const loads = reader.watchFrameLoads(docId);
  const hold = await reader.delayRequests(draftPath(docId), { method: "GET", rules: Array.from({ length: 500 }, () => HOLD_MS) });
  const chunk = Math.ceil(REPLY_TAIL.length / (typists.length * 2));
  let typed = 0;
  try {
    for (let r = 0; r < 2; r += 1) {
      for (const [i, u] of typists.entries()) {
        const token = log.next(u.name, typistParagraph(i));
        const s = await u.typeAndAutosave(idSelector(typistParagraph(i)), token, { delay: KEY_DELAY_MS, timeout: 60_000 });
        precondition(s.status === 200, `${u.name}'s save answered ${s.status}`);
        await eventually(async () => (await (await reader.frame()).evaluate((t) => document.body?.textContent.includes(t) === true, token)) || false, { timeout: HOLD_MS + 30_000, interval: 200, message: `the reader's frame shows ${u.name}'s token` });
        await sleep(1_000); // the restore runs in a frame after the load
        const piece = REPLY_TAIL.slice(typed, typed + chunk);
        if (piece) {
          await reader.page.keyboard.type(piece, { delay: 20 });
          typed += piece.length;
        }
      }
    }
    if (typed < REPLY_TAIL.length) await reader.page.keyboard.type(REPLY_TAIL.slice(typed), { delay: 20 });
    await hold.restore();
    await afterStorm(ctx, w, { who: "C22-serial" });
  } finally {
    await hold.restore().catch(() => undefined);
    await loads.stop();
  }
  const view = await frameView(reader);
  const reply = await replyBox(reader);
  const rows = draftLoads(loads);
  ctx.step(`reader: ${rows.length} draft load(s), ${rows.filter((r) => !r.committed).length} abandoned; scrollY ${place.scrollY} → ${view.scrollY}, #${READER_MARK} ${place.markTop} → ${view.markTop}; reply ${reply.value === REPLY_HEAD + REPLY_TAIL ? "whole" : JSON.stringify(reply.value)}, focused ${reply.focused}`);
  measure(ctx, "c22-storm", { kind: "serial", loads: rows.length, abandoned: rows.filter((r) => !r.committed).length, scrollBefore: place.scrollY, scrollAfter: view.scrollY, markBefore: place.markTop, markAfter: view.markTop, replyKept: reply.value === REPLY_HEAD + REPLY_TAIL, focused: reply.focused });
  precondition(rows.length >= typists.length * 2, `the reader's frame reloaded for each save (${rows.length} load(s) for ${typists.length * 2} save(s))`);
  assert.deepEqual(placeProblems({ before: place, after: view }), [], "C22-serial: the reader's place is kept when its frame reloads one save at a time");
  const lost = replyProblems({ want: REPLY_HEAD + REPLY_TAIL, ...reply });
  assert.deepEqual(lost, [], `C22-serial: the reader's reply keeps every key and the focus: ${lost.join("; ")}`);
});

// --- C22 suggesting: the hold path -----------------------------------------------------------------

/** The suggestion form's judgement: [] when no reload came while it was open, and it kept every key, its quote and the focus. */
function formProblems(f) {
  const out = [];
  if (f.loadsWhileOpen > 0) out.push(`the reader's frame reloaded ${f.loadsWhileOpen} time(s) while its suggestion form was open (the hold, DocViewer.tsx:357, did not hold)`);
  if (!f.form?.open) out.push("the suggestion form was gone before the reader pressed Escape");
  else {
    if (f.form.value !== f.want) out.push(`the form's field holds ${JSON.stringify(f.form.value)}, want ${JSON.stringify(f.want)}`);
    if (!f.form.focused) out.push("the form's field lost the focus");
    if (f.form.quote?.trim() !== QUOTE) out.push(`the form quotes ${JSON.stringify(f.form.quote)}, want ${JSON.stringify(QUOTE)}`);
  }
  return out;
}

/**
 * The C22 suggesting work case, natural or held. The reader's suggestion
 * form is open on its selection when the storm starts; it types the rest of
 * its suggestion while the typists save, and presses Escape while they
 * still do. Its frame must not reload while the form is open, and must
 * catch up once it closes.
 */
async function c22SuggestWork(ctx, { held }) {
  const ref = held ? "C22 suggesting held" : "C22 suggesting";
  const obs = record(ctx, ref);
  const w = await selectionWorld(ctx, { title: `${ref} N=${ctx.n}`, form: true });
  const { docId, typists, reader, log, place } = w;
  obs.stage = "world";
  const loads = reader.watchFrameLoads(docId);
  const hold = held ? await reader.delayRequests(draftPath(docId), { method: "GET", rules: Array.from({ length: 500 }, () => HOLD_MS) }) : null;
  const marks = typists.map((u) => u.responseMark());
  const want = QUOTE + SUGGEST_HEAD + SUGGEST_TAIL;
  let keys = [];
  let atClose = null;
  let closedAt = null;
  try {
    ctx.step(`the storm: ${typists.length} typist(s) × ${SUGGEST_ROUNDS} round(s), a save each round, staggered; the reader types the rest of its suggestion meanwhile and presses Escape while they still save${held ? `; each of its frame loads held ${HOLD_MS} ms` : ""}`);
    const writing = (async () => {
      keys = await typeSlowly(reader.page, SUGGEST_TAIL, REPLY_GAP_MS);
      const [form, selection, view] = await Promise.all([reader.suggestState(), selectionState(reader), frameView(reader)]);
      atClose = { form, selection, view };
      await reader.page.keyboard.press("Escape");
      closedAt = Date.now();
    })();
    await Promise.all([writing, storm(typists, log, { rounds: SUGGEST_ROUNDS })]);
    const closed = await eventually(async () => !(await reader.suggestState()).open, { timeout: 5_000, interval: 100, message: "the suggestion form closes on Escape" }).then(() => true, () => false);
    precondition(closed, "the suggestion form closes on Escape (SPEC §22 \"Escape cancels\")");
    const rows = draftLoads(loads);
    const saves = typists.flatMap((u, i) => u.findResponses({ method: "POST", path: "/draft", status: 200 }, { since: marks[i] }).map((r) => ({ who: u.name, at: r.at })));
    const inTyping = saves.filter((s) => s.at >= keys[0] && s.at <= keys[keys.length - 1]);
    const whileOpen = rows.filter((r) => r.t < closedAt);
    const afterClose = rows.filter((r) => r.t >= closedAt);
    obs.storm = { saves: saves.length, savesWhileTyping: inTyping.length, loads: rows.length, loadsWhileOpen: whileOpen.length, loadsAfterClose: afterClose.length };
    ctx.ev.json("loads", rows);
    ctx.ev.json("at-close", atClose);
    ctx.step(`while the form was open: ${inTyping.length} of the typists' ${saves.length} save(s) answered 200 as the reader typed; the reader's frame loaded ${whileOpen.length} time(s); after Escape ${afterClose.length}`);
    if (inTyping.length < 2) inconclusive(ctx, obs, `the storm did not reach the reader while it wrote its suggestion: ${inTyping.length} of the typists' ${saves.length} save(s) answered while it typed (want 2 or more)`);
    if (hold) {
      const { held: heldCount, overlaps } = heldOverlaps(hold);
      obs.storm.held = heldCount;
      obs.storm.overlaps = overlaps;
      if (overlaps < 1) inconclusive(ctx, obs, `the race did not hold: the reload owed at the close never overlapped a later one (${heldCount} held load(s), none begun while the previous was held)`);
    }
    const f = { loadsWhileOpen: whileOpen.length, form: atClose.form, want };
    obs.form = f;
    obs.stage = "measured";
    const broken = formProblems(f);
    assert.deepEqual(broken, [], `${ref}: while the form was open no peer save reloaded the reader's frame, and the form kept every key, its quote and the focus (DocViewer.tsx:357, useLiveSync.ts:17-21): ${broken.join("; ")}`);
    assert.equal(atClose.selection.text, QUOTE, `${ref} selection: while the form was open the reader's frame kept its selection of "${QUOTE}": ${JSON.stringify(atClose.selection)}`);
    if (hold) await hold.restore();
    await afterStorm(ctx, w, { who: `${ref} catch-up` });
  } finally {
    if (hold) await hold.restore().catch(() => undefined);
    await loads.stop();
  }
  const view = await frameView(reader);
  measure(ctx, "c22-suggest", { kind: held ? "held" : "natural", ...obs.storm, formKept: atClose?.form?.value === want, focused: atClose?.form?.focused ?? null, selectionKept: atClose?.selection?.text === QUOTE, scrollBefore: place.scrollY, scrollAtClose: atClose?.view?.scrollY ?? null, scrollAfter: view.scrollY });
  ctx.step(`after the catch-up: scrollY ${place.scrollY} → ${atClose?.view?.scrollY} at Escape → ${view.scrollY} (recorded; the place is C22's judge)`);
}

scenario("C22 suggesting: while an editor reading the draft writes a suggestion on its selection, N−1 editors type and autosave in staggered rounds; its frame never reloads while the form is open, the form keeps every key, its quote and the focus, the frame keeps the selection, and once the form closes the frame catches up with every token", {
  tiers: BOTH,
  n: N_ALL,
  timeoutMs: CASE_MS,
  ...LIVE,
}, (ctx) => c22SuggestWork(ctx, { held: false }));

scenario("C22 suggesting held: the same with each of the reader's frame loads held 2.5 s, so the reload owed when the form closes is still loading when the next peer save lands; no reload while the form is open, the form and the selection kept, and the frame catches up", {
  tiers: BOTH,
  n: N_ALL,
  timeoutMs: CASE_MS,
  ...LIVE,
}, (ctx) => c22SuggestWork(ctx, { held: true }));

// --- C22 selection: a bare selection --------------------------------------------------------------

scenario("C22 selection: N−1 editors type and autosave in staggered rounds while an editor reading the draft holds a selection (the selection toolbar showing) and does nothing else; the typists settle (I1, I2) and the reader's frame catches up with every token", {
  tiers: BOTH,
  n: N_ALL,
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const obs = record(ctx, "C22 selection");
  const w = await selectionWorld(ctx, { title: `C22 selection N=${ctx.n}`, form: false });
  const { docId, typists, reader, log } = w;
  obs.stage = "world";
  const loads = reader.watchFrameLoads(docId);
  const t0 = Date.now();
  try {
    ctx.step(`the storm: ${typists.length} typist(s) × ${ROUNDS} round(s), a save each round, staggered; the reader holds its selection`);
    await storm(typists, log);
    await afterStorm(ctx, w, { who: "C22 selection catch-up" });
  } finally {
    await loads.stop();
  }
  const rows = draftLoads(loads);
  const reloads = rows.filter((r) => r.t >= t0 && r.committed);
  const now = await selectionState(reader);
  obs.storm = { loads: rows.length, committed: reloads.length };
  ctx.ev.json("loads", rows);
  measure(ctx, "c22-selection", { kind: "storm", loads: rows.length, committed: reloads.length, selection: now.text, ranges: now.ranges, toolbar: now.toolbar, kept: now.text === QUOTE && now.toolbar });
  ctx.step(`reader: ${reloads.length} committed reload(s) of its frame while it held its selection; now selected ${JSON.stringify(now.text)} (${now.ranges} range(s)), selection toolbar ${now.toolbar ? "showing" : "gone"}`);
  if (reloads.length < 1) inconclusive(ctx, obs, `the storm never reloaded the reader's frame while it held its selection (${rows.length} load(s), none committed after the storm began)`);
  obs.selection = { want: QUOTE, ...now, reloads: reloads.length };
  obs.stage = "measured";
});

scenario("C22 selection kept: through the storm the reader's frame keeps its selection of the passage, and the selection toolbar (Comment, Suggest edit) still shows", { tiers: BOTH, n: N_ALL, timeoutMs: JUDGE_MS, defect: "S28" }, async (ctx) => {
  const s = observation(ctx, "C22 selection", "selection");
  const lost = [];
  if (s.text !== s.want) lost.push(`the frame's selection is ${JSON.stringify(s.text)} (${s.ranges} range(s)), want ${JSON.stringify(s.want)}`);
  if (!s.toolbar) lost.push("the selection toolbar is gone");
  assert.deepEqual(lost, [], `S28: a peer's save reloaded the reader's frame and threw its selection away (${s.reloads} reload(s); one is enough: frameMode.ts:60-67 remounts the frame, nothing restores a selection): ${lost.join("; ")}`);
});

scenario("C22 selection-serial positive control: the same typists save one at a time, each once the reader's previous reload shows the last token; the reader selects the passage after the last one and holds it through a quiet spell: the selection and the selection toolbar are kept", {
  tiers: BOTH,
  n: N_ALL,
  timeoutMs: SERIAL_MS,
  ...LIVE,
}, async (ctx) => {
  record(ctx, "C22 selection-serial");
  const w = await draftReader(ctx, { title: `C22 selection serial N=${ctx.n}` });
  const { docId, typists, reader, log } = w;
  await scrollToReaderTop(ctx, reader);
  const loads = reader.watchFrameLoads(docId);
  try {
    for (const [i, u] of typists.entries()) {
      const token = log.next(u.name, typistParagraph(i));
      const s = await u.typeAndAutosave(idSelector(typistParagraph(i)), token, { delay: KEY_DELAY_MS, timeout: 60_000 });
      precondition(s.status === 200, `${u.name}'s save answered ${s.status}`);
      await eventually(async () => (await (await reader.frame()).evaluate((t) => document.body?.textContent.includes(t) === true, token)) || false, { timeout: 30_000, interval: 200, message: `the reader's frame shows ${u.name}'s token` });
    }
    await afterStorm(ctx, w, { who: "C22 selection-serial" });
  } finally {
    await loads.stop();
  }
  const before = draftLoads(loads).length;
  precondition(before >= typists.length, `the reader's frame reloaded for each save (${before} load(s) for ${typists.length} save(s))`);
  ctx.step(`the reader selects "${QUOTE}" after the last reload; nobody types for ${QUIET_MS} ms`);
  const sel = await reader.selectText(idSelector(READER_MARK), QUOTE);
  precondition(sel.text === QUOTE, `the reader selected "${QUOTE}" (${sel.via}: ${JSON.stringify(sel.text)})`);
  const quiet = reader.watchFrameLoads(docId);
  await sleep(QUIET_MS);
  await quiet.stop();
  const now = await selectionState(reader);
  const during = draftLoads(quiet).length;
  measure(ctx, "c22-selection", { kind: "serial", loads: before, quietLoads: during, selection: now.text, ranges: now.ranges, toolbar: now.toolbar, kept: now.text === QUOTE && now.toolbar });
  ctx.step(`after ${QUIET_MS} ms with ${during} reload(s): selected ${JSON.stringify(now.text)}, selection toolbar ${now.toolbar ? "showing" : "gone"}`);
  precondition(during === 0, `nothing reloaded the reader's frame during the quiet spell (${during} load(s))`);
  assert.deepEqual({ text: now.text, toolbar: now.toolbar }, { text: QUOTE, toolbar: true }, "C22 selection-serial: with no peer save during it, the reader's selection and the selection toolbar are kept");
});

// --- C23: an unlisted link holder among co-editors -------------------------------------------------

/**
 * C23's world: an owner and N−2 editors (joinShared, reading), the document
 * made unlisted with open editing, then the members enter edit (the owner
 * first, alone, and seeds) until "Shared". Resolves {docId, owner, members,
 * linkToken}.
 */
async function unlistedWorld(ctx, obs, { title }) {
  const n = ctx.n;
  const { docId, owner, users: members } = await joinShared(ctx, { n: n - 1, title, enter: false });
  ctx.step(`the owner makes ${docId} unlisted with open editing`);
  const v = await setVisibility(ctx.target, { owner, doc: docId, visibility: "unlisted", publicEdit: true, timeoutMs: 120_000 });
  precondition(v.visibility === "unlisted" && v.publicEdit === true && typeof v.linkToken === "string" && v.linkToken.length >= 22, `POST /visibility unlisted with open editing: ${v.status}`);
  const edit = (await rtdbGetPatient(ctx.target, `editAccess/${docId}`)) ?? {};
  precondition(edit["*"] !== true, `an unlisted open-editing document never carries editAccess/* (SPEC §16): ${JSON.stringify(Object.keys(edit))}`);
  ctx.step(`${members[0].name} enters edit alone and seeds; the other member(s) follow until "Shared"`);
  await enterShared(ctx, obs, members[0]);
  await waitSeed(ctx, obs, docId, members[0].name);
  for (let i = 1; i < members.length; i += 5) await Promise.all(members.slice(i, i + 5).map((u) => enterShared(ctx, obs, u)));
  return { docId, owner, members, linkToken: v.linkToken };
}

/** `.share-state` as the toolbar shows it: {state, text}, or null when there is none. */
async function shareBadge(u) {
  return u.page.evaluate(() => {
    const el = document.querySelector(".share-state");
    return el ? { state: el.getAttribute("data-state"), text: el.textContent.trim() } : null;
  });
}

/** Does a POST /draft response entry carry `text` in the html it saved? */
const carries = (r, text) => r.method === "POST" && r.path === "/draft" && String(r.postJson?.html ?? "").includes(text);

/** The draft as the owner reads it: {status, holds} (holds: null when it could not be read). */
async function draftHolds(owner, docId, text) {
  const draft = await owner.http.get(`/draft/${encodeURIComponent(docId)}/index.html`, { timeoutMs: 60_000 }).catch(() => null);
  return { status: draft?.status ?? null, holds: draft?.status === 200 ? draft.text.includes(text) : null };
}

/**
 * The joiner (a link holder, or in the serial controls a member) in the
 * editor among Shared members, part one: its share state, its own token's
 * way to the others (live, timed from its last keystroke), and its way out
 * through POST /draft: the first save of its since Edit, the first that
 * CARRIES its token, and whether the draft (read as the owner) then holds
 * the token, before any member types.
 */
async function joinerSaves(ctx, { docId, owner, members, joiner, log }) {
  const deadline = settleDeadlineMs(ctx.n);
  const draftMark = joiner.responseMark();
  const entered = await joiner.enterEdit({ waitShared: false, timeout: 90_000 });
  const badge = await shareBadge(joiner);
  ctx.step(`${joiner.name} pressed Edit: share-state ${entered.share}; badge ${JSON.stringify(badge)}`);
  const own = log.next(joiner.name, LINK_PARAGRAPH);
  // The joiner's token: does it reach every member live (merged), and does it go out through POST /draft?
  const { arrivals: ownArrivals } = await probeArrivals([joiner, ...members], { from: joiner, id: LINK_PARAGRAPH, text: own, timeoutMs: deadline });
  const save = await joiner.waitForResponse({ method: "POST", path: "/draft" }, { since: draftMark, timeout: 60_000 }).catch(() => null);
  const carried = await joiner.waitForResponse((r) => carries(r, own), { since: draftMark, timeout: 30_000 }).catch(() => null);
  const drafted = await draftHolds(owner, docId, own);
  ctx.step(`${joiner.name}'s token ${own}: its first POST /draft ${save?.status ?? "never sent"}; a save carrying the token ${carried ? `answered ${carried.status}` : "never sent"}; the draft (GET as the owner, ${drafted.status ?? "failed"}) ${drafted.holds === null ? "unread" : drafted.holds ? "holds it" : "does NOT hold it"}`);
  return {
    name: joiner.name,
    share: entered.share,
    badge,
    shownShared: entered.share === "shared" || badge?.state === "shared",
    own,
    ownArrivals,
    save: save ? { status: save.status, at: save.at } : null,
    carried: carried ? { status: carried.status, at: carried.at } : null,
    draftHeldOwn: drafted.holds,
    draftStatus: drafted.status,
    deadline,
  };
}

/** Part two: a member's probe, and whether it reaches the joiner (timed from the member's last keystroke). */
async function memberProbe(ctx, j, { members, joiner, log }) {
  const probe = log.next(members[0].name, PROBE_PARAGRAPH);
  const { arrivals } = await probeArrivals([members[0], joiner, ...members.slice(1)], { from: members[0], id: PROBE_PARAGRAPH, text: probe, timeoutMs: j.deadline });
  j.probe = probe;
  j.toJoiner = arrivals.find((a) => a.name === joiner.name) ?? null;
  j.finalState = await joiner.shareState();
  return j;
}

/** The first member POST /draft answered 200 since the marks (taken after the joiner's save): {who, status, at, msAfterJoiner, holdsOwn}, or null. */
function firstMemberSave(members, marks, j) {
  const rows = members.flatMap((m, i) => m.findResponses({ method: "POST", path: "/draft", status: 200 }, { since: marks[i] }).map((r) => ({ who: m.name, status: r.status, at: r.at, holdsOwn: carries(r, j.own) })));
  rows.sort((a, b) => a.at - b.at);
  const first = rows[0] ?? null;
  return first ? { ...first, msAfterJoiner: j.carried ? first.at - j.carried.at : null } : null;
}

/** Shows the conflict banner, "<peer> saved a change while you were editing" (ViewerBanners.tsx, useLiveSync.ts conflict). */
const conflictBanners = (u) => u.page.evaluate(() => [...document.querySelectorAll(".viewer-banners .banner")].filter((b) => /saved a change while you were editing/.test(b.textContent ?? "")).length);

/**
 * Once the members have settled, what last-writer-wins between the joiner's
 * POST /draft and the members' autosaves did: is the joiner's own token
 * still in the draft (GET /draft, as the owner), and was the joiner, or a
 * member, shown the conflict banner. Resolves {kept (null: the draft was not
 * read), toldJoiner, toldMembers, draftStatus}; a row in
 * <invocation>/c23-lww.jsonl with `extra` beside it.
 */
async function lastWriter(ctx, { owner, docId, joiner, members, own, kind, extra = {} }) {
  const d = await draftHolds(owner, docId, own);
  const kept = d.holds;
  const toldJoiner = (await conflictBanners(joiner)) > 0;
  const toldMembers = (await Promise.all(members.map(conflictBanners))).filter((k) => k > 0).length;
  measure(ctx, "c23-lww", { kind, tokenInDraft: kept, draftStatus: d.status, joinerShownConflict: toldJoiner, membersShownConflict: toldMembers, members: members.length, ...extra });
  ctx.step(`${joiner.name}'s token is ${kept === null ? `unread (GET /draft ${d.status ?? "failed"})` : kept ? "in" : "NOT in"} the draft the members settled on; the conflict banner shows for ${joiner.name}: ${toldJoiner}, for ${toldMembers} of ${members.length} member(s)`);
  return { kept, toldJoiner, toldMembers, draftStatus: d.status };
}

/** The last-writer judgement: [] when the joiner's edit is in the draft, or the joiner was told it was replaced. */
function silentLoss(l, who) {
  return l.kept === true || l.toldJoiner ? [] : [`${who}'s edit is gone from the draft the members' autosaves left, and ${who} was never shown that a peer's save replaced it (no conflict banner)`];
}

/**
 * C23's judgement: [] when the joiner is not shown Shared, or is merged
 * both ways within I13's 2 s (checkI13, PROBE_ARRIVAL_MS): a member's probe
 * reaches it, and its own token reaches every member, each timed from the
 * typist's last keystroke (probeArrivals, as A11.8 times it). A later
 * arrival fails as one that never came.
 */
function mergedProblems(j, members) {
  const out = [];
  if (j.shownShared || j.finalState === "shared") {
    const shown = `shown "Shared" (share ${j.share}, badge ${JSON.stringify(j.badge?.state ?? null)}, now ${j.finalState})`;
    const legIn = checkI13({ arrivals: [{ name: j.name, ms: j.toJoiner?.ms ?? null, shared: true }], limitMs: PROBE_ARRIVAL_MS });
    for (const f of legIn.failures) out.push(`${shown} but not merged (I13, a member's probe → ${j.name}, within ${PROBE_ARRIVAL_MS} ms; waited ${j.deadline} ms): ${f}`);
    const legOut = checkI13({ arrivals: j.ownArrivals.map((a) => ({ name: a.name, ms: a.ms, shared: true })), limitMs: PROBE_ARRIVAL_MS });
    for (const f of legOut.failures) out.push(`${shown} but not merged (I13, ${j.name}'s token → the ${members.length} member(s), within ${PROBE_ARRIVAL_MS} ms; waited ${j.deadline} ms): ${f}`);
  }
  if (j.finalState === "joining") out.push("its editor is stuck joining");
  return out;
}

/** A c23-joiner.jsonl row. */
const joinerRow = (j, members, kind) => ({
  kind,
  shownShared: j.shownShared,
  finalState: j.finalState,
  probeMs: j.toJoiner?.ms ?? null,
  ownReached: j.ownArrivals.filter((a) => a.ms != null).length,
  ownMaxMs: Math.max(-1, ...j.ownArrivals.map((a) => a.ms ?? -1)),
  members: members.length,
  draftStatus: j.save?.status ?? null,
  carriedStatus: j.carried?.status ?? null,
  draftHeldOwn: j.draftHeldOwn,
});

scenario("C23 unlisted link holder among co-editors: N−1 members edit live and an unlisted open-editing link holder enters the editor; it is not shown Shared, or it is genuinely merged both ways; its edit goes out through POST /draft; the members settle (I1)", {
  tiers: BOTH,
  n: N_ALL,
  needs: RTDB_RULES,
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const obs = record(ctx, "C23");
  const { docId, owner, members, linkToken } = await unlistedWorld(ctx, obs, { title: `C23 N=${ctx.n}` });
  const { user: holder } = await addMember(ctx, { docId, name: `p${ctx.n}`, role: null, k: linkToken });
  precondition((await holder.page.locator('.viewer-toolbar [aria-label="Edit"]').count()) === 1, "open editing gives the link holder an Edit button");
  const log = tokenLog(ctx.target.runId);
  const j = await joinerSaves(ctx, { docId, owner, members, joiner: holder, log });
  ctx.ev.json("joiner-saves", j);
  if (!j.shownShared) {
    // SPEC §16: a link holder not merged live edits through /draft: a save of its, carrying its edit, is answered 200.
    assert.equal(j.carried?.status, 200, `C23: a link holder who is not merged live edits through POST /draft (SPEC §16 spec.md:1570-1571): a POST /draft carrying its token ${j.own} answers 200 (its first save: ${j.save?.status ?? "never sent"}; one carrying the token: ${j.carried?.status ?? "never sent"})`);
    if (j.draftHeldOwn !== true) inconclusive(ctx, obs, `the told judge's precondition did not hold: the link holder's save carrying ${j.own} answered ${j.carried.status}, but the draft (GET /draft as the owner: ${j.draftStatus ?? "failed"}) does not hold it before any member typed, so there is nothing of its for the members' saves to replace`);
  }
  const marks = members.map((m) => m.responseMark());
  await memberProbe(ctx, j, { members, joiner: holder, log });
  ctx.ev.json("joiner", j);
  measure(ctx, "c23-joiner", joinerRow(j, members, "link-holder"));
  ctx.step(`link holder: shown Shared ${j.shownShared} (now ${j.finalState}); a member's probe ${j.toJoiner?.ms == null ? "never reached it" : `reached it in ${j.toJoiner.ms} ms`}; its token reached ${j.ownArrivals.filter((a) => a.ms != null).length} of ${members.length} member(s) live (I13 bound ${PROBE_ARRIVAL_MS} ms)`);
  const settled = await settleLive(members, { docId, n: ctx.n });
  ctx.step(`the members settled in ${settled.ms} ms`);
  const memberSave = firstMemberSave(members, marks, j);
  ctx.step(`the first member POST /draft 200 after the link holder's save: ${memberSave ? `${memberSave.who}'s, ${memberSave.msAfterJoiner} ms after it, ${memberSave.holdsOwn ? "holding" : "NOT holding"} the link holder's token` : "none"}`);
  obs.lww = {
    ...(await lastWriter(ctx, { owner, docId, joiner: holder, members, own: j.own, kind: "link-holder", extra: { saved: j.carried?.status ?? null, draftHeldOwn: j.draftHeldOwn, memberSave } })),
    saved: j.carried?.status ?? null,
    draftHeldOwn: j.draftHeldOwn,
    memberSave,
  };
  obs.stage = "measured";
  const unmerged = mergedProblems(j, members);
  assert.deepEqual(unmerged, [], `S24: the link holder is shown as Shared but is not merged live with the members: ${unmerged.join("; ")}`);
});

scenario("C23 told: once the members' autosaves have replaced the draft the unlisted link holder saved, its edit is still in the draft, or the link holder was told a peer's save replaced it (last-writer-wins is never silent for it)", { tiers: BOTH, n: N_ALL, needs: RTDB_RULES, timeoutMs: JUDGE_MS, defect: "X-c18-scale-ui-1" }, async (ctx) => {
  const l = observation(ctx, "C23", "lww");
  if (l.kept === null) ctx.inconclusive(`the C23 work case could not read the draft (GET /draft ${l.draftStatus ?? "failed"}), so there is nothing to judge`);
  if (l.saved !== 200 || l.draftHeldOwn !== true) ctx.inconclusive(`the link holder's save carrying its token answered ${l.saved ?? "nothing"} and the draft ${l.draftHeldOwn ? "held" : "did not hold"} it before the members typed, so no save of its was there to replace`);
  if (!l.memberSave) ctx.inconclusive("no member's POST /draft was answered after the link holder's save, so nothing replaced it");
  assert.deepEqual(silentLoss(l, "the link holder"), [], `X-c18-scale-ui-1: the unlisted link holder's edit was lost to ${l.memberSave.who}'s autosave (${l.memberSave.msAfterJoiner} ms after its own), silently`);
});

scenario("C23-serial positive control: a member takes the link holder's place, entering after the others; it is Shared, a member's probe reaches it, its token reaches every member, and its edit is in the draft the members settle on", {
  tiers: BOTH,
  n: N_ALL,
  needs: RTDB_RULES,
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const obs = record(ctx, "C23-serial");
  const { docId, owner, members } = await unlistedWorld(ctx, obs, { title: `C23 serial N=${ctx.n}` });
  ctx.step(`p${ctx.n}, an editor, signs in, opens the document and enters edit last`);
  const { user: late } = await addMember(ctx, { owner, docId, name: `p${ctx.n}`, role: "editor" });
  const log = tokenLog(ctx.target.runId);
  const j = await joinerSaves(ctx, { docId, owner, members, joiner: late, log });
  const marks = members.map((m) => m.responseMark());
  await memberProbe(ctx, j, { members, joiner: late, log });
  ctx.ev.json("joiner", j);
  measure(ctx, "c23-joiner", joinerRow(j, members, "member"));
  ctx.step(`late member: Shared ${j.shownShared}; probe ${j.toJoiner?.ms ?? "never"} ms; its token reached ${j.ownArrivals.filter((a) => a.ms != null).length} of ${members.length}, the slowest in ${Math.max(-1, ...j.ownArrivals.map((a) => a.ms ?? -1))} ms (I13 bound ${PROBE_ARRIVAL_MS} ms)`);
  if (!j.shownShared) inconclusive(ctx, obs, `the sync precondition did not hold: the late member never showed "Shared" (share ${j.share}, now ${j.finalState})`);
  const unmerged = mergedProblems(j, members);
  assert.deepEqual(unmerged, [], `C23-serial: a member shown Shared is merged both ways within I13's ${PROBE_ARRIVAL_MS} ms: ${unmerged.join("; ")}`);
  await settleLive([...members, late], { docId, n: ctx.n });
  const memberSave = firstMemberSave(members, marks, j);
  const l = await lastWriter(ctx, { owner, docId, joiner: late, members, own: j.own, kind: "member", extra: { saved: j.carried?.status ?? null, draftHeldOwn: j.draftHeldOwn, memberSave } });
  precondition(l.kept !== null, `the draft could be read (GET /draft ${l.draftStatus ?? "failed"})`);
  assert.deepEqual(silentLoss(l, "the late member"), [], "C23-serial: a merged member's edit is in the draft the members settled on");
});

scenario("C23 told-serial positive control: on the same unlisted open-editing document the members type, autosave and settle, and stop; then the link holder enters the editor, types and autosaves LAST: its edit is in the draft, so the told judge's oracle passes on a link holder's own POST /draft path", {
  tiers: BOTH,
  n: N_ALL,
  needs: RTDB_RULES,
  timeoutMs: CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const obs = record(ctx, "C23 told-serial");
  const { docId, owner, members, linkToken } = await unlistedWorld(ctx, obs, { title: `C23 told serial N=${ctx.n}` });
  const { user: holder } = await addMember(ctx, { docId, name: `p${ctx.n}`, role: null, k: linkToken });
  precondition((await holder.page.locator('.viewer-toolbar [aria-label="Edit"]').count()) === 1, "open editing gives the link holder an Edit button");
  const log = tokenLog(ctx.target.runId);
  ctx.step(`the ${members.length} member(s) type a token each and autosave, one after another`);
  for (const [i, m] of members.entries()) {
    const s = await m.typeAndAutosave(idSelector(typistParagraph(i)), log.next(m.name, typistParagraph(i)), { delay: KEY_DELAY_MS, timeout: 60_000 });
    precondition(s.status === 200, `${m.name}'s save answered ${s.status}`);
  }
  const settled = await settleLive(members, { docId, n: ctx.n });
  ctx.step(`the members settled in ${settled.ms} ms and stop`);
  const memberTokens = log.typed.map((e) => e.token);
  const marks = members.map((m) => m.responseMark());
  const mark = holder.responseMark();
  const entered = await holder.enterEdit({ waitShared: false, timeout: 90_000 });
  const own = log.next(holder.name, LINK_PARAGRAPH);
  ctx.step(`${holder.name} pressed Edit (share-state ${entered.share}) and types ${own} last`);
  const s = await holder.typeAndAutosave(idSelector(LINK_PARAGRAPH), own, { delay: KEY_DELAY_MS, timeout: 60_000 });
  precondition(s.status === 200, `the link holder's save answered ${s.status}`);
  const carried = holder.findResponses((r) => carries(r, own), { since: mark });
  precondition(carried.length > 0 && carried.every((r) => r.status === 200), `a POST /draft of the link holder's carries its token and answered 200 (${carried.map((r) => r.status).join(", ") || "none"})`);
  ctx.step("nobody types after it; 3 s for any save it might set off");
  await sleep(3_000);
  const after = members.flatMap((m, i) => m.findResponses({ method: "POST", path: "/draft" }, { since: marks[i] }));
  const d = await owner.http.get(`/draft/${encodeURIComponent(docId)}/index.html`, { timeoutMs: 60_000 }).catch(() => null);
  const membersKept = d?.status === 200 ? memberTokens.filter((t) => d.text.includes(t)).length : null;
  const l = await lastWriter(ctx, { owner, docId, joiner: holder, members, own, kind: "link-holder-last", extra: { memberSavesAfter: after.length, membersKept, memberTokens: memberTokens.length } });
  obs.stage = "measured";
  ctx.step(`after the link holder's save: ${after.length} member POST /draft; the draft holds ${membersKept ?? "?"} of the members' ${memberTokens.length} token(s) (recorded)`);
  precondition(l.kept !== null, `the draft could be read (GET /draft ${l.draftStatus ?? "failed"})`);
  precondition(after.length === 0, `no member saved after the link holder (${after.length} POST /draft), so its save was the last`);
  assert.deepEqual(silentLoss(l, "the link holder"), [], "C23 told-serial: the link holder saved last, so its edit is in the draft (the told oracle passes on its own POST /draft path)");
  assert.equal(l.kept, true, "C23 told-serial: the link holder's token is in the draft after its save, made last");
});
