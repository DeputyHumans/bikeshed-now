// SPDX-License-Identifier: Apache-2.0
// A16 decks: the navigator's rule, the overview and its keys, paging, presentation, stored thumbnails and their refusals (SPEC §6d).

/**
 * The catalogue's A16 cases, on the two deck samples the tree ships and on
 * small decks built here to sit either side of a rule:
 *
 *   Q  deck-quarter-review: eight `section[id]` slides, each one viewport
 *      tall, no script. Flat: slides follow each other, so navigation scrolls.
 *   D  deck-animated: six `.slide` sections. Sandboxed it is flat like Q;
 *      trusted, its script stacks them (`position:absolute; inset:0`), shows
 *      one `.active` at a time with a 0.35 s opacity transition, and answers
 *      the arrow keys itself, calling preventDefault.
 *
 *   A16.1   the rail and the Slides / All slides buttons appear for Q (eight)
 *           and for three viewport-tall slides; never for tall sections or
 *           short ones. `o` (parent focus) and `O` toggle the overview, each
 *           opening and closing it, and `o` with the focus inside the frame
 *           opens it too. Escape closes the
 *           overview and nothing else, even while presenting; with the
 *           overview shut it is left untouched (not defaultPrevented).
 *   A16.1b  a recognized two-slide deck keeps its rail and navigation; a
 *           single slide has no navigator. X-a16-decks-2 was a specification
 *           mismatch: useful two-slide navigation is retained (SPEC §6d).
 *   A16.2   flat Q: every paging key on the parent scrolls the frame to the
 *           right slide and the rail follows; a key inside the frame too.
 *           Stacked D (trusted): a parent ArrowRight, a rail click, End and
 *           Home move the deck through its own keys without scrolling it; an
 *           ArrowRight inside the frame advances exactly one slide (the
 *           deck's preventDefault wins over the viewer's paging). A trusted
 *           flat deck that takes ArrowDown itself is not scrolled by it.
 *   A16.2b  on D, four parent ArrowRight presses show slides 2-5 and the rail
 *           marks each. Tagged X-a16-decks-1, CLASS I (the product does what
 *           SPEC §6d spec.md:891-895 says, and the harm is concrete; ask at
 *           G1): position is read from which slide is shown at the deck's own
 *           attribute change, the signal the SPEC names, and at that change
 *           the new slide's opacity transition is at 0 and the old one is
 *           still visible, so `current` lags and every other press goes
 *           nowhere. The same deck with its section transitions removed is
 *           the case's own control (precondition).
 *   A16.3   Present hides the chrome, keeps a counter that follows the deck,
 *           and stops when fullscreen ends without the Exit button
 *           (`fullscreenchange`); Exit stops it; a refused fullscreen still
 *           presents, because the CSS state is what hides the chrome.
 *   A16.4   the owner's browser posts the cover, then the slides, once each;
 *           the record is {versionId, rev, cover, slides:{key, count}} and
 *           updatedAt is untouched; the cover is slide one's image at 16:9; a
 *           viewer who opened the deck first posts nothing; the viewer's rail
 *           and overview then use <img src=/thumb/…>, each a member read
 *           `private, max-age=86400, immutable`; a stranger and an anonymous
 *           reader get the absent id's 404, byte for byte.
 *   A16.5   POST /thumb refuses r≠THUMB_REVISION, a version that is not
 *           current, a non-JPEG, 160 KiB + 1, 1281 px and 101 slides, and none
 *           of those writes anything; exactly 160 KiB at 1280×720 and exactly
 *           100 slides are stored.
 *
 * Only e2e/lib/ talks to the stack.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario, untilLanded } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { absentDocId, publish, readSample, updateUpload } from "../../lib/seed.mjs";
import { share } from "../../lib/grant.mjs";
import { closeAdmin, listObjects, readDoc, trustAsOperator } from "../../lib/admin.mjs";
import { eventually, sameHeadersExceptDate } from "../../lib/assert.mjs";
import { treeConstant } from "../../lib/target.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const tag = () => `${runTag(target.runId)}-${rand4()}`;

function noPageErrors(users) {
  for (const u of users) assert.deepEqual(u.log.errors.map((e) => e.message), [], `${u.name}: uncaught page errors`);
}

/**
 * A session for `account`, sent again while the stack leaves POST /session
 * unanswered (a loaded shared stack cuts it off at its minute). Its client
 * throws on Hosting's cut-off (`cutoffError`), so a request it makes later
 * that the stack never answered ends the case INCONCLUSIVE, not judged.
 */
async function signIn(ctx, account) {
  const { out } = await untilLanded(ctx, `POST /session for ${account.role}`, () => openSession(target, account, { timeoutMs: 90_000, cutoffError: true }), null, { stopAt: "budget" });
  return out;
}

/** An owner with a session, and the rest of the cast as bare accounts. */
async function castWithOwner(ctx, roles) {
  const accounts = await cast(target, ["owner", ...roles]);
  const owner = await signIn(ctx, accounts[0]);
  return { owner, accounts };
}

/** Sign `u` in through the UI, again while the page's POST /session is cut off. */
async function signInUi(ctx, u, account) {
  await untilLanded(ctx, `${u.name}: sign-in through the UI`, () => u.signInUi(account.email, account.password), null, { stopAt: "budget" });
}

/**
 * Trust a deck for everyone as the operator does: POST /trust is a
 * superadmin's (ADR 0021), and these cases are about what a trusted deck does.
 */
async function trust(docId) {
  await trustAsOperator(target, docId);
}

/** The scenarios' common options: a loaded shared stack's non-answer is INCONCLUSIVE, never judged. */
const STALLS = { inconclusiveOnHttpStall: true, inconclusiveOnRequestStall: true };

/**
 * Sign the owner in through the UI and leave the workspace before anything is
 * published: the workspace backfills a missing cover for every card on screen
 * (SPEC §6d), and a backfill POST would be mistaken for the viewer's capture.
 */
async function ownerBrowser(ctx, account, name = "owner") {
  const u = await ctx.users.user({ name });
  await signInUi(ctx, u, account);
  await u.goto("/terms");
  return u;
}

// --- documents ----------------------------------------------------------------

/**
 * A document of `n` sibling sections under <main>, each at least `minHeight`
 * tall. `slide` gives every section the class `slide` and a heading (rule 2
 * of deck.ts); otherwise each carries only an id (rule 5, three or more).
 */
