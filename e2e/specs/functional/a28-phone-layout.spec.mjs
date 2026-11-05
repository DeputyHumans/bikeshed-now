// SPDX-License-Identifier: Apache-2.0
// A28 a phone at every width: nothing overlaps, nothing runs off the screen, nothing is cut, and the document keeps the screen (SPEC §7).

/**
 * Catalogue A28. A24's phone is one width, 400 px, which sits just below the
 * tier that hides what used to break: every real iPhone Pro is 402. So the same
 * surfaces walk here at fourteen sizes, portrait and landscape, on a touch
 * device, each loaded afresh at its width because a media hook reads its first
 * render. One shared measurement, and one named judge per kind of defect, so a
 * red case names what is wrong and where.
 *
 *   A28.0  every surface was reached at every size
 *   A28.1  nothing scrolls sideways
 *   A28.2  no two controls in one layer overlap
 *   A28.3  no control runs off the screen or is cut by its box
 *   A28.4  no icon or logo is flexed below its declared size
 *   A28.5  every text field and select is at least 16 px, so iOS does not zoom
 *   A28.6  words a box cuts carry an ellipsis
 *   A28.7  every control keeps a 44×44 hit area
 *   A28.8  an open menu lies wholly on the screen
 *   A28.9  on a phone, the bars above a document take at most two rows
 *   A28.10 someone else in the document adds one row, and is named in it
 *   A28.11 a deck opens on its slide; the drawer opens on request and gets out of the way
 *   A28.12 a reader gets from a document to the folder holding it in two taps
 *   A28.13 in one column the comments pane is left by the toggle, never to a blank screen
 *   A28.14 a comment started signed out is on its passage after signing in
 *   A28.15 the bars leave on the way down and return on the way up, the frame really
 *          grows, the bottom does not flicker, and the document's bytes do not change
 *   A28.16 they stay where a reader needs them: a short document, a deck, the
 *          comments pane, a selection, an open menu; and focus brings them back
 *   A28.17 a new version brings them back to say so
 *   A28.18 a tap beside the folder drawer closes it, and so does going somewhere
 *
 * Set A28_SCREENSHOTS to a directory to keep a picture of every surface at every
 * size, which is how a layout is looked at rather than only measured. Set A28_SIZES
 * to a comma-separated list such as 402x874,320x640 to walk only those, which is what
 * makes a negative control on this file affordable.
 *
 * Only e2e/lib/ talks to the stack. Every account is cast with notifications off.
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after } from "node:test";
import { inspectUi } from "../../lib/accessibility.mjs";
import { eventually } from "../../lib/assert.mjs";
import { docFrame, setSelection } from "../../lib/frame.mjs";
import { sharedMeasurement } from "../../lib/shared-measurement.mjs";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { browserSession, mintToken } from "../../lib/session.mjs";
import { createFolder, publish, readSample, updateUpload } from "../../lib/seed.mjs";
import { share } from "../../lib/grant.mjs";
import { closeAdmin } from "../../lib/admin.mjs";
import { authorizeParams, pkce, register } from "../../lib/oauth.mjs";

// Shared option objects are opaque to the static budget scanner; cover the walk and its judges.
const E2E_FILE_TIMEOUT_MS = 60 * 60_000;

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const LISTEN_MS = 90_000;
const DAY = 86_400_000;
const shots = process.env.A28_SCREENSHOTS || null;
if (shots) mkdirSync(shots, { recursive: true });

/** Width by height. 402 is every current iPhone Pro; 320 the narrowest anyone still carries; 601 the first size that is no longer a phone. */
const ALL_SIZES = [
  [320, 640], [360, 740], [375, 667], [390, 844], [402, 874], [430, 932], [440, 956], [480, 800], [600, 900], [601, 900], [768, 1024], [820, 1180],
  [844, 390], [932, 430],
].map(([width, height]) => Object.freeze({ width, height, name: `${width}x${height}` }));
const CHOSEN = process.env.A28_SIZES ? process.env.A28_SIZES.split(",") : null;
const SIZES = Object.freeze(ALL_SIZES.filter((size) => !CHOSEN || CHOSEN.includes(size.name)));

/** Entering the editor is slow, and editing keeps its layout: these sizes are enough to see it does not regress. */
const EDITOR_SIZES = new Set(["320x640", "402x874", "600x900", "844x390"]);

const TITLE = "Tomer Ullman · An intelligence profile for the Stanford colloquium";
const MARKERS = Array.from({ length: 30 }, (_, i) => `marker-${i + 1}`);

