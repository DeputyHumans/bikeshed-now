// SPDX-License-Identifier: Apache-2.0
// The OAuth side of connecting an app: discovery, DCR, PKCE, a loopback receiver, token exchange, and the consent driver (SPEC §23).

/**
 * The protocol half runs in Node through http.mjs (guarded, traced):
 *
 *   discover(http)              both metadata documents (and their headers)
 *   register(http, {...})       POST /oauth/register → bsdcr_ client id
 *   pkce()                      {verifier, challenge, method: "S256"}
 *   authorizeUrl(target, {...}) the /connect address a browser opens
 *   approveViaApi(http, …)      POST /oauth/consent as the consent page does it
 *                               (ID token + same-origin), for protocol cases
 *                               that are not about the page itself
 *   exchangeCode(http, …), refresh(http, …)   POST /oauth/token, form-encoded
 *   startReceiver({...})        where the redirect lands: a loopback HTTP
 *                               server, or (`via: "route"`) an answer inside
 *                               the browser that follows it
 *
 * The browser half is `consent(page, {approve})`. Approve is disabled until the
 * page has been visible and focused for ARM_DELAY_MS AND a pointer move or key
 * press has reached it — from listeners an effect attaches a turn AFTER the
 * render that shows the button. So the driver brings the page to the front and
 * keeps moving the pointer across the card for the whole wait, until Approve
 * is enabled, and only then clicks. A single early move can land before the
 * listeners exist and never arm the page (the CI failure fixed in 391e8ab).
 *
 * MEASURING THE ARMING. consent() drives the arming; `armingProbe(page)`
 * measures it, in the page and on the page's own clock (`performance.timeOrigin
 * + performance.now()`), so the one-second delay and the input requirement are
 * judged from the times the page itself saw, never from this process's clock,
 * which lags a CDP round trip or more under load. It is an init script, so it
 * is in every /connect document from before that document's first script:
 * a MutationObserver records the exact DOM change at which Approve appeared
 * and at which it stopped being disabled (no poll), and capture-phase window
 * listeners record every pointermove and keydown, and every focus, blur and
 * visibilitychange, before the page's own listeners see them
 * (app/src/pages/Connect.tsx useArmed listens for exactly these). It adds no
 * node and no attribute: the record lives in `window[Symbol.for(ARMING_KEY)]`.
 * `readArming(page)` reads the current document's record.
 *
 * WHERE THE REDIRECT LANDS. The consent page sends the browser back with
 * `location.assign(<redirect>)` (app/src/oauth.ts leave). A socket receiver's
 * wait() resolves when that request ARRIVES, which is before the browser has
 * committed the navigation, so a goto straight after it is "interrupted by
 * another navigation". Given the `page` that follows the redirect,
 * `received()` also waits until that page has loaded the receiver's address.
 * On production a browser may not navigate to loopback at all (the tripwire
 * calls it an isolation breach), so there the receiver is a ROUTE on the
 * page's context: the redirect is answered inside the browser, as an MCP
 * client's own listener would answer it, and nothing binds a socket or leaves
 * the browser. `via: "route"` does the same on a local stack, so the
 * production path runs where it can be watched.
 *
 * WHEN NO REDIRECT COMES. The consent page leaves only once its own POST
 * /oauth/consent has answered 2xx: on a 4xx or 5xx it shows its failure view
 * and has nowhere to go (app/src/pages/Connect.tsx decide, app/src/oauth.ts
 * consent). On a loaded stack that POST can get Hosting's 504 at its 60 s
 * cut-off, and a bare "no redirect reached the receiver" reads like a product
 * or harness fault. So a receiver given a `page` watches, from its start,
 * every POST /oauth/consent that page's context sends for ITS redirect (the
 * body's `params.redirect_uri`; a body that names another is another
 * receiver's), and its timeout names each one's answer, or that none was
 * sent. Receivers on one context share one set of listeners, detached when
 * the last of them closes.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { claimSparePort } from "./spare.mjs";

export const ARM_DELAY_MS = 1000;

/** Where armingProbe keeps its record in the page: `window[Symbol.for(ARMING_KEY)]`. */
export const ARMING_KEY = "bikeshed-e2e.consent-arming";