function sectionsDoc({ n, minHeight, slide = true, script = "", title = "Sections" }) {
  const sections = Array.from({ length: n }, (_, i) =>
    slide
      ? `<section class="slide" id="part-${i + 1}"><h2>Part ${i + 1}</h2><p>Paragraph ${i + 1} of the e2e deck.</p></section>`
      : `<section id="part-${i + 1}"><p>Paragraph ${i + 1}, a short section of prose.</p></section>`,
  ).join("\n");
  return Buffer.from(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
  main > section { box-sizing: border-box; min-height: ${minHeight}; padding: 2rem; border-bottom: 1px solid #ccd; }
</style>
</head>
<body>
<main>
${sections}
</main>
${script ? `<script>${script}</script>` : ""}
</body>
</html>
`);
}

/**
 * A trusted FLAT deck whose own script takes ArrowDown (preventDefault, and a
 * count) and nothing else. The viewer must yield that key and still page on
 * the others (SPEC §6d: keys "yield to defaultPrevented so a trusted deck's
 * own navigation wins").
 */
const TAKES_ARROWDOWN = `
  window.__deckTook = 0;
  document.addEventListener("keydown", function (event) {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    window.__deckTook += 1;
  });
`;

/** The D sample's two section transitions, which A16.2b removes for its control twin. */
const D_TRANSITIONS = ["transition: opacity 0.35s ease, visibility 0s linear 0.35s;", "transition: opacity 0.35s ease;"];

/** Q's slide titles in DOM order: the first h1 or h2 of each `<section id>`. */
function qTitles(bytes) {
  const html = bytes.toString("utf8");
  const titles = [...html.matchAll(/<section id="[^"]+">[\s\S]*?<h[12][^>]*>([\s\S]*?)<\/h[12]>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
  return precondition(titles.length === 8 && titles, `Q has eight titled sections (got ${titles.length})`);
}

// --- reading the viewer ---------------------------------------------------------

/** The navigator as the parent page draws it. */
function viewerState(u) {
  return u.page.evaluate(() => {
    const thumbs = Array.from(document.querySelectorAll(".slide-rail .slide-thumb"));
    const items = Array.from(document.querySelectorAll(".slide-overview .slide-overview-item"));
    const btn = (label) => document.querySelector(`.viewer-toolbar button[aria-label="${label}"]`);
    return {
      rail: thumbs.length,
      labels: thumbs.map((b) => b.getAttribute("aria-label")),
      current: thumbs.findIndex((b) => b.getAttribute("aria-current") === "true"),
      slidesButton: Boolean(btn("Slides")),
      slidesPressed: btn("Slides")?.getAttribute("aria-pressed") ?? null,
      allSlidesButton: Boolean(btn("All slides")),
      overview: items.length,
      overviewCurrent: items.findIndex((b) => b.getAttribute("aria-current") === "true"),
      focusInOverview: Boolean(document.activeElement?.closest?.(".slide-overview")),
      presenting: document.body.classList.contains("is-presenting"),
      fullscreen: Boolean(document.fullscreenElement),
      counter: document.querySelector(".present-counter")?.textContent ?? null,
      exit: Boolean(document.querySelector(".present-exit")),
    };
  });
}

/** Where the frame is: its scroll, each slide's offset, and (for D) the shown slide. */
async function frameState(u, sel = "main > section") {
  const f = await u.frame();
  return f.evaluate((s) => {
    const sections = Array.from(document.querySelectorAll(s));
    return {
      y: Math.round(window.scrollY),
      innerHeight: window.innerHeight,
      offsets: sections.map((el) => Math.round(el.getBoundingClientRect().top + window.scrollY)),
      active: sections.findIndex((el) => el.classList.contains("active")),
      js: document.documentElement.classList.contains("js"),
      animations: typeof document.getAnimations === "function" ? document.getAnimations().length : 0,
      took: typeof window.__deckTook === "number" ? window.__deckTook : null,
    };
  }, sel);
}

/** Until the frame runs no transition or animation, on three samples in a row. */
async function settleFrame(u, sel, what) {
  return eventually(async () => {
    const s = await frameState(u, sel);
    if (s.animations !== 0) throw new Error(`${s.animations} animation(s) running`);
    return { y: s.y, active: s.active };
  }, { timeout: 10_000, interval: 100, stableSamples: 3, message: `${what}: the frame settled` });
}

/** The parent window holds the focus (keys go to its listener), not the frame. */
async function focusParent(u) {
  await u.page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    window.focus();
  });
  await eventually(() => u.page.evaluate(() => document.activeElement === document.body && document.hasFocus()), { timeout: 5_000, message: "the parent page holds the focus" });
}

/** A real click near the frame's bottom-right corner, where no sample has content, so the frame document takes the focus. */
async function focusFrame(u) {
  const box = await u.page.locator("iframe.doc-frame").boundingBox();
  precondition(box && box.width > 100 && box.height > 100, "the document frame has a box to click");
  await u.page.mouse.click(box.x + box.width - 24, box.y + box.height - 24);
  const f = await u.frame();
  await eventually(async () => (await u.page.evaluate(() => document.activeElement?.classList.contains("doc-frame"))) && (await f.evaluate(() => document.hasFocus())), { timeout: 5_000, message: "the frame document holds the focus" });
}

/** The deck the viewer sees once the frame loaded: rail drawn (or decided absent) on two stable samples. */
async function openDeck(u, docId, { expectRail = true } = {}) {
  await u.open(docId);
  return eventually(async () => {
    const s = await viewerState(u);
    if (expectRail && s.rail === 0) throw new Error("no rail yet");
    return s;
  }, { timeout: 15_000, interval: 200, stableSamples: expectRail ? 2 : 8, message: "the navigator decided" });
}

/**
 * Every Escape keydown the parent window sees, with `defaultPrevented` read
 * after the event finished dispatching: useDeck re-binds its window listener
 * whenever the slide changes, so a probe registered earlier would otherwise
 * run before it.
 */
async function installEscapeProbe(u) {
  await u.page.evaluate(() => {
    window.__e2eEscape = [];
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setTimeout(() => window.__e2eEscape.push(e.defaultPrevented), 0);
    });
  });
}
const escapes = (u) => u.page.evaluate(() => window.__e2eEscape.slice());

// --- thumbnails -------------------------------------------------------------------

const pathOf = (url) => new URL(url).pathname;

/**
 * Every POST /thumb a user's pages send from the call on, written at the send
 * (so one still waiting for its answer is a row), with its status once the
 * response arrives (`User.capture`). Not `log.requests`: that is written at
 * the response, so "posted nothing" read from it passes while a POST is in
 * flight. `uploadThumbs` takes only `res.ok`, so a /thumb row is answered and
 * never settles; nothing here waits for it to settle.
 */
const watchThumbPosts = (u) => u.capture({ paths: "/thumb", method: "POST", responseJson: false });

/** The POST /thumb requests a capture holds (for one document, or all), in the order they were sent. */
function thumbPosts(rows, docId = null) {
  return rows
    .filter((r) => docId === null || new URL(r.url).searchParams.get("doc") === docId)
    .sort((a, b) => a.seq - b.seq)
    .map((r) => {
      const q = new URL(r.url).searchParams;
      return { t: r.t, doc: q.get("doc"), v: q.get("v"), kind: q.get("kind"), r: q.get("r"), sizes: (q.get("sizes") ?? "").split(",").map(Number), status: r.status, state: r.state };
    });
}

/** A JPEG's pixel size from its frame header, as thumbs.ts reads it; null if not a JPEG. */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = buf.readUInt16BE(i + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * A baseline JPEG by its markers (all POST /thumb reads): SOI, APP1 padding
 * up to `total` bytes, an SOF0 frame header of `width`×`height`, EOI. No
 * browser decodes these.
 */
function jpeg({ width = 1, height = 1, total = 17 } = {}) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00]);
  const fixed = 2 + sof.length + 2;
  let pad = total - fixed;
  if (pad < 0 || pad === 1 || pad === 2 || pad === 3) throw new Error(`jpeg: cannot pad to ${total}`);
  const parts = [Buffer.from([0xff, 0xd8])];
  while (pad > 0) {
    // One APP1 segment is at most 2 + 65535 bytes; never leave a remainder too short to be a segment.
    let seg = Math.min(pad, 65537);
    if (pad - seg > 0 && pad - seg < 4) seg -= 4;
    const len = seg - 2;
    const head = Buffer.from([0xff, 0xe1, len >> 8, len & 0xff]);
    parts.push(head, Buffer.alloc(len - 2, 0x20));
    pad -= seg;
  }
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  const out = Buffer.concat(parts);
  if (out.length !== total) throw new Error(`jpeg: built ${out.length}, wanted ${total}`);
  return out;
}

const octet = { "content-type": "application/octet-stream" };

function postThumb(http, { doc, v, kind, images, r, sizes }) {
  return http.request("POST", "/thumb", {
    query: { doc, v, kind, sizes: sizes ?? images.map((b) => b.length).join(","), ...(r === undefined ? {} : { r: String(r) }) },
    headers: octet,
    body: Buffer.concat(images),
  });
}

// --- A16.1 ----------------------------------------------------------------------

scenario("A16.1 the rail and the slide buttons appear for viewport-tall decks of three and eight slides and never for tall or short sections; o and O toggle the overview from the parent and from inside the frame; Escape closes only the overview, even while presenting, and is left untouched once it is shut", {
  tiers: ["local", "prod"],
  timeoutMs: 420_000,
  ...STALLS,
}, async (ctx) => {
  ctx.step("cast an owner; publish Q, three viewport-tall slides, four slides three screens tall, and three short id'd sections");
  const { owner, accounts } = await castWithOwner(ctx, []);
  const q = readSample(target, "deck-quarter-review");
  const titles = qTitles(q.bytes);
  const t = tag();
  const docs = {
    q: (await publish(owner.http, { body: q.bytes, filename: q.filename, title: `Q ${t}`, name: "a161-q", patient: { ctx, stopAt: "budget" } })).docId,
    three: (await publish(owner.http, { body: sectionsDoc({ n: 3, minHeight: "100vh" }), filename: "index.html", title: `Three ${t}`, name: "a161-three", patient: { ctx, stopAt: "budget" } })).docId,
    tall: (await publish(owner.http, { body: sectionsDoc({ n: 4, minHeight: "300vh" }), filename: "index.html", title: `Tall ${t}`, name: "a161-tall", patient: { ctx, stopAt: "budget" } })).docId,
    short: (await publish(owner.http, { body: sectionsDoc({ n: 3, minHeight: "6rem", slide: false }), filename: "index.html", title: `Short ${t}`, name: "a161-short", patient: { ctx, stopAt: "budget" } })).docId,
  };
  const o = await ownerBrowser(ctx, accounts[0]);

  ctx.step("Q: a rail of eight, labelled with the slide titles in DOM order, slide one current; Slides (pressed) and All slides in the toolbar");
  const qs = await openDeck(o, docs.q);
  assert.deepEqual(
    { rail: qs.rail, labels: qs.labels, current: qs.current, slidesButton: qs.slidesButton, slidesPressed: qs.slidesPressed, allSlidesButton: qs.allSlidesButton, overview: qs.overview },
    { rail: 8, labels: titles.map((title, i) => `Slide ${i + 1}: ${title}`), current: 0, slidesButton: true, slidesPressed: "true", allSlidesButton: true, overview: 0 },
    "Q's navigator",
  );

  ctx.step("three viewport-tall slides: a rail of three");
  const ts = await openDeck(o, docs.three);
  assert.deepEqual({ rail: ts.rail, slidesButton: ts.slidesButton, allSlidesButton: ts.allSlidesButton }, { rail: 3, slidesButton: true, allSlidesButton: true }, "three viewport-tall slides get the navigator");

  for (const [key, why] of [["tall", "four slides three screens tall"], ["short", "three short sections"]]) {
    ctx.step(`${why}: no rail, no Slides or All slides button; o opens no overview and ArrowDown on the parent pages nothing`);
    const s = await openDeck(o, docs[key], { expectRail: false });
    assert.deepEqual({ rail: s.rail, slidesButton: s.slidesButton, allSlidesButton: s.allSlidesButton }, { rail: 0, slidesButton: false, allSlidesButton: false }, `${why}: no navigator`);
    await focusParent(o);
    await o.page.evaluate(() => {
      window.__e2eUnpagedKeys = [];
      const heard = (event) => {
        if (!["o", "ArrowDown"].includes(event.key)) return;
        queueMicrotask(() => {
          window.__e2eUnpagedKeys.push({ key: event.key, prevented: event.defaultPrevented });
          if (window.__e2eUnpagedKeys.length === 2) window.removeEventListener("keydown", heard);
        });
      };
      window.addEventListener("keydown", heard);
    });
    await o.page.keyboard.press("o");
    await o.page.keyboard.press("ArrowDown");
    const after = await eventually(async () => ({ v: await viewerState(o), f: await frameState(o) }), { timeout: 3_000, interval: 150, stableSamples: 5, message: `${why}: steady after o and ArrowDown` });
    assert.deepEqual({ overview: after.v.overview, y: after.f.y }, { overview: 0, y: 0 }, `${why}: o drew no overview and ArrowDown did not page the frame`);
    assert.deepEqual(await o.page.evaluate(() => window.__e2eUnpagedKeys), [{ key: "o", prevented: false }, { key: "ArrowDown", prevented: false }], "unpaged sections keep their overview and paging keys");
  }

  ctx.step("Q again: o on the parent opens the overview (eight cards, focus on the current one); O closes it");
  // Negative controls for this half (spec mutations, scratch only): a page listener that swallows O, swallows o
  // inside the frame or o while the overview is open, makes Escape also turn the rail off or end Present, or
  // prevents an Escape with the overview shut, each turns this case red at the matching assertion.
  await openDeck(o, docs.q);
  await focusParent(o);
  await installEscapeProbe(o);
  await o.page.keyboard.press("o");
  const opened = await eventually(async () => {
    const s = await viewerState(o);
    if (s.overview === 0) throw new Error("no overview");
    return s;
  }, { timeout: 5_000, message: "o opened the overview" });
  assert.deepEqual({ overview: opened.overview, overviewCurrent: opened.overviewCurrent, focusInOverview: opened.focusInOverview }, { overview: 8, overviewCurrent: 0, focusInOverview: true }, "the overview: every slide, the current one focused");
  await o.page.keyboard.press("O");
  await eventually(async () => (await viewerState(o)).overview === 0, { timeout: 5_000, message: "O closed the overview" });

  ctx.step("O opens it again and o closes it: each key both opens and closes (SPEC §6d: o opens and closes the overview)");
  await o.page.keyboard.press("O");
  await eventually(async () => (await viewerState(o)).overview === 8, { timeout: 5_000, message: "O opened the overview" });
  await o.page.keyboard.press("o");
  await eventually(async () => (await viewerState(o)).overview === 0, { timeout: 5_000, message: "o closed the overview" });

  ctx.step("with the focus inside the frame, o opens the overview too (keys are bound on the frame document)");
  await focusFrame(o);
  await o.page.keyboard.press("o");
  await eventually(async () => (await viewerState(o)).overview === 8, { timeout: 5_000, message: "o inside the frame opened the overview" });

  ctx.step("Escape closes it: defaultPrevented, the rail still there and Slides still pressed");
  await o.page.keyboard.press("Escape");
  const closed = await eventually(async () => {
    const s = await viewerState(o);
    if (s.overview !== 0) throw new Error("overview still open");
    return s;
  }, { timeout: 5_000, message: "Escape closed the overview" });
  assert.deepEqual({ rail: closed.rail, slidesPressed: closed.slidesPressed, presenting: closed.presenting }, { rail: 8, slidesPressed: "true", presenting: false }, "Escape closed the overview and nothing else");
  assert.deepEqual(await eventually(() => escapes(o).then((e) => (e.length === 1 ? e : false)), { timeout: 3_000, message: "the Escape was seen" }), [true], "the Escape that closed the overview was defaultPrevented");

  ctx.step("present (fullscreen granted), open the overview with o, Escape: the overview closes and the presentation stays");
  await focusParent(o);
  await o.page.getByRole("button", { name: "Present", exact: true }).click();
  await eventually(async () => {
    const s = await viewerState(o);
    return s.presenting && s.fullscreen;
  }, { timeout: 10_000, message: "presenting in fullscreen" });
  await o.page.keyboard.press("o");
  await eventually(async () => (await viewerState(o)).overview === 8, { timeout: 5_000, message: "o opened the overview while presenting" });
  await o.page.keyboard.press("Escape");
  const inPresent = await eventually(async () => {
    const s = await viewerState(o);
    if (s.overview !== 0) throw new Error("overview still open");
    return s;
  }, { timeout: 5_000, message: "Escape closed the overview while presenting" });
  assert.deepEqual({ presenting: inPresent.presenting, fullscreen: inPresent.fullscreen, counter: inPresent.counter }, { presenting: true, fullscreen: true, counter: "1 / 8" }, "the presentation survived the Escape that closed the overview");

  ctx.step("Escape with the overview shut: left untouched (not defaultPrevented), and nothing of the app's changes");
  await o.page.keyboard.press("Escape");
  const seen = await eventually(() => escapes(o).then((e) => (e.length === 3 ? e : false)), { timeout: 3_000, message: "three Escapes seen" });
  assert.deepEqual(seen, [true, true, false], "only the Escapes that closed the overview were defaultPrevented");
  const still = await eventually(() => viewerState(o), { timeout: 3_000, interval: 150, stableSamples: 5, message: "steady after the last Escape" });
  assert.deepEqual({ presenting: still.presenting, overview: still.overview }, { presenting: true, overview: 0 }, "an Escape with the overview shut changed nothing of the app's");
  await o.page.locator(".present-exit").click();
  await eventually(async () => !(await viewerState(o)).presenting, { timeout: 10_000, message: "Exit stopped presenting" });
  noPageErrors([o]);
});

scenario("A16.1b a recognized two-slide deck has a navigator that reaches both slides; a single slide has none (SPEC §6d)", {
  tiers: ["local", "prod"],
  timeoutMs: 300_000,
  ...STALLS,
}, async (ctx) => {
  const { owner, accounts } = await castWithOwner(ctx, []);
  const t = tag();
  const three = (await publish(owner.http, { body: sectionsDoc({ n: 3, minHeight: "100vh" }), filename: "index.html", title: `Three ${t}`, name: "a161b-three", patient: { ctx, stopAt: "budget" } })).docId;
  const two = (await publish(owner.http, { body: sectionsDoc({ n: 2, minHeight: "100vh" }), filename: "index.html", title: `Two ${t}`, name: "a161b-two", patient: { ctx, stopAt: "budget" } })).docId;
  const one = (await publish(owner.http, { body: sectionsDoc({ n: 1, minHeight: "100vh" }), filename: "index.html", title: `One ${t}`, name: "a161b-one", patient: { ctx, stopAt: "budget" } })).docId;
  const o = await ownerBrowser(ctx, accounts[0]);

  ctx.step("control: the same slides, three of them, get the navigator (so the slides are detected and measured paged)");
  const s3 = await openDeck(o, three);
  precondition(s3.rail === 3 && s3.slidesButton, `three viewport-tall slides get a rail of three (got ${JSON.stringify({ rail: s3.rail, slidesButton: s3.slidesButton })})`);

  ctx.step("two of them: both rail entries, Slides and All slides remain available");
  const s2 = await openDeck(o, two, { expectRail: false });
  ctx.ev.json("two-slides", s2);
  assert.deepEqual({ rail: s2.rail, slidesButton: s2.slidesButton, allSlidesButton: s2.allSlidesButton }, { rail: 2, slidesButton: true, allSlidesButton: true }, "a recognized two-slide deck has its navigator");
  const layout = await frameState(o);
  precondition(layout.offsets.length === 2 && layout.offsets[1] > layout.offsets[0], "the two slides occupy separate pages");
  const reaches = async (index) => eventually(async () => {
    const frame = await frameState(o);
    const viewer = await viewerState(o);
    return Math.abs(frame.y - layout.offsets[index]) <= 2 && viewer.current === index;
  }, { timeout: 5_000, interval: 100, stableSamples: 3, message: `two-slide navigation reaches ${index + 1}` }).catch(() => false);
  await o.page.locator(".slide-rail .slide-thumb").nth(1).click();
  assert.equal(await reaches(1), true, "the two-slide navigator reaches the second slide");
  await focusParent(o);
  await o.page.keyboard.press("Home");
  assert.equal(await reaches(0), true, "the two-slide navigator returns to the first slide");

  ctx.step("a single recognized slide needs no navigator");
  const s1 = await openDeck(o, one, { expectRail: false });
  assert.deepEqual({ rail: s1.rail, slidesButton: s1.slidesButton, allSlidesButton: s1.allSlidesButton }, { rail: 0, slidesButton: false, allSlidesButton: false }, "a single slide has no navigator");
  noPageErrors([o]);
});

// --- A16.2 ----------------------------------------------------------------------

scenario("A16.2 keys scroll a flat deck and the rail follows; on a stacked trusted deck they go into the deck through its own keys without scrolling it; the deck's own preventDefault wins inside the frame, stacked or flat", {
  tiers: ["local", "prod"],
  timeoutMs: 420_000,
  ...STALLS,
}, async (ctx) => {
  ctx.step("cast an owner; publish Q, D (trusted for everyone) and a trusted flat deck that takes ArrowDown itself");
  const { owner, accounts } = await castWithOwner(ctx, []);
  const t = tag();
  const q = readSample(target, "deck-quarter-review");
  const d = readSample(target, "deck-animated");
  const docs = {
    q: (await publish(owner.http, { body: q.bytes, filename: q.filename, title: `Q ${t}`, name: "a162-q", patient: { ctx, stopAt: "budget" } })).docId,
    d: (await publish(owner.http, { body: d.bytes, filename: d.filename, title: `D ${t}`, name: "a162-d", patient: { ctx, stopAt: "budget" } })).docId,
    pd: (await publish(owner.http, { body: sectionsDoc({ n: 4, minHeight: "100vh", script: TAKES_ARROWDOWN }), filename: "index.html", title: `Takes ArrowDown ${t}`, name: "a162-pd", patient: { ctx, stopAt: "budget" } })).docId,
  };
  for (const id of [docs.d, docs.pd]) await trust(id);
  const o = await ownerBrowser(ctx, accounts[0]);

  ctx.step("Q (flat): each paging key on the parent scrolls the frame to its slide and the rail marks it");
  await openDeck(o, docs.q);
  const q0 = await frameState(o);
  precondition(q0.offsets.length === 8 && q0.offsets.every((top, i) => i === 0 || top > q0.offsets[i - 1]), `Q's slides follow each other: ${JSON.stringify(q0.offsets)}`);
  await focusParent(o);
  const walk = [["ArrowDown", 1], ["ArrowRight", 2], ["Space", 3], ["PageDown", 4], ["ArrowUp", 3], ["PageUp", 2], ["ArrowLeft", 1], ["End", 7], ["Home", 0]];
  const seen = [];
  for (const [key, want] of walk) {
    await o.page.keyboard.press(key);
    const s = await eventually(async () => {
      const f = await frameState(o);
      const v = await viewerState(o);
      if (Math.abs(f.y - q0.offsets[want]) > 2 || v.current !== want) throw new Error(`${key}: y=${f.y} rail=${v.current}`);
      return { y: f.y, rail: v.current };
    }, { timeout: 5_000, interval: 100, stableSamples: 3, message: `${key} on the parent reached slide ${want + 1}` }).catch((err) => ({ error: err.message }));
    seen.push([key, s.error ?? `slide ${want + 1}`]);
  }
  assert.deepEqual(seen, walk.map(([key, want]) => [key, `slide ${want + 1}`]), "every parent key paged Q to its slide, the rail following");

  ctx.step("Q: ArrowDown with the focus inside the frame pages too");
  await focusFrame(o);
  await o.page.keyboard.press("ArrowDown");
  await eventually(async () => {
    const f = await frameState(o);
    return Math.abs(f.y - q0.offsets[1]) <= 2 && (await viewerState(o)).current === 1;
  }, { timeout: 5_000, stableSamples: 3, message: "ArrowDown inside Q's frame paged to slide 2" });

  ctx.step("D (trusted): its script ran and stacked the slides; the frame is unsandboxed");
  await openDeck(o, docs.d);
  const d0 = await eventually(async () => {
    const f = await frameState(o, ".deck > section");
    if (!f.js || f.active !== 0) throw new Error(`deck script not run: ${JSON.stringify(f)}`);
    return f;
  }, { timeout: 15_000, message: "D's script showed slide one" });
  precondition(d0.offsets.every((top) => top === d0.offsets[0]), `D's slides share one top (stacked): ${JSON.stringify(d0.offsets)}`);
  precondition((await o.page.evaluate(() => document.querySelector("iframe.doc-frame").getAttribute("sandbox"))) === null, "the trusted deck's frame is unsandboxed");
  await settleFrame(o, ".deck > section", "D at load");
  await (await o.frame()).evaluate(() => {
    window.__a16Keys = [];
    document.addEventListener("keydown", (e) => window.__a16Keys.push({ key: e.key, trusted: e.isTrusted }), true);
  });

  // Act, wait until the deck moved at all, let its transition finish, then say where it is.
  const dStep = async (what, act, want, message = `${what}: D shows slide ${want + 1} and the frame did not scroll`) => {
    const from = (await frameState(o, ".deck > section")).active;
    const keyMark = await (await o.frame()).evaluate(() => window.__a16Keys.length);
    await act();
    await eventually(async () => (await frameState(o, ".deck > section")).active !== from, { timeout: 5_000, message: `${what}: the deck moved off slide ${from + 1}` });
    const s = await settleFrame(o, ".deck > section", what);
    assert.deepEqual(s, { y: 0, active: want }, message);
    const keys = await (await o.frame()).evaluate((mark) => window.__a16Keys.slice(mark), keyMark);
    if (!what.includes("inside the frame")) assert.deepEqual(keys, Array.from({ length: Math.abs(want - from) }, () => ({ key: want > from ? "ArrowRight" : "ArrowLeft", trusted: false })), `${what}: stacked navigation dispatches the exact synthetic deck keys`);
  };
  await focusParent(o);
  await dStep("ArrowRight on the parent", () => o.page.keyboard.press("ArrowRight"), 1);
  await dStep("a click on the rail's fifth slide", () => o.page.locator(".slide-rail .slide-thumb").nth(4).click(), 4);
  await focusParent(o);
  await dStep("End on the parent", () => o.page.keyboard.press("End"), 5);
  await dStep("Home on the parent", () => o.page.keyboard.press("Home"), 0);

  ctx.step("D: ArrowRight inside the frame advances exactly one slide (the deck took it; the viewer yielded)");
  await focusFrame(o);
  await dStep("ArrowRight inside the frame", () => o.page.keyboard.press("ArrowRight"), 1, "defaultPrevented wins: ArrowRight inside the frame, which the deck took, moved D exactly one slide and the viewer paged nothing on top");

  ctx.step("the trusted flat deck that takes ArrowDown: ArrowDown inside the frame is the deck's alone; ArrowRight still pages");
  await openDeck(o, docs.pd);
  const p0 = await eventually(async () => {
    const f = await frameState(o);
    if (f.took !== 0) throw new Error(`deck script not run: took=${f.took}`);
    return f;
  }, { timeout: 15_000, message: "the deck's script ran" });
  precondition(p0.offsets.length === 4 && p0.y === 0, `four flat slides at the top: ${JSON.stringify(p0)}`);
  await focusFrame(o);
  await o.page.keyboard.press("ArrowDown");
  const afterDown = await eventually(async () => {
    const f = await frameState(o);
    if (f.took !== 1) throw new Error(`took=${f.took}`);
    return { y: f.y, rail: (await viewerState(o)).current, took: f.took };
  }, { timeout: 5_000, interval: 150, stableSamples: 5, message: "the deck took ArrowDown" });
  assert.deepEqual(afterDown, { y: 0, rail: 0, took: 1 }, "defaultPrevented wins: the flat deck took ArrowDown, and the viewer did not also page it");
  await o.page.keyboard.press("ArrowRight");
  await eventually(async () => {
    const f = await frameState(o);
    return Math.abs(f.y - p0.offsets[1]) <= 2 && (await viewerState(o)).current === 1;
  }, { timeout: 5_000, stableSamples: 3, message: "ArrowRight, which the deck does not take, paged to slide 2" });
  noPageErrors([o]);
});

/** Computed visibility can finish moving after the deck's last attribute change. */
scenario("A16.2b on the animated deck, trusted (stacked), four ArrowRight presses on the parent show slides 2 to 5 and the rail marks each", {
  tiers: ["local", "prod"],
  timeoutMs: 300_000,
  ...STALLS,
}, async (ctx) => {
  ctx.step("cast an owner; publish D and its twin without the two section transitions, both trusted for everyone");
  const { owner, accounts } = await castWithOwner(ctx, []);
  const t = tag();
  const d = readSample(target, "deck-animated");
  let still = d.bytes.toString("utf8");
  for (const decl of D_TRANSITIONS) {
    precondition(still.split(decl).length === 2, `D declares ${decl} once`);
    still = still.replace(decl, "transition: none;");
  }
  const docs = {
    still: (await publish(owner.http, { body: Buffer.from(still), filename: "index.html", title: `D still ${t}`, name: "a162b-still", patient: { ctx, stopAt: "budget" } })).docId,
    d: (await publish(owner.http, { body: d.bytes, filename: d.filename, title: `D ${t}`, name: "a162b-d", patient: { ctx, stopAt: "budget" } })).docId,
  };
  for (const id of Object.values(docs)) await trust(id);
  const o = await ownerBrowser(ctx, accounts[0]);

  const presses = async (docId, what) => {
    await openDeck(o, docId);
    await eventually(async () => {
      const f = await frameState(o, ".deck > section");
      if (!f.js || f.active !== 0) throw new Error(`deck script not run: ${JSON.stringify(f)}`);
      return true;
    }, { timeout: 15_000, message: `${what}: the script showed slide one` });
    await settleFrame(o, ".deck > section", `${what} at load`);
    await focusParent(o);
    const seq = [];
    for (let k = 1; k <= 4; k++) {
      await o.page.keyboard.press("ArrowRight");
      // Settled = no transition running and the deck and the rail both unchanged on three samples.
      const s = await eventually(async () => {
        const f = await frameState(o, ".deck > section");
        if (f.animations !== 0) throw new Error(`${f.animations} animation(s) running`);
        return [f.active, (await viewerState(o)).current];
      }, { timeout: 10_000, interval: 150, stableSamples: 3, message: `${what}: settled after press ${k}` });
      seq.push(s);
    }
    ctx.step(`${what}: [deck, rail] after each press: ${JSON.stringify(seq)}`);
    return seq;
  };

  const want = [[1, 1], [2, 2], [3, 3], [4, 4]];
  const control = await presses(docs.still, "D without transitions");
  precondition(JSON.stringify(control) === JSON.stringify(want), `control: the stacked deck without transitions is driven one slide per press and the rail follows (got ${JSON.stringify(control)})`);
  const animated = await presses(docs.d, "D");
  ctx.ev.json("presses", { control, animated });
  assert.deepEqual(animated, want, "the settled animated deck and its navigator advance once per ArrowRight");
});

// --- A16.3 ----------------------------------------------------------------------

/** The chrome presentation hides, as the page computes it. */
function chromeState(u) {
  return u.page.evaluate(() => {
    const shown = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).display !== "none" : null;
    };
    return {
      header: shown(".app-header"),
      toolbar: shown(".viewer-toolbar"),
      banners: shown(".viewer-banners"),
      comments: shown(".comments-panel"),
      rail: Boolean(document.querySelector(".slide-rail")),
    };
  });
}