function longHtml(title) {
  const paras = MARKERS.map((w, i) => `<p id="m-${i + 1}">Paragraph ${i + 1} speaks of ${w} and then goes on for a while so that it wraps across more than one line of the reading column, which keeps the document long enough to scroll.</p>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.6}</style>
</head>
<body>
<h1 id="m-title">${title}</h1>
${paras}
</body>
</html>
`;
}

/** Page-level geometry; inspectUi checks the nested scrollports. */
function measurePageInPage() {
  const de = document.documentElement;
  const before = window.scrollX;
  window.scrollTo(100000, window.scrollY);
  const scrolledX = window.scrollX;
  window.scrollTo(before, window.scrollY);
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) };
  };
  return {
    clientWidth: de.clientWidth,
    viewHeight: window.innerHeight,
    scrollWidth: Math.max(de.scrollWidth, document.body.scrollWidth),
    scrolledX,
    frame: box(document.querySelector("iframe.doc-frame")),
    menu: box(document.querySelector(".menu")),
  };
}

/** Two animation frames and a beat, so a transition has settled before anything is read. */
const settle = (page) => page.evaluate(() => new Promise((r) => {
  const fallback = setTimeout(r, 500);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    clearTimeout(fallback);
    setTimeout(r, 120);
  }));
}));

/** What the walk measured, for its judges: one row per surface per size. */
const walk = { rows: null };

async function seed(ctx, n) {
  const t = `${runTag(target.runId)}${rand4()}`;
  const accounts = await cast(target, ["owner", "reader"], { notifications: false });
  const device = { width: 402, height: 874, touch: true };
  const owner = await ctx.users.user({ name: `owner-${n}`, device, consent: "denied" });
  await owner.signInUi(accounts[0].email, accounts[0].password);
  const reader = await ctx.users.user({ name: `reader-${n}`, device, consent: "denied" });
  await reader.signInUi(accounts[1].email, accounts[1].password);
  const anon = await ctx.users.user({ name: `anon-${n}`, device, consent: "denied" });
  const visitor = await ctx.users.user({ name: `visitor-${n}`, device });
  const session = await browserSession(owner, { account: accounts[0], cutoffError: true });

  const pub = async (name, body, filename, title) => {
    const up = await publish(session.http, { body, filename, title: `${title} ${t}`, name: `a28-${name}`, ownerEmail: accounts[0].email });
    precondition(up.status === 200, `publish ${name}: ${up.status} ${JSON.stringify(up.json)}`);
    return up.docId;
  };
  const folder = await createFolder(session.http, { name: `A folder with a long enough name to matter ${t}`, ownerEmail: accounts[0].email });
  precondition(folder.status === 200 && folder.folderId, `POST /folder: ${folder.status}`);

  const doc = await pub("doc", longHtml(TITLE), "index.html", TITLE);
  const deckSample = readSample(target, "deck-quarter-review");
  const deck = await pub("deck", deckSample.bytes, deckSample.filename, deckSample.title);
  const filed = await pub("filed", longHtml(`Filed in a folder ${t}`), "index.html", "Filed in a folder");
  const trashed = await pub("trashed", longHtml(`Thrown away ${t}`), "index.html", "A document on its way out with a long title");
  const public_ = await pub("public", longHtml(`Open to anyone ${t}`), "index.html", "Open to anyone");

  const post = async (path, body, what) => {
    const r = await session.http.postJson(path, body);
    precondition(r.status === 200, `${what}: ${r.status} ${r.text?.slice(0, 200)}`);
    return r.json;
  };
  // A date within the week escalates its chip, which is the one that stays in view on a phone.
  await post("/visibility", { docId: doc, visibility: "private", publicEdit: false, expiresAt: Date.now() + 3 * DAY }, "the expiry");
  await post("/visibility", { docId: public_, visibility: "public", publicEdit: false, expiresAt: null }, "public");
  await post("/organize", { kind: "doc", id: filed, op: "move", targetFolderId: folder.folderId }, "file a document");
  await post("/organize", { kind: "doc", id: trashed, op: "trash" }, "trash");
  const link = await post("/visibility", { folderId: folder.folderId, visibility: "unlisted", expiresAt: null }, "the folder link");
  precondition(typeof link.linkToken === "string", `folder link token: ${link.linkToken}`);

  await share(target, { owner: session, doc, account: accounts[1], role: "viewer" });
  await share(target, { owner: session, doc: deck, account: accounts[1], role: "viewer" });

  const { token } = await mintToken(session, { name: `e2e a28 ${t}`, channel: "mcp" });
  const mcp = ctx.mcp({ token, actor: "owner-mcp" });
  await mcp.initialize();
  const said = await mcp.call("add_comment", { id: doc, exact: "Paragraph 2 speaks", body: `A thread to read at every width ${t}` });
  precondition(!said.isError, `add_comment: ${said.text?.slice(0, 200)}`);

  const redirectUri = "http://127.0.0.1/a28-callback";
  const reg = await register(ctx.http({ actor: "oauth-app", cutoffError: true }), { redirectUris: [redirectUri], clientName: `E2E A28 app ${t}` });
  precondition(reg.status === 201 && reg.clientId, `registration: ${reg.status}`);
  const connect = new URLSearchParams(authorizeParams({ clientId: reg.clientId, redirectUri, challenge: pkce().challenge }));

  return { owner, reader, anon, visitor, doc, deck, public_, folderId: folder.folderId, linkKey: link.linkToken, connect };
}

