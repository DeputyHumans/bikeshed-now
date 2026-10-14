// SPDX-License-Identifier: Apache-2.0
// Casting a run's accounts: verified email-and-password users, recorded in the ledger (SPEC §12, §14).

/**
 * `cast(target, ["owner", "viewer"])` → [{role, email, password, uid}, …].
 *
 * LOCAL: the Auth emulator's REST API — accounts:signUp with the public web
 * key, then accounts:update emailVerified:true as the emulator's admin
 * ("Bearer owner"). users/{uid} is NOT written: the product writes it at the
 * first POST /session, and specs that test that must see it happen.
 *   email: <role>-<run6>-<rand4>@example.com
 *   An address the emulator says is already signed up (EMAIL_EXISTS: a
 *   long-lived shared stack holds thousands per role under one run tag, so a
 *   fresh suffix is now and then taken) is replaced by another fresh one, up
 *   to {retryTaken} (3) times; a refused signUp makes and ledgers nothing.
 *   With {notifications: false} (and/or {analytics: false}) the account record
 *   IS written, before any session, as production does:
 *   users/{uid} = {uid, email, emailNotifications: false[, analyticsOptOut: true]}.
 *   POST /session merges {uid, email} over it, so the opt-out survives, and
 *   no comment, suggestion or invitation emails the account on either tier.
 *
 * PRODUCTION (implemented, never run in this build): Admin createUser with
 * emailVerified:true, then users/{uid} = {uid, email, emailNotifications:false,
 * analyticsOptOut:true} BEFORE any session, so no comment, suggestion or
 * invitation can email the account and no visit counts it.
 *   email: e2e-<run6>-u<NN>@<E2E_PROD_EMAIL_DOMAIN | bikeshed-e2e.invalid>
 *   NN is claimed with an O_EXCL slot file, so parallel spec processes never
 *   collide; the role goes in the display name and the ledger.
 *   The same path runs against the Auth emulator with cast(…, {via: "admin"}),
 *   which is how it is exercised without production.
 *
 * Passwords are HMAC-SHA256(E2E_RUN_SECRET, email): derivable again by any
 * process holding the secret, never written to disk, never in the ledger.
 * Without E2E_RUN_SECRET a per-process random secret is used, so an account
 * can only be signed in by the process that cast it.
 */

import { createHmac, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { appendLedger } from "./ledger.mjs";
import { createHttp } from "./http.mjs";

let processSecret = null;

function runSecret() {
  const s = process.env.E2E_RUN_SECRET;
  if (s && s.length >= 16) return s;
  processSecret ??= randomBytes(32).toString("hex");
  return processSecret;
}

/** Six characters that identify a run inside an email or a doc id. */
export function runTag(runId) {
  const compact = String(runId).replace(/[^a-z0-9]/g, "");
  if (compact.length < 6) throw new Error(`runTag: run id ${runId} is too short`);
  return compact.slice(-6);
}

const RAND_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/**
 * The largest multiple of 36 a byte reaches (7 × 36): a byte at or above it
 * is drawn again. `b % 36` over every byte would give a–d 8 chances in 256
 * and every other character 7, since 256 = 7 × 36 + 4.
 */
const RAND_BYTE_LIMIT = 252;

/** Four random [a-z0-9], each of the 36 equally likely. */
export function rand4() {
  let out = "";
  while (out.length < 4) {
    for (const b of randomBytes(4)) {
      if (b < RAND_BYTE_LIMIT && out.length < 4) out += RAND_ALPHABET[b % 36];
    }
  }
  return out;
}

/** The password for an email under this process's run secret. Upper, lower, digit and symbol. */
export function passwordFor(email) {
  const mac = createHmac("sha256", runSecret()).update(String(email).toLowerCase()).digest("base64url");
  return `${mac.slice(0, 24)}Aa1!`;
}

function roleSlug(role) {
  const s = String(role).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16);
  if (!s) throw new Error(`cast: role ${JSON.stringify(role)} has no usable characters`);
  return s;
}

export function localEmail(target, role) {
  return `${roleSlug(role)}-${runTag(target.runId)}-${rand4()}@example.com`;
}

export const PROD_EMAIL_DOMAIN_DEFAULT = "bikeshed-e2e.invalid";

