// SPDX-License-Identifier: Apache-2.0
// Product analytics: eleven events, no identifiers, opt-out on the account (SPEC §15).

import type { Analytics } from "firebase/analytics";
import { app } from "./firebase";
import { MEASUREMENT_ID, USE_EMULATORS } from "./config";
import { readConsent } from "./consent";
import type { Role } from "./types";

/**
 * Three things here are easy to get wrong, and one of them is a real leak.
 *
 * 1. `getAnalytics()` THROWS in unsupported environments. Skip the
 *    `isSupported()` guard and a browser with third-party storage blocked fails
 *    this module's initialization and takes sign-in down with it.
 *
 * 2. Never under emulators, or local development pollutes production data.
 *
 * 3. THE IMPORTANT ONE: the automatic page view sends `page_location`, the full
 *    URL, and this app's URLs are /d/{docId}/{versionId}. The document slug is
 *    frequently the confidential thing — a real corpus has slugs like
 *    "q3-acquisition-memo". So automatic collection is switched OFF and route
 *    changes are logged manually as route PATTERNS.
 *
 * No document id, title, slug, folder name or email is ever sent. Parameters
 * are enums and counts only, and the event-builder test asserts it.
 *
 * This is NOT the product's first-party reading statistics (SPEC §4). Those
 * answer "who read this document and for how long" and live in the owner's own
 * Firestore, gated by the ACL. This answers "how is the product used" in
 * aggregate. Neither grows to cover the other's job.
 */

export type AnalyticsEvent =
  | { name: "page_view"; params: { page_path: string } }
  | { name: "login"; params: { method: "google" | "github" | "password" } }
  | { name: "sign_up"; params: { method: "google" | "github" | "password" } }
  | { name: "doc_publish"; params: { source: "cli" | "upload" | "mcp"; format: "html" | "markdown" } }
  | { name: "doc_open"; params: { format: "html" | "markdown"; sandboxed: boolean } }
  | { name: "annotation_create"; params: Record<string, never> }
  | { name: "comment_create"; params: Record<string, never> }
  | { name: "version_commit"; params: { format: "html" | "markdown" } }
  | { name: "export"; params: { kind: "pdf" | "png" | "svg" | "html" | "zip" } }
  | { name: "share_grant"; params: { role: Role; principal: "person" | "team" } }
  | { name: "trust_grant"; params: { scope: "global" | "personal" } };

let instance: Analytics | null = null;
let ready: Promise<Analytics | null> | null = null;
let optedOut = false;

/**
 * True when this deployment could collect anything at all.
 *
 * Exported so the consent banner can stay hidden on a deployment that has no
 * measurement id: asking somebody to consent to something that cannot happen is
 * a dark pattern in the shape of diligence.
 */
export function analyticsConfigured(): boolean {
  return Boolean(MEASUREMENT_ID) && !USE_EMULATORS;
}

/**
 * Resolve the Analytics instance once, or null until consent changes.
 *
 * The two guards are OUTSIDE the memo deliberately. An earlier version put the
 * consent check inside the async body and reset `ready` from in there, which
 * does not work: the body runs synchronously up to its first await, so it
 * cleared `ready` before the outer `ready = (...)()` assignment overwrote it
 * with the very promise that had just resolved to null. Consent could then be
 * granted and nothing would ever initialize — which is exactly what the
 * deployment did, while the unit tests passed because each case ran in a fresh
 * module registry and never granted consent after a refusal.
 *
 * Checking before memoizing means a refusal costs nothing and is not sticky.
 */
function resolve(): Promise<Analytics | null> {
  if (!analyticsConfigured()) return Promise.resolve(null);
  // Denial means the measurement script is never fetched, rather than fetched
  // and then disabled — a request nobody sends cannot be logged by anybody.
  if (readConsent() !== "granted") return Promise.resolve(null);
  if (ready) return ready;
  ready = (async () => {
    try {
      const { initializeAnalytics, isSupported } = await import("firebase/analytics");
      if (!(await isSupported())) return null;
      instance = initializeAnalytics(app, {
        config: {
          // The one line that keeps document slugs out of a third party's logs.
          send_page_view: false,
          // gtag emits session_start, first_visit and user_engagement on its
          // own and attaches page_title from document.title, which the viewer
          // sets to the document's own title. `buildEvent` pins the constant
          // on the events this app logs; this pins it on the tag's.
          page_title: "Bikeshed",
        },
      });
      return instance;
    } catch {
      return null;
    }
  })();
  return ready;
}

/** Start analytics if this deployment configured it. Safe to call repeatedly. */
export function initAnalytics(): void {
  void resolve();
}

/**
 * Honour the account's preference, on top of the visitor's consent.
 *
 * The two are different questions and both must be satisfied. Consent
 * (`consent.ts`) is per-visitor and gates whether the measurement script loads
 * at all; this is per-account and travels with the person across their devices.
 * An account opt-out cannot re-enable something consent has denied, because
 * `resolve()` returns null and there is nothing to enable.
 */
export async function setAnalyticsOptOut(value: boolean): Promise<void> {
  optedOut = value;
  const analytics = await resolve();
  if (!analytics) return;
  const { setAnalyticsCollectionEnabled } = await import("firebase/analytics");
  setAnalyticsCollectionEnabled(analytics, !value);
}

/**
 * Turn a concrete path into the PATTERN it matches.
 *
 * `/d/q3-acquisition-memo/v3` becomes `/d/:docId/:versionId`. Exported so the
 * test can assert the mapping directly rather than inferring it from a mock.
 */
export function routePattern(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  switch (segments[0]) {
    case "d":
      return segments.length > 2 ? "/d/:docId/:versionId" : "/d/:docId";
    case "folder":
      return "/folder/:folderId";
    default:
      return `/${segments[0]}`;
  }
}

/**
 * Build the payload for an event.
 *
 * Separated from sending so the test can assert — over every event shape — that
 * no identifier ever appears in a payload. That assertion is the actual
 * guarantee; the comments above are just its explanation.
 */
export function buildEvent(event: AnalyticsEvent): {
  name: string;
  params: Record<string, string | number | boolean>;
} {
  if (event.name === "page_view") {
    const pattern = event.params.page_path;
    // All three are set explicitly to the PATTERN. Leaving any of them to
    // gtag's defaults re-introduces the full URL.
    return {
      name: "page_view",
      params: { page_path: pattern, page_location: pattern, page_title: pattern },
    };
  }
  // GA4 attaches page_title from document.title automatically, and the
  // viewer now sets that to the document's own title — so every OTHER event
  // has to pin it back to the constant, or a document's title rides along on
  // doc_open, comment_create, every event this app logs (SPEC §15).
  return { name: event.name, params: { ...event.params, page_title: "Bikeshed" } };
}

export function logEvent(event: AnalyticsEvent): void {
  if (optedOut) return;
  void resolve().then(async (analytics) => {
    if (!analytics) return;
    const built = buildEvent(event);
    const { logEvent: log } = await import("firebase/analytics");
    log(analytics, built.name, built.params);
  });
}

/** Log a route change as a pattern. Never the concrete path. */
export function logPageView(pathname: string): void {
  logEvent({ name: "page_view", params: { page_path: routePattern(pathname) } });
}