scenario("A16.3 Present hides the chrome and shows a counter that follows the deck; leaving fullscreen without Exit ends it (fullscreenchange); Exit ends it; a refused fullscreen still presents", {
  tiers: ["local", "prod"],
  timeoutMs: 300_000,
  ...STALLS,
}, async (ctx) => {
  const { owner, accounts } = await castWithOwner(ctx, []);
  const q = readSample(target, "deck-quarter-review");
  const withScript = Buffer.from(q.bytes.toString("utf8").replace("</body>", "<script>window.a16Blocked = true;</script></body>"));
  const docId = (await publish(owner.http, { body: withScript, filename: q.filename, title: `Q ${tag()}`, name: "a163-q", patient: { ctx, stopAt: "budget" } })).docId;
  const o = await ownerBrowser(ctx, accounts[0]);
  await openDeck(o, docId);
  const heading = await (await o.frame()).locator("h1").first().textContent();
  precondition(heading?.trim(), "the deck has a title to attach a real comment to");
  await o.selectText("h1", heading.trim());
  await o.comment("A16 presentation keeps this thread when leaving fullscreen");
  await o.openComments();
  await o.page.locator(".comments-panel .thread").first().waitFor({ state: "visible" });
  const before = await chromeState(o);
  precondition(Object.values(before).every((value) => value === true), `the header, toolbar, script banner, comment thread and rail are on screen before presenting: ${JSON.stringify(before)}`);
  const hidden = (c) => ({ header: c.header, toolbar: c.toolbar, banners: c.banners === true, comments: c.comments === true, rail: c.rail });
  const allHidden = { header: false, toolbar: false, banners: false, comments: false, rail: false };

  ctx.step("Present: fullscreen, every piece of chrome hidden, the rail gone, the counter at 1 / 8, Exit shown");
  await focusParent(o);
  await o.page.getByRole("button", { name: "Present", exact: true }).click();
  const p = await eventually(async () => {
    const s = await viewerState(o);
    if (!s.presenting || !s.fullscreen) throw new Error(JSON.stringify(s));
    return s;
  }, { timeout: 10_000, message: "presenting in fullscreen" });
  assert.deepEqual({ counter: p.counter, exit: p.exit }, { counter: "1 / 8", exit: true }, "the counter and Exit");
  assert.deepEqual(hidden(await chromeState(o)), allHidden, "presenting hides the header, toolbar, banners, comments and rail");

  ctx.step("ArrowDown while presenting: the counter follows to 2 / 8");
  await o.page.keyboard.press("ArrowDown");
  await eventually(async () => (await viewerState(o)).counter === "2 / 8", { timeout: 5_000, message: "the counter followed the deck" });

  ctx.step("fullscreen ends without the Exit button (document.exitFullscreen, as Escape or F11 would): presenting follows fullscreenchange");
  await o.page.evaluate(() => document.exitFullscreen());
  const ended = await eventually(async () => {
    const s = await viewerState(o);
    if (s.fullscreen) throw new Error("still fullscreen");
    return s;
  }, { timeout: 5_000, message: "fullscreen ended" });
  const settled = await eventually(async () => ({ v: await viewerState(o), c: await chromeState(o) }), { timeout: 5_000, interval: 150, stableSamples: 4, message: "steady after fullscreen ended" });
  assert.deepEqual(
    { presenting: settled.v.presenting, counter: settled.v.counter, exit: settled.v.exit, header: settled.c.header, toolbar: settled.c.toolbar, rail: settled.c.rail },
    { presenting: false, counter: null, exit: false, header: true, toolbar: true, rail: true },
    `presentation follows fullscreenchange: leaving fullscreen ends it (fullscreen ${ended.fullscreen})`,
  );

  ctx.step("Present, then Exit: presenting stops and fullscreen is left");
  await o.page.getByRole("button", { name: "Present", exact: true }).click();
  await eventually(async () => {
    const s = await viewerState(o);
    return s.presenting && s.fullscreen;
  }, { timeout: 10_000, message: "presenting in fullscreen again" });
  await o.page.locator(".present-exit").click();
  await eventually(async () => {
    const s = await viewerState(o);
    return !s.presenting && !s.fullscreen;
  }, { timeout: 10_000, message: "Exit ended the presentation and fullscreen" });

  ctx.step("the browser refuses fullscreen: Present still hides the chrome, because the CSS state is what hides it; Exit restores");
  await o.page.evaluate(() => {
    document.documentElement.requestFullscreen = () => Promise.reject(new DOMException("refused by the e2e stub", "NotAllowedError"));
  });
  await o.page.getByRole("button", { name: "Present", exact: true }).click();
  const refused = await eventually(async () => {
    const s = await viewerState(o);
    if (!s.presenting) throw new Error("not presenting");
    return s;
  }, { timeout: 5_000, interval: 150, stableSamples: 4, message: "presenting without fullscreen" });
  assert.deepEqual({ presenting: refused.presenting, fullscreen: refused.fullscreen, exit: refused.exit }, { presenting: true, fullscreen: false, exit: true }, "a refused fullscreen still presents");
  assert.deepEqual(hidden(await chromeState(o)), allHidden, "a refused fullscreen still hides the chrome");
  await o.page.locator(".present-exit").click();
  await eventually(async () => {
    const s = await viewerState(o);
    const c = await chromeState(o);
    return !s.presenting && c.toolbar && c.rail;
  }, { timeout: 5_000, message: "Exit restored the chrome" });
  noPageErrors([o]);
});