/**
 * The ports a route receiver writes into its redirect URI. Nothing ever binds
 * one: the browser's route answers it. They lie above the harness's
 * 30000–39999 blocks and away from the 1xxxx/2xxxx ports other sessions use,
 * so a request the route misses is never a stack's port either: the
 * isolation tripwire aborts it as a breach, on any target.
 */
export const ROUTE_RECEIVER_PORTS = Object.freeze({ min: 40000, max: 48999 });

/** What a receiver answers the redirect with. */
const RECEIVER_PAGE = "<!doctype html><title>e2e receiver</title><p>Received. You can close this window.</p>";

/** A Playwright Page, from a Page or a lib/browser.mjs User. */
function pageOf(host) {
  return host && host.page && typeof host.page.goto === "function" ? host.page : host;
}

/** RFC 7636 S256: a 43-character verifier and its challenge. */
export function pkce(verifier = randomBytes(32).toString("base64url")) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error("pkce: a verifier is 43–128 unreserved characters");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function randomState() {
  return randomBytes(16).toString("base64url");
}

/** Both discovery documents, with the responses for header oracles. */
export async function discover(http) {
  const prm = await http.get("/.well-known/oauth-protected-resource/mcp");
  const prmRoot = await http.get("/.well-known/oauth-protected-resource");
  const as = await http.get("/.well-known/oauth-authorization-server");
  const oidc = await http.get("/.well-known/openid-configuration");
  return { prm: prm.json, prmRoot: prmRoot.json, as: as.json, responses: { prm, prmRoot, as, oidc } };
}

/** Dynamic client registration → {status, json, clientId}. */
export async function register(http, { redirectUris, clientName = "bikeshed-e2e client", extra = {} } = {}) {
  const r = await http.postJson("/oauth/register", { redirect_uris: redirectUris, client_name: clientName, token_endpoint_auth_method: "none", ...extra });
  return { status: r.status, json: r.json, clientId: r.json?.client_id, response: r };
}

/** The authorize parameters a client sends, as an object. */
export function authorizeParams({ clientId, redirectUri, challenge, state = randomState(), resource, extra = {} }) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...(resource ? { resource } : {}),
    ...extra,
  };
}

