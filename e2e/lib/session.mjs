// SPDX-License-Identifier: Apache-2.0
// Signing an account in over HTTP: ID token, the __session cookie, and personal access tokens (SPEC §12, §14, §23).

/**
 * The sign-in a browser performs, without the browser:
 *
 *   accounts:signInWithPassword (Auth REST)  → idToken
 *   POST <origin>/session {idToken}          → __session cookie in the actor's jar
 *
 * The product writes users/{uid} ONLY at POST /session, so an account that has
 * never opened a session has no account record (and gets no comment email).
 *
 * Tokens are session-only to create and list (SPEC §23):
 *   POST /tokens {op:"create", name, channel}  → {tokenId, token: "bsk_…"}
 *   POST /tokens {op:"list"}                   → {tokens}
 *   POST /tokens {op:"revoke", tokenId}        → {revoked}
 * A minted token is recorded in the ledger by id; its value only ever lives in
 * the returned object (and is redacted from every trace).
 *
 * `timeoutMs` (signInWithPassword, openSession, openSessions, bearerHttp) is
 * the client's default timeout (http.mjs createHttp): the session's `http`
 * keeps it for every later request, so publish(), share() and the other
 * helpers that take the session's client wait that long without being told.
 * With `o.http` given, that client's own default applies instead.
 *
 * `cutoffError` (signInWithPassword, openSession, openSessions, bearerHttp) is
 * the client's too (http.mjs createHttp): with `true`, Hosting's cut-off 504
 * to POST /session, or to any later request of the session's `http`, throws
 * E2E_STACK_CUTOFF rather than E2E_SESSION or a returned response. With
 * `o.http` given, that client's own applies instead.
 *
 * A case that signed a browser user in through the UI already has a session:
 * `browserSession(user)` copies that user's `__session` cookie into a client's
 * jar instead of opening a second one (no POST /session, no sign-in at all).
 */

import { appendLedger } from "./ledger.mjs";
import { createHttp } from "./http.mjs";

/** Identity Toolkit signInWithPassword → {idToken, refreshToken, uid, expiresIn}. */
export async function signInWithPassword(target, account, o = {}) {
  const http = o.http ?? createHttp(target, { actor: account.role ?? "account", evidence: o.evidence, timeoutMs: o.timeoutMs, cutoffError: o.cutoffError });
  const r = await http.postJson(
    `${target.authRestBase}/accounts:signInWithPassword?key=${encodeURIComponent(target.webApiKey)}`,
    { email: account.email, password: account.password, returnSecureToken: true },
  );
  if (r.status !== 200 || !r.json?.idToken) {
    const err = new Error(`signInWithPassword for ${account.role ?? account.email}: ${r.status} ${r.json?.error?.message ?? ""}`);
    err.code = "E2E_SIGNIN";
    err.response = r;
    throw err;
  }
  return { idToken: r.json.idToken, refreshToken: r.json.refreshToken, uid: r.json.localId, expiresIn: Number(r.json.expiresIn) };
}

/**
 * Sign an account in and open a session.
 *
 * @returns {Promise<Session>} { account, http, idToken, uid, status, response }
 *   http: the actor's client, whose jar now holds __session.
 *   With `expectStatus` other than "ok" (e.g. "unverified"), returns instead of
 *   throwing when /session answers that.
 */
export async function openSession(target, account, o = {}) {
  const http = o.http ?? createHttp(target, { actor: account.role ?? "account", evidence: o.evidence, timeoutMs: o.timeoutMs, cutoffError: o.cutoffError });
  const signed = await signInWithPassword(target, account, { http });
  const r = await http.postJson("/session", { idToken: signed.idToken });
  const status = r.json?.status;
  const want = o.expectStatus ?? "ok";
  if (status !== want) {
    const err = new Error(`POST /session for ${account.role ?? account.email}: ${r.status} ${status ?? r.text.slice(0, 120)} (wanted ${want})`);
    err.code = "E2E_SESSION";
    err.response = r;
    throw err;
  }
  if (want === "ok" && !http.jar.has("__session")) {
    const err = new Error(`POST /session for ${account.role}: ok but no __session cookie was stored`);
    err.code = "E2E_SESSION";
    throw err;
  }
  return { account, http, idToken: signed.idToken, refreshToken: signed.refreshToken, uid: signed.uid, status, response: r };
}

