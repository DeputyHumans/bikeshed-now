// SPDX-License-Identifier: Apache-2.0
// The options every function is defined with, and the handles every handler shares (SPEC §2).

import { setGlobalOptions } from "firebase-functions/v2/options";
import * as admin from "firebase-admin";
/**
 * FieldValue and Timestamp come from the MODULAR entry point, never through
 * `admin.firestore.*`.
 *
 * The Functions emulator wraps `firebase-admin` in a proxy so calls reach the
 * local services, and that proxy does not carry the static namespace properties
 * onto the callable `firestore` function — so `admin.firestore.FieldValue` is
 * `undefined` there and every write that stamps a timestamp throws. It works in
 * a deployed function, which is exactly why it survived 127 unit tests and was
 * only found by running the emulator suite. `Timestamp` then went the same way
 * on the one line that set an expiry, found the same way; `wiring.test.js`
 * now pins the shape.
 */
import { FieldValue } from "firebase-admin/firestore";
import { REGION, RESEND_API_KEY, bucketName, isEmulated } from "../config";
import { canRead, type DocAclData, type LinkProof } from "../lib/acl";
import { warnIfOriginUnconfigured } from "../lib/shell";

// Runtime update policy is managed by the operator API until the SDK exposes it.
setGlobalOptions({ preserveExternalChanges: true });

if (admin.apps.length === 0) {
  admin.initializeApp();
}

// Once, at load: the emulator with no origin answers every /d/** with 503,
// and the symptom is far from the cause.
warnIfOriginUnconfigured(process.env, isEmulated(), console.warn);

export const db = () => admin.firestore();
export const bucket = () => admin.storage().bucket(bucketName());
export const now = () => FieldValue.serverTimestamp();

/**
 * The status for a caller refused an action on a document that exists: 404
 * unless they may read it. A 403 confirms the id, which only a reader already
 * knows; answering 403 to anyone else would make every write endpoint the
 * existence check the read paths closed (SPEC §1.4b, §17).
 */
export function refusal(
  doc: DocAclData,
  caller: { uid: string; emailLower: string } | null,
  proof?: LinkProof,
): 403 | 404 {
  return canRead(doc, caller, proof) ? 403 : 404;
}


/** Functions that may send email declare the secret; the rest never load it. */
export const MAILING = { region: REGION, secrets: [RESEND_API_KEY] };
export const PLAIN = { region: REGION };
/**
 * The three services a document open waits on, in series: docShell, session,
 * contentProxy. Each is its own Cloud Run service and cold-starts on its own,
 * which put seconds in front of a first open (ADR 0011). One idle instance
 * each is a standing monthly charge, priced there; nothing else is warm.
 */
export const WARM = { ...PLAIN, minInstances: 1 };
/**
 * The two services that turn a whole HTML page into a Markdown reading:
 * `docMarkdown` and `mcp`'s `get_document` (ADR 0030). At the 256 MiB default,
 * reading a 2.2 MB page, production killed `docMarkdown` three times in thirty
 * seconds on 2026-11-17, and `mcp` on the fourth page of one read ("262 MiB
 * used"); each kill handed the next request a cold start. A Linux container
 * of the same size did NOT reproduce it (three readings peaked at 206 MiB), so
 * what production adds is unmeasured and only its log can show this is
 * enough. 1 GiB leaves room for several readings at once on `mcp`, which
 * takes up to 80 requests. Neither service is warm, so it is paid per request.
 */
export const READS_PAGES = { memory: "1GiB" } as const;
