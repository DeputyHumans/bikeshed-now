// SPDX-License-Identifier: Apache-2.0
// Every tunable the functions share: region, limits, bucket, secrets (SPEC §8).

import { defineSecret } from "firebase-functions/params";

/** FIXED. Hosting rewrites only reach functions in us-central1. */
export const REGION = "us-central1";

/** Session cookie lifetime. */
export const SESSION_EXPIRES_MS = 5 * 24 * 60 * 60 * 1000;

/** The only cookie Firebase Hosting forwards to a function. */
export const SESSION_COOKIE_NAME = "__session";

/** Upper bound on a bundle held in memory at upload or commit time. */
export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;

/**
 * Largest active-time delta a single reading heartbeat may contribute. The
 * client beats every 60s, so anything past a few minutes is a stale tab, a clock
 * jump, or a forged payload — clamp rather than trust it.
 */
export const MAX_BEAT_MS = 5 * 60 * 1000;

/** Hard ceiling on one reading session, so a pinned tab cannot inflate totals. */
export const MAX_SESSION_MS = 8 * 60 * 60 * 1000;

/** How long a verification code is valid. Short, because it is re-issuable. */
export const VERIFY_TTL_MS = 15 * 60 * 1000;

/** How long something stays in the Trash before the daily job deletes it forever (SPEC §4, ADR 0025). */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a code to delete from the Trash is valid: one sitting, not one day. */
export const PURGE_CODE_TTL_MS = 10 * 60 * 1000;

/** Minimum gap between two comment notifications to the same person about the same doc. */
export const COMMENT_EMAIL_COOLDOWN_MS = 30 * 60 * 1000;

/** Cache lifetime for non-private content. Also the revocation latency (SPEC §17). */
export const PUBLIC_CACHE_SECONDS = 300;

/**
 * The Resend API key.
 *
 * A Firebase secret rather than an env var, so it never lands on disk. Email is
 * OPTIONAL by design: with no key configured every send is a logged no-op and
 * the app behaves exactly as it does with one. That is the path CI exercises,
 * and it is why the quickstart does not require a Resend account.
 */
export const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

/** Project id, as the runtime reports it. */
export function projectId(): string {
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
}

/**
 * The private content bucket.
 *
 * The Firebase DEFAULT bucket is deliberately never assumed. Its name changed:
 * `${projectId}.appspot.com` is wrong for projects created after 2024, and
 * `.firebasestorage.app` is wrong for those created before. Guessing either way
 * means writes land in a bucket nobody reads, or deletes remove nothing while
 * reporting success. So: explicit env var first, then a derived name that
 * `setup.mjs` actually creates. Opting into the Firebase default bucket is
 * supported — you set BIKESHED_BUCKET to it, deliberately.
 */
export function bucketName(): string {
  const explicit = process.env.BIKESHED_BUCKET;
  if (explicit && explicit.length > 0) return explicit;
  return `${projectId()}-content`;
}

/** Public origin for links in email and sitemap.xml. */
export function publicOrigin(): string {
  const configured = process.env.BIKESHED_PUBLIC_ORIGIN;
  if (configured && configured.length > 0) return configured.replace(/\/+$/, "");
  const id = projectId();
  return id ? `https://${id}.web.app` : "";
}

/**
 * The address transactional email is sent FROM.
 *
 * Separate from `publicOrigin()` on purpose, because the domain a deployment
 * SERVES from and the one it is allowed to SEND from are not the same thing and
 * usually cannot be. A default Firebase deployment serves on `*.web.app`, which
 * no one can verify with an email provider — so deriving the sender from the
 * serving origin made email structurally impossible on exactly the deployments
 * most likely to be someone's first.
 *
 * Unset, it falls back to the old behaviour: noreply@<publicOrigin host>. That
 * keeps a deployment whose serving domain IS its verified sending domain
 * working with no configuration.
 */
export function mailFrom(): string {
  const configured = process.env.BIKESHED_MAIL_FROM;
  if (configured && configured.trim().length > 0) return configured.trim();
  const host = publicOrigin().replace(/^https?:\/\//, "") || "localhost";
  return `Bikeshed <noreply@${host}>`;
}

/** One sentence for someone the allowlist rejected. Never the allowlist itself. */
export function signInHint(): string {
  return process.env.BIKESHED_SIGN_IN_HINT || "";
}

/**
 * Who may trust a document for everyone (ADR 0021): `BIKESHED_SUPERADMINS`,
 * addresses separated by commas or spaces, lowercased. Deployment
 * configuration, never committed. Unset means nobody — the safe default.
 */
export function superadmins(): ReadonlySet<string> {
  const raw = process.env.BIKESHED_SUPERADMINS ?? "";
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/** True inside the Firebase emulator suite. */
export function isEmulated(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true";
}