// --- A16.4 ----------------------------------------------------------------------

scenario("A16.4 the owner's browser posts Q's cover, then its slides, once each; the record is {versionId, rev, cover, slides:{key, count}} with updatedAt untouched; a viewer who opened first posts nothing, then reads the rail and overview as <img src=/thumb/…>; a stranger and an anonymous reader get the absent id's 404", {
  tiers: ["local", "prod"],
  timeoutMs: 420_000,
  ...STALLS,
}, async (ctx) => {
  const REV = Number(treeConstant(target, "functions/src/lib/thumbs.ts", "THUMB_REVISION"));
  const SETTLE_MS = Number(treeConstant(target, "app/src/viewer/useThumbCapture.ts", "SETTLE_MS"));
  const CACHE_S = 86_400; // SPEC §6d: one day; do not follow a regressed product constant.

  ctx.step("cast an owner, a viewer and a stranger; the owner publishes Q and shares it with the viewer");
  const { owner, accounts } = await castWithOwner(ctx, ["viewer", "stranger"]);
  const [, vAcct, sAcct] = accounts;
  const q = readSample(target, "deck-quarter-review");
  const o = await ownerBrowser(ctx, accounts[0]);
  const oWatch = watchThumbPosts(o);
  const docId = (await publish(owner.http, { body: q.bytes, filename: q.filename, title: `Q ${tag()}`, name: "a164-q", patient: { ctx, stopAt: "budget" } })).docId;
  await share(target, { owner, doc: docId, account: vAcct, role: "viewer", patient: { ctx, stopAt: "budget" } });
  const rec0 = await readDoc(target, `docs/${docId}`);
  precondition(rec0 && !rec0.thumb && rec0.updatedAt, "the new document has no thumb and an updatedAt");

  ctx.step(`the viewer opens Q first, sees its live rail, and stays well past the capture's ${SETTLE_MS} ms settle`);
  const v = await ctx.users.user({ name: "viewer" });
  const vWatch = watchThumbPosts(v);
  await signInUi(ctx, v, vAcct);
  const vs = await openDeck(v, docId);
  precondition(vs.rail === 8, `the viewer's rail has eight slides (got ${vs.rail})`);
  await eventually(() => v.page.evaluate(() => document.querySelectorAll(".slide-rail iframe.slide-thumb-frame").length === 8), { timeout: 10_000, message: "the viewer's rail is eight live previews" });
  // The product is time-based here: a capture starts SETTLE_MS after the frame loads. Three settles is the window
  // in which an editor's browser posted its cover in every exploratory run (owner: about 2.5 s after load).
  await new Promise((r) => setTimeout(r, 3 * SETTLE_MS));
  assert.deepEqual(thumbPosts(vWatch), [], "the viewer, who may not edit, posted no thumbnail while capture was owed");

  ctx.step("the owner opens Q: one cover POST, then one slides POST of eight, both 200");
  await openDeck(o, docId);
  const posts = await eventually(() => {
    const p = thumbPosts(oWatch, docId);
    return p.length >= 2 && p.every((x) => x.status !== null) ? p : false;
  }, { timeout: 60_000, interval: 250, message: "the owner's two thumbnail POSTs finished" });
  const rec = await eventually(async () => {
    const r = await readDoc(target, `docs/${docId}`);
    return r?.thumb?.cover && r?.thumb?.slides ? r : false;
  }, { timeout: 20_000, interval: 250, message: "the record names both kinds" });
  await new Promise((r) => setTimeout(r, SETTLE_MS)); // a duplicate would have to come after the record changed; give it one settle
  const allPosts = thumbPosts(oWatch, docId);
  assert.deepEqual(
    allPosts.map((x) => ({ kind: x.kind, v: x.v, r: x.r, images: x.sizes.length, status: x.status })),
    [{ kind: "cover", v: "v1", r: String(REV), images: 1, status: 200 }, { kind: "slides", v: "v1", r: String(REV), images: 8, status: 200 }],
    "the cover first, then the slides, once each",
  );
  assert.equal(allPosts[1].sizes[0], allPosts[0].sizes[0], "the deck's cover is its first slide: the same image, so the same size");
  ctx.ev.json("posts", posts);

  ctx.step("the record: exactly {versionId, rev, cover, slides:{key, count}} with server-minted keys, and updatedAt untouched");
  assert.deepEqual(Object.keys(rec.thumb).sort(), ["cover", "rev", "slides", "versionId"], "thumb's keys");
  assert.deepEqual(
    { versionId: rec.thumb.versionId, rev: rec.thumb.rev, cover: /^[0-9a-f]{16}$/.test(rec.thumb.cover), slideKeys: Object.keys(rec.thumb.slides).sort(), key: /^[0-9a-f]{16}$/.test(rec.thumb.slides.key), count: rec.thumb.slides.count },
    { versionId: "v1", rev: REV, cover: true, slideKeys: ["count", "key"], key: true, count: 8 },
    "the thumb record",
  );
  assert.ok(rec.updatedAt.isEqual(rec0.updatedAt), `updatedAt is untouched by the thumbnails: ${rec0.updatedAt.toDate().toISOString()} → ${rec.updatedAt.toDate().toISOString()}`);

  ctx.step("the stored cover is byte-identical to slide one's image, and both are 16:9 (the fixed stage, whoever captured)");
  const { key } = rec.thumb.slides;
  const coverPath = `/thumb/${encodeURIComponent(docId)}/v1/${rec.thumb.cover}/cover.jpg`;
  const slidePath = (i) => `/thumb/${encodeURIComponent(docId)}/v1/${key}/s${i}.jpg`;
  const cover = await owner.http.get(coverPath, { expect: 200 });
  const s0 = await owner.http.get(slidePath(0), { expect: 200 });
  assert.ok(cover.buffer.equals(s0.buffer), "cover.jpg and s0.jpg are the same bytes");
  const size = jpegSize(cover.buffer);
  precondition(size, "the stored cover is a JPEG with a frame header");
  assert.ok(Math.abs(size.width / size.height - 16 / 9) < 0.01 && size.width <= 1280, `the cover is 16:9 and at most 1280 px wide: ${size.width}×${size.height}`);

  ctx.step("the viewer opens Q again: the rail is eight <img src=/thumb/…> in slot order and no live preview; the overview uses the same images");
  const before = v.log.requests.length;
  const vs2 = await openDeck(v, docId);
  precondition(vs2.rail === 8, "the viewer's rail has eight slides");
  const want = Array.from({ length: 8 }, (_, i) => slidePath(i));
  const rail = await eventually(() => v.page.evaluate(() => ({
    imgs: Array.from(document.querySelectorAll(".slide-rail .slide-thumb img.slide-thumb-image")).map((i) => i.getAttribute("src")),
    frames: document.querySelectorAll(".slide-rail iframe.slide-thumb-frame").length,
  })), { timeout: 10_000, interval: 200, stableSamples: 3, message: "the viewer's rail steady" });
  assert.deepEqual(rail, { imgs: want, frames: 0 }, "the rail shows the stored images, not live previews");
  await eventually(() => v.page.evaluate(() => {
    const img = document.querySelector(".slide-rail .slide-thumb img.slide-thumb-image");
    return Boolean(img && img.complete && img.naturalWidth > 0);
  }), { timeout: 10_000, message: "the first stored image rendered" });
  const vGets = v.log.requests.slice(before).filter((r) => r.method === "GET" && pathOf(r.url).startsWith(`/thumb/${encodeURIComponent(docId)}/`));
  assert.ok(vGets.length >= 1 && vGets.every((r) => r.status === 200), `the viewer's page fetched its rail from /thumb with 200: ${JSON.stringify(vGets.map((r) => [pathOf(r.url), r.status]))}`);
  await focusParent(v);
  await v.page.keyboard.press("o");
  const overview = await eventually(() => v.page.evaluate(() => {
    // Opening is independent of the image renderer: a live-preview regression
    // must reach the stored-image assertion rather than masquerade as no modal.
    if (!document.querySelector(".slide-overview")) return false;
    const imgs = Array.from(document.querySelectorAll(".slide-overview .slide-overview-item img.slide-thumb-image")).map((i) => i.getAttribute("src"));
    return { imgs, frames: document.querySelectorAll(".slide-overview iframe.slide-thumb-frame").length };
  }), { timeout: 5_000, message: "the overview opened" });
  assert.deepEqual(overview, { imgs: want, frames: 0 }, "the overview shows the same stored images");
  assert.deepEqual(thumbPosts(vWatch), [], "the viewer still posted nothing");

  ctx.step(`each image as the viewer reads it over HTTP: 200 image/jpeg, private, max-age=${CACHE_S}, immutable`);
  const vSession = await signIn(ctx, vAcct);
  for (let i = 0; i < 8; i++) {
    const r = await vSession.http.get(slidePath(i));
    assert.deepEqual({ i, status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control") }, { i, status: 200, type: "image/jpeg", cache: `private, max-age=${CACHE_S}, immutable` }, `the viewer's read of s${i}.jpg`);
  }

  ctx.step("a signed-in stranger and an anonymous reader: the same 404 as an absent document, headers (Date aside) and bytes");
  const stranger = await signIn(ctx, sAcct);
  const anon = ctx.http({ actor: "anonymous", cutoffError: true });
  const absent = absentDocId(target, "a164-absent");
  for (const [who, http] of [["stranger", stranger.http], ["anonymous", anon]]) {
    for (const [name, rel] of [["s0", `${key}/s0.jpg`], ["cover", `${rec.thumb.cover}/cover.jpg`]]) {
      const real = await http.get(`/thumb/${encodeURIComponent(docId)}/v1/${rel}`);
      const none = await http.get(`/thumb/${encodeURIComponent(absent)}/v1/${rel}`);
      const same = sameHeadersExceptDate(real, none);
      assert.deepEqual(
        { status: real.status, headers: same.equal ? "equal" : same.diff, bytes: real.buffer.equals(none.buffer) },
        { status: 404, headers: "equal", bytes: true },
        `${who} ${name}: the member-only image answers exactly as an absent document's (absent: ${none.status})`,
      );
    }
  }
  oWatch.stop();
  vWatch.stop();
  noPageErrors([o, v]);
});

// --- A16.5 ----------------------------------------------------------------------

scenario("A16.5 POST /thumb refuses an r other than the deployment's, a version that is not current, a non-JPEG, 160 KiB + 1, 1281 px and 101 slides, each writing nothing; exactly 160 KiB at 1280x720 and exactly 100 slides are stored", {
  tiers: ["local", "prod"],
  timeoutMs: 300_000,
  ...STALLS,
}, async (ctx) => {
  const REV = Number(treeConstant(target, "functions/src/lib/thumbs.ts", "THUMB_REVISION"));
  const MAX_SLIDES = Number(treeConstant(target, "functions/src/lib/thumbs.ts", "THUMB_MAX_SLIDES"));
  const MAX_SIDE = Number(treeConstant(target, "functions/src/lib/thumbs.ts", "THUMB_MAX_SIDE"));
  const MAX_BYTES = 160 * 1024; // SPEC §2: "at most 160 KiB"
  precondition(MAX_SLIDES === 100 && MAX_SIDE === 1280, `the tree's limits are SPEC §2's: ${MAX_SLIDES} slides, ${MAX_SIDE} px`);

  ctx.step("cast an owner; publish a document and update it, so v2 is current and v1 is not");
  const { owner } = await castWithOwner(ctx, []);
  const docId = (await publish(owner.http, { body: sectionsDoc({ n: 3, minHeight: "100vh" }), filename: "index.html", title: `Thumb refusals ${tag()}`, name: "a165", patient: { ctx, stopAt: "budget" } })).docId;
  const isV2 = async () => (await readDoc(target, `docs/${docId}`))?.currentVersion === "v2";
  const { out: up } = await untilLanded(ctx, `POST /publish?update=${docId}`, () => updateUpload(owner.http, docId, { body: sectionsDoc({ n: 4, minHeight: "100vh" }), baseVersion: "v1" }), isV2, { stopAt: "budget" });
  precondition((up === null || up.status === 200) && (await isV2()), `the update made v2 current: ${up?.status ?? "landed"} ${JSON.stringify(up?.json ?? null)}`);

  const tiny = jpeg();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108020000009077" + "53de0000000c4944415408d763f8ffff3f0005fe02fea7d6a4ae0000000049454e44ae426082", "hex");
  // Each row sits one unit past the limit it names. Its negative control (a spec mutation, scratch only) moves
  // that one input back inside, which is the 200 and the write a product whose limit had moved would give, and
  // must turn the row red; so must a cover stored before the rows, and either accepted limit pushed one past.
  const rows = [
    ["r one below the deployment's", { doc: docId, v: "v2", kind: "cover", images: [tiny], r: REV - 1 }, 409, "captured by an older version of the app"],
    ["r one above the deployment's", { doc: docId, v: "v2", kind: "cover", images: [tiny], r: REV + 1 }, 409, "captured by an older version of the app"],
    ["no r at all", { doc: docId, v: "v2", kind: "cover", images: [tiny] }, 409, "captured by an older version of the app"],
    ["a version that is not current", { doc: docId, v: "v1", kind: "cover", images: [tiny], r: REV }, 409, "not the current version"],
    ["two images for one cover", { doc: docId, v: "v2", kind: "cover", images: [tiny, tiny], r: REV }, 400, "a cover is one image"],
    ["a PNG", { doc: docId, v: "v2", kind: "cover", images: [png], r: REV }, 400, "not a JPEG"],
    [`a JPEG of ${MAX_BYTES + 1} bytes`, { doc: docId, v: "v2", kind: "cover", images: [jpeg({ width: 1280, height: 720, total: MAX_BYTES + 1 })], r: REV }, 400, "image too large"],
    [`a JPEG ${MAX_SIDE + 1} px wide`, { doc: docId, v: "v2", kind: "cover", images: [jpeg({ width: MAX_SIDE + 1, height: 720 })], r: REV }, 400, "image too large"],
    [`${MAX_SIDE + 1} px tall`, { doc: docId, v: "v2", kind: "slides", images: [tiny, jpeg({ width: 16, height: MAX_SIDE + 1 })], r: REV }, 400, "image too large"],
    [`${MAX_SLIDES + 1} slides`, { doc: docId, v: "v2", kind: "slides", images: Array.from({ length: MAX_SLIDES + 1 }, () => tiny), r: REV }, 400, null],
  ];
  const got = [];
  for (const [what, req, status, error] of rows) {
    const r = await postThumb(owner.http, req);
    const thumb = (await readDoc(target, `docs/${docId}`))?.thumb ?? null;
    got.push({ what, status: r.status, error: error === null ? (typeof r.json?.error === "string" && /slides|sizes/.test(r.json.error) ? "about the slide count" : r.json?.error ?? r.text.slice(0, 80)) : r.json?.error ?? r.text.slice(0, 80), thumb });
    ctx.step(`${what}: ${r.status} ${r.text.slice(0, 120)}`);
  }
  assert.deepEqual(
    got,
    rows.map(([what, , status, error]) => ({ what, status, error: error ?? "about the slide count", thumb: null })),
    "every refusal, its answer, and no thumb on the record after it",
  );
  assert.deepEqual(await listObjects(target, `docs/${docId}/thumbs/`), [], "no refusal left an object in Storage");

  ctx.step(`the limits themselves are accepted: a cover of exactly ${MAX_BYTES} bytes at 1280x720, and exactly ${MAX_SLIDES} slides`);
  const atLimit = jpeg({ width: 1280, height: 720, total: MAX_BYTES });
  const c = await postThumb(owner.http, { doc: docId, v: "v2", kind: "cover", images: [atLimit], r: REV });
  assert.deepEqual({ status: c.status, json: c.json }, { status: 200, json: { stored: true } }, "a cover at exactly 160 KiB and 1280 px is stored");
  const s = await postThumb(owner.http, { doc: docId, v: "v2", kind: "slides", images: Array.from({ length: MAX_SLIDES }, () => tiny), r: REV });
  assert.deepEqual({ status: s.status, json: s.json }, { status: 200, json: { stored: true } }, `${MAX_SLIDES} slides are stored`);
  const thumb = (await readDoc(target, `docs/${docId}`))?.thumb;
  assert.deepEqual({ versionId: thumb?.versionId, rev: thumb?.rev, cover: typeof thumb?.cover, count: thumb?.slides?.count }, { versionId: "v2", rev: REV, cover: "string", count: MAX_SLIDES }, "the record names both");
  const objects = await listObjects(target, `docs/${docId}/thumbs/v2/`);
  assert.equal(objects.length, 1 + MAX_SLIDES, `one cover and ${MAX_SLIDES} slide objects under thumbs/v2/`);
  const stored = await owner.http.get(`/thumb/${encodeURIComponent(docId)}/v2/${thumb.cover}/cover.jpg`, { expect: 200 });
  assert.ok(stored.buffer.equals(atLimit), "the stored cover is the uploaded bytes");
});
