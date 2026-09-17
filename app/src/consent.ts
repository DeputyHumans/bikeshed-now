// SPDX-License-Identifier: Apache-2.0
// Whether this visitor has agreed to analytics cookies (SPEC §15).

/**
 * Why this exists, when SPEC §15 argued it would not be needed.
 *
 * The original reasoning was: there is no anonymous browsing, everything is
 * behind sign-in, so consent can live on the account and no banner is required.
 * That was true when it was written. **Public and unlisted sharing (SPEC §17)
 * made it false** — a signed-out reader now loads the app, and `initAnalytics`
 * runs for them like anybody else, setting `_ga` cookies for somebody who has
 * not been asked and has no account to carry a preference on.
 *
 * So consent is a per-visitor decision stored per-visitor, and analytics does
 * not initialize until it is granted. Denial is remembered, and is honoured by
 * never loading the measurement script at all rather than loading it and
 * switching it off — a request that is never made cannot be logged by anybody.
 *
 * The SESSION cookie is not covered here and deliberately needs no consent: it
 * is strictly necessary to serve a document to the person who asked for one,
 * which is the one category that never requires it.
 */

const KEY = "bshd-consent";

export type Consent = "granted" | "denied" | "unset";

/**
 * Read the stored choice.
 *
 * Every access is wrapped: storage throws in a private window, with site data
 * blocked, and inside some embedded webviews. An unreadable store means we have
 * not been told yes, which is the safe reading of silence.
 */
export function readConsent(): Consent {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "granted" || value === "denied" ? value : "unset";
  } catch {
    return "unset";
  }
}

/** Record the choice. A failure to persist is not a failure to honour it. */
export function writeConsent(value: Exclude<Consent, "unset">): void {
  try {
    window.localStorage.setItem(KEY, value);
  } catch {
    /* Honoured for this page either way: the caller holds it in state. */
  }
}
