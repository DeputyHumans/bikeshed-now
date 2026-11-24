// SPDX-License-Identifier: Apache-2.0
// Slide thumbnails take the shape of the slides' content, whatever window the deck is read in (SPEC §6d).

/**
 * Three synthetic decks, one per shape `deckShape` tells apart:
 *
 *   LETTERBOX  trusted, every slide `position:absolute; inset:0` holding a
 *              80rem×45rem stage, the root font sized min(100vw/80, 100vh/45),
 *              as the deck that showed the fault does: a window of any shape
 *              letterboxes a 16:9 stage.
 *   CV         three A4 pages, 794×1123 px, flowing down a grey page.
 *   FLUID      four sections, each 100vh, their text reflowing in them.
 *
 *   A30.1  a letterboxed deck in a desktop frame the panels narrowed: 16:9
 *          thumbnails, the stage filling each.
 *   A30.2  the same deck on a phone: 16:9 thumbnails in the drawer.
 *   A30.3  a CV: portrait thumbnails, in the page's own shape.
 *   A30.4  a fluid deck: 16:9, whatever the frame.
 *   A30.5  a CV's stored images are portrait too, cropped to the page.
 *
 * Before the change every thumbnail took the shape of the reader's frame, and
 * A30.1-5 fail on such a build.
 */

import assert from "node:assert/strict";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { publish, publishZip } from "../../lib/seed.mjs";
import { readDoc, trustAsOperator } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { treeConstant } from "../../lib/target.mjs";

const target = currentTarget();
const CASE_MS = 300_000;
export const E2E_FILE_TIMEOUT_MS = 8 * CASE_MS;
const ON_STACK = Object.freeze({ inconclusiveOnRequestStall: true, inconclusiveOnHttpStall: true });
const UI_MS = 30_000;
/** How far a thumbnail's shape may be from its content's, as a share of the ratio. */
const TOLERANCE = 0.03;