/** Every surface: its user, how to reach it from a fresh load, and what says it is ready. */
function surfaces(s) {
  const heading = (u, name) => u.page.getByRole("heading", { name, level: 1 });
  const button = (u, name, within = u.page) => within.getByRole("button", { name, exact: true });
  const pane = (u, name) => u.page.locator(".pane-toggle button", { hasText: name });
  const dialog = (u, name) => u.page.getByRole("dialog", { name });
  const openDoc = (u, id) => u.open(id, { timeout: LISTEN_MS });
  const list = [
    { name: "landing", u: s.anon, go: (u) => u.goto("/"), ready: (u) => u.page.locator("main h1") },
    // Only a stack built with a measurement id asks: --app-env VITE_FIREBASE_MEASUREMENT_ID=dummy.
    { name: "landing-consent", u: s.visitor, optional: true, go: (u) => u.goto("/"), ready: (u) => u.page.locator(".consent") },
    { name: "sign-in", u: s.anon, go: (u) => u.goto("/signup"), ready: (u) => u.page.locator("#auth-email") },
    { name: "privacy", u: s.anon, go: (u) => u.goto("/privacy"), ready: (u) => heading(u, "Privacy policy") },
    { name: "terms", u: s.anon, go: (u) => u.goto("/terms"), ready: (u) => u.page.locator(".legal h1") },
    { name: "shared-folder-signed-out", u: s.anon, go: (u) => u.goto(`/folder/${encodeURIComponent(s.folderId)}?k=${encodeURIComponent(s.linkKey)}`), ready: (u) => u.page.locator(".shared-folder") },
    { name: "public-document", u: s.anon, go: (u) => openDoc(u, s.public_), ready: (u) => u.page.locator("iframe.doc-frame") },
    { name: "connect", u: s.owner, go: (u) => u.goto(`/connect?${s.connect}`), ready: (u) => button(u, "Cancel") },
    { name: "recent", u: s.owner, go: (u) => u.goto("/"), ready: (u) => button(u, "Upload") },
    { name: "upload-dialog", u: s.owner, go: async (u) => { await u.goto("/"); await button(u, "Upload").click(); }, ready: (u) => dialog(u, "Upload a document") },
    { name: "everything", u: s.owner, go: (u) => u.goto("/everything"), ready: (u) => button(u, "Upload") },
    { name: "everything-list", u: s.owner, go: async (u) => { await u.goto("/everything"); await u.page.getByTitle("List", { exact: true }).click(); }, ready: (u) => u.page.locator(".doc-table") },
    { name: "shared", u: s.reader, go: (u) => u.goto("/shared"), ready: (u) => u.page.locator("main h1, main h2").first() },
    { name: "folder", u: s.owner, go: (u) => u.goto(`/folder/${encodeURIComponent(s.folderId)}`), ready: (u) => button(u, "Folder actions") },
    // In a drawer at or below 860 px, and beside the list above it.
    { name: "folder-drawer", u: s.owner, go: async (u) => { await u.goto("/everything"); await button(u, "Upload").waitFor({ state: "visible", timeout: LISTEN_MS }); const open = u.page.getByRole("button", { name: "Folders" }); if (await open.isVisible()) await open.click(); }, ready: (u) => u.page.locator(".folder-rail") },
    { name: "trash", u: s.owner, go: (u) => u.goto("/trash"), ready: (u) => u.page.locator(".trash-name").first() },
    { name: "account", u: s.owner, go: (u) => u.goto("/account"), ready: (u) => heading(u, "Account") },
    { name: "document-owner", u: s.owner, go: (u) => openDoc(u, s.doc), ready: (u) => u.page.locator("iframe.doc-frame") },
    { name: "document-reader", u: s.reader, go: (u) => openDoc(u, s.doc), ready: (u) => u.page.locator("iframe.doc-frame") },
    // Beside the document above 860 px, and behind the toggle at or below it.
    { name: "comments", u: s.owner, go: async (u) => { await openDoc(u, s.doc); if (await pane(u, "Comments").isVisible()) await pane(u, "Comments").click(); }, ready: (u) => u.page.locator(".comments-panel .thread") },
    { name: "more-menu", u: s.owner, go: async (u) => { await openDoc(u, s.doc); await button(u, "More actions").click(); }, ready: (u) => u.page.locator(".menu") },
    { name: "share-dialog", u: s.owner, go: async (u) => { await openDoc(u, s.doc); await u.page.locator(".viewer-toolbar").getByRole("button", { name: /^Share/ }).first().click(); }, ready: (u) => dialog(u, /^Share/) },
    { name: "deck-owner", u: s.owner, go: (u) => openDoc(u, s.deck), ready: (u) => u.page.locator("iframe.doc-frame") },
    { name: "deck-reader", u: s.reader, go: (u) => openDoc(u, s.deck), ready: (u) => u.page.locator("iframe.doc-frame") },
    { name: "editor", u: s.owner, editor: true, go: async (u) => { await openDoc(u, s.doc); await u.enterEdit({ waitShared: false }); }, ready: (u) => u.page.getByRole("toolbar", { name: "Formatting" }) },
  ];
  return list;
}

