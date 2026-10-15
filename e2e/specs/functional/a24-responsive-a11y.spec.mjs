// SPDX-License-Identifier: Apache-2.0
// A24 responsive and accessible: a 400 px phone, keyboard-only flows, focus traps, reduced motion, touch, words for screen readers (SPEC §7).

/**
 * Catalogue A24. SPEC §7: "Accessibility is a hard requirement: visible
 * `:focus-visible`, targets ≥44px, colour is never the sole signal,
 * `prefers-reduced-motion` honoured, WCAG AA contrast." Each case casts its
 * own accounts and publishes its own documents; where a known defect's case
 * is the same measurement as a passing case, the passing case measures both
 * and the defect's case reads what it recorded (as smoke 2b does); when
 * nothing was recorded the defect's case is INCONCLUSIVE, never a pass.
 *
 *   A24.1   a 400×800 touch phone (the lib's touch device, so `(pointer: coarse)`
 *           and `(hover: none)` hold as on a phone): 11 screens and 2 dialogs
 *           never scroll sideways, and each one's primary actions, once
 *           scrolled to, lie wholly inside the viewport, uncovered at their
 *           centre
 *   A24.1b  every interactive hit area, including labels for checkboxes and
 *           radios, reaches 44×44; inline prose links retain their exception
 *   A24.2   keyboard-only sign-in, comment, suggestion, review, Share, upload,
 *           versions, deck overview and OAuth consent; every stop has a ring,
 *           dialogs contain focus and restore their opener
 *   A24.3   reduced motion in all five app scroll paths: passage, thread card,
 *           review Next, deck arrows and rail follow
 *   A24.4   closed tablet panel and phone pane open on explicit highlight tap;
 *           long press, toolbar placement and Comment work on both devices
 *   A24.5   forced-colour shapes remain painted, suggestions have spoken words,
 *           and Chrome measures contrast, names and reserved focus paint on
 *           all 11 screens and 2 dialogs, without an extra dependency
 *
 * EMAIL. Every account is cast with notifications off, so no comment,
 * suggestion or invitation notice is sent, and every case that comments
 * asserts quietDoc() first. A24.2e adds a person through the Share dialog,
 * a raw POST /access from the page: LOCAL, and it declares the email effect.
 *
 * Fixed waits, only where the product or the measurement is time-based: the
 * consent page arms Approve after a second (A24.2i); a long press is a touch
 * held 1.2 s (A24.4a); the scroll sampler records a fixed 2 s of animation
 * frames (A24.3a). And one for the environment: a write the loaded emulator
 * refused is pressed again after a 5 s pause (pressUntil).
 *
 * Load. On a fresh stack the whole file takes about four minutes; on a
 * shared emulator under heavy load each case can take minutes, and the
 * Firestore client in the page can go offline for a while, so waits on what
 * a listener delivers are generous (LISTEN_MS), and a document whose frame
 * did not load while the page saw the stack stall is loaded once more
 * (openDoc). A write the emulator refuses with a rules "Service call error" is
 * the environment: retried after a pause, and INCONCLUSIVE when it keeps
 * happening (pressUntil). Every case that touches the stack declares
 * `inconclusiveOnCaseTimeout` (lib/test.mjs): Hosting's cut-off 504, a request
 * or an admin call past its deadline, or a wait (the case's own budget among
 * them) that ran out while one of its pages saw the stack stall ends it
 * INCONCLUSIVE with the reason; an assertion and a defect's oracle are judged
 * as they are. Node calls ride the browser's own session (browserSession),
 * with a client that throws Hosting's cut-off itself (cutoffError).
 *
 * Only e2e/lib/ talks to the stack.
 */

import assert from "node:assert/strict";
import { inspectUi, spokenText } from "../../lib/accessibility.mjs";
import { after } from "node:test";
import { answered, currentTarget, pageStall, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { browserSession, mintToken } from "../../lib/session.mjs";
import { createFolder, ledgerDoc, publish, readSample, updateUpload } from "../../lib/seed.mjs";
import { share } from "../../lib/grant.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { quietDoc } from "../../lib/guard.mjs";
import { eventually } from "../../lib/assert.mjs";
import { authorizeParams, pkce, register, startReceiver } from "../../lib/oauth.mjs";
import { frameGeometry, framePointToPage, rangeRects, selectionText, setSelection } from "../../lib/frame.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const tag = () => `${runTag(target.runId)}${rand4()}`;
const BOTH = ["local", "prod"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How long a request the page sends may take on a loaded shared emulator. */
const SERVER_MS = 60_000;
/** How long a Firestore listener may take to deliver to the page on a loaded shared emulator (it can go offline for a while). */
const LISTEN_MS = 90_000;

/** The phone of A24: a touch device 400 CSS px wide, 800 tall (plan, A24.1). */
const PHONE = Object.freeze({ width: 400, height: 800, touch: true });
/** A touch tablet: wider than ONE_COLUMN_MAX (860, hooks/breakpoints.ts), so the panel sits beside the document. */
const TABLET = Object.freeze({ width: 1024, height: 800, touch: true });
/** --tap (styles/tokens.css): the minimum comfortable touch target. */
const TAP = 44;

// --- documents ------------------------------------------------------------------

const TEXT = Object.freeze({
  "a24-1": "The quick brown fox jumps over the lazy dog near the riverbank.",
  "a24-2": "A second paragraph mentions lanterns and harbour lights at dusk.",
  "a24-3": "This sentence is really quite important to the argument.",
  "a24-4": "Closing words for the record, kept short.",
});

function plainHtml(title, text = TEXT) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.6}</style>
</head>
<body>
<h1 id="a24-title">${title}</h1>
${Object.entries(text).map(([id, t]) => `<p id="${id}">${t}</p>`).join("\n")}
</body>
</html>
`;
}

/** Thirty long paragraphs, each with one unique marker phrase, so the document and the panel both scroll. */
const MARKERS = Object.freeze(["amber", "birch", "cedar", "delta", "ember", "fjord", "garnet", "heron", "indigo", "juniper", "kestrel", "lagoon", "marble", "nectar", "osprey", "pumice", "quartz", "raven", "saffron", "tundra", "umber", "violet", "walnut", "xenon", "yarrow", "zephyr", "acorn", "basil", "cobalt", "dune"]);
function longHtml(title) {
  const paras = MARKERS.map((w, i) => `<p id="m-${i + 1}">Paragraph ${i + 1} speaks of the ${w} marker phrase and then goes on for a while so that it wraps across more than one line of the reading column, which keeps the document long enough to scroll.</p>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.6}</style>
</head>
<body>
<h1 id="m-title">${title}</h1>
${paras}
</body>
</html>
`;
}

/** An anchor as the app builds one (as a08 does): the nearest id element, the quote, 32 characters either side. */
function anchorFor(id, exact, text = TEXT) {
  const t = text[id];
  const at = t.indexOf(exact);
  precondition(at >= 0 && t.indexOf(exact, at + 1) < 0, `"${exact}" is not unique in #${id}`);
  return { elementId: id, exact, prefix: t.slice(Math.max(0, at - 32), at), suffix: t.slice(at + exact.length, at + exact.length + 32), start: at, end: at + exact.length };
}

// --- cast, sign in, seed ---------------------------------------------------------------

async function assertCoarse(u) {
  const m = await u.page.evaluate(() => ({ coarse: matchMedia("(pointer: coarse)").matches, noHover: matchMedia("(hover: none)").matches, w: innerWidth, h: innerHeight }));
  precondition(m.coarse && m.noHover, `the page matches (pointer: coarse) and (hover: none) as a touch device: ${JSON.stringify(m)}`);
  return m;
}

/**
 * An owner (and accounts for `roles`), all with notifications off before any
 * session; the owner signed in through the UI in a browser user of their own
 * (a touch device when `device` is given), and a Node session riding the
 * browser's own cookie (browserSession), whose client throws Hosting's
 * cut-off itself.
 */
async function ownerOnPage(ctx, { roles = [], name = "owner", device = null } = {}) {
  const accounts = await cast(target, ["owner", ...roles], { notifications: false });
  const u = await ctx.users.user({ name, device });
  ctx.step(`cast ${["owner", ...roles].join(", ")}; ${name} signs in through the UI`);
  await u.signInUi(accounts[0].email, accounts[0].password);
  const owner = await browserSession(u, { account: accounts[0], cutoffError: true });
  ctx.step(`${name} is signed in`);
  return { u, owner, accounts };
}

async function signInAs(ctx, account, name, device = null) {
  const u = await ctx.users.user({ name, device });
  await u.signInUi(account.email, account.password);
  return u;
}

async function publishPlain(owner, name, title = `A24 ${name} ${tag()}`) {
  const up = await publish(owner.http, { body: plainHtml(title), filename: "index.html", title, name: `a24-${name}`, ownerEmail: owner.account.email });
  precondition(up.status === 200 && up.versionId === "v1", `publish ${name}: ${up.status} ${JSON.stringify(up.json)}`);
  return { docId: up.docId, title };
}

async function publishDeck(owner, name) {
  const d = readSample(target, "deck-quarter-review");
  const up = await publish(owner.http, { body: d.bytes, filename: d.filename, title: `${d.title} ${tag()}`, name: `a24-${name}`, ownerEmail: owner.account.email });
  precondition(up.status === 200, `deck published: ${up.status}`);
  return up.docId;
}

async function mcpFor(ctx, session, actor) {
  const { token } = await mintToken(session, { name: `e2e a24 ${actor}`, channel: "mcp" });
  const mcp = ctx.mcp({ token, actor });
  await mcp.initialize();
  return mcp;
}

/** An agent's comment on a quote (SPEC §19): a highlight and a thread, with no browser involved. */
async function addComment(mcp, docId, exact, body) {
  const r = await mcp.call("add_comment", { id: docId, exact, body });
  precondition(!r.isError, `add_comment "${exact}": ${r.text.slice(0, 300)}`);
  return r.json?.threadId;
}

/** A pending suggestion made over POST /suggestion, as a08 makes them (A7 drives the form). */
async function postSuggestion(session, docId, anchor, replacement) {
  const r = await session.http.postJson("/suggestion", { op: "create", docId, versionId: "v1", anchor, replacement });
  precondition(r.status === 200 && r.json?.annId, `POST /suggestion create: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.annId;
}

/** A folder at the owner's root, made and ledgered by seed.mjs's createFolder. */
async function folderOf(session, name) {
  const r = await createFolder(session.http, { name, ownerEmail: session.account.email });
  precondition(r.status === 200 && r.folderId, `POST /folder answered a folderId (${r.status} ${JSON.stringify(r.json)})`);
  return r.folderId;
}

/**
 * Open a document and wait for its frame. On a loaded shared emulator the
 * page's Firestore client can lose the emulator for a while and leave
 * "Opening the document…" up past the wait. Only when the page saw such a
 * stall (lib pageStall: Hosting's cut-off, or the SDK losing its backend) is
 * the page loaded once more; a frame that did not load on a stack that kept
 * answering FAILS here, and a second stall is judged by the case's own
 * inconclusiveOnCaseTimeout.
 */
async function openDoc(ctx, u, docId, o = {}) {
  ctx.step(`${u.name} opens ${docId}`);
  try {
    return await u.open(docId, { timeout: LISTEN_MS, ...o });
  } catch (err) {
    const stall = pageStall(err, ctx);
    if (!stall) throw err;
    ctx.step(`environment: ${u.name}'s document frame did not load while the stack stalled (${stall}); loading the page once more`);
    return await u.open(docId, { timeout: LISTEN_MS, ...o });
  }
}

