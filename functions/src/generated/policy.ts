// SPDX-License-Identifier: Apache-2.0
// GENERATED — DO NOT EDIT.
// Rendered by tools/build-policy.mjs from config/access-policy.json.
// Edit the source and run `npm run build:policy`; CI byte-compares this file.
// source sha256: 309f8413ff70f3c681cc9cc5f947062d3ecdce61128e827ebc23152f4ee6b40c
// The deployment's identity policy, server side (SPEC §1).

export const ALLOWED_EMAIL_DOMAINS: readonly string[] = [];

export const POLICY_IS_OPEN = true;

const FORBIDDEN_CHARS = /[\s$#[\]/\\,;:"'<>()]/;
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]");
const LOCAL_OK = /^[a-z0-9!%&'*+=?^_`{|}~.-]+$/;
const DOMAIN_OK = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Structural validity: the shapes this system can store and key on (SPEC §1.3). */
export function isEmailShapeValid(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (e.length === 0 || e.length > 254) return false;
  if (FORBIDDEN_CHARS.test(e)) return false;
  if (CONTROL_CHARS.test(e)) return false;
  const at = e.indexOf("@");
  if (at <= 0 || at !== e.lastIndexOf("@")) return false;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (local.length === 0 || local.length > 64) return false;
  if (e.includes("..")) return false;
  if (local.startsWith(".") || local.endsWith(".")) return false;
  if (!LOCAL_OK.test(local)) return false;
  return DOMAIN_OK.test(domain);
}

/** Anchored per-entry matchers, precompiled once. */
const MATCHERS: readonly RegExp[] = [];

/**
 * True iff this deployment accepts the address.
 *
 * Shape is checked FIRST and always: an open policy accepts any address the
 * system can actually store, not any string. Without that conjunct
 * `isAllowedEmail("not an email")` would be true on the default configuration,
 * and the value would flow straight into an ACL array.
 */
export function isAllowedEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (!isEmailShapeValid(e)) return false;
  if (POLICY_IS_OPEN) return true;
  return MATCHERS.some((re) => re.test(e));
}
