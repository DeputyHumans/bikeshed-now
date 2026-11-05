// SPDX-License-Identifier: Apache-2.0
// A19 Account: the comment-email toggle, analytics and consent, export-marking defaults, teams, personal tokens (with S15) and the skill zips (SPEC §14, §15, §18, §19, §20, §23).

/**
 * The account screen (/account) and what each of its controls changes, each
 * case with its own accounts and documents:
 *
 *   A19.1  #notify gates the comment email both ways: off, the owner is not
 *          told of a reply whose notice — in the same trigger run, after the
 *          owner's turn — reaches the thread's other participant; back on,
 *          the owner's next notice arrives (LOCAL: Mailpit)
 *   A19.2  analytics (SPEC §15), three cases by what the stack was built with,
 *          each skipping declaratively on the others' stacks:
 *          a  no measurement id: no banner, no analytics request, even with a
 *             stored "granted" (the shared stack; needs !measurement-id)
 *          b  a dummy id built in, under emulators: still nothing, because
 *             VITE_USE_EMULATORS disables analytics outright (stack up
 *             --app-env VITE_FIREBASE_MEASUREMENT_ID=dummy)
 *          c  analytics live (production, or locally that stack plus
 *             --patches a19-analytics-live, which drops only the emulator
 *             guard): declining fetches nothing, and "unanswered → Allow" in
 *             ONE page fetches the measurement script — the sequence a real
 *             visitor performs. Every analytics request is FULFILLED LOCALLY
 *             by the user's fulfilAnalytics() route and counted; none is ever
 *             sent
 *   A19.3  the account default marking seeds new documents only, in both
 *          directions, and persists; and (on a stack built with --app-env
 *          VITE_EXPORT_MARK_ENABLED, _LABEL and _FOOTER) the deployment
 *          default seeds a new account, as SPEC §20 and
 *          docs/operations/config.md say (known defect X-a19-account-1)
 *   A19.4  teams on the account screen: create, rename, add (one invitation),
 *          admin on and off (and what admin allows), remove, delete, each
 *          with its blast-radius toast (LOCAL: POST /team is refused on
 *          production and adding sends email)
 *   A19.5  personal tokens: a name is required; bsk_ shown once, stored only
 *          as a hash the client cannot read; lastUsedAt; revoke → /mcp 401
 *          with error="invalid_token". Disabled and deleted Auth owners lose
 *          session and personal-token access alike (the S15 regressions)
 *   A19.6  skill zips: application/zip, attachment, exactly the folder <n>/
 *          and <n>/SKILL.md, stored, byte-equal to the served SKILL.md; the
 *          account screen offers each and the download is those bytes
 *
 * Only e2e/lib/ talks to the stack.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { answered, currentTarget, precondition, scenario, stackDidNotAnswer } from "../../lib/test.mjs";
import { CONSENT_KEY } from "../../lib/browser.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { idToken, listTokens, mintToken, openSession } from "../../lib/session.mjs";
import { docIdFor, ledgerDoc, publish, publishMcp } from "../../lib/seed.mjs";
import { share } from "../../lib/grant.mjs";
import { adminFor, closeAdmin, readDoc } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { mailbox } from "../../lib/mail/reader.mjs";
import { appendLedger } from "../../lib/ledger.mjs";
import { clientFirestore } from "../../lib/firestore-client.mjs";
import { readZip } from "../../lib/zipread.mjs";
import { isMeasurementIdShape, patchCapability } from "../../lib/options.mjs";
import { REPO_ROOT } from "../../lib/paths.mjs";
import { treeConstant } from "../../lib/target.mjs";
import { cliHome, runCli } from "../../lib/cli.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const BOTH = ["local", "prod"];
const LOCAL = ["local"];
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const tag = () => `${runTag(target.runId)}-${rand4()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The token shape tokens.ts mints: bsk_<32 hex id>.<base64url secret>. */
const TOKEN_RE = /^bsk_([0-9a-f]{32})\.([A-Za-z0-9_-]{20,64})$/;
/** POST /tokens create's refusal of a missing name (functions/src/index.ts manageTokens). */
const NAME_REQUIRED = "name is required — an unnamed token cannot be revoked with confidence";
/** The keys of the account screen's token mirror, users/{uid}/tokens/{id}, before first use (tokens.ts prepareToken). */
const MIRROR_KEYS = ["channel", "createdAt", "name", "revokedAt", "tokenId"];
/** The keys of a team record (SPEC §18 "Model"). */
const TEAM_KEYS = ["admins", "createdAt", "members", "name", "ownerEmail", "slug", "teamId", "updatedAt"];
const MARKING_OFF = { enabled: false, label: "", footer: "" };
/** The privacy page's line when analyticsConfigured() is false (app/src/pages/Legal.tsx). */
const NOT_CONFIGURED = "This deployment has not configured analytics, so none is collected.";
/**
 * How long a negative analytics check watches after the page and a route
 * change: resolve() runs at App mount and on every route change, and when it
 * may initialize, the dynamic import and the first request follow within a
 * second on this machine. Not a product timer — the settle a "nothing was
 * requested" claim needs.
 */
const ANALYTICS_SETTLE_MS = 5_000;
/**
 * Waits for things a loaded shared stack can make slow: a Firestore snapshot
 * reaching the page, a function's answer behind a toast. Generous on purpose:
 * on a stack eight specs share, a cast has taken 89 s, POST /session 22 s and
 * POST /access 31 s, and the page's Firestore listener has gone 45 s without
 * a snapshot after "Backend didn't respond within 10 seconds".
 */
const RECORD_WAIT_MS = 90_000;
const TOAST_WAIT_MS = 90_000;
/**
 * Every case declares `inconclusiveOnPageStall` (lib/test.mjs): on a loaded
 * shared stack Hosting cuts off a function that has not answered in 60 s, and
 * a page's Firestore client loses the emulator, so a wait that runs out then,
 * with that evidence from this case's own pages, is the stack's and ends
 * INCONCLUSIVE. An assertion never does. A response the case reads itself goes
 * through answered() first, so a cut-off 504 is never judged as the product's
 * answer.
 */
const ON_STALL = { inconclusiveOnPageStall: true };

// --- helpers -----------------------------------------------------------------

function noPageErrors(users) {
  for (const u of users) assert.deepEqual(u.log.errors.map((e) => e.message), [], `${u.name}: uncaught page errors`);
}

/**
 * A signed-in visitor who already declined analytics (`consent: "denied"`): on
 * a deployment with analytics (production, or the a19-analytics-live stack)
 * the consent banner otherwise lies over the bottom of every page and takes
 * the clicks meant for the account screen's controls (seen: Create under
 * "Cookie choices"). Never used by the A19.2 cases, which test the banner.
 */
async function signedIn(ctx, acct, name) {
  const u = await ctx.users.user({ name, consent: "denied" });
  // Past Hosting's 60 s cut-off, so a slow POST /session ends in an answer or
  // a 504 the page records (inconclusiveOnPageStall), not in a bare 45 s timeout.
  const s = await u.signInUi(acct.email, acct.password, { timeout: RECORD_WAIT_MS });
  precondition(s.status === "ok", `${name} signed in through the UI`);
  return u;
}

/**
 * /account, rendered for this user (its caption is their address), with its
 * Firestore listeners answered: the token and team lists have left their
 * spinners. The account record rides the same stream; the controls it drives
 * (#default-marking, #notify) are still read with `eventually`.
 */
async function openAccount(u, email) {
  await u.goto("/account");
  await u.page.getByRole("heading", { name: "Account", level: 1 }).waitFor({ timeout: RECORD_WAIT_MS });
  await u.page.locator("p.caption", { hasText: email.toLowerCase() }).waitFor({ timeout: RECORD_WAIT_MS });
  for (const label of ["Loading your tokens", "Loading your teams"]) {
    await u.page.locator(`.spinner[aria-label="${label}"]`).waitFor({ state: "detached", timeout: RECORD_WAIT_MS });
  }
}

/** The account screen's section under an h2. */
function section(u, heading) {
  return u.page.locator("section").filter({ has: u.page.getByRole("heading", { name: heading, exact: true, level: 2 }) });
}

/** Wait until users/{uid} satisfies `pred` (the account screen writes it from the client). */
async function userRecord(uid, pred, message) {
  return eventually(async () => {
    const u = await readDoc(target, `users/${uid}`);
    if (!pred(u ?? {})) throw new Error(`users/${uid}: ${JSON.stringify(u ?? null)}`);
    return u;
  }, { timeout: RECORD_WAIT_MS, interval: 250, message });
}

