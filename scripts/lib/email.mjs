// SPDX-License-Identifier: Apache-2.0
// Email normalization and the deployment's identity policy, for scripts (SPEC §1).

/**
 * Scripts are ESM and can import the policy module directly, so unlike the two
 * TypeScript runtimes they need no generated mirror. One fewer artifact to keep
 * in step.
 */
export {
  isAllowedEmail,
  isEmailShapeValid,
  normalizeEmail,
} from "../../config/policy.mjs";

import { isAllowedEmail, normalizeEmail } from "../../config/policy.mjs";

/**
 * Normalize and validate a list of addresses, throwing on the first one this
 * deployment will not accept.
 *
 * Throwing rather than filtering is deliberate: a script that silently drops a
 * mistyped address reports success while granting nobody anything, which is the
 * failure mode hardest to notice.
 */
export function assertUsableEmails(emails) {
  const list = (Array.isArray(emails) ? emails : [emails])
    .map(normalizeEmail)
    .filter(Boolean);
  const bad = list.filter((e) => !isAllowedEmail(e));
  if (bad.length > 0) {
    throw new Error(`address(es) this deployment will not accept: ${bad.join(", ")}`);
  }
  return list;
}