/** A session cookie's claims (a JWT's payload, read and never verified: the stack verifies it), or null when it is not one. */
function cookieClaims(value) {
  const parts = String(value).split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

function sessionError(message) {
  const err = new Error(message);
  err.code = "E2E_SESSION";
  return err;
}

/**
 * The session a browser user is signed in with, for Node: an http.mjs
 * client whose jar holds that user's own `__session` cookie
 * (browser.mjs User.sessionCookie), so a case that signed in through the UI
 * makes no second POST /session (5–10 s a case on a loaded shared stack).
 * It is the SAME session, copied once: the stack verifies the cookie on
 * every request, so a revocation reaches both; DELETE /session
 * (closeSession) clears only the copy it was sent from, the browser's own
 * or this jar's; a later sign-in in the browser is not seen here.
 *
 * `uid` is the cookie's own subject (its `user_id`, else `sub`; read, not
 * verified), so it names the account the browser IS signed in as. With
 * `o.account` (a cast account), that account is the session's, and a cookie
 * of another uid throws; without it the account is {role: user.name, email,
 * uid} from the cookie and the user. `o.http` is a client to put the cookie
 * in instead of a new one (its own options then apply); otherwise the new
 * client takes `o.evidence`, `o.timeoutMs` and `o.cutoffError` as openSession
 * does, its actor is the account's role, and inside a case it logs to the
 * case's http.jsonl. A user holding no `__session` cookie, or one that is not
 * a token naming a subject, throws E2E_SESSION.
 *
 * @returns {Promise<{account, http, uid, idToken: null, refreshToken: null, via: "browser"}>}
 *   No ID token: what needs one (clientFirestore's `session`, /oauth/consent)
 *   takes idToken(target, account) instead.
 */
export async function browserSession(user, o = {}) {
  if (!user || typeof user.sessionCookie !== "function" || !user.target?.origin) {
    throw new TypeError("browserSession(user): user is a browser.mjs User of a target, signed in (signInUi)");
  }
  const origin = user.target.origin;
  const c = await user.sessionCookie();
  if (!c?.value) throw sessionError(`browserSession: ${user.name} holds no __session cookie for ${origin}; sign it in first (signInUi)`);
  const claims = cookieClaims(c.value);
  const uid = [claims?.user_id, claims?.sub].find((v) => typeof v === "string" && v.length > 0);
  if (!uid) throw sessionError(`browserSession: ${user.name}'s __session cookie is not a token naming its account`);
  const given = o.account ?? null;
  if (given?.uid != null && given.uid !== uid) {
    throw sessionError(`browserSession: ${user.name} is signed in as uid ${uid}, not as ${given.role ?? given.email ?? "the account given"} (uid ${given.uid})`);
  }
  const account = given ?? { role: user.name, email: typeof claims.email === "string" ? claims.email : (user.email ?? null), uid };
  const http = o.http ?? createHttp(user.target, { actor: account.role ?? user.name, evidence: o.evidence, timeoutMs: o.timeoutMs, cutoffError: o.cutoffError });
  const attrs = [`Path=${c.path || "/"}`];
  if (Number.isFinite(c.expires) && c.expires > 0) attrs.push(`Expires=${new Date(c.expires * 1000).toUTCString()}`);
  if (typeof c.domain === "string" && c.domain.startsWith(".")) attrs.push(`Domain=${c.domain}`);
  if (c.secure) attrs.push("Secure");
  http.jar.store(origin, [`__session=${c.value}; ${attrs.join("; ")}`]);
  return { account, http, uid, idToken: null, refreshToken: null, via: "browser" };
}

/** Sign several accounts in, in batches (the plan signs in 5 at a time). */
export async function openSessions(target, accounts, { batch = 5, ...o } = {}) {
  const out = [];
  for (let i = 0; i < accounts.length; i += batch) {
    out.push(...(await Promise.all(accounts.slice(i, i + batch).map((a) => openSession(target, a, o)))));
  }
  return out;
}

/** DELETE /session. Returns the response; the jar drops __session from its Max-Age=0. */
export async function closeSession(session) {
  return session.http.delete("/session");
}

/** A fresh ID token for the account (for /verify/*, /oauth/consent). */
export async function idToken(target, account, o = {}) {
  return (await signInWithPassword(target, account, o)).idToken;
}

/**
 * Mint a personal access token with the session.
 * @returns {Promise<{tokenId, token, channel, name}>}
 */
export async function mintToken(session, { name = `e2e ${session.account.role ?? "token"}`, channel = "cli" } = {}) {
  const r = await session.http.postJson("/tokens", { op: "create", name, channel });
  if (r.status !== 200 || !/^bsk_[0-9a-f]{32}\./.test(r.json?.token ?? "")) {
    const err = new Error(`POST /tokens create: ${r.status} ${r.json?.error ?? ""}`);
    err.code = "E2E_TOKEN";
    err.response = r;
    throw err;
  }
  appendLedger(session.http.target, { kind: "token", tokenId: r.json.tokenId, uid: session.uid, channel, name });
  return { tokenId: r.json.tokenId, token: r.json.token, channel, name };
}

/** POST /tokens {op:"list"} → the response (json.tokens on 200). */
export async function listTokens(session) {
  return session.http.postJson("/tokens", { op: "list" });
}

/** POST /tokens {op:"revoke", tokenId} with the session → the response. */
export async function revokeToken(session, tokenId) {
  return session.http.postJson("/tokens", { op: "revoke", tokenId });
}

/** A client that authenticates with a bearer token instead of a cookie. */
export function bearerHttp(target, token, o = {}) {
  return createHttp(target, { ...o, actor: o.actor ?? "token", headers: { ...(o.headers ?? {}), authorization: `Bearer ${token}` } });
}