/**
 * The stack-built variants. The analytics-live set drops only the emulator
 * guard (e2e/patches/a19-analytics-live); a19.2c needs it on a local target.
 */
const ANALYTICS_LIVE = patchCapability("a19-analytics-live");

/**
 * Analytics requests, as the user's fulfilAnalytics() route counted them
 * (lib/browser.mjs: every one is answered locally, none is ever sent).
 */
const gtagRequests = (seen) => seen.filter((r) => r.kind === "gtag");
const banner = (u) => u.page.locator('aside.consent[aria-label="Cookie choices"]');

/** /privacy rendered (its h1), and the consent line it shows. */
async function privacyLine(u) {
  await u.goto("/privacy");
  await u.page.getByRole("heading", { name: "Privacy policy", level: 1 }).waitFor({ timeout: RECORD_WAIT_MS });
  const cookies = u.page.locator("main.legal h2", { hasText: "Cookies" }).locator("xpath=following-sibling::p[1]");
  return (await cookies.textContent())?.replace(/\s+/g, " ").trim() ?? "";
}

/** What the page itself holds of analytics: the script tag, the data layer, a _ga cookie. */
async function analyticsTraces(u) {
  const inPage = await u.page.evaluate(() => ({
    gtagScripts: [...document.querySelectorAll("script[src]")].map((s) => s.src).filter((s) => /googletagmanager/.test(s)).length,
    dataLayer: Array.isArray(window.dataLayer) ? window.dataLayer.length : null,
  }));
  const cookies = (await u.context.cookies()).filter((c) => /^_ga/.test(c.name)).map((c) => c.name);
  return { ...inPage, gaCookies: cookies };
}

async function setConsent(u, value) {
  await u.page.evaluate(([k, v]) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v)), [CONSENT_KEY, value]);
}
const readConsent = (u) => u.page.evaluate((k) => localStorage.getItem(k), CONSENT_KEY);

/** Upload a document through the workspace's Upload dialog; returns {docId, boxChecked}. */
async function uploadThroughDialog(u, ownerEmail, { name, title, anchor }) {
  // Everything, where the cards are: "/" is Recent, in rows (SPEC §13).
  await u.goto("/everything");
  // The dialog seeds its box from the account record when it MOUNTS, so open
  // it at a person's pace: once the workspace lists a document of this owner
  // (the same Firestore stream carries the account record).
  await u.page.locator(`.doc-grid a.doc-card-title[href="/d/${anchor}"]`).waitFor({ timeout: RECORD_WAIT_MS });
  await u.page.locator(".workspace-toolbar").getByRole("button", { name: "Upload", exact: true }).click();
  const dlg = u.page.getByRole("dialog", { name: "Upload a document" });
  await dlg.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>A19 marking probe.</p></body></html>`;
  await dlg.locator('input[type="file"]').setInputFiles({ name: "probe.html", mimeType: "text/html", buffer: Buffer.from(html) });
  await dlg.locator(".upload-dropzone strong", { hasText: "probe.html" }).waitFor({ timeout: RECORD_WAIT_MS });
  const boxChecked = await dlg.locator("#upload-marking").isChecked();
  await dlg.locator("#upload-id").fill(docIdFor(target, name));
  const posts = u.capture({ paths: "/publish" });
  await dlg.getByRole("button", { name: "Upload", exact: true }).click();
  // Past Hosting's 60 s cut-off, so a slow /publish ends in an answer or a 504 that answered() names.
  const row = await posts.waitFor("/publish", { timeout: 90_000 }).finally(() => posts.stop());
  const pj = row.json;
  if (pj?.docId) ledgerDoc(target, { docId: pj.docId, via: "upload-ui", ownerEmail, actor: u.name });
  answered(row, "the Upload dialog's POST /publish");
  precondition(row.status === 200 && pj?.docId, `the dialog's POST /publish: ${row.status} ${JSON.stringify(pj)}`);
  return { docId: pj.docId, boxChecked };
}

// --- A19.1 -------------------------------------------------------------------

const QUOTE_A = "Estuary amber zephyr walnut vellum";
const QUOTE_B = "Xenon delta timber linen orchard";

/**
 * Why a witness: onCommentCreated walks its recipients in order — the owner
 * first, then the thread's earlier participants (functions/src/index.ts) — so
 * when a reply's notice reaches the witness, the same run has already decided
 * the owner's. The owner's silence is then a decision, not a trigger that has
 * not run yet; the 10 s settle after it is only belt and braces.
 */
scenario("A19.1 the Email toggle gates comment email both ways: with #notify off the owner gets no notice of a reply whose notice reaches the thread's other participant; turned back on, the owner's next notice arrives", {
  tiers: LOCAL,
  effects: ["email:POST /access", "email:comment"],
  needs: ["email", "mailpit"],
  timeoutMs: 540_000,
  ...ON_STALL,
}, async (ctx) => {
  const t = tag();
  ctx.step("cast an owner, a witness and a commenter; the owner publishes a document and shares it with both");
  const [ownerAcct, witnessAcct, commenterAcct] = await cast(target, ["quiet", "witness", "commenter"]);
  const [owner, witness, commenter] = await Promise.all([ownerAcct, witnessAcct, commenterAcct].map((a) => openSession(target, a)));
  const title = `A19.1 notify ${t}`;
  const doc = await publish(owner.http, { fixture: "crdt-paragraphs.html", title, name: "a191-notify" });
  await share(target, { owner, doc: doc.docId, account: witnessAcct, role: "viewer" });
  await share(target, { owner, doc: doc.docId, account: commenterAcct, role: "viewer" });

  ctx.step("the owner opens /account: Tell me when somebody comments is on by default; they turn it off");
  const q = await signedIn(ctx, ownerAcct, "owner");
  await openAccount(q, ownerAcct.email);
  const notify = q.page.locator("#notify");
  await notify.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  assert.equal(await notify.isChecked(), true, "#notify is on for an account that never chose");
  // Controlled by the stored record (checked = emailNotifications !== false),
  // so the box flips when the write's snapshot arrives: click, then wait.
  await notify.click();
  await userRecord(ownerAcct.uid, (u) => u.emailNotifications === false, "users/{uid}.emailNotifications is false");
  await q.page.reload();
  await notify.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  await eventually(async () => (await notify.isChecked()) === false, { timeout: RECORD_WAIT_MS, message: "#notify reads back off after a reload" });

  ctx.step("the witness opens a thread, and the commenter replies in it (MCP add_comment, reply_to_comment)");
  const mcpOf = async (session, actor) => {
    const { token } = await mintToken(session, { name: `e2e a19.1 ${actor} ${t}`, channel: "mcp" });
    const m = ctx.mcp({ token, actor });
    await m.initialize();
    return m;
  };
  const [mw, mc] = [await mcpOf(witness, "witness-mcp"), await mcpOf(commenter, "commenter-mcp")];
  const thread = await mw.ok("add_comment", { id: doc.docId, exact: QUOTE_A, body: `A19.1 opening ${t}` });
  precondition(typeof thread?.threadId === "string", `add_comment: ${JSON.stringify(thread)}`);
  const replyBody = `A19.1 reply while off ${t}`;
  await mc.ok("reply_to_comment", { id: doc.docId, threadId: thread.threadId, body: replyBody });

  ctx.step("the reply's notice reaches the witness; the owner, decided first in that same run, is told nothing (then a 10 s settle)");
  const box = mailbox(target);
  const subject = `${commenterAcct.email} commented on “${title}”`;
  const seen = await box.expectMail({ to: witnessAcct.email, subject, count: 1, timeout: 120_000 });
  ctx.step(`the witness's notice after ${seen.waitedMs} ms`);
  const witnessText = String((await box.message(seen.messages[0].ID)).Text);
  precondition(witnessText.includes(replyBody), "the witness's notice is the reply's");
  await box.expectMail({ to: ownerAcct.email, count: 0 }).catch(() => undefined);
  assert.deepEqual((await box.find({ to: ownerAcct.email })).map((m) => m.Subject), [], "with #notify off, the quiet owner is told nothing of a new comment");
  assert.equal((await readDoc(target, `users/${ownerAcct.uid}`))?.emailCooldowns?.[doc.docId], undefined, "and no cooldown was claimed for them");

  ctx.step("the owner turns #notify back on; the commenter opens a new thread; its notice reaches the owner, once");
  await notify.click();
  await userRecord(ownerAcct.uid, (u) => u.emailNotifications === true, "users/{uid}.emailNotifications is true again");
  await eventually(async () => (await notify.isChecked()) === true, { timeout: RECORD_WAIT_MS, message: "#notify reads on" });
  const againBody = `A19.1 again ${t}`;
  await mc.ok("add_comment", { id: doc.docId, exact: QUOTE_B, body: againBody });
  const back = await box.expectMail({ to: ownerAcct.email, subject, count: 1, timeout: 120_000 });
  const full = String((await box.message(back.messages[0].ID)).Text);
  assert.ok(full.includes(againBody), "the owner's notice is for the comment made after turning it back on");
  assert.ok(!full.includes(replyBody), "and not for the reply made while it was off");
  noPageErrors([q]);
});

