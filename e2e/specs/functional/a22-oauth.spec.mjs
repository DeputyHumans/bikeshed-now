// SPDX-License-Identifier: Apache-2.0
// Connecting an app by signing in: discovery, registration, consent, tokens, rotation, revocation, the CLI's client and the agent-facing pages (SPEC §23).

/**
 * Catalogue A22, one scenario per case:
 *
 *   A22.1  discovery: both protected-resource documents name the issuer byte
 *          for byte as their only authorization server and this host's /mcp,
 *          private, no-store; the authorization-server metadata is public,
 *          max-age=300 and advertises S256, auth none, CIMD and iss, with no
 *          scopes; openid-configuration is a JSON 404; the /mcp 401 points at
 *          the protected-resource document
 *   A22.2  the whole browser flow: DCR → /connect opened signed out (query
 *          captured, stripped, kept ten minutes, surviving the sign-in) → the
 *          card says where it sends you and that the name is the app's own
 *          claim → Approve arms only after a second of focus AND a pointer or
 *          key event → the redirect carries code, state and iss → a one-hour
 *          bsa_ and a bsr_; bsa_ sees the 33 tools at /mcp and nothing else.
 *          Cancel sends access_denied with state and iss
 *   A22.2b real tab focus loss disarms the consent card; returning focus
 *          requires a fresh second before approval can arm again
 *   A22.3  refresh rotates both secrets; a replay of the spent bsr_, or of
 *          the code, within 60 s gets the identical pair; a wrong secret for
 *          a known grant changes nothing; a replay after 60 s revokes the
 *          grant (time-based: the case waits out the product's 60 s window)
 *   A22.4  every token-endpoint check runs before the code is spent; hostile
 *          redirect URIs are refused at registration and in a hand-built id;
 *          a loopback redirect matches any port; localhost is not 127.0.0.1;
 *          an https redirect matches exactly; PKCE is S256 only, and a
 *          failure after the redirect is established carries `back` with iss
 *   A22.5  POST /oauth/consent: only the ID token, only from this origin's
 *          own page — HTTP matrix and a real cross-site browser page
 *   A22.6  the account screen lists a connected app and its Revoke ends it
 *          (/mcp 401 invalid_token, refresh refused); the CLI's built-in
 *          client goes through the same consent page and gets a cli bsk_
 *          named for its device, with no refresh token, usable beyond /mcp
 *   A22.7  /llms.txt, /skills/index.json, /.well-known/mcp.json, the /docs
 *          redirects and the legal pages
 *   A22.8  authorization, access and refresh resource/client binding; refused
 *          attempts preserve the original usable grant
 *
 * No client_id here is a metadata-document URL: the one outbound fetch the
 * product makes would be refused by the stack's egress guard, which says
 * nothing about the product. Every redirect a browser follows goes to a
 * lib/oauth.mjs receiver given the page that follows it: locally a socket on
 * a claimed spare port of the stack, except A22.2's Cancel, which takes the
 * route receiver (answered inside the browser) so the path production uses
 * runs here too; on production every one is a route.
 *
 * When the stack does not answer, nothing was measured. Every case declares
 * inconclusiveOnCaseTimeout (lib/test.mjs), which also classifies page stalls, its clients throw for Hosting's
 * cut-off 504 (cutoffError), and a response a case reads itself goes through
 * answered(). A redirect that never comes because the consent page's own POST
 * /oauth/consent got that 504 is the receiver's timeout carrying it as
 * `response` (lib/oauth.mjs startReceiver with a `page`), so it ends
 * INCONCLUSIVE too; a quicker 4xx or 5xx there is the product's answer, and
 * the same timeout names it and FAILS.
 *
 * Only e2e/lib/ talks to the stack.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answered, currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { idToken, listTokens, mintToken, openSession, bearerHttp } from "../../lib/session.mjs";
import { approveViaApi, armingProbe, authorizeParams, consent, discover, realPageFocus, exchangeCode, pkce, readArming, refresh, register, startReceiver } from "../../lib/oauth.mjs";
import { openCrossSitePage } from "../../lib/browser.mjs";
import { adminFor, closeAdmin, readDoc } from "../../lib/admin.mjs";
import { assertHeaderMatrix, eventually } from "../../lib/assert.mjs";
import { appendLedger } from "../../lib/ledger.mjs";
import { publish } from "../../lib/seed.mjs";
import { REPO_ROOT } from "../../lib/paths.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const BOTH = ["local", "prod"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = () => `${runTag(target.runId)}-${rand4()}`;
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** The issuer and the resource on this target: in the emulator the request's own origin, in production the configured one (SPEC §23 "Discovery"). */
const ISSUER = () => target.origin;
const RESOURCE = () => `${target.origin}/mcp`;
const PRM_URL = () => `${target.origin}/.well-known/oauth-protected-resource/mcp`;
/** A loopback redirect registered with no port: matches any port it is presented with (RFC 8252, SPEC §23). */
const LOOPBACK_CB = "http://127.0.0.1/callback";
/** The product's words (functions/src/oauth/*.ts, app/src/pages/Connect.tsx). */
const MSG = Object.freeze({
  notOurPage: "This request has to come from Bikeshed's own page.",
  signIn: "Sign in to continue.",
  json: "Expected a JSON body.",
  redirectRefused: "each redirect_uri must be https, http on a loopback address, or an app's own scheme",
  unregistered: "This app asked to send you back to an address it never registered, so we stopped here.",
  whoIsAsking: "We couldn't confirm which app is asking. Try connecting again from the app.",
  pkceRequired: "PKCE with S256 is required",
  disconnected: "this connection was disconnected",
  replayedRefresh: "refresh token was already used; the connection has been disconnected",
  replayedCode: "authorization code was already used; what it issued has been revoked",
  notRecognised: "refresh token not recognised",
  unchecked: "chosen by the app, not checked",
});
const ACCESS_RE = /^bsa_([0-9a-f]{32})\.[A-Za-z0-9_-]{43}$/;
const REFRESH_RE = /^bsr_([0-9a-f]{32})\.[A-Za-z0-9_-]{43}$/;
const PERSONAL_RE = /^bsk_([0-9a-f]{32})\.[A-Za-z0-9_-]{20,64}$/;
/** SPEC §19 "Skills": three of them, one per job. */
const SPEC_SKILLS = ["bikeshed-feedback", "bikeshed-folders", "bikeshed-permissions", "bikeshed-publishing"];
/** tools/stamp-deployment.mjs TOKEN: the placeholder the build replaces with the deployment's origin. */
const STAMP_TOKEN = "https://<deployment>";
/**
 * How long a browser wait that rides on a function round trip may take (the
 * consent page's describe and decide, POST /session, POST /tokens). Not an
 * oracle: on the shared stack under load one execution has taken 30 s
 * (manageTokens, 2026-10-11), which a 20 s wait turned into a false failure.
 */
const ROUND_TRIP_MS = 90_000;
/** The REPLAY_GRACE_MS of functions/src/oauth/grants.ts, plus a margin for the two clocks' requests. */
const PAST_REPLAY_WINDOW_MS = 61_500;

function noPageErrors(users) {
  for (const u of users) assert.deepEqual(u.log.errors.map((e) => e.message), [], `${u.name}: uncaught page errors`);
}

/** The tree the stack was built from (this checkout for a target with none). */
function treeFile(rel) {
  return readFileSync(join(target.stack?.treeDir ?? REPO_ROOT, rel));
}

/** An owner with notifications and analytics off, and a session. */
async function owner(role = "owner") {
  const [acct] = await cast(target, [role], { notifications: false, analytics: false });
  const session = await openSession(target, acct, { cutoffError: true });
  return { acct, session };
}

/** Register a client and insist on the bsdcr_ shape; returns the registration. */
async function client(http, redirectUris, clientName = `E2E A22 app ${tag()}`) {
  const reg = await register(http, { redirectUris, clientName });
  precondition(reg.status === 201 && /^bsdcr_[A-Za-z0-9_-]+$/.test(reg.clientId ?? ""), `POST /oauth/register answered ${reg.status} ${JSON.stringify(reg.json)}`);
  return reg;
}

/** Approve through the API and exchange; returns the pair and its grant id, ledgered. */
async function connectViaApi(http, session, { clientId, redirectUri, resource }) {
  const p = pkce();
  const params = authorizeParams({ clientId, redirectUri, challenge: p.challenge, resource });
  const approved = await approveViaApi(http, session.idToken, params);
  precondition(approved.status === 200 && approved.code, `approve: ${approved.status} ${JSON.stringify(approved.json)}`);
  const x = await exchangeCode(http, { code: approved.code, verifier: p.verifier, clientId, redirectUri });
  precondition(x.status === 200 && ACCESS_RE.test(x.json?.access_token ?? ""), `exchange: ${x.status} ${JSON.stringify(x.json)}`);
  const tokenId = ACCESS_RE.exec(x.json.access_token)[1];
  appendLedger(target, { kind: "oauth", tokenId, uid: session.uid, clientId });
  return { pair: x.json, tokenId, code: approved.code, verifier: p.verifier, params, approved };
}

