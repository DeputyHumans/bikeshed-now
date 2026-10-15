// SPDX-License-Identifier: Apache-2.0
// A1 identity: landing, password sign-up and its code, lockout, resend gap, recipients, sign-out, next=, shared-before-sign-up, frame headers (SPEC §1, §2, §3, §14, §23).

/**
 * The A1 catalogue, one scenario per case, each with its own accounts and
 * documents (the stack is shared with other specs):
 *
 *   A1.1  `/` as an anonymous visitor: the landing page, no __session, no
 *         POST /session; GET /config is 200 with keys ⊆ {signInHint} (§1.2, §2)
 *   A1.2  password sign-up at /signup: /session says "unverified", exactly one
 *         code mail, /verify/complete {verified:true}, the next /session "ok"
 *         with the cookie attributes §2 names, users/{uid} = {uid, email}. The
 *         account is created with accounts:signUp (what the SDK's
 *         createUserWithEmailAndPassword sends); A1.2b covers the browser form.
 *   A1.2b the form enables after a rejected policy request and creates an
 *         unverified account locally through the real browser Auth SDK. This
 *         guards X-a01-identity-1: allMet([]) formerly disabled it forever.
 *   A1.3  five wrong codes are each 400; the sixth attempt — the RIGHT code —
 *         is 429 and the verification is deleted; the account stays unverified
 *   A1.4  a second start inside 60 s is 429 and the mail count holds at 1; the
 *         gap is still closed at 55 s and open again after 60 s (time-based:
 *         these two waits are the product's own clock, not a settle; a probe
 *         the server only ran after the gap is INCONCLUSIVE, not a failure)
 *   A1.5  malformed recipients on /access, /folder-access and /team-members
 *         are 400 "not a valid recipient: …"; a mixed batch grants nobody and
 *         invites nobody (§1.3)
 *   A1.6  Sign out: DELETE /session 204 with Max-Age=0; the private document's
 *         content is 200 before and 404 after, in the browser and over HTTP
 *   A1.7  `next=` is honoured only as a path on this origin (§21 "Where Fork is
 *         offered"): hostile values land on `/`, a same-origin path lands there
 *   A1.8  a document shared before sign-up is listed on the workspace's first
 *         render: the empty state never appears (§14 sign-up step 5). When the
 *         stack took over 10 s to answer the page's first Firestore Listen,
 *         the SDK goes offline and the empty state comes from its cache: that
 *         run measured A1.8b's path, not this one, and is INCONCLUSIVE
 *   A1.8b the same, with the Listen channel held past the SDK's 10 s on
 *         purpose: no false empty state from the offline cache before it lists
 *         the shared document (regression X-a01-identity-3)
 *   A1.8c the owner's existing document, under the same delayed first listen:
 *         no false empty state before the server's card (X-a14-workspace-2)
 *   A1.9  /connect and /signup send X-Frame-Options: DENY and
 *         frame-ancestors 'none' (§23 Consent)
 *   A1.9b mixed case, trailing slash and encoded routes, and protected account
 *         and folder routes, render sign-in and carry the same frame headers.
 *         Production Hosting headers require a production observation; local
 *         execution proves only the emulator (X-a01-identity-2).
 *   A1.9c the framing proof, local only (it needs a stack spare port for the
 *         other origin): another origin cannot show sign-in in any variant.
 *   A1.9d every app-shell entry path, including paths that client-redirect,
 *         carries frame headers; document byte routes remain embeddable.
 *
 * Email-sending cases are local only and declare their effects. Only e2e/lib/
 * talks to the stack. Waits for the server's answer allow ANSWER_MS: a shared
 * stack under other specs' load has run single functions for most of a minute.
 * A case the stack did not answer (Hosting's 504 at its 60 s cut-off, a
 * request with no answer, or a wait that ran out while a page saw the stack
 * stall) ends INCONCLUSIVE, never PASS or FAIL: the product gave no answer to
 * judge (budgeted: lib/test.mjs's caseBudget, onAnsweringStack, pageStall and
 * functionKill; every raw response a case judges goes through its answered()).
 * Setup sends again what the stack did not answer, until SETUP_MS. A1.8b holds
 * the page's Firestore Listen channel itself, so the loss it causes is no
 * evidence there (afterHold).
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after } from "node:test";
import { answered, caseBudget, currentTarget, functionKill, onAnsweringStack, pageStall, precondition, scenario, untilLanded } from "../../lib/test.mjs";
import { FIRESTORE_LISTEN_PATH } from "../../lib/browser.mjs";
import { cast, castUnverified, localEmail, passwordFor, rand4, runTag } from "../../lib/accounts.mjs";
import { appendLedger } from "../../lib/ledger.mjs";
import { closeSession, idToken, openSession } from "../../lib/session.mjs";
import { createFolder, createTeam, publish } from "../../lib/seed.mjs";
import { share, shareFolder, teamMembers } from "../../lib/grant.mjs";
import { adminFor, closeAdmin, readDoc } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { mailbox } from "../../lib/mail/reader.mjs";
import { claimSparePort } from "../../lib/spare.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

/** The subject notify.ts writes for a verification code. */
const CODE_SUBJECT = /^\d{6} is your Bikeshed verification code$/;
/** SESSION_EXPIRES_MS / 1000 (functions/src/config.ts): five days. */
const SESSION_MAX_AGE = String(5 * 24 * 60 * 60);
/** The resend gap the product enforces (functions/src/index.ts VERIFY_RESEND_GAP_MS). */
const RESEND_GAP_MS = 60_000;
/**
 * How long a wait for the SERVER's answer may take: a request, a POST /session
 * the page makes, the page acting on it. The Hosting emulator gives a function
 * 60 s and then answers 504 itself; on a long-lived shared stack single
 * function executions have been measured at 25-59 s (its logs/emulators.log),
 * past signInUi's 45 s and page.waitForResponse's 30 s defaults. None of these
 * waits is an oracle; each ends at the answer, not at the bound.
 */
const ANSWER_MS = 120_000;

// --- helpers ------------------------------------------------------------------

/**
 * The case's HTTP client for `actor`, waiting ANSWER_MS for every request
 * (the client's default, so the helpers that send through it wait as long).
 * http.mjs's own 60 s would race the Hosting emulator's 60 s: a function that
 * overruns would read as "timeout after 60000 ms", which could be either side.
 * Waiting longer lets the stack's own 504 say which.
 */
function httpFor(ctx, actor) {
  return ctx.http({ actor, timeoutMs: ANSWER_MS });
}

/**
 * How long, from a case's start, its setup (the sessions and documents it
 * makes before measuring) may go on sending again what the stack did not
 * answer: past it, the next non-answer ends the case INCONCLUSIVE (untilLanded
 * stopAt), so a loaded stack cannot spend the measurement's time on setup.
 */
const SETUP_MS = 100_000;

/**
 * A setup session for `acct` (openSession, its client httpFor's): a POST
 * /session the stack did not answer is sent again (lib/test.mjs untilLanded,
 * an idempotent call) until `stopAt`, and the case ends INCONCLUSIVE when that
 * keeps happening. Never for a session a case judges.
 */
async function sessionFor(ctx, acct, actor, stopAt) {
  const { out } = await untilLanded(ctx, `POST /session (${actor})`, () => openSession(target, acct, { http: httpFor(ctx, actor) }), null, { stopAt });
  return out;
}

/**
 * A case body, judged as lib/test.mjs judges one declared with
 * inconclusiveOnCaseTimeout: it runs against a budget (caseBudget: the case's
 * `timeoutMs` less a margin), and a failure the stack made (onAnsweringStack:
 * Hosting's cut-off, a request with no answer; then `pages`, by default
 * pageStall: a wait that ran out while a page saw the stack stall) ends
 * INCONCLUSIVE. One reading more, of the budget alone: running out of it while
 * the emulator's own log shows the stack overloaded since the case began
 * (functionKill: functions killed for a lock timeout, or stopped at 60 s while
 * Hosting answered 504) is the stack's slowness too. A wait of the case's own
 * that ran out still needs a page's evidence, and an assertion never is.
 */
