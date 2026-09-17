// SPDX-License-Identifier: Apache-2.0
// GENERATED — DO NOT EDIT.
// Rendered by tools/build-policy.mjs from config/access-policy.json.
// Edit the source and run `npm run build:policy`; CI byte-compares this file.
// source sha256: 309f8413ff70f3c681cc9cc5f947062d3ecdce61128e827ebc23152f4ee6b40c
// The client's half of the identity policy (SPEC §1).
//
// Deliberately list-free: Vite inlines this module into the public bundle, so
// the allowlist itself must never appear here. The client gets the shape rules
// (so a sign-up form can validate before a round trip) and one boolean.
//
// The validator body below is emitted from config/policy.mjs' own function, not
// retyped — one implementation, rendered twice, so client and server cannot
// disagree about which addresses exist.

export const POLICY_IS_OPEN = true;

const FORBIDDEN_CHARS = /[\s$#[\]/\\,;:"'<>()]/;
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]");
const LOCAL_OK = /^[a-z0-9!%&'*+=?^_`{|}~.-]+$/;
const DOMAIN_OK = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Structural validity — the same rule the server applies (SPEC §1). */
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
