// SPDX-License-Identifier: Apache-2.0
// Working together on a deck that stacks its slides: following, others' selections, painted highlights, who is on which slide, and a clean presentation (SPEC §6, §6d, §16, ADR 0043).

/**
 * A synthetic deck with the shape of a real vendor deck that showed every one
 * of these faults, none of its words: every slide `position:absolute; inset:0`
 * in a 100vh deck, hidden with `visibility`, moved by its own script toggling
 * `is-active` (keys, a click), and flex and grid containers holding runs of
 * text. Trusted, it stacks; untrusted, its `html.js` rules never apply and the
 * slides flow.
 *
 *   A29.1  (control) the reader follows the leader to their slide, and on.
 *   A29.2  a tab that shares no slide: the follower is told, and stays put.
 *          Before 0.42.0 nothing happened at all.
 *   A29.3  a leader who shares a place and no slide: the follower goes to the
 *          slide holding it. Before, a stacked deck could not be scrolled there.
 *   A29.4  a leader's place on a stacked deck names the slide on screen; it
 *          named the last slide, and was never sent again on a slide change.
 *   A29.5  a reader whose deck is not paged goes to the leader's slide (a
 *          guard: by place it already did, on a deck that flows).
 *   A29.6  a peer's selection shows only on its slide; it showed on every one.
 *   A29.7  a comment on part of a run of text in a flex container moves no
 *          element; a <mark> there made three items of one (ADR 0043).
 *   A29.8  the slide list shows each person on their slide.
 *   A29.9  presenting draws nothing over the slides; the eye hides comments
 *          and others' activity; a thread opened while hidden blinks.
 *
 * Run on a stack built from 0.41.2's tree, A29.2-4 and A29.6-9 fail, and A29.1
 * and A29.5 pass.
 */

import assert from "node:assert/strict";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { publishZip } from "../../lib/seed.mjs";
import { share } from "../../lib/grant.mjs";
import { rtdbGet, trustAsOperator } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { paintedCount, paintedHighlights } from "../../lib/frame.mjs";
import { nameOfAddress } from "../../lib/names.mjs";

const target = currentTarget();
const CASE_MS = 300_000;
export const E2E_FILE_TIMEOUT_MS = 12 * CASE_MS;
const ON_STACK = Object.freeze({ inconclusiveOnRequestStall: true, inconclusiveOnHttpStall: true });
const UI_MS = 20_000;

const SLIDES = 9;
const slideHtml = (n) => `<section class="slide" id="slide-${n}" data-title="Slide ${n}"><div class="stage">
  <h2>Slide ${n} heading</h2>
  <p class="rev-s" id="rev-${n}">Who we are on ${n} <b>today</b> and what comes after</p>
  <div class="tile" id="tile-${n}">Tile words for slide ${n} sit in a grid</div>
  <p id="p-${n}">Plain words on slide ${n} for selecting and commenting.</p>
</div></section>`;

