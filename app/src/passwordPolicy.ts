// SPDX-License-Identifier: Apache-2.0
// Turn Firebase's password-policy verdict into something a person can act on (SPEC §13).

import type { PasswordValidationStatus } from "firebase/auth";

/**
 * The policy is NOT restated here, and that is the point.
 *
 * Which rules apply is configured in the Firebase console, and this deployment
 * currently asks for eight characters with a lower case letter, an upper case
 * letter, a digit and a symbol. Hardcoding that list would put the requirements
 * in two places, and the copy in the browser would quietly start lying the day
 * somebody changed the console.
 *
 * So `validatePassword()` fetches the live policy and reports which parts of it
 * a candidate meets; this only labels the verdict. Turn a requirement off in
 * the console and its line disappears from the form with no code change.
 */
export interface Requirement {
  key: string;
  label: string;
  met: boolean;
}

/**
 * Only the rules the deployment actually enforces.
 *
 * The status flags are `undefined` for a rule that is switched off, which is
 * exactly the distinction needed: `undefined` means "not asked for" and must
 * not render as an unmet requirement somebody cannot satisfy.
 */
export function requirementsFrom(status: PasswordValidationStatus): Requirement[] {
  const options = status.passwordPolicy?.customStrengthOptions ?? {};
  const out: Requirement[] = [];

  const min = options.minPasswordLength;
  if (typeof min === "number") {
    out.push({
      key: "length",
      label: `At least ${min} characters`,
      met: status.meetsMinPasswordLength === true,
    });
  }
  if (options.containsLowercaseLetter) {
    out.push({
      key: "lower",
      label: "A lower case letter",
      met: status.containsLowercaseLetter === true,
    });
  }
  if (options.containsUppercaseLetter) {
    out.push({
      key: "upper",
      label: "An upper case letter",
      met: status.containsUppercaseLetter === true,
    });
  }
  if (options.containsNumericCharacter) {
    out.push({
      key: "digit",
      label: "A number",
      met: status.containsNumericCharacter === true,
    });
  }
  if (options.containsNonAlphanumericCharacter) {
    out.push({
      key: "symbol",
      label: "A symbol, such as ! ? or #",
      met: status.containsNonAlphanumericCharacter === true,
    });
  }

  // A maximum exists in every policy and is 4096 by default. Showing it as a
  // requirement would be noise for every password a person would ever type, so
  // it appears only once it is actually in the way.
  const max = options.maxPasswordLength;
  if (typeof max === "number" && status.meetsMaxPasswordLength === false) {
    out.push({ key: "max", label: `At most ${max} characters`, met: false });
  }

  return out;
}

/** True when every rule this deployment enforces is satisfied. */
export function allMet(requirements: Requirement[]): boolean {
  return requirements.length > 0 && requirements.every((r) => r.met);
}