// --- the browser, one key at a time ------------------------------------------------------

/** The centre of a quote in the document frame, in page coordinates. */
async function quotePoint(u, selector, exact) {
  const f = await u.frame();
  const rr = await rangeRects(f, selector, exact);
  precondition(!rr.error && rr.rects.length > 0, `"${exact}" is laid out in ${selector}: ${rr.error ?? "no rects"}`);
  const geom = await frameGeometry(u.page);
  const r = rr.rects[0];
  return framePointToPage(geom, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
}

/**
 * Two animation frames and a beat: a transition on the outline settles, so the
 * ring read is the ring shown. A page that produces no frame at all still
 * answers within half a second, so a read never hangs on one.
 */
const settle = (page) =>
  page.evaluate(() => new Promise((r) => {
    const fallback = setTimeout(r, 500);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(fallback);
      setTimeout(r, 30);
    }));
  }));

/**
 * What has focus, read in the page: the element, its dialog or menu, its ring
 * (outline style, width, colour, and whether that colour is the resolved
 * --color-focus), whether it is visibly rendered, and its label. A focused
 * document frame is reported as IFRAME.
 */
function focusInfoInPage() {
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return { tag: a?.tagName ?? null, label: "", none: true };
  const probe = document.createElement("span");
  probe.style.color = "var(--color-focus)";
  document.body.appendChild(probe);
  const focusColor = getComputedStyle(probe).color;
  probe.remove();
  const cs = getComputedStyle(a);
  const r = a.getBoundingClientRect();
  const label = (a.getAttribute("aria-label") || a.textContent || a.getAttribute("placeholder") || a.getAttribute("title") || a.id || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const clipped = cs.clipPath !== "none" || (cs.clip && cs.clip !== "auto");
  return {
    tag: a.tagName,
    id: a.id || null,
    cls: typeof a.className === "string" ? a.className : null,
    label,
    type: a.getAttribute("type"),
    dialog: a.closest("[role=dialog]")?.getAttribute("aria-label") ?? null,
    menu: Boolean(a.closest("[role=menu]")),
    focusVisible: a.matches(":focus-visible"),
    ring: { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, isFocusColor: cs.outlineColor === focusColor, focusColor },
    box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    visible: r.width >= 4 && r.height >= 4 && !clipped && Number(cs.opacity) > 0 && cs.visibility !== "hidden",
  };
}

async function focused(page) {
  await settle(page);
  return page.evaluate(focusInfoInPage);
}

const describe = (f) => (f ? `${f.tag}${f.id ? `#${f.id}` : ""} "${f.label}"` : "nothing");

/** The ring a keyboard stop must wear (SPEC §10: --color-focus appears nowhere but :focus-visible). */
function ringProblem(f) {
  if (!f || f.none) return null;
  // A date field's own parts (day, month, year, the picker) are focus stops of one element; the ring is the element's.
  if (f.tag === "INPUT" && f.type === "date") return null;
  const problems = [];
  if (!f.focusVisible && f.tag !== "IFRAME") problems.push("not :focus-visible");
  if (f.ring.style !== "solid") problems.push(`outline-style ${f.ring.style}`);
  if (parseFloat(f.ring.width) < 2) problems.push(`outline-width ${f.ring.width}`);
  if (!f.ring.isFocusColor) problems.push(`outline-color ${f.ring.color}, not --color-focus ${f.ring.focusColor}`);
  return problems.length ? `${describe(f)}: ${problems.join(", ")}` : null;
}

/**
 * Press Tab (or Shift+Tab) until `want(focusInfo)` holds, at most `max`
 * times, recording every stop. A target never reached is a precondition
 * naming the last stops.
 */
async function tabTo(page, want, { max = 40, back = false, what = "the target", stops = [] } = {}) {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    const f = await focused(page);
    stops.push(f);
    if (want(f)) return f;
  }
  assert.fail(`${what} is reachable by ${back ? "Shift+Tab" : "Tab"} within ${max} presses (stops: ${stops.slice(-12).map(describe).join(" → ")})`);
}

/**
 * Reach a control near focus whichever side of it the control lies: Shift+Tab
 * up to `max` times, then Tab, which may have to go round the page. For a
 * control re-rendered under focus, where focus lands is not the thing tested.
 */
async function tabToNear(page, want, { max = 12, what = "the target", stops = [] } = {}) {
  const tried = [];
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press("Shift+Tab");
    const f = await focused(page);
    tried.push(f);
    if (want(f)) {
      stops.push(...tried);
      return f;
    }
  }
  stops.push(...tried);
  return tabTo(page, want, { max: 3 * max + 40, what: `${what} (after ${max} Shift+Tab: ${tried.map(describe).join(" → ")})`, stops });
}

const isButton = (name) => (f) => f.tag === "BUTTON" && f.label === name;

/**
 * How long to wait for the answer to a request a page sends: past Hosting's
 * own minute, so a function that never answered is seen as its cut-off 504,
 * which lib answered() then throws as the stack's, not the product's.
 */
const ANSWER_MS = 2 * SERVER_MS;

/** The emulator's own failure under load: a rule's get() that never answered (an E-class refusal, not the rules'). */
const SERVICE_ERROR = /Service call error/;

/**
 * Press a key that makes the page write, and wait for `done()`. When the
 * write is refused only because the loaded emulator failed a rule's get()
 * ("Service call error" in the error toast), the key is pressed again, at
 * most twice, each time recorded as an environment retry; any other outcome
 * is left to `done()`'s wait.
 */
async function pressUntil(ctx, u, key, done, { what, timeout = SERVER_MS, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const mark = u.toastMark();
    await u.page.keyboard.press(key);
    const outcome = await eventually(async () => {
      const d = await done();
      if (d) return { done: d };
      const refused = u.log.toasts.slice(mark).find((x) => x.kind === "error" && SERVICE_ERROR.test(x.text));
      return refused ? { refused } : false;
    }, { timeout, interval: 250, message: what });
    if (outcome.done) return outcome.done;
    if (attempt >= retries) ctx.inconclusive(`${what}: the loaded emulator refused the write ${attempt + 1} times with a rules "Service call error", so the flow could not be measured`);
    ctx.step(`environment: the emulator failed a rule's get() ("Service call error"); ${key} again in 5 s (${attempt + 1})`);
    await sleep(5_000); // a pause for the emulator, not a wait on the product
  }
}

function assertRings(ctx, stops) {
  ctx.ev.json("stops", stops);
  assert.deepEqual(stops.map(ringProblem).filter(Boolean), [], "every keyboard stop wears the ring: :focus-visible, solid, 2 px, --color-focus (SPEC §10)");
}

// --- A24.1: the phone walk ------------------------------------------------------------

/** Page-level geometry complements the nested scrollports checked by inspectUi. */
function measureSurfaceInPage() {
  const de = document.documentElement;
  const before = window.scrollX;
  window.scrollTo(100000, window.scrollY);
  const scrolledX = window.scrollX;
  window.scrollTo(before, window.scrollY);
  return { vw: innerWidth, clientWidth: de.clientWidth, scrollWidth: Math.max(de.scrollWidth, document.body.scrollWidth), scrolledX, overflowing: [] };
}

/** Is the element wholly inside the viewport, and is it what a finger at its centre would touch? */
function placementInPage(el) {
  const r = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const inside = r.width > 0 && r.height > 0 && r.left >= -0.5 && r.top >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5;
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const onTop = Boolean(hit && (hit === el || el.contains(hit)));
  const coveredBy = onTop || !hit ? null : `${hit.tagName.toLowerCase()}.${String(hit.className?.baseVal ?? hit.className).trim().replace(/\s+/g, ".")}`;
  return { inside, horizontal: r.left >= -0.5 && r.right <= vw + 0.5, onTop, coveredBy, box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] };
}

/** What the A24.1 walk measured, for A24.1b. */
const walk = { surfaces: null, expected: 13 };