/** The /connect address for those parameters (authorization_endpoint from metadata if given). */
export function authorizeUrl(target, params, authorizationEndpoint = `${target.origin}/connect`) {
  const u = new URL(authorizationEndpoint);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * POST /oauth/consent as the consent page does: the signed-in account's ID
 * token, JSON, and a same-origin request.
 * @returns {Promise<{status, json, redirect, code, iss, state, error}>}
 */
export async function approveViaApi(http, idToken, params, { action = "approve", headers = {} } = {}) {
  const r = await http.postJson(
    "/oauth/consent",
    { action, params },
    { headers: { authorization: `Bearer ${idToken}`, origin: http.target.origin, "sec-fetch-site": "same-origin", ...headers } },
  );
  const redirect = r.json?.redirect;
  let code;
  let iss;
  let state;
  let error;
  if (typeof redirect === "string") {
    const q = new URL(redirect).searchParams;
    code = q.get("code") ?? undefined;
    iss = q.get("iss") ?? undefined;
    state = q.get("state") ?? undefined;
    error = q.get("error") ?? undefined;
  }
  return { status: r.status, json: r.json, redirect, code, iss, state, error, response: r };
}

/** POST /oauth/token grant_type=authorization_code, form-encoded. */
export async function exchangeCode(http, { code, verifier, clientId, redirectUri, resource, extra = {} }) {
  const form = { grant_type: "authorization_code", code, code_verifier: verifier, ...(clientId ? { client_id: clientId } : {}), ...(redirectUri ? { redirect_uri: redirectUri } : {}), ...(resource ? { resource } : {}), ...extra };
  const r = await http.request("POST", "/oauth/token", { form, headers: { accept: "application/json" } });
  return { status: r.status, json: r.json, response: r };
}

/** POST /oauth/token grant_type=refresh_token. */
export async function refresh(http, { refreshToken, clientId, resource, extra = {} }) {
  const form = { grant_type: "refresh_token", refresh_token: refreshToken, ...(clientId ? { client_id: clientId } : {}), ...(resource ? { resource } : {}), ...extra };
  const r = await http.request("POST", "/oauth/token", { form, headers: { accept: "application/json" } });
  return { status: r.status, json: r.json, response: r };
}

/** Route receivers alive in this process, by port, so two never share an address. */
const routePortsInUse = new Set();

function routePort() {
  const { min, max } = ROUTE_RECEIVER_PORTS;
  for (let i = 0; i < 200; i++) {
    const p = min + Math.floor(Math.random() * (max - min + 1));
    if (!routePortsInUse.has(p)) return p;
  }
  throw new Error(`startReceiver: no free route port in ${min}–${max} after 200 tries (${routePortsInUse.size} receivers alive in this process)`);
}

/** The consent page's own request: what it sends to describe, approve or deny. */
const CONSENT_PATH = "/oauth/consent";
/** How many of a receiver's consent rows its timeout message names (the latest; the rest are counted). */
const CONSENT_ROWS_NAMED = 6;

/**
 * One set of listeners per browser context, shared by every receiver
 * watching a page of it: `request`, `response` and `requestfailed`, attached
 * with the first watcher and detached with the last. Each POST
 * /oauth/consent is handed to every watcher with its parsed body (null when
 * it is not JSON); a watcher keeps only its own.
 */
const consentHubs = new WeakMap();

function consentHub(context) {
  let hub = consentHubs.get(context);
  if (hub) return hub;
  const watchers = new Set();
  const onRequest = (req) => {
    let url;
    let body = null;
    try {
      if (req.method() !== "POST") return;
      url = new URL(req.url());
      if (url.pathname !== CONSENT_PATH) return;
      body = JSON.parse(req.postData() ?? "");
    } catch {
      if (!url || url.pathname !== CONSENT_PATH) return; // not one, or unreadable: not the consent page's
    }
    for (const w of watchers) w.request(req, url, body);
  };
  const onResponse = (res) => {
    for (const w of watchers) w.response(res);
  };
  const onFailed = (req) => {
    for (const w of watchers) w.failed(req);
  };
  hub = {
    add(w) {
      if (watchers.size === 0) {
        context.on("request", onRequest);
        context.on("response", onResponse);
        context.on("requestfailed", onFailed);
      }
      watchers.add(w);
    },
    remove(w) {
      if (!watchers.delete(w) || watchers.size > 0) return;
      context.off("request", onRequest);
      context.off("response", onResponse);
      context.off("requestfailed", onFailed);
    },
  };
  consentHubs.set(context, hub);
  return hub;
}

/**
 * Watch, from now on, the POST /oauth/consent requests a page of `context`
 * sends for `redirectUri`: those whose body's `params.redirect_uri` is it, or
 * that name none (an unreadable body is kept, not hidden); with `origin`, only
 * to that origin. One row each, in the order sent, `{method: "POST", path:
 * "/oauth/consent", action, state: "sent"|"answered"|"failed", status, ms,
 * failure, t, at}` on Date.now()'s clock (as lib/browser.mjs measures a
 * response: from the request event to the response event). `snapshot()` copies
 * them, an unanswered row's `ms` the wait so far; `stop()` stops watching.
 */
function watchConsent(context, { redirectUri, origin }) {
  const rows = [];
  const byRequest = new WeakMap();
  const watcher = {
    request(req, url, body) {
      if (origin && url.origin !== origin) return;
      const named = body?.params?.redirect_uri;
      if (typeof named === "string" && named !== redirectUri) return; // another receiver's
      const row = { method: "POST", path: CONSENT_PATH, action: typeof body?.action === "string" ? body.action : null, state: "sent", status: null, ms: null, failure: null, t: Date.now(), at: null };
      rows.push(row);
      byRequest.set(req, row);
    },
    response(res) {
      let row;
      try {
        row = byRequest.get(res.request());
      } catch {
        return;
      }
      if (!row || row.state !== "sent") return;
      row.at = Date.now();
      row.ms = row.at - row.t;
      row.state = "answered";
      try {
        row.status = res.status();
      } catch {
        row.status = null;
      }
    },
    failed(req) {
      const row = byRequest.get(req);
      if (!row || row.state !== "sent") return; // a failure after the headers keeps the answer
      row.at = Date.now();
      row.ms = row.at - row.t;
      row.state = "failed";
      try {
        row.failure = req.failure()?.errorText ?? "failed";
      } catch {
        row.failure = "failed";
      }
    },
  };
  const hub = consentHub(context);
  hub.add(watcher);
  return {
    snapshot() {
      const t = Date.now();
      return rows.map((r) => ({ ...r, ms: r.state === "sent" ? t - r.t : r.ms }));
    },
    stop: () => hub.remove(watcher),
  };
}

/** The answer that left the consent page nowhere to go: the latest row, when it answered 4xx or 5xx; else null. */
function consentRefusal(rows) {
  const last = rows.at(-1);
  return last && last.state === "answered" && Number.isInteger(last.status) && last.status >= 400 ? last : null;
}

/** What a receiver's timeout adds about the consent page's POSTs (see the header). Never an origin or a query. */
function consentWords(rows, refusal) {
  if (rows.length === 0) return "; the page sent no POST /oauth/consent for this redirect after the receiver started";
  const one = (r) => {
    const ms = `${Math.round(r.ms)} ms`;
    const what = r.state === "answered" ? `${r.status} after ${ms}` : r.state === "failed" ? `failed (${r.failure}) after ${ms}` : `unanswered after ${ms}`;
    return `${r.action ?? "(no action)"} ${what}`;
  };
  const named = rows.slice(-CONSENT_ROWS_NAMED);
  const earlier = rows.length - named.length;
  const list = `${earlier ? `${earlier} earlier, then ` : ""}${named.map(one).join(", ")}`;
  return `; the page's POST /oauth/consent for this redirect: ${list}${refusal ? `; the last answered ${refusal.status}, so the consent page had nowhere to go` : ""}`;
}

/**
 * A receiver for the authorization redirect.
 *
 * `via: "socket"` (the default on a local target, and wherever no `page` is
 * given) binds an HTTP server on 127.0.0.1. With a local `target` and no
 * `port`, on a port CLAIMED from the stack's spare pool (lib/spare.mjs) — a
 * stack port, because a browser following the redirect to any other loopback
 * port trips the isolation check, and claimed, so concurrent spec files on one
 * stack each get their own; the claim is released by close() (or if listening
 * fails). Otherwise on `port` (0 = ephemeral).
 *
 * `via: "route"` (the default when a `page` is given on any target but a local
 * one) binds nothing: it routes `http://127.0.0.1:<port>` on the page's
 * context and answers there, so the redirect never leaves the browser. `port`
 * is then only the number in the URI (by default an unused one in
 * ROUTE_RECEIVER_PORTS). Every request to that origin is answered: `path`
 * with the receiver's page, anything else (a favicon) 404. It needs `page`.
 * The page it serves is not on loopback to Chrome's local-network rules, so
 * Chrome refuses any request it makes to another loopback port (it makes
 * none). A socket receiver with a `page` on a non-local target is refused:
 * that browser may not navigate to loopback.
 *
 * Either way the first request to `path` resolves wait() with its query.
 *
 * @param {object} [o]
 * @param {object} [o.page]            the Page (or User) whose navigation follows the redirect
 * @param {"socket"|"route"} [o.via]
 * @param {number} [o.claimTimeoutMs]  how long to wait for a free spare port
 * @returns {Promise<{via, redirectUri, port, claim,
 *   wait(timeoutMs?): Promise<{code, state, iss, error, query, url}>,
 *   received(timeoutMs?): Promise<{code, state, iss, error, query, url}>,
 *   heard(): boolean, requests: Array<{t, method, path}>, close()}>}
 *   Either wait rejects E2E_OAUTH_TIMEOUT with `consent` and, sometimes,
 *   `response` (below).
 *
 * `received(timeoutMs = 30_000)` is wait(), and then, with a `page`, until
 * that page has COMMITTED and LOADED the receiver's address, within the same
 * `timeoutMs` (without a page it is wait()). Use it whenever a browser
 * follows the redirect; it throws E2E_OAUTH_TIMEOUT naming where the page is
 * (origin and path only: the query holds the code). `heard()` says, without
 * waiting, whether a request to `path` has arrived. `requests` (live) is one
 * row per request the receiver answered, any path, `{t, method, path}`
 * (never the query). `url` is the full address the request named.
 *
 * When no redirect comes, wait() and received() reject E2E_OAUTH_TIMEOUT
 * "no redirect reached the receiver within <timeoutMs> ms", and with a `page`
 * that message goes on to name what the consent page's own POST
 * /oauth/consent answered (see the header), as
 * "; the page's POST /oauth/consent for this redirect: describe 200 after
 * 412 ms, approve 504 after 60008 ms; the last answered 504, so the consent
 * page had nowhere to go", or "approve unanswered after 30002 ms", or "the
 * page sent no POST /oauth/consent for this redirect after the receiver
 * started". The error carries:
 *   consent   null without a page (nothing was watched); else one row per
 *             such POST since startReceiver, oldest first: `{method: "POST",
 *             path: "/oauth/consent", action ("describe", "approve", "deny";
 *             null when the body does not say), state ("sent": no answer yet,
 *             "answered", "failed": no answer will come), status (null unless
 *             answered), ms (the wait for its answer, or so far), failure
 *             (Playwright's errorText, when failed), t (when it was sent) and
 *             at (when it was answered or failed, else null), both
 *             Date.now()}`. A body naming another redirect_uri is left out:
 *             that is another receiver's. The message names the latest six
 *             and counts the rest ("2 earlier, then …").
 *   response  the last row, only when it ANSWERED 4xx or 5xx (what left the
 *             page nowhere to go); else absent. So Hosting's 504 at its
 *             cut-off is the stack not answering to lib/test.mjs
 *             stackDidNotAnswer (`inconclusiveOnStackTimeout`), and a quicker
 *             error is the product's answer, judged: pageStall and
 *             functionKill never excuse an error carrying `response`. With no
 *             such answer (none sent, still unanswered, failed, or 2xx) the
 *             error is the wait it always was.
 * The first clause is unchanged, so "within <timeoutMs> ms" is still how the
 * judges read the wait's length.
 */
export async function startReceiver({ target, host = "127.0.0.1", port, path = "/callback", claimTimeoutMs, page = null, via } = {}) {
  const pg = page ? pageOf(page) : null;
  const remote = Boolean(target) && target.kind !== "local";
  via ??= pg && remote ? "route" : "socket";
  if (via !== "socket" && via !== "route") throw new TypeError(`startReceiver: via is "socket" or "route", not ${JSON.stringify(via)}`);
  if (via === "route" && !pg) throw new TypeError('startReceiver: via "route" answers the redirect inside the browser, so it needs the page that follows it ({page})');
  if (via === "socket" && pg && remote) {
    throw new Error(`startReceiver: a browser on a ${target.kind} target may not navigate to loopback (an isolation breach): use via "route", which answers the redirect inside the browser`);
  }

  let deliver;
  const got = new Promise((r) => (deliver = r));
  let heardIt = false;
  const requests = [];
  /** One request to the receiver's origin: a row, and the delivery if it is the first to `path`. */
  const hit = (method, u) => {
    requests.push({ t: Date.now(), method, path: u.pathname });
    if (u.pathname !== path) return false;
    if (!heardIt) {
      heardIt = true;
      const q = u.searchParams;
      deliver({ code: q.get("code"), state: q.get("state"), iss: q.get("iss"), error: q.get("error"), query: Object.fromEntries(q), url: u.toString() });
    }
    return true;
  };
  /** The consent page's POSTs for this redirect, once the address is known and only with a page (see the header). */
  let consentWatch = null;
  /** The timeout: the wait's own words first, then what the consent page's POSTs answered. */
  const noRedirect = (timeoutMs) => {
    const rows = consentWatch ? consentWatch.snapshot() : null;
    const refusal = rows ? consentRefusal(rows) : null;
    const err = new Error(`no redirect reached the receiver within ${timeoutMs} ms${rows ? consentWords(rows, refusal) : ""}`);
    err.code = "E2E_OAUTH_TIMEOUT";
    err.consent = rows;
    if (refusal) err.response = refusal;
    return err;
  };
  const wait = (timeoutMs = 30_000) =>
    Promise.race([
      got,
      new Promise((_, rej) => setTimeout(() => rej(noRedirect(timeoutMs)), timeoutMs).unref()),
    ]);

  let origin;
  let close;
  let claim = null;
  let bound;
  if (via === "route") {
    if (port === undefined || port === null) port = routePort();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError(`startReceiver: a route receiver's port is 1–65535, not ${port}`);
    if (routePortsInUse.has(port)) throw new Error(`startReceiver: a route receiver on port ${port} is already alive in this process`);
    origin = `http://${host}:${port}`;
    const ctx = pg.context();
    const match = (u) => u.origin === origin;
    const handler = (route) => {
      const req = route.request();
      const onPath = hit(req.method(), new URL(req.url()));
      const answer = onPath
        ? { status: 200, contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store" }, body: RECEIVER_PAGE }
        : { status: 404, contentType: "text/plain", body: "not here" };
      return route.fulfill(answer).catch(() => undefined);
    };
    routePortsInUse.add(port);
    try {
      await ctx.route(match, handler);
    } catch (err) {
      routePortsInUse.delete(port);
      throw err;
    }
    bound = port;
    let closing = null;
    close = () =>
      (closing ??= Promise.resolve()
        .then(() => ctx.unroute(match, handler))
        .catch(() => undefined)
        .finally(() => routePortsInUse.delete(bound)));
  } else {
    if (port === undefined) {
      if (target?.kind === "local") {
        claim = await claimSparePort(target, { purpose: "oauth-receiver", ...(claimTimeoutMs ? { timeoutMs: claimTimeoutMs } : {}) });
        port = claim.port;
      } else port = 0;
    }
    const server = createServer((req, res) => {
      const u = new URL(req.url, origin);
      if (!hit(req.method, u)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not here");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(RECEIVER_PAGE);
    });
    try {
      await new Promise((res, rej) => {
        server.once("error", rej);
        server.listen(port, host, res);
      });
    } catch (err) {
      claim?.release();
      throw err;
    }
    bound = server.address().port;
    origin = `http://${host}:${bound}`;
    let closing = null;
    /** Stop listening (keep-alive sockets a browser left open included) and release the spare-port claim. */
    close = () =>
      (closing ??= new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      }).finally(() => claim?.release()));
  }

  const redirectUri = `${origin}${path}`;
  if (pg) {
    try {
      consentWatch = watchConsent(pg.context(), { redirectUri, origin: target?.origin ? new URL(target.origin).origin : null });
    } catch (err) {
      await close();
      throw err;
    }
    const unwatched = close;
    close = () => {
      consentWatch.stop();
      return unwatched();
    };
  }

  return {
    via,
    port: bound,
    claim,
    redirectUri,
    wait,
    async received(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      const delivered = await wait(timeoutMs);
      if (!pg) return delivered;
      try {
        await pg.waitForURL((u) => u.origin === origin && u.pathname === path, { waitUntil: "load", timeout: Math.max(1, deadline - Date.now()) });
      } catch (err) {
        let at;
        try {
          const now = new URL(pg.url());
          at = `${now.origin}${now.pathname}`;
        } catch {
          at = "an unreadable address";
        }
        throw Object.assign(new Error(`the redirect reached the receiver, but the page did not load ${origin}${path} within ${timeoutMs} ms; the page is at ${at}`), { code: "E2E_OAUTH_TIMEOUT", cause: err });
      }
      return delivered;
    },
    heard: () => heardIt,
    requests,
    close,
  };
}

function buttonsOf(page) {
  return {
    approve: page.getByRole("button", { name: "Approve", exact: true }),
    cancel: page.getByRole("button", { name: "Cancel", exact: true }),
  };
}

/** Pages armingProbe was installed on, with its options. */
const probes = new WeakMap();

/**
 * Runs in the page, as an init script (so in every document of the page, and
 * of its child frames, from before their first script): records the arming of
 * the button labelled `label` on `path`. See the header.
 */
function armingRecorder({ key, path, label }) {
  if (window !== window.top) return;
  if (location.pathname !== path) return;
  const sym = Symbol.for(key);
  if (window[sym]) return;
  const clock = () => performance.timeOrigin + performance.now();
  const p = { path, label, installedAt: clock(), appeared: null, enabled: null, focusAtAppear: null, visibleAtAppear: null, moves: [], keys: [], states: [], focusChanges: [] };
  Object.defineProperty(window, sym, { value: p, configurable: true });
  const opts = { capture: true, passive: true };
  window.addEventListener("pointermove", () => p.moves.push(clock()), opts);
  window.addEventListener("keydown", () => p.keys.push(clock()), opts);
  const focusRow = (e) => p.focusChanges.push({ t: clock(), type: e.type, hasFocus: document.hasFocus(), visibility: document.visibilityState });
  // A capture listener on window also hears every element's focus and blur: keep the window's own.
  window.addEventListener("focus", (e) => e.target === window && focusRow(e), opts);
  window.addEventListener("blur", (e) => e.target === window && focusRow(e), opts);
  document.addEventListener("visibilitychange", focusRow, opts);
  let last = null;
  const find = () => {
    for (const b of document.querySelectorAll("button")) if (b.textContent.trim() === label) return b;
    return null;
  };
  const tick = () => {
    const b = find();
    const present = b !== null;
    const disabled = b ? b.disabled : null;
    if (last && last.present === present && last.disabled === disabled) return;
    const t = clock();
    last = { t, present, disabled };
    p.states.push(last);
    if (present && p.appeared === null) {
      p.appeared = t;
      p.focusAtAppear = document.hasFocus();
      p.visibleAtAppear = document.visibilityState;
    }
    if (present && !disabled && p.enabled === null) p.enabled = t;
  };
  new MutationObserver(tick).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["disabled"] });
  tick();
}

