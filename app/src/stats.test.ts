// SPDX-License-Identifier: Apache-2.0
// The reading clock measures ATTENTION, not wall-clock (SPEC §4).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_DELAY_MS, trackView } from "./stats";

/**
 * Every beat reports ABSOLUTE accumulated time, never a delta, so a retried or
 * duplicated beat is a server-side no-op. These tests assert the numbers on the
 * wire, because the server's correctness depends on that property and nothing
 * else here can check it.
 */

interface Beat {
  docId: string;
  versionId: string;
  sessionId: string;
  ms: number;
  k?: string;
}

function beats(): Beat[] {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  return fetchMock.mock.calls.map((call) =>
    JSON.parse((call[1] as RequestInit).body as string),
  );
}

/** The tab changes state, and tells the page, as a browser does. */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("trackView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
    // sendBeacon is absent in jsdom; without stubbing it the final flush would
    // take the fetch path and the assertions would still hold, but the branch
    // being exercised would not be the real one.
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: undefined });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("records NOTHING before the grace period", () => {
    /**
     * Two reasons this exists, and both matter. Opening the wrong document and
     * closing it immediately is not a "view", so the count means something. And
     * it makes the tracker inert under StrictMode's mount/unmount/remount probe
     * in development, which would otherwise log two views for every open.
     */
    const tracker = trackView("d1", "v1");
    vi.advanceTimersByTime(OPEN_DELAY_MS - 1);
    tracker.stop();
    expect(beats()).toHaveLength(0);
  });

  it("registers the session once the grace period elapses", () => {
    const tracker = trackView("d1", "v1");
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(beats()).toHaveLength(1);
    // Registered at zero, so a reader who leaves after thirty seconds is still
    // counted rather than being lost between heartbeats.
    expect(beats()[0].ms).toBe(0);
    tracker.stop();
  });

  it("carries an unlisted document's key, and sends no key field otherwise", () => {
    // Without its key an unlisted document answers /view exactly as an absent
    // id, so a link holder's beats must present it (SPEC §17).
    const linked = trackView("d1", "v1", "tok_0123456789abcdefghijk");
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    linked.stop();
    expect(beats()[0].k).toBe("tok_0123456789abcdefghijk");
    expect(beats().every((b) => b.k === "tok_0123456789abcdefghijk")).toBe(true);

    vi.mocked(globalThis.fetch).mockClear();
    const plain = trackView("d2", "v1");
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    plain.stop();
    expect(beats().length).toBeGreaterThan(0);
    expect(beats().every((b) => !("k" in b))).toBe(true);
  });

  it("reports ABSOLUTE time, not a delta", () => {
    const tracker = trackView("d1", "v1");
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(60_000);
    const values = beats().map((b) => b.ms);
    // Monotonic and cumulative: 0, ~60s, ~120s. A delta protocol would send
    // 60s twice, and a retried beat would then double-count.
    expect(values[0]).toBe(0);
    expect(values[1]).toBeGreaterThanOrEqual(60_000);
    expect(values[2]).toBeGreaterThan(values[1]);
    tracker.stop();
  });

  it("keeps one session id for the whole session", () => {
    const tracker = trackView("d1", "v1");
    vi.advanceTimersByTime(OPEN_DELAY_MS + 60_000);
    const ids = new Set(beats().map((b) => b.sessionId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    tracker.stop();
  });

  it("stops the clock while the tab is hidden", () => {
    const tracker = trackView("d1", "v1");
    vi.advanceTimersByTime(OPEN_DELAY_MS);

    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    const atHide = beats().at(-1)!.ms;

    vi.advanceTimersByTime(10 * 60_000);
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    tracker.stop();

    // Ten minutes passed; none of it counts, because a document left open on a
    // second monitor is not being read.
    expect(beats().at(-1)!.ms).toBeLessThan(atHide + 1000);
  });

  it("stops the clock after a long silence, and restarts on interaction", () => {
    const tracker = trackView("d1", "v1");
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    vi.advanceTimersByTime(30 * 60_000); // well past the idle window
    const idle = beats().at(-1)!.ms;

    tracker.markActive();
    vi.advanceTimersByTime(60_000);
    tracker.stop();

    // The idle stretch is not counted beyond the detection granularity: the
    // clock is evaluated once per heartbeat, so it overshoots by at most one
    // beat interval past the five-minute window. That is the same one-beat
    // tolerance the protocol already accepts for a dropped final beacon, and
    // paying for finer resolution would mean a timer that never sleeps.
    expect(idle).toBeLessThanOrEqual(6 * 60_000);
    expect(beats().at(-1)!.ms).toBeGreaterThan(idle);
  });

  it("flushes a final beat on stop", () => {
    const tracker = trackView("d1", "v1");
    vi.advanceTimersByTime(OPEN_DELAY_MS + 30_000);
    const before = beats().length;
    tracker.stop();
    expect(beats().length).toBe(before + 1);
  });

  it("is safe to stop more than once", () => {
    const tracker = trackView("d1", "v1");
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    tracker.stop();
    const after = beats().length;
    tracker.stop();
    tracker.stop();
    expect(beats().length).toBe(after);
  });

  it("stays silent when stopped before registering", () => {
    // Beating now would CREATE the session server-side, turning a two-second
    // glance into a recorded view.
    const tracker = trackView("d1", "v1");
    tracker.stop();
    expect(beats()).toHaveLength(0);
  });

  it("uses sendBeacon for the final flush when it exists", () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { ...navigator, sendBeacon });
    const tracker = trackView("d1", "v1");
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    tracker.stop();
    // fetch is killed during pagehide; sendBeacon survives it and carries the
    // same-origin session cookie, so it passes the identity gate identically.
    expect(sendBeacon).toHaveBeenCalledWith("/view", expect.any(Blob));
  });

  /**
   * Every beat that reports new time is a read: it lifts the document in Recent
   * and clears "New since you read it". So a tab nobody is looking at must say
   * nothing. Each case is one tracker going through states in order, because the
   * order is what a real tab does and what a per-state check would never see.
   */
  describe("a tab nobody is looking at", () => {
    const show = () => setVisibility("visible");
    const hide = () => setVisibility("hidden");

    it("sends nothing when opened in the background and never shown", () => {
      hide();
      const tracker = trackView("d1", "v1");
      vi.advanceTimersByTime(10 * 60_000);
      tracker.stop();
      expect(beats()).toHaveLength(0);
    });

    it("registers two seconds after it is shown, not after it was opened", () => {
      hide();
      const tracker = trackView("d1", "v1");
      vi.advanceTimersByTime(60_000);

      show();
      vi.advanceTimersByTime(OPEN_DELAY_MS - 1);
      expect(beats()).toHaveLength(0);

      vi.advanceTimersByTime(1);
      expect(beats().map((b) => b.ms)).toEqual([0]);

      // The minute it sat in the background is not reading time.
      tracker.stop();
      expect(beats().at(-1)!.ms).toBe(OPEN_DELAY_MS);
    });

    it("sends nothing for a new session shown for less than the grace period", () => {
      hide();
      const tracker = trackView("d1", "v1");
      show();
      vi.advanceTimersByTime(OPEN_DELAY_MS - 1);
      hide();
      vi.advanceTimersByTime(60_000);
      tracker.stop();
      expect(beats()).toHaveLength(0);
    });

    it("sends its final beat when it goes to the background, then nothing", () => {
      const tracker = trackView("d1", "v1");
      vi.advanceTimersByTime(OPEN_DELAY_MS + 1_000);
      hide();
      expect(beats().map((b) => b.ms)).toEqual([0, OPEN_DELAY_MS + 1_000]);

      vi.advanceTimersByTime(10 * 60_000);
      tracker.stop();
      expect(beats()).toHaveLength(2);
    });

    it("passes over a registered tab without a beat, and counts none of that time", () => {
      const tracker = trackView("d1", "v1");
      vi.advanceTimersByTime(OPEN_DELAY_MS + 1_000);
      hide();
      const atHide = beats().at(-1)!.ms;
      const sent = beats().length;

      // Ctrl+Tab through it on the way to another tab.
      vi.advanceTimersByTime(60_000);
      show();
      vi.advanceTimersByTime(OPEN_DELAY_MS - 1);
      hide();
      expect(beats()).toHaveLength(sent);

      // Back for real: the time reported is the earlier stretch plus this one.
      vi.advanceTimersByTime(60_000);
      show();
      vi.advanceTimersByTime(OPEN_DELAY_MS);
      expect(beats().at(-1)!.ms).toBe(atHide + OPEN_DELAY_MS);
      tracker.stop();
    });

    it("sends nothing when a registered tab is closed within the grace period of coming back", () => {
      const tracker = trackView("d1", "v1");
      vi.advanceTimersByTime(OPEN_DELAY_MS + 1_000);
      hide();
      const sent = beats().length;

      vi.advanceTimersByTime(60_000);
      show();
      vi.advanceTimersByTime(OPEN_DELAY_MS - 1);
      tracker.stop();
      expect(beats()).toHaveLength(sent);
    });

    it("counts bringing a tab forward as activity, however long it was away", () => {
      const tracker = trackView("d1", "v1");
      vi.advanceTimersByTime(OPEN_DELAY_MS);
      hide();
      const atHide = beats().at(-1)!.ms;

      vi.advanceTimersByTime(30 * 60_000); // well past the idle window
      show();
      // No pointer and no key: the reader only switched to the tab.
      vi.advanceTimersByTime(OPEN_DELAY_MS);
      expect(beats().at(-1)!.ms).toBe(atHide + OPEN_DELAY_MS);

      // And the clock goes on running, with still no input.
      vi.advanceTimersByTime(60_000);
      expect(beats().at(-1)!.ms).toBeGreaterThan(atHide + OPEN_DELAY_MS);
      tracker.stop();
    });

    it("goes silent when idle on screen, and speaks again after an interaction", () => {
      const tracker = trackView("d1", "v1");
      vi.advanceTimersByTime(30 * 60_000); // well past the idle window
      const sent = beats().length;
      const idle = beats().at(-1)!.ms;

      // The clock has stopped, so another half hour has nothing new to report.
      vi.advanceTimersByTime(30 * 60_000);
      expect(beats()).toHaveLength(sent);

      tracker.markActive();
      vi.advanceTimersByTime(60_000);
      expect(beats().length).toBeGreaterThan(sent);
      expect(beats().at(-1)!.ms).toBeGreaterThan(idle);
      tracker.stop();
    });

    it("sends one final beat when going hidden and leaving both fire", () => {
      const tracker = trackView("d1", "v1");
      vi.advanceTimersByTime(OPEN_DELAY_MS + 1_000);

      hide();
      window.dispatchEvent(new Event("pagehide"));
      expect(beats()).toHaveLength(2);
      tracker.stop();
      expect(beats()).toHaveLength(2);
    });

    it("sends one final beat when leaving fires before going hidden", () => {
      const tracker = trackView("d1", "v1");
      vi.advanceTimersByTime(OPEN_DELAY_MS + 1_000);

      window.dispatchEvent(new Event("pagehide"));
      hide();
      expect(beats()).toHaveLength(2);
      tracker.stop();
      expect(beats()).toHaveLength(2);
    });
  });
});