scenario("A24.1 at 400×800 on a touch phone, 11 screens and 2 dialogs never scroll sideways, and each one's primary actions, once scrolled to, lie wholly inside the viewport, uncovered at their centre", {
  tiers: BOTH,
  timeoutMs: 360_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const t = tag();
  ctx.step("the owner signs in on a phone; publish a plain document and a deck, make a folder, an agent comments, an app registers for /connect");
  const { u: phone, owner } = await ownerOnPage(ctx, { name: "owner-phone", device: PHONE });
  const plain = await publishPlain(owner, "walk");
  const deckId = await publishDeck(owner, "walk-deck");
  const folderId = await folderOf(owner, `A24 walk ${t}`);
  await quietDoc(target, plain.docId);
  const mcp = await mcpFor(ctx, owner, "owner-mcp");
  await addComment(mcp, plain.docId, "lazy dog", `A24.1 thread ${t}`);
  const redirectUri = "http://127.0.0.1/a24-callback";
  const reg = await register(ctx.http({ actor: "oauth-app", cutoffError: true }), { redirectUris: [redirectUri], clientName: `E2E A24 app ${t}` });
  precondition(reg.status === 201 && reg.clientId, `registration: ${reg.status}`);
  const params = authorizeParams({ clientId: reg.clientId, redirectUri, challenge: pkce().challenge });
  const anon = await ctx.users.user({ name: "anon-phone", device: PHONE });

  const surfaces = [];
  const visit = async (u, name, { ready, primary = [] }) => {
    ctx.step(`${name}: wait for ${ready.label}, then measure`);
    await ready.loc.first().waitFor({ state: "visible", timeout: LISTEN_MS });
    await settle(u.page);
    if (!surfaces.some((x) => x.user === u.name)) await assertCoarse(u);
    const m = await u.page.evaluate(measureSurfaceInPage);
    const accessibility = await inspectUi(u.page);
    m.small = accessibility.issues.small;
    m.horizontal = accessibility.issues.horizontal;
    const places = [];
    for (const p of primary) {
      const el = p.loc.first();
      await el.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
      const visible = await el.isVisible().catch(() => false);
      if (!visible) {
        places.push({ label: p.label, visible });
        continue;
      }
      // A phone scrolls a long page down to its buttons. What must hold is that, once there, the
      // action is wholly on screen (never past the right edge) and nothing lies over it.
      const atLoad = await el.evaluate(placementInPage);
      await el.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
      places.push({ label: p.label, visible, horizontalAtLoad: atLoad.horizontal, belowTheFold: !atLoad.inside, ...(await el.evaluate(placementInPage)) });
    }
    surfaces.push({ name, user: u.name, ...m, primary: places, accessibility });
  };
  const btn = (u, name, within = u.page) => ({ label: `button "${name}"`, loc: within.getByRole("button", { name, exact: true }) });
  const css = (u, sel, label = sel) => ({ label, loc: u.page.locator(sel) });
  const paneToggle = (u, name) => ({ label: `pane toggle "${name}"`, loc: u.page.locator(".pane-toggle button", { hasText: name }) });

  // The walk measures as it goes, and the oracles judge what it measured. A screen that scrolls sideways
  // can itself stop the walk (a click the overflowing layout no longer lands); what was measured up to
  // there is still judged for sideways scroll first, and the walk's own failure stands after it.
  let stopped = null;
  try {
    await anon.goto("/");
    await visit(anon, "landing", { ready: { label: "the heading", loc: anon.page.locator("main h1") }, primary: [{ label: 'link "Sign in"', loc: anon.page.getByRole("link", { name: "Sign in", exact: true }) }] });
    await anon.goto("/signup");
    await visit(anon, "sign-in", { ready: css(anon, "#auth-email"), primary: [css(anon, "#auth-email"), css(anon, "#auth-password"), btn(anon, "Sign in")] });
    await anon.goto("/privacy");
    await visit(anon, "privacy", { ready: { label: "the heading", loc: anon.page.getByRole("heading", { name: "Privacy policy" }) } });

    await phone.goto(`/connect?${new URLSearchParams(params)}`);
    await visit(phone, "connect", { ready: btn(phone, "Cancel"), primary: [btn(phone, "Cancel"), btn(phone, "Approve")] });
    await phone.goto("/");
    await visit(phone, "workspace", { ready: btn(phone, "Upload"), primary: [btn(phone, "Upload")] });
    await phone.page.getByRole("button", { name: "Upload", exact: true }).click();
    const uploadDialog = phone.page.getByRole("dialog", { name: "Upload a document" });
    await visit(phone, "upload dialog", { ready: { label: "the dialog", loc: uploadDialog }, primary: [btn(phone, "Choose a file", uploadDialog), btn(phone, "Cancel", uploadDialog), btn(phone, "Upload", uploadDialog)] });
    await uploadDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await uploadDialog.waitFor({ state: "detached", timeout: 10_000 });
    await phone.goto(`/folder/${encodeURIComponent(folderId)}`);
    await visit(phone, "folder", { ready: btn(phone, "Upload"), primary: [btn(phone, "Upload")] });
    await phone.goto("/account");
    await visit(phone, "account", { ready: { label: "the heading", loc: phone.page.getByRole("heading", { name: "Account", level: 1 }) }, primary: [btn(phone, "Sign out")] });

    await openDoc(ctx, phone, plain.docId);
    await visit(phone, "document", { ready: { label: "the frame", loc: phone.page.locator("iframe.doc-frame") }, primary: [paneToggle(phone, "Comments"), btn(phone, "Edit"), btn(phone, "Share")] });
    await phone.page.locator(".pane-toggle button", { hasText: "Comments" }).click();
    await visit(phone, "comments", { ready: css(phone, ".comments-panel .thread", "a thread"), primary: [paneToggle(phone, "Document"), css(phone, '.comments-panel .thread textarea[placeholder="Reply"]', "the thread's reply box")] });
    await phone.page.locator(".pane-toggle button", { hasText: "Document" }).click();
    await phone.page.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = phone.page.getByRole("dialog", { name: /^Share/ });
    await visit(phone, "share dialog", { ready: { label: "the dialog", loc: shareDialog }, primary: [css(phone, "#share-input", "the address field"), btn(phone, "Add", shareDialog), btn(phone, "Done", shareDialog)] });
    await shareDialog.getByRole("button", { name: "Done", exact: true }).click();
    await shareDialog.waitFor({ state: "detached", timeout: 10_000 });
    await phone.enterEdit({ waitShared: false });
    await visit(phone, "editor", { ready: { label: "the formatting toolbar", loc: phone.page.getByRole("toolbar", { name: "Formatting" }) }, primary: [btn(phone, "Done"), btn(phone, "Save as new version")] });
    await phone.done();

    await openDoc(ctx, phone, deckId);
    await visit(phone, "deck", { ready: css(phone, ".slide-rail", "the slide rail"), primary: [btn(phone, "Slides"), paneToggle(phone, "Comments"), btn(phone, "Present")] });
  } catch (err) {
    stopped = err;
    ctx.step(`the walk stopped after ${surfaces.at(-1)?.name ?? "no surface"}: ${String(err?.message ?? err).split("\n")[0]}`);
  }

  walk.surfaces = surfaces;
  ctx.ev.json("surfaces", surfaces);
  for (const x of surfaces) ctx.step(`${x.name}: scrollWidth ${x.scrollWidth}/${x.clientWidth}, scrollX after scrollTo ${x.scrolledX}, primary ${x.primary.map((p) => `${p.label}${p.belowTheFold ? " (scrolled to)" : ""}${p.inside && p.onTop ? "" : " ✗"}`).join(", ") || "none"}`);

  ctx.step("no screen scrolls sideways: scrollWidth ≤ clientWidth, and scrollTo(100000, y) leaves scrollX at 0");
  const sideways = surfaces.filter((x) => x.scrollWidth > x.clientWidth + 1 || x.scrolledX !== 0 || x.horizontal.length).map((x) => `${x.name}: scrollWidth ${x.scrollWidth} > ${x.clientWidth}, scrollX ${x.scrolledX} (${x.overflowing.join("; ")}; nested ${JSON.stringify(x.horizontal)})`);
  assert.deepEqual(sideways, [], `screens that scroll sideways at ${PHONE.width} px: ${sideways.join(" | ")}`);
  ctx.step("every primary action is visible and, once scrolled to, wholly inside the viewport and the topmost element at its centre");
  const misplaced = surfaces.flatMap((x) => x.primary.filter((p) => !p.visible || !p.horizontalAtLoad || !p.inside || !p.onTop).map((p) => `${x.name}: ${p.label} ${!p.visible ? "not visible" : !p.horizontalAtLoad ? "initially outside the horizontal viewport" : !p.inside ? `outside the viewport ${JSON.stringify(p.box)}` : `covered by ${p.coveredBy} at its centre`}`));
  assert.deepEqual(misplaced, [], `primary actions out of reach: ${misplaced.join(" | ")}`);
  if (stopped) throw stopped;
});

scenario("A24.1b on the same touch phone walk, every interactive target has a 44×44 CSS px hit area, with an exception for inline prose links", {
  tiers: BOTH,
  timeoutMs: 30_000,
}, async (ctx) => {
  if (walk.surfaces?.length !== walk.expected) ctx.inconclusive(`the A24.1 walk measured ${walk.surfaces?.length ?? 0} of ${walk.expected} surfaces (it runs first, and measures for this case)`);
  const small = walk.surfaces.filter((x) => x.small.length).map((x) => `${x.name}: ${JSON.stringify(x.small)}`);
  ctx.ev.json("small-targets", walk.surfaces.map((x) => ({ surface: x.name, small: x.small })));
  assert.deepEqual(small, [], `targets under ${TAP}×${TAP} on a coarse pointer (SPEC §7 "targets ≥44px"; styles/base.css "Every interactive target reaches 44px on a coarse pointer"): ${small.join(" | ")}`);
});

// --- A24.2: keyboard only ----------------------------------------------------------------

scenario("A24.2a sign-in by keyboard: Tab reaches the skip link (shown when focused), the address, the password and Sign in, Enter signs in, and every stop wears the one --color-focus ring", {
  tiers: BOTH,
  timeoutMs: 180_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const [acct] = await cast(target, ["member"], { notifications: false });
  const u = await ctx.users.user({ name: "kbd" });
  await u.goto("/signup");
  await u.page.locator("#auth-email").waitFor({ state: "visible", timeout: 30_000 });
  const stops = [];

  ctx.step("the first Tab focuses Skip to main content, which slides into view; Enter moves focus to <main>");
  await u.page.keyboard.press("Tab");
  const skip = await focused(u.page);
  stops.push(skip);
  assert.equal(skip.label, "Skip to main content", `the first stop is the skip link (got ${describe(skip)})`);
  assert.ok(skip.visible && skip.box.y >= 0 && skip.box.y + skip.box.h <= 800, `the skip link is on screen while focused: ${JSON.stringify(skip.box)}`);
  await u.page.keyboard.press("Enter");
  await eventually(async () => (await focused(u.page)).id === "main" || false, { timeout: 5_000, message: "focus moved to #main" });

  ctx.step("Tab to the address, type it; Tab to the password, type it; Tab to Sign in, press Enter");
  await tabTo(u.page, (f) => f.id === "auth-email", { what: "the address field", stops });
  await u.page.keyboard.type(acct.email);
  await tabTo(u.page, (f) => f.id === "auth-password", { max: 3, what: "the password field", stops });
  await u.page.keyboard.type(acct.password);
  await tabTo(u.page, isButton("Sign in"), { max: 4, what: 'the "Sign in" button', stops });
  const mark = u.responseMark();
  await u.page.keyboard.press("Enter");
  const res = answered(await u.waitForResponse({ method: "POST", path: "/session" }, { since: mark, timeout: ANSWER_MS }), "POST /session from the sign-in form");
  assert.equal(res.status, 200, "POST /session after Enter on Sign in");
  await eventually(async () => new URL(u.page.url()).pathname !== "/signup" || false, { timeout: 30_000, message: "the app left /signup" });
  assertRings(ctx, stops);
});

scenario("A24.2b comment by keyboard: Shift+→ extends a one-word selection to the phrase, Tab reaches Comment, Enter starts the thread, Tab reaches its reply box and Enter sends", {
  tiers: BOTH,
  timeoutMs: 180_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { u, owner } = await ownerOnPage(ctx);
  const { docId } = await publishPlain(owner, "kbd-comment");
  await quietDoc(target, docId);
  await openDoc(ctx, u, docId);
  const stops = [];

  ctx.step("Tab from the top of the page reaches the document frame");
  await tabTo(u.page, (f) => f.tag === "IFRAME", { what: "the document frame", stops });
  const f = await u.frame();
  ctx.step('"lazy" is selected as caret browsing leaves a word; four Shift+→ extend it to "lazy dog"');
  await setSelection(f, "#a24-1", "lazy");
  for (let i = 0; i < 4; i += 1) await u.page.keyboard.press("Shift+ArrowRight");
  assert.equal(await selectionText(f), "lazy dog", "Shift+→ extended the selection by keyboard");
  await u.page.locator(".selection-fab", { hasText: "Comment" }).waitFor({ state: "visible", timeout: 10_000 });

  ctx.step("Tab: the selection toolbar's Comment takes focus; Enter starts a thread on the phrase");
  const fab = await tabTo(u.page, isButton("Comment"), { max: 2, what: "the selection toolbar's Comment", stops });
  assert.match(fab.cls ?? "", /selection-fab/, "focus is on the selection toolbar's button");
  const ann = await pressUntil(ctx, u, "Enter", async () => {
    const rows = await readCollection(target, `docs/${docId}/versions/v1/annotations`);
    return rows.length === 1 ? rows[0] : false;
  }, { what: "one annotation on v1", retries: 0 });
  assert.equal(ann.data.anchor.exact, "lazy dog", "the thread quotes the keyboard selection");
  const afterComment = await focused(u.page);
  ctx.step(`after Enter on Comment, focus is on ${describe(afterComment)}`);

  ctx.step("Tab reaches the new thread's reply box; typing and Enter send the comment");
  await tabTo(u.page, (x) => x.tag === "TEXTAREA" && x.label === "Reply", { max: 60, what: "the thread's reply box", stops });
  const body = `A24.2b by keyboard ${tag()}`;
  await u.page.keyboard.type(body);
  const comments = await pressUntil(ctx, u, "Enter", async () => {
    const rows = await readCollection(target, `docs/${docId}/versions/v1/annotations/${ann.id}/comments`);
    return rows.length === 1 ? rows : false;
  }, { what: "the comment is stored" });
  assert.deepEqual(comments.map((c) => ({ body: c.data.body, authorEmail: c.data.authorEmail })), [{ body, authorEmail: owner.account.email.toLowerCase() }]);
  await u.thread("lazy dog").first().locator(".comment-body", { hasText: body }).waitFor({ state: "visible", timeout: LISTEN_MS });
  assertRings(ctx, stops);
});

