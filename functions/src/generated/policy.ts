// SPDX-License-Identifier: Apache-2.0
// GENERATED — DO NOT EDIT.
// Rendered by tools/build-policy.mjs from config/access-policy.json.
// Edit the source and run `npm run build:policy`; CI byte-compares this file.
// source sha256: 309f8413ff70f3c681cc9cc5f947062d3ecdce61128e827ebc23152f4ee6b40c
// The deployment's identity policy, server side (SPEC §1).

export const ALLOWED_EMAIL_DOMAINS: readonly string[] = [];

export const POLICY_IS_OPEN = true;

/** Anchored per-entry matchers, precompiled once. */
const MATCHERS: readonly RegExp[] = [];

/** True iff the deployment's allowlist permits this (already-normalized) email. */
export function isAllowedEmail(emailLower: string): boolean {
  if (POLICY_IS_OPEN) return true;
  return MATCHERS.some((re) => re.test(emailLower));
}
