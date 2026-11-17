// SPDX-License-Identifier: Apache-2.0
// Health, the session cookie and the app's runtime config (SPEC §2, §3, §14).

import { healthHandler } from "../lib/health";
import healthConfig from "../health.json";
import { onRequest, type Request } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as cookie from "cookie";
import { SESSION_COOKIE_NAME, SESSION_EXPIRES_MS, signInHint } from "../config";
import { verifyIdToken } from "../lib/auth";
import { googleAddress, requestMove } from "../lib/accountmove";
import { jsonBody, rejectMethod } from "../lib/http";
import { db, bucket, PLAIN, WARM } from "./runtime";

/** Public operational health; never reads user documents or writes state. */
export const health = onRequest({ ...PLAIN, timeoutSeconds: 10 }, healthHandler({
  firestore: () => db().doc(healthConfig.firestorePath).get(),
  storage: async () => {
    const [bytes] = await bucket().file(healthConfig.storagePath).download({ start: 0, end: 63, validation: false });
    if (bytes.toString("utf8") !== healthConfig.marker) throw new Error("health marker mismatch");
  },
  report: (dependency) => console.error(JSON.stringify({ severity: "ERROR", event: "dependency_health_failed", dependency })),
}));

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Extract `idToken` from a JSON body, tolerant of how the runtime parsed it. */
function extractIdToken(req: Request): string | null {
  const body = jsonBody(req) as { idToken?: unknown } | null;
  const token = body?.idToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * POST /session — mint the __session cookie. DELETE /session — clear it.
 *
 * The response carries a TYPED OUTCOME rather than a bare status code, because
 * "verify your email" and "this deployment does not accept your address" are
 * different states with different next actions. Collapsing both into 401 is how
 * a sign-in screen ends up looking broken to the one person who most needs to
 * understand what happened.
 */
export const session = onRequest(WARM, async (req, res) => {
  if (req.method === "DELETE") {
    res.setHeader(
      "Set-Cookie",
      cookie.serialize(SESSION_COOKIE_NAME, "", {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
        maxAge: 0,
      }),
    );
    res.status(204).end();
    return;
  }
  if (rejectMethod(req, res, ["POST"])) return;

  const idToken = extractIdToken(req);
  if (!idToken) {
    res.status(401).json({ status: "session_failed" });
    return;
  }

  const gate = await verifyIdToken(idToken);
  if (!gate.ok) {
    if (gate.reason === "unverified") {
      res.status(200).json({ status: "unverified" });
      return;
    }
    if (gate.reason === "not_allowed") {
      res.status(403).json({ status: "not_allowed", message: signInHint() });
      return;
    }
    res.status(401).json({ status: "session_failed" });
    return;
  }

  /**
   * Google renamed this account (SPEC §14, ADR 0020). The browser sends
   * Google's own token only when the two addresses differ; `googleAddress`
   * believes nothing but Google's signature, bound to this account by `sub`.
   * The move itself is a job a trigger finishes: Hosting cuts a request at
   * sixty seconds, and a move can touch every document the person can see.
   * No cookie: this token names the address the account is leaving. Anything
   * that fails here signs the person in as they were, which is no worse than
   * before.
   */
  const googleIdToken = (jsonBody(req) as { googleIdToken?: unknown } | null)?.googleIdToken;
  if (googleIdToken !== undefined) {
    try {
      const to = await googleAddress(googleIdToken, gate.googleSubs);
      if (to && to !== gate.principal.emailLower) {
        const jobId = await requestMove(db(), gate.principal.uid, gate.principal.emailLower, to);
        res.status(200).json({ status: "moving", jobId, to });
        return;
      }
    } catch (err) {
      console.error("could not start an account move:", (err as Error)?.message ?? err);
    }
  }

  let sessionCookie: string;
  try {
    sessionCookie = await admin
      .auth()
      .createSessionCookie(idToken, { expiresIn: SESSION_EXPIRES_MS });
  } catch (err) {
    /**
     * LOG IT. The client still learns only "session_failed" — it must not be
     * told whether the token was bad or the deployment is misconfigured — but
     * swallowing this server-side made the two indistinguishable to the
     * OPERATOR too, which is the person who can actually fix it.
     *
     * The realistic cause is not a bad token: minting a session cookie signs a
     * JWT, so the runtime service account needs `iam.serviceAccounts.signBlob`
     * on itself (roles/iam.serviceAccountTokenCreator). A fresh project does
     * not grant that, and the symptom is every sign-in failing with no trace.
     */
    console.error("createSessionCookie failed:", (err as Error)?.message ?? err);
    res.status(401).json({ status: "session_failed" });
    return;
  }

  /**
   * The account record, keyed by uid and carrying the verified address (SPEC
   * §14, sign-up step 4). Every email that names a person finds them through
   * it — `uidForEmail` — and skips anyone without one, silently, by design for
   * an address with no account yet. Only the code-verification path and the
   * account screen used to write it, so an account whose address arrived
   * verified (Google, GitHub) had none and was never told about a comment or a
   * suggestion. Written here, at the one door every sign-in passes, merged so
   * a preference already saved survives. A failure is logged and does not
   * refuse the sign-in: the cost of losing it is a missed email, not access.
   */
  try {
    await db()
      .collection("users")
      .doc(gate.principal.uid)
      .set({ uid: gate.principal.uid, email: gate.principal.emailLower }, { merge: true });
  } catch (err) {
    console.error("could not write the account record:", (err as Error)?.message ?? err);
  }

  res.setHeader(
    "Set-Cookie",
    cookie.serialize(SESSION_COOKIE_NAME, sessionCookie, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: Math.floor(SESSION_EXPIRES_MS / 1000),
    }),
  );
  res.status(200).json({ status: "ok" });
});

/**
 * GET /config — the only thing a signed-out client is told about policy.
 *
 * One deployment-authored sentence for the rejection screen. Never the
 * allowlist: publishing the list of domains that may sign in publishes the
 * deployment's membership policy to every anonymous visitor.
 */
export const appConfig = onRequest({ ...PLAIN, cors: true }, async (req, res) => {
  if (rejectMethod(req, res, ["GET"])) return;
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json({ signInHint: signInHint() });
});