scenario("A24.2c suggest by keyboard: Tab reaches Suggest edit, Enter opens the form focused with the caret at the end, Escape cancels sending nothing, every control of the form is reachable, and its submit by key sends the suggestion", {
  tiers: BOTH,
  timeoutMs: 240_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { u, owner } = await ownerOnPage(ctx);
  const { docId } = await publishPlain(owner, "kbd-suggest");
  await quietDoc(target, docId);
  await openDoc(ctx, u, docId);
  const stops = [];
  const toSuggestEdit = async () => {
    await tabTo(u.page, (f) => f.tag === "IFRAME", { what: "the document frame", stops });
    const f = await u.frame();
    await setSelection(f, "#a24-2", "harbour");
    for (let i = 0; i < 7; i += 1) await u.page.keyboard.press("Shift+ArrowRight");
    assert.equal(await selectionText(f), "harbour lights", "Shift+→ extended the selection");
    // A keyboard reader waits for the selection toolbar too: it appears on the selection's change.
    await u.page.locator(".selection-fab", { hasText: "Suggest edit" }).waitFor({ state: "visible", timeout: 10_000 });
    await tabTo(u.page, isButton("Suggest edit"), { max: 3, what: "Suggest edit", stops });
  };

  ctx.step('Tab to the frame; "harbour lights" by keyboard; Tab, Tab to Suggest edit; Enter');
  await toSuggestEdit();
  const mark = u.responseMark();
  await u.page.keyboard.press("Enter");
  const opened = await eventually(async () => {
    const st = await u.suggestState();
    return st.open ? st : false;
  }, { timeout: 10_000, message: "the suggestion form opened" });
  assert.deepEqual({ value: opened.value, start: opened.start, end: opened.end, focused: opened.focused }, { value: "harbour lights", start: 14, end: 14, focused: true }, "prefilled, focused, the caret at the end");

  ctx.step("Escape closes the form and sends nothing");
  await u.page.keyboard.press("Escape");
  await eventually(async () => !(await u.suggestState()).open, { timeout: 5_000, message: "the form closed on Escape" });
  assert.deepEqual(u.findResponses({ method: "POST", path: "/suggestion" }, { since: mark }).map((r) => r.status), [], "Escape sent no suggestion");

  ctx.step("again by keyboard; replace the text by keys; Tab through the note, the submit button and Cancel");
  await toSuggestEdit();
  await u.page.keyboard.press("Enter");
  await eventually(async () => (await u.suggestState()).focused || false, { timeout: 10_000, message: "the form's field has focus" });
  const R = `harbour beacons ${tag()}`;
  await u.page.keyboard.press("ControlOrMeta+A");
  await u.page.keyboard.type(R);
  assert.equal((await u.suggestState()).value, R, "the field holds the typed replacement");
  const formStops = [];
  for (let i = 0; i < 3; i += 1) {
    await u.page.keyboard.press("Tab");
    const s = await focused(u.page);
    formStops.push(s);
    if (s.tag === "INPUT" && s.label === "Note (optional)") await u.page.keyboard.type("by keyboard");
  }
  stops.push(...formStops);
  const labels = formStops.map(describe);
  ctx.step(`Tab stops after the field: ${labels.join(" → ")}`);
  assert.deepEqual(formStops.map((s) => [s.tag, s.label]), [["INPUT", "Note (optional)"], ["BUTTON", "Suggest"], ["BUTTON", "Cancel"]], `the note, the submit and Cancel follow the field in Tab order: ${labels.join(" → ")}`);

  ctx.step("Shift+Tab to Suggest and press Enter: POST /suggestion 200, a pending suggestion of the typed text");
  await tabTo(u.page, isButton("Suggest"), { back: true, max: 2, what: "the form's submit button", stops });
  const sent = u.responseMark();
  await u.page.keyboard.press("Enter");
  const post = answered(await u.waitForResponse({ method: "POST", path: "/suggestion" }, { since: sent, timeout: ANSWER_MS }), "POST /suggestion from the form");
  assert.equal(post.status, 200, "the suggestion was taken");
  const anns = await readCollection(target, `docs/${docId}/versions/v1/annotations`);
  assert.deepEqual(anns.map((a) => ({ exact: a.data.anchor?.exact, replacement: a.data.suggestion?.replacement, state: a.data.suggestion?.state })), [{ exact: "harbour lights", replacement: R, state: "pending" }]);
  assertRings(ctx, stops);
});

scenario("A24.2d review by keyboard: Edit, Review them, Next, Previous, Reject… with a reason and Accept are each reached by Tab and pressed by key; both decisions are recorded as the owner's, in the app", {
  tiers: BOTH,
  timeoutMs: 240_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { u, owner } = await ownerOnPage(ctx);
  const { docId } = await publishPlain(owner, "kbd-review");
  await quietDoc(target, docId);
  const R1 = `sleepy cat ${tag()}`;
  const R2 = `paper lamps ${tag()}`;
  const ids = {
    "lazy dog": await postSuggestion(owner, docId, anchorFor("a24-1", "lazy dog"), R1),
    "harbour lights": await postSuggestion(owner, docId, anchorFor("a24-2", "harbour lights"), R2),
  };
  await openDoc(ctx, u, docId);
  const stops = [];

  ctx.step("Tab to Edit, Enter: the editor opens and joins the live document");
  await tabTo(u.page, isButton("Edit"), { what: "Edit", stops });
  await u.page.keyboard.press("Enter");
  await u.page.getByRole("toolbar", { name: "Formatting" }).waitFor({ state: "visible", timeout: LISTEN_MS });
  await u.waitForFrame({ editable: true, timeout: LISTEN_MS });
  await eventually(async () => (await u.shareState()) === "shared" || false, { timeout: SERVER_MS, message: "the editor joined the live document" });

  const count = () => u.page.locator(".review-bar .review-count").textContent({ timeout: 2_000 }).then((s) => s.trim()).catch(() => null);
  const del = () => u.page.locator(".review-bar .review-change del").textContent({ timeout: 2_000 }).catch(() => null);
  ctx.step("Tab to Review them (once the bar has the suggestions), Enter: the pass shows 1 of 2");
  await u.page.locator(".review-bar").getByRole("button", { name: "Review them", exact: true }).waitFor({ state: "visible", timeout: LISTEN_MS });
  await tabTo(u.page, isButton("Review them"), { max: 80, what: "Review them", stops });
  await u.page.keyboard.press("Enter");
  await eventually(async () => (await count()) === "1 of 2" || false, { timeout: 15_000, message: "the pass is on 1 of 2" });

  ctx.step("every control of the pass is reachable by Tab: Accept, Reject…, Previous, Next, Done");
  const want = ["Accept", "Reject…", "Previous", "Next", "Done"];
  const barStops = [];
  for (let i = 0; i < 12 && !want.every((w) => barStops.some(isButton(w))); i += 1) {
    await u.page.keyboard.press("Tab");
    barStops.push(await focused(u.page));
  }
  stops.push(...barStops);
  for (const w of want) assert.ok(barStops.some(isButton(w)), `${w} is reachable by Tab (reached: ${barStops.map(describe).join(" → ")})`);

  ctx.step("Next by key: 2 of 2; Previous by key: 1 of 2");
  const first = await del();
  await tabTo(u.page, isButton("Next"), { back: true, max: 12, what: "Next", stops });
  await u.page.keyboard.press("Enter");
  await eventually(async () => (await count()) === "2 of 2" || false, { timeout: 10_000, message: "Next moved to 2 of 2" });
  assert.notEqual(await del(), first, "Next shows the other suggestion");
  await tabTo(u.page, isButton("Previous"), { back: true, max: 12, what: "Previous", stops });
  await u.page.keyboard.press("Enter");
  await eventually(async () => (await count()) === "1 of 2" || false, { timeout: 10_000, message: "Previous moved back to 1 of 2" });

  ctx.step("Reject… by key: the reason field takes focus; a reason and Enter reject it; the pass moves on");
  const rejected = await del();
  await tabTo(u.page, isButton("Reject…"), { back: true, max: 12, what: "Reject…", stops });
  await u.page.keyboard.press("Enter");
  const reasonField = await eventually(async () => {
    const s = await focused(u.page);
    return s.label === "Why reject it? (optional)" ? s : false;
  }, { timeout: 5_000, message: "the reason field has focus" });
  stops.push(reasonField);
  await u.page.keyboard.type(`not this one ${tag()}`);
  await u.page.keyboard.press("Enter");
  await eventually(async () => (await count()) === "1 of 1" || false, { timeout: SERVER_MS, message: "the pass moved on to 1 of 1" });

  ctx.step("Accept by key: Tab to it, Enter; the pass ends with the publish notice");
  const accepted = await del();
  const toast = u.toastMark();
  await tabToNear(u.page, isButton("Accept"), { what: "Accept", stops });
  await u.page.keyboard.press("Enter");
  await u.waitForToast((x) => /That was the last suggestion/.test(x.text), { since: toast, timeout: ANSWER_MS });

  const rec = async (annId) => (await readDoc(target, `docs/${docId}/versions/v1/annotations/${annId}`))?.suggestion;
  const [r, a] = [await rec(ids[rejected]), await rec(ids[accepted])];
  const me = owner.account.email.toLowerCase();
  assert.deepEqual({ state: r?.state, by: r?.decidedBy?.email, channel: r?.decidedBy?.channel }, { state: "rejected", by: me, channel: "web" }, `"${rejected}" rejected in the app`);
  assert.deepEqual({ state: a?.state, by: a?.decidedBy?.email, channel: a?.decidedBy?.channel }, { state: "accepted", by: me, channel: "web" }, `"${accepted}" accepted in the app`);
  assertRings(ctx, stops);
});

/** Where focus was once a person had been added from the Share dialog by keyboard, recorded in A24.2e for A24.2e2. */
const afterAdd = { focus: null, escapeClosed: null };