const DECK = {
  "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Collab deck</title>
<script>document.documentElement.className+=' js';</script><link rel="stylesheet" href="style.css"></head>
<body><main class="deck">${Array.from({ length: SLIDES }, (_, i) => slideHtml(i + 1)).join("\n")}</main><script src="app.js"></script></body></html>`,
  "style.css": `*{box-sizing:border-box}html,body{margin:0;font:20px/1.5 sans-serif}
.slide{display:grid;place-items:center;margin:0 auto 1rem}
.stage{width:60rem;height:30rem;display:grid;align-content:center;gap:1rem;padding:2rem;background:#fff;color:#111}
.rev-s{display:flex;justify-content:space-between;gap:1rem;margin:0}
.tile{display:grid;grid-template-columns:1fr;gap:1rem}
html.js .deck{position:relative;width:100vw;height:100vh;overflow:hidden}
html.js .slide{position:absolute;inset:0;visibility:hidden;margin:0}
html.js .slide.is-active{visibility:visible}`,
  "app.js": `(function(){
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide')), i = 0;
  function show(n){ n = Math.max(0, Math.min(slides.length - 1, n)); slides.forEach(function(s){ s.classList.remove('is-active'); }); slides[n].classList.add('is-active'); i = n; }
  document.addEventListener('keydown', function(e){
    if (e.key === 'ArrowRight' || e.key === 'PageDown'){ show(i + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp'){ show(i - 1); e.preventDefault(); }
  });
  document.addEventListener('click', function(e){ if (e.target.closest && e.target.closest('a,button')) return; show(i + 1); });
  show(0);
})();`,
};

/** Two members of one deck, signed in through the UI: the owner leads, the other reads. */
async function deckWorld(ctx, { trusted = true, devices = {} } = {}) {
  const accounts = await cast(target, ["owner", "reader"], { notifications: false });
  const owner = await openSession(target, accounts[0]);
  const up = await publishZip(owner.http, DECK, { title: `A29 ${runTag(target.runId)}-${rand4()}`, name: "a29-collab" });
  precondition(up.status === 200, `published the deck: ${up.status} ${JSON.stringify(up.json)?.slice(0, 200)}`);
  if (trusted) await trustAsOperator(target, up.docId);
  const g = await share(target, { owner, doc: up.docId, account: accounts[1], role: "editor" });
  precondition(g.status === 200 && g.mirror?.ok, `shared with the reader: ${JSON.stringify(g.mirror)}`);
  const sign = async (name, account) => {
    const u = await ctx.users.user({ name, device: devices[name] ?? null });
    const s = await u.signInUi(account.email, account.password);
    precondition(s.status === "ok", `${name} signed in`);
    return u;
  };
  const [leader, reader] = await Promise.all([sign("leader", accounts[0]), sign("reader", accounts[1])]);
  await Promise.all([leader.open(up.docId), reader.open(up.docId)]);
  ctx.step(`deck ${up.docId} (${trusted ? "trusted" : "untrusted"}); leader ${accounts[0].email}, reader ${accounts[1].email}`);
  return { docId: up.docId, leader, reader, leaderAcct: accounts[0], readerAcct: accounts[1] };
}

/** The id of the slide a trusted deck shows in u's frame. */
async function shown(u) {
  return (await u.frame()).evaluate(() => document.querySelector(".slide.is-active")?.id ?? null);
}

/** Move u's deck by the viewer's own keys, from the parent page. */
async function pressKeys(u, key, times) {
  for (let i = 0; i < times; i += 1) {
    await u.page.keyboard.press(key);
    await u.page.waitForTimeout(80);
  }
}

/** The chip of the person named by `email` in u's presence bar. */
function chip(u, email) {
  return u.page.locator(".presence-bar .presence-chip", { hasText: nameOfAddress(email) });
}

/** u's own presence records, from the database. */
async function recordsOf(docId, uid) {
  const peers = (await rtdbGet(target, `status/${docId}/peers`)) ?? {};
  return Object.values(peers).filter((p) => p?.uid === uid);
}

/** Write a presence record as an older or another tab would, past the rules: the emulator's admin credential. */
async function writePeer(docId, session, record) {
  const base = new URL(target.databaseURL);
  const url = new URL(`${base.origin}/status/${encodeURIComponent(docId)}/peers/${encodeURIComponent(session)}.json`);
  for (const [k, v] of base.searchParams) url.searchParams.set(k, v);
  const r = await fetch(url, { method: "PUT", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: JSON.stringify(record) });
  precondition(r.ok, `wrote the presence record ${session}: ${r.status}`);
}

const FAKE = (n, extra) => ({ uid: `fake-${n}`, email: `fake-${n}@example.com`, name: `Fake ${n}`, mode: "view", lastChanged: Date.now(), liveEpoch: "initial", ...extra });

// --- Following --------------------------------------------------------------

scenario("A29.1 on a trusted stacked deck the reader follows the leader to their slide, and on", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, leader, reader, leaderAcct } = await deckWorld(ctx);
  await pressKeys(leader, "ArrowRight", 6);
  await eventually(async () => (await shown(leader)) === "slide-7", { timeout: UI_MS, message: "the leader is on slide 7" });
  await eventually(async () => (await recordsOf(docId, leaderAcct.uid)).some((r) => r.slide === 6), { timeout: UI_MS, message: "the leader's record carries slide 7" });
  precondition((await shown(reader)) === "slide-1", "the reader starts on slide 1");
  await chip(reader, leaderAcct.email).click();
  await eventually(async () => (await shown(reader)) === "slide-7", { timeout: UI_MS, message: "the reader followed to slide 7" });
  await pressKeys(leader, "ArrowLeft", 3);
  await eventually(async () => (await shown(reader)) === "slide-4", { timeout: UI_MS, message: "the reader followed back to slide 4" });
});

scenario("A29.2 following a tab that shares no slide says so, and leaves the deck where it is", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, reader } = await deckWorld(ctx);
  // A tab on an app from before slides were shared: a fraction, always 0 on a stacked deck.
  await writePeer(docId, "old-tab", FAKE(1, { viewport: 0 }));
  const c = reader.page.locator(".presence-bar .presence-chip", { hasText: "Fake" });
  await c.waitFor({ state: "visible", timeout: UI_MS });
  await c.click();
  await reader.page.getByText(/tab isn't sharing which slide they're on\. Ask them to reload the page\./).waitFor({ state: "visible", timeout: UI_MS });
  assert.equal(await shown(reader), "slide-1", "the deck stays where it was");
});

scenario("A29.3 following a leader who shares a place and no slide takes the reader to the slide holding it", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, reader } = await deckWorld(ctx);
  // A leader whose viewer did not page the deck: a place in the text, no slide.
  await writePeer(docId, "flowing-tab", FAKE(2, { viewport: 0.6, place: { a: "p-6", b: "slide-7", at: 0.2 } }));
  const c = reader.page.locator(".presence-bar .presence-chip", { hasText: "Fake" });
  await c.waitFor({ state: "visible", timeout: UI_MS });
  await c.click();
  await eventually(async () => (await shown(reader)) === "slide-6", { timeout: UI_MS, message: "the reader is on the slide holding #p-6" });
});

scenario("A29.4 a leader's place on a stacked deck names the slide on screen", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, leader, leaderAcct } = await deckWorld(ctx);
  await pressKeys(leader, "ArrowRight", 2);
  await eventually(async () => (await shown(leader)) === "slide-3", { timeout: UI_MS, message: "the leader is on slide 3" });
  // A scroll is what sends the place; a stacked deck does not scroll, so the wheel goes to the frame.
  await leader.page.mouse.move(400, 400);
  await leader.page.mouse.wheel(0, 40);
  // The place goes again with the slide change, through a throttle of half a second.
  const frame = await leader.frame();
  const holderOf = (p) => frame.evaluate((p) => {
    const at = (id) => (id ? document.getElementById(id)?.closest(".slide")?.id ?? null : null);
    return { a: at(p.a), b: at(p.b) };
  }, p);
  const seen = [];
  const found = await eventually(async () => {
    const p = (await recordsOf(docId, leaderAcct.uid)).find((r) => r.place)?.place;
    if (!p) return false;
    const holder = await holderOf(p);
    seen.push({ p, holder });
    return holder.a === "slide-3" || (holder.a === null && holder.b === "slide-3") ? { p, holder } : false;
  }, { timeout: UI_MS, message: `the leader's place names slide 3: ${JSON.stringify(seen.slice(-2))}` });
  ctx.step(`the leader's place: ${JSON.stringify(found)}`);
});

scenario("A29.5 a reader whose deck is not paged goes to the leader's slide", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  // Untrusted: the slides flow. The leader's tall window pages them; the reader's short one does not.
  const { docId, leader, reader, leaderAcct } = await deckWorld(ctx, { trusted: false, devices: { leader: { width: 1400, height: 1000 }, reader: { width: 1400, height: 560 } } });
  const view = async (u) => (await u.frame()).evaluate(() => innerHeight);
  ctx.step(`frames: leader ${await view(leader)} px, reader ${await view(reader)} px tall`);
  await leader.page.locator(".slide-rail .slide-thumb").nth(4).click();
  await eventually(async () => (await recordsOf(docId, leaderAcct.uid)).some((r) => r.slide === 4), { timeout: UI_MS, message: "the leader's record carries slide 5" });
  precondition((await reader.page.locator(".slide-rail").count()) === 0, "the reader's deck is not paged: no slide list");
  await chip(reader, leaderAcct.email).click();
  await eventually(async () => {
    const top = await (await reader.frame()).evaluate(() => document.getElementById("slide-5").getBoundingClientRect().top);
    return Math.abs(top) < 24;
  }, { timeout: UI_MS, message: "slide 5 is at the top of the reader's frame" });
});

// --- Others' selections -------------------------------------------------------

scenario("A29.6 a peer's selection shows only on its slide, and follows the deck from slide to slide", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, leader, reader, leaderAcct } = await deckWorld(ctx);
  await pressKeys(leader, "ArrowRight", 2);
  await eventually(async () => (await shown(leader)) === "slide-3", { timeout: UI_MS, message: "the leader is on slide 3" });
  await leader.selectText("#p-3", "words on slide 3");
  await eventually(async () => (await recordsOf(docId, leaderAcct.uid)).some((r) => r.focus?.exact?.includes("words on slide 3")), { timeout: UI_MS, message: "the leader's selection reached the database" });
  await pressKeys(leader, "ArrowRight", 2);
  await eventually(async () => (await shown(leader)) === "slide-5", { timeout: UI_MS, message: "the leader moved on to slide 5" });
  await pressKeys(reader, "ArrowRight", 4);
  await eventually(async () => (await shown(reader)) === "slide-5", { timeout: UI_MS, message: "the reader is on slide 5" });
  const carets = async () => (await reader.frame()).evaluate(() => document.querySelectorAll("#bshd-peers .bshd-peer-caret").length);
  await reader.page.waitForTimeout(1_500);
  assert.equal(await carets(), 0, "no caret on slide 5 for a selection on slide 3");
  await pressKeys(reader, "ArrowLeft", 2);
  await eventually(async () => (await shown(reader)) === "slide-3", { timeout: UI_MS, message: "the reader is on slide 3" });
  await eventually(async () => (await carets()) === 1, { timeout: UI_MS, message: "the leader's caret shows on slide 3" });
});

