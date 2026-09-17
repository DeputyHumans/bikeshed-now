// SPDX-License-Identifier: Apache-2.0
// The identity gate, over every credential a caller can present (SPEC §1, §19).

import * as admin from "firebase-admin";
import { isAllowedEmail } from "../generated/policy";

/** An authenticated, gate-passing caller. Emails are always lowercased. */
export interface Principal {
  uid: string;
  emailLower: string;
  /** Which credential was presented. Server-derived; never taken from the body. */
  channel: "web" | "cli" | "mcp" | "api";
  /** The personal access token used, when `channel` is not "web". */
  tokenId?: string;
}

/**
 * Apply the gate to an already-decoded Firebase token.
 *
 * `email_verified === true` is the whole gate, and it stays that way: the
 * sign-up flow writes Firebase's own `emailVerified` field through the Admin SDK
 * rather than inventing a parallel claim, so there is exactly one source of
 * truth and the rules never needed to change to support a second provider.
 *
 * The `typeof rawEmail !== "string"` check mirrors `email is string` in
 * firestore.rules and is not redundant: a custom token can carry
 * `email_verified: true` with no `email` claim at all.
 */
export function gateDecodedToken(
  decoded: admin.auth.DecodedIdToken,
): Principal | null {
  if (decoded.email_verified !== true) return null;
  const rawEmail = decoded.email;
  if (typeof rawEmail !== "string" || rawEmail.length === 0) return null;
  if (typeof decoded.uid !== "string" || decoded.uid.length === 0) return null;
  const emailLower = rawEmail.toLowerCase();
  if (!isAllowedEmail(emailLower)) return null;
  return { uid: decoded.uid, emailLower, channel: "web" };
}

/** Why a token was refused, so POST /session can say which (SPEC §2). */
export type GateFailure = "invalid" | "unverified" | "not_allowed";

export type GateResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: GateFailure };

/**
 * Verify an ID token and report WHY it failed, not just that it did.
 *
 * `POST /session` needs the distinction: "verify your email" and "this
 * deployment does not accept your address" are different states with different
 * next actions, and collapsing both into 401 is how a sign-in screen ends up
 * looking broken.
 */
export async function verifyIdToken(idToken: string): Promise<GateResult> {
  if (typeof idToken !== "string" || idToken.length === 0) {
    return { ok: false, reason: "invalid" };
  }
  let decoded: admin.auth.DecodedIdToken;
  try {
    // `true` is checkRevoked, which costs an extra call to the Auth backend.
    // That call can fail for reasons that have nothing to do with the token —
    // a missing permission on the runtime service account, for one — so the
    // error is logged rather than collapsed into "invalid". The CALLER is still
    // told only "invalid": which of the two it was is the operator's business,
    // not an anonymous client's.
    decoded = await admin.auth().verifyIdToken(idToken, true);
  } catch (err) {
    console.error("verifyIdToken failed:", (err as Error)?.message ?? err);
    return { ok: false, reason: "invalid" };
  }
  const rawEmail = decoded.email;
  if (typeof rawEmail !== "string" || rawEmail.length === 0) {
    return { ok: false, reason: "unverified" };
  }
  if (decoded.email_verified !== true) {
    return { ok: false, reason: "unverified" };
  }
  if (!isAllowedEmail(rawEmail.toLowerCase())) {
    return { ok: false, reason: "not_allowed" };
  }
  const principal = gateDecodedToken(decoded);
  return principal
    ? { ok: true, principal }
    : { ok: false, reason: "invalid" };
}

/** Verify a session cookie (checkRevoked) and apply the gate. */
export async function verifySessionCookie(
  sessionCookie: string,
): Promise<Principal | null> {
  if (typeof sessionCookie !== "string" || sessionCookie.length === 0) {
    return null;
  }
  try {
    const decoded = await admin.auth().verifySessionCookie(sessionCookie, true);
    return gateDecodedToken(decoded);
  } catch {
    return null;
  }
}
