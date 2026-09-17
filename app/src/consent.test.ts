// SPDX-License-Identifier: Apache-2.0
// Consent gates analytics, and silence is never a yes (SPEC §15).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readConsent, writeConsent } from "./consent";

/**
 * The bug this guards against is not hypothetical — it shipped.
 *
 * SPEC §15 argued no cookie banner was needed because "there is no anonymous
 * browsing". Public and unlisted sharing (§17) made that false, and
 * `initAnalytics()` ran for every visitor including signed-out readers of a
 * public document, setting `_ga` cookies for somebody who had never been asked.
 */

describe("consent", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("treats an unanswered visitor as NOT consenting", () => {
    expect(readConsent()).toBe("unset");
  });

  it("round-trips a granted and a denied answer", () => {
    writeConsent("granted");
    expect(readConsent()).toBe("granted");
    writeConsent("denied");
    expect(readConsent()).toBe("denied");
  });

  it("treats a corrupted value as unanswered, never as granted", () => {
    // A stale or tampered value must not read as permission.
    window.localStorage.setItem("bshd-consent", "yes-please");
    expect(readConsent()).toBe("unset");
  });

  it("survives storage that throws, and still does not assume consent", () => {
    // Private windows, blocked site data and some embedded webviews all throw
    // on access. An unreadable store means we have not been told yes.
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    try {
      expect(readConsent()).toBe("unset");
      expect(() => writeConsent("granted")).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe("analytics is gated on consent", () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
  });

  /**
   * The assertion that matters: with analytics fully CONFIGURED, an unanswered
   * visitor must still not cause the measurement script to load. Config and
   * firebase are stubbed so this does not depend on which .env file happens to
   * be present — the first version of this test asserted against ambient env
   * and passed only by accident.
   */
  async function initWith(consent: "unset" | "granted" | "denied") {
    if (consent !== "unset") writeConsent(consent);
    const initializeAnalytics = vi.fn(() => ({}) as never);
    vi.doMock("./config", () => ({
      MEASUREMENT_ID: "G-TESTONLY",
      USE_EMULATORS: false,
    }));
    vi.doMock("./firebase", () => ({ app: {} }));
    vi.doMock("firebase/analytics", () => ({
      initializeAnalytics,
      isSupported: async () => true,
      logEvent: vi.fn(),
      setAnalyticsCollectionEnabled: vi.fn(),
    }));
    const analytics = await import("./analytics");
    expect(analytics.analyticsConfigured()).toBe(true);
    analytics.initAnalytics();
    // resolve() is async inside; let its microtasks run.
    await new Promise((r) => setTimeout(r, 0));
    return initializeAnalytics;
  }

  it("does NOT initialize for a visitor who has not answered", async () => {
    const init = await initWith("unset");
    expect(init).not.toHaveBeenCalled();
  });

  it("does NOT initialize for a visitor who declined", async () => {
    const init = await initWith("denied");
    expect(init).not.toHaveBeenCalled();
  });

  it("initializes once consent is granted", async () => {
    const init = await initWith("granted");
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("initializes when consent is granted AFTER a refusal, in the same page", async () => {
    /**
     * The case that shipped broken, and that every test above missed because
     * each ran in a fresh module registry.
     *
     * The consent check lived inside the memoized async body and reset `ready`
     * from within it. That body runs synchronously up to its first await, so it
     * cleared `ready` a moment before the outer assignment overwrote it with
     * the promise that had just resolved to null — memoizing the refusal
     * forever. Clicking Allow then did nothing at all.
     */
    const initializeAnalytics = vi.fn(() => ({}) as never);
    vi.doMock("./config", () => ({ MEASUREMENT_ID: "G-TESTONLY", USE_EMULATORS: false }));
    vi.doMock("./firebase", () => ({ app: {} }));
    vi.doMock("firebase/analytics", () => ({
      initializeAnalytics,
      isSupported: async () => true,
      logEvent: vi.fn(),
      setAnalyticsCollectionEnabled: vi.fn(),
    }));
    const analytics = await import("./analytics");

    // Unanswered: nothing loads.
    analytics.initAnalytics();
    await new Promise((r) => setTimeout(r, 0));
    expect(initializeAnalytics).not.toHaveBeenCalled();

    // The visitor now clicks Allow, in the SAME page — no reload.
    writeConsent("granted");
    analytics.initAnalytics();
    await new Promise((r) => setTimeout(r, 0));
    expect(initializeAnalytics).toHaveBeenCalledTimes(1);
  });
});