// --- Painted highlights -------------------------------------------------------

/**
 * Every element's box on the slide shown, relative to the slide's stage, by a
 * path: what a wrapper in its text would move. Relative, because opening the
 * comments panel narrows the frame and moves the whole stage, which is not the
 * layout of the slide changing.
 */
async function boxes(u) {
  return (await u.frame()).evaluate(() => {
    const out = {};
    const stage = document.querySelector(".slide.is-active .stage").getBoundingClientRect();
    const all = document.querySelectorAll(".slide.is-active .stage *");
    all.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      out[`${i}:${el.tagName}${el.id ? "#" + el.id : ""}`] = [Math.round(r.left - stage.left), Math.round(r.top - stage.top), Math.round(r.width), Math.round(r.height)].join(",");
    });
    return out;
  });
}

scenario("A29.7 a comment on a run of text in a flex container changes no element's box, for the commenter and the other reader", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { leader, reader } = await deckWorld(ctx);
  // The panel open first for both, so it is not what moves anything.
  await leader.openComments();
  await reader.openComments();
  await leader.page.waitForTimeout(500);
  const before = { leader: await boxes(leader), reader: await boxes(reader) };
  await leader.selectText("#rev-1", "are on 1");
  await leader.comment(`A29 layout ${rand4()}`);
  for (const [name, u] of [["leader", leader], ["reader", reader]]) {
    // Highlighted either way, painted or wrapped, so the boxes decide, on any build.
    await eventually(async () => {
      const frame = await u.frame();
      return (await paintedCount(frame)) >= 1 || (await frame.evaluate(() => document.querySelectorAll("mark.bshd-hl").length)) >= 1;
    }, { timeout: UI_MS, message: `${name}: the passage is highlighted` });
    await u.page.waitForTimeout(300);
    assert.deepEqual(await boxes(u), before[name], `${name}: every element of the slide is where it was`);
    assert.equal(await (await u.frame()).evaluate(() => document.querySelectorAll("mark").length), 0, `${name}: no mark in the document`);
  }
});