// --- A19.2 -------------------------------------------------------------------

/** Watch a page with analytics: two route changes, then the settle. Returns the traces. */
async function watchNothing(u, seen, what) {
  await u.goto("/terms");
  await u.page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: RECORD_WAIT_MS });
  const line = await privacyLine(u);
  await sleep(ANALYTICS_SETTLE_MS);
  const traces = await analyticsTraces(u);
  assert.equal(await banner(u).count(), 0, `${what}: a consent banner is shown`);
  assert.deepEqual(seen.map((r) => `${r.method} ${r.host}${r.path}`), [], `${what}: analytics requests were made`);
  assert.deepEqual(traces, { gtagScripts: 0, dataLayer: null, gaCookies: [] }, `${what}: analytics left traces in the page`);
  return line;
}

scenario("A19.2 with no measurement id built in there is no consent banner and no analytics request, for a visitor who never answered and for one whose stored answer is granted", {
  tiers: LOCAL,
  // A stack built with an id is the next two cases'.
  needs: ["!measurement-id"],
  timeoutMs: 150_000,
  ...ON_STALL,
}, async (ctx) => {
  const u = await ctx.users.user({ name: "visitor" });
  const seen = await u.fulfilAnalytics();
  ctx.step("a signed-out visitor who never answered: the landing page, the terms, the privacy page");
  await u.goto("/");
  await u.page.locator("#main, main").first().waitFor({ timeout: RECORD_WAIT_MS });
  assert.equal(await readConsent(u), null, "no stored answer");
  const line = await watchNothing(u, seen, "unanswered, no measurement id");
  assert.equal(line, NOT_CONFIGURED, "the privacy page says this deployment has not configured analytics");

  ctx.step(`the same visitor with ${CONSENT_KEY}=granted stored: reload and move between routes`);
  await setConsent(u, "granted");
  await u.page.reload();
  await watchNothing(u, seen, "granted, no measurement id");
  noPageErrors([u]);
});

scenario("A19.2 with a measurement id built in but running under emulators, there is still no banner and no analytics request, even with a stored grant (SPEC §15: never under emulators)", {
  tiers: LOCAL,
  needs: ["measurement-id", `!${ANALYTICS_LIVE}`],
  timeoutMs: 150_000,
  ...ON_STALL,
}, async (ctx) => {
  const id = target.options.appEnv.VITE_FIREBASE_MEASUREMENT_ID;
  precondition(isMeasurementIdShape(id), "the stack's measurement id is a generated dummy");
  ctx.step("the served bundle carries the dummy id, so what follows is the emulator guard, not a missing id");
  const http = ctx.http({ actor: "bundle" });
  const index = await http.get("/", { expect: 200 });
  const scripts = [...index.text.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]);
  let carried = false;
  for (const src of scripts) if ((await http.get(src, { expect: 200 })).text.includes(id)) carried = true;
  precondition(carried, `the bundle carries the dummy id (looked in ${scripts.join(", ")})`);

  const u = await ctx.users.user({ name: "visitor" });
  const seen = await u.fulfilAnalytics();
  ctx.step("a visitor who never answered");
  await u.goto("/");
  await u.page.locator("#main, main").first().waitFor({ timeout: RECORD_WAIT_MS });
  const line = await watchNothing(u, seen, "unanswered, id built in, under emulators");
  assert.equal(line, NOT_CONFIGURED, "the privacy page says this deployment has not configured analytics");
  ctx.step("the same visitor with a stored grant");
  await setConsent(u, "granted");
  await u.page.reload();
  await watchNothing(u, seen, "granted, id built in, under emulators");
  noPageErrors([u]);
});

scenario("A19.2 with analytics live, declining fetches nothing and is remembered, and \"unanswered → Allow\" in one page fetches the measurement script once, with page views off; every analytics request is fulfilled locally", {
  tiers: BOTH,
  // Locally only on a stack built with an id and the analytics-live set; production is live as it is.
  needs: target?.kind === "local" ? ["measurement-id", ANALYTICS_LIVE] : [],
  timeoutMs: 180_000,
  ...ON_STALL,
}, async (ctx) => {
  ctx.step("declining: a fresh visitor sees the banner, nothing is fetched before answering, No thanks fetches nothing");
  const d = await ctx.users.user({ name: "decliner" });
  const seenD = await d.fulfilAnalytics();
  await d.goto("/privacy");
  await banner(d).waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  assert.equal(await readConsent(d), null, "no stored answer before the banner is answered");
  await sleep(ANALYTICS_SETTLE_MS);
  assert.deepEqual(seenD.map((r) => r.host), [], "unanswered: nothing was fetched");
  await banner(d).getByRole("button", { name: "No thanks", exact: true }).click();
  await banner(d).waitFor({ state: "detached", timeout: RECORD_WAIT_MS });
  assert.equal(await readConsent(d), "denied", "the answer is stored");
  await d.goto("/terms");
  await d.page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: RECORD_WAIT_MS });
  await sleep(ANALYTICS_SETTLE_MS);
  assert.deepEqual(seenD.map((r) => r.host), [], "declined: a route change fetched nothing");
  ctx.step("declining is remembered: a reload shows no banner, the privacy page says declined, and still nothing is fetched");
  const line = await privacyLine(d);
  assert.match(line, /Your current choice on this device: analytics declined\./, "the privacy page reads the stored answer");
  await sleep(ANALYTICS_SETTLE_MS);
  assert.equal(await banner(d).count(), 0, "no banner once answered");
  assert.deepEqual(seenD.map((r) => r.host), [], "declined, after a reload: nothing was fetched");
  assert.deepEqual(await analyticsTraces(d), { gtagScripts: 0, dataLayer: null, gaCookies: [] }, "declined: no analytics traces in the page");

  ctx.step("allowing in one page: a fresh visitor, nothing fetched while unanswered, then Allow — without a reload — fetches the measurement script");
  const a = await ctx.users.user({ name: "allower" });
  const seenA = await a.fulfilAnalytics();
  await a.goto("/privacy");
  await banner(a).waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  await sleep(ANALYTICS_SETTLE_MS);
  assert.deepEqual(seenA.map((r) => r.host), [], "unanswered: nothing was fetched");
  const navs = [];
  a.page.on("framenavigated", (f) => {
    if (f === a.page.mainFrame()) navs.push(f.url());
  });
  await banner(a).getByRole("button", { name: "Allow", exact: true }).click();
  await banner(a).waitFor({ state: "detached", timeout: RECORD_WAIT_MS });
  assert.equal(await readConsent(a), "granted", "the answer is stored");
  const gtag = await eventually(() => {
    const g = gtagRequests(seenA);
    return g.length > 0 ? g : false;
  }, { timeout: 30_000, interval: 100, message: "after Allow, in the same page, the measurement script is requested" });
  assert.deepEqual(navs, [], "Allow did not reload or navigate the page");
  assert.equal(gtag.length, 1, `the measurement script is requested once: ${JSON.stringify(gtag)}`);
  assert.equal(gtag[0].id, seenA.measurementId, "for the measurement id the SDK's web config named");
  const config = await eventually(async () => {
    const c = await a.page.evaluate(() => (Array.isArray(window.dataLayer) ? window.dataLayer.map((e) => Array.from(e)).find((e) => e[0] === "config") : null));
    return c ?? false;
  }, { timeout: 10_000, message: "gtag is configured" });
  assert.deepEqual({ send_page_view: config[2]?.send_page_view, page_title: config[2]?.page_title }, { send_page_view: false, page_title: "Bikeshed" }, "the automatic page view is off and the title pinned (SPEC §15)");
  ctx.step("a client-side route change reuses the script, and a document route sends only its pattern");
  await a.page.getByRole("link", { name: "Terms", exact: true }).click();
  await a.page.getByRole("heading", { name: "Terms of service", level: 1 }).waitFor({ timeout: RECORD_WAIT_MS });
  const confidential = `private-a19-${tag()}`;
  await a.page.evaluate((path) => { history.pushState(null, "", path); dispatchEvent(new PopStateEvent("popstate")); }, `/d/${confidential}/v1`);
  const pageView = await eventually(() => a.page.evaluate(() => (window.dataLayer ?? []).map((e) => Array.from(e)).find((e) => e[0] === "event" && e[1] === "page_view" && e[2]?.page_path === "/d/:docId/:versionId") ?? false), { timeout: RECORD_WAIT_MS, message: "the document route emits its pattern" });
  assert.deepEqual({ path: pageView[2].page_path, location: pageView[2].page_location, title: pageView[2].page_title }, { path: "/d/:docId/:versionId", location: "/d/:docId/:versionId", title: "/d/:docId/:versionId" }, "every page-view field is the route pattern");
  assert.ok(!(await a.page.evaluate(() => JSON.stringify(window.dataLayer))).includes(confidential), "the concrete document slug never reaches the data layer");
  await sleep(ANALYTICS_SETTLE_MS);
  assert.equal(gtagRequests(seenA).length, 1, "later route changes still fetch the measurement script only once");
  noPageErrors([d, a]);
});