scenario("A24.2e share by keyboard: the dialog takes focus, Tab and Shift+Tab never leave it, Escape closes it with focus back on Share, and a person is added by keys", {
  tiers: ["local"],
  effects: ["email:POST /access"],
  timeoutMs: 300_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { u, owner, accounts } = await ownerOnPage(ctx, { roles: ["invitee"] });
  const { docId } = await publishPlain(owner, "kbd-share");
  await openDoc(ctx, u, docId);
  const stops = [];
  const dialog = u.page.getByRole("dialog", { name: /^Share/ });

  ctx.step("Tab to Share, Enter: the dialog opens and focus is inside it");
  await tabTo(u.page, isButton("Share"), { what: "Share", stops });
  await u.page.keyboard.press("Enter");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const first = await focused(u.page);
  assert.ok(first.dialog?.startsWith("Share"), `focus moved into the dialog (got ${describe(first)})`);

  ctx.step("Tab round the dialog twice, then Shift+Tab: focus never leaves it");
  const ring = [];
  for (let i = 0; i < 24; i += 1) {
    await u.page.keyboard.press("Tab");
    ring.push({ key: "Tab", ...(await focused(u.page)) });
  }
  for (let i = 0; i < 12; i += 1) {
    await u.page.keyboard.press("Shift+Tab");
    ring.push({ key: "Shift+Tab", ...(await focused(u.page)) });
  }
  stops.push(...ring);
  ctx.ev.json("dialog-walk", ring);
  assert.deepEqual(ring.filter((s) => !s.dialog?.startsWith("Share")).map((s) => `${s.key}: ${describe(s)}`), [], "Tab and Shift+Tab stay inside the Share dialog");
  assert.ok(ring.some(isButton("Done")) && ring.some(isButton("Close")), "the walk went all the way round (Done and Close both reached)");

  ctx.step("Escape closes the dialog and focus returns to Share");
  await u.page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached", timeout: 10_000 });
  const back = await focused(u.page);
  assert.ok(isButton("Share")(back), `focus returned to the button that opened the dialog (got ${describe(back)})`);

  ctx.step("Enter on Share again; Tab to the address field, type the person, Tab to Add, Enter: they are added");
  await u.page.keyboard.press("Enter");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await tabTo(u.page, (f) => f.id === "share-input", { max: 12, what: "the address field", stops });
  await u.page.keyboard.type(accounts[1].email);
  await tabTo(u.page, isButton("Add"), { max: 4, what: "Add", stops });
  const mark = u.responseMark();
  await u.page.keyboard.press("Enter");
  const access = answered(await u.waitForResponse({ method: "POST", path: "/access" }, { since: mark, timeout: ANSWER_MS }), "POST /access from the dialog");
  assert.equal(access.status, 200, "POST /access from the dialog");
  await eventually(async () => ((await readDoc(target, `docs/${docId}`))?.members ?? []).includes(accounts[1].email.toLowerCase()) || false, { timeout: SERVER_MS, message: "the person is a member" });
  await u.page.getByRole("dialog").getByText(accounts[1].email.toLowerCase()).first().waitFor({ state: "visible", timeout: SERVER_MS });

  ctx.step("for A24.2e2: where focus is once the person is added, and whether Escape then closes the dialog");
  afterAdd.focus = await focused(u.page);
  ctx.step(`after Add: focus on ${describe(afterAdd.focus)} (${afterAdd.focus.dialog ? "inside" : "outside"} the dialog)`);
  await u.page.keyboard.press("Escape");
  afterAdd.escapeClosed = await dialog.waitFor({ state: "detached", timeout: 5_000 }).then(() => true, () => false);
  assertRings(ctx, stops);
});

scenario("A24.2e2 after a person is added from the Share dialog by keyboard, focus stays inside the dialog, so Escape still closes it", {
  tiers: ["local"],
  timeoutMs: 30_000,
}, async (ctx) => {
  if (!afterAdd.focus) ctx.inconclusive("A24.2e did not get as far as adding a person by keyboard (it runs first, and measures for this case)");
  ctx.step(`after Add: focus on ${describe(afterAdd.focus)}; Escape closed the dialog: ${afterAdd.escapeClosed}`);
  assert.deepEqual({ focusInDialog: Boolean(afterAdd.focus.dialog?.startsWith("Share")), escapeClosed: afterAdd.escapeClosed }, { focusInDialog: true, escapeClosed: true }, `once Add has worked, focus has fallen to ${describe(afterAdd.focus)}: components/Modal.tsx "Trap Tab inside itself" and "Close on Escape" no longer hold`);
});

/** A small document for the upload dialog, built here so nothing binary is committed. */
const uploadFile = (title) => ({ name: "keyboard-upload.html", mimeType: "text/html", buffer: Buffer.from(plainHtml(title)) });
/** One full Tab round of the upload dialog, recorded in A24.2f for A24.2f2. */
const uploadRound = { stops: null };