// --- The rail's people --------------------------------------------------------

scenario("A29.8 the slide list shows the leader on their slide, and moves them with it", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { leader, reader, leaderAcct } = await deckWorld(ctx);
  const name = nameOfAddress(leaderAcct.email);
  const thumbs = reader.page.locator(".slide-rail .slide-thumb");
  await pressKeys(leader, "ArrowRight", 6);
  await eventually(async () => (await thumbs.nth(6).getAttribute("aria-label"))?.endsWith(`, with ${name}`), { timeout: UI_MS, message: "thumb 7 names the leader" });
  assert.equal(await thumbs.nth(6).locator(".slide-thumb-people .presence-dot").count(), 1, "one dot on slide 7");
  assert.equal(await thumbs.nth(0).locator(".slide-thumb-people").count(), 0, "nobody else is on slide 1 (the reader is not shown)");
  await pressKeys(leader, "ArrowLeft", 5);
  await eventually(async () => (await thumbs.nth(1).getAttribute("aria-label"))?.endsWith(`, with ${name}`), { timeout: UI_MS, message: "thumb 2 names the leader" });
  assert.equal(await thumbs.nth(6).locator(".slide-thumb-people").count(), 0, "the dot left slide 7");
});

// --- Presenting and the switch -----------------------------------------------

