// SPDX-License-Identifier: Apache-2.0
// Proving an address with a six-digit code (SPEC §2, §14).

import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { randomBytes, createHash } from "crypto";
import { VERIFY_TTL_MS } from "../config";
import { isAllowedEmail, isEmailShapeValid } from "../generated/policy";
import { normalizeEmail } from "../lib/access";
import { badRequest, jsonBody, rejectMethod } from "../lib/http";
import { db, MAILING } from "./runtime";

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

const VERIFY_MAX_ATTEMPTS = 5;
const VERIFY_RESEND_GAP_MS = 60 * 1000;
/**
 * Codes sent to one ADDRESS in a rolling day, whoever asks. The gap above is
 * per account, and each new code comes with five fresh guesses, so without
 * this a hundred throwaway accounts could make 720,000 guesses a day at an
 * address with shares waiting for it: about even odds of taking them all in a
 * day. Here an address gets 25 guesses a day, however many accounts ask.
 */
const VERIFY_CODES_PER_ADDRESS = 5;
const VERIFY_ADDRESS_WINDOW_MS = 24 * 60 * 60 * 1000;

export function sixDigitCode(): string {
  // randomInt-free so the dependency surface stays at crypto primitives we
  // already use; modulo bias over 10^6 from 4 bytes is ~1e-13 and irrelevant
  // for a single-use, 15-minute, rate-limited code.
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

/**
 * POST /verify/start and POST /verify/complete.
 *
 * The flow exists because GitHub does not assert `email_verified`, and the ACL
 * is keyed by email: signing in with an unverified address that matches a
 * pending share would hand an attacker someone else's documents.
 *
 * Completing it calls `updateUser({ emailVerified: true })`, writing FIREBASE's
 * canonical field. That is the whole trick — one gate, one source of truth, and
 * not a single change to firestore.rules to support a second provider.
 *
 * The challenge lives in `verifications/{uid}`, which no client can read, and
 * never on the account's own record, which its account can. A six-digit
 * code's hash is no secret to whoever holds it: a million guesses take under
 * a second, and the five-guess budget only counts guesses made here. Kept on
 * `users/{uid}` until 0.29.1, it let anyone verify an address they did not
 * own by reading the hash and trying every code offline.
 */
export const verifyEmail = onRequest(MAILING, async (req, res) => {
  if (rejectMethod(req, res, ["POST"])) return;

  const authHeader = req.headers.authorization;
  const idToken =
    typeof authHeader === "string" && /^Bearer /i.test(authHeader)
      ? authHeader.slice(7)
      : "";
  let decoded: admin.auth.DecodedIdToken;
  try {
    decoded = await admin.auth().verifyIdToken(idToken, true);
  } catch {
    res.status(401).end();
    return;
  }

  const uid = decoded.uid;
  const action = req.path.endsWith("/complete") ? "complete" : "start";
  const ref = db().collection("verifications").doc(uid);

  if (action === "start") {
    const body = jsonBody(req) as { email?: unknown } | null;
    const email = normalizeEmail(
      typeof body?.email === "string" ? body.email : (decoded.email ?? ""),
    );
    // Two distinct failures, so the UI can explain which one happened: a
    // malformed address and a well-formed one this deployment does not accept
    // are different problems with different next steps.
    if (!isEmailShapeValid(email)) {
      badRequest(res, "invalid email address");
      return;
    }
    if (!isAllowedEmail(email)) {
      res.status(403).json({ error: "email not permitted by policy" });
      return;
    }

    const code = sixDigitCode();
    const reservationId = randomBytes(16).toString("hex");
    // Keyed by a hash so the record names no address; server-only, like the
    // challenge itself (firestore.rules).
    const targetRef = db().collection("verifyTargets").doc(createHash("sha256").update(email).digest("hex"));
    const reserved = await db().runTransaction(async (tx): Promise<"ok" | "account" | "address"> => {
      const existing = (await tx.get(ref)).data() as { sentAt?: number; reservationId?: string } | undefined;
      const target = (await tx.get(targetRef)).data() as { sentAt?: unknown } | undefined;
      if (existing?.reservationId === reservationId) return "ok";
      const at = Date.now();
      if (existing?.sentAt && at - existing.sentAt < VERIFY_RESEND_GAP_MS) return "account";
      const recent = (Array.isArray(target?.sentAt) ? target.sentAt : [])
        .filter((t): t is number => typeof t === "number" && at - t < VERIFY_ADDRESS_WINDOW_MS);
      if (recent.length >= VERIFY_CODES_PER_ADDRESS) return "address";
      // Reserve once before sending: retrying this transaction never mails an
      // obsolete candidate code or resets a newer challenge's attempt budget.
      tx.set(ref, {
        hash: createHash("sha256").update(`${uid}:${code}`).digest("hex"),
        email,
        expiresAt: at + VERIFY_TTL_MS,
        attempts: 0,
        sentAt: at,
        reservationId,
      });
      tx.set(targetRef, { sentAt: [...recent, at] });
      return "ok";
    });
    if (reserved === "account") {
      res.status(429).json({ error: "a code was just sent; wait a minute" });
      return;
    }
    if (reserved === "address") {
      res.status(429).json({ error: "too many codes were sent to this address today; try again tomorrow" });
      return;
    }

    const { sendVerificationCode } = await import("../email/notify");
    await sendVerificationCode(email, code, Math.round(VERIFY_TTL_MS / 60000));
    res.status(200).json({ sent: true, email });
    return;
  }

  const body = jsonBody(req) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  type VerificationCheck =
    | { status: 400 | 409 | 429; error: string }
    | { status: 200; email: string; identity: string };
  const expected = createHash("sha256").update(`${uid}:${code}`).digest("hex");
  const identity = (value: { hash?: string; email?: string; sentAt?: number; expiresAt?: number }) =>
    JSON.stringify([value.hash, value.email, value.sentAt, value.expiresAt]);
  const attemptId = randomBytes(16).toString("hex");
  let checkedIdentity: string | undefined;
  const checked = await db().runTransaction(async (tx): Promise<VerificationCheck> => {
    const verification = (await tx.get(ref)).data() as
      | { hash?: string; email?: string; expiresAt?: number; attempts?: number; sentAt?: number; attemptIds?: string[] }
      | undefined;
    if (!verification?.hash || !verification.email) {
      return { status: 409, error: "no verification in progress" };
    }
    const currentIdentity = identity(verification);
    if (checkedIdentity !== undefined && checkedIdentity !== currentIdentity) {
      return { status: 409, error: "that code was replaced; use the latest code" };
    }
    checkedIdentity = currentIdentity;
    // The challenge allows at most five wrong attempts, so this receipt list
    // is bounded by the existing limit and survives other concurrent guesses.
    const attemptIds = Array.isArray(verification.attemptIds) ? verification.attemptIds : [];
    if (attemptIds.includes(attemptId)) return { status: 400, error: "that code is not right" };
    if (Number(verification.expiresAt ?? 0) < Date.now()) {
      tx.delete(ref);
      return { status: 409, error: "that code has expired" };
    }
    if (Number(verification.attempts ?? 0) >= VERIFY_MAX_ATTEMPTS) {
      tx.delete(ref);
      return { status: 429, error: "too many attempts; request a new code" };
    }
    if (expected !== verification.hash) {
      tx.update(ref, { attempts: Number(verification.attempts ?? 0) + 1, attemptIds: [...attemptIds, attemptId] });
      return { status: 400, error: "that code is not right" };
    }
    return { status: 200, email: verification.email, identity: identity(verification) };
    // At most five wrong-attempt commits and one retirement can race a caller.
    // Leave room to observe the resulting refusal after those conflicts.
  }, { maxAttempts: VERIFY_MAX_ATTEMPTS + 3 });
  if (checked.status !== 200) {
    res.status(checked.status).json({ error: checked.error });
    return;
  }

  await admin.auth().updateUser(uid, { email: checked.email, emailVerified: true });
  await db().runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data();
    // Auth is outside Firestore: a resend can reserve another challenge while
    // this call is in flight. Completion retires only the challenge it checked.
    if (!current || identity(current) !== checked.identity) return;
    tx.delete(ref);
    // `verification` is where a challenge was kept before 0.29.1; one left
    // there is dead, since nothing reads it, and is cleared with the rest.
    tx.set(db().collection("users").doc(uid), { uid, email: checked.email, verification: FieldValue.delete() }, { merge: true });
  });
  res.status(200).json({ verified: true, email: checked.email });
});