/**
 * Install the arming probe on a page (a Playwright Page or a User): from the
 * NEXT document on, every top-level document at `path` records, on the page's
 * clock (`performance.timeOrigin + performance.now()`):
 *
 *   appeared         when the button labelled `label` first existed
 *   enabled          when it first existed without `disabled` (null: never)
 *   focusAtAppear    document.hasFocus() at `appeared`
 *   visibleAtAppear  document.visibilityState at `appeared`
 *   moves, keys      the time of every pointermove and keydown that reached the window
 *   states           [{t, present, disabled}] at each change of the button,
 *                    the first row the state at install (present: false)
 *   focusChanges     [{t, type: focus|blur|visibilitychange, hasFocus, visibility}]
 *
 * Install it BEFORE the goto that opens the page: the document already shown
 * when it is called has no record (readArming → null until the next load).
 * Once per page; again with the same options is a no-op, with others it
 * throws. The record lives in `window[Symbol.for(ARMING_KEY)]`: no node, no
 * attribute, nothing the page can see unless it looks for that symbol.
 * @returns {Promise<{path, label}>}
 */
export async function armingProbe(host, { path = "/connect", label = "Approve" } = {}) {
  const page = pageOf(host);
  if (!page || typeof page.addInitScript !== "function") throw new TypeError("armingProbe: a Playwright Page or a User");
  if (typeof path !== "string" || !path.startsWith("/")) throw new TypeError(`armingProbe: path is a pathname, not ${JSON.stringify(path)}`);
  if (typeof label !== "string" || label.trim() === "" || label !== label.trim()) throw new TypeError(`armingProbe: label is the button's text, not ${JSON.stringify(label)}`);
  const had = probes.get(page);
  if (had) {
    if (had.path === path && had.label === label) return { ...had };
    throw new Error(`armingProbe: this page already records ${had.label} on ${had.path}; one probe per page`);
  }
  const options = { path, label };
  probes.set(page, options);
  try {
    await page.addInitScript(armingRecorder, { key: ARMING_KEY, path, label });
  } catch (err) {
    probes.delete(page);
    throw err;
  }
  return { ...options };
}