/** What u's frame draws over the document that is not the document's. */
async function drawnOver(u) {
  const frame = await u.frame();
  return {
    painted: await paintedCount(frame),
    peers: await frame.evaluate(() => document.querySelectorAll("#bshd-peers .bshd-peer-caret").length),
  };
}

scenario("A29.9 presenting draws nothing over the slides; the eye and the menu hide comments and others' activity; a thread opened while hidden blinks and leaves nothing", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { docId, leader, reader, leaderAcct } = await deckWorld(ctx);
  // A comment on slide 1, and the leader's selection on it too.
  await reader.selectText("#p-1", "words on slide 1");
  await reader.comment(`A29 present ${rand4()}`);
  // A second, which posting selects: opening the first later is then a change of thread.
  await reader.selectText("#tile-1", "Tile words");
  await reader.comment(`A29 second ${rand4()}`);
  await leader.selectText("#p-1", "Plain words");
  await eventually(async () => (await recordsOf(docId, leaderAcct.uid)).some((r) => r.focus), { timeout: UI_MS, message: "the leader's selection reached the database" });
  await eventually(async () => { const d = await drawnOver(reader); return d.painted >= 1 && d.peers === 1; }, { timeout: UI_MS, message: "the reader sees the comment and the leader's caret" });

  ctx.step("Present: nothing but the deck");
  await reader.page.getByRole("button", { name: "Present", exact: true }).click();
  await eventually(async () => { const d = await drawnOver(reader); return d.painted === 0 && d.peers === 0; }, { timeout: UI_MS, message: "presenting: no highlight, no caret" });
  await reader.page.locator(".present-exit").click();
  await eventually(async () => { const d = await drawnOver(reader); return d.painted >= 1 && d.peers === 1; }, { timeout: UI_MS, message: "after presenting: both back" });

  ctx.step("the eye after the chips hides both, and shows them again");
  const eye = reader.page.getByRole("button", { name: "Show comments and others' activity" });
  await eye.click();
  await eventually(async () => { const d = await drawnOver(reader); return d.painted === 0 && d.peers === 0; }, { timeout: UI_MS, message: "hidden by the eye" });
  assert.equal(await eye.getAttribute("aria-pressed"), "false");

  ctx.step("a thread opened from the panel while hidden lights, and then nothing is left marked");
  await reader.openComments();
  const seen = [];
  // The blink paints under its own name, beside the hidden threads'.
  const lit = async () => (await paintedHighlights(await reader.frame())).filter((r) => r.name === "bshd-hl-flash").length;
  const sample = setInterval(async () => { try { seen.push(await lit()); } catch { /* the frame may be mid-load */ } }, 60);
  await reader.thread("words on slide 1").first().locator(".thread-quote").click();
  await reader.page.waitForTimeout(1_600);
  clearInterval(sample);
  ctx.step(`painted while blinking: ${seen.join(",")}`);
  assert.ok(seen.some((n) => n >= 1), "the passage was lit");
  assert.equal((await drawnOver(reader)).painted, 0, "nothing is left marked");
  assert.equal(await lit(), 0, "and nothing is lit");

  await eye.click();
  await eventually(async () => { const d = await drawnOver(reader); return d.painted >= 1 && d.peers === 1; }, { timeout: UI_MS, message: "shown by the eye" });

  ctx.step("the ⋮ menu does the same, for a reader alone as well");
  const menu = reader.page.getByRole("button", { name: "More actions" });
  await menu.click();
  await reader.page.getByRole("menuitem", { name: "Hide comments and others' activity" }).click();
  await eventually(async () => { const d = await drawnOver(reader); return d.painted === 0 && d.peers === 0; }, { timeout: UI_MS, message: "hidden from the menu" });
  assert.equal(await eye.getAttribute("aria-pressed"), "false", "the eye says so too");
  await menu.click();
  await reader.page.getByRole("menuitem", { name: "Show comments and others' activity" }).click();
  await eventually(async () => { const d = await drawnOver(reader); return d.painted >= 1 && d.peers === 1; }, { timeout: UI_MS, message: "shown from the menu" });
});