scenario("A19.2 account analytics opt-out survives reload and another browser, and the checkbox can enable and disable collection", {
  tiers: LOCAL,
  needs: ["measurement-id", ANALYTICS_LIVE],
  timeoutMs: 240_000,
  ...ON_STALL,
}, async (ctx) => {
  const [account] = await cast(target, ["analytics-opt-out"], { analytics: false, notifications: false });
  const u = await ctx.users.user({ name: "opted-out", consent: "denied" });
  const seen = await u.fulfilAnalytics();
  precondition((await u.signInUi(account.email, account.password, { timeout: RECORD_WAIT_MS })).status === "ok", "the opted-out account signed in");
  await openAccount(u, account.email);
  const box = u.page.locator("#analytics");
  await eventually(() => box.isChecked(), { timeout: RECORD_WAIT_MS, message: "the stored analytics opt-out reaches the checkbox" });
  await setConsent(u, "granted");
  await u.page.reload();
  await openAccount(u, account.email);
  await eventually(() => box.isChecked(), { timeout: RECORD_WAIT_MS, message: "the opt-out reads back after reload" });
  await sleep(ANALYTICS_SETTLE_MS);
  assert.deepEqual(seen.map((r) => r.host), [], "a saved opt-out fetches no measurement script after reload, despite granted consent");
  assert.equal((await analyticsTraces(u)).dataLayer, null, "a restored opt-out records no event");
  const other = await ctx.users.user({ name: "another-device", consent: "denied" });
  const otherSeen = await other.fulfilAnalytics();
  precondition((await other.signInUi(account.email, account.password, { timeout: RECORD_WAIT_MS })).status === "ok", "the same account signed in on another browser");
  await setConsent(other, "granted");
  await other.page.reload();
  await openAccount(other, account.email);
  await eventually(() => other.page.locator("#analytics").isChecked(), { timeout: RECORD_WAIT_MS, message: "another device reads the account opt-out" });
  await sleep(ANALYTICS_SETTLE_MS);
  assert.deepEqual(otherSeen.map((r) => r.host), [], "the account opt-out travels to another browser");
  await box.click();
  await userRecord(account.uid, (r) => r.analyticsOptOut === false, "unchecking stores the account opt-in");
  await eventually(async () => !(await box.isChecked()), { timeout: RECORD_WAIT_MS, message: "the checkbox reflects the saved account opt-in" });
  await eventually(() => gtagRequests(seen).length === 1, { timeout: RECORD_WAIT_MS, message: "unchecking enables analytics in the same page" });
  await box.click();
  await userRecord(account.uid, (r) => r.analyticsOptOut === true, "checking stores the account opt-out");
  await eventually(() => box.isChecked(), { timeout: RECORD_WAIT_MS, message: "the checkbox reflects the saved account opt-out" });
  await eventually(() => u.page.evaluate((id) => window[`ga-disable-${id}`] === true, seen.measurementId), { timeout: RECORD_WAIT_MS, message: "checking disables the initialized analytics instance" });
  noPageErrors([u, other]);
});

scenario("A19.2 corrupted stored consent is unanswered and fetches no measurement script", {
  tiers: LOCAL,
  needs: ["measurement-id", ANALYTICS_LIVE],
  timeoutMs: 120_000,
  ...ON_STALL,
}, async (ctx) => {
  const u = await ctx.users.user({ name: "corrupt-consent", consent: "denied" });
  const seen = await u.fulfilAnalytics();
  await u.goto("/privacy");
  await setConsent(u, "GRANTED");
  await u.page.reload();
  await u.page.getByRole("heading", { name: "Privacy policy", level: 1 }).waitFor({ timeout: RECORD_WAIT_MS });
  await sleep(ANALYTICS_SETTLE_MS);
  assert.equal(await banner(u).count(), 1, "corrupted consent must ask for a new answer");
  assert.deepEqual(seen.map((r) => r.host), [], "corrupted consent never grants collection");
  noPageErrors([u]);
});

// --- A19.3 -------------------------------------------------------------------

