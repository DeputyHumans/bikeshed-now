// SPDX-License-Identifier: Apache-2.0
// The code emailed to confirm deleting something forever, for exactly one thing, once (SPEC §4, ADR 0025).

import * as admin from "firebase-admin";
import { createHash, randomBytes } from "node:crypto";
import { PURGE_CODE_TTL_MS } from "../config";
import { safeSegment } from "./http";
import type { PurgeTarget } from "./purge";

type Db = admin.firestore.Firestore;

/**
 * Why a code, and why kept like this
 * ----------------------------------
 * Deleting forever cannot be undone, and a session cookie is all a browser
 * left signed in on a shared computer needs. So the browser asks for a code,
 * the server emails it to the account's own address, and the purge happens
 * only with it: proof that whoever clicks is also whoever reads that inbox.
 *
 * A code is for one thing, named when it is asked for (`targetKey`), so a
 * code for one document cannot empty the Trash. It is valid ten minutes, used
 * once, and burned by five wrong guesses; another can be asked for a minute
 * after the last. It lives in `purgeCodes/{uid}`, which no client can read, as
 * `verifications/{uid}` does and for the same reason: a six-digit code's hash
 * is the code to whoever can read it.
 */
export const PURGE_MAX_ATTEMPTS = 5;
export const PURGE_RESEND_GAP_MS = 60 * 1000;

/** The one thing a code is for, as a string the hash binds. */
export function targetKey(target: PurgeTarget): string {
  return "all" in target ? "all" : `${target.kind}:${target.id}`;
}

/** A target from a request body, or null. */
export function parseTarget(value: unknown): PurgeTarget | null {
  const t = value as { all?: unknown; kind?: unknown; id?: unknown } | null | undefined;
  if (!t || typeof t !== "object") return null;
  if (t.all === true) return { all: true };
  if ((t.kind === "document" || t.kind === "folder") && typeof t.id === "string" && safeSegment(t.id)) {
    return { kind: t.kind, id: t.id };
  }
  return null;
}

function hashOf(uid: string, key: string, code: string): string {
  return createHash("sha256").update(`${uid}:${key}:${code}`).digest("hex");
}

interface Challenge {
  hash?: string;
  key?: string;
  expiresAt?: number;
  attempts?: number;
  sentAt?: number;
  reservationId?: string;
  attemptIds?: string[];
  /** The request that spent the right code. */
  usedBy?: string;
}

/** The address a code went to, as the dialog shows it: `p•••@example.com`. */
export function maskAddress(email: string): string {
  const at = email.lastIndexOf("@");
  return at <= 0 ? "your address" : `${email[0]}•••${email.slice(at)}`;
}

const ref = (db: Db, uid: string) => db.collection("purgeCodes").doc(uid);

/**
 * Reserve a code for `key`, replacing any earlier one, unless one was sent
 * less than a minute ago. Reserved before it is sent, so a retried
 * transaction never mails a code that is not the one kept.
 */
export async function reservePurgeCode(db: Db, uid: string, key: string, code: string): Promise<"reserved" | "cooldown"> {
  const reservationId = randomBytes(16).toString("hex");
  return db.runTransaction(async (tx) => {
    const existing = (await tx.get(ref(db, uid))).data() as Challenge | undefined;
    if (existing?.reservationId === reservationId) return "reserved";
    const at = Date.now();
    if (existing?.sentAt && at - existing.sentAt < PURGE_RESEND_GAP_MS) return "cooldown";
    tx.set(ref(db, uid), {
      hash: hashOf(uid, key, code),
      key,
      expiresAt: at + PURGE_CODE_TTL_MS,
      attempts: 0,
      sentAt: at,
      reservationId,
    });
    return "reserved";
  });
}

export type PurgeCheck = { status: 200 } | { status: 400 | 409 | 429; error: string };

/**
 * Spend `code` on `key`. The right code is marked used as it is accepted, so
 * it confirms one purge and no other, and `retirePurgeCode` removes it once
 * that purge is done; a wrong one costs a guess, and the sixth attempt, right
 * or wrong, retires the code.
 */
export async function checkPurgeCode(db: Db, uid: string, key: string, code: string): Promise<PurgeCheck> {
  const attemptId = randomBytes(16).toString("hex");
  return db.runTransaction(async (tx): Promise<PurgeCheck> => {
    const challenge = (await tx.get(ref(db, uid))).data() as Challenge | undefined;
    if (!challenge?.hash) return { status: 409, error: "no code is waiting; ask for one" };
    // A retried transaction finds what its first attempt committed: the code
    // it spent, or the guess it was charged, never a second of either.
    if (challenge.usedBy === attemptId) return { status: 200 };
    if (challenge.usedBy) return { status: 409, error: "that code has been used; ask for a new one" };
    const attemptIds = Array.isArray(challenge.attemptIds) ? challenge.attemptIds : [];
    if (attemptIds.includes(attemptId)) return { status: 400, error: "that code is not right" };
    if (challenge.key !== key) return { status: 409, error: "that code was sent for something else; ask for a new one" };
    if (Number(challenge.expiresAt ?? 0) < Date.now()) {
      tx.delete(ref(db, uid));
      return { status: 409, error: "that code has expired; ask for a new one" };
    }
    if (Number(challenge.attempts ?? 0) >= PURGE_MAX_ATTEMPTS) {
      tx.delete(ref(db, uid));
      return { status: 429, error: "too many attempts; ask for a new code" };
    }
    if (hashOf(uid, key, code) !== challenge.hash) {
      tx.update(ref(db, uid), { attempts: Number(challenge.attempts ?? 0) + 1, attemptIds: [...attemptIds, attemptId] });
      return { status: 400, error: "that code is not right" };
    }
    tx.update(ref(db, uid), { usedBy: attemptId });
    return { status: 200 };
  }, { maxAttempts: PURGE_MAX_ATTEMPTS + 3 });
}

/** Remove a spent code, unless a newer one has been asked for since. */
export async function retirePurgeCode(db: Db, uid: string): Promise<void> {
  await db.runTransaction(async (tx) => {
    const challenge = (await tx.get(ref(db, uid))).data() as Challenge | undefined;
    if (challenge?.usedBy) tx.delete(ref(db, uid));
  });
}