/**
 * Three hundred surfaces take an hour in a row, so several walkers share the sizes.
 * Each casts its own people and publishes its own documents: one walker reading a
 * document another is on would raise the presence row, and move what is measured.
 */
const WALKERS = 4;

const phoneWalk = sharedMeasurement("A28 the phone walk", { tiers: ["local"], timeoutMs: 45 * 60_000, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  const rows = [];
  walk.rows = rows;
  const walker = async (n) => {
    ctx.step(`walker ${n}: cast an owner, a reader and two visitors on one touch device each, and seed every surface`);
    const s = await seed(ctx, n);
    const all = surfaces(s);
    for (const size of SIZES.filter((_, i) => i % WALKERS === n)) {
      ctx.step(`${size.name}: ${all.length} surfaces`);
      for (const u of [s.owner, s.reader, s.anon, s.visitor]) await u.page.setViewportSize({ width: size.width, height: size.height });
      for (const surface of all) {
        if (surface.editor && !EDITOR_SIZES.has(size.name)) continue;
        const row = { size: size.name, width: size.width, height: size.height, surface: surface.name, user: surface.u.name };
        rows.push(row);
        const started = Date.now();
        try {
          await surface.go(surface.u);
          await surface.ready(surface.u).first().waitFor({ state: "visible", timeout: surface.optional ? 5_000 : LISTEN_MS }).catch((err) => {
            if (!surface.optional) throw err;
            row.absent = true;
          });
          if (row.absent) { row.ms = Date.now() - started; continue; }
          await settle(surface.u.page);
          Object.assign(row, await surface.u.page.evaluate(measurePageInPage));
          row.issues = (await inspectUi(surface.u.page)).issues;
          if (shots) await surface.u.page.screenshot({ path: join(shots, `${size.name}-${surface.name}.png`) });
          // Leave the editor by its own door, so the next load is not interrupted by a prompt.
          if (surface.editor) await surface.u.done().catch(() => undefined);
        } catch (err) {
          row.stopped = String(err?.message ?? err).split("\n")[0];
          ctx.step(`${size.name} ${surface.name} stopped: ${row.stopped}`);
        }
        row.ms = Date.now() - started;
        // Off the page, or the next person to open this document finds them in it.
        await surface.u.page.goto("about:blank").catch(() => undefined);
      }
      ctx.ev.json("rows", rows);
    }
  };
  await Promise.all(Array.from({ length: WALKERS }, (_, n) => walker(n)));
  ctx.ev.json("rows", rows);
});

/** Judge one kind of issue across every row, naming the surface and size of each. */
function judge(ctx, kind, what) {
  const measured = walk.rows.filter((r) => r.issues);
  if (!measured.length) ctx.inconclusive("the walk measured nothing");
  const bad = measured.filter((r) => r.issues[kind].length).map((r) => `${r.size} ${r.surface}: ${JSON.stringify(r.issues[kind])}`);
  ctx.ev.json(kind, bad);
  assert.deepEqual(bad, [], `${what} (${bad.length} of ${measured.length}): ${bad.slice(0, 40).join(" | ")}`);
}

const opts = phoneWalk.options;

scenario("A28.0 every surface is reached at every size", opts, async (ctx) => {
  await phoneWalk.run(ctx);
  const stopped = walk.rows.filter((r) => r.stopped).map((r) => `${r.size} ${r.surface}: ${r.stopped}`);
  ctx.ev.json("stopped", stopped);
  assert.deepEqual(stopped, [], `surfaces not reached (${stopped.length} of ${walk.rows.length}): ${stopped.slice(0, 40).join(" | ")}`);
});

scenario("A28.1 nothing scrolls sideways at any size", opts, async (ctx) => {
  await phoneWalk.ensure(ctx);
  const bad = walk.rows.filter((r) => r.issues).filter((r) => r.scrollWidth > r.clientWidth + 1 || r.scrolledX !== 0 || r.issues.horizontal.length).map((r) => `${r.size} ${r.surface}: scrollWidth ${r.scrollWidth} of ${r.clientWidth}, scrollX ${r.scrolledX}, nested ${JSON.stringify(r.issues.horizontal)}`);
  ctx.ev.json("sideways", bad);
  assert.deepEqual(bad, [], `surfaces that scroll sideways (${bad.length}): ${bad.slice(0, 40).join(" | ")}`);
});

scenario("A28.2 no two controls in one layer overlap at any size", opts, async (ctx) => {
  await phoneWalk.ensure(ctx);
  judge(ctx, "overlap", "controls that overlap");
});

scenario("A28.3 no control runs off the screen or is cut by its box at any size", opts, async (ctx) => {
  await phoneWalk.ensure(ctx);
  judge(ctx, "clipped", "controls cut off");
});

scenario("A28.4 no icon or logo is flexed below its declared size at any size", opts, async (ctx) => {
  await phoneWalk.ensure(ctx);
  judge(ctx, "mark", "marks squeezed");
});