scenario("A24.2f upload by keyboard: Tab to Upload, Enter opens the dialog with focus inside and Tab kept in it; Choose a file by key (the OS picker answered by the harness), a title typed, Upload pressed by key publishes the document", {
  tiers: BOTH,
  timeoutMs: 240_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { u, owner } = await ownerOnPage(ctx);
  // Listening from the start: Playwright turns on file-chooser interception when the first listener is
  // added, and a listener added just before the key press can lose that race (the picker then opens
  // natively, unseen).
  const choosers = [];
  u.page.on("filechooser", (fc) => choosers.push(fc));
  await u.goto("/");
  await u.page.getByRole("button", { name: "Upload", exact: true }).waitFor({ state: "visible", timeout: LISTEN_MS });
  const stops = [];

  ctx.step("Tab to Upload, Enter: the dialog opens with focus inside");
  await tabTo(u.page, isButton("Upload"), { what: "Upload", stops });
  await u.page.keyboard.press("Enter");
  const dialog = u.page.getByRole("dialog", { name: "Upload a document" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const start = await focused(u.page);
  assert.equal(start.dialog, "Upload a document", `focus is inside the dialog (got ${describe(start)})`);

  ctx.step("Tab once round the dialog: every stop is in it, and the round closes on where it began");
  const round = [];
  for (let i = 0; i < 12; i += 1) {
    await u.page.keyboard.press("Tab");
    const s = await focused(u.page);
    round.push(s);
    if (describe(s) === describe(start)) break;
  }
  uploadRound.stops = round;
  ctx.ev.json("dialog-round", round);
  assert.deepEqual(round.filter((s) => s.dialog !== "Upload a document").map(describe), [], "Tab stays inside the upload dialog");
  assert.equal(describe(round.at(-1)), describe(start), `Tab came round to where it began (${round.map(describe).join(" → ")})`);
  stops.push(...round.filter((s) => s.visible));

  ctx.step("Tab to Choose a file, Enter: the file picker opens; the harness answers it");
  await tabTo(u.page, isButton("Choose a file"), { max: 8, what: "Choose a file", stops });
  const title = `A24 keyboard upload ${tag()}`;
  const before = choosers.length;
  await u.page.keyboard.press("Enter");
  const chooser = await eventually(() => choosers[before] ?? false, { timeout: 10_000, interval: 50, message: "Enter on Choose a file opened the file picker" });
  await chooser.setFiles(uploadFile(title));
  await dialog.getByText("keyboard-upload.html").waitFor({ state: "visible", timeout: 10_000 });

  ctx.step("Tab to the title, type it; Tab to Upload, Enter");
  await tabTo(u.page, (f) => f.id === "upload-title", { max: 6, what: "the title field", stops });
  await u.page.keyboard.type(title);
  await tabTo(u.page, (f) => isButton("Upload")(f) && f.dialog === "Upload a document", { max: 8, what: "the dialog's Upload", stops });
  const mark = u.responseMark();
  await u.page.keyboard.press("Enter");
  const res = answered(await u.waitForResponse({ method: "POST", path: "/publish" }, { since: mark, timeout: ANSWER_MS }), "POST /publish from the dialog");
  const json = await res.response.json().catch(() => null);
  if (res.status === 200 && json?.docId) ledgerDoc(target, { docId: json.docId, via: "upload-ui", ownerEmail: owner.account.email, actor: u.name, versionId: json.versionId ?? null });
  assert.equal(res.status, 200, `POST /publish from the dialog: ${JSON.stringify(json)}`);
  const doc = await readDoc(target, `docs/${json.docId}`);
  assert.deepEqual({ title: doc?.title, owner: doc?.ownerEmail }, { title, owner: owner.account.email.toLowerCase() }, "the uploaded document, titled as typed");
  assertRings(ctx, stops);
});

scenario("A24.2f2 every Tab stop of the upload dialog is something visible: focus never lands on a visually hidden element", {
  tiers: BOTH,
  timeoutMs: 30_000,
}, async (ctx) => {
  if (!(uploadRound.stops?.length > 1)) ctx.inconclusive("A24.2f recorded no Tab round of the upload dialog (it runs first, and measures for this case)");
  const hidden = uploadRound.stops.filter((s) => !s.visible).map((s) => `${describe(s)} (class "${s.cls ?? ""}", ${s.box.w}×${s.box.h})`);
  ctx.step(`the round: ${uploadRound.stops.map((s) => `${describe(s)}${s.visible ? "" : " (hidden)"}`).join(" → ")}`);
  assert.deepEqual(hidden, [], "a Tab stop shows nothing to focus (WCAG 2.4.7; SPEC §7 \"visible :focus-visible\")");
});

scenario("A24.2g versions by keyboard: Tab to More actions, Enter opens the menu on its first item, Escape closes it onto its trigger; ArrowDown reaches an older version and Enter pins it", {
  tiers: BOTH,
  timeoutMs: 150_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { u, owner } = await ownerOnPage(ctx);
  const { docId, title } = await publishPlain(owner, "kbd-versions");
  const up = await updateUpload(owner.http, docId, { body: plainHtml(`${title} (two)`), baseVersion: "v1" });
  precondition(up.status === 200 && up.json?.versionId === "v2", `update to v2: ${up.status}`);
  await openDoc(ctx, u, docId);
  await u.waitForFrame({ match: /\/v2\//, timeout: LISTEN_MS });
  const stops = [];

  ctx.step("Tab to More actions, Enter: the menu opens with its first item focused; Escape closes it onto More actions");
  await tabTo(u.page, isButton("More actions"), { what: "More actions", stops });
  await u.page.keyboard.press("Enter");
  const first = await eventually(async () => {
    const s = await focused(u.page);
    return s.menu ? s : false;
  }, { timeout: 5_000, message: "focus is in the menu" });
  stops.push(first);
  await u.page.keyboard.press("Escape");
  await u.page.getByRole("menu").waitFor({ state: "detached", timeout: 5_000 });
  const back = await focused(u.page);
  assert.ok(isButton("More actions")(back), `Escape returns focus to the trigger (got ${describe(back)})`);

  ctx.step("Enter again (Escape and again, until the version list has loaded); ArrowDown to v1; Enter pins it");
  await eventually(async () => {
    await u.page.keyboard.press("Enter");
    await u.page.getByRole("menu").waitFor({ state: "visible", timeout: 5_000 });
    if (await u.page.getByRole("menu").getByRole("menuitem", { name: "v1", exact: true }).count()) return true;
    await u.page.keyboard.press("Escape");
    await u.page.getByRole("menu").waitFor({ state: "detached", timeout: 5_000 });
    return false;
  }, { timeout: SERVER_MS, interval: 1_000, message: "the menu lists the versions" });
  const walked = [];
  for (let i = 0; i < 30; i += 1) {
    const s = await focused(u.page);
    walked.push(s);
    if (s.label === "v1") break;
    await u.page.keyboard.press("ArrowDown");
  }
  stops.push(...walked);
  precondition(walked.at(-1)?.label === "v1", `ArrowDown reached v1 (walked: ${walked.map((s) => s.label).join(", ")})`);
  await u.page.keyboard.press("Enter");
  await eventually(async () => new URL(u.page.url()).pathname === `/d/${docId}/v1` || false, { timeout: 15_000, message: "the address pins v1" });
  await u.waitForFrame({ match: /\/v1\//, timeout: LISTEN_MS });
  assertRings(ctx, stops);
});

/** The rail's current slide, by its accessible name. */
const railCurrent = (u) => u.page.evaluate(() => document.querySelector(".slide-rail [aria-current='true']")?.getAttribute("aria-label") ?? null);
const overview = (u) => u.page.locator('[role="dialog"][aria-label="All slides"]');
/** The overview's Tab walk, recorded in A24.2h for A24.2j. */
const overviewWalk = { stops: null, focusable: 0, modal: null };

scenario("A24.2h deck keys: → and ← move the current slide from the page and from inside the frame; o opens the overview on the current slide, Enter on another card goes there, Escape closes it", {
  tiers: BOTH,
  timeoutMs: 180_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { u, owner } = await ownerOnPage(ctx);
  const deckId = await publishDeck(owner, "kbd-deck");
  await openDoc(ctx, u, deckId);
  const at = (name, msg) => eventually(async () => (await railCurrent(u)) === name || false, { timeout: 10_000, message: msg });
  await eventually(async () => (await railCurrent(u)) === "Slide 1: Quarter review" || false, { timeout: LISTEN_MS, message: "the rail shows slide 1 as current" });

  ctx.step("from the page: →, →, ←");
  await u.page.keyboard.press("ArrowRight");
  await at("Slide 2: What we will cover", "→ moved to slide 2");
  await u.page.keyboard.press("ArrowRight");
  await at("Slide 3: The three numbers that moved", "→ moved to slide 3");
  await u.page.keyboard.press("ArrowLeft");
  await at("Slide 2: What we will cover", "← moved back to slide 2");

  ctx.step("from inside the frame (reached by Tab): → moves on, ← moves back");
  await tabTo(u.page, (f) => f.tag === "IFRAME", { max: 60, what: "the document frame" });
  await u.page.keyboard.press("ArrowRight");
  await at("Slide 3: The three numbers that moved", "→ inside the frame moved to slide 3");
  await u.page.keyboard.press("ArrowLeft");
  await at("Slide 2: What we will cover", "← inside the frame moved back to slide 2");

  ctx.step("o opens the overview with focus on the current slide's card");
  await u.page.keyboard.press("o");
  await overview(u).waitFor({ state: "visible", timeout: 10_000 });
  const card = await focused(u.page);
  assert.equal(card.label, "Slide 2: What we will cover", `focus lands on the current slide's card (got ${describe(card)})`);
  assert.equal(ringProblem(card), null, `the card wears the ring: ${ringProblem(card)}`);

  ctx.step("the overview's Tab walk, for A24.2j: Tab then Shift+Tab, each two past its focusable count");
  overviewWalk.modal = await overview(u).getAttribute("aria-modal");
  overviewWalk.focusable = await overview(u).evaluate((d) => d.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])").length);
  const walkStops = [];
  for (let i = 0; i < overviewWalk.focusable + 2; i += 1) {
    await u.page.keyboard.press("Tab");
    walkStops.push({ key: "Tab", ...(await focused(u.page)) });
  }
  for (let i = 0; i < overviewWalk.focusable + 2; i += 1) {
    await u.page.keyboard.press("Shift+Tab");
    walkStops.push({ key: "Shift+Tab", ...(await focused(u.page)) });
  }
  overviewWalk.stops = walkStops;
  ctx.ev.json("overview-walk", walkStops);

  ctx.step("Escape closes the overview; o opens it again on slide 2; Tab to slide 3's card, Enter goes there and closes it");
  await u.page.keyboard.press("Escape");
  await overview(u).waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(await railCurrent(u), "Slide 2: What we will cover", "Escape changed no slide");
  await u.page.keyboard.press("o");
  await overview(u).waitFor({ state: "visible", timeout: 10_000 });
  const again = await focused(u.page);
  assert.equal(again.label, "Slide 2: What we will cover", `o reopened the overview on the current card (got ${describe(again)})`);
  await u.page.keyboard.press("Tab");
  const next = await focused(u.page);
  assert.equal(next.label, "Slide 3: The three numbers that moved", `Tab moved to the next card (got ${describe(next)})`);
  await u.page.keyboard.press("Enter");
  await overview(u).waitFor({ state: "detached", timeout: 10_000 });
  await at("Slide 3: The three numbers that moved", "Enter on a card went to that slide");
});

scenario("A24.2j the slide overview, a dialog with aria-modal=\"true\", keeps Tab and Shift+Tab inside it", {
  tiers: BOTH,
  timeoutMs: 30_000,
}, async (ctx) => {
  if (!(overviewWalk.stops?.length >= 4 && overviewWalk.focusable >= 2)) ctx.inconclusive("A24.2h did not walk the overview by Tab (it runs first, and measures for this case)");
  precondition(overviewWalk.modal === "true", `the overview declares aria-modal="true" (got ${overviewWalk.modal})`);
  const outside = overviewWalk.stops.filter((s) => s.dialog !== "All slides").map((s) => `${s.key}: ${describe(s)}`);
  ctx.step(`the walk: ${overviewWalk.stops.map((s) => `${s.key} ${describe(s)}${s.dialog === "All slides" ? "" : " (outside)"}`).join(" → ")}`);
  assert.deepEqual(outside, [], "focus left an aria-modal dialog (WAI-ARIA aria-modal; components/Modal.tsx: \"Trap Tab inside itself, or Tab walks into the page behind it\")");
});

scenario("A24.2i consent approval by keyboard: Approve arms on a key press after its second, is reached by Tab and pressed with Enter, and the redirect carries the code and state", {
  tiers: BOTH,
  timeoutMs: 240_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const t = tag();
  const { u } = await ownerOnPage(ctx);
  ctx.step("claim a loopback receiver for the redirect, watching the consent page's own requests; register an app that returns there");
  const receiver = await startReceiver({ target, page: u, claimTimeoutMs: 30_000 });
  try {
    const reg = await register(ctx.http({ actor: "oauth-app", cutoffError: true }), { redirectUris: [receiver.redirectUri], clientName: `E2E A24 keyboard ${t}` });
    precondition(reg.status === 201, `registration: ${reg.status}`);
    const params = authorizeParams({ clientId: reg.clientId, redirectUri: receiver.redirectUri, challenge: pkce().challenge });
    ctx.step("open /connect with the request");
    await u.page.bringToFront();
    await u.goto(`/connect?${new URLSearchParams(params)}`);
    const approve = u.page.getByRole("button", { name: "Approve", exact: true });
    await approve.waitFor({ state: "visible", timeout: LISTEN_MS });
    const stops = [];

    ctx.step("Approve starts disabled; the product arms it only after a second of focus and then a key press (a time-based wait)");
    assert.equal(await approve.isDisabled({ timeout: 5_000 }), true, "Approve is disabled when it appears");
    await sleep(1_200);
    ctx.step("Tab until Approve has focus: the first Tab is the key press that arms it");
    const f = await eventually(async () => {
      await u.page.keyboard.press("Tab");
      const s = await focused(u.page);
      stops.push(s);
      return isButton("Approve")(s) ? s : false;
    }, { timeout: 20_000, interval: 100, message: "Approve reached by Tab" });
    assert.equal(f.label, "Approve");
    ctx.step("Enter: the browser goes back to the app with the code and the state");
    await u.page.keyboard.press("Enter");
    // Past Hosting's minute, so a POST /oauth/consent the stack never answered is seen as its cut-off.
    const back = await receiver.received(ANSWER_MS);
    // Leave the receiver's page before the receiver closes: a page still reading from a server that
    // closed under it once left the context unclosable.
    await u.page.goto("about:blank", { timeout: 10_000 }).catch(() => undefined);
    assert.equal(back.state, params.state, "state round-trips");
    assert.match(back.code ?? "", /^[A-Za-z0-9_-]{43}$/, `an authorization code came back: ${JSON.stringify(Object.keys(back.query))}`);
    assertRings(ctx, stops);
  } finally {
    ctx.step("release the receiver");
    await Promise.race([receiver.close(), sleep(5_000)]);
  }
});

// --- A24.3: reduced motion ----------------------------------------------------------------

/**
 * Sample, on every animation frame of the PARENT page (the document frame
 * runs no script of its own), the frame's scrollY and the comments list's
 * scrollTop, for `ms` milliseconds from now.
 */
function startScrollSampler(ms) {
  const frame = document.querySelector("iframe.doc-frame");
  let list = document.querySelector(".comments-panel .thread");
  while (list && list !== document.body) {
    const cs = getComputedStyle(list);
    if (/(auto|scroll)/.test(cs.overflowY) && list.scrollHeight > list.clientHeight) break;
    list = list.parentElement;
  }
  if (list === document.body) list = null;
  const samples = [];
  window.__a24samples = samples;
  const t0 = performance.now();
  const sample = () => samples.push({ t: Math.round(performance.now() - t0), frame: Math.round(frame?.contentWindow?.scrollY ?? -1), list: list ? Math.round(list.scrollTop) : null, rail: Math.round(document.querySelector(".slide-rail")?.scrollTop ?? 0) });
  const tick = () => {
    sample();
    if (performance.now() - t0 < ms) requestAnimationFrame(tick);
  };
  // The position before the action, taken now: an instant scroll can land before the next frame's first sample.
  sample();
  requestAnimationFrame(tick);
  return { list: list ? String(list.className) : null };
}

/** The positions a scroll passed through: its start, its end, and how many distinct positions lay between. */
function scrollPath(samples, key) {
  const values = samples.map((s) => s[key]).filter((v) => v != null);
  const path = values.filter((v, i) => i === 0 || v !== values[i - 1]);
  return { start: path[0], end: path.at(-1), moved: Math.abs(path.at(-1) - path[0]), between: Math.max(0, path.length - 2), frames: values.length, path: path.slice(0, 40) };
}

async function sampleScroll(u, act, { key, ms = 2_000 }) {
  const info = await u.page.evaluate(startScrollSampler, ms);
  await act();
  // The sampler's own window: a fixed span of animation frames is what is measured.
  await sleep(ms + 200);
  const samples = await u.page.evaluate(() => window.__a24samples);
  return { ...scrollPath(samples, key), list: info.list };
}

/** Scroll the comments list to its far end, as a reader who scrolled the panel down. */
function scrollListToEnd() {
  let el = document.querySelector(".comments-panel .thread");
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    }
    el = el.parentElement;
  }
  return null;
}

/** Where the comments list is scrolled, and whether that is its far end. */
function listScrollState() {
  let el = document.querySelector(".comments-panel .thread");
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) return { top: el.scrollTop, atEnd: el.scrollTop >= el.scrollHeight - el.clientHeight - 2 };
    el = el.parentElement;
  }
  return { top: null, atEnd: false };
}

/** The centre of the nth highlight in the frame's own viewport, scrolled into view first. */
async function markPoint(u, n) {
  const p = await (await u.frame()).evaluate((i) => {
    const m = document.querySelectorAll("mark.bshd-hl")[i];
    if (!m) return null;
    m.scrollIntoView({ block: "center" });
    const r = m.getClientRects()[0];
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, n);
  precondition(p, `highlight ${n} is drawn`);
  return p;
}

/** The panel's scroll path when a highlight is clicked, measured in A24.3a for A24.3b. */
const panelMotion = { smooth: null, instant: null };

scenario("A24.3a with reduced motion, selecting a thread brings its passage into view in one frame; with no preference the same scroll animates", {
  tiers: BOTH,
  timeoutMs: 240_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { u, owner } = await ownerOnPage(ctx);
  const title = `A24 motion ${tag()}`;
  const up = await publish(owner.http, { body: longHtml(title), filename: "index.html", title, name: "a24-motion", ownerEmail: owner.account.email });
  precondition(up.status === 200, `publish: ${up.status}`);
  await quietDoc(target, up.docId);
  const mcp = await mcpFor(ctx, owner, "owner-mcp");
  const quoted = MARKERS.filter((_, i) => i % 3 === 0);
  for (const w of quoted) await addComment(mcp, up.docId, `${w} marker phrase`, `note on ${w}`);
  await openDoc(ctx, u, up.docId);
  await u.openComments();
  const cards = u.page.locator(".comments-panel .thread");
  await eventually(async () => (await cards.count()) === quoted.length || false, { timeout: LISTEN_MS, message: `${quoted.length} threads in the panel` });
  await eventually(async () => (await (await u.frame()).locator("mark.bshd-hl").count()) >= quoted.length || false, { timeout: LISTEN_MS, message: "every highlight drawn" });
  const prefers = (pref) => u.page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches).then((m) => m === (pref === "reduce"));

  ctx.step("no preference: the last thread's card is selected; the frame scrolls to its passage, and the sampler sees it animate");
  await u.page.emulateMedia({ reducedMotion: "no-preference" });
  precondition(await prefers("no-preference"), "the page reports no motion preference");
  const smooth = await sampleScroll(u, () => cards.nth(quoted.length - 1).click(), { key: "frame" });
  ctx.step(`frame path (no preference): ${JSON.stringify(smooth.path)} over ${smooth.frames} frames`);
  precondition(smooth.moved > 200, `the selection scrolled the frame (${smooth.moved} px)`);
  assert.ok(smooth.between >= 3, `with no preference the scroll animates through intermediate positions (${smooth.between}), so the sampler can see motion`);

  ctx.step("reduce: the first thread's card is selected; the frame jumps back to its passage in a single step");
  await u.page.emulateMedia({ reducedMotion: "reduce" });
  precondition(await prefers("reduce"), "the page reports prefers-reduced-motion: reduce");
  const instant = await sampleScroll(u, () => cards.nth(0).click(), { key: "frame" });
  ctx.step(`frame path (reduce): ${JSON.stringify(instant.path)} over ${instant.frames} frames`);
  precondition(instant.moved > 200, `the selection scrolled the frame (${instant.moved} px)`);
  assert.equal(instant.between, 0, `with reduced motion the passage is brought into view in one frame, not animated: ${JSON.stringify(instant.path)}`);

  ctx.step("for A24.3b, the panel: scrolled to its end, a click on the second highlight (no preference), then on the first (reduce)");
  for (const [pref, n, slot] of [["no-preference", 1, "smooth"], ["reduce", 0, "instant"]]) {
    await u.page.emulateMedia({ reducedMotion: pref });
    precondition(await prefers(pref), `the page reports ${pref}`);
    const point = await markPoint(u, n);
    // Parked at its far end and still there over three frames: a smooth scroll still running from the
    // previous click would otherwise carry the list back up under the new measurement.
    await eventually(async () => {
      const at = await u.page.evaluate(scrollListToEnd);
      await settle(u.page);
      const now = await u.page.evaluate(listScrollState);
      return at > 0 && now.top === at && now.atEnd ? now.top : false;
    }, { timeout: 15_000, interval: 300, stableSamples: 3, message: "the comments list rests at its far end" });
    panelMotion[slot] = await sampleScroll(u, () => u.clickInFrame(point), { key: "list" });
    ctx.step(`panel path (${pref}): ${JSON.stringify(panelMotion[slot].path)} in ${panelMotion[slot].list}`);
  }
});

scenario("A24.3b with reduced motion, a click on a highlight brings its thread card into view in the panel in one frame (with no preference it animates)", {
  tiers: BOTH,
  timeoutMs: 30_000,
}, async (ctx) => {
  const { smooth, instant } = panelMotion;
  if (!(smooth && instant)) ctx.inconclusive("A24.3a did not measure the panel's scroll after a highlight click (it runs first, and measures for this case)");
  precondition(smooth.list && smooth.moved > 200 && smooth.between >= 3, `with no preference the click scrolled the panel and the sampler saw it animate (moved ${smooth.moved}, ${smooth.between} between)`);
  precondition(instant.moved > 200, `with reduced motion the click scrolled the panel (${instant.moved} px)`);
  ctx.step(`panel path with reduced motion: ${JSON.stringify(instant.path)}`);
  assert.equal(instant.between, 0, `with reduced motion the thread card is brought into view in one frame, not animated through ${instant.between} positions (SPEC §7 "prefers-reduced-motion honoured"): ${JSON.stringify(instant.path)}`);
});

/** Observe real scroll requests while preserving the native method and rendered motion. */
function observeScrollCallsInPage() {
  window.__a24scrollCalls = [];
  const views = [["app", window], ["frame", document.querySelector("iframe.doc-frame").contentWindow]];
  for (const [source, view] of views) {
    const original = view.Element.prototype.scrollIntoView;
    view.Element.prototype.scrollIntoView = function (options) {
      window.__a24scrollCalls.push({ source, tag: this.tagName, id: this.id, rail: this.matches(".slide-thumb"), behavior: options?.behavior });
      return original.call(this, options);
    };
  }
}

scenario("A24.3c reduced motion is honoured by review Next, deck arrow navigation and the slide rail following the current slide", {
  tiers: BOTH,
  timeoutMs: 180_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { u, owner } = await ownerOnPage(ctx);
  await u.page.emulateMedia({ reducedMotion: "reduce" });
  const title = `A24 review motion ${tag()}`;
  const up = await publish(owner.http, { body: longHtml(title), filename: "index.html", title, name: "a24-review-motion", ownerEmail: owner.account.email });
  precondition(up.status === 200, "the long review document was published");
  await quietDoc(target, up.docId);
  for (const n of [0, 29]) {
    const exact = `${MARKERS[n]} marker phrase`;
    const prefix = `Paragraph ${n + 1} speaks of the `;
    const suffix = " and then goes on for a while so ";
    await postSuggestion(owner, up.docId, { elementId: `m-${n + 1}`, exact, prefix, suffix, start: prefix.length, end: prefix.length + exact.length }, `${exact} revised`);
  }
  await openDoc(ctx, u, up.docId);
  await u.enterEdit({ waitShared: true });
  await u.page.locator(".review-bar").getByRole("button", { name: "Review them", exact: true }).click({ timeout: LISTEN_MS });
  await settle(u.page);
  await u.page.evaluate(observeScrollCallsInPage);
  const review = await sampleScroll(u, () => u.page.locator(".review-bar").getByRole("button", { name: "Next", exact: true }).click(), { key: "frame" });
  const reviewCalls = await u.page.evaluate(() => window.__a24scrollCalls.filter((x) => x.source === "frame"));
  assert.ok(reviewCalls.length > 0 && reviewCalls.every((x) => x.behavior === "auto"), `review Next uses auto with reduced motion: ${JSON.stringify(reviewCalls)}`);
  precondition(review.moved > 200, "review Next moved to a distant passage");
  assert.equal(review.between, 0, `review Next does not animate: ${JSON.stringify(review.path)}`);

  const deckTitle = `A24 motion deck ${tag()}`;
  const body = `<!doctype html><html lang="en"><head><title>${deckTitle}</title><style>body{margin:0;font:24px sans-serif}section{height:800px;padding:40px;box-sizing:border-box}</style></head><body>${Array.from({ length: 20 }, (_, i) => `<section class="slide" id="slide-${i + 1}"><h1>Motion slide ${i + 1}</h1><p>Authored slide content.</p></section>`).join("")}</body></html>`;
  const deck = await publish(owner.http, { body, filename: "index.html", title: deckTitle, name: "a24-motion-deck", ownerEmail: owner.account.email });
  precondition(deck.status === 200, "the long deck was published");
  await openDoc(ctx, u, deck.docId);
  await u.page.locator(".slide-rail .slide-thumb").last().waitFor({ state: "attached", timeout: LISTEN_MS });
  // End puts both scrollports far from their start. ArrowLeft then exercises
  // the normal arrow path while the rail must follow a card outside its view.
  await u.page.keyboard.press("End");
  await settle(u.page);
  await u.page.evaluate(() => { document.querySelector(".slide-rail").scrollTop = 0; });
  await u.page.evaluate(observeScrollCallsInPage);
  const deckMotion = await sampleScroll(u, () => u.page.keyboard.press("ArrowLeft"), { key: "frame" });
  const samples = await u.page.evaluate(() => window.__a24samples);
  const railMotion = scrollPath(samples, "rail");
  const calls = await u.page.evaluate(() => window.__a24scrollCalls);
  for (const [name, rows] of [["deck arrow", calls.filter((x) => x.source === "frame")], ["rail follow", calls.filter((x) => x.rail)]]) {
    assert.ok(rows.length > 0 && rows.every((x) => x.behavior === "auto"), `${name} uses auto with reduced motion: ${JSON.stringify(rows)}`);
  }
  precondition(deckMotion.moved > 200 && railMotion.moved > 200, "the arrow moved the deck and its rail");
  assert.equal(deckMotion.between, 0, `deck arrow does not animate: ${JSON.stringify(deckMotion.path)}`);
  assert.equal(railMotion.between, 0, `rail follow does not animate: ${JSON.stringify(railMotion.path)}`);
  ctx.ev.json("remaining-motion-paths", { review, reviewCalls, deckMotion, railMotion, calls });
});

// --- A24.4: touch -------------------------------------------------------------------------

/** The selected thread in the panel, and whether a reader can see it. */
function selectedThreadInPage() {
  const t = document.querySelector('.comments-panel .thread[aria-selected="true"]');
  const pane = document.querySelector(".viewer")?.getAttribute("data-pane") ?? null;
  if (!t) return { selected: false, pane };
  const r = t.getBoundingClientRect();
  const panel = document.querySelector(".comments-panel");
  const quote = t.querySelector(".thread-quote")?.textContent ?? null;
  const shown = getComputedStyle(panel).display !== "none" && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  return { selected: true, quote, shown, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], pane };
}