scenario("A19.3 the account default marking seeds new documents only: turned on it stores the suggested marking, reads back after a reload and checks the Upload dialog; turned off it stores none, unchecks the dialog, and leaves the document marked while it was on as it was", {
  tiers: BOTH,
  // "Off for a new account" holds only where the deployment sets no default
  // (SPEC §20: VITE_EXPORT_MARK_* seeds accounts); that stack is the next case's.
  needs: ["!export-mark-default"],
  timeoutMs: 600_000,
  ...ON_STALL,
}, async (ctx) => {
  const t = tag();
  const seeded = {
    enabled: true,
    label: treeConstant(target, "app/src/export/labels.ts", "SUGGESTED_LABEL"),
    // Declared with its literal on the line after `=`, which treeConstant reads too.
    footer: treeConstant(target, "app/src/export/labels.ts", "SUGGESTED_FOOTER"),
  };
  const [ownerAcct] = await cast(target, ["owner"], { notifications: false, analytics: false });
  const owner = await openSession(target, ownerAcct);
  const anchor = (await publish(owner.http, { fixture: "crdt-paragraphs.html", title: `A19.3 anchor ${t}`, name: "a193-anchor" })).docId;
  assert.deepEqual((await readDoc(target, `docs/${anchor}`)).marking, MARKING_OFF, "a document made before any default is unmarked");
  const o = await signedIn(ctx, ownerAcct, "owner");

  ctx.step("/account: Stamp new documents by default starts off for a new account");
  await openAccount(o, ownerAcct.email);
  const box = o.page.locator("#default-marking");
  await box.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  // #default-marking reads unchecked BEFORE users/{uid} reaches the page too
  // (Account.tsx starts at MARKING_OFF), so an "off" read means something only
  // once the record has arrived. This account was cast with comment email off,
  // and #notify reads checked until the record says so: wait for that first.
  const notify = o.page.locator("#notify");
  const recordShown = (when) => eventually(async () => (await notify.isChecked()) === false, { timeout: RECORD_WAIT_MS, message: `${when}: users/{uid} reached the page (#notify shows the cast's opt-out)` });
  await recordShown("a new account");
  assert.equal(await box.isChecked(), false, "off by default");
  assert.equal((await readDoc(target, `users/${ownerAcct.uid}`))?.defaultMarking, undefined, "no default stored");

  ctx.step("turned on: the suggested marking is stored, and it reads back checked after a reload");
  await box.check();
  await userRecord(ownerAcct.uid, (u) => isDeepStrictEqual(u.defaultMarking, seeded), "users/{uid}.defaultMarking is the suggested marking");
  await o.page.reload();
  await box.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  await eventually(async () => (await box.isChecked()) === true, { timeout: RECORD_WAIT_MS, message: "checked after a reload" });

  ctx.step("a document uploaded now starts with the dialog's box checked and carries the default");
  const marked = await uploadThroughDialog(o, ownerAcct.email, { name: "a193-on", title: `A19.3 on ${t}`, anchor });
  assert.equal(marked.boxChecked, true, "the dialog's Stamp box is seeded on");
  assert.deepEqual((await readDoc(target, `docs/${marked.docId}`)).marking, seeded, "the new document carries the default");

  ctx.step("MCP publishing without a marking field inherits the same account default");
  const { token } = await mintToken(owner, { name: `a19 default ${t}`, channel: "mcp" });
  const mcp = ctx.mcp({ token, actor: "default-marking-mcp" });
  await mcp.initialize();
  const fromMcp = await publishMcp(mcp, { title: `A19.3 MCP ${t}`, content: "<!doctype html><p>Account default via MCP.</p>", id: docIdFor(target, "a193-mcp") });
  precondition(typeof fromMcp.docId === "string", `MCP published: ${JSON.stringify(fromMcp.json)}`);
  assert.deepEqual((await readDoc(target, `docs/${fromMcp.docId}`)).marking, seeded, "MCP publish inherits the owner's account default");

  const cliToken = (await mintToken(owner, { name: `a19 CLI default ${t}`, channel: "cli" })).token;
  const home = cliHome(target);
  writeFileSync(join(home.home, "default.html"), "<!doctype html><p>Account default via CLI.</p>");
  const cli = answered(await runCli(target, ["publish", "default.html", "--id", docIdFor(target, "a193-cli"), "--json"], { home, token: cliToken, timeoutMs: 180_000 }), "CLI publish with an account default");
  precondition(cli.code === 0, `CLI publication completed: ${cli.stderr}`);
  const fromCli = JSON.parse(cli.stdout);
  ledgerDoc(target, { docId: fromCli.docId, via: "cli", ownerEmail: ownerAcct.email, versionId: fromCli.versionId });
  assert.deepEqual((await readDoc(target, `docs/${fromCli.docId}`)).marking, seeded, "CLI publish inherits the owner's account default");

  ctx.step("turned off: nothing is stored as a default, it reads back off, and the next upload starts unchecked and unmarked");
  await openAccount(o, ownerAcct.email);
  await box.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  await eventually(async () => (await box.isChecked()) === true, { timeout: RECORD_WAIT_MS, message: "the box reads the stored default" });
  await box.uncheck();
  await userRecord(ownerAcct.uid, (u) => isDeepStrictEqual(u.defaultMarking, MARKING_OFF), "users/{uid}.defaultMarking is off");
  await o.page.reload();
  await box.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  await recordShown("after turning it off and a reload");
  assert.equal(await box.isChecked(), false, "unchecked after a reload");
  const plain = await uploadThroughDialog(o, ownerAcct.email, { name: "a193-off", title: `A19.3 off ${t}`, anchor });
  assert.equal(plain.boxChecked, false, "the dialog's Stamp box is seeded off");
  assert.deepEqual((await readDoc(target, `docs/${plain.docId}`)).marking, MARKING_OFF, "the new document is unmarked");

  ctx.step("the default seeds; it never rewrites: the document made while it was on keeps its marking, and turning it on again leaves the plain one plain");
  assert.deepEqual((await readDoc(target, `docs/${marked.docId}`)).marking, seeded, "the earlier document keeps its own marking");
  await openAccount(o, ownerAcct.email);
  await box.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  await box.check();
  await userRecord(ownerAcct.uid, (u) => isDeepStrictEqual(u.defaultMarking, seeded), "on again, with the suggested marking");
  assert.deepEqual((await readDoc(target, `docs/${plain.docId}`)).marking, MARKING_OFF, "the plain document stays plain");
  assert.deepEqual((await readDoc(target, `docs/${anchor}`)).marking, MARKING_OFF, "and so does the one made before any default");
  noPageErrors([o]);
});

scenario("A19.3 the deployment default marking (VITE_EXPORT_MARK_*) seeds a new account's default, which the account screen shows and the next upload carries (SPEC §20, docs/operations/config.md)", {
  tiers: LOCAL,
  // stack up --app-env VITE_EXPORT_MARK_ENABLED --app-env "VITE_EXPORT_MARK_LABEL=…" --app-env "VITE_EXPORT_MARK_FOOTER=…"
  needs: ["export-mark-default"],
  timeoutMs: 240_000,
  ...ON_STALL,
}, async (ctx) => {
  const env = target.options?.appEnv ?? {};
  const deployment = { enabled: true, label: env.VITE_EXPORT_MARK_LABEL ?? "", footer: env.VITE_EXPORT_MARK_FOOTER ?? "" };
  precondition(deployment.label && deployment.footer, `the stack was built with a whole deployment marking, label and footer too: ${JSON.stringify(deployment)}`);
  const t = tag();
  // Evidence for the mechanism, not an oracle: whether the served bundle holds
  // the deployment label at all (a constant nothing imports is tree-shaken).
  const http = ctx.http({ actor: "bundle" });
  const index = await http.get("/", { expect: 200 });
  const scripts = [...index.text.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]);
  let inBundle = false;
  for (const src of scripts) if ((await http.get(src, { expect: 200 })).text.includes(deployment.label)) inBundle = true;
  ctx.ev.json("bundle", { scripts, deploymentLabelInBundle: inBundle });
  ctx.step(`the served bundle ${inBundle ? "holds" : "does not hold"} the deployment label`);
  const [ownerAcct] = await cast(target, ["owner"], { notifications: false, analytics: false });
  const owner = await openSession(target, ownerAcct);
  const anchor = (await publish(owner.http, { fixture: "crdt-paragraphs.html", title: `A19.3 anchor ${t}`, name: "a193-danchor" })).docId;
  const o = await signedIn(ctx, ownerAcct, "owner");

  ctx.step("a new account opens /account: its default is the deployment's");
  await openAccount(o, ownerAcct.email);
  const box = o.page.locator("#default-marking");
  await box.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  await eventually(async () => !(await o.page.locator("#notify").isChecked()), { timeout: RECORD_WAIT_MS, message: "the account record arrived (#notify reflects its stored opt-out)" });
  const seededAccount = await userRecord(ownerAcct.uid, (u) => u.defaultMarking !== undefined, "the deployment default is stored on the new account");
  assert.deepEqual(seededAccount.defaultMarking, deployment, "the new account stores the configured deployment marking");
  const shown = await box.isChecked();
  ctx.step("the next upload through the dialog");
  const up = await uploadThroughDialog(o, ownerAcct.email, { name: "a193-deploy", title: `A19.3 deployment ${t}`, anchor });
  const stored = (await readDoc(target, `docs/${up.docId}`)).marking;
  assert.deepEqual(
    { accountScreen: shown, dialogBox: up.boxChecked, document: stored },
    { accountScreen: true, dialogBox: true, document: deployment },
    "VITE_EXPORT_MARK_* seeds the account default, the dialog and the new document",
  );
});

// --- A19.4 -------------------------------------------------------------------

/**
 * One team change made in the owner's page, judged by what it reports
 * (TeamsSection.tsx: "every change reports its blast radius"). The page's own
 * POST is read first and passed through answered(), so Hosting's cut-off ends
 * the case INCONCLUSIVE instead of being judged. Then the FIRST toast after
 * the press is the oracle, as an assertion: a wrong or missing count FAILS at
 * once, naming what was shown. A wait for the expected words would instead
 * run out, and on a stalled stack be read as the stall (inconclusiveOnPageStall).
 * For a change that recomputes access, the server's own `affected` must say
 * the same count.
 */
async function teamChange(u, { what, path, op = null, press, toast, affected = null }) {
  const posts = u.capture({ paths: path });
  const mark = u.toastMark();
  try {
    await press();
    const row = await posts.waitFor(op ? { path, op } : path, { timeout: TOAST_WAIT_MS });
    answered(row, `${what}: the page's POST ${path}`);
    assert.equal(row.status, 200, `${what}: POST ${path} answered ${row.status} ${JSON.stringify(row.json)}`);
    const shown = await u.waitForToast(() => true, { since: mark, timeout: TOAST_WAIT_MS });
    assert.deepEqual(
      { kind: shown.kind, text: shown.text },
      { kind: "info", text: toast },
      `${what}: the toast reports the change${affected === null ? "" : ` and the ${affected} item${affected === 1 ? "" : "s"} it touched`}`,
    );
    if (affected !== null) assert.equal(row.json?.affected, affected, `${what}: the server's answer counts the items it recomputed`);
    return row;
  } finally {
    posts.stop();
  }
}

