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
}

function beats(): Beat[] {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  return fetchMock.mock.calls.map((call) =>
    JSON.parse((call[1] as RequestInit).body as string),
  );
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
});