scenario("A28.5 every text field and select is at least 16 px on touch, so iOS does not zoom the page", opts, async (ctx) => {
  await phoneWalk.ensure(ctx);
  judge(ctx, "inputFont", "fields iOS would zoom on");
});

scenario("A28.6 words a box cuts carry an ellipsis at any size", opts, async (ctx) => {
  await phoneWalk.ensure(ctx);
  judge(ctx, "cutText", "words cut with no ellipsis");
});

scenario("A28.7 every control keeps a 44×44 hit area at any size", opts, async (ctx) => {
  await phoneWalk.ensure(ctx);
  judge(ctx, "small", "targets under 44×44");
});

scenario("A28.8 an open menu lies wholly on the screen at any size", opts, async (ctx) => {
  await phoneWalk.ensure(ctx);
  const rows = walk.rows.filter((r) => r.surface === "more-menu" && r.issues);
  if (!rows.length) ctx.inconclusive("the walk measured no open menu");
  const bad = rows.filter((r) => !r.menu || r.menu.top < 0 || r.menu.bottom > r.viewHeight || r.menu.left < 0 || r.menu.right > r.clientWidth).map((r) => `${r.size}: ${JSON.stringify(r.menu)} on ${r.clientWidth}×${r.viewHeight}`);
  assert.deepEqual(bad, [], `menus past the edge of the screen: ${bad.join(" | ")}`);
});

scenario("A28.9 on a phone, the bars above a document take at most two rows", opts, async (ctx) => {
  await phoneWalk.ensure(ctx);
  // 52 + 52 + a 1 px rule, and a little for rounding (SPEC §7). The landscape phones are condensed too.
  const rows = walk.rows.filter((r) => ["document-owner", "document-reader", "public-document"].includes(r.surface) && r.issues && (r.width <= 600 || r.height <= 500));
  if (!rows.length) ctx.inconclusive("the walk measured no document on a phone");
  const bad = rows.filter((r) => r.frame.top > 107).map((r) => `${r.size} ${r.surface}: the frame starts at ${r.frame.top}`);
  ctx.ev.json("frame-top", rows.map((r) => ({ size: r.size, surface: r.surface, top: r.frame.top })));
  assert.deepEqual(bad, [], `documents pushed down by more than two rows: ${bad.join(" | ")}`);
});

// --- What a phone does, one sequence at a time ---------------------------------------