scenario("A19.4 teams on the account screen: create, rename, add (one invitation, access granted), make and remove an admin (and what that allows), remove, delete; each change reports how many items it touched", {
  tiers: LOCAL,
  effects: ["email:POST /team-members", "email:POST /access"],
  needs: ["email", "mailpit"],
  timeoutMs: 600_000,
  ...ON_STALL,
}, async (ctx) => {
  const t = tag();
  const [ownerAcct, memberAcct] = await cast(target, ["owner", "member"]);
  const [owner, member] = await Promise.all([openSession(target, ownerAcct), openSession(target, memberAcct)]);
  const doc = await publish(owner.http, { fixture: "crdt-paragraphs.html", title: `A19.4 team doc ${t}`, name: "a194-doc" });
  const o = await signedIn(ctx, ownerAcct, "owner");
  await openAccount(o, ownerAcct.email);
  const teams = section(o, "Teams");
  await teams.getByText("You are not in any team yet.").waitFor({ timeout: RECORD_WAIT_MS });

  ctx.step("create: New team → name → Create");
  const name1 = `A19.4 team ${t}`;
  await teams.getByRole("button", { name: "New team" }).click();
  await o.page.locator("#new-team").fill(name1);
  await teamChange(o, {
    what: "create",
    path: "/team",
    op: "create",
    press: () => teams.getByRole("button", { name: "Create", exact: true }).click(),
    toast: `${name1} created. Add people to it, then share with it by name.`,
  });
  const row = teams.locator("li.token-row", { hasText: name1 });
  await row.getByText("1 person · you are the owner").waitFor({ timeout: RECORD_WAIT_MS });
  const mine = (await adminFor(target).db.collection("teams").where("ownerEmail", "==", ownerAcct.email).get()).docs;
  assert.equal(mine.length, 1, "exactly one team owned by this account");
  const teamId = mine[0].id;
  // Made by the browser, so no helper ledgered it (lib/ledger.mjs's "team" row).
  appendLedger(target, { kind: "team", teamId, ownerEmail: ownerAcct.email, actor: o.name, name: name1 });
  const rec1 = mine[0].data();
  assert.deepEqual(Object.keys(rec1).sort(), TEAM_KEYS, "the team record's keys (SPEC §18)");
  assert.deepEqual(
    { teamId: rec1.teamId, name: rec1.name, ownerEmail: rec1.ownerEmail, admins: rec1.admins, members: rec1.members },
    { teamId, name: name1, ownerEmail: ownerAcct.email, admins: [ownerAcct.email], members: [ownerAcct.email] },
  );
  // The team, its owner its only member so far, is granted on the document.
  const g = await share(target, { owner, doc: doc.docId, team: teamId, role: "viewer" });
  precondition(g.status === 200 && g.mirror?.ok, `the team is granted on the document: ${g.status} ${JSON.stringify(g.mirror)}`);

  ctx.step("rename: Manage → Name → Rename");
  await row.getByRole("button", { name: "Manage", exact: true }).click();
  let dlg = o.page.getByRole("dialog", { name: name1 });
  await dlg.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  const name2 = `A19.4 renamed ${t}`;
  await dlg.locator("#team-name").fill(name2);
  await teamChange(o, { what: "rename", path: "/team", op: "rename", press: () => dlg.getByRole("button", { name: "Rename", exact: true }).click(), toast: "Renamed." });
  dlg = o.page.getByRole("dialog", { name: name2 });
  await dlg.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  const rec2 = await readDoc(target, `teams/${teamId}`);
  // The slug as functions/src/lib/folders.ts slugify() makes it.
  const slug = name2.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  assert.deepEqual({ name: rec2.name, slug: rec2.slug }, { name: name2, slug }, "the record is renamed and re-slugged");

  ctx.step("add: the member is in the team, gets the team's document, and exactly one invitation");
  const box = mailbox(target);
  await dlg.locator("#team-invite").fill(memberAcct.email);
  await teamChange(o, {
    what: "add",
    path: "/team-members",
    press: () => dlg.getByRole("button", { name: "Add", exact: true }).click(),
    toast: `${memberAcct.email} is in ${name2}. Access updated on 1 item.`,
    affected: 1,
  });
  const rec3 = await readDoc(target, `teams/${teamId}`);
  assert.deepEqual({ members: rec3.members, admins: rec3.admins }, { members: [memberAcct.email, ownerAcct.email].sort(), admins: [ownerAcct.email] });
  assert.ok((await readDoc(target, `docs/${doc.docId}`)).members.includes(memberAcct.email), "the member reads the team's document");
  const invite = await box.expectMail({ to: memberAcct.email, count: 1, timeout: 120_000 });
  assert.equal(invite.messages[0].Subject, `${ownerAcct.email} shared “${name2}” with you`, "the invitation names the team");
  assert.equal(await dlg.locator("li.member-row", { hasText: ownerAcct.email }).getByRole("button").count(), 0, "the owner's row has no controls");

  const renameAs = async (s, name) => answered(await s.http.postJson("/team", { op: "rename", teamId, name }), `the member's POST /team rename`);
  assert.equal((await renameAs(member, `not an admin ${t}`)).status, 403, "a plain member may not rename the team");

  ctx.step("Make admin: the record says so, and the member may now rename (the owner's dialog follows live)");
  const memberRow = dlg.locator("li.member-row", { hasText: memberAcct.email });
  await teamChange(o, {
    what: "Make admin",
    path: "/team-members",
    press: () => memberRow.getByRole("button", { name: "Make admin", exact: true }).click(),
    toast: `${memberAcct.email} is an admin. Access updated on 1 item.`,
    affected: 1,
  });
  assert.deepEqual((await readDoc(target, `teams/${teamId}`)).admins, [memberAcct.email, ownerAcct.email].sort(), "admins");
  const name3 = `A19.4 admin-renamed ${t}`;
  assert.equal((await renameAs(member, name3)).status, 200, "an admin may rename the team");
  dlg = o.page.getByRole("dialog", { name: name3 });
  await dlg.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });

  ctx.step("Remove admin: the record drops it, and renaming is refused again");
  await teamChange(o, {
    what: "Remove admin",
    path: "/team-members",
    press: () => dlg.locator("li.member-row", { hasText: memberAcct.email }).getByRole("button", { name: "Remove admin", exact: true }).click(),
    toast: `${memberAcct.email} is no longer an admin. Access updated on 1 item.`,
    affected: 1,
  });
  assert.deepEqual((await readDoc(target, `teams/${teamId}`)).admins, [ownerAcct.email], "admins");
  assert.equal((await renameAs(member, `demoted ${t}`)).status, 403, "no longer an admin, no longer allowed");

  ctx.step("remove: the member is out of the team and loses the team's document");
  await teamChange(o, {
    what: "remove",
    path: "/team-members",
    press: () => dlg.getByRole("button", { name: `Remove ${memberAcct.email} from ${name3}`, exact: true }).click(),
    toast: `${memberAcct.email} is out of ${name3}. Access updated on 1 item.`,
    affected: 1,
  });
  assert.deepEqual((await readDoc(target, `teams/${teamId}`)).members, [ownerAcct.email], "members");
  assert.ok(!(await readDoc(target, `docs/${doc.docId}`)).members.includes(memberAcct.email), "the member no longer reads the team's document");

  ctx.step("re-add the member before deletion, so the delete must revoke inherited access");
  await dlg.locator("#team-invite").fill(memberAcct.email);
  await teamChange(o, { what: "re-add", path: "/team-members", press: () => dlg.getByRole("button", { name: "Add", exact: true }).click(), toast: `${memberAcct.email} is in ${name3}. Access updated on 1 item.`, affected: 1 });
  assert.ok((await readDoc(target, `docs/${doc.docId}`)).members.includes(memberAcct.email), "the re-added member reads the document before team deletion");
  ctx.step("delete: Delete this team → Delete <name>; the record is gone and the list is empty");
  await dlg.getByRole("button", { name: "Delete this team" }).click();
  await teamChange(o, {
    what: "delete",
    path: "/team",
    op: "delete",
    press: () => dlg.getByRole("button", { name: `Delete ${name3}`, exact: true }).click(),
    toast: `${name3} is gone. Access updated on 1 item.`,
    affected: 1,
  });
  await dlg.waitFor({ state: "detached", timeout: RECORD_WAIT_MS });
  assert.equal(await readDoc(target, `teams/${teamId}`), null, "the team record is deleted");
  assert.ok(!(await readDoc(target, `docs/${doc.docId}`)).members.includes(memberAcct.email), "deleting a populated team revokes its member's document access");
  await teams.getByText("You are not in any team yet.").waitFor({ timeout: RECORD_WAIT_MS });

  ctx.step("only the add and re-add sent mail: the member's count holds at two");
  await box.expectMail({ to: memberAcct.email, count: 2 });
  noPageErrors([o]);
});