/**
 * The current document's arming record (see armingProbe), copied, with `now`
 * the page's clock at the read; null when the document has none (another
 * path, or loaded before armingProbe).
 * @returns {Promise<null|{path, label, installedAt, appeared, enabled, focusAtAppear, visibleAtAppear, moves: number[], keys: number[], states: Array<{t, present, disabled}>, focusChanges: Array<{t, type, hasFocus, visibility}>, now: number}>}
 */
export async function readArming(host) {
  const page = pageOf(host);
  if (!page || typeof page.evaluate !== "function") throw new TypeError("readArming: a Playwright Page or a User");
  return page.evaluate((key) => {
    const p = window[Symbol.for(key)];
    if (!p) return null;
    return {
      ...p,
      moves: [...p.moves],
      keys: [...p.keys],
      states: p.states.map((s) => ({ ...s })),
      focusChanges: p.focusChanges.map((f) => ({ ...f })),
      now: performance.timeOrigin + performance.now(),
    };
  }, ARMING_KEY);
}

/**
 * Drive the consent page.
 *
 * Waits for the Approve button, brings the page to the front and scrolls the
 * button into view, then moves the
 * pointer through the card every `stepMs` until Approve is enabled (or
 * `timeoutMs` passes), and clicks it. With approve:false it clicks Cancel,
 * which is never gated. Works with any Playwright Page; nothing here imports
 * playwright-core.
 *
 * `arming` is the page's arming record (readArming) read just before the
 * click, when armingProbe was installed on this page; null otherwise.
 *
 * @returns {Promise<{clicked: "approve"|"cancel", armedAfterMs: number, moves: number, arming: object|null}>}
 */