const PHONE = Object.freeze({ width: 402, height: 874, touch: true });
const LOCAL = Object.freeze({ tiers: ["local"], timeoutMs: 300_000, inconclusiveOnCaseTimeout: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The first second after a page opens is frozen: its own scrolling is not the reader's. */
const QUIET_MS = 1200;

/** A person with a phone and a session, and whatever they are about to read published. */
async function onPhone(ctx, role = "owner") {
  const [account] = await cast(target, [role], { notifications: false });
  const u = await ctx.users.user({ name: role, device: PHONE, consent: "denied" });
  await u.signInUi(account.email, account.password);
  const session = await browserSession(u, { account, cutoffError: true });
  return { u, session, account };
}

async function publishAs(session, name, body = longHtml(`A28 ${name}`), filename = "index.html") {
  const up = await publish(session.http, { body, filename, title: `A28 ${name} ${rand4()}`, name: `a28-${name}`, ownerEmail: session.account.email });
  precondition(up.status === 200, `publish ${name}: ${up.status} ${JSON.stringify(up.json)}`);
  return up.docId;
}

const publishDeck = (session, name) => {
  const d = readSample(target, "deck-quarter-review");
  return publishAs(session, name, d.bytes, d.filename);
};

/** A finger on the document: Chrome's own touch scroll gesture, so a real scroll with real events. */
async function swipe(u, distance) {
  const cdp = await u.page.context().newCDPSession(u.page);
  try {
    await cdp.send("Input.synthesizeScrollGesture", { x: 200, y: 450, yDistance: -distance, speed: 3000, gestureSourceType: "touch", preventFling: true });
  } finally {
    await cdp.detach();
  }
}

const bars = (u) => u.page.evaluate(() => {
  const frame = document.querySelector("iframe.doc-frame").getBoundingClientRect();
  const hit = document.elementFromPoint(200, 20);
  return {
    hidden: document.querySelector(".viewer")?.getAttribute("data-chrome") === "hidden",
    top: Math.round(frame.top),
    height: Math.round(frame.height),
    view: innerHeight,
    atTop: hit?.tagName ?? null,
  };
});

/** Down far enough to hide them, and wait until they have. */
async function scrollThemAway(u) {
  await eventually(async () => {
    await swipe(u, 400);
    return (await bars(u)).hidden;
  }, { timeout: 20_000, interval: 300, message: "the bars leave on the way down" });
}

/** Count flips for a while, with nobody touching anything. */
async function flipsOver(u, ms) {
  return u.page.evaluate((ms) => new Promise((resolve) => {
    const viewer = document.querySelector(".viewer");
    let flips = 0;
    const seen = new MutationObserver((records) => { flips += records.length; });
    seen.observe(viewer, { attributes: true, attributeFilter: ["data-chrome"] });
    setTimeout(() => { seen.disconnect(); resolve(flips); }, ms);
  }), ms);
}

scenario("A28.10 someone else in the document adds one row to the bars, and is named in it", LOCAL, async (ctx) => {
  const { u, session } = await onPhone(ctx);
  const [other] = await cast(target, ["other"], { notifications: false });
  const docId = await publishAs(session, "peer");
  await share(target, { owner: session, doc: docId, account: other, role: "viewer" });
  await u.open(docId, { timeout: LISTEN_MS });
  const peer = await ctx.users.user({ name: "other", consent: "denied" });
  await peer.signInUi(other.email, other.password);
  await peer.open(docId, { timeout: LISTEN_MS });
  await u.page.locator(".presence-chip").first().waitFor({ state: "visible", timeout: LISTEN_MS });
  const { top } = await bars(u);
  ctx.ev.json("frame-top", { top });
  assert.ok(top <= 155, `the frame starts at ${top}: two rows and one for the person here`);
  assert.ok(top > 107, `the frame starts at ${top}: there is a third row for the person here`);
});

scenario("A28.11 a deck opens on its slide; the drawer opens on request, and picking a slide or tapping beside it closes it", LOCAL, async (ctx) => {
  const { u, session } = await onPhone(ctx);
  const docId = await publishDeck(session, "deck");
  await u.open(docId, { timeout: LISTEN_MS });
  const slides = u.page.getByRole("button", { name: "Slides", exact: true });
  await slides.waitFor({ state: "visible", timeout: LISTEN_MS });
  const rail = u.page.locator(".slide-rail");
  assert.equal(await rail.count(), 0, "the drawer is closed when a deck opens, or it covers the slide");
  await slides.click();
  await rail.waitFor({ state: "visible", timeout: 10_000 });
  await u.page.getByRole("button", { name: "Close the slide list", exact: true }).click({ position: { x: 380, y: 300 } });
  await rail.waitFor({ state: "detached", timeout: 10_000 });
  await slides.click();
  await rail.locator(".slide-thumb").nth(1).click();
  await rail.waitFor({ state: "detached", timeout: 10_000 });
  await sleep(QUIET_MS);
  await swipe(u, 300).catch(() => undefined);
  await sleep(400);
  assert.equal((await bars(u)).hidden, false, "a deck keeps its bars: they are how it is driven");
});

scenario("A28.12 a reader gets from a document to the folder holding it in two taps", LOCAL, async (ctx) => {
  const { u, session, account } = await onPhone(ctx);
  const folder = await createFolder(session.http, { name: `Board papers ${rand4()}`, ownerEmail: account.email });
  const docId = await publishAs(session, "filed");
  const moved = await session.http.postJson("/organize", { kind: "doc", id: docId, op: "move", targetFolderId: folder.folderId });
  precondition(moved.status === 200, `file it: ${moved.status}`);
  await u.open(docId, { timeout: LISTEN_MS });
  await u.page.getByRole("button", { name: "Menu", exact: true }).click();
  await u.page.getByRole("menuitem", { name: /^Board papers/ }).click();
  await eventually(() => new URL(u.page.url()).pathname === `/folder/${folder.folderId}`, { timeout: 15_000, message: "the second tap lands on the folder" });
});

scenario("A28.13 in one column the comments pane is left by the toggle, and there is no way to a blank screen", LOCAL, async (ctx) => {
  const { u, session } = await onPhone(ctx);
  const docId = await publishAs(session, "pane");
  await u.open(docId, { timeout: LISTEN_MS });
  await u.page.locator(".pane-toggle button", { hasText: "Comments" }).click();
  await u.page.locator(".comments-panel").waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await u.page.locator(".comments-close").isVisible(), false, "no close button beside the toggle, whose other half already says how to leave");
  await u.page.locator(".pane-toggle button", { hasText: "Document" }).click();
  await u.page.locator("iframe.doc-frame").waitFor({ state: "visible", timeout: 10_000 });
});

scenario("A28.14 a comment started signed out is on its passage after signing in", LOCAL, async (ctx) => {
  const { session } = await onPhone(ctx);
  const [reader] = await cast(target, ["reader"], { notifications: false });
  const docId = await publishAs(session, "resume");
  const opened = await session.http.postJson("/visibility", { docId, visibility: "public", publicEdit: false, expiresAt: null });
  precondition(opened.status === 200, `make it public: ${opened.status}`);
  const anon = await ctx.users.user({ name: "anon", device: PHONE, consent: "denied" });
  await anon.open(docId, { timeout: LISTEN_MS });
  const frame = await docFrame(anon.page);
  const picked = await setSelection(frame, "#m-3", "speaks of marker-3");
  precondition(!picked?.error, `select the passage: ${JSON.stringify(picked)}`);
  const comment = anon.page.locator(".selection-dock .selection-fab", { hasText: "Comment" });
  await comment.waitFor({ state: "visible", timeout: 15_000 });
  await comment.click();
  const prompt = anon.page.locator(".signin-to-comment");
  await prompt.waitFor({ state: "visible", timeout: 15_000 });
  assert.match(await prompt.innerText(), /Your selection is kept/);
  assert.equal(await frame.evaluate(() => window.getSelection().isCollapsed), true, "the selection is cleared, or iOS draws its handles over the pane");
  await prompt.getByRole("button", { name: "Sign in", exact: true }).click();
  await eventually(() => new URL(anon.page.url()).pathname === "/signup", { timeout: 15_000, message: "on to the sign-in page" });
  assert.equal(new URL(anon.page.url()).searchParams.get("next"), `/d/${docId}`, "with the way back in its next");
  assert.ok(!anon.page.url().includes("marker"), "and the passage nowhere in the address");
  await anon.signInUi(reader.email, reader.password, { here: true });
  await eventually(() => new URL(anon.page.url()).pathname === `/d/${docId}`, { timeout: LISTEN_MS, message: "back on the document" });
  const thread = anon.page.locator(".comments-panel .thread", { hasText: "speaks of marker-3" });
  await thread.waitFor({ state: "visible", timeout: LISTEN_MS });
  assert.equal(await thread.count(), 1, "one thread, on the passage they chose");
  // Used once: a reload must not raise it again.
  await anon.page.reload();
  await anon.waitForFrame({ timeout: LISTEN_MS });
  await sleep(2000);
  await anon.page.locator(".pane-toggle button", { hasText: "Comments" }).click();
  await thread.waitFor({ state: "visible", timeout: LISTEN_MS });
  assert.equal(await anon.page.locator(".comments-panel .thread").count(), 1, "still one after a reload");
});

scenario("A28.15 the bars leave on the way down and return on the way up, the frame really grows, the bottom does not flicker, and the document's bytes do not change", LOCAL, async (ctx) => {
  const { u, session } = await onPhone(ctx);
  const docId = await publishAs(session, "scroll");
  await u.open(docId, { timeout: LISTEN_MS });
  const frame = await docFrame(u.page);
  const bytes = await frame.evaluate(() => document.documentElement.outerHTML);
  await sleep(QUIET_MS);

  const rest = await bars(u);
  ctx.ev.json("at-rest", rest);
  assert.equal(rest.hidden, false, "at the top they are there");
  assert.ok(rest.top <= 107, `at rest the frame starts at ${rest.top}`);

  await scrollThemAway(u);
  const away = await bars(u);
  ctx.ev.json("scrolled-down", away);
  assert.equal(away.top, 0, "the document has the top of the screen");
  assert.equal(away.height, away.view, "and all of its height");
  assert.equal(away.atTop, "IFRAME", "and a tap at the top lands in it, not on bars that are only out of sight");

  await swipe(u, -60);
  await eventually(async () => !(await bars(u)).hidden, { timeout: 5_000, interval: 50, message: "the bars come back on a small scroll up" });

  ctx.step("hiding at the very end clamps the scroll by the height of the bars, which must not read as a scroll up");
  await u.open(docId, { timeout: LISTEN_MS });
  const atEnd = await docFrame(u.page);
  // Inside the quiet second, so the bars are still up when the reader reaches the end.
  await atEnd.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight - window.innerHeight - 90));
  await sleep(QUIET_MS);
  assert.equal((await bars(u)).hidden, false, "the bars are up, 90 px short of the end");
  const counting = flipsOver(u, 2500);
  await swipe(u, 400);
  const flips = await counting;
  ctx.ev.json("flips-at-the-bottom", { flips, ...(await bars(u)) });
  assert.equal(flips, 1, `the bars flipped ${flips} times at the bottom with nobody touching anything`);
  assert.equal((await bars(u)).hidden, true, "and are still away");

  await atEnd.evaluate(() => window.scrollTo(0, 0));
  await eventually(async () => !(await bars(u)).hidden, { timeout: 5_000, interval: 50, message: "at the top they are always back" });

  assert.equal(await atEnd.evaluate(() => document.documentElement.outerHTML), bytes, "not a byte of the document changed");
});