/** POST /mcp initialize with a bearer: {status, challenge, cacheControl}. */
async function mcpInit(ctx, token, actor) {
  const m = ctx.mcp({ token, actor, cutoffError: true });
  const r = await m.raw({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bikeshed-e2e", version: "1" } } });
  answered(r.response, `POST /mcp initialize (${actor})`);
  return { status: r.status, challenge: r.headers.get("www-authenticate"), cacheControl: r.headers.get("cache-control") };
}

/** The 31 tool names a token sees. */
async function toolNames(ctx, token, actor) {
  const m = ctx.mcp({ token, actor, cutoffError: true });
  await m.initialize();
  return (await m.listTools()).map((t) => t.name).sort();
}

/** The challenge /mcp answers a refused credential with (SPEC §23 "Discovery"). */
function challengeFor(presented) {
  return `Bearer realm="bikeshed", resource_metadata="${PRM_URL()}"${presented ? ', error="invalid_token"' : ""}`;
}

/** POST /oauth/consent with exactly these headers (no defaults beyond JSON when a body object is given). */
async function consentRaw(http, { body, headers = {}, contentType = "application/json" }) {
  return http.request("POST", "/oauth/consent", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": contentType, ...headers },
  });
}

// --- A22.1 ------------------------------------------------------------------

scenario("A22.1 discovery: both protected-resource documents name the issuer byte for byte as their only authorization server and this host's /mcp, private, no-store; the authorization-server metadata is public, max-age=300 and advertises S256, auth none, CIMD and iss with no scopes; openid-configuration is a JSON 404; /mcp's 401 points at the protected-resource document", {
  tiers: BOTH,
  inconclusiveOnCaseTimeout: true,
  timeoutMs: 180_000,
}, async (ctx) => {
  const http = ctx.http({ actor: "oauth-app", cutoffError: true });
  const d = await discover(http);
  const { prm, prmRoot, as, oidc } = d.responses;

  ctx.step("headers: PRM private, no-store on both paths; AS public, max-age=300; the OIDC probe a JSON 404; all CORS-open");
  assertHeaderMatrix([
    { label: "PRM …/mcp", res: prm, status: 200, expect: { "cache-control": "private, no-store", "access-control-allow-origin": "*", "content-type": /^application\/json/ } },
    { label: "PRM root", res: prmRoot, status: 200, expect: { "cache-control": "private, no-store", "access-control-allow-origin": "*", "content-type": /^application\/json/ } },
    { label: "AS metadata", res: as, status: 200, expect: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*", "content-type": /^application\/json/ } },
    { label: "openid-configuration", res: oidc, status: 404, expect: { "cache-control": "private, no-store", "content-type": /^application\/json/ } },
  ]);
  assert.equal(oidc.json?.error, "not_found", `the OIDC probe's body: ${oidc.text.slice(0, 200)}`);

  ctx.step("the issuer is this origin, with no trailing slash, and is each PRM's only authorization server, byte for byte");
  const issuer = d.as.issuer;
  assert.equal(issuer, ISSUER(), "issuer (SPEC §23: publicOrigin(), compared byte for byte)");
  for (const [label, doc] of [["PRM …/mcp", d.prm], ["PRM root", d.prmRoot]]) {
    assert.deepEqual(
      { resource: doc.resource, authorization_servers: doc.authorization_servers, bearer: doc.bearer_methods_supported },
      { resource: RESOURCE(), authorization_servers: [issuer], bearer: ["header"] },
      `${label} (RFC 9728)`,
    );
    assert.ok(Buffer.from(doc.authorization_servers[0]).equals(Buffer.from(issuer)), `${label}: authorization_servers[0] is the issuer's bytes`);
  }

  ctx.step("the AS metadata advertises what SPEC §23 lists, and no scopes");
  const want = {
    issuer: ISSUER(),
    authorization_endpoint: `${ISSUER()}/connect`,
    token_endpoint: `${ISSUER()}/oauth/token`,
    registration_endpoint: `${ISSUER()}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
  assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, d.as[k]])), want, "authorization-server metadata (RFC 8414)");
  assert.equal("scopes_supported" in d.as, false, "no scopes_supported (SPEC §23)");

  ctx.step("only GET and HEAD read the metadata");
  const head = await http.head("/.well-known/oauth-authorization-server");
  const post = await http.request("POST", "/.well-known/oauth-protected-resource/mcp", { body: "{}", headers: { "content-type": "application/json" } });
  assert.deepEqual({ head: head.status, post: post.status, allow: post.headers.get("allow") }, { head: 200, post: 405, allow: "GET, HEAD" });

  ctx.step("the chain an MCP client follows: /mcp's 401 names the PRM, and that address answers this document");
  const probe = await ctx.mcp({ actor: "no-credential", cutoffError: true }).raw({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual({ status: probe.status, challenge: probe.headers.get("www-authenticate") }, { status: 401, challenge: challengeFor(false) });
  const followed = await http.get(/resource_metadata="([^"]+)"/.exec(probe.headers.get("www-authenticate"))[1], { expect: 200 });
  assert.deepEqual(followed.json, d.prm, "the challenge's resource_metadata is the PRM");

  if (target.kind === "local") {
    ctx.step("emulator: asked on another host name, both documents follow the host the request used (SPEC §23: the request's own origin)");
    const other = new URL(target.origin);
    other.hostname = "localhost";
    const alt = other.origin;
    const prmAlt = await http.get(`${alt}/.well-known/oauth-protected-resource/mcp`, { expect: 200 });
    const asAlt = await http.get(`${alt}/.well-known/oauth-authorization-server`, { expect: 200 });
    assert.deepEqual({ resource: prmAlt.json.resource, servers: prmAlt.json.authorization_servers, issuer: asAlt.json.issuer }, { resource: `${alt}/mcp`, servers: [alt], issuer: alt });
  } else {
    ctx.step("production: an X-Forwarded-Host that is not one of the deployment's hosts never reaches the metadata");
    const spoof = await http.get("/.well-known/oauth-protected-resource/mcp", { headers: { "x-forwarded-host": `e2e-${tag()}.example` }, expect: 200 });
    assert.deepEqual({ resource: spoof.json.resource, servers: spoof.json.authorization_servers }, { resource: RESOURCE(), servers: [ISSUER()] });
  }
});

// --- A22.2 ------------------------------------------------------------------

/**
 * The page's own focus, blur and visibility changes since Approve appeared.
 * Each one holds arming back (app/src/pages/Connect.tsx useArmed restarts its
 * second on every one, and settles only while visible and focused), so a
 * timing the environment spoiled is told apart from a page that never armed.
 * Read from the arming record (lib/oauth.mjs armingProbe).
 */
function focusChangesSinceAppear(record) {
  return (record?.focusChanges ?? []).filter((f) => f.t >= record.appeared).map((f) => `${f.type}@${Math.round(f.t - record.appeared)}ms(focus ${f.hasFocus}, ${f.visibility})`);
}

/** The query /connect is opened with: the authorize parameters, plus one key the page must drop. */
function connectPath(params) {
  const q = new URLSearchParams({ ...params, e2e_extra: "dropped" });
  return `/connect?${q}`;
}

/** Sign in from the form /connect shows a signed-out visitor, by keyboard only (no pointer event reaches the page). */
async function signInAtConnect(u, acct) {
  const mark = u.responseMark();
  await u.page.fill("#auth-email", acct.email);
  await u.page.fill("#auth-password", acct.password);
  await u.page.press("#auth-password", "Enter");
  const s = answered(await u.waitForResponse({ method: "POST", path: "/session" }, { since: mark, timeout: ROUND_TRIP_MS }), "the page's POST /session at /connect");
  precondition(s.status === 200, `POST /session from /connect answered ${s.status}`);
}

scenario("A22.2 connect: DCR gives a bsdcr_ id; /connect opened signed out strips its query, keeps it ten minutes and survives the sign-in; the card says where you go back to and that the name is chosen by the app, not checked; Approve arms only after a second of focus and a pointer or key event; the redirect carries code, state and iss; the exchange gives a one-hour bsa_ and a bsr_, and bsa_ sees the 33 tools at /mcp and nothing else; Cancel sends access_denied with state and iss", {
  tiers: BOTH,
  inconclusiveOnCaseTimeout: true,
  timeoutMs: 360_000,
}, async (ctx) => {
  const t = tag();
  const { acct, session } = await owner();
  const http = ctx.http({ actor: "oauth-app", cutoffError: true });
  const webHost = `app-${t}.example`;
  const webRedirect = `https://${webHost}/cb`;

  ctx.step("register: the name carries a zero-width space and a right-to-left override, which must not survive");
  const rawName = `E2E​ A22‮ app ${t}`;
  const cleanName = `E2E A22 app ${t}`;
  const reg = await register(http, { redirectUris: [LOOPBACK_CB, webRedirect], clientName: rawName });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  assert.match(reg.clientId, /^bsdcr_[A-Za-z0-9_-]+$/, "a stateless registration's id");
  assert.deepEqual(
    { name: reg.json.client_name, redirects: reg.json.redirect_uris, auth: reg.json.token_endpoint_auth_method, grants: reg.json.grant_types },
    { name: cleanName, redirects: [LOOPBACK_CB, webRedirect], auth: "none", grants: ["authorization_code", "refresh_token"] },
  );

  const u = await ctx.users.user({ name: "owner" });
  await armingProbe(u); // before the first goto: every /connect document from now on records its arming on its own clock
  await u.page.bringToFront();
  const approve = u.page.getByRole("button", { name: "Approve", exact: true });
  const card = u.page.locator(".connect-card");
  const timings = {};
  const arming = {};

  // r1: the default for this target (a socket on a spare port locally, a route on production).
  // r2: always a route, answered inside the browser, so production's receiver also runs on a local stack.
  const r1 = await startReceiver({ target, page: u });
  const r2 = await startReceiver({ target, page: u, via: "route" });
  try {
    const p1 = pkce();
    const params1 = authorizeParams({ clientId: reg.clientId, redirectUri: r1.redirectUri, challenge: p1.challenge });

    ctx.step("open /connect with the request while signed out: the sign-in form shows, the address bar already reads /connect, and the request is kept");
    await u.goto(connectPath(params1));
    await u.page.locator("#auth-password").waitFor({ state: "visible", timeout: 30_000 });
    const where = await u.page.evaluate(() => ({
      href: location.href,
      nav: performance.getEntriesByType("navigation")[0]?.name ?? null,
      saved: sessionStorage.getItem("bikeshed.connect"),
      now: Date.now(),
    }));
    assert.ok(new URL(where.nav).searchParams.get("client_id") === reg.clientId, "the page was loaded with the query (positive control)");
    assert.equal(where.href, `${target.origin}/connect`, "the query is stripped from the address bar before sign-in (SPEC §23)");
    const saved = JSON.parse(where.saved ?? "null");
    assert.deepEqual(saved?.params, params1, "session storage keeps exactly the allowlisted parameters");
    const ttl = saved.expiresAt - where.now;
    assert.ok(ttl > 9 * 60_000 && ttl <= 10 * 60_000, `kept for ten minutes (expires in ${ttl} ms)`);

    ctx.step("sign in there, by keyboard: the consent card for the same request appears");
    await signInAtConnect(u, acct);
    await approve.waitFor({ state: "visible", timeout: ROUND_TRIP_MS });

    ctx.step("card 1 (loopback): who is asking, where you go back to, the warning, the account");
    assert.equal((await card.locator("h1").textContent()).trim(), "Connect a program on this computer to Bikeshed?");
    assert.equal((await card.locator(".connect-name").textContent()).trim(), cleanName, "the name, with its format characters stripped");
    assert.equal((await card.locator(".connect-from .chip-warn").textContent()).trim(), MSG.unchecked);
    assert.equal((await card.locator(".connect-host").textContent()).trim(), "127.0.0.1");
    assert.match((await card.locator(".banner-warn").first().textContent()).replace(/\s+/g, " "), /That's a program on this computer\./);
    assert.match((await card.textContent()).replace(/\s+/g, " "), new RegExp(`Signed in as ${acct.email.toLowerCase().replace(/[.+]/g, "\\$&")}`));

    assert.deepEqual(await card.locator(".connect-list:not(.connect-list-not) li").allTextContents(), [
      "Read what you can read", "Publish, revise and rename documents", "Comment, reply, suggest edits and resolve threads",
      "Accept or reject suggested edits where you can, and save them as a new version", "Create folders and file documents in them",
      "Manage sharing on documents and folders you own, sending invitations to new readers",
      "Change visibility, open editing and expiry on documents you own, and visibility and expiry on folders you own",
      "Rename and move folders you can edit; delete folders you own while keeping their contents",
    ], "consent discloses every allowed capability");
    assert.deepEqual(await card.locator(".connect-list-not li").allTextContents(), [
      "Delete documents or manage teams", "Trust document scripts or act with permissions you do not have",
    ], "consent discloses the forbidden capabilities");

    ctx.step("arming, phase 1: with no input at all for 2.5 s Approve stays disabled (the product's one-second delay, waited out with margin)");
    const a0 = await readArming(u);
    precondition(a0?.appeared != null, "the arming probe saw Approve appear");
    if (a0.focusAtAppear !== true || a0.visibleAtAppear !== "visible") ctx.inconclusive(`the consent page did not have focus (${a0.focusAtAppear}) or was not visible (${a0.visibleAtAppear}) when Approve appeared`);
    await sleep(Math.max(0, a0.appeared + 2500 - a0.now));
    const a1 = await readArming(u);
    // Only input from the moment Approve exists counts: the product listens from then on (the sign-in's Enter came before).
    const since = (list, at) => list.filter((x) => x >= at);
    const stray = { moves: since(a1.moves, a1.appeared).length, keys: since(a1.keys, a1.appeared).length };
    if (stray.moves || stray.keys) ctx.inconclusive(`input reached the page during the no-input phase: ${stray.moves} pointermove, ${stray.keys} keydown`);
    timings.noInput = { waitedMs: Math.round(a1.now - a1.appeared), enabledAfterMs: a1.enabled === null ? null : Math.round(a1.enabled - a1.appeared) };
    arming["no input for 2.5 s keeps Approve disabled"] = a1.enabled === null && (await approve.isDisabled());

    ctx.step("arming, phase 2: one key press then arms it at once");
    await u.page.keyboard.press("Shift");
    await eventually(async () => (await readArming(u)).enabled !== null || false, { timeout: 5_000, interval: 50, message: "Approve armed after the key press" }).catch(() => undefined);
    const a2 = await readArming(u);
    const keyAt = since(a2.keys, a2.appeared)[0] ?? null;
    timings.key = { keyAfterMs: keyAt === null ? null : Math.round(keyAt - a2.appeared), armLagMs: keyAt === null || a2.enabled === null ? null : Math.round(a2.enabled - keyAt) };
    arming["a key press after the second arms Approve"] = keyAt !== null && a2.enabled !== null && a2.enabled - keyAt < 1000;
    const spoiled2 = focusChangesSinceAppear(a2);
    if (!arming["a key press after the second arms Approve"] && spoiled2.length) ctx.inconclusive(`the page's focus changed after Approve appeared (${spoiled2.join(", ")}), which restarts its second: the key-press timing does not hold`);

    ctx.step("approve: the browser goes back to the receiver with code, state and iss, and nothing else");
    precondition(await approve.isEnabled(), "Approve is enabled before it is pressed");
    await approve.click();
    const back1 = await r1.received(ROUND_TRIP_MS);
    assert.deepEqual(Object.keys(back1.query).sort(), ["code", "iss", "state"], `the authorization response: ${Object.keys(back1.query)}`);
    assert.deepEqual({ state: back1.state, iss: back1.iss }, { state: params1.state, iss: ISSUER() }, "state round-trips; iss is the issuer (RFC 9207)");
    assert.match(back1.code, /^[A-Za-z0-9_-]{43}$/);

    ctx.step("the code from card 1 exchanges for a bsa_ good for one hour and a bsr_ of the same grant; no-store, no-cache");
    const x = await exchangeCode(http, { code: back1.code, verifier: p1.verifier, clientId: reg.clientId, redirectUri: r1.redirectUri });
    assert.equal(x.status, 200, JSON.stringify(x.json));
    assertHeaderMatrix([{ label: "POST /oauth/token", res: x.response, expect: { "cache-control": "private, no-store", pragma: "no-cache" } }]);
    assert.deepEqual(Object.keys(x.json).sort(), ["access_token", "expires_in", "refresh_token", "token_type"]);
    assert.equal(x.json.token_type, "Bearer");
    const am = ACCESS_RE.exec(x.json.access_token);
    const rm = REFRESH_RE.exec(x.json.refresh_token);
    assert.ok(am && rm && am[1] === rm[1], "bsa_<tokenId>.<secret> and bsr_<same tokenId>.<secret>");
    assert.ok(x.json.expires_in > 3590 && x.json.expires_in <= 3600, `expires_in ${x.json.expires_in}: one hour`);
    const tokenId = am[1];
    appendLedger(target, { kind: "oauth", tokenId, uid: session.uid, clientId: reg.clientId });
    if (target.kind === "local") {
      const rec = await readDoc(target, `oauthCodes/${sha256(back1.code)}`);
      assert.equal(await readDoc(target, `oauthCodes/${back1.code}`), null, "the code itself is never a key");
      assert.deepEqual(
        { uid: rec?.uid, clientId: rec?.clientId, redirectUri: rec?.redirectUri, challenge: rec?.codeChallenge, resource: rec?.resource, life: rec?.expiresAt.toMillis() - rec?.createdAt.toMillis(), spent: Boolean(rec?.usedAt), tokenId: rec?.tokenId },
        { uid: session.uid, clientId: reg.clientId, redirectUri: r1.redirectUri, challenge: p1.challenge, resource: RESOURCE(), life: 120_000, spent: true, tokenId },
        "Approve wrote oauthCodes/{sha256(code)}, valid for two minutes, spent by the exchange (SPEC §23 Consent)",
      );
      const g = await readDoc(target, `tokens/${tokenId}`);
      assert.deepEqual(
        { kind: g.kind, channel: g.channel, hasHash: "hash" in g, life: g.accessExpiresAt.toMillis() - g.createdAtMs, resource: g.resource, client: g.client, generation: g.generation, revokedAt: g.revokedAt },
        { kind: "oauth", channel: "mcp", hasHash: false, life: 3_600_000, resource: RESOURCE(), client: { id: reg.clientId, host: null, verified: false, registration: "dcr" }, generation: 0, revokedAt: null },
        "tokens/{id}: an oauth grant, never with a personal token's hash (SPEC §23 Tokens)",
      );
    }
    const listed = ((await listTokens(session)).json?.tokens ?? []).filter((x2) => x2.tokenId === tokenId);
    assert.deepEqual(listed.map((l) => ({ kind: l.kind, name: l.name, channel: l.channel, clientHost: l.clientHost, registration: l.registration, revoked: l.revoked })), [{ kind: "oauth", name: cleanName, channel: "mcp", clientHost: null, registration: "dcr", revoked: false }], "the account's token list carries the grant");

    ctx.step("bsa_ at /mcp sees exactly the tools a personal token sees (33); at /publish it is not a credential");
    const viaGrant = await toolNames(ctx, x.json.access_token, "oauth-mcp");
    const personal = await mintToken(session, { name: `e2e a22 compare ${t}`, channel: "mcp" });
    const viaPersonal = await toolNames(ctx, personal.token, "personal-mcp");
    assert.equal(viaGrant.length, 33, viaGrant.join(", "));
    assert.deepEqual(viaGrant, viaPersonal, "the same 33 tools as a personal token");
    const pub = await bearerHttp(target, x.json.access_token, { actor: "oauth-bsa", cutoffError: true }).request("POST", "/publish", { body: "<!doctype html><p>e2e a22", headers: { "content-type": "text/html" } });
    assert.equal(pub.status, 401, `POST /publish with a bsa_: ${pub.status} (SPEC §23: /mcp only)`);


    ctx.step("card 2 (an https redirect): the title leads with the redirect's host, then the self-chosen name, unchecked, with the any-name warning");
    const p3 = pkce();
    await u.goto(connectPath(authorizeParams({ clientId: reg.clientId, redirectUri: webRedirect, challenge: p3.challenge })));
    await approve.waitFor({ state: "visible", timeout: ROUND_TRIP_MS });
    assert.equal((await card.locator("h1").textContent()).trim(), `Connect ${webHost} to Bikeshed?`);
    const order = await card.evaluate((c) => {
      const h1 = c.querySelector("h1");
      const from = c.querySelector(".connect-from");
      return Boolean(h1 && from && h1.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.equal(order, true, "the redirect host (title) comes before the app's own name");
    assert.equal((await card.locator(".connect-name").textContent()).trim(), cleanName);
    assert.equal((await card.locator(".connect-from .chip-warn").textContent()).trim(), MSG.unchecked);
    assert.equal((await card.locator(".connect-host").textContent()).trim(), webHost);
    assert.match((await card.textContent()).replace(/\s+/g, " "), new RegExp(`Anyone can register an app under any name\\. Approve only if you were connecting an app at ${webHost.replace(/\./g, "\\.")} just now\\.`));

    ctx.step("card 3 (loopback again): the pointer moves from the moment Approve appears; Approve still waits out its second");
    const p2 = pkce();
    const params2 = authorizeParams({ clientId: reg.clientId, redirectUri: r2.redirectUri, challenge: p2.challenge });
    await u.goto(connectPath(params2));
    await approve.waitFor({ state: "visible", timeout: ROUND_TRIP_MS });
    const box = (await card.boundingBox()) ?? { x: 50, y: 50, width: 300, height: 300 };
    const points = [[box.x + 10, box.y + 10], [box.x + box.width - 10, box.y + 10], [box.x + box.width - 10, box.y + 30], [box.x + 10, box.y + 30]];
    const startedMove = Date.now();
    for (let i = 0; ; i++) {
      const [x, y] = points[i % points.length];
      await u.page.mouse.move(x, y, { steps: 2 });
      // Keep moving for at least 300 ms, then until Approve arms (8 s at most).
      if (Date.now() - startedMove > 300 && ((await approve.isEnabled()) || Date.now() - startedMove > 8_000)) break;
    }
    const c = await readArming(u);
    const firstMove = c.moves.find((m) => m >= c.appeared);
    if (firstMove === undefined || firstMove - c.appeared > 700) ctx.inconclusive(`the first pointer move came ${firstMove === undefined ? "never" : `${Math.round(firstMove - c.appeared)} ms`} after Approve appeared, too late to test the delay`);
    timings.early = { firstMoveAfterMs: Math.round(firstMove - c.appeared), enabledAfterMs: c.enabled === null ? null : Math.round(c.enabled - c.appeared), moves: c.moves.length };
    arming["under pointer movement from the start, Approve stays disabled for the first second"] = c.enabled === null || c.enabled - c.appeared >= 990;
    arming["and then it arms"] = c.enabled !== null;
    const spoiled3 = focusChangesSinceAppear(c);
    if (!arming["and then it arms"] && spoiled3.length) ctx.inconclusive(`the page's focus changed after Approve appeared (${spoiled3.join(", ")}), which restarts its second: whether it arms under movement does not hold`);

    ctx.step("Cancel: the browser goes back with error=access_denied, state and iss, and no code");
    await u.page.getByRole("button", { name: "Cancel", exact: true }).click();
    const back2 = await r2.received(ROUND_TRIP_MS);
    ctx.step(`receivers: approve went to a ${r1.via} receiver (${r1.requests.map((q) => `${q.method} ${q.path}`).join(", ")}), cancel to a ${r2.via} receiver (${r2.requests.map((q) => `${q.method} ${q.path}`).join(", ")}); the page is now at ${new URL(u.page.url()).origin}${new URL(u.page.url()).pathname}`);
    assert.deepEqual(
      { keys: Object.keys(back2.query).sort(), error: back2.error, state: back2.state, iss: back2.iss },
      { keys: ["error", "iss", "state"], error: "access_denied", state: params2.state, iss: ISSUER() },
      "Cancel's redirect: access_denied with state and iss, and no code (RFC 6749 §4.1.2.1, RFC 9207)",
    );

  } finally {
    await r1.close();
    await r2.close();
  }

  ctx.step(`arming verdicts: ${JSON.stringify(arming)} timings ${JSON.stringify(timings)}`);
  const failed = Object.entries(arming).filter(([, ok]) => !ok).map(([k]) => k);
  assert.deepEqual(failed, [], `consent arming (SPEC §23 "Approve stays disabled until the page has had focus for a second and a pointer or key event"): failed: ${failed.join("; ")} — timings ${JSON.stringify(timings)}`);
  noPageErrors([u]);
});

// --- A22.3 ------------------------------------------------------------------

scenario("A22.3 refresh rotates both secrets and the spent bsa_ stops working; a replay of the spent bsr_ or of the code within 60 s gets the identical pair; a wrong secret for a known grant changes nothing; a replay after 60 s revokes the grant, so its bsa_ answers 401 and its newest bsr_ is refused", {
  tiers: BOTH,
  inconclusiveOnCaseTimeout: true,
  timeoutMs: 360_000,
}, async (ctx) => {
  const { session } = await owner();
  const http = ctx.http({ actor: "oauth-app", cutoffError: true });
  const reg = await client(http, [LOOPBACK_CB]);
  const redirectUri = "http://127.0.0.1:1/callback"; // never followed: approved and exchanged over HTTP only

  ctx.step("grant A: exchange, then refresh once: both secrets change, the tokenId stays");
  const A = await connectViaApi(http, session, { clientId: reg.clientId, redirectUri });
  const pair0 = A.pair;
  assert.equal((await mcpInit(ctx, pair0.access_token, "A0")).status, 200, "the first bsa_ works");
  const rotationStartedAt = Date.now();
  const rot = await refresh(http, { refreshToken: pair0.refresh_token, clientId: reg.clientId });
  const rotatedAt = Date.now();
  assert.equal(rot.status, 200, JSON.stringify(rot.json));
  const pair1 = rot.json;
  assert.ok(ACCESS_RE.exec(pair1.access_token)?.[1] === A.tokenId && REFRESH_RE.exec(pair1.refresh_token)?.[1] === A.tokenId, "the same grant");
  assert.notEqual(pair1.access_token, pair0.access_token, "the access secret rotated");
  assert.notEqual(pair1.refresh_token, pair0.refresh_token, "the refresh secret rotated");
  ctx.step("a retry of the same spend within 60 s gets the identical pair, and writes nothing");
  const retry = await refresh(http, { refreshToken: pair0.refresh_token, clientId: reg.clientId });
  if (retry.status !== 200 && Date.now() - rotationStartedAt >= 60_000) ctx.inconclusive("the rotation and retry requests outlasted the 60-second replay window");
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  assert.deepEqual({ access: retry.json.access_token, refresh: retry.json.refresh_token }, { access: pair1.access_token, refresh: pair1.refresh_token }, "the identical pair");
  if (target.kind === "local") assert.equal((await readDoc(target, `tokens/${A.tokenId}`)).generation, 1, "one rotation, not two");

  const spent = await mcpInit(ctx, pair0.access_token, "A0-after-rotation");
  assert.deepEqual({ status: spent.status, challenge: spent.challenge }, { status: 401, challenge: challengeFor(true) }, "the bsa_ from before the rotation no longer works");
  assert.equal((await mcpInit(ctx, pair1.access_token, "A1")).status, 200, "the rotated bsa_ works");



  ctx.step("revocation requires possession: a wrong secret for the known grant id is refused and changes nothing");
  const forged = `bsr_${A.tokenId}.${randomBytes(32).toString("base64url")}`;
  const wrong = await refresh(http, { refreshToken: forged, clientId: reg.clientId });
  assert.deepEqual({ status: wrong.status, error: wrong.json?.error, d: wrong.json?.error_description }, { status: 400, error: "invalid_grant", d: MSG.notRecognised });
  assert.equal((await mcpInit(ctx, pair1.access_token, "A1-after-forgery")).status, 200, "the grant still works");

  ctx.step("grant B: a retry of the code exchange within 60 s gets the identical pair");
  const codeRetryStartedAt = Date.now();
  const B = await connectViaApi(http, session, { clientId: reg.clientId, redirectUri });
  const exchangedAt = Date.now();
  const again = await exchangeCode(http, { code: B.code, verifier: B.verifier, clientId: reg.clientId, redirectUri });
  if (again.status !== 200 && Date.now() - codeRetryStartedAt >= 60_000) ctx.inconclusive("the first exchange and code retry requests outlasted the 60-second replay window");
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.deepEqual({ access: again.json.access_token, refresh: again.json.refresh_token }, { access: B.pair.access_token, refresh: B.pair.refresh_token }, "the identical pair for a retried code");
  assert.equal((await mcpInit(ctx, B.pair.access_token, "B")).status, 200);

  const wait = Math.max(rotatedAt, exchangedAt) + PAST_REPLAY_WINDOW_MS - Date.now();
  ctx.step(`wait ${Math.max(0, wait)} ms: past the product's 60 s replay window (REPLAY_GRACE_MS), a time-based rule`);
  await sleep(Math.max(0, wait));

  ctx.step("grant A: replaying the spent bsr_ now revokes the grant");
  const late = await refresh(http, { refreshToken: pair0.refresh_token, clientId: reg.clientId });
  assert.deepEqual({ status: late.status, error: late.json?.error, d: late.json?.error_description }, { status: 400, error: "invalid_grant", d: MSG.replayedRefresh });
  const afterA = await mcpInit(ctx, pair1.access_token, "A1-after-late-replay");
  assert.deepEqual({ status: afterA.status, challenge: afterA.challenge }, { status: 401, challenge: challengeFor(true) }, "late replay revokes: /mcp refuses the newest bsa_");
  const newestA = await refresh(http, { refreshToken: pair1.refresh_token, clientId: reg.clientId });
  assert.deepEqual({ status: newestA.status, error: newestA.json?.error, d: newestA.json?.error_description }, { status: 400, error: "invalid_grant", d: MSG.disconnected }, "late replay revokes: the newest bsr_ is refused");

  ctx.step("grant B: exchanging the code again now revokes what it issued");
  const lateCode = await exchangeCode(http, { code: B.code, verifier: B.verifier, clientId: reg.clientId, redirectUri });
  assert.deepEqual({ status: lateCode.status, error: lateCode.json?.error, d: lateCode.json?.error_description }, { status: 400, error: "invalid_grant", d: MSG.replayedCode });
  assert.equal((await mcpInit(ctx, B.pair.access_token, "B-after-late-replay")).status, 401, "late code replay revokes: /mcp refuses its bsa_");
  const newestB = await refresh(http, { refreshToken: B.pair.refresh_token, clientId: reg.clientId });
  assert.deepEqual({ status: newestB.status, d: newestB.json?.error_description }, { status: 400, d: MSG.disconnected });

  const listed = ((await listTokens(session)).json?.tokens ?? []).filter((x) => x.tokenId === A.tokenId || x.tokenId === B.tokenId);
  assert.deepEqual(listed.map((x) => x.revoked), [true, true], "the account lists both grants revoked");
});

scenario("A22.3b the gate is re-checked at every refresh: once the account signs out everywhere, or is disabled, the next refresh of its connected app is refused with \"this account can no longer connect apps\" and revokes the grant, whose bsa_ then answers 401", {
  tiers: ["local"],
  inconclusiveOnCaseTimeout: true,
  needs: ["admin-emulator"],
  timeoutMs: 360_000,
}, async (ctx) => {
  const http = ctx.http({ actor: "oauth-app", cutoffError: true });
  const reg = await client(http, [LOOPBACK_CB]);
  const redirectUri = "http://127.0.0.1:1/callback";
  const auth = adminFor(target).auth;
  const out = {};
  for (const [label, close] of [
    ["signed out everywhere", (uid) => auth.revokeRefreshTokens(uid)],
    ["disabled", (uid) => auth.updateUser(uid, { disabled: true })],
    ["unverified email", (uid) => auth.updateUser(uid, { emailVerified: false })],
    ["changed email", (uid) => auth.updateUser(uid, { email: `changed-${tag()}@example.com` })],
    ["deleted account", (uid) => auth.deleteUser(uid)],
  ]) {
    const { session } = await owner();
    const G = await connectViaApi(http, session, { clientId: reg.clientId, redirectUri });
    precondition((await mcpInit(ctx, G.pair.access_token, `${label}-before`)).status === 200, `${label}: the grant works before the gate closes`);
    // tokensValidAfterTime is whole seconds: let the grant's creation fall in an earlier second than the revocation (a time-based rule of Firebase Auth).
    await sleep(1100);
    await close(session.uid);
    const accessBefore = (await mcpInit(ctx, G.pair.access_token, `${label}-not-yet-refreshed`)).status;
    ctx.step(`${label}: the bsa_ answers ${accessBefore} before any refresh (SPEC §23: a grant asks at every refresh, so the connection ends within the hour)`);
    const r = await refresh(http, { refreshToken: G.pair.refresh_token, clientId: reg.clientId });
    const after = await mcpInit(ctx, G.pair.access_token, `${label}-after`);
    const record = await readDoc(target, `tokens/${G.tokenId}`);
    out[label] = { refresh: `${r.status} ${r.json?.error}: ${r.json?.error_description}`, mcp: after.status, revoked: Boolean(record?.revokedAt) };
  }
  const closed = { refresh: "400 invalid_grant: this account can no longer connect apps", mcp: 401, revoked: true };
  assert.deepEqual(out, { "signed out everywhere": closed, disabled: closed, "unverified email": closed, "changed email": closed, "deleted account": closed }, "a closed gate revokes the grant at its next refresh (SPEC §23 Tokens)");
});

// --- A22.4 ------------------------------------------------------------------

/** A client id built by hand, as an attacker would: registration-encoded, never registered. */
function handBuiltClientId(name, redirects) {
  return `bsdcr_${Buffer.from(JSON.stringify({ n: name, r: redirects }), "utf8").toString("base64url")}`;
}

scenario("A22.4 redirects and PKCE: every token-endpoint check runs before the code is spent, so a wrong client, redirect_uri, resource or verifier is refused and the code still works; javascript:, data:, fragment and userinfo redirects are refused at registration and in a hand-built id; a loopback redirect matches any port, localhost is not 127.0.0.1, an https one matches exactly; only S256, and a failure once the redirect is known carries back with iss, which the consent page follows only when pressed", {
  tiers: BOTH,
  inconclusiveOnCaseTimeout: true,
  timeoutMs: 300_000,
}, async (ctx) => {
  const { session } = await owner();
  const http = ctx.http({ actor: "oauth-app", cutoffError: true });
  const t = tag();

  ctx.step("registration refuses every hostile or malformed redirect, one at a time");
  const hostile = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "blob:https://example.com/id",
    "file:///etc/passwd",
    "about:blank",
    `https://app-${t}.example/cb#fragment`,
    `https://user:pw@app-${t}.example/cb`,
    `http://app-${t}.example/cb`,
  ];
  const refusals = [];
  for (const uri of hostile) {
    const r = await register(http, { redirectUris: [uri] });
    refusals.push({ uri, status: r.status, error: r.json?.error, d: r.json?.error_description });
  }
  assert.deepEqual(refusals, hostile.map((uri) => ({ uri, status: 400, error: "invalid_redirect_uri", d: MSG.redirectRefused })), "registration refuses hostile redirect URIs");

  const tok = session.idToken;
  const describe = async (params) => approveViaApi(http, tok, params, { action: "describe" });

  ctx.step("every hostile URI is rejected again when smuggled in a hand-built client id");
  for (const uri of hostile) {
    const forged = handBuiltClientId("Forged", [uri]);
    const fd = await describe(authorizeParams({ clientId: forged, redirectUri: uri, challenge: pkce().challenge }));
    assert.deepEqual(fd.json, { valid: false, error: "invalid_client", message: MSG.whoIsAsking }, `hand-built redirect is rejected without a back URL: ${uri}`);
  }
  for (const uri of ["com.example.app:/callback", "example-app://desktop/callback"]) {
    const app = await register(http, { redirectUris: [uri], clientName: "A22 native application" });
    assert.equal(app.status, 201, "an application's private-use scheme can register");
    const described = await describe(authorizeParams({ clientId: app.clientId, redirectUri: uri, challenge: pkce().challenge }));
    assert.equal(described.json?.valid, true, "an application's private-use scheme can request consent");
  }

  ctx.step("loopback: registered with no port, any port matches; another host spelling, path or query does not");
  const lo = await client(http, [LOOPBACK_CB]);
  const ch = pkce().challenge;
  const portA = 30000 + Math.floor(Math.random() * 9000);
  const portB = portA + 1;
  const loop = {};
  for (const [label, uri] of [
    ["127.0.0.1:A", `http://127.0.0.1:${portA}/callback`],
    ["127.0.0.1:B", `http://127.0.0.1:${portB}/callback`],
    ["127.0.0.1 no port", LOOPBACK_CB],
    ["localhost:A", `http://localhost:${portA}/callback`],
    ["[::1]:A", `http://[::1]:${portA}/callback`],
    ["other path", `http://127.0.0.1:${portA}/callback2`],
    ["added query", `http://127.0.0.1:${portA}/callback?x=1`],
  ]) {
    const r = await describe(authorizeParams({ clientId: lo.clientId, redirectUri: uri, challenge: ch }));
    loop[label] = r.json?.valid === true ? "valid" : `${r.json?.error}${r.json?.back ? " +back" : ""}`;
  }
  assert.deepEqual(loop, {
    "127.0.0.1:A": "valid",
    "127.0.0.1:B": "valid",
    "127.0.0.1 no port": "valid",
    "localhost:A": "invalid_redirect_uri",
    "[::1]:A": "invalid_redirect_uri",
    "other path": "invalid_redirect_uri",
    "added query": "invalid_redirect_uri",
  }, "loopback matching (RFC 8252; SPEC §23): any port, nothing else; refusals carry no back");
  const lh = await client(http, ["http://localhost/callback"]);
  const lhr = await describe(authorizeParams({ clientId: lh.clientId, redirectUri: `http://127.0.0.1:${portA}/callback`, challenge: ch }));
  assert.deepEqual({ valid: lhr.json?.valid, error: lhr.json?.error, message: lhr.json?.message, back: lhr.json?.back }, { valid: false, error: "invalid_redirect_uri", message: MSG.unregistered, back: undefined }, "registered localhost, presented 127.0.0.1");

  ctx.step("https: matched byte for byte, so a trailing slash or a port is another address");
  const webUri = `https://app-${t}.example/cb`;
  const web = await client(http, [webUri]);
  const exact = {};
  for (const [label, uri] of [["exact", webUri], ["trailing slash", `${webUri}/`], ["port", `https://app-${t}.example:8443/cb`], ["upper-case path", `https://app-${t}.example/CB`]]) {
    const r = await describe(authorizeParams({ clientId: web.clientId, redirectUri: uri, challenge: ch }));
    exact[label] = r.json?.valid === true ? "valid" : r.json?.error;
  }
  assert.deepEqual(exact, { exact: "valid", "trailing slash": "invalid_redirect_uri", port: "invalid_redirect_uri", "upper-case path": "invalid_redirect_uri" }, "HTTPS redirect matching is exact");

  ctx.step("PKCE is S256 only; with the redirect established, the refusal carries back, with the error, state and iss");
  const plainParams = authorizeParams({ clientId: lo.clientId, redirectUri: `http://127.0.0.1:${portA}/callback`, challenge: ch, extra: { code_challenge_method: "plain" } });
  const plain = await describe(plainParams);
  assert.deepEqual({ valid: plain.json?.valid, error: plain.json?.error }, { valid: false, error: "invalid_request" }, "plain PKCE cannot request consent");
  const back = new URL(plain.json.back);
  assert.deepEqual(
    { at: `${back.origin}${back.pathname}`, q: Object.fromEntries(back.searchParams) },
    { at: `http://127.0.0.1:${portA}/callback`, q: { error: "invalid_request", error_description: MSG.pkceRequired, state: plainParams.state, iss: ISSUER() } },
  );
  const noChallenge = await describe({ ...authorizeParams({ clientId: lo.clientId, redirectUri: `http://127.0.0.1:${portA}/callback`, challenge: ch }), code_challenge: undefined });
  assert.equal(noChallenge.json?.error, "invalid_request", "no code_challenge at all");

  ctx.step("a real code for a port nobody registered: every check before the spend refuses, and changes nothing");
  const p = pkce();
  const redirectUri = `http://127.0.0.1:${portB}/callback`;
  const approved = await approveViaApi(http, tok, authorizeParams({ clientId: lo.clientId, redirectUri, challenge: p.challenge }));
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  const approvedAt = Date.now();
  assert.ok(approved.redirect.startsWith(`${redirectUri}?`), `the code goes to the port presented: ${approved.redirect.split("?")[0]}`);
  const attempts = [
    ["another client", { clientId: web.clientId, redirectUri, verifier: p.verifier }],
    ["another redirect_uri", { clientId: lo.clientId, redirectUri: `http://127.0.0.1:${portA}/callback`, verifier: p.verifier }],
    ["another resource", { clientId: lo.clientId, redirectUri, verifier: p.verifier, resource: `${target.origin}/not-mcp` }],
    ["a malformed verifier", { clientId: lo.clientId, redirectUri, verifier: "short" }],
    ["the wrong verifier", { clientId: lo.clientId, redirectUri, verifier: pkce().verifier }],
  ];
  const refused = {};
  for (const [label, a] of attempts) {
    const r = await exchangeCode(http, { code: approved.code, ...a });
    refused[label] = `${r.status} ${r.json?.error}: ${r.json?.error_description}`;
  }
  assert.deepEqual(refused, {
    "another client": "400 invalid_grant: the code was issued to another client",
    "another redirect_uri": "400 invalid_grant: redirect_uri does not match the authorization request",
    "another resource": "400 invalid_target: resource does not match the authorization request",
    "a malformed verifier": "400 invalid_grant: code_verifier is malformed",
    "the wrong verifier": "400 invalid_grant: code_verifier does not match",
  });
  const fields = { grant_type: "authorization_code", code: approved.code, code_verifier: p.verifier, client_id: lo.clientId, redirect_uri: redirectUri, resource: RESOURCE() };
  for (const repeated of ["code_verifier", "redirect_uri"]) {
    const form = new URLSearchParams(fields);
    form.append(repeated, fields[repeated]);
    const response = await http.request("POST", "/oauth/token", { body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.deepEqual({ status: response.status, error: response.json?.error, description: response.json?.error_description }, { status: 400, error: "invalid_request", description: "a parameter was repeated" }, `a repeated ${repeated} is rejected before spending the code`);
  }
  if (Date.now() - approvedAt >= 110_000) ctx.inconclusive("the refusal matrix consumed the authorization code's two-minute life before its final exchange could be measured");
  const ok = await http.postJson("/oauth/token", fields);
  assert.equal(ok.status, 200, `the code still works after the refused attempts (SPEC §23: a wrong verifier costs nothing): ${ok.status} ${JSON.stringify(ok.json)}`);
  assert.match(ok.json.access_token, ACCESS_RE);
  appendLedger(target, { kind: "oauth", tokenId: ACCESS_RE.exec(ok.json.access_token)[1], uid: session.uid, clientId: lo.clientId });
  assert.equal((await mcpInit(ctx, ok.json.access_token, "after-refusals")).status, 200);

  ctx.step("in the browser: a redirect the app never registered is a message with no way back; a refusal once the redirect is known offers Go back, and the page follows it only when pressed");
  const u = await ctx.users.user({ name: "owner" });
  const s = await u.signInUi(session.account.email, session.account.password);
  precondition(s.status === "ok", "signed in through the UI");
  const card = u.page.locator(".auth-card");
  const receiver = await startReceiver({ target, page: u });
  try {
    await u.goto(`/connect?${new URLSearchParams(authorizeParams({ clientId: lo.clientId, redirectUri: `http://localhost:${new URL(receiver.redirectUri).port}/callback`, challenge: ch }))}`);
    await card.getByRole("heading", { name: "This request can't go ahead", level: 1 }).waitFor({ timeout: ROUND_TRIP_MS });
    assert.deepEqual(
      { lead: (await card.locator(".auth-lead").textContent()).trim(), hint: (await card.locator(".field-hint").textContent()).trim() },
      { lead: MSG.unregistered, hint: "Start again from the app you were connecting." },
    );
    assert.equal(await card.getByRole("button").count(), 0, "no button: nothing is sent to an address the app never registered");

    const refusedParams = authorizeParams({ clientId: lo.clientId, redirectUri: receiver.redirectUri, challenge: ch, extra: { code_challenge_method: "plain" } });
    await u.goto(`/connect?${new URLSearchParams(refusedParams)}`);
    const goBack = card.getByRole("button", { name: "Go back to 127.0.0.1", exact: true });
    await goBack.waitFor({ state: "visible", timeout: ROUND_TRIP_MS });
    // Firebase listeners intentionally keep network activity alive. Observe
    // the navigation/receiver state after the refusal rendered instead.
    // Observe beyond a common deferred-navigation timer; this is a bounded
    // no-navigation oracle, not a network-idle or backend latency wait.
    await sleep(2500);
    assert.equal(new URL(u.page.url()).pathname, "/connect", "the page did not leave by itself");
    assert.equal(receiver.heard(), false, "the receiver heard nothing before the button was pressed");
    await goBack.click();
    const back2 = await receiver.received(ROUND_TRIP_MS);
    assert.deepEqual(back2.query, { error: "invalid_request", error_description: MSG.pkceRequired, state: refusedParams.state, iss: ISSUER() });
  } finally {
    await receiver.close();
  }
  noPageErrors([u]);
});

// --- A22.5 ------------------------------------------------------------------

scenario("A22.5 POST /oauth/consent takes only the signed-in account's ID token from this origin's own page: the session cookie alone and a personal token are 401; cross-site, same-site and unlabelled requests are 403 even with a valid ID token, and a real cross-site page cannot get past that; a non-JSON body is 400 and GET 405, every answer private, no-store", {
  tiers: BOTH,
  inconclusiveOnCaseTimeout: true,
  timeoutMs: 240_000,
}, async (ctx) => {
  const { acct, session } = await owner();
  const http = ctx.http({ actor: "consent-probe", cutoffError: true });
  const reg = await client(http, [LOOPBACK_CB]);
  const params = authorizeParams({ clientId: reg.clientId, redirectUri: "http://127.0.0.1:1/callback", challenge: pkce().challenge });
  const body = { action: "describe", params };
  const bearer = { authorization: `Bearer ${session.idToken}` };
  const personal = await mintToken(session, { name: `e2e a22 consent ${tag()}`, channel: "mcp" });

  ctx.step("over HTTP: one request per row, all else equal");
  const rows = [
    ["ID token, same-origin (positive control)", http, { ...bearer, "sec-fetch-site": "same-origin" }, "application/json", 200, null],
    ["ID token, Origin of this site and no Sec-Fetch-Site (positive control)", http, { ...bearer, origin: target.origin }, "application/json", 200, null],
    ["the session cookie alone, same-origin", session.http, { "sec-fetch-site": "same-origin" }, "application/json", 401, MSG.signIn],
    ["a personal token, same-origin", http, { authorization: `Bearer ${personal.token}`, "sec-fetch-site": "same-origin" }, "application/json", 401, MSG.signIn],
    ["ID token, cross-site", http, { ...bearer, "sec-fetch-site": "cross-site" }, "application/json", 403, MSG.notOurPage],
    ["ID token, same-site", http, { ...bearer, "sec-fetch-site": "same-site" }, "application/json", 403, MSG.notOurPage],
    ["ID token, no Sec-Fetch-Site and no Origin", http, { ...bearer }, "application/json", 403, MSG.notOurPage],
    ["ID token, Origin of another site", http, { ...bearer, origin: `https://e2e-${tag()}.example` }, "application/json", 403, MSG.notOurPage],
    ["ID token, same-origin, text/plain", http, { ...bearer, "sec-fetch-site": "same-origin" }, "text/plain", 400, MSG.json],
  ];
  const got = [];
  const headerRows = [];
  for (const [label, sender, headers, contentType] of rows) {
    const r = await consentRaw(sender, { body, headers, contentType });
    got.push({ label, status: r.status, error: r.json?.error ?? null, valid: r.json?.valid ?? null });
    headerRows.push({ label, res: r, expect: { "cache-control": "private, no-store" } });
  }
  assert.deepEqual(got, rows.map(([label, , , , status, error]) => ({ label, status, error, valid: status === 200 ? true : null })), "consent requires the ID token and this origin");
  const get = await http.get("/oauth/consent");
  assert.deepEqual({ status: get.status, allow: get.headers.get("allow") }, { status: 405, allow: "POST" });
  headerRows.push({ label: "GET", res: get, expect: { "cache-control": "private, no-store" } });
  assertHeaderMatrix(headerRows);

  ctx.step("in a browser, signed in: from this origin's own page the same request is judged on its credential (cookie alone 401, text/plain 400, ID token 200)");
  const u = await ctx.users.user({ name: "owner" });
  const s = await u.signInUi(acct.email, acct.password);
  precondition(s.status === "ok", "signed in through the UI");
  await u.goto("/terms");
  const sameOrigin = await u.page.evaluate(async ({ body: b, idToken: tokn }) => {
    const send = async (headers, payload) => {
      const r = await fetch("/oauth/consent", { method: "POST", credentials: "include", headers, body: payload });
      let error = null;
      let valid = null;
      try {
        const j = await r.json();
        error = j.error ?? null;
        valid = j.valid ?? null;
      } catch {}
      return { status: r.status, error, valid };
    };
    return {
      cookie: await send({ "content-type": "application/json" }, JSON.stringify(b)),
      text: await send({ "content-type": "text/plain" }, JSON.stringify(b)),
      idToken: await send({ "content-type": "application/json", authorization: `Bearer ${tokn}` }, JSON.stringify(b)),
    };
  }, { body, idToken: await idToken(target, acct) });
  assert.deepEqual(sameOrigin, {
    cookie: { status: 401, error: MSG.signIn, valid: null },
    text: { status: 400, error: MSG.json, valid: null },
    idToken: { status: 200, error: null, valid: true },
  });

  ctx.step("from a cross-site page: the request a page can send without a preflight is refused 403 (not the 400 its body earns), and one that needs a preflight is never sent");
  // lib/browser.mjs: locally the stack's own Hosting under its other loopback name; on production a route-answered .example page.
  const site = await openCrossSitePage(u);
  precondition(new URL(site).origin !== target.origin, `the page is on another origin (${site})`);
  const mark = u.responseMark();
  const crossSite = await u.page.evaluate(async ({ origin, body: b, idToken: tokn }) => {
    const out = {};
    try {
      const r = await fetch(`${origin}/oauth/consent?e2e=simple`, { method: "POST", mode: "no-cors", credentials: "include", headers: { "content-type": "text/plain" }, body: JSON.stringify(b) });
      out.simple = r.type;
    } catch (e) {
      out.simple = `threw ${e.name}`;
    }
    try {
      await fetch(`${origin}/oauth/consent?e2e=preflighted`, { method: "POST", mode: "cors", credentials: "include", headers: { "content-type": "application/json", authorization: `Bearer ${tokn}` }, body: JSON.stringify(b) });
      out.preflighted = "sent";
    } catch (e) {
      out.preflighted = `threw ${e.name}`;
    }
    return out;
  }, { origin: target.origin, body, idToken: await idToken(target, acct) });
  const simple = answered(await u.waitForResponse((r) => r.method === "POST" && r.path === "/oauth/consent" && r.query.get("e2e") === "simple", { since: mark, timeout: ROUND_TRIP_MS }), "the cross-site page's simple POST /oauth/consent");
  ctx.step(`the page at ${site}: ${JSON.stringify(crossSite)}; the simple request was answered ${simple.status}`);
  assert.equal(simple.status, 403, "a cross-site page's simple request is refused by the site check (SPEC §23)");
  assert.deepEqual(crossSite, { simple: "opaque", preflighted: "threw TypeError" }, "the page reads nothing, and the preflighted request fails");
  assert.equal(u.findResponses((r) => r.method === "POST" && r.path === "/oauth/consent" && r.query.get("e2e") === "preflighted", { since: mark }).length, 0, "the preflighted POST never reached the server");
});

// --- A22.6 ------------------------------------------------------------------

/** /account for this user, with its token list past its spinner. */
async function openAccount(u, email) {
  await u.goto("/account");
  await u.page.getByRole("heading", { name: "Account", level: 1 }).waitFor({ timeout: 30_000 });
  await u.page.locator("p.caption", { hasText: email.toLowerCase() }).waitFor({ timeout: ROUND_TRIP_MS });
  await u.page.locator('.spinner[aria-label="Loading your tokens"]').waitFor({ state: "detached", timeout: ROUND_TRIP_MS });
}

scenario("A22.6 a connected app is listed on the account screen under where it returns, and Revoke there makes /mcp refuse its bsa_ with invalid_token and the token endpoint its bsr_; the command line's built-in client goes through the same consent page and gets an ordinary cli token named for its device, with no refresh token, that works beyond /mcp", {
  tiers: BOTH,
  inconclusiveOnCaseTimeout: true,
  timeoutMs: 360_000,
}, async (ctx) => {
  const t = tag();
  const { acct, session } = await owner();
  const http = ctx.http({ actor: "oauth-app", cutoffError: true });
  const webHost = `app-${t}.example`;
  const webRedirect = `https://${webHost}/cb`;
  const name = `E2E A22 revoke ${t}`;

  ctx.step("connect a registered app over the protocol (its redirect is https and never followed)");
  const reg = await register(http, { redirectUris: [webRedirect], clientName: name });
  assert.equal(reg.status, 201);
  const W = await connectViaApi(http, session, { clientId: reg.clientId, redirectUri: webRedirect });
  assert.equal((await mcpInit(ctx, W.pair.access_token, "app")).status, 200, "the app's bsa_ works");

  ctx.step("the account screen lists it as an app: its own name, quoted as unchecked, and the host it returns to");
  const u = await ctx.users.user({ name: "owner" });
  const s = await u.signInUi(acct.email, acct.password);
  precondition(s.status === "ok", "signed in through the UI");
  await openAccount(u, acct.email);
  const row = u.page.locator(`li.token-row[data-kind="app"]`, { hasText: name });
  await row.waitFor({ state: "visible", timeout: ROUND_TRIP_MS });
  assert.equal((await row.locator("strong q").textContent()).trim(), name, "an unchecked name is shown in quotes");
  assert.equal((await row.locator(".mono").textContent()).trim(), webHost);
  assert.match((await row.textContent()).replace(/\s+/g, " "), /· connected .* · /);

  ctx.step("Revoke on the account screen");
  const mark = u.toastMark();
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await u.waitForToast((x) => x.text === "Revoked.", { since: mark, timeout: ROUND_TRIP_MS });
  await eventually(async () => (await row.getAttribute("data-revoked")) === "true", { timeout: ROUND_TRIP_MS, message: "the row is marked revoked" });
  assert.equal(await row.getByRole("button", { name: "Revoke" }).count(), 0, "a revoked app offers no Revoke");

  ctx.step("/mcp refuses the bsa_ with the invalid_token challenge; the token endpoint refuses the bsr_");
  const probe = await mcpInit(ctx, W.pair.access_token, "app-after-revoke");
  assert.deepEqual(probe, { status: 401, challenge: challengeFor(true), cacheControl: "private, no-store" });
  const r = await refresh(http, { refreshToken: W.pair.refresh_token, clientId: reg.clientId });
  assert.deepEqual({ status: r.status, error: r.json?.error, d: r.json?.error_description }, { status: 400, error: "invalid_grant", d: MSG.disconnected });
  if (target.kind === "local") assert.ok((await readDoc(target, `tokens/${W.tokenId}`)).revokedAt, "tokens/{id}.revokedAt is set");

  ctx.step("the CLI's client: the same consent page says it is Bikeshed's command line on the reported device, and refuses any redirect but 127.0.0.1 or [::1]");
  const device = `e2e-host‮-${t}`;
  const cleanDevice = `e2e-host-${t}`;
  const tok = session.idToken;
  const cliRefused = {};
  for (const [label, uri] of [["localhost", "http://localhost:4321/callback"], ["https", `https://${webHost}/callback`], ["other path", "http://127.0.0.1:4321/cb"]]) {
    const d = await approveViaApi(http, tok, authorizeParams({ clientId: "bikeshed-cli", redirectUri: uri, challenge: pkce().challenge, extra: { device } }), { action: "describe" });
    cliRefused[label] = d.json?.valid === true ? "valid" : d.json?.error;
  }
  assert.deepEqual(cliRefused, { localhost: "invalid_redirect_uri", https: "invalid_redirect_uri", "other path": "invalid_redirect_uri" }, "the built-in CLI redirects only to its registered numeric loopback callback");

  const receiver = await startReceiver({ target, page: u });
  try {
    const p = pkce();
    const params = authorizeParams({ clientId: "bikeshed-cli", redirectUri: receiver.redirectUri, challenge: p.challenge, resource: RESOURCE(), extra: { device } });
    await u.goto(`/connect?${new URLSearchParams(params)}`);
    const card = u.page.locator(".connect-card");
    await u.page.getByRole("button", { name: "Approve", exact: true }).waitFor({ state: "visible", timeout: ROUND_TRIP_MS });
    assert.equal((await card.locator("h1").textContent()).trim(), "Connect Bikeshed command line to Bikeshed?");
    assert.equal((await card.locator(".connect-from").textContent()).replace(/\s+/g, " ").trim(), `Bikeshed's command line on ${cleanDevice} (as reported by the program)`);
    assert.equal(await card.locator(".chip-warn").count(), 0, "the built-in client is not flagged as unchecked");
    assert.match((await card.locator(".banner-warn").first().textContent()).replace(/\s+/g, " "), /That's a program on this computer\. Approve only if you just started it, for example with bikeshed login\./);
    await consent(u.page, { approve: true });
    const back = await receiver.received(ROUND_TRIP_MS);
    assert.deepEqual({ state: back.state, iss: back.iss, error: back.error }, { state: params.state, iss: ISSUER(), error: null });

    ctx.step("the exchange answers an ordinary personal token and nothing else: no refresh token, no expiry");
    const x = await exchangeCode(http, { code: back.code, verifier: p.verifier, clientId: "bikeshed-cli", redirectUri: receiver.redirectUri, resource: RESOURCE() });
    assert.equal(x.status, 200, JSON.stringify(x.json));
    assert.deepEqual(Object.keys(x.json).sort(), ["access_token", "token_type"], "no refresh_token (SPEC §23: parallel CLI processes would trip reuse detection)");
    assert.equal(x.json.token_type, "Bearer");
    const m = PERSONAL_RE.exec(x.json.access_token);
    assert.ok(m, "a bsk_ personal token");
    const tokenId = m[1];
    appendLedger(target, { kind: "token", tokenId, uid: session.uid, channel: "cli", name: `CLI on ${cleanDevice}` });
    const listed = ((await listTokens(session)).json?.tokens ?? []).filter((x2) => x2.tokenId === tokenId);
    assert.deepEqual(listed.map((l) => ({ name: l.name, channel: l.channel, kind: l.kind ?? null, revoked: l.revoked })), [{ name: `CLI on ${cleanDevice}`, channel: "cli", kind: null, revoked: false }]);

    ctx.step("it works at /mcp and beyond it: it publishes through POST /publish");
    assert.equal((await mcpInit(ctx, x.json.access_token, "cli-token")).status, 200);
    const up = await publish(bearerHttp(target, x.json.access_token, { actor: "cli-token", cutoffError: true }), { body: `<!doctype html><title>A22.6 ${t}</title><p>published with the CLI's token</p>`, filename: "a22.html", title: `A22.6 ${t}`, name: "a22-cli" });
    assert.equal(up.status, 200, `POST /publish with the cli token: ${up.status}`);
    if (target.kind === "local") assert.equal((await readDoc(target, `docs/${up.docId}`))?.ownerEmail, acct.email.toLowerCase(), "published as the account that approved");
  } finally {
    await receiver.close();
  }
  noPageErrors([u]);
});

// --- A22.7 ------------------------------------------------------------------

function stamp(buf) {
  return Buffer.from(buf.toString("utf8").split(STAMP_TOKEN).join(target.origin), "utf8");
}

scenario("A22.7 /llms.txt is the tree's agent guide stamped with this origin; /skills/index.json lists SPEC §19's four skills, each served stamped; /.well-known/mcp.json is served as written, every URL in it relative and answering here; /docs and /docs/ 302 to /d/docs and /docs/developers to /d/docs-developers; /terms and /privacy render for an anonymous visitor", {
  tiers: BOTH,
  inconclusiveOnCaseTimeout: true,
  timeoutMs: 180_000,
}, async (ctx) => {
  const http = ctx.http({ actor: "anonymous", cutoffError: true });

  ctx.step("/llms.txt: the agent guide, byte for byte, with every placeholder replaced by this origin");
  const guide = treeFile("docs/agents/agent-guide.md");
  precondition(treeFile("app/public/llms.txt").equals(guide), "the tree's app/public/llms.txt is the agent guide (check:agents)");
  precondition(guide.toString("utf8").includes(STAMP_TOKEN), "the guide has a placeholder to stamp");
  const llms = await http.get("/llms.txt");
  assert.equal(llms.status, 200);
  assert.match(llms.headers.get("content-type") ?? "", /^text\/plain/);
  assert.ok(llms.buffer.equals(stamp(guide)), `GET /llms.txt is the stamped guide (${llms.buffer.length} vs ${stamp(guide).length} bytes)`);
  assert.equal(llms.text.includes("<deployment>"), false, "no placeholder survives");

  ctx.step("/skills/index.json: exactly SPEC §19's four skills, each one's SKILL.md and archive served");
  const index = await http.get("/skills/index.json");
  assert.equal(index.status, 200);
  assert.ok(index.buffer.equals(stamp(treeFile("app/public/skills/index.json"))), "the served index is the tree's");
  const skills = index.json?.skills ?? [];
  assert.deepEqual(skills.map((s) => s.name).sort(), SPEC_SKILLS);
  for (const s of skills) {
    assert.deepEqual({ path: s.path, archive: s.archive }, { path: `skills/${s.name}/SKILL.md`, archive: `skills/${s.name}.zip` });
    const md = await http.get(`/${s.path}`);
    assert.equal(md.status, 200, s.path);
    assert.ok(md.buffer.equals(stamp(treeFile(`app/public/${s.path}`))), `${s.path} is served stamped`);
    assert.ok(md.text.startsWith(`---\nname: ${s.name}\n`), `${s.path} carries its name in its frontmatter`);
    assert.equal(md.text.includes("<deployment>"), false, `${s.path}: no placeholder survives`);
    const zip = await http.get(`/${s.archive}`);
    assert.deepEqual({ status: zip.status, type: zip.headers.get("content-type") }, { status: 200, type: "application/zip" }, s.archive);
  }

  ctx.step("/.well-known/mcp.json: served as the tree has it (nothing stamps it), every address in it relative, each one answering");
  const manifest = await http.get("/.well-known/mcp.json");
  assert.equal(manifest.status, 200);
  assert.ok(manifest.buffer.equals(treeFile("app/public/.well-known/mcp.json")), "served as written");
  const strings = [];
  const walk = (v, at) => {
    if (typeof v === "string") strings.push([at, v]);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
  };
  walk(manifest.json, "$");
  assert.deepEqual(strings.filter(([, v]) => /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.startsWith("//")), [], "no absolute URL anywhere in mcp.json");
  const m = manifest.json;
  const urls = { transport: m.transport?.url, resourceMetadata: m.authentication?.resourceMetadata, authorizationServer: m.authentication?.authorizationServer, instructions: m.authentication?.instructions };
  assert.deepEqual(urls, { transport: "/mcp", resourceMetadata: "/.well-known/oauth-protected-resource/mcp", authorizationServer: "/.well-known/oauth-authorization-server", instructions: "/llms.txt" });
  const answers = {
    transport: (await ctx.mcp({ actor: "anonymous", cutoffError: true }).raw({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { path: urls.transport })).status,
    resourceMetadata: (await http.get(urls.resourceMetadata)).json?.resource ?? null,
    authorizationServer: (await http.get(urls.authorizationServer)).json?.issuer ?? null,
    instructions: (await http.get(urls.instructions)).status,
  };
  assert.deepEqual(answers, { transport: 401, resourceMetadata: RESOURCE(), authorizationServer: ISSUER(), instructions: 200 });

  ctx.step("the /docs redirects are 302s to the documentation documents");
  const redirects = {};
  for (const path of ["/docs", "/docs/", "/docs/developers"]) {
    const r = await http.get(path);
    redirects[path] = `${r.status} ${r.headers.get("location") ? new URL(r.headers.get("location"), target.origin).href : "(none)"}`;
  }
  assert.deepEqual(redirects, {
    "/docs": `302 ${target.origin}/d/docs`,
    "/docs/": `302 ${target.origin}/d/docs`,
    "/docs/developers": `302 ${target.origin}/d/docs-developers`,
  }, "documentation routes preserve their exact destinations");

  ctx.step("the legal pages render for somebody who is not signed in, and stay where they are");
  const u = await ctx.users.user({ name: "anonymous" });
  for (const [path, heading] of [["/terms", "Terms of service"], ["/privacy", "Privacy policy"]]) {
    await u.goto(path);
    await u.page.getByRole("heading", { name: heading, level: 1 }).waitFor({ timeout: 30_000 });
    assert.equal(new URL(u.page.url()).pathname, path, `${path} is not redirected`);
    assert.match(await u.page.locator(".legal__updated").textContent(), /^Last updated /);
    assert.deepEqual(await u.page.locator(".legal__nav a").allTextContents(), ["Back to your documents", "Terms", "Privacy"]);
  }
  noPageErrors([u]);
});


scenario("A22.8 resource and client binding reject authorization, access and refresh at the wrong target without disconnecting the valid grant", {
  tiers: ["local"], inconclusiveOnCaseTimeout: true, timeoutMs: 240_000,
}, async (ctx) => {
  const { session } = await owner();
  const http = ctx.http({ actor: "oauth-binding", cutoffError: true });
  const redirectUri = "http://127.0.0.1:1/callback";
  const registered = await client(http, [LOOPBACK_CB]);
  const otherClient = await client(http, [LOOPBACK_CB]);
  const wrongResource = `${target.origin}/not-mcp`;
  for (const action of ["describe", "approve"]) {
    const refused = await approveViaApi(http, session.idToken, authorizeParams({ clientId: registered.clientId, redirectUri, challenge: pkce().challenge, resource: wrongResource }), { action });
    assert.equal(refused.json?.error, "invalid_target", `${action} refuses another resource`);
  }
  const grant = await connectViaApi(http, session, { clientId: registered.clientId, redirectUri, resource: RESOURCE() });
  const otherOrigin = new URL(target.origin);
  otherOrigin.hostname = "localhost";
  const wrongAccess = await http.postJson(`${otherOrigin.origin}/mcp`, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "a22", version: "1" } } }, { headers: { authorization: `Bearer ${grant.pair.access_token}` } });
  assert.equal(wrongAccess.status, 401, "an access token is refused by another resource authority");
  assert.match(wrongAccess.headers.get("www-authenticate") ?? "", /error="invalid_token"/, "wrong-resource access carries the invalid-token challenge");
  for (const [label, fields, error, description] of [
    ["resource", { clientId: registered.clientId, resource: wrongResource }, "invalid_target", "refresh token was issued for another resource"],
    ["client", { clientId: otherClient.clientId, resource: RESOURCE() }, "invalid_grant", "refresh token was issued to another client"],
  ]) {
    const refused = await refresh(http, { refreshToken: grant.pair.refresh_token, ...fields });
    assert.deepEqual({ status: refused.status, error: refused.json?.error, description: refused.json?.error_description }, { status: 400, error, description }, `refresh refuses another ${label} without spending the secret`);
    assert.equal((await mcpInit(ctx, grant.pair.access_token, `after-wrong-${label}`)).status, 200, `wrong ${label} never revokes the legitimate connection`);
  }
  const valid = await refresh(http, { refreshToken: grant.pair.refresh_token, clientId: registered.clientId, resource: RESOURCE() });
  assert.equal(valid.status, 200, "the original refresh token still works at its own resource and client");
});


scenario("A22.2b consent loses its armed state while another page has focus and waits a fresh second after focus returns", {
  tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 240_000,
}, async (ctx) => {
  const { acct } = await owner();
  const http = ctx.http({ actor: "oauth-focus", cutoffError: true });
  const registered = await client(http, [LOOPBACK_CB]);
  const u = await ctx.users.user({ name: "consent-focus" });
  await armingProbe(u);
  precondition((await u.signInUi(acct.email, acct.password)).status === "ok", "the owner signed in");
  const focus = await realPageFocus(u);
  try {
    await u.goto(connectPath(authorizeParams({ clientId: registered.clientId, redirectUri: "http://127.0.0.1:1/callback", challenge: pkce().challenge })));
    const approve = u.page.getByRole("button", { name: "Approve", exact: true });
    await approve.waitFor({ state: "visible", timeout: ROUND_TRIP_MS });
    await u.page.bringToFront();
    await u.page.keyboard.press("Shift");
    await eventually(() => approve.isEnabled(), { timeout: 5_000, interval: 40, message: "the focused page arms after input and a second" });
    await focus.blur();
    const blurred = await eventually(() => u.page.evaluate(() => !document.hasFocus()), { timeout: 3_000, interval: 40, message: "the browser gives actual focus to the other page" }).catch(() => false);
    if (!blurred) ctx.inconclusive("this browser did not expose a real focus transition after disabling focus emulation");
    await sleep(1500);
    assert.equal(await approve.isDisabled(), true, "consent stays disarmed after a full second without focus");
    await u.page.bringToFront();
    const focusedAt = await eventually(async () => {
      const record = await readArming(u);
      return record.focusChanges.filter((f) => f.type === "focus" && f.hasFocus).at(-1)?.t ?? false;
    }, { timeout: 3_000, interval: 20, message: "the probe records returning focus" });
    assert.equal(await approve.isDisabled(), true, "returning focus does not arm consent immediately");
    await eventually(() => approve.isEnabled(), { timeout: 5_000, interval: 30, message: "a new focused second arms consent again" });
    const record = await readArming(u);
    ctx.ev.json("focus-rearming", record);
    const armedAt = record.states.find((state) => state.t >= focusedAt && state.present && !state.disabled)?.t;
    assert.ok(armedAt != null && armedAt - focusedAt >= 990, `consent waits a fresh focused second: ${armedAt - focusedAt} ms`);
  } finally {
    await focus.restore();
  }
});