const LETTERBOX = {
  "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Letterbox</title>
<script>document.documentElement.className+=' js';</script><link rel="stylesheet" href="style.css"></head>
<body><main class="deck">${[1, 2, 3, 4, 5, 6].map((n) => `<section class="slide" id="slide-${n}"><div class="stage"><h2>Slide ${n}</h2><p>Words of slide ${n}.</p></div></section>`).join("")}</main><script src="app.js"></script></body></html>`,
  "style.css": `html{font-size:min(calc(100vw / 80), calc(100vh / 45))}
body{margin:0;background:#1c1f24;overflow:hidden;font-family:sans-serif}
.deck{position:relative;width:100vw;height:100vh;overflow:hidden}
.slide{position:absolute;inset:0;display:grid;place-items:center;visibility:hidden}
.slide.is-active{visibility:visible}
.stage{width:80rem;height:45rem;box-sizing:border-box;padding:3rem;background:#fff;color:#111;display:grid;align-content:center;gap:1rem}
h2{font-size:4rem;margin:0}p{font-size:2rem;margin:0}`,
  "app.js": `(function(){
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide')), i = 0;
  function show(n){ n = Math.max(0, Math.min(slides.length - 1, n)); slides.forEach(function(s){ s.classList.remove('is-active'); }); slides[n].classList.add('is-active'); i = n; }
  document.addEventListener('keydown', function(e){
    if (e.key === 'ArrowRight'){ show(i + 1); e.preventDefault(); } else if (e.key === 'ArrowLeft'){ show(i - 1); e.preventDefault(); }
  });
  show(0);
})();`,
};

const CV = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CV</title><style>
body{margin:0;background:#d8d8d8;font-family:serif}
.page{width:794px;height:1123px;margin:0 auto 24px;box-sizing:border-box;padding:56px;background:#fff;color:#111}
h2{margin:0 0 16px}p{margin:0 0 12px}
</style></head><body>${[1, 2, 3].map((n) => `<section class="page" id="page-${n}"><h2>Page ${n}</h2><p>Experience, education and skills.</p><p>More of page ${n}.</p></section>`).join("")}</body></html>`;

const FLUID = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fluid</title><style>
body{margin:0;font-family:sans-serif}
.slide{height:100vh;box-sizing:border-box;padding:6vh 8vw;display:flex;flex-direction:column;justify-content:center;gap:2vh;background:#fffbe8}
h2{margin:0;font-size:6vh}p{margin:0;font-size:3vh}
</style></head><body>${[1, 2, 3, 4].map((n) => `<section class="slide"><h2>Fluid ${n}</h2><p>Words that reflow with the window.</p><p>Another line on slide ${n}.</p></section>`).join("")}</body></html>`;

/** An owner who publishes one deck and reads it, on a device of the case's choosing. */
async function deckOn(ctx, { deck, device = null, name }) {
  const [account] = await cast(target, ["owner"], { notifications: false });
  const session = await openSession(target, account);
  const title = `A30 ${name} ${runTag(target.runId)}-${rand4()}`;
  const up = typeof deck === "string"
    ? await publish(session.http, { body: deck, filename: "index.html", title, name: `a30-${name}` })
    : await publishZip(session.http, deck, { title, name: `a30-${name}` });
  precondition(up.status === 200, `published ${name}: ${up.status} ${JSON.stringify(up.json)?.slice(0, 200)}`);
  if (deck === LETTERBOX) await trustAsOperator(target, up.docId);
  const u = await ctx.users.user({ name, device });
  const s = await u.signInUi(account.email, account.password);
  precondition(s.status === "ok", `${name} signed in`);
  await u.open(up.docId);
  return { u, docId: up.docId };
}

/** The rail's thumbnails as laid out: each box, and whether its preview has painted. */
async function railBoxes(u) {
  return u.page.evaluate(() => Array.from(document.querySelectorAll(".slide-rail .slide-thumb-box")).map((b) => {
    const r = b.getBoundingClientRect();
    return { width: r.width, height: r.height, painted: Boolean(b.querySelector("[data-painted]")) };
  }));
}

/** Wait for the rail, then its first thumbnail painted; its box's width over height. */
async function firstThumbRatio(u) {
  await u.page.locator(".slide-rail").waitFor({ state: "visible", timeout: UI_MS });
  const [first] = await eventually(async () => {
    const boxes = await railBoxes(u);
    return boxes.length > 0 && boxes[0].painted && boxes[0].width > 0 ? boxes : false;
  }, { timeout: UI_MS, message: "the rail's first thumbnail has painted" });
  return first.width / first.height;
}

/** Where the first painted thumbnail draws `selector` of its preview, in its box's coordinates. */
async function drawnInThumb(u, selector) {
  return u.page.evaluate((sel) => {
    const frame = document.querySelector(".slide-rail iframe.slide-thumb-frame[data-painted]");
    const el = frame?.contentDocument?.querySelector(sel);
    const m = frame && /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(frame.style.transform);
    if (!frame || !el || !m) return null;
    const [x, y, s] = m.slice(1).map(Number);
    const r = el.getBoundingClientRect();
    const box = frame.parentElement.getBoundingClientRect();
    return { left: r.left * s + x, top: r.top * s + y, width: r.width * s, height: r.height * s, boxWidth: box.width, boxHeight: box.height };
  }, selector);
}

/** The shape of the window the document is laid out in, inside the frame: what the thumbnails must not take. */
const frameRatio = async (u) => (await u.frame()).evaluate(() => (innerHeight > 0 ? innerWidth / innerHeight : null));

function near(actual, expected, what) {
  assert.ok(Math.abs(actual - expected) / expected <= TOLERANCE, `${what}: ${actual.toFixed(3)}, expected ${expected.toFixed(3)} (±${TOLERANCE * 100} %)`);
}

scenario("A30.1 a letterboxed deck in a desktop frame the panels narrowed shows 16:9 thumbnails, its stage filling each", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  // A squarer desktop window: a frame far from 16:9 from the moment the deck
  // loads, when a thumbnail's shape is decided, and narrower once the comments open.
  const { u } = await deckOn(ctx, { deck: LETTERBOX, name: "letterbox", device: { width: 1100, height: 1000 } });
  await u.openComments();
  const frame = await frameRatio(u);
  ctx.step(`the frame is ${frame?.toFixed(3)} wide for each unit of height`);
  precondition(frame !== null && Math.abs(frame - 16 / 9) > 0.25, `the frame is not 16:9, so its shape and the slide's differ (${frame})`);
  near(await firstThumbRatio(u), 16 / 9, "the thumbnail's shape");
  const stage = await drawnInThumb(u, ".stage");
  ctx.step(`the stage in its thumbnail: ${JSON.stringify(stage)}`);
  assert.ok(stage, "the thumbnail draws the stage, translated and scaled to it");
  for (const [k, want] of [["left", 0], ["top", 0], ["width", stage.boxWidth], ["height", stage.boxHeight]]) {
    assert.ok(Math.abs(stage[k] - want) <= 2, `the stage fills its thumbnail: ${k} ${stage[k].toFixed(1)}, expected ${want.toFixed(1)}`);
  }
});

scenario("A30.2 the same deck on a phone shows 16:9 thumbnails in the slide list's drawer", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { u } = await deckOn(ctx, { deck: LETTERBOX, name: "phone", device: { width: 390, height: 844, touch: true } });
  await u.page.getByRole("button", { name: "Slides", exact: true }).click();
  near(await firstThumbRatio(u), 16 / 9, "the thumbnail's shape on a phone");
});

scenario("A30.3 a CV's A4 pages show portrait thumbnails, in the page's own shape", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  // A window tall enough that a page is about a screen, so the document pages and has a slide list.
  const { u } = await deckOn(ctx, { deck: CV, name: "cv", device: { width: 1280, height: 1400 } });
  near(await firstThumbRatio(u), 794 / 1123, "the thumbnail's shape");
});