scenario("A28.16 they stay where a reader needs them: a short document, a deck, the comments pane, a selection, an open menu; and focus brings them back", LOCAL, async (ctx) => {
  const { u, session } = await onPhone(ctx);
  const shortDoc = await publishAs(session, "short", `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Short</title></head><body><h1>Short</h1><p id="only">One line that never needs to scroll, so there is nothing to scroll the bars back with.</p></body></html>`);
  const docId = await publishAs(session, "holds");

  ctx.step("a document too short to scroll them back");
  await u.open(shortDoc, { timeout: LISTEN_MS });
  await sleep(QUIET_MS);
  await swipe(u, 300);
  await sleep(400);
  assert.equal((await bars(u)).hidden, false, "a short document keeps its bars");

  ctx.step("a selection: nothing moves under a handle");
  await u.open(docId, { timeout: LISTEN_MS });
  const frame = await docFrame(u.page);
  await sleep(QUIET_MS);
  await setSelection(frame, "#m-1", "speaks of marker-1");
  await u.page.locator(".selection-dock").waitFor({ state: "visible", timeout: 15_000 });
  await frame.evaluate(() => window.scrollTo(0, 1200));
  await sleep(500);
  assert.equal((await bars(u)).hidden, false, "a selection holds them where they are");
  await frame.evaluate(() => window.getSelection().removeAllRanges());

  ctx.step("an open menu");
  await frame.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await scrollThemAway(u);
  await swipe(u, -80);
  await eventually(async () => !(await bars(u)).hidden, { timeout: 5_000, interval: 50, message: "back up" });
  await u.page.getByRole("button", { name: "More actions", exact: true }).click();
  await u.page.locator(".menu").waitFor({ state: "visible", timeout: 5_000 });
  await frame.evaluate(() => window.scrollBy(0, 800));
  await sleep(500);
  assert.equal(await u.page.locator(".menu").isVisible(), true, "the menu is still open");
  assert.equal(await u.page.locator(".viewer-toolbar").evaluate((el) => getComputedStyle(el).clipPath), "none", "and the bars holding it are showing");
  await u.page.keyboard.press("Escape");

  ctx.step("focus brings them back with no scrolling");
  await u.page.evaluate(() => document.activeElement?.blur?.());
  await scrollThemAway(u);
  await u.page.locator(".viewer-toolbar button").first().focus();
  await eventually(() => u.page.locator(".viewer-toolbar").evaluate((el) => getComputedStyle(el).clipPath === "none"), { timeout: 3_000, interval: 50, message: "focus inside brings the bars back" });
  await u.page.evaluate(() => document.activeElement?.blur?.());

  ctx.step("the comments pane");
  await u.open(docId, { timeout: LISTEN_MS });
  await sleep(QUIET_MS);
  await scrollThemAway(u);
  await swipe(u, -80);
  await eventually(async () => !(await bars(u)).hidden, { timeout: 5_000, interval: 50, message: "back up" });
  await u.page.locator(".pane-toggle button", { hasText: "Comments" }).click();
  await u.page.locator(".comments-panel").waitFor({ state: "visible", timeout: 15_000 });
  await sleep(300);
  assert.notEqual(await u.page.locator(".viewer").getAttribute("data-chrome"), "hidden", "the comments pane keeps its bars");
});

