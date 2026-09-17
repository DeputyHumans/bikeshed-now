// SPDX-License-Identifier: Apache-2.0
// Everything the client reads from its environment, in one place (SPEC §12, §15, §20).

import type { Marking } from "./types";

/**
 * Vite inlines every VITE_* value into the built bundle, so nothing here can be
 * secret. A Firebase web config is public by design and security comes from the
 * rules, not from hiding the project id — which is why `app/dist` is gitignored
 * but the values themselves are not treated as credentials.
 *
 * What IS kept out of git is the BINDING between this source tree and one
 * particular deployment. Everything tracked uses placeholders or the
 * emulator-only `demo-` prefix, which Firebase refuses to point at a real
 * backend.
 */

function env(name: string): string {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  return typeof value === "string" ? value.trim() : "";
}

function flag(name: string): boolean {
  const value = env(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export const USE_EMULATORS = flag("VITE_USE_EMULATORS");

export const firebaseConfig = {
  apiKey: env("VITE_FIREBASE_API_KEY"),
  authDomain: env("VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: env("VITE_FIREBASE_PROJECT_ID"),
  storageBucket: env("VITE_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: env("VITE_FIREBASE_MESSAGING_SENDER_ID"),
  appId: env("VITE_FIREBASE_APP_ID"),
  databaseURL: env("VITE_FIREBASE_DATABASE_URL") || undefined,
};

/**
 * Analytics initializes ONLY when a measurement id is configured.
 *
 * Clone this repository without one and there is no analytics, no
 * googletagmanager.com request, and no cookie. That is the same privacy posture
 * as self-hosting the font instead of linking a CDN, and for the same reason: a
 * self-hosted tool should not make third-party requests its operator did not
 * ask for (SPEC §15).
 */
export const MEASUREMENT_ID = env("VITE_FIREBASE_MEASUREMENT_ID");

/** Emulator ports. Read from firebase.json at build time would be nicer, but
 * Vite cannot import outside the app root at runtime; these mirror it and the
 * dev proxy is derived from the same file, so a mismatch shows up immediately. */
export const EMULATOR_PORTS = {
  auth: 9099,
  firestore: 8088,
  database: 9000,
} as const;

/**
 * The deployment's default export marking, which seeds each new ACCOUNT's
 * default, which in turn seeds each new document. Off unless configured, and
 * the document's own value is what is authoritative at export time (SPEC §20).
 */
export const DEPLOYMENT_MARKING: Marking = {
  enabled: flag("VITE_EXPORT_MARK_ENABLED"),
  label: env("VITE_EXPORT_MARK_LABEL"),
  footer: env("VITE_EXPORT_MARK_FOOTER"),
};

/**
 * Who to contact about the terms and the privacy policy.
 *
 * Per-deployment, because those documents describe the OPERATOR's handling of
 * data and not this project's. Unset, the pages say so plainly rather than
 * inventing an address — a privacy policy naming a mailbox nobody reads is
 * worse than one that admits it has none.
 */
export const LEGAL_CONTACT = env("VITE_LEGAL_CONTACT");

/** True when the app is talking to a real backend rather than the emulators. */
export const IS_LIVE = !USE_EMULATORS && firebaseConfig.projectId.length > 0;