/** Claim the next free u<NN> for this run, race-free across processes. */
export function claimProdSlot(target) {
  const dir = join(target.runDir, "account-slots");
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const nn = String(n).padStart(2, "0");
    try {
      closeSync(openSync(join(dir, `u${nn}`), "wx"));
      return `u${nn}`;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new Error("claimProdSlot: no free account slot");
}

export function prodEmail(target, slot) {
  const domain = process.env.E2E_PROD_EMAIL_DOMAIN || PROD_EMAIL_DOMAIN_DEFAULT;
  if (!/^[a-z0-9.-]+\.[a-z]+$/i.test(domain)) throw new Error(`E2E_PROD_EMAIL_DOMAIN is not a domain: ${domain}`);
  return `e2e-${runTag(target.runId)}-${slot}@${domain}`;
}

/**
 * How many times, by default, a REST cast replaces an address the Auth
 * emulator says is already signed up (EMAIL_EXISTS) with a fresh one. A
 * long-lived shared stack holds thousands of accounts per role under one run
 * tag, so a fresh four-character suffix is now and then one already taken;
 * four in a row is not a collision.
 */
const TAKEN_RETRIES = 3;

/** `retryTaken` checked: a whole number 0 to 20, TAKEN_RETRIES when not given. */
function takenRetries(v, who) {
  if (v === undefined) return TAKEN_RETRIES;
  if (!Number.isInteger(v) || v < 0 || v > 20) {
    throw new Error(`${who}: retryTaken is how many times an address already signed up (EMAIL_EXISTS) is replaced by a fresh one, a whole number 0 to 20, got ${JSON.stringify(v) ?? String(v)}`);
  }
  return v;
}

/** The Auth REST API's refusal of an address already signed up, as http.mjs throws it for `expect`: 400 {error: {message: "EMAIL_EXISTS"}}. */
function emailTaken(err) {
  return err?.code === "E2E_STATUS" && err.response?.status === 400 && err.response?.json?.error?.message === "EMAIL_EXISTS";
}

/**
 * accounts:signUp for a fresh localEmail(target, role), and again under
 * another fresh address, up to `retryTaken` times, while the emulator answers
 * EMAIL_EXISTS. A refused signUp creates nothing, so nothing is ledgered for
 * it. Any other answer, or the last refusal, is thrown as it is.
 */
async function signUpFresh(target, role, http, retryTaken) {
  const key = encodeURIComponent(target.webApiKey);
  for (let taken = 0; ; taken += 1) {
    const email = localEmail(target, role);
    const password = passwordFor(email);
    try {
      const r = await http.postJson(`${target.authRestBase}/accounts:signUp?key=${key}`, { email, password, returnSecureToken: true }, { expect: 200 });
      return { email, password, json: r.json };
    } catch (err) {
      if (taken < retryTaken && emailTaken(err)) continue;
      throw err;
    }
  }
}

async function castLocal(target, role, http, retryTaken = TAKEN_RETRIES) {
  const key = encodeURIComponent(target.webApiKey);
  const { email, password, json } = await signUpFresh(target, role, http, retryTaken);
  const uid = json?.localId;
  if (!uid) throw new Error(`cast: signUp for ${role} returned no localId`);
  await http.postJson(
    `${target.authRestBase}/accounts:update?key=${key}`,
    { localId: uid, emailVerified: true },
    { headers: { authorization: "Bearer owner" }, expect: 200 },
  );
  return { role, email, password, uid };
}

/**
 * The production way: Admin createUser, then the account record with the
 * opt-outs BEFORE any session. Exported so it can be exercised against the
 * Auth emulator (cast(..., {via: "admin"})); production uses nothing else.
 */
export async function castAdmin(target, role) {
  const { adminFor, writeUser } = await import("./admin.mjs");
  const slot = claimProdSlot(target);
  const email = prodEmail(target, slot);
  const password = passwordFor(email);
  const { auth } = adminFor(target);
  const user = await auth.createUser({ email, password, emailVerified: true, displayName: `e2e ${runTag(target.runId)} ${roleSlug(role)}` });
  // Before any session: /session merges {uid,email} over this, so the opt-outs survive.
  await writeUser(target, user.uid, { uid: user.uid, email, emailNotifications: false, analyticsOptOut: true });
  return { role, email, password, uid: user.uid, slot };
}

/**
 * The account record a REST-cast account gets before its first session, or
 * null when the options ask for none: {notifications: false} opts out of
 * email, {analytics: false} out of visitor counts. castAdmin writes both,
 * always, so production needs neither option.
 */
export function optOutRecord(acct, o = {}) {
  for (const k of ["notifications", "analytics"]) {
    if (o[k] !== undefined && typeof o[k] !== "boolean") throw new Error(`cast: ${k} is true or false, got ${JSON.stringify(o[k])}`);
  }
  if (o.notifications !== false && o.analytics !== false) return null;
  return {
    uid: acct.uid,
    email: String(acct.email).toLowerCase(),
    ...(o.notifications === false ? { emailNotifications: false } : {}),
    ...(o.analytics === false ? { analyticsOptOut: true } : {}),
  };
}

/**
 * Create one verified account per role, in order. Every account is appended
 * to the ledger (without its password) as soon as it exists.
 *
 * @param {object} [o]
 * @param {boolean} [o.notifications]  false: write users/{uid}.emailNotifications=false before any session
 * @param {boolean} [o.analytics]      false: write users/{uid}.analyticsOptOut=true before any session
 * @param {"rest"|"admin"} [o.via]     how a local account is made (production: admin only)
 * @param {object} [o.http]            the client for the Auth REST calls
 * @param {Function} [o.writeUser]     a test's stand-in for admin.writeUser
 * @param {number} [o.retryTaken]      REST only: how many times an address the
 *        emulator says is already signed up (EMAIL_EXISTS) is replaced by a
 *        fresh one, 0 to 20 (default 3). A refused signUp makes nothing and
 *        ledgers nothing; the last refusal is thrown as it is.
 */
export async function cast(target, roles, o = {}) {
  if (!Array.isArray(roles) || roles.length === 0) throw new Error("cast: give a non-empty list of roles");
  if (target.kind === "prod" && (o.notifications === true || o.analytics === true)) {
    throw new Error("cast: production accounts are always cast with email and analytics off");
  }
  optOutRecord({ uid: "check", email: "check" }, o); // reject a malformed option before any account exists
  const retryTaken = takenRetries(o.retryTaken, "cast");
  const http = o.http ?? createHttp(target, { actor: "harness", evidence: o.evidence });
  const out = [];
  const via = o.via ?? (target.kind === "prod" ? "admin" : "rest");
  if (target.kind === "prod" && via !== "admin") throw new Error("cast: production accounts are created with the Admin SDK only");
  for (const role of roles) {
    const acct = via === "admin" ? await castAdmin(target, role) : await castLocal(target, role, http, retryTaken);
    appendLedger(target, { kind: "account", role: acct.role, email: acct.email, uid: acct.uid, tier: target.kind, via, ...(acct.slot ? { slot: acct.slot } : {}) });
    // castAdmin has already written the record with both opt-outs.
    const record = via === "admin" ? null : optOutRecord(acct, o);
    if (record) {
      const write = o.writeUser ?? (await import("./admin.mjs")).writeUser;
      await write(target, acct.uid, record);
    }
    out.push(Object.freeze(acct));
  }
  return out;
}

/** One account. */
export async function castOne(target, role, o) {
  const [a] = await cast(target, [role], o);
  return a;
}

/**
 * An UNVERIFIED local account (for the sign-up-and-code path, A1.2), made the
 * way a person makes one: accounts:signUp with the public web key, which is
 * what the web SDK's createUserWithEmailAndPassword sends. Local only:
 * production never signs up. Ledgered as {kind: "account", verified: false}.
 *
 * `email` chooses the address, for a case that needs it before the account
 * exists (shared with first, signed up with after, A1.8). It is sent exactly
 * as given; without it the address is localEmail(target, role). Choose one
 * unique to the run (`<role>-<runTag(runId)>-<rand4()>@example.com`, which
 * localEmail makes): an address already signed up is refused (EMAIL_EXISTS)
 * and nothing is ledgered. A chosen address is never replaced: its refusal
 * is thrown. Without `email`, the address is its own, and a taken one is
 * replaced by a fresh one as cast() does (`retryTaken`).
 *
 * @param {object} target
 * @param {string} role
 * @param {object} [o]
 * @param {string} [o.email]   the address; default localEmail(target, role)
 * @param {object} [o.http]    the client for the Auth REST call
 * @param {number} [o.retryTaken]  without `email`: as cast's (default 3)
 * @returns {Promise<{role, email, password, uid, verified: false}>}
 */
export async function castUnverified(target, role, o = {}) {
  if (target.kind !== "local") throw new Error("castUnverified is local-only: production accounts are created verified by the Admin SDK");
  const chosen = o.email === undefined ? null : chosenEmail(o.email);
  const retryTaken = takenRetries(o.retryTaken, "castUnverified");
  const http = o.http ?? createHttp(target, { actor: "harness", evidence: o.evidence });
  let email;
  let json;
  if (chosen === null) {
    ({ email, json } = await signUpFresh(target, role, http, retryTaken));
  } else {
    email = chosen;
    ({ json } = await http.postJson(`${target.authRestBase}/accounts:signUp?key=${encodeURIComponent(target.webApiKey)}`, { email, password: passwordFor(email), returnSecureToken: true }, { expect: 200 }));
  }
  const password = passwordFor(email);
  const uid = json?.localId;
  if (!uid) throw new Error(`castUnverified: signUp for ${role} returned no localId`);
  const acct = Object.freeze({ role, email, password, uid, verified: false });
  appendLedger(target, { kind: "account", role, email, uid, tier: target.kind, verified: false });
  return acct;
}

/** An address a caller chose for an account: one address, no spaces, a dotted domain. */
function chosenEmail(email) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`castUnverified: email must be an address, got ${JSON.stringify(email)}`);
  }
  return email;
}