/** An owner on a touch device, a plain document, and an agent's thread on "lazy dog". */
async function touchCase(ctx, device, name) {
  const { u, owner } = await ownerOnPage(ctx, { device, name });
  await assertCoarse(u);
  const { docId } = await publishPlain(owner, name);
  await quietDoc(target, docId);
  const mcp = await mcpFor(ctx, owner, "owner-mcp");
  await addComment(mcp, docId, "lazy dog", `A24.4 thread ${tag()}`);
  await openDoc(ctx, u, docId);
  await eventually(async () => (await (await u.frame()).locator("mark.bshd-hl").count()) >= 1 || false, { timeout: LISTEN_MS, message: "the thread's highlight is drawn" });
  return { u, docId };
}

/** Same real long press, toolbar geometry and comment persistence on phone and tablet. */
async function longPressComment(ctx, u, docId) {
  ctx.step('a long press (a touch held 1.2 s) on "lanterns": the word is selected and the selection toolbar shows, inside the viewport');
  await u.tap(await quotePoint(u, "#a24-2", "lanterns"), { durationMs: 1_200 });
  const word = await eventually(async () => (await selectionText(await u.frame())).trim() || false, { timeout: 5_000, message: "the long press selected text" });
  assert.equal(word, "lanterns", "the long press selected the word under the finger");
  const comment = u.page.locator(".selection-fab", { hasText: "Comment" });
  await comment.waitFor({ state: "visible", timeout: 5_000 });
  const place = await comment.evaluate(placementInPage);
  assert.deepEqual({ inside: place.inside, onTop: place.onTop }, { inside: true, onTop: true }, `the toolbar's Comment is on screen and uncovered: ${JSON.stringify(place)}`);

  ctx.step('tap Comment: a thread on "lanterns" is created, selected and shown');
  const box = await comment.boundingBox();
  await u.tap({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await eventually(async () => (await readCollection(target, `docs/${docId}/versions/v1/annotations`)).some((r) => r.data.anchor?.exact === "lanterns") || false, { timeout: SERVER_MS, message: 'an annotation on "lanterns"' });
  await eventually(async () => {
    const x = await u.page.evaluate(selectedThreadInPage);
    return (x.selected && x.shown && x.quote?.includes("lanterns")) || false;
  }, { timeout: LISTEN_MS, message: "the new thread is selected and shown" });
}

scenario("A24.4a on a touch tablet (two columns), a tap on a highlight selects its thread in the visible panel, and a long press selects a word and shows the selection toolbar, whose Comment, tapped, starts a thread", {
  tiers: BOTH,
  timeoutMs: 180_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { u, docId } = await touchCase(ctx, TABLET, "touch-tablet");
  await u.openComments();
  await u.page.getByRole("button", { name: "Close comments", exact: true }).click();
  precondition(await u.page.locator(".viewer-body").getAttribute("data-comments") === "closed", "the tablet panel is explicitly closed before the tap");

  ctx.step('tap the highlight on "lazy dog": its thread is selected, in the panel, on screen');
  await u.tap(await quotePoint(u, "#a24-1", "lazy dog"));
  const sel = await eventually(async () => {
    const x = await u.page.evaluate(selectedThreadInPage);
    return x.selected ? x : false;
  }, { timeout: 10_000, message: "a thread is selected after the tap" });
  assert.deepEqual({ quote: Boolean(sel.quote?.includes("lazy dog")), shown: sel.shown }, { quote: true, shown: true }, `the tapped passage's thread is selected and visible: ${JSON.stringify(sel)}`);

  await longPressComment(ctx, u, docId);
});

scenario("A24.4b on a touch phone (one column), a tap on a highlight shows its thread", {
  tiers: BOTH,
  timeoutMs: 150_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { u, docId } = await touchCase(ctx, PHONE, "touch-phone");
  precondition((await u.page.locator(".viewer").getAttribute("data-pane")) === "doc", "the phone shows the document pane");

  ctx.step('tap the highlight on "lazy dog"');
  await u.tap(await quotePoint(u, "#a24-1", "lazy dog"));
  const sel = await eventually(async () => {
    const x = await u.page.evaluate(selectedThreadInPage);
    return x.selected ? x : false;
  }, { timeout: 10_000, message: "the tap reached the highlight: its thread is selected" });
  ctx.step(`after the tap: ${JSON.stringify(sel)}`);
  precondition(sel.quote?.includes("lazy dog"), `the selected thread is the tapped passage's (${sel.quote})`);
  await ctx.oracle(() => eventually(async () => (await u.page.evaluate(selectedThreadInPage)).shown || false, { timeout: 5_000, message: `the tapped highlight's thread is shown to the reader (it is selected, but the phone stays on pane "${sel.pane}" with the panel hidden)` }));
  await u.page.locator(".pane-toggle button", { hasText: "Document" }).click();
  await longPressComment(ctx, u, docId);
});

// --- A24.5: shape, words, contrast and names -------------------------------------------------------------

/** The chip a user sees for `email`: its dot's shape, the Editing icon, its colour. */
async function chipFor(u, email) {
  return u.page.evaluate((who) => {
    const chip = [...document.querySelectorAll(".presence-bar .presence-chip")].find((b) => b.querySelector(".presence-name")?.textContent === who);
    if (!chip) return null;
    const dot = chip.querySelector(".presence-dot");
    const cs = getComputedStyle(dot);
    return {
      mode: dot.getAttribute("data-mode"),
      radius: cs.borderTopLeftRadius,
      transform: cs.transform,
      icon: chip.querySelector('[role="img"][aria-label="Editing"]') ? "Editing" : null,
      color: getComputedStyle(chip).color,
      painted: cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== getComputedStyle(chip).backgroundColor,
      dotBackground: cs.backgroundColor,
      chipBackground: getComputedStyle(chip).backgroundColor,
    };
  }, email.toLowerCase());
}

scenario("A24.5a mode is shown by shape: in forced colours, where colour carries nothing, an editor's chip differs from a reader's by its dot's shape and by the word \"Editing\" in its accessible name", {
  tiers: BOTH,
  timeoutMs: 180_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { u: o, owner, accounts } = await ownerOnPage(ctx, { roles: ["editor"] });
  const { docId } = await publishPlain(owner, "shape");
  await share(target, { owner, doc: docId, account: accounts[1], role: "editor" });
  const e = await signInAs(ctx, accounts[1], "editor");
  await o.page.emulateMedia({ forcedColors: "active" });
  precondition(await o.page.evaluate(() => matchMedia("(forced-colors: active)").matches), "the owner's page is in forced colours");
  await Promise.all([openDoc(ctx, o, docId), openDoc(ctx, e, docId)]);
  const who = accounts[1].email.toLowerCase();
  const nameRe = new RegExp(`${who.replace(/[.+]/g, "\\$&")}.*Editing`);

  ctx.step("the editor reads: the owner sees a round dot, and no Editing in the chip's accessible name");
  const reading = await eventually(async () => {
    const c = await chipFor(o, who);
    return c?.mode === "view" ? c : false;
  }, { timeout: LISTEN_MS, message: "the editor's chip shows them reading" });
  const readNamed = await o.page.getByRole("button", { name: nameRe }).count();
  ctx.step("the editor enters edit mode: the owner sees a square, turned dot and Editing");
  await e.enterEdit({ waitShared: false });
  const editing = await eventually(async () => {
    const c = await chipFor(o, who);
    return c?.mode === "edit" ? c : false;
  }, { timeout: LISTEN_MS, message: "the editor's chip shows them editing" });
  const editNamed = await o.page.getByRole("button", { name: nameRe }).count();
  ctx.ev.json("chips", { reading, editing, readNamed, editNamed });

  assert.equal(editing.color, reading.color, "in forced colours the chip's colour is the same in both modes, so colour cannot be what tells them apart");
  assert.ok(reading.painted && editing.painted, `both mode dots remain painted in forced colours: ${JSON.stringify({ reading, editing })}`);
  assert.equal(reading.radius, "50%", "a reader's dot is round");
  assert.notEqual(editing.radius, reading.radius, `the dot's shape differs: ${reading.radius} reading, ${editing.radius} editing`);
  assert.notEqual(editing.transform, "none", "an editor's dot is turned (a diamond)");
  assert.deepEqual({ reading: reading.icon, editing: editing.icon }, { reading: null, editing: "Editing" }, "the Editing icon, with its name, only in edit mode");
  assert.deepEqual({ readNamed, editNamed }, { readNamed: 0, editNamed: 1 }, "the chip's accessible name says Editing in edit mode only");
});

/** The text a sighted reader sees in a node: text inside a clipped or 1-px box (.visually-hidden) left out. */
async function seenText(locator) {
  return locator.evaluate((el) => {
    const hidden = (n) => {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return cs.display === "none" || cs.visibility === "hidden" || cs.clipPath !== "none" || (cs.clip && cs.clip !== "auto") || (r.width <= 1 && r.height <= 1);
    };
    const walk = (n) => {
      if (n.nodeType === 3) return n.data;
      if (n.nodeType !== 1 || hidden(n)) return "";
      return [...n.childNodes].map(walk).join("");
    };
    return walk(el).replace(/\s+/g, " ").trim();
  });
}

scenario("A24.5b a suggestion is put in words for a screen reader in the panel and in the review bar: \"Replace … with …\" and \"Delete …\", the arrow silent", {
  tiers: BOTH,
  timeoutMs: 180_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { u, owner } = await ownerOnPage(ctx);
  const { docId } = await publishPlain(owner, "words");
  await quietDoc(target, docId);
  const R = `sleepy cat ${tag()}`;
  await postSuggestion(owner, docId, anchorFor("a24-1", "lazy dog"), R);
  await postSuggestion(owner, docId, anchorFor("a24-3", "really quite important"), "");
  await openDoc(ctx, u, docId);
  await u.openComments();
  const changes = u.page.locator(".comments-panel .suggestion-change");
  await eventually(async () => (await changes.count()) === 2 || false, { timeout: LISTEN_MS, message: "two suggestions in the panel" });

  ctx.step("the panel: what a screen reader is given for each change, and what the eye sees");
  ctx.ev.text("panel-aria.yml", await u.page.locator(".comments-panel").ariaSnapshot());
  const said = [await spokenText(changes.nth(0)), await spokenText(changes.nth(1))].sort();
  ctx.step(`spoken: ${JSON.stringify(said)}`);
  assert.deepEqual(said, [`Delete really quite important`, `Replace lazy dog with ${R}`].sort(), "each change in words; the arrow and the (delete) mark silent");
  const shown = [await seenText(changes.nth(0)), await seenText(changes.nth(1))].sort();
  ctx.step(`seen: ${JSON.stringify(shown)}`);
  assert.deepEqual(shown, [`lazy dog → ${R}`, "really quite important (delete)"].sort(), "the eye sees the struck quote and the arrow, and none of the spoken words");

  ctx.step('the review bar: the change reads "<author> suggests: replace … with …", announced politely');
  await u.enterEdit({ waitShared: true });
  await u.page.locator(".review-bar").getByRole("button", { name: "Review them", exact: true }).click({ timeout: LISTEN_MS });
  const change = u.page.locator(".review-bar .review-change");
  await change.waitFor({ state: "visible", timeout: LISTEN_MS });
  const spoken = await spokenText(change);
  const me = owner.account.email.toLowerCase();
  assert.ok([`${me} suggests: replace lazy dog with ${R}`, `${me} suggests: delete really quite important`].includes(spoken), `the bar reads the change in words: ${JSON.stringify(spoken)}`);
  assert.equal(await change.getAttribute("aria-live"), "polite", "the bar announces each change as the pass moves");
});

scenario("A24.5c all 11 screens and 2 dialogs have AA text contrast, computed accessible names, and focus colour reserved for focused indicators", {
  tiers: BOTH,
  timeoutMs: 10_000,
}, async (ctx) => {
  if (walk.surfaces?.length !== walk.expected) ctx.inconclusive(`A24.1 measured ${walk.surfaces?.length ?? 0} of ${walk.expected} surfaces`);
  ctx.ev.json("accessibility", walk.surfaces.map(({ name, accessibility }) => ({ name, ...accessibility })));
  for (const { name, accessibility } of walk.surfaces) {
    assert.ok(accessibility.checked.text > 0 && accessibility.checked.accessibleNames > 0, `${name}: rendered text and Chrome accessible names were measured`);
    assert.deepEqual(accessibility.issues.contrast, [], `${name}: WCAG AA text contrast (4.5 normal, 3 large), including resolved translucent backgrounds`);
    assert.deepEqual(accessibility.issues.names, [], `${name}: Chrome computes a nonempty accessible name for every exposed control and image`);
    assert.deepEqual(accessibility.issues.focusPaint, [], `${name}: --color-focus is painted only by a focused indicator`);
  }
});