function budgeted(timeoutMs, body, { pages = pageStall } = {}) {
  return onAnsweringStack(caseBudget(body, timeoutMs), {
    also: async (err, ctx) => (await pages(err, ctx)) ?? (err?.code === "E2E_CASE_BUDGET" ? functionKill(err, ctx) : null),
  });
}

/** A response entry (User.waitForResponse) whose request is `method path`. */
const call = (method, path) => (r) => r.method === method && r.path === path;

/** The JSON body of a browser response entry, or null (a navigation can take it). */
async function bodyOf(entry) {
  try {
    return await entry.response.json();
  } catch {
    return null;
  }
}

/** A Set-Cookie line as {name, value, attrs: {lowercased name: value | true}}. */
function parseSetCookie(line) {
  const [pair, ...rest] = String(line).split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  const attrs = {};
  for (const a of rest) {
    if (!a) continue;
    const i = a.indexOf("=");
    if (i < 0) attrs[a.toLowerCase()] = true;
    else attrs[a.slice(0, i).trim().toLowerCase()] = a.slice(i + 1).trim();
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

/** The __session Set-Cookie of a browser response entry (Playwright's raw headers). */
async function sessionSetCookie(entry) {
  const raw = (await entry.response.headerValue("set-cookie")) ?? "";
  const line = raw.split("\n").find((l) => l.trim().startsWith("__session="));
  return line ? parseSetCookie(line) : null;
}

/** The code in a verification subject. */
function codeOf(subject) {
  const m = /^(\d{6}) is your Bikeshed verification code$/.exec(subject ?? "");
  if (!m) throw new Error(`not a verification subject: ${JSON.stringify(subject)}`);
  return m[1];
}

/** Six-digit codes that are not `code`, all different. */
function wrongCodes(code, n) {
  const out = [];
  let k = Number(code);
  while (out.length < n) {
    k = (k + 104_729) % 1_000_000;
    const c = String(k).padStart(6, "0");
    if (c !== code && !out.includes(c)) out.push(c);
  }
  return out;
}

/** POST /verify/<action> as the account's ID token, over HTTP (a Hosting cut-off throws, see answered). */
async function verify(http, token, action, json) {
  return answered(await http.postJson(`/verify/${action}`, json, { headers: { authorization: `Bearer ${token}` } }), `POST /verify/${action}`);
}

/** The user record's `verification` field, or undefined. */
async function verificationOf(uid) {
  return (await readDoc(target, `users/${uid}`))?.verification;
}

/** On the "Almost there" screen: press Send me a code; the /verify/start outcome. */
async function sendCodeUi(u) {
  const send = u.page.getByRole("button", { name: "Send me a code", exact: true });
  await send.waitFor({ state: "visible", timeout: 15_000 });
  const mark = u.responseMark();
  await send.click();
  const st = answered(await u.waitForResponse(call("POST", "/verify/start"), { since: mark, timeout: ANSWER_MS }));
  return { status: st.status, body: await bodyOf(st) };
}

/** Type the code and press Confirm; the /verify/complete and the next POST /session. */
async function confirmCodeUi(u, code) {
  await u.page.fill("#verify-code", code);
  const mark = u.responseMark();
  await u.page.getByRole("button", { name: "Confirm", exact: true }).click();
  const c = answered(await u.waitForResponse(call("POST", "/verify/complete"), { since: mark, timeout: ANSWER_MS }));
  const s = answered(await u.waitForResponse(call("POST", "/session"), { since: c.seq, timeout: ANSWER_MS }));
  return {
    complete: { status: c.status, body: await bodyOf(c) },
    session: { status: s.status, body: await bodyOf(s), cookie: await sessionSetCookie(s) },
  };
}

function noPageErrors(users) {
  for (const u of users) assert.deepEqual(u.log.errors.map((e) => e.message), [], `${u.name}: uncaught page errors`);
}

// --- A1.1 ---------------------------------------------------------------------

scenario("A1.1 `/` as an anonymous visitor: the landing page, no __session and no POST /session; GET /config is 200 with keys ⊆ {signInHint}", {
  tiers: ["local", "prod"],
  timeoutMs: 150_000,
}, budgeted(150_000, async (ctx) => {
  ctx.step("GET / over HTTP with no cookies: 200 and no Set-Cookie");
  const http = httpFor(ctx, "anonymous");
  const root = await http.get("/", { expect: 200 });
  assert.deepEqual(root.setCookies, [], "GET / sets no cookie");

  ctx.step("GET /config: 200 JSON whose keys are a subset of {signInHint}, signInHint a string when present (SPEC §1.2, §2)");
  const config = await http.get("/config", { expect: 200 });
  assert.match(String(config.headers.get("content-type")), /^application\/json/, "content-type");
  assert.ok(config.json && typeof config.json === "object" && !Array.isArray(config.json), `a JSON object: ${config.text.slice(0, 200)}`);
  const extra = Object.keys(config.json).filter((k) => k !== "signInHint");
  assert.deepEqual(extra, [], `GET /config exposes nothing but signInHint: ${config.text.slice(0, 300)}`);
  if ("signInHint" in config.json) assert.equal(typeof config.json.signInHint, "string", "signInHint is a string");

  ctx.step("an anonymous browser opens /: the landing page renders, no __session is stored, and the app never posts /session");
  const anon = await ctx.users.user({ name: "anonymous" });
  await anon.goto("/");
  await anon.page.locator(".landing").waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await anon.sessionCookie(), null, "no __session cookie for an anonymous visitor");
  const sessionCalls = anon.log.requests.filter((r) => new URL(r.url).pathname === "/session");
  assert.deepEqual(sessionCalls.map((r) => `${r.method} ${r.status}`), [], "no request to /session");
  noPageErrors([anon]);
}));

// --- A1.2 ---------------------------------------------------------------------

scenario("A1.2 password sign-up at /signup: unverified, one code mail, /verify/complete verified, then /session ok with the §2 cookie and users/{uid} = {uid, email}", {
  tiers: ["local"],
  effects: ["email:POST /verify/start"],
  needs: ["email", "mailpit", "admin-emulator"],
  timeoutMs: 420_000,
}, budgeted(420_000, async (ctx) => {
  const email = localEmail(target, "signup");
  const box = mailbox(target);
  assert.deepEqual(await box.find({ to: email }), [], "nothing for the new address before sign-up");

  // The account is created with accounts:signUp, the Auth REST call the web
  // SDK's createUserWithEmailAndPassword makes: the form's own "Create account"
  // never enables against the Auth emulator (A1.2b, X-a01-identity-1).
  ctx.step(`${email} is created unverified (accounts:signUp), then signs in at /signup`);
  const acct = await castUnverified(target, "signup", { email, http: httpFor(ctx, "harness") });
  assert.equal((await adminFor(target).auth.getUser(acct.uid)).emailVerified, false, "the new account is not verified");
  assert.equal(await readDoc(target, `users/${acct.uid}`), null, "no users/{uid} before the first session");
  const u = await ctx.users.user({ name: "signup" });
  const first = await u.signInUi(email, acct.password, { expectStatus: "unverified", timeout: ANSWER_MS });
  assert.deepEqual(
    { status: first.status, already: first.already, httpStatus: first.httpStatus, body: first.body, gate: first.gate },
    { status: "unverified", already: false, httpStatus: 200, body: { status: "unverified" }, gate: "needs_verification" },
    "POST /session for an unverified password account, and the page at the verification step",
  );
  assert.equal(await u.sessionCookie(), null, "an unverified account gets no __session");

  ctx.step("the app blocks on the Verify step; Send me a code");
  await u.page.locator(".auth-step[aria-current=step]", { hasText: "3. Verify" }).waitFor({ state: "visible", timeout: 15_000 });
  const start = await sendCodeUi(u);
  assert.deepEqual(start, { status: 200, body: { sent: true, email } }, "POST /verify/start");

  ctx.step("exactly one code mail reaches Mailpit for the address, held 10 s");
  const { messages } = await box.expectMail({ to: email, count: 1 });
  assert.match(messages[0].Subject, CODE_SUBJECT, "the verification subject");
  const code = codeOf(messages[0].Subject);

  ctx.step("type the code and press Confirm");
  const done = await confirmCodeUi(u, code);
  assert.deepEqual(done.complete, { status: 200, body: { verified: true, email } }, "POST /verify/complete");
  assert.deepEqual({ status: done.session.status, body: done.session.body }, { status: 200, body: { status: "ok" } }, "the next POST /session");
  precondition(done.session.cookie, "the ok /session response carried no readable __session Set-Cookie");
  assert.deepEqual(done.session.cookie.attrs, { "max-age": SESSION_MAX_AGE, path: "/", httponly: true, secure: true, samesite: "Strict" }, `__session is HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=432000 (SPEC §2): got ${JSON.stringify(done.session.cookie.attrs)}`);
  assert.ok(done.session.cookie.value.length > 0, "the cookie has a value");

  ctx.step("the app leaves /signup for the workspace, holding __session; the account is verified and users/{uid} = {uid, email}");
  await u.poll(() => new URL(u.page.url()).pathname === "/", { timeout: ANSWER_MS, what: "landing on / after verification" });
  const stored = await u.sessionCookie();
  assert.ok(stored, "Chrome stored __session");
  assert.deepEqual({ httpOnly: stored.httpOnly, secure: stored.secure, sameSite: stored.sameSite, path: stored.path }, { httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
  assert.equal((await adminFor(target).auth.getUser(acct.uid)).emailVerified, true, "Firebase's emailVerified is now true (SPEC §14)");
  const record = await readDoc(target, `users/${acct.uid}`);
  assert.deepEqual({ uid: record?.uid, email: record?.email, verification: record?.verification }, { uid: acct.uid, email, verification: undefined }, "users/{uid} holds {uid, email} and no pending verification");
  assert.equal((await box.find({ to: email })).length, 1, "still exactly one mail");
  noPageErrors([u]);
}));

scenario("A1.2b Create account enables at /signup for a password the deployment's policy accepts, so a person can sign up there", {
  tiers: ["local", "prod"],
  timeoutMs: 60_000,
}, async (ctx) => {
  const email = localEmail(target, "create");
  const u = await ctx.users.user({ name: "create" });
  await u.goto("/signup");
  await u.page.getByRole("button", { name: "Create an account", exact: true }).click();
  const create = u.page.getByRole("button", { name: "Create account", exact: true });
  await create.waitFor({ state: "visible", timeout: 15_000 });
  ctx.step("type an address and a password with upper and lower case letters, a digit, a symbol and 28 characters");
  await u.page.fill("#auth-email", email);
  await u.page.fill("#auth-password", passwordFor(email));
  const policyFetch = () => u.log.requests.filter((r) => /\/passwordPolicy\b/.test(new URL(r.url).pathname)).map((r) => r.status ?? r.failure);
  await eventually(() => policyFetch().length > 0, { timeout: 15_000, message: "the form asked for the deployment's password policy" });
  ctx.step(`the password-policy fetch answered ${JSON.stringify(policyFetch())}`);
  await ctx.oracle(async () => {
    try {
      await eventually(async () => create.isEnabled(), { timeout: 15_000, interval: 250, message: "Create account enabled" });
    } catch {
      const shown = await u.page.locator("#password-requirements li").count();
      throw new Error(`Create account never enabled for a policy-satisfying password within 15 s: the password-policy fetch answered ${JSON.stringify(policyFetch())} and the form shows ${shown} requirement(s) and no reason`);
    }
  });
  if (target.kind === "local") {
    ctx.step("Create account submits to Auth and reaches the unverified account gate");
    const created = u.page.waitForResponse((r) => /\/accounts:signUp$/.test(new URL(r.url()).pathname) && r.request().method() === "POST", { timeout: 20_000 });
    const session = u.page.waitForResponse((r) => new URL(r.url()).pathname === "/session" && r.request().method() === "POST", { timeout: 20_000 });
    await create.click();
    const response = await created;
    const data = await response.json();
    assert.equal(response.status(), 200, "the enabled signup form creates the account");
    assert.equal(typeof data.localId, "string", "Auth returned the new account uid");
    appendLedger(target, { kind: "account", role: "create", email, uid: data.localId, tier: "local", verified: false, via: "browser-signup" });
    const answer = await session;
    assert.deepEqual(await answer.json(), { status: "unverified" }, "creating an account never bypasses email verification");
    assert.equal((await adminFor(target).auth.getUser(data.localId)).emailVerified, false);
    await u.page.locator(".auth-step[aria-current=step]", { hasText: "3. Verify" }).waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await u.sessionCookie(), null, "an unverified signup receives no session cookie");
  }
});

// --- A1.3 ---------------------------------------------------------------------

scenario("A1.3 five wrong codes are each 400; the sixth attempt, with the right code, is 429, the verification is deleted and the account stays unverified", {
  tiers: ["local"],
  effects: ["email:POST /verify/start"],
  needs: ["email", "mailpit", "admin-emulator"],
  timeoutMs: 600_000,
}, budgeted(600_000, async (ctx) => {
  const acct = await castUnverified(target, "lockout");
  const http = httpFor(ctx, "lockout");
  const token = await idToken(target, acct, { http });
  const box = mailbox(target);

  ctx.step("POST /verify/start; one code mail");
  const started = await verify(http, token, "start", {});
  assert.deepEqual({ status: started.status, json: started.json }, { status: 200, json: { sent: true, email: acct.email } }, "start");
  const { messages } = await box.expectMail({ to: acct.email, count: 1 });
  const code = codeOf(messages[0].Subject);

  const wrong = wrongCodes(code, 5);
  for (const [i, c] of wrong.entries()) {
    ctx.step(`wrong code ${i + 1} of 5`);
    const r = await verify(http, token, "complete", { code: c });
    assert.deepEqual({ status: r.status, json: r.json }, { status: 400, json: { error: "that code is not right" } }, `wrong code ${i + 1}`);
    assert.equal((await verificationOf(acct.uid))?.attempts, i + 1, `attempts after wrong code ${i + 1}`);
  }

  ctx.step("the sixth attempt is the RIGHT code: refused with 429, and the verification is deleted");
  const sixth = await verify(http, token, "complete", { code });
  assert.deepEqual({ status: sixth.status, json: sixth.json }, { status: 429, json: { error: "too many attempts; request a new code" } }, "the sixth attempt");
  assert.equal(await verificationOf(acct.uid), undefined, "users/{uid}.verification is deleted");

  ctx.step("the right code again: nothing is in progress any more; the account is still unverified");
  const seventh = await verify(http, token, "complete", { code });
  assert.deepEqual({ status: seventh.status, json: seventh.json }, { status: 409, json: { error: "no verification in progress" } }, "after the lockout");
  assert.equal((await adminFor(target).auth.getUser(acct.uid)).emailVerified, false, "emailVerified stays false");
  const s = answered(await http.postJson("/session", { idToken: await idToken(target, acct, { http }) }));
  assert.deepEqual({ status: s.status, json: s.json }, { status: 200, json: { status: "unverified" } }, "POST /session still says unverified");
  assert.equal((await box.find({ to: acct.email })).length, 1, "no further mail");
}));

// --- A1.4 ---------------------------------------------------------------------

scenario("A1.4 a second /verify/start within 60 s is 429 and the mail count holds at 1; the gap is closed at 55 s and open after 60 s", {
  tiers: ["local"],
  effects: ["email:POST /verify/start"],
  needs: ["email", "mailpit", "admin-emulator"],
  timeoutMs: 420_000,
}, budgeted(420_000, async (ctx) => {
  const acct = await castUnverified(target, "resend");
  const http = httpFor(ctx, "resend");
  const token = await idToken(target, acct, { http });
  const box = mailbox(target);

  ctx.step("the first start: 200");
  const first = await verify(http, token, "start", {});
  assert.deepEqual({ status: first.status, json: first.json }, { status: 200, json: { sent: true, email: acct.email } }, "first start");
  const sentAt = (await verificationOf(acct.uid))?.sentAt;
  precondition(typeof sentAt === "number", "the first start recorded no sentAt");

  ctx.step("a second start at once: 429, and the stored verification is untouched");
  const second = await verify(http, token, "start", {});
  assert.deepEqual({ status: second.status, json: second.json }, { status: 429, json: { error: "a code was just sent; wait a minute" } }, "second start inside the gap");
  assert.equal((await verificationOf(acct.uid))?.sentAt, sentAt, "the refused start did not rewrite the verification");

  // The two waits below are the product's own clock (the 60 s gap), not a
  // settle. The mail is counted after the 55 s probe, so a slow stack's
  // 10 s mailbox hold cannot push the probe past its point.
  ctx.step("at 55 s after the first send: still 429");
  const at55 = sentAt + RESEND_GAP_MS - 5_000 - Date.now();
  if (at55 <= 1_000) ctx.inconclusive(`the 55 s probe point had already passed (${at55} ms): the stack was too slow to place it`);
  await new Promise((r) => setTimeout(r, at55));
  const probeAt = Date.now();
  const third = await verify(http, token, "start", {});
  if (third.status === 200) {
    // A start the server let through rewrote sentAt with its own clock, AFTER
    // its gap check. Under RESEND_GAP_MS later it was decided inside the gap:
    // the product is wrong. At or over it, a slow stack ran the probe after
    // the gap, and it measured nothing.
    const reSent = (await verificationOf(acct.uid))?.sentAt;
    if (typeof reSent === "number" && reSent - sentAt >= RESEND_GAP_MS) {
      ctx.inconclusive(`the 55 s probe was let through, but the server ran it ${reSent - sentAt} ms after the first send, past the ${RESEND_GAP_MS} ms gap: the stack was too slow to place it`);
    }
  }
  assert.equal(third.status, 429, `a start at ~55 s: ${third.status} ${third.text.slice(0, 120)}`);
  // A refusal decided at 55 s or any later moment still shows the gap closed
  // at 55 s; a gap that stays closed too long is the next step's failure.
  ctx.step(`the probe was sent ${probeAt - sentAt} ms and answered ${Date.now() - sentAt} ms after the first send`);

  ctx.step("exactly one code mail for the three starts so far, held 10 s");
  const once = await box.expectMail({ to: acct.email, count: 1 });
  const code1 = codeOf(once.messages[0].Subject);

  ctx.step("after 60 s: 200, and a second code mail");
  await new Promise((r) => setTimeout(r, Math.max(0, sentAt + RESEND_GAP_MS + 1_500 - Date.now())));
  const fourth = await verify(http, token, "start", {});
  assert.deepEqual({ status: fourth.status, json: fourth.json }, { status: 200, json: { sent: true, email: acct.email } }, "a start after the gap");
  const twice = await box.expectMail({ to: acct.email, count: 2 });
  const code2 = codeOf(twice.messages.map((m) => m.Subject).find((s) => codeOf(s) !== code1) ?? twice.messages[0].Subject);

  ctx.step("the newest code verifies the account");
  const done = await verify(http, token, "complete", { code: code2 });
  assert.deepEqual({ status: done.status, json: done.json }, { status: 200, json: { verified: true, email: acct.email } }, "complete with the resent code");
}));

// --- A1.5 ---------------------------------------------------------------------

/** Addresses SPEC §1.3 calls malformed: whitespace, control characters, `..`, edge dots, `$ # [ ] /`, and no usable @ or domain. */
const MALFORMED = Object.freeze([
  "no-at-sign.example.com",
  "two words@example.com",
  "bell\u0007char@example.com",
  "double..dot@example.com",
  ".leading@example.com",
  "trailing.@example.com",
  "dollar$sign@example.com",
  "hash#sign@example.com",
  "bracket[open@example.com",
  "bracket]close@example.com",
  "slash/in@example.com",
  "nodot@localhost",
  "two@@example.com",
]);

scenario("A1.5 malformed recipients on /access, /folder-access and /team-members are 400 \"not a valid recipient\"; a mixed batch grants and invites nobody", {
  tiers: ["local"],
  effects: ["email:POST /access", "email:POST /folder-access", "email:POST /team-members"],
  needs: ["email", "mailpit", "admin-emulator"],
  timeoutMs: 600_000,
}, budgeted(600_000, async (ctx) => {
  const setupBy = Date.now() + SETUP_MS;
  const [ownerAcct] = await cast(target, ["owner"]);
  const owner = await sessionFor(ctx, ownerAcct, "owner", setupBy);
  const up = await publish(owner.http, { fixture: "crdt-paragraphs.html", title: `A1.5 recipients ${rand4()}`, name: "a15-recipients", patient: { ctx, stopAt: setupBy } });
  const docId = up.docId;
  const before = await readDoc(target, `docs/${docId}`);

  // Raw POST /access, not share(): share() ledgers a grant whatever the
  // answer, and the mixed batch below needs two entries in one request.
  // The case is local only (an email route), so nothing here reaches production.
  ctx.step(`POST /access with each of ${MALFORMED.length} malformed addresses, four at a time (each is refused alone and changes nothing)`);
  for (let i = 0; i < MALFORMED.length; i += 4) {
    const batch = MALFORMED.slice(i, i + 4);
    const answers = await Promise.all(batch.map(async (bad) => answered(await owner.http.postJson("/access", { docId, add: [{ email: bad, role: "viewer" }] }))));
    for (const [j, r] of answers.entries()) {
      assert.deepEqual({ status: r.status, json: r.json }, { status: 400, json: { error: `not a valid recipient: ${batch[j]}` } }, `/access with ${JSON.stringify(batch[j])}`);
    }
  }

  ctx.step("a mixed batch, one valid new address and one malformed: 400 naming only the malformed one; nobody is granted or invited");
  const valid = localEmail(target, "mixed");
  const mixed = answered(await owner.http.postJson("/access", { docId, add: [{ email: valid, role: "viewer" }, { email: "two words@example.com", role: "editor" }] }));
  assert.deepEqual({ status: mixed.status, json: mixed.json }, { status: 400, json: { error: "not a valid recipient: two words@example.com" } }, "the mixed batch");
  const afterDoc = await readDoc(target, `docs/${docId}`);
  const acl = (d) => Object.fromEntries(Object.entries(d ?? {}).filter(([, v]) => Array.isArray(v)).sort(([a], [b]) => a.localeCompare(b)));
  precondition(Array.isArray(before?.members) && before.members.includes(ownerAcct.email), `docs/${docId}.members does not list the owner: ${JSON.stringify(before?.members)}`);
  // The valid entry first: a batch applied in part names its grant, not just a changed list.
  const holding = Object.entries(acl(afterDoc)).filter(([, v]) => v.includes(valid)).map(([k]) => k);
  assert.deepEqual(holding, [], `the refused batch granted ${valid}: it is in ${holding.join(", ")}`);
  assert.deepEqual(acl(afterDoc), acl(before), "the document's member and role lists are unchanged");

  ctx.step("POST /folder-access and POST /team-members with a malformed address");
  const folder = await createFolder(owner.http, { name: `A1.5 folder ${rand4()}`, ownerEmail: ownerAcct.email });
  precondition(folder.folderId, `POST /folder returned no folder id: ${JSON.stringify(folder.json)}`);
  const fa = await shareFolder(target, { owner, folder, account: "slash/in@example.com", role: "viewer", expect: null });
  answered(fa.response);
  assert.deepEqual({ status: fa.status, json: fa.json }, { status: 400, json: { error: "not a valid recipient: slash/in@example.com" } }, "/folder-access");
  const team = await createTeam(owner.http, { name: `A1.5 team ${rand4()}`, ownerEmail: ownerAcct.email });
  precondition(team.teamId, `POST /team create returned no teamId: ${JSON.stringify(team.json)}`);
  const tm = await teamMembers(owner.http, team, { add: ["double..dot@example.com"], expect: null });
  answered(tm.response);
  assert.deepEqual({ status: tm.status, json: tm.json }, { status: 400, json: { error: "not a valid recipient: double..dot@example.com" } }, "/team-members");

  ctx.step("the valid address in the refused batch received nothing, held 10 s");
  await mailbox(target).expectMail({ to: valid, count: 0 });
}));

// --- A1.6 ---------------------------------------------------------------------

scenario("A1.6 Sign out: DELETE /session is 204 with Max-Age=0, and the private document's content is 200 before and 404 after", {
  tiers: ["local", "prod"],
  timeoutMs: 540_000,
}, budgeted(540_000, async (ctx) => {
  const setupBy = Date.now() + SETUP_MS;
  const [acct] = await cast(target, ["owner"]);
  const owner = await sessionFor(ctx, acct, "owner-http", setupBy);
  const up = await publish(owner.http, { fixture: "crdt-paragraphs.html", title: `A1.6 sign-out ${rand4()}`, name: "a16-signout", patient: { ctx, stopAt: setupBy } });
  const content = `/content/${encodeURIComponent(up.docId)}/${up.versionId}/`;

  ctx.step("over HTTP: content is 200 with the session; DELETE /session is 204 and clears __session; content is then 404");
  assert.equal(answered(await owner.http.get(content)).status, 200, "content with a session");
  const del = answered(await closeSession(owner));
  assert.equal(del.status, 204, "DELETE /session");
  const cleared = (del.setCookies ?? []).map(parseSetCookie).filter((c) => c.name === "__session");
  assert.equal(cleared.length, 1, `exactly one __session Set-Cookie: ${JSON.stringify((del.setCookies ?? []).length)}`);
  assert.deepEqual({ value: cleared[0].value, attrs: cleared[0].attrs }, { value: "", attrs: { "max-age": "0", path: "/", httponly: true, secure: true, samesite: "Strict" } }, "__session is cleared with Max-Age=0 and the same attributes");
  assert.equal(owner.http.jar.has("__session"), false, "the jar dropped __session");
  assert.equal(answered(await owner.http.get(content)).status, 404, "content after DELETE /session");

  ctx.step("in the browser: sign in, read the content from the page, press Sign out, read it again");
  const u = await ctx.users.user({ name: "owner" });
  await u.signInUi(acct.email, acct.password, { timeout: ANSWER_MS });
  // The page's own fetch, read back from the response log (so a Hosting cut-off is seen as one).
  const fetchStatus = async () => {
    const mark = u.responseMark();
    await u.page.evaluate(async (p) => (await fetch(p, { credentials: "same-origin", cache: "no-store" })).status, content);
    return answered(await u.waitForResponse(call("GET", content), { since: mark, timeout: ANSWER_MS })).status;
  };
  const before = await fetchStatus();
  ctx.step(`signed in: the page's fetch of the content answered ${before}`);
  assert.equal(before, 200, "the page reads the private content while signed in");
  await u.goto("/");
  const signOut = u.page.getByRole("button", { name: "Sign out", exact: true });
  await signOut.waitFor({ state: "visible", timeout: ANSWER_MS });
  const mark = u.responseMark();
  await signOut.click();
  const d = answered(await u.waitForResponse(call("DELETE", "/session"), { since: mark, timeout: ANSWER_MS }));
  assert.equal(d.status, 204, "the app's DELETE /session");
  const c = await sessionSetCookie(d);
  precondition(c, "the browser's DELETE /session response carried no readable __session Set-Cookie");
  assert.equal(c.attrs["max-age"], "0", "Max-Age=0");
  ctx.step(`Sign out: DELETE /session ${d.status}, Set-Cookie attributes ${JSON.stringify(c.attrs)}`);
  await eventually(async () => (await u.sessionCookie()) === null, { timeout: 10_000, message: "Chrome dropped __session" });
  const afterOut = await fetchStatus();
  ctx.step(`signed out: the page's fetch of the content answered ${afterOut}`);
  assert.equal(afterOut, 404, "the private content after Sign out");
  noPageErrors([u]);
}));

// --- A1.7 ---------------------------------------------------------------------

/** `next` values that must not leave this origin (app/src/next.ts names the forms). */
const HOSTILE_NEXT = Object.freeze([
  "https://evil.example/",
  "//evil.example",
  "/\\evil.example",
  "\\\\evil.example",
  "/\t/evil.example",
  "https:evil.example",
]);

/** What a signed-in visit to /signup asks the stack: the Auth emulator's account and token calls, and POST /session. */
const SIGN_IN_CALLS = [/^\/session$/, /^\/identitytoolkit\.googleapis\.com\//, /^\/securetoken\.googleapis\.com\//];

/**
 * Where the page settles: the URL once it has held still for three samples
 * and the app has rendered something other than the sign-in form. A page that
 * never gets there (a crash, a blocked navigation) settles where it stopped:
 * the URL is what the oracle compares, so a stuck page is a wrong landing, not
 * a timeout.
 *
 * Stuck means still on the sign-in page `timeout` after the call (moving off
 * it is the app's own, client-side step). A page that has moved off it may
 * take ANSWER_MS more to render what it loads from the server.
 *
 * `calls` (a User.capture of SIGN_IN_CALLS started before a signed-in visit
 * to /signup): first wait for the page's own POST /session to be answered,
 * since only then does the app act on `next`, and that answer is the server's
 * time, not the page's. One that stays unanswered for ANSWER_MS, or any
 * sign-in call still unanswered then (the Auth emulator's token lookups), is
 * the stack not answering: that throws an error whose `stackCut` names them
 * (lib/test.mjs reads it as the stack's), and Hosting's 504 at its cut-off
 * throws answered()'s E2E_STACK_CUTOFF. A page that never posts /session
 * still settles.
 */
async function settledUrl(u, { timeout = 20_000, calls = null } = {}) {
  if (calls !== null) {
    const isSession = (r) => r.method === "POST" && r.path === "/session";
    const done = await u.poll(() => calls.find((r) => isSession(r) && r.state !== "sent") ?? null, { timeout: ANSWER_MS, interval: 100, what: "POST /session answered" }).catch(() => null);
    calls.stop();
    if (done) answered(done, `${u.name}: the page's POST /session`);
    const waiting = calls.filter((r) => r.state === "sent");
    if (!done && waiting.length > 0) {
      const err = new Error(`${u.name}: the page's ${waiting.map((r) => `${r.method} ${r.path}`).join(", ")} got no answer in ${ANSWER_MS} ms`);
      err.stackCut = err.message;
      throw err;
    }
  }
  const started = Date.now();
  const onSignIn = (url) => {
    try {
      const p = new URL(url);
      return p.origin === u.target.origin && p.pathname.toLowerCase() === "/signup";
    } catch {
      return false;
    }
  };
  const sample = async () => {
    const url = u.page.url();
    const rendered = await u.page
      .evaluate(() => !!document.querySelector(".app-shell main, .app-shell .landing, .app-shell .viewer-body, .app-shell .doc-grid, .app-shell .empty-state") && !document.querySelector("#auth-password") && !document.querySelector(".app-shell .spinner"))
      .catch(() => false);
    return { url, rendered };
  };
  const stuck = (url) => `${url} (never rendered past sign-in)`;
  try {
    const out = await eventually(async () => {
      const s = await sample();
      if (onSignIn(s.url) && Date.now() - started > timeout) return { stuck: s.url };
      if (!s.rendered && s.url.startsWith(u.target.origin)) throw new Error(`not rendered at ${s.url}`);
      return s.url;
    }, { timeout: timeout + ANSWER_MS, interval: 300, stableSamples: 3, message: "the page settled" });
    return typeof out === "string" ? out : stuck(out.stuck);
  } catch (err) {
    if (err.code !== "E2E_EVENTUALLY_TIMEOUT") throw err;
    return stuck((await sample()).url);
  }
}

/** Every request this browser made, or had blocked, to an evil.example host (by hostname, not by query string). */
function touchedEvil(u) {
  const all = [...u.log.requests.map((r) => r.url), ...u.log.external.map((r) => r.url), ...u.log.websockets.map((r) => r.url)];
  return all.filter((url) => {
    try {
      return /(^|\.)evil\.example$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  });
}

scenario("A1.7 next= is honoured only as a path on this origin: https://evil.example/, //evil.example and the other hostile forms land on /, a same-origin path lands there", {
  tiers: ["local", "prod"],
  timeoutMs: 600_000,
}, budgeted(600_000, async (ctx) => {
  const setupBy = Date.now() + SETUP_MS;
  const [a, b, c] = await cast(target, ["nexta", "nextb", "nextc"]);
  const home = `${target.origin}/`;
  const ua = await ctx.users.user({ name: "next-abs" });
  const ub = await ctx.users.user({ name: "next-proto" });
  const uc = await ctx.users.user({ name: "next-path" });

  // Three browsers, each its own account, run side by side: a fresh sign-in
  // with a hostile next, then, signed in, half of the hostile values each; and
  // the positive. The chains share nothing, so the order between them is moot.
  const hostile = async (u, acct, first, revisits) => {
    ctx.step(`${u.name}: sign in at /signup?next=${first} in a fresh browser: lands on /`);
    await u.signInUi(acct.email, acct.password, { path: `/signup?next=${encodeURIComponent(first)}`, timeout: ANSWER_MS });
    assert.equal(await settledUrl(u), home, `next=${first} landed on /`);
    for (const raw of revisits) {
      ctx.step(`${u.name}: signed in, open /signup?next=${JSON.stringify(raw)}: lands on /`);
      const calls = u.capture({ paths: SIGN_IN_CALLS, method: null, responseJson: false });
      await u.goto(`/signup?next=${encodeURIComponent(raw)}`);
      assert.equal(await settledUrl(u, { calls }), home, `next=${JSON.stringify(raw)} landed on /`);
    }
  };
  const positive = async () => {
    const ownerC = await sessionFor(ctx, c, "nextc", setupBy);
    const up = await publish(ownerC.http, { fixture: "crdt-paragraphs.html", title: `A1.7 next ${rand4()}`, name: "a17-next", patient: { ctx, stopAt: setupBy } });
    ctx.step(`${uc.name}: positive: sign in at /signup?next=/d/${up.docId} in a fresh browser: lands on that document`);
    await uc.signInUi(c.email, c.password, { path: `/signup?next=${encodeURIComponent(`/d/${up.docId}`)}`, timeout: ANSWER_MS });
    const landed = new URL(await settledUrl(uc));
    assert.equal(landed.origin, target.origin, "stayed on this origin");
    assert.match(landed.pathname, new RegExp(`^/d/${up.docId}(/v1)?$`), `a same-origin next is honoured (landed on ${landed.pathname})`);
  };
  const half = Math.ceil(HOSTILE_NEXT.length / 2);
  const chains = await Promise.allSettled([
    hostile(ua, a, "https://evil.example/", HOSTILE_NEXT.slice(0, half)),
    hostile(ub, b, "//evil.example", HOSTILE_NEXT.slice(half)),
    positive(),
  ]);
  // An oracle's failure outranks a stall in another chain.
  const failures = chains.filter((r) => r.status === "rejected").map((r) => r.reason);
  if (failures.length > 0) throw failures.find((e) => e?.code === "ERR_ASSERTION") ?? failures[0];

  ctx.step("no browser ever requested evil.example");
  for (const u of [ua, ub, uc]) assert.deepEqual(touchedEvil(u), [], `${u.name} requested evil.example`);
  noPageErrors([ua, ub, uc]);
}));

// --- A1.8 ---------------------------------------------------------------------

/**
 * Init script: from the first document on, every time an `.empty-state` panel,
 * a loading skeleton or a real document card is inserted at `/`. React mounts a render's subtree
 * in one insertion, so an added node that is or holds the selector is one
 * render showing it.
 */
function workspaceObserver() {
  if (window.top !== window) return;
  const seen = (window.__a01Seen = { empty: [], states: [], skeletons: 0, cards: [] });
  const scan = (node) => {
    if (node.nodeType !== 1 || location.pathname !== "/") return;
    const hit = (sel) => node.matches(sel) || node.querySelector(sel);
    // A waiting panel (Loading) shares the class but holds a spinner; the
    // workspace's own empty state is the one without.
    for (const el of [node, ...node.querySelectorAll(".empty-state")]) {
      if (!el.matches(".empty-state")) continue;
      seen.states.push({ t: Date.now(), waiting: !!el.querySelector(".spinner"), text: el.textContent.trim().slice(0, 120) });
      if (!el.querySelector(".spinner")) seen.empty.push({ t: Date.now(), text: el.textContent.trim().slice(0, 120) });
    }
    // The loading skeletons are `.doc-card`s too; a real card has a title link.
    if (hit(".skeleton")) seen.skeletons += 1;
    if (hit(".doc-card-title")) seen.cards.push({ t: Date.now(), titles: Array.from(document.querySelectorAll(".doc-card .doc-card-title"), (e) => e.textContent.trim()) });
  };
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) scan(n);
  }).observe(document, { childList: true, subtree: true });
}

/** The Firestore SDK's own words when its backend has not answered in 10 s and it goes offline. */
const SDK_OFFLINE = /Could not reach Cloud Firestore backend/;

/**
 * The page's "went offline" console line from 15 s before `t` to 2 s after
 * it, or null. Offline, the SDK raises a listener's first snapshot from its
 * cache even when that is empty (app/node_modules/@firebase/firestore/dist/
 * index.esm2017.js, QueryListener: "Raise data from cache if we have any
 * documents, have cached results before, or we are offline"), right after it
 * logs this line, so an empty state rendered at `t` came from that.
 */
function offlineNear(u, t) {
  return u.log.console.find((c) => SDK_OFFLINE.test(c.text ?? "") && c.t >= t - 15_000 && c.t <= t + 2_000) ?? null;
}

scenario("A1.8 a document shared before sign-up is listed on the workspace's first render: the empty state never appears", {
  tiers: ["local"],
  effects: ["email:POST /access", "email:POST /verify/start"],
  needs: ["email", "mailpit", "admin-emulator"],
  timeoutMs: 600_000,
}, budgeted(600_000, async (ctx) => {
  const setupBy = Date.now() + SETUP_MS;
  const [ownerAcct] = await cast(target, ["owner"]);
  const owner = await sessionFor(ctx, ownerAcct, "owner", setupBy);
  const title = `A1.8 shared before sign-up ${runTag(target.runId)}-${rand4()}`;
  const up = await publish(owner.http, { fixture: "crdt-paragraphs.html", title, name: "a18-before", patient: { ctx, stopAt: setupBy } });
  const invitee = localEmail(target, "invitee");

  ctx.step(`the owner shares with ${invitee}, who has no account yet`);
  const granted = await share(target, { owner, doc: up.docId, account: invitee, role: "viewer" });
  assert.ok(granted.members?.includes(invitee), `members: ${JSON.stringify(granted.members)}`);
  const box = mailbox(target);
  await box.expectMail({ to: invitee, subject: `${ownerAcct.email} shared “${title}” with you`, count: 1 });

  ctx.step("the invitee's account is created (accounts:signUp), and they sign in at /signup and verify the address, watched from the first document on");
  const acct = await castUnverified(target, "invitee", { email: invitee, http: httpFor(ctx, "harness") });
  const u = await ctx.users.user({ name: "invitee" });
  await u.page.addInitScript(workspaceObserver);
  const first = await u.signInUi(invitee, acct.password, { expectStatus: "unverified", timeout: ANSWER_MS });
  assert.deepEqual({ body: first.body, gate: first.gate }, { body: { status: "unverified" }, gate: "needs_verification" }, "an unverified account, at the verification step");
  const start = await sendCodeUi(u);
  assert.deepEqual(start, { status: 200, body: { sent: true, email: invitee } }, "POST /verify/start");
  const codes = await box.expectMail({ to: invitee, subject: CODE_SUBJECT, count: 1 });
  const done = await confirmCodeUi(u, codeOf(codes.messages[0].Subject));
  assert.deepEqual({ complete: done.complete.body, session: done.session.body }, { complete: { verified: true, email: invitee }, session: { status: "ok" } }, "verified, then signed in");

  ctx.step("the workspace at / lists the shared document, and its empty state was never rendered");
  await u.poll(() => new URL(u.page.url()).pathname === "/", { timeout: ANSWER_MS, what: "landing on /" });
  await u.page.locator(".doc-card .doc-card-title", { hasText: title }).waitFor({ state: "visible", timeout: ANSWER_MS });
  const seen = await u.page.evaluate(() => window.__a01Seen);
  precondition(seen, "the workspace observer was not installed");
  ctx.ev.json("workspace-renders", seen);
  // An empty state the page's Firestore client raised from its offline cache,
  // because this stack took over 10 s to answer its first Listen, is the path
  // A1.8b holds on purpose (X-a01-identity-3): here it measured nothing.
  const offline = seen.empty.length > 0 ? offlineNear(u, seen.empty[0].t) : null;
  if (offline) {
    ctx.inconclusive(`the page's Firestore client went offline ("${offline.text.split("\n")[0].slice(0, 140)}") as the empty state rendered (${seen.empty[0].t - offline.t} ms apart), so the stack, not the workspace, was slow to list the document (A1.8b measures that path)`);
  }
  assert.deepEqual(seen.empty, [], "the workspace showed its empty state before listing the shared document");
  assert.deepEqual(seen.cards[0]?.titles, [title], "the first render with a card lists exactly the shared document");
  const errors = u.log.toasts.filter((t) => t.kind === "error");
  assert.deepEqual(errors.map((t) => t.text), [], "no error toast");
  noPageErrors([u]);
}));

/** How long A1.8b holds the page's Firestore Listen requests: past the SDK's 10 s, so it goes offline first. */
const LISTEN_HOLD_MS = 15_000;

/**
 * Hold every POST of the page's Firestore Listen channel (FIRESTORE_LISTEN_PATH,
 * on the stack's Firestore origin) until `ms` after the first one arrived, then
 * let each go on (User.delayRequests: route.fallback(), through the isolation
 * tripwire, to the stack). Nothing is failed or answered here: the page only
 * sees a backend that is slow to answer. Resolves delayRequests' handle.
 */
async function holdListen(u, ms) {
  let until = null;
  const untilDeadline = () => {
    until ??= Date.now() + ms;
    return new Promise((r) => setTimeout(r, Math.max(0, until - Date.now())));
  };
  // A rule per request: one page has been seen to send a single Listen POST in
  // the hold; any past these go at once, by then long after the deadline.
  return u.delayRequests(FIRESTORE_LISTEN_PATH, { at: "firestore", rules: Array.from({ length: 64 }, () => untilDeadline) });
}

/** Each A1.8b case's Listen hold, for afterHold to read once its body has failed. */
const holds = new WeakMap();
/** After the hold lets the channel go, how long the SDK may still report the loss the hold caused. */
const HOLD_AFTERMATH_MS = 5_000;

// LIB-REQUEST: pagestall-own-hold — pageStall reads every Firestore loss of a
// page as the stack's, including the one a case causes with delayRequests(…,
// {at: "firestore"}). Proposed: pageStall(err, ctx, {ignoreLost: [{from, to}]}),
// or delayRequests' handle marking its rows' window for pageStall to skip.
/**
 * A1.8b's judge of a wait that ran out (lib/test.mjs pageStall), on what the
 * case's pages saw of the stack stalling, LESS the loss the case caused
 * itself: the SDK going offline while the hold kept its Listen channel, and
 * its network tests then, up to HOLD_AFTERMATH_MS after the last held request
 * went on, are not the stack's. Every Hosting cut-off 504 still counts. While a
 * request is still held, no loss counts.
 */
function afterHold(err, ctx) {
  const rows = holds.get(ctx)?.rows ?? [];
  const released = rows.map((r) => (r.releasedAt == null ? Infinity : r.t + (r.releasedAt - r.heldAt)));
  const since = rows.length === 0 ? -Infinity : Math.max(...released) + HOLD_AFTERMATH_MS;
  const users = ctx.usersSoFar.map((u) => ({
    name: u.name,
    responses: u.responses,
    log: { requests: u.log.requests, console: u.log.console.filter((c) => c.t > since), sdkProbes: (u.log.sdkProbes ?? []).filter((p) => p.t > since) },
  }));
  return pageStall(err, { usersSoFar: users });
}

async function slowWorkspaceInitialListen(ctx, ownerOnly) {
  const setupBy = Date.now() + SETUP_MS;
  const [ownerAcct, inviteeAcct] = await cast(target, ownerOnly ? ["owner"] : ["owner", "invitee"]);
  const owner = await sessionFor(ctx, ownerAcct, "owner", setupBy);
  const title = `${ownerOnly ? "A1.8c owned" : "A1.8b shared"} before sign-in ${runTag(target.runId)}-${rand4()}`;
  const up = await publish(owner.http, { fixture: "crdt-paragraphs.html", title, name: "a18b-slow", patient: { ctx, stopAt: setupBy } });
  if (!ownerOnly) {
    ctx.step(`the owner shares with ${inviteeAcct.email}, who has never signed in`);
    const granted = await share(target, { owner, doc: up.docId, account: inviteeAcct, role: "viewer" });
    precondition(granted.members?.includes(inviteeAcct.email), `members: ${JSON.stringify(granted.members)}`);
  }

  const who = ownerOnly ? "owner" : "invitee", account = ownerOnly ? ownerAcct : inviteeAcct;
  ctx.step(`the ${who} signs in while every Firestore Listen request is held ${LISTEN_HOLD_MS} ms (a backend slower than the SDK's 10 s), watched from the first document on`);
  const u = await ctx.users.user({ name: who });
  await u.page.addInitScript(workspaceObserver);
  const hold = await holdListen(u, LISTEN_HOLD_MS);
  holds.set(ctx, hold);
  try {
    await u.signInUi(account.email, account.password, { timeout: ANSWER_MS });
    await u.page.locator(".doc-card .doc-card-title", { hasText: title }).waitFor({ state: "visible", timeout: ANSWER_MS });
  } finally {
    await hold.restore();
  }
  const seen = await u.page.evaluate(() => window.__a01Seen);
  precondition(seen, "the workspace observer was not installed");
  // Times only: a row's url and body carry the channel's session and the account's token.
  const held = hold.rows.map((r) => ({ t: r.t, heldMs: r.releasedAt == null ? null : Math.round(r.releasedAt - r.heldAt), released: r.released }));
  precondition(held.length > 0, "no Firestore Listen request was held: the page never listened");
  const offline = u.log.console.find((c) => SDK_OFFLINE.test(c.text ?? "") && c.t >= held[0].t);
  ctx.ev.json("workspace-renders", { seen, held, offlineAt: offline?.t ?? null });
  if (!offline) ctx.inconclusive(`holding the Listen channel ${LISTEN_HOLD_MS} ms did not take the page's Firestore client offline: the path under test never ran`);
  ctx.step(`${held.length} Listen POST(s) held (${JSON.stringify(held.map((h) => h.heldMs))} ms); the SDK went offline ${offline.t - held[0].t} ms after the first; empty states at ${JSON.stringify(seen.empty.map((e) => e.t - offline.t))} ms and the first card at ${seen.cards[0] ? seen.cards[0].t - offline.t : null} ms from then`);
  await ctx.oracle(() => assert.deepEqual(seen.empty, [], ownerOnly
    ? "the workspace told its owner \"Nothing here yet\" from its offline cache before listing their existing document"
    : "the workspace told the invitee \"Nothing here yet\" from its offline cache before listing the document shared with them"));
}

scenario("A1.8b a document shared before sign-in is listed even when the backend takes over 10 s to answer the workspace's first listen: the empty state never appears", {
  tiers: ["local"], effects: ["email:POST /access"], timeoutMs: 600_000,
}, budgeted(600_000, (ctx) => slowWorkspaceInitialListen(ctx, false), { pages: afterHold }));

scenario("A1.8c an owner's existing document is listed after a delayed first workspace listen, without a false empty state from the offline cache", {
  tiers: ["local"], timeoutMs: 600_000,
}, budgeted(600_000, (ctx) => slowWorkspaceInitialListen(ctx, true), { pages: afterHold }));

// --- A1.9 ---------------------------------------------------------------------

/** The frame headers of one response: {status, xfo, ancestors}. */
function frameHeaders(r) {
  const csp = r.headers.get("content-security-policy") ?? "";
  return { status: r.status, xfo: r.headers.get("x-frame-options"), ancestors: csp.split(";").map((d) => d.trim()).find((d) => /^frame-ancestors\b/i.test(d)) ?? null };
}

scenario("A1.9 /connect and /signup send X-Frame-Options: DENY and Content-Security-Policy frame-ancestors 'none'", {
  tiers: ["local", "prod"],
  timeoutMs: 60_000,
}, budgeted(60_000, async (ctx) => {
  const http = httpFor(ctx, "anonymous");
  const paths = [
    "/connect",
    "/connect?response_type=code&client_id=e2e-a19&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb&state=s&code_challenge=x&code_challenge_method=S256",
    "/signup",
    `/signup?next=${encodeURIComponent("/connect?client_id=e2e-a19")}`,
  ];
  const bad = [];
  for (const p of paths) {
    const h = frameHeaders(answered(await http.get(p)));
    ctx.step(`${p}: ${h.status} X-Frame-Options=${h.xfo} frame-ancestors=${h.ancestors}`);
    if (h.status !== 200 || h.xfo !== "DENY" || h.ancestors !== "frame-ancestors 'none'") bad.push({ path: p, ...h });
  }
  assert.deepEqual(bad, [], `every /connect and /signup response is 200 with X-Frame-Options: DENY and frame-ancestors 'none'; these are not: ${bad.map((b) => `${b.path} ${b.status} X-Frame-Options=${b.xfo} frame-ancestors=${b.ancestors}`).join("; ")}`);
}));

/** Is a frame of `url`, made by a page on another origin, showing the sign-in form? */
async function framedShowsSignIn(u, framerOrigin, url) {
  await u.page.goto(`${framerOrigin}/?src=${encodeURIComponent(url)}`, { waitUntil: "load" });
  const iframe = u.page.locator("iframe#framed");
  await iframe.waitFor({ state: "attached", timeout: 10_000 });
  // Either the app renders its form in the frame, or Chrome blocks the load and
  // the frame holds its error page. Wait for one of the two, then read which.
  return eventually(async () => {
    const f = await (await iframe.elementHandle())?.contentFrame();
    if (!f) throw new Error("no frame yet");
    const fu = f.url();
    if (fu.startsWith("chrome-error:")) return { url: fu, signIn: false };
    if (!fu.startsWith(target.origin)) throw new Error(`frame at ${fu}`);
    if (await f.locator("#auth-password").isVisible().catch(() => false)) return { url: fu, signIn: true };
    throw new Error(`frame at ${fu}, no form yet`);
  }, { timeout: 15_000, interval: 200, message: `the framed ${url} settled` });
}

/** Alternate and protected routes that render sign-in at the requested path. */
const FRAME_VARIANTS = Object.freeze(["/SIGNUP", "/Signup", "/CONNECT", "/Connect", "/signup/", "/CONNECT/", "/%73ignup", "/account", "/folder/e2e-framing"]);

/** Did each variant, in an anonymous browser, show the sign-in form at its own path? Throws a precondition when one did not: the case's premise. */
async function variantsRenderSignIn(ctx, u) {
  ctx.step("each alternate or protected route renders sign-in at its own path");
  for (const p of FRAME_VARIANTS) {
    await u.goto(p);
    await u.page.locator("#auth-password").waitFor({ state: "visible", timeout: 15_000 });
    precondition(new URL(u.page.url()).pathname === p, `${p} did not stay at ${p} (${u.page.url()})`);
  }
}

/** Both frame headers, as A1.9 wants them. */
const framesDenied = (h) => h.xfo === "DENY" && h.ancestors === "frame-ancestors 'none'";

scenario("A1.9b case variants of /signup and /connect (/SIGNUP, /Signup, /CONNECT, /Connect) render the sign-in page, so a GET of each is answered with X-Frame-Options: DENY and frame-ancestors 'none' too", {
  tiers: ["local", "prod"],
  timeoutMs: 120_000,
}, budgeted(120_000, async (ctx) => {
  const http = httpFor(ctx, "anonymous");

  // The baseline: A1.9's own oracle on the two canonical paths. When it does
  // not hold, A1.9 fails, and a variant has nothing to be compared with.
  ctx.step("GET /signup and /connect, anonymous: both are 200 with both frame headers (the baseline)");
  const canonical = {};
  for (const p of ["/signup", "/connect"]) {
    const r = answered(await http.get(p));
    canonical[p] = { ...frameHeaders(r), text: r.text };
    precondition(canonical[p].status === 200 && framesDenied(canonical[p]), `${p} itself is ${canonical[p].status} X-Frame-Options=${canonical[p].xfo} frame-ancestors=${canonical[p].ancestors}: A1.9 fails, so the variants have no baseline`);
  }

  const u = await ctx.users.user({ name: "anonymous" });
  await variantsRenderSignIn(ctx, u);

  ctx.step("GET each variant over HTTP, anonymous, no cookie: its status, its frame headers, and whether its body is /signup's app shell");
  const headers = {};
  for (const p of FRAME_VARIANTS) {
    const r = answered(await http.get(p));
    headers[p] = { ...frameHeaders(r), shell: r.text === canonical["/signup"].text };
  }
  ctx.ev.json("variant-headers", headers);
  ctx.step(`variants: ${JSON.stringify(headers)}`);
  const exposed = FRAME_VARIANTS.filter((p) => !framesDenied(headers[p]));
  assert.deepEqual(exposed, [], `variant paths that render the sign-in page but are answered without the frame headers: ${exposed.map((p) => `${p} ${headers[p].status} X-Frame-Options=${headers[p].xfo} frame-ancestors=${headers[p].ancestors}${headers[p].shell ? " (/signup's app shell)" : ""}`).join("; ")}`);
}));

scenario("A1.9c a page on another origin cannot frame the sign-in page at /SIGNUP, /Signup, /CONNECT or /Connect, as it cannot frame /signup itself", {
  tiers: ["local"],
  needs: ["spare-pool"],
  timeoutMs: 120_000,
}, budgeted(120_000, async (ctx) => {
  const u = await ctx.users.user({ name: "anonymous" });
  await variantsRenderSignIn(ctx, u);

  ctx.step("a page on another origin (a stack spare port) frames /signup and each variant");
  const claim = await claimSparePort(target, { purpose: "a01-framer" });
  const server = createServer((req, res) => {
    const src = new URL(req.url, "http://framer.invalid").searchParams.get("src") ?? "";
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><meta charset="utf-8"><title>framer</title><iframe id="framed" src="${src.replace(/"/g, "&quot;")}" width="800" height="600"></iframe>`);
  });
  const framed = {};
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(claim.port, "127.0.0.1", resolve));
    const framer = `http://127.0.0.1:${claim.port}`;
    const canonical = await framedShowsSignIn(u, framer, `${target.origin}/signup`);
    precondition(canonical.signIn === false, `the framing check is blind: another origin framed /signup itself (${JSON.stringify(canonical)})`);
    for (const p of FRAME_VARIANTS) framed[p] = (await framedShowsSignIn(u, framer, `${target.origin}${p}`)).signIn;
  } finally {
    await new Promise((r) => server.close(r));
    claim.release();
  }

  ctx.ev.json("variants-framed", framed);
  ctx.step(`framed by another origin with the sign-in form showing: ${JSON.stringify(framed)}`);
  const exposed = FRAME_VARIANTS.filter((p) => framed[p]);
  assert.deepEqual(exposed, [], `variant paths another origin framed with the sign-in form showing, though it could not frame /signup: ${exposed.join(", ")}`);
}));