export async function consent(page, { approve = true, timeoutMs = 15_000, stepMs = 120 } = {}) {
  const { approve: approveBtn, cancel } = buttonsOf(page);
  const probed = probes.has(page);
  const arming = () => (probed ? readArming(page).catch(() => null) : null);
  await approveBtn.waitFor({ state: "visible", timeout: timeoutMs });
  if (typeof page.bringToFront === "function") await page.bringToFront();
  if (!approve) {
    const record = await arming();
    await cancel.click();
    return { clicked: "cancel", armedAfterMs: 0, moves: 0, arming: record };
  }
  await approveBtn.scrollIntoViewIfNeeded();
  const started = Date.now();
  const box = (await approveBtn.boundingBox()) ?? { x: 100, y: 100, width: 80, height: 30 };
  let moves = 0;
  // A small loop of points around (never on) the button, so a stray click
  // event can never be what arms or presses it.
  const points = [
    [box.x - 40, box.y - 30],
    [box.x + box.width + 40, box.y - 30],
    [box.x + box.width + 40, box.y + box.height + 30],
    [box.x - 40, box.y + box.height + 30],
  ];
  while (!(await approveBtn.isEnabled())) {
    if (Date.now() - started > timeoutMs) {
      const err = new Error(`consent: Approve never armed within ${timeoutMs} ms (${moves} pointer moves)`);
      err.code = "E2E_CONSENT";
      throw err;
    }
    const [x, y] = points[moves % points.length];
    await page.mouse.move(Math.max(1, x), Math.max(1, y), { steps: 2 });
    moves++;
    await page.waitForTimeout(stepMs);
  }
  const armedAfterMs = Date.now() - started;
  const record = await arming();
  await approveBtn.click();
  return { clicked: "approve", armedAfterMs, moves, arming: record };
}