scenario("A30.4 a fluid deck, whose slides fill the window and reflow, shows 16:9 thumbnails, whatever the frame", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const { u } = await deckOn(ctx, { deck: FLUID, name: "fluid", device: { width: 1100, height: 1000 } });
  const frame = await frameRatio(u);
  ctx.step(`the frame lays the document out ${frame?.toFixed(3)} wide for each unit of height`);
  precondition(frame !== null && Math.abs(frame - 16 / 9) > 0.15, `the frame is not 16:9 (${frame})`);
  near(await firstThumbRatio(u), 16 / 9, "the thumbnail's shape");
});

scenario("A30.5 a CV's stored images are portrait too, cropped to the page", { tiers: ["local"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const REV = Number(treeConstant(target, "functions/src/lib/thumbs.ts", "THUMB_REVISION"));
  const { u, docId } = await deckOn(ctx, { deck: CV, name: "cv-stored", device: { width: 1280, height: 1400 } });
  await u.page.locator(".slide-rail").waitFor({ state: "visible", timeout: UI_MS });
  // The owner may edit, so their browser captures the version's images once it settles.
  const rec = await eventually(async () => {
    const r = await readDoc(target, `docs/${docId}`);
    return r?.thumb?.slides ? r : false;
  }, { timeout: 90_000, interval: 500, message: "the owner's browser stored the slide images" });
  assert.equal(rec.thumb.rev, REV, "stored by this capture");
  await u.page.reload();
  const images = await eventually(async () => {
    const shapes = await u.page.evaluate(() => Array.from(document.querySelectorAll(".slide-rail img.slide-thumb-image[data-painted]")).map((i) => ({ w: i.naturalWidth, h: i.naturalHeight })));
    return shapes.length === 3 ? shapes : false;
  }, { timeout: UI_MS, message: "the rail shows the three stored images" });
  ctx.step(`stored image sizes: ${JSON.stringify(images)}`);
  for (const [i, img] of images.entries()) near(img.w / img.h, 794 / 1123, `stored image ${i + 1}'s shape`);
  near(await firstThumbRatio(u), 794 / 1123, "the thumbnail's shape");
});