// --- A19.5 -------------------------------------------------------------------

/** POST /mcp initialize with a bearer token: the raw response, once it is the product's answer and not Hosting's cut-off (answered). */
async function mcpProbe(ctx, token, actor) {
  const m = ctx.mcp({ token, actor });
  const r = await m.raw({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bikeshed-e2e", version: "1" } } });
  answered(r.response, `${actor}: POST /mcp initialize`);
  return r;
}

scenario("A19.5 personal tokens: a name is required; bsk_ is shown once and stored only as a hash no client can read; first use sets lastUsedAt; Revoke makes /mcp answer 401 with error=\"invalid_token\"", {
  tiers: BOTH,
  timeoutMs: 360_000,
  ...ON_STALL,
}, async (ctx) => {
  const t = tag();
  const [acct] = await cast(target, ["owner"], { notifications: false, analytics: false });
  const session = await openSession(target, acct);

  ctx.step("a name is required: the server refuses an empty or blank one, and the Create button stays disabled");
  for (const name of ["", "   "]) {
    const r = answered(await session.http.postJson("/tokens", { op: "create", name, channel: "mcp" }), "POST /tokens create");
    assert.deepEqual({ status: r.status, error: r.json?.error }, { status: 400, error: NAME_REQUIRED }, `name ${JSON.stringify(name)}`);
  }
  const u = await signedIn(ctx, acct, "owner");
  await openAccount(u, acct.email);
  const tokens = section(u, "Access tokens");
  const nameBox = tokens.getByPlaceholder("What is it for? e.g. laptop CLI");
  const create = tokens.getByRole("button", { name: "Create", exact: true });
  await tokens.getByText("No tokens or connected apps yet.").waitFor({ timeout: RECORD_WAIT_MS });
  assert.equal(await create.isDisabled(), true, "Create is disabled with no name");
  await nameBox.fill("   ");
  assert.equal(await create.isDisabled(), true, "Create is disabled with a blank name");

  ctx.step("create an Agent (MCP) token: the plaintext is shown once, with the warning");
  const name = `A19.5 laptop ${t}`;
  await nameBox.fill(name);
  await tokens.getByRole("combobox", { name: "Token kind" }).selectOption("mcp");
  await create.click();
  const reveal = tokens.locator(".token-reveal");
  await reveal.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  const plaintext = (await reveal.locator(".token-value").textContent()).trim();
  const m = TOKEN_RE.exec(plaintext);
  assert.ok(m, "the revealed value is a bsk_ token");
  const [, tokenId, secret] = m;
  appendLedger(target, { kind: "token", tokenId, uid: acct.uid, channel: "mcp", name, via: "account-ui" });
  await tokens.getByText("This is the only time it is shown.", { exact: false }).waitFor({ timeout: 5_000 });
  const tokenRow = tokens.locator(`li.token-row[data-kind="token"]`, { hasText: name });
  await tokenRow.locator(".token-unused", { hasText: "never used" }).waitFor({ timeout: RECORD_WAIT_MS });
  assert.match((await tokenRow.textContent()).replace(/\s+/g, " "), /mcp · created .* · never used/, "the row says its channel and that it is unused");

  ctx.step("Done hides it, and neither the page nor a reload holds it again");
  await reveal.getByRole("button", { name: "Done", exact: true }).click();
  await reveal.waitFor({ state: "hidden", timeout: 5_000 });
  const pageHolds = async () => u.page.evaluate(([p, s]) => {
    const html = document.documentElement.outerHTML;
    return html.includes(p) || html.includes(s) || /bsk_[0-9a-f]{32}\./.test(html);
  }, [plaintext, secret]);
  assert.equal(await pageHolds(), false, "after Done the page holds no token");
  await u.page.reload();
  await tokenRow.waitFor({ state: "visible", timeout: RECORD_WAIT_MS });
  assert.equal(await pageHolds(), false, "after a reload the page holds no token");

  ctx.step("stored only as a hash: the record's hash is SHA-256 of the secret, nothing stores the plaintext, and no client reads the record");
  const record = await readDoc(target, `tokens/${tokenId}`);
  assert.equal(record.hash, sha256(secret), "tokens/{id}.hash is SHA-256 of the secret");
  assert.ok(!JSON.stringify(record).includes(secret), "the record holds no secret");
  const mirror = await readDoc(target, `users/${acct.uid}/tokens/${tokenId}`);
  assert.deepEqual(Object.keys(mirror).sort(), MIRROR_KEYS, "the account screen's mirror has no hash");
  const fs = clientFirestore(target, { idToken: () => idToken(target, acct), http: ctx.http({ actor: "owner-fs" }) });
  assert.equal((await fs.get(`tokens/${tokenId}`)).verdict, "DENY", "the owner's own client cannot read tokens/{id}");
  assert.equal((await fs.get(`users/${acct.uid}/tokens/${tokenId}`)).verdict, "ALLOW", "but reads its mirror (positive control)");
  const listed = answered(await listTokens(session), "POST /tokens list");
  assert.equal(listed.status, 200);
  const mineListed = listed.json.tokens.filter((x) => x.tokenId === tokenId);
  assert.equal(mineListed.length, 1, "POST /tokens list names it");
  assert.ok(!JSON.stringify(listed.json).includes(secret) && !JSON.stringify(listed.json).includes(record.hash), "the listing holds neither the secret nor the hash");
  assert.deepEqual({ name: mineListed[0].name, channel: mineListed[0].channel, lastUsedAt: mineListed[0].lastUsedAt, revoked: mineListed[0].revoked }, { name, channel: "mcp", lastUsedAt: null, revoked: false });

  ctx.step("first use: POST /mcp initialize answers 200, and lastUsedAt appears on the record, its mirror and the row");
  const used = await mcpProbe(ctx, plaintext, "token");
  assert.equal(used.status, 200, "the token works");
  await eventually(async () => {
    const [r, mm] = await Promise.all([readDoc(target, `tokens/${tokenId}`), readDoc(target, `users/${acct.uid}/tokens/${tokenId}`)]);
    return Boolean(r.lastUsedAt && mm.lastUsedAt) || false;
  }, { timeout: RECORD_WAIT_MS, message: "lastUsedAt is set on tokens/{id} and its mirror" }).catch(error => {
    if (error.code !== "E2E_EVENTUALLY_TIMEOUT") throw error;
  });
  const [usedRecord, usedMirror] = await Promise.all([readDoc(target, `tokens/${tokenId}`), readDoc(target, `users/${acct.uid}/tokens/${tokenId}`)]);
  assert.ok(usedRecord.lastUsedAt && usedMirror.lastUsedAt, "lastUsedAt is set on tokens/{id} and its mirror after use");
  await tokenRow.getByText(/last used/).waitFor({ timeout: RECORD_WAIT_MS });
  assert.equal(await tokenRow.locator(".token-unused").count(), 0, "the row no longer says never used");

  ctx.step("Revoke: the row says revoked and offers no Revoke; /mcp answers 401 with the invalid_token challenge");
  const mark = u.toastMark();
  await tokenRow.getByRole("button", { name: "Revoke", exact: true }).click();
  await u.waitForToast((x) => x.text === "Revoked.", { since: mark, timeout: TOAST_WAIT_MS });
  await eventually(async () => (await tokenRow.getAttribute("data-revoked")) === "true", { timeout: RECORD_WAIT_MS, message: "the row is marked revoked" });
  assert.match((await tokenRow.textContent()).replace(/\s+/g, " "), /revoked/);
  assert.equal(await tokenRow.getByRole("button", { name: "Revoke" }).count(), 0, "a revoked row offers no Revoke");
  assert.ok((await readDoc(target, `tokens/${tokenId}`)).revokedAt, "tokens/{id}.revokedAt is set");
  const refused = await mcpProbe(ctx, plaintext, "token-revoked");
  assert.equal(refused.status, 401, "a revoked token is refused");
  assert.match(String(refused.headers.get("www-authenticate") ?? ""), /error="invalid_token"/, `the challenge says invalid_token: ${refused.headers.get("www-authenticate")}`);
  noPageErrors([u]);
});

/** Personal tokens follow the current Auth identity on every request (SPEC §19). */
const currentIdentityCases = {
  disabled: "A19.5 S15: once the Auth user is disabled, their session is refused, and so is their personal token",
  deleted: "A19.5 S15: once the Auth user is deleted, their session is refused, and so is their personal token",
};
for (const state of ["disabled", "deleted"]) {
scenario(currentIdentityCases[state], {
  tiers: LOCAL,
  needs: ["admin-emulator"],
  timeoutMs: 180_000,
  ...ON_STALL,
}, async (ctx) => {
  const t = tag();
  const [acct] = await cast(target, ["owner"]);
  const session = await openSession(target, acct);
  const { token } = await mintToken(session, { name: `e2e a19.5 s15 ${t}`, channel: "mcp" });

  ctx.step("before: the session lists tokens and the token initializes MCP");
  precondition(answered(await listTokens(session), "POST /tokens list").status === 200, "the session works");
  precondition((await mcpProbe(ctx, token, "token")).status === 200, "the token works");

  ctx.step(`the operator makes the Auth user ${state}`);
  const auth = adminFor(target).auth;
  if (state === "disabled") {
    await auth.updateUser(acct.uid, { disabled: true });
    precondition((await auth.getUser(acct.uid)).disabled === true, "the user is disabled");
  } else {
    await auth.deleteUser(acct.uid);
    const absent = await auth.getUser(acct.uid).then(() => false, (err) => err.code === "auth/user-not-found");
    precondition(absent, "the user is deleted");
  }

  ctx.step("control: the session cookie is now refused (POST /tokens list 401)");
  const sessionAfter = await eventually(async () => {
    const r = answered(await listTokens(session), `${state} user's POST /tokens list`);
    return r.status === 401 ? r : false;
  }, { timeout: 10_000, message: `${state} user's session is refused` }).catch((err) => {
    if (stackDidNotAnswer(err.cause)) throw err.cause;
    return null;
  });
  precondition(sessionAfter, `${state}: the session is refused before comparing the token`);

  ctx.step("the personal token is refused through the same current-identity boundary");
  const after = await mcpProbe(ctx, token, `token-after-${state}`);
  assert.equal(after.status, 401, `a ${state} user's personal token is refused`);
});
}

// --- A19.6 -------------------------------------------------------------------

/** The skill names the stack's tree ships: claude-plugin/skills/<name>/SKILL.md. */
function treeSkills() {
  const root = join(target.stack?.treeDir ?? REPO_ROOT, "claude-plugin", "skills");
  return readdirSync(root).filter((n) => existsSync(join(root, n, "SKILL.md"))).sort();
}

scenario("A19.6 each skill zip is application/zip, an attachment, holding exactly the folder <name>/ and <name>/SKILL.md, stored and byte-equal to the served SKILL.md; the account screen offers each one and the download is those bytes", {
  tiers: BOTH,
  timeoutMs: 180_000,
  ...ON_STALL,
}, async (ctx) => {
  const http = ctx.http({ actor: "anonymous" });
  ctx.step("the index lists the tree's skills, each with its archive");
  const index = await http.get("/skills/index.json", { expect: 200 });
  const skills = index.json?.skills ?? [];
  assert.deepEqual(skills.map((s) => s.name).sort(), treeSkills(), "the index lists every skill the tree ships");
  for (const s of skills) {
    assert.match(s.name, /^[a-z0-9][a-z0-9-]*$/, "a skill name is a safe directory name");
    assert.equal(s.archive, `skills/${s.name}.zip`, `${s.name}: its archive`);
  }

  const zips = new Map();
  for (const s of skills) {
    ctx.step(`/skills/${s.name}.zip`);
    const z = await http.get(`/${s.archive}`, { expect: 200 });
    assert.deepEqual(
      { type: z.headers.get("content-type"), disposition: z.headers.get("content-disposition"), nosniff: z.headers.get("x-content-type-options") },
      { type: "application/zip", disposition: "attachment", nosniff: "nosniff" },
      `${s.name}.zip headers`,
    );
    // The folder and its one file, nothing else (tools/stamp-deployment.mjs skillArchives).
    const entries = readZip(z.buffer);
    assert.deepEqual(entries.map((e) => [e.name, e.dir]), [[`${s.name}/`, true], [`${s.name}/SKILL.md`, false]], `${s.name}.zip holds exactly the folder ${s.name}/ and ${s.name}/SKILL.md`);
    const file = entries[1];
    assert.equal(file.method, 0, `${s.name}.zip is stored, not compressed`);
    const md = await http.get(`/skills/${s.name}/SKILL.md`, { expect: 200 });
    assert.equal(sha256(file.data), sha256(md.buffer), `${s.name}: the zipped SKILL.md is the served (stamped) one, byte for byte`);
    assert.match(md.text, new RegExp(`^---\\n(?:[^\\n]*\\n)*?name: ${s.name}\\n`), `${s.name}: its frontmatter names it`);
    zips.set(s.name, z.buffer);
  }

  ctx.step("/skills/bikeshed-plugin.zip holds the manifest and every skill, each the served (stamped) one");
  assert.equal(index.json?.plugin, "skills/bikeshed-plugin.zip", "the index names the plugin zip");
  const plugin = await http.get(`/${index.json.plugin}`, { expect: 200 });
  assert.deepEqual(
    { type: plugin.headers.get("content-type"), disposition: plugin.headers.get("content-disposition"), nosniff: plugin.headers.get("x-content-type-options") },
    { type: "application/zip", disposition: "attachment", nosniff: "nosniff" },
    "the plugin zip's headers",
  );
  const held = readZip(plugin.buffer);
  assert.deepEqual(
    held.map((e) => e.name),
    [".claude-plugin/", ".claude-plugin/plugin.json", "skills/", ...skills.flatMap((s) => [`skills/${s.name}/`, `skills/${s.name}/SKILL.md`])],
    "the plugin zip holds the manifest and every skill, and nothing else",
  );
  assert.ok(held.every((e) => e.method === 0), "the plugin zip is stored, not compressed");
  for (const s of skills) {
    const md = await http.get(`/skills/${s.name}/SKILL.md`, { expect: 200 });
    assert.equal(sha256(held.find((e) => e.name === `skills/${s.name}/SKILL.md`).data), sha256(md.buffer), `the plugin's ${s.name} is the served (stamped) one, byte for byte`);
  }

  ctx.step("the account screen leads with the plugin, then each zip in the index's order, and downloading gives those bytes");
  const [acct] = await cast(target, ["owner"], { notifications: false, analytics: false });
  const u = await signedIn(ctx, acct, "owner");
  await openAccount(u, acct.email);
  const links = u.page.locator("ul.connect-skills a[download]");
  await eventually(async () => (await links.count()) === skills.length + 1, { timeout: 15_000, message: "the plugin, and one download link per skill" });
  assert.deepEqual(await links.evaluateAll((as) => as.map((a) => a.getAttribute("href"))), [`/${index.json.plugin}`, ...skills.map((s) => `/${s.archive}`)], "the links");
  const [pluginDownload] = await Promise.all([u.page.waitForEvent("download", { timeout: 15_000 }), links.first().click()]);
  assert.equal(pluginDownload.suggestedFilename(), "bikeshed-plugin.zip", "the download is named for the plugin");
  assert.equal(sha256(readFileSync(await pluginDownload.path())), sha256(plugin.buffer), "the downloaded bytes are the served plugin zip");

  const first = skills[0];
  await u.page.locator(".connect-guide summary", { hasText: "Free plan" }).click();
  const [dl] = await Promise.all([u.page.waitForEvent("download", { timeout: 15_000 }), links.nth(1).click()]);
  assert.equal(dl.suggestedFilename(), `${first.name}.zip`, "the download is named for the skill");
  const path = await dl.path();
  assert.equal(sha256(readFileSync(path)), sha256(zips.get(first.name)), "the downloaded bytes are the served zip");
  noPageErrors([u]);
});
