// SPDX-License-Identifier: Apache-2.0
// Playback privacy, accessible captions, and transcript failure sequences (SPEC §7).

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LandingVideo } from "./LandingVideo";

const media = vi.hoisted(() => ({ base: "" }));
vi.mock("../config", () => ({
  get LANDING_MEDIA_BASE_URL() { return media.base; },
}));

const VTT = "WEBVTT\n\nNOTE caption metadata\nnot narration\n\n1\n00:00:00.000 --> 00:00:03.000\nA draft with feedback\non the exact words.\n\n2\n00:00:03.000 --> 00:00:06.000\nPublish the next version.\n";
const fetchCaptions = vi.fn();

beforeEach(() => {
  media.base = "https://media.example.test/story-v1";
  fetchCaptions.mockReset();
  fetchCaptions.mockResolvedValue({ ok: true, text: async () => VTT });
  vi.stubGlobal("fetch", fetchCaptions);
});

afterEach(() => vi.unstubAllGlobals());

function openTranscript(container: HTMLElement) {
  const details = container.querySelector("details")!;
  act(() => {
    details.open = true;
    fireEvent(details, new Event("toggle"));
  });
  return details;
}

describe("the native story player", () => {
  it("requests playback only from the visitor, with sound and inline native controls", () => {
    const { container } = render(<LandingVideo />);
    const video = container.querySelector("video")!;
    expect({
      controls: video.controls,
      preload: video.preload,
      autoplay: video.autoplay,
      muted: video.muted || video.defaultMuted,
      inline: video.playsInline,
    }).toEqual({ controls: true, preload: "none", autoplay: false, muted: false, inline: true });
  });

  it("loads one configured media revision with a poster and default cross-origin English captions", () => {
    const { container } = render(<LandingVideo />);
    const video = container.querySelector("video")!;
    const track = container.querySelector("track")!;
    expect({
      video: video.getAttribute("src"),
      poster: video.getAttribute("poster"),
      crossorigin: video.crossOrigin,
      captions: track.getAttribute("src"),
      kind: track.kind,
      language: track.srclang,
      label: track.label,
      default: track.default,
    }).toEqual({
      video: `${media.base}/bikeshed-explainer.mp4`,
      poster: `${media.base}/poster.webp`,
      crossorigin: "anonymous",
      captions: `${media.base}/bikeshed-explainer.vtt`,
      kind: "captions",
      language: "en",
      label: "English",
      default: true,
    });
  });

  it("omits the optional media when the deployment has not configured it", () => {
    media.base = "";
    const { container } = render(<LandingVideo />);
    expect(container.innerHTML).toBe("");
  });

  it("keeps caption failures separate from video failures and recovers when playback succeeds", () => {
    const { container } = render(<LandingVideo />);
    const video = container.querySelector("video")!;
    const track = container.querySelector("track")!;
    fireEvent.error(track);
    expect(screen.getByRole("status").textContent).toMatch(/^Captions couldn’t load/);
    fireEvent.load(track);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.error(video);
    expect(screen.getByRole("status").textContent).toMatch(/^The video couldn’t load/);
    fireEvent.playing(video);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("the transcript", () => {
  it("fetches only on disclosure, uses the caption text, and retains it on reopening", async () => {
    const { container } = render(<LandingVideo />);
    expect(fetchCaptions).not.toHaveBeenCalled();
    const details = openTranscript(container);
    await screen.findByText("Publish the next version.");
    expect(Array.from(details.querySelectorAll("p"), (p) => p.textContent)).toEqual([
      "A draft with feedback on the exact words.",
      "Publish the next version.",
    ]);
    act(() => {
      details.open = false;
      fireEvent(details, new Event("toggle"));
    });
    openTranscript(container);
    expect(fetchCaptions.mock.calls.map(([url]) => url)).toEqual([`${media.base}/bikeshed-explainer.vtt`]);
  });

  it.each([
    ["failed HTTP response", { ok: false, text: async () => VTT }],
    ["an HTML fallback", { ok: true, text: async () => "<!doctype html><title>Bikeshed</title>" }],
    ["empty captions", { ok: true, text: async () => "WEBVTT\n\n" }],
  ])("offers the guide and retry for %s", async (_name, response) => {
    fetchCaptions.mockResolvedValue(response);
    const { container } = render(<LandingVideo />);
    const details = openTranscript(container);
    await screen.findByRole("button", { name: "Try again" });
    expect(details.querySelector("[role=status] a")?.getAttribute("href")).toBe("/docs");
  });

  it("can retry a network failure in the same disclosure", async () => {
    fetchCaptions.mockRejectedValueOnce(new Error("offline"));
    const { container } = render(<LandingVideo />);
    openTranscript(container);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText("Publish the next version.")).not.toBeNull());
  });

  it("cancels an outstanding transcript request when the visitor leaves", () => {
    fetchCaptions.mockReturnValue(new Promise(() => {}));
    const { container, unmount } = render(<LandingVideo />);
    openTranscript(container);
    const signal = fetchCaptions.mock.calls[0][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
