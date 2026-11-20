// SPDX-License-Identifier: Apache-2.0
// The name the app draws for an e2e account, which has no sign-in name: first name and last initial from its address (SPEC §16 "Names", ADR 0040).

/**
 * Every e2e account signs in with a password, so the provider gives no name
 * and the app names it from its address, `owner-ab12cd-x9f2@example.com` →
 * "Owner X". Written out here from the rule SPEC §16 states, not imported
 * from the app, so a change to the app's rule shows up as a failing case
 * rather than as two implementations drifting together.
 */
export function nameOfAddress(email) {
  const local = String(email).toLowerCase().split("@")[0] ?? "";
  const parts = local.split("+")[0].split(/[._-]+/).filter((p) => p && !/^\d+$/.test(p));
  if (parts.length === 0) return local;
  const capital = (w) => w.charAt(0).toLocaleUpperCase() + w.slice(1);
  const first = capital(parts[0]);
  if (parts.length === 1) return first;
  return `${first} ${Array.from(parts[parts.length - 1])[0].toLocaleUpperCase()}`;
}

/** For a RegExp built around a name. */
export const escapeName = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