scenario("A28.17 a new version brings the bars back to say so", LOCAL, async (ctx) => {
  const { session } = await onPhone(ctx);
  const [reader] = await cast(target, ["reader"], { notifications: false });
  const docId = await publishAs(session, "news");
  await share(target, { owner: session, doc: docId, account: reader, role: "viewer" });
  const u = await ctx.users.user({ name: "reader-phone", device: PHONE, consent: "denied" });
  await u.signInUi(reader.email, reader.password);
  // Pinned to v1: an unpinned reader simply follows, and has nothing to be told (A12.3).
  await u.open(docId, { v: "v1", timeout: LISTEN_MS });
  await sleep(QUIET_MS);
  await scrollThemAway(u);
  const up = await updateUpload(session.http, docId, { body: longHtml("A28 news, version two"), baseVersion: "v1" });
  precondition(up.status === 200, `the second version: ${up.status}`);
  await u.page.locator(".viewer-banners").waitFor({ state: "attached", timeout: LISTEN_MS });
  await eventually(async () => !(await bars(u)).hidden, { timeout: 10_000, interval: 100, message: "the bars come back with the news" });
  assert.equal(await u.page.locator(".viewer-banners").evaluate((el) => getComputedStyle(el).clipPath), "none", "and the banner is showing");
});

scenario("A28.18 a tap beside the folder drawer closes it, and so does going somewhere", LOCAL, async (ctx) => {
  const { u, session, account } = await onPhone(ctx);
  const folder = await createFolder(session.http, { name: `Drawer ${rand4()}`, ownerEmail: account.email });
  await u.goto("/everything");
  const open = u.page.getByRole("button", { name: "Folders" });
  await open.waitFor({ state: "visible", timeout: LISTEN_MS });
  await open.click();
  const link = u.page.locator(".folder-rail").getByRole("button", { name: /^Drawer/ });
  await link.first().waitFor({ state: "visible", timeout: 15_000 });
  await u.page.getByRole("button", { name: "Close the folder list", exact: true }).click({ position: { x: 380, y: 400 } });
  await link.first().waitFor({ state: "hidden", timeout: 5_000 });
  await open.click();
  await link.first().click();
  await eventually(() => new URL(u.page.url()).pathname === `/folder/${folder.folderId}`, { timeout: 15_000, message: "on to the folder" });
  await sleep(300);
  assert.equal(await open.getAttribute("aria-expanded"), "false", "and the drawer has closed behind them");
});

export { E2E_FILE_TIMEOUT_MS };