scenario("A1.9d every app-shell entry path denies framing before client navigation, while content byte routes remain embeddable", {
  tiers: ["local", "prod"], timeoutMs: 60_000,
}, budgeted(60_000, async (ctx) => {
  const http = httpFor(ctx, "anonymous");
  const paths = ["/", "/index.html", "/terms", "/privacy", "/e2e-unknown-shell", "/content", "/%73ignup", "/SIGNUP/", "/account", "/folder/e2e-framing"];
  const exposed = [];
  for (const path of paths) {
    const response = answered(await http.get(path));
    const h = frameHeaders(response);
    if (h.status !== 200 || !framesDenied(h)) exposed.push({ path, ...h });
  }
  assert.deepEqual(exposed, [], `app-shell paths missing frame protection: ${JSON.stringify(exposed)}`);
  // These are absent documents, so no protected bytes need to be fetched to
  // prove the Hosting rule leaves the application's iframe routes alone.
  for (const prefix of ["content", "draft", "thumb"]) {
    const h = frameHeaders(answered(await http.get(`/${prefix}/e2e-absent-framing/v1/index.html`)));
    assert.equal(h.xfo, null, `${prefix} remains embeddable`);
    assert.equal(h.ancestors, null, `${prefix} remains embeddable`);
  }
}));
