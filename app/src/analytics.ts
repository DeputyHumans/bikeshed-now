// SPDX-License-Identifier: Apache-2.0
// Product analytics: eleven events, no identifiers, opt-out on the account (SPEC §15).

import type { Analytics } from "firebase/analytics";
import { app } from "./firebase";
import { MEASUREMENT_ID, USE_EMULATORS } from "./config";

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
  | { name: "login"; params: { method: "google" | "github" } }
  | { name: "sign_up"; params: { method: "google" | "github" } }
  | { name: "doc_publish"; params: { source: "cli" | "upload" | "mcp"; format: "html" | "markdown" } }
  | { name: "doc_open"; params: { format: "html" | "markdown"; sandboxed: boolean } }
  | { name: "annotation_create"; params: Record<string, never> }
  | { name: "comment_create"; params: Record<string, never> }
  | { name: "version_commit"; params: { format: "html" | "markdown" } }
  | { name: "export"; params: { kind: "pdf" | "png" | "svg" | "html" | "zip" } }
  | { name: "share_grant"; params: { role: "viewer" | "editor"; principal: "person" | "team" } }
  | { name: "trust_grant"; params: { scope: "global" | "personal" } };

let instance: Analytics | null = null;
let ready: Promise<Analytics | null> | null = null;
let optedOut = false;

/** Resolve the Analytics instance once, or null forever. */
function resolve(): Promise<Analytics | null> {
  if (ready) return ready;
  ready = (async () => {
    if (!MEASUREMENT_ID || USE_EMULATORS) return null;
    try {
      const { initializeAnalytics, isSupported } = await import("firebase/analytics");
      if (!(await isSupported())) return null;
      instance = initializeAnalytics(app, {
        // The one line that keeps document slugs out of a third party's logs.
        config: { send_page_view: false },
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
 * Honour the account's preference.
 *
 * Consent lives on the account rather than in a banner because there is no
 * anonymous browsing to consent for: a signed-out visitor to a public document
 * never initializes analytics at all.
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
  return { name: event.name, params: { ...event.params } };
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
